# huu — Humans Underwrite Undertakings
# Multi-stage build: tsc compiles src/ in the builder, runtime ships only
# dist/ + pruned node_modules + git + tini.
#
# See docker-roadmap.md §9.1 for design rationale.
#
# ───────── PORTABILITY CONTRACT — no BuildKit-only syntax in here ─────────
#
# This file MUST build on a factory Docker: plain `docker build`, no buildx
# plugin installed, no DOCKER_BUILDKIT=1 exported. huu is docker-only — the
# re-exec into the container IS the product, and only HUU_DEV_NATIVE=1
# escapes it — so a Dockerfile that needs an optional CLI plugin does not
# degrade one feature, it makes the whole tool refuse to start.
#
# That is not hypothetical. `RUN --mount=type=cache,target=/root/.npm` sat on
# the `npm ci` step from the very first commit, and on any Docker without
# buildx every `npm start` died at step 4 with:
#     the --mount option requires BuildKit
# DOCKER_BUILDKIT=1 does not rescue it either ("BuildKit is enabled but the
# buildx component is missing or broken") — buildx is a separate package, and
# README lists only Node, git and Docker as prerequisites.
#
# So: NO cache mounts, NO `RUN --mount=type=secret|ssh`, NO `RUN --network=`,
# NO `COPY --link` / `COPY --chmod`, NO heredocs (`RUN <<EOF`). Enforced by
# `scripts/check-dockerfile.ts`, wired into `scripts/gate.sh` — so the gate
# says no before a user's build does.
#
# What the two cache mounts were actually worth, measured before deleting
# them: the one wrapping `npm prune --omit=dev` covered a command that
# downloads NOTHING (gain ≈ zero), and the one wrapping `npm ci` only pays
# when package-lock.json CHANGES — with the lockfile untouched, Docker's
# ordinary LAYER cache already skips the entire step. Small, localized cost;
# for a docker-only product, portability is worth more.
#
# There is deliberately NO `# syntax=docker/dockerfile:1.x` line either. The
# legacy builder silently ignores it (it is not an error), but it advertises
# a frontend this file does not use — and that advertisement is precisely the
# invitation that put `RUN --mount` here. Nothing below needs anything newer
# than the built-in frontend, so the file says so by staying quiet.
#
# WHAT WAS ACTUALLY BUILT, AND WHAT WAS NOT
# -----------------------------------------
# Measured: this file, exactly as it stands, was built through the real entry
# point (`./scripts/ensure-image.sh`) on a Docker 29.7.2 with NO buildx
# plugin — 40 steps, `Successfully tagged huu:local`, and
# `docker run --rm huu:local huu --help` exited 0.
# NOT measured: the BuildKit path after the directive was dropped. It should
# be a no-op — without a `# syntax=` line BuildKit uses its built-in
# frontend, which parses everything here — but nobody re-ran a BuildKit build
# to confirm it, so treat "BuildKit still builds this unchanged" as reasoning
# rather than as a transcript. Note in particular that an equivalence check
# that strips comments before diffing is BLIND to this change: `# syntax=` is
# itself a comment, so the strip deletes the very line under test.
# `docker build` picks whatever builder that host defaults to, which is why
# neither this file nor scripts/ensure-image.sh forces one.

# ─────────── Stage 1: builder ───────────
FROM node:20-slim AS builder

WORKDIR /build

# Install full dev dependencies.
#
# NO `--mount=type=cache,target=/root/.npm` here — see the PORTABILITY
# CONTRACT at the top of this file. It is not an oversight and it is not an
# optimization waiting to happen: that flag is BuildKit-only, and huu must
# build on a Docker with no buildx plugin. Docker's plain layer cache already
# skips this whole step whenever package-lock.json is unchanged.
#
# .npmrc is required: the lockfile resolved with legacy-peer-deps=true
# (model-selector-ink declares a peer of ink@^6 while the rest of the
# tree pins ink@^4 — npm 7+ refuses to install otherwise).
#
# `--include=dev` brings vitest/tsx for the build step. `optionalDependencies`
# (@github/copilot-sdk) install by default; if a future version is unavailable
# at build time, npm ci will skip it without failing — the Copilot backend
# falls back to a clear runtime error and the rest of huu still works.
COPY package.json package-lock.json .npmrc ./
RUN npm ci --include=dev

# Compile TypeScript. tsconfig excludes node_modules/dist/scripts so tsc
# only walks src/.
COPY tsconfig.json ./
COPY src ./src
# The knowledge-bootstrap agent prompt is a doc, but the runtime needs it: the
# build copies it into dist/assets/ because only dist/ reaches the final image.
COPY docs/knowledge-skills-architect-prompt.md ./docs/
RUN npm run build

# Pre-compile the bind() interceptor so the runtime image doesn't need a
# C toolchain. Without this, ensureNativeShim() would silently degrade to
# env-only mode in the official container — and parallel agents that
# hardcode `bind(3000)` would collide on the same kernel inside the
# shared network namespace. See PORT-SHIM.md §6.4.
#
# gcc/libc6-dev live ONLY in the builder stage; the runtime never sees
# them. The resulting .so (~16KB) is what gets copied forward.
COPY native /build/native
RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc libc6-dev \
    && cc -O2 -fPIC -Wall -shared \
        -o /build/native/port-shim/huu-port-shim.so \
        /build/native/port-shim/port-shim.c \
        -ldl -lpthread \
    && rm -rf /var/lib/apt/lists/*

# Drop devDependencies so the runtime stage can copy a lean node_modules.
# (Also no cache mount: `npm prune` downloads nothing, so the BuildKit-only
# flag that used to be here bought exactly zero. PORTABILITY CONTRACT, top.)
RUN npm prune --omit=dev

# Strip artifacts node won't load at runtime: source maps (~35MB across
# the LLM provider SDKs we bundle) and per-package READMEs (~5MB). We
# preserve LICENSE/COPYING files for redistribution compliance.
# .d.ts files are intentionally kept — some packages chain require()
# resolution through them in production.
RUN find node_modules -type f \( \
        -name "*.map" \
        -o -name "*.md" \
        -o -name "*.markdown" \
        -o -name "CHANGELOG*" \
        -o -name "HISTORY*" \
    \) ! -iname "LICENSE*" ! -iname "COPYING*" -delete \
    && find node_modules -type d -empty -delete


# ─────────── Stage 2: runtime ───────────
FROM node:20-slim AS runtime

# Build arg controls whether openssh-client ships in the image.
# - INCLUDE_SSH=true (default): allows pipelines whose git remotes use
#   `git@github.com:` URLs and SSH-based credential helpers to push.
# - INCLUDE_SSH=false: ~50MB smaller image (`huu:slim`). Pick this when
#   the repo only uses HTTPS remotes or when the agent never pushes.
ARG INCLUDE_SSH=true

# Build arg controls whether the surf web-research CLI ships in the image.
# - INCLUDE_SURF=true (default): pipeline steps can run real, cited web
#   research from inside the container — `surf-research-skill` (probe + raw
#   links) plus `surf-search-normal` / `surf-search-unlimit` (the autonomous
#   waves the research prompts reach for FIRST).
# - INCLUDE_SURF=false: ~20MB smaller image; research steps degrade to
#   repo-only knowledge (the prompt handles it — see docs/dev-mode.md).
#
# THE PACKAGE NAME IS `surf-agent-skill`. The old `surf-skill` name is
# DEPRECATED on npm — `npm view surf-skill deprecated` answers "Renomeado para
# surf-agent-skill — instale com: npm i -g surf-agent-skill" — and is frozen at
# 7.0.0. huu is docker-only, so the image IS production research: installing
# the abandoned name does not degrade a dev box, it silently ships every user a
# CLI that does not match the code calling it.
#
# SURF_VERSION is a MAJOR RANGE, not a pin: 8.x fixes land without a Dockerfile
# edit, but the image never crosses a major on its own. That boundary is the
# whole point — v8 is the release that made Brave the ONLY backend, deleted the
# keyless `surf-free-skill` rung and made a missing key exit 78 *before*
# anything runs, and huu encodes exactly those facts in
# src/lib/surf-research.ts, src/lib/dev-graph/research-contract.ts and
# src/lib/dev-mode/knowledge-blackboard.ts. A v9 must be read before it is
# trusted, so it does not arrive by itself.
ARG INCLUDE_SURF=true
ARG SURF_VERSION=8

# Pentest mode's active-testing toolchain (nmap, nikto, whatweb, sqlmap, …).
# OFF by default — it adds weight most runs never need, and only the
# `huu pentest` live-target path uses it. Build the opt-in variant with:
#   docker build --build-arg INCLUDE_PENTEST_TOOLS=true -t huu-pentest:local .
# then run pentest mode with HUU_IMAGE=huu-pentest:local. `jq` and `curl`
# (the scope-guard + http-probe exec skills need them) ship in the base image
# regardless, so repo-only + HTTP-based testing works everywhere.
ARG INCLUDE_PENTEST_TOOLS=false

# - tini: PID 1 init that forwards SIGINT/SIGTERM to the Node process.
#   Without it, Ctrl+C from `docker run -it` does not reach the TUI's signal
#   handlers and can leave the host terminal in raw mode.
# - git: huu's whole point — `git worktree`, branch ops, merges.
# - ca-certificates: HTTPS to OpenRouter.
# - openssh-client: optional via INCLUDE_SSH build arg (see above).
#
# Layer-cleanup pass:
# - Drop yarn (~7MB): the node:20-slim base ships yarn v1 as a tarball
#   under /opt; huu uses npm exclusively, so it's pure overhead.
# - Strip locale/doc/man (~30MB): no shell user inside this container
#   needs man pages or POSIX locales beyond C/UTF-8.
# All in a single RUN to avoid baking the deletions into a separate
# layer that still inflates the image.
RUN set -eux; \
    extra_pkgs=""; \
    if [ "$INCLUDE_SSH" = "true" ]; then extra_pkgs="openssh-client"; fi; \
    apt-get update && apt-get install -y --no-install-recommends \
        tini \
        git \
        ca-certificates \
        jq \
        curl \
        $extra_pkgs \
    && rm -rf /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* \
              /usr/share/doc/* /usr/share/man/* /usr/share/locale/*

# Web-research CLI (optional, see INCLUDE_SURF above).
#
# `--ignore-scripts` is MANDATORY: surf's postinstall writes harness symlinks
# and a keys.json skeleton into the BUILD user's $HOME, which is both useless
# (the runtime HOME differs) and a layer of stale state baked into the image.
# The bin symlinks come from package.json `bin`, which npm links regardless.
#
# The three `command -v` guards are the ASSERTION this layer was missing. The
# prompts call `surf-search-normal` first and `surf-research-skill` second; a
# package that stops shipping either one is a broken image, and a build that
# fails here is infinitely cheaper than a run that discovers it at agent time.
RUN if [ "$INCLUDE_SURF" = "true" ]; then \
        npm i -g --ignore-scripts "surf-agent-skill@${SURF_VERSION}" \
        && command -v surf-research-skill >/dev/null \
        && command -v surf-search-normal >/dev/null \
        && command -v surf-search-unlimit >/dev/null \
        && npm cache clean --force; \
    fi

# Pentest active-testing toolchain (opt-in — see INCLUDE_PENTEST_TOOLS above).
# Debian-packaged tools only, so it stays a single cached apt layer; the
# `exec/` skills call these, and `exec/_lib/scope-guard.sh` refuses any target
# off the mission allowlist before a tool ever runs.
RUN if [ "$INCLUDE_PENTEST_TOOLS" = "true" ]; then \
        apt-get update && apt-get install -y --no-install-recommends \
            nmap \
            nikto \
            whatweb \
            sqlmap \
            dnsutils \
            netcat-openbsd \
        && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* \
                  /usr/share/doc/* /usr/share/man/* /usr/share/locale/*; \
    fi

# SURF_QUIET keeps the CLI's progress chatter out of agent transcripts;
# SURF_AGENT_BUDGET_MS caps one research call at 4 min so a hung provider
# can't eat a card's timeout. Both are overridable per-run — the host wrapper
# forwards every SURF_* knob (see docker-reexec.ts passthrough).
ENV SURF_QUIET=1 \
    SURF_AGENT_BUDGET_MS=240000

# safe.directory '*' at the system level lets git operate against bind-mounted
# host repos owned by a UID different from the container's process UID. This
# is the pragmatic choice for a dev tool image — users running `--user` to
# match host UID/GID get correct ownership; users running as the default
# (root) still get a working git. See docker-roadmap.md §4.2.
#
# Wildcard support in safe.directory was added in git 2.36 (released May
# 2022); Debian Bookworm ships git ≥2.39, so this is portable.
RUN git config --system --add safe.directory '*' \
    && git config --system init.defaultBranch main

# Mirror the non-interactive git env that huu sets at runtime via
# nonInteractiveGitEnv() in src/git/git-client.ts. Anything the user runs
# directly inside the container (e.g., `docker compose run huu sh`) also
# inherits these — no surprise hangs on credential prompts.
ENV GIT_TERMINAL_PROMPT=0 \
    GCM_INTERACTIVE=Never \
    NODE_ENV=production \
    TERM=xterm-256color \
    HUU_IN_CONTAINER=1

# Web UI default port. EXPOSE is documentation only — the host wrapper
# publishes it with `docker run -p <port>:<port>` (buildDockerArgv), and the
# in-container server binds 0.0.0.0:$HUU_WEB_PORT. Override with --port / HUU_WEB_PORT.
EXPOSE 4888

WORKDIR /opt/huu

# Pull only what the runtime needs from the builder.
COPY --from=builder /build/package.json /build/package-lock.json ./
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/dist ./dist
COPY recommended-models.json ./

# Reference pipelines bundled at a known path. Tiny in absolute size
# (~10KB) but high in onboarding value: a user with the image on disk
# can copy a curated pipeline out without cloning the repo:
#   docker run --rm ghcr.io/.../huu:latest \
#     cat /opt/huu/cookbook/demo-rapida.pipeline.json \
#     > demo-rapida.pipeline.json
# Path also surfaces via HUU_COOKBOOK_DIR for future programmatic use.
COPY pipelines/ /opt/huu/cookbook/
ENV HUU_COOKBOOK_DIR=/opt/huu/cookbook

# Pre-built bind() interceptor from the builder stage. Pointing
# HUU_NATIVE_SHIM_PATH at this absolute path lets ensureNativeShim()
# skip the on-demand `cc` invocation entirely — the runtime image
# intentionally has no compiler. The .so is ~16KB.
COPY --from=builder /build/native/port-shim/huu-port-shim.so /opt/huu/native/huu-port-shim.so
ENV HUU_NATIVE_SHIM_PATH=/opt/huu/native/huu-port-shim.so

# Symlink so `huu ...` resolves anywhere on PATH inside the container.
#
# Same trick for `jcode`, with one difference: jcode is NOT baked into this
# image. No public distribution URL for it exists, so the image cannot fetch
# it; instead the HOST wrapper bind-mounts a usable host install read-only at
# /opt/jcode (src/lib/jcode-bundle.ts → buildDockerArgv `readonlyMounts`). The
# mounted directory carries BOTH the /bin/sh launcher and its sidecar ELF
# payload, which is why the mount unit is a directory and why this link points
# at the launcher inside it.
#
# A symlink is deliberately preferred over `ENV PATH=/opt/jcode:$PATH`: it
# exposes exactly one name, so an arbitrary host directory can never shadow the
# container's own git/node/sh. When no bundle was mounted the link simply
# dangles and `spawn('jcode')` fails with ENOENT — which the jcode backend
# turns into an actionable message (jcodeMissingExecutableMessage).
RUN ln -s /opt/huu/dist/cli.js /usr/local/bin/huu \
    && ln -s /opt/jcode/jcode /usr/local/bin/jcode

# Entrypoint script applies last-mile fixups (HOME synthesis when the
# user passes --user with a UID not in /etc/passwd, fallback safe.directory
# at the user level).
COPY docker/entrypoint.sh /usr/local/bin/huu-entrypoint
RUN chmod +x /usr/local/bin/huu-entrypoint

# tini handles signals and reaps zombies. Anything supplied as CMD or as
# `docker run <image> ...` arguments is forwarded by the entrypoint.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/huu-entrypoint"]
CMD ["huu", "--help"]

# Container health: the TUI launcher writes /tmp/huu/active with the
# repo path of the running pipeline. The probe sources that path,
# cd's into it, and asks `huu status --liveness` whether the run is
# stalled or crashed (both emit exit 1). If the sentinel is absent
# (idle container, fresh start, scaffolding-only invocation), exit 0
# — an idle container isn't unhealthy.
#
# --start-period gives the run a generous window to write the sentinel
# before failures count. --interval / --timeout / --retries are tuned
# for overnight pipelines where hours of progress are normal between
# stage transitions.
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD sh -c 'if [ -f /tmp/huu/active ]; then \
        cd "$(cat /tmp/huu/active)" && exec huu status --liveness; \
    else \
        exit 0; \
    fi'

# OCI labels for discoverability on registries / `docker inspect`.
LABEL org.opencontainers.image.title="huu" \
      org.opencontainers.image.description="Humans Underwrite Undertakings — guided pipeline TUI" \
      org.opencontainers.image.source="https://github.com/frederico-kluser/huu" \
      org.opencontainers.image.licenses="Apache-2.0"

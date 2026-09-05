#!/usr/bin/env bash
# Guarantee `npm start`/`npm run dev` execute the CURRENT source.
#
# huu is docker-only: the host wrapper (src/cli.tsx via tsx) is always fresh,
# but the actual run happens INSIDE the image — which is frozen at whatever
# the last `docker build` produced. Without this step, a fixed bug keeps
# "happening" until someone remembers to rebuild (the stale-image trap).
#
# Behavior:
#   - HUU_IMAGE set to anything other than huu:local → the caller pinned a
#     specific image on purpose (e.g. a published GHCR tag) — skip.
#   - docker missing → warn and continue (native-only subcommands like
#     `status`/`--help` still work; the CLI itself explains when a run
#     actually needs Docker).
#   - otherwise → `docker build -t huu:local .`. Layer cache makes the
#     no-change case take ~1–3 s; a src/ change re-runs only tsc + the
#     runtime-image layers. A FAILED build aborts the start — running stale
#     code silently is exactly what this script exists to prevent.
#
# `--network=host` on Linux: hosts using systemd-resolved expose the DNS stub
# 127.0.0.53, which the default bridge network can't reach — apt/npm inside
# the build would fail name resolution (harmless where not needed).
#
# WHY THIS RUNS PLAIN `docker build` AND FORCES NO BUILDER
# -------------------------------------------------------
# It deliberately does NOT export DOCKER_BUILDKIT, and deliberately does not
# probe for buildx to "use it when available". Two reasons, both learned the
# hard way:
#   1. `docker build` already picks whatever builder that host defaults to —
#      BuildKit where buildx is installed (Docker Desktop, most modern Linux
#      packages), the classic builder where it is not. Forcing the choice can
#      only make it worse: DOCKER_BUILDKIT=1 on a machine without the plugin
#      fails outright with "BuildKit is enabled but the buildx component is
#      missing or broken".
#   2. A second, buildx-only code path would be exercised on some machines and
#      not others — and the path that must never rot is the one without it,
#      since huu is docker-only and README promises only Node, git and Docker.
#      The Dockerfile is kept free of BuildKit-only syntax for exactly this
#      reason (see its PORTABILITY CONTRACT header, enforced by
#      scripts/check-dockerfile.ts in the gate), so the classic builder is
#      never the degraded path — it is the contract.
#
# When the build DOES fail, the raw Docker error is usually the least useful
# line on screen. diagnose_failure() below translates the failures worth
# translating into the command that fixes them.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${HUU_IMAGE:-huu:local}"

if [[ "$IMAGE" != "huu:local" ]]; then
  echo "[ensure-image] HUU_IMAGE=$IMAGE (explicitly pinned) — skipping the local build" >&2
  exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "[ensure-image] docker not found — continuing WITHOUT rebuilding huu:local" >&2
  echo "[ensure-image] (native-only subcommands still work; container runs will fail loudly)" >&2
  exit 0
fi

NET_ARGS=()
if [[ "$(uname -s)" == "Linux" ]]; then
  NET_ARGS+=(--network=host)
fi

BUILD_LOG="$(mktemp "${TMPDIR:-/tmp}/huu-image-build.XXXXXX")"

say() { echo "[ensure-image] $*" >&2; }

# Case-insensitive fixed-string probe over the captured build output.
log_has() { grep -qiF "$1" "$BUILD_LOG"; }

# Turn a raw Docker failure into the next command to type.
#
# Two of the branches below were OBSERVED on a developer machine while the
# buildx bug was being fixed: `the --mount option requires BuildKit` (Docker
# 29.7.2, no buildx plugin) and `BuildKit is enabled but the buildx component
# is missing or broken` (the same machine with DOCKER_BUILDKIT=1). The rest —
# daemon down, docker.sock permission, disk full, DNS — this build *can*
# produce, and each one is documented Docker behavior, but nobody here
# triggered them. They are written from the failure mode, not from a
# transcript; the wording says what to type, and the fallback covers whatever
# does not match without pretending to know more than it does.
diagnose_failure() {
  say ""
  say "──────────────── the image build FAILED ────────────────"

  if log_has "requires BuildKit" || log_has "the --mount option"; then
    say "CAUSE: the Dockerfile uses BuildKit-only syntax, and this Docker has"
    say "       no buildx plugin, so the classic builder cannot parse it."
    say "       huu is docker-only — this is not a slow build, it is no huu."
    say "FIX:   npx tsx scripts/check-dockerfile.ts"
    say "       It names the exact line. Rewrite that line without the flag;"
    say "       the Dockerfile's PORTABILITY CONTRACT header explains why the"
    say "       cache mounts were removed and what they were worth (≈nothing)."
    say "       Installing buildx unblocks YOUR machine only — every user"
    say "       without it stays broken, so it is a workaround, not the fix."

  elif log_has "buildx component is missing" || log_has "buildx component is missing or broken"; then
    say "CAUSE: BuildKit is being forced on (DOCKER_BUILDKIT=${DOCKER_BUILDKIT:-<unset>})"
    say "       but the buildx plugin is not installed."
    say "FIX:   unset DOCKER_BUILDKIT     # the classic builder builds this fine"
    say "       …or install the plugin: docker-buildx-plugin (Debian/Ubuntu),"
    say "       docker-buildx (Arch). huu needs neither."

  elif log_has "Cannot connect to the Docker daemon" || log_has "Is the docker daemon running"; then
    say "CAUSE: the Docker daemon is not reachable."
    say "FIX:   sudo systemctl start docker      # Linux"
    say "       …or launch Docker Desktop, then re-run."

  elif log_has "permission denied" && log_has "docker.sock"; then
    say "CAUSE: your user cannot talk to /var/run/docker.sock."
    # `${USER:-$(id -un)}` and not `$USER`: this script runs under `set -u`,
    # and USER is UNSET in exactly the shells that hit this branch — a
    # non-login shell, `docker exec`, some CI runners. A bare `$USER` would
    # abort mid-diagnosis and print nothing, in the one branch whose whole
    # value is the command it hands you.
    say "FIX:   sudo usermod -aG docker \"${USER:-$(id -un)}\" && newgrp docker"
    say "       (a full re-login also works)."

  elif log_has "no space left on device"; then
    say "CAUSE: the Docker storage pool is full."
    say "FIX:   docker system df && docker system prune -af"

  elif log_has "Temporary failure resolving" || log_has "Could not resolve host" \
       || log_has "network is unreachable"; then
    say "CAUSE: name resolution failed INSIDE the build (apt/npm could not"
    say "       reach the network). On Linux this script already passes"
    say "       --network=host for the systemd-resolved stub; a VPN with a"
    say "       reduced MTU is the usual remaining culprit."
    say "FIX:   retry off the VPN, or skip building entirely with a published"
    say "       image: HUU_IMAGE=ghcr.io/frederico-kluser/huu:latest npm start"

  else
    say "CAUSE: not one of the failures this script knows how to translate."
  fi

  say ""
  say "REPRODUCE (same command, full output):"
  say "  docker build ${NET_ARGS[*]:-} -t huu:local $REPO_ROOT"
  say "FULL LOG: $BUILD_LOG"
  say "Nothing was started: running a stale huu:local silently is exactly what"
  say "this script exists to prevent."
  say "────────────────────────────────────────────────────────"
}

say "refreshing huu:local from the current source (cached layers skip fast)…"

# `if !` keeps `set -e` from killing the script before it can explain itself;
# `pipefail` (set above) makes the pipeline carry docker's status, not tee's.
# `${NET_ARGS[@]+"${NET_ARGS[@]}"}` and not `"${NET_ARGS[@]}"`: on anything but
# Linux this array is EMPTY, and bash 3.2 — the bash macOS still ships —
# treats an empty `"${arr[@]}"` as an unbound variable under `set -u`. The
# plain form would abort every macOS `npm start` before docker was even
# invoked. bash ≥ 4.4 does not care, so the bug is invisible on Linux.
if ! docker build ${NET_ARGS[@]+"${NET_ARGS[@]}"} -t huu:local "$REPO_ROOT" 2>&1 | tee "$BUILD_LOG" >&2; then
  diagnose_failure
  exit 1
fi

rm -f "$BUILD_LOG"
say "huu:local is up to date with the working tree"

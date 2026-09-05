# Operations · `huu`

> **Português (BR):** [docs/operations.pt-BR.md](operations.pt-BR.md)

How to run `huu` in production-like settings — Docker modes, configuration,
auto-scaling, cost control, port isolation, FAQ, roadmap.

## Table of contents

- [Docker](#docker)
  - [Lifetime and signals](#lifetime-and-signals)
  - [VPN / MTU handling](#vpn--mtu-handling)
  - [Isolated-volume mode](#isolated-volume-mode)
  - [Compose](#compose)
  - [Docker secrets](#docker-secrets)
  - [Image variants](#image-variants)
  - [Cookbook in the image](#cookbook-in-the-image)
  - [No native mode (docker-only)](#no-native-mode-docker-only)
- [Configuration](#configuration)
  - [API key registry](#api-key-registry)
  - [Environment variables](#environment-variables)
  - [Files written by the tool](#files-written-by-the-tool)
  - [Recommended models](#recommended-models)
- [Auto-scaling concurrency](#auto-scaling-concurrency)
  - [Memory guard: the pressure ladder](#memory-guard-the-pressure-ladder)
  - [Kernel memory ceilings](#kernel-memory-ceilings)
- [Cost predictability](#cost-predictability)
- [Port isolation (overview)](#port-isolation-overview)
- [Visual conventions](#visual-conventions)
- [FAQ](#faq)
- [Roadmap](#roadmap)
- [Contributing](#contributing)

---

## Docker

`huu` runs in Docker by default — your shell credentials, `~/.ssh`, and
`~/.aws` are never visible to the LLM agent. The recommended path is to
**build the image from source** (zero registry dependency, full
reproducibility):

```bash
git clone https://github.com/frederico-kluser/huu
cd huu
docker build -t huu:local .
HUU_IMAGE=huu:local huu run pipeline.json
# or: docker run --rm -it --user "$(id -u):$(id -g)" \
#       -v "$PWD:$PWD" -w "$PWD" -e OPENROUTER_API_KEY \
#       huu:local run pipeline.json
```

Pre-built images are published manually by the maintainer to
`ghcr.io/frederico-kluser/huu:<version>`. If a tag is available, the
wrapper pulls it automatically:

```bash
export OPENROUTER_API_KEY=sk-or-...
huu run pipelines/huu-test-suite.pipeline.json     # auto-uses ghcr.io/frederico-kluser/huu:latest
```

> huu writes the bundled default pipelines into `./pipelines/` on first
> launch — pick one on the welcome screen or pass its path.

Behind the scenes the wrapper builds the equivalent of:

```bash
docker run --rm -it \
  --cidfile /tmp/huu-cids/cid-<pid>-<rand>.id \
  --user "$(id -u):$(id -g)" \
  -v "$PWD:$PWD" -w "$PWD" \
  -e OPENROUTER_API_KEY \
  ghcr.io/frederico-kluser/huu:latest run pipelines/huu-test-suite.pipeline.json
```

> **Why mount `$PWD:$PWD` (same path on both sides)?** git stores
> absolute paths inside `.git/worktrees/<name>/gitdir`. Mounting under
> a different prefix would leave host-visible worktree pointers that
> resolve to nowhere when the container exits.

### Lifetime and signals

Lifetime is bound to your terminal. Ctrl+C, closing the terminal
(SIGHUP), and `kill` (SIGTERM) all stop the container reliably. The
wrapper traps each signal in the host process and issues
`docker kill --signal …` against the captured cidfile, which sidesteps
the long-standing [moby#28872](https://github.com/moby/moby/issues/28872)
where `docker run -it` sometimes drops signals on the way to the
container. Inside the container, [tini](https://github.com/krallin/tini)
(PID 1) forwards the signal to huu's Node process, the TUI's exit
handlers run, and `--rm` removes the container.

If the wrapper itself is killed hard (`kill -9`, OOM), the next `huu`
invocation prunes any orphan containers whose recorded parent PID is no
longer alive. Use `huu prune --list` to inspect lingering huu
containers, `huu prune --dry-run` to preview cleanup, and `huu prune`
to force kill them.

### VPN / MTU handling

**On a VPN (WireGuard / OpenVPN / Tailscale exit-node)? Just works.** At
wrapper startup, huu inspects the host's default-route MTU (on Linux).
When it's below 1500 — typical of VPN tunnels — huu auto-creates a
docker bridge named `huu-net-mtu<N>` with the matching MTU and runs the
container on it. No env var, no daemon.json edits, no
`--network=host`. The network is idempotent and reused across runs; if
your VPN MTU changes, a fresh per-MTU network is created next time.

To override (e.g., force `host` networking or use a pre-existing custom
network), set `HUU_DOCKER_NETWORK=<value>` — passed verbatim to
`docker run --network`. To inspect what huu created:
`docker network ls | grep huu-net-`.

Why this matters: without MTU clamping, the docker bridge (1500) >
tunnel (~1420) mismatch silently drops TLS ClientHello packets, and
every HTTPS handshake hangs. As defense-in-depth, the orchestrator also
runs an 8s OpenRouter reachability probe at run-start and aborts loudly
if upstream is unreachable, so you never burn 30 minutes on retry
loops.

### Isolated-volume mode

For max performance on macOS / Windows with full filesystem isolation:
tell huu to put worktrees on a named volume instead of inside the
bind-mounted repo. Branch operations stay on the repo (so the
integration branch still lands in your local `git log`); only the
per-agent scratch space goes to the fast volume.

```bash
docker volume create huu-worktrees
docker run --rm -it \
  --user "$(id -u):$(id -g)" \
  -v "$PWD:$PWD" -w "$PWD" \
  -v huu-worktrees:/var/huu-worktrees \
  -e HUU_WORKTREE_BASE=/var/huu-worktrees \
  -e OPENROUTER_API_KEY \
  ghcr.io/frederico-kluser/huu:latest run pipeline.json
```

`HUU_WORKTREE_BASE` accepts an absolute path (used verbatim) or a
repo-relative path (resolved against the repo root). When set,
`git worktree list` on the host won't show the active per-agent trees
during the run — that's the trade-off for the speedup.

### Compose

```bash
# uses the bundled compose.yaml (builds the image on first run)
export OPENROUTER_API_KEY=sk-or-...
docker compose run --rm huu run pipelines/huu-test-suite.pipeline.json
```

**Convenience wrapper:** drop [`scripts/huu-docker`](../scripts/huu-docker)
on your `PATH` to abbreviate the above to `huu-docker run pipeline.json`.

### Docker secrets

The auto-Docker wrapper handles `OPENROUTER_API_KEY` securely: it writes
the key to a `0600`-mode file under `/dev/shm` (Linux tmpfs — never
hits disk; falls back to `os.tmpdir()` elsewhere) and bind-mounts it
read-only at `/run/secrets/openrouter_api_key` inside the container.
The key value never appears in `docker inspect`, never appears in
`ps auxf`, and is unlinked from the host as soon as the wrapper exits.

For Compose-driven setups, the canonical pattern works:

```yaml
# compose.yaml fragment
services:
  huu:
    secrets:
      - openrouter_api_key
secrets:
  openrouter_api_key:
    file: ./openrouter.key  # or external: true with `docker secret create`
```

The image checks `/run/secrets/openrouter_api_key` before falling back
to `OPENROUTER_API_KEY_FILE` and finally the plain env var — same
precedence the postgres image uses.

### Image variants

- `huu:latest` (~613MB) — ships `openssh-client` for SSH-based git
  remotes.
- `huu:slim` (~604MB; build-arg `INCLUDE_SSH=false`) — drops it for
  HTTPS-only setups.

### Cookbook in the image

The official image ships the repo's reference pipelines at
`$HUU_COOKBOOK_DIR` (`/opt/huu/cookbook/`). Pull a curated pipeline
into your repo without cloning anything:

```bash
docker run --rm ghcr.io/frederico-kluser/huu:latest \
  cookbook pull huu-test-suite > my-test-pipeline.json
```

### No native mode (docker-only)

huu is **docker-only**: every pipeline run executes inside the
container, which carries the kernel memory ceiling (`--memory`) — the
one guarantee software can't undermine. The old native bypasses
(`--yolo`, `--no-docker`, `HUU_NO_DOCKER=1`) were **removed**: the CLI
detects them, prints a one-line notice, strips the flags and re-execs
into Docker anyway. What still runs on the host is not pipeline
execution: `huu --help` and the host utilities (`huu init-docker`,
`huu status`, `huu prune`). Inside the container, `HUU_IN_CONTAINER=1`
(set by the image) remains the internal short-circuit that keeps the
same binary from re-wrapping itself.

The one exception is for people working ON huu: `HUU_DEV_NATIVE=1` (what
`npm run dev` sets) runs the CLI on the host, no daemon involved, so the
edit→run loop doesn't pay a `docker build` + `docker run` every few seconds.
It is env-only, never a flag, and the CLI prints a loud banner on every start
because container isolation and the container memory ceiling are both absent —
on Linux the systemd self-wrap supplies a kernel ceiling, elsewhere only the
software guard remains. `npm run dev:docker` is the same hot reload through
Docker, and is what you should use to rehearse what a user actually gets.

### Troubleshooting: `denied: denied` on pull

`docker: ... error from registry: denied` means Docker could not pull the
image from GHCR — usually because the tag isn't published/is private, or
because of invalid cached credentials in `~/.docker/config.json` (GHCR
does not fall back to anonymous access in that case). Three ways out, from
simplest to most complete:

| Path | Command | When |
|---|---|---|
| Clear credentials | `docker logout ghcr.io` | Quick one-off fix |
| **Local build** | `docker build -t huu:local .` then `HUU_IMAGE=huu:local huu run …` | **Recommended** — reproducible, registry-free |
| Re-authenticate | `echo "$PAT" \| docker login ghcr.io -u <user> --password-stdin` | Need private images (PAT with `read:packages` scope) |

(Running natively is no longer an escape: huu is docker-only — the old
`--yolo`/`--no-docker` bypasses are ignored with a notice.)

---

## Configuration

### API key registry

`huu` resolves API keys through a declarative registry
(`src/lib/api-key-registry.ts`). Adding a key in the future is a
one-entry append; everything else (TUI prompt, Docker secret mount,
env-passthrough, orphan cleanup) iterates the same list.

The current registry:

| Key | Required | Backend | Used by |
|---|---|---|---|
| `OPENROUTER_API_KEY` (`openrouter`) | yes (without `--stub`) | Pi | The Pi SDK agent + the pipeline assistant + project recon. |
| `ARTIFICIAL_ANALYSIS_API_KEY` (`artificialAnalysis`) | yes | all | Model recommendations / live capability lookups in the picker. |
| `COPILOT_GITHUB_TOKEN` (`copilot`) | yes (when `--copilot`) | Copilot | The Copilot SDK agent. Fine-grained PAT with "Copilot Requests" scope, or `GH_TOKEN`. |

Resolution order for every spec (first non-empty wins) — the EXPLICIT
choice beats the AMBIENT one:

1. Container secret mount at `/run/secrets/<snake_case_name>` — same
   convention as the postgres / mysql Docker images. (On a Docker run the
   host resolves the key with this same order and re-mounts it here.)
2. The persisted global store at `$XDG_CONFIG_HOME/huu/config.json`
   (fallback `~/.config/huu/config.json`, mode `0600` in a `0700`
   directory; `HUU_CONFIG_DIR` overrides the location — the Docker
   wrapper sets it to the HOST's config dir and bind-mounts it RW, so
   keys saved from inside the container land on the host and survive
   `docker run --rm`). The TUI offers "save globally" the first time you
   paste a key, and the web **⚙ Settings → OpenRouter API key** panel's
   "Validate & save" writes here too. A key you explicitly saved
   OUTRANKS the env var below it.
3. `<NAME>_FILE` env var pointing at a file with the value.
4. `<NAME>` env var (plain) — the fallback when nothing is saved (the
   standard CI / headless path).

Any key that resolves to empty AND is `required: true` causes the TUI
to pop the prompt on the way to the first run. Stub mode (`--stub`)
short-circuits the requirement check.

Because the saved store (step 2) now outranks the env var (step 4), a key you
explicitly saved in the Options screen takes precedence — a stale
`OPENROUTER_API_KEY` left in a shell profile no longer shadows it. If you
*want* the env var to apply, clear the saved key. `resolveApiKeyWithSource`
reports which tier won, so the abort message names the real source: update the
saved key when that one was used, or fix the env var / save a key when the env
var was only the fallback.

The **web UI** has two key surfaces. A key pasted in the *launch form* stays
in that tab's `sessionStorage` — validated against the provider first, sent
with each run, never written to disk. The **⚙ Settings → OpenRouter API key**
panel *persists*: "Validate & save" checks the key against OpenRouter (a
rejected key is never saved), writes it to the config store above and arms a
live in-session override so every new run uses it immediately — even inside
Docker, where the startup secret-mount snapshot would otherwise keep winning
until restart. The panel shows which key is active and where it came from
(always masked), warns when an env var is being ignored, and "clear saved
key" falls back to the env var. A run whose key is rejected (401) reports the
source that actually supplied it — browser tab, web Options, saved store or
env var. Every key event (validated / rejected / saved / cleared) and every
run-lifecycle event is also logged to the terminal that launched huu.

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | yes (without `--stub`) | Sent to OpenRouter through the Pi SDK. If missing, the TUI prompts on first real run; "save globally" persists to `~/.config/huu/config.json`. |
| `OPENROUTER_API_KEY_FILE` | no | Path to a file containing the key. Wins over `OPENROUTER_API_KEY` when both are set; the canonical Docker-secret mount at `/run/secrets/openrouter_api_key` wins over both. A key saved via the Options screen (`~/.config/huu/config.json`) now outranks all three — clear it if you want an env var to apply. |
| `ARTIFICIAL_ANALYSIS_API_KEY` | yes | Used for live model-capability lookups (`supportsThinking`, pricing). Same precedence chain via `ARTIFICIAL_ANALYSIS_API_KEY_FILE` and `/run/secrets/artificial_analysis_api_key`. |
| `COPILOT_GITHUB_TOKEN` | yes (when `--copilot`) | GitHub fine-grained PAT with "Copilot Requests" scope (or `GH_TOKEN`). Required only when `--backend=copilot` is active. Same precedence chain via `COPILOT_GITHUB_TOKEN_FILE` and `/run/secrets/copilot_token`. |
| `HUU_WORKTREE_BASE` | no | Override the base directory for per-run worktrees. Absolute paths are used verbatim; relative paths are resolved against the repo root. Default: `<repo>/.huu-worktrees`. Used by the isolated-volume container mode. |
| `HUU_WORKSPACE` | no | Host directory the web **folder picker** may browse (bind-mounted RW into the container at the same absolute path). Default `$HOME`, so the picker sees every project under your home. Tighten it (`HUU_WORKSPACE=~/Projects`) or widen it (`HUU_WORKSPACE=/` for the whole filesystem). **Security:** the workspace is mounted read-write, so an agent's shell can read/write anything under it (including `~/.ssh` when it is `$HOME`) — keep it as small as your projects allow. The picker opens here (⌂ Home button) and `runDirectory` picks are resolved against it. |
| `HUU_CHECK_PUSH` | no | When set, preflight verifies the configured remote is reachable before the run starts. |
| `HUU_RAM_PERCENT` | no | RAM budget as a percent of TOTAL machine memory — the admission dial that governs concurrency. Default `70` (on a desktop the OS + browser + IDE routinely hold 20–30% of RAM, so the old `85` started every run already at the edge), clamped `10`–`95`; the budget is floored so the adaptive OS reserve (see `HUU_OS_RESERVE_MB`) stays untouchable. Machine-global (one machine, one RAM): in multi-run it configures the single shared budget scaler, with no per-project override. Also exposed as the CLI flag `--ram-percent=<n>` and the web Settings field "RAM budget %" — the web field now applies LIVE (`POST /api/settings` reconfigures current + queued runs immediately) and persists server-side in `~/.config/huu/web-settings.json`. See [Auto-scaling concurrency](#auto-scaling-concurrency). |
| `HUU_OS_RESERVE_MB` | no | Overrides the OS reserve — the slice of total RAM the budget (and the kernel ceilings) never touch. The default is now ADAPTIVE: `max(min(2 GiB, 25% of total), 8% of total, 512 MiB)` — the old flat 512 MiB was far too thin for a desktop. Value in MiB, capped at 90% of total. |
| `HUU_NO_HOST_CLAMP` | no | Set `1` to disable the host-availability clamp — huu then plans admission by the RAM-budget dial / container cgroup only, ignoring the host's `/proc/meminfo`. For dedicated hosts. Default: the clamp is on, so every admission plans with `min(budget headroom, host available − OS reserve)`. |
| `HUU_GUARD_*` | no | Threshold family for the graded **pressure ladder** that replaced the single ≥ 95% memory-guard trigger — available-RAM + free-swap floors, PSI `full` lines, swap-in rate/sustain, over-budget sustain, container-swap ceiling, re-preempt spacing, post-storm calm hold. All have safe defaults; the full table lives in [Memory guard: the pressure ladder](#memory-guard-the-pressure-ladder). |
| `HUU_PAUSE_BACKOFF_MS` | no | A paused task backs off before it resumes: `min(10s × 2^(pauses−1), 120s)` × a deterministic up-only jitter in `[1, 1.5)` keyed `runId#agentId#pauses` — de-syncs the multi-run herd. `0` disables the backoff. There is deliberately NO cap on the number of pauses. |
| `HUU_OOM_SCORE_ADJ` | no | Adjusts the huu process's `/proc/self/oom_score_adj` so the kernel's OOM-killer biases away from huu. Conservative default (`-100`, a mild nudge that does NOT immunize); best-effort — a NEGATIVE value only sticks with `CAP_SYS_RESOURCE`, which neither a plain user process nor the container (it runs `--user <uid>:<gid>`, non-root) has, so the nudge usually no-ops. The effective lever is `HUU_CHILD_OOM_SCORE_ADJ` below — RAISING a score needs no privilege. Linux-only. |
| `HUU_CHILD_OOM_SCORE_ADJ` | no | OOM bias for huu's DESCENDANT processes: a watcher sweeps `/proc` every 2 s and raises agent tool children (vitest workers, npm installs, builds…) to `oom_score_adj` `+500` (the default), so a kernel OOM kills a test runner — surfacing as a plain task retry — instead of the orchestrator or your desktop session. Set `0` to disable the watcher. Linux-only. |
| `HUU_NO_CGROUP` | no | Set `1` to skip the transient systemd user scope of the native systemd-scope wrap — now **dormant defense-in-depth** since huu is docker-only (the container `--memory` ceiling is the one in practice; see [Kernel memory ceilings](#kernel-memory-ceilings)). Without the flag the wrap already degrades to unwrapped, with a one-line stderr note, when systemd isn't usable. |
| `HUU_SWAP_MAX_MB` | no | Swap ceiling for huu's process tree, in MiB (default `4096`; `0` = no swap at all). Applied as the `--memory-swap` delta on the Docker container (and as `MemorySwapMax` on the dormant native systemd scope). |
| `HUU_DOCKER_MEMORY_MB` | no | Overrides the container's memory ceiling, in MiB. Default: host total − OS reserve, passed by the wrapper as `docker run --memory`. |
| `HUU_NO_MEM_LIMIT` | no | Set `1` to launch the container with NO memory ceiling (the legacy behavior — an unlimited container can consume 100% of host RAM). |
| `HUU_MAX_LIVE_RUNS` | no | Ceiling on multi-run executions live at once (default `8`). The effective cap ADAPTS DOWN to what the budget actually fits: `budget ÷ (HUU_RUN_BASELINE_MB + per-agent footprint)`. |
| `HUU_MAX_QUEUED_RUNS` | no | Total runs the web server accepts (default `256`; was a hardcoded 64). Queued runs cost no budget — queue as many projects as you want. |
| `HUU_RUN_BASELINE_MB` | no | Fixed per-run baseline (MiB, default `384`) charged against byte headroom when admitting a queued run, on top of the per-agent footprint. |
| `HUU_JCODE_HERMETIC` | no | Debug escape hatch for the **hermetic jcode runtime** — the live spelling; the old `HUU_PI_HERMETIC` name is gone and nothing reads it. Hermetic is the DEFAULT: every `jcode` subprocess huu spawns gets `JCODE_MEMORY_ENABLED=false` (zero embeddings), `JCODE_NO_TELEMETRY=1`, an isolated `JCODE_AGENT_DIR`, and a `JCODE_HOME` at `~/.huu/jcode-home` holding a `config.toml` huu writes itself — the host's `~/.jcode/config.toml` is **ignored**. Set `0`/`false` and `process.env` is passed through untouched, so jcode resolves its config from the host again (writes NO file, sets NO forced var). The wrapper forwards this variable into the container automatically — no `HUU_DOCKER_PASS_ENV` needed. |
| `HUU_AGENT_MEM_SEED_MB` | no | Cold-start seed for the AutoScaler's per-agent memory estimate, in MiB (clamped `128`–`4096`). The pessimistic default `1536` is a deliberate OOM guard — it under-admits until the EMA observes the real footprint. Lower it ONLY from evidence: watch `scaler`/`config` and `scaler`/`ema_move` in the debug NDJSON (or `AutoScaleStatus.observedAgentMemoryMb` in the UIs) across a few runs, then seed near the observed p95. |
| `HUU_AGENT_MEM_EMA_ALPHA` | no | Smoothing factor of the observed per-agent footprint EMA (clamped `0.01`–`1`; default `0.2` ≈ 5 s time constant at the 1 Hz poll). Raise it to converge faster from the seed to the measured footprint (more reactive, noisier); lower it for stability. |
| `HUU_IN_CONTAINER` | no | Set to `1` automatically by the official Docker image. Used by the wrapper to short-circuit the auto-Docker re-exec (so the same binary runs the TUI directly inside the container). |
| `HUU_IMAGE` | no | Override the container image used by the auto-Docker wrapper. Default: `ghcr.io/frederico-kluser/huu:latest`. Useful for pinning a release or pointing at a private mirror. |
| `HUU_NO_DOCKER` | no | **REMOVED — ignored with a notice.** huu is docker-only: the native pipeline-execution mode no longer exists. Like the removed `--no-docker`/`--yolo` flags, this variable is detected, a one-line notice is printed, and huu re-execs into the container anyway. CI also runs through Docker now — see [`docs/ci.md`](ci.md). |
| `HUU_DEV_NATIVE` | no | **Contributor escape hatch — not a product feature.** `1`/`true` skips the Docker re-exec entirely so the CLI runs on the host with no daemon; `npm run dev` sets it. Container isolation and the container memory ceiling are both OFF (agents reach `~/.ssh`, `~/.aws`, …), so huu prints a banner on every start. Env-only by design — the user-facing `--no-docker`/`HUU_NO_DOCKER` spellings stay removed. Use `npm run dev:docker` to iterate the way users actually run. |
| `HUU_DOCKER_NETWORK` | no | Pass-through value for `docker run --network=<value>`. By default huu auto-creates `huu-net-mtu<N>` when on a VPN (default-route MTU < 1500); set this to override (e.g., `host`, or the name of a pre-existing user-managed network). |
| `HUU_DOCKER_PASS_ENV` | no | Whitespace-separated list of additional env var names to forward into the container. The wrapper always forwards `OPENROUTER_API_KEY`, `OPENROUTER_API_KEY_FILE`, `HUU_CHECK_PUSH`, `HUU_WORKTREE_BASE`, `HUU_HOST_HOME`, `TERM`, every RAM-safety knob (`HUU_RAM_PERCENT`, the `HUU_GUARD_*` family, `HUU_OS_RESERVE_MB`, `HUU_MAX_LIVE_RUNS`, `HUU_MAX_QUEUED_RUNS`, `HUU_RUN_BASELINE_MB`, `HUU_OOM_SCORE_ADJ`, `HUU_NO_PAUSE`), the jcode hermetic hatch (`HUU_JCODE_HERMETIC`) and the `SURF_*` research knobs — a host `HUU_RAM_PERCENT` was previously ignored inside the container. Use this to add custom names. |
| `HUU_HOST_HOME` | no | Set automatically by the wrapper to the host's home directory. Inside the container, `getHuuHome()` reads it so writes to `~/.huu/` and the default `~/Downloads/` export target land on the host's bind-mounted filesystem. Unset outside Docker. |
| `HUU_CONFIG_DIR` | no | Set automatically by the wrapper to the HOST's huu config dir (`$XDG_CONFIG_HOME/huu`, default `~/.config/huu`), which is bind-mounted read-write into the container. `configFilePath()` (the saved-key store) and `webSettingsPath()` prefer it, so keys/settings saved from inside the container persist on the host. Unset outside Docker (local XDG resolution applies). |
| `HUU_WEB_LOG_STREAM` | no | Set `1` to ALSO mirror the raw agent-output firehose (streamed assistant/thinking text, per line) to the terminal that launched huu. The lifecycle log (runs queued/started/finished/failed, per-agent activity, key events, refused launches) is always on — this flag only adds the verbose stream. |
| `HUU_MAX_EVENT_LISTENERS` | no | Raises the Node EventTarget / EventEmitter default listener cap (default `256`; `0` keeps Node's own defaults) to silence a `MaxListenersExceededWarning` storm — pi adds one abort listener per tool call to the session `AbortSignal`. |
| `HUU_UID` | no | Container UID for `docker compose` runs. Default: `1000`. Override with `HUU_UID=$(id -u)` if your host UID isn't 1000, or use the `scripts/huu-compose` wrapper which sets it automatically. |
| `HUU_GID` | no | Container GID for `docker compose` runs. Same defaulting rules as `HUU_UID`. |

### Files written by the tool

| Path | Scope | Purpose |
|---|---|---|
| `~/.config/huu/config.json` | global | API keys persisted via the TUI's "save globally" prompt or the web **⚙ Settings → OpenRouter API key** panel (mode `0600` in a `0700` directory). Under Docker the dir is bind-mounted and pointed at by `HUU_CONFIG_DIR`, so in-container saves land here on the host. |
| `~/.huu/recents.json` | global | Recently-used models for the picker. |
| `~/.huu/pipeline-memory.json` | global | Pipelines saved from the TUI editor. |
| `<repo>/.huu-worktrees/<runId>/` | repo | One subdirectory per agent during a run; removed at the end (manifest preserved). |
| `<repo>/.huu/<stamp>-execution-<runId>.log` | repo | Full chronological transcript of a run. |
| `<repo>/.huu/<stamp>-execution-<runId>/agent-<id>.log` | repo | Per-agent transcript. |
| `<repo>/.huu/debug-<ISO>.log` | repo | NDJSON debug trace, one line per lifecycle event. |
| `<repo>/.huu-cache/native-shim/<os>-<arch>/` | repo | Compiled `bind()` interceptor. Built once, reused across runs. |
| `<worktree>/.env.huu` | per-agent | Per-agent port assignments; auto-loaded by dotenv-aware tools. |
| `<worktree>/.huu-bin/with-ports` | per-agent | Shell wrapper that sources `.env.huu` and `exec`s a command — needed for binaries that ignore dotenv. |

In host-bind mode (the default), all of these paths are visible on the
host filesystem after the container exits — the bind mount makes the
container writes land directly on the host. `huu` adds `.huu-worktrees/`, `.huu/`,
`.huu-cache/`, `.env.huu`, and `.huu-bin/` to the repo's `.gitignore`
on the first run.

### Recommended models

`recommended-models.json` ships a curated short-list shown at the top
of the model picker; its first entry is the **default model**,
`deepseek/deepseek-v4-flash` (fast, cheap, 1M context, tools +
reasoning) — it leads the recommended list and the web UI preselects
it. Each entry can carry optional metadata: `description`, `bestFor`
(use-case tags), `tier` (`planning` / `flagship` / `workhorse` /
`fast`), and `provider` (`openrouter` or `azure`).

In the **web UI**, the Model field loads the **full live OpenRouter
catalog** — every model, capability-annotated (`GET /api/models` →
`listAllModels` in `src/lib/openrouter.ts`). OpenRouter's `/models`
endpoint is **public**, so the catalog loads **with or without an
OpenRouter key**, the moment you open the picker; models that lack tool
calling are **badged** (`no tools`) rather than hidden, and you can type
any model id to use it verbatim. The curated short-list above is only the
offline / fetch-failure fallback.

When `ARTIFICIAL_ANALYSIS_API_KEY` is set, the quick picker renders a
fixed-width table with live metrics from Artificial Analysis —
`Model · tok/s · Agnt · Code · Razn · $in/$out · BestFor`. Without
the key, columns degrade to `—` placeholders without blocking selection.

---

## Auto-scaling concurrency

**Memory-aware auto-scaling is on by default.** Concurrency is governed
by a **RAM budget dial**: a configurable percent of TOTAL machine memory
(default `70`, clamped `10`–`95` — on a desktop the OS + browser + IDE
routinely hold 20–30% of RAM, so the old default of `85` started every
run already at the edge), floored so an **adaptive OS reserve**
stays untouchable — `max(min(2 GiB, 25% of total), 8% of total, 512 MiB)`,
overridable with `HUU_OS_RESERVE_MB` (the old flat 512 MiB was far too
thin for a desktop running a browser next to a big run). The auto-scaler
admits a new agent only while it fits inside that budget —
`ramBudgetBytes(total, percent) − ramUsedBytes` divided by the agent's
observed footprint — and the read is cgroup-aware, so inside a container
it respects the container's limit, not the host's. Set the dial with
`--ram-percent=<n>`, the `HUU_RAM_PERCENT` env var, or the web Settings
field "RAM budget %" — the web dial applies LIVE to current and queued
runs and persists server-side (`~/.config/huu/web-settings.json`); it is
machine-global (one machine, one RAM — no per-project override). Pass
`--concurrency=N` or `--no-auto-scale` to pin **manual mode** instead
(live-tunable with `+`/`-` on the run dashboard; `A` re-enables auto).
In headless configs, setting `"concurrency"` pins manual; omit it for
auto.

Five refinements keep the budget from overshooting on cold starts and
bursts:

- **PSI front brake (Linux).** The scaler reads memory Pressure Stall
  Information — the per-cgroup `memory.pressure` when containerized, else
  system-wide `/proc/pressure/memory` — and freezes admission the moment
  the `some avg10` value crosses ~0.5%. Pressure rises *before* RAM
  saturates, so this catches a burst the lagging RAM gate would miss.
  Where PSI is unavailable (macOS, kernels without `CONFIG_PSI`) it falls
  back to the RAM-budget gate above.
- **Pessimistic seed, mature-cohort EMA.** The per-agent estimate starts
  at 1536 MiB (clamped 128–4096) and a moving average corrects it from
  real measurements — but it samples only MATURE agents (≈ 45 s old):
  young agents haven't faulted in their full working set yet, and letting
  them into the average once dragged the estimate down into an
  over-admission spiral. The EMA is also asymmetric — it tracks up fast
  and down slowly — so a cold start deliberately under-admits and a
  scare is remembered.
- **Reservation accounting.** Admission charges in-flight spawns at the
  FULL footprint and young agents (< 45 s) at HALF, so a burst of
  admissions can't overshoot inside the 1–2 s window where metrics are
  stale. Near the budget edge the metrics poll accelerates 1 s → 250 ms,
  and the sampler also reads SwapTotal/SwapFree, PSI `full avg10` and
  the `/proc/vmstat` swap-in rate — the signals the pressure ladder
  below consumes.
- **Host-aware RAM accounting.** The metrics sampler also reads the
  host's `/proc/meminfo` pair (`hostMemTotalBytes` /
  `hostMemAvailableBytes`) — `/proc` is not namespaced, so a container
  reads the host's real memory — and every admission decision plans with
  the tighter of the two budgets: `min(budget headroom, host available −
  OS reserve)`. The smoothing is asymmetric: a host-availability DROP
  binds instantly while recovery is damped, so a host that fills up
  outside the container throttles huu at once. The pressure ladder's
  earlyoom floors likewise take the tighter of container-vs-host
  availability. On a dedicated host, `HUU_NO_HOST_CLAMP=1` turns the
  clamp off — huu then plans by the RAM-budget dial / container cgroup
  alone.
- **Fast-ramp.** The worker pool caps new spawns to
  `max(1, ceil(busy × 0.5))` per tick (~+50%/tick), so auto mode never
  floods the whole pool in a single tick. Manual mode still fills
  immediately.

The auto-scaler watches CPU and RAM via `lib/resource-monitor.ts` and
moves between five states, surfaced in the header as
`AUTO <STATE> · CPU/RAM · ~<N>MB/agent · free <N>MB`:

- **NORMAL** — under both thresholds, willing to spawn more agents up
  to the queue depth.
- **SCALING_UP** — actively granting spawn slots.
- **BACKING_OFF** — usage above the stop threshold (default 90%);
  refuses new spawns but leaves running agents alone.
- **DESTROYING** — the pressure ladder (below) demands shedding; the
  **newest** agent is preempted to recover headroom. By default it is
  **paused** — worktree, branch and session preserved, amber `PAUSED`
  card with a `⏸N` badge, resumed in place once headroom returns; it is
  killed and requeued (`↻N`, task restarts from zero) only when a
  checkpoint isn't possible or under `HUU_NO_PAUSE=1`. Older agents'
  work is never lost.
- **COOLDOWN** — 30s pause after a destroy or backoff event so the
  system doesn't oscillate.

Manual `+`/`-` on the dashboard automatically disables auto-scale —
press `A` to turn it back on. The **memory guard stays active in manual
mode** (the header swaps the `AUTO` chip for a `GUARD` chip with the
preempt count). The status block also shows live `CPU%` and `RAM%`,
mirroring the `SystemMetricsBar` so you don't have to correlate two
readouts.

**MAX mode (`M`, single-run TUI only)** is a third, **budget-greedy**
mode: it floods the pool with one agent per queued task — but only while
the RAM-budget dial still has headroom (the PSI brake and the legacy 95%
line also hold), instead of flooding up to the 95% destroy line as it
used to. The dial holds in every mode. The header shows a blue `MAX
<STATE>` chip with the preempt count; cooldown damping keeps it from
thrashing. Press `M` again (or `A`) to return to auto, `+`/`-` to drop
to manual. The **web UI no longer offers MAX**: every web run is
subordinate to the shared multi-run scheduler, where a per-run greedy
flag never drove anything — the topbar toggle cycles Auto ⇄ Manual, and
legacy `greedy` POSTs coerce to `auto`.

Override defaults by setting `agentMemoryEstimateMb`, `budgetPercent`,
`admitPsiThreshold`, `stopThresholdPercent`, `destroyThresholdPercent`,
`cooldownMs`, and `maxAgents` in code if you embed the orchestrator; the
CLI exposes `--ram-percent=<n>`, `--concurrency=N`, and `--no-auto-scale`.

### Memory guard: the pressure ladder

The memory guard used to have a single trigger — RAM or CPU ≥ 95% —
which a swapping host never crosses: it thrash-freezes first. It is
replaced by a graded **pressure ladder**, evaluated on every guard tick
in every concurrency mode (auto, manual and MAX):

- **L1 — over budget.** Usage sustained over the RAM-budget dial for
  ~3 s (`HUU_GUARD_OVER_BUDGET_MS`) → spawns freeze and the guard pauses
  the newest agents (one per tick, spaced by `HUU_GUARD_L1_REPREEMPT_MS`)
  until usage is back under the dial. L1 never drains below ONE live
  agent — the run degrades to sequential, never to zero.
- **L2 — host pressure** (earlyoom-style). Available RAM < 10% AND free
  swap < 10% (a host with no swap counts as swap-exhausted), OR PSI
  `full avg10` ≥ 5%, OR sustained swap-in (≥ 1000 pages/s for 2 s), OR
  the container spilling into its own `--memory-swap` allowance (cgroup
  v2 `memory.swap.current` ≥ `HUU_GUARD_CONTAINER_SWAP_PCT`% of
  `memory.swap.max`, default 50%), OR the legacy RAM/CPU ≥ 95% line →
  shed one victim EVERY tick, with the guard tick accelerated
  500 ms → 150 ms and admission of queued runs frozen.
- **L3 — emergency.** Available < 5% AND free swap < 5%, OR PSI `full`
  ≥ 20% — the same shedding, at the highest urgency.

The victim is always the **newest** agent (least work done, picked by
`startedAt`; in multi-run, the lowest-priority run's newest agent
first). Pausing is the default preemption — checkpoint the session,
dispose the agent to free RAM, keep the worktree + branch + transcript,
resume in place once headroom returns; `HUU_NO_PAUSE=1`, or a backend
that can't checkpoint, falls back to kill + requeue (`↻N`).

Guard pause/kill log lines carry the exact pressure-ladder REASON that
fired — e.g. `paused by memory guard — avail 0.4% + swap free 0.0%
below emergency floor (container RAM 98%)`, not a misleading bare
"RAM 9%" — and the line is published to the UI immediately.

Reserved judge / integration agents (ids `9998` / `9999`) COUNT in the
global RAM budget while they live, folded into demand and the pool's
busy side. They are NEVER preemption victims and their spawn path keeps
ZERO gates, so a frozen budget can throttle new work without ever
deadlocking a stage on its own judge or merge.

Every threshold has an env knob:

| Knob | Default | Level | Meaning |
|---|---|---|---|
| `HUU_GUARD_OVER_BUDGET_MS` | `3000` | L1 | How long usage must stay over the RAM-budget dial before spawns freeze and pausing starts. |
| `HUU_GUARD_L1_REPREEMPT_MS` | `2500` | L1 | Minimum spacing between successive L1 pause victims. |
| `HUU_GUARD_AVAIL_PCT` | `10` | L2 | Available-RAM floor (% of total), combined with the swap floor. |
| `HUU_GUARD_SWAP_FREE_PCT` | `10` | L2 | Free-swap floor (%). No swap configured counts as swap-exhausted. |
| `HUU_GUARD_PSI_FULL_HIGH` | `5` | L2 | PSI `full avg10` (%) — the canonical thrash signal. |
| `HUU_GUARD_SWAPIN_PAGES_SEC` | `1000` | L2 | Swap-in rate (pages/s) that counts as thrashing… |
| `HUU_GUARD_SWAPIN_SUSTAIN_MS` | `2000` | L2 | …when sustained for this long. |
| `HUU_GUARD_DESTROY_PCT` | `95` | L2 | The legacy RAM/CPU line, kept as a fallback trigger. |
| `HUU_GUARD_CONTAINER_SWAP_PCT` | `50` | L2 | % of the container `--memory-swap` allowance (cgroup v2 `memory.swap.current` / `memory.swap.max`) that trips an L2 verdict — the container spilling into its own swap. |
| `HUU_GUARD_AVAIL_PCT_EMERGENCY` | `5` | L3 | Emergency available-RAM floor (%). |
| `HUU_GUARD_SWAP_FREE_PCT_EMERGENCY` | `5` | L3 | Emergency free-swap floor (%). |
| `HUU_GUARD_PSI_FULL_EMERGENCY` | `20` | L3 | Emergency PSI `full avg10` (%). |
| `HUU_GUARD_REOPEN_CALM_MS` | `10000` | L2/L3 | Post-storm CALM HOLD (ms; `0` disables): after any L2/L3 verdict, spawn admission AND new-run admission stay frozen this long past the last high-pressure reading — both the single-run pool and the GlobalScheduler. Prevents the pause↔resume thundering herd. |

### Kernel memory ceilings

The ladder is software; the last line of defense is the kernel:

- **Docker (the ceiling in practice):** huu is docker-only, so every
  run gets this one. The wrapper passes `--memory` = host total − OS
  reserve, `--memory-swap` = memory + `HUU_SWAP_MAX_MB`, and
  `--pids-limit 8192` to the container. Override the ceiling with
  `HUU_DOCKER_MEMORY_MB` (MiB) or restore the legacy unlimited
  container with `HUU_NO_MEM_LIMIT=1`.
- **Native systemd scope (dormant defense-in-depth):** the code path
  that re-execs huu into a transient **systemd user scope**
  (`systemd-run --user --scope`) with `MemoryHigh` = total − OS reserve
  (the kernel throttles huu's whole tree before the host thrashes),
  `MemoryMax` = total − reserve/2 (worst case huu is killed inside its
  scope, never the host), `MemorySwapMax` = `HUU_SWAP_MAX_MB` (default
  4096 MiB; `0` = no swap) and `TasksMax=8192` remains in the tree, but
  with the native pipeline-execution mode removed it no longer fires in
  normal operation. When systemd isn't usable it degrades to unwrapped
  with a one-line stderr note; `HUU_NO_CGROUP=1` opts out.

`huu status` prints a **ram containment** doctor section: the dial and
where it came from (web-settings / env / default), the budget in bytes,
the OS reserve, the kernel ceiling detected on the current cgroup (or
"NONE — software guard only"), live PSI some/full + swap, and every
`HUU_*` safety knob currently set. It also prints a `host:` line — what
huu may claim on this machine right now (host available − OS reserve) —
and a `docker:` preview of the `--memory` ceiling the wrapper will pass
and the in-container budget it yields.

---

## Cost predictability

A `huu` run's cost is bounded by the number of cards and the model
chosen per stage. There is no agent loop that can decide to "also do
X" — you get the run you paid for.

**Today's tools to keep cost in check:**

- `--stub` runs the entire flow without any LLM. Use it to validate
  pipeline structure and decomposition before spending a dollar.
- `--copilot` uses subscription-based Copilot credits instead of
  per-token billing — cost stays within your existing GitHub plan's
  premium-request quota.
- Per-step `modelId` lets you route mechanical stages to Haiku / Gemini
  Flash and reserve Sonnet / Opus for stages that actually need it.
- Tokens and cost are recorded per agent and surfaced in the run
  summary; full breakdown in `.huu/<runId>-execution-...log`.

**Roadmap:** `huu estimate <pipeline.json>` will dry-run the
decomposition and produce a forecast like:

```
5 stages × 12 tasks × Sonnet 4.5: estimated $3.40, ~14 min wallclock.
```

Until that lands, the convention is: stub-validate first, then run
with eyes on the kanban during the first stage to catch surprises
early.

---

## Port isolation (overview)

`git worktree` isolates the **filesystem**. It does not isolate the
**host network**: when ten agents simultaneously launch `npm run dev`
they all hit `bind(3000)` on the same kernel. Nine fail with
`EADDRINUSE`, and the agents — correctly believing the customer code
is fine — burn tokens "fixing" a non-bug.

`huu` defends in four layers (none require Docker):

1. **`PortAllocator`** assigns each agent a contiguous window of TCP
   ports (default `55100 + (agentId − 1) × 10`).
2. **`.env.huu` per worktree** — a dedicated env file exporting
   `PORT`, `HUU_PORT_HTTP`, `HUU_PORT_DB`, `HUU_PORT_WS`,
   `DATABASE_URL`, and seven extras. Frameworks that respect dotenv
   (Next, Vite, Nest, Astro, dotenv-flow, …) load it automatically.
3. **Native `bind()` interceptor.** A ~170-line C shared library at
   `native/port-shim/port-shim.c`. The orchestrator compiles it with
   `cc` and preloads it via `LD_PRELOAD` (Linux) or
   `DYLD_INSERT_LIBRARIES` (macOS). Customer code is never modified —
   `app.listen(3000)` literal in source ships exactly as written; the
   kernel just sees a per-agent port instead.
4. **System prompt** — the agent is shown its allocated ports and
   reminded to prefix non-dotenv-aware commands with the
   `./.huu-bin/with-ports <command>` shell wrapper.

**Coverage matrix, exclusions, disabling, and the full design:**
[`PORT-SHIM.md`](PORT-SHIM.md).

To opt out for pure refactors / static analysis / doc generation, add
`"portAllocation": { "enabled": false }` to the pipeline.

---

## Visual conventions

**Magenta = AI actions.** Whenever you see a purple panel or marker
(`✦`) — the **Smart Select** mode (`S` on the file picker), the
**Pipeline Assistant**, **Project Recon**, **agent logs** — there is
an LLM being invoked on your behalf. Cyan is neutral
navigation/selection; green is confirmation/success; yellow is
intermediate state or warning; red is error; blue is non-AI auxiliary
information (helper modals, non-AI scopes).

Tokens are defined in [`src/ui/theme.ts`](../src/ui/theme.ts).
Components that introduce new magenta usage outside of AI contexts
should pick another color.

---

## FAQ

**Can I run this unsupervised, overnight?**
Yes — it's the primary use case. Each agent has timeouts and retries;
the run terminates itself with a persisted summary. Read
`.huu/<runId>-execution-*.log` in the morning. To get notified on
completion, wire the CLI exit code into a notifier (ntfy, webhook,
Slack incoming-webhook, your habit of choice).

**Will the run touch my checked-out branch?**
No. Every agent works in its own worktree branched off your current
HEAD. Your working tree is never modified during a run.

**Do I need to commit before running?**
Yes. Preflight refuses to start on a dirty working tree. Stash or
commit first.

**What happens if an agent crashes mid-run?**
The orchestrator marks the card as failed, drops its worktree, and
(depending on `maxRetries`) re-spawns the task in a fresh worktree on
the same integration HEAD. If retries are exhausted, the run
continues without that card and the failure is preserved in the
summary.

**Why did an agent's card jump back to TODO with a `↻` badge (or show an
amber `⏸` PAUSED)?**
The always-on memory guard fired. It runs a graded **pressure ladder** —
sustained usage over the RAM-budget dial (L1), earlyoom-style
host-pressure floors, PSI `full` or sustained swap-in (L2/L3), with the
old ~95% RAM/CPU line kept only as a fallback — and preempts the
**newest** agent, one victim per tick (the tick accelerates 500 ms →
150 ms under host pressure) so the older agents' work survives. By
default the victim is **paused** (worktree + session preserved, amber
`⏸N`, resumed in place once headroom returns); it is killed and requeued
(`↻N`, restart from zero) only when a checkpoint isn't possible or with
`HUU_NO_PAUSE=1`. At L1 the guard never drains below ONE live agent — a
run degrades to sequential, never to zero. The guard is active in every
concurrency mode (auto, manual, and MAX). Memory-aware auto-scale is the
default; pin a fixed agent count with `--concurrency=N` or
`--no-auto-scale` (or `"concurrency": N` in a headless config).
Thresholds: [Memory guard: the pressure ladder](#memory-guard-the-pressure-ladder).

**Can I run huu in CI (GitHub Actions / GitLab)?**
Yes — the job needs a runner with **Docker available** (GitHub's hosted
runners ship it; on GitLab use a docker-enabled job). Drive the run
with `huu auto` — the wrapper re-execs into the huu image as usual; pin
it with `HUU_IMAGE`. Native CI execution (`--no-docker` /
`HUU_NO_DOCKER=1`) was removed — the flags are ignored with a notice.
Full recipes, including artifact upload of `.huu/audits/`:
[`docs/ci.md`](ci.md).

**What if two agents touch the same file?**
A sign the pipeline was misdesigned: in a healthy pipeline, each task
in a stage owns a disjoint file. If overlap happens anyway and git
can't auto-merge, an integration agent backed by a real LLM resolves
the conflict on a side worktree and continues. Conflict resolution is
disabled in `--stub` mode. Treat this path as a safety net, not a
feature.

**Can I abort a run safely?**
Yes. `Q` triggers a cooperative abort: in-flight agents finish their
current step, branches with commits are kept as artifacts, the
integration worktree is cleaned up. Press `Q` again to force-exit the
dashboard.

**How much will I spend?**
Depends on pipeline shape and model. A 30-file pipeline on Sonnet 4.5
typically lands between $1 and $10. Use `--stub` to validate
structure first; route mechanical stages to cheaper models via
per-step `modelId`. The run summary breaks cost down per agent.

**Why two timeout values?**
Single-file cards usually finish faster than whole-project cards by an
order of magnitude. Splitting the timeout means tight feedback on
per-file work without prematurely killing a broader card that's still
making progress.

**Where do I put my API key?**
For **Pi** (default backend): export `OPENROUTER_API_KEY` before
launching, or paste it in the prompt the first time you start a run
without it. For **Copilot**: export `COPILOT_GITHUB_TOKEN` (GitHub
PAT with "Copilot Requests" scope). The tool itself never persists
the key unless you choose "save globally" in the TUI prompt.

**Why is the Docker container slower on macOS?**
Bind-mounted filesystems on macOS cross a VM boundary, adding ~3×
latency for many-small-files operations like `git worktree add`. Use
[OrbStack](https://orbstack.dev/) instead of Docker Desktop for ~2×
faster file I/O on the same workload.

**Can I run huu on Windows without WSL2?**
Not practically. Docker Desktop on Windows requires either WSL2 or
Hyper-V, and bind-mounted Windows paths (`/mnt/c/...`) are 10–20×
slower than ext4 inside WSL — enough to make `git worktree add` for
a real pipeline take minutes per task. Install WSL2, clone your repo
into `/home/<user>/` inside WSL, and use Docker Desktop with WSL
integration enabled.

**Why does Ctrl+C in the container sometimes leave my terminal wedged?**
It shouldn't — the image runs `tini` as PID 1 to forward signals,
and `huu`'s CLI installs a belt-and-suspenders raw-mode restorer
for `SIGINT`/`SIGTERM`/`SIGHUP`/`uncaughtException`. If you ever see
a stuck terminal, run `stty sane` to recover and please open an
issue with the contents of `.huu/debug-<ISO>.log` from that run.

**Files in `.huu-worktrees/` are owned by root and I can't delete them.**
You're on a host where your primary user isn't UID 1000. Either:
1. Use `scripts/huu-compose run pipeline.json` — auto-detects your
   UID via `id(1)` and exports `HUU_UID`/`HUU_GID`.
2. Export once per shell: `export HUU_UID=$(id -u) HUU_GID=$(id -g)`
   and then use `docker compose run` normally.

---

## Roadmap

- `huu estimate <pipeline.json>` — dry-run cost and wallclock forecast.
- `huu lint <pipeline.json>` — detect overlapping `files` across
  stages, missing `$file` placeholders, undefined model IDs.
- `huu/cookbook` — community pipeline registry, with each entry
  tagged by domain (testing, audits, refactors, docs).
- GitHub Action wrapper — run a `huu` pipeline as part of CI on a
  labeled PR.
- JSON Schema + LSP for `huu-pipeline-v1.json` — autocomplete and
  validation in editors.

---

## Contributing

`huu` is open-source under [Apache 2.0](../LICENSE). Issues and pull
requests are welcome.

Ground rules:

- Read the relevant skill under `.agents/skills/` before changing a
  layer you're not familiar with.
- Prefer **Conventional Commits** (`feat:`, `fix:`, `refactor:`,
  `docs:`, …).
- Never force-push to `main`.
- CI runs the gate (`.github/workflows/gate.yml` → `scripts/gate.sh`) on
  every push and pull request. Still run `npm run typecheck && npm test`
  locally before opening a PR — CI only reports after you push. Enable the
  pre-push hook with `git config core.hooksPath .githooks` to enforce it.
  `bash scripts/gate.sh` reproduces the CI run exactly.

```bash
npm run dev          # hot-reload on src/cli.tsx, NATIVE (no Docker at all)
npm run dev:docker   # same hot reload, through Docker (rehearses the real thing)
npm run build        # tsc → dist/
npm run typecheck    # tsc --noEmit
npm test             # vitest (orchestrator, run logger, file scanner, pipeline e2e)
```

Smoke tests for releases:

```bash
docker build -t huu:local .
./scripts/smoke-image.sh        # ~10s — image sanity
./scripts/smoke-pipeline.sh     # ~60s — end-to-end pipeline with --stub
```

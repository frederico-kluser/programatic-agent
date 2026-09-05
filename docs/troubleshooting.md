# Troubleshooting

> Every fatal run error in huu carries an **actionable reason** — it shows on
> the red summary screen, in the headless final JSON (`errorReason`), and in
> the run log. This page expands each failure mode: symptom → cause → fix.
>
> Português: [troubleshooting.pt-BR.md](troubleshooting.pt-BR.md)

## Where to look first

| Surface | What it tells you |
|---|---|
| **Summary screen** | Red = the run failed (the ⚠ line is the root cause + next step). Yellow = run finished but some agents errored (first failure shown). Green = clean. |
| **Run dashboard** | `ENTER` on any card opens its full log. `F` filters the log column per agent. |
| `.huu/debug-*.log` | Process-wide NDJSON debug log (secrets redacted). |
| `.huu/<stamp>-execution-<runId>.log` | Full per-run log + per-agent splits. |
| Headless final JSON | `ok`, `status`, `errorReason`, per-agent `state`/`error`. Exit code ≠ 0 on failure. |

## Preflight failures (run never starts)

| Symptom | Cause → fix |
|---|---|
| `not a git repository` | huu runs ON a repo. `git init` first (huu offers to). |
| push-permission errors at start | Preflight probes push when `HUU_CHECK_PUSH` demands it. Fix the remote/credentials, or unset the probe for offline repos. |

## API keys & models

| Symptom | Cause → fix |
|---|---|
| key prompt loops / `401` in agent logs | The resolver chain is `/run/secrets/<name>` → `~/.config/huu/config.json` (saved key) → `<VAR>_FILE` → env → TUI prompt (first non-empty wins). Save one in the Options screen, or export `OPENROUTER_API_KEY` (or the backend's var), and retry. |
| **a *valid* key still `401s`** | A key you saved in Options takes precedence over the env var, so a `401` usually means the *saved* key was rejected. Easiest fix: open the web **⚙ Settings → OpenRouter API key**, paste a working key and **Validate & save** — it is checked against OpenRouter first (a rejected key is never saved), takes effect for every new run immediately (Docker included) and persists; **clear saved key** there falls back to the env var. The 401 message names the source that ACTUALLY supplied the rejected key (browser tab / web Options / saved store / env var), and every key + run event is logged in the terminal that launched huu. Confirm which key is dead with `curl -H "Authorization: Bearer <key>" https://openrouter.ai/api/v1/auth/key` (a `401` there = that key is bad). A key pasted in the *launch form* (as opposed to ⚙ Settings) stays in that browser tab only. |
| `402` / `429` in agent logs | Provider credits/rate limit — not a huu failure. Pick a cheaper model or wait. |
| model id rejected | Use an id from the selector/catalog (`recommended-models.json`); OpenRouter ids look like `vendor/model-name`. |

## Agents: timeouts, retries, failures

- Every card gets `maxRetries` (default 1) fresh-worktree retries; a timeout
  aborts the in-flight request before retrying.
- **Symptom: cards die at exactly N minutes** → raise the per-card timeouts
  in pipeline settings (`T` in the editor): whole-project and single-file
  timeouts are separate.
- **Symptom: agent error after retries** → the summary's yellow ⚠ shows the
  first failure; open the card (`ENTER`) for the full log. The run still
  merges every agent that DID commit.
- **Retry a failed card yourself** → when a run ends with cards in error it
  pauses in **`awaiting_retry`** (status pill **review**, amber) instead of
  jumping to the summary, keeping the integration worktree alive. A **timeout**
  shows amber (`TIMEOUT`/`timeout`), any other failure red (`FAILED`/`failed`).
  - **TUI**: focus the card, press **`R`** to retry it (a timeout asks for a new
    time limit first), **`D`** to finish, **`Q`** to abort.
  - **Web**: click the red/amber card → drawer **Retry** button (timeouts get a
    minutes field); **Finish** leaves the review hold.
  - The card re-runs against the current integration HEAD and, on success, its
    branch is merged in — no need to re-run the whole pipeline. User retries
    show a `⟳N` badge. (Single-run TUI and any web run only; the multi-run TUI
    has no per-card retry.)
- **Symptom: cards return to TODO with `↻N`** → not an error: the memory
  guard killed the newest agent under RAM pressure and requeued it.

## Web UI: a run looks frozen / the live board stopped updating

The browser runs an **SSE liveness watchdog** — a real `event: ping`
heartbeat plus 60-second staleness detection that FORCE-RECONNECTS a zombie
SSE stream and resyncs the board WITHOUT a manual page refresh, so a
momentarily frozen board should self-heal within ~60s.

If you DO refresh the page mid-queue, the project queue SURVIVES the reload:
it persists each run's status + `runId` (localStorage `huu-queue-v2`) and
RE-LINKS to the still-live runs in the huu process instead of resetting them
to "pending". The run itself lives in the huu process, not the browser —
closing or reloading the tab never stops it; only **Stop** or quitting `huu`
(Ctrl+C) does.

## Merge conflicts {#merge-conflicts}

`stage integration failed: unresolved merge conflicts` — parallel agents
edited the same lines in one stage.

1. Narrow each task's write surface: per-file prompts should write ONLY to
   `$file`; project-scope steps that share files with a parallel branch
   belong in different waves (`dependsOn`).
2. Set `pipeline.integrationModelId` to a stronger model — the conflict
   resolver is an LLM agent and benefits from it.
3. The **stub backend never resolves conflicts** by design (a no-LLM run must
   not silently ship a bad merge): structural dry-runs need conflict-free
   pipelines.

## Memory files (`scope: "memory"`)

| Symptom | Cause → fix |
|---|---|
| stage completed with **0 tasks** + warning | The memory file wasn't at `filesFrom` in the integration worktree. Legitimate when the producer found nothing; otherwise check the path (typo?) and that the producer's stage committed the file. |
| run fails with `is not valid JSON` / `does not match huu-memory-v1` | The producer wrote a malformed file. Declare `produces` on it so huu appends the exact format contract — or paste the format into its prompt. See [memory-scope.md](memory-scope.md). |
| fewer agents than listed entries | Read the warnings: nonexistent / duplicate / skip-listed / escaping paths are dropped one by one; `maxFiles` truncation is logged. |

## Runaway loops {#runaway-loop}

`pipeline exceeded maxNodeExecutions=N`:

- **Legacy (linear) pipelines**: a check whose chosen outcome keeps pointing
  BACKWARDS re-runs the same segment forever. Make the SAFE outcome the
  `default: true` one (forward), and bound the check with `maxRuns`.
- **DAG (wave) pipelines**: an outcome/`next` re-pends its target plus the
  whole downstream cone every time it fires. Same fix — forward defaults,
  bounded `maxRuns` — or raise `pipeline.maxNodeExecutions` if the rework
  budget is genuinely larger.

## Judges (check steps)

- A yellow **DEFAULT** badge on a judge card means the fallback fired (judge
  failed, emitted an unknown label, or hit `maxRuns`) — the run took the
  `default: true` outcome. Make conditions objectively checkable ("file X
  exists and section Y is non-empty"), not vibes.
- Judges run in the integration worktree with shell access; their last JSON
  block (`{ "label": ..., "reason": ... }`) is the verdict.

## Ports (`EADDRINUSE`, shim)

- Parallel agents get disjoint port windows (base 55100) via `.env.huu` +
  the `with-ports` shim — but only for processes launched THROUGH
  `.huu-bin/with-ports`. A server that still binds the original port wasn't.
- `HUU_PORT_DEBUG=1` logs every remap. Coverage limits (static Go, musl
  Rust, SIP-protected binaries): [PORT-SHIM.md](PORT-SHIM.md).

## Git state {#git-state}

- `cannot read integration HEAD` → a previous run's leftovers are in the
  way. `huu prune` kills orphan containers and cleans stale state; deleting
  `.huu-worktrees/<runId>/` by hand is safe (branches survive as artifacts).
- Run branches (`huu/<runId>/...`) are artifacts on purpose — delete them
  with normal git when you're done reviewing.

## Docker

| Symptom | Cause → fix |
|---|---|
| changes to huu itself don't take effect | A globally-installed `huu` re-execs into the PUBLISHED image. Iterate with `scripts/huu-try` (always builds + runs `huu:local` via Docker; `--no-build` skips the build), or `docker build -t huu:local . && HUU_IMAGE=huu:local huu …`. Developing IN the repo, `npm start` / `npm run dev:docker` AUTO-REBUILD `huu:local` first (`scripts/ensure-image.sh`, layer-cached ~2s) so you never run stale baked code; set `HUU_IMAGE=<other>` to skip the rebuild as a deliberate pin. For the fast loop, `npm run dev` (`HUU_DEV_NATIVE=1`) runs on the host with no Docker at all — no image to go stale, but also no container isolation. (`HUU_NO_DOCKER=1` is a DIFFERENT door — the user-facing native bypass — and it works; see [operations.md](operations.md#docker-by-default-native-as-an-opt-in).) |
| orphan containers after a crash | `huu prune` (uses recorded cidfiles). |
| network hangs on VPN | huu auto-creates an MTU-matched bridge; override with `HUU_DOCKER_NETWORK`. |
| CI runner without Docker | huu is docker BY DEFAULT, not docker-only: run with `--no-docker` / `HUU_NO_DOCKER=1` to go native instead (loses the container's memory ceiling), or use a docker-enabled runner/job to keep it; recipes in [ci.md](ci.md). |

## macOS: runs idle forever at $0 (fixed)

Versions before the `vm_stat` fix could never spawn agents on a warmed-up
Mac: `os.freemem()` counts only truly-free pages, RAM% saturated ≥95% and
the auto-scaler gated the pool forever (status `running`, activeAgents 0,
cost $0). Update huu; the monitor now derives available memory from
vm_stat's reclaimable pages.

## Aborting

`Q` on the dashboard aborts the run (twice force-exits the screen). Merged
work stays merged; in-flight agents are disposed; pending/merging cards are
swept to `error: aborted` so nothing sits in TODO forever.

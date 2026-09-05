# Architecture

This document describes the layered structure of `huu` and the design decisions behind it. For onboarding-level guidance, contributors should also consult the relevant `.agents/skills/<domain>/SKILL.md`.

## Layered tree

```
src/
├── cli.tsx                    # entry CLI (argv, --help, --concurrency/--no-auto-scale, terminal restoration; --yolo/--no-docker/--docker resolve the runtime — flag > env > saved `huu setup` config > docker default)
├── app.tsx                    # screen router (welcome / assistant / editor / run / summary)
├── lib/
│   ├── types.ts               # Pipeline, AgentStatus, RunManifest, AutoScaleStatus, defaults
│   ├── card-state.ts          # pure agent-card → column/label (kanban truth contract; web mirror src/web/client/card-state.js)
│   ├── pipeline-io.ts         # JSON read/write (format v1)
│   ├── file-scanner.ts        # repo file tree (gitignore-aware)
│   ├── run-id.ts              # opaque run identifiers
│   ├── run-logger.ts          # per-run chronological + per-agent logs
│   ├── debug-logger.ts        # NDJSON tracing under .huu/
│   ├── api-key-registry.ts    # declarative spec list (openrouter, artificialAnalysis, …)
│   ├── api-key.ts             # generic resolver (mount → saved store → _FILE → env; store at ~/.config/huu/config.json, HUU_CONFIG_DIR overrides — the wrapper points it at the host dir under Docker)
│   ├── docker-reexec.ts       # auto-execs into the official image; signal-safe; secret-file mount
│   ├── active-run-sentinel.ts # /tmp/huu/active for the HEALTHCHECK probe
│   ├── init-docker.ts         # `huu init-docker` scaffolder
│   ├── status.ts              # `huu status` headless monitor
│   ├── prune.ts               # `huu prune` manual orphan inspection / cleanup
│   ├── resource-monitor.ts    # CPU/RAM sampling for the auto-scaler + SystemMetricsBar
│   ├── package-info.ts        # version/name pulled from package.json (used by --help and TUI)
│   ├── model-factory.ts       # LangChain ChatOpenAI factories (OpenRouter-tuned)
│   ├── openrouter.ts          # OpenRouter helpers shared by recon + assistant
│   ├── project-digest.ts      # compact project summary (file tree, package.json, README, …)
│   ├── project-recon.ts       # 4-agent pre-flight LLM recon (digest-only, single-pass)
│   ├── project-recon-prompts.ts  # mission statements for the four recon roles
│   ├── assistant-client.ts    # LangChain chat client used by the pipeline assistant
│   ├── assistant-prompts.ts   # interview system prompt + initial human message
│   └── assistant-schema.ts    # Zod schema for AssistantTurn / PipelineDraft
├── git/
│   ├── git-client.ts          # git wrapper with credential-helper isolation
│   ├── worktree-manager.ts    # create / dispose worktrees
│   ├── branch-namer.ts        # deterministic branch naming
│   ├── preflight.ts           # repo-state validation
│   └── integration-merge.ts   # branch merge into the central worktree
├── orchestrator/
│   ├── index.ts               # Orchestrator class (pool, lifecycle, abort, destroyAgent)
│   ├── task-decomposer.ts     # step → tasks
│   ├── stub-agent.ts          # synthetic lifecycle for demos / tests
│   ├── simulation/            # SimulationEngine: synthetic /simulation web demo (no git/LLM/key)
│   ├── real-agent.ts          # real LLM agent via pi-coding-agent
│   ├── integration-agent.ts   # LLM conflict resolver
│   ├── auto-scaler.ts         # resource-bound concurrency state machine
│   ├── port-allocator.ts      # per-agent TCP port windows + probe
│   ├── agent-env.ts           # .env.huu writer + with-ports shim
│   ├── native-shim.ts         # on-demand compile of bind() interceptor
│   ├── agents-md-generator.ts # writes per-agent AGENTS.md briefings
│   └── types.ts               # AgentFactory and friends
├── models/                    # OpenRouter catalog + global recents
├── contracts/                 # zod schemas
├── prompts/                   # static prompt fragments shared by agents
└── ui/
    ├── components/
    │   ├── PipelineAssistant.tsx   # conversational pipeline authoring
    │   ├── PipelineEditor.tsx
    │   ├── PipelineImportList.tsx
    │   ├── PipelineIOScreen.tsx
    │   ├── ProjectRecon.tsx        # 4-agent pre-flight recon view
    │   ├── StepEditor.tsx
    │   ├── FileMultiSelect.tsx
    │   ├── ModelSelectorOverlay.tsx
    │   ├── RunDashboard.tsx
    │   ├── RunKanban.tsx
    │   ├── RunModal.tsx
    │   ├── LogArea.tsx
    │   ├── Spinner.tsx
    │   ├── SystemMetricsBar.tsx
    │   └── ApiKeyPrompt.tsx
    ├── hooks/
    │   ├── useTerminalClear.ts
    │   ├── useTerminalResize.ts
    │   └── useSystemMetrics.ts
    └── safe-terminal.ts       # belt-and-suspenders TTY restoration

native/
└── port-shim/
    ├── port-shim.c            # bind() interceptor (LD_PRELOAD / DYLD)
    └── Makefile               # local build target

scripts/
├── deploy.sh                  # interactive release driver (semver bump + tag + optional ghcr push)
├── huu-docker                 # bash wrapper documented in the README's Docker section
├── huu-compose                # auto-detects host UID/GID for `docker compose run`
└── smoke-image.sh, smoke-pipeline.sh
```

Dependencies flow **downward only**: the UI never imports the orchestrator's internals, and the orchestrator never imports the UI. See [`.agents/skills/architecture-conventions/SKILL.md`](../.agents/skills/architecture-conventions/SKILL.md) for the full set of layering rules.

## How a run unfolds

```
┌─────────────┐   ┌─────────────────┐   ┌─────────────────────────┐
│  Preflight  │──▶│ Build pipeline  │──▶│ Pick model + concurrency│
└─────────────┘   └─────────────────┘   └─────────────────────────┘
                                                     │
                                                     ▼
              ┌─────────────────────────────────────────────────┐
              │ Graph cursor (v2 — supports check nodes)        │
              │   1. Decompose work steps into tasks            │
              │   2. Walk steps as a directed graph:            │
              │      - WorkStep → spawn agents, merge to integ  │
              │      - CheckStep → spawn judge in integ wt,     │
              │        parse verdict JSON, jump to outcome      │
              │   3. Each agent commits to its own branch       │
              │   4. Merge branches serially into integration   │
              │   5. (rare) LLM resolves conflicts on a side wt │
              │   6. Next visit branches off updated integration│
              │      (loops re-execute on top — NEVER rewind)   │
              │   7. Caps: maxRuns/check, maxNodeExecutions/run │
              └─────────────────────────────────────────────────┘
                                                     │
                                                     ▼
                                        ┌────────────────────────┐
                                        │ Cleanup + summary view │
                                        └────────────────────────┘
```

1. **Preflight** validates repo state (clean tree, valid base branch, push capability where relevant).
2. The **integration worktree** is created on a disposable branch named `huu/<runId>/integration`.
3. Per stage, the orchestrator decomposes the step into tasks — one whole-project task, one per picked file, or (`scope: "memory"`) one per path listed in a `huu-memory-v1` file an **earlier step wrote**, read from the integration worktree with per-entry hints reaching prompts via `$hint` (see [`memory-scope.md`](memory-scope.md)) — allocates them to a bounded worker pool, and lets each agent work in its own worktree under `<repo>/.huu-worktrees/<runId>/`. Each worktree also receives a per-agent TCP port window (`.env.huu`) and a `.huu-bin/with-ports` shim — see [`PORT-SHIM.md`](PORT-SHIM.md) and the [`isolating-agent-ports`](../.agents/skills/isolating-agent-ports/SKILL.md) skill.
4. As soon as all tasks for the stage finish, branches are merged serially into the integration worktree. In the rare case where a poorly-decomposed pipeline produces overlapping edits in the same stage, an integration agent backed by a real LLM resolves the conflict on a side worktree. Failed or timed-out tasks are retried up to `maxRetries` times in fresh worktrees.
5. The next stage branches off the **HEAD of the updated integration**, so each step sees the changes from every previous step. **Conditional steps (`type: "check"`, v2)** insert decision nodes into this flow: a judge agent runs in the integration worktree (no commits, shell access only), emits a JSON verdict, and the cursor jumps to the matching outcome's `nextStepName`. Loops back to earlier steps re-execute on top of the current HEAD — the integration worktree is monotonic, it never rewinds. See [`docs/pipeline-json-guide.md`](pipeline-json-guide.md#conditional-steps-check-nodes) for the schema and `orchestrator/check-evaluator.ts` for the judge spawner.
6. Cleanup removes the integration worktree. Per-agent branches are preserved as artifacts; logs land under `.huu/`.

> See [`.agents/skills/orchestrating-git-worktrees/SKILL.md`](../.agents/skills/orchestrating-git-worktrees/SKILL.md) for the full lifecycle, branch naming, merge strategy, and conflict-resolution rules.

## Authoring layer (pipeline assistant + project recon)

The pipeline assistant (`ui/components/PipelineAssistant.tsx`) is the
guided alternative to writing JSON by hand. Triggered with `A` on the
welcome screen, it walks through five stages:

```
pick-model → intent → recon → asking ↻ ──┬──> editor (PipelineDraft → Pipeline)
                              answering ─┘
                              free-text ─┘
```

1. **`pick-model`** — the same `ModelSelectorOverlay` the run flow uses;
   the default is the cheap `DEFAULT_ASSISTANT_MODEL` because authoring
   shouldn't cost as much as running.
2. **`intent`** — a single free-text input describing what the pipeline
   should do.
3. **`recon`** — `lib/project-recon.ts` fans out four parallel
   `ChatOpenAI` calls (LangChain over OpenRouter), each with a focused
   mission (`stack`, `structure`, `libraries`, `conventions`). They
   share a single pre-built `lib/project-digest.ts` snapshot — the
   agents have **no tool access** and run **single-pass, digest-only**,
   so cost and latency are bounded. Each emits up to five terse bullets.
   Default model: `minimax/minimax-m2.7`. The aggregated bullets get
   embedded into the assistant's system prompt so the interview is
   project-specific.
4. **`asking` ↔ `answering` / `free-text`** — up to `MAX_TURNS = 8`
   multiple-choice questions. Every question carries a free-text escape
   hatch as its last option. The schema for each turn lives in
   `lib/assistant-schema.ts` (Zod-validated `AssistantTurn`). When the
   model emits a `done` turn, its `PipelineDraft` is converted to a
   `Pipeline` and handed to the editor.
5. The standard editor opens with the draft pre-loaded — review, tweak,
   `G` to run.

The assistant uses LangChain (`@langchain/openai`, `@langchain/core`)
because the OpenAI tool-calling/structured-output surface there is
better-tested than building a JSON-mode loop on the Pi SDK. The Pi SDK
is reserved for the actual run agents — they need filesystem tools, and
LangChain doesn't.

## Auto-scaling layer

`orchestrator/auto-scaler.ts` is a small state machine driven by
`lib/resource-monitor.ts` (1Hz CPU/RAM sampling). It exposes three
hooks the worker pool consults: `shouldSpawn()`, `shouldDestroy()`, and
`notifyAgentSpawned/notifyTaskQueued`. The states are surfaced to the
UI via `OrchestratorState.autoScale` (`AutoScaleStatus`):

| State | Meaning |
|---|---|
| `NORMAL` | Under both thresholds; will grant `shouldSpawn() === true`. |
| `SCALING_UP` | Actively granting spawn slots while the queue has work. |
| `BACKING_OFF` | CPU or RAM ≥ stop threshold (default 90%); refuses new spawns but leaves running agents alone. |
| `DESTROYING` | The memory guard now fires on a **pressure ladder**: sustained over the RAM budget dial (L1), plus earlyoom-style host pressure — low host-available **and** low free swap, high PSI `full`, or sustained swap-in — at L2/L3; the old CPU/RAM ≥ 95% line is only a legacy fallback. The newest agent is then **paused by default**: `pauseAgent()` checkpoints the pi session, disposes the agent to free RAM, PRESERVES its worktree + branch + transcript, and re-queues the task in a `paused` phase, resuming it **in place** (same worktree, restored session) once headroom returns. Only when the backend can't checkpoint or `HUU_NO_PAUSE=1` is set does it fall back to the legacy KILL — `destroyAgent(newestId)` drops the worktree + branch and requeues the task from zero. |
| `COOLDOWN` | 30s pause after a destroy/back-off event so the system doesn't oscillate. |

Manual `+`/`-` on the run dashboard disables auto-scale (a single `A`
press re-enables it); `M` toggles **MAX mode** (`greedy`) — flood one
agent per queued task and let the memory guard alone hold the line,
surfaced as a blue `MAX` chip. Admission is **host-aware**: beyond the
container cgroup, `shouldSpawn()` also reads the host `/proc/meminfo` and
clamps the concurrency target to `min(budget headroom, host available −
OS reserve)`. A **paused** agent re-queues its task in the `paused` phase
and resumes in place once headroom returns; a hard **kill** (checkpoint
impossible or `HUU_NO_PAUSE=1`) instead lands on the `killed_by_autoscaler`
lifecycle phase. Both are preserved in the run summary.

## Docker layer (host wrapper + container runtime)

The `huu` binary is the same in both worlds; an environment-gated branch
at the very top of `cli.tsx` decides which it is.

```
                   ┌─────────────────── HOST ────────────────────┐
                   │                                             │
                   │  $ huu run pipeline.json                    │
                   │       │                                     │
                   │       ▼                                     │
                   │  cli.tsx top-level                          │
                   │  decideReexec(argv, env)                    │
                   │       │                                     │
                   │       ├── --yolo/--no-docker/      → native │
                   │       │   HUU_NO_DOCKER=1   (loud no-isolation
                   │       │   warning; kernel ceiling lost)      │
                   │       ├── --help/-h               → native  │
                   │       ├── init-docker|status|prune → native │
                   │       ├── --docker      → re-exec (forced)  │
                   │       ├── setup.runtime==='native' → native │
                   │       └── otherwise (default)      → re-exec│
                   │                                  │          │
                   │  reexecInDocker(argv):           │          │
                   │  spawn `docker run --rm -it     │           │
                   │    --cidfile /tmp/huu-cids/...  │           │
                   │    --user $UID:$GID             │           │
                   │    -v $PWD:$PWD -w $PWD         │           │
                   │    -e OPENROUTER_API_KEY ...    │           │
                   │    ghcr.io/.../huu:latest`      │           │
                   │                                  │          │
                   │  Trap SIGINT/SIGTERM/SIGHUP →   │           │
                   │    docker kill --signal <X>     │           │
                   │      <cid>                      │           │
                   │                                  ▼          │
                   └─────────────────────────────────┼───────────┘
                                                     │
                   ┌──────────── CONTAINER ──────────┼───────────┐
                   │                                 ▼           │
                   │  PID 1: tini                                │
                   │   └─ PID 2: huu-entrypoint (shell)          │
                   │        └─ PID 3: huu (Node)                 │
                   │              cli.tsx (HUU_IN_CONTAINER=1    │
                   │              short-circuits the re-exec)    │
                   │                                             │
                   │  HEALTHCHECK probe reads /tmp/huu/active    │
                   │  (sentinel written by the TUI launcher) and │
                   │  cd's there before `huu status --liveness`. │
                   └─────────────────────────────────────────────┘
```

Key invariants:

- **Same-path bind mount.** `-v $PWD:$PWD -w $PWD` keeps the absolute paths git stores inside `.git/worktrees/<name>/gitdir` consistent on both sides. Without this, worktrees created in the container resolve to nowhere on the host.
- **Wrapper-side signal trap, not docker's sig-proxy.** [moby#28872](https://github.com/moby/moby/issues/28872) documents that `docker run -it` sometimes drops signals on the way to the container. We trap in the host process and explicitly `docker kill <cid>` to bypass that.
- **Orphan prune on startup.** SIGKILL of the wrapper bypasses traps and would leave orphans. The next `huu` invocation reads stale cidfiles in `/tmp/huu-cids/`, checks the recorded parent PID with `process.kill(pid, 0)`, and kills any container whose parent is gone.
- **Subcommand affinity.** `init-docker` and `status` operate on host filesystem state — running them in a container with a bind mount works but is wasted work. They stay native.

## Design decisions

| Decision | Choice | Why |
|---|---|---|
| LLM SDK | [`@mariozechner/pi-coding-agent`](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) via OpenRouter | Lean, multi-provider-capable SDK designed for coding agents. |
| MCP | Not supported, deliberately | Tool definitions × N parallel agents = a significant fixed token cost on every turn before any useful work. Pi SDK's default tools (read/bash/edit/write) cover the supported use cases. |
| Conflict resolution | Integration agent (real LLM) on a side worktree | Fallback for misdesigned pipelines, not a core path — see "Decomposition is human work" in the README. |
| Worktree location | `<repo>/.huu-worktrees/<runId>/` | Isolated edits, native git audit trail. |
| Per-agent network isolation | `LD_PRELOAD` / `DYLD_INSERT_LIBRARIES` shim that rewrites `bind(2)` against a per-agent port table | No Docker, no privileges, no edits to customer code. Worktrees isolate FS but not network — without this, parallel `npm run dev` invocations collide on port 3000. See [`PORT-SHIM.md`](PORT-SHIM.md) for the full alternatives analysis (Docker / netns / code rewriting / serialization rejected). |
| Native shim build | On-demand compile via `cc` into `<repo>/.huu-cache/native-shim/<os>-<arch>/` | Avoids shipping prebuilts; gracefully falls back to env-only mode when `cc` is unavailable. Source at `native/port-shim/port-shim.c` (~170 lines C). |
| Recents storage | `~/.huu/recents.json` (global) | Stays out of repo state. |
| Default concurrency | `10` (live-tunable with `+`/`-`) | Empirically a good default for OpenRouter throughput. |
| Default port range | `55100..55300` for the default ceiling of 20 agents (10 ports per agent; configurable via `pipeline.portAllocation`) | Above well-known + registered ranges; TCP probe slides the window forward — as far as ~55900 — if the user already occupies part of it. |
| Default timeouts | `300000ms` single-file · `600000ms` multi-file/whole-project | Single-file work has very different latency from whole-project work. |
| Default retries | `1` per card | Retries run in fresh worktrees off the current integration HEAD. |
| Pipeline editor | Full in-app TUI, plus JSON import/export | Pipelines are reusable artifacts and round-trip cleanly. |
| Pipeline assistant | Conversational drafting with mandatory single-pass project recon | Authoring is the work; the recon is digest-only (`lib/project-digest.ts` + `lib/project-recon.ts`) so cost is bounded and the interview can ground itself in real project facts before asking ≤8 questions. |
| Auto-scaling | Resource-bound state machine (`orchestrator/auto-scaler.ts`) | Overnight runs need concurrency to track CPU/RAM headroom without operator input. The guard fires on a **pressure ladder** (sustained over the RAM dial at L1; earlyoom-style host pressure at L2/L3; the old CPU/RAM ≥ 95% line is a legacy fallback) and **pauses** the newest agent by default (checkpoint + resume-in-place; falls back to kill+requeue when it can't checkpoint or `HUU_NO_PAUSE=1`), with a 30s cooldown after each event; admission is host-aware (clamps to host `/proc/meminfo` availability). Manual `+`/`-` disables auto-scale until `A` re-enables. |
| API key registry | Declarative spec list (`lib/api-key-registry.ts`) | Adding a key is a one-entry append; resolver, TUI prompt, Docker-secret bind-mount, env passthrough, orphan secret-file cleanup all iterate the same list. |
| Native escape hatch | **Honored, not removed** — docker is the default, not the only runtime | `--yolo` / `--no-docker` / `HUU_NO_DOCKER=1` bypass the container on purpose (`decideReexec`, `docker-reexec.ts`) and run the whole CLI on the host, at the cost of container isolation and the `--memory` kernel ceiling — huu warns loudly on every such start. `--docker` mirrors it, forcing the container even over a `native` runtime saved by `huu setup`. Precedence is flag > env > saved config > default. On Linux a native run still gets a kernel ceiling from the systemd-scope self-wrap; elsewhere only the software AutoScaler guard remains. Only `--help` and the host utilities (`init-docker`, `status`, `prune`) always run on the host regardless of runtime. |

## Agent skills

The `.agents/skills/` directory contains the skill system every task in this repo routes through (source of truth, mirrored into `.claude/skills/` via per-skill symlinks). It is also the canonical reference if you are extending `huu`.

Start at [`project-router`](../.agents/skills/project-router/SKILL.md); the canonical routing index is [`catalog.md`](../.agents/skills/catalog.md) — 18 skills: 1 router · 9 knowledge (architecture, orchestrator, git worktrees, LLM backends, ports, Docker, tests, docs, agent-prompts) · 6 task (pipelines, default pipelines, TUI, web UI, commit gate, release) · 2 meta (evolution, consolidate).

A human-facing overview of how the system works (routing, LEARNINGS, evolution, consolidation) lives at [`agent-skills.md`](../agent-skills.md).

## Logs and debugging

- The kanban dashboard streams `LogArea` lines for every agent in real time. Use `F` to scope the log column to a single agent.
- Each agent card shows a per-action counter label (`stream`/`tool`/`file`/`log`/`usage`/`done`/`error`, tallied from the live `AgentEvent` stream into `AgentStatus.actionCounts`) and leads its telemetry line with the most recent action (`→ <action>`, from `AgentStatus.lastAction`). Both are bumped in `handleAgentEvent` and accumulate like tokens/logs (not reset on a memory-guard requeue).
- A card's kanban column and label come from the shared pure `lib/card-state.ts` (web mirror `src/web/client/card-state.js`, kept in lockstep) — the **kanban truth contract**: green `DONE` only after the agent's branch has MERGED into the integration worktree (`AgentStatus.merged`, tri-state); blue `READY` while the agent is finished-awaiting-merge (still in the DOING column); amber `UNMERGED` when integration failed or the run ended with the branch never landing (`mergeFailed`); and a memory-guard-**PAUSED** card renders in the TODO column (its task is re-queued). Manifests predating the `merged` flag stay backward-compatible.
- The run summary screen shows totals (cost, tokens, duration), per-agent outcomes, and the full list of merged branches.
- For deeper post-mortems, open the chronological log under `.huu/`. It records every state transition, prompt, tool call, and merge result.
- A keyboard "freeze" diagnostic trace lands in `.huu/debug-<ISO>.log` (NDJSON). The CLI sets up this logger before mounting Ink, so even crashes during initial render leave a trail.

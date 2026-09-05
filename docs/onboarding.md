# Onboarding · `huu`

> **Português (BR):** [docs/onboarding.pt-BR.md](onboarding.pt-BR.md)

This is the long-form tutorial for `huu`. The [README](../README.md) is the
pitch and a quick taste — this is the walkthrough.

huu designs pipelines that make thinking agents follow a deterministic
process — built for audits, test generation, knowledge extraction, and
any assembly-line process with real, predictable value, not for
building new features.

## Table of contents

- [Install](#install)
- [First run: smoke with `--stub`](#first-run-smoke-with---stub)
- [First real run: Pi / OpenRouter](#first-real-run-pi--openrouter)
- [Same run with GitHub Copilot](#same-run-with-github-copilot)
- [When to use huu / when not to](#when-to-use-huu--when-not-to)
- [huu vs alternatives](#huu-vs-alternatives)
- [Example walkthrough: huu Test Suite](#example-walkthrough)
- [Authoring your own pipeline](#authoring-your-own-pipeline)
  - [The TUI editor](#the-tui-editor)
  - [Pipeline Assistant (`A` on welcome)](#pipeline-assistant)
  - [Saved pipelines (`S` on welcome)](#saved-pipelines)
- [Headless mode (`huu auto`)](#headless-mode)
- [Backends deep dive (Pi · Copilot · Stub)](#backends-deep-dive)
- [Bundled default pipelines](#bundled-default-pipelines)
- [Pipelines as a shared artifact](#pipelines-as-a-shared-artifact)
- [Philosophy](#philosophy)

---

## Install

`huu` runs in Docker by default — your shell credentials, `~/.ssh`, and
`~/.aws` are never visible to the LLM agent. Two installation paths:

### Docker (recommended)

```bash
git clone https://github.com/frederico-kluser/huu
cd huu
docker build -t huu:local .
HUU_IMAGE=huu:local huu run pipeline.json
```

Pre-built images are published manually by the maintainer to
`ghcr.io/frederico-kluser/huu:<version>` — CI runs the test gate but
publishes nothing. If a tag is available, the wrapper pulls it
automatically:

```bash
export OPENROUTER_API_KEY=sk-or-...
huu run pipelines/huu-test-suite.pipeline.json     # auto-uses ghcr.io/frederico-kluser/huu:latest
```

> huu writes the bundled default pipelines into `./pipelines/` on first
> launch — pick one on the welcome screen or pass its path.

**Prerequisites:**

| OS | Install |
|---|---|
| Linux | `sudo apt install docker.io docker-compose-v2` (or your distro's equivalent — see [docker.com/engine/install](https://docs.docker.com/engine/install/)) |
| macOS | [OrbStack](https://orbstack.dev/) (recommended, ~2× faster bind mounts than Docker Desktop) or [Docker Desktop](https://www.docker.com/products/docker-desktop/) |
| Windows | [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install) + [Docker Desktop](https://www.docker.com/products/docker-desktop/) with WSL integration enabled |

> **Windows users:** clone your repo inside the WSL filesystem (`/home/...`)
> — not `/mnt/c/...` — for native performance. Bind mounts that cross the
> Windows/WSL boundary are 10–20× slower for the many-small-files I/O that
> `git worktree add` does.

### Docker by default, native as an opt-in

```bash
npm install -g huu-pipe        # Node 20+, a working `git`, and Docker
huu                            # re-execs itself into the container
```

huu runs in the container **by default**, which carries the kernel
memory ceiling and isolates your shell credentials from the agent.
`--yolo` / `--no-docker` / `HUU_NO_DOCKER=1` skip the container on
purpose — for targets that already run their own Docker, where nesting
containers is the problem — and cost exactly those two guarantees; huu
prints a one-line warning on every such start. `--docker` is the
mirror, forcing the container for one run even over a saved `native`
runtime. On the first `npm start`, `huu setup` asks which runtime (and
which front-end) you want and saves it to
`~/.config/huu/config.json` — reopen the question any time with `huu
setup`. Precedence: **flag > env > saved config > default**. Only
`--help` and the host utilities (`init-docker`, `status`, `prune`) run
outside the container regardless of runtime. CI needs a docker-enabled
runner to use the default — see [`docs/ci.md`](ci.md) for the GitHub
Actions / GitLab recipes.

For more on Docker run modes (compose, isolated-volume mode, secrets,
VPN/MTU), see [`docs/operations.md#docker`](operations.md#docker).

---

## First run: smoke with `--stub`

The stub agent runs the entire flow without invoking any LLM. Use it to
check that your install works, that worktrees mount, and that your repo
is in a state `huu` can run on.

```bash
huu --stub
```

You'll see the welcome screen. Press `N` to create a new pipeline, fill
in trivial steps, then run it. Each "agent" writes a `STUB_*.md` file
into its worktree and the orchestrator merges them. No tokens spent.

---

## First real run: Pi / OpenRouter

```bash
export OPENROUTER_API_KEY=sk-or-...
huu run pipelines/huu-test-suite.pipeline.json
```

huu ships **seven bundled pipelines** and materializes them into
`./pipelines/` on first launch. The default — highlighted on the welcome
screen — is **huu Test Suite**: it autonomously selects the most
test-worthy files and writes a unit-test suite for them. Pick any pipeline
on the welcome screen (or pass its path, as above). A minimal pipeline of
your own is just a list of steps with a `$file` token, e.g.:

```json
{
  "_format": "huu-pipeline-v2",
  "pipeline": {
    "name": "standardize-headers",
    "steps": [
      {
        "name": "Standardize headers",
        "prompt": "Add a JSDoc header at the top of $file with @author huu.",
        "files": ["src/cli.tsx", "src/app.tsx"],
        "scope": "per-file"
      }
    ]
  }
}
```

What you'll see on a real run:

1. The **backend selector** (Pi / Copilot — skipped when you pass
   `--backend=`, `--copilot`, or `--stub` on the CLI).
2. The model picker (catalog from OpenRouter or Copilot, with your
   recents pinned to the top and live metrics from Artificial Analysis
   when `ARTIFICIAL_ANALYSIS_API_KEY` is set).
3. A live kanban with one card per agent — phase, tokens, cost, current
   file. Memory-aware auto-scaling is on by default; `+`/`-` pin manual
   concurrency and `A` turns auto-scale back on at any time.
4. After all stages finish: a summary screen, plus per-agent
   transcripts under `.huu/<runId>-execution-...log`.
5. On disk: a new branch `huu/<runId>/integration` with the merged work,
   plus per-agent branches preserved for `git log` audits.

If you don't have a pipeline yet, press `A` on the welcome screen instead
of `N` — the [Pipeline Assistant](#pipeline-assistant) runs an adaptive
project recon and walks you through ≤8 questions to draft one for you.

The bundled defaults that land in `./pipelines/` on first launch:

- **huu Test Suite** — autonomous unit-test suite (the default, highlighted
  on the welcome screen).
- **huu Knowledge System** — builds a skills/knowledge system from the repo.
- Five report-only audits: **huu Docs Audit**, **huu Quality Audit**,
  **huu Performance Audit**, **huu Refactor Plan**, **huu Security Audit**.

See [Bundled default pipelines](#bundled-default-pipelines) for the full
table.

---

## Same run with GitHub Copilot

```bash
export COPILOT_GITHUB_TOKEN=ghp_...      # fine-grained PAT, "Copilot Requests" scope
huu --copilot run pipelines/huu-test-suite.pipeline.json
```

Same pipeline, same orchestrator, same merge logic — the only difference
is the agent factory and the cost model (subscription instead of
per-token). The Copilot SDK is declared as an `optionalDependency`; if it's
absent at runtime, picking the Copilot backend produces a clear error and
the rest of `huu` keeps working.

Copilot support is currently **stabilizing**. Pi / OpenRouter is the
recommended default.

---

## When to use huu / when not to

The concrete problem `huu` solves is more specific than "general coding
tasks": **applying the same class of transformation to N independent files,
with per-file auditability.** Canonical cases:

- Writing unit tests for 30 modules.
- Per-file security audit (OWASP), partial reports, consolidation in a
  final stage.
- High-repetition refactors: typing 80 JS files, migrating 40 Mocha
  tests to Vitest, adding JSDoc to 50 functions.
- Plan + parallel execution: stage 1 writes a `PLAN.md`, stage 2
  applies it across N files.

`huu` is **not** the right tool for:

- Bugs whose root cause is unknown — you need interactive exploration first.
- Architectural refactors that touch cross-cutting shared state.
- Feature work whose scope emerges from exploring the code.
- Monorepos with complex cross-package dependencies.
- Work where you want the system to surprise you with solutions.

For these cases, use Claude Code, Cursor, Aider, or Plandex. `huu` is
deliberately the opposite: you know what you want, you know which files
to touch, and you want parallelism plus auditability. **If you don't
yet know what you want to do, it is too early to use this.**

---

## huu vs alternatives

| Tool family | Approach | Use when |
|---|---|---|
| Claude Code, Cursor, Aider | Chat-driven, exploratory | You don't yet know what to do. |
| Claude Code `/batch` | LLM-driven decomposition with a human approval gate | You want batched tasks but trust an LLM to slice them. |
| Plandex, Devin, OpenHands | LLM-driven decomposition, autonomous execution | You trust the system to decide scope. |
| Conductor, Claude Squad | Parallel workspaces, human merge per branch | You want parallelism with PR-level human review of each task. |
| **huu** | **Human-written plan, parallel execution, native git audit** | **You know the scope exactly and want a reusable, versioned pipeline.** |

The honest difference vs `/batch`: `huu` will not decide that step 3
should also touch a file you didn't list. The pipeline is the contract —
the human underwrote it.

---

## Example walkthrough

### huu Test Suite — step by step

`huu Test Suite` is the default pipeline materialized on first run. It is
the canonical demonstration of why mixing `project` and `per-file` scope
matters. Source: `src/lib/default-pipelines/huu-test-suite.ts`.

**Step 1 — `Analyze stack and write huu-tests.md`** · scope `project`

One agent runs on the whole repo. It detects the language (Node / Python /
Go / Rust / Java / .NET), verifies the test runner exists, and writes
`huu-tests.md` with the test conventions to follow + initializes
`huu-tests-faq.json`. This is the **plan** all later steps obey.

**Step 2 — `Test 3 representative files`** · scope `project`

One agent picks 3 diverse business-logic files, writes tests for each,
fixes failures, and appends learnings to `huu-tests-faq.json`. Output:
3 working test files + a richer FAQ.

**Step 3 — `Test $file (user-selected)`** · scope `per-file`

This is where parallelism kicks in. You select N files during the run;
the orchestrator spawns N agents, each receiving exactly **one** file as
its mission via the `$file` placeholder. Each agent reads the whole
worktree for context, follows `huu-tests.md`, writes a test for its
single file, recovers from failures, and appends its learnings to the
shared FAQ. They run in parallel and merge cleanly because they own
disjoint files.

**Step 4 — `Final cleanup + coverage badge`** · scope `project`

One agent runs the full suite, deletes only the failing test **blocks**
(never entire files), measures coverage, and updates the README.md badge.

**Why this is the showcase**

- Step 1 creates a contract (`huu-tests.md`) that step 3 obeys, agent by
  agent. The intelligence is in the *plan* — not in each agent
  re-deriving conventions.
- Step 3 is `per-file`: each agent has **one mission** (one file). The
  prompt is identical across the N agents — only `$file` is substituted.
  No context degradation, no scope drift between agents.
- Worktrees merge between steps. Step 2 doesn't see step 3's tests — step
  4 sees both, plus an FAQ that accumulated learnings across all of them.

This is the template for everything else: **plan in `project`, execute
in `per-file`, validate in `project`.**

---

## Authoring your own pipeline

You write the pipeline by hand, or via the assistant. Either way you end
up with a `huu-pipeline-v1.json` artifact that's portable and auditable.

### The TUI editor

After `huu` opens, press `N` on the welcome screen. Keys:

- `N` — new work step
- `C` — new check step (LLM-judged routing)
- `T` — timeouts
- `M` — model picker (per-step override)
- `S` — Smart Select for the file picker (magenta — LLM-driven)
- `↑↓` / `Enter` / `ESC` — standard nav

Full reference: [`docs/KEYBOARD.md`](KEYBOARD.md).

The editor saves to global memory automatically (see [Saved pipelines](#saved-pipelines))
and you can export to a `huu-pipeline-v1.json` file at any time.

### Pipeline Assistant

If you'd rather describe what you want in natural language, press `A` on
the welcome screen.

What happens, in order:

1. **Adaptive project recon.** A lightweight selector LLM receives your
   intent, a compact project digest, and a catalog of available recon
   missions (stack analysis, structure mapping, library audit,
   conventions scan, …). It picks the subset that's actually relevant
   (up to 10) and can synthesize fully custom missions when the catalog
   doesn't cover an angle. Selected missions fan out in parallel — each
   produces up to five terse bullets. Findings are aggregated and
   injected into the assistant's system prompt so the interview is
   project-specific rather than generic.
2. **Interview.** You describe your intent (`"add JSDoc to every helper
   under src/utils"`); the assistant asks at most **8 follow-up
   questions**, one at a time, each multiple-choice with an escape hatch
   to free-text.
3. **Draft → editor.** The assistant emits a `PipelineDraft` (validated
   by Zod) converted to a normal `huu-pipeline-v1` pipeline and handed
   to the standard editor. From there it's the same flow as a
   hand-written pipeline.

The assistant uses a cheap default model (recon uses
`minimax/minimax-m2.7`) so authoring cost is bounded — the heavy models
are reserved for the actual run.

### Saved pipelines

Pipelines edited in the TUI are persisted automatically to a **global
memory store** at `~/.huu/pipeline-memory.json`. Close `huu`, reopen
later, and pick up where you left off without re-importing a JSON file.

From the welcome screen, press `S` to open the **Saved Pipelines Manager**:

- **↑↓** to navigate, **Enter** to load a pipeline into the editor.
- **D** to delete a saved pipeline (with confirmation).
- **ESC** to go back.

Pipelines are saved by name — editing one loaded from memory auto-saves
back. The memory file is global (not per-repo).

**Inside Docker, saves still land on the host.** The wrapper bind-mounts
the host's `~/.huu` into the container at the same absolute path and
sets `HUU_HOST_HOME=$HOME`, so `~/.huu/pipeline-memory.json` and
`~/.huu/pipelines/` are the same files whether you run `huu` natively,
via the auto-reexec, or through `docker compose -f compose.huu.yaml run --rm huu`.
A pipeline saved inside the container will be there when you reopen
`huu` outside it.

---

## Headless mode

For CI, cron, demos, or any unattended invocation:

```bash
huu auto <pipeline.json> --config <config.json>
```

The config JSON supplies everything the interactive TUI would normally
collect — model, backend, per-step file overrides, timeouts:

```json
{
  "modelId": "minimax/minimax-m2.7",
  "backend": "pi",
  "files": {
    "3. Test $file (user-selected)": ["src/index.ts"]
  },
  "singleFileCardTimeoutMs": 300000,
  "maxRetries": 1,
  "concurrency": 4
}
```

`files` is a map keyed by **`step.name`** (exact match — typos surface
as warnings on stderr, not silent failures). The mapped array overrides
that step's `files`. Steps not mentioned keep their pipeline-defined
files.

Setting `"concurrency": N` **pins manual mode** at N agents. Omit it to
get the default memory-aware auto-scale, which adapts concurrency to
the real memory headroom (cgroup-aware — it respects the container's
limit); `"autoScale": true` forces auto explicitly. The memory guard is
always on in every mode. For sizing on CI runners, see
[`docs/ci.md`](ci.md).

API key resolution follows the same chain as the TUI:
`/run/secrets/openrouter_api_key` → the persisted global store →
`OPENROUTER_API_KEY_FILE` → `OPENROUTER_API_KEY`. In CI there's no saved
key, so `OPENROUTER_API_KEY=sk-or-... huu auto …` just works (the env var
is the fallback); a key saved via the TUI takes precedence.

### Output

- **stderr** — line-delimited JSON progress events (NDJSON), one per
  state change, throttled to ~250 ms. Pipe through `jq -c` for
  human-readable output.
- **stdout** — ONE final JSON object on completion:
  `{ ok, runId, integrationBranch, status, totalCost, durationMs, filesModified, agents[] }`.
  Build pipes on top: `huu auto … | jq .runId`, or
  `git show "huu/$(jq -r .runId)/integration:huu-tests.md"` to verify
  the integration branch shipped what you expected.
- **Exit code** — `0` if `manifest.status === 'done'`, `1` otherwise.

Like `huu run …`, `huu auto …` re-execs into the Docker image by
default — auto-MTU network applies, port-isolation shim applies,
secrets mount applies. (`--yolo` / `--no-docker` still skip the
container when you mean it, at the cost of that isolation and the
memory ceiling.)

---

## Backends deep dive

`huu` ships three pluggable agent backends. The choice is made once per
run — via CLI flag or the TUI's **BackendSelector** screen (shown when
no flag is passed):

| Backend | Flag | SDK | Cost model |
|---|---|---|---|
| **Pi** (default) | `--backend=pi` | `@mariozechner/pi-coding-agent` over OpenRouter | Pay-per-token (`OPENROUTER_API_KEY`). |
| **GitHub Copilot** | `--backend=copilot` or `--copilot` | `@github/copilot-sdk` (optional dep, lazy-loaded) | Subscription with premium-request quota (`COPILOT_GITHUB_TOKEN`). |
| **Stub** | `--backend=stub` or `--stub` | Built-in no-LLM mock | Free — writes `STUB_*.md` files and emits fake events. For smoke tests and demos. |

All three share the same orchestrator, worktree lifecycle, and merge
logic — only the "call the LLM" step differs. Adding a future backend
(ACP, Claude Code, …) is a one-folder + one-case-in-registry change
under `src/orchestrator/backends/`.

Aliases `--copilot` and `--stub` are shorthand for `--backend=copilot`
and `--backend=stub`. The long form `--backend=<kind>` also accepts
legacy aliases: `real` / `openrouter` → `pi`, `gh-copilot` /
`github-copilot` → `copilot`, `fake` / `mock` → `stub`.

The Copilot SDK is declared as an `optionalDependency` in
`package.json`. If it's absent at runtime, selecting the Copilot
backend produces a clear error — the rest of `huu` still works.

### Why Pi is the default

`huu`'s Pi factory enables **thinking mode at `medium`** by default for
every model that supports it (see
`src/orchestrator/backends/pi/factory.ts`). Thinking mode trades latency
for quality: the model is allowed to draft, critique, and revise
internally before emitting a final answer. For per-file work — the
sweet spot for `huu` — this is the right trade-off, because each agent
has exactly one mission and the marginal cost of "thinking harder"
is small.

The Pi SDK also has built-in auto-retry (up to 5 attempts on transient
errors), exposed transparently in the run log. No huu-specific override
is needed.

---

## Bundled default pipelines

On first run, huu materializes seven framework-agnostic starter pipelines
into `pipelines/`. They are **idempotent** — they never overwrite an
existing file, so editing one preserves your changes across launches.

| Pipeline | What it does | Methodology |
|---|---|---|
| **huu Test Suite** *(highlighted)* | Detects the stack, sets up a test runner, writes unit tests for 3 representative files + the user-selected files, then prunes failing blocks and adds a coverage badge to README. | Unit-test fundamentals |
| **huu Knowledge System** | Builds the full knowledge-skills system, fully autonomous via the `memory` scope: recon picks the study files by itself (one hint per file), per-file deep study accumulates findings in `.huu/knowledge/`, per-topic dossiers become Agent Skills under `.agents/skills/` (one parallel agent per skill) plus evolution meta-skills and a router-aware routing surface (extends an existing router/`catalog.md`, else creates `project-knowledge`). A judge validates the skills and a blind routing eval gates the finish, sharpening descriptions on rework. | [Agent Skills spec](https://agentskills.io/specification) + [memory-scope](memory-scope.md) fan-out |
| **huu Docs Audit** | Classifies every doc by [Diátaxis](https://diataxis.fr/) quadrant, scores the README against Awesome-README, flags stale references, measures inline API-doc coverage. | Diátaxis + Awesome-README |
| **huu Quality Audit** | Sonar-style: cyclomatic / cognitive complexity, function/file size, parameter count, nesting depth, duplication, dead code. | [SonarSource](https://www.sonarsource.com/resources/library/cyclomatic-complexity/) + Fowler smells |
| **huu Performance Audit** | Static hotspot scan (N+1, big-O, sync I/O, memory leak signals), Core Web Vitals for frontends, USE-method checklist for backends/CLIs. | [USE method](https://www.brendangregg.com/usemethod.html) + [Core Web Vitals](https://web.dev/articles/vitals) |
| **huu Refactor Plan** | Characterization-test baseline, per-file Fowler smell catalog, top-5 target ranking, static Mikado-style dependency graph, final Fowler-catalog recommendations. Plan-only — no code rewrites. | [Fowler refactoring catalog](https://refactoring.com/catalog/) + [Mikado method](https://www.manning.com/books/the-mikado-method) |
| **huu Security Audit** | gitleaks secrets sweep, OWASP Top 10:2025 per-file scan, dependency CVE scan, supply-chain & CI posture check, CWE Top 25:2025-aligned remediation roadmap. | [OWASP Top 10](https://owasp.org/Top10/2025/) + [CWE Top 25](https://cwe.mitre.org/top25/archive/2025/2025_cwe_top25.html) |

The five audits now **end with a report-validating judge step** — a
`check` node that verifies the report is complete and internally
consistent, looping back once for rework when it isn't — and the
security audit follows OWASP Top 10:2025. The table in
[`AGENTS.md`](../AGENTS.md) is the detailed per-pipeline source.

**Report-only contract for the five audits.** They write ONLY to
`.huu/audits/<topic>.md` and `.huu/audits/<topic>-faq.json`, plus at
most one `.gitignore` adjustment (a committed `.huu/` line becomes
`.huu/*` + `!.huu/audits/`, otherwise the reports are silently dropped
by the stage merge). They never modify your README, `package.json`,
lockfiles, or any production source. Tools that need to be invoked
(semgrep, jscpd, gitleaks, lighthouse-ci, …) are run ephemerally via
`npx --yes`, `pipx run`, or vendored binaries under `$HOME/.huu/bin/` —
never added to your project's manifests. Two pipelines touch production
files by design: `huu Test Suite` (writes `huu-tests.md` and a tests
badge in README) and `huu Knowledge System` (writes `.agents/skills/**`
and `.huu/knowledge/**`) — both are setup pipelines, not audits.

`Pipeline.maxNodeExecutions = 50` caps cursor visits to steps — a
per-file (or memory) fan-out of N files counts as ONE visit. On
large repos, narrow your file selection with Smart Select; auto-skip
rules ignore `node_modules/`, `dist/`, `build/`, `vendor/`, generated
files, `*.d.ts`, and lock files.

---

## Pipelines as a shared artifact

A pipeline is a reusable artifact. A `huu-security-audit.pipeline.json`
that works on one Node repo works on another. The know-how of "how to
decompose this class of task" is captured in JSON — not in the head of
whoever ran an interactive agent that afternoon.

That asymmetry is the whole tease:

- **Authoring a pipeline is the work.** It takes thought to slice a
  task into independent units, choose models per stage, and define
  what `done` looks like.
- **Running someone else's good pipeline is cheap.** Clone the JSON,
  point it at your repo, run it.

The intent is a community cookbook of pipelines: published as plain JSON
in a public repo, typically under MIT or CC0. The runner is open-source
(Apache 2.0); pipelines you author are *yours*. Drop them in a gist,
in your repo, in a `huu/cookbook` PR — the human underwrote them, the
format makes them portable.

> 🚧 The `huu/cookbook` registry is on the roadmap — until then, share
> pipelines via gists or your own repos. The format is stable enough
> that they'll keep working.

---

## Philosophy

**The name is the product.** `huu` stands for **Humans Underwrite
Undertakings**:

- **Humans** — the pipeline is written by a person, not generated by an
  LLM planner.
- **Underwrite** — in the financial sense: the human signs off, takes
  responsibility for, and guarantees the scope. The system does not get
  to negotiate it.
- **Undertakings** — discrete, well-scoped pieces of work, each with a
  clear outcome.

`huu` is *not an autonomous agent*. It is a harness that executes a
plan you wrote. The intelligence lives in the pipeline — not in the
system. If the pipeline is poorly designed, the result will be
predictably and auditably bad. This is a feature.

Three premises:

1. The pipeline author owns the scope of every step.
2. Well-designed steps isolate edits per file, eliminating conflicts
   by design.
3. Predictability and auditability beat sophistication.

If you want an agent that *decides* what to do, use Devin, Plandex, or
Claude Code. If you want a system that executes *exactly* what you
underwrote, in parallel, with a native git audit trail, this is the
product.

### Why we don't use MCP

MCP became a de-facto standard in 2026 and is an obvious temptation. We
refuse the integration for a concrete economic reason: every tool
definition is re-sent on every turn of every agent.

Concretely: a single MCP server (e.g., GitHub MCP) injects ~55k tokens
of tool definitions per turn. With 10 parallel agents, that's
**~550k tokens of overhead per turn**, before the first edit. For a
product whose proposition is *cheap, auditable parallelism*, MCP
inverts the trade-off.

The supported use cases (tests, audits, refactors) need to read files,
run shell commands, and edit files. Pi SDK's default tools
(read/bash/edit/write) cover all of that with no overhead.
Integrations with Jira, Linear, or Slack are deliberately out of
scope — `huu` is a code-transformation product, not a general-purpose
productivity agent.

### Conflict resolution as a fallback

When the operator's decomposition accidentally puts overlapping work in
the same stage, an integration agent backed by a real LLM spins up on
a side worktree to resolve and commit. Pipelines that follow the "one
file per task" rule never hit this path. Treat it as a safety net, not
a feature you should rely on. Conflict resolution is disabled in
`--stub` mode.

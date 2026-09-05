# Development mode (`huu dev`)

> pt-BR: [dev-mode.pt-BR.md](dev-mode.pt-BR.md) · Back to the [index](README.md)

Development mode is the **only** huu flow whose step graph is written at run
time. You write the goal; a planner decomposes it into parallel **fronts**;
each front becomes a swarm of worktree agents; the whole thing is compiled
into an ordinary `huu-pipeline-v2` pipeline and runs on the existing wave
scheduler.

## How this squares with the MANIFESTO

Badly, in two places, and it is worth saying so up front. The MANIFESTO sells
**"zero LLM planner at run time"** as differential #2, and states that huu
**"is not a tool for building new features"**. Development mode contradicts
both: a planner writes the step graph at run time, and the work it aims at is
usually a feature. The useful question is not whether the tension exists — it
does — but which properties survive it, which get stronger, and which get
worse.

**Non-negotiable, and it holds:**

- **The human underwrites the goal.** It goes in verbatim, is stored at
  `.huu/dev/goal.md`, and no agent may rewrite it. The planner *decomposes* —
  it never widens, narrows or reinterprets.
- **The shape of an epoch belongs to huu, not to the model.** The compiler
  emits a fixed template — global recon → parallel fronts (recon → swarm →
  judge) → consolidation → gate → seal — and re-validates it against the
  production `PipelineSchema` + `validateTopology`. Neither the knowledge
  request schema nor `DevPlanSchema` carries `steps`, `dependsOn` or file
  paths: the model writes **content**, never **structure**. It is structurally
  incapable of emitting a graph.
- **Every path ends at a judge**, with a mechanically checkable condition and
  exactly one forward `default: true` outcome.

**What the current design makes stronger:**

- **The plan is an artifact a human can sign.** With the gate on
  (`--approve-each`, or *Approve each epoch* on the web), the human
  underwrites the plan itself, not just the goal and the epoch template. With
  the gate off — which is the default, see below — nobody signs it.
- **The compiled pipeline is a portable artifact again** (differential #3):
  each epoch persists its `pipeline.json` next to its blackboard, so the graph
  can be re-read, re-run, edited and audited instead of being thrown away.
- **The planner is blind.** It reads no file. It declares the knowledge gaps
  it needs, agents answer them against the real code, and it plans from a
  bounded digest — less unaccountable repo content reaches it than in the old
  shape, which handed it a mechanically truncated file digest.

**What it makes worse — plainly:** the merge is now gated by a *per-task
critic* whose criterion is prose another LLM wrote. A blocking finding sends
the diff back to the same agent before its branch is eligible for the stage
merge (`WorkStep.review`), and the standard the critic holds it to — the epoch
atlas, the task spec — was itself written by a model. The deterministic merge
barrier was the point; this puts an LLM's opinion in front of it. The defenses
(cross-family critic, run-the-gate-before-opining, a counterexample rule, a
hard finding cap, forward-default on every failure) reduce the damage. None of
them makes the gate deterministic — for one that is, see the opt-in lint gate
under [Methodology options](#methodology-options).

### What the research supports — and what it doesn't

Three things to know before trusting the shape of this mode.

**The leader delegates retrieval; it does not skip it.** The blind
orchestrator reads no file, but this is not "planning without looking at the
repo": the knowledge phase **is** the retrieval, run by agents that must cite
real paths. The only measured comparison on repository understanding favors
retrieval (semantic search beats grep-only by ~12.5% offline accuracy and
+2.6% code retention on 1000+ file repos). A leader that retrieves *nothing*
has no empirical support in any system we could find — so the defensible
reading of this design is delegation, and any doc that reads otherwise is
wrong.

**The model split is NOT a cost optimization, and is never sold as one.** A
fan-out of agents costs **3–10× the tokens** of a single agent, while the
price gap between the leader and the workers is about **2×**. Routing work to
the cheaper model cannot pay for that multiplier. The justification is context
isolation and parallelism — and, for the critic, a second opinion from a
different vendor.

**The blind orchestrator is an instrumented hypothesis, not proven practice.**
Adversarial verification of this design's own sources knocked out the primary
basis on **both** sides: the citations in favor (the orchestrator-worker
uplift figure, "context pollution", the 1–2k-token summary contract) and the
ones against (writes must be single-threaded; the "telephone game" argument
against recon → swarm → judge). Read that as *not citable in that pass*, not
as *refuted* — but it means the blind leader ships labeled as a hypothesis,
with counters attached, rather than as a best practice. The critic runs
cross-family (`moonshotai/kimi-k2.6` against DeepSeek workers) for the same
reason: the evidence points at *the same cheap model as both author and
reviewer* as the single most fragile assumption in the design, so the default
preset breaks it and the `monoculture` preset exists to A/B against it.

## The drawn method — when NOT to use the planner

The contradiction above has an exit, and it is a first-class one: **draw the
method yourself.** A [devgraph](dev-graph.md) (`huu-devgraph-v1`) is a graph a
human draws — which blocks run, in which order, where a decision branches, where
the branches rejoin — which huu compiles into the same `huu-pipeline-v2` this
mode already emits. With one in hand the LLM planner is **never called**, and
dev mode stops contradicting differential #2: the human underwrites the method,
the model supplies the intelligence inside each node.

```bash
huu dev "<the objective>" --graph=<id>              # saved under .huu/dev/graphs/
huu dev "<the objective>" --graph=./drafts/a.json   # a file
```

Which one to reach for:

| | LLM planner (no `--graph`) | Drawn method (`--graph=…`) |
|---|---|---|
| **Use it when** | you know the goal but not the shape of the work; the repo is unfamiliar; you expect to learn between epochs | you already know the method — an audit, a test-generation pass, a migration you have run before |
| Topology decided by | a model, at run time | you, before the run |
| Epochs | replans until the goal is met, or the ceiling | **exactly one**; `--epochs > 1` with `--graph` is refused |
| Knowledge phase (A) + planning (B) | both run | **neither runs** — there is no plan to write and nobody to brief |
| Phase 0 (skills bootstrap) | runs | **runs too** |
| Methodology flags · per-role model routing | compiled into the epoch | **ignored, with a warning** — a drawing has boxes, not roles |
| Approval gate | signs the model's plan | signs your drawing, one front per node |

Everything *after* the run is identical on both paths: the landing merge, the
epoch evidence, the blackboard commit. Draw and inspect with `huu graph
list|show|validate|compile|new|rm`, the `[G]` screen in the TUI, or the `/graph`
canvas in the browser.

Full documentation: [`docs/dev-graph.md`](dev-graph.md) ·
[pt-BR](dev-graph.pt-BR.md).

## Usage

```bash
# Autonomous — THE DEFAULT: plan and run up to the epoch ceiling, no questions
huu dev "migrate the parser to streaming without breaking the public API" \
    --model=anthropic/claude-sonnet-4

# Opt IN to a human gate on every epoch
huu dev "extract the HTTP client into its own package" \
    --model=anthropic/claude-sonnet-4 --approve-each --epochs=2

# No-LLM dry run (compiles the graph, runs the waves, does the merges)
huu dev "anything" --stub --epochs=1
```

**Autonomy is the default.** A bare `huu dev "<goal>"` plans and runs every
epoch up to the ceiling without asking you anything: the CLI maps *no flag* to
`approval: 'autonomous'`. The human gate is **opt-in** — `--approve-each`
(CLI) or *Approve each epoch* (web) is the only way to be shown a plan before
it runs. `--autonomous` exists solely to state that default out loud; it
changes nothing, and passing it together with `--approve-each` is rejected.

### From the web UI

A **switch** at the top, putting the two ways to start work side by side:

```
┌──────────────────────────┬──────────────────────────┐
│ ≡ Pipelines              │ </> Development          │
│   You already have       │     You have a goal      │
│   the method             │     instead              │
└──────────────────────────┴──────────────────────────┘
```

Each half is a real route (`/` and `/dev`), so it bookmarks, copies and opens
in a new tab. But a plain click does **not** reload the page: the client swaps
the view in place and `pushState`s the URL — a reload would drop the SSE
stream, the run board and a half-built queue. Back works.

The switch hides while you are on a run board (it would be a silent way to
navigate away from a live run). While a dev session is running, the
**Development** half carries a pulsing green dot — amber when a plan is
**blocked waiting on your approval** — so someone sitting on the pipelines
side can see it.

> With `HUU_WEB_TOKEN` set, both links are rewritten at boot to carry the
> `?token=` — a bare `href` would land you on a shell whose API calls 401.

### The form

- **Goal** — the one input the run is underwritten by. The mic button dictates
  it: the browser records, re-encodes 16 kHz mono WAV (OpenRouter rejects the
  webm a `MediaRecorder` produces), and `POST /api/dev/transcribe` sends it to
  `google/gemini-3.1-flash-lite` — the 3.1-flash variant that accepts audio.
  Override with `HUU_TRANSCRIBE_MODEL`. A transcription APPENDS to whatever is
  already typed. Cost is around US$0.00007 for a four-second clip.
- **Project** — the same filesystem browser the pipeline flow uses, but
  single-select: a dev session ends in a merge into ONE repo's working branch.
- **Approval** — Autonomous (**preselected**) or Approve-each-epoch. Same
  default as the CLI: nothing waits for you unless you ask it to.
- **Parallel fronts** — Auto (the planner chooses, up to 4) or Manual (pins the
  ceiling; the compiler enforces it, not just the prompt).
- **Methodology** — twelve opt-in checkboxes, each compiling a piece of real
  enforcement into the epoch. All OFF by default; the selection persists in
  the browser. See [Methodology options](#methodology-options).
- **No epoch limit.** A web session runs until the planner reports the goal
  complete or you abort it, bounded only by an internal safety backstop. The
  CLI keeps its `--epochs` default of 3, because a headless run may be
  unattended and has no Abort button.

### Flags

| Flag | Effect |
|---|---|
| `--model <id>` | Model for the planner and the swarm. Required unless `--stub`. |
| `--epochs <n>` | Epoch ceiling (default 3; the web surface has none). |
| `--fronts <n>` | Parallel fronts per epoch (default 4, max 4). |
| `--max-cost <usd>` | Stop the session before the epoch that would push it past this. Checked BETWEEN epochs (never mid-swarm), counting both runs of every epoch. Exits 0 — the ceiling you asked for worked. |
| `--approve-each` | **Opt-in gate:** show each epoch's plan and wait for confirmation. Needs an interactive terminal. |
| `--autonomous` | No-op that states **the default** (plan and run everything without asking). Rejected together with `--approve-each`. |
| `--skip-knowledge` | Do not bootstrap agent skills even when the project has none. |
| `--run-dir <path>` | Target repository (default: the current directory). |
| `--tdd` | Split every front's work into a tests step and an implementation step. See [Methodology options](#methodology-options). |
| `--lint-gate` | Run the project's lint/typecheck as a deterministic merge gate. See [Methodology options](#methodology-options). |
| `--standards` | Give every per-task critic a rubric from the project's atlas and declared conventions. See [Methodology options](#methodology-options). |
| `--plan-review` | Validate the epoch's choices in a compiled step before the fan-out. See [Methodology options](#methodology-options). |
| `--write-set` | Block any file written outside the task spec's declared ownership. See [Methodology options](#methodology-options). |
| `--changelog` | Check commit subjects against Conventional Commits, and demand a changelog entry for user-visible change. See [Methodology options](#methodology-options). |
| `--diff-budget` | Cap each task's diff in lines and files. See [Methodology options](#methodology-options). |
| `--fitness` | Run the project's architecture/dependency check as a merge gate. See [Methodology options](#methodology-options). |
| `--checklist` | Make every critic answer a fixed checklist item by item, with evidence. See [Methodology options](#methodology-options). |
| `--traceability` | Build a bidirectional requirement ↔ evidence matrix after the fan-out and gate on undeclared orphans. See [Methodology options](#methodology-options). |
| `--characterize` | Snapshot today's observable behavior before changing anything, then freeze it. See [Methodology options](#methodology-options). |
| `--verify-claims` | Re-check every knowledge claim against the repo and demote what cannot be reproduced. See [Methodology options](#methodology-options). |
| `--debate` | Have two agents from different model families argue the epoch's design decisions before the fronts start, judged by an anonymized rubric. See [Methodology options](#methodology-options). |
| `--advocate-model <id>` / `--prosecutor-model <id>` | Route the two sides of `--debate`. Give them **different families** — see [Adversarial debate](#adversarial-debate---debate). |

## The two phases

### Phase 0 — the knowledge gate

Before any development, huu probes the repository
(`src/lib/knowledge-detect.ts`):

1. `.agents/skills/catalog.md` exists → present
2. else an `.agents/skills/*/SKILL.md` that is a router (frontmatter
   `type: router`, or named `project-router` / `project-knowledge`)
3. else the same under `.claude/skills/`

**Skills with no routing surface do NOT count as present** — the planner would
have no entry point into them.

When absent, huu runs the bundled **`huu Knowledge System`** pipeline in
**MAX** mode (`greedy`: one agent per queued task up to the hard ceiling, with
the memory guard as the only backstop) — the "maximum swarm" phase. Its
integration branch is landed before phase 1 starts.

### Phase 1..N — the epochs

Each epoch is: **plan → (approve) → run → land → replan**.

The planner receives the goal, the project's knowledge surface, the history of
previous epochs, the structured evidence of what the last one actually
delivered and the **brief pack** agents wrote answering the knowledge gaps it
itself declared. It does **not** receive a repository digest and cannot read a
file — see [the retrieval note above](#what-the-research-supports--and-what-it-doesnt).
It returns a schema-enforced list of fronts.

`compileEpochPipeline` turns that into a pipeline:

```
0. Recon do objetivo                         (project, root)
├─ 1a. <front> — recon       (project, produces <front>/tasks.json)
│  └─ 1b. <front> — implementar    (memory, filesFrom the same path)
│     └─ 1c. <front> — verificar   (check: approved ↦ forward, rework ↦ 1b)
├─ 2a/2b/2c …                                 (fronts run as PARALLEL waves)
├─ N+1. Consolidar época      (project, dependsOn every front judge)
├─ N+2. Portão de qualidade   (check: approved ↦ seal, rework ↦ consolidate)
└─ N+3. Selar época           (project)
```

Independent fronts become **ready in the same wave** and share one worker
pool. A front that declares `dependsOnFronts` waits on the other's judge — the
compiler sorts fronts topologically and breaks cycles by dropping edges (with
a warning) rather than losing the epoch.

## Methodology options

Thirteen checkboxes in the dev form (the **Methodology** fieldset, right above
*How it runs*) and thirteen matching CLI flags. Each one is the human
underwriting a piece of the *method*, on top of the goal: the option changes
the **structure** the epoch compiler emits (a step split, a deterministic
merge gate, a critic rubric, a validation step before the fan-out), never the
fields a model can produce — the planner's schemas still carry no `steps`,
`dependsOn` or file paths.

There are six mechanisms and every option is built from them: a new step
(`--tdd`, `--characterize`), a new check with a loop-back (`--plan-review`,
`--traceability`), a rubric appended to the critic (`--standards`,
`--write-set`, `--diff-budget`, `--fitness`, `--changelog`, `--checklist`), a
command appended to the deterministic merge gate (`--lint-gate`, `--fitness`,
`--diff-budget`, `--changelog`), a clause appended to the front's judge
(`--tdd`, `--write-set`, `--characterize`), and — only `--debate` — a BLOCK of
steps before the fan-out plus the prompt block that hands its output to the
fronts. The merge gate and the judge clauses ACCUMULATE — several options
contribute to each, chained in the order they are declared, so no option can
silently erase another's.

`--verify-claims` is the only one that touches the KNOWLEDGE phase instead of
the execution phase: it inserts a verification pass between answering and
consolidating, and it demotes unreproducible claims into `unknowns` rather
than failing — every path out of Phase A stays forward.

**All thirteen default OFF.** A session that selects none of them compiles exactly
the pipeline it compiles today, byte for byte — the same additive contract as
the per-role model policy. What each one enforces, mechanically:

### TDD (`--tdd`)

Each front's single implementation step becomes two chained steps over the
same task list — a **tests** step, then an **implementation** step — with the
front's judge after them, as before:

```
1a. <front> — recon
└─ 1b. <front> — testes         (writes the FAILING tests first)
   └─ 1c. <front> — implementar (test files frozen)
      └─ 1d. <front> — verificar
```

- The tests step is instructed to run the new tests and **capture the
  failure** — the red phase is evidence, not an error.
- The implementation step's prompt forbids editing the test files, and the
  front's judge gains two clauses: the tests are unchanged since the tests
  step's commit, and every file in the diff has a test. A violation is a
  blocking finding — it holds the merge, and with the escape semantics below
  it can hold it for a human.

The freeze is enforced by the judge, not by the filesystem — it is exactly as
strong as the critic that audits it (see [Known limits](#known-limits)).

### Lint gate (`--lint-gate`)

Sets the compiled pipeline's `mergeGate` to the project's lint and typecheck
commands: a deterministic, no-LLM gate that runs in the integration worktree
after every agent-branch merge. A non-zero exit **reverts the merge commit**
and marks the branch `mergeFailed` (the branch itself is preserved for
inspection). Only the fast static checks feed the gate — it has a 60-second
timeout per merge, so build and test commands stay with the critic. A project
whose knowledge brief has no lint command turns the option into a no-op with
a warning, never into a failed run.

### Standards (`--standards`)

Every per-task critic's briefing gains a rubric built from the epoch's atlas
and the project's declared conventions (`AGENTS.md` and friends), with an
anti-nitpick scope: report a **correctness violation** or a **violation of a
declared standard** — never taste. The point is to stop the critic from
inventing a bar the project never set, and from rubber-stamping work that
breaks the bar it did set.

### Plan review (`--plan-review`)

Inserts a validation pass **after every front's recon and before any
implementation**: an agent reads the atlas, the task specs (`T-*.md`), the
plan and the goal, and audits the epoch's *choices* — goal coverage, front
boundaries, and the declared write-set partition (this is where the ownership
check becomes blocking instead of advisory). A judge then routes the verdict:

```
0. Recon do objetivo
├─ 1a/2a/… <front> — recon        (every front reconnoitres first)
├─ R1. Revisar as escolhas        (atlas + specs + plan + goal → plan-review.md)
│  └─ R2. Plano validado?         (check: approved ↦ fan-out, rework ↦ step 0)
├─ 1b/1c/…                        (implementation starts only after the verdict)
```

- `approved` → the fan-out proceeds.
- `rework` → back to the global recon, once: the check caps at 2 runs, and at
  the cap the default outcome goes **forward**, with the findings recorded in
  the consolidation and the epoch evidence.

The real block is structural — no implementation step starts before the
verdict — and the loop-back cannot spin forever.

### Write-set enforcement (`--write-set`)

Every task spec declares a `Files this task OWNS` list. huu already *measured*
violations of it (`writeSetViolations` in the epoch evidence); this flag is the
switch that makes them block. The critic performs a set difference — files the
diff touched, minus the declared list, minus huu's own scratch tree — and every
leftover path is a `blocker`, one finding per file. The front's judge re-checks
it after the merge, against `git log --name-only`.

The asymmetry is deliberate: writing an **undeclared** file blocks, because
that is what collides with a parallel front at merge time; leaving a
**declared** file untouched is nothing at all. "The change genuinely needed
that file" is not a defence — if it did, the spec was wrong, and saying so is
the finding.

### Changelog discipline (`--changelog`)

Two halves with different grounding. The commit-subject half is universal —
Conventional Commits is a *format*, so a regex over `git log` needs no project
tooling — and it runs as a merge gate. The changelog-entry half needs a real
surface, so huu **detects** one (`.changes/`, `changelog.d/`, `.changeset/`,
`CHANGELOG.md`, fragment directories first) and only then tells the critic to
demand an entry for user-visible change. No surface ⇒ the rubric is dropped
with a warning and the format gate still applies. Internal-only changes owe
nothing, and demanding an entry for one is explicitly called out as noise.

### Small batches (`--diff-budget`)

Each task's diff is capped at **400 changed lines across 12 files**, ignoring
huu's scratch tree, enforced with `git diff --numstat` at merge time. 400 is
the top of the range where review effectiveness is repeatedly reported to
collapse; the cap exists because reviewing a large diff *harder* is not a fix.

It acts in two phases: the planner is told to decompose until every task fits
(content, not structure), and the gate counts. The critic is asked for the one
thing the gate cannot produce — **where the cut goes** — and is explicitly told
that a finding which only restates the number is useless.

### Architecture rules (`--fitness`)

The only option that adds a question to the **knowledge phase**: an
`architecture-rules` gap asks an agent for this project's executable
dependency/layering check (dependency-cruiser, madge, ArchUnit, import-linter,
a custom script) and the exact command line. That command then runs as a merge
gate, and the atlas's layering rules become a citable rubric for the critic.

The gap is asked every epoch, not only the first — the answer feeds a gate that
runs every epoch, and an epoch that *adds* a rules file should be gated by it
in the next one. Most repositories have no such command; that is reported as
absent and no gate is invented. Classification is by explicit `fitness:` label
only, never by a hint, so enabling this cannot quietly move a command out of
the `lint` bucket that `--lint-gate` has always run.

### Checklist review (`--checklist`)

The critic stops writing prose and answers a fixed list item by item —
`C1 VERIFY-RAN`, `C2 DONE-WHEN`, `C3 SPEC-ONLY`, `C4 CONVENTIONS`,
`C5 NO-PLACEHOLDER` — with one verdict token (`PASS`, `FAIL`, `N-A`) and one
line of evidence each: a command with its exit code, or a `file:line`.

Two properties do the work. A **fixed enum** is comparable across epochs in a
way an uncalibrated 1–5 score is not. **Mandatory evidence** makes fabrication
cost more than abstention — which is why `N-A` is a first-class answer: without
a legal way to say "I could not settle this", a model manufactures a PASS.
Findings must map to items marked `FAIL`, in both directions.

### Traceability matrix (`--traceability`)

A work step + check pair inserted between the consolidation and the epoch gate.
An agent writes `epoch-N/traceability.md` with two tables: forward (every
"Done when" criterion → the `file:line` or command that settles it) and reverse
(every delivered file → the criterion it serves), closing with an `## Órfãos`
section.

Both directions catch different failures. Forward catches the criterion nobody
delivered; reverse catches **scope nobody asked for**, which in an agent swarm
is the more common defect and the one no other check here sees. A `rework`
loops back to the matrix step, not to the report — a rejected matrix needs a
better matrix. An epoch with *declared* orphans still passes: making them
visible to the next planner is the job. What fails is a matrix that is
incomplete, unsourced, or inconsistent with itself.

### Characterization tests (`--characterize`)

`--tdd` for the work that has no spec — audits, knowledge extraction, legacy
refactors, which is most of what huu exists to run. The front's work splits the
same way TDD splits it: a `caracterizar` step runs the **current** code at an
observable boundary, commits the captured output as snapshots, and confirms
they pass against unchanged code. Green here is the proof the baseline is real
— the inverse of TDD's red.

The recorded behavior is **not** assumed correct. Changing anything in that
step is a blocker, including a fix that is obviously right; a genuine defect is
recorded as a finding and the buggy behavior is snapshotted anyway, because the
snapshot's job is to make the next change *visible*. Afterwards the snapshots
are frozen: rewriting one without an approval in the same commit is a blocker
for the critic and a fail for the judge — a behavior change that erased its own
evidence. With `--tdd` also on, the front runs `caracterizar` → `testes` →
`implementar`, and both freeze clauses reach the implementation critic.

### Claim verification (`--verify-claims`)

The only methodology that acts on the **knowledge phase**. It inserts
`K1.5. Verificar as afirmações` between answering and consolidating: one agent
per brief, fanned out over the same committed index, deriving a falsifying
question for each `facts` entry and answering it *from the repository* — never
from the brief, which is the thing under test.

It exists because the orchestrator is blind. `digest.md` is literally the only
thing it ever learns about this repository, so one confident wrong claim does
not merely go unnoticed: it becomes a plan, and then an order to a real agent.

It **demotes, never fails and never deletes**. Unverified claims move from
`facts` to `unknowns` — the field the brief schema already requires precisely
so an agent always has somewhere honest to put one — and `confidence` may only
go down. That is what keeps every path out of Phase A forward: there is
deliberately no CheckStep in this phase, and this step is not one.

### Adversarial debate (`--debate`)

The only option whose steps are **agents arguing**. Between the global recon
and the fronts, the compiler inserts three nodes:

```
0. Recon do objetivo
├─ Sustentar as escolhas    writes .huu/dev/<session>/epoch-N/debate/A.md
├─ Contestar as escolhas    reads A.md, writes B.md
└─ Debate resolvido?        convergiu ↦ the first front's recon (DEFAULT)
                            contestado ↦ Sustentar as escolhas (one more round)
```

**A** is the decision record: at most six decisions, each with the alternative
it rejects, the reason (pointing at a real path, the atlas or the goal) and the
observation that would prove it wrong, plus the risks the epoch accepts on
purpose. **B** attacks it: one verdict per decision id — `SUSTENTADA` or
`CONTESTADA` — and, behind every contested one, a predicted failure and
evidence you can point at. Neither side may edit the other's file.

**How the result reaches the fronts.** The only step→step channel huu has is
the file system of the integration worktree, and only once it is *committed* —
a judge's verdict text never reaches the next step's prompt. Nothing in huu
injects a check's `reason` into any prompt, so every gate in this file now says
so in its own words: a `rework` or `contestado` verdict is the **record** of
why the step was sent back, read by a human on the check's card and in the run
log, not a message delivered to the agent that re-runs. (Three gates used to
claim the opposite — "that text is the only thing the retry agents receive" —
and that claim was inherited, not introduced by this option.) So each front's
recon (a) **waits on the debate gate**, which is what puts the two briefs in
the tree its worktree branches from, and (b) is told to read both by path. A
decision marked `SUSTENTADA` is settled and the recon implements it; one marked
`CONTESTADA` is an *accepted risk* that must be named in the affected task
spec's Context — never a licence to redesign. The recon is where this lands
because the recon writes the task specs; by the time a worker reads its spec,
the decision is already inside it.

**The judge's rubric is MODEL-anonymized — and only model-anonymized.** It is
never told which agent or which **model** wrote either brief, and the gate's
prompt contains no vendor, family or model string at all. It *is* told which
file is the record and which is the attack, because the **roles are
structurally impossible to hide**: the two files answer different questions,
and the gate's own clauses have to read one as the record and the other as the
attack in order to compare them. Role anonymity was never on offer here; model
anonymity is, and it is the property that fights family bias. The files are
called `A.md` and `B.md` and nothing else, because a filename is not something
a model can be asked to unsee; both writers get the *same* output skeleton and
the *same* ban on naming the model behind them (no model, no vendor, no
signature — plus, as tidiness rather than a claimed property, no role name), so
they cannot be told apart by shape either; and the rubric denies length, order
and confidence as evidence by name. The verdict is about the **state of the
record**, not about a winner: there is no "the advocate wins" outcome to route
on, because a debate that picked a winner would be an LLM deciding the design.
The gate's own clauses are set comparisons — every decision has a verdict,
every contested one has evidence and a resolution — plus one anonymity clause
it can settle without knowing the answer.

**Heterogeneity is the mechanism, not a nicety.** The two sides are separate
roles (`advocate`, `prosecutor`) precisely so they can be routed to different
families: the published result on naive multi-agent debate is that it often
fails to beat plain chain-of-thought, and cross-family is the lever that
changes it. Every preset but `monoculture` — which is the deliberate A/B
baseline — routes them apart; `roster` uses the pair the roster document names
(Claude Opus 5 and GPT-5.6 Sol, both already in that roster, so the option
costs it no new vendor). Leave them unrouted and both fall back to the run
model: huu compiles the debate anyway and **warns** that it is one model
talking to itself. Stated rather than hidden: in `roster` the judge and the
advocate are the same model, which is exactly why the rubric is anonymized —
route `--judge-model` to a third family if you want full independence.

**`writes` here DECLARES a surface; it does not enforce one.** Both debate
steps carry `writes: ['<epoch>/debate/**']`, and it is worth being exact about
what that buys. huu uses `writes` in one place: `validateTopology` rejects two
*concurrent* steps whose globs intersect. The prosecutor `dependsOn` the
advocate, so they are never concurrent and that check has no pair to compare;
the runtime partition check returns early too, because each step declares
`files: []` and so fans out to exactly one task. Neither agent's toolset is
restricted, neither step declares a critic, and their diffs merge without a
gate — the same shape `0. Recon do objetivo` has had since dev mode existed, so
this is not a new hole, but the declaration is documentation of intent, not a
sandbox. What actually keeps each agent off the other's file is the prompt
("never edit `A.md`") plus the fact that they run in different waves.

**Rounds are capped at 2**, and the cap forwards. `contestado` re-pends the
advocate's whole downstream cone, so each extra round costs an epoch's worth of
node executions; hitting the cap takes the forward default with the record as
it stands, exactly like every other gate here.

**With `--plan-review`, a plan rework does NOT re-argue the debate.** The two
options overlap on a loop, and left alone the overlap was fatal rather than
slow. `Plano validado?` sends `rework` back to a step whose *whole downstream
cone* gets re-pended; with the debate hanging off the global recon, that cone
contained the two debaters, so every plan rework paid for the entire argument
again — and `runDagWaves` answers a blown `maxNodeExecutions` with a run error,
which means the epoch is **lost** after every agent up to that point has
already been paid for. So when `--debate` is on, `rework` aims one node lower:
at the debate **gate**. The coverage is identical (every first-wave front recon
already waits on that gate, so the specs, the audit and the check itself are
still re-pended) and the argued briefs survive. That is a scope statement as
much as a budget one: the plan gate rules on the *specs*, the debate on the
*design*, and two specs colliding on a file is not a reason to re-open which
design the epoch rests on. Measured by replaying the real wave loop at four
fronts, this took the worst case for `tdd+planReview+traceability+
characterization+debate` from 85 node executions to 79.

**The ceiling itself was re-measured.** `maxNodeExecutions` for a compiled
epoch is now **96**, not 50. The old number carried a hand estimate ("4 fronts
+ tail + rework loops ≈ 26") that had drifted badly: replaying `runDagWaves`
over all 2¹³ methodology combinations at the maximum four fronts, with every
gate taking its backward arm until its own `maxRuns` forces the forward
default, the worst case is **70 without `--debate` at all** and **79 with it**.
50 was therefore already ~20 short for combinations that predate the debate.
A test (`the node-execution budget` in `plan-to-pipeline.test.ts`) now replays
that loop for every combination and fails if any stops fitting, so a new
methodology cannot reintroduce the overflow in silence.

**It also turns the critic to HOLD** — see the next section. `--debate` adds no
critic rubric and no merge gate of its own, so that is the one behavior you get
from it without asking for it: with `--debate` on, a task whose critic reaches
its round cap with blocking findings open is parked for a human instead of
waiving. That is said in the flag's description, in the web checkbox and here.

### The escape: blocking holds for a human, never a silent waive

With any enforcement option on, the compiler marks the review contract
`onBlocked: 'hold'`. When the critic's round cap is reached with blocking
findings still open, the task is **parked for a human** through the same
interactive-retry hold a failed stage uses: retry re-runs the task (reviewed
again); abandoning applies the classic waive to the preserved branch. Runs
without an interactive channel (headless, `run-many`, smoke tests) always
degrade to the classic waive — an enforcement option can never deadlock an
unattended run. With every option off, nothing changes: findings still waive
at the round cap, exactly as before.

## The blackboard (`.huu/dev/`)

```
.huu/dev/
  goal.md              ← huu writes it, nobody rewrites it
  state.json           ← huu writes it (huu-devstate-v2)
  journal.md           ← agents append (append-only)
  <sessionId>/         ← one session's epochs, namespaced: without it a second
                         session's memory fan-out could resolve the PREVIOUS
                         session's committed task list
    epoch-<N>/
      atlas.md         ← codebase map from the global recon
      pipeline.json    ← the compiled epoch graph, kept as a portable artefact
      findings/        ← one JSON shard PER WRITER — never one shared file:
                           a fan-out wave has N agents appending and the stage
                           merge is sequential, so a single file conflicts on
                           every branch after the first
      report.md        ← the consolidation's report
      <front>/
        tasks.json     ← huu-memory-v1 list (produces/filesFrom)
        T-001.md …     ← one spec per task
```

**Why specs are files:** `resolveMemoryFiles` drops any path that does not
exist in the integration worktree. A development task is not a target file, so
the front's recon materializes one markdown spec per task and lists *those*.
Good side effect: the plan is version-controlled and auditable.

**Ownership split** (restated in every prompt): huu owns `goal.md` and
`state.json`; agents own `<sessionId>/epoch-<N>/**` and `journal.md`.

**Verification commands, persisted.** The epoch-1 knowledge brief asks for the
project's build, test and lint commands as separately labelled lists. huu
extracts and classifies them into `build` / `test` / `lint` buckets
(typechecks count as lint — exactly the fast static checks a merge gate may
run) and stores them in `state.json` (`verifyCommands`). From then on every
epoch compiles with the same executable anchor for its critics — before this,
only epoch 1 had it, because the baseline gap that produces the commands is
never asked again. A line that cannot be parsed is skipped with a warning; a
missing brief means no commands, exactly as before.

## Rules huu enforces (that the planner cannot break)

- **Partition by file ownership.** Parallel agents get merged; two tasks
  writing the same file conflict. Every spec declares the files its task
  **owns**, and the prompt says reading is free, writing is not. The declared
  ownerships are checked against the landed specs **after each epoch lands** —
  the only moment the `T-*.md` files exist in your checkout (checking earlier
  scanned a directory that had none). A violation is recorded as epoch
  evidence and logged — advisory, never blocking. The blocking version exists
  when `--plan-review` is on: the pre-fan-out audit carries the disjointness
  clause, where it can still prevent the conflict instead of reporting it.
- **`dependsOn` only ever points backwards.** That is what `validateTopology`
  requires and what `descendantsOf` assumes.
- **Exactly one `default: true` per check, pointing forward.** The default
  fires on judge failure, unknown label or the `maxRuns` cap — so it must be
  the safe path, never the loop.
- **The compiled pipeline passes `PipelineSchema` + `validateTopology`** before
  it runs. A failure there is a huu bug, not a bad plan.

## Landing between epochs

A huu run leaves its work on `huu/<runId>/integration` and **removes** the
integration worktree at the end. Right for a one-shot pipeline, wrong for a
chain of epochs: epoch N+1 branches from your checkout's HEAD and would see
none of it.

So between epochs huu merges the integration branch into your working branch,
non-fast-forward. A conflict there is a genuine stop (`git merge --abort` runs
first, so the tree comes back clean).

Two practical consequences:

- **Your tree must be clean at session start.** The session refuses up front,
  listing the files, rather than dying at the first landing.
- **huu commits what huu itself writes** (`goal.md`, `state.json` and the
  `.gitignore` `Orchestrator.start()` adjusts) before every landing, as
  `chore(huu-dev): …` commits.

## How a session ends

| `stoppedBecause` | Meaning | Exit 0? |
|---|---|---|
| `goal-complete` | The planner proved the goal is already satisfied | ✅ |
| `max-epochs` | Hit the epoch ceiling with everything landed | ✅ |
| `plan-rejected` | You declined a plan at the gate | ✅ |
| `dirty-tree` | Uncommitted work that huu does not own | ❌ |
| `empty-plan` | The planner emitted no fronts and claimed no completion | ❌ |
| `planner-failed` | The model could not produce a valid plan | ❌ |
| `run-failed` | The epoch ended in error | ❌ |
| `landing-failed` | The epoch's merge conflicted | ❌ |
| `consecutive-failures` | 3 epochs failed in a row — the circuit breaker stopped the session | ❌ |
| `cost-ceiling` | `--max-cost` was reached, with everything landed | ✅ |
| `graceful-stop` | A stop was requested and the epoch in flight finished and landed | ✅ |
| `bootstrap-failed` | The knowledge bootstrap did not complete | ❌ |

The CLI prints one JSON object on stdout carrying that field, the epochs and
their commits.

## Known limits

- **Fronts are parallel within an epoch, not across epochs.** An epoch is a
  barrier: every front merges before replanning. Fronts at independent depths
  would mean giving up the deterministic per-stage merge, which is the spine
  of `src/git/`.
- **At most 4 fronts per epoch** — what fits under the compiled pipeline's
  20-step ceiling.
- **A green judge is an anti-loop valve, not proof of correctness.** The same
  caveat as the [pipeline guide](pipeline-json-guide.md) applies: give the
  judge a capable model and read the diff yourself.
- **Per-task review blocks by SEVERITY, and that is a deliberate choice with a
  known cost.** A `blocker`/`major` finding holds the merge whether or not the
  critic backed it with a command that actually failed. The measured failure
  mode of an LLM critic is *spurious blocking of correct code* — 22.5% to
  91.9% false rejection across 5 models × 3 benchmarks, 87.2% of it semantic
  hallucination rather than style pedantry — and the only remedy anyone has
  measured is requiring a finding to be **executable** before it may block.
  huu does not require that. What it does instead is **count**: every blocking
  finding that triggered a fix round is recorded on the card as proved or
  unproved (`AgentStatus.reviewStats`), and every finding still open when a
  task is waived at the round cap rides the epoch evidence to the next
  planner — or, with a methodology option switched on, parks the task for a
  human decision instead of waiving (see
  [Methodology options](#methodology-options)). That is there precisely so
  this choice can be revisited with this
  project's own numbers instead of literature measured on isolated functions.
  Switching to proof-gated blocking is then a one-line change to `blockOn`.
- **A reviewed card can take `cardTimeout × (1 + maxRounds)` of wall clock**,
  and each in-flight review holds one pool slot (the worker is pinned
  non-preemptible while its critic reads the worktree). Review rounds are
  intra-step, so they do not consume `maxNodeExecutions`.
- **The lint gate is a hammer with a 60-second arm.** `mergeGate` reverts a
  merge commit on a non-zero exit and marks the branch `mergeFailed` — the
  work survives on the agent's own branch. That is why only lint/typecheck
  commands feed it: anything slower belongs in the critic's `verifyCommands`,
  not in a gate that fires per merge.
- **A held task parks its stage.** With a methodology option on, a review that
  hits its round cap with blockers open converts into the interactive-retry
  hold — the run waits for a human at that point. That is the design (a silent
  waive would make the enforcement decorative), but it means an attended
  session can stop mid-stage; unattended runs degrade to the classic waive and
  never wait.
- **The TDD freeze is judge-enforced, not filesystem-enforced.** The
  implementation step is *told* not to touch the test files and the front
  judge is *told* to check — a determined agent can still edit them, and what
  catches it is the critic's blocking finding, not a permission bit.
- **The plan-review loop-back re-runs the global recon.** Rework is real work:
  one extra recon pass per epoch at most (the check caps at 2 runs and its
  default goes forward), budgeted as the price of not fanning out on a bad
  plan.
- **The read-only roles are a REDUCTION, not a sandbox.** The critic and the
  front/epoch judges run with a tool allowlist that has no `edit` and no
  `write` — pi filters them out of the registry entirely, so the model is not
  even told they exist. `bash` stays, because both roles are required to run
  the project's own build/test commands before concluding anything, and
  `cat > file` still writes. It removes the tool a reporter reaches for by
  reflex; it does not make the role incapable.
- **Only the critic and the judges are restricted.** The plan auditor, the
  consolidation reporter and the seal step all WRITE their reports, so taking
  `write` from them would not harden the epoch, it would break it.
  `WorkStep.readOnly` exists for pipelines that genuinely report to the reply
  rather than to a file; no bundled pipeline uses it yet.
- **A card that compacts its context three times is stopped.** The first
  compaction re-states the task's spec path and write scope into the same
  session (`session.steer()`); the third fails the card with an actionable
  message rather than letting it thrash to the wall clock. Same threshold and
  the same reasoning as the epoch circuit breaker.
- **Writing the findings shard early survives compaction and a pause, not a
  timeout.** The prompt now asks agents to write as they go, but the failure
  path deletes the agent's worktree and branch, so a card that times out still
  takes its shard with it. Salvaging that needs a mechanism that does not exist
  yet.
- **The declared write-set collision check reports; it never blocks.** It runs
  before the fan-out and across every step of the run (so it sees two parallel
  fronts claiming the same file, which the post-landing scan could only ever
  see too late), and it lands in the epoch evidence for the next planner. Two
  agents can still be dispatched at the same file — huu just says so first.
- **Epoch resume recovers the PLAN, not the agents.** A session that died in
  Phase C comes back and re-runs the persisted graph instead of re-buying the
  knowledge run and re-planning. The agents, their worktrees and their partial
  work are gone; only the expensive half is recovered.

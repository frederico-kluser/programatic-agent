# The drawn method (`huu-devgraph-v1`)

> pt-BR: [dev-graph.pt-BR.md](dev-graph.pt-BR.md) · Back to the [index](README.md)

A **devgraph** is a method a human *drew*: which blocks run, in which order,
where a decision branches, where the branches rejoin. huu compiles that drawing
into an ordinary [`huu-pipeline-v2`](pipeline-json-guide.md) pipeline and runs it
on the wave scheduler that already exists — same worktrees, same deterministic
stage merge, same judges.

Nothing in the format lets a model add a node, an edge or a route.

## Why a drawn method exists

The MANIFESTO's differential #2 is *"Zero LLM planner at runtime"* — in huu the
graph is the JSON you wrote. It already carries an explicit **exception** for
[development mode](dev-mode.md), where an LLM planner decomposes a human goal
into parallel fronts and therefore writes the topology of every epoch. A
devgraph is what makes that exception unnecessary:

| | LLM planner (`huu dev "<goal>"`) | Drawn method (`huu dev "<goal>" --graph=<id>`) |
|---|---|---|
| Who decides the topology | a model, at run time | **you**, before the run |
| Who writes the prompts | huu's fixed epoch template + the model's content | the block catalog, or you |
| Who supplies the intelligence | the agents inside each step | the agents inside each node |
| Epochs | replans until the goal is met (or the ceiling) | **exactly one** — the drawing *is* the complete method |

The human underwrites the **method**; the model supplies the intelligence
**inside** each node. That is differential #2 holding without an exception — and
it is why the driver refuses, loudly, every path that could quietly hand a drawn
session back to the planner (see [Known limits](#known-limits)).

The rest is unchanged: `compileGraphPipeline` emits a pipeline that huu's own
`PipelineSchema` + `validateTopology` accept, so the scheduler, the memory
fan-out, judge routing and the stage merge run it **without modification**.

## The four node kinds

A canvas holds four things (`src/lib/dev-graph/graph-types.ts`):

- **`prompt`** — the entry. Your objective, in your own words. **Exactly one per
  graph**, it is the root the whole method hangs from, and it may have no
  incoming edge. Every block template can inject it with the `$goal` token, so a
  sentence written once reaches twelve nodes without being retyped. It compiles
  to **nothing**: it is the objective, not a step. Nodes hanging off it become
  the pipeline's roots (`dependsOn: []`).
- **`action`** — one unit of work, from the block catalog below. Compiles to one
  `WorkStep`.
- **`research`** — a question answered *before* the work continues, optionally
  routing the graph. See [Research nodes and the web](#research-nodes-and-the-web).
- **`gate`** — a check you wrote: an LLM judge evaluates your `condition` in the
  integration worktree, after the merge, and picks one of your declared
  outcomes. Compiles to one `CheckStep`.

Every node except `prompt` carries a **join** (see below). Every node carries a
`label` (the chip on the canvas) and an optional `notes` field — the human's
margin, which **never reaches an agent**.

The caps are hard, they are declared once in `graph-types.ts`, and they are
enforced by the **validator** — not by the schema, which carries its own much
higher anti-DoS ceilings (see [How a graph compiles](#how-a-graph-compiles)):

| Cap | Value | Constant |
|---|---:|---|
| nodes | 40 | `DEVGRAPH_MAX_NODES` |
| edges | 80 | `DEVGRAPH_MAX_EDGES` |
| longest root→leaf path (warning) | 12 | `DEVGRAPH_MAX_DEPTH` |
| arms per branching node | 12 | `DEVGRAPH_MAX_BRANCHES` |
| hand-picked files per node | 400 | `DEVGRAPH_MAX_FILES` |
| node label | 80 chars | `DEVGRAPH_MAX_LABEL` |
| `prompt.goal` / `action.prompt` | 4000 chars each | `DEVGRAPH_MAX_GOAL` / `DEVGRAPH_MAX_PROMPT` |

A node id is a slug (`^[a-z0-9][a-z0-9-]{0,39}$`) — it becomes part of the
compiled step name, so it has to be path- and step-safe.

## The block catalog

An `action` node does not carry a prompt you have to invent; it carries a
**block** — a method somebody already underwrote. Dropping `tdd` on the canvas
is a decision about process, not a prompt-writing exercise. Fifteen blocks ship,
in palette order (`src/lib/dev-graph/node-catalog.ts`):

| Block | Default scope | Writes a list? | Read-only? | Critic on? |
|---|---|:--:|:--:|:--:|
| `recon` — map the repo, write the target list | `project` | ✅ | | |
| `implement` — do the change, don't widen the scope | `project` | | | ✅ |
| `tdd` — failing test first, then the code | `project` | | | ✅ |
| `tests` — cover existing code, never edit it | `per-file` | | | ✅ |
| `security-review` — audit and REPORT | `per-file` | | ✅ | |
| `performance-review` — audit and REPORT | `project` | | ✅ | |
| `refactor` — structure only, behavior identical | `per-file` | | | ✅ |
| `docs` — verified against the code, not the intent | `project` | | | |
| `characterize` — pin today's behavior in snapshots | `per-file` | | | ✅ |
| `lint-fix` — bring the project's static checks green | `project` | | | |
| `consolidate` — one report out of the previous nodes | `project` | | | |
| `custom` — blank block: the method is yours | `project` | | | |
| `security-findings` — audit and WRITE one task per finding | `project` | ✅ | | |
| `performance-findings` — same, for measurable costs | `project` | ✅ | | |
| `review-findings` — same, for code-review defects | `project` | ✅ | | |

Order is contract: the array is served to the browser and rendered as the
palette in that order, so new blocks are appended, never inserted.

### `-review` and `-findings` are not duplicates

`security-review` and `security-findings` differ in the only dimension a graph
cares about: **whether the node can hand DATA to the node after it.**

```
security-review     readOnly: true,  produces: false  → REPORTS.
security-findings   readOnly: false, produces: true   → WRITES WORK ORDERS.
```

In huu the only step→step channel is the **committed filesystem** of the
integration worktree — a judge's `reason` never reaches the next prompt. So a
node that writes nothing is a data dead end: it can route control (through a
gate) but it cannot tell the next node *what it found*. And `WorkStep.readOnly`
is enforced at the harness layer (the backend hands the session a tool allowlist
with no `edit` and no `write`), so `readOnly` and `produces` are mutually
exclusive — pinned by a test in `node-catalog.test.ts`.

The `-findings` blocks write **one markdown task file per finding** under
`.huu/findings/<axis>/`, each declaring the files it owns, plus a
`huu-memory-v1` list whose entries point at the *task files*. The node after it
fans out one agent per entry, so `$file` there is the briefing and `$hint` is
the one-line "what is broken". That is what makes **"audit → one agent per
problem"** expressible; before this family, `recon` was the catalog's only
producer and every fan-out had to start at a file shortlist.

Each block also carries a `judgeClause` — a mechanically checkable acceptance
sentence. It does **not** become a step of its own. It is used twice, both times
as text: appended to the agent's prompt as the acceptance it will be measured
against, and handed to the per-task critic as the declared standard. If you want
that clause to *route* something, draw a gate node — which is precisely the
decision this format hands back to you.

## Joins: `all`, `subset`, and the merge barrier

Each non-root node declares how it treats its incoming edges:

- **`all`** (the default) — every direct predecessor is a dependency. This is
  plain `dependsOn` in pipeline terms.
- **`subset`** — only the listed predecessors are dependencies. The others stay
  on the canvas as pure drawing: they still show where the work came from, but
  the node does not wait on them. The "fan out three reviews, continue from the
  performance one" shape.

**Read this before designing around `subset`.** huu executes in BSP waves over
git: at the end of every stage, **every** branch is merged into the integration
worktree before the next stage starts. Relaxing a join removes the **dependency**
— of data and of success — between the branches: the node no longer waits for
the dropped predecessors and no longer fails when they fail. It does **not**
remove the wave's merge barrier, and it does not make the node start earlier in
wall-clock terms once the dropped branches are already in the same wave. There
is no "skip the barrier" semantics in huu, and this format does not invent one.

The validator says the same thing to your face: a `subset` join that actually
drops something emits the `join-subset-drops-barrier` warning, worded exactly
that way. A `subset` on a node with one (or zero) inbound edge emits
`join-subset-single-inbound` — it changes nothing.

Two consequences worth knowing:

- "Upstream" for research context means the transitive closure of the
  **effective** dependencies, not of the drawn edges. A node that dropped an
  inbound edge is never told to read that branch's `research.md`, because
  nothing guarantees the file exists yet — and dropping the edge was you saying
  "I do not want that input".
- A rework arm is never a dependency (next section), so it never participates in
  a join.

## Research nodes and the web

A research node asks **one** question and turns the answer into something the
rest of the graph can act on. Three output kinds:

- **`boolean`** — decides an affirmation; the arms are the fixed ids `yes` and `no`;
- **`choice`** — decides between closed options you registered (≥ 2 ids);
- **`info`** — routes **nothing**. Its result enters the nodes after it as
  **context**. Because it does not branch, its outgoing edges must not name an
  arm (`edge-outcome-forbidden`); it may still feed several successors, and each
  of them is told to read the artifact.

`useContext` says whether the answer must be grounded in *this* repository (the
agent reads the code) or answered from the model and the web alone.

Every research node writes **two committed files** under its own directory in
the graph blackboard — `research.json` (structured, `_format:
"huu-research-v1"`) and `research.md` (for a human and for the next agent). Even
`info`, which routes nothing, writes them: the committed file is the *only*
channel a node has to the node after it.

### The degradation ladder

A research agent has seven tools — `bash edit find grep ls read write` — and
none of them is a web tool. The only road to the internet is `bash`, so the
research prompt describes **shell commands** and names the exact binaries the
image ships. It walks a **two-rung** ladder and stops at the first rung that
**works**:

| Rung | Command | `method` recorded |
|---|---|---|
| **A** — keyed search (Brave, the only backend) | `surf-research-skill gate`, then `surf-search-normal "…" --task … --goal …`; raw links via `surf-research-skill search "Q1" "Q2" "Q3"` | `surf-research` |
| **B** — `curl` of a URL the agent already knew | `curl` + `jq` (always present) | `direct-fetch`, or `none` |

**There is no keyless rung.** surf v8 (`surf-agent-skill`, installed by the
Dockerfile) searches over Brave and nothing else, and `surf-free-skill` — the
old Wikipedia→DuckDuckGo rung — does not exist in it. Without a Brave key
`gate` exits **78 before anything runs**, which is a configuration verdict, not
a transient failure: retrying burns an agent card and changes nothing. The
prompt says so explicitly, so an agent does not go hunting for a binary that is
never coming back. `method: "surf-free"` survives only as a RETIRED value — no
new node writes it, and an artifact carrying it is old enough that its evidence
can no longer be re-run.

**The ladder degrades on FAILURE, not merely on absence** — and that distinction
is the whole point. `command -v` proves a binary is *installed*; it does not
prove it has a key, a quota or a network. The image installs the search CLI at
build time regardless of any key, and huu's key materialization is explicitly
non-fatal, so "installed and keyless" is a common state. The prompt therefore
counts as a **layer failure** (and descends): a non-zero exit, empty output, any
mention of a missing/invalid credential (`no … key`, `unauthorized`, `401`,
`403`), any quota or rate-limit mention (`quota`, `429`), and any network error
(`timeout`, `ENOTFOUND`, `connection refused`).

`direct-fetch` exists so a node that fetched the official page, found the answer
and cited the URL is not forced to write `none`. `none` means literally nothing
external was obtained — and the block handed to downstream consumers says so:
*"treat the node as unanswered"*.

### `defaultOutcome` is your decision, not the model's

A branching research node (and every gate) must name a `defaultOutcome`. It is
the outcome the compiled `CheckStep` marks `default: true`, and huu's
forward-default rule fires it on **every** failure: judge crash, timeout,
missing file, corrupt JSON, a label outside the enum.

huu cannot derive which route is safe. For *"is there a known CVE in this
library?"*, `no` means "adopt the library" — so a judge failure silently
answering `no` would read as "the library is safe", the most destructive answer
available. Which side is cautious depends entirely on which branch is expensive
to take by mistake, and only you know that.

The judge that routes a research node is deliberately **mechanical**: it does
not re-research and does not weigh the research's merit. It reads one field of
one file and transcribes it into the enum.

## Rework — the arm that goes back

*"Quality gate: if it failed, go back and fix it"* is the single most common
reason a gate exists. Mark that arm's edge with `rework: true` and it becomes a
route **back** to a node that already ran.

It is not a cycle, because a devgraph has **two layers over one drawing**:

```
DEPENDENCY layer   every edge WITHOUT `rework`. This is what becomes
                   `dependsOn`, what the topological order sorts, what
                   "ancestor" means — and the ONLY layer a cycle is looked for in.
ACTIVATION layer   every edge, rework included. This is what routes
                   (`outcomes[].nextStepName`) and what reachability follows.
```

A rework edge never becomes a dependency: if it did, the target would start
waiting for the gate that comes *after* it, and the drawing would be a genuine
dependency cycle. huu's own `validateTopology` states the rule outright — loops
belong to `next`/`outcomes` (activation edges), never to `dependsOn`.

It is inferred from **nothing**. A backwards arm without the flag stays a `cycle`
error, because a loop the human did not underwrite is a loop nobody signed. Four
stable error codes police it:

- `rework-edge-not-from-branch` — the source has only one way out;
- `rework-edge-needs-outcome` — a rework route is still an *arm*, so it needs a
  `sourceOutcome`;
- `rework-edge-not-backward` — the target is not an ancestor in the dependency
  layer, i.e. a forward edge wearing the loop's clothes;
- `default-outcome-is-rework` — **the default may never be the loop.**

That last one is the rule to remember. The default fires when the judge *fails*,
so it has to be the safe route forward; a default that loops turns a broken judge
into a run that spins until the execution budget kills it.

What bounds a legitimate loop is the gate's own `maxRuns`. A gate that actually
has a rework arm and named no `maxRuns` gets **3** (`DEVGRAPH_REWORK_CHECK_MAX_RUNS`
— the first verdict plus two chances to fix); every other check gets **2**
(`DEVGRAPH_CHECK_MAX_RUNS`), which is what makes every graph drawn before loops
existed compile byte-identically. `Pipeline.maxNodeExecutions` is the run-wide
backstop underneath, and the compiler *budgets for the repeats* so the backstop
never cuts a loop you legitimately drew.

## Fan-out

An action node can run **one agent per entry of a list an earlier node wrote**.
Set `fanOutFrom` to the id of an **ancestor** action node whose block
`produces` a `huu-memory-v1` list; the compiler emits `scope: 'memory'` +
`filesFrom` pointing at that node's list.

The validator enforces all three halves of that sentence, each with its own code:

- `fanout-source-unknown` — the named node does not exist;
- `fanout-source-not-ancestor` — it does not run before this node;
- `fanout-source-not-producer` — its block does not `produces` a list.

And the two scope mismatches: `fanout-needs-memory-scope` (a `fanOutFrom` with an
explicit non-`memory` scope) and `scope-memory-needs-fanout` (a `memory` scope
with nothing to read).

`maxFiles` is the **width you are underwriting**, not a suggestion — one entry is
one agent, one worktree, one merge. Unset, the compiled step gets **40**
(`DEVGRAPH_DEFAULT_FAN_OUT`, the same default the orchestrator applies); the
compiler clamps it to **100** (`DEVGRAPH_MAX_FAN_OUT`) and reports the clamp as a
warning. Note that this is a different number from `DEVGRAPH_MAX_FILES` (400):
one is how many files a human may hand-pick, the other is how wide a run-time
fan-out may get.

**Where the list lives, and why it is not tidy.** Producer lists are written to
`.huu/findings/<namespace>/<producer-node-id>.json` — *outside* the graph
blackboard. The producing blocks' prompts tell the agent that, in a repository
whose `.gitignore` carries `.huu/`, it may rewrite that line to `.huu/*` and add
`!.huu/findings/` — "the one edit permitted". That remedy re-includes
`.huu/findings/**` and nothing else, so a list written anywhere tidier would stay
ignored, uncommitted, and invisible to the fan-out, which would then dispatch
zero agents in silence. The namespace carries the **session and the epoch**, so a
re-run whose producer wrote nothing finds no list, resolves to zero tasks, and
the stage completes empty — the honest outcome — instead of dispatching agents
onto yesterday's targets.

## How a graph compiles

`compileGraphPipeline` (`src/lib/dev-graph/graph-to-pipeline.ts`) is mechanical
and pure. It emits, per node kind:

| Node | Emits |
|---|---|
| `prompt` | nothing |
| `action` | one `WorkStep` |
| `research` (`info`) | one `WorkStep` |
| `research` (`boolean` / `choice`) | a `WorkStep` **and** a `CheckStep` that transcribes the artifact's verdict into a route |
| `gate` | one `CheckStep` |

**Step names** carry three jobs in one string:

```
single-step node   3. Security review [seguranca]
research pair      3a. Is there a known CVE? [cve]
                   3b. Is there a known CVE? — decisão [cve]
```

The position prefix is the node's 1-based place in the topological order (so a
kanban and a log read in execution order); the label is what you wrote on the
chip; the `[node-id]` suffix is the durable identity that maps a card back to the
box you drew. Uniqueness is structural — one node, one position — so
`validateTopology`'s duplicate-name rule can never fire on this output.
`CompiledGraph.stepsByNode` is the machine-readable form of the same mapping.

**`dependsOn`** is the node's *effective* dependencies mapped to step names, with
the prompt node dropped (it emits no step, so a node hanging off the objective
becomes a root with `dependsOn: []`). A node that depends on a research pair
depends on the **CheckStep**, never on the work step alone: the pair is only done
once its judge has routed.

**Outcomes** are read off the activation layer, so a rework arm gets its
`nextStepName` like every other arm — pointing at the **first** step of a node
that already ran. Exactly one outcome is forced to be `default: true`, and among
candidates the compiler prefers the last arm that goes **forward**.

**Exactly one edge per branch arm** — zero is `branch-outcome-missing-edge`, two
is `branch-outcome-multiple-edges` — because a `CheckStep` routes to one
`nextStepName` per outcome. To parallelize *after* a decision, point the arm at a
single action node and let **that** node fan out.

**The rules are 46 blocking codes and 4 warnings** (`GraphErrorCode` /
`GraphWarningCode` in `graph-types.ts`). The *code* is the stable identity of a
problem — the UI maps it to a translated sentence — so renaming one is a
breaking change, while rewording an issue's `message` is not. One defect gets
exactly one code: there is deliberately no `orphan-node` (a node with no inbound
edge that is not the root is already `unreachable-node`), a node tangled in a
cycle is reported only as `cycle` (the cause, not its consequence), and an edge
that fails a `rework-*` rule is not also reported under the generic
`edge-outcome-*` family.

**The schema and the validator are not the same layer**, and the split is
deliberate. The zod schema (`parseDevGraph`) owns the **shape** and a set of
anti-DoS ceilings that sit well above the product caps — 500 nodes, 1000 edges,
20 000 characters of text — while the validator owns the caps themselves and
every rule a human should *see*. A parse error is a
blank canvas and a lost drawing; an issue is a to-do you can fix on screen. The
same rule sorts ids: a **declaration** (a graph id, a choice id, an outcome id)
is strict in zod, while a **reference** (a node id, an edge's source/target,
`fanOutFrom`, a join subset entry) is permissive there and checked by the
validator, where the problem can be shown against the box that carries it.

**Two gates, and they are asymmetric on purpose.** `validateGraph` never throws —
the editor validates on every keystroke of a half-drawn graph, and a throw there
is a blank canvas. The *compiler* throws on the first invalid graph it is handed,
because a compiler that silently "repairs" a broken method runs a method nobody
underwrote. It throws a second time if its own output fails `PipelineSchema` —
that is a huu bug, not a bad drawing, and the message says so. Everything it can
repair (clamped numbers, dropped file lists, a degraded scope) comes back in
`warnings`, which every surface is expected to **show**.

**Author text that travels is neutralized.** The objective and a gate's
`condition` are pasted into prompts whose `=== SECTION ===` markers, closed enums
and JSON verdict blocks are huu's *machinery*, so both go through
`neutralizePromptText`: backticks become `'`, quotes become `”`, runs of `===`
collapse, and the `<query>`/`<allowed-labels>` tags are rewritten with
guillemets. A node's own `prompt` override is **not** neutralized — it *is* the
instruction for that node, its fences are you writing a prompt, and there is no
boundary to cross. `notes` never reach an agent at all. This is a coherence rule,
not a security boundary: the author of a devgraph underwrites the run. What it
buys is that pasting a spec containing `=== HARD RULES ===` into your objective
gets you a prompt that still means what it says.

## The three surfaces

**The browser** is where you *draw* — `/graph`, a real bookmarkable route, and
the only surface that can create a node with a mouse. The canvas is rendered by
**React Flow** (`@xyflow/react` 12.11.2), pre-bundled with React 18.3.1 into one
committed ESM file the browser loads directly: the huu client is a no-build,
no-CDN app, so the vendored bundle *is* the dependency and there is no npm
dependency on React. React Flow only **draws**; the devgraph is the truth.

You add a node from the **arm row** on the right edge of a node card — the row
that carries the arm's name, a `+` and the connector dot. Clicking anywhere on
that row (the dot included) opens a palette menu with every catalog block,
grouped by what the block *does* — "writes findings/lists", "audits without
touching code", "writes code" — plus the two other drawable node kinds,
`research` and `gate`. (`prompt` is never offered: the root takes no inbound
edge.) Picking an entry creates the node **and** the edge in one move; if the
connection is refused the node is not left behind. Entries the rules forbid stay
visible and clickable, greyed with their reason, so a click gets you the refusal
out loud instead of nothing. Keyboard: `Enter`/`Space` on an arm row opens the
palette, `↑`/`↓` walk it, `Enter` picks, `Escape` closes.

The **inspector** on the side edits the selected node: its label, its own text
field (`goal` / `prompt` / `query` / `condition`), its join policy, its `notes`,
its per-node `modelId`, and everything specific to its kind — a research node's
`outputKind` and options, a gate's outcomes and `maxRuns`, an action node's
`fanOutFrom`, `scope`, `files`, `maxFiles` and `review` toggle. The block's own
`promptTemplate` is shown read-only, so you can see the method you dropped
without being able to corrupt it in place; clearing an action's `prompt`
override restores the template. Switching a research node's `outputKind` in a way
that would orphan edges asks first, listing every link it would drop. Backwards
(rework) arms get their own builder, because dragging one is refused as a
`cycle` — correct and unhelpful.

Validation runs **live**, debounced 400 ms, on every change: problems are
grouped by anchor, nodes and edges get error/warning styling with a count badge,
and anything with no anchor (a payload that is not a devgraph at all) lands in a
global list — a canvas that only knew how to highlight nodes would drop it and
look green for a graph the store will refuse to save. A **warning is not a
defect**: `join-subset-drops-barrier` is the expected answer for the very graph
this screen exists to draw, so it is counted separately and never turns the
status red. Compile errors paint nodes too, and any edit retires the compile
answer.

The HTTP surface is `src/web/graph-api.ts`, under `/api/graphs`:

| Route | Verb | What it does |
|---|---|---|
| `/api/graphs` | GET | list the saved graphs (`?dir=` picks the repository) |
| `/api/graphs/catalog` | GET | the palette: blocks, node kinds, methodologies |
| `/api/graphs/validate` | POST | run the rules on a posted graph |
| `/api/graphs/compile` | POST | compile a posted graph to a pipeline |
| `/api/graphs/from-sample` | POST | save one of the worked examples as your graph |
| `/api/graphs/<id>` | GET · PUT · DELETE | read · save · delete one graph |

`catalog`, `validate`, `compile` and `from-sample` are **reserved ids**: they are
also legal slugs, so the write paths refuse them with a 400 rather than letting
you save a graph that could never be read back. Two contract details worth
knowing: the body is always the envelope `{ graph }`, never the raw devgraph;
and `dir` travels as a **query parameter** on GET/DELETE but as a **body field**
on PUT/POST — a `dir` in a PUT's query string is silently ignored and the graph
lands in huu's own working directory instead of yours. `POST /validate` always
answers 200 — a graph full of errors is an answer, not a transport failure.
`POST /compile` refuses with a 400, and when the refusal comes from the
**validator** it carries the full `errors[]` beside the message, precisely so the
canvas can paint the culprits without a second round trip; a refusal at the
**shape** layer (no `graph` in the body, or one the schema rejects) carries only
the message, because there are no per-node anchors to paint.

**Saving is explicit** — the save button, not an autosave — and there is no undo
or redo. The sample picker is not a preview either: choosing one **writes it to
disk immediately** as a new graph of your own, with a numeric suffix if the id is
taken.

**The CLI** is `huu graph`, for the people who live in a terminal:

```bash
huu graph list                        # the saved drawings
huu graph show <id>                   # the topology as text, in execution order
huu graph validate <id>               # the rules; exits non-zero on any error
huu graph compile <id> --out p.json   # a PORTABLE huu-pipeline-v2
huu graph new <id> [--from <sample>] [--name <n>] [--force]
huu graph rm <id>
```

Output discipline: **stdout** carries the payload (the listing, the topology, the
report, the pipeline when there is no `--out`), **stderr** carries progress and
refusals. So `huu graph compile <id> > pipeline.json` writes a pipeline and
nothing else. A compiled file is a genuinely portable artifact — run it with
`huu auto pipeline.json --config <config.json>`, in any repository, with no dev
mode involved.

**The TUI** is a picker, not a canvas — `[G]` from the welcome screen. It lists
the drawings, reads one out loud as an ASCII diagram, shows every problem the
validator found, and hands the **compiled pipeline** to the run chain the TUI
already has. Keys are in [KEYBOARD.md](KEYBOARD.md).

**Running one** is `huu dev`:

```bash
huu dev "<the objective>" --graph=<id>              # a graph saved under .huu/dev/graphs/
huu dev "<the objective>" --graph=./drafts/a.json   # a file
```

…from the terminal, or `R` on the TUI's graph screen. **From the browser** it is
the *Method* panel on the `/dev` form — `LLM planner | Method you drew`, plus a
picker of the saved methods — or **Run this method** on the canvas, which hands
the id to that same form rather than starting a session itself. Both routes post
`graphId`, so the drawing has to be **saved** first (see
[Known limits](#known-limits)).

A bare slug is an **id**; anything containing `/` or `.` is a **path**, so the
two can never be confused. With a graph in hand, **Phases A and B of the epoch do
not happen** — not "are skipped to save money": Phase B writes a plan and the
plan already exists, and Phase A exists to brief the thing that writes the plan.
The LLM planner is never called. What survives untouched is everything *after*
the run: the landing merge, the epoch evidence, the blackboard commit.

The approval gate still gates. `--approve-each` shows the drawing projected onto
the plan panel — one front per node, with the **compiled** fan-out width as the
blast radius you are signing for — and, with nobody wired to answer, it means
*no*.

## Worked examples

Six samples ship (`huu graph new <id> --from <sample>`, or the `S` key in the
TUI, or *from-sample* in the browser). Each is saved as **your** graph — nothing
is loaded behind your back:

| Sample | Nodes / edges | What it demonstrates |
|---|:--:|---|
| `tdd-seguranca-performance` | 5 / 6 | three parallel fronts and a `subset` join — including the honest note about what relaxing a join does and does not do |
| `pesquisa-booleana` | 4 / 3 | a yes/no research question routing the work, with both arms wired and `no` as the safe default |
| `pesquisa-multipla-escolha` | 5 / 4 | a three-way choice, one edge per arm, defaulting to the only branch that touches no production code |
| `pesquisa-informativa` | 4 / 3 | an `info` node: one way out, no arm names, `useContext` on |
| `recon-fanout` | 4 / 3 | recon writes the target list, the next node opens one agent per entry |
| `portao-de-qualidade` | 5 / 4 | a gate with a mechanically checkable condition and `approved` as the forward default |

## Known limits

Honest list. Each item was verified in the code.

- **A graph session is exactly ONE epoch.** `--epochs` greater than 1 combined
  with `--graph` is **refused** (`graph-conflict`), not silently downgraded: a
  devgraph is the complete method, and re-running the same drawing is not a
  second epoch. Re-running the same objective is instead offered as a *resume*,
  which continues the epoch numbering inside the same session.
- **Phase 0 still runs.** Only A and B are gone. On a repository with no agent
  skills and no `--skip-knowledge`, a graph session bootstraps the skill system
  first — a real pi agent writing real files, committed before a single box
  compiles — and a failure there stops the session with `bootstrap-failed`
  before the graph is touched. This is deliberate: the node prompts only get the
  project-router prefix when the knowledge probe says it is there.
- **`reportExcerpt` is empty for a drawn epoch.** huu reads the consolidation
  report from a path *it* compiled on the planner path; a devgraph's
  `consolidate` block names no output file, so there is no path to read. The
  empty result is huu declining to guess, not huu looking in the wrong place.
  Nothing downstream is harmed — the excerpt only ever fed the *next* epoch's
  planner prompt, and a drawn session never reaches a planner.
- **The declared-partition reconciliation scan finds nothing on a drawn epoch.**
  It scans the epoch directory, and a drawing's task files live under
  `.huu/findings/<axis>/` by design. Pointing it at the graph blackboard would
  find nothing (or match an ownership-shaped heading inside a research
  write-up); pointing it at `.huu/findings/` would be worse, because that tree is
  namespaced by axis and its specs are committed, so a resumed drawing would
  re-read the previous epoch's task files. **Nothing is actually unmeasured**:
  the authoritative check is the run itself, which collides declared ownership
  before every `memory` fan-out and across every step so far — and that check is
  live on the drawn path too.
- **The 12 methodology flags are NOT compiled by a drawing.** They are validated,
  carried as metadata and **warned about**, in the compiler and again at session
  start. Each flag compiles a *structure* into a graph the planner wrote; a
  devgraph expresses method by drawing it (drop the `tdd` block, draw a gate
  node), and adding steps nobody drew is the exact decision this format takes
  back from the machine. Per-role model routing (`--worker-model` and friends) is
  ignored for the same reason — a drawing has boxes, not roles. Route with the
  graph's `meta.modelId` or a per-node `modelId`.
- **The browser launches a drawing only by *id*, and only one already saved.**
  `POST /api/dev` takes a drawn method as either `graphId` (a saved id) or an
  inline `graph`, and refuses a present-but-unusable one with a 400
  (`graph-not-found`, `graph-invalid`, `graph-conflict`) rather than falling back
  to the planner. The client posts **`graphId` and never the inline `graph`**, so
  the canvas *as it stands on screen* is not runnable: **Run this method** is
  disabled, with the reason spelled out beneath it, until the validator is green
  **and** the document is still the one the server last saw. ("Saved" is
  reference equality against the last document off the wire — every mutation
  returns a new object — so it errs toward *unsaved*, the harmless direction:
  `huu dev --graph` reads the FILE, and running an edited-but-unsaved canvas
  would run the old method with the new drawing on screen.) Two controls reach
  the wire, and neither is a second launcher: the **Method** panel on the `/dev`
  form (`LLM planner | Method you drew`, plus a picker of the saved methods), and
  the canvas button — which does not POST at all. It only *names* the method,
  firing the `huu:run-graph` document event (a DOM event and not a call:
  `launch.js` already imports the canvas, so importing `dev.js` back would close
  an ESM cycle); `/dev` adopts the id and the ordinary submit starts the session,
  so there is exactly one submit path and one body to test. `maxEpochs` is never
  sent on either path — a drawn session is exactly one epoch, and an explicit
  `maxEpochs >= 2` is `graph-conflict` before the session exists. The library is
  also **per project**: `GET /api/graphs?dir=` reads the store inside the chosen
  directory, so changing the project clears the selection and re-lists, and the
  hand-off from the canvas re-lists too — otherwise an id from the previous
  project, or one saved seconds ago, reaches the server as `graph-not-found`.
  The **compile** button is unchanged and still a read-only preview: every step,
  its `dependsOn`, and each outcome's `label → nextStepName` with the default
  marked.
- **There is no rename primitive.** The store keys a graph by its id and derives
  the filename from it, and the HTTP surface has no rename route. The browser's
  rename affordance is therefore a **destructive two-step** — delete the old id,
  save under the new one — behind an explicit warning and a confirm; if the
  delete fails, the save still proceeds and you are told both now exist. From the
  CLI it is `huu graph new <new-id> …` plus `huu graph rm <old-id>`.
- **Graph-level `meta` has no editor in the browser.** `meta.methodology`,
  `meta.maxNodeExecutions` and `meta.modelId` are read and honored by the
  compiler (and shown by `huu graph show`), but nothing in the canvas or the
  inspector writes them — only the **per-node** `modelId` is editable. Set them
  by editing the JSON.
- **`.huu/dev/graphs/*.json` is gitignored in most repositories** — including
  this one, whose `.gitignore` carries `.huu/`. A saved drawing is *not*
  versioned unless you un-ignore it, and "my method vanished when I cloned
  elsewhere" is a real outcome. The store touches no git at all; it reads and
  writes the working tree.
- **Resuming a drawn session requires re-supplying the drawing.** A resume
  re-opens a session, not the arguments it was started with. Without the graph,
  huu **refuses** (`graph-missing-on-resume`) rather than falling back to the LLM
  planner — silently swapping your drawing for a model's plan inside a session
  you opened as a drawing is the precise failure this feature exists to delete.
  A resume carrying a *different* graph is refused too (`graph-conflict`).
- **The canvas geometry is not covered by an automated test, and the suites say
  so themselves.** `canvas.test.js` and `inspector.test.js` mount the real React
  Flow tree in jsdom — which has no layout, so every element measures 0×0, React
  Flow never measures the nodes, and no edge path is ever computed. What is
  proved is the *graph*: which nodes exist, which arm a handle belongs to, which
  CSS class an edge carries, what the model does with a drag event. What is
  **not** proved is handle coordinates, edge routing, the pan/zoom transform,
  `fitView`, or whether the palette lands next to the dot it belongs to (the
  popover's clamping helper has no test at all). The model's position arithmetic
  *is* unit-tested. Any change to the drawing surface itself needs a human eye in
  a real browser.

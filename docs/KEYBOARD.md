# Keyboard reference

The entire TUI is in English (the pipeline assistant is currently in
Portuguese, matching the recon prompts). Below is the complete map.

## Welcome

- `A` open the **pipeline assistant** (guided conversational authoring; runs a four-agent project recon first)
- `N` new pipeline — opens the **pattern picker** first (Discover → Act, Per-file transform, Audit with judge, Blank); `↑↓` choose · `ENTER` scaffold · `ESC` back
- `I` import from list (`./pipelines/*.pipeline.json`)
- `M` saved pipelines
- `P` **run across projects** — mark several project folders and run a pipeline
  once per folder (see *Project picker (multi-mark)* below)
- `G` **drawn methods** — the devgraph library (`huu-devgraph-v1`): a method a
  human drew, which compiles into a pipeline (see *Drawn methods* below)
- `O` open **Options** — RAM budget dial + AI provider API keys (also opens automatically when a run aborts on an invalid key)
- `↑↓` highlight a pipeline from the discovered list · `ENTER` load it
- `0`–`9` jump straight to the labelled pipeline; `[0]` is the pinned **default** (unit-test suite), shown first and colored distinctly
- `Q` quit

## Options

- `↑↓` select a row · `ENTER` edit it · `ENTER` save · `ESC` cancel/back
- Row 0 is the **RAM budget** dial — the machine-global admission ceiling
  (10–95%, default 70). The editor opens **empty**; the current value is shown in
  the prompt. Out-of-range input is clamped and non-numeric input is refused, both
  reported on screen. Saved to `~/.config/huu/web-settings.json` — the **same
  store the web ⚙ Settings panel writes**, because one machine has one RAM — and
  applied to the **next** run (a live run keeps the dial it started with). The
  precedence is `--ram-percent=N` → this saved dial → `HUU_RAM_PERCENT` → 70.
- The remaining rows are provider credentials (masked input). Keys are persisted
  to the global config (`~/.config/huu/config.json`, mode 0600; under Docker the
  dir is host-mounted via `HUU_CONFIG_DIR`, so saves survive the container — the
  web ⚙ Settings key panel writes to the same store)

## Project picker (multi-mark) — `P` from Welcome

Opens at the **workspace root** (`HUU_WORKSPACE`, default your host `$HOME` — the
tree the Docker wrapper bind-mounts, so anything outside it is invisible to a run
and the screen warns when you leave it).

- `↑↓` move · `ENTER` open a folder · `←`/Backspace parent · `H` back to the
  workspace root
- `SPACE` mark/unmark the highlighted folder (marks **persist across
  navigation**, so several directories can be collected in one pass)
- `A` mark/unmark **every sub-folder of the current listing** (flips to "unmark
  all" once they are all marked; folders marked elsewhere are never touched)
- `C` clear all marks · `G` **go** with the marked set · `ESC` cancel

`ENTER` deliberately navigates rather than confirming — you need it to browse.
`G` is the confirm, matching the editor's "go".

Next comes the pipeline picker (`SPACE` to pick several, `ENTER` to take the
highlighted one — either way each pipeline runs once per marked project), then the
shared backend/model/timeout/resolver flow, then the run queue.

## Drawn methods — `G` from Welcome

The devgraph library. This screen is a **picker, not a canvas**: drawing needs a
mouse, so that lives in the browser at `/graph`. Here you list the drawings, read
one out loud, check it, and run it. A graph compiles into a `huu-pipeline-v2` and
is handed to the ordinary backend → model → timeout → resolver → dashboard chain.
Graphs are read from `<repo>/.huu/dev/graphs/`. Full doc:
[dev-graph.md](dev-graph.md).

### List

- `↑↓` highlight a drawing · `ENTER` **inspect** it (opens the detail screen)
- `R` **compile & run** the highlighted drawing. A graph flagged `needs fixing`
  refuses here and says how many blocking problems it has — the compiler throws
  on an invalid graph, so the run affordance never reaches it.
- `S` open the **worked examples**; the example is saved as *your* graph, under
  its own id (suffixed `-2`, `-3`… if that id is taken), so nothing is loaded
  behind your back and you can throw it away
- `ESC` back

Inside the examples list: `↑↓` choose · `ENTER` save it · `ESC` back.

### Detail (one drawing)

Two panes over the same graph — the ASCII diagram, in the order the method
actually runs, and the list of problems the validator found.

- `↑↓` scroll the active pane one line at a time
- `V` switch pane (diagram ↔ problems)
- `R` **compile & run** this drawing
- `L` reload it from disk (pick up an edit made in the browser)
- `ESC` back to the list

## Run queue (review before starting)

The `(pipeline × project)` fan-out, grouped by pipeline. Row order **is scheduler
priority**: the top run is admitted immediately, the rest start as RAM frees up.

- `↑↓` select · `SPACE` skip/include a run (a toggle — nothing is deleted, so a
  mis-press is undone with the same key) · `A` skip-all / include-all
- `ENTER` run the included set · `ESC` back
- Folders without a `.git` are flagged: those runs would fail preflight.

## Pipeline assistant

- Model picker is open first — same key map as the global model selector.
  The chosen model runs the interview AND the **Architect flow** (3 parallel
  blueprint sketches under different lenses → generative selection against a
  mechanical rubric → per-step prompts written in parallel → real schema +
  topology validation, one guided fix at most). Planning is maximum
  leverage — `planning`-tier models (deepseek-v4-pro, kimi-k2.6, gpt-5.4,
  claude-opus-4.6) are suggested on screen.
- After the interview finalizes, the Architect phases stream live; the
  finished pipeline lands in the editor as usual. `ESC` cancels.
- On the intent screen: `ENTER` start the interview · `ESC` go back.
- During recon: `ESC` cancel and return to the intent screen.
- During an interview question: `1`–`9` select an option; the last option is always a free-text escape hatch.
- Free-text answer screen: `ENTER` submit · `ESC` cancel.
- Anywhere except `pick-model`: `ESC` opens a `Y/N` confirm-cancel prompt — `Y` exits to welcome, `N` (or `ESC`) returns.

## Pipeline editor

- `↑↓` select step · `SHIFT+↑↓` reorder · `ENTER` edit step
- `N` new **work** step · `C` new **check** step (LLM-judged decision node)
- `D` delete step · `R` rename pipeline
- `T` open timeouts/retries settings
- `I` import · `S` save (export)
- `G` go (run pipeline) when every step is valid
- `ESC` back

## Check step editor (conditional routing)

- `↑↓` select field · `ENTER` start editing the active field
- Fields: **Name**, **Condition** (NL — supports `$runs` token), **MaxRuns**, **Outcomes**, **Feasibility**
- **Outcomes** subform:
  - `A` add outcome · `D` delete · `S` set as default
  - `L` edit label · `N` edit `nextStepName`
  - `C` cycle `nextStepName` through existing step names
- **Feasibility** row: `ENTER` runs the setup-time LLM analysis (`analyzeCheckFeasibility`) and surfaces an `instructionDraft` hint for the runtime judge.
- `ESC` exit editing · `S` save check step

## Step editor

- `↑↓` select field · `TAB` cycle (Name / Prompt / Scope / Files / Model)
- The active field is marked by a `›` indicator; a single footer line always
  shows the keys for the focused field.
- `ENTER` start editing the active field · `ENTER` again to confirm and move on
- On the **Prompt** row: `ENTER` edit inline (single line) · `E` open the
  prompt in `$EDITOR` for multiline editing (git-commit pattern; set
  `EDITOR`/`VISUAL`).
- On the **Scope** row: `ENTER` opens a **scope list** with a one-line
  consequence per option, or jump directly with `P` (project), `F`
  (per-file), `X` (flexible), `M` (memory).
- On the **Deps** row: `ENTER` opens the **dependency picker** (SPACE
  toggles earlier steps · `D` default chain · `R` root). Declaring any
  dependency switches the run into deterministic parallel waves.
  - `project` — runs once on the whole project. The Files row is locked.
  - `per-file` — runs once per selected file. The Files row demands a
    selection; `ENTER` (and `F`) on Files opens the picker.
  - `memory` — runs once per file listed in a memory file an EARLIER step
    writes (`$file` + `$hint` in the prompt).
  - `flexible` — pick at edit time (legacy behavior).
- On the **Files** row:
  - `scope=flexible`: `F` open the picker · `W` use whole project · `ENTER`
    re-opens the picker once a choice has been made.
  - `scope=per-file`: `F` or `ENTER` open the picker. `W` is disabled.
  - `scope=project`: `F`/`W`/`ENTER` are no-ops — the selection is locked.
  - `scope=memory`: `ENTER` opens the **memory link picker** — choose a
    file an earlier step `produces`, pick an earlier step to produce it
    (huu wires both sides and appends the format contract to that step's
    prompt at run time), or type a custom path. `U` unlinks.
  - A step that `produces` a memory file shows `→ produces: <path>` here;
    `O` stops producing it.
- On the **Model** row: `M` pick a model for this step · `C` clear and use the global default
- `ESC` exit editing
- Pressing `ESC` outside editing saves the step when complete (cancels when incomplete)

## File picker

- `↑↓` navigate · `SPACE` toggle · `A` select all · `C` clear all
- `/` filter (smart-case substring)
- `r` regex-select across the whole tree
- `P` copy file selection from a previous step
- `ENTER` confirm (empty selection means whole-project)
- `ESC` cancel

## Run dashboard

- `+` / `-` adjust concurrency live **and pin manual mode**
  (memory-aware auto-scale is on by default); the always-on memory
  guard stays active in manual — the header swaps the `AUTO` chip for
  a `GUARD` chip with the kill count
- `A` toggle auto-scale back on. In auto mode the header shows
  `AUTO <NORMAL|SCALING_UP|BACKING_OFF|COOLDOWN|DESTROYING>` plus live
  `CPU%`/`RAM%`, the observed `~<N>MB/agent` footprint, and free
  memory. Pin manual at startup with `huu --concurrency=N` or
  `huu --no-auto-scale`.
- `M` toggle **MAX mode** (greedy): floods one agent per queued task
  (capped at the hard ceiling) and lets the always-on memory guard be the
  sole backstop — concurrency settles right at the RAM limit, the newest
  agent is killed and requeued to TODO whenever it's crossed. The header
  shows a blue `MAX <state>` chip with live `CPU%`/`RAM%` and the kill
  count. Cooldown-damped, so it never thrashes. Press `M` again (or `A`)
  to return to auto; `+`/`-` drops to manual.
- `↑↓←→` navigate cards · `ENTER` open card details
- `F` filter logs to a single agent (cycles through agents and back to "all")
- `Q` abort the run · press `Q` twice to force-exit the dashboard immediately

### Retry a failed task (`awaiting_retry`)

When a pipeline finishes its steps but **left one or more task cards in error**,
the dashboard does **not** jump to the summary — it pauses in a
**`review (retry?)`** state (amber status, integration worktree kept alive) so
you can recover individual failures. This works on the single-run dashboard AND
per run on the multi-run one:

- `R` — retry the **focused** error card. A **timed-out** card (amber `TIMEOUT`)
  opens a small prompt for a **new time limit** before re-running; any other
  failure (red `FAILED`) re-runs immediately. The card re-runs against the
  current integration HEAD and, on success, its branch is merged in. A user
  retry shows as a `⟳N` badge on the card.
- `D` — **done**: leave the review hold and finalize the run (advances to the
  summary). `Q` instead aborts, discarding any remaining failures.

## Multi-run dashboard (concurrent runs)

Reached two ways: `P` (mark N project folders → pick pipelines → review the
queue), or **saved pipelines** (`M`) with 2+ pipelines checked via `SPACE` to run
them against the current directory. Either way the runs share ONE
backend/model/key, chosen once.

Admission is **lazy**: only the top-priority run starts immediately, the rest sit
in a `queued` phase (amber `⋯` on the tab strip, `N queued` on the budget chip)
until the machine shows sustained spare RAM. This is the same rule the web and
`run-many` use — starting every run at once is what caused the OOM incident in
`ROADMAP.md`.

- `Tab` / `1`–`9` switch which run's board is shown
- `↑↓←→` move focus across the active board's cards · `ENTER` card details
- `R` retry the focused failed card / `D` finish, while that run shows
  **`review (retry?)`** (see the retry section above — it works per run here too)
- `Q` abort all remaining runs and return (press `Q` twice to force)
- When everything settles: the **batch summary** takes over (per-run status,
  commits, files, conflicts, cost + the batch total). `B` returns to the boards,
  `S` brings the summary back, `ENTER` returns to the editor, `Q` quits.

The header carries a machine-global **budget chip** — `dial N%` ·
`agents live/B` (including reserved judge/merge agents) · `RAM %` · host free ·
`N queued` · `host-limited` · pressure reason — next to the active run's own
`grant`. Concurrency is **scheduler-controlled** across all runs (earlier runs have
priority, later ones backfill idle slots, the lowest-priority run's newest agent is
preempted first under memory pressure), so the per-run `+` / `-` / `A` / `M`
concurrency keys are intentionally absent here.

## Dev dashboard (`huu dev --cli`)

The live board of a development session — opt in with `--cli`, `--tui` or
`HUU_CLI=1`; a bare `huu dev` stays headless. It reuses the run kanban, but it
is a **read-only** surface: no card navigation, no log filter, and no `Q` —
`Ctrl+C` is the only exit. Concurrency is decided by the session, not by you.

It paints on **stderr**, so the one JSON object `huu dev` writes to stdout is
byte-identical with the board on or off. With no TTY on stderr huu says so once
and falls back to the plain log; with no TTY on stdin the board still renders,
it just cannot be typed at.

- `Ctrl+C` abort — unmounts the board and exits `130`, the conventional code
  for "terminated by SIGINT"
- `y` / `s` **yes**, at a gate. **Any other key — ENTER included — is no.**
  It is a single keypress, not a typed line: Ink holds stdin in raw mode, so
  the gates are answered inside the frame instead of by a `readline` prompt
  that would fight it for keystrokes. Same default as the headless path.

Only three things ever raise a gate, and all three are opt-in or exceptional:
`--approve-each` (show each epoch's plan before it runs), the offer to **resume**
an interrupted session, and the offer to land **orphan branches** left by one.
Without a TTY on stdin every gate answers **no** before it reaches the board —
no approval, no resume, no orphan landing.

## Card details modal

- `↑↓` scroll · `ESC` / `ENTER` close

## Summary

- `ENTER` back to editor · `Q` quit

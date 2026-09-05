// Compile a DevPlan into a runnable huu Pipeline.
//
// This is the load-bearing translation of dev mode: the planner reasons about
// FRONTS, and this module turns them into an ordinary `huu-pipeline-v2` graph
// with `dependsOn` edges — which means the existing wave scheduler, memory
// fan-out, judge routing and deterministic stage merge run it UNCHANGED. No
// new scheduler, no new merge semantics.
//
// Shape emitted per epoch:
//
//   0. Recon do objetivo                    (project, root)
//   ├─ 1a. <front> — recon    (project, produces <front>/tasks.json)
//   │  └─ 1b. <front> — implementar   (memory, filesFrom the same path,
//   │     │                            + per-task `review`: the critic loop)
//   │     └─ 1c. <front> — verificar  (check: approved ↦ forward, rework ↦ 1b)
//   ├─ 2a/2b/2c …                            (fronts run as PARALLEL waves)
//   ├─ N+1. Consolidar época   (project, dependsOn every front's judge)
//   ├─ N+2. Portão de qualidade (check: approved ↦ seal, rework ↦ consolidate)
//   └─ N+3. Selar época         (project)
//
// Two invariants the compiler owns so the planner can never break them:
//  - `dependsOn` may only name EARLIER steps (`validateTopology` enforces it,
//    and `descendantsOf` relies on it). Fronts are therefore emitted in
//    topological order, and a cyclic/unknown front dependency is DROPPED with
//    a warning rather than failing the epoch.
//  - Every check has exactly one `default: true` outcome and it points
//    FORWARD — the default fires on judge failure, unknown label or the
//    `maxRuns` cap, so it must be the safe path, never the loop.
//
// Three things it now also owns, all purely ADDITIVE (omit the option and the
// emitted pipeline is byte-identical to the one this file emitted before):
//  - MODEL STAMPING. Nine emission points carry a role (`recon`, `worker`,
//    `critic`, `judge`, `reporter`, `integration`). A role the policy does not
//    name OMITS the field, so the orchestrator's `AppConfig.modelId` fallback
//    stays the single authority.
//  - THE PER-TASK REVIEW. The `{k}b` work step declares a `ReviewSpec`, so
//    every task in the swarm is audited in its OWN worktree before its branch
//    is eligible for the stage merge.
//  - THE SELECTABLE METHODOLOGIES (`CompileEpochOptions.methodology`). Each
//    flag is the HUMAN underwriting a piece of method, and each one changes
//    STRUCTURE, never a schema the planner could fill. The options themselves
//    are DECLARED in `methodology-registry.ts` (key, flag, labels, planner
//    bullet); what lives here is the structure each one compiles, through
//    exactly five mechanisms:
//      M1 a new step             (`tdd`: `{k}b. testes (TDD)` before implement)
//      M2 a new check            (`planReview`: "Plano validado?" + loop-back)
//      M3 a critic rubric        (`standards`, `writeSet` → `ReviewSpec.prompt`)
//      M4 a merge gate command   (`lintGate` → `Pipeline.mergeGate`)
//      M5 a front-judge clause   (`tdd`, `writeSet` → the `verificar` condition)
//    Two of those are ACCUMULATORS on purpose — `collectMergeGate` and the
//    judge's `verifyClauses` array — because several options want the one
//    `mergeGate` field and the one clause list, and an option that overwrote
//    another's would vanish with no error to show for it.
//    Any flag on ⇒ the critic's `ReviewSpec.onBlocked` becomes `'hold'`, so a
//    round-cap with blockers parks for a human instead of waiving silently.
//
// Keep this file pure (no fs / no env): it is unit-tested without a repo and
// is imported by the CLI, the web server and the driver alike.

import {
  DEFAULT_REVIEW_BLOCK_ON,
  DEFAULT_REVIEW_MAX_FINDINGS,
  DEFAULT_REVIEW_MAX_ROUNDS,
  DEV_MAX_FRONTS,
  type DevFront,
  type DevMethodology,
  type DevModelPolicy,
  type DevModelRole,
  type DevPlan,
  type Pipeline,
  type PipelineStep,
  type ReviewSpec,
} from '../types.js';
import { PipelineSchema } from '../pipeline-io.js';
import { anyMethodologyOn } from './methodology-registry.js';
import { persistenceCheck } from '../default-pipelines/knowledge-protocol.js';
import { COORDINATOR_RULES } from '../../orchestrator/review-agent.js';
import {
  DEV_FINDINGS_SCHEMA_LINE,
  DEV_SKIP_RULE,
  DEV_STEP_BOUNDARY,
  ROUTER_PREFIX,
  prefixPrompt,
  devFindingsProtocol,
  devPaths,
  devSessionPaths,
  taskSpecContract,
  taskWorkPreamble,
} from './dev-protocol.js';

/** Loop caps. Judges are safety valves, not quality proofs — keep them low. */
const FRONT_JUDGE_MAX_RUNS = 2;
const EPOCH_GATE_MAX_RUNS = 2;

/** Visit ceiling for a compiled epoch. 4 fronts + tail + rework loops ≈ 26. */
const EPOCH_MAX_NODE_EXECUTIONS = 50;

/** Step titles are shown in the kanban; keep them scannable. */
const MAX_TITLE_CHARS = 40;

/**
 * The `diffBudget` ceilings, per TASK, excluding huu's own scratch tree.
 *
 * 400 lines is the top of the range where review effectiveness is repeatedly
 * reported to collapse (the widely cited SmartBear/Cisco review study puts the
 * fall-off at roughly 200–400 LOC); 12 files is the point past which a single
 * task stops being one ownership unit and starts being a merge risk.
 *
 * Constants, not knobs: the value of this option is that the number is not
 * negotiable mid-run. A per-project override is a deliberate future decision,
 * not an oversight — and it would need a surface to be configured FROM.
 */
const DIFF_BUDGET_LINES = 400;
const DIFF_BUDGET_FILES = 12;

export interface CompileEpochOptions {
  plan: DevPlan;
  /** 1-based epoch number — names the blackboard directory. */
  epoch: number;
  /** The human's goal, verbatim. Quoted into the recon step. */
  goal: string;
  /** One line describing the project's knowledge surface, when it has one. */
  knowledgeSummary?: string;
  /**
   * The user's ceiling on parallel fronts for this epoch. Clamped to
   * {@link DEV_MAX_FRONTS}. Without it the cap only ever reached the planner's
   * PROMPT, so a model that returned more fronts than asked simply got them —
   * the compiler is the only layer that can enforce it.
   */
  maxFronts?: number;
  /** Per-card timeout overrides, forwarded onto the pipeline. */
  cardTimeoutMs?: number;
  singleFileCardTimeoutMs?: number;
  /**
   * Per-role model routing. A role this policy does not name is OMITTED from
   * the emitted step, so `AppConfig.modelId` applies exactly as it does today
   * — which is what makes heterogeneous routing opt-in instead of a change to
   * everyone's runs. Absent ⇒ every step is emitted without a `modelId`.
   */
  models?: DevModelPolicy;
  /**
   * Namespaces the blackboard as `.huu/dev/<sessionId>/epoch-N/…`.
   *
   * ABSENT ⇒ the legacy `.huu/dev/epoch-N/…` layout, unchanged, so existing
   * callers keep compiling and keep producing the same graph. PRESENT ⇒ every
   * epoch-scoped path this epoch writes or reads moves under the session
   * segment, which is what makes a `tasks.json` left behind by an EARLIER
   * session structurally unreachable (`resolveMemoryFiles` validates nothing
   * beyond `existsSync`, so a stale file would otherwise fan the swarm out
   * over another session's specs).
   *
   * The session INDEX — `goal.md`, `state.json`, `journal.md` — deliberately
   * stays at the root either way: it is the pointer into the sessions, and the
   * journal is the one file that must accumulate across all of them.
   */
  sessionId?: string;
  /**
   * The project's REAL gate, when a surface detected one (`npm run typecheck
   * && npm test`, or the equivalent). Handed to the per-task critic, which is
   * instructed to RUN it and paste the output BEFORE writing a single finding
   * — the ordering that anchors the critic to something executable instead of
   * to an unverified opinion. Absent ⇒ the critic falls back to the commands
   * the epoch atlas names, and is told to invent none.
   */
  verifyCommands?: string[];
  /**
   * The classified LINT/TYPECHECK subset of the project's real gate — the
   * fast static checks. Read ONLY when `methodology.lintGate` is on: the
   * commands, joined with ` && `, become `Pipeline.mergeGate`. On with an
   * empty/absent list ⇒ the gate is OMITTED with a warning; an extraction
   * failure must never break the run. Ignored entirely when the option is
   * off, which is part of what keeps the no-methodology graph byte-identical.
   */
  lintCommands?: string[];
  /**
   * The classified TEST subset of the project's real gate. Read ONLY when
   * `methodology.tdd` is on: the tests step is told to RUN them and capture
   * the failing red-phase output, the implementar step to finish green, and
   * the critic gets them in its `verifyCommands`. Ignored when the option is
   * off.
   */
  testCommands?: string[];
  /**
   * The changelog surfaces this repository actually has (`.changes/`,
   * `CHANGELOG.md`, …), from {@link detectChangelogPaths}. Read ONLY when
   * `methodology.changelogGate` is on, and only by the CRITIC half of that
   * option: the merge-gate half checks commit-subject FORMAT, which needs no
   * project surface at all. Empty/absent with the option on ⇒ the critic
   * rubric is omitted with a warning, because demanding an entry in a file
   * this project does not have would block every merge for a reason nobody
   * can act on.
   */
  changelogPaths?: string[];
  /**
   * The classified ARCHITECTURE/fitness subset of the project's checks, from
   * the `architecture-rules` knowledge gap. Read ONLY when
   * `methodology.fitnessFunctions` is on: the commands join the composed merge
   * gate. On with an empty/absent list ⇒ the gate contribution is OMITTED with
   * a warning, because most repositories genuinely have no such command and
   * inventing one fails every merge.
   */
  fitnessCommands?: string[];
  /**
   * The methodologies the human underwrote for this session — one checkbox
   * each, all OFF by default. Every flag changes the STRUCTURE this compiler
   * emits (see the file header); absent — or every flag unset — emits exactly
   * the pipeline emitted before this option existed, byte for byte. See
   * {@link DevMethodology}.
   */
  methodology?: DevMethodology;
  /**
   * When the project has a project-router skill, prepend this to every
   * agent prompt so the router classifies the task before execution.
   * Pass {@link ROUTER_PREFIX} from dev-protocol.
   */
  routerPrefix?: string;
}

export interface CompiledEpoch {
  pipeline: Pipeline;
  /** Fronts in the order they were emitted (topologically sorted). */
  frontOrder: string[];
  /** Non-fatal repairs made to the plan (dropped edges, clamped values). */
  warnings: string[];
}

/**
 * The epoch-scoped slice of the blackboard the compiler addresses. Both path
 * sets satisfy it: {@link devSessionPaths} directly, and the legacy
 * {@link devPaths} through the adapter in {@link resolvePaths}.
 */
interface EpochPaths {
  epochDir: (epoch: number) => string;
  atlas: (epoch: number) => string;
  findingsDir: (epoch: number) => string;
  findings: (epoch: number, writer: string) => string;
  epochReport: (epoch: number) => string;
  frontDir: (epoch: number, frontId: string) => string;
  frontTasks: (epoch: number, frontId: string) => string;
  /** Per-task critic shards — one file per task, same anti-conflict rule. */
  reviewDir: (epoch: number, frontId: string) => string;
}

function resolvePaths(sessionId: string | undefined): EpochPaths {
  if (sessionId !== undefined) return devSessionPaths(sessionId);
  return {
    epochDir: devPaths.epochDir,
    atlas: devPaths.atlas,
    findingsDir: devPaths.findingsDir,
    findings: devPaths.findings,
    epochReport: devPaths.epochReport,
    frontDir: devPaths.frontDir,
    frontTasks: devPaths.frontTasks,
    // The legacy path set predates the review loop; mirror the layout
    // `devSessionPaths` uses so the two are the same tree, one prefix apart.
    reviewDir: (epoch, frontId) => `${devPaths.frontDir(epoch, frontId)}/review`,
  };
}

/**
 * Rewrites the LEGACY epoch prefix out of the shared prompt blocks.
 *
 * `dev-protocol.ts`'s reusable blocks (`taskSpecContract`, `taskWorkPreamble`,
 * `devFindingsProtocol`) still address `devPaths` directly; migrating their
 * signatures is a separate, compile-error-driven step owned by that module.
 * Until then a session-namespaced epoch would emit prompts pointing half at
 * `.huu/dev/<sessionId>/epoch-N/` and half at `.huu/dev/epoch-N/` — the exact
 * split-brain the namespacing exists to prevent.
 *
 * The rewrite is total and unambiguous: every epoch-scoped path in this module
 * and in those blocks is built from the literal `.huu/dev/epoch-<N>` prefix,
 * and the namespaced form (`.huu/dev/<sessionId>/epoch-<N>`) does not contain
 * it, so applying this to a whole prompt is idempotent and can never rewrite a
 * path twice. Without a `sessionId` it is the identity function, which is why
 * the no-session graph stays byte-identical.
 */
function makeNamespacer(epoch: number, sessionId: string | undefined): (text: string) => string {
  if (sessionId === undefined) return (text) => text;
  const legacy = devPaths.epochDir(epoch);
  const namespaced = devSessionPaths(sessionId).epochDir(epoch);
  return (text) => text.replaceAll(legacy, namespaced);
}

/** Everything the step builders need, resolved once per compilation. */
interface CompileCtx {
  opts: CompileEpochOptions;
  paths: EpochPaths;
  /** Namespaces the shared `dev-protocol` blocks — identity without a session. */
  ns: (text: string) => string;
  /**
   * Spreadable model stamp. A role the policy does not name yields `{}`, so
   * the emitted step OMITS `modelId` and the orchestrator's own fallback wins.
   */
  model: (role: DevModelRole) => { modelId?: string };
}

/**
 * A step carries a model, never a provider: `AppConfig.provider` is one
 * provider per run, and the pipeline schema has no per-step provider field to
 * stamp. So a route's `provider` is NOT dropped silently — it is enforced one
 * layer up, by `checkDevModelPolicy` at the session border, which refuses a
 * role whose id the run's provider cannot serve BEFORE any worktree exists.
 * When a step grows a provider of its own, this is the function that fills it.
 */
function makeModelStamper(models: DevModelPolicy | undefined): CompileCtx['model'] {
  return (role) => {
    const modelId = models?.[role]?.model.trim();
    return modelId ? { modelId } : {};
  };
}

function shortTitle(title: string): string {
  const t = title.trim();
  return t.length <= MAX_TITLE_CHARS ? t : `${t.slice(0, MAX_TITLE_CHARS - 1)}…`;
}

/**
 * Kahn topological sort over `dependsOnFronts`, resolving ties by the
 * planner's own ordering so the result is deterministic. Unknown ids and
 * self-edges are dropped up front; fronts left in a cycle are appended in
 * plan order with their unresolved edges dropped. Never throws — a malformed
 * dependency is a planner slip, not a reason to lose the epoch.
 */
export function sortFronts(fronts: readonly DevFront[]): {
  order: DevFront[];
  /** Effective deps after repair, keyed by front id. */
  deps: Map<string, string[]>;
  warnings: string[];
} {
  const warnings: string[] = [];
  const known = new Set(fronts.map((f) => f.id));
  const deps = new Map<string, string[]>();

  for (const front of fronts) {
    const cleaned: string[] = [];
    for (const dep of front.dependsOnFronts) {
      if (dep === front.id) {
        warnings.push(`front "${front.id}": dropped self-dependency`);
        continue;
      }
      if (!known.has(dep)) {
        warnings.push(`front "${front.id}": dropped dependency on unknown front "${dep}"`);
        continue;
      }
      if (cleaned.includes(dep)) continue;
      cleaned.push(dep);
    }
    deps.set(front.id, cleaned);
  }

  const order: DevFront[] = [];
  const placed = new Set<string>();
  let progressed = true;
  while (progressed && order.length < fronts.length) {
    progressed = false;
    for (const front of fronts) {
      if (placed.has(front.id)) continue;
      if (deps.get(front.id)!.every((d) => placed.has(d))) {
        order.push(front);
        placed.add(front.id);
        progressed = true;
      }
    }
  }

  // Whatever is left sits in a dependency cycle. Break it by dropping the
  // unresolved edges — the fronts still run, just without the ordering the
  // planner asked for.
  for (const front of fronts) {
    if (placed.has(front.id)) continue;
    const unresolved = deps.get(front.id)!.filter((d) => !placed.has(d));
    warnings.push(
      `front "${front.id}": dropped dependency on ${unresolved.map((d) => `"${d}"`).join(', ')} to break a cycle`,
    );
    deps.set(
      front.id,
      deps.get(front.id)!.filter((d) => placed.has(d)),
    );
    order.push(front);
    placed.add(front.id);
  }

  return { order, deps, warnings };
}

function reconStepName(): string {
  return '0. Recon do objetivo';
}

/** Which pre-implementation steps a front carries, from the methodology. */
interface FrontStages {
  /** `characterization`: capture today's behavior as a committed baseline. */
  characterize: boolean;
  /** `tdd`: write the failing tests before any implementation exists. */
  tdd: boolean;
}

function frontStages(m: DevMethodology | undefined): FrontStages {
  return { characterize: m?.characterization === true, tdd: m?.tdd === true };
}

interface FrontStepNames {
  recon: string;
  /** The golden-master step — present only when `characterization` is on. */
  characterize: string | undefined;
  /** The tests-first step — present only when `tdd` is on. */
  tests: string | undefined;
  work: string;
  verify: string;
}

/**
 * The front's step names and, implicitly, its ORDER.
 *
 * Lettered from the sequence rather than written out per combination: two
 * options now insert a step before `implementar`, and enumerating the four
 * combinations by hand is how `{k}c` ends up meaning two different things in
 * two branches of the same file.
 *
 * `caracterizar` precedes `testes` because it records what the code does
 * TODAY, and it must not be able to observe a test written this epoch. With
 * neither option on, the letters are `a`/`b`/`c` exactly as they always were.
 */
function frontStepNames(index: number, title: string, stages: FrontStages = { characterize: false, tdd: false }): FrontStepNames {
  const k = index + 1;
  const t = shortTitle(title);
  const sequence: { key: keyof FrontStepNames; label: string }[] = [
    { key: 'recon', label: 'recon' },
    ...(stages.characterize ? [{ key: 'characterize' as const, label: 'caracterizar' }] : []),
    ...(stages.tdd ? [{ key: 'tests' as const, label: 'testes (TDD)' }] : []),
    { key: 'work', label: 'implementar' },
    { key: 'verify', label: 'verificar' },
  ];
  const names: FrontStepNames = {
    recon: '',
    characterize: undefined,
    tests: undefined,
    work: '',
    verify: '',
  };
  sequence.forEach((stage, i) => {
    names[stage.key] = `${k}${'abcdefg'[i]}. ${t} — ${stage.label}`;
  });
  return names;
}

/**
 * The front-line prompt rules (Onda 2.5, from the front-line leak), shared
 * verbatim by both recon templates below. UNCONDITIONAL text: it changes what
 * the prompts say, never the graph, so the no-methodology byte-identity
 * contract is untouched. Module-level so the two templates cannot drift.
 */
const RECON_EXPLORATION_BLOCK = `=== EXPLORATION DISCIPLINE ===
- This is a git worktree — an isolated copy of the repository. Run all commands from this directory.
- Batch independent tool calls into ONE turn — fire every read and search you already know you need in parallel instead of dribbling them out one at a time.
- Write down every key fact the moment you find it. Tool results may be compacted away later; what lands in the files you write (the atlas, the task specs, your findings shard) is the memory that survives.`;

/** Same source, aimed at the work steps: minimal scope, WHY-only comments, durable memory. */
const WORK_IMPLEMENTATION_BLOCK = `=== IMPLEMENTATION DISCIPLINE ===
- This is a git worktree — an isolated copy of the repository. Run all commands from this directory.
- Don't add features, refactor code, or make 'improvements' beyond what was asked. A bug fix doesn't need surrounding code cleaned up. A simple feature doesn't need extra configurability.
- Default to writing no comments. Only add one when the WHY is non-obvious: a hidden constraint, a subtle invariant, a workaround.
- Batch independent tool calls into ONE turn when you explore — read everything you already know you need in parallel.
- Before you finish, persist every key fact you discovered into your findings shard. Tool results may be compacted away later; the files are the memory that survives.`;

function buildReconStep(ctx: CompileCtx, frontSummary: string): PipelineStep {
  const { epoch, goal } = ctx.opts;
  const paths = ctx.paths;
  return {
    type: 'work',
    name: reconStepName(),
    scope: 'project',
    files: [],
    dependsOn: [],
    ...ctx.model('recon'),
    prompt: `${RECON_EXPLORATION_BLOCK}

${DEV_SKIP_RULE}

${DEV_STEP_BOUNDARY}

You are the reconnaissance agent that opens epoch ${epoch} of a huu development run. ONE cognitive op: map the ground the swarm is about to work on. You do NOT implement anything.

=== THE GOAL (written by the human, never reinterpret it) ===
${goal}

=== THIS EPOCH ===
${ctx.opts.plan.epochGoal}

The following fronts will run IN PARALLEL right after you, each fanning out into its own swarm of agents:
${frontSummary}
${ctx.opts.knowledgeSummary ? `\n=== PROJECT KNOWLEDGE ===\n${ctx.opts.knowledgeSummary}\n` : ''}
${persistenceCheck('dev')}

=== WRITE THE ATLAS ===
Write \`${paths.atlas(epoch)}\` — the map every agent in this epoch reads before acting. Create parent directories as needed. Cover, with real repo-relative paths and no filler:
- **Stack & entry points** — languages, build/test commands that actually exist here, where execution starts.
- **Where the goal lands** — the modules, directories and files the goal touches, and what each is responsible for.
- **Conventions to match** — naming, module system, error handling, test layout. Quote a short real example.
- **Existing pieces to reuse** — functions, types and helpers already in the repo that the work should build on instead of duplicating.
- **Landmines** — generated code, things that look editable but aren't, load-bearing invariants a newcomer would break.
- **Per front** — one short section per front id above, listing the files that front will most likely touch.

The atlas is also the STANDARD a separate reviewer will hold every task's diff against, so "Conventions to match" and "Landmines" must name real, checkable rules — a vague atlas turns into vague review findings.

=== BOOTSTRAP THE SHARED MEMORY ===
Create \`${paths.findings(epoch, 'recon')}\` as a JSON array. Seed it with the decisions and risks you already see, one entry per line of this shape:
${DEV_FINDINGS_SCHEMA_LINE}
Use \`"front": "recon"\` for your own entries. Write ONLY that file — every later agent writes its own shard in the same directory, which is what lets a parallel wave merge without conflicting.

=== HARD RULES ===
- Write ONLY under \`${paths.epochDir(epoch)}/\` (plus the one \`.gitignore\` rewrite the persistence check may require). Change no source.
- Be concrete. "Follows standard patterns" is worthless; name the file and the pattern.
- Be language-agnostic — do not assume Node.js.`,
  };
}

/**
 * The per-task critic brief for one front (§1.4b of the design).
 *
 * The generic critic protocol — the output contract, the git range, the
 * severity cap — is `review-agent.ts`'s system prompt and is the same for any
 * pipeline that declares a `review`. What belongs HERE is what only dev mode
 * knows: the human's goal, the epoch's own atlas, the project's knowledge
 * surface, and the fact that the standard for "style" and "pattern" is LOADED
 * from those artefacts rather than invented.
 *
 * Every ordering rule below is a defence against the measured dominant failure
 * mode of an LLM critic, which is SPURIOUS BLOCKING of correct code (false
 * rejection measured at 22.5%–91.9%, ~87% of it semantic hallucination —
 * dominated by asserted logic errors with no counterexample and by invented
 * requirements), not missed bugs. Hence: run before opining, proof before
 * opinion, a hard cap, a mandatory counterexample for a blocking logic claim,
 * and explicit permission to abstain.
 */
/**
 * Which phase of a split front a critic brief is auditing — absent when
 * neither `tdd` nor `characterization` splits the work.
 */
type ReviewLens = 'tests' | 'characterization' | 'implementation';

/**
 * What the TDD split changes for the critic: the same measured defences, but
 * aimed at the phase under review. The tests-phase brief INVERTS the generic
 * "a failing command is a finding" rule — a failing test run is the proof the
 * red phase happened, and a green one is the defect.
 */
function tddLensBlock(lens: ReviewLens, stages: FrontStages): string {
  if (lens === 'characterization') {
    return `=== THE CHARACTERIZATION CONTRACT — WHAT THIS DIFF IS ===
This diff is a BASELINE: snapshots of what the code does TODAY, recorded before anything changes.
- A production file in this diff is a \`blocker\` — this agent was forbidden to change behavior, including behavior it believed was wrong.
- Every expected value must be traceable to a run the agent actually performed. A snapshot that reads like a PREDICTION of the output rather than a capture of it is a \`blocker\`: the whole baseline is worthless if any part of it was imagined.
- The suite is EXPECTED TO PASS here — green against unchanged code is the proof the baseline is real, and red means the snapshot does not match the very code it was taken from. The agent was told to paste that passing output into its findings shard; no proof means no baseline.
- Do NOT report the captured behavior as a defect. "This output looks wrong" is out of scope by construction: recording wrong behavior faithfully is exactly the job. A genuine defect belongs in the findings as a note, never as a reason to change the snapshot.`;
  }
  if (lens === 'tests') {
    return `=== THE TDD CONTRACT — WHAT THIS DIFF IS ===
This diff is the RED phase of TDD: TEST FILES ONLY, written before any implementation exists.
- An implementation file in this diff is a \`blocker\` — this agent was forbidden to write one.
- Every test must derive from the task spec's "Done when" list. A criterion with no test is a gap; a test that asserts nothing about a listed criterion is noise.
- The test command is EXPECTED TO FAIL here — that failure IS the red phase, not a finding. The defect to catch is the opposite: tests that PASS with zero implementation written prove nothing, and that is a \`major\` at minimum. The agent was told to paste the failing output into its findings shard as proof; no proof means the red phase never happened.`;
  }
  const frozen: string[] = [];
  if (stages.tdd) {
    frozen.push(
      '- The test files are FROZEN. Any modification, rename or deletion of a test file in this diff is a `blocker` — a test may only change through the tests step\'s own critic loop, never through the implementation.',
    );
  }
  if (stages.characterize) {
    frozen.push(
      '- The SNAPSHOT files are FROZEN unless the change is explicitly approved IN THE SAME COMMIT (an approval file, or this project\'s own accept marker — the atlas names it). A rewritten snapshot with no approval is a `blocker`: it is a behavior change that erased its own evidence. A snapshot that changed WITH an approval is legitimate — check that the approved value matches what the code now produces, and that the task spec asked for that change.',
    );
  }
  const what = stages.tdd
    ? 'the GREEN phase of TDD: the smallest implementation that turns the already-written tests green'
    : 'the implementation, measured against the behavior baseline the characterization step recorded';
  const run = stages.tdd
    ? '- RUN the test command and demand PASSING output. Red at the end of this step is a `blocker`.'
    : '- RUN the test command and demand PASSING output, characterization tests included. Red at the end of this step is a `blocker`.';
  return `=== THE ${stages.tdd ? 'TDD' : 'CHARACTERIZATION'} CONTRACT — WHAT THIS DIFF IS ===
This diff is ${what}.
${frozen.join('\n')}
${run}
- "It was wrong so I changed it" is not a defence available to this diff — the fix for a wrong test or a wrong snapshot is a blocking finding, not a silent edit.`;
}

/**
 * The `standards` rubric: the critic already LOADS the standard from the
 * atlas and the goal; this section makes enforcement explicit and names the
 * project's own constitution. The anti-nitpick rule is the same defence the
 * brief already states in its own words ("The spec is the contract, not your
 * preferred design"). The closing coordinator rules are the SHARED
 * {@link COORDINATOR_RULES} from `review-agent.ts` — one source of truth, so
 * this rubric and the critic's own system prompt can never drift apart.
 */
function standardsBlock(atlasPath: string): string {
  return `=== THE DECLARED STANDARDS (the human enabled standards enforcement for this run) ===
The standard you hold this diff against is DECLARED, not felt:
- the epoch atlas (\`${atlasPath}\`) — its "Conventions to match" and "Landmines" sections are binding here;
- the project's own \`AGENTS.md\` at the repo root, when one exists — the project's written constitution;
- the task spec's "Done when" list.
Report ONLY violations of correctness or of a declared standard you can point at — never taste, preference, or a convention you cannot cite in one of those. A finding no declared standard backs is noise: drop it.
${COORDINATOR_RULES}`;
}

/**
 * The `writeSet` rubric: the task spec's `Files this task OWNS` list stops
 * being a hint and becomes a contract the critic checks.
 *
 * Deliberately framed as a SET DIFFERENCE, not a judgement. Everything else
 * this brief asks of a critic is calibrated against spurious blocking, so an
 * option that let it block on "should this file have been touched?" would be
 * the exact failure mode the rest of the prompt fights. Two lists and a
 * subtraction have no room for a hallucinated requirement.
 *
 * The asymmetry is deliberate too: writing an UNDECLARED file is blocking (it
 * is what collides with a parallel agent at merge time), while leaving a
 * DECLARED file untouched is nothing at all — a spec may over-declare.
 *
 * The exclusions mirror `writeSetViolations` in `review-agent.ts`, which is
 * what the orchestrator's own instrumentation counts: huu's scratch tree is
 * written by every agent BY INSTRUCTION, so counting it would make every task
 * a violator of itself.
 */
function writeSetBlock(): string {
  return `=== THE DECLARED WRITE SET (the human enabled write-set enforcement for this run) ===
The task spec's "Files this task OWNS" section is a CONTRACT here, and checking it is mechanical:
1. List the files this diff actually touches (\`git diff --name-only\` against the branch base).
2. Subtract the spec's ownership list. An entry naming a directory covers everything under it. huu's own scratch tree never counts: \`.huu/\`, \`.huu-*\`, \`.env.huu\` are written by instruction.
3. Every path still left over is a \`blocker\` — one finding per file, the path itself as the evidence.
This is a set difference, not a judgement call. "The change genuinely needed that file" is not a defence: if it did, the SPEC was wrong, and saying so IS the finding. Parallel agents are writing other files right now, and an undeclared write is what collides at merge time.
The converse is NOT a finding: a file the spec declares and the diff never touched is fine — a spec is allowed to over-declare.`;
}

/**
 * The `changelogGate` rubric — the half of that option a machine cannot do.
 *
 * The split is the whole design: commit-subject FORMAT is a regex and lives in
 * the merge gate, while "is this change user-visible?" needs the task spec and
 * the diff, which is the critic's job and nobody else's. The closing line
 * exists to stop the critic re-reviewing the format half and reporting a
 * finding for something the gate already blocks — duplicate findings eat the
 * `maxFindings` budget a real defect needs.
 */
function changelogBlock(paths: readonly string[]): string {
  return `=== THE CHANGELOG (the human enabled changelog discipline for this run) ===
This project records user-visible change in ${paths.map((p) => `\`${p}\``).join(' or ')}. If — and ONLY if — this diff changes something a USER can observe (a CLI flag, an API surface, an output format, a default, a config key, an error message they read), the same diff must carry the entry.
- User-visible change with no entry: \`major\`, naming the file that should have carried it.
- An internal-only change (a refactor, a test, a private helper) owes NOTHING here. Demanding an entry for one is noise — do not.
- The commit SUBJECTS are already checked mechanically by the merge gate. Do not review their format here, and do not report a finding about it.`;
}

/**
 * The `diffBudget` rubric. The merge gate already owns the NUMBER — counting
 * lines is not something a critic should be spending a turn on — so what this
 * asks for is the one thing a machine cannot produce: where the cut goes.
 *
 * A finding that only restates the count is worse than no finding: it consumes
 * one of the critic's capped slots and hands the agent nothing to act on.
 */
function diffBudgetBlock(): string {
  return `=== THE DIFF BUDGET (the human enabled small-batch enforcement for this run) ===
This task's diff is capped at ${DIFF_BUDGET_LINES} changed line(s) across ${DIFF_BUDGET_FILES} file(s), ignoring huu's own scratch tree. The merge gate already counts; what YOU owe is the diagnosis.
- Over budget: \`major\`, and name WHERE the natural cut is — which subset of the "Done when" list should have been its own task. A finding that only restates the number is useless to the agent that has to act on it, and it costs a slot a real defect needed.
- Under budget is never a finding. A small diff is the goal, not a symptom of missing work.
- Do not stretch a review to match the cap. Review quality collapsing on large diffs is the entire reason the cap exists — reviewing a large diff harder is not the fix.`;
}

/**
 * The `fitnessFunctions` rubric.
 *
 * Layering is the standard a swarm erodes without ever breaking a test: each
 * diff is locally reasonable and the boundary dies by accumulation. The gate
 * catches it AFTER the merge; this asks the critic to catch it before, and —
 * critically — only against rules it can point at. "This feels like a layering
 * violation" is the exact hallucinated-requirement failure the rest of the
 * brief is calibrated against.
 */
function fitnessBlock(atlasPath: string, commands: readonly string[]): string {
  const gateLine =
    commands.length > 0
      ? `The same check runs as a merge gate (\`${commands.join('` and `')}\`), so a violation you miss costs a rewound merge — but a violation you INVENT costs a correct branch.`
      : 'This project has no executable architecture check, so the atlas is the whole standard here — which is also why a rule you cannot cite in it does not exist.';
  return `=== THE ARCHITECTURE RULES (the human enabled architecture enforcement for this run) ===
Layering is what a parallel swarm erodes without breaking a single test: every diff is locally reasonable, and the boundary dies by accumulation. Hold this diff to the DECLARED rules only:
- the epoch atlas (\`${atlasPath}\`) — its layering, module-boundary and dependency-direction rules are binding here;
- the project's own architecture/dependency-rule config, when the atlas names one.
A new import that crosses a declared boundary, or a new cycle between modules, is a \`blocker\` — quote the rule and name the importing file and the imported one. A dependency direction no declared rule mentions is NOT a violation, however wrong it looks to you.
${gateLine}`;
}

/**
 * The `checklistReview` rubric — the machinery that makes a critic's output
 * REPRODUCIBLE rather than merely plausible.
 *
 * Two properties do the work, and both come from the inspection literature
 * rather than from prompt folklore. First, a FIXED ENUM per item: a 1–5
 * quality score from an LLM is uncalibrated and drifts between runs, while
 * `PASS`/`FAIL`/`N-A` against a named item is a decision that can be compared
 * across epochs. Second, MANDATORY EVIDENCE: an item whose verdict cites no
 * command output and no `file:line` is the shape a hallucinated finding takes,
 * so requiring the citation is what makes fabrication cost more than
 * abstention.
 *
 * `N-A` is deliberately a first-class answer. Without it the model has no
 * legal way to say "this item does not apply here" and will manufacture a
 * PASS — which is exactly the rubber-stamp the whole review exists to avoid.
 *
 * The checklist comes BEFORE the findings on purpose: it is the same
 * run-before-you-opine ordering the base brief already uses, applied to
 * judgement instead of to commands.
 */
function checklistBlock(): string {
  return `=== THE REVIEW CHECKLIST (the human enabled checklist review for this run) ===
Before ANY free-form finding, answer every item below, in order, one line each, in exactly this shape:

    C1 VERIFY-RAN: PASS — npm test, exit 0
    C2 DONE-WHEN: FAIL — spec line 3 ("rejects an empty id") — src/parse.ts:41 accepts it

The verdict token is \`PASS\`, \`FAIL\` or \`N-A\` and nothing else — no scores, no percentages, no hedged words. Every line carries evidence: a command with its exit code, or a \`file:line\`. An item you cannot settle is \`N-A\` with the reason; that is a CORRECT answer, and it beats a guess in both directions.

    C1 VERIFY-RAN — the declared commands were actually run in this worktree and their real output is in this reply.
    C2 DONE-WHEN — every line of the task spec's "Done when" list is satisfied. Answer ONE LINE PER CRITERION; a compound criterion gets one verdict per clause.
    C3 SPEC-ONLY — the diff implements what the spec asked and nothing beyond it (an extra feature is as much a defect as a missing one).
    C4 CONVENTIONS — the diff matches the conventions the atlas names, each one you checked cited by name.
    C5 NO-PLACEHOLDER — no TODO, stub or hard-coded return stands in for the work.

Then, and only then, write your findings. EVERY finding must correspond to an item you marked \`FAIL\`; a finding with no failing item is out of scope for this review, and an item marked \`FAIL\` with no finding is an omission. Skipping an item is a malformed review, not a shorter one.`;
}

function buildReviewSpec(front: DevFront, ctx: CompileCtx, lens?: ReviewLens): ReviewSpec {
  const { epoch, goal, knowledgeSummary, verifyCommands } = ctx.opts;
  const paths = ctx.paths;
  const blockOn = [...DEFAULT_REVIEW_BLOCK_ON];
  const maxRounds = DEFAULT_REVIEW_MAX_ROUNDS;
  const maxFindings = DEFAULT_REVIEW_MAX_FINDINGS;
  const standards = ctx.opts.methodology?.standards === true;
  const writeSet = ctx.opts.methodology?.writeSet === true;
  // Appended in registry order, so a critic running both rubrics always reads
  // them in the same sequence — a prompt that reshuffles between epochs
  // defeats the provider prompt cache for no benefit.
  const changelogPaths = (ctx.opts.changelogPaths ?? []).filter((p) => p.trim().length > 0);
  const changelog = ctx.opts.methodology?.changelogGate === true && changelogPaths.length > 0;
  const rubrics = [
    ...(standards ? [standardsBlock(paths.atlas(epoch))] : []),
    ...(writeSet ? [writeSetBlock()] : []),
    ...(changelog ? [changelogBlock(changelogPaths)] : []),
    ...(ctx.opts.methodology?.diffBudget === true ? [diffBudgetBlock()] : []),
    ...(ctx.opts.methodology?.fitnessFunctions === true
      ? [
          fitnessBlock(
            paths.atlas(epoch),
            (ctx.opts.fitnessCommands ?? []).filter((c) => c.trim().length > 0),
          ),
        ]
      : []),
    // LAST on purpose: it is the block that tells the critic what SHAPE to
    // answer in, so it must come after every rubric that adds a thing to
    // check — otherwise it describes an output contract for a checklist the
    // reader has not been given yet.
    ...(ctx.opts.methodology?.checklistReview === true ? [checklistBlock()] : []),
  ];

  const prompt = `You are auditing ONE task of the "${front.id}" front of epoch ${epoch} of a huu development run. A different agent wrote this diff alone, in this worktree, from the task spec named below.

=== THE GOAL (written by the human, never reinterpret it) ===
${goal}

=== THIS FRONT ===
${front.title} — ${front.rationale}${lens ? `\n\n${tddLensBlock(lens, frontStages(ctx.opts.methodology))}` : ''}

=== THE THREE LENSES, IN THIS ORDER ===
1. **correctness** — does the diff do what its task spec asked, without breaking what already worked?
2. **pattern** — does it follow THIS project's design patterns?
3. **style** — does it match THIS project's code style?

You do NOT invent the standard for 2 and 3. LOAD it:
- \`${paths.atlas(epoch)}\` — the epoch atlas, written this epoch by an agent that read the repo: stack, conventions to match, existing pieces to reuse, landmines.
- \`${devPaths.goal}\` — the goal, verbatim.
- the project's own convention/skill files, when the atlas names them.${knowledgeSummary ? `\n- the project's documented knowledge surface: ${knowledgeSummary}` : ''}
If none of them states a rule, that rule does not exist in this project. Do not import a convention from somewhere else.

=== ORDER OF WORK (do not reorder) ===
1. RUN the commands under <verify-commands> FIRST and paste their real output into your reply BEFORE writing a single finding. If none is declared, run the build / type-check / test commands the atlas names. If this project genuinely has none, say so — never invent one.
2. Every failure a command actually demonstrated becomes a finding WITH \`proof\` (the command, its exit code, a short excerpt). Those come first.
3. ONLY THEN read the diff against the task spec and judge pattern and style.

=== WHAT MAKES A FINDING LEGITIMATE HERE ===
- A correctness finding at \`blocker\` or \`major\` requires a CONCRETE COUNTEREXAMPLE — the input, the expected output, and the actual output — or a command that failed. Without one it is a \`minor\`, not a blocker. A confident story about how the code "could" break is not evidence.
- Do NOT invent requirements. If a constraint is not in the task spec, not in the goal above, and not in a project convention you can point at, its absence is not a violation.
- The spec is the contract, not your preferred design. "I would have structured it differently" is at most a \`nit\`.
- "I could not verify this" is a correct and cheap answer. Prefer it to a guess; an unverifiable suspicion is a \`minor\`, never a \`blocker\`.
- At most ${maxFindings} findings, severity-descending, \`evidence\` ≤ 15 lines. A longer list is not a better review.
- Only this diff is yours to judge. A problem that already existed outside it does not belong here at all — the front's judge sees the merged tree and is the one that can act on it.${rubrics.map((r) => `\n\n${r}`).join('')}

=== WHAT BLOCKING COSTS ===
${blockOn.join(' and ')} findings hold the merge and send the work back to the SAME agent, for at most ${maxRounds} round(s) in total. Everything else is recorded and merged. A blocked round costs a full extra agent turn on this project's budget, so an unproven suspicion is not worth it — and blocking correct code is the failure mode this review is calibrated against, not missing a nit.`;

  // The critic's executable anchor. Without a lens this is the caller's flat
  // list, verbatim. The tests-phase critic gets ONLY the test command —
  // build/lint commands fail spuriously against a tree whose implementation
  // does not exist yet — and the implementation-phase critic gets the test
  // command guaranteed present, since green-at-the-end is its bar.
  const commands = (() => {
    const tests = (ctx.opts.testCommands ?? []).filter((c) => c.trim().length > 0);
    // Both pre-implementation lenses get ONLY the test command: a build or a
    // lint run against a tree whose implementation does not exist yet (tdd) —
    // or has not been touched at all (characterization) — fails for reasons
    // that have nothing to do with the diff under review.
    if (lens === 'tests' || lens === 'characterization') {
      return tests.length > 0 ? tests : undefined;
    }
    const merged = verifyCommands && verifyCommands.length > 0 ? [...verifyCommands] : [];
    if (lens === 'implementation') {
      for (const cmd of tests) {
        if (!merged.includes(cmd)) merged.push(cmd);
      }
    }
    return merged.length > 0 ? merged : undefined;
  })();

  return {
    prompt,
    maxRounds,
    blockOn,
    maxFindings,
    findingsDir: paths.reviewDir(epoch, front.id),
    ...(commands ? { verifyCommands: commands } : {}),
    ...(anyMethodologyOn(ctx.opts.methodology) ? { onBlocked: 'hold' as const } : {}),
    ...ctx.model('critic'),
  };
}

function buildFrontReconStep(
  front: DevFront,
  index: number,
  ctx: CompileCtx,
  depVerifyNames: string[],
): PipelineStep {
  const { epoch } = ctx.opts;
  const paths = ctx.paths;
  const names = frontStepNames(index, front.title, frontStages(ctx.opts.methodology));
  const tasksPath = paths.frontTasks(epoch, front.id);

  return {
    type: 'work',
    name: names.recon,
    scope: 'project',
    files: [],
    dependsOn: [reconStepName(), ...depVerifyNames],
    produces: tasksPath,
    ...ctx.model('recon'),
    prompt: `${RECON_EXPLORATION_BLOCK}

${ctx.ns(DEV_SKIP_RULE)}

${DEV_STEP_BOUNDARY}

You are the planner for the "${front.id}" front of epoch ${epoch}. ONE cognitive op: split this front into independent tasks and brief the agents that will execute them. You do NOT implement anything.

=== THE GOAL (written by the human, never reinterpret it) ===
${ctx.opts.goal}

=== THIS FRONT ===
${front.title} — ${front.rationale}

=== YOUR ASSIGNMENT ===
${front.reconPrompt}

=== READ FIRST ===
- \`${paths.atlas(epoch)}\` — the epoch atlas: stack, conventions, landmines, and the section naming the files this front will touch.
- \`${devPaths.goal}\` — the goal, verbatim.

${ctx.ns(devFindingsProtocol(epoch, `${front.id}-recon`))}

${ctx.ns(taskSpecContract(epoch, front.id, front.maxTasks))}

Each task's diff is audited by a SEPARATE reviewer before its branch may merge, against the task spec you write here. A spec whose "Done when" list is vague ("works correctly") gives that reviewer nothing to check and invites it to invent a standard — write criteria a command or a file read can settle.`,
  };
}

/**
 * The work half of one front. Without `tdd`: the single `{k}b. implementar`
 * memory step plus its judge, exactly as before the methodologies existed.
 * With `tdd`: the RED/GREEN split — `{k}b. testes (TDD)` → `{k}c.
 * implementar`, judge at `{k}d` — both memory steps fanning out over the SAME
 * tasks.json (one task agent per spec, per phase), each audited by its own
 * critic lens.
 *
 * `firstWorkExtraDeps` carries the plan gate's name when `planReview` is on:
 * the front's first work step may not start before "Plano validado?" routes —
 * the same way "Selar" may not start before the epoch gate.
 */
function buildFrontWorkSteps(
  front: DevFront,
  index: number,
  ctx: CompileCtx,
  consolidateName: string,
  firstWorkExtraDeps: string[],
): PipelineStep[] {
  const { epoch } = ctx.opts;
  const paths = ctx.paths;
  const stages = frontStages(ctx.opts.methodology);
  const tdd = stages.tdd;
  const names = frontStepNames(index, front.title, stages);
  const tasksPath = paths.frontTasks(epoch, front.id);

  const testCommandClause = (() => {
    const cmds = (ctx.opts.testCommands ?? []).filter((c) => c.trim().length > 0);
    return cmds.length > 0
      ? `the test command (\`${cmds.join('`, `')}\`)`
      : 'the test command the atlas names (if this project genuinely has none, write the tests anyway and record in your findings that nothing here can run them)';
  })();

  // The pre-implementation chain, in emission order. Each link depends on the
  // previous one and the FIRST link carries the extra deps (the plan gate),
  // so inserting a stage cannot leave the gate wired to a step that no longer
  // runs first.
  const chain = [names.characterize, names.tests].filter((n): n is string => n !== undefined);
  const dependsOnFor = (position: number): string[] =>
    position === 0 ? [names.recon, ...firstWorkExtraDeps] : [chain[position - 1]!];

  const characterize: PipelineStep | undefined = stages.characterize
    ? {
        type: 'work',
        name: names.characterize!,
        scope: 'memory',
        filesFrom: tasksPath,
        maxFiles: front.maxTasks,
        files: [],
        dependsOn: dependsOnFor(chain.indexOf(names.characterize!)),
        review: buildReviewSpec(front, ctx, 'characterization'),
        ...ctx.model('worker'),
        prompt: `You are one agent in a parallel swarm on the "${front.id}" front, writing CHARACTERIZATION TESTS — a snapshot of what this code does TODAY, before anybody changes it. Your ENTIRE assignment is the spec file \`$file\`.

Summary from the planner: $hint

=== WHY THIS STEP EXISTS ===
The behavior you are about to record is not necessarily correct. It is what the system DOES, and that is the only baseline a change to unspecified code can be measured against. You are not judging it, improving it, or fixing it — you are pinning it down so the next step cannot alter it by accident.

=== PROCEDURE (record, never change) ===
1. Read \`$file\` in full. Its "Done when" list tells you which behavior this task is about to touch.
2. Read \`${devPaths.goal}\` for the overall goal, and \`${paths.atlas(epoch)}\` for the map of the codebase produced this epoch — its conventions name this project's test layout and runner.
3. For each behavior the task will touch, find the OBSERVABLE boundary: a command's stdout and exit code, a function's return value for concrete inputs, a rendered file, an HTTP response. Pick the outermost one you can drive.
4. EXECUTE the current code at that boundary and capture the REAL output — every value in the snapshot must come from a run you actually performed. A snapshot you predicted instead of observed is worthless and worse than none.
5. Write the snapshot in the project's own approval/snapshot idiom when it has one (the atlas names it); otherwise commit a plain expected-output file next to the test that asserts against it.
6. RUN ${testCommandClause} and confirm the characterization tests PASS against the unchanged code. Green here is the proof the baseline is real. Paste the passing output into your findings shard.
7. Commit your work.

=== FORBIDDEN IN THIS STEP ===
- Changing ANY behavior. No fix, no refactor, no "obvious improvement" — even one that is clearly right. If you find a real defect, record it as a finding and snapshot the buggy behavior anyway; the snapshot's job is to make the next change VISIBLE, not correct.
- Writing an expected value you did not observe.
- Characterizing behavior this task will not touch. A snapshot of unrelated code is noise the next step has to keep green forever.

=== OWNERSHIP (non-negotiable) ===
- Write ONLY snapshot/characterization test files, in the project's test layout, plus YOUR OWN findings shard (named below).
- You may READ anything. Other agents are running RIGHT NOW; touching a file outside your snapshot files produces a merge conflict that costs the whole stage.
- Never edit another task's spec, another front's directory, or \`${devPaths.state}\`.

${WORK_IMPLEMENTATION_BLOCK}

${ctx.ns(devFindingsProtocol(epoch, null))}

=== YOUR DIFF IS REVIEWED BEFORE IT MERGES ===
A separate reviewer reads \`git diff\` on your branch and checks the characterization contract: snapshot files only, every expected value traceable to a run you performed, and the suite green against unchanged code.

${ctx.ns(DEV_SKIP_RULE)}`,
      }
    : undefined;

  const tests: PipelineStep | undefined = tdd
    ? {
        type: 'work',
        name: names.tests!,
        scope: 'memory',
        filesFrom: tasksPath,
        maxFiles: front.maxTasks,
        files: [],
        dependsOn: dependsOnFor(chain.indexOf(names.tests!)),
        review: buildReviewSpec(front, ctx, 'tests'),
        ...ctx.model('worker'),
        prompt: `${WORK_IMPLEMENTATION_BLOCK}

${ctx.ns(DEV_SKIP_RULE)}

${DEV_STEP_BOUNDARY}

You are one agent in a parallel swarm on the "${front.id}" front, writing TESTS FIRST — the RED phase of TDD. Your ENTIRE assignment is the spec file \`$file\`.

Summary from the planner: $hint

=== PROCEDURE (tests first — implementation is the NEXT step's job, never yours) ===
1. Read \`$file\` in full. It names the behavior to specify and the "Done when" criteria.
2. Read \`${devPaths.goal}\` for the overall goal, and \`${paths.atlas(epoch)}\` for the map of the codebase produced this epoch — its conventions name this project's test layout and test runner.
3. Derive tests from the spec's "Done when" list: one behavioral test per criterion, in the project's own test style and layout.
4. RUN ${testCommandClause} and CAPTURE THE FAILING OUTPUT. Failure because the implementation does not exist yet is exactly right — it is the REQUIRED red phase: paste the command and its failing output into your findings shard as proof. A test that passes with no implementation written proves NOTHING — rewrite it until it fails for the right reason.
5. Commit your work.

=== FORBIDDEN IN THIS STEP ===
- Writing or modifying ANY implementation file. You specify; the next step implements. The implementation files your spec lists under "Files this task OWNS" belong to that step, not to you.
- Writing a test that cannot fail (an empty assertion, a tautology, a test of the test framework).

=== OWNERSHIP (non-negotiable) ===
- Write ONLY test files, in the project's test layout, plus YOUR OWN findings shard (named below).
- You may READ anything. Other agents are running RIGHT NOW; touching a file outside your test files produces a merge conflict that costs the whole stage.
- Never edit another task's spec, another front's directory, or \`${devPaths.state}\`.

${ctx.ns(devFindingsProtocol(epoch, null))}

=== YOUR DIFF IS REVIEWED BEFORE IT MERGES ===
When you finish, a separate reviewer reads \`git diff\` on your branch and checks the TDD contract: test files only, every test derived from a "Done when" line, and the red-phase proof you pasted. Blocking findings come straight back to you in this same session — and YOUR fix turns are the only place a test file may still change in this epoch.`,
      }
    : undefined;

  const work: PipelineStep = tdd
    ? {
        type: 'work',
        name: names.work,
        scope: 'memory',
        filesFrom: tasksPath,
        maxFiles: front.maxTasks,
        files: [],
        dependsOn: [chain[chain.length - 1]!],
        review: buildReviewSpec(front, ctx, 'implementation'),
        ...ctx.model('worker'),
        prompt: `${WORK_IMPLEMENTATION_BLOCK}

${ctx.ns(DEV_SKIP_RULE)}

${DEV_STEP_BOUNDARY}

You are one agent in a parallel swarm IMPLEMENTING the "${front.id}" front — the GREEN phase of TDD. Your ENTIRE assignment is the spec file \`$file\`.

Summary from the planner: $hint

=== PROCEDURE (make the tests green) ===
1. Read \`$file\` in full. It names the files you OWN and the criteria for done.
2. Read \`${devPaths.goal}\` for the overall goal, and \`${paths.atlas(epoch)}\` for the map of the codebase produced this epoch.
3. Find the tests the previous step wrote for this spec — they are already merged into your branch's base (\`git log --oneline $baseCommit..HEAD\` shows them; the atlas names the test layout). They are the spec made executable.
4. Write the SMALLEST implementation that turns every one of those tests green, in the files your spec lists under "Files this task OWNS".
5. RUN ${testCommandClause} at the end. Green is the bar for done — paste the passing output into your findings shard.

=== THE TEST FILES ARE FROZEN ===
Never modify, rename or delete a test file in this step. A test may only change through the critic loop's fix turns of the TESTS step — never here. If a test looks wrong, implement what the spec's "Done when" actually requires and record a \`"kind": "blocker"\` finding explaining the mismatch; do not "fix" the test to match your code.

=== OWNERSHIP (non-negotiable) ===
- Write ONLY the files your spec lists under "Files this task OWNS", plus YOUR OWN findings shard (named below).
- You may READ anything. Other agents are editing other files RIGHT NOW; touching a file you don't own produces a merge conflict that costs the whole stage.
- Never edit another task's spec, another front's directory, or \`${devPaths.state}\`.

${ctx.ns(devFindingsProtocol(epoch, null))}

=== YOUR DIFF IS REVIEWED BEFORE IT MERGES ===
When you finish, a separate reviewer reads \`git diff\` on your branch and checks the TDD contract: the test files are untouched, and the test command passes. Blocking findings come straight back to you in this same session.`,
      }
    : {
        type: 'work',
        name: names.work,
        scope: 'memory',
        filesFrom: tasksPath,
        maxFiles: front.maxTasks,
        files: [],
        dependsOn:
          chain.length > 0 ? [chain[chain.length - 1]!] : [names.recon, ...firstWorkExtraDeps],
        review: buildReviewSpec(front, ctx, stages.characterize ? 'implementation' : undefined),
        ...ctx.model('worker'),
        prompt: `${WORK_IMPLEMENTATION_BLOCK}

${ctx.ns(DEV_SKIP_RULE)}

${DEV_STEP_BOUNDARY}

${ctx.ns(taskWorkPreamble(epoch, front.id))}

=== FRONT BRIEF ===
${front.workPrompt}

${ctx.ns(devFindingsProtocol(epoch, null))}

=== YOUR DIFF IS REVIEWED BEFORE IT MERGES ===
When you finish, a separate reviewer reads \`git diff\` on your branch and judges it on three axes: correctness against your spec, this project's design patterns, and this project's code style — using \`${paths.atlas(epoch)}\` and the project's own conventions as the standard, not its own taste. Blocking findings come straight back to you in this same session, so aim the first pass at that standard: satisfy every "Done when" line, match the surrounding code, and leave no placeholder.`,
      };

  // Numbered from the ARRAY, never by hand: two methodologies that both append
  // a clause would otherwise collide on "5)" and the second one's number would
  // be a lie the judge is asked to cite back. Base clauses first, then one
  // block per enabled methodology in registry order.
  const verifyClauses = [
    front.verifyCondition,
    `Every task spec under \`${paths.frontDir(epoch, front.id)}/T-*.md\` has had its "Done when" list actually satisfied by the code now on disk — check them one by one, not by reading the specs alone.`,
    `\`git diff --name-only $baseCommit..HEAD\` shows no file written by this front that the repo's build or type-check now rejects. If the project has a build/type-check/test command, RUN it and treat a new failure as a fail.`,
    'No task left a placeholder, a TODO standing in for the work, or a stub that only pretends to satisfy its spec.',
  ];
  if (tdd) {
    verifyClauses.push(
      `The test files this front's tests step wrote are UNCHANGED since that step committed them — verify with git: \`git log --name-only --oneline $baseCommit..HEAD\` must show no implementation-step commit touching a test path (the atlas names this project's test layout). An implementation step that edited a test file is a fail.`,
      'Every implementation file this front added in `git diff --name-only $baseCommit..HEAD` has a corresponding test. Name any untested implementation file — it is a fail.',
    );
  }
  if (stages.characterize) {
    verifyClauses.push(
      `The snapshot files this front's characterization step committed are UNCHANGED since that step, unless an explicit approval accompanies the change. Verify with git: \`git log --name-only --oneline $baseCommit..HEAD\` must show no implementation-step commit rewriting a snapshot without an approval file (or the project's own approve/accept marker) in the SAME commit. A silently rewritten snapshot is a behavior change nobody signed — that is a fail, not a detail.`,
    );
  }
  if (ctx.opts.methodology?.writeSet === true) {
    verifyClauses.push(
      `Every file this front committed is covered by the "Files this task OWNS" section of the spec that committed it. Map commits to specs with \`git log --name-only --oneline $baseCommit..HEAD\`, then subtract each \`${paths.frontDir(epoch, front.id)}/T-*.md\`'s ownership list (a directory entry covers everything under it; \`.huu/\`, \`.huu-*\` and \`.env.huu\` never count — agents write those by instruction). Name every source file left over: an undeclared write is a fail even when the code is correct, because it is what collides with a parallel front at merge time.`,
    );
  }

  const verify: PipelineStep = {
    type: 'check',
    name: names.verify,
    dependsOn: [names.work],
    maxRuns: FRONT_JUDGE_MAX_RUNS,
    ...ctx.model('judge'),
    condition: `You are judging the "${front.id}" front of epoch ${epoch} in the integration worktree, with shell access. Gather EVIDENCE before answering — read files, run the project's own build/test commands where they exist.

Verify ALL of:
${verifyClauses.map((clause, i) => `${i + 1}) ${clause}`).join('\n')}

This is run $runs of this check. If every clause holds, answer "approved". If any fails, answer "rework" and name precisely which task, which clause, and what is missing — that text is the only thing the retry agents receive.

${COORDINATOR_RULES}`,
    outcomes: [
      // default MUST be the forward/safe path: it fires on judge failure,
      // unknown label and the maxRuns cap.
      { label: 'approved', nextStepName: consolidateName, default: true },
      { label: 'rework', nextStepName: names.work },
    ],
  };

  return [...(characterize ? [characterize] : []), ...(tests ? [tests] : []), work, verify];
}

/** The work step of the plan-validation pair (`planReview`). Unnumbered: it is inserted between the recon block and the fan-out, and the tail already owns the `N+1`…`N+3` numbers. */
function planReviewStepName(): string {
  return 'Revisar as escolhas';
}

/** The check of the plan-validation pair — the fan-out may not start before it routes. */
function planCheckStepName(): string {
  return 'Plano validado?';
}

/**
 * The `planReview` auditor (D4 of the design): one agent that reads the
 * atlas, the goal and EVERY task spec the recons just wrote, and audits the
 * choices BEFORE the fan-out. Its headline clause is the DECLARED write-set
 * disjointness check across all specs — the mechanical partition proof the
 * driver lost when the declared-partition check moved out of the driver.
 * Findings land in the epoch's shared-memory tree, where the epoch gate's
 * existing findings clause already reads them.
 */
function buildPlanReviewStep(ctx: CompileCtx, reconNames: string[]): PipelineStep {
  const { epoch, goal } = ctx.opts;
  const paths = ctx.paths;
  const plan = ctx.opts.plan;
  const taskLists = plan.fronts.map((f) => `\`${paths.frontTasks(epoch, f.id)}\``).join(', ');
  const specDirs = plan.fronts.map((f) => `\`${paths.frontDir(epoch, f.id)}/T-*.md\``).join(', ');
  return {
    type: 'work',
    name: planReviewStepName(),
    scope: 'project',
    files: [],
    dependsOn: [...reconNames],
    ...ctx.model('judge'),
    prompt: `You are the plan auditor for epoch ${epoch} of a huu development run. Every front has just been split into task specs and NO implementation has started — you are the last review before the fan-out. ONE cognitive op: audit the choices. You do NOT implement anything.

=== THE GOAL (written by the human, never reinterpret it) ===
${goal}

=== THIS EPOCH ===
${plan.epochGoal}

=== READ FIRST (all of it, before any verdict) ===
- \`${paths.atlas(epoch)}\` — the epoch atlas: stack, conventions, landmines, per-front file map.
- \`${devPaths.goal}\` — the goal, verbatim.
- The epoch plan as materialized on the blackboard: every front's task list (${taskLists}) and EVERY spec it names (${specDirs}). Read them all, not a sample.

=== WHAT YOU AUDIT ===
1. COVERAGE — do the specs, taken together, deliver the epoch goal? Name anything missing, with the front it belongs to.
2. DECLARED WRITE-SET DISJOINTNESS — every spec declares "Files this task OWNS". Build the union ACROSS ALL fronts and report every file owned by more than one spec: parallel agents merge deterministically, so two specs owning the same file is a guaranteed merge conflict. Compare the DECLARED ownership lists, never your guess of what a task will touch.
3. FEASIBILITY — does any spec demand something the atlas says does not exist (a command, a file, an API)? Cite the spec line and the atlas line.
4. CRITERIA — is every "Done when" checkable by a command or a file read? A vague criterion ("works correctly") hands the per-task critic nothing to check.

=== WHAT YOU WRITE ===
- \`${paths.epochDir(epoch)}/plan-review.md\` — your verdict per front (approved / rework) with the findings behind it, one section per audit item above.
- \`${paths.findings(epoch, 'plan-review')}\` — your findings shard, a JSON array of entries in this shape:
  ${DEV_FINDINGS_SCHEMA_LINE}
  Use \`"front": "plan-review"\`. Every disjointness violation and every coverage gap is a \`"kind": "blocker"\`. The epoch gate reads this shard — a finding left out of it never happened.

=== HARD RULES ===
- Report, never fix. Do NOT edit specs, the atlas, or any source — a plan defect goes back through the rework loop.
- Ground every verdict in a spec, the atlas or the goal. A concern you cannot point at is a \`"kind": "risk"\` note, never a blocker.
- Anti-nitpick: this audit exists to catch STRUCTURAL defects (conflicts, gaps, impossible specs), not to re-plan. A plan merely sliced differently from how you would have sliced it is APPROVED.

${ctx.ns(DEV_SKIP_RULE)}`,
  };
}

/**
 * The `planReview` gate. `approved` points FORWARD at the fan-out and is the
 * default, so the maxRuns cap forwards with the findings recorded — never an
 * infinite loop. `rework` loops back to the global recon, whose activation
 * cone re-pends every spec, the audit and this check itself.
 */
function buildPlanCheckStep(ctx: CompileCtx, forwardName: string): PipelineStep {
  const { epoch } = ctx.opts;
  const paths = ctx.paths;
  return {
    type: 'check',
    name: planCheckStepName(),
    dependsOn: [planReviewStepName()],
    maxRuns: EPOCH_GATE_MAX_RUNS,
    ...ctx.model('judge'),
    condition: `You are the plan gate for epoch ${epoch}, running in the integration worktree with shell access. A plan auditor has reviewed every front's task specs; you decide whether the swarm may start.

Read \`${paths.epochDir(epoch)}/plan-review.md\` and the shard \`${paths.findings(epoch, 'plan-review')}\`, then verify ALL of:
1) The review EXISTS and covers every front of this epoch — an absent or half-written review is not an approval.
2) The declared write-set disjointness check was actually performed ACROSS ALL fronts' specs — the review either lists the collisions it found or states the union is disjoint. This is the clause that keeps two parallel agents from owning the same file.
3) Every \`"kind": "blocker"\` finding in the shard comes with a verdict that says WHAT must change — a blocker nobody can act on is a fail; name it.

This is run $runs of this gate. If every clause holds, answer "approved". If any fails, answer "rework" and state precisely what the plan must fix — that text sends the epoch back to the recon agents, and they re-split from it.

${COORDINATOR_RULES}`,
    outcomes: [
      // default MUST be the forward/safe path: it fires on judge failure,
      // unknown label and the maxRuns cap — the run continues WITH the
      // auditor's findings recorded, never in a loop.
      { label: 'approved', nextStepName: forwardName, default: true },
      { label: 'rework', nextStepName: reconStepName() },
    ],
  };
}

/**
 * The traceability pair (`traceability`). Unnumbered for the same reason the
 * plan-review pair is: it is inserted into the tail, and the tail already owns
 * the `N+1`…`N+3` numbers.
 */
function traceStepName(): string {
  return 'Mapear rastreabilidade';
}

function traceCheckStepName(): string {
  return 'Rastreabilidade completa?';
}

/**
 * The matrix step: one agent, one cognitive op, one artefact.
 *
 * It runs AFTER the consolidation because it needs the merged tree — the whole
 * point is to compare what was PROMISED across every front against what landed
 * — and BEFORE the epoch gate, so an epoch with orphans is caught while the
 * gate's rework loop can still act on it.
 *
 * Both directions matter and they catch different failures. Forward
 * (criterion → evidence) catches the criterion nobody delivered. Backward
 * (delivered file → criterion) catches scope nobody asked for, which in an
 * agent swarm is the more common defect and the one no other check here sees.
 */
function buildTraceabilityStep(ctx: CompileCtx, frontIds: readonly string[]): PipelineStep {
  const { epoch } = ctx.opts;
  const paths = ctx.paths;
  const specDirs = frontIds.map((id) => `\`${paths.frontDir(epoch, id)}/T-*.md\``).join(', ');
  return {
    type: 'work',
    name: traceStepName(),
    scope: 'project',
    files: [],
    dependsOn: [`${frontIds.length + 1}. Consolidar época ${epoch}`],
    produces: `${paths.epochDir(epoch)}/traceability.md`,
    ...ctx.model('judge'),
    prompt: `You are building the TRACEABILITY MATRIX for epoch ${epoch} of a huu development run, in the integration worktree where every front has already merged. ONE cognitive op: map promises to evidence, both ways. You implement NOTHING and you fix NOTHING.

=== THE GOAL (written by the human, never reinterpret it) ===
${ctx.opts.goal}

=== READ ===
- every task spec of this epoch: ${specDirs} — each one's "Done when" list is a set of PROMISES;
- the merged tree: \`git diff --name-only $baseCommit..HEAD\` is what was DELIVERED;
- \`${paths.epochReport(epoch)}\` — the consolidation's own account of the epoch.

=== WRITE \`${paths.epochDir(epoch)}/traceability.md\` ===
A table with one row per "Done when" criterion, across every front:

\`\`\`markdown
| spec | criterion | settled by | how |
| --- | --- | --- | --- |
| T-001 | rejects an empty id | src/parse.test.ts:42 | test asserts the throw |
| T-002 | the flag is documented | — | ORPHAN: nothing delivered settles this |
\`\`\`

Then a second table, the REVERSE direction — one row per source file the diff touched:

\`\`\`markdown
| file | criterion it serves |
| --- | --- |
| src/parse.ts | T-001 "rejects an empty id" |
| src/telemetry.ts | ORPHAN: no criterion asked for this |
\`\`\`

Close with \`## Órfãos\`: every \`ORPHAN\` row from either table, one line each, or the literal line \`Nenhum órfão.\` when both are clean.

=== HOW TO SETTLE A ROW ===
- "settled by" is a \`file:line\` or a command you RAN with its exit code — never a paragraph of reasoning. If you cannot point at one, the row is an ORPHAN and saying so is the correct answer.
- huu's own scratch tree (\`${paths.epochDir(epoch)}/\`, findings shards, task specs) is not delivered work. Leave it out of the reverse table entirely.
- A file changed only to satisfy a build (a lockfile, a generated artefact, an index re-export) serves whatever criterion caused it — say which, do not mark it orphan.

=== HARD RULES ===
- Write ONLY \`${paths.epochDir(epoch)}/traceability.md\`. Change no source.
- Do not repair an orphan by widening a criterion or by inventing one. Reporting it IS the job — the gate after you is what decides.`,
  };
}

/**
 * The traceability gate. `rework` goes back to the MATRIX step, not to the
 * consolidation: what a rejected matrix needs is a better matrix, and sending
 * the epoch back to rewrite its report would loop on the wrong artefact.
 */
function buildTraceabilityCheckStep(ctx: CompileCtx, forwardName: string): PipelineStep {
  const { epoch } = ctx.opts;
  const paths = ctx.paths;
  return {
    type: 'check',
    name: traceCheckStepName(),
    dependsOn: [traceStepName()],
    maxRuns: EPOCH_GATE_MAX_RUNS,
    ...ctx.model('judge'),
    condition: `You are the traceability gate for epoch ${epoch}, in the integration worktree with shell access.

Verify ALL of:
1) \`${paths.epochDir(epoch)}/traceability.md\` exists and carries BOTH tables plus a \`## Órfãos\` section.
2) Every "Done when" criterion in every task spec of this epoch appears as a row in the forward table — spot-check at least one spec by reading it, do not trust the matrix's own count.
3) Every "settled by" cell is a \`file:line\` or a command with an exit code, and the file it names EXISTS in this tree. A cell holding prose instead of a pointer counts as an orphan that was not declared.
4) The \`## Órfãos\` section lists every ORPHAN row from both tables — no orphan is silently dropped between the tables and the summary.

An epoch with DECLARED orphans still passes this gate: the matrix's job is to make them visible to the next epoch's planner, not to hide them. What fails is a matrix that is incomplete, unsourced, or inconsistent with itself.

This is run $runs of this gate. If every clause holds, answer "approved". If any fails, answer "rework" and name the clause and the row.

${COORDINATOR_RULES}`,
    outcomes: [
      { label: 'approved', nextStepName: forwardName, default: true },
      { label: 'rework', nextStepName: traceStepName() },
    ],
  };
}

/**
 * Assemble `Pipeline.mergeGate` — the deterministic pre-merge check the
 * executor runs after EVERY agent-branch merge, rewinding the merge commit on
 * a non-zero exit.
 *
 * There is ONE such field and several methodologies want it, so this is an
 * ACCUMULATOR, not an assignment: each enabled gate contributes its commands
 * and the survivors are chained with ` && `. A single `pipeline.mergeGate = …`
 * per option would mean the last option compiled silently erases the ones
 * before it — a gate that vanishes without an error is worse than no gate.
 *
 * Registry order is the run order, and it is deliberate: the cheapest, most
 * local checks fail first so an expensive one never runs to tell you what a
 * lint error already knew.
 *
 * A gate that is ON but whose commands huu could not extract is OMITTED with a
 * warning. huu never invents a command: a fabricated gate either passes
 * vacuously or fails every merge for a reason nobody can act on.
 */
function collectMergeGate(opts: CompileEpochOptions, warnings: string[]): string | undefined {
  const parts: string[] = [];

  if (opts.methodology?.lintGate === true) {
    // Only the classified lint/typecheck subset qualifies — the fast static
    // checks. This runs per merge, so a full build or test suite here would
    // multiply the epoch's wall clock by the number of tasks.
    const lintCommands = (opts.lintCommands ?? []).map((c) => c.trim()).filter((c) => c.length > 0);
    if (lintCommands.length > 0) {
      parts.push(...lintCommands);
    } else {
      warnings.push(
        'lintGate is on but no lint/typecheck commands were extracted for this epoch — mergeGate omitted rather than invented',
      );
    }
  }

  if (opts.methodology?.fitnessFunctions === true) {
    // Before the commit checks and after lint: it is a static analysis of the
    // merged tree, so it wants the tree to type-check first, and it is far
    // cheaper than discovering a broken boundary in the next epoch.
    const fitnessCommands = (opts.fitnessCommands ?? [])
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    if (fitnessCommands.length > 0) {
      parts.push(...fitnessCommands);
    } else {
      warnings.push(
        'fitnessFunctions is on but this project reported no executable architecture check — the critic rubric still applies, but no merge gate was invented',
      );
    }
  }

  if (opts.methodology?.changelogGate === true) {
    // Universal by construction: Conventional Commits is a FORMAT, so this
    // needs no project tooling and no discovered command — just git and a
    // regex. `HEAD^..HEAD` is exactly the merged branch's own commits after a
    // --no-ff merge (the second parent's side), and the merge commit itself is
    // dropped by `--no-merges` since huu, not the agent, authored it.
    // A repo state with no `HEAD^` makes `git log` print nothing, so the check
    // passes rather than exploding — a gate must never fail for lack of input.
    //
    // Subjects starting with `[` are SKIPPED, and that exclusion is what makes
    // this gate usable at all. When an agent leaves changes uncommitted, huu
    // commits them itself as `[<pipeline name>] <step> (agent N)`
    // (`finalize.ts`) — a subject the agent never wrote. Judging it would hold
    // the agent to huu's own formatting and, since that path is common, reject
    // essentially every branch. An end-to-end stub run failed exactly this way
    // before the exclusion existed. No Conventional Commit subject begins with
    // `[`, so nothing real is lost.
    parts.push(
      `( bad=$(git log --no-merges --format=%s HEAD^..HEAD 2>/dev/null | grep -v '^\\[' | grep -vE '^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\\([^)]+\\))?!?: .+' || true); [ -z "$bad" ] || { printf 'changelogGate: commit subject is not a Conventional Commit (type(scope)!: description):\\n%s\\n' "$bad" >&2; exit 1; } )`,
    );
  }

  if (opts.methodology?.diffBudget === true) {
    // Counting is git's job, not a discovered command's: `--numstat` over the
    // merged branch's own commits, with huu's scratch tree excluded BY GIT
    // (a pathspec, not a grep — paths with spaces break a grep and would
    // silently under-count). awk reads the two leading numeric columns, so a
    // path containing whitespace cannot shift them; a binary file reports `-`
    // and counts as zero lines but still as a file. `END` always prints two
    // numbers, so an empty range degrades to `0 0` and PASSES.
    parts.push(
      `( set -- $(git diff --numstat HEAD^..HEAD -- . ':(exclude).huu' ':(exclude).huu-*' ':(exclude).env.huu' 2>/dev/null | awk '{ a=($1=="-"?0:$1); d=($2=="-"?0:$2); L+=a+d; F+=1 } END { print L+0, F+0 }'); [ "$1" -le ${DIFF_BUDGET_LINES} ] && [ "$2" -le ${DIFF_BUDGET_FILES} ] || { printf 'diffBudget: %s changed line(s) across %s file(s) exceeds the budget of ${DIFF_BUDGET_LINES} line(s) and ${DIFF_BUDGET_FILES} file(s) per task — split it.\\n' "$1" "$2" >&2; exit 1; } )`,
    );
  }

  return parts.length > 0 ? parts.join(' && ') : undefined;
}

/**
 * Compile one epoch of a {@link DevPlan} into a validated {@link Pipeline}.
 *
 * Throws only when the compiler itself produced an invalid graph (a bug,
 * covered by `plan-to-pipeline.test.ts`); every recoverable defect in the
 * plan is repaired and reported through `warnings`.
 */
export function compileEpochPipeline(opts: CompileEpochOptions): CompiledEpoch {
  const { plan, epoch } = opts;
  const warnings: string[] = [];

  if (plan.fronts.length === 0) {
    throw new Error(
      `dev mode: epoch ${epoch} plan has no fronts — the driver must stop the session instead of compiling an empty epoch`,
    );
  }

  const frontCap = Math.min(Math.max(1, opts.maxFronts ?? DEV_MAX_FRONTS), DEV_MAX_FRONTS);
  let fronts = plan.fronts;
  if (fronts.length > frontCap) {
    warnings.push(
      `plan listed ${fronts.length} fronts — truncated to ${frontCap} (plan order); the rest can run in the next epoch`,
    );
    fronts = fronts.slice(0, frontCap);
  }

  const seenIds = new Set<string>();
  const deduped: DevFront[] = [];
  for (const front of fronts) {
    if (seenIds.has(front.id)) {
      warnings.push(`dropped duplicate front id "${front.id}"`);
      continue;
    }
    seenIds.add(front.id);
    deduped.push(front);
  }

  const sorted = sortFronts(deduped);
  warnings.push(...sorted.warnings);

  const n = sorted.order.length;
  const consolidateName = `${n + 1}. Consolidar época ${epoch}`;
  const gateName = `${n + 2}. Portão de qualidade`;
  const sealName = `${n + 3}. Selar época ${epoch}`;

  const frontSummary = sorted.order
    .map((f) => `- **${f.id}** (${f.title}): ${f.rationale}`)
    .join('\n');

  const ctx: CompileCtx = {
    opts: { ...opts, plan: { ...plan, fronts: sorted.order } },
    paths: resolvePaths(opts.sessionId),
    ns: makeNamespacer(epoch, opts.sessionId),
    model: makeModelStamper(opts.models),
  };
  const paths = ctx.paths;

  const steps: PipelineStep[] = [buildReconStep(ctx, frontSummary)];

  const stages = frontStages(opts.methodology);
  const tdd = stages.tdd;
  const planReview = opts.methodology?.planReview === true;

  // Index of each front's judge, so a dependent front can wait on it.
  const verifyNameById = new Map<string, string>();
  sorted.order.forEach((front, i) => {
    verifyNameById.set(front.id, frontStepNames(i, front.title, stages).verify);
  });

  const depVerifyNamesOf = (front: DevFront): string[] =>
    sorted
      .deps.get(front.id)!
      .map((d) => verifyNameById.get(d)!)
      .filter(Boolean);

  if (!planReview) {
    sorted.order.forEach((front, i) => {
      steps.push(buildFrontReconStep(front, i, ctx, depVerifyNamesOf(front)));
      steps.push(...buildFrontWorkSteps(front, i, ctx, consolidateName, []));
    });
  } else {
    // The plan gate sits between the LAST recon it can audit and the FIRST
    // work step. A front with no (repaired) front dependencies recons in the
    // first wave and gets audited. A DEPENDENT front's recon waits on its
    // deps' judges — steps that only exist after the fan-out — so it is
    // emitted beside its own work steps instead, and gated TRANSITIVELY: its
    // recon's deps trace back to a first-wave work step, which itself waits
    // on the check. Wiring it any other way would make the check wait on a
    // step that waits on the check.
    const firstWave = new Set(
      sorted.order.filter((f) => sorted.deps.get(f.id)!.length === 0).map((f) => f.id),
    );

    const firstReconNames: string[] = [];
    sorted.order.forEach((front, i) => {
      if (!firstWave.has(front.id)) return;
      const recon = buildFrontReconStep(front, i, ctx, []);
      firstReconNames.push(recon.name);
      steps.push(recon);
    });

    // `approved` aims at the first step of the fan-out block — the activation
    // is a no-op on the happy path (the step is already pending) and the
    // correct re-entry after a rework loop.
    const firstFrontNames = frontStepNames(0, sorted.order[0]!.title, stages);
    const forwardName = firstWave.has(sorted.order[0]!.id)
      ? (firstFrontNames.tests ?? firstFrontNames.work)
      : firstFrontNames.recon;
    steps.push(buildPlanReviewStep(ctx, firstReconNames));
    steps.push(buildPlanCheckStep(ctx, forwardName));

    sorted.order.forEach((front, i) => {
      if (firstWave.has(front.id)) {
        steps.push(...buildFrontWorkSteps(front, i, ctx, consolidateName, [planCheckStepName()]));
      } else {
        steps.push(buildFrontReconStep(front, i, ctx, depVerifyNamesOf(front)));
        steps.push(...buildFrontWorkSteps(front, i, ctx, consolidateName, []));
      }
    });
  }

  const allVerifyNames = sorted.order.map((f, i) => frontStepNames(i, f.title, stages).verify);

  steps.push({
    type: 'work',
    name: consolidateName,
    scope: 'project',
    files: [],
    dependsOn: allVerifyNames,
    ...ctx.model('reporter'),
    prompt: `You are closing epoch ${epoch} of a huu development run. Every front has merged into this worktree. ONE cognitive op: write the epoch report. You do NOT implement anything new.

=== THE GOAL (written by the human) ===
${opts.goal}

=== THIS EPOCH AIMED AT ===
${plan.epochGoal}

=== THE OVERALL GOAL IS DONE WHEN ===
${plan.doneWhen}

=== WRITE THE REPORT ===
Write \`${paths.epochReport(epoch)}\` with exactly these sections:
- **## Entregue** — what this epoch actually changed, per front, with repo-relative paths. Read the diff (\`git diff --stat $baseCommit..HEAD\`), do not trust the specs.
- **## Verificação** — for each front, the project's own build/test/type-check commands you ran and their real result. If a command does not exist here, say so; never invent one.
- **## Pendências** — every \`"kind": "blocker"\` finding from EVERY \`*.json\` under \`${paths.findingsDir(epoch)}/\` (each file is one agent's shard; read them all), plus every finding waived at the review cap in \`*.json\` under each front's \`review/\` directory (each of those files carries \`"waived": true\` and the findings that were still open), plus anything the diff shows as half-finished. One line each, with the file.
- **## Próximo passo** — the single most valuable thing the NEXT epoch should do, and why. If the goal's "done when" is already satisfied, say that instead and justify it against the diff.

=== HARD RULES ===
- Write ONLY under \`${paths.epochDir(epoch)}/\`. Change no source, fix nothing — reporting a defect is your job, fixing it is the next epoch's.
- Every claim must be grounded in the diff, a file you read, or a command you ran. No optimistic summaries.`,
  });

  // The traceability pair sits BETWEEN the consolidation and the epoch gate:
  // it needs the merged tree the consolidation just described, and an epoch
  // with an undeclared orphan has to be caught while the gate's rework loop
  // can still act on it.
  const traceability = opts.methodology?.traceability === true;
  if (traceability) {
    steps.push(buildTraceabilityStep(ctx, sorted.order.map((f) => f.id)));
    steps.push(buildTraceabilityCheckStep(ctx, gateName));
  }

  steps.push({
    type: 'check',
    name: gateName,
    // Naming the traceability check keeps the gate downstream of it. The
    // consolidation stays in the list either way: the gate's own clauses read
    // the epoch report, and an edge you can point at beats a transitive one.
    dependsOn: traceability ? [consolidateName, traceCheckStepName()] : [consolidateName],
    maxRuns: EPOCH_GATE_MAX_RUNS,
    ...ctx.model('judge'),
    condition: `You are the epoch gate for epoch ${epoch}, running in the integration worktree with shell access. Gather evidence before answering.

Verify ALL of:
1) \`${paths.epochReport(epoch)}\` exists and every required section (## Entregue, ## Verificação, ## Pendências, ## Próximo passo) is present with real content — no placeholders, no "TODO", no "(preenchido depois)".
2) The paths cited under "## Entregue" actually appear in \`git diff --name-only $baseCommit..HEAD\`.
3) "## Verificação" reports commands that EXIST in this project, and its stated results match what you get when you re-run the cheapest one yourself.
4) every \`*.json\` under \`${paths.findingsDir(epoch)}/\` parses as a JSON array, and every blocker recorded across them appears under "## Pendências".

This is run $runs of this gate. If every clause holds, answer "approved". If any fails, answer "rework" and state exactly which clause and why.

${COORDINATOR_RULES}`,
    outcomes: [
      { label: 'approved', nextStepName: sealName, default: true },
      { label: 'rework', nextStepName: consolidateName },
    ],
  });

  steps.push({
    type: 'work',
    name: sealName,
    scope: 'project',
    files: [],
    dependsOn: [gateName],
    ...ctx.model('reporter'),
    prompt: `Seal epoch ${epoch}. ONE cognitive op: append the epoch's entry to the run journal. Nothing else.

Append to \`${devPaths.journal}\` (create it with the heading \`# Dev mode — journal\` if missing) a section:

\`\`\`markdown
## Epoch ${epoch} — ${plan.epochGoal.replace(/\n/g, ' ')}
- Fronts: ${sorted.order.map((f) => f.id).join(', ')}
- Entregue: <one line per front, drawn from ${paths.epochReport(epoch)}>
- Pendências: <one line each, or "nenhuma">
- Próximo passo: <verbatim from the report>
\`\`\`

=== HARD RULES ===
- APPEND only. Never rewrite or delete an earlier epoch's section.
- Write ONLY \`${devPaths.journal}\`. Change no source, and do not touch \`${devPaths.state}\` — huu owns that file.`,
  });

  // The ninth stamping point: the merge-conflict resolver. Same omit-when-unset
  // rule — `Pipeline.integrationModelId` already falls back to `AppConfig`.
  const integrationModelId = ctx.model('integration').modelId;

  // Apply the router prefix to every agent prompt when the project has skills.
  if (opts.routerPrefix) {
    for (const step of steps) {
      if ('prompt' in step && typeof step.prompt === 'string') {
        (step as { prompt: string }).prompt = prefixPrompt(step.prompt, opts.routerPrefix);
      }
    }
  }

  const pipeline: Pipeline = {
    name: `huu Dev — época ${epoch}`,
    description: `Época ${epoch}: ${plan.epochGoal}`.slice(0, 280),
    steps,
    maxNodeExecutions: EPOCH_MAX_NODE_EXECUTIONS,
    ...(opts.cardTimeoutMs !== undefined ? { cardTimeoutMs: opts.cardTimeoutMs } : {}),
    ...(opts.singleFileCardTimeoutMs !== undefined
      ? { singleFileCardTimeoutMs: opts.singleFileCardTimeoutMs }
      : {}),
    ...(integrationModelId ? { integrationModelId } : {}),
  };

  const mergeGate = collectMergeGate(opts, warnings);
  if (mergeGate) pipeline.mergeGate = mergeGate;

  // The critic-side halves that need a surface huu could not find. The option
  // still does its deterministic half; only the rubric is dropped, and saying
  // so beats a silently weaker review.
  if (
    opts.methodology?.changelogGate === true &&
    (opts.changelogPaths ?? []).filter((p) => p.trim().length > 0).length === 0
  ) {
    warnings.push(
      'changelogGate is on but this project has no changelog surface (.changes/, changelog.d/, .changeset/, CHANGELOG.md) — only the commit-subject gate applies',
    );
  }

  // The real gate: the exact schema + topology a run performs at load time.
  // A failure here is a compiler bug, not bad input — the plan has already
  // been repaired above.
  const parsed = PipelineSchema.safeParse(pipeline);
  if (!parsed.success) {
    throw new Error(
      `dev mode: compiled epoch ${epoch} is not a valid pipeline (this is a huu bug): ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }

  return { pipeline, frontOrder: sorted.order.map((f) => f.id), warnings };
}

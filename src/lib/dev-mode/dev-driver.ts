// `runDevMode` — the development-mode driver.
//
// Dev mode is the one huu flow whose step graph is written at run time. The
// driver is what makes that safe: it never lets a planner decide anything
// structural. The sequence per session is fixed, and a human wrote the goal.
//
//   Session   resume or start fresh, then report integration branches an
//             earlier session left behind.
//   Phase 0   knowledge gate — probe the repo for agent skills; if it has
//             none, run a jcode agent (deepseek) with the knowledge-
//             skills-architect prompt to bootstrap them.
//   Phase 1..N  epochs. An epoch is TWO runs, not one, because the plan can
//             only exist after the knowledge arrived:
//
//               A. KNOWLEDGE (run #1, a FIXED pipeline nobody plans)
//                  The blind orchestrator declares what it needs to know;
//                  huu materializes one real spec file per gap, COMMITS them,
//                  and a fan-out of agents with a shell answers them into one
//                  consolidated digest.
//               B. PLAN (no run)
//                  The same orchestrator plans the epoch against that digest —
//                  the only thing about this repository it ever reads — and
//                  the compiled graph is persisted as a portable artefact.
//               C. EXECUTION (run #2, the planned pipeline)
//                  → land → collect structured evidence → replan.
//
//             Zero gaps ⇒ Phase A is skipped and the epoch is one run, exactly
//             as it has always been.
//
//   THE GRAPH PATH (`dev.graph` / `dev.graphId`)
//             When the human hands over a DRAWN method, Phases A and B do not
//             happen at all: there is no plan to write and nobody to brief,
//             because the topology IS the drawing. `compileGraphPipeline` turns
//             it into the same `huu-pipeline-v2` the planner path emits, and
//             Phase C runs it — same landing merge, same evidence, same
//             blackboard. The session is ONE epoch, always: replanning is what
//             epochs exist for, and a graph has nothing to replan.
//
//             This is the branch that puts dev mode back inside MANIFESTO
//             differential #2 ("nenhum planner LLM decide em runtime o que o
//             passo 3 deve fazer"). `docs/dev-mode.md` opens by admitting the
//             planner path contradicts it; the graph path does not — the human
//             underwrites the method, the model supplies the intelligence
//             inside each node, and nothing here can add a node nobody drew.
//
//             PHASE 0 STILL RUNS. Only A and B are gone. A graph session on a
//             repo with no agent skills bootstraps them first, exactly like a
//             planner session — one jcode agent, real files, committed before the
//             drawing compiles — because the node prompts only get the
//             project-router prefix when the knowledge probe says it is there.
//
// Layering note: like `run-many.ts`, this module lives in `lib/` yet imports
// `orchestrator/` — the established exception for run DRIVERS. Everything
// below it (the planner, the compilers, the protocol blocks) stays pure.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Orchestrator } from '../../orchestrator/index.js';
import { GitClient } from '../../git/git-client.js';
import type { AgentFactory } from '../../orchestrator/types.js';
import type { LlmClientContext } from '../llm-client-factory.js';
import { resolveRunProvider } from '../providers.js';
import { detectKnowledge, type KnowledgeStatus } from '../knowledge-detect.js';
import { generateRunId } from '../run-id.js';
import type {
  AppConfig,
  DevEpochRecord,
  DevFront,
  DevModeConfig,
  DevPlan,
  DevState,
  DevVerifyCommands,
  OrchestratorState,
  Pipeline,
} from '../types.js';
import {
  DEFAULT_MEMORY_MAX_FILES,
  DEV_MAX_FRONTS,
  DEV_MAX_GAPS,
  DEV_UNBOUNDED_EPOCH_BACKSTOP,
} from '../types.js';
import { compileEpochPipeline } from './plan-to-pipeline.js';
import { compileGraphPipeline, type CompiledGraph } from '../dev-graph/graph-to-pipeline.js';
import { readGraph } from '../dev-graph/graph-store.js';
import { sanitizeNodeId } from '../dev-graph/research-contract.js';
import { effectiveDependencies, validateGraph } from '../dev-graph/graph-validate.js';
import {
  isActionNode,
  isGateNode,
  isPromptNode,
  isResearchNode,
  type DevGraph,
  type GraphNode,
} from '../dev-graph/graph-types.js';
import { detectChangelogPaths } from './changelog-surface.js';
import { PipelineSchema } from '../pipeline-io.js';
import { checkWritePartition, formatWritePartitionViolations, type TaskSpec } from './write-partition.js';
import { compileKnowledgePipeline } from './knowledge-to-pipeline.js';
import { landEpoch, type LandEpochResult } from './epoch-landing.js';
import { devPaths, devSessionPaths, ROUTER_PREFIX, type DevSessionPaths } from './dev-protocol.js';
import { devModelProviderIndex } from './model-catalog-index.js';
import {
  checkDevModelPolicy,
  collapseDevModelPolicy,
  devModelRefusals,
  formatDevModelIssues,
  modelKnownFor,
  pickModelRoute,
  resolveDevModels,
} from './dev-model-policy.js';
import type { KnowledgeGap, KnowledgeRequest } from './knowledge-schema.js';
import {
  FITNESS_COMMANDS_GAP,
  KNOWLEDGE_DIGEST_MAX_CHARS,
  assembleAccumulatedKnowledge,
  extractVerifyCommands,
  flattenVerifyCommands,
  mergeBaselineGaps,
  readAccumulatedBriefs,
  readKnowledgeDigest,
  writeKnowledgeGaps,
} from './knowledge-blackboard.js';
import {
  MAX_VIOLATION_TASKS,
  collectEpochEvidence,
  formatInstrumentationLine,
  readLandedDiffStat,
} from './epoch-evidence.js';
import { findOrphanIntegrationBranches, type OrphanBranch } from './orphan-branches.js';
import {
  planEpoch,
  planKnowledge,
  type PlanEpochOptions,
  type PlanKnowledgeOptions,
} from './planner.js';
import {
  DEV_STATE_FORMAT,
  commitBlackboard,
  foreignDirtyPaths,
  readDevState,
  readEpochReport,
  writeDevState,
  writeGoalFile,
} from './dev-state.js';

/** Why the session stopped. Every exit takes exactly one of these. */
export type DevStopReason =
  | 'goal-complete'
  | 'max-epochs'
  | 'plan-rejected'
  | 'planner-failed'
  | 'empty-plan'
  | 'run-failed'
  | 'landing-failed'
  | 'consecutive-failures'
  | 'cost-ceiling'
  | 'graceful-stop'
  | 'bootstrap-failed'
  | 'knowledge-failed'
  | 'model-preflight-failed'
  | 'dirty-tree'
  /**
   * `dev.graphId` names no readable graph under `.huu/dev/graphs/`. A session
   * that cannot find the method it was told to run must not fall back to the
   * PLANNER — that would silently swap the human's method for a model's.
   */
  | 'graph-not-found'
  /**
   * The drawn method does not compile: `validateGraph` reported blocking
   * issues, the stored file is not a `huu-devgraph-v1`, or the compiler itself
   * refused the output. Same rule as above — never a fallback, always a stop.
   */
  | 'graph-invalid'
  /**
   * The SESSION asked for something a graph cannot honor: `maxEpochs ≥ 2`
   * (a graph is the complete method, so it is exactly one epoch), or a
   * `graph`/`graphId` pair naming two different methods. Refused out loud
   * instead of quietly picking one.
   */
  | 'graph-conflict'
  /**
   * The session being RESUMED was a drawn method (`DevState.drawnMethod`) and
   * the caller did not re-supply the drawing. It is not a missing file — it is
   * a missing ARGUMENT, and the only two things the driver could do without it
   * are both wrong: run the LLM planner inside a session a human opened as a
   * drawing (silently swapping their method for a model's), or start a fresh
   * session under the same goal and orphan the epochs already recorded. So it
   * refuses and names the graph the session needs back.
   */
  | 'graph-missing-on-resume'
  | 'aborted';

/**
 * Consecutive FAILED epochs the driver tolerates before stopping the session
 * (`'consecutive-failures'`). One bad epoch is often just a bad epoch — its
 * partial work lands and the next planner sees it on disk — but this many in
 * a row is a failure that is not recovering, and an unattended session must
 * not retry it forever. The shape of Claude Code's
 * `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`, adopted for the same incident:
 * sessions looping on a failure that never recovers, burning API calls.
 * Exported for tests.
 */
export const MAX_CONSECUTIVE_EPOCH_FAILURES = 3;

/**
 * How a DRAWN method announces itself on the `planned` event.
 *
 * WHY IT RIDES `planned` INSTEAD OF BEING ITS OWN EVENT. `DevEvent` is consumed
 * by exhaustive `switch`es that return a value (`describeEvent` in
 * `dev-cli.ts`), so a NEW variant is a compile error in every surface until it
 * is taught the case — while an OPTIONAL FIELD on an existing variant is
 * invisible to code that does not look for it. Every listener therefore keeps
 * working unchanged and still sees a plan; the ones that want to render the
 * drawing check for this field. `epoch-start` already carries the compiled
 * `Pipeline`, so the graph costs the surfaces nothing extra to run.
 */
export interface DevGraphAnnouncement {
  /** The graph's slug — its filename under `.huu/dev/graphs/`. */
  id: string;
  name: string;
  description?: string;
  /**
   * Emission order of the nodes that produced steps — topological and
   * deterministic. The `prompt` node emits nothing and is absent.
   */
  nodeOrder: string[];
  /** node id → the pipeline step names it compiled to (1 or 2 per node). */
  stepsByNode: Record<string, string[]>;
  /** Repo-relative blackboard root this graph's artifacts land under. */
  graphRoot: string;
}

export type DevEvent =
  | { type: 'knowledge'; status: KnowledgeStatus }
  | { type: 'bootstrap-start'; model: string }
  | { type: 'bootstrap-progress'; message: string }
  | { type: 'bootstrap-done'; ok: boolean }
  | { type: 'planning'; epoch: number }
  /**
   * `plan` is what the approval gate and every existing surface consume. On the
   * GRAPH path it is SYNTHETIC — a view of the drawing in the shape the
   * callback expects (see {@link graphDevPlan}) — and `graph` is set. On the
   * planner path `graph` is absent and nothing changed.
   */
  | {
      type: 'planned';
      epoch: number;
      plan: DevPlan;
      warnings: string[];
      graph?: DevGraphAnnouncement;
    }
  | { type: 'epoch-start'; epoch: number; pipeline: Pipeline }
  | { type: 'epoch-done'; record: DevEpochRecord }
  | { type: 'stopped'; reason: DevStopReason; detail?: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

/**
 * Which run of the session an orchestrator is being built for.
 *
 * The surfaces care: a `bootstrap` run predates epoch 1 and floods the
 * machine, a `knowledge` run is the epoch's cheap two-step retrieval phase,
 * and a `work` run is the planned epoch. All three are ordinary huu runs and
 * all three now go through the SAME factory — which is what gives the
 * bootstrap a run id, SSE frames and an abort handle it never had.
 */
export type DevRunPhase = 'bootstrap' | 'knowledge' | 'work';

/** What a caller wants done with integration branches an earlier session left. */
export type OrphanAction = 'land' | 'ignore';

export interface RunDevModeArgs {
  dev: DevModeConfig;
  config: AppConfig;
  /** The user's checkout. Epochs accumulate on its current branch. */
  cwd: string;
  agentFactory: AgentFactory;
  conflictResolverFactory?: AgentFactory;
  concurrency?: number;
  autoScale?: boolean;
  cardTimeoutMs?: number;
  singleFileCardTimeoutMs?: number;
  /**
   * Names the session's blackboard namespace (`.huu/dev/<sessionId>/…`).
   * Absent ⇒ generated. A value that is not a usable single path segment is
   * refused with a warning and replaced by a generated one: an unusable id
   * must not cost the session, and collapsing it into a shared directory is
   * exactly the collision the namespace exists to prevent.
   */
  sessionId?: string;
  /**
   * `'auto'` resumes a matching session without asking; `'never'` never does.
   * Undefined defers to {@link RunDevModeArgs.onResumeOffer}, and with no
   * callback wired the answer is NO — a fresh session, so every existing
   * caller keeps behaving exactly as it does today.
   */
  resume?: 'auto' | 'never';
  /**
   * Asked once, before the knowledge gate, when the previous session's state
   * carries the SAME goal and never reported it complete. Return true to
   * continue that session: same `sessionId`, epoch numbering continued, its
   * epochs seeded as history.
   */
  onResumeOffer?: (state: DevState, nextEpoch: number) => boolean | Promise<boolean>;
  /**
   * Called when integration branches from earlier runs are not contained in
   * HEAD — genuinely lost work that `git status` cannot show. `'land'` merges
   * them oldest epoch first; `'ignore'` just names them. With no callback the
   * driver warns and continues: a forgotten branch must never block a new
   * session.
   */
  onOrphanBranches?: (orphans: OrphanBranch[]) => OrphanAction | Promise<OrphanAction>;
  onEvent?: (event: DevEvent) => void;
  /** Mirrors each running orchestrator's state (kanban, logs, budget). */
  onState?: (state: OrchestratorState, epoch: number) => void;
  /**
   * Approval gate. Called with every compiled plan when
   * `dev.approval === 'each-epoch'`; resolve false to end the session.
   * Ignored in `'autonomous'` mode.
   */
  onApprove?: (plan: DevPlan, epoch: number, warnings: string[]) => boolean | Promise<boolean>;
  /** Test seam: replaces the planner (and therefore every LLM call). */
  planner?: (opts: PlanEpochOptions) => Promise<DevPlan>;
  /** Test seam: replaces stage one, the blind orchestrator's knowledge request. */
  knowledgePlanner?: (opts: PlanKnowledgeOptions) => Promise<KnowledgeRequest>;
  /**
   * Stops the session. Checked at every boundary (before planning, before the
   * knowledge run, between the epoch's two runs, before the approval gate,
   * before landing, and at the top of each epoch), and it aborts the live
   * run. An epoch interrupted this way is NOT landed — see below for why.
   */
  signal?: AbortSignal;
  /**
   * STOP AFTER THE CURRENT EPOCH LANDS.
   *
   * `signal` is a hard abort: the live run is cut, and an aborted epoch is
   * deliberately NOT landed (its agents were killed mid-flight and no judge saw
   * the result). That is correct for "stop, this is going wrong" and much too
   * blunt for "stop when you reach a good place" — pressing it costs the merge
   * of every front that had already passed its judge.
   *
   * This signal is the second one. It is checked only at epoch boundaries, so
   * the epoch in flight runs to completion, lands, records its evidence, and
   * THEN the session ends cleanly. Absent ⇒ nothing changes.
   */
  gracefulSignal?: AbortSignal;
  /** Test seam: replaces orchestrator construction. */
  orchestratorFactory?: (pipeline: Pipeline, epoch: number, phase: DevRunPhase) => DevRunHandle;
}

/** The slice of `Orchestrator` the driver actually uses. */
export interface DevRunHandle {
  subscribe(listener: (state: OrchestratorState) => void): () => void;
  start(): Promise<{
    manifest: { runId: string; status: string; integrationBranch: string };
    /**
     * What the run cost. It sits beside the manifest rather than inside it
     * because `RunManifest` carries no cost field — `OrchestratorResult` does.
     * Optional so a handle that cannot report one simply doesn't; the driver
     * then falls back to the last state it observed.
     */
    totalCost?: number;
  }>;
  abort(): void;
  /**
   * Flood mode (one agent per queued task, the memory guard as the only
   * backstop). Used for the knowledge BOOTSTRAP, which should take the whole
   * machine. Optional: a handle that cannot flood just runs narrower.
   */
  setGreedy?(): void;
}

export interface DevModeResult {
  stoppedBecause: DevStopReason;
  detail?: string;
  epochs: DevEpochRecord[];
  goalComplete: boolean;
  knowledge: KnowledgeStatus;
  knowledgeBootstrapped: boolean;
  /** The blackboard namespace this session used — `.huu/dev/<sessionId>/`. */
  sessionId: string;
  /** True when this session continued a previous one's epoch numbering. */
  resumed: boolean;
}

/** What one orchestrator run produced, in the terms the driver reasons about. */
interface RunOutcome {
  runId: string;
  /** `''` when the run never produced one. */
  branch: string;
  /** Manifest status was `done`. */
  ok: boolean;
  /** The abort signal fired while this run was live. */
  interrupted: boolean;
  /** Last state the run emitted — the input to `collectEpochEvidence`. */
  state: OrchestratorState | null;
  totalCost?: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function summarizeKnowledge(status: KnowledgeStatus): string | undefined {
  if (!status.present) return undefined;
  const where = status.catalogPath ?? `.${status.surface}/skills/`;
  return `This project documents its own conventions as agent skills: ${status.skillCount} skill(s) (${status.skills.join(', ')}), routed by \`${where}\`. Read the relevant ones before deciding anything they already answer.`;
}

function writeFileEnsuringDir(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

/** `devSessionPaths` for an id that may be junk, without throwing. */
function safeSessionPaths(sessionId: string): DevSessionPaths | null {
  try {
    return devSessionPaths(sessionId);
  } catch {
    return null;
  }
}

/**
 * The consolidation step's report for `epoch`.
 *
 * Session-scoped first, because that is where a compiled epoch writes it. The
 * fallback reads the pre-namespacing location (`.huu/dev/epoch-N/report.md`),
 * which is all a blackboard left by an older huu ever had.
 *
 * A DRAWN EPOCH RETURNS `undefined` HERE, AND THAT IS NOT A BUG TO FIX BY
 * REPOINTING THIS AT `graphRoot`. Both paths this reads belong to the PLANNER
 * epoch, whose consolidation step huu compiles and whose output path huu
 * therefore knows. A devgraph's `consolidate` block names no output file at all
 * (`node-catalog.ts`) — the agent writes its report wherever the drawing's
 * prose sends it — so there is no `<graphRoot>/report.md` to find either. The
 * empty result is huu declining to guess, not huu looking in the wrong place.
 *
 * WHAT IS LOST, said out loud: `DevEpochEvidence.reportExcerpt` is absent for
 * every epoch a drawing ran, so the excerpt is missing from `state.json` and
 * from the session snapshot the browser renders. The one CONSUMER is unharmed:
 * the excerpt only ever feeds the NEXT epoch's planner prompt
 * (`planner-prompts.ts`), and a drawn session never reaches the planner — the
 * graph branch of the epoch loop returns before Phase A, and a resume that
 * drops the drawing is refused (`graph-missing-on-resume`) rather than handed
 * to a model. If a future drawing gains a report at a path huu OWNS, teach that
 * path to this function and delete this paragraph.
 */
function readEpochReportFor(
  cwd: string,
  paths: DevSessionPaths,
  epoch: number,
): string | undefined {
  const scoped = join(cwd, paths.epochReport(epoch));
  if (existsSync(scoped)) {
    try {
      const text = readFileSync(scoped, 'utf8');
      if (text.trim().length > 0) return text;
    } catch {
      /* fall through to the legacy location */
    }
  }
  return readEpochReport(cwd, epoch);
}

/** Names the branch that holds work huu deliberately did not merge. */
function unlandedDetail(branch: string, why: string): string {
  return branch
    ? `${why} — not landed; the partial work is on \`${branch}\` (merge it yourself with \`git merge ${branch}\` if you want it)`
    : `${why} before the run produced an integration branch`;
}

/**
 * Recursively scan a directory for task spec files (`.md` files whose content
 * has an ownership heading — `## Files this task OWNS`, or any heading whose
 * title names both "own(s)" and "file(s)", in either order, exactly the gate
 * {@link checkWritePartition}'s parser applies) and return them as
 * {@link TaskSpec} entries.
 *
 * ITS ONE CALLER SCANS THE EPOCH DIRECTORY, WHICH A DRAWN EPOCH LEAVES EMPTY —
 * deliberately, and NOT repairable by pointing the scan at `graphRoot`:
 *
 *  - A drawing's producer blocks write their task files to `.huu/findings/
 *    <axis>/`, hard-coded in the block prompt and deliberately OUTSIDE
 *    `graphRoot` (the gitignore remedy those prompts carry re-includes exactly
 *    that path — see `devGraphFanOutNamespace` and `graph-to-pipeline.ts`). So
 *    `graphRoot` holds research artifacts and critic shards, never a task spec:
 *    scanning it would find nothing, or worse, match an ownership-shaped
 *    heading inside a research write-up.
 *  - Scanning `.huu/findings/` instead would be worse than finding nothing.
 *    That directory is namespaced by AXIS, not by session or epoch, and its
 *    specs are committed — so epoch 2 of a resumed drawing would re-read epoch
 *    1's task files and report violations that no longer exist. That is the
 *    exact cross-epoch collision the epoch segment in `devGraphRoot` and
 *    `devGraphFanOutNamespace` was added to make impossible.
 *
 * NOTHING IS ACTUALLY UNMEASURED. This scan is only the RECONCILIATION pass
 * (see its call site): the authoritative source is the run itself, which
 * collides declared ownership BEFORE each `memory` fan-out and across every
 * step so far (`Orchestrator` → `OrchestratorState.declaredWriteCollisions` →
 * `collectEpochEvidence`). That check is live on the drawn path too — a
 * drawing's fan-out is an ordinary `memory`-scope step — and it is both earlier
 * and cross-node, which is where the expensive conflicts are.
 */
function scanSpecs(root: string): TaskSpec[] {
  const specs: TaskSpec[] = [];
  if (!existsSync(root)) return specs;
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      specs.push(...scanSpecs(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      try {
        const content = readFileSync(full, 'utf8');
        if (/^#{1,6}\s+(?=.*\bowns?\b)(?=.*\bfiles?\b)/im.test(content)) {
          specs.push({ path: full, content });
        }
      } catch {
        // Unreadable file — skip.
      }
    }
  }
  return specs;
}

// ─────────────────────────── the drawn-method path ──────────────────────────

/**
 * The blackboard segment a graph session's artifacts live under —
 * `.huu/dev/<sessionId>/graph/epoch-<N>/…`.
 *
 * UNDER THE SESSION, for exactly the reason `devSessionPaths` exists: a graph
 * writes per-node research artifacts (`<graphRoot>/<nodeId>/research.json`) and
 * critic shards, and node ids are semantic (`recon`, `consolidar`). Two SESSIONS
 * of the same drawing sharing one directory is the collision the epoch
 * blackboard already fixed, so the segment hangs off `paths.root`, never off
 * `.huu/dev/` directly.
 *
 * AND UNDER THE EPOCH, which is the half that was missing. A graph session is
 * one epoch PER RUN, not one epoch ever: a drawing always ends with
 * `goalComplete: false`, so every re-run of the same objective is offered a
 * resume, and an accepted resume continues the numbering (epoch 2, epoch 3…)
 * inside the SAME `sessionId`. The session segment does nothing about that.
 * Concretely, without the epoch segment: epoch 1's recon commits a list of 30
 * targets; epoch 2's recon fails; the fan-out reads the committed file anyway
 * (`resolveMemoryFiles` checks `existsSync` and nothing else) and dispatches 30
 * agents onto yesterday's work. The segment turns that from likely into
 * impossible — a run whose producer wrote nothing finds no list, resolves to
 * ZERO tasks, and the stage completes empty, which is the honest outcome.
 *
 * (The FAN-OUT lists are a separate decision the compiler owns and documents:
 * they live under `.huu/findings/`, outside `graphRoot`, because the producing
 * blocks' gitignore remedy re-includes exactly that path — see
 * {@link devGraphFanOutNamespace}, which carries the same epoch segment into
 * the one path this function cannot reach.)
 */
export const DEV_GRAPH_ROOT_SEGMENT = 'graph';

/** `.huu/dev/<sessionId>/graph/epoch-<N>` — see {@link DEV_GRAPH_ROOT_SEGMENT}. */
export function devGraphRoot(sessionId: string, epoch: number): string {
  const root = `${devSessionPaths(sessionId).root}/${DEV_GRAPH_ROOT_SEGMENT}`;
  return `${root}/epoch-${Math.max(1, Math.trunc(epoch))}`;
}

/**
 * Ceiling `sanitizeNodeId` enforces on the namespace segment (it is the id slug
 * `RESEARCH_ID_PATTERN` accepts). Mirrored here because the truncation has to
 * happen BEFORE the epoch suffix is appended: letting the compiler cut the
 * string would drop the very segment this function exists to add, and silently
 * restore the collision for any long session id.
 */
const FAN_OUT_NAMESPACE_MAX = 40;

/**
 * The namespace the fan-out lists live under —
 * `.huu/findings/<session>-e<epoch>/<node>.json`.
 *
 * Same argument as {@link DEV_GRAPH_ROOT_SEGMENT}, applied to the ONE path that
 * deliberately sits outside `graphRoot`: the producing blocks tell the agent it
 * may un-ignore `.huu/findings/` and nothing else, so the list has to stay
 * there and gets its execution segment folded into the namespace instead of
 * added as a directory level.
 *
 * The session half is truncated first so the epoch half always survives — a
 * namespace that lost its epoch is worse than a namespace that lost characters
 * of its session id, because only one of the two is a correctness segment.
 */
export function devGraphFanOutNamespace(sessionId: string, epoch: number): string {
  const suffix = `-e${Math.max(1, Math.trunc(epoch))}`;
  const base = sanitizeNodeId(sessionId).slice(0, Math.max(1, FAN_OUT_NAMESPACE_MAX - suffix.length));
  return `${base.replace(/-+$/, '')}${suffix}`;
}

/** A drawn method the session will run, or the refusal that stops it. */
export type DevGraphResolution =
  | { ok: true; graph: DevGraph }
  | {
      ok: false;
      reason: Extract<DevStopReason, 'graph-not-found' | 'graph-invalid' | 'graph-conflict'>;
      detail: string;
    };

/**
 * Resolve the DRAWN METHOD a session was given, if any. Never throws.
 *
 * `null` — and ONLY `null` — means "no graph was asked for", which is what
 * keeps every existing caller on the planner path byte for byte. Same
 * discipline as `parseMethodologyFlags` returning `undefined` instead of `{}`.
 *
 * ORDER OF REFUSALS, and it is deliberate: the two pure-CONFIGURATION conflicts
 * are checked BEFORE anything is read from disk. They cost nothing to detect
 * and they are the ones the caller can fix without touching the repository, so
 * a session with both a bad `--epochs` and a missing graph hears about the flag
 * it typed rather than about a file it may not have written yet.
 *
 * Exported because a SURFACE should be able to refuse a bad selection before it
 * starts a session at all (the picker saying "that drawing does not compile"
 * beats a session that opens and immediately stops).
 */
export function resolveDevGraph(cwd: string, dev: DevModeConfig): DevGraphResolution | null {
  const inline = dev.graph;
  const id = dev.graphId?.trim();
  if (inline === undefined && (id === undefined || id.length === 0)) return null;

  // --- pure-configuration refusals -----------------------------------------
  if (inline !== undefined && id !== undefined && id.length > 0 && inline.id !== id) {
    return {
      ok: false,
      reason: 'graph-conflict',
      detail: `the session was given two different methods — an inline graph "${inline.id}" and graphId "${id}". Pass one: there is no defensible way to guess which drawing the human meant.`,
    };
  }
  // A drawn method IS the complete method, so the session that runs it is one
  // epoch. Replanning is what the epoch chain exists for and there is nothing
  // to replan here — running the SAME drawing N times over would repeat the
  // work, not advance it. `undefined` (the web sends nothing; "no ceiling") is
  // accepted and read as one epoch; only an explicit ≥ 2 is a contradiction of
  // something the caller actually asked for.
  if (dev.maxEpochs !== undefined && dev.maxEpochs > 1) {
    return {
      ok: false,
      reason: 'graph-conflict',
      detail: `maxEpochs=${dev.maxEpochs} cannot be combined with a drawn method: a devgraph is the COMPLETE method, so a graph session is exactly one epoch. Drop the epoch ceiling (or set it to 1) — re-running the same drawing is not a second epoch.`,
    };
  }

  // --- load ----------------------------------------------------------------
  let graph: DevGraph;
  if (inline !== undefined) {
    graph = inline;
  } else {
    const read = readGraph(cwd, id!);
    if (!read.ok) {
      // The store's `reason` opens with a stable prefix; only "there is no such
      // graph" is a not-found. Everything else (bad JSON, foreign schema, a
      // file that is not a regular file) is a graph that exists and is broken.
      const absent = read.reason.startsWith('not-found') || read.reason.startsWith('invalid-id');
      return {
        ok: false,
        reason: absent ? 'graph-not-found' : 'graph-invalid',
        detail: `graphId "${id}": ${read.reason}`,
      };
    }
    graph = read.graph;
  }

  // --- structural validation ------------------------------------------------
  // `compileGraphPipeline` THROWS on an invalid graph, by contract. Running the
  // non-throwing validator here is what turns that contract into a clean stop
  // reason with the human's own node ids in it, before a session opens.
  const validation = validateGraph(graph);
  if (!validation.ok) {
    const detail = validation.errors
      .map((issue) => `${issue.code}${issue.nodeId ? ` (${issue.nodeId})` : ''}: ${issue.message}`)
      .join('; ');
    return {
      ok: false,
      reason: 'graph-invalid',
      detail: `devgraph "${graph.id}" has ${validation.errors.length} blocking issue(s): ${detail}`,
    };
  }
  return { ok: true, graph };
}

/** One line, collapsed and capped — falls back to the node id when blank. */
function nodeLabel(node: GraphNode): string {
  const raw = typeof node.label === 'string' ? node.label.replace(/\s+/g, ' ').trim() : '';
  return raw.length > 0 ? raw : String(node.id ?? '');
}

/** Trim + collapse + cap, for text that goes into a `DevFront` field. */
function oneLine(text: string | undefined, max: number): string {
  const collapsed = (text ?? '').replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

/** What KIND of box this is, in one human line — the front's `rationale`. */
function nodeRationale(node: GraphNode): string {
  const notes = oneLine(node.notes, 160);
  const kind = isActionNode(node)
    ? `bloco "${node.block}"${node.scope ? ` · escopo ${node.scope}` : ''}${node.fanOutFrom ? ` · leque a partir de "${node.fanOutFrom}"` : ''}`
    : isResearchNode(node)
      ? `pesquisa (${node.outputKind})${node.useContext ? ' · lê o repositório' : ''}`
      : isGateNode(node)
        ? `portão · ${node.outcomes.length} saída(s), default "${node.defaultOutcome}"`
        : 'nó';
  return notes.length > 0 ? `${kind} — ${notes}` : kind;
}

/**
 * A drawn node id, as a `DevFront.id`.
 *
 * `FRONT_ID_PATTERN` demands 3–40 chars; `graph-schema.ts` accepts a node id of
 * ONE. So `a` is a legal box on a legal canvas and an illegal front, and the
 * two shapes diverged in silence because nothing ever parsed the synthetic
 * plan. Padding is the honest repair: the id is a DISPLAY key here (surfaces
 * render it, `dependsOnFronts` cross-references it), while the authoritative
 * node↔step mapping travels untouched on {@link DevGraphAnnouncement}.
 */
function padFrontId(nodeId: string): string {
  const base = sanitizeNodeId(nodeId) || 'no';
  return base.length >= 3 ? base : `${base}-no`;
}

/**
 * node id → front id, for every emitted node at once.
 *
 * Done as a MAP rather than per node because padding is not injective: a canvas
 * carrying both `a` and `a-no` would otherwise produce two fronts with one id,
 * and `dependsOnFronts` would point at both. The numeric disambiguator is
 * deterministic in emission order, which is itself deterministic.
 */
function frontIdsByNode(nodeIds: readonly string[]): Map<string, string> {
  const taken = new Set<string>();
  const byNode = new Map<string, string>();
  for (const nodeId of nodeIds) {
    const padded = padFrontId(nodeId);
    let candidate = padded;
    for (let n = 2; taken.has(candidate); n++) {
      candidate = `${padded.slice(0, 35).replace(/-+$/, '')}-${n}`;
    }
    taken.add(candidate);
    byNode.set(nodeId, candidate);
  }
  return byNode;
}

/**
 * HOW MANY AGENTS THIS BOX MAY SPAWN — read off the COMPILED steps, never off
 * the node.
 *
 * This number is what the approval gate prints ("até N agente(s)"), so it is
 * the blast radius a human is signing for. Deriving it from the node was a
 * consent bug in both directions at once: a node with no `maxFiles` showed 1
 * while the compiled step carried {@link DEVGRAPH_DEFAULT_FAN_OUT} (40), and a
 * node asking for 400 showed 400 while the compiled step was clamped to
 * {@link DEVGRAPH_MAX_FAN_OUT} (100). Only the compiler knows the defaults and
 * the clamps, and the compiled pipeline is already in hand when the plan is
 * built — so the plan reads it instead of guessing.
 *
 * The rules mirror `Orchestrator.buildTasks` exactly:
 *  - `memory` scope fans out over the producer's list, capped by `maxFiles`;
 *  - any other step decomposes one task per file, and `decomposeTasks` gives a
 *    step with no files ONE whole-project task (not zero);
 *  - a `CheckStep` is one judge, always.
 * A node emits at most two steps and they run in sequence, so the front's width
 * is the WIDEST of them, not their sum.
 */
function compiledFrontWidth(compiled: CompiledGraph, nodeId: string): number {
  const emitted = new Set(compiled.stepsByNode[nodeId] ?? []);
  let width = 1;
  for (const step of compiled.pipeline.steps) {
    if (!emitted.has(step.name) || step.type === 'check') continue;
    const stepWidth =
      step.scope === 'memory' && typeof step.filesFrom === 'string'
        ? (step.maxFiles ?? DEFAULT_MEMORY_MAX_FILES)
        : Math.max(1, step.files.length);
    if (stepWidth > width) width = stepWidth;
  }
  return width;
}

/**
 * The drawing, in the shape {@link RunDevModeArgs.onApprove} expects.
 *
 * WHY A SYNTHETIC `DevPlan` AND NOT A NEW CALLBACK. The approval gate's whole
 * job is "show the human what is about to run and let them refuse it", and its
 * signature is already wired through the CLI (`formatPlan`) and the web
 * (`session.plan` → the plan panel). A second callback would leave one of the
 * two paths ungated until every surface grew it — and an ungated graph is the
 * one thing this feature must not ship. So the graph is projected onto the
 * shape that already gets shown, and the FULL drawing rides beside it on the
 * event ({@link DevGraphAnnouncement}) for surfaces that want to render it
 * properly.
 *
 * BE HONEST ABOUT THE PROJECTION: a `DevFront` is a parallel WORKSTREAM the
 * planner invented; a graph node is a BOX A HUMAN DREW. One front per emitted
 * node is the mapping that renders correctly in the panels that exist today
 * (`title`, `id`, `rationale`, `dependsOnFronts`, `maxTasks` are the only
 * fields any surface reads). The three prompt fields have no counterpart in a
 * drawing, so they carry the node's own authored text — and, where the node
 * authored none, one honest line saying where its prompt DOES come from,
 * because `DevPlanSchema` reads an empty string as a missing field and every
 * surface reads it as an empty box.
 *
 * IT IS A VALID `DevPlanSchema` VALUE, with three named exceptions. Nothing
 * parses this object at run time, which is how the two shapes drifted apart
 * unnoticed; `dev-driver.test.ts` now parses it, so they cannot drift again.
 * The exceptions are all the same thing — cardinality ceilings that bound what
 * a PLANNER MODEL may invent in one epoch, applied to a topology a human drew:
 *   - `fronts` may exceed {@link DEV_MAX_FRONTS} (4). That cap exists to keep a
 *     planner's epoch under the 20-step compile ceiling; a canvas is bounded by
 *     `graph-schema.ts` and `validateGraph` instead, and truncating it would
 *     hide boxes from the very gate that authorizes them.
 *   - `dependsOnFronts` may exceed {@link DEV_MAX_FRONTS}, for the same reason:
 *     a join is as wide as the arrows the human drew.
 *   - `maxTasks` may exceed 40 (the planner's fan-out ceiling) up to
 *     {@link DEVGRAPH_MAX_FAN_OUT}, or higher on a hand-picked file list. This
 *     one is not negotiable in the other direction: see
 *     {@link compiledFrontWidth} — under-reporting the blast radius at the
 *     approval gate is a consent failure, and consent is what the gate is for.
 *
 * `goalComplete` is ALWAYS false: nothing in a drawing can claim the human's
 * overall goal is met, and it is not a graph's business to say so.
 */
function graphDevPlan(graph: DevGraph, compiled: CompiledGraph): DevPlan {
  const byId = new Map<string, GraphNode>();
  for (const node of graph.nodes) if (!byId.has(node.id)) byId.set(node.id, node);
  const promptId = graph.nodes.find(isPromptNode)?.id;
  const frontIds = frontIdsByNode(compiled.nodeOrder);

  const fronts: DevFront[] = [];
  for (const nodeId of compiled.nodeOrder) {
    const node = byId.get(nodeId);
    if (!node) continue;
    const steps = compiled.stepsByNode[nodeId] ?? [];
    const authored = isResearchNode(node)
      ? node.query
      : isGateNode(node)
        ? node.condition
        : isActionNode(node)
          ? (node.prompt ?? '')
          : '';
    const drawnOutcomes = isGateNode(node)
      ? node.outcomes.map((outcome) => outcome.id).join(' | ')
      : isResearchNode(node) && node.choices
        ? node.choices.map((choice) => choice.id).join(' | ')
        : '';
    fronts.push({
      id: frontIds.get(nodeId) ?? padFrontId(nodeId),
      title: oneLine(nodeLabel(node), 60) || padFrontId(nodeId),
      rationale: oneLine(nodeRationale(node), 400) || 'nó do desenho',
      dependsOnFronts: effectiveDependencies(graph, node.id)
        .filter((dep) => dep !== promptId)
        .map((dep) => frontIds.get(dep) ?? padFrontId(dep)),
      reconPrompt:
        oneLine(authored, 400) ||
        (isActionNode(node)
          ? `sem texto próprio no nó — o prompt vem do bloco "${node.block}" do catálogo`
          : 'sem texto próprio no nó'),
      workPrompt: oneLine(steps.join(' · '), 6000) || 'nenhum step compilado para este nó',
      verifyCondition:
        oneLine(drawnOutcomes, 1200) || 'sem portão desenhado — nada julga este nó dentro do desenho',
      // The width the COMPILED step actually has — see `compiledFrontWidth`.
      maxTasks: compiledFrontWidth(compiled, nodeId),
    });
  }

  const name = oneLine(graph.name, 120) || graph.id || 'método desenhado';
  return {
    epochGoal: name,
    doneWhen: oneLine(
      `o método desenhado "${oneLine(graph.name, 60) || graph.id}" rodou de ponta a ponta (${fronts.length} nó(s)) — um grafo não declara outro critério: quem desenhou é quem julga`,
      600,
    ),
    goalComplete: false,
    fronts,
  };
}

/**
 * Run a full dev-mode session. Never throws for an expected failure — every
 * stop path comes back as a `DevModeResult` so the CLI and the web surface
 * can report the same thing.
 */
export async function runDevMode(args: RunDevModeArgs): Promise<DevModeResult> {
  const { dev, config, cwd } = args;
  const emit = (event: DevEvent): void => {
    try {
      args.onEvent?.(event);
    } catch {
      /* an observer must never take the session down */
    }
  };
  const log = (level: 'info' | 'warn' | 'error', message: string): void =>
    emit({ type: 'log', level, message });

  const git = new GitClient(cwd);

  // THE DRAWN METHOD, if the human handed one over. Resolved FIRST because the
  // epoch ceiling below depends on it: a graph session is one epoch and nothing
  // else. `null` is "no graph" and keeps every line after it exactly as it was;
  // a refusal is reported the moment `finish()` has a knowledge status to
  // report it with (just after the probe, below).
  const graphResolution = resolveDevGraph(cwd, dev);
  const drawnMethod: DevGraph | undefined =
    graphResolution?.ok === true ? graphResolution.graph : undefined;

  // No ceiling configured ⇒ run until the goal is reported complete, the
  // consecutive-failure circuit breaker trips, or the caller aborts. The
  // backstop is not a product limit, it is the thing that keeps an unattended
  // session from looping forever on a planner that never says "done".
  //
  // A GRAPH pins it to 1: the drawing is the complete method, so there is no
  // second epoch to plan. `resolveDevGraph` already REFUSED an explicit
  // `maxEpochs ≥ 2`, so this line only ever collapses `undefined` (the web's
  // "no ceiling") and an explicit 1.
  const unboundedEpochs = dev.maxEpochs === undefined && drawnMethod === undefined;
  const maxEpochs = drawnMethod
    ? 1
    : unboundedEpochs
      ? DEV_UNBOUNDED_EPOCH_BACKSTOP
      : Math.max(1, dev.maxEpochs!);
  const maxFronts = Math.min(Math.max(1, dev.maxFronts ?? DEV_MAX_FRONTS), DEV_MAX_FRONTS);

  /**
   * Session options a DRAWING owns and a flag cannot override.
   *
   * Warned rather than refused, and the distinction matters: a caller may carry
   * these from a preset or a default while the human's drawing already says
   * `tdd` (they dropped the tdd block) or already says which model runs which
   * node. Refusing would turn a harmless leftover into a dead session. What is
   * NOT acceptable is silence — the flags read as promises, so they are logged
   * AND carried into the approval gate's warnings, where a human signs.
   *
   * The 12 methodologies are the EPOCH compiler's surface: each one compiles a
   * structure (an extra step, a merge gate, a critic rubric) into a graph the
   * PLANNER wrote. `compileGraphPipeline` deliberately refuses to do that —
   * adding steps nobody drew is the exact decision a devgraph takes back from
   * the machine. Model routing is the same argument: `DevModelRole` names jobs
   * inside the planner's fixed epoch template, and a drawing has boxes, not
   * roles. Its routing surface is `meta.modelId` and each node's `modelId`.
   */
  const graphSessionWarnings: string[] = [];
  if (drawnMethod) {
    const flags = Object.entries(dev.methodology ?? {})
      .filter(([, on]) => on === true)
      .map(([key]) => key);
    if (flags.length > 0) {
      graphSessionWarnings.push(
        `the session turned on ${flags.join(', ')}, and a drawn method does NOT compile the methodology flags — a devgraph expresses method by DRAWING it (drop the tdd block, draw a gate node). The flags are ignored here; the drawing decides.`,
      );
    }
    const roles = Object.keys(dev.models ?? {});
    if (roles.length > 0) {
      graphSessionWarnings.push(
        `per-role model routing (${roles.join(', ')}) is NOT applied to a drawn method — roles exist inside the planner's epoch template, a drawing has nodes. Route with the graph's meta.modelId or a per-node modelId.`,
      );
    }
  }
  const aborted = (): boolean => args.signal?.aborted === true;
  const stopRequested = (): boolean => args.gracefulSignal?.aborted === true;
  const epochs: DevEpochRecord[] = [];

  // "Which providers serve this id", from huu's own shipped catalog UNIONED
  // with whatever the audited repo ships. That union is what the model
  // preflight below judges against.
  const modelIndex = devModelProviderIndex(cwd);
  const isKnownModel = modelKnownFor(modelIndex, config.provider);

  // Every role, resolved. Only `planner` is read from here — it is the one
  // call the driver makes itself. The compilers get the RAW policy, because a
  // role it does not name must keep OMITTING `modelId` so the orchestrator's
  // own `AppConfig.modelId` fallback stays the single authority.
  const models = resolveDevModels(
    dev.models,
    config.modelId,
    isKnownModel,
  );

  let sessionId = args.sessionId?.trim() || generateRunId();
  let resumed = false;
  /** Set on resume when a previous session died with an epoch mid-EXECUTION. */
  let resumePending: DevState['pendingEpoch'];

  const state: DevState = {
    _format: DEV_STATE_FORMAT,
    goal: dev.goal,
    doneWhen: '',
    epochs,
    goalComplete: false,
    updatedAt: nowIso(),
    sessionId,
    // WRITTEN SO A RESUME CAN REFUSE. `resolveDevGraph` reads only what the
    // CALLER passed, so without this the drawing is forgotten the moment the
    // process exits and a resume with no `--graph` degrades to the LLM planner
    // — inside a session a human opened as a drawing. Spread, not assigned:
    // a planner session must keep writing exactly the state.json it writes
    // today, key for key.
    ...(drawnMethod
      ? { drawnMethod: { graphId: drawnMethod.id, graphName: drawnMethod.name } }
      : {}),
  };

  const persist = async (message: string, extraPaths: readonly string[] = []): Promise<void> => {
    state.updatedAt = nowIso();
    state.sessionId = sessionId;
    writeGoalFile(cwd, dev.goal);
    writeDevState(cwd, state);
    try {
      const sha = await commitBlackboard(git, cwd, message, extraPaths);
      if (sha) log('info', `blackboard commited (${sha.slice(0, 8)})`);
    } catch (err) {
      // Not fatal on its own, but the next landing merge will refuse on the
      // resulting dirty tree — so say it loudly.
      log('warn', `could not commit the dev blackboard: ${message_(err)}. The next epoch's landing may refuse on a dirty tree.`);
    }
  };

  const finish = (reason: DevStopReason, knowledge: KnowledgeStatus, bootstrapped: boolean, detail?: string): DevModeResult => {
    emit({ type: 'stopped', reason, detail });
    return {
      stoppedBecause: reason,
      detail,
      epochs,
      goalComplete: state.goalComplete,
      knowledge,
      knowledgeBootstrapped: bootstrapped,
      sessionId,
      resumed,
    };
  };

  /**
   * One orchestrator run, whatever its phase. Owning construction, the abort
   * wiring, the state mirror and the cost read in ONE place is what let the
   * bootstrap join the same path as the epochs — it used to build its
   * `Orchestrator` inline, which is why it had no run id, no frames and no
   * abort handle.
   */
  const runPipeline = async (
    pipeline: Pipeline,
    epochForState: number,
    phase: DevRunPhase,
  ): Promise<RunOutcome> => {
    const handle: DevRunHandle =
      args.orchestratorFactory?.(pipeline, epochForState, phase) ??
      wrapOrchestrator(
        new Orchestrator(config, pipeline, cwd, args.agentFactory, {
          initialConcurrency: args.concurrency,
          conflictResolverFactory: args.conflictResolverFactory,
          autoScale: args.autoScale ?? args.concurrency === undefined,
        }),
      );

    // An abort DURING the run has to reach the orchestrator, and the orchestrator
    // resolves an aborted run as `done` (index.ts forces the terminal status),
    // so the manifest can never tell us it was interrupted. Track it here.
    let interrupted = false;
    const onAbort = (): void => {
      interrupted = true;
      try {
        handle.abort();
      } catch (err) {
        log('warn', `${phase} run: abort failed: ${message_(err)}`);
      }
    };
    if (aborted()) onAbort();
    args.signal?.addEventListener('abort', onAbort, { once: true });

    // A one-slot holder rather than a bare `let`: the subscription writes it
    // from a callback, and a captured `let` keeps its initializer's type for
    // the reader below. Holding the last state here is also what makes the
    // evidence free — `DevRunHandle` needs no new member for it, because the
    // driver already receives every state the run emits.
    const observed: { last: OrchestratorState | null } = { last: null };
    const unsubscribe = handle.subscribe((s) => {
      observed.last = s;
      args.onState?.(s, epochForState);
    });

    let runId = '';
    let branch = '';
    let ok = false;
    let totalCost: number | undefined;
    try {
      const result = await handle.start();
      runId = result.manifest.runId;
      branch = result.manifest.integrationBranch;
      ok = result.manifest.status === 'done';
      totalCost = result.totalCost;
    } catch (err) {
      log('error', `${phase} run failed: ${message_(err)}`);
    } finally {
      unsubscribe();
      args.signal?.removeEventListener('abort', onAbort);
    }

    return {
      runId,
      branch,
      ok,
      interrupted,
      state: observed.last,
      totalCost: totalCost ?? observed.last?.totalCost,
    };
  };

  /**
   * Integration branches HEAD never absorbed — a crash, a Ctrl-C, a conflicted
   * landing. It is genuinely lost work and it is invisible (`git status` is
   * clean, the files are simply not there), so a new session says what it
   * found. It NEVER blocks: with no callback, or with a landing that fails,
   * the session continues and the branch is named.
   */
  const handleOrphanBranches = async (): Promise<void> => {
    let orphans: OrphanBranch[];
    try {
      orphans = await findOrphanIntegrationBranches(git, epochs);
    } catch (err) {
      log('warn', `could not scan for orphan integration branches: ${message_(err)}`);
      return;
    }
    if (orphans.length === 0) return;

    const describe = (o: OrphanBranch): string =>
      `\`${o.branch}\` (${o.ahead} commit(s)${o.epoch === undefined ? '' : `, epoch ${o.epoch}`})`;
    log('warn', `${orphans.length} integration branch(es) never landed: ${orphans.map(describe).join(', ')}`);

    let action: OrphanAction = 'ignore';
    if (args.onOrphanBranches) {
      try {
        action = await Promise.resolve(args.onOrphanBranches(orphans));
      } catch (err) {
        log('warn', `the orphan-branch offer threw (${message_(err)}) — leaving them alone`);
        action = 'ignore';
      }
    }

    if (action !== 'land') {
      for (const orphan of orphans) {
        log('warn', `left behind: ${describe(orphan)} — land it yourself with \`git merge ${orphan.branch}\``);
      }
      return;
    }

    // Ascending epoch order (`findOrphanIntegrationBranches` sorts them):
    // merging an older epoch after a newer one replays history backwards.
    for (const orphan of orphans) {
      const landing = await landEpoch({ cwd, integrationBranch: orphan.branch, epoch: orphan.epoch ?? 0 });
      if (landing.landed) {
        log('info', `landed orphan ${orphan.branch}${landing.commit ? ` at ${landing.commit.slice(0, 8)}` : ''}`);
      } else {
        log('warn', `could not land ${orphan.branch}: ${landing.error} — land it yourself with \`git merge ${orphan.branch}\``);
      }
    }
  };

  // --- Phase 0: the knowledge gate ---------------------------------------
  let knowledge = detectKnowledge(cwd);
  emit({ type: 'knowledge', status: knowledge });
  log('info', `knowledge probe: ${knowledge.present ? 'present' : 'absent'} — ${knowledge.reason}`);

  // The drawn method was resolved at the top (the epoch ceiling depends on it);
  // this is where a refusal becomes a stop. Reported BEFORE the model preflight
  // and the dirty-tree probe on purpose: it is the cheapest gate and the one
  // whose fix is entirely in the caller's hands. A session told to run a method
  // it cannot load NEVER falls through to the planner — silently swapping the
  // human's drawing for a model's plan is the one failure mode this whole
  // feature exists to remove.
  if (graphResolution && !graphResolution.ok) {
    return finish(graphResolution.reason, knowledge, false, graphResolution.detail);
  }
  if (drawnMethod) {
    log(
      'info',
      `drawn method "${drawnMethod.id}" (${drawnMethod.nodes.length} node(s), ${drawnMethod.edges.length} edge(s)) — the LLM planner will NOT be called; this session is one epoch`,
    );
  }

  // THE MODEL PREFLIGHT, restored. It exists to move ONE failure earlier: a
  // role routed to an id this run's provider does not serve used to survive
  // until the first agent was spawned — worktree created, branch created,
  // blackboard committed — and only then die on "model not found". Refusing
  // here costs the user nothing but the message.
  //
  // Refuse on positive contradiction, warn on absence of evidence: the catalog
  // is a hand-maintained recommendation list, not a registry, so an id it has
  // never heard of is reported and RUN (huu cannot enumerate what an endpoint
  // serves), while an id the catalog places on another endpoint only is a stop.
  {
    const issues = checkDevModelPolicy({
      policy: dev.models,
      provider: config.provider,
      index: modelIndex,
    });
    for (const issue of issues) {
      if (issue.severity === 'warn') log('warn', `model routing: ${issue.message}`);
    }
    const refusals = devModelRefusals(issues);
    if (refusals.length > 0) {
      for (const refusal of refusals) log('error', `model routing: ${refusal.message}`);
      return finish(
        'model-preflight-failed',
        knowledge,
        false,
        `${refusals.length} role(s) routed to a model ${config.provider ?? 'this run'} does not serve:\n${formatDevModelIssues(refusals)}`,
      );
    }
  }

  // Fail fast on the user's own uncommitted work. Every epoch ends in a merge
  // into this branch, and that merge refuses on a dirty tree — better to say
  // so now than after the first epoch has burned a swarm.
  try {
    const foreign = await foreignDirtyPaths(git, cwd);
    if (foreign.length > 0) {
      return finish(
        'dirty-tree',
        knowledge,
        false,
        `the working tree has uncommitted changes huu does not own (${foreign.slice(0, 5).join(', ')}${
          foreign.length > 5 ? `, +${foreign.length - 5} more` : ''
        }) — commit or stash them first; every epoch ends in a merge into this branch`,
      );
    }
  } catch (err) {
    log('warn', `could not read the working tree state: ${message_(err)}`);
  }

  // --- Session: resume, or start a new one -------------------------------
  //
  // A DIFFERENT goal is a different session, full stop: continuing one
  // session's epoch numbering under another's goal is how the planner ends up
  // reading history that never applied to what it is being asked to do.
  const previous = readDevState(cwd);
  const previousSession = previous?.sessionId?.trim();

  if (
    previous !== null &&
    // A v1 state file has no session, and an id that is not a path segment
    // cannot address its own blackboard — neither can be attributed to, so
    // neither is resumable. (`readDevState` already refuses a foreign format.)
    previousSession !== undefined &&
    safeSessionPaths(previousSession) !== null &&
    previous.goal.trim() === dev.goal.trim() &&
    !previous.goalComplete &&
    args.resume !== 'never'
  ) {
    const nextEpoch = previous.epochs.length + 1;
    let accept = args.resume === 'auto';
    if (!accept && args.onResumeOffer) {
      try {
        accept = (await Promise.resolve(args.onResumeOffer(previous, nextEpoch))) === true;
      } catch (err) {
        log('warn', `the resume offer threw (${message_(err)}) — starting a new session`);
        accept = false;
      }
    }
    if (accept) {
      // ── THE DRAWING HAS TO COME BACK WITH THE SESSION ───────────────────
      //
      // A resume re-opens a session; it does not re-open the ARGUMENTS the
      // session was started with. `resolveDevGraph` reads `dev.graph` /
      // `dev.graphId`, which only the caller can supply, so a session whose
      // epoch 1 was a drawn method comes back as an ordinary planner session
      // the moment a surface forgets to re-send the selection — and epoch 2
      // then runs a topology a MODEL invented inside a session a human opened
      // as a drawing. That is the precise substitution this whole feature
      // exists to delete, and it is the worst version of it, because nothing
      // on screen says it happened.
      //
      // So: refuse. Not "start fresh" either — a fresh session under the same
      // goal would orphan the epochs already recorded AND still run the
      // planner. The two refusals below both precede every side effect (the
      // orphan-branch scan, the first blackboard commit, the knowledge gate),
      // exactly like the refusals in `resolveDevGraph`.
      const previousDrawn = previous.drawnMethod;
      if (previousDrawn) {
        if (!drawnMethod) {
          return finish(
            'graph-missing-on-resume',
            knowledge,
            false,
            `session ${previousSession} ran the drawn method "${previousDrawn.graphId}" (${previousDrawn.graphName}) and this resume carries no drawing — pass it again (graphId "${previousDrawn.graphId}"), or start a NEW session. huu will not hand a session a human opened as a drawing over to the LLM planner.`,
          );
        }
        if (drawnMethod.id !== previousDrawn.graphId) {
          return finish(
            'graph-conflict',
            knowledge,
            false,
            `session ${previousSession} ran the drawn method "${previousDrawn.graphId}" (${previousDrawn.graphName}) and this resume carries a DIFFERENT one, "${drawnMethod.id}" (${drawnMethod.name}) — resuming would continue one method's epoch numbering under another's topology. Pass "${previousDrawn.graphId}" to continue it, or start a new session for "${drawnMethod.id}".`,
          );
        }
      } else if (drawnMethod) {
        // The mirror case, and deliberately NOT a refusal: the human is here
        // with a drawing in hand, which is them taking the topology BACK from
        // the planner — the direction this feature wants. It still changes the
        // method mid-session, so it is said out loud rather than assumed.
        log(
          'warn',
          `session ${previousSession} was planned by the LLM planner and this resume carries the drawn method "${drawnMethod.id}" — epoch ${nextEpoch} onward runs the drawing, not a plan`,
        );
      }
      resumed = true;
      sessionId = previousSession;
      state.sessionId = sessionId;
      state.doneWhen = previous.doneWhen;
      // The commands the previous session extracted stay the critic's anchor —
      // the baseline gap that produced them is never asked again.
      if (isUsableVerifyCommands(previous.verifyCommands)) {
        state.verifyCommands = previous.verifyCommands;
      }
      // An epoch whose EXECUTION run started and never finished. Its compiled
      // graph is a committed artefact; re-running it is strictly cheaper and
      // strictly more faithful than re-buying the knowledge run and asking a
      // planner to reproduce a plan it can no longer see.
      if (
        previous.pendingEpoch &&
        Number.isInteger(previous.pendingEpoch.epoch) &&
        existsSync(join(cwd, previous.pendingEpoch.pipelinePath))
      ) {
        resumePending = previous.pendingEpoch;
      }
      // Seeded, not just counted: history and the previous epoch's structured
      // evidence are what the next planning pass reads.
      epochs.push(...previous.epochs);
      log('info', `resuming session ${sessionId} at epoch ${nextEpoch} (${epochs.length} epoch(s) already done)`);
    }
  }

  let paths = safeSessionPaths(sessionId);
  if (!paths) {
    const generated = generateRunId();
    log(
      'warn',
      `dev session id ${JSON.stringify(sessionId)} is not a usable path segment — this session's blackboard goes under "${generated}" instead`,
    );
    sessionId = generated;
    state.sessionId = sessionId;
    paths = devSessionPaths(sessionId);
  }
  const startEpoch = epochs.length + 1;

  await handleOrphanBranches();

  await persist('chore(huu-dev): abrir sessão de desenvolvimento');

  if (aborted()) return finish('aborted', knowledge, false, 'aborted before the first epoch');

  let bootstrapped = false;
  if (!knowledge.present && !dev.skipKnowledgeBootstrap) {
    log(
      'warn',
      'no knowledge system found — knowledge bootstrap is not available in v3.0 (jcode/deepseek backend). The planner will plan from whatever the knowledge phase can gather.',
    );
  }

  const knowledgeSummary = summarizeKnowledge(knowledge);
  const plan_ = args.planner ?? planEpoch;
  const planKnowledge_ = args.knowledgePlanner ?? planKnowledge;

  /**
   * The critic's executable anchor for one epoch. Persisted on first
   * successful extraction: the `build-test-commands` baseline gap is only
   * asked in epoch 1, so without this every epoch ≥ 2 silently compiled with
   * no commands at all. Falls back to the LATEST brief that has them, so a
   * session resumed from an older state file still finds epoch 1's.
   */
  const verifyCommandsForEpoch = (epoch: number): DevVerifyCommands | undefined => {
    if (isUsableVerifyCommands(state.verifyCommands)) return state.verifyCommands;
    for (let e = epoch; e >= 1; e--) {
      const extraction = extractVerifyCommands(cwd, paths, e);
      if (!extraction) continue;
      for (const warning of extraction.warnings) {
        log('warn', `epoch ${epoch} verify commands: ${warning}`);
      }
      state.verifyCommands = extraction.commands;
      return extraction.commands;
    }
    return undefined;
  };

  /**
   * Write the epoch's compiled graph to `paths.pipeline(epoch)` and COMMIT it.
   *
   * The compiled pipeline is the epoch's PORTABLE artefact — reusable, editable
   * and auditable, which is what huu claims for every other pipeline. It is
   * also huu-written, so huu commits it: an uncommitted file under `.huu/`
   * leaves the tree dirty and the landing merge refuses. A write that fails is
   * a warning, never a stop — losing the audit copy must not lose the epoch.
   *
   * Shared by BOTH compilers (the planner's `compileEpochPipeline` and the
   * drawing's `compileGraphPipeline`) so the artefact, the commit and the
   * `pendingEpoch` pointer that resumes it cannot drift between the two paths.
   */
  const persistPipeline = async (epoch: number, pipeline: Pipeline): Promise<string> => {
    const pipelinePath = paths.pipeline(epoch);
    let extras: string[] = [];
    try {
      writeFileEnsuringDir(join(cwd, pipelinePath), `${JSON.stringify(pipeline, null, 2)}\n`);
      extras = [pipelinePath];
    } catch (err) {
      log('warn', `epoch ${epoch}: could not persist the compiled pipeline: ${message_(err)}`);
    }
    await persist(`chore(huu-dev): época ${epoch} — pipeline compilado`, extras);
    return pipelinePath;
  };

  /**
   * PHASE C — run the planned graph, land it, record what it actually did.
   *
   * Extracted so it has TWO entry points: the ordinary one, right after the
   * planner compiled a fresh graph, and the RESUME one, which reads the graph
   * back off disk. The compiled pipeline was always persisted as a portable
   * artefact; before this it was only ever auditable, never reusable, so a
   * crash between the plan and the record threw away the expensive half of the
   * epoch and re-bought it.
   *
   * Returns a `stop` when the session must end here (only the abort path does),
   * and a `failure` for the circuit breaker to count. Never throws.
   */
  const runPlannedEpoch = async (
    pipeline: Pipeline,
    epoch: number,
    knowledgeCost: number,
    meta: { epochGoal: string; frontIds: string[] },
  ): Promise<{
    stop?: DevModeResult;
    failure?: { reason: 'run-failed' | 'landing-failed'; detail: string };
  }> => {
  // --- Phase C: execution ---------------------------------------------
  emit({ type: 'epoch-start', epoch, pipeline: pipeline });
  const startedAt = nowIso();

  const run = await runPipeline(pipeline, epoch, 'work');
  let runStatus: DevEpochRecord['status'] = run.ok ? 'done' : 'error';
  // Abort wins over whatever the manifest claims.
  if (run.interrupted || aborted()) runStatus = 'aborted';

  const record: DevEpochRecord = {
    epoch,
    runId: run.runId,
    epochGoal: meta.epochGoal,
    frontIds: meta.frontIds,
    status: runStatus,
    startedAt,
    finishedAt: nowIso(),
  };
  // BOTH runs — the epoch is what it cost, and the knowledge run is not free.
  const costUsd = knowledgeCost + (run.totalCost ?? 0);
  if (costUsd > 0) record.costUsd = costUsd;

  // Sweep huu's OWN housekeeping before landing. `Orchestrator.start()`
  // writes `.gitignore` (worktree dir, run logs, .env.huu, agent bin), which
  // leaves the tree dirty — and `landEpoch` refuses to merge onto a dirty
  // tree. Committing it here is huu owning what huu wrote.
  await persist(`chore(huu-dev): manutenção antes de aterrissar a época ${epoch}`);

  if (runStatus === 'aborted') {
    // An ABORTED epoch is NOT landed. Its agents were cut mid-flight, so
    // whatever merged is partial and no judge ever saw it — exactly the
    // state the user pressed stop to avoid. The work is not lost: it stays
    // on the integration branch, and we name it so they can land it by hand.
    record.landingError = unlandedDetail(run.branch, 'aborted');
    const abortedEvidence = collectEpochEvidence({
      epoch,
      state: run.state,
      landing: { landed: false, error: record.landingError },
      report: readEpochReportFor(cwd, paths, epoch),
      diffStat: '',
    });
    record.evidence = abortedEvidence;
    delete state.pendingEpoch;
    // An aborted epoch measured LESS, not nothing — the cards that already
    // went through the critic still carry their numbers.
    log('info', formatInstrumentationLine(epoch, abortedEvidence.instrumentation));
    epochs.push(record);
    emit({ type: 'epoch-done', record });
    await persist(`chore(huu-dev): época ${epoch} abortada`);
    return { stop: finish('aborted', knowledge, bootstrapped, record.landingError) };
  }

  // Land even a FAILED epoch: partial work that merged into the integration
  // branch is still work, and the next planner needs to see it on disk. An
  // aborted one is different — see above.
  const headBefore = await safeHead(git, cwd);
  let landing: LandEpochResult;
  if (run.branch) {
    landing = await landEpoch({ cwd, integrationBranch: run.branch, epoch });
    if (landing.landed && !landing.alreadyUpToDate) {
      record.landedCommit = landing.commit;
    } else if (landing.alreadyUpToDate) {
      record.landingError = `epoch ${epoch} landing produced no new commits (the integration branch was already contained in HEAD)`;
    } else {
      record.landingError = landing.error;
    }
  } else {
    landing = { landed: false, error: 'the epoch produced no integration branch' };
    record.landingError = landing.error;
  }

  // Evidence is collected AFTER landing: the diff stat is the range the
  // landing actually produced, and the report only reaches this checkout
  // through the landing merge.
  const evidence = collectEpochEvidence({
    epoch,
    state: run.state,
    landing,
    report: readEpochReportFor(cwd, paths, epoch),
    diffStat: await readLandedDiffStat(git, headBefore, landing.commit),
  });

  // Declared-ownership partition check, AFTER the landing: the T-*.md specs
  // are written DURING the run by the front recons, so they only exist in
  // this checkout once the epoch landed (checking earlier scanned a
  // directory that had none — the check was structurally dead). Advisory on
  // purpose: violations are recorded as epoch evidence and logged, never
  // blocked on; the blocking role moves to a compiled step in a later wave.
  // RECONCILIATION pass. The run itself now reports collisions BEFORE its
  // fan-out (`OrchestratorState.declaredWriteCollisions` → the evidence
  // above), which is both earlier and cross-front. This scan stays for the
  // cases that check cannot reach: an epoch whose specs were written but
  // never fanned out, and a run whose state was lost. It therefore only
  // fills the field when the run reported nothing.
  //
  // A DRAWN epoch scans an empty directory here, on purpose: its task specs
  // live under `.huu/findings/<axis>/`, and re-aiming this at them would read
  // ACROSS epochs. `scanSpecs`'s own doc carries the full argument, and the
  // run-level collision check above still covers the drawn path.
  const landedSpecs = scanSpecs(join(cwd, paths.epochDir(epoch)));
  if (landedSpecs.length > 0 && evidence.declaredPartitionViolations === undefined) {
    const partition = checkWritePartition(landedSpecs);
    if (!partition.ok) {
      evidence.declaredPartitionViolations = partition.violations.slice(0, MAX_VIOLATION_TASKS);
      log('warn', `epoch ${epoch}: ${formatWritePartitionViolations(partition.violations)}`);
    }
  }
  record.evidence = evidence;

  // The four numbers the research came back empty on, once per epoch, in the
  // operator log. Without this line the measurement exists only inside
  // `state.json` — and a number nobody reads changes no decision.
  log('info', formatInstrumentationLine(epoch, evidence.instrumentation));

  // The epoch is RECORDED, so it is no longer in flight. Cleared before the
  // persist below, so what lands on disk already reflects that.
  delete state.pendingEpoch;
  epochs.push(record);
  emit({ type: 'epoch-done', record });
  await persist(`chore(huu-dev): época ${epoch} — ${meta.epochGoal}`.slice(0, 200));
    const failure: { reason: 'run-failed' | 'landing-failed'; detail: string } | undefined =
      runStatus !== 'done'
        ? {
            reason: 'run-failed',
            detail: `epoch ${epoch} ended with status "${runStatus}" (run ${run.runId || 'unknown'})`,
          }
        : record.landingError !== undefined
          ? { reason: 'landing-failed', detail: record.landingError }
          : undefined;
    return failure ? { failure } : {};
  };

  // --- Phase 1..N: the epochs --------------------------------------------
  //
  // The ceiling counts epochs from where this session STARTS, so `--epochs=3`
  // on a resumed session still means "three more epochs".
  //
  // Circuit-breaker state: CONSECUTIVE failed epochs — an epoch fails when its
  // execution run errors or it ends without a `landedCommit`. A clean landed
  // epoch resets the count; an abort is never a failure. The budget is per
  // session: a resumed session starts fresh, because continuing one is itself
  // a human decision.
  let consecutiveEpochFailures = 0;
  let lastEpochFailure: { reason: 'run-failed' | 'landing-failed'; detail: string } | undefined;
  for (let epoch = startEpoch; epoch < startEpoch + maxEpochs; epoch++) {
    if (aborted()) {
      return finish('aborted', knowledge, bootstrapped, `aborted after ${epochs.length} epoch(s)`);
    }

    // Requested BETWEEN epochs, so everything the last epoch merged is landed
    // and recorded. This is the exit a human reaches for; the hard abort above
    // is the one they reach for when something is wrong.
    if (stopRequested()) {
      return finish(
        'graceful-stop',
        knowledge,
        bootstrapped,
        `stopped by request after ${epochs.length} epoch(s), with everything landed`,
      );
    }

    // The breaker is checked BEFORE the epoch burns a planner call: this many
    // failures in a row is a failure that is not recovering, and retrying it
    // is exactly the waste the protection exists to stop.
    if (consecutiveEpochFailures >= MAX_CONSECUTIVE_EPOCH_FAILURES) {
      log(
        'warn',
        `circuit breaker (MAX_CONSECUTIVE_EPOCH_FAILURES=${MAX_CONSECUTIVE_EPOCH_FAILURES}): ${consecutiveEpochFailures} consecutive epoch failure(s) — stopping the session instead of burning more runs`,
      );
      return finish(
        'consecutive-failures',
        knowledge,
        bootstrapped,
        `${consecutiveEpochFailures} consecutive epochs failed — last: ${lastEpochFailure?.detail ?? 'unknown'}`,
      );
    }
    // The dollar ceiling, checked in the SAME place and for the same reason as
    // the failure breaker: before the epoch burns a planner call. Between
    // epochs rather than inside one — aborting a live swarm to save money loses
    // the work and still pays for the tokens already spent.
    if (dev.maxCostUsd !== undefined && dev.maxCostUsd > 0) {
      const spent = epochs.reduce((sum, e) => sum + (e.costUsd ?? 0), 0);
      if (spent >= dev.maxCostUsd) {
        return finish(
          'cost-ceiling',
          knowledge,
          bootstrapped,
          `spent $${spent.toFixed(2)} of the $${dev.maxCostUsd.toFixed(2)} ceiling after ${epochs.length} epoch(s) — stopping before epoch ${epoch}`,
        );
      }
    }
    // RESUMED EPOCH: its plan already exists on disk as a committed artefact,
    // so Phases A and B are skipped entirely and Phase C re-runs the persisted
    // graph. Consumed once — a second failure of the same epoch replans, which
    // is the right escalation: re-running a plan that just died twice is how a
    // session loops.
    const resuming = resumePending?.epoch === epoch ? resumePending : undefined;
    resumePending = undefined;
    if (resuming) {
      const restored = readPersistedPipeline(cwd, resuming.pipelinePath);
      if (restored) {
        log(
          'info',
          `epoch ${epoch}: resuming the EXECUTION run from the persisted plan (${resuming.pipelinePath}) — knowledge and planning are not re-bought`,
        );
        const resumedOutcome = await runPlannedEpoch(restored.pipeline, epoch, 0, {
          epochGoal: resuming.epochGoal,
          frontIds: resuming.frontIds,
        });
        if (resumedOutcome.stop) return resumedOutcome.stop;
        if (resumedOutcome.failure) {
          consecutiveEpochFailures++;
          lastEpochFailure = resumedOutcome.failure;
        } else {
          consecutiveEpochFailures = 0;
          lastEpochFailure = undefined;
        }
        continue;
      }
      log(
        'warn',
        `epoch ${epoch}: the persisted plan at ${resuming.pipelinePath} could not be read — planning it again`,
      );
    }

    // ═══ THE DRAWN METHOD ══════════════════════════════════════════════════
    //
    // Phases A and B do not run here. Not "are skipped to save money" — they
    // have nothing to do. Phase B writes a plan, and the plan already exists:
    // a human drew it. Phase A exists to brief the thing that writes the plan,
    // and there is no such thing in this session. What survives untouched is
    // everything AFTER the run: the landing merge, the epoch evidence, the
    // blackboard commit. A graph changes who decides the topology, not what
    // huu does with the result.
    //
    // PHASE 0 IS NOT ONE OF THEM, AND IT DOES RUN. The knowledge gate sits
    // upstream of this whole loop: on a repo with no agent skills and no
    // `skipKnowledgeBootstrap`, a graph session bootstraps the skill system
    // FIRST — a real jcode agent writing real files into the repo, committed
    // before a single box of the drawing compiles, and a failure there stops
    // the session with `bootstrap-failed` before the graph is ever touched.
    // That is deliberate, not an oversight: `routerPrefix` below is only sent
    // when `knowledge.present`, so every node's prompt loses its routing when
    // Phase 0 is skipped. "Phases A and B do not happen" was always true and
    // was always being read as "nothing runs before the drawing"; it is not.
    // `dev-driver.test.ts` pins it.
    if (drawnMethod) {
      // Kept so the surfaces' state machine stays coherent — `dev-manager.ts`
      // clears its plan panel on this event and sets the current epoch. On this
      // path it means "compiling the drawing", not "asking a model", and the
      // `planned` event that follows arrives in the same tick.
      emit({ type: 'planning', epoch });

      // BOTH namespaces carry the EPOCH, not just the session. A drawing always
      // ends `goalComplete: false`, so re-running the same objective is offered
      // a resume, and an accepted resume runs the same drawing again as epoch
      // N+1 inside the SAME session id. Sharing one namespace across those runs
      // means epoch 1's committed target list is exactly what epoch 2's fan-out
      // reads when epoch 2's producer fails — a swarm dispatched over stale
      // work, with real worktrees and real cost.
      const graphRoot = devGraphRoot(sessionId, epoch);
      const fanOutNamespace = devGraphFanOutNamespace(sessionId, epoch);
      let compiled: CompiledGraph;
      try {
        compiled = compileGraphPipeline({
          graph: drawnMethod,
          goal: dev.goal,
          graphRoot,
          sessionId: fanOutNamespace,
          // `modelId` is deliberately NOT forwarded. Passing `config.modelId`
          // would stamp an explicit id on EVERY emitted step and end
          // `AppConfig.modelId`'s job as the single authority — the same reason
          // a role nobody routed omits the field on the planner path. Omitted,
          // the graph's own `meta.modelId` and each node's `modelId` still win,
          // which is where a DRAWING says routing.
          cardTimeoutMs: args.cardTimeoutMs,
          singleFileCardTimeoutMs: args.singleFileCardTimeoutMs,
          routerPrefix: knowledge.present ? ROUTER_PREFIX : undefined,
        });
      } catch (err) {
        // `resolveDevGraph` already ran the non-throwing validator before the
        // session opened, so reaching this catch means the compiler refused its
        // OWN output (its documented second gate) — a compiler bug, not a
        // drawing the human can fix by moving a box. Either way there is
        // nothing to route around: it is a stop, never a fallback to a planner.
        return finish('graph-invalid', knowledge, bootstrapped, `epoch ${epoch}: ${message_(err)}`);
      }

      const graphWarnings = [...compiled.warnings, ...graphSessionWarnings];
      for (const warning of graphWarnings) log('warn', `epoch ${epoch} graph: ${warning}`);

      const graphPlan = graphDevPlan(drawnMethod, compiled);
      state.doneWhen = graphPlan.doneWhen;
      const announcement: DevGraphAnnouncement = {
        id: drawnMethod.id,
        name: drawnMethod.name,
        ...(drawnMethod.description !== undefined ? { description: drawnMethod.description } : {}),
        nodeOrder: compiled.nodeOrder,
        stepsByNode: compiled.stepsByNode,
        graphRoot,
      };
      emit({ type: 'planned', epoch, plan: graphPlan, warnings: graphWarnings, graph: announcement });

      // The gate still gates, and it still fails CLOSED. A method the human
      // drew last week is not automatically the method they want run right now
      // against this goal — and `each-epoch` with nobody wired to answer must
      // mean "no", exactly as it does on the planner path.
      if (dev.approval === 'each-epoch') {
        const approved = await Promise.resolve(args.onApprove?.(graphPlan, epoch, graphWarnings) ?? false);
        if (!approved) {
          return finish(
            'plan-rejected',
            knowledge,
            bootstrapped,
            `epoch ${epoch}: the drawn method "${drawnMethod.id}" was not approved`,
          );
        }
      }
      if (aborted()) {
        return finish('aborted', knowledge, bootstrapped, `aborted before epoch ${epoch} started`);
      }

      const graphPipelinePath = await persistPipeline(epoch, compiled.pipeline);
      // Same in-flight pointer the planner path sets: a crash from here on
      // resumes the EXECUTION from the persisted graph instead of recompiling.
      // It costs nothing to support and it is strictly the same artefact.
      state.pendingEpoch = {
        epoch,
        pipelinePath: graphPipelinePath,
        epochGoal: graphPlan.epochGoal,
        frontIds: compiled.nodeOrder,
      };
      const graphOutcome = await runPlannedEpoch(compiled.pipeline, epoch, 0, {
        epochGoal: graphPlan.epochGoal,
        frontIds: compiled.nodeOrder,
      });
      if (graphOutcome.stop) return graphOutcome.stop;
      if (graphOutcome.failure) {
        consecutiveEpochFailures++;
        lastEpochFailure = graphOutcome.failure;
      } else {
        consecutiveEpochFailures = 0;
        lastEpochFailure = undefined;
      }
      continue;
    }

    emit({ type: 'planning', epoch });

    const previousEvidence = epochs.length > 0 ? epochs[epochs.length - 1]!.evidence : undefined;

    // --- Phase A: knowledge ---------------------------------------------
    let knowledgeRequest: KnowledgeRequest;
    try {
      knowledgeRequest = await planKnowledge_({
        goal: dev.goal,
        epoch,
        knowledgeSummary,
        history: epochs,
        previousEvidence,
        apiKey: config.apiKey,
        modelId: models.planner,
        llmContext: llmContextFor(config),
      });
    } catch (err) {
      // An orchestrator that cannot even produce a schema-valid QUESTION is
      // not one whose plan should run a swarm.
      return finish('planner-failed', knowledge, bootstrapped, `epoch ${epoch} knowledge request: ${message_(err)}`);
    }

    if (aborted()) {
      return finish('aborted', knowledge, bootstrapped, `aborted while planning epoch ${epoch}`);
    }

    // ZERO gaps is a decision, not a defect: the orchestrator is saying it
    // already knows enough, and huu honors it by skipping Phase A entirely.
    // The baseline gaps are a FLOOR UNDER A REQUEST, not a reason to
    // manufacture one nobody made — and this is also what keeps a `--stub`
    // session at one run per epoch (the stub backend cannot answer a question:
    // it writes no files).
    const merged =
      knowledgeRequest.gaps.length === 0
        ? { gaps: [] as KnowledgeGap[], warnings: [] as string[] }
        : mergeBaselineGaps(
            knowledgeRequest,
            epoch,
            DEV_MAX_GAPS,
            dev.methodology?.fitnessFunctions === true ? [FITNESS_COMMANDS_GAP] : [],
          );
    for (const warning of merged.warnings) {
      log('warn', `epoch ${epoch} knowledge request repaired: ${warning}`);
    }

    let briefPack: string | undefined;
    let knowledgeCost = 0;
    if (merged.gaps.length === 0) {
      log('info', `epoch ${epoch}: the orchestrator declared no knowledge gaps — planning straight away`);
    } else {
      let writtenPaths: string[];
      let knowledgePipeline: Pipeline;
      try {
        // huu writes the gap specs AND the memory index in TypeScript, from
        // one list. An agent asked to write both can miss the contract in a
        // dozen ordinary ways, and `resolveMemoryFiles` does not merely drop a
        // path that is missing — when a non-empty list resolves to nothing it
        // THROWS, which kills the run.
        writtenPaths = writeKnowledgeGaps({
          cwd,
          paths,
          epoch,
          gaps: merged.gaps,
          goal: dev.goal,
          knowledge,
        }).writtenPaths;
        knowledgePipeline = compileKnowledgePipeline({
          gaps: merged.gaps,
          epoch,
          goal: dev.goal,
          paths,
          knowledgeSummary,
          // The whole phase IS the retrieval the orchestrator delegates, so it
          // runs on the `recon` role. Unset ⇒ the field is omitted and the run
          // model applies, exactly as today.
          ...(() => {
            const recon = pickModelRoute(
              dev.models?.recon,
              isKnownModel,
            )?.model;
            return recon ? { subagentModelId: recon } : {};
          })(),
          // Only `chainOfVerification` reads this — every other option shapes
          // Phase C. Passed whole so the compiler stays the one place that
          // decides which flags reach the knowledge graph.
          ...(dev.methodology ? { methodology: dev.methodology } : {}),
          cardTimeoutMs: args.cardTimeoutMs,
          singleFileCardTimeoutMs: args.singleFileCardTimeoutMs,
          routerPrefix: knowledge.present ? ROUTER_PREFIX : undefined,
        }).pipeline;
      } catch (err) {
        return finish('knowledge-failed', knowledge, bootstrapped, `epoch ${epoch}: ${message_(err)}`);
      }

      // COMMITTED BEFORE THE RUN, and that is a correctness requirement rather
      // than tidiness: the fan-out resolves `filesFrom` out of the INTEGRATION
      // worktree, which branches from HEAD. An uncommitted spec does not exist
      // there, and a list whose entries all vanish makes `resolveMemoryFiles`
      // throw — killing the run.
      await persist(
        `chore(huu-dev): época ${epoch} — ${merged.gaps.length} lacuna(s) de conhecimento`,
        writtenPaths,
      );

      if (aborted()) {
        return finish('aborted', knowledge, bootstrapped, `aborted before the knowledge run of epoch ${epoch}`);
      }

      emit({ type: 'epoch-start', epoch, pipeline: knowledgePipeline });
      const run = await runPipeline(knowledgePipeline, epoch, 'knowledge');
      knowledgeCost = run.totalCost ?? 0;

      if (run.interrupted || aborted()) {
        return finish(
          'aborted',
          knowledge,
          bootstrapped,
          unlandedDetail(run.branch, `aborted during the knowledge run of epoch ${epoch}`),
        );
      }

      await persist(`chore(huu-dev): manutenção antes de aterrissar o conhecimento da época ${epoch}`);

      if (run.branch) {
        const landing = await landEpoch({ cwd, integrationBranch: run.branch, epoch });
        if (!landing.landed) {
          return finish('landing-failed', knowledge, bootstrapped, `epoch ${epoch} knowledge run: ${landing.error}`);
        }
        if (landing.alreadyUpToDate) {
          log('warn', `epoch ${epoch} knowledge landing: no new commits (already up-to-date)`);
        }
      } else {
        log('warn', `epoch ${epoch}: the knowledge run produced no integration branch — nothing to land`);
      }

      // Forward default, deliberately: a knowledge run that failed still
      // usually landed SOME briefs, and `readKnowledgeDigest` falls back to the
      // raw shards. Planning on a thin briefing beats losing the session.
      if (!run.ok) {
        log('warn', `epoch ${epoch}: the knowledge run did not complete — planning continues on whatever landed`);
      }

      // The gap list is passed so the digest can be CHECKED: a consolidation
      // step that silently dropped a gap used to reach the planner as a
      // confident-looking document with a hole in it, and the planner cannot
      // tell a missing section from a verified "nothing here".
      briefPack =
        readKnowledgeDigest(cwd, paths, epoch, dev.knowledgeDigestMaxChars, merged.gaps) || undefined;
      log(
        'info',
        briefPack
          ? `epoch ${epoch}: knowledge digest is ${briefPack.length} chars over ${merged.gaps.length} gap(s)`
          : `epoch ${epoch}: NO knowledge digest and no briefs landed — the planner gets nothing about this repo`,
      );

      // Back to planning: the run frames the surfaces just showed were the
      // knowledge phase, not the epoch's work.
      emit({ type: 'planning', epoch });
    }

    if (aborted()) {
      return finish('aborted', knowledge, bootstrapped, `aborted while planning epoch ${epoch}`);
    }

    // Everything EARLIER epochs established, deduped by gap with the newest
    // answer winning. Budgeted separately and smaller than the epoch's own
    // digest: it is standing knowledge, and it must never crowd out the fresh
    // briefing it exists to complement.
    const accumulatedPack =
      epoch > 1
        ? assembleAccumulatedKnowledge(
            readAccumulatedBriefs(cwd, paths, epoch - 1),
            Math.floor((dev.knowledgeDigestMaxChars ?? KNOWLEDGE_DIGEST_MAX_CHARS) * 0.4),
          )
        : '';
    if (accumulatedPack) {
      log(
        'info',
        `epoch ${epoch}: ${accumulatedPack.length} chars of knowledge carried forward from earlier epochs`,
      );
    }

    // --- Phase B: the plan ----------------------------------------------
    let plan: DevPlan;
    try {
      plan = await plan_({
        goal: dev.goal,
        epoch,
        briefPack,
        ...(accumulatedPack ? { accumulatedPack } : {}),
        knowledgeSummary,
        history: epochs,
        previousEvidence,
        previousReport: epoch > 1 ? readEpochReportFor(cwd, paths, epoch - 1) : undefined,
        ...(knowledgeRequest.planningNotes?.trim()
          ? { planningNotes: knowledgeRequest.planningNotes }
          : {}),
        ...(dev.methodology ? { methodology: dev.methodology } : {}),
        maxFronts,
        apiKey: config.apiKey,
        modelId: models.planner,
        llmContext: llmContextFor(config),
      });
    } catch (err) {
      return finish('planner-failed', knowledge, bootstrapped, `epoch ${epoch}: ${message_(err)}`);
    }

    if (aborted()) {
      return finish('aborted', knowledge, bootstrapped, `aborted while planning epoch ${epoch}`);
    }

    const previousDoneWhen = state.doneWhen;
    state.doneWhen = plan.doneWhen;

    if (plan.goalComplete) {
      if (epoch === 1) {
        log('warn', `epoch 1: the planner reported goalComplete on the first epoch — refusing; goalComplete requires corroboration from at least one executed epoch`);
      } else {
        state.goalComplete = true;
        await persist(`chore(huu-dev): objetivo concluído após ${epochs.length} época(s)`);
        log('info', `planner reports the goal is already satisfied: ${plan.doneWhen}`);
        return finish('goal-complete', knowledge, bootstrapped);
      }
    }

    if (plan.fronts.length === 0) {
      return finish('empty-plan', knowledge, bootstrapped, `epoch ${epoch}: the planner emitted no fronts and did not declare the goal complete`);
    }

    const verifyCommands = verifyCommandsForEpoch(epoch);

    let compiled;
    try {
      compiled = compileEpochPipeline({
        plan,
        epoch,
        goal: dev.goal,
        knowledgeSummary,
        maxFronts,
        cardTimeoutMs: args.cardTimeoutMs,
        singleFileCardTimeoutMs: args.singleFileCardTimeoutMs,
        ...(() => {
          // The compiler stamps ONE id per step, so a chain must collapse to
          // its surviving rung before it gets there — a step carrying
          // "a, b" as its modelId would fail in the factory, which is exactly
          // the failure the chain exists to prevent.
          const collapsed = collapseDevModelPolicy(
            dev.models,
            isKnownModel,
          );
          return collapsed ? { models: collapsed } : {};
        })(),
        sessionId,
        ...(verifyCommands ? { verifyCommands: flattenVerifyCommands(verifyCommands) } : {}),
        ...(dev.methodology ? { methodology: dev.methodology } : {}),
        ...(verifyCommands && verifyCommands.lint.length > 0
          ? { lintCommands: [...verifyCommands.lint] }
          : {}),
        ...(verifyCommands && verifyCommands.test.length > 0
          ? { testCommands: [...verifyCommands.test] }
          : {}),
        // Detected, never assumed: `changelogGate`'s critic half names a real
        // file back to the agent, so a project without one gets the
        // commit-format gate and no invented demand. Probed per epoch — an
        // earlier epoch may have created the surface.
        ...(dev.methodology?.changelogGate === true
          ? { changelogPaths: detectChangelogPaths(cwd) }
          : {}),
        ...(verifyCommands && (verifyCommands.fitness?.length ?? 0) > 0
          ? { fitnessCommands: [...verifyCommands.fitness!] }
          : {}),
        routerPrefix: knowledge.present ? ROUTER_PREFIX : undefined,
      });
    } catch (err) {
      return finish('planner-failed', knowledge, bootstrapped, `epoch ${epoch}: ${message_(err)}`);
    }

    for (const warning of compiled.warnings) log('warn', `epoch ${epoch} plan repaired: ${warning}`);
    emit({ type: 'planned', epoch, plan, warnings: compiled.warnings });

    // Gate augmentations: doneWhen drift and restatedGoal comprehension check
    const doneWhenChanged = previousDoneWhen.length > 0 && previousDoneWhen !== plan.doneWhen;
    if (doneWhenChanged) {
      log('warn', `epoch ${epoch}: doneWhen changed — was "${previousDoneWhen.slice(0, 80)}${previousDoneWhen.length > 80 ? '…' : ''}", now "${plan.doneWhen.slice(0, 80)}${plan.doneWhen.length > 80 ? '…' : ''}"`);
    }
    if (knowledgeRequest.restatedGoal) {
      log('info', `epoch ${epoch}: restatedGoal: ${knowledgeRequest.restatedGoal.slice(0, 120)}${knowledgeRequest.restatedGoal.length > 120 ? '…' : ''}`);
    }
    const gateWarnings = [
      ...compiled.warnings,
      ...(doneWhenChanged ? [`doneWhen changed from "${previousDoneWhen.slice(0, 80)}${previousDoneWhen.length > 80 ? '…' : ''}" to "${plan.doneWhen.slice(0, 80)}${plan.doneWhen.length > 80 ? '…' : ''}"`] : []),
      ...(knowledgeRequest.restatedGoal ? [`restatedGoal: ${knowledgeRequest.restatedGoal}`] : []),
    ];

    if (dev.approval === 'each-epoch') {
      const approved = await Promise.resolve(args.onApprove?.(plan, epoch, gateWarnings) ?? false);
      if (!approved) {
        return finish('plan-rejected', knowledge, bootstrapped, `epoch ${epoch} plan was not approved`);
      }
    }
    if (aborted()) {
      return finish('aborted', knowledge, bootstrapped, `aborted before epoch ${epoch} started`);
    }

    // The compiled graph is the epoch's PORTABLE artefact — see
    // {@link persistPipeline}, shared with the drawn-method path.
    const pipelinePath = await persistPipeline(epoch, compiled.pipeline);

    // --- Phase C: execution ---------------------------------------------
    //
    // The plan is on disk and committed; record the epoch as IN FLIGHT so a
    // crash from here on resumes the execution instead of re-planning it.
    state.pendingEpoch = {
      epoch,
      pipelinePath,
      epochGoal: plan.epochGoal,
      frontIds: compiled.frontOrder,
    };
    const outcome = await runPlannedEpoch(compiled.pipeline, epoch, knowledgeCost, {
      epochGoal: plan.epochGoal,
      frontIds: compiled.frontOrder,
    });
    if (outcome.stop) return outcome.stop;
    const failure = outcome.failure;

    // Circuit-breaker accounting. A failed epoch no longer stops the session
    // by itself: whatever merged landed above, the next planner sees it on
    // disk, and one bad epoch is often just a bad epoch. What must never
    // happen is the incident behind Claude Code's
    // MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES — sessions retrying a failure that
    // never recovers, burning API calls forever. So failures defer the stop:
    // the session ends when the breaker trips at the top of the loop, or when
    // the ceiling arrives with the last epoch(s) failed (reported just after
    // the loop). A run error counts even when its partial work landed; the
    // reset requires a CLEAN landed epoch.
    if (failure) {
      consecutiveEpochFailures++;
      lastEpochFailure = failure;
      log(
        'warn',
        `epoch ${epoch} failed — ${consecutiveEpochFailures} consecutive failure(s); the circuit breaker stops the session at ${MAX_CONSECUTIVE_EPOCH_FAILURES}`,
      );
      continue;
    }
    consecutiveEpochFailures = 0;
    lastEpochFailure = undefined;
  }

  // The ceiling with the last epoch(s) failed reports that failure, not the
  // ceiling: 'max-epochs' claims a healthy chain (and maps to exit 0). These
  // are the two finishes the circuit breaker deferred from inside the loop.
  if (lastEpochFailure) {
    return finish(lastEpochFailure.reason, knowledge, bootstrapped, lastEpochFailure.detail);
  }

  // `max-epochs` is the CLEAN end of a graph session, not a ceiling it bumped
  // into: the drawing ran, so the method the human underwrote is finished. It
  // is also already in the CLI's `CLEAN_STOPS`, which is what keeps a graph
  // session exiting 0 without teaching every surface a new reason.
  return finish(
    'max-epochs',
    knowledge,
    bootstrapped,
    drawnMethod
      ? `the drawn method "${drawnMethod.id}" ran end to end — a devgraph is the COMPLETE method, so a graph session is exactly one epoch`
      : unboundedEpochs
        ? `stopped at the ${maxEpochs}-epoch safety backstop without the planner ever reporting the goal complete — inspect \`${devPaths.journal}\` before starting another session`
        : `reached the ${maxEpochs}-epoch ceiling`,
  );
}

/** Adapts a real `Orchestrator` to the slice the driver uses. */
function wrapOrchestrator(orch: Orchestrator): DevRunHandle {
  return {
    subscribe: (listener) => orch.subscribe(listener),
    start: () => orch.start(),
    abort: () => orch.abort(),
    setGreedy: () => orch.enableGreedyMode(),
  };
}

/**
 * Read a persisted epoch graph back off disk and VALIDATE it.
 *
 * The file is huu-written and committed, but it is also plain JSON in the
 * user's repository and a resume is exactly when it may have been edited (by
 * hand, or by a merge). It therefore goes through the same `PipelineSchema` a
 * run performs at load time; anything that fails simply reads as "no persisted
 * plan" and the epoch is planned again. Never throws.
 */
function readPersistedPipeline(
  cwd: string,
  pipelinePath: string,
): { pipeline: Pipeline } | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(cwd, pipelinePath), 'utf8'));
    const parsed = PipelineSchema.safeParse(raw);
    return parsed.success ? { pipeline: parsed.data as Pipeline } : null;
  } catch {
    return null;
  }
}

async function safeHead(git: GitClient, cwd: string): Promise<string | undefined> {
  try {
    return await git.getHead(cwd);
  } catch {
    return undefined;
  }
}

function message_(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Shape guard for the PERSISTED verify commands — `readDevState` casts without
 * validating, and a hand-edited state file must not be able to crash the
 * compiler with a `verifyCommands` that is not what huu wrote.
 */
function isUsableVerifyCommands(value: DevVerifyCommands | undefined): value is DevVerifyCommands {
  return (
    value !== undefined &&
    Array.isArray(value.all) &&
    value.all.length > 0 &&
    value.all.every((command) => typeof command === 'string' && command.trim().length > 0)
  );
}

/**
 * Map an {@link AppConfig} onto the PROVIDER-aware context the planner's chat
 * client needs.
 *
 * `provider` is carried through and the key travels in the neutral `apiKey`
 * field. The old shape (`deepseekApiKey`) was honored by `buildChatClient`
 * only when the resolved provider was `deepseek`, so an OpenRouter dev session
 * would have thrown "API key missing" while holding the right key.
 */
export function llmContextFor(config: AppConfig): LlmClientContext {
  const backend = config.backend ?? 'jcode';
  return {
    backend,
    provider: resolveRunProvider(backend, config.provider),
    apiKey: config.apiKey,
  };
}

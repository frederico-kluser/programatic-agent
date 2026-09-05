// Development mode for the web front-end.
//
// Design choice worth naming: this manager does NOT reimplement the kanban.
// Each epoch is an ordinary `Orchestrator` run, so the manager pushes a normal
// `RunSnapshot` into the SAME broadcast sink `WebRunManager` uses — the
// browser's existing board renders an epoch with zero client work. What rides
// its own `{type:'dev'}` frame is only what the board cannot express: the
// goal, the knowledge probe, the epoch chain, and the approval gate.
//
// One session at a time, on purpose: every epoch ends in a merge into the
// user's working branch, and two concurrent sessions on one repo would race
// that merge. Concurrency inside a session is the swarm's job.

import { readFileSync } from 'node:fs';
import { resolve as resolvePath, sep } from 'node:path';
import { Orchestrator } from '../orchestrator/index.js';
import type { AgentOutputChunk } from '../orchestrator/types.js';
import { selectBackend, type AgentBackendKind } from '../orchestrator/backends/registry.js';
import { apiKeySpecNameForProvider, resolveRunProvider } from '../lib/providers.js';
import { findSpec } from '../lib/api-key.js';
import { createKeyPoolHandle, type KeyPoolHandle } from '../lib/api-key-pool.js';
import { generateRunId } from '../lib/run-id.js';
import {
  resolveDevGraph,
  runDevMode,
  type DevEvent,
  type DevGraphAnnouncement,
  type DevRunPhase,
  type DevStopReason,
  type OrphanAction,
} from '../lib/dev-mode/dev-driver.js';
import type { DevGraph } from '../lib/dev-graph/graph-types.js';
import type { OrphanBranch } from '../lib/dev-mode/orphan-branches.js';
import {
  buildDebateTranscript,
  findDebateSteps,
  type DebateRole,
  type DebateTranscript,
} from '../lib/dev-mode/debate-transcript.js';
import { integrationWorktreePath } from '../git/branch-namer.js';
import { activeMethodologies } from '../lib/dev-mode/methodology-registry.js';
import { devModelProviderIndex } from '../lib/dev-mode/model-catalog-index.js';
import {
  checkDevModelPolicy,
  defaultDevModelPolicy,
  devModelRefusals,
  formatDevModelIssues,
  modelKnownFor,
  parseDevModelPolicy,
  parseModelRoute,
  resolveDevModels,
} from '../lib/dev-mode/dev-model-policy.js';
import type {
  AppConfig,
  DevApprovalMode,
  DevEpochRecord,
  DevMethodology,
  DevModelPolicy,
  DevModelPreset,
  DevPlan,
  DevState,
  LlmProvider,
  OrchestratorState,
} from '../lib/types.js';
import { DEV_MAX_FRONTS } from '../lib/types.js';
import { pickRunKey, type RunSnapshot, type WebRunManager } from './run-manager.js';

/**
 * Lifecycle of a dev session as the browser sees it.
 *
 * `knowledge` is the epoch's Phase A — the cheap two-step retrieval run that
 * answers the blind orchestrator's declared gaps. It is a real huu run with
 * its own kanban, so it needs its own phase: rendering it as `running` made
 * the epoch look like it had started implementing when it had not.
 */
export type DevPhase =
  | 'idle'
  | 'probing'
  | 'bootstrapping'
  | 'knowledge'
  | 'planning'
  | 'awaiting-approval'
  | 'running'
  | 'done'
  | 'error';

export interface DevLogLine {
  level: 'info' | 'warn' | 'error';
  message: string;
  at: number;
}

/** A previous session this one could continue, as offered to the browser. */
export interface DevResumeOffer {
  sessionId: string;
  goal: string;
  epochsDone: number;
  nextEpoch: number;
  /**
   * THE PREVIOUS SESSION RAN A METHOD A HUMAN DREW — verbatim from
   * `DevState.drawnMethod`, which is why it keeps that record's key names
   * instead of the `{id, name}` shape {@link DevSessionSnapshot.drawnMethod}
   * uses for the LIVE session: this describes what is on disk, not what is
   * running.
   *
   * Without it the offer was a trap. `dev-driver.ts` REFUSES a resume that does
   * not bring the same drawing back (`graph-missing-on-resume`), and the driver
   * is right to — a session a human opened as a drawing must never continue as
   * a model's plan. But the only thing the browser was told was "resume session
   * X", so the human clicked "retomar" on a session whose next epoch could not
   * start, with nothing on screen saying which drawing to re-select. The
   * `graphId` here is exactly what the resume request has to carry back.
   *
   * Additive and optional: a session the LLM planner wrote has none, which is
   * what "this was never a drawing" means, and every existing planner-path
   * caller reads the offer it always read.
   */
  drawnMethod?: { graphId: string; graphName: string };
}

/**
 * WHERE THE ADVERSARIAL DEBATE IS, in the epoch that is running — everything
 * the browser needs to render the two sides WITHOUT learning a single step
 * name of its own.
 *
 * Absent on every session that did not turn `--debate` on, which is the
 * default: `findDebateSteps` answers `null` for a pipeline with no debate
 * block, and this field is then never assigned. A client that sees no `debate`
 * shows no chat — not an empty one, not a disabled one.
 *
 * DELIBERATELY LIGHT. `{type:'dev'}` is rebroadcast on every `emit()`, so the
 * two markdown briefs must never ride it; what travels here is a handful of
 * ids and three step names. The prose comes on demand from
 * `GET /api/dev/debate`, and live from the un-throttled `agent-stream`
 * firehose the browser already receives.
 */
export interface DevDebateInfo {
  /** The epoch whose compiled pipeline carries the debate block. */
  epoch: number;
  /**
   * The run the debate belongs to. An epoch is TWO runs and agent ids restart
   * at 1 in each, so a browser buffering the live firehose by agent id alone
   * would splice the knowledge run's agent 1 into the advocate's turn. Every
   * live frame is filtered by this id first.
   */
  runId: string;
  /**
   * The three step names as `findDebateSteps` anchored them. Sent so the
   * browser can match the GATE's `checkRuns` entry (which carries a step name,
   * not an agent id) without hardcoding a literal that lives in
   * `plan-to-pipeline.ts`.
   */
  names: { advocate: string; prosecutor: string; gate: string };
  /**
   * agentId → side, stamped as each debater's card appears on the board.
   * Ids ascend and a rework arm allocates FRESH ones, so the n-th advocate id
   * is the n-th ROUND — which is how the browser keeps round 1 and round 2
   * apart even though `A.md` is rewritten whole each time.
   */
  roles: Record<string, DebateRole>;
  /** How the localizer anchored — `name` (exact) or `structure` (fallback). */
  matchedBy: 'name' | 'structure';
}

/** One epoch's debate as `GET /api/dev/debate` answers it. */
export interface DevDebateRead {
  epoch: number;
  sessionId: string;
  /** Repo-relative paths of the two briefs, or null when undeducible. */
  paths: { a: string; b: string } | null;
  /** Which of the two was actually readable at read time. */
  exists: { a: boolean; b: boolean };
  /** Where the text came from: the integration worktree, or the landed tree. */
  source: 'integration' | 'worktree' | 'none';
  transcript: DebateTranscript;
}

/** An integration branch HEAD never absorbed, as offered to the browser. */
export interface DevOrphanBranch {
  branch: string;
  runId: string;
  ahead: number;
  epoch?: number;
}

/**
 * Why a DRAWN method was refused at the border — the three `DevStopReason`s
 * {@link resolveDevGraph} can answer with, and no other.
 */
export type DevStartRefusalReason = Extract<
  DevStopReason,
  'graph-not-found' | 'graph-invalid' | 'graph-conflict'
>;

/**
 * A start request the manager refuses BEFORE a session exists.
 *
 * WHY A TYPED ERROR AND NOT A BARE `Error`. `start()` already signals a bad
 * request by throwing, and `server.ts` grades those by regex-ing the message
 * (`/already running/` ⇒ 409). That is fine for one sentence and hopeless for a
 * refusal the browser wants to ACT on: "the drawing you picked no longer
 * exists" and "the drawing does not compile" are different repairs, and the
 * only stable handle on the difference is the reason CODE. So the code travels
 * as a field, the prose stays the message, and the HTTP layer maps neither by
 * parsing English.
 *
 * A refusal costs nothing: it is thrown before `this.session` is assigned, so
 * no worktree, no run id, no key resolution and no lock outlive it.
 */
export class DevStartRefusal extends Error {
  readonly reason: DevStartRefusalReason;
  constructor(reason: DevStartRefusalReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = 'DevStartRefusal';
    this.reason = reason;
  }
}

export interface DevSessionSnapshot {
  active: boolean;
  /**
   * The blackboard namespace (`.huu/dev/<sessionId>/`). Assigned before the
   * driver starts and handed to it, so the id the browser is told is the id on
   * disk; a RESUMED session adopts the previous one's id, at which point this
   * changes to it.
   */
  sessionId: string;
  /** True once this session continued a previous one's epoch numbering. */
  resumed: boolean;
  goal: string;
  runDirectory: string;
  approval: DevApprovalMode;
  phase: DevPhase;
  modelId: string;
  /**
   * The EFFECTIVE model id per role — every role resolved against the policy
   * with `modelId` as the fallback, so the browser can show what actually ran
   * rather than what was requested. With no routing asked for, every role
   * reads back as `modelId`.
   */
  models: Record<string, string>;
  /**
   * The methodology flags this session is actually enforcing, by key, in
   * registry order. Same reason `models` is here: the /dev panel reflects
   * localStorage, not the live session, so a resumed or reloaded browser had
   * no way to read back what a RUNNING session was gated on. Empty array when
   * none is on — never omitted, so the client can render "none" rather than
   * having to distinguish absent from empty.
   */
  methodologies: string[];
  backend: AgentBackendKind;
  /**
   * Epoch ceiling, or null when the session runs until the goal is done.
   *
   * A DRAWN method reads back as `1`, whatever the browser posted (which is
   * normally nothing). That is not a re-interpretation: the driver pins a graph
   * session to one epoch — `resolveDevGraph` refuses an explicit ≥ 2 outright —
   * so reporting `null` ("no ceiling") here would be the snapshot contradicting
   * the session it describes.
   */
  maxEpochs: number | null;
  maxFronts: number;
  currentEpoch: number;
  knowledge?: { present: boolean; reason: string; skillCount: number };
  knowledgeBootstrapped: boolean;
  /**
   * The DRAWING this session runs, when the human handed one over instead of
   * letting the planner write the topology. Absent ⇒ an ordinary planner
   * session, exactly as before.
   *
   * Set at `start()`, not at the `planned` event: the browser has to be able to
   * say "this session is your method, not a model's" from the very first frame,
   * including while the knowledge bootstrap is still running. The FULL
   * compiled announcement arrives later, on {@link DevSessionSnapshot.graph}.
   */
  drawnMethod?: { id: string; name: string; description?: string };
  /**
   * What the drawing compiled to, as announced on the `planned` event: the
   * emitted node order, the steps each node produced, and the blackboard root
   * its artifacts land under. Absent on the planner path and until the drawing
   * compiles.
   */
  graph?: DevGraphAnnouncement;
  /** The plan being approved or currently running. */
  plan?: DevPlan;
  /**
   * Everything the compiler and the SESSION want the human to know before the
   * gate: on the graph path this is where `graphSessionWarnings` lands, which
   * is how a user discovers that the methodology checkboxes and the per-role
   * routing they left on were NOT compiled into their drawing.
   */
  planWarnings: string[];
  /** True while `approve()` is the only thing the session is waiting on. */
  awaitingApproval: boolean;
  epochs: DevEpochRecord[];
  /**
   * One entry per orchestrator run, in start order. An epoch is TWO runs now
   * (`knowledge` then `work`), plus the epoch-0 `bootstrap` when the knowledge
   * gate fired — so the epoch number alone no longer identifies a run and the
   * phase travels with it.
   */
  runIds: { epoch: number; runId: string; phase: DevRunPhase }[];
  /** True while `resumeSession()` is the only thing the session is waiting on. */
  awaitingResume: boolean;
  /** The offer behind `awaitingResume`; retained after the answer for display. */
  resumeOffer?: DevResumeOffer;
  /** True while `resolveOrphans()` is the only thing the session is waiting on. */
  awaitingOrphans: boolean;
  /** The branches behind `awaitingOrphans`; retained after the answer. */
  orphans?: DevOrphanBranch[];
  logs: DevLogLine[];
  /**
   * The adversarial debate of the RUNNING epoch, when `--debate` compiled
   * one. Absent is the default and means "there is no chat to show".
   */
  debate?: DevDebateInfo;
  stoppedBecause?: DevStopReason;
  detail?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface StartDevParams {
  goal: string;
  backend: AgentBackendKind;
  provider?: LlmProvider;
  modelId: string;
  /** Browser session key. Same precedence as a normal run. Never persisted. */
  apiKey?: string;
  endpoint?: string;
  runDirectory?: string;
  approval?: DevApprovalMode;
  maxEpochs?: number;
  maxFronts?: number;
  skipKnowledgeBootstrap?: boolean;
  concurrency?: number;
  mode?: 'auto' | 'manual' | 'greedy';
  timeoutMinutes?: number;
  /**
   * Named starting point for the routing policy. Resolved HERE, at the
   * surface, never in the driver — that is what keeps heterogeneous routing an
   * opt-in. Non-`jcode` backends resolve to `{}`.
   */
  modelsPreset?: DevModelPreset;
  /**
   * Explicit per-role routing, layered OVER `modelsPreset`. A role named here
   * wins; a role named nowhere omits `modelId` on the emitted step and falls
   * back to {@link StartDevParams.modelId}, exactly as today.
   */
  models?: DevModelPolicy;
  /**
   * `'auto'` continues a matching previous session without asking; `'never'`
   * always starts fresh. Undefined ASKS — the session parks at the resume gate
   * and the browser answers via `POST /api/dev/resume`.
   */
  resume?: 'auto' | 'never';
  /**
   * The selectable methodologies (the /dev checkboxes), already coerced by the
   * server. Passed through to the driver untouched: undefined — the same
   * byte-identical contract as {@link StartDevParams.models} — compiles
   * exactly the pipeline it compiles today.
   */
  methodology?: DevMethodology;
  /**
   * THE METHOD, DRAWN BY A HUMAN — by id. Names a graph saved under
   * `.huu/dev/graphs/` INSIDE {@link StartDevParams.runDirectory} (the same
   * directory `/api/graphs?dir=` writes to, deliberately: the editor and the
   * runner must agree about where a method lives).
   *
   * Present ⇒ the LLM planner is never called, Phases A and B do not happen,
   * and the session is exactly one epoch. Absent — together with
   * {@link StartDevParams.graph} — leaves every byte of the request on the
   * planner path it was on before this field existed.
   */
  graphId?: string;
  /**
   * The same thing by value, for a canvas that has not been saved (or a caller
   * that already holds the object). Must be a graph the schema accepts — the
   * server parses it with `parseDevGraph` before it gets here.
   *
   * Setting BOTH is fine while they name the same drawing; naming two different
   * ones is refused ({@link DevStartRefusal}, `graph-conflict`).
   */
  graph?: DevGraph;
}

const MAX_LOG_LINES = 300;

export class WebDevManager {
  private session: DevSessionSnapshot | null = null;
  /** Resolver of the promise `runDevMode` parks on at the approval gate. */
  private approvalResolve: ((approved: boolean) => void) | null = null;
  /**
   * Resolver of the RESUME gate — same parked-promise pattern as the approval
   * gate. Both fail CLOSED on abort: resume answers `false` (a fresh session),
   * orphans answer `'ignore'` (nothing is merged behind the user's back).
   */
  private resumeResolve: ((accept: boolean) => void) | null = null;
  /** Resolver of the ORPHAN-BRANCH gate. */
  private orphanResolve: ((action: OrphanAction) => void) | null = null;
  /**
   * Drives the driver's own abort checkpoints AND cuts the live epoch's run.
   * Before this existed, `abort()` only unblocked the approval gate — a path
   * the AUTONOMOUS mode never reaches — so aborting an autonomous session did
   * nothing at all while the UI claimed otherwise.
   */
  private abortController: AbortController | null = null;
  private activeOrchestrator: Orchestrator | null = null;
  /**
   * epoch → where that epoch's two briefs live, and in which run.
   *
   * Kept SERVER-SIDE and keyed by a number the browser can only choose from
   * a set huu wrote: `GET /api/dev/debate` never takes a path, so no request
   * can point the reader at a file the pipeline did not declare.
   */
  private debatePaths = new Map<number, { runId: string; paths: { a: string; b: string } | null }>();

  constructor(
    private readonly cwd: string,
    private readonly runs: WebRunManager,
    /** Session-level frame sink (`{type:'dev'}`). */
    private readonly onDev: (snapshot: DevSessionSnapshot) => void,
    /** Per-epoch kanban sink — the SAME one normal runs use. */
    private readonly onRun: (snapshot: RunSnapshot) => void,
    private readonly onAgentOutput?: (runId: string, chunk: AgentOutputChunk) => void,
  ) {}

  /** Current session, or null when none has ever run in this server session. */
  snapshot(): DevSessionSnapshot | null {
    return this.session;
  }

  isActive(): boolean {
    return this.session?.active === true;
  }

  private emit(): void {
    if (!this.session) return;
    try {
      this.onDev({ ...this.session, epochs: [...this.session.epochs], logs: [...this.session.logs] });
    } catch {
      /* a broadcast failure must never take the session down */
    }
  }

  private log(level: DevLogLine['level'], message: string): void {
    if (!this.session) return;
    this.session.logs.push({ level, message, at: Date.now() });
    if (this.session.logs.length > MAX_LOG_LINES) {
      this.session.logs.splice(0, this.session.logs.length - MAX_LOG_LINES);
    }
  }

  /**
   * The DRAWN METHOD a start request names, resolved at the BORDER.
   *
   * `resolveDevGraph` is exported by the driver for exactly this: it never
   * throws, it answers with data, and it is the SAME function `runDevMode` will
   * run a moment later — so a selection the driver would stop on becomes a 4xx
   * here instead of a session that opens, costs a worktree and immediately dies
   * with `graph-not-found`. Resolving twice is deliberate and free on this path:
   * the resolved drawing is handed over INLINE, so the store is read once and a
   * file edited between the two calls cannot swap the method mid-flight.
   *
   * `null` — and only `null` — means "no drawing was asked for", which is what
   * keeps a request carrying neither field byte-identical to today's.
   */
  private resolveDrawing(
    params: StartDevParams,
    cwd: string,
    goal: string,
    approval: DevApprovalMode,
    /** The EFFECTIVE ceiling, i.e. the number the driver is about to receive. */
    maxEpochs: number | null,
  ): DevGraph | null {
    const resolution = resolveDevGraph(cwd, {
      goal,
      approval,
      ...(maxEpochs === null ? {} : { maxEpochs }),
      ...(params.graph !== undefined ? { graph: params.graph } : {}),
      ...(params.graphId !== undefined ? { graphId: params.graphId } : {}),
    });
    if (resolution === null) return null;
    if (!resolution.ok) throw new DevStartRefusal(resolution.reason, resolution.detail);
    return resolution.graph;
  }

  /**
   * Start a session. Throws (mapped to 4xx by the server) on a bad request or
   * when a session is already running; a refused DRAWING throws the typed
   * {@link DevStartRefusal} so the status and the reason code do not have to be
   * recovered from the prose.
   */
  start(params: StartDevParams): { sessionId: string } {
    if (this.isActive()) {
      throw new Error('a development session is already running — abort it before starting another');
    }
    const goal = params.goal?.trim();
    if (!goal) throw new Error('goal is required');
    if (!params.modelId?.trim()) throw new Error('modelId is required');
    // The RUN-LEVEL model carries no provider: `AppConfig.provider` already
    // says which endpoint the session spends on, and `modelId` is the fallback
    // for every step nothing routed. A `<provider>:` prefix can still arrive
    // here — the browser derives this field from the `worker` role input, and a
    // preset now shows prefixed ids in those inputs — so it is stripped rather
    // than shipped to the endpoint as part of the model name.
    const runModelId = parseModelRoute(params.modelId)?.model ?? params.modelId.trim();

    const bundle = selectBackend(params.backend);
    const devProvider = resolveRunProvider(params.backend, params.provider);
    const runDirectory = params.runDirectory ? resolvePath(params.runDirectory) : this.cwd;

    // The web surface offers NO epoch ceiling: a session runs until the planner
    // reports the goal complete or the user aborts (only the driver's safety
    // backstop bounds it). An explicit value is still honored if one is posted.
    const maxEpochs = params.maxEpochs === undefined ? null : Math.max(1, params.maxEpochs);
    const approval: DevApprovalMode = params.approval === 'each-epoch' ? 'each-epoch' : 'autonomous';

    // Before the key, before the config, before anything that costs: a drawing
    // the driver would refuse must not buy a session. `maxEpochs` is passed as
    // the CLAMPED value, not the raw body one, so the border judges the exact
    // number `runDevMode` is about to be handed — a `maxEpochs: 3` posted with a
    // graph is `graph-conflict` HERE, not a session that opens and dies.
    const drawnMethod = this.resolveDrawing(params, runDirectory, goal, approval, maxEpochs);

    let apiKey = '';
    let apiKeySource: AppConfig['apiKeySource'];
    let keyPool: KeyPoolHandle | undefined;
    if (bundle.requiresApiKey) {
      // Same rule as the run path (`run-manager.ts`): the PROVIDER names the
      // credential, never the backend bundle — `jcode` serves two providers,
      // so `bundle.apiKeySpecName` is undefined there by design.
      const specName = apiKeySpecNameForProvider(devProvider);
      const spec = specName ? findSpec(specName) : undefined;
      const picked = pickRunKey(
        params.apiKey,
        specName ? this.runs.getWebKey(specName) : undefined,
        spec,
      );
      apiKey = picked.value;
      apiKeySource = picked.source;
      if (!apiKey) {
        throw new Error(
          `no API key available for ${spec?.label ?? bundle.label} — add one in ⚙ Settings`,
        );
      }
      // Rotation is opt-in BY CONSTRUCTION: `createKeyPoolHandle` returns a
      // SINGLETON whenever the resolved key is not a member of the persisted
      // pool. A browser session key (or a Docker secret mount, which outranks
      // the store) therefore never gets silently swapped for another one — the
      // handle only rotates when the run is demonstrably using a key the pool
      // owns.
      if (spec) keyPool = createKeyPoolHandle(spec, apiKey);
    }

    let endpoint = params.endpoint?.trim() || undefined;
    if (false) {
      endpoint = endpoint ?? (this.runs.getWebKey('azureEndpoint') || undefined);
      if (!endpoint) throw new Error('the Azure provider requires an endpoint URL');
    }

    const config: AppConfig = {
      apiKey: apiKey || 'stub',
      modelId: runModelId,
      backend: params.backend,
      provider: devProvider,
      endpoint,
      apiKeySource,
    };

    const sessionId = generateRunId();
    const maxFronts = Math.min(Math.max(1, params.maxFronts ?? DEV_MAX_FRONTS), DEV_MAX_FRONTS);

    // Preset FIRST, explicit roles OVER it — a user who picks `hetero` and then
    // pins one slot gets the preset everywhere else. A policy that ends up
    // empty is passed as UNDEFINED, not as `{}`: that is what keeps a request
    // carrying none of the new fields compiling the exact pipeline it compiles
    // today, field for field. The explicit half is re-parsed rather than
    // trusted — `start()` is the manager's public entry point, and a malformed
    // role must degrade to "no routing for that role" whoever assembled it.
    const policy: DevModelPolicy = {
      ...(params.modelsPreset ? defaultDevModelPolicy(params.backend, params.modelsPreset) : {}),
      ...parseDevModelPolicy(params.models),
    };
    const routed = Object.keys(policy).length > 0;

    // THE MODEL PREFLIGHT, at the web border. `runDevMode` runs the same check
    // and is the authority; refusing here is what turns "the session opened,
    // the board rendered, and it stopped" into a 4xx the launch form can show
    // next to the field that caused it. Warnings are logged, never fatal — an
    // id absent from the catalog is not evidence the provider lacks it.
    const modelIndex = devModelProviderIndex(runDirectory);
    const modelIssues = checkDevModelPolicy({
      policy: routed ? policy : undefined,
      provider: devProvider,
      index: modelIndex,
    });
    const modelRefusals = devModelRefusals(modelIssues);
    if (modelRefusals.length > 0) {
      throw new Error(
        `${modelRefusals.length} role(s) routed to a model ${devProvider ?? 'this run'} does not serve:\n` +
          formatDevModelIssues(modelRefusals),
      );
    }

    const models = resolveDevModels(
      routed ? policy : undefined,
      runModelId,
      modelKnownFor(modelIndex, devProvider),
    );

    this.abortController = new AbortController();
    this.debatePaths.clear();
    this.session = {
      active: true,
      sessionId,
      resumed: false,
      goal,
      runDirectory,
      approval,
      phase: 'probing',
      modelId: runModelId,
      models,
      methodologies: activeMethodologies(params.methodology).map((d) => d.key),
      backend: params.backend,
      // A drawing IS one epoch — see the field's own doc comment.
      maxEpochs: drawnMethod ? 1 : maxEpochs,
      ...(drawnMethod
        ? {
            drawnMethod: {
              id: drawnMethod.id,
              name: drawnMethod.name,
              ...(drawnMethod.description !== undefined
                ? { description: drawnMethod.description }
                : {}),
            },
          }
        : {}),
      maxFronts,
      currentEpoch: 0,
      knowledgeBootstrapped: false,
      planWarnings: [],
      awaitingApproval: false,
      epochs: [],
      runIds: [],
      awaitingResume: false,
      awaitingOrphans: false,
      logs: [],
      startedAt: Date.now(),
    };
    // Logged HERE and not next to the check above: `this.log` writes into
    // `this.session.logs` and no-ops while there is no session, so a warning
    // emitted a few lines earlier would simply vanish.
    for (const issue of modelIssues) {
      if (issue.severity === 'warn') this.log('warn', `model routing: ${issue.message}`);
    }
    this.emit();

    const timeoutMs = params.timeoutMinutes ? Math.round(params.timeoutMinutes * 60_000) : undefined;

    void runDevMode({
      dev: {
        goal,
        approval,
        maxEpochs: maxEpochs ?? undefined,
        maxFronts,
        skipKnowledgeBootstrap: params.skipKnowledgeBootstrap,
        // THE DRAWING, handed over BY VALUE even when the request named it by
        // id. The border already read and validated it (`resolveDrawing`), so
        // passing the resolved object means the store is read exactly once and
        // the driver runs the very graph the 200 was granted for — a file
        // rewritten between the two calls cannot swap the method underneath the
        // session. The id rides along when the caller supplied one, so the
        // driver's log line and the resume gate name what the human picked.
        ...(drawnMethod ? { graph: drawnMethod } : {}),
        ...(params.graphId !== undefined ? { graphId: params.graphId } : {}),
        // Omitted entirely when nothing was routed — see `routed` above.
        ...(routed ? { models: policy } : {}),
        // Omitted entirely when no methodology checkbox came through — the
        // same byte-identical contract as `models` just above.
        ...(params.methodology ? { methodology: params.methodology } : {}),
      },
      config,
      cwd: runDirectory,
      agentFactory: bundle.agentFactory,
      conflictResolverFactory: bundle.conflictResolverFactory,
      concurrency: params.mode === 'manual' ? params.concurrency : undefined,
      autoScale: params.mode !== 'manual',
      cardTimeoutMs: timeoutMs,
      singleFileCardTimeoutMs: timeoutMs,
      // Hand the driver the id the browser was just told, so the blackboard
      // namespace and the session the UI tracks are the same string.
      sessionId,
      ...(params.resume ? { resume: params.resume } : {}),
      signal: this.abortController.signal,
      onEvent: (event) => this.handleEvent(event),
      onApprove: (plan, epoch, warnings) => this.gate(plan, epoch, warnings),
      onResumeOffer: (previous, nextEpoch) => this.resumeGate(previous, nextEpoch),
      onOrphanBranches: (orphans) => this.orphanGate(orphans),
      orchestratorFactory: (pipeline, epoch, phase) => {
        const runId = generateRunId();
        const orch = new Orchestrator(config, pipeline, runDirectory, bundle.agentFactory, {
          conflictResolverFactory: bundle.conflictResolverFactory,
          autoScale: params.mode !== 'manual',
          initialConcurrency: params.mode === 'manual' ? params.concurrency : undefined,
          runId,
          keyPool,
        });
        // MAX mode now travels through the handle's `setGreedy` seam instead of
        // being called inline: the DRIVER floods the knowledge bootstrap, and a
        // user who asked for MAX still gets it on every run of the session.
        const setGreedy = (): void => orch.enableGreedyMode();
        if (params.mode === 'greedy') setGreedy();
        this.activeOrchestrator = orch;
        // THE DEBATE, LOCALIZED ONCE PER RUN, from the compiled pipeline this
        // seam already holds. `findDebateSteps` is pure and answers `null` for
        // every pipeline that did not compile the block — the default — so a
        // session without `--debate` never gains the field and the browser
        // never renders a chat. Anchoring here (and not in the client) is what
        // keeps the three step names a private literal of
        // `plan-to-pipeline.ts` instead of a fourth copy in the browser.
        const debateSteps = findDebateSteps(pipeline);
        if (debateSteps && this.session) {
          this.session.debate = {
            epoch,
            runId,
            names: debateSteps.names,
            roles: {},
            matchedBy: debateSteps.matchedBy,
          };
          this.debatePaths.set(epoch, { runId, paths: debateSteps.briefPaths });
        }
        if (this.session) {
          this.session.runIds.push({ epoch, runId, phase });
          this.session.phase =
            phase === 'bootstrap' ? 'bootstrapping' : phase === 'knowledge' ? 'knowledge' : 'running';
          this.emit();
        }

        const startedAt = Date.now();
        const pushRun = (state: OrchestratorState | null, phase: RunSnapshot['phase']): void => {
          this.onRun({
            phase,
            runId,
            pipelineName: pipeline.name,
            runDirectory,
            backend: params.backend,
            modelId: runModelId,
            startedAt,
            state,
          });
        };

        return {
          subscribe: (listener) => {
            const un = orch.subscribe((state) => {
              // Feed BOTH the dev-mode driver and the normal kanban sink.
              listener(state);
              pushRun(state, state.status === 'done' ? 'done' : state.status === 'error' ? 'error' : 'running');
              // Only a GROWN map re-emits the session frame — see the method.
              if (this.stampDebateRoles(state)) this.emit();
            });
            const unOut = this.onAgentOutput
              ? orch.subscribeAgentOutput((chunk) => this.onAgentOutput!(runId, chunk))
              : () => undefined;
            return () => {
              un();
              unOut();
            };
          },
          start: async () => {
            const result = await orch.start();
            pushRun(orch.getState(), result.manifest.status === 'done' ? 'done' : 'error');
            return result;
          },
          abort: () => orch.abort(),
          setGreedy,
        };
      },
    })
      .then((result) => {
        if (!this.session) return;
        this.session.active = false;
        this.session.awaitingApproval = false;
        this.session.awaitingResume = false;
        this.session.awaitingOrphans = false;
        // Authoritative, because only the driver knows whether the resume gate
        // ended up adopting the previous session's namespace.
        this.session.sessionId = result.sessionId;
        this.session.resumed = result.resumed;
        this.session.phase =
          result.stoppedBecause === 'goal-complete' ||
          result.stoppedBecause === 'max-epochs' ||
          result.stoppedBecause === 'aborted' ||
          result.stoppedBecause === 'plan-rejected'
            ? 'done'
            : 'error';
        this.session.stoppedBecause = result.stoppedBecause;
        this.session.detail = result.detail;
        this.session.knowledgeBootstrapped = result.knowledgeBootstrapped;
        this.session.finishedAt = Date.now();
        this.emit();
      })
      .catch((err: unknown) => {
        if (!this.session) return;
        this.session.active = false;
        this.session.awaitingApproval = false;
        this.session.awaitingResume = false;
        this.session.awaitingOrphans = false;
        this.session.phase = 'error';
        this.session.detail = err instanceof Error ? err.message : String(err);
        this.session.finishedAt = Date.now();
        this.log('error', this.session.detail);
        this.emit();
      })
      .finally(() => {
        this.activeOrchestrator = null;
        this.approvalResolve = null;
        this.resumeResolve = null;
        this.orphanResolve = null;
        this.abortController = null;
      });

    return { sessionId };
  }

  /**
   * agentId → side, read off the ONE thing the board already carries: each
   * card's `stageName` IS the pipeline step's name.
   *
   * Returns `true` only when the map GREW, and that is the sole trigger for a
   * session re-emit. `{type:'dev'}` is rebroadcast whole on every `emit()`, so
   * re-stamping on each orchestrator tick would multiply the session traffic
   * by the run's — the map changes at most a handful of times per epoch.
   */
  private stampDebateRoles(state: OrchestratorState): boolean {
    const debate = this.session?.debate;
    if (!debate) return false;
    const byName = new Map<string, DebateRole>([
      [debate.names.advocate, 'advocate'],
      [debate.names.prosecutor, 'prosecutor'],
      [debate.names.gate, 'gate'],
    ]);
    let grew = false;
    for (const agent of state.agents ?? []) {
      const role = byName.get(agent.stageName);
      if (!role) continue;
      const key = String(agent.agentId);
      if (debate.roles[key] === role) continue;
      debate.roles[key] = role;
      grew = true;
    }
    return grew;
  }

  /**
   * The SETTLED half of one epoch's debate: the two briefs as they exist on
   * disk, parsed by `debate-transcript.ts` — the only reader there is.
   *
   * WHY THE SERVER PARSES. The browser client is bundler-free vanilla ESM and
   * cannot import a `.ts` module; shipping a hand-written JS twin of the parser
   * would be a second implementation of prose rules that already took 52 tests
   * to pin. So the markdown is read and parsed here and only JSON crosses.
   *
   * TWO ROOTS, IN THIS ORDER. A debater writes inside its OWN agent worktree,
   * so nothing is at the canonical path until a merge. The wave merge lands the
   * briefs in the run's INTEGRATION worktree; the epoch landing later lands
   * them in the user's tree. Reading integration first is what makes the chat
   * settle at the end of the debate wave instead of at the end of the epoch.
   *
   * Never throws: an unreadable side reads as an ABSENT side, which
   * `buildDebateTranscript` renders as "this side wrote nothing" — a legitimate
   * state (the gate may forward with no brief), not an error.
   */
  debateTranscript(epoch?: number): DevDebateRead | null {
    const s = this.session;
    const debate = s?.debate;
    if (!s || !debate) return null;
    const wanted = epoch === undefined ? debate.epoch : epoch;
    const entry = this.debatePaths.get(wanted);
    if (!entry) return null;
    const { paths } = entry;
    const empty = (source: DevDebateRead['source']): DevDebateRead => ({
      epoch: wanted,
      sessionId: s.sessionId,
      paths,
      exists: { a: false, b: false },
      source,
      transcript: buildDebateTranscript({}),
    });
    if (!paths) return empty('none');

    const roots = [
      integrationWorktreePath(s.runDirectory, entry.runId),
      s.runDirectory,
    ] as const;
    for (const root of roots) {
      const a = readInside(root, paths.a);
      const b = readInside(root, paths.b);
      if (a === null && b === null) continue;
      return {
        epoch: wanted,
        sessionId: s.sessionId,
        paths,
        exists: { a: a !== null, b: b !== null },
        source: root === roots[0] ? 'integration' : 'worktree',
        transcript: buildDebateTranscript({ a, b }),
      };
    }
    return empty('none');
  }

  /**
   * Resolve the approval gate. Returns false when nothing was waiting, so the
   * server can answer 409 instead of silently accepting a stale click.
   */
  approve(approved: boolean): boolean {
    if (!this.approvalResolve || !this.session?.awaitingApproval) return false;
    const resolve = this.approvalResolve;
    this.approvalResolve = null;
    this.session.awaitingApproval = false;
    this.session.phase = approved ? 'running' : 'done';
    this.log('info', approved ? 'plano aprovado pelo usuário' : 'plano rejeitado pelo usuário');
    this.emit();
    resolve(approved && this.abortController?.signal.aborted !== true);
    return true;
  }

  /**
   * Answer the resume gate. Returns false when nothing was waiting, so the
   * server can answer 409 instead of silently accepting a stale click.
   */
  resumeSession(accept: boolean): boolean {
    if (!this.resumeResolve || !this.session?.awaitingResume) return false;
    const resolve = this.resumeResolve;
    this.resumeResolve = null;
    this.session.awaitingResume = false;
    const offer = this.session.resumeOffer;
    if (accept && offer) {
      // Adopt the namespace NOW rather than at the end of the session: the
      // browser is about to watch epochs land under that directory.
      this.session.resumed = true;
      if (offer.sessionId) this.session.sessionId = offer.sessionId;
    }
    this.log(
      'info',
      accept && offer
        ? `retomando a sessão ${offer.sessionId} na época ${offer.nextEpoch}`
        : 'começando uma sessão nova (a anterior não será retomada)',
    );
    this.emit();
    resolve(accept && this.abortController?.signal.aborted !== true);
    return true;
  }

  /**
   * Answer the orphan-branch gate. Returns false when nothing was waiting.
   */
  resolveOrphans(action: OrphanAction): boolean {
    if (!this.orphanResolve || !this.session?.awaitingOrphans) return false;
    const resolve = this.orphanResolve;
    this.orphanResolve = null;
    this.session.awaitingOrphans = false;
    const count = this.session.orphans?.length ?? 0;
    this.log(
      'info',
      action === 'land'
        ? `aterrissando ${count} branch(es) de integração órfã(s)`
        : `deixando ${count} branch(es) de integração órfã(s) intocada(s)`,
    );
    this.emit();
    // Fail CLOSED: an abort that races the answer must never trigger a merge.
    resolve(this.abortController?.signal.aborted === true ? 'ignore' : action);
    return true;
  }

  /**
   * Abort the session. Signals the driver (which checks at every boundary and
   * cuts the live run), declines EVERY pending gate, and stops the bootstrap
   * phase too — the bootstrap Orchestrator is built inside the driver, so only
   * the signal can reach it.
   *
   * Every gate fails CLOSED here: no plan is approved, no previous session is
   * adopted, and no orphan branch is merged on the way out.
   */
  abort(): boolean {
    if (!this.isActive()) return false;
    this.log('warn', 'sessão abortada pelo usuário');
    this.abortController?.abort();
    this.activeOrchestrator?.abort();
    this.resumeSession(false);
    this.resolveOrphans('ignore');
    this.approve(false);
    this.emit();
    return true;
  }

  private gate(plan: DevPlan, epoch: number, warnings: string[]): Promise<boolean> {
    if (!this.session || this.abortController?.signal.aborted) return Promise.resolve(false);
    this.session.phase = 'awaiting-approval';
    this.session.awaitingApproval = true;
    this.session.plan = plan;
    this.session.planWarnings = warnings;
    this.session.currentEpoch = epoch;
    this.emit();
    return new Promise<boolean>((resolve) => {
      this.approvalResolve = resolve;
    });
  }

  /**
   * The resume gate. Fires once, before the knowledge gate, when a previous
   * session carried the SAME goal and never reported it complete — and only
   * when the caller did not already decide with `resume: 'auto'|'never'`.
   *
   * `phase` deliberately does NOT change: this is a question asked during
   * `probing`, and the browser drives its prompt off `awaitingResume`.
   */
  private resumeGate(previous: DevState, nextEpoch: number): Promise<boolean> {
    if (!this.session || this.abortController?.signal.aborted) return Promise.resolve(false);
    this.session.awaitingResume = true;
    const drawn = previous.drawnMethod;
    this.session.resumeOffer = {
      sessionId: previous.sessionId ?? '',
      goal: previous.goal,
      epochsDone: previous.epochs.length,
      nextEpoch,
      // Copied FIELD BY FIELD, not spread: the offer is a browser payload and
      // must not start carrying whatever a future `DevState.drawnMethod` gains.
      ...(drawn ? { drawnMethod: { graphId: drawn.graphId, graphName: drawn.graphName } } : {}),
    };
    // Said out loud as well as carried as data: a client that has not learned
    // the new field yet still shows the human WHY the accept may be refused,
    // and which drawing repairs it. Fires only for a drawn session — a planner
    // session's gate is exactly the gate it always was.
    if (drawn) {
      this.log(
        'warn',
        `a sessão ${previous.sessionId ?? ''} rodava o método DESENHADO "${drawn.graphId}" (${drawn.graphName}) — para retomá-la, selecione esse mesmo método antes de aceitar; sem ele a retomada é recusada`,
      );
    }
    this.emit();
    return new Promise<boolean>((resolve) => {
      this.resumeResolve = resolve;
    });
  }

  /**
   * The orphan-branch gate: integration branches HEAD never absorbed. Genuinely
   * lost work that `git status` cannot show, so it is a question, not a log
   * line — but it must never block, hence the abort-safe `'ignore'` default.
   */
  private orphanGate(orphans: OrphanBranch[]): Promise<OrphanAction> {
    if (!this.session || this.abortController?.signal.aborted) {
      return Promise.resolve<OrphanAction>('ignore');
    }
    this.session.awaitingOrphans = true;
    this.session.orphans = orphans.map((o) => ({
      branch: o.branch,
      runId: o.runId,
      ahead: o.ahead,
      ...(o.epoch === undefined ? {} : { epoch: o.epoch }),
    }));
    this.emit();
    return new Promise<OrphanAction>((resolve) => {
      this.orphanResolve = resolve;
    });
  }

  private handleEvent(event: DevEvent): void {
    const s = this.session;
    if (!s) return;

    switch (event.type) {
      case 'knowledge':
        s.knowledge = {
          present: event.status.present,
          reason: event.status.reason,
          skillCount: event.status.skillCount,
        };
        break;
      case 'bootstrap-start':
        s.phase = 'bootstrapping';
        this.log('info', `bootstrap de knowledge com pi (${event.model})`);
        break;
      case 'bootstrap-progress':
        // progress events are too noisy for the web log
        break;
      case 'bootstrap-done':
        s.knowledgeBootstrapped = event.ok;
        this.log(event.ok ? 'info' : 'error', `bootstrap ${event.ok ? 'concluído' : 'falhou'}`);
        break;
      case 'planning':
        s.phase = 'planning';
        s.currentEpoch = event.epoch;
        s.plan = undefined;
        s.planWarnings = [];
        // The announcement belongs to the epoch that is about to be compiled,
        // exactly like `plan`. On the graph path `planned` follows in the same
        // tick, so this clears nothing a human ever sees; what it DOES buy is a
        // compile that fails leaving no stale node map behind. `drawnMethod`
        // survives — the session is still a drawing, compiled or not.
        s.graph = undefined;
        break;
      case 'planned':
        s.plan = event.plan;
        s.planWarnings = event.warnings;
        // Optional by construction: absent on the planner path, so this line is
        // a no-op there. Present ⇒ the browser can render the boxes the human
        // drew instead of the fronts a model invented.
        if (event.graph) s.graph = event.graph;
        this.log(
          'info',
          event.graph
            ? `época ${event.epoch}: desenho "${event.graph.id}" — ${event.graph.nodeOrder.join(', ')}`
            : `época ${event.epoch}: ${event.plan.fronts.map((f) => f.id).join(', ')}`,
        );
        break;
      case 'epoch-start':
        s.phase = 'running';
        s.currentEpoch = event.epoch;
        break;
      case 'epoch-done':
        s.epochs.push(event.record);
        break;
      case 'stopped':
        s.stoppedBecause = event.reason;
        s.detail = event.detail;
        break;
      case 'log':
        this.log(event.level, event.message);
        break;
    }
    this.emit();
  }
}

/**
 * Read a repo-relative path under `root`, or `null`.
 *
 * The relative half is written by huu's own compiler, never by a request — the
 * containment check is belt and braces so a future caller cannot turn this into
 * an arbitrary-file reader by handing it a `../`.
 */
function readInside(root: string, rel: string): string | null {
  try {
    const abs = resolvePath(root, rel);
    if (abs !== root && !abs.startsWith(root.endsWith(sep) ? root : root + sep)) return null;
    const text = readFileSync(abs, 'utf8');
    return text.trim() === '' ? null : text;
  } catch {
    return null;
  }
}

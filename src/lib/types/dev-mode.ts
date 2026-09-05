/**
 * Dev-mode types.
 *
 * Re-exported from the `lib/types` barrel so existing callers that import
 * `../lib/types.js` keep type-checking. New code may import directly from
 * `../lib/types/dev-mode.js`.
 */

import type { LlmProvider } from '../providers.js';
import type { DevGraph } from '../dev-graph/graph-types.js';
import type { ReviewFinding } from './pipeline.js';

// --- Development mode ---
//
// Dev mode is the one huu flow whose STEP GRAPH is written at run time: a
// planner decomposes a human-underwritten goal into parallel FRONTS, each
// front compiles into a recon → memory fan-out → judge chain, and the whole
// thing is emitted as an ordinary `Pipeline` with `dependsOn` edges so the
// existing wave scheduler runs it unchanged (see `src/lib/dev-mode/`).
//
// The human still underwrites the goal and the method; the planner only
// DECOMPOSES what the human asked for, and every front ends at a judge.

/** Root of the dev-mode blackboard inside the target repo. */
export const DEV_MODE_DIR = '.huu/dev';

/** Hard cap on parallel fronts per epoch. Keeps the compiled pipeline under
 *  the 20-step planner ceiling: 1 recon + fronts×3 + 3 tail steps. */
export const DEV_MAX_FRONTS = 4;

/** Default cap on tasks fanned out per front (the memory step's maxFiles). */
export const DEV_DEFAULT_MAX_TASKS = 8;

/** Default ceiling on epochs in one dev-mode session (CLI default). */
export const DEV_DEFAULT_MAX_EPOCHS = 3;

/**
 * Backstop when NO epoch ceiling is set (the web surface deliberately offers
 * none — a session runs until the planner reports the goal complete or the
 * user aborts). This is not a product limit; it is the last thing standing
 * between a planner that never says "done" and an unattended overnight run.
 * Reaching it is reported as `max-epochs` with a loud detail.
 */
export const DEV_UNBOUNDED_EPOCH_BACKSTOP = 50;

/**
 * Hard cap on knowledge gaps the orchestrator may declare for one epoch. The
 * orchestrator plans without reading the repo, so its gap list is the ONLY
 * retrieval it gets — but each gap costs a parallel subagent, and a model
 * asked for "everything it doesn't know" will happily list thirty. The cap
 * forces prioritization; the fixed baseline gaps guarantee a floor.
 */
export const DEV_MAX_GAPS = 12;

/** Who decides that an epoch's plan may run. */
export type DevApprovalMode = 'autonomous' | 'each-epoch';

/**
 * The distinct jobs a dev-mode session hands to a model. Each maps to a
 * `modelId` the orchestrator already honors end to end (`WorkStep.modelId`,
 * `CheckStep.modelId`, `Pipeline.integrationModelId`, `ReviewSpec.modelId`) —
 * heterogeneous routing needs no orchestrator change at all, the dev-mode
 * compiler just has to fill the fields in.
 *
 * A word on the economics, because it is easy to get backwards: splitting
 * roles across models is NOT a cost optimization. Running a fan-out of agents
 * costs several times a single agent's tokens, while the price gap between the
 * models here is about 2× — routing work to the cheaper model does not pay for
 * the multiplier. The justification is context isolation and parallelism, and
 * for `critic` specifically, getting a second opinion from another vendor.
 */
export type DevModelRole =
  /**
   * The blind orchestrator: no tools, no file reads, no repo digest. Reached
   * through the structured-output LangChain client, NOT through the pi agent
   * registry — which is why an id the pi registry has never heard of is fine
   * here and fatal anywhere else.
   */
  | 'planner'
  /** Global recon plus each front's recon — the retrieval the planner delegates. */
  | 'recon'
  /** The memory fan-out: the agents that actually write code. */
  | 'worker'
  /**
   * The per-task critic of {@link ReviewSpec}. Cross-family from `worker` on
   * purpose — a model auditing its own family's output is the single most
   * fragile assumption in this design, so the default preset breaks it.
   */
  | 'critic'
  /** Consolidation and sealing — writing a report about a diff. */
  | 'reporter'
  /**
   * Front verification and the epoch gate (`CheckStep` judges). Kept on the
   * strong model even in the thrifty preset: every check has a forward
   * `default: true` outcome, so a judge that fails or hallucinates a label
   * APPROVES SILENTLY. It is the one place where saving cents buys a broken
   * epoch.
   */
  | 'judge'
  /** The merge-conflict resolver → `Pipeline.integrationModelId`. */
  | 'integration'
  /**
   * THE DEBATE PAIR (`methodology.debate`). The roster document names an
   * adversarial pair — `advogado` (defends the design) and `promotor` (attacks
   * it) — and the `--debate` methodology is the step that finally runs them:
   * `Sustentar as escolhas` → `Contestar as escolhas` → `Debate resolvido?`,
   * compiled between the global recon and the fronts.
   *
   * They are two roles, not one, precisely so they can be routed to DIFFERENT
   * FAMILIES. A debate between two instances of the same model is a monologue
   * with extra tokens: the measured failure of naive multi-agent debate (it
   * often fails to beat plain chain-of-thought) is what heterogeneity is the
   * antidote to, and it is the only property here that cannot be recovered by
   * a better prompt.
   *
   * With NO routing both fall back to `AppConfig.modelId`, which is homogeneous
   * — say so rather than hide it (`docs/dev-mode.md`), and route them.
   */
  | 'advocate'
  /** See {@link DevModelRole} `'advocate'` — the other half of the pair. */
  | 'prosecutor';

/**
 * WHERE one role runs: the model, and the provider whose endpoint serves it.
 *
 * The provider half is the part that was missing while a policy value was a
 * bare string. `AppConfig.provider` is ONE provider for the whole run, so a
 * roster that mixes vendors is only expressible if each role can say which
 * endpoint its id belongs to — otherwise `z-ai/glm-5.2` travels to
 * api.deepseek.com and dies inside the first agent, after its worktree and
 * branch already exist.
 *
 * `provider` absent means "whatever provider the run is on", which is exactly
 * what a bare string has always meant. Leave it unset for an id BOTH endpoints
 * serve (`deepseek/…` is in the catalog under both) — that keeps the route
 * portable. Set it for an id only one endpoint serves, and the preflight can
 * then refuse the mismatch at the border with no catalog lookup at all.
 */
export interface DevModelRoute {
  /**
   * A model id, or an ordered chain of fallback rungs (`"a/x, b/y"`) — see
   * `modelRungs` in `dev-mode/dev-model-policy.ts`. Written in huu's canonical
   * catalog shape (`vendor/model`); `modelIdForProvider` renames it for the
   * endpoint at the last moment.
   */
  model: string;
  /**
   * Provider whose endpoint serves {@link model}. Absent ⇒ inherit the run's
   * provider (`AppConfig.provider`).
   */
  provider?: LlmProvider;
}

/**
 * What a role may be written as at an INPUT surface (a CLI flag, a POST body,
 * a preset table). A bare string keeps meaning exactly what it meant, and it
 * may carry an explicit provider as a `<provider>:` prefix
 * (`"openrouter:anthropic/claude-opus-5"`) — the one form that survives a
 * round-trip through a plain `Record<string, string>` JSON payload, which is
 * what `/api/bootstrap` hands the browser and what the browser posts back.
 */
export type DevModelRouteInput = string | DevModelRoute;

/**
 * Role → route. Partial by design: a role left unset OMITS `modelId` on the
 * emitted step, so the existing `AppConfig.modelId` fallback applies and the
 * compiled pipeline is byte-identical to today's.
 */
export type DevModelPolicy = Partial<Record<DevModelRole, DevModelRoute>>;

/** The same policy as an untrusted/loose surface may write it. */
export type DevModelPolicyInput = Partial<Record<DevModelRole, DevModelRouteInput>>;

/** Named policies the CLI and the web offer. */
export type DevModelPreset = 'hetero' | 'thrifty' | 'monoculture' | 'roster' | 'uniform';

/**
 * `deepseek/…` ids are deliberately written WITHOUT a provider: both endpoints
 * serve them (the catalog carries a `deepseek` and an `openrouter` entry for
 * each), so an unqualified route is portable and inherits the run's provider.
 * Only the ids a single endpoint serves carry the `openrouter:` prefix — and
 * that prefix is what makes a preset self-describing, so the preflight can
 * refuse a provider mismatch WITHOUT consulting a catalog that may not ship
 * with the audited repository.
 */
const DS = 'deepseek/deepseek-v4-pro';
const DS_FLASH = 'deepseek/deepseek-v4-flash';

export const DEV_MODEL_PRESETS = {
  /**
   * ★ Strong blind leader, cheap swarm, critic from ANOTHER family.
   *
   * An OPENROUTER preset, and it cannot be anything else: a cross-family critic
   * needs an endpoint that fronts more than one family, and OpenRouter is the
   * only one huu speaks. Run it with `--provider=openrouter`; on DeepSeek the
   * preflight refuses it by name instead of letting `z-ai/glm-5.2` reach
   * api.deepseek.com.
   */
  hetero: {
    planner: 'openrouter:z-ai/glm-5.2',
    recon: DS,
    worker: DS,
    critic: 'openrouter:moonshotai/kimi-k2.6',
    reporter: DS,
    judge: DS,
    integration: DS,
    // The debate pair reuses the two families this preset ALREADY pays for —
    // the DeepSeek family that writes the code and the Moonshot family that
    // already audits it — so `--debate` is cross-family by construction
    // without adding a vendor, a key or a billing surface to the preset.
    advocate: DS,
    prosecutor: 'openrouter:moonshotai/kimi-k2.6',
  },
  /** Same as `hetero`, with the reporter demoted — it is mechanical prose over a diff. */
  thrifty: {
    planner: 'openrouter:z-ai/glm-5.2',
    recon: DS,
    worker: DS,
    critic: 'openrouter:moonshotai/kimi-k2.6',
    reporter: DS_FLASH,
    judge: DS,
    integration: DS,
    // NOT demoted, unlike the reporter. Demoting ONE side of a debate buys a
    // few cents and hands the judge exactly the asymmetry its anonymized
    // rubric exists to remove: the weaker writer loses on prose rather than on
    // argument. Thrifty's economy comes from the reporter, not from here.
    advocate: DS,
    prosecutor: 'openrouter:moonshotai/kimi-k2.6',
  },
  /**
   * Everything on the worker's model — INCLUDING the critic. This is
   * explicitly the configuration the evidence flags as the weakest
   * assumption; it exists so the cross-family critic can be A/B'd against it,
   * not as a recommendation.
   *
   * The planner stays on the same leader as `hetero` ON PURPOSE: the arm under
   * test is the CRITIC, so changing the leader too would confound the
   * comparison. That also makes this an OpenRouter preset.
   */
  monoculture: {
    planner: 'openrouter:z-ai/glm-5.2',
    recon: DS,
    worker: DS,
    critic: DS,
    reporter: DS,
    judge: DS,
    integration: DS,
    // Same family on BOTH sides of the debate, deliberately — this preset is
    // the A/B baseline, and the debate's heterogeneity claim is exactly the
    // kind of thing that has to be measured against a monoculture arm rather
    // than assumed. It is the one preset where this is not a defect.
    advocate: DS,
    prosecutor: DS,
  },
  /**
   * The heterogeneous ROSTER: one endpoint (OpenRouter), five vendors, each
   * role on the model whose failure mode it can least afford.
   *
   *   planner     V4 Pro           — the blind leader decomposes; it reads only
   *                                  a digest, so reasoning beats context here.
   *   recon       V4 Pro           — the ARCHITECT. Front recon writes the task
   *                                  specs, i.e. it decides the decomposition;
   *                                  a vague atlas produces vague findings.
   *   worker      V4 Flash         — the fan-out. Cheapest per token, and every
   *                                  worker's output is read by a critic.
   *   critic      GPT-5.6 Sol      — the PROSECUTOR, and cross-family from the
   *                                  DeepSeek workers by construction. A model
   *                                  auditing its own family is the single most
   *                                  fragile assumption in this design.
   *   reporter    GLM-5.3 Flash    — retrieval-and-summarize over a long diff:
   *                                  1.31M of context for ~$0.08/Mtok.
   *   judge       Claude Opus 5    — the strongest model in the roster, on the
   *                                  role whose failure is SILENT (every check
   *                                  has a forward `default: true`).
   *   integration V4 Pro           — resolves conflicts in code the DeepSeek
   *                                  workers wrote; same family is an asset for
   *                                  a merge, unlike for an audit.
   *
   *   advocate    Claude Opus 5    — the adversarial PAIR the roster document
   *   prosecutor  GPT-5.6 Sol        names (advogado / promotor), which
   *                                  `--debate` finally has a step for. Two
   *                                  vendors, no new model: both ids are
   *                                  already in this roster, so turning the
   *                                  debate on costs a preset nothing.
   *
   * KNOWN OVERLAP, stated rather than hidden: `judge` and `advocate` are both
   * Opus 5, so the debate's judge shares a family with one debater. With five
   * models over nine roles some overlap is unavoidable, and this is why the
   * judge's rubric is ANONYMIZED — it is never told which brief is whose. A
   * session that wants full independence routes `--judge-model=` to a sixth
   * family; the compiler stamps whatever the policy names.
   */
  roster: {
    planner: DS,
    recon: DS,
    worker: DS_FLASH,
    critic: 'openrouter:openai/gpt-5.6-sol',
    reporter: 'openrouter:z-ai/glm-5.3-flash',
    judge: 'openrouter:anthropic/claude-opus-5',
    integration: DS,
    advocate: 'openrouter:anthropic/claude-opus-5',
    prosecutor: 'openrouter:openai/gpt-5.6-sol',
  },
  /** Every role falls back to `AppConfig.modelId` — today's behavior, byte-identical. */
  uniform: {},
} as const satisfies Record<DevModelPreset, DevModelPolicyInput>;

/** One parallel workstream within an epoch. */
export interface DevFront {
  /** Stable kebab-case id, unique within the epoch. Names the blackboard dir. */
  id: string;
  /** Short human-facing title. */
  title: string;
  /** Why this front exists — surfaced in the approval view. */
  rationale: string;
  /** Ids of OTHER fronts in this epoch that must land before this one starts. */
  dependsOnFronts: string[];
  /** What the front's recon must discover and hand to the fan-out. */
  reconPrompt: string;
  /** What each task agent must do. Uses the `$file` / `$hint` tokens. */
  workPrompt: string;
  /** Objectively checkable condition for the front's judge. */
  verifyCondition: string;
  /** Fan-out cap for this front. */
  maxTasks: number;
}

/** One epoch's plan — the unit the planner emits and the human approves. */
export interface DevPlan {
  /** What THIS epoch achieves (a slice of the overall goal). */
  epochGoal: string;
  /** Objective criterion for the OVERALL goal being finished. */
  doneWhen: string;
  /** True when the planner judges the overall goal already satisfied. */
  goalComplete: boolean;
  fronts: DevFront[];
}

/**
 * What an executed epoch actually produced, in a shape the next planning pass
 * can read. Today the next epoch's planner gets only a prose report; this is
 * the structured half.
 *
 * It is also what keeps the orchestrator blind while still being INFORMED:
 * every field is bounded and tabular (never a file, never a diff body), so the
 * model gets a summary of reality rather than a window into the repo. The
 * INTERPRETATION of it is not the planner's job either — from epoch 2 on, a
 * "what was delivered vs what was promised" gap is handed to a subagent that
 * can actually read the code, and its answer arrives as ordinary knowledge.
 *
 * Everything here is derivable from state the run already has: verdicts from
 * `OrchestratorState.checkRuns`, waived/outcomes from `OrchestratorState.agents`,
 * landing from the epoch-landing result, `diffStat` from git.
 */
export interface DevEpochEvidence {
  epoch: number;
  /** `git diff --stat`, truncated by churn (top ~40 files + "…and N more"). */
  diffStat: string;
  /** Changed paths, capped. */
  filesChanged: string[];
  /** Every check verdict, and whether the judge produced it or the forward default fired. */
  verdicts: { stepName: string; label: string; fromJudge: boolean; reason?: string }[];
  /**
   * Tasks that merged with blocking review findings waived at the round cap.
   * The single most important row for the next planner: it is work that landed
   * while a critic was still objecting.
   */
  waived: { agentId: number; stageName: string; findings: ReviewFinding[] }[];
  taskOutcomes: { done: number; noChanges: number; failed: number; unmerged: number };
  landing: { landed: boolean; commit?: string; error?: string };
  /**
   * A bounded slice of the epoch's consolidation report.
   *
   * ABSENT FOR EVERY EPOCH A DRAWING RAN, deliberately: huu reads the report
   * from the path IT compiled (`.huu/dev/<session>/epoch-N/report.md`), and a
   * devgraph's `consolidate` block names no output file, so there is no path to
   * read. What that costs is the excerpt in `state.json` and in the browser
   * snapshot; the only CONSUMER — the next epoch's planner prompt — is never
   * reached on the drawn path. Full argument on `readEpochReportFor`
   * (`dev-mode/dev-driver.ts`), which is the one place that fills this.
   */
  reportExcerpt?: string;
  /**
   * DECLARED-vs-declared write-set check, run over the epoch's task specs
   * AFTER the landing — the only moment the `T-*.md` files exist in the
   * user's checkout (the front recons write them during the run). Sibling of
   * `instrumentation.writeSetViolations`, which measures what agents ACTUALLY
   * wrote outside their spec; this one measures whether the specs themselves
   * partitioned the tree. Advisory: violations are recorded here and logged,
   * never blocked on — the blocking role moves to a compiled step in a later
   * wave. Absent when the epoch produced no specs or the specs are disjoint.
   *
   * On a DRAWN epoch this comes only from the run's own pre-fan-out collision
   * check (`OrchestratorState.declaredWriteCollisions`), never from the disk
   * scan: a drawing's task specs live under `.huu/findings/<axis>/`, which is
   * namespaced by axis and not by epoch, so scanning it would report a
   * previous epoch's specs as today's violations. See `scanSpecs`.
   */
  declaredPartitionViolations?: { path: string; specs: string[] }[];
  /**
   * The four numbers nobody has published for parallel coding agents, which
   * huu is in a position to MEASURE rather than cite. They exist to make the
   * severity-vs-proof blocking choice, and the parallel-fronts bet, revisable
   * with this project's own data instead of another domain's literature.
   *
   * Optional only because this record is PERSISTED (`state.json` →
   * `DevEpochRecord.evidence`): an epoch written before instrumentation
   * existed is still a valid v2 record and comes back on resume without the
   * block. `collectEpochEvidence` ALWAYS emits it — zeros and empty arrays
   * when nothing was measured, never `undefined`.
   */
  instrumentation?: {
    /** Files an agent committed that its task spec did not declare as OWNED. */
    writeSetViolations: { agentId: number; stageName: string; paths: string[] }[];
    /**
     * Blocking findings that triggered a fix round, split by whether a command
     * proved them, plus the RAW per-card round distribution — not an average.
     * "How many rounds of critique actually help" is a question about the
     * shape of that distribution, and a mean hides the tail that answers it.
     */
    review: { proved: number; unproved: number; rounds: number[]; waivedCount: number };
    /** Per stage merge: how many eligible branches conflicted and needed the resolver. */
    mergeConflicts: { stageName: string; eligible: number; conflicted: number }[];
  };
}

/** Outcome of one executed epoch, appended to the dev state. */
export interface DevEpochRecord {
  epoch: number;
  runId: string;
  epochGoal: string;
  frontIds: string[];
  /** Terminal status of the epoch's orchestrator run. */
  status: 'done' | 'error' | 'aborted';
  /** Commit the epoch's work landed on, when the merge succeeded. */
  landedCommit?: string;
  /** Populated when landing failed (conflict, dirty tree, merge error). */
  landingError?: string;
  startedAt: string;
  finishedAt: string;
  /** Structured outcome of the epoch — see {@link DevEpochEvidence}. */
  evidence?: DevEpochEvidence;
  /**
   * What the epoch cost, in USD, from the run manifest's authoritative total.
   * Per-epoch cost is not measurable today at all; one propagated field makes
   * every "is this design worth it" question answerable with a number.
   */
  costUsd?: number;
}

/**
 * The project's real verification commands, extracted from the
 * `build-test-commands` knowledge brief and classified by kind.
 *
 * `all` preserves the brief's original order and is what current consumers
 * (the per-task critic) receive — so an epoch compiled from a persisted value
 * is byte-identical to one compiled straight from the brief. The buckets are
 * the same commands partitioned by kind, for consumers that need a subset: a
 * later wave feeds `lint` (lint/typecheck — the fast checks) to a merge gate,
 * which must never inherit a command nobody could classify.
 */
export interface DevVerifyCommands {
  /** Every command, in the order the brief listed them. */
  all: string[];
  build: string[];
  test: string[];
  /** Lint AND type-check commands — the subset a merge gate may run. */
  lint: string[];
  /**
   * Architecture/fitness-function commands (dependency rules, layering,
   * cycles). Optional and additive: a state file persisted before this bucket
   * existed is still valid, and re-extraction fills it.
   *
   * Populated ONLY from an explicit `fitness:` label — never from a hint —
   * so enabling `fitnessFunctions` cannot quietly move a command out of the
   * `lint` bucket that `lintGate` has always run.
   */
  fitness?: string[];
}

/**
 * Persisted dev-mode blackboard: `.huu/dev/state.json`.
 *
 * The v2 format tag exists so `readDevState` can refuse a v1 file outright —
 * it returns null for any foreign tag, which degrades to "no resume offered"
 * and needs no migration code at all. v2 adds `sessionId`, which namespaces
 * the epoch blackboard (`.huu/dev/<sessionId>/epoch-N/…`): without it, a
 * second session's memory fan-out can resolve a PREVIOUS session's committed
 * `tasks.json` and dispatch the wrong swarm.
 */
export interface DevState {
  /**
   * Transitional union: v2 is what huu writes from now on, v1 is retained only
   * until the writer (`dev-state.ts` / `dev-driver.ts`) is bumped, so this
   * type change lands without breaking them. Drop the v1 arm with that bump.
   */
  _format: 'huu-devstate-v2' | 'huu-devstate-v1';
  /** The human's goal, verbatim. Never rewritten by an agent. */
  goal: string;
  doneWhen: string;
  epochs: DevEpochRecord[];
  /** Last verdict from the planner about whether the goal is met. */
  goalComplete: boolean;
  updatedAt: string;
  /**
   * Identifier of this dev session — the path segment every epoch artefact
   * lives under. Optional ONLY for the transition (a v1 state file has none);
   * every v2 writer sets it. See the format note above for why it exists.
   */
  sessionId?: string;
  /**
   * THE SESSION RAN A METHOD A HUMAN DREW — recorded so a RESUME cannot
   * silently hand the same session back to the LLM planner.
   *
   * Without it, `resolveDevGraph` reads only `dev.graph` / `dev.graphId`, which
   * the CALLER must re-supply. A caller that resumes without them gets a
   * session whose epoch 1 was a drawing and whose epoch 2 is a model's plan —
   * the exact substitution {@link DevModeConfig.graph} exists to remove, and
   * the worst possible outcome, because it is invisible. With this field the
   * driver can refuse instead: see the `graph-missing-on-resume` and
   * `graph-conflict` stops in `dev-driver.ts`.
   *
   * Additive and optional: a state file written by a planner session has none,
   * which is exactly what "this session was never a drawing" means, and every
   * state file written before this field existed is still a valid v2 record.
   */
  drawnMethod?: {
    /** The graph's slug — the identity a resume must match. */
    graphId: string;
    /** Its name when it ran, so a refusal can be read by a human. */
    graphName: string;
  };
  /**
   * Verification commands extracted from the `build-test-commands` brief,
   * persisted on first successful extraction. The baseline gap that produces
   * them is only asked in epoch 1 — without this field every epoch ≥ 2 lost
   * the critic's executable anchor. Additive and optional: a state file
   * written before it existed is still valid v2 and simply re-extracts.
   */
  verifyCommands?: DevVerifyCommands;
  /**
   * An epoch whose EXECUTION run was started and never recorded — set just
   * before Phase C spawns, cleared the moment the epoch's record is pushed.
   *
   * It exists so a crash in Phase C does not cost Phases A and B. Resume was
   * epoch-granular: a session that died with twenty agents already merged came
   * back and re-bought the knowledge run, re-planned, and re-compiled — even
   * though the compiled graph was ALREADY on disk as a committed artefact
   * (`paths.pipeline(epoch)`). This field is the pointer that makes that
   * artefact usable instead of merely auditable.
   *
   * Deliberately NOT mid-run resume: the agents are gone, their worktrees are
   * gone, and reconstructing them is a different problem. What is recovered is
   * the epoch's PLAN, which is the expensive part nobody should pay twice.
   */
  pendingEpoch?: {
    epoch: number;
    /** Repo-relative path of the compiled pipeline for that epoch. */
    pipelinePath: string;
    /** The epoch's goal, so a resumed run records the same history line. */
    epochGoal: string;
    /** The fronts it compiled, for the same reason. */
    frontIds: string[];
  };
}

/**
 * The selectable methodologies of a dev-mode session — one checkbox each, all
 * OFF by default. Each flag is the HUMAN underwriting a piece of method: it
 * changes the STRUCTURE the dev compiler emits (step splits, merge gates,
 * judge rubrics, review behavior), never gives a model new structure fields.
 *
 * Additive by design, same contract as {@link DevModelPolicy}: a session that
 * sets none of this compiles the pipeline it compiles today, byte for byte.
 * Enforcement is never a silent waive — a flagged gate that fails blocks with
 * a human escape (see `ReviewSpec.onBlocked` in `./pipeline.js`).
 */
export interface DevMethodology {
  /** Split each front's work into a tests step + an implementation step (TDD). */
  tdd?: boolean;
  /** Run the project's lint/typecheck commands as a deterministic merge gate. */
  lintGate?: boolean;
  /** Add the project's atlas/conventions as a rubric to every per-task critic. */
  standards?: boolean;
  /** Compile a plan-validation step (work + check with loop-back) before the fan-out. */
  planReview?: boolean;
  /**
   * Enforce each task spec's declared `Files this task OWNS` list: the critic
   * blocks any file written outside it and the front's judge re-checks it
   * after the merge. huu already MEASURES this
   * (`DevEpochInstrumentation.writeSetViolations`); this flag is the human
   * turning the measurement into a gate.
   */
  writeSet?: boolean;
  /**
   * Check commit subjects against Conventional Commits as a deterministic
   * merge gate, and make the critic demand a changelog entry for any
   * user-visible change — when the project HAS a changelog surface.
   */
  changelogGate?: boolean;
  /**
   * Cap each task's diff (lines and files) as a deterministic merge gate, and
   * tell the planner to decompose until every task fits. Small batches are
   * what keeps the critic's review effective at all.
   */
  diffBudget?: boolean;
  /**
   * Ask an agent, in the knowledge phase, for the project's architecture/
   * dependency-rule command, then run it as a merge gate and give the critic
   * the atlas's layering rules as a citable rubric. Parallel fronts erode
   * layering faster than anything else, and nothing else here catches it.
   */
  fitnessFunctions?: boolean;
  /**
   * Make the critic answer a FIXED checklist item by item — one enum verdict
   * (`PASS`/`FAIL`/`N/A`) plus one line of evidence each — instead of writing
   * free prose. A fixed-enum verdict with mandatory evidence is reproducible
   * between runs in a way an uncalibrated judgement is not.
   */
  checklistReview?: boolean;
  /**
   * Compile a traceability pair after the consolidation: an agent builds a
   * bidirectional matrix (every "Done when" criterion → the test/file that
   * settles it, and back) and a check refuses orphans in either direction,
   * looping back to the matrix step.
   */
  traceability?: boolean;
  /**
   * Split each front's work into a characterization step + an implementation
   * step: capture TODAY's observable behavior as committed snapshots before
   * changing anything, then treat any later divergence as a defect unless it
   * was explicitly approved.
   *
   * This is `tdd` for the work that has no spec to test against — audits,
   * knowledge extraction, legacy refactors — which is most of what huu exists
   * to run.
   */
  characterization?: boolean;
  /**
   * Insert a verification pass into the KNOWLEDGE phase (the only methodology
   * that does): one agent per brief re-checks every claim against the
   * repository and demotes what it cannot reproduce into `unknowns`.
   *
   * It never fails and never deletes — every path out of Phase A stays
   * forward. It exists because the orchestrator is blind: the digest is the
   * only thing it learns about the repo, so one confident wrong claim there
   * becomes a plan nobody downstream can correct.
   */
  chainOfVerification?: boolean;
  /**
   * Compile an ADVERSARIAL DEBATE over the epoch's design decisions, between
   * the global recon and the fronts: one agent writes the decision record, a
   * second one from ANOTHER model family attacks it, and a judge with an
   * ANONYMIZED rubric routes on two enumerated outcomes.
   *
   * It is a methodology and not a free-running discussion on purpose. The
   * debate emits PROSE into two files huu named in advance; the graph is the
   * compiler's, fixed, revalidated by `PipelineSchema` + `validateTopology`;
   * the judge's verdict is one of two labels with the forward one as
   * `default: true`. Nothing here lets a model emit `steps`, `dependsOn` or a
   * path — the MANIFESTO boundary dev mode already lives inside.
   *
   * Heterogeneity is the whole mechanism: {@link DevModelRole} gains
   * `advocate` and `prosecutor` so the two sides can be routed to different
   * families, and every preset but `monoculture` (the A/B baseline) does.
   * Two agents of the SAME model agreeing is not evidence of anything.
   */
  debate?: boolean;
}

/** Everything `runDevMode` needs beyond the shared `AppConfig`. */
export interface DevModeConfig {
  /** The human-underwritten goal. Required — dev mode never invents scope. */
  goal: string;
  approval: DevApprovalMode;
  /**
   * Ceiling on epochs. Undefined = UNBOUNDED: run until the planner reports
   * the goal complete, the consecutive-failure circuit breaker trips, or the
   * caller aborts — bounded only by {@link DEV_UNBOUNDED_EPOCH_BACKSTOP}. The
   * CLI defaults to {@link DEV_DEFAULT_MAX_EPOCHS}; the web sends nothing.
   */
  maxEpochs?: number;
  /** Ceiling on parallel fronts per epoch. Defaults to {@link DEV_MAX_FRONTS}. */
  maxFronts?: number;
  /** Skip the knowledge bootstrap even when the probe says it is missing. */
  skipKnowledgeBootstrap?: boolean;
  /**
   * THE METHOD, DRAWN BY A HUMAN. Present ⇒ the LLM planner is never called.
   *
   * This is the field that closes the MANIFESTO gap `docs/dev-mode.md` opens
   * in its own first section: dev mode normally hands the TOPOLOGY to a model
   * (how many fronts, what each does, where they join), which is precisely the
   * decision differential #2 says must not be delegated. A `huu-devgraph-v1` is
   * the human's answer — the topology IS the drawing, and the model only
   * supplies intelligence INSIDE each node.
   *
   * Consequences, all of them deliberate (see `runDevMode`):
   *  - Phase A (knowledge) and Phase B (plan) are SKIPPED. There is nothing to
   *    plan and nobody to brief: the drawing already says what runs.
   *  - The session is EXACTLY ONE EPOCH. Replanning is what epochs are for, and
   *    a graph has nothing to replan — so {@link DevModeConfig.maxEpochs} ≥ 2
   *    is REFUSED (`graph-conflict`) rather than silently ignored.
   *  - {@link DevModeConfig.methodology} and {@link DevModeConfig.models} are
   *    NOT compiled into it. A devgraph expresses method by DRAWING it and
   *    routing by the node's own `modelId`; applying the flags here would mean
   *    adding steps the human never drew.
   *
   * ADDITIVE, and that is a contract with a test behind it: a session that
   * sets NEITHER this nor {@link DevModeConfig.graphId} compiles and runs
   * byte-identically to today's planner session.
   */
  graph?: DevGraph;
  /**
   * The same thing by reference: the id of a graph saved under
   * `.huu/dev/graphs/`, resolved by the driver through `readGraph`.
   *
   * Exists so a surface can hand over a picker selection without loading and
   * re-serializing the drawing. Setting BOTH is fine while they name the same
   * graph (the inline object wins, no read happens); naming two DIFFERENT
   * graphs is refused (`graph-conflict`) — there is no defensible way to pick
   * which method the human meant.
   */
  graphId?: string;
  /**
   * Per-role model routing. Undefined — or any role left unset inside it —
   * means the emitted step omits `modelId` entirely and falls back to
   * `AppConfig.modelId`, so a session that doesn't ask for routing compiles
   * exactly the pipeline it compiles today. See {@link DEV_MODEL_PRESETS}.
   */
  models?: DevModelPolicy;
  /**
   * Selectable methodologies (the checkboxes). Undefined — or every flag left
   * unset — compiles exactly the pipeline it compiles today, byte for byte.
   * See {@link DevMethodology}.
   */
  methodology?: DevMethodology;
  /**
   * Hard ceiling on what the SESSION may spend, in USD. Checked at the top of
   * each epoch against the sum of every epoch's `costUsd` (which counts BOTH
   * runs). Undefined ⇒ no ceiling, exactly as before.
   *
   * The number was already being collected and was gating nothing: the only
   * two stops an unattended session had were the consecutive-failure breaker
   * (3) and the epoch backstop ({@link DEV_UNBOUNDED_EPOCH_BACKSTOP} = 50), and
   * 50 epochs × two runs × N agents is not a bound anyone can reason about in
   * advance. A dollar figure is. The check is deliberately BETWEEN epochs, not
   * inside one: killing a swarm mid-flight to save money loses the work AND
   * still pays for the tokens already spent.
   */
  maxCostUsd?: number;
  /**
   * Overrides the character ceiling on the knowledge digest — the ONLY thing
   * the blind planner ever reads about the repository.
   *
   * The default ({@link KNOWLEDGE_DIGEST_MAX_CHARS}) is small ON PURPOSE, and
   * not because of any context window: a near-relevant paragraph in a briefing
   * is a distractor that measurably pulls a planner off, so the budget is a
   * DISTRACTOR bound, not a capacity bound. Deriving it from the planner
   * model's window would measure what fits, not what helps.
   *
   * What was wrong before was not the number — it was that the number could not
   * be moved without editing a constant, so nobody could ever measure whether
   * it is right. This is that dial.
   */
  knowledgeDigestMaxChars?: number;
}

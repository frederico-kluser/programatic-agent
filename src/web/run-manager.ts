/**
 * Multi-run lifecycle manager for the web server. Holds a `Map<runId, …>` of
 * concurrent runs that all share ONE {@link GlobalScheduler} (a single RAM /
 * concurrency budget): earlier runs have priority, later ones backfill the idle
 * slots of earlier ones, and under memory pressure the scheduler kills the
 * lowest-priority run's newest agent first. `start()` no longer refuses a
 * second run — it assigns a stable runId, registers an Orchestrator with the
 * scheduler, and returns immediately. State is pushed to the server via
 * `onUpdate` (the server throttles + fans out per run); the firehose is tagged
 * with the originating runId.
 *
 * `/simulation` runs are synthetic (no scheduler, no git/LLM) and live in the
 * same map, so the browser can show several at once through the project
 * selector.
 */

import { existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { Orchestrator } from '../orchestrator/index.js';
import { GlobalScheduler } from '../orchestrator/global-scheduler.js';
import { SimulationEngine } from '../orchestrator/simulation/engine.js';
import type { SimulationOptions } from '../orchestrator/simulation/engine.js';
import type { AgentOutputChunk } from '../orchestrator/types.js';
import {
  selectBackend,
  type AgentBackendKind,
} from '../orchestrator/backends/registry.js';
import {
  findSpec,
  maskKey,
  resolveApiKey,
  resolveApiKeyWithSource,
  type ApiKeySpec,
} from '../lib/api-key.js';
import { createKeyPoolHandle, type KeyPoolHandle } from '../lib/api-key-pool.js';
import {
  providerInfo,
  resolveRunProvider,
} from '../lib/providers.js';
import { generateRunId } from '../lib/run-id.js';
import { resolveRamPercent } from '../lib/budget.js';
import { noKernelCeilingWarning } from '../lib/ram-doctor.js';
import type {
  AppConfig,
  LlmProvider,
  LogEntry,
  OrchestratorState,
  Pipeline,
} from '../lib/types.js';
import { getPipelineByName } from './api-data.js';
import { termLog } from './terminal-log.js';
import { AdmissionController, computeAdmissionContext } from '../lib/admission-controller.js';
import { loadWebSettings, saveWebSettings, type WebSettings } from '../lib/web-settings.js';
import { clampPercent, runBaselineBytes } from '../lib/budget.js';

export type RunPhase = 'idle' | 'queued' | 'running' | 'done' | 'error';

/**
 * Default cap on simultaneously-tracked NON-TERMINAL runs (queued + running).
 * Queued runs are cheap (an unstarted Orchestrator consumes no budget), so the
 * cap exists only against a runaway client — "queue every project I have" is a
 * supported workflow. `HUU_MAX_QUEUED_RUNS` overrides.
 */
const DEFAULT_MAX_QUEUED_RUNS = 256;
/**
 * Default cap on runs ADMITTED (running) at once; the rest wait in `pending`
 * (queued). The EFFECTIVE cap each tick is the smaller of this and what the
 * RAM budget can hold (baseline + one agent per run). `HUU_MAX_LIVE_RUNS`
 * overrides the ceiling.
 */
const DEFAULT_MAX_LIVE_RUNS = 8;
/** Admission poll cadence (ms) — mirrors the shared MultiRunDriver. */
const ADMIT_CHECK_MS = 500;

/** Positive-int env knob with clamp; unset/garbage → fallback (never throws). */
function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(min, Math.min(max, n));
}

function maxQueuedRuns(): number {
  return envInt('HUU_MAX_QUEUED_RUNS', DEFAULT_MAX_QUEUED_RUNS, 1, 4096);
}

function maxLiveRuns(): number {
  return envInt('HUU_MAX_LIVE_RUNS', DEFAULT_MAX_LIVE_RUNS, 1, 64);
}


export interface StartRunParams {
  /** Pipeline name to resolve from disk/memory. Ignored when `pipeline` set. */
  pipelineName?: string;
  /** A concrete pipeline (e.g. preloaded via `huu run x.json --web`). */
  pipeline?: Pipeline;
  backend: AgentBackendKind;
  /** User-facing provider (openrouter|azure). Carried into AppConfig for display. */
  provider?: LlmProvider;
  modelId: string;
  /**
   * Optional model for the merge/integration conflict-resolver agent. When
   * non-empty it is applied as `Pipeline.integrationModelId`; empty/absent
   * lets the resolver inherit the run model. The resolver always runs at the
   * model's maximum thinking level (see the pi/azure backend factories).
   */
  conflictResolverModelId?: string;
  /**
   * Per-run API key supplied by the browser (validated client-side, kept in
   * session memory, sent with the request). Takes precedence over the
   * env/mount/disk resolver and is NEVER persisted. Absent for CLI/headless
   * callers, which fall back to the resolver.
   */
  apiKey?: string;
  /** Manual concurrency seed (used when mode === 'manual'). */
  concurrency?: number;
  /** Concurrency strategy. Defaults to 'auto' (memory-aware). */
  mode?: 'auto' | 'manual' | 'greedy';
  /** Azure only — endpoint URL override. */
  endpoint?: string;
  /**
   * Directory to run in. Defaults to the server's cwd. Lets the web folder
   * picker target a different project without restarting the server.
   */
  runDirectory?: string;
  /** Per-card timeout in minutes (sets both card timeouts, like the TUI). */
  timeoutMinutes?: number;
  /**
   * Authoritative priority among concurrent runs (lower = higher). The web
   * client sends the project's queue index so the FIRST project in the list is
   * always highest priority, independent of the order the concurrent POSTs
   * happen to reach the server. Absent → arrival order (a monotonic fallback).
   */
  priority?: number;
}

export interface RunSnapshot {
  phase: RunPhase;
  runId: string;
  pipelineName: string;
  /** Absolute directory the run targets — the "project" the run operates on.
      Surfaced so concurrent runs are disambiguable by project, not just pipeline. */
  runDirectory: string;
  backend: AgentBackendKind;
  modelId: string;
  startedAt: number;
  finishedAt?: number;
  errorReason?: string;
  state: OrchestratorState | null;
}

/**
 * Slim a TERMINAL run's retained state — applied AFTER the full terminal frame
 * is broadcast (the browser archives from that frame; IndexedDB owns history).
 * Caps mirror what the orchestrator itself already bounds (getState slices run
 * logs to 200 and per-agent logs accumulate to ≤200), so a late-connecting
 * tab's replay and post-settle /api/agent-logs see the SAME data as before the
 * retention work — the win is the terminal-run retention cap, not lossier
 * logs.
 */
function slimTerminalState(state: OrchestratorState | null): OrchestratorState | null {
  if (!state) return null;
  return {
    ...state,
    logs: state.logs.slice(-200),
    agents: state.agents.map((a) => ({ ...a, logs: a.logs.slice(-200) })),
  };
}

const IDLE_SNAPSHOT: RunSnapshot = {
  phase: 'idle',
  runId: '',
  pipelineName: '',
  runDirectory: '',
  backend: 'jcode',
  modelId: '',
  startedAt: 0,
  state: null,
};

/**
 * The minimal contract the manager drives a run through. Both the real
 * {@link Orchestrator} and the {@link SimulationEngine} satisfy it structurally.
 */
interface RunDriver {
  subscribe(cb: (state: OrchestratorState) => void): () => void;
  subscribeAgentOutput(cb: (chunk: AgentOutputChunk) => void): () => void;
  start(): Promise<{ runId: string; manifest: { errorReason?: string } }>;
}

interface RunEntry {
  snapshot: RunSnapshot;
  /** Live control handle while running; nulled on settle. One of these is set. */
  orch: Orchestrator | null;
  sim: SimulationEngine | null;
}

export class WebRunManager {
  /** One shared budget across every concurrent run. Created+started lazily. */
  private scheduler: GlobalScheduler | null = null;
  private readonly runs = new Map<string, RunEntry>();
  /**
   * Real runs constructed but NOT yet admitted (lazy admission). FIFO order =
   * priority. The admission loop pulls them into `runs` as live capacity frees.
   */
  private readonly pending: Array<{
    runId: string;
    orch: Orchestrator;
    seed: RunSnapshot;
    priority: number;
  }> = [];
  /** Monotonic fallback priority for runs started without an explicit one. */
  private enqueueSeq = 0;
  private admissionController: AdmissionController | null = null;
  private admissionTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Machine-global settings, persisted server-side (~/.config/huu/
   * web-settings.json) — the browser's localStorage is only a display cache.
   * Loaded once at construction; `setRamPercent()` applies + persists changes.
   */
  private settings: WebSettings = loadWebSettings();
  /**
   * Keys saved via the web ⚙ Options THIS server session (`POST /api/keys`).
   * Inside Docker the resolver's step-1 secret mount is a read-only SNAPSHOT
   * taken at container start, so a key saved mid-session would otherwise stay
   * outranked by the stale mount until restart. This map makes a just-saved
   * key take effect IMMEDIATELY for every run that doesn't carry its own
   * browser key; `saveApiKey` (disk, host-mounted via HUU_CONFIG_DIR) covers
   * the next start.
   */
  private readonly webKeys = new Map<string, string>();

  constructor(
    private readonly cwd: string,
    /** Called on every run's state change (server throttles + fans out per runId). */
    private readonly onUpdate: (snap: RunSnapshot) => void,
    /**
     * Called for every coalesced line of streamed agent output, tagged with the
     * originating runId so the server can route the firehose to the right board.
     */
    private readonly onAgentOutput?: (runId: string, chunk: AgentOutputChunk) => void,
  ) {}

  /** Snapshot for a specific run, or (no id) the most-recently-started one. */
  getSnapshot(runId?: string): RunSnapshot {
    if (runId) return this.runs.get(runId)?.snapshot ?? IDLE_SNAPSHOT;
    const entries = [...this.runs.values()];
    return entries.length ? entries[entries.length - 1]!.snapshot : IDLE_SNAPSHOT;
  }

  /** Every tracked run's snapshot, in start order. */
  getSnapshots(): RunSnapshot[] {
    return [...this.runs.values()].map((e) => e.snapshot);
  }

  /** True while any run is still running OR queued (waiting for capacity). */
  isActive(): boolean {
    for (const e of this.runs.values())
      if (e.snapshot.phase === 'running' || e.snapshot.phase === 'queued') return true;
    return false;
  }

  /** Admitted (running) runs — the live concurrency the admission loop gates. */
  private activeCount(): number {
    let n = 0;
    for (const e of this.runs.values()) if (e.snapshot.phase === 'running') n++;
    return n;
  }

  /** Non-terminal runs (queued + running) — the cap on total accepted work. */
  private nonTerminalCount(): number {
    let n = 0;
    for (const e of this.runs.values())
      if (e.snapshot.phase === 'running' || e.snapshot.phase === 'queued') n++;
    return n;
  }

  /** True when some admitted run is merging (pool drained → box idle). */
  private anyIntegrating(): boolean {
    for (const e of this.runs.values()) if (e.snapshot.state?.status === 'integrating') return true;
    return false;
  }

  /** Start the lazy-admission loop (idempotent). Stops itself when `pending` drains. */
  private ensureAdmissionLoop(): void {
    if (!this.admissionController) {
      this.admissionController = new AdmissionController({ maxAdmitted: maxLiveRuns() });
    }
    if (this.admissionTimer) return;
    this.admissionTimer = setInterval(() => this.tickAdmission(), ADMIT_CHECK_MS);
    this.admissionTimer.unref?.();
  }

  /**
   * One admission pass: pull in the next queued run when the budget allows.
   * Beyond the scheduler's slot signal, admission now charges a run's fixed
   * BASELINE cost (Node structures, repo scan, worktrees) against the byte
   * headroom, and the live cap adapts to the machine: a small box admits fewer
   * concurrent runs than the HUU_MAX_LIVE_RUNS ceiling.
   */
  private tickAdmission(): void {
    if (this.pending.length === 0) {
      if (this.admissionTimer) {
        clearInterval(this.admissionTimer);
        this.admissionTimer = null;
      }
      return;
    }
    // Shared with the Ink TUI + run-many via MultiRunDriver — keep the admission
    // rule in ONE place (`computeAdmissionContext`), never re-derived per surface.
    const ctx = computeAdmissionContext({
      liveAdmitted: this.activeCount(),
      pendingCount: this.pending.length,
      anyIntegrating: this.anyIntegrating(),
      runBaselineBytes: runBaselineBytes(),
      budget: this.scheduler,
    });
    if (this.admissionController!.shouldAdmit(ctx)) {
      this.admitNext();
    }
  }

  /** Admit (start) the highest-priority queued run, flipping it to `running`. */
  private admitNext(): void {
    const item = this.pending.shift();
    if (!item) return;
    const entry = this.runs.get(item.runId);
    if (!entry) return; // aborted while queued
    const waitedMs = Date.now() - item.seed.startedAt;
    entry.snapshot = { ...entry.snapshot, phase: 'running', startedAt: Date.now() };
    termLog(
      'info',
      basename(entry.snapshot.runDirectory) || entry.snapshot.runDirectory,
      `run ${item.runId} started${waitedMs > 2_000 ? ` (waited ${fmtDuration(waitedMs)} in the queue)` : ''}`,
    );
    this.beginRun(entry, item.orch, { orch: item.orch });
  }

  private ensureScheduler(): GlobalScheduler {
    if (!this.scheduler) {
      this.scheduler = new GlobalScheduler({
        // "Agents globally announce when they stop": one serve-terminal line
        // per exit with the global counts (only fires in true multi-run).
        onAnnounce: (line) => termLog('info', 'sched', line),
      });
      // Persisted web dial (server-side settings) wins over env/default.
      this.scheduler.setBudgetPercent(this.effectiveRamPercent());
      this.scheduler.start();
      // Gap-B loud warning (once per process): inside the container but no
      // cgroup ceiling → the budget is % of the HOST total with no kernel
      // backstop — the config of the multi-run OOM incident.
      const warning = noKernelCeilingWarning(this.scheduler.budgetTelemetry());
      if (warning) termLog('warn', 'ram', warning);
    }
    return this.scheduler;
  }

  /** The dial in effect: persisted web setting, else HUU_RAM_PERCENT, else 70. */
  effectiveRamPercent(): number {
    return resolveRamPercent(this.settings.ramPercent);
  }

  /**
   * Apply + persist the machine-global RAM dial NOW (the `POST /api/settings`
   * handler). A non-finite/absent value clears the web override (falls back to
   * env/default). Returns the effective percent so the client can read back
   * what actually took — the old dial only traveled piggybacked on run POSTs,
   * so changing it mid-run silently did nothing.
   */
  setRamPercent(pct?: number): number {
    if (typeof pct === 'number' && Number.isFinite(pct)) {
      this.settings = { ...this.settings, ramPercent: clampPercent(pct) };
    } else {
      const { ramPercent: _cleared, ...rest } = this.settings;
      this.settings = rest;
    }
    saveWebSettings(this.settings);
    const effective = this.effectiveRamPercent();
    this.scheduler?.setBudgetPercent(effective);
    return effective;
  }

  /**
   * Machine-global budget telemetry for the `{type:'budget'}` SSE frame — the
   * scheduler's snapshot plus the manager's run counts. Null until the first
   * real run constructs the scheduler.
   */
  budgetTelemetry(): (Record<string, unknown> & { budgetPercent: number }) | null {
    if (!this.scheduler) return null;
    let queued = 0;
    let running = 0;
    for (const e of this.runs.values()) {
      if (e.snapshot.phase === 'queued') queued++;
      else if (e.snapshot.phase === 'running') running++;
    }
    return { ...this.scheduler.budgetTelemetry(), queuedRuns: queued, runningRuns: running };
  }

  /**
   * Register a key saved via the web ⚙ Options so runs in THIS server session
   * use it right away (see {@link webKeys}). Disk persistence is the caller's
   * job (`saveApiKey`) — this is only the live override.
   */
  setWebKey(name: string, value: string): void {
    const v = value.trim();
    if (!name || !v) return;
    this.webKeys.set(name, v);
  }

  /** Drop the live web-Options override for a key (e.g. after a clear). */
  clearWebKey(name: string): void {
    this.webKeys.delete(name);
  }

  /** The live web-Options override for a key, or ''. Never the disk store. */
  getWebKey(name: string): string {
    return this.webKeys.get(name) ?? '';
  }

  /**
   * Resolve config + factory, construct a fresh Orchestrator subordinate to the
   * shared scheduler, and kick the run. Returns its snapshot (runId already
   * assigned). Throws on user-correctable problems (missing key/pipeline/
   * endpoint, or too many concurrent runs) so the server returns a 4xx.
   */
  start(params: StartRunParams): RunSnapshot {
    const cap = maxQueuedRuns();
    if (this.nonTerminalCount() >= cap) {
      throw new Error(`Too many concurrent runs (max ${cap}).`);
    }

    const pipeline =
      params.pipeline ??
      (params.pipelineName ? getPipelineByName(this.cwd, params.pipelineName) : null);
    if (!pipeline) {
      throw new Error(`Pipeline not found: ${params.pipelineName ?? '(none provided)'}`);
    }

    const effectivePipeline = applyResolverModel(
      applyTimeout(pipeline, params.timeoutMinutes),
      params.conflictResolverModelId,
    );

    // Resolve the run directory: an explicit pick from the folder picker, or
    // the server's cwd. Validate up front so a typo fails as a 4xx instead of
    // surfacing deep in preflight.
    const runDir = params.runDirectory?.trim() || this.cwd;
    if (!existsSync(runDir) || !statSync(runDir).isDirectory()) {
      throw new Error(`Run directory does not exist: ${runDir}`);
    }

    const bundle = selectBackend(params.backend);
    // THE line the whole web credential path hangs on: the provider the
    // browser picked, honored. `params.provider` used to be accepted, stored
    // for display, and then ignored here in favor of `bundle.apiKeySpecName`
    // — so an OpenRouter run resolved the DeepSeek spec: it was refused when
    // only OPENROUTER_API_KEY existed, and (worse) ran silently against
    // DeepSeek when only DEEPSEEK_API_KEY existed.
    const { provider: runProvider, spec: credSpec, label: credLabel } = runCredential(
      params.backend,
      params.provider,
    );

    let apiKey = 'stub';
    let keySource: NonNullable<AppConfig['apiKeySource']> = 'none';
    let keyNote = 'not needed';
    let endpoint: string | undefined;
    /**
     * Multi-key rotation for THIS run. Opt-in by construction: seeded with the
     * key the run already resolved, `createKeyPoolHandle` hands back a
     * SINGLETON (never rotates) unless that key is a member of the persisted
     * pool — so a browser session key and a Docker secret mount, both of which
     * outrank the store, are never silently swapped for another key.
     */
    let keyPool: KeyPoolHandle | undefined;
    if (bundle.requiresApiKey) {
      const spec = credSpec;
      const specName = spec?.name;
      // Key precedence for a web run: the key the browser sent with THIS run
      // (validated, session-held) → a key saved via the web ⚙ Options this
      // server session → the env/mount/disk resolver (CLI path). The winning
      // source travels in AppConfig.apiKeySource so a 401 blames the right key.
      const picked = pickRunKey(
        params.apiKey,
        specName ? this.webKeys.get(specName) : undefined,
        spec,
      );
      apiKey = picked.value;
      keySource = picked.source;
      keyNote = describeKeySource(picked.source, apiKey, spec);
      if (!apiKey) {
        // Names the PROVIDER and its env var: "jcode needs an API key" was
        // unactionable when the missing credential could be either of two.
        const who = credLabel || bundle.label;
        const envVar = spec ? ` (${spec.envVar})` : '';
        throw new Error(
          `${who} needs an API key${envVar}. Save one in ⚙ Options (validated) or paste one in the launch form.`,
        );
      }
      if (spec) keyPool = createKeyPoolHandle(spec, apiKey);
      if (picked.storedOverridesEnv && spec) {
        termLog(
          'warn',
          'keys',
          `${spec.envVar} is set in the environment but IGNORED — the key saved in Options wins. ` +
            `Clear the saved key in ⚙ Options to fall back to ${spec.envVar}.`,
        );
      }
      if (false) {
        const endpointSpec = findSpec('deepseek')!;
        endpoint =
          params.endpoint?.trim() ||
          (endpointSpec ? resolveApiKey(endpointSpec) : '') ||
          undefined;
        if (!endpoint) {
          throw new Error(
            'Azure needs an endpoint URL. Add AZURE_OPENAI_BASE_URL under Settings → Keys.',
          );
        }
      }
    }

    const config: AppConfig = {
      apiKey: apiKey || 'stub',
      modelId: params.modelId,
      backend: params.backend,
      // The choice reaches the orchestrator, so the run spends — and, once the
      // jcode profile wave lands, TALKS TO — the provider the user picked.
      provider: runProvider,
      endpoint,
      apiKeySource: keySource,
    };

    const runId = generateRunId();
    // 'greedy' (MAX) is coerced to 'auto': every web run is subordinate to the
    // GlobalScheduler, whose shared budget scaler is always 'auto' — a per-run
    // greedy mode changed nothing but the UI label, and pretending otherwise is
    // how the 33-run incident was launched. The dial (settings) is the lever.
    const mode = params.mode === 'greedy' ? 'auto' : (params.mode ?? 'auto');
    // Authoritative priority = the project's position in the client's queue list
    // (lower = higher). Falls back to arrival order for callers that don't send
    // one. This — NOT the racy POST arrival order — keeps the first project in
    // the list served first.
    const priority = params.priority ?? this.enqueueSeq++;
    // The shared scheduler carries the machine-global RAM dial (persisted web
    // setting via setRamPercent / POST /api/settings — no longer per-run).
    const scheduler = this.ensureScheduler();
    const projectName = basename(runDir) || runDir;
    const orch = new Orchestrator(config, effectivePipeline, runDir, bundle.agentFactory, {
      conflictResolverFactory: bundle.conflictResolverFactory,
      autoScale: mode !== 'manual',
      initialConcurrency: params.concurrency,
      scheduler,
      priority,
      runId,
      // Hold the run open in `awaiting_retry` when it ends with failed cards so
      // the browser can retry individual failures (a timed-out card with a
      // longer limit) before the run tears down. See server `/api/run/retry`.
      interactiveRetry: true,
      // Mirror the run's activity log to the serve terminal — the browser
      // already sees it (SSE run-log console); the terminal used to see nothing.
      onLog: (entry) => mirrorRunLog(projectName, entry),
      // Undefined for a key-less backend; a singleton (no rotation, today's
      // behavior byte for byte) unless the resolved key is a pool member.
      keyPool,
    });

    const seed: RunSnapshot = {
      phase: 'queued',
      runId,
      pipelineName: effectivePipeline.name,
      runDirectory: runDir,
      backend: params.backend,
      modelId: params.modelId,
      startedAt: Date.now(),
      state: null,
    };
    // LAZY ADMISSION: register the run as QUEUED and let the admission loop pull
    // it in once the shared budget shows sustained spare capacity (or a run is
    // merging). The FIRST run (nothing live yet) starts immediately. This is the
    // direct fix for the OOM incident — the whole project queue no longer spawns
    // at once; the browser keeps POSTing every item, the SERVER paces them.
    const entry: RunEntry = { snapshot: seed, orch, sim: null };
    termLog(
      'info',
      projectName,
      `run ${runId} queued — pipeline "${effectivePipeline.name}", model ${params.modelId || '(default)'}, ` +
        `key ${keyNote}` +
        (typeof params.priority === 'number' ? `, priority ${params.priority}` : ''),
    );
    this.runs.set(runId, entry);
    // Keep `pending` ordered by priority (lower first) so admitNext() always
    // pulls the earliest-in-the-list project next, even if two POSTs arrived out
    // of order. JS sort is stable → equal priorities keep insertion order.
    this.pending.push({ runId, orch, seed, priority });
    this.pending.sort((a, b) => a.priority - b.priority);
    this.ensureAdmissionLoop();
    if (this.activeCount() === 0) this.admitNext();
    this.onUpdate(entry.snapshot);
    return entry.snapshot;
  }

  /**
   * Start a synthetic `/simulation` run. No backend/key/pipeline resolution, no
   * git, no LLM, no scheduler — the {@link SimulationEngine} fabricates the
   * kanban. Tracked in the same map so several can show in the selector.
   */
  startSimulation(opts: SimulationOptions): RunSnapshot {
    const cap = maxQueuedRuns();
    if (this.nonTerminalCount() >= cap) {
      throw new Error(`Too many concurrent runs (max ${cap}).`);
    }
    const engine = new SimulationEngine(opts);
    const seed: RunSnapshot = {
      phase: 'running',
      runId: opts.runId,
      pipelineName: engine.pipelineName,
      runDirectory: this.cwd,
      backend: 'stub',
      modelId: opts.modelIds[0] || 'simulation',
      startedAt: Date.now(),
      state: null,
    };
    return this.launch(opts.runId, engine, seed, { sim: engine });
  }

  /**
   * Create an entry and start it immediately (the `/simulation` path — sims are
   * synthetic and lightweight, so they are not lazily admitted). Real runs go
   * through the pending queue + {@link admitNext} instead.
   */
  private launch(
    runId: string,
    driver: RunDriver,
    seed: RunSnapshot,
    refs: { orch?: Orchestrator; sim?: SimulationEngine },
  ): RunSnapshot {
    const entry: RunEntry = { snapshot: seed, orch: refs.orch ?? null, sim: refs.sim ?? null };
    this.runs.set(runId, entry);
    this.beginRun(entry, driver, refs);
    return entry.snapshot;
  }

  /**
   * Subscribe a driver to the snapshot + firehose channels and kick it off
   * fire-and-forget, flipping its phase on settle. Operates on an EXISTING entry
   * (created by {@link launch} for sims, or pre-registered as 'queued' for
   * lazily-admitted real runs), so concurrent runs never clobber each other.
   */
  private beginRun(
    entry: RunEntry,
    driver: RunDriver,
    refs: { orch?: Orchestrator; sim?: SimulationEngine },
  ): void {
    entry.orch = refs.orch ?? entry.orch;
    entry.sim = refs.sim ?? entry.sim;
    const runId = entry.snapshot.runId;

    const unsubscribe = driver.subscribe((state) => {
      entry.snapshot = { ...entry.snapshot, runId: state.runId || runId, state };
      this.onUpdate(entry.snapshot);
    });

    let unsubscribeOutput: (() => void) | null = null;
    if (this.onAgentOutput) {
      const cb = this.onAgentOutput;
      unsubscribeOutput = driver.subscribeAgentOutput((chunk) => cb(runId, chunk));
    }

    const project = basename(entry.snapshot.runDirectory) || entry.snapshot.runDirectory || 'run';
    driver
      .start()
      .then((result) => {
        entry.snapshot = {
          ...entry.snapshot,
          phase: 'done',
          runId: result.runId || runId,
          finishedAt: Date.now(),
          errorReason: result.manifest.errorReason,
          state: entry.snapshot.state,
        };
        const took = fmtDuration(Date.now() - entry.snapshot.startedAt);
        const cost = entry.snapshot.state?.totalCost;
        if (result.manifest.errorReason) {
          termLog('warn', project, `run ${runId} finished WITH PROBLEMS after ${took}: ${firstLine(result.manifest.errorReason)}`);
        } else {
          termLog(
            'ok',
            project,
            `run ${runId} finished in ${took}` +
              (typeof cost === 'number' && cost > 0 ? ` — cost $${cost.toFixed(4)}` : ''),
          );
        }
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        entry.snapshot = {
          ...entry.snapshot,
          phase: 'error',
          finishedAt: Date.now(),
          errorReason: message,
          state: entry.snapshot.state,
        };
        termLog('error', project, `run ${runId} FAILED: ${firstLine(message)}`);
      })
      .finally(() => {
        unsubscribe();
        unsubscribeOutput?.();
        entry.orch = null;
        entry.sim = null;
        // Broadcast the FULL terminal frame FIRST — the browser archives run
        // history (IndexedDB / export) from this frame, so it must precede any
        // trimming. Only THEN slim the retained copy (memory hygiene: a
        // terminal run's state used to live untrimmed for the server's
        // lifetime) and cap how many terminal runs stay tracked at all.
        this.onUpdate(entry.snapshot);
        entry.snapshot = { ...entry.snapshot, state: slimTerminalState(entry.snapshot.state) };
        this.pruneTerminalRuns();
      });

    this.onUpdate(entry.snapshot);
  }

  /**
   * Drop the OLDEST terminal runs beyond the retention cap. Non-terminal runs
   * are never touched; the browser keeps full history in IndexedDB anyway.
   */
  private pruneTerminalRuns(keep = 100): void {
    const terminal: string[] = [];
    for (const [id, e] of this.runs) {
      if (e.snapshot.phase === 'done' || e.snapshot.phase === 'error') terminal.push(id);
    }
    while (terminal.length > keep) this.runs.delete(terminal.shift()!);
  }

  /** Hard-stop one run, or (no id) every run + tear the shared scheduler down. */
  abort(runId?: string): void {
    termLog('warn', 'web', runId ? `abort requested for run ${runId}` : 'abort requested for ALL runs');
    if (runId) {
      // Queued (not yet admitted) → drop from the pending queue and mark it.
      const qi = this.pending.findIndex((p) => p.runId === runId);
      if (qi >= 0) {
        this.pending.splice(qi, 1);
        this.markAbortedBeforeAdmission(runId);
        return;
      }
      const e = this.runs.get(runId);
      e?.orch?.abort();
      e?.sim?.abort();
      return;
    }
    // Abort everything: stop admission, drop the queue, abort live runs.
    if (this.admissionTimer) {
      clearInterval(this.admissionTimer);
      this.admissionTimer = null;
    }
    for (const p of this.pending.splice(0)) this.markAbortedBeforeAdmission(p.runId);
    for (const e of this.runs.values()) {
      e.orch?.abort();
      e.sim?.abort();
    }
    this.scheduler?.stop();
    this.scheduler = null;
  }

  /** Flip a still-queued run to error (it never consumed budget). */
  private markAbortedBeforeAdmission(runId: string): void {
    const e = this.runs.get(runId);
    if (e && e.snapshot.phase === 'queued') {
      e.snapshot = {
        ...e.snapshot,
        phase: 'error',
        finishedAt: Date.now(),
        errorReason: 'aborted before admission',
      };
      this.onUpdate(e.snapshot);
    }
  }

  /** Pause/resume a /simulation run (no-op for real runs / unknown id). */
  setPaused(runId: string, paused: boolean): void {
    this.runs.get(runId)?.sim?.setPaused(paused);
  }

  /** Pin manual concurrency for one run (also flips it out of auto/greedy). */
  setConcurrency(runId: string, value: number): void {
    const e = this.runs.get(runId);
    e?.orch?.setConcurrency(value);
    e?.sim?.setConcurrency(value);
  }

  /** Nudge one run's concurrency up/down by one. */
  adjust(runId: string, delta: number): void {
    const e = this.runs.get(runId);
    const driver = e?.orch ?? e?.sim;
    if (!driver) return;
    if (delta > 0) driver.increaseConcurrency();
    else if (delta < 0) driver.decreaseConcurrency();
  }

  /**
   * Switch one run's concurrency strategy mid-run. 'greedy' coerces to 'auto':
   * a scheduler-subordinate run's greedy flag never drove anything (grants
   * govern it), so the web no longer offers or honors MAX.
   */
  setMode(runId: string, mode: 'auto' | 'manual' | 'greedy'): void {
    const e = this.runs.get(runId);
    const driver = e?.orch ?? e?.sim;
    if (!driver) return;
    if (mode === 'manual') driver.disableAutoScale();
    else driver.enableAutoScale();
  }

  /**
   * Retry a single failed task card while a real run is held open in
   * `awaiting_retry`. Optional `timeoutMinutes` re-runs a timed-out card with a
   * longer per-task limit. No-op for /simulation or unknown ids. Fire-and-forget
   * — progress streams over SSE like any other state change.
   */
  retryTask(runId: string, agentId: number, timeoutMinutes?: number): void {
    const orch = this.runs.get(runId)?.orch;
    if (!orch) return;
    const timeoutMs =
      timeoutMinutes && timeoutMinutes > 0 ? Math.floor(timeoutMinutes * 60_000) : undefined;
    void orch.retryTask(agentId, timeoutMs ? { timeoutMs } : undefined);
  }

  /** Leave the `awaiting_retry` hold so the run finalizes + tears down. */
  finish(runId: string): void {
    this.runs.get(runId)?.orch?.finish();
  }
}

/**
 * Apply a per-card timeout (minutes) to a pipeline, matching the TUI's
 * TimeoutPrompt: both the multi-file and single-file card timeouts are set.
 * Returns the original pipeline untouched when no timeout is requested.
 */
export function applyTimeout(pipeline: Pipeline, minutes?: number): Pipeline {
  if (!minutes || minutes <= 0) return pipeline;
  const ms = Math.floor(minutes * 60_000);
  return { ...pipeline, cardTimeoutMs: ms, singleFileCardTimeoutMs: ms };
}

/**
 * Pin the merge/integration conflict-resolver model. An empty/whitespace value
 * leaves the pipeline untouched so the resolver inherits the run model
 * (`Pipeline.integrationModelId ?? config.modelId`). The orchestrator already
 * reads `integrationModelId`, so this is the entire wiring needed.
 */
export function applyResolverModel(pipeline: Pipeline, modelId?: string): Pipeline {
  const trimmed = modelId?.trim();
  if (!trimmed) return pipeline;
  return { ...pipeline, integrationModelId: trimmed };
}

/**
 * The credential a web run is about to spend, decided by the PROVIDER.
 *
 * This is the seam the whole web credential path hangs on, and it is exported
 * because the invariant it encodes is the contract:
 *   · an OpenRouter run asks for `OPENROUTER_API_KEY` and nothing else;
 *   · a DeepSeek run asks for `DEEPSEEK_API_KEY` and nothing else;
 *   · a `stub` run asks for nothing at all.
 *
 * It replaced `bundle.apiKeySpecName`, which is keyed on the BACKEND — and
 * `jcode` serves BOTH providers, so that reading resolved every jcode run to
 * the DeepSeek spec: it refused an OpenRouter run that held a perfectly good
 * OpenRouter key, and (worse) silently spent the DeepSeek key when that one
 * happened to exist.
 */
export function runCredential(
  backend: AgentBackendKind,
  provider?: LlmProvider,
): { provider: LlmProvider | undefined; spec: ApiKeySpec | undefined; label: string } {
  const runProvider = resolveRunProvider(backend, provider);
  if (!runProvider) return { provider: undefined, spec: undefined, label: '' };
  const info = providerInfo(runProvider);
  return { provider: runProvider, spec: findSpec(info.apiKeySpecName), label: info.label };
}

/**
 * Decide which key a web run uses and where it came from:
 *   1. the key the browser sent with THIS run (validated client-side, held in
 *      sessionStorage) → `'request'`;
 *   2. a key saved via the web ⚙ Options this server session → `'options'`;
 *   3. the `lib/api-key` resolver (secret-mount → stored → env-file → env).
 * Exported for tests — the precedence IS the contract (a stale lower tier
 * silently outranking a fresh higher one is the 401-misattribution bug class).
 */
export function pickRunKey(
  requestKey: string | undefined,
  webOptionsKey: string | undefined,
  spec: ApiKeySpec | undefined,
): {
  value: string;
  source: NonNullable<AppConfig['apiKeySource']>;
  storedOverridesEnv: boolean;
} {
  const fromRequest = requestKey?.trim();
  if (fromRequest) return { value: fromRequest, source: 'request', storedOverridesEnv: false };
  const fromOptions = webOptionsKey?.trim();
  if (fromOptions) return { value: fromOptions, source: 'options', storedOverridesEnv: false };
  if (!spec) return { value: '', source: 'none', storedOverridesEnv: false };
  const res = resolveApiKeyWithSource(spec);
  return { value: res.value, source: res.source, storedOverridesEnv: res.storedOverridesEnv };
}

/** Human phrase for the terminal log: which key a run is using, masked. */
function describeKeySource(
  source: NonNullable<AppConfig['apiKeySource']>,
  apiKey: string,
  spec: ApiKeySpec | undefined,
): string {
  if (!apiKey) return 'MISSING';
  const masked = maskKey(apiKey);
  switch (source) {
    case 'request':
      return `${masked} (sent by the browser session)`;
    case 'options':
      return `${masked} (saved via web ⚙ Options)`;
    case 'secret-mount':
      return `${masked} (forwarded from the host when huu started)`;
    case 'stored':
      return `${masked} (saved config store)`;
    case 'env-file':
      return `${masked} (file named by ${spec?.envFileVar ?? 'the _FILE env var'})`;
    case 'env':
      return `${masked} (environment variable ${spec?.envVar ?? ''})`.replace(' )', ')');
    default:
      return masked;
  }
}

/**
 * Mirror one orchestrator activity-log entry to the serve terminal — the same
 * stream the web run-log console renders. `debug` entries stay in the run-log
 * file (they'd drown the terminal).
 */
function mirrorRunLog(project: string, entry: LogEntry): void {
  if (entry.level === 'debug') return;
  const who =
    entry.agentId === 9999
      ? '[merge] '
      : entry.agentId === 9998
        ? '[judge] '
        : entry.agentId >= 0
          ? `[agent ${entry.agentId}] `
          : '';
  const stage = entry.stageName ? `${entry.stageName} — ` : '';
  const level = entry.level === 'error' ? 'error' : entry.level === 'warn' ? 'warn' : 'info';
  termLog(level, project, `${who}${stage}${entry.message}`);
}

/** `95s` → `1m35s`; sub-minute stays in seconds. */
function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

/** First line of a (possibly multi-line) error message, for one-line logs. */
function firstLine(message: string): string {
  const i = message.indexOf('\n');
  return i === -1 ? message : `${message.slice(0, i)} …`;
}

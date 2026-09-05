// Screen state for the Ink TUI (src/app.tsx). Keep it pure and side-effect-free
// — all I/O (selectBackend, resolveApiKey, findMissingKeysForBackend, saveApiKey,
// exit(), terminal clears, …) happens in the caller and is passed back to the
// reducer via event payloads.
//
// (The web front-end has its OWN state model in the browser — `src/web/session.ts`
// was planned but never built, so this reducer has exactly one consumer.)

import type { ApiKeySpec } from './api-key.js';
import { resolveRunProvider, type LlmProvider } from './providers.js';
import type { AgentBackendKind, OrchestratorResult, Pipeline } from './types.js';

export type Screen =
  | { kind: 'welcome' }
  | { kind: 'faq' }
  | { kind: 'pipeline-assistant' }
  | { kind: 'pipeline-editor' }
  | { kind: 'pipeline-import' }
  | { kind: 'pipeline-import-custom' }
  | { kind: 'pipeline-import-paste' }
  | { kind: 'pipeline-export' }
  | { kind: 'saved-pipelines' }
  | { kind: 'options'; focusSpecName?: string }
  /**
   * `multi: true` browses the tree checking off N PROJECT folders (the
   * run-across-projects flow); absent/false is the classic "pick one run
   * directory" behavior.
   */
  | { kind: 'directory-picker'; multi?: boolean }
  /**
   * The library of hand-drawn methods (`huu-devgraph-v1`). It is a PICKER, not a
   * canvas: a graph compiles into a `Pipeline` and the TUI already knows how to
   * run one of those, so this screen lists, inspects and LAUNCHES — it never
   * opens a second run machine of its own.
   */
  | { kind: 'graph-picker' }
  /**
   * One graph, read out loud: the ASCII diagram plus every problem the validator
   * found. The id rides on the VARIANT (not on `FsmState`) so the screen is
   * self-describing — a stale "current graph" field could survive a screen
   * change and make the next visit inspect the wrong drawing.
   */
  | { kind: 'graph-detail'; graphId: string }
  /** Review the (pipeline × project) fan-out before spending RAM and tokens. */
  | { kind: 'run-queue'; modelId: string; apiKey: string }
  | { kind: 'backend-selector' }
  /**
   * `provider` rides on the screen next to `backendKind` because the model
   * CATALOG is provider-scoped: `jcode` serves DeepSeek and OpenRouter, so
   * filtering by backend alone mixes Claude and DeepSeek entries into one list.
   */
  | { kind: 'model-selector'; backendKind: AgentBackendKind; provider?: LlmProvider }
  | { kind: 'api-key'; missing: ApiKeySpec[] }
  | { kind: 'timeout-prompt'; modelId: string; apiKey: string }
  | {
      kind: 'resolver-model-selector';
      backendKind: AgentBackendKind;
      provider?: LlmProvider;
      modelId: string;
      apiKey: string;
    }
  | { kind: 'run'; modelId: string; apiKey: string }
  | { kind: 'summary'; result: OrchestratorResult };

export interface FsmState {
  screen: Screen;
  pipeline: Pipeline | null;
  /**
   * A multi-run BATCH: 2+ pipelines selected to run CONCURRENTLY under one
   * shared scheduler. Set only via `saved.selectMany`; cleared whenever a
   * single pipeline is chosen. When set, the `run` screen renders the
   * MultiRunDashboard instead of RunDashboard. `pipeline` holds pipelines[0]
   * as a representative so the shared config flow has something to read.
   */
  pipelines: Pipeline[] | null;
  /**
   * Project roots marked in the MULTI-mark directory picker. Non-empty means the
   * run is a (pipeline × project) fan-out — one run per pair, each with its OWN
   * `cwd` — instead of N pipelines against the single session `repoRoot`. Cleared
   * by every single-pipeline transition, exactly like {@link pipelines}: a stale
   * list would silently multiply a later single run across old folders.
   */
  projectDirs: string[];
  modelId: string;
  /**
   * Optional model for the merge/integration conflict-resolver agent, chosen on
   * the run-launch `resolver-model-selector` screen. Empty = inherit `modelId`.
   * Applied to the pipeline(s) as `Pipeline.integrationModelId` before the run.
   */
  conflictResolverModelId: string;
  backendKind: AgentBackendKind;
  /**
   * The provider the user chose — the axis that names the credential and the
   * base URL. `undefined` only for a backend that serves none (`stub`).
   *
   * It is SEPARATE from `backendKind` on purpose: both `deepseek` and
   * `openrouter` dispatch to `jcode`, so collapsing the choice into the
   * backend (what the TUI used to do at `BackendSelector.onSelect`) throws the
   * user's pick away one screen before the credential gate reads it.
   */
  provider: LlmProvider | undefined;
  apiKey: string;
  requiresApiKey: boolean;
  pipelineSourceName: string | null;
}

export type FsmEvent =
  // welcome
  | { type: 'welcome.assistant' }
  | { type: 'welcome.new' }
  | { type: 'welcome.import' }
  | { type: 'welcome.saved' }
  | { type: 'welcome.selectPipeline'; pipeline: Pipeline }
  | { type: 'welcome.faq' }
  | { type: 'welcome.options' }
  | { type: 'welcome.directory' }
  /** Open the picker in MULTI-mark mode to run across several projects. */
  | { type: 'welcome.projects' }
  /** Open the library of hand-drawn methods (devgraphs). */
  | { type: 'welcome.graphs' }
  | { type: 'welcome.quit' }
  // graph-picker / graph-detail (hand-drawn methods)
  | { type: 'graph.inspect'; graphId: string }
  /** Leave the detail view — back to the list, never to welcome. */
  | { type: 'graph.back' }
  | { type: 'graph.cancel' }
  /**
   * A graph COMPILED. The caller did the I/O (read the file, ran
   * `compileGraphPipeline`, which THROWS on an invalid graph) and hands the
   * finished `Pipeline` in; the reducer only routes it into the launch config
   * that already exists. `graphName` names the drawing, not the emitted
   * pipeline, so the run screen says which method is running.
   */
  | {
      type: 'graph.launch';
      pipeline: Pipeline;
      graphName: string;
      initialBackendSet: boolean;
    }
  // options (provider/API-key editor)
  | { type: 'options.close' }
  // directory-picker (choose where to run)
  | { type: 'directory.select' }
  /** Multi-mark confirmed: N project roots → pick the pipeline(s) to fan out. */
  | { type: 'directory.selectMany'; dirs: string[] }
  | { type: 'directory.cancel' }
  // run-queue (review the pipeline × project fan-out)
  | { type: 'runQueue.confirm' }
  | { type: 'runQueue.cancel' }
  // faq
  | { type: 'faq.back' }
  // pipeline-assistant
  | { type: 'assistant.complete'; pipeline: Pipeline }
  | { type: 'assistant.cancel' }
  // pipeline-editor
  | { type: 'editor.complete'; pipeline: Pipeline; initialBackendSet: boolean }
  | { type: 'editor.import' }
  | { type: 'editor.export'; pipeline: Pipeline }
  | { type: 'editor.cancel' }
  // backend-selector
  | {
      type: 'backend.select';
      backendKind: AgentBackendKind;
      /** The provider actually picked. Omitted → the backend's first provider. */
      provider?: LlmProvider;
      requiresApiKey: boolean;
      skipModelSelector: boolean;
      firstStepModelId?: string;
    }
  | { type: 'backend.cancel' }
  // pipeline-import
  | { type: 'import.selectFromList'; pipeline: Pipeline }
  | { type: 'import.paste' }
  | { type: 'import.customPath' }
  | { type: 'import.cancel' }
  // pipeline-import-paste
  | { type: 'importPaste.complete'; pipeline: Pipeline }
  | { type: 'importPaste.cancel' }
  // pipeline-import-custom
  | { type: 'importCustom.complete'; pipeline: Pipeline | null }
  | { type: 'importCustom.cancel' }
  // pipeline-export
  | { type: 'export.complete' }
  | { type: 'export.cancel' }
  // saved-pipelines
  // `initialBackendSet` mirrors `editor.complete`: with a backend already locked
  // by a CLI flag (--stub / --backend= / --provider=), the provider picker is
  // skipped. Without it a `--stub` batch walked into the provider screen and
  // OVERWROTE the stub backend with whatever was highlighted there.
  | { type: 'saved.select'; pipeline: Pipeline; initialBackendSet?: boolean }
  | { type: 'saved.selectMany'; pipelines: Pipeline[]; initialBackendSet?: boolean }
  | { type: 'saved.cancel' }
  // model-selector
  | {
      type: 'modelSelector.select';
      modelId: string;
      requiresApiKey: boolean;
      backendKind: AgentBackendKind;
      /** Omitted → keep `state.provider` (re-derived against `backendKind`). */
      provider?: LlmProvider;
      missingKeys: ApiKeySpec[];
      resolvedApiKey: string;
    }
  | { type: 'modelSelector.cancel'; initialBackendSet: boolean }
  // api-key
  | { type: 'apiKey.submit'; resolvedApiKey: string }
  | { type: 'apiKey.cancel' }
  // timeout-prompt
  | { type: 'timeout.submit'; minutes: number }
  | { type: 'timeout.cancel' }
  // resolver-model-selector (optional conflict-resolver model pick)
  | { type: 'resolverModelSelector.select'; modelId: string }
  | { type: 'resolverModelSelector.skip' }
  // skip-model-selector fast path: dispatched from editor.onComplete or
  // BackendSelector.onSelect when every pipeline step already pins its
  // own modelId (so the global model selector would never be consulted).
  // Mirrors the legacy `navigateToRunSkippingModel` helper: routes to
  // api-key when keys are missing, otherwise straight to `run`.
  | {
      type: 'runDirect';
      modelId: string;
      missingKeys: ApiKeySpec[];
      resolvedApiKey: string;
      /** When set, replaces state.pipeline (editor fast path). */
      pipeline?: Pipeline;
      /** When set, updates state.backendKind (backend-selector fast path). */
      backendKind?: AgentBackendKind;
      /** When set, updates state.provider (backend-selector fast path). */
      provider?: LlmProvider;
      /** When set, overrides state.requiresApiKey (backend-selector fast path). */
      requiresApiKey?: boolean;
    }
  // run
  | { type: 'run.complete'; result: OrchestratorResult }
  | { type: 'run.abort' }
  // run → auth failure: jump to the Options screen pre-focused on the
  // rejected provider so the user can fix the key in place.
  | { type: 'run.authError'; backendKind: AgentBackendKind; specName?: string }
  // summary
  | { type: 'summary.back' }
  | { type: 'summary.quit' };

/**
 * First screen of the SHARED launch config for a batch. Mirrors
 * `editor.complete`: a backend locked on the command line skips the provider
 * picker, because that screen's own selection would otherwise replace it (the
 * `--stub` batch that silently became a real provider run).
 */
function batchLaunchStart(state: FsmState, initialBackendSet: boolean): Screen {
  return initialBackendSet
    ? { kind: 'model-selector', backendKind: state.backendKind, provider: state.provider }
    : { kind: 'backend-selector' };
}

/**
 * Where the shared launch config lands once it is complete. A (pipeline ×
 * project) fan-out gets a REVIEW stop first — N projects × M pipelines is real
 * RAM and real tokens, and the queue screen is where a wrong mark gets removed.
 * Everything else goes straight to the run, exactly as before.
 */
function afterLaunchConfig(state: FsmState, modelId: string, apiKey: string): Screen {
  return state.projectDirs.length > 0
    ? { kind: 'run-queue', modelId, apiKey }
    : { kind: 'run', modelId, apiKey };
}

/** True when every step in the pipeline already has a per-step modelId. */
export function allStepsHaveModel(p: Pipeline | null): boolean {
  if (!p || p.steps.length === 0) return false;
  return p.steps.every((s) => !!s.modelId);
}

export interface InitialStateOpts {
  initialPipeline?: Pipeline;
  autoStart?: boolean;
  initialBackend?: AgentBackendKind;
  /** Provider locked from `--provider=`. Absent → the backend's first provider. */
  initialProvider?: LlmProvider;
  deepseekResolvedKey: string;
  requiresApiKey: boolean;
}

export function initialState(opts: InitialStateOpts): FsmState {
  return {
    screen:
      opts.autoStart && opts.initialPipeline
        ? { kind: 'pipeline-editor' }
        : { kind: 'welcome' },
    pipeline: opts.initialPipeline ?? null,
    pipelines: null,
    projectDirs: [],
    modelId: '',
    conflictResolverModelId: '',
    backendKind: opts.initialBackend ?? 'jcode',
    provider: resolveRunProvider(opts.initialBackend ?? 'jcode', opts.initialProvider),
    apiKey: opts.deepseekResolvedKey,
    requiresApiKey: opts.requiresApiKey,
    pipelineSourceName: null,
  };
}

/**
 * Pure reducer. NOTE on timeout handling: the `timeout.submit` event stores
 * the chosen ms on `state.pipeline.cardTimeoutMs` / `singleFileCardTimeoutMs`
 * (mirroring the existing app.tsx behavior at lines 526–532). That keeps the
 * pipeline self-describing when it reaches the orchestrator, instead of
 * smuggling a separate `timeoutMs` field through `FsmState`.
 */
export function reduce(state: FsmState, event: FsmEvent): FsmState {
  switch (event.type) {
    // ── welcome ───────────────────────────────────────────────────────────
    case 'welcome.assistant':
      return { ...state, screen: { kind: 'pipeline-assistant' } };
    case 'welcome.new':
      return { ...state, screen: { kind: 'pipeline-editor' } };
    case 'welcome.import':
      return { ...state, screen: { kind: 'pipeline-import' } };
    case 'welcome.saved':
      return { ...state, screen: { kind: 'saved-pipelines' } };
    case 'welcome.selectPipeline':
      return {
        ...state,
        pipeline: event.pipeline,
        pipelines: null,
        projectDirs: [],
        screen: { kind: 'pipeline-editor' },
      };
    case 'welcome.quit':
      // Side effect (exit()) handled by caller; state is unchanged.
      return state;
    case 'welcome.faq':
      return { ...state, screen: { kind: 'faq' } };
    case 'welcome.options':
      return { ...state, screen: { kind: 'options' } };
    case 'welcome.directory':
      return { ...state, screen: { kind: 'directory-picker' } };
    case 'welcome.projects':
      // Re-entering keeps the previous marks (projectDirs is passed to the
      // picker as initialMarked), so a mis-press doesn't lose the selection.
      return { ...state, screen: { kind: 'directory-picker', multi: true } };
    case 'welcome.graphs':
      return { ...state, screen: { kind: 'graph-picker' } };

    // ── graph-picker / graph-detail ───────────────────────────────────────
    // Listing, reading and compiling are the CALLER's job (this reducer is
    // pure); what happens here is navigation and the hand-off of the compiled
    // pipeline into the launch config that already exists.
    case 'graph.inspect':
      return { ...state, screen: { kind: 'graph-detail', graphId: event.graphId } };
    case 'graph.back':
      return { ...state, screen: { kind: 'graph-picker' } };
    case 'graph.cancel':
      return { ...state, screen: { kind: 'welcome' } };
    case 'graph.launch': {
      const p = event.pipeline;
      // Deliberately NOT via the pipeline editor. The drawing is the design
      // surface; the emitted pipeline is machine output, and hand-editing it
      // would desync it from the graph it claims to be. Straight to the shared
      // launch config, exactly like a batch.
      if (state.projectDirs.length > 0) {
        // Marked projects are still marked: one graph × N projects is a fan-out,
        // mirroring `saved.select`. Dropping them here would silently discard
        // folders the user just picked.
        return {
          ...state,
          pipeline: p,
          pipelines: [p],
          pipelineSourceName: event.graphName,
          screen: batchLaunchStart(state, event.initialBackendSet),
        };
      }
      return {
        ...state,
        pipeline: p,
        pipelines: null,
        projectDirs: [],
        pipelineSourceName: event.graphName,
        screen: batchLaunchStart(state, event.initialBackendSet),
      };
    }

    // ── options ───────────────────────────────────────────────────────────
    case 'options.close':
      return { ...state, screen: { kind: 'welcome' } };

    // ── directory-picker ──────────────────────────────────────────────────
    // The chosen directory is applied as a side effect by the caller
    // (setRepoRoot); the reducer only navigates back to welcome.
    case 'directory.select':
    case 'directory.cancel':
      return { ...state, screen: { kind: 'welcome' } };

    // ── directory-picker (multi-mark) ─────────────────────────────────────
    // N project roots chosen → straight to the pipeline picker. The pipelines
    // chosen there fan out over these dirs (one run per pair).
    case 'directory.selectMany':
      if (event.dirs.length === 0) return { ...state, screen: { kind: 'welcome' } };
      return {
        ...state,
        projectDirs: event.dirs,
        screen: { kind: 'saved-pipelines' },
      };

    // ── run-queue ────────────────────────────────────────────────────────
    // The reviewed queue itself lives in the caller (it owns repoRoot and the
    // per-row removals); the reducer only gates the jump into the run.
    case 'runQueue.confirm': {
      const cur = state.screen;
      if (cur.kind !== 'run-queue') return state;
      return { ...state, screen: { kind: 'run', modelId: cur.modelId, apiKey: cur.apiKey } };
    }
    case 'runQueue.cancel':
      return { ...state, screen: { kind: 'welcome' } };

    // ── faq ───────────────────────────────────────────────────────────────
    case 'faq.back':
      return { ...state, screen: { kind: 'welcome' } };

    // ── pipeline-assistant ────────────────────────────────────────────────
    case 'assistant.complete':
      return {
        ...state,
        pipeline: event.pipeline,
        pipelines: null,
        projectDirs: [],
        screen: { kind: 'pipeline-editor' },
      };
    case 'assistant.cancel':
      return { ...state, screen: { kind: 'welcome' } };

    // ── pipeline-editor ───────────────────────────────────────────────────
    case 'editor.complete': {
      const p = event.pipeline;
      const all = allStepsHaveModel(p);
      const base: FsmState = { ...state, pipeline: p, pipelines: null, projectDirs: [] };
      if (all && event.initialBackendSet) {
        // Caller may intercept to insert an api-key gate; the FSM treats
        // this as the direct destination so the screen branch is decidable
        // from (allStepsHaveModel, initialBackendSet) alone.
        const mid = p.steps[0]!.modelId!;
        return {
          ...base,
          modelId: mid,
          screen: { kind: 'run', modelId: mid, apiKey: state.apiKey },
        };
      }
      if (!event.initialBackendSet) {
        return { ...base, screen: { kind: 'backend-selector' } };
      }
      return {
        ...base,
        screen: {
          kind: 'model-selector',
          backendKind: state.backendKind,
          provider: state.provider,
        },
      };
    }
    case 'editor.import':
      return { ...state, screen: { kind: 'pipeline-import' } };
    case 'editor.export':
      return {
        ...state,
        pipeline: event.pipeline,
        screen: { kind: 'pipeline-export' },
      };
    case 'editor.cancel':
      return { ...state, screen: { kind: 'welcome' } };

    // ── backend-selector ──────────────────────────────────────────────────
    case 'backend.select': {
      const provider = resolveRunProvider(event.backendKind, event.provider);
      const base: FsmState = {
        ...state,
        backendKind: event.backendKind,
        provider,
        requiresApiKey: event.requiresApiKey,
      };
      if (event.skipModelSelector) {
        const mid = event.firstStepModelId!;
        return {
          ...base,
          modelId: mid,
          screen: { kind: 'run', modelId: mid, apiKey: state.apiKey },
        };
      }
      return {
        ...base,
        screen: { kind: 'model-selector', backendKind: event.backendKind, provider },
      };
    }
    case 'backend.cancel':
      return { ...state, screen: { kind: 'pipeline-editor' } };

    // ── pipeline-import ───────────────────────────────────────────────────
    case 'import.selectFromList':
      return {
        ...state,
        pipeline: event.pipeline,
        pipelines: null,
        projectDirs: [],
        screen: { kind: 'pipeline-editor' },
      };
    case 'import.paste':
      return { ...state, screen: { kind: 'pipeline-import-paste' } };
    case 'import.customPath':
      return { ...state, screen: { kind: 'pipeline-import-custom' } };
    case 'import.cancel':
      return {
        ...state,
        screen: state.pipeline ? { kind: 'pipeline-editor' } : { kind: 'welcome' },
      };

    // ── pipeline-import-paste ────────────────────────────────────────────
    case 'importPaste.complete':
      return {
        ...state,
        pipeline: event.pipeline,
        pipelines: null,
        projectDirs: [],
        screen: { kind: 'pipeline-editor' },
      };
    case 'importPaste.cancel':
      return { ...state, screen: { kind: 'pipeline-import' } };

    // ── pipeline-import-custom ───────────────────────────────────────────
    case 'importCustom.complete':
      if (event.pipeline) {
        return {
          ...state,
          pipeline: event.pipeline,
          pipelines: null,
          projectDirs: [],
          screen: { kind: 'pipeline-editor' },
        };
      }
      // Matches existing app.tsx: when no pipeline is loaded, the screen
      // doesn't advance (PipelineIOScreen will keep rendering / re-prompt).
      return state;
    case 'importCustom.cancel':
      return { ...state, screen: { kind: 'pipeline-import' } };

    // ── pipeline-export ──────────────────────────────────────────────────
    case 'export.complete':
    case 'export.cancel':
      return { ...state, screen: { kind: 'pipeline-editor' } };

    // ── saved-pipelines ──────────────────────────────────────────────────
    case 'saved.select':
      // With project dirs marked, ONE highlighted pipeline is still a fan-out
      // (1 pipeline × N projects) — routing to the single-pipeline editor here
      // would silently drop the N projects the user just marked.
      if (state.projectDirs.length > 0) {
        return {
          ...state,
          pipelines: [event.pipeline],
          pipeline: event.pipeline,
          pipelineSourceName: event.pipeline.name,
          screen: batchLaunchStart(state, event.initialBackendSet === true),
        };
      }
      return {
        ...state,
        pipeline: event.pipeline,
        pipelines: null,
        projectDirs: [],
        pipelineSourceName: event.pipeline.name,
        screen: { kind: 'pipeline-editor' },
      };
    case 'saved.selectMany':
      return {
        ...state,
        // Run the batch CONCURRENTLY with ONE shared config. Skip the
        // single-pipeline editor (can't edit N at once) and go straight to the
        // shared backend/model selection; pipelines[0] is the representative.
        pipelines: event.pipelines,
        pipeline: event.pipelines[0] ?? state.pipeline,
        pipelineSourceName:
          state.projectDirs.length > 0
            ? `${event.pipelines.length} × ${state.projectDirs.length} projects`
            : `${event.pipelines.length} projects`,
        screen: batchLaunchStart(state, event.initialBackendSet === true),
      };
    case 'saved.cancel':
      return { ...state, screen: { kind: 'welcome' } };

    // ── model-selector ───────────────────────────────────────────────────
    case 'modelSelector.select': {
      const base: FsmState = {
        ...state,
        modelId: event.modelId,
        backendKind: event.backendKind,
        provider: resolveRunProvider(event.backendKind, event.provider ?? state.provider),
      };
      if (!event.requiresApiKey || event.backendKind === 'stub') {
        return {
          ...base,
          screen: {
            kind: 'timeout-prompt',
            modelId: event.modelId,
            apiKey: state.apiKey,
          },
        };
      }
      if (event.missingKeys.length > 0) {
        return {
          ...base,
          screen: { kind: 'api-key', missing: event.missingKeys },
        };
      }
      return {
        ...base,
        apiKey: event.resolvedApiKey,
        screen: {
          kind: 'timeout-prompt',
          modelId: event.modelId,
          apiKey: event.resolvedApiKey,
        },
      };
    }
    case 'modelSelector.cancel':
      return {
        ...state,
        screen: event.initialBackendSet
          ? { kind: 'pipeline-editor' }
          : { kind: 'backend-selector' },
      };

    // ── api-key ──────────────────────────────────────────────────────────
    case 'apiKey.submit':
      return {
        ...state,
        apiKey: event.resolvedApiKey,
        screen: {
          kind: 'timeout-prompt',
          modelId: state.modelId,
          apiKey: event.resolvedApiKey,
        },
      };
    case 'apiKey.cancel':
      return {
        ...state,
        screen: { kind: 'model-selector', backendKind: state.backendKind, provider: state.provider },
      };

    // ── timeout-prompt ───────────────────────────────────────────────────
    case 'timeout.submit': {
      const ms = event.minutes * 60_000;
      const withTimeout = (p: Pipeline): Pipeline => ({
        ...p,
        cardTimeoutMs: ms,
        singleFileCardTimeoutMs: ms,
      });
      const newPipeline: Pipeline | null = state.pipeline ? withTimeout(state.pipeline) : state.pipeline;
      // Multi-run: the chosen timeout applies to EVERY pipeline in the batch.
      const newPipelines: Pipeline[] | null = state.pipelines
        ? state.pipelines.map(withTimeout)
        : state.pipelines;
      // Pull modelId/apiKey off the timeout-prompt screen when present
      // (mirrors app.tsx line 531: `screen.modelId` / `screen.apiKey`),
      // otherwise fall back to the top-level state copies.
      const cur = state.screen;
      const mid = cur.kind === 'timeout-prompt' ? cur.modelId : state.modelId;
      const ak = cur.kind === 'timeout-prompt' ? cur.apiKey : state.apiKey;
      return {
        ...state,
        pipeline: newPipeline,
        pipelines: newPipelines,
        // Offer the optional conflict-resolver model pick before the run; the
        // overlay's cancel (Esc) skips it (resolver inherits the run model).
        screen: {
          kind: 'resolver-model-selector',
          backendKind: state.backendKind,
          provider: state.provider,
          modelId: mid,
          apiKey: ak,
        },
      };
    }
    case 'timeout.cancel':
      return {
        ...state,
        screen: { kind: 'model-selector', backendKind: state.backendKind, provider: state.provider },
      };

    // ── resolver-model-selector ──────────────────────────────────────────
    // Optional: pin a (stronger) model for the merge conflict-resolver agent.
    // `select` records it on the pipeline(s) as integrationModelId; `skip`
    // leaves it unset so the resolver inherits the run model. Both advance to
    // the run — or, when projects were marked, to the run-queue review first.
    // The integration agent always runs at max thinking (backend).
    case 'resolverModelSelector.select': {
      const cur = state.screen;
      if (cur.kind !== 'resolver-model-selector') return state;
      const id = event.modelId;
      const withResolver = (p: Pipeline): Pipeline => ({ ...p, integrationModelId: id });
      return {
        ...state,
        conflictResolverModelId: id,
        pipeline: state.pipeline ? withResolver(state.pipeline) : state.pipeline,
        pipelines: state.pipelines ? state.pipelines.map(withResolver) : state.pipelines,
        screen: afterLaunchConfig(state, cur.modelId, cur.apiKey),
      };
    }
    case 'resolverModelSelector.skip': {
      const cur = state.screen;
      if (cur.kind !== 'resolver-model-selector') return state;
      return {
        ...state,
        screen: afterLaunchConfig(state, cur.modelId, cur.apiKey),
      };
    }

    // ── runDirect (skip-model fast path) ─────────────────────────────────
    case 'runDirect': {
      const backendKind = event.backendKind ?? state.backendKind;
      const requiresApiKey = event.requiresApiKey ?? state.requiresApiKey;
      const base: FsmState = {
        ...state,
        provider: resolveRunProvider(backendKind, event.provider ?? state.provider),
        // runDirect is the single-pipeline skip-model fast path
        pipelines: null,
        projectDirs: [],
        ...(event.pipeline !== undefined ? { pipeline: event.pipeline } : {}),
        backendKind,
        requiresApiKey,
        modelId: event.modelId,
      };
      if (!requiresApiKey || backendKind === 'stub') {
        return {
          ...base,
          screen: { kind: 'run', modelId: event.modelId, apiKey: state.apiKey },
        };
      }
      if (event.missingKeys.length > 0) {
        return {
          ...base,
          screen: { kind: 'api-key', missing: event.missingKeys },
        };
      }
      return {
        ...base,
        apiKey: event.resolvedApiKey,
        screen: { kind: 'run', modelId: event.modelId, apiKey: event.resolvedApiKey },
      };
    }

    // ── run ──────────────────────────────────────────────────────────────
    case 'run.complete':
      return { ...state, screen: { kind: 'summary', result: event.result } };
    case 'run.abort':
      return { ...state, screen: { kind: 'pipeline-editor' } };
    case 'run.authError':
      return {
        ...state,
        backendKind: event.backendKind,
        screen: { kind: 'options', focusSpecName: event.specName },
      };

    // ── summary ──────────────────────────────────────────────────────────
    case 'summary.back':
      return { ...state, screen: { kind: 'pipeline-editor' } };
    case 'summary.quit':
      // Side effect (exit()) handled by caller; state is unchanged.
      return state;
  }
}

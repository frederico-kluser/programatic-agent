import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { pkg } from './lib/package-info.js';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { join } from 'node:path';
import { ModelSelectorOverlay } from './ui/components/ModelSelectorOverlay.js';
import { PipelineAssistant } from './ui/components/PipelineAssistant.js';
import { PipelineEditor } from './ui/components/PipelineEditor.js';
import { PipelineIOScreen } from './ui/components/PipelineIOScreen.js';
import { PipelineImportList } from './ui/components/PipelineImportList.js';
import { PipelineJsonPaste } from './ui/components/PipelineJsonPaste.js';
import { TimeoutPrompt } from './ui/components/TimeoutPrompt.js';
import { RunDashboard } from './ui/components/RunDashboard.js';
import { MultiRunDashboard } from './ui/components/MultiRunDashboard.js';
import { ApiKeyPrompt } from './ui/components/ApiKeyPrompt.js';
import { BackendSelector } from './ui/components/BackendSelector.js';
import { DirectoryPicker } from './ui/components/DirectoryPicker.js';
import { GraphScreen } from './ui/components/GraphScreen.js';
import { RunQueueScreen } from './ui/components/RunQueueScreen.js';
import { useTerminalResize } from './ui/hooks/useTerminalResize.js';
import { SystemMetricsBar } from './ui/components/SystemMetricsBar.js';
import { SavedPipelinesManager } from './ui/components/SavedPipelinesManager.js';
import { OptionsScreen } from './ui/components/OptionsScreen.js';
import {
  selectBackend,
  type AgentBackendKind,
} from './orchestrator/backends/registry.js';
import { resolveRunProvider, type LlmProvider } from './lib/providers.js';
import { listAllPipelines, savePipelineToMemory, deletePipelineFromMemory } from './lib/pipeline-io.js';
import { listPipelinesInMemory } from './lib/pipeline-memory.js';
import { ensureAllDefaultPipelines } from './lib/pipeline-bootstrap.js';
import {
  findMissingKeysForProvider,
  findSpec,
  resolveApiKey,
  saveApiKey,
  specForProvider,
  type ApiKeySpec,
} from './lib/api-key.js';
import { log as dlog, bump as dbump } from './lib/debug-logger.js';
import type { PipelineEntry } from './lib/pipeline-io.js';
import type { AgentFactory } from './orchestrator/types.js';
import type { Pipeline } from './lib/types.js';
import { buildRunQueue, type RunQueueItem } from './lib/run-queue.js';
import {
  allStepsHaveModel,
  initialState,
  reduce,
  type FsmEvent,
  type FsmState,
} from './lib/screen-fsm.js';
import { theme } from './ui/theme.js';
import { t, translate } from './lib/i18n/index.js';

/** FAQ entries, in render order. Each has a `_q`/`_a` pair in the catalog. */
const FAQ_KEYS = [
  'what_is_huu',
  'what_is_pipeline',
  'modifies_repo',
  'providers',
  'api_key',
  'why_docker',
  'ports',
  'assistant',
  'prior_runs',
] as const;

interface AppProps {
  initialPipeline?: Pipeline;
  agentFactory?: AgentFactory;
  /** Optional LLM resolver for merge conflicts. */
  conflictResolverFactory?: AgentFactory;
  /** If true, an API key is required before running (real LLM). */
  requiresApiKey?: boolean;
  /**
   * Backend kind locked from the CLI flag. When provided, the
   * BackendSelector screen is skipped. When undefined, the user is
   * shown the selector before model picking.
   */
  backend?: AgentBackendKind;
  /**
   * Provider locked from `--provider=`. Travels separately from `backend`
   * because `providerToBackend` is many-to-one: both `deepseek` and
   * `openrouter` become `jcode`, so the backend cannot carry the pick.
   */
  provider?: LlmProvider;
  /** When true and initialPipeline is set, jumps straight from welcome → editor. */
  autoStart?: boolean;
  /**
   * Memory-aware dynamic concurrency (default true). False pins the pool
   * at `concurrency`; the memory guard stays active either way.
   */
  autoScale?: boolean;
  /** Initial/pinned concurrency (--concurrency=N). */
  concurrency?: number;
}

const FULL_CLEAR = '\x1b[3J';

export function App({
  initialPipeline,
  agentFactory,
  conflictResolverFactory,
  requiresApiKey,
  backend: initialBackend,
  provider: initialProvider,
  autoStart,
  autoScale,
  concurrency,
}: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  useTerminalResize();

  // The credential of the provider huu STARTS on (`--provider=`, else the
  // backend's first provider). Not "the DeepSeek key" any more: jcode serves
  // two providers and only the provider names the spec.
  const bootProvider = resolveRunProvider(initialBackend ?? 'jcode', initialProvider);
  const bootSpec = specForProvider(bootProvider);

  const [fsm, setFsm] = useState<FsmState>(() =>
    initialState({
      initialPipeline,
      autoStart,
      initialBackend,
      initialProvider,
      deepseekResolvedKey: bootSpec ? resolveApiKey(bootSpec) : '',
      requiresApiKey: requiresApiKey ?? true,
    }),
  );

  const dispatch = useCallback((event: FsmEvent) => {
    dlog('nav', 'dispatch', { type: event.type });
    setFsm((prev) => reduce(prev, event));
  }, []);

  // Auxiliary state that does NOT belong in the FSM: backend factories
  // (the FSM is pure — it doesn't know about AgentFactory), UI-list
  // selection, and the pipeline catalog.
  const [activeFactory, setActiveFactory] = useState<AgentFactory | null>(
    () => agentFactory ?? null,
  );
  const [activeResolverFactory, setActiveResolverFactory] = useState<
    AgentFactory | undefined
  >(() => conflictResolverFactory);
  const [activeRequiresApiKey, setActiveRequiresApiKey] = useState<boolean>(
    requiresApiKey ?? true,
  );
  const [availablePipelines, setAvailablePipelines] = useState<PipelineEntry[]>([]);
  const [selectedPipelineIndex, setSelectedPipelineIndex] = useState<number>(0);
  const [savedPipelines, setSavedPipelines] = useState<PipelineEntry[]>([]);

  const {
    screen,
    pipeline,
    pipelines,
    projectDirs,
    modelId,
    backendKind,
    provider: activeProvider,
    apiKey,
    pipelineSourceName,
  } = fsm;
  // The directory the run targets. Defaults to the process cwd (which the
  // `--dir=` flag may already have moved). The DirectoryPicker screen lets
  // the user navigate the filesystem and choose a different folder at runtime.
  const [repoRoot, setRepoRoot] = useState<string>(() => process.cwd());
  /**
   * The reviewed queue, set by the run-queue screen. Null → derive the batch
   * from `pipelines × repoRoot` (the legacy "N pipelines, one repo" path).
   */
  const [confirmedQueue, setConfirmedQueue] = useState<RunQueueItem[] | null>(null);
  // Every concurrent run of this launch: one per (pipeline, project) pair.
  const runQueue = useMemo(
    () => confirmedQueue ?? buildRunQueue(pipelines ?? [], projectDirs, repoRoot),
    [confirmedQueue, pipelines, projectDirs, repoRoot],
  );
  // 2+ concurrent runs → the multi-run dashboard. Note this is now driven by the
  // QUEUE, not the pipeline count: ONE pipeline over three projects is multi-run.
  const isMulti = runQueue.length >= 2;
  /**
   * What the pipeline picker offers. The multi-PROJECT flow must see the SAME
   * pipelines the welcome screen lists (`./pipelines`, which is where the bundled
   * defaults are materialized) — the memory-only list would be empty for anyone
   * who never saved one by hand, making the whole flow a dead end. De-duplicated
   * by name, disk entries first.
   */
  const pickerEntries = useMemo(() => {
    if (projectDirs.length === 0) return savedPipelines;
    const byName = new Map<string, PipelineEntry>();
    for (const e of [...availablePipelines, ...savedPipelines]) {
      if (!byName.has(e.pipeline.name)) byName.set(e.pipeline.name, e);
    }
    return [...byName.values()];
  }, [projectDirs.length, availablePipelines, savedPipelines]);

  // CLI-provided factory wins. When the user picks via TUI we set
  // `activeFactory` from selectBackend(). The fallback chain is:
  // activeFactory → CLI-injected agentFactory → jcode (registry default).
  // Memoize so re-renders don't allocate a new BackendBundle just to
  // read its agentFactory — selectBackend() returns a fresh object.
  const jcodeFallbackBundle = useMemo(() => selectBackend('jcode'), []);
  const factory =
    activeFactory ?? agentFactory ?? jcodeFallbackBundle.agentFactory;
  const resolverFactory = activeResolverFactory ?? conflictResolverFactory;

  // Active spec used by the missing-key check — keyed on the PROVIDER the user
  // chose, never on the backend. `stub` resolves to no provider and therefore
  // to no spec, so it stays keyless by construction.
  const activeSpec: ApiKeySpec | undefined = useMemo(
    () => specForProvider(activeProvider),
    [activeProvider],
  );

  const helperLlmContext: import('./lib/llm-client-factory.js').LlmClientContext = useMemo(() => {
    return {
      backend: backendKind,
      provider: activeProvider,
      apiKey: activeSpec ? resolveApiKey(activeSpec) : '',
    };
  }, [backendKind, activeProvider, activeSpec]);

  // Side effects mirroring the legacy navigate() callback: full-screen
  // clear and dlog when screen.kind changes.
  const prevKindRef = useRef(screen.kind);
  useEffect(() => {
    if (prevKindRef.current !== screen.kind) {
      dlog('nav', 'navigate', { from: prevKindRef.current, to: screen.kind });
      if (stdout.isTTY) stdout.write(FULL_CLEAR);
      prevKindRef.current = screen.kind;
    }
  }, [screen.kind, stdout]);

  // One-shot bootstrap: materialize bundled default pipelines into the
  // user's `pipelines/` directory on first mount (idempotent — never
  // overwrites an existing file). Best-effort: failures are logged and
  // don't block the app.
  useEffect(() => {
    try {
      ensureAllDefaultPipelines(repoRoot, (err, mod) => {
        dlog('bootstrap', 'default_pipeline_failed', {
          name: mod.DEFAULT_PIPELINE_NAME,
          error: err.message,
        });
      });
    } catch (err) {
      dlog('bootstrap', 'ensureAllDefaultPipelines_threw', {
        error: (err as Error).message,
      });
    }
  }, [repoRoot]);

  useEffect(() => {
    // `saved-pipelines` is included because the multi-PROJECT flow lands there
    // and offers the ./pipelines entries too — without this refresh a user who
    // never opened the welcome list would be handed an empty picker.
    if (
      screen.kind === 'welcome' ||
      screen.kind === 'pipeline-import' ||
      screen.kind === 'saved-pipelines'
    ) {
      const entries = listAllPipelines(join(repoRoot, 'pipelines'));
      setAvailablePipelines(entries);
      if (screen.kind !== 'saved-pipelines') setSelectedPipelineIndex(0);
    }
    if (screen.kind === 'welcome' || screen.kind === 'saved-pipelines') {
      const memoryEntries = listPipelinesInMemory().map((e) => ({
        fileName: e.name,
        filePath: `memory://${e.name}`,
        pipeline: e.pipeline,
        source: 'global' as const,
      }));
      setSavedPipelines(memoryEntries);
    }
  }, [screen.kind, repoRoot]);

  useEffect(() => {
    dlog('nav', 'screen_mount', { kind: screen.kind });
    return () => dlog('nav', 'screen_unmount', { kind: screen.kind });
  }, [screen.kind]);

  // Ink's useInput keeps the handler in its effect deps and re-attaches the
  // listener every time the reference changes. SystemMetricsBar re-renders the
  // App every second; without ref-stability that re-attach happens on every
  // tick. Refs feed the latest state into a stable handler instead.
  const availablePipelinesRef = useRef(availablePipelines);
  availablePipelinesRef.current = availablePipelines;
  const selectedPipelineIndexRef = useRef(selectedPipelineIndex);
  selectedPipelineIndexRef.current = selectedPipelineIndex;
  const screenKindRef = useRef(screen.kind);
  screenKindRef.current = screen.kind;

  const handleAppInput = useCallback(
    (input: string, key: { upArrow: boolean; downArrow: boolean; return: boolean }) => {
      const kind = screenKindRef.current;
      dbump('input.App');
      dlog('input', 'App.useInput', {
        screen: kind,
        input,
        upArrow: key.upArrow,
        downArrow: key.downArrow,
        return: key.return,
      });
      if (kind === 'welcome') {
        if (input === 'q' || input === 'Q') {
          dispatch({ type: 'welcome.quit' });
          exit();
          return;
        }
        if (input === '?') {
          dispatch({ type: 'welcome.faq' });
          return;
        }
        if (input === 'a' || input === 'A') {
          dispatch({ type: 'welcome.assistant' });
          return;
        }
        if (input === 'n' || input === 'N') {
          dispatch({ type: 'welcome.new' });
          return;
        }
        if (input === 'i' || input === 'I') {
          dispatch({ type: 'welcome.import' });
          return;
        }
        if (input === 'm' || input === 'M') {
          dispatch({ type: 'welcome.saved' });
          return;
        }
        if (input === 'o' || input === 'O') {
          dispatch({ type: 'welcome.options' });
          return;
        }
        if (input === 'd' || input === 'D') {
          dispatch({ type: 'welcome.directory' });
          return;
        }
        if (input === 'p' || input === 'P') {
          dispatch({ type: 'welcome.projects' });
          return;
        }
        if (input === 'g' || input === 'G') {
          dispatch({ type: 'welcome.graphs' });
          return;
        }
        if (key.upArrow) {
          setSelectedPipelineIndex((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setSelectedPipelineIndex((prev) =>
            Math.min(availablePipelinesRef.current.length - 1, prev + 1),
          );
          return;
        }
        if (key.return && availablePipelinesRef.current.length > 0) {
          const selected =
            availablePipelinesRef.current[selectedPipelineIndexRef.current];
          if (selected) {
            dispatch({ type: 'welcome.selectPipeline', pipeline: selected.pipeline });
          }
          return;
        }
        // Labels are 0-based ([0] is the pinned default), so the digit maps
        // directly to the list index.
        const num = parseInt(input, 10);
        if (
          !Number.isNaN(num) &&
          num >= 0 &&
          num < availablePipelinesRef.current.length
        ) {
          dispatch({
            type: 'welcome.selectPipeline',
            pipeline: availablePipelinesRef.current[num]!.pipeline,
          });
        }
      } else if (kind === 'faq') {
        dispatch({ type: 'faq.back' });
      } else if (kind === 'summary') {
        if (input === 'q' || input === 'Q') {
          dispatch({ type: 'summary.quit' });
          exit();
          return;
        }
        if (key.return) dispatch({ type: 'summary.back' });
      }
    },
    [exit, dispatch],
  );

  useInput(handleAppInput, {
    isActive: screen.kind === 'welcome' || screen.kind === 'summary' || screen.kind === 'faq',
  });

  let body: React.JSX.Element = <Text>?</Text>;

  if (screen.kind === 'welcome') {
    body = (
      <Box flexDirection="column" width="100%">
        <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column" width="100%">
          <Text bold color="cyanBright">{' __                        '}</Text>
          <Text bold color="cyanBright">{'/\\ \\                       '}</Text>
          <Text bold color="cyanBright">{'\\ \\ \\___   __  __  __  __  '}</Text>
          <Text bold color="cyanBright">{' \\ \\  _ `\\/\\ \\/\\ \\/\\ \\/\\ \\ '}</Text>
          <Text bold color="cyanBright">{'  \\ \\ \\ \\ \\ \\ \\_\\ \\ \\ \\_\\ \\'}</Text>
          <Text bold color="cyan">{'   \\ \\_\\ \\_\\ \\____/\\ \\____/'}</Text>
          <Text dimColor color="cyan">{'    \\/_/\\/_/\\/___/  \\/___/ '}</Text>
          <Box marginTop={1}>
            <Text bold color="cyan">{pkg.name} v{pkg.version}</Text>
          </Box>
          <Text dimColor>{t('tui.home.tagline')}</Text>

          <Box marginTop={1} flexDirection="column">
            <Text>  <Text bold color={theme.ai}>[A]</Text>  {t('tui.home.menu_assistant')}</Text>
            <Text>  <Text bold color="cyan">[N]</Text>  {t('tui.home.menu_new')}</Text>
            <Text>  <Text bold color="cyan">[I]</Text>  {t('tui.home.menu_import')}</Text>
            <Text>  <Text bold color="cyan">[M]</Text>  {t('tui.home.menu_saved')}</Text>
            <Text>  <Text bold color="cyan">[D]</Text>  {t('tui.home.menu_dir')}</Text>
            <Text>  <Text bold color="cyan">[P]</Text>  {t('tui.home.menu_projects')}</Text>
            <Text>  <Text bold color={theme.ai}>[G]</Text>  {t('tui.graph.menu')}</Text>
            <Text>  <Text bold color="cyan">[O]</Text>  {t('tui.home.menu_options')}</Text>
            <Text>  <Text bold color="cyan">[?]</Text>  {t('tui.home.menu_faq')}</Text>
            <Text>  <Text bold color="cyan">[Q]</Text>  {t('tui.home.menu_quit')}</Text>
          </Box>

          {availablePipelines.length > 0 && (
            <Box marginTop={1} flexDirection="column">
              <Text bold>{t('tui.home.available')}</Text>
              {availablePipelines.map((entry, idx) => {
                const isSelected = idx === selectedPipelineIndex;
                const isDefault = entry.pipeline._default === true;
                // The pinned default ([0]) gets its own color so it reads as
                // distinct even when another row is selected.
                const labelColor = isDefault ? 'green' : isSelected ? 'green' : 'cyan';
                const desc = entry.pipeline.description?.trim();
                return (
                  <Box key={entry.filePath} flexDirection="column">
                    <Text>
                      {isSelected ? '› ' : '  '}
                      <Text bold color={labelColor}>
                        [{idx}]
                      </Text>{' '}
                      <Text color={isDefault ? 'green' : undefined} bold={isDefault}>
                        {entry.pipeline.name}
                      </Text>
                      {isDefault ? <Text dimColor> ({t('tui.check.default_tag')})</Text> : null}
                    </Text>
                    {desc ? (
                      <Text dimColor wrap="wrap">
                        {'      '}
                        {desc}
                      </Text>
                    ) : null}
                  </Box>
                );
              })}
              <Box marginTop={1}>
                <Text dimColor>
                  <Text bold>ENTER</Text> {t('tui.home.hint_load')} · <Text bold>↑↓</Text>{' '}
                  {t('common.action.navigate')} · <Text bold>0-9</Text> {t('tui.home.hint_jump')}
                </Text>
              </Box>
            </Box>
          )}

          <Box marginTop={1}>
            <Text dimColor>
              {t('tui.home.run_dir', { dir: repoRoot })}  ·  <Text bold>[D]</Text>{' '}
              {t('tui.home.hint_change')}
            </Text>
          </Box>
        </Box>
      </Box>
    );
  } else if (screen.kind === 'faq') {
    body = (
      <Box flexDirection="column" width="100%">
        <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column" width="100%">
          <Text bold color="cyanBright">FAQ — {pkg.name} v{pkg.version}</Text>
          <Text dimColor>{t('tui.faq.subtitle')}</Text>

          {FAQ_KEYS.map((key) => (
            <Box key={key} marginTop={1} flexDirection="column">
              <Text bold color="cyan">{translate(`tui.faq.${key}_q`)}</Text>
              <Text>{`  ${translate(`tui.faq.${key}_a`)}`}</Text>
            </Box>
          ))}

          <Box marginTop={1}>
            <Text dimColor>
              <Text bold>ENTER</Text> / <Text bold>Esc</Text> / {t('tui.faq.any_key')}
            </Text>
          </Box>
        </Box>
      </Box>
    );
  } else if (screen.kind === 'pipeline-assistant') {
    body = (
      <PipelineAssistant
        apiKey={apiKey || 'stub'}
        llmContext={helperLlmContext}
        onComplete={(p) => dispatch({ type: 'assistant.complete', pipeline: p })}
        onCancel={() => dispatch({ type: 'assistant.cancel' })}
      />
    );
  } else if (screen.kind === 'pipeline-editor') {
    body = (
      <PipelineEditor
        initialPipeline={pipeline ?? undefined}
        sourceName={pipelineSourceName ?? undefined}
        repoRoot={repoRoot}
        apiKey={apiKey || 'stub'}
        llmContext={helperLlmContext}
        onComplete={(p) => {
          // When every step already specifies its own model, skip the
          // global model selector — it would never be used as a fallback.
          if (allStepsHaveModel(p) && initialBackend) {
            // Resolve api-key gate inputs OUTSIDE the reducer so the
            // FSM remains pure. Mirrors legacy navigateToRunSkippingModel.
            // The 'stub' branch short-circuits inside the FSM, so we
            // only consult the api-key registry for real backends.
            // Gate on the PROVIDER. `findMissingKeysForBackend` answered for
            // the backend's FIRST provider, so an OpenRouter run was told it
            // was missing DEEPSEEK_API_KEY.
            const missing = findMissingKeysForProvider(activeProvider);
            const resolved = activeSpec ? resolveApiKey(activeSpec) : apiKey;
            dispatch({
              type: 'runDirect',
              pipeline: p,
              modelId: p.steps[0]!.modelId!,
              requiresApiKey: activeRequiresApiKey,
              backendKind,
              provider: activeProvider,
              missingKeys: missing,
              resolvedApiKey: resolved,
            });
            return;
          }
          dispatch({
            type: 'editor.complete',
            pipeline: p,
            initialBackendSet: !!initialBackend,
          });
        }}
        onImport={() => dispatch({ type: 'editor.import' })}
        onExport={(p) => dispatch({ type: 'editor.export', pipeline: p })}
        onCancel={() => dispatch({ type: 'editor.cancel' })}
      />
    );
  } else if (screen.kind === 'backend-selector') {
    body = (
      <BackendSelector
        onSelect={(chosenProvider, kind) => {
          const bundle = selectBackend(kind);
          // The provider the user actually highlighted — carried, not derived.
          const nextProvider = resolveRunProvider(kind, chosenProvider);
          setActiveFactory(() => bundle.agentFactory);
          setActiveResolverFactory(() => bundle.conflictResolverFactory);
          setActiveRequiresApiKey(bundle.requiresApiKey);
          // Skip model selector when every step already has its own model.
          // Never skip for a multi-run batch — it picks ONE shared model.
          if (!isMulti && allStepsHaveModel(pipeline)) {
            const missing = findMissingKeysForProvider(nextProvider);
            // The credential name comes from the PROVIDER the user just
            // picked, NOT from `activeSpec` (keyed on the not-yet-updated
            // state) and NOT from `bundle.apiKeySpecName` (keyed on the
            // backend, which serves both providers and so names neither).
            // `stub` resolves to no provider → no spec → stays keyless.
            const spec = specForProvider(nextProvider);
            const resolved = spec ? resolveApiKey(spec) : apiKey;
            dispatch({
              type: 'runDirect',
              modelId: pipeline!.steps[0]!.modelId!,
              backendKind: kind,
              provider: nextProvider,
              requiresApiKey: bundle.requiresApiKey,
              missingKeys: missing,
              resolvedApiKey: resolved,
            });
            return;
          }
          dispatch({
            type: 'backend.select',
            backendKind: kind,
            provider: nextProvider,
            requiresApiKey: bundle.requiresApiKey,
            skipModelSelector: false,
          });
        }}
        onCancel={() => dispatch({ type: 'backend.cancel' })}
      />
    );
  } else if (screen.kind === 'pipeline-import') {
    body = (
      <PipelineImportList
        entries={availablePipelines}
        onSelect={(loaded) =>
          dispatch({ type: 'import.selectFromList', pipeline: loaded })
        }
        onPasteJson={() => dispatch({ type: 'import.paste' })}
        onCustomPath={() => dispatch({ type: 'import.customPath' })}
        onCancel={() => dispatch({ type: 'import.cancel' })}
      />
    );
  } else if (screen.kind === 'pipeline-import-paste') {
    body = (
      <PipelineJsonPaste
        onComplete={(loaded) =>
          dispatch({ type: 'importPaste.complete', pipeline: loaded })
        }
        onCancel={() => dispatch({ type: 'importPaste.cancel' })}
      />
    );
  } else if (screen.kind === 'pipeline-import-custom') {
    body = (
      <PipelineIOScreen
        mode="import"
        onComplete={(loaded) =>
          dispatch({ type: 'importCustom.complete', pipeline: loaded })
        }
        onCancel={() => dispatch({ type: 'importCustom.cancel' })}
      />
    );
  } else if (screen.kind === 'pipeline-export') {
    body = (
      <PipelineIOScreen
        mode="export"
        pipeline={pipeline ?? undefined}
        onComplete={() => dispatch({ type: 'export.complete' })}
        onCancel={() => dispatch({ type: 'export.cancel' })}
      />
    );
  } else if (screen.kind === 'saved-pipelines') {
    body = (
      <SavedPipelinesManager
        entries={pickerEntries}
        title={projectDirs.length > 0 ? t('tui.home.pick_pipelines_title') : undefined}
        subtitle={
          projectDirs.length > 0
            ? projectDirs.length === 1
              ? t('tui.home.pick_pipelines_sub_one', { count: projectDirs.length })
              : t('tui.home.pick_pipelines_sub_other', { count: projectDirs.length })
            : undefined
        }
        // Deleting is a memory-store operation; in the projects flow the list is
        // mostly ./pipelines files it can't touch, so don't offer it there.
        allowDelete={projectDirs.length === 0}
        onSelect={(loaded) =>
          dispatch({
            type: 'saved.select',
            pipeline: loaded,
            initialBackendSet: !!initialBackend,
          })
        }
        onSelectMany={(picked) =>
          dispatch({
            type: 'saved.selectMany',
            pipelines: picked,
            initialBackendSet: !!initialBackend,
          })
        }
        onDelete={(name) => {
          deletePipelineFromMemory(name);
          setSavedPipelines((prev) => prev.filter((e) => e.pipeline.name !== name));
        }}
        onCancel={() => dispatch({ type: 'saved.cancel' })}
      />
    );
  } else if (screen.kind === 'options') {
    body = (
      <OptionsScreen
        focusSpecName={screen.focusSpecName}
        onClose={() => dispatch({ type: 'options.close' })}
      />
    );
  } else if (screen.kind === 'directory-picker') {
    body = (
      <DirectoryPicker
        initialDir={repoRoot}
        multi={screen.multi === true}
        initialMarked={projectDirs}
        // Set by the Docker wrapper to the host path it bind-mounts RW (default
        // $HOME). Outside it nothing is visible in the container, so it is the
        // only sane place for a multi-project pass to start.
        workspaceRoot={process.env.HUU_WORKSPACE?.trim() || undefined}
        onSelect={(dir) => {
          setRepoRoot(dir);
          dispatch({ type: 'directory.select' });
        }}
        onConfirmMany={(dirs) => {
          // A previously reviewed queue is stale the moment the project set
          // changes — drop it so the review screen rebuilds from scratch.
          setConfirmedQueue(null);
          dispatch({ type: 'directory.selectMany', dirs });
        }}
        onCancel={() => dispatch({ type: 'directory.cancel' })}
      />
    );
  } else if (screen.kind === 'graph-picker' || screen.kind === 'graph-detail') {
    // ONE component, two screen kinds: the FSM variant decides list vs detail
    // and carries the id. All the I/O (listGraphs / readGraph /
    // compileGraphPipeline) happens inside the component, so the reducer only
    // ever sees the finished Pipeline — see `graph.launch` in screen-fsm.ts.
    body = (
      <GraphScreen
        repoRoot={repoRoot}
        mode={
          screen.kind === 'graph-detail'
            ? { kind: 'detail', graphId: screen.graphId }
            : { kind: 'list' }
        }
        onInspect={(graphId) => dispatch({ type: 'graph.inspect', graphId })}
        onLaunch={(compiled, graphName) =>
          dispatch({
            type: 'graph.launch',
            pipeline: compiled,
            graphName,
            initialBackendSet: !!initialBackend,
          })
        }
        onBack={() =>
          dispatch(
            screen.kind === 'graph-detail' ? { type: 'graph.back' } : { type: 'graph.cancel' },
          )
        }
      />
    );
  } else if (screen.kind === 'run-queue') {
    body = (
      <RunQueueScreen
        items={buildRunQueue(pipelines ?? [], projectDirs, repoRoot)}
        modelId={screen.modelId}
        onConfirm={(items) => {
          setConfirmedQueue(items);
          dispatch({ type: 'runQueue.confirm' });
        }}
        onCancel={() => {
          setConfirmedQueue(null);
          dispatch({ type: 'runQueue.cancel' });
        }}
      />
    );
  } else if (screen.kind === 'model-selector') {
    body = (
      <ModelSelectorOverlay
        backend={screen.backendKind}
        provider={screen.provider}
        onSelect={(id) => {
          // Gate on the PROVIDER the screen is carrying. AA used to be
          // universal-required and prompted here, but that fired AFTER
          // pipeline+backend+model picking — a foot-gun. AA is now optional
          // (set ARTIFICIAL_ANALYSIS_API_KEY before launching huu) and the
          // model selector degrades gracefully when missing. Re-resolve at
          // decision time so keys persisted earlier in the same session are
          // picked up.
          const runProvider = resolveRunProvider(screen.backendKind, screen.provider);
          const missing = findMissingKeysForProvider(runProvider);
          const spec = specForProvider(runProvider);
          const resolved = spec ? resolveApiKey(spec) : apiKey;
          dispatch({
            type: 'modelSelector.select',
            modelId: id,
            requiresApiKey: activeRequiresApiKey,
            backendKind: screen.backendKind,
            provider: runProvider,
            missingKeys: missing,
            resolvedApiKey: resolved,
          });
        }}
        onCancel={() =>
          dispatch({
            type: 'modelSelector.cancel',
            initialBackendSet: !!initialBackend,
          })
        }
      />
    );
  } else if (screen.kind === 'api-key') {
    body = (
      <ApiKeyPrompt
        specs={screen.missing}
        onSubmit={(values, saveGlobally) => {
          // Persist (when allowed) and propagate into process.env so the
          // rest of the app — including downstream resolveApiKey() calls
          // and any code that reads process.env directly — sees the new
          // values without further plumbing.
          for (const [name, value] of Object.entries(values)) {
            const spec = findSpec(name);
            if (!spec) continue;
            process.env[spec.envVar] = value;
            if (saveGlobally) saveApiKey(spec, value);
          }
          const next = activeSpec ? resolveApiKey(activeSpec) : '';
          dispatch({ type: 'apiKey.submit', resolvedApiKey: next });
        }}
        onCancel={() => dispatch({ type: 'apiKey.cancel' })}
      />
    );
  } else if (screen.kind === 'timeout-prompt') {
    body = (
      <TimeoutPrompt
        onSubmit={(minutes) => dispatch({ type: 'timeout.submit', minutes })}
        onCancel={() => dispatch({ type: 'timeout.cancel' })}
      />
    );
  } else if (screen.kind === 'resolver-model-selector') {
    body = (
      <Box flexDirection="column" width="100%">
        <Box paddingX={1} flexDirection="column">
          <Text bold color={theme.ai}>{t('tui.home.resolver_title')}</Text>
          <Text dimColor>{t('tui.home.resolver_body')}</Text>
        </Box>
        <ModelSelectorOverlay
          backend={screen.backendKind}
          provider={screen.provider}
          onSelect={(id) => dispatch({ type: 'resolverModelSelector.select', modelId: id })}
          onCancel={() => dispatch({ type: 'resolverModelSelector.skip' })}
        />
      </Box>
    );
  } else if (screen.kind === 'run' && (isMulti ? runQueue.length > 0 : pipeline)) {
    // A single-item queue is still a PROJECT choice: 1 pipeline × 1 marked
    // folder must run in THAT folder, not in the session repoRoot.
    const soloRun = runQueue.length === 1 ? runQueue[0]! : null;
    const runConfig = {
      apiKey: screen.apiKey || 'stub',
      modelId: screen.modelId,
      backend: backendKind,
      // The user's actual pick, all the way to the orchestrator: it names the
      // credential in `apiKey`, the base URL the helper clients use, and the
      // jcode `--provider-profile` the spawn layer will consume.
      provider: activeProvider,
      endpoint: undefined,
    };
    body = isMulti ? (
      // 2+ concurrent runs → one scheduler with LAZY admission and a project
      // switcher. Each spec carries its own cwd, so this is N PROJECTS, not N
      // pipelines against one repo. Q returns (mirrors run.abort).
      <MultiRunDashboard
        specs={runQueue}
        config={runConfig}
        agentFactory={factory}
        conflictResolverFactory={resolverFactory}
        autoScale={autoScale}
        initialConcurrency={concurrency}
        onExit={() => dispatch({ type: 'run.abort' })}
        onAuthError={(specName) =>
          dispatch({ type: 'run.authError', backendKind, specName })
        }
      />
    ) : (
      <RunDashboard
        config={runConfig}
        pipeline={soloRun?.pipeline ?? pipeline!}
        cwd={soloRun?.cwd ?? repoRoot}
        agentFactory={factory}
        conflictResolverFactory={resolverFactory}
        autoScale={autoScale}
        initialConcurrency={concurrency}
        onComplete={(result) => dispatch({ type: 'run.complete', result })}
        onAbort={() => dispatch({ type: 'run.abort' })}
        onAuthError={(specName) =>
          dispatch({ type: 'run.authError', backendKind, specName })
        }
      />
    );
  } else if (screen.kind === 'summary') {
    const r = screen.result;
    const seconds = Math.floor(r.duration / 1000);
    const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
    const ss = String(seconds % 60).padStart(2, '0');
    const committed = r.agents.filter((a) => a.commitSha).length;
    // Honest verdict colors: red = the RUN failed (manifest carries the
    // actionable reason); yellow = run completed but some agents errored;
    // green = clean.
    const failedAgents = r.agents.filter((a) => a.state === 'error');
    const runFailed = r.manifest.status === 'error';
    const verdictColor = runFailed ? 'red' : failedAgents.length > 0 ? 'yellow' : 'green';
    const verdictText = runFailed
      ? t('tui.summary.failed')
      : failedAgents.length > 0
        ? failedAgents.length === 1
          ? t('tui.summary.finished_with_failures_one', { count: failedAgents.length })
          : t('tui.summary.finished_with_failures_other', { count: failedAgents.length })
        : t('tui.summary.finished');
    body = (
      <Box flexDirection="column" width="100%">
        <Box borderStyle="round" borderColor={verdictColor} paddingX={1} flexDirection="column" width="100%">
          <Text bold color={verdictColor}>{verdictText}</Text>

          {runFailed && r.manifest.errorReason && (
            <Box marginTop={1} flexDirection="column">
              <Text color="red" wrap="wrap">⚠ {r.manifest.errorReason}</Text>
            </Box>
          )}
          {!runFailed && failedAgents.length > 0 && (
            <Box marginTop={1} flexDirection="column">
              <Text color="yellow" wrap="wrap">
                {t('tui.summary.first_failure', {
                  kind: failedAgents[0]!.errorKind ?? t('tui.summary.kind_failed'),
                  message: failedAgents[0]!.error ?? t('tui.summary.unknown'),
                })}
              </Text>
              <Text dimColor wrap="wrap">{t('tui.summary.logs_hint')}</Text>
            </Box>
          )}

          <Box marginTop={1} flexDirection="column">
            <Box>
              <Box width={24}><Text dimColor>{t('tui.summary.run_id')}</Text></Box>
              <Text bold>{r.runId}</Text>
            </Box>
            <Box>
              <Box width={24}><Text dimColor>{t('tui.summary.integration_branch')}</Text></Box>
              <Text bold>{r.manifest.integrationBranch}</Text>
            </Box>
            <Box>
              <Box width={24}><Text dimColor>{t('tui.summary.duration')}</Text></Box>
              <Text>{mm}:{ss}</Text>
            </Box>
            <Box>
              <Box width={24}><Text dimColor>{t('tui.summary.agents_committed')}</Text></Box>
              <Text>{committed} / {r.agents.length}</Text>
            </Box>
            <Box>
              <Box width={24}><Text dimColor>{t('tui.summary.files_modified')}</Text></Box>
              <Text>{r.filesModified.length}</Text>
            </Box>
            {r.integration.conflicts.length > 0 && (
              <Box>
                <Box width={24}><Text color="red">{t('tui.summary.conflicts')}</Text></Box>
                <Text color="red">{r.integration.conflicts.length}</Text>
              </Box>
            )}
          </Box>

          <Box marginTop={1}>
            <Text dimColor>
              <Text bold>ENTER</Text> {t('tui.summary.hint_back')} · <Text bold>Q</Text>{' '}
              {t('common.action.quit')}
            </Text>
          </Box>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width="100%">
      <SystemMetricsBar />
      {body}
    </Box>
  );
}

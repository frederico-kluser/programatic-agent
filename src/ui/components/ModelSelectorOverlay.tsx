import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import {
  loadRecommendedModels,
  findRecommendedModel,
} from '../../models/catalog.js';
import { loadRecents, addRecent } from '../../models/recents.js';
import { log as dlog, bump as dbump } from '../../lib/debug-logger.js';
import {
  buildRowLabel,
  HEADER_ROW,
  EMPTY_METRICS,
  type AARowMetrics,
} from '../../models/format-row.js';
import { buildMetricsIndex } from '../../models/aa-enrichment.js';
import type { AAModel } from 'model-selector-ink';
import type { ModelEntry } from '../../contracts/models.js';
import type { AgentBackendKind } from '../../lib/types.js';
import type { LlmProvider } from '../../lib/providers.js';
import { t } from '../../lib/i18n/index.js';

const MORE_MODELS_VALUE = '__more_models__';
const MIN_RECENTS_TO_SHOW = 3;
const MAX_RECENTS_IN_QUICK = 3;

export interface ModelSelectorOverlayProps {
  onSelect: (modelId: string) => void;
  onCancel: () => void;
  /**
   * Optional. When set, the catalog is filtered to only models the
   * given backend can serve. Recents/favorites are kept regardless —
   * the user might still want to pick a model they used yesterday on
   * a different backend; the upstream factory will reject if the
   * combination is invalid.
   */
  backend?: AgentBackendKind;
  /**
   * The provider that will actually serve the run. THE sharp filter: `jcode`
   * serves both DeepSeek and OpenRouter, so `backend` alone leaves a Claude
   * entry and a DeepSeek entry in the same list and lets the user pick a model
   * the chosen provider cannot serve.
   */
  provider?: LlmProvider;
}

type OverlayMode = 'quick' | 'table';

interface SelectItem {
  label: string;
  value: string;
}

type AAState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'loaded'; models: readonly AAModel[] | null };

function buildItem(
  entry: ModelEntry,
  metrics: AARowMetrics,
  prefix: string,
): SelectItem {
  return {
    label: buildRowLabel(entry, metrics, prefix),
    value: entry.id,
  };
}

export function buildQuickItems(
  metricsIndex: ReadonlyMap<string, AARowMetrics> | null,
  backend?: AgentBackendKind,
  provider?: LlmProvider,
): SelectItem[] {
  const startedAt = Date.now();
  const projectRoot = process.cwd();
  const recents = loadRecents();
  const items: SelectItem[] = [];
  const seen = new Set<string>();
  const getMetrics = (id: string): AARowMetrics =>
    metricsIndex?.get(id) ?? EMPTY_METRICS;

  const uniqueRecents: string[] = [];
  for (const id of recents.recent) {
    if (!uniqueRecents.includes(id)) uniqueRecents.push(id);
  }
  if (uniqueRecents.length >= MIN_RECENTS_TO_SHOW) {
    for (const modelId of uniqueRecents.slice(0, MAX_RECENTS_IN_QUICK)) {
      const entry = findRecommendedModel(projectRoot, modelId);
      if (entry) {
        items.push(buildItem(entry, getMetrics(entry.id), '⏱'));
      } else {
        // Fallback: model not in catalog (custom recent). Keep raw id so the
        // user can still re-select it.
        items.push({ label: `⏱ ${modelId}`, value: modelId });
      }
      seen.add(modelId);
    }
  }

  if (recents.favorites.length > 0) {
    for (const modelId of recents.favorites) {
      if (seen.has(modelId)) continue;
      const entry = findRecommendedModel(projectRoot, modelId);
      if (entry) {
        items.push(buildItem(entry, getMetrics(entry.id), '★'));
      } else {
        items.push({ label: `★ ${modelId}`, value: modelId });
      }
      seen.add(modelId);
    }
  }

  items.push({ label: `── ${t('tui.model.recommended')} ──`, value: '__separator_1__' });

  for (const entry of loadRecommendedModels(projectRoot, backend, provider)) {
    if (seen.has(entry.id)) continue;
    items.push(buildItem(entry, getMetrics(entry.id), ''));
  }

  items.push({ label: '──────────────────', value: '__separator_2__' });
  items.push({ label: `🔍 ${t('tui.model.more')}`, value: MORE_MODELS_VALUE });

  dbump('buildQuickItems');
  dlog('perf', 'buildQuickItems', {
    durationMs: Date.now() - startedAt,
    itemCount: items.length,
    recentCount: recents.recent.length,
    favoriteCount: recents.favorites.length,
    aaEnriched: metricsIndex !== null,
  });
  return items;
}

/**
 * Loads Artificial Analysis benchmark data once on mount and exposes a
 * stable reference. AA fetch runs in the background; the UI renders
 * placeholder columns ('—') until it lands. Failures degrade silently to the
 * placeholder state — never block model selection on a benchmark fetch.
 */
function useAAState(): AAState {
  const [state, setState] = useState<AAState>({ kind: 'loading' });
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    void (async () => {
      try {
        const mod = await import('model-selector-ink');
        if (cancelledRef.current) return;
        const apiKey = process.env.ARTIFICIAL_ANALYSIS_API_KEY?.trim() ?? '';
        if (!apiKey) {
          // No AA key — model-selector-ink's hook would normally consult the
          // bundled/disk fallback, but exposing that here would pull in cache
          // services we don't otherwise need. Render placeholders.
          setState({ kind: 'loaded', models: null });
          return;
        }
        const result = await mod.fetchAAModels(apiKey);
        if (cancelledRef.current) return;
        setState({
          kind: 'loaded',
          models: result.ok ? result.models : null,
        });
      } catch (err) {
        if (cancelledRef.current) return;
        dlog('error', 'ModelSelectorOverlay.aaFetch.failed', {
          message: err instanceof Error ? err.message : String(err),
        });
        setState({ kind: 'loaded', models: null });
      }
    })();
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  return state;
}

export function ModelSelectorOverlay({
  onSelect,
  onCancel,
  backend,
  provider,
}: ModelSelectorOverlayProps): React.JSX.Element {
  const [mode, setMode] = useState<OverlayMode>('quick');
  const aaState = useAAState();

  const metricsIndex = useMemo(() => {
    if (aaState.kind !== 'loaded') return null;
    const projectRoot = process.cwd();
    const catalog = loadRecommendedModels(projectRoot, backend, provider);
    return buildMetricsIndex(catalog, aaState.models);
  }, [aaState, backend, provider]);

  useEffect(() => {
    dlog('mount', 'ModelSelectorOverlay', { mode });
    return () => dlog('mount', 'ModelSelectorOverlay.unmount');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    dlog('state', 'ModelSelectorOverlay.modeChange', { mode });
  }, [mode]);

  const prevModeRef = useRef<OverlayMode>(mode);
  useEffect(() => {
    if (prevModeRef.current === 'table' && mode === 'quick') {
      process.stdout.write('\x1b[3J');
    }
    prevModeRef.current = mode;
  }, [mode]);

  useInput((input, key) => {
    dbump('input.ModelSelector');
    dlog('input', 'ModelSelectorOverlay.useInput', {
      mode,
      input,
      escape: key.escape,
      return: key.return,
    });
    if (key.escape) {
      if (mode === 'table') setMode('quick');
      else onCancel();
    }
  }, { isActive: mode === 'quick' });

  const handleQuickSelect = useCallback(
    (item: SelectItem) => {
      dlog('action', 'ModelSelectorOverlay.handleQuickSelect', { value: item.value });
      if (item.value.startsWith('__separator')) return;
      if (item.value === MORE_MODELS_VALUE) {
        setMode('table');
        return;
      }
      addRecent(item.value);
      onSelect(item.value);
    },
    [onSelect],
  );

  const handleTableSelect = useCallback(
    (modelId: string) => {
      addRecent(modelId);
      onSelect(modelId);
    },
    [onSelect],
  );

  if (mode === 'quick') {
    const items = buildQuickItems(metricsIndex, backend, provider);
    const aaSubtitle =
      aaState.kind === 'loading'
        ? t('tui.model.aa_loading')
        : metricsIndex && Array.from(metricsIndex.values()).some((m) => m.agentic !== null)
          ? t('tui.model.aa_ready')
          : t('tui.model.aa_unavailable');
    return (
      <Box flexDirection="column" width="100%">
        <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column" width="100%">
          <Text bold color="cyan">{t('tui.model.title')}</Text>
          <Text dimColor>{t('tui.model.subtitle', { metrics: aaSubtitle })}</Text>
          <Box marginTop={1}>
            <Text dimColor>{`  ${HEADER_ROW}`}</Text>
          </Box>
          <Box>
            <SelectInput items={items} onSelect={handleQuickSelect} />
          </Box>
          <Box marginTop={1}>
            <Text dimColor>
              <Text bold>↑↓</Text> {t('common.action.navigate')} · <Text bold>ENTER</Text>{' '}
              {t('common.action.select')} · <Text bold>ESC</Text> {t('common.action.cancel')}
              {`  ·  ${t('tui.model.legend')}`}
            </Text>
          </Box>
        </Box>
      </Box>
    );
  }

  return <TableView onSelect={handleTableSelect} onCancel={() => setMode('quick')} />;
}

interface TableViewProps {
  onSelect: (modelId: string) => void;
  onCancel: () => void;
}

function TableView({ onSelect, onCancel }: TableViewProps): React.JSX.Element {
  const [Loaded, setLoaded] = useState<{
    Selector: typeof import('model-selector-ink')['ModelSelector'];
  } | null>(null);

  if (!Loaded) {
    void import('model-selector-ink').then((m) => {
      setLoaded({ Selector: m.ModelSelector });
    });
    return (
      <Box flexDirection="column" width="100%">
        <Box borderStyle="round" borderColor="cyan" paddingX={1} width="100%">
          <Text color="yellow">{t('tui.model.loading_table')}</Text>
        </Box>
      </Box>
    );
  }

  const apiKey = process.env.ARTIFICIAL_ANALYSIS_API_KEY?.trim();

  return (
    <Box flexDirection="column" width="100%">
      <Text bold color="cyan" dimColor>
        {t('tui.model.esc_back')}
      </Text>
      <Loaded.Selector
        onSelect={(model) => onSelect(model.id)}
        onCancel={onCancel}
        title={t('tui.model.title')}
        {...(apiKey ? { artificialAnalysisApiKey: apiKey } : {})}
      />
    </Box>
  );
}

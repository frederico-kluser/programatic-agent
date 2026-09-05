import React, { useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import type { AgentBackendKind } from '../../orchestrator/backends/registry.js';
import { PROVIDERS, providerToBackend } from '../../lib/providers.js';
import { findMissingKeysForProvider } from '../../lib/api-key.js';
import type { LlmProvider } from '../../lib/providers.js';
import { log as dlog } from '../../lib/debug-logger.js';
import { t, translate } from '../../lib/i18n/index.js';

export interface BackendSelectorProps {
  /**
   * Receives BOTH halves of the choice: the provider the user actually picked
   * AND the concrete dispatch backend that serves it.
   *
   * The provider is not derivable from the backend — `providerToBackend` maps
   * `deepseek` and `openrouter` to the SAME `jcode` kind — so handing back the
   * backend alone destroyed the pick right here, one screen before the
   * credential gate read it. That is why this screen could render "key set" for
   * OpenRouter and the very next screen demand `DEEPSEEK_API_KEY`.
   */
  onSelect: (provider: LlmProvider, kind: AgentBackendKind) => void;
  onCancel: () => void;
}

interface SelectItem {
  label: string;
  value: LlmProvider;
}

/**
 * Provider picker. huu exposes a single dispatch backend — jcode — serving TWO
 * providers (DeepSeek and OpenRouter). The readiness badge is computed with
 * `findMissingKeysForProvider`, and the SAME provider travels back to the app
 * so the gate downstream asks for the credential the badge just promised.
 */
export function BackendSelector({
  onSelect,
  onCancel,
}: BackendSelectorProps): React.JSX.Element {
  const items: SelectItem[] = useMemo(
    () =>
      PROVIDERS.map((p) => {
        const ready = findMissingKeysForProvider(p.id).length === 0;
        const badge = ready ? t('tui.backend.key_set') : t('tui.backend.key_needed');
        return {
          // Provider blurbs live in the catalog under `provider.<id>.*` so the
          // description is translated with everything else on screen.
          label: t('tui.backend.item', {
            label: p.label,
            description: translate(`provider.${p.id}.description`),
            badge,
          }),
          value: p.id,
        };
      }),
    [],
  );

  useInput((_, key) => {
    if (key.escape) onCancel();
  });

  return (
    <Box flexDirection="column" width="100%">
      <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column" width="100%">
        <Text bold color="cyan">{t('tui.backend.title')}</Text>
        <Text dimColor>{t('tui.backend.description')}</Text>

        <Box marginTop={1}>
          <SelectInput
            items={items}
            onSelect={(item) => {
              const kind = providerToBackend(item.value);
              dlog('action', 'BackendSelector.select', { provider: item.value, kind });
              onSelect(item.value, kind);
            }}
          />
        </Box>

        <Box marginTop={1}>
          <Text dimColor>
            <Text bold>↑↓</Text> {t('common.action.navigate')} · <Text bold>ENTER</Text>{' '}
            {t('common.action.select')} · <Text bold>ESC</Text> {t('common.action.cancel')}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

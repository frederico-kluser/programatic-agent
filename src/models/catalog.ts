import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  RecommendedModelsFileSchema,
  type ModelEntry,
  type ModelProvider,
} from '../contracts/models.js';
import type { AgentBackendKind } from '../lib/types.js';
import { providersForBackend, type LlmProvider } from '../lib/providers.js';

/**
 * Compile-time parity between the two provider unions. `ModelProvider`
 * (contracts/, a zod enum) and `LlmProvider` (lib/, the runtime provider
 * table) MUST hold the same members: the catalog filter compares one against
 * the other, so a member added to only one side would silently make every
 * entry of the missing provider unselectable. `contracts/` cannot import from
 * `lib/` (downward-only), hence the assertion instead of a shared type.
 * Adding a provider to just one enum turns `_PROVIDER_UNIONS_MATCH` into
 * `never` and fails `npm run typecheck`.
 */
type SameProviders =
  [LlmProvider] extends [ModelProvider]
    ? [ModelProvider] extends [LlmProvider]
      ? true
      : never
    : never;
const _PROVIDER_UNIONS_MATCH: SameProviders = true;

/**
 * The single canonical default model id — the headline of the recommended
 * catalog and the value both front-ends preselect when the user hasn't picked
 * one. Keep in sync with the FIRST entry of `recommended-models.json` (the
 * shipped catalog) and of `DEFAULT_RECOMMENDED_MODELS` below (the in-code
 * fallback used when that file is absent or fails to parse). The web client
 * mirrors this string in `src/web/client/app.js` (vanilla JS, no TS import).
 */
export const DEFAULT_MODEL_ID = 'deepseek/deepseek-v4-flash';

const DEFAULT_RECOMMENDED_MODELS: readonly ModelEntry[] = [
  {
    id: DEFAULT_MODEL_ID,
    label: 'DeepSeek V4 Flash',
    inputPrice: 0.09,
    outputPrice: 0.18,
    description:
      'Default — fast, cheap, capable (1M context, tools + reasoning). The general-purpose default for running pipeline steps.',
    bestFor: ['fast', 'cheap', 'coding'],
    tier: 'fast',
  },
  {
    id: 'minimax/minimax-m2.7',
    label: 'MiniMax M2.7',
    inputPrice: 0.134,
    outputPrice: 1.31,
    description:
      'Fast and cheap — use for simple steps, per-file, parallel fan-out (lint, rename, JSDoc, translate, boilerplate).',
    bestFor: ['cheap', 'fast'],
    tier: 'fast',
    // OpenRouter-namespaced (`minimax/…`): api.deepseek.com serves only its own
    // models, so an entry whose vendor segment is someone else's can ONLY be
    // reached through the aggregator. Offering it under `deepseek` is offering
    // a guaranteed "model not found".
    provider: 'openrouter',
  },
  {
    id: 'moonshotai/kimi-k2.6',
    label: 'Kimi K2.6',
    inputPrice: 0.74,
    outputPrice: 4.66,
    description:
      'Deep thinking, agentic, heavy coding — use for complex steps, multi-file, reasoning, cross-file refactors.',
    bestFor: ['coding', 'reasoning', 'agentic'],
    tier: 'workhorse',
    provider: 'openrouter',
  },
];

const RECOMMENDED_MODELS_FILE = 'recommended-models.json';

/**
 * Returns the merged catalog, optionally filtered to what the active
 * dispatch target can actually serve.
 *
 * Precedence — the PROVIDER is the real axis, the backend only a fallback:
 *   · `provider` given → keep only that provider's models. This is the sharp
 *     filter, and the one callers should use: `jcode` serves BOTH providers,
 *     so the backend can never discriminate a Claude entry from a DeepSeek
 *     one.
 *   · else `backend === 'stub'` (or absent) → NO filter. A `--stub` smoke run
 *     never calls a provider, so it must be able to show every model.
 *   · else → keep the models of every provider that backend serves.
 *
 * Models without an explicit `provider` are treated as `deepseek` (back-compat
 * with files written before the field existed).
 */
export function loadRecommendedModels(
  projectRoot: string,
  backend?: AgentBackendKind,
  provider?: LlmProvider,
): ModelEntry[] {
  const filePath = join(projectRoot, RECOMMENDED_MODELS_FILE);
  let entries: readonly ModelEntry[] = DEFAULT_RECOMMENDED_MODELS;
  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      entries = RecommendedModelsFileSchema.parse(parsed).models;
    } catch {
      // Keep defaults on parse error — surfacing a hard failure here
      // breaks the TUI for a recoverable problem.
    }
  }

  const all: ModelEntry[] = [...entries];

  // An explicit provider is the sharpest filter and always wins.
  if (provider) return all.filter((m) => providerFor(m) === provider);

  // No filter when backend is undefined OR 'stub'. Stub never calls a
  // provider, so a smoke-test run (`--stub`) MUST not be blocked by a
  // filter — and it cannot fall through to the branch below, where
  // `providersForBackend('stub')` is legitimately EMPTY and would drop the
  // whole catalog.
  if (!backend || backend === 'stub') return all;

  // Real backend, provider unknown: keep everything that backend could
  // serve. Derived from the provider table, so `jcode` widens by itself the
  // day it stops serving a provider — no hardcoded answer to update.
  const servable = providersForBackend(backend);
  return all.filter((m) => servable.includes(providerFor(m)));
}

/**
 * The provider that serves an entry. The `?? 'deepseek'` default is
 * load-bearing back-compat: a `recommended-models.json` written before the
 * field existed must keep every entry selectable, not silently vanish from
 * the picker.
 */
function providerFor(m: ModelEntry): LlmProvider {
  return m.provider ?? 'deepseek';
}

export function formatPrice(price: number | undefined | null): string {
  if (price === undefined || price === null) return '$?';
  return `$${price.toFixed(2)}`;
}

export function formatModelLabel(entry: ModelEntry): string {
  return `${entry.label}  ${formatPrice(entry.inputPrice)}/${formatPrice(entry.outputPrice)}`;
}

export function findRecommendedModel(
  projectRoot: string,
  modelId: string,
): ModelEntry | undefined {
  return loadRecommendedModels(projectRoot).find((m) => m.id === modelId);
}

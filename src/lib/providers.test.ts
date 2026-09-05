import { describe, it, expect } from 'vitest';
import {
  PROVIDERS,
  modelIdForProvider,
  providerInfo,
  type LlmProvider,
} from './providers.js';

// ---------------------------------------------------------------------------
// modelIdForProvider — the model-id NAMESPACE, in both directions
// ---------------------------------------------------------------------------

// huu keeps ONE canonical model id (`vendor/model`, the OpenRouter shape) and
// renders it per endpoint. The jcode backend passes `--model` VERBATIM to the
// endpoint (`[[providers.X.models]]` is not an allowlist — measured against
// jcode v0.81.4), so whatever this function returns IS what the vendor sees.
//
// MUTATION KILLED by this block: making the function the identity (`return id`)
// — the shape the code had before, when `hermetic.ts` declared the bare
// `deepseek-v4-pro` while the catalog shipped `deepseek/deepseek-v4-flash`, so
// EVERY catalog entry died at api.deepseek.com with "model not found".
describe('modelIdForProvider', () => {
  it('strips the vendor namespace for the SINGLE-VENDOR endpoint (deepseek)', () => {
    expect(modelIdForProvider('deepseek', 'deepseek/deepseek-v4-flash')).toBe(
      'deepseek-v4-flash',
    );
    expect(modelIdForProvider('deepseek', 'deepseek/deepseek-v4-pro')).toBe(
      'deepseek-v4-pro',
    );
  });

  it('keeps the vendor namespace for the AGGREGATOR (openrouter)', () => {
    // The prefix IS openrouter.ai's routing — stripping it would break the
    // exact ids the live catalog is written in.
    expect(modelIdForProvider('openrouter', 'anthropic/claude-opus-5')).toBe(
      'anthropic/claude-opus-5',
    );
    expect(modelIdForProvider('openrouter', 'deepseek/deepseek-v4-pro')).toBe(
      'deepseek/deepseek-v4-pro',
    );
  });

  it('strips ONLY the provider’s own namespace, never a foreign one', () => {
    // A rule, not a translation table. An id aimed at the wrong endpoint must
    // arrive UNCHANGED so the vendor answers "unknown model", instead of huu
    // mangling `anthropic/claude-opus-5` into a plausible-looking
    // `claude-opus-5` that hides the real mistake.
    expect(modelIdForProvider('deepseek', 'anthropic/claude-opus-5')).toBe(
      'anthropic/claude-opus-5',
    );
    // Only the LEADING segment counts, and only once.
    expect(modelIdForProvider('deepseek', 'x/deepseek/v4')).toBe('x/deepseek/v4');
  });

  it('is idempotent — an already-bare id survives a second pass', () => {
    const once = modelIdForProvider('deepseek', 'deepseek/deepseek-v4-pro');
    expect(modelIdForProvider('deepseek', once)).toBe(once);
  });

  it('trims, and leaves an id alone when there is no provider (stub)', () => {
    expect(modelIdForProvider('deepseek', '  deepseek/deepseek-v4-pro \n')).toBe(
      'deepseek-v4-pro',
    );
    expect(modelIdForProvider(undefined, 'deepseek/deepseek-v4-pro')).toBe(
      'deepseek/deepseek-v4-pro',
    );
  });
});

// ---------------------------------------------------------------------------
// The provider table itself
// ---------------------------------------------------------------------------

describe('PROVIDERS — every entry is complete enough to route a run', () => {
  // MUTATION KILLED: adding a provider with no `keysUrl`/`apiKeySpecName`, or
  // pointing two providers at the same base URL — either would make one
  // provider's credential reachable at another's host.
  it('gives every provider its own base URL and a key page', () => {
    const urls = new Set<string>();
    for (const info of PROVIDERS) {
      expect(info.defaultBaseUrl).toMatch(/^https:\/\/[^/]+\/.+[^/]$/);
      expect(info.keysUrl).toMatch(/^https:\/\//);
      expect(info.apiKeySpecName.trim()).not.toBe('');
      expect(urls.has(info.defaultBaseUrl)).toBe(false);
      urls.add(info.defaultBaseUrl);
    }
  });

  it('declares a namespace only where the endpoint is single-vendor', () => {
    // `providerInfo` is the single source both the jcode profile writer and the
    // LangChain client read, so this pins the fact the whole rule rests on.
    expect(providerInfo('deepseek').modelNamespace).toBe('deepseek');
    expect(providerInfo('openrouter').modelNamespace).toBeUndefined();
  });

  it('renders SOME id for every provider, whatever the id', () => {
    for (const info of PROVIDERS) {
      const p: LlmProvider = info.id;
      expect(modelIdForProvider(p, 'deepseek/deepseek-v4-pro')).not.toBe('');
    }
  });
});

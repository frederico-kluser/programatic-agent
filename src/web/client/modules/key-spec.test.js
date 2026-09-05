// @vitest-environment jsdom
/* The BROWSER's answer to "which key does this run need".
   ==================================================================

   The ⚙ Settings panel wrote the key it validated to the HARD-CODED spec
   `'openrouter'` (four call sites) while a run resolved the credential of
   whatever provider was selected. On a DeepSeek machine the two never met: the
   key saved in Settings simply never reached a run. That was already broken
   BEFORE OpenRouter came back as a first-class provider — reintroducing the
   second provider only made the mismatch reachable in both directions.

   The fix is one helper: ask the ACTIVE provider (the `/api/providers`
   projection the launch form already gates on) for its spec. These tests pin
   that helper, because it is the only thing standing between "the key I saved"
   and "the key the run spends".

   `state.js` touches `document` and `location` at import time, hence jsdom. */

import { describe, expect, it } from 'vitest';
import { activeKeySpec, activeKeySpecName, providerKeySpecName } from './state.js';

/** The shape `/api/providers` (listProvidersInfo) actually returns. */
const PROVIDERS = [
  {
    id: 'deepseek',
    backend: 'jcode',
    label: 'DeepSeek',
    description: 'x',
    hasKey: false,
    keySpecs: [{ name: 'deepseek', label: 'DeepSeek', hint: 'starts with sk-', present: false }],
  },
  {
    id: 'openrouter',
    backend: 'jcode',
    label: 'OpenRouter',
    description: 'y',
    hasKey: true,
    keySpecs: [
      { name: 'openrouter', label: 'OpenRouter', hint: 'starts with sk-or-', present: true },
    ],
  },
];

describe('activeKeySpec — the panel follows the provider, never a literal', () => {
  it('names the DeepSeek spec while DeepSeek is selected', () => {
    // MUTATION KILLED: going back to a hard-coded `'openrouter'` in the
    // Settings panel. With DeepSeek selected, that writes the key under the
    // wrong name and the run — which reads the ACTIVE provider's spec — never
    // sees it.
    const S = { providers: PROVIDERS, provider: 'deepseek' };
    expect(activeKeySpec(S)?.name).toBe('deepseek');
    expect(activeKeySpecName(S)).toBe('deepseek');
  });

  it('names the OpenRouter spec while OpenRouter is selected', () => {
    const S = { providers: PROVIDERS, provider: 'openrouter' };
    expect(activeKeySpec(S)?.name).toBe('openrouter');
    expect(activeKeySpecName(S)).toBe('openrouter');
  });

  it('degrades to nothing (never to a guess) when the provider is unknown', () => {
    // MUTATION KILLED: defaulting to one provider's spec when the projection
    // has no entry — a guess here is a key sent to the wrong vendor.
    expect(activeKeySpec({ providers: PROVIDERS, provider: 'nope' })).toBeNull();
    expect(activeKeySpecName({ providers: [], provider: 'deepseek' })).toBe('');
  });
});

describe('providerKeySpecName — a queued row carries its OWN provider', () => {
  it('answers per row, not per current selection', () => {
    // MUTATION KILLED: resolving the queue's session key from `S.provider`
    // (or from `item.backend`, which is `jcode` for both). Two rows in one
    // queue may target different providers; the shared backend names neither.
    const S = { providers: PROVIDERS, provider: 'deepseek' };
    expect(providerKeySpecName(S, 'openrouter')).toBe('openrouter');
    expect(providerKeySpecName(S, 'deepseek')).toBe('deepseek');
    expect(providerKeySpecName(S, undefined)).toBe('');
  });
});

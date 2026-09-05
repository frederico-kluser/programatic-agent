import { describe, expect, it } from 'vitest';
import { API_KEY_REGISTRY, detectForeignKeySpec, findSpec } from './api-key-registry.js';

/**
 * The CROSS-SPEC guard, seen from the registry rather than from the validator.
 *
 * `api-key.test.ts` already covers the DeepSeek ⇄ OpenRouter case the guard was
 * born for. What lives here is the OTHER half — the specs the guard used to be
 * structurally unable to judge — and the exact shape of the limitation that is
 * left, so nobody has to re-derive it from the loop body.
 */
describe('detectForeignKeySpec — the specs beyond the two LLM providers', () => {
  const brave = () => findSpec('brave')!;
  const deepseek = () => findSpec('deepseek')!;
  const openrouter = () => findSpec('openrouter')!;

  describe('brave — the spec that owns a probe, and therefore a format', () => {
    it('declares BSA, the prefix real Brave keys carry', () => {
      // Measured, not guessed: the installed surf CLI's Brave adapter documents
      // `X-Subscription-Token` keys as `BSA…`, and every Brave key held in this
      // machine's ~/.config/surf/keys.json is `BSA` + 28 characters.
      //
      // This is a SAFETY field, not a UX hint — see the test below for what it
      // buys — which is why it is pinned here rather than left implicit.
      expect(brave().validatePrefix).toBe('BSA');
      expect(brave().hint).toContain('BSA');
    });

    it('catches another provider\'s key pasted into the Brave prompt', () => {
      // WHAT WAS BROKEN: with no `validatePrefix` on the target, the guard
      // returned `undefined` on its second line and never looked at the value.
      // An OpenRouter secret in this slot was therefore accepted, persisted —
      // and, because `brave` is the one non-LLM spec with a live probe, sent
      // to api.search.brave.com to be validated.
      expect(detectForeignKeySpec(brave(), 'sk-or-v1-abcdef')?.name).toBe('openrouter');
      expect(detectForeignKeySpec(brave(), 'sk-abcdef')?.name).toBe('deepseek');
      expect(detectForeignKeySpec(brave(), 'tvly-abcdef')?.name).toBe('tavily');
    });

    it('lets a real Brave key through, and is caught in the other prompts', () => {
      // The false-positive direction. A `BSA…` value matches nothing else in
      // the registry, so declaring the prefix cannot block a legitimate key —
      // and the same declaration now stops a Brave key being filed as DeepSeek.
      expect(detectForeignKeySpec(brave(), 'BSAabcdefghijklmnopqrstuvwxyz12')).toBeUndefined();
      expect(detectForeignKeySpec(deepseek(), 'BSAabcdefghijklmnopqrstuvwxyz12')?.name).toBe(
        'brave',
      );
      expect(detectForeignKeySpec(openrouter(), 'BSAabcdefghijklmnopqrstuvwxyz12')?.name).toBe(
        'brave',
      );
    });

    it('a Brave key of an UNKNOWN shape is warned about, never blocked', () => {
      // The soft/hard split that makes declaring a prefix cheap: only a value
      // matching ANOTHER spec's prefix returns a (blocking) `wrong-key`. A
      // value matching nothing — a future Brave format, a legacy key — comes
      // back `undefined` here and is left to the SOFT prefix warning the UI
      // renders, which the user can ignore and submit through.
      expect(detectForeignKeySpec(brave(), 'some-future-brave-format')).toBeUndefined();
    });
  });

  describe('the limitation that remains, stated so it cannot be mistaken for coverage', () => {
    it('is a no-op for every spec that declares no format', () => {
      // NOT A BUG — a deliberate refusal to guess. `wrong-key` blocks with no
      // in-product override (`ApiKeyPrompt` will not submit, `POST /api/keys`
      // will not save), and this repo knows no format for these two, so calling
      // an `sk-…` value foreign here would hard-block a credential that may be
      // perfectly good.
      const prefixless = API_KEY_REGISTRY.filter((s) => !s.validatePrefix);
      expect(prefixless.map((s) => s.name)).toEqual(['artificialAnalysis', 'parallel']);
      for (const spec of prefixless) {
        expect(detectForeignKeySpec(spec, 'sk-or-v1-abcdef'), spec.name).toBeUndefined();
        expect(detectForeignKeySpec(spec, 'tvly-abcdef'), spec.name).toBeUndefined();
      }
    });

    it('costs "stored under the wrong name", never "sent to the wrong host"', () => {
      // WHY the limitation above is tolerable, expressed as a checkable fact
      // instead of a promise: a prefix-less spec has no probe, so a value
      // pasted into it never leaves the machine during validation. The probe
      // side of the same invariant is pinned in `key-validation.test.ts`
      // ('every spec that can put a key on the wire declares a prefix') —
      // stated here too because THIS is the file whose data makes it true.
      for (const spec of API_KEY_REGISTRY) {
        if (spec.validatePrefix) continue;
        expect(['artificialAnalysis', 'parallel']).toContain(spec.name);
      }
    });
  });
});

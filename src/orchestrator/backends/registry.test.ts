import { describe, it, expect } from 'vitest';
import {
  ALL_BACKENDS,
  parseBackendKind,
  selectBackend,
} from './registry.js';
import {
  PROVIDERS,
  providerToBackend,
  providersForBackend,
  defaultProviderForBackend,
  backendToProvider,
  parseProvider,
  apiKeySpecNameForProvider,
  resolveRunProvider,
} from '../../lib/providers.js';
import { findSpec } from '../../lib/api-key-registry.js';

describe('backend registry', () => {
  describe('ALL_BACKENDS', () => {
    it('lists exactly jcode and stub (pi, azure, copilot removed)', () => {
      expect([...ALL_BACKENDS].sort()).toEqual(['jcode', 'stub']);
    });

    it('no longer contains pi, azure, or copilot', () => {
      expect([...ALL_BACKENDS]).not.toContain('pi');
      expect([...ALL_BACKENDS]).not.toContain('azure');
      expect([...ALL_BACKENDS]).not.toContain('copilot');
    });
  });

  describe('parseBackendKind', () => {
    it('accepts canonical names', () => {
      expect(parseBackendKind('jcode')).toBe('jcode');
      expect(parseBackendKind('stub')).toBe('stub');
    });

    it('accepts legacy aliases', () => {
      expect(parseBackendKind('deepseek')).toBe('jcode');
      expect(parseBackendKind('fake')).toBe('stub');
      expect(parseBackendKind('mock')).toBe('stub');
    });

    it('is case-insensitive and trims whitespace', () => {
      expect(parseBackendKind('  JCODE  ')).toBe('jcode');
      expect(parseBackendKind('Stub')).toBe('stub');
    });

    it('returns null for unknown values (including removed backends)', () => {
      expect(parseBackendKind('pi')).toBeNull();
      expect(parseBackendKind('real')).toBeNull();
      expect(parseBackendKind('openrouter')).toBeNull();
      expect(parseBackendKind('azure')).toBeNull();
      expect(parseBackendKind('azure-foundry')).toBeNull();
      expect(parseBackendKind('copilot')).toBeNull();
      expect(parseBackendKind('claude-code')).toBeNull();
      expect(parseBackendKind('')).toBeNull();
      expect(parseBackendKind('xyz')).toBeNull();
    });
  });

  describe('selectBackend', () => {
    it('jcode: requires an API key but names NO spec — the provider does', () => {
      // MUTATION KILLED: re-adding `apiKeySpecName: 'deepseek'` here.
      // `jcode` dispatches BOTH providers, so a spec name on the bundle can
      // only ever be one of them, and every gate that read it (app.tsx,
      // cli.tsx `auto`, web run-manager) demanded DEEPSEEK_API_KEY from an
      // OpenRouter run. The credential is `specForProvider(provider)`.
      const b = selectBackend('jcode');
      expect(b.requiresApiKey).toBe(true);
      expect(b.apiKeySpecName).toBeUndefined();
      expect(b.conflictResolverFactory).toBe(b.agentFactory);
    });

    it('stub: no API key, no conflict resolver', () => {
      const b = selectBackend('stub');
      expect(b.requiresApiKey).toBe(false);
      expect(b.apiKeySpecName).toBeUndefined();
      expect(b.conflictResolverFactory).toBeUndefined();
    });

    it('every backend exposes a label and description', () => {
      for (const kind of ALL_BACKENDS) {
        const b = selectBackend(kind);
        expect(b.label).toBeTruthy();
        expect(b.description).toBeTruthy();
      }
    });

    it('the spec a jcode run needs comes from the PROVIDER, both ways', () => {
      // The positive half of the pin above: dropping the name off the bundle
      // is only safe because the provider table answers the same question
      // sharply, per provider.
      expect(apiKeySpecNameForProvider('deepseek')).toBe('deepseek');
      expect(apiKeySpecNameForProvider('openrouter')).toBe('openrouter');
      // No provider (stub) → no credential, by construction.
      expect(apiKeySpecNameForProvider(undefined)).toBeUndefined();
      expect(apiKeySpecNameForProvider(resolveRunProvider('stub'))).toBeUndefined();
    });

    it('every declared apiKeySpecName resolves to a REAL API_KEY_REGISTRY spec', () => {
      // Regression pin: jcode declared `apiKeySpecName: 'deepseek'` while the
      // registry had no such entry, so findSpec returned undefined and
      // docker-reexec (which iterates API_KEY_REGISTRY to build secret mounts
      // and the -e passthrough) never carried DEEPSEEK_API_KEY into the
      // container. A dangling name must fail here, not at run time.
      for (const kind of ALL_BACKENDS) {
        const b = selectBackend(kind);
        if (b.apiKeySpecName === undefined) {
          // No spec on the bundle is legitimate in TWO shapes now: a keyless
          // backend (stub), or a backend served by several providers (jcode),
          // where the provider — never the backend — names the credential.
          // Whichever it is, every provider it serves must name a real spec.
          for (const p of providersForBackend(kind)) {
            const name = apiKeySpecNameForProvider(p);
            expect(name, `${kind} → ${p}`).toBeDefined();
            expect(findSpec(name!), `${kind} → ${p} → ${name}`).toBeDefined();
          }
          if (b.requiresApiKey) {
            expect(providersForBackend(kind).length, `${kind} needs a key`).toBeGreaterThan(0);
          }
          continue;
        }
        expect(findSpec(b.apiKeySpecName), `${kind} → ${b.apiKeySpecName}`).toBeDefined();
      }
    });

    it('only jcode is user-selectable (stub via CLI)', () => {
      expect(selectBackend('jcode').userSelectable).toBe(true);
      expect(selectBackend('stub').userSelectable).toBe(false);
    });
  });

  describe('provider mapping', () => {
    it('exposes both DeepSeek and OpenRouter', () => {
      expect(PROVIDERS.map((p) => p.id).sort()).toEqual(['deepseek', 'openrouter']);
    });

    it('BOTH providers dispatch to the same jcode backend', () => {
      // The fact that makes `backendToProvider` ambiguous and forces every
      // credential/catalog decision onto the provider axis.
      expect(providerToBackend('deepseek')).toBe('jcode');
      expect(providerToBackend('openrouter')).toBe('jcode');
    });

    it('providersForBackend: jcode serves both, stub serves NONE', () => {
      // The empty array is load-bearing: it is what makes `stub` keyless and
      // catalog-unfiltered without a hardcoded special case in either place.
      expect([...providersForBackend('jcode')].sort()).toEqual(['deepseek', 'openrouter']);
      expect(providersForBackend('stub')).toEqual([]);
    });

    it('every provider points at a REAL API_KEY_REGISTRY spec', () => {
      // Same regression shape as the backend pin above: a dangling
      // apiKeySpecName means docker-reexec never forwards that key.
      for (const p of PROVIDERS) {
        expect(findSpec(p.apiKeySpecName), `${p.id} → ${p.apiKeySpecName}`).toBeDefined();
      }
    });

    it('resolveRunProvider: honors the pick, refuses an impossible pair, and stays empty for stub', () => {
      // THE funnel every gate goes through. Three rules, one function:
      //   · a provider the backend serves is HONORED (the user's pick survives);
      //   · a provider the backend cannot serve is DISCARDED for the backend's
      //     own first provider — never sending one vendor's key to another;
      //   · a backend that serves nobody yields `undefined`, which is what
      //     keeps `--stub` keyless.
      // MUTATION KILLED: using `defaultProviderForBackend` here instead. It
      // falls back to DEFAULT_PROVIDER for `stub`, so a keyless smoke run would
      // start demanding DEEPSEEK_API_KEY.
      expect(resolveRunProvider('jcode', 'openrouter')).toBe('openrouter');
      expect(resolveRunProvider('jcode', 'deepseek')).toBe('deepseek');
      expect(resolveRunProvider('jcode')).toBe('deepseek');
      expect(resolveRunProvider('stub')).toBeUndefined();
      expect(resolveRunProvider('stub', 'openrouter')).toBeUndefined();
      expect(defaultProviderForBackend('stub')).toBe('deepseek'); // the trap it avoids
    });

    it('every provider declares a distinct https base URL', () => {
      // The base URL is what routes the LangChain helpers; two providers
      // sharing one would silently send a key to the wrong vendor.
      const urls = PROVIDERS.map((p) => p.defaultBaseUrl);
      expect(new Set(urls).size).toBe(PROVIDERS.length);
      for (const u of urls) {
        expect(u.startsWith('https://'), u).toBe(true);
        expect(u.endsWith('/'), u).toBe(false);
      }
    });

    it('defaultProviderForBackend is a DEFAULT, not an answer', () => {
      // jcode serves two providers; this returns the FIRST — the fallback for
      // callers that never made a choice. `backendToProvider` is the
      // @deprecated alias of exactly this, kept so existing call sites compile.
      expect(defaultProviderForBackend('jcode')).toBe('deepseek');
      expect(backendToProvider('jcode')).toBe(defaultProviderForBackend('jcode'));
      expect(backendToProvider('stub')).toBe(defaultProviderForBackend('stub'));
    });

    it('parses provider strings and aliases', () => {
      expect(parseProvider('deepseek')).toBe('deepseek');
      expect(parseProvider('ds')).toBe('deepseek');
      expect(parseProvider('openrouter')).toBe('openrouter');
      expect(parseProvider('or')).toBe('openrouter');
      expect(parseProvider('  OpenRouter  ')).toBe('openrouter');
      expect(parseProvider('nope')).toBeNull();
    });
  });
});

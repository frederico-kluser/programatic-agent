import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  API_KEY_REGISTRY,
  clearStoredApiKey,
  configFilePath,
  findMissingKeysForBackend,
  findMissingKeysForProvider,
  findMissingRequiredKeys,
  findSpec,
  keyRemedyHint,
  loadStoredApiKey,
  maskKey,
  resolveApiKey,
  resolveApiKeyWithSource,
  resolveApiKeyForProvider,
  resolveDeepSeekApiKey,
  saveApiKey,
  specForProvider,
  detectForeignKeySpec,
} from './api-key.js';

describe('api-key registry', () => {
  // Tests must isolate from the user's real ~/.config/huu/config.json.
  // We point XDG_CONFIG_HOME at a tmpdir for every test so saves and
  // loads land there.
  const TRACKED_ENV = [
    'OPENROUTER_API_KEY',
    'OPENROUTER_API_KEY_FILE',
    'ARTIFICIAL_ANALYSIS_API_KEY',
    'ARTIFICIAL_ANALYSIS_API_KEY_FILE',
    'TAVILY_API_KEY',
    'TAVILY_API_KEY_FILE',
    'PARALLEL_API_KEY',
    'PARALLEL_API_KEY_FILE',
    'BRAVE_API_KEY',
    'BRAVE_API_KEY_FILE',
    'DEEPSEEK_API_KEY',
    'DEEPSEEK_API_KEY_FILE',
    'XDG_CONFIG_HOME',
    'HUU_CONFIG_DIR',
  ] as const;
  const saved: Record<string, string | undefined> = {};
  let tmpDir: string;
  let configHome: string;

  beforeEach(() => {
    for (const k of TRACKED_ENV) saved[k] = process.env[k];
    for (const k of TRACKED_ENV) delete process.env[k];
    tmpDir = mkdtempSync(join(tmpdir(), 'huu-api-key-test-'));
    configHome = join(tmpDir, 'xdg');
    process.env.XDG_CONFIG_HOME = configHome;
  });

  afterEach(() => {
    for (const k of TRACKED_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('registry shape', () => {
    it('includes the deepseek + artificialAnalysis specs', () => {
      const names = API_KEY_REGISTRY.map((s) => s.name);
      expect(names).toContain('deepseek');
      expect(names).toContain('artificialAnalysis');
    });

    it('artificialAnalysis is optional (required: false)', () => {
      // AA is purely informational — used by the model selector to enrich
      // entries with benchmark metrics. Demoting `required` to false
      // removed a foot-gun where AA was prompted AFTER pipeline + backend +
      // model selection, blocking the run at the last step.
      const aa = findSpec('artificialAnalysis')!;
      expect(aa.required).toBe(false);
    });

    it('every entry has the secret-mount path under /run/secrets', () => {
      for (const spec of API_KEY_REGISTRY) {
        expect(spec.secretMountPath.startsWith('/run/secrets/')).toBe(true);
      }
    });

    it('findSpec returns by name', () => {
      // Two distinct names -> two distinct specs: this pins the name->spec
      // mapping itself, not merely that one lookup happens to resolve.
      expect(findSpec('deepseek')?.envVar).toBe('DEEPSEEK_API_KEY');
      expect(findSpec('openrouter')?.envVar).toBe('OPENROUTER_API_KEY');
      expect(findSpec('not-a-registered-key')).toBeUndefined();
    });

    it('includes the three web-research specs (tavily/parallel/brave)', () => {
      const names = API_KEY_REGISTRY.map((s) => s.name);
      expect(names).toContain('tavily');
      expect(names).toContain('parallel');
      expect(names).toContain('brave');
      expect(findSpec('tavily')?.envVar).toBe('TAVILY_API_KEY');
      expect(findSpec('parallel')?.envVar).toBe('PARALLEL_API_KEY');
      expect(findSpec('brave')?.envVar).toBe('BRAVE_API_KEY');
      expect(findSpec('tavily')?.validatePrefix).toBe('tvly-');
    });

    it('includes the deepseek spec the jcode backend points at', () => {
      // `selectBackend('jcode').apiKeySpecName === 'deepseek'`. Without this
      // entry findSpec returns undefined and docker-reexec — which iterates
      // API_KEY_REGISTRY to build secret mounts and the -e passthrough —
      // never carries DEEPSEEK_API_KEY into the container.
      const spec = findSpec('deepseek')!;
      expect(spec.envVar).toBe('DEEPSEEK_API_KEY');
      expect(spec.envFileVar).toBe('DEEPSEEK_API_KEY_FILE');
      expect(spec.secretMountPath).toBe('/run/secrets/deepseek_api_key');
      expect(spec.hostSecretScope).toBe('huu-deepseek-key');
      expect(spec.validatePrefix).toBe('sk-');
    });

    it('deepseek is bound to the deepseek PROVIDER (not to a backend)', () => {
      const spec = findSpec('deepseek')!;
      expect(spec.providerBound).toBe('deepseek');
      expect(spec.required).toBe(true);
    });

    it('openrouter is bound to its provider AND `required: false`', () => {
      // This exact shape (`providerBound` set + `required: false`) is what
      // makes the gate's two rules distinguishable: the binding must enforce
      // the key for an OpenRouter run while `required: false` keeps it out of
      // the universal gate, so a DeepSeek run never asks for it.
      const spec = findSpec('openrouter')!;
      expect(spec.providerBound).toBe('openrouter');
      expect(spec.required).toBe(false);
      expect(spec.envVar).toBe('OPENROUTER_API_KEY');
    });

    it('the two provider keys bind to DIFFERENT providers', () => {
      // Binding both to the shared `jcode` backend was the design error this
      // replaced: it would make a single run demand BOTH credentials.
      expect(findSpec('deepseek')!.providerBound).not.toBe(
        findSpec('openrouter')!.providerBound,
      );
    });

    it('the research specs are optional AND unbound — invisible to the run gate', () => {
      // The gate only enforces a spec without `providerBound` when
      // `required: true`. Both flags together are what keeps a missing
      // research key from ever blocking a run.
      for (const name of ['tavily', 'parallel', 'brave']) {
        const spec = findSpec(name)!;
        expect(spec.required, `${name}.required`).toBe(false);
        expect(spec.providerBound, `${name}.providerBound`).toBeUndefined();
      }
    });
  });

  describe('resolveApiKey', () => {
    it('returns empty when nothing is set anywhere', () => {
      const spec = findSpec('deepseek')!;
      expect(resolveApiKey(spec)).toBe('');
    });

    it('reads the env var when set', () => {
      const spec = findSpec('deepseek')!;
      process.env.DEEPSEEK_API_KEY = '  sk-plain  ';
      expect(resolveApiKey(spec)).toBe('sk-plain');
    });

    it('reads via _FILE env var (trimmed)', () => {
      const spec = findSpec('deepseek')!;
      const path = join(tmpDir, 'key.txt');
      writeFileSync(path, 'sk-from-file\n');
      process.env.DEEPSEEK_API_KEY_FILE = path;
      expect(resolveApiKey(spec)).toBe('sk-from-file');
    });

    it('_FILE wins over plain env when both are set', () => {
      const spec = findSpec('deepseek')!;
      const path = join(tmpDir, 'key.txt');
      writeFileSync(path, 'sk-from-file');
      process.env.DEEPSEEK_API_KEY_FILE = path;
      process.env.DEEPSEEK_API_KEY = 'sk-plain';
      expect(resolveApiKey(spec)).toBe('sk-from-file');
    });

    it('falls back to plain env when _FILE points at a missing path', () => {
      const spec = findSpec('deepseek')!;
      process.env.DEEPSEEK_API_KEY_FILE = join(tmpDir, 'does-not-exist');
      process.env.DEEPSEEK_API_KEY = 'sk-fallback';
      expect(resolveApiKey(spec)).toBe('sk-fallback');
    });

    it('falls back to the global store when env is empty', () => {
      const spec = findSpec('deepseek')!;
      saveApiKey(spec, 'sk-from-store');
      expect(resolveApiKey(spec)).toBe('sk-from-store');
    });

    it('the saved store wins over the env var (explicit beats ambient)', () => {
      const spec = findSpec('deepseek')!;
      saveApiKey(spec, 'sk-from-store');
      process.env.DEEPSEEK_API_KEY = 'sk-from-env';
      expect(resolveApiKey(spec)).toBe('sk-from-store');
    });

    it('resolves arbitrary specs (artificialAnalysis)', () => {
      const spec = findSpec('artificialAnalysis')!;
      process.env.ARTIFICIAL_ANALYSIS_API_KEY = 'aa-12345';
      expect(resolveApiKey(spec)).toBe('aa-12345');
    });
  });

  describe('resolveApiKeyWithSource', () => {
    const spec = () => findSpec('deepseek')!;

    it('reports source "none" when nothing is set', () => {
      const r = resolveApiKeyWithSource(spec());
      expect(r).toEqual({ value: '', source: 'none', storedOverridesEnv: false });
    });

    it('reports source "stored" when only the global store has it', () => {
      saveApiKey(spec(), 'sk-stored');
      const r = resolveApiKeyWithSource(spec());
      expect(r.value).toBe('sk-stored');
      expect(r.source).toBe('stored');
      // No ambient env var, so nothing is being overridden.
      expect(r.storedOverridesEnv).toBe(false);
    });

    it('reports source "env" when the env var is the only key (no saved key)', () => {
      process.env.DEEPSEEK_API_KEY = 'sk-env';
      const r = resolveApiKeyWithSource(spec());
      expect(r.value).toBe('sk-env');
      expect(r.source).toBe('env');
      expect(r.storedOverridesEnv).toBe(false);
    });

    it('reports source "env-file" when the _FILE var wins', () => {
      const path = join(tmpDir, 'key.txt');
      writeFileSync(path, 'sk-from-file\n');
      process.env.DEEPSEEK_API_KEY_FILE = path;
      const r = resolveApiKeyWithSource(spec());
      expect(r.value).toBe('sk-from-file');
      expect(r.source).toBe('env-file');
    });

    it('flags storedOverridesEnv when a saved key overrides a DIFFERENT env var', () => {
      // The inverted production bug: a valid key saved in Options now WINS over
      // a stale key in the environment (e.g. exported from ~/.secrets), so the
      // saved key is used and the env var is flagged as ignored.
      saveApiKey(spec(), 'sk-valid-saved');
      process.env.DEEPSEEK_API_KEY = 'sk-stale-env';
      const r = resolveApiKeyWithSource(spec());
      expect(r.value).toBe('sk-valid-saved');
      expect(r.source).toBe('stored');
      expect(r.storedOverridesEnv).toBe(true);
    });

    it('does NOT flag storedOverridesEnv when env and store hold the same key', () => {
      saveApiKey(spec(), 'sk-same');
      process.env.DEEPSEEK_API_KEY = 'sk-same';
      const r = resolveApiKeyWithSource(spec());
      expect(r.source).toBe('stored');
      expect(r.storedOverridesEnv).toBe(false);
    });

    it('value matches resolveApiKey for every tier (no behavior drift)', () => {
      saveApiKey(spec(), 'sk-stored');
      process.env.DEEPSEEK_API_KEY = 'sk-env';
      expect(resolveApiKeyWithSource(spec()).value).toBe(resolveApiKey(spec()));
    });
  });

  describe('keyRemedyHint', () => {
    const spec = () => findSpec('deepseek')!;

    it('the stored-overrides-env case names the ignored env var and points at Options', () => {
      const hint = keyRemedyHint(spec(), {
        value: 'x',
        source: 'stored',
        storedOverridesEnv: true,
      });
      expect(hint).toContain('DEEPSEEK_API_KEY');
      expect(hint).toContain('IGNORED');
      expect(hint).toContain('Options');
      expect(hint).toContain('precedence');
      expect(hint).toContain('rejected');
    });

    it('the plain stored case tells you to update the saved key in Options', () => {
      const hint = keyRemedyHint(spec(), {
        value: 'x',
        source: 'stored',
        storedOverridesEnv: false,
      });
      expect(hint).toContain('Options screen');
      expect(hint).toContain('rejected');
    });

    it('the none case asks the user to add a key', () => {
      const hint = keyRemedyHint(spec(), {
        value: '',
        source: 'none',
        storedOverridesEnv: false,
      });
      expect(hint).toContain('No DEEPSEEK_API_KEY');
    });

    it('never leaks the key value into the hint', () => {
      const secret = 'sk-supersecret-value';
      for (const source of ['env', 'env-file', 'secret-mount', 'stored', 'none'] as const) {
        const hint = keyRemedyHint(spec(), { value: secret, source, storedOverridesEnv: true });
        expect(hint).not.toContain(secret);
      }
    });
  });

  describe('saveApiKey', () => {
    it('writes the global store with mode 0600 in a 0700 dir', () => {
      const spec = findSpec('deepseek')!;
      saveApiKey(spec, 'sk-saved');
      const path = configFilePath();
      expect(path.startsWith(configHome)).toBe(true);
      // 0o777 mask filters umask noise.
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      // The store is keyed by `spec.name`, NOT by the env var.
      expect(parsed.deepseek).toBe('sk-saved');
    });

    it('preserves other keys when saving one', () => {
      const ds = findSpec('deepseek')!;
      const aa = findSpec('artificialAnalysis')!;
      saveApiKey(ds, 'sk-1');
      saveApiKey(aa, 'aa-2');
      const parsed = JSON.parse(readFileSync(configFilePath(), 'utf8'));
      expect(parsed).toEqual({ deepseek: 'sk-1', artificialAnalysis: 'aa-2' });
    });

    it('ignores empty values (doesn’t pollute the store)', () => {
      const spec = findSpec('deepseek')!;
      saveApiKey(spec, '   ');
      expect(loadStoredApiKey(spec)).toBe('');
    });
  });

  describe('findMissingRequiredKeys', () => {
    it('returns deepseek when nothing is set', () => {
      const missing = findMissingRequiredKeys();
      const names = missing.map((s) => s.name);
      expect(names).toContain('deepseek');
    });

    it('does not return artificialAnalysis (required: false)', () => {
      // AA is optional — see "artificialAnalysis is optional" test above.
      const missing = findMissingRequiredKeys();
      const names = missing.map((s) => s.name);
      expect(names).not.toContain('artificialAnalysis');
    });

    it('drops a spec once its key is in env', () => {
      process.env.DEEPSEEK_API_KEY = 'sk-set';
      const missing = findMissingRequiredKeys();
      const names = missing.map((s) => s.name);
      expect(names).not.toContain('deepseek');
    });

    it('drops a spec once its key is in the global store', () => {
      const spec = findSpec('deepseek')!;
      saveApiKey(spec, 'sk-stored');
      const missing = findMissingRequiredKeys();
      const names = missing.map((s) => s.name);
      expect(names).not.toContain('deepseek');
    });

    it('the removed copilot spec is gone from the registry', () => {
      const names = API_KEY_REGISTRY.map((s) => s.name);
      expect(names).not.toContain('copilot');
    });

    it('does not require the web-research specs (required: false)', () => {
      const names = findMissingRequiredKeys().map((s) => s.name);
      expect(names).not.toContain('tavily');
      expect(names).not.toContain('parallel');
      expect(names).not.toContain('brave');
    });

    it('the removed azure specs are gone from the registry', () => {
      // The azure backend was deleted along with pi (`AgentBackendKind` is
      // `'jcode' | 'stub'` now), and its two specs went with it. Pinned in
      // the same shape as the copilot removal above so a re-add has to be
      // deliberate rather than accidental.
      const names = API_KEY_REGISTRY.map((s) => s.name);
      expect(names).not.toContain('azureApiKey');
      expect(names).not.toContain('azureEndpoint');
    });
  });

  describe('findMissingKeysForBackend (backend-aware)', () => {
    it('jcode backend: requires ONLY deepseek when nothing is configured', () => {
      // Non-vacuous on three fronts:
      //  · the research specs (tavily/parallel/brave) carry no `providerBound`
      //    and `required: false`, so they never reach the run gate;
      //  · AA is `required: false` too — the model selector degrades
      //    gracefully instead of blocking a fully configured run;
      //  · delete the deepseek entry from the registry and this returns []
      //    instead, so it pins the registry entry and not just the
      //    resolver's ability to find nothing.
      const names = findMissingKeysForBackend('jcode').map((s) => s.name);
      expect(names).toEqual(['deepseek']);
      expect(names).not.toContain('artificialAnalysis');
    });

    it('stub backend: requires nothing', () => {
      expect(findMissingKeysForBackend('stub')).toEqual([]);
    });

    it('jcode backend: stops requiring deepseek once the key resolves', () => {
      process.env.DEEPSEEK_API_KEY = 'sk-jcode-set';
      expect(findMissingKeysForBackend('jcode')).toEqual([]);
    });

    it('jcode backend: the gate goes through the FULL resolver, not just the env var', () => {
      // `findMissingKeysForBackend` calls `resolveApiKey`, so every tier
      // satisfies the gate — here the postgres-style `_FILE` companion.
      const path = join(tmpDir, 'jcode-key.txt');
      writeFileSync(path, 'sk-jcode-from-file\n');
      process.env.DEEPSEEK_API_KEY_FILE = path;
      expect(findMissingKeysForBackend('jcode')).toEqual([]);
    });

    it('jcode backend: the same key also resolves through the saved store', () => {
      saveApiKey(findSpec('deepseek')!, 'sk-jcode-stored');
      expect(findMissingKeysForBackend('jcode')).toEqual([]);
      expect(resolveApiKey(findSpec('deepseek')!)).toBe('sk-jcode-stored');
    });

    it('the openrouter key never gates a DEEPSEEK run', () => {
      // OpenRouter is a first-class provider again, but its spec is bound to
      // the `openrouter` provider — so it stays invisible to a run served by
      // deepseek (which is what the backend-keyed wrapper defaults to), and
      // `required: false` keeps it out of the universal gate too.
      expect(findMissingKeysForBackend('jcode').map((s) => s.name)).not.toContain('openrouter');
      expect(findMissingKeysForProvider('deepseek').map((s) => s.name)).not.toContain('openrouter');
      expect(findMissingRequiredKeys().map((s) => s.name)).not.toContain('openrouter');
    });

    it('stub is keyless: no backend-bound spec ever gates it', () => {
      expect(findMissingKeysForBackend('stub').map((s) => s.name)).not.toContain('deepseek');
    });
  });

  describe('findMissingKeysForProvider (the PRIMARY gate)', () => {
    it('the deepseek provider needs the deepseek key', () => {
      const names = findMissingKeysForProvider('deepseek').map((s) => s.name);
      expect(names).toEqual(['deepseek']);
      expect(names).toEqual(findMissingKeysForBackend('jcode').map((s) => s.name));
    });

    it('the deepseek provider stops asking once the key resolves', () => {
      process.env.DEEPSEEK_API_KEY = 'sk-provider-set';
      expect(findMissingKeysForProvider('deepseek')).toEqual([]);
    });

    it('the openrouter provider blocks on ITS key even though `required: false`', () => {
      // MUTATION KILLED: gating the bound branch on `required`
      // (`if (spec.required && !resolveApiKey(spec))`) — the openrouter spec
      // is the only one in the `bound && required: false` shape, so before it
      // existed this branch had no test that could fail. With the mutation the
      // result is [] and an OpenRouter run launches with NO credential.
      expect(findMissingKeysForProvider('openrouter').map((s) => s.name)).toEqual([
        'openrouter',
      ]);
    });

    it('an openrouter run asks for the openrouter key ONLY — never both', () => {
      // MUTATION KILLED: dropping the `bound !== provider` skip (or binding
      // both specs to the shared `jcode` backend). Either makes this return
      // ['deepseek', 'openrouter'] and blocks a user who legitimately has one
      // key for the provider they picked.
      process.env.OPENROUTER_API_KEY = 'sk-or-live';
      expect(findMissingKeysForProvider('openrouter')).toEqual([]);
      // …and the OTHER provider is still correctly blocked by the same env.
      expect(findMissingKeysForProvider('deepseek').map((s) => s.name)).toEqual([
        'deepseek',
      ]);
    });

    it('a deepseek run is not unblocked by an openrouter key (and vice versa)', () => {
      // The credential axis must be the provider, not "any key present".
      process.env.DEEPSEEK_API_KEY = 'sk-ds-live';
      expect(findMissingKeysForProvider('deepseek')).toEqual([]);
      expect(findMissingKeysForProvider('openrouter').map((s) => s.name)).toEqual([
        'openrouter',
      ]);
    });

    it('WITH NO KEY AT ALL, every provider is refused', () => {
      // The floor of the invariant: relaxing `required`, or loosening the
      // bound branch, must never make a keyless run launchable.
      for (const p of ['deepseek', 'openrouter'] as const) {
        expect(findMissingKeysForProvider(p).length, p).toBeGreaterThan(0);
      }
    });

    it('provider `undefined` (stub: no provider is called) demands nothing', () => {
      // MUTATION KILLED: replacing `providersForBackend(backend).at(0)` with a
      // hardcoded provider — `stub` would then demand that provider's key and
      // `huu --stub` could no longer run keyless.
      expect(findMissingKeysForProvider(undefined)).toEqual([]);
      expect(findMissingKeysForBackend('stub')).toEqual([]);
    });
  });

  describe('specForProvider — the ONLY authority on which key a run spends', () => {
    it('separates the two providers that share the jcode backend', () => {
      // MUTATION KILLED: deriving the spec from the BACKEND again (
      // `selectBackend('jcode').apiKeySpecName`). Both providers dispatch to
      // jcode, so a backend-keyed answer is the SAME for both — this pair of
      // assertions cannot both hold under that mutation.
      expect(specForProvider('deepseek')?.envVar).toBe('DEEPSEEK_API_KEY');
      expect(specForProvider('openrouter')?.envVar).toBe('OPENROUTER_API_KEY');
      expect(specForProvider(undefined)).toBeUndefined();
    });

    it('resolves ONLY the chosen provider key, even when the other one is set', () => {
      // MUTATION KILLED: falling back to any other resolvable credential when
      // the chosen provider's key is missing — the silent substitution that
      // spent DeepSeek money on an OpenRouter run.
      process.env.DEEPSEEK_API_KEY = 'sk-deepseek-only';
      expect(resolveApiKeyForProvider('deepseek')).toBe('sk-deepseek-only');
      expect(resolveApiKeyForProvider('openrouter')).toBe('');
      expect(resolveApiKeyForProvider(undefined)).toBe('');
    });

    it('with ONLY the OpenRouter key, the OpenRouter run is ready and DeepSeek is not', () => {
      // The reviewer's "só OR" row — the state of the machine that BLOCKED.
      process.env.OPENROUTER_API_KEY = 'sk-or-only-this-one';
      expect(findMissingKeysForProvider('openrouter')).toEqual([]);
      expect(resolveApiKeyForProvider('openrouter')).toBe('sk-or-only-this-one');
      expect(findMissingKeysForProvider('deepseek').map((s) => s.envVar)).toEqual([
        'DEEPSEEK_API_KEY',
      ]);
    });
  });

  describe('detectForeignKeySpec — the credential foot-gun', () => {
    // Why this exists: `sk-or-…` SATISFIES the DeepSeek spec's `sk-` prefix, so
    // the soft prefix warning is silent exactly where the damage is worst — the
    // OpenRouter key gets stored under the name `deepseek` and sent to
    // api.deepseek.com. A prefix cannot express "sk- but not sk-or-", so the
    // discrimination has to be cross-spec.
    const deepseek = findSpec('deepseek')!;
    const openrouter = findSpec('openrouter')!;
    const aa = findSpec('artificialAnalysis')!;

    it('refuses an OpenRouter key pasted into the DeepSeek prompt', () => {
      // MUTATION KILLED: dropping the cross-spec check and relying on
      // `validatePrefix` alone — `'sk-or-v1-abc'.startsWith('sk-')` is TRUE, so
      // the prefix check reports nothing at all.
      expect(deepseek.validatePrefix).toBe('sk-');
      expect('sk-or-v1-abc'.startsWith(deepseek.validatePrefix!)).toBe(true);
      expect(detectForeignKeySpec(deepseek, 'sk-or-v1-abc')?.name).toBe('openrouter');
    });

    it('refuses a DeepSeek key pasted into the OpenRouter prompt', () => {
      expect(detectForeignKeySpec(openrouter, 'sk-abc123')?.name).toBe('deepseek');
    });

    it('accepts each provider its OWN key', () => {
      // MUTATION KILLED: making the check "any other prefix that matches",
      // which would claim every `sk-…` for one of the two and lock both out.
      expect(detectForeignKeySpec(deepseek, 'sk-abc123')).toBeUndefined();
      expect(detectForeignKeySpec(openrouter, 'sk-or-v1-abc')).toBeUndefined();
    });

    it('never judges a spec that declares no format, and never judges an unknown shape', () => {
      // MUTATION KILLED: dropping the `if (!target.validatePrefix) return`
      // guard — an Artificial Analysis key that happens to start with `sk-`
      // would be refused as "a DeepSeek key", blocking a valid credential.
      expect(aa.validatePrefix).toBeUndefined();
      expect(detectForeignKeySpec(aa, 'sk-whatever')).toBeUndefined();
      // A shape nothing claims stays a SOFT warning's business, not a block.
      expect(detectForeignKeySpec(deepseek, 'totally-new-format')).toBeUndefined();
      expect(detectForeignKeySpec(deepseek, '   ')).toBeUndefined();
    });

    it('catches a research key in a provider prompt too', () => {
      expect(detectForeignKeySpec(deepseek, 'tvly-abc')?.name).toBe('tavily');
    });
  });

  describe('resolveDeepSeekApiKey', () => {
    // The `resolveOpenRouterApiKey` alias that used to sit beside it (a
    // misleading name pointing at the DeepSeek credential, zero callers) was
    // DELETED when OpenRouter became a real provider again: the name now
    // belongs to a real key, and an alias resolving the other provider's
    // credential would be a live foot-gun rather than dead weight.
    it('resolves the DEEPSEEK key and ignores OPENROUTER_API_KEY', () => {
      process.env.DEEPSEEK_API_KEY = 'sk-deepseek-direct';
      process.env.OPENROUTER_API_KEY = 'sk-or-other';
      expect(resolveDeepSeekApiKey()).toBe('sk-deepseek-direct');
      expect(resolveApiKey(findSpec('openrouter')!)).toBe('sk-or-other');
    });

    it('is empty when the deepseek key is unset, whatever openrouter holds', () => {
      process.env.OPENROUTER_API_KEY = 'sk-or-other';
      expect(resolveDeepSeekApiKey()).toBe('');
    });
  });

  describe('HUU_CONFIG_DIR override (docker-mounted host store)', () => {
    it('configFilePath prefers HUU_CONFIG_DIR over XDG_CONFIG_HOME', () => {
      process.env.HUU_CONFIG_DIR = join(tmpDir, 'hostcfg');
      expect(configFilePath()).toBe(join(tmpDir, 'hostcfg', 'config.json'));
      delete process.env.HUU_CONFIG_DIR;
      expect(configFilePath()).toBe(join(configHome, 'huu', 'config.json'));
    });

    it('save + load + resolve go through the HUU_CONFIG_DIR store', () => {
      process.env.HUU_CONFIG_DIR = join(tmpDir, 'hostcfg');
      const spec = findSpec('deepseek')!;
      saveApiKey(spec, 'sk-host');
      expect(loadStoredApiKey(spec)).toBe('sk-host');
      expect(resolveApiKeyWithSource(spec)).toMatchObject({
        value: 'sk-host',
        source: 'stored',
      });
      expect(
        JSON.parse(readFileSync(join(tmpDir, 'hostcfg', 'config.json'), 'utf8')),
      ).toMatchObject({ deepseek: 'sk-host' });
    });
  });

  describe('clearStoredApiKey', () => {
    it('removes the entry so resolution falls back to the env var', () => {
      const spec = findSpec('deepseek')!;
      saveApiKey(spec, 'sk-stale');
      process.env.DEEPSEEK_API_KEY = 'sk-fresh';
      expect(resolveApiKeyWithSource(spec).source).toBe('stored');

      expect(clearStoredApiKey(spec)).toBe(true);
      const after = resolveApiKeyWithSource(spec);
      expect(after.source).toBe('env');
      expect(after.value).toBe('sk-fresh');
    });

    it('keeps OTHER specs untouched and returns false when nothing was stored', () => {
      // Two SURVIVING specs — the azure pair this used to exercise went away
      // with the azure backend, but the per-spec isolation it pinned is live.
      const ds = findSpec('deepseek')!;
      const aa = findSpec('artificialAnalysis')!;
      saveApiKey(ds, 'sk-keep');
      saveApiKey(aa, 'aa-keep');
      expect(clearStoredApiKey(aa)).toBe(true);
      expect(loadStoredApiKey(ds)).toBe('sk-keep');
      expect(loadStoredApiKey(aa)).toBe('');
      expect(clearStoredApiKey(aa)).toBe(false); // already gone
    });
  });

  describe('maskKey', () => {
    it('shows a prefix + the last 4 chars, never the middle', () => {
      const m = maskKey('sk-or-v1-abcdefghijklmnop');
      expect(m).toBe('sk-or-…mnop');
      expect(m).not.toContain('abcdefghijkl');
    });

    it('degrades for short/empty values', () => {
      expect(maskKey('')).toBe('(none)');
      expect(maskKey('   ')).toBe('(none)');
      expect(maskKey('short')).toBe('••••');
    });
  });
});

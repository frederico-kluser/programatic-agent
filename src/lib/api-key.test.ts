import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  API_KEY_REGISTRY,
  CORRUPT_BACKUP_INFIX,
  MAX_CORRUPT_BACKUPS,
  clearStoredApiKey,
  configFilePath,
  readConfigStore,
  writeConfigStore,
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

  // ─────────────────────────────────────────────────────────────────────────
  // The credential-destruction guard.
  //
  // `readConfigStore()` answers `{}` for a file it cannot parse, so the NEXT
  // write of any module — `saveApiKey`, the key pool, the setup record — used
  // to serialize that emptiness over the user's keys. A truncated config still
  // holds the key AS TEXT and is recoverable by hand, but only while the bytes
  // are still on disk. These tests pin the copy, its permissions, its bound,
  // and the fact that a failed copy never blocks the real write.
  // ─────────────────────────────────────────────────────────────────────────
  describe('a config.json that cannot be parsed is preserved before it is replaced', () => {
    /** Truncated mid-object: invalid JSON, and the key is still plainly there. */
    const BROKEN = '{\n  "deepseek": "sk-ds-OLD-STILL-READABLE",\n  "_pools": { "deep';

    const writeRawConfig = (contents: string, mode = 0o600): void => {
      const path = configFilePath();
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, contents, { mode });
    };

    const backups = (): string[] => {
      const dir = dirname(configFilePath());
      try {
        return readdirSync(dir)
          .filter((n) => n.includes(CORRUPT_BACKUP_INFIX))
          .sort()
          .map((n) => join(dir, n));
      } catch {
        return [];
      }
    };

    /** The name `preserveCorruptConfig` builds — deterministic, hence predictable. */
    const backupPathFor = (when: Date): string =>
      `${configFilePath()}${CORRUPT_BACKUP_INFIX}${when.toISOString().replace(/[:.]/g, '-')}-${process.pid}`;

    let warnings: string[];
    beforeEach(() => {
      warnings = [];
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        warnings.push(args.map(String).join(' '));
      });
    });
    afterEach(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    it('keeps the old key recoverable by hand after the write that replaced it', () => {
      writeRawConfig(BROKEN);

      saveApiKey(findSpec('deepseek')!, 'sk-ds-NEW');

      // The new write landed, and the store is clean again.
      expect(loadStoredApiKey(findSpec('deepseek')!)).toBe('sk-ds-NEW');
      expect(readConfigStore()).toEqual({ deepseek: 'sk-ds-NEW' });

      // …and the bytes that held the OLD key are still on disk, verbatim.
      const kept = backups();
      expect(kept).toHaveLength(1);
      expect(readFileSync(kept[0]!, 'utf8')).toBe(BROKEN);
      expect(readFileSync(kept[0]!, 'utf8')).toContain('sk-ds-OLD-STILL-READABLE');
    });

    it('tells the user on stderr, naming both the file and the copy', () => {
      writeRawConfig(BROKEN);

      saveApiKey(findSpec('deepseek')!, 'sk-ds-NEW');

      const said = warnings.join('\n');
      expect(said).toContain(configFilePath());
      expect(said).toContain(backups()[0]!);
    });

    it('gives the copy mode 0600 even when the broken file was world-readable', () => {
      writeRawConfig(BROKEN, 0o644);

      saveApiKey(findSpec('deepseek')!, 'sk-ds-NEW');

      expect((statSync(backups()[0]!).mode & 0o777).toString(8)).toBe('600');
      // And the replacement is tightened too — a 0644 config does not survive.
      expect((statSync(configFilePath()).mode & 0o777).toString(8)).toBe('600');
    });

    it('preserves valid JSON that is not an object — readConfigStore discards it just the same', () => {
      writeRawConfig('[1, 2, 3]');

      saveApiKey(findSpec('deepseek')!, 'sk-ds-NEW');

      expect(readFileSync(backups()[0]!, 'utf8')).toBe('[1, 2, 3]');
    });

    it('preserves the bytes verbatim, not a re-encoded string', () => {
      // Half UTF-8, half binary: the ASCII key text must survive byte for byte,
      // so a copy that round-tripped through a JS string would fail here.
      const bytes = Buffer.concat([
        Buffer.from('{ "deepseek": "sk-ds-BINARY-NEIGHBOUR", '),
        Buffer.from([0xff, 0xfe, 0x00, 0x80]),
      ]);
      mkdirSync(dirname(configFilePath()), { recursive: true, mode: 0o700 });
      writeFileSync(configFilePath(), bytes, { mode: 0o600 });

      saveApiKey(findSpec('deepseek')!, 'sk-ds-NEW');

      expect(readFileSync(backups()[0]!).equals(bytes)).toBe(true);
    });

    it('copies nothing when the config is healthy (no litter on the happy path)', () => {
      saveApiKey(findSpec('deepseek')!, 'sk-ds-one');
      saveApiKey(findSpec('openrouter')!, 'sk-or-two');
      clearStoredApiKey(findSpec('openrouter')!);

      expect(backups()).toEqual([]);
      expect(readdirSync(dirname(configFilePath()))).toEqual(['config.json']);
    });

    it('copies nothing for an empty file — there is nothing in it to recover', () => {
      writeRawConfig('   \n');

      saveApiKey(findSpec('deepseek')!, 'sk-ds-NEW');

      expect(backups()).toEqual([]);
      expect(loadStoredApiKey(findSpec('deepseek')!)).toBe('sk-ds-NEW');
    });

    it(`never keeps more than ${MAX_CORRUPT_BACKUPS} copies, however often the file comes back broken`, () => {
      // The pile this bounds is a pile of CREDENTIAL files, and a boot-path
      // write is what creates it — so "corrupt again on every run" must not
      // grow without limit. Time is faked so the six copies get six distinct
      // (and chronologically sorted) names inside one millisecond of real time.
      vi.useFakeTimers({ toFake: ['Date'] });
      const start = Date.parse('2026-09-05T12:00:00.000Z');
      for (let i = 0; i < 6; i++) {
        vi.setSystemTime(new Date(start + i * 1000));
        writeRawConfig(`{ "deepseek": "sk-ds-GEN-${i}", broken`);
        saveApiKey(findSpec('deepseek')!, `sk-ds-NEW-${i}`);
      }

      const kept = backups();
      expect(kept).toHaveLength(MAX_CORRUPT_BACKUPS);
      // The ones kept are the NEWEST — the generation whose key the user most
      // likely still uses.
      expect(readFileSync(kept[kept.length - 1]!, 'utf8')).toContain('sk-ds-GEN-5');
      expect(readFileSync(kept[0]!, 'utf8')).toContain('sk-ds-GEN-3');
    });

    it('does not mint a second copy of a file it already preserved byte for byte', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-05T12:00:00.000Z'));
      writeRawConfig(BROKEN);
      saveApiKey(findSpec('deepseek')!, 'sk-ds-ONE');

      vi.setSystemTime(new Date('2026-09-05T13:00:00.000Z'));
      writeRawConfig(BROKEN); // the same breakage, again
      saveApiKey(findSpec('deepseek')!, 'sk-ds-TWO');

      expect(backups()).toHaveLength(1);
    });

    it('still writes the config when the copy itself fails, and says the old bytes are gone', () => {
      // THE DECISION, pinned: losing the broken file is bad, refusing to save a
      // credential (or to finish the boot-time setup) is worse. A directory
      // squatting on the copy's path is the portable stand-in for "the copy
      // cannot be created".
      vi.useFakeTimers({ toFake: ['Date'] });
      const when = new Date('2026-09-05T12:00:00.000Z');
      vi.setSystemTime(when);
      writeRawConfig(BROKEN);
      mkdirSync(backupPathFor(when), { recursive: true });

      expect(() => saveApiKey(findSpec('deepseek')!, 'sk-ds-NEW')).not.toThrow();

      expect(loadStoredApiKey(findSpec('deepseek')!)).toBe('sk-ds-NEW');
      const said = warnings.join('\n');
      expect(said).toContain(configFilePath());
      expect(said).toMatch(/could not save a copy/i);
    });

    it('refuses to replace a config it cannot even read, instead of renaming over it', () => {
      // `rename` needs only the DIRECTORY to be writable, so without the guard
      // an unreadable (mode 000) credential file would be destroyed by a write
      // that could never have read it. Root ignores the mode bits, so the
      // assertion only means anything as a normal user.
      writeRawConfig(BROKEN, 0o000);
      if (process.getuid?.() === 0) return;

      expect(() => saveApiKey(findSpec('deepseek')!, 'sk-ds-NEW')).toThrow();
      expect(statSync(configFilePath()).size).toBe(BROKEN.length);
    });
  });

  describe('writeConfigStore is atomic (the credential file is never left truncated)', () => {
    it('swaps in a new inode instead of truncating the file already there', () => {
      // Observable consequence of `rename`, no timing and no crash simulation:
      // a truncating write reuses the inode, a rename replaces it.
      saveApiKey(findSpec('deepseek')!, 'sk-ds-first');
      const first = statSync(configFilePath()).ino;

      saveApiKey(findSpec('deepseek')!, 'sk-ds-second');

      expect(statSync(configFilePath()).ino).not.toBe(first);
      expect(loadStoredApiKey(findSpec('deepseek')!)).toBe('sk-ds-second');
    });

    it('never shows a concurrent reader a half-written config', () => {
      // The reader that opened the file BEFORE the write — a backup tool, the
      // user's `cat`, a second huu — keeps reading the COMPLETE previous
      // version through its descriptor.
      writeConfigStore({ deepseek: 'sk-ds-before', filler: 'x'.repeat(4096) });
      const before = readFileSync(configFilePath(), 'utf8');
      const reader = openSync(configFilePath(), 'r');
      try {
        writeConfigStore({ deepseek: 'sk-ds-after' });
        const buf = Buffer.alloc(before.length * 4);
        const read = readSync(reader, buf, 0, buf.length, 0);
        expect(buf.subarray(0, read).toString('utf8')).toBe(before);
      } finally {
        closeSync(reader);
      }
      expect(loadStoredApiKey(findSpec('deepseek')!)).toBe('sk-ds-after');
    });

    it('keeps mode 0600 through the rename, even under umask 000', () => {
      // The cost of the new inode: `rename` installs a file created with
      // `mode & ~umask`, so the bits of the file it replaced are gone. Under
      // umask 000 a forgotten chmod shows up as 0666 on a file full of keys.
      const previousUmask = process.umask(0o000);
      try {
        saveApiKey(findSpec('deepseek')!, 'sk-ds-first');
        expect((statSync(configFilePath()).mode & 0o777).toString(8)).toBe('600');
        expect((statSync(dirname(configFilePath())).mode & 0o777).toString(8)).toBe('700');

        saveApiKey(findSpec('deepseek')!, 'sk-ds-second'); // the REPLACE path
        expect((statSync(configFilePath()).mode & 0o777).toString(8)).toBe('600');
      } finally {
        process.umask(previousUmask);
      }
    });

    it('reaches 0600 even under a umask that strips the write bit off the staging file', () => {
      // The other half of the mode claim, and the only case where the chmod
      // AFTER the rename is what does the work: `open(2)` applies `mode & ~umask`
      // to the staging file too, so under umask 0277 the file the rename
      // installs is 0400 — readable, but the user could no longer edit it and
      // some tools would call the store read-only.
      // The directory is created first: `mkdirSync(…, { mode: 0o700 })` is
      // subject to the same umask, and a 0500 config dir would fail the write
      // for an unrelated reason.
      mkdirSync(dirname(configFilePath()), { recursive: true, mode: 0o700 });
      const previousUmask = process.umask(0o277);
      try {
        saveApiKey(findSpec('deepseek')!, 'sk-ds-first');
        expect((statSync(configFilePath()).mode & 0o777).toString(8)).toBe('600');
      } finally {
        process.umask(previousUmask);
      }
    });

    it('gives the corrupt-config copy 0600 under umask 000 too', () => {
      const previousUmask = process.umask(0o000);
      try {
        mkdirSync(dirname(configFilePath()), { recursive: true, mode: 0o700 });
        writeFileSync(configFilePath(), '{ "deepseek": "sk-ds-OLD", broken', { mode: 0o600 });
        const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
          saveApiKey(findSpec('deepseek')!, 'sk-ds-NEW');
        } finally {
          quiet.mockRestore();
        }
        const copy = readdirSync(dirname(configFilePath())).find((n) =>
          n.includes(CORRUPT_BACKUP_INFIX),
        )!;
        expect((statSync(join(dirname(configFilePath()), copy)).mode & 0o777).toString(8)).toBe(
          '600',
        );
      } finally {
        process.umask(previousUmask);
      }
    });

    it('leaves no staging file behind on the happy path', () => {
      saveApiKey(findSpec('deepseek')!, 'sk-ds-first');
      saveApiKey(findSpec('openrouter')!, 'sk-or-second');
      clearStoredApiKey(findSpec('deepseek')!);

      expect(readdirSync(dirname(configFilePath()))).toEqual(['config.json']);
    });

    it('sweeps the staging file when the write fails, and still reports the failure', () => {
      // A DIRECTORY where config.json belongs: `rename` cannot replace it.
      // Without the cleanup branch this leaves a `*.huu.tmp` nobody lists and
      // nobody deletes — in a directory that is supposed to hold one file.
      mkdirSync(configFilePath(), { recursive: true });

      expect(() => writeConfigStore({ deepseek: 'sk-ds-NEW' })).toThrow();

      expect(
        readdirSync(dirname(configFilePath())).filter((n) => n.includes('.huu.tmp')),
      ).toEqual([]);
    });

    it('writes THROUGH a symlink instead of replacing it', () => {
      // `writeFileSync` follows a symlink; `rename` does not. A user who keeps
      // config.json in a dotfiles repo must not find their link silently
      // swapped for a regular file the next time huu saves a key.
      const real = join(tmpDir, 'dotfiles', 'huu.json');
      mkdirSync(dirname(real), { recursive: true });
      writeFileSync(real, '{}', { mode: 0o600 });
      mkdirSync(dirname(configFilePath()), { recursive: true, mode: 0o700 });
      symlinkSync(real, configFilePath());

      saveApiKey(findSpec('deepseek')!, 'sk-ds-through');

      expect(JSON.parse(readFileSync(real, 'utf8'))).toEqual({ deepseek: 'sk-ds-through' });
      expect(readdirSync(dirname(configFilePath()))).toEqual(['config.json']);
      expect(readdirSync(dirname(real)).sort()).toEqual(['huu.json']);
    });
  });
});

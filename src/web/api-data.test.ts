import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { API_KEY_REGISTRY, findSpec } from '../lib/api-key.js';
import { hasKeyProbe } from '../lib/key-validation.js';
import {
  keyStatus,
  listBackendsInfo,
  listDirs,
  listModelsForBackend,
  listProvidersInfo,
  validateKeyValue,
} from './api-data.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listBackendsInfo', () => {
  it('exposes NO apiKeySpecName for jcode — the provider names the credential', () => {
    // MUTATION KILLED: re-introducing a backend-keyed spec name here. The
    // browser used to read it (`backendSpecName`) to decide which session key
    // to send with a run; with jcode serving two providers that answer was
    // wrong half the time, so the projection now stays empty and the client
    // reads `/api/providers` → `keySpecs` instead.
    const backends = listBackendsInfo();
    expect(backends.find((b) => b.id === 'jcode')?.apiKeySpecName).toBeUndefined();
    // stub needs no key — no spec to look up.
    expect(backends.find((b) => b.id === 'stub')?.apiKeySpecName).toBeUndefined();
  });
});

describe('listModelsForBackend', () => {
  // The live OpenRouter catalog went away with the `pi` backend (v3.0):
  // DeepSeek exposes no public /models endpoint, so the web picker is served
  // the SAME static catalog the TUI uses (`recommended-models.json`, or the
  // in-code fallback) and never touches the network.

  it('serves the static recommended catalog, with or without a key, and never fetches', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    for (const key of ['', 'sk-whatever']) {
      const r = await listModelsForBackend(process.cwd(), 'jcode', key);
      expect(r.source).toBe('recommended');
      // A key-less user must still get a pickable list, never an empty picker.
      expect(r.models.length).toBeGreaterThan(0);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('projects the catalog entry and annotates thinking capability', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'huu-api-data-models-'));
    try {
      writeFileSync(
        join(dir, 'recommended-models.json'),
        JSON.stringify({
          models: [
            {
              id: 'deepseek/deepseek-v4-flash',
              label: 'Flash',
              inputPrice: 0.14,
              outputPrice: 0.28,
              description: 'default',
              bestFor: ['fast'],
              tier: 'fast',
            },
            { id: 'moonshotai/kimi-k2.6', label: 'Kimi' },
          ],
        }),
        'utf-8',
      );
      const r = await listModelsForBackend(dir, 'jcode', '');
      const byId = Object.fromEntries(r.models.map((m) => [m.id, m]));
      const flash = byId['deepseek/deepseek-v4-flash'];
      expect(flash.label).toBe('Flash');
      expect(flash.inputPrice).toBe(0.14);
      expect(flash.outputPrice).toBe(0.28);
      expect(flash.description).toBe('default');
      expect(flash.bestFor).toEqual(['fast']);
      expect(flash.tier).toBe('fast');
      // `thinking` comes from the local model registry (supportsThinking),
      // not from a provider response — v4 reasons, kimi doesn't.
      expect(flash.thinking).toBe(true);
      expect(byId['moonshotai/kimi-k2.6'].thinking).toBe(false);
      // `tools`/`contextLength` were live-catalog-only annotations: the static
      // catalog knows neither, so the picker must not badge either way.
      expect(flash.tools).toBeUndefined();
      expect(flash.contextLength).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('validateKeyValue', () => {
  const deepseek = () => findSpec('deepseek')!;

  it('returns unverifiable for an empty value without hitting the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const r = await validateKeyValue(deepseek(), '   ');
    expect(r).toEqual({ status: 'unverifiable', reason: 'empty value' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // THIS TEST REPLACES "returns unverifiable for every registered spec — no
  // provider has a cheap probe", and the old one was right to be deleted: it
  // pinned a LIMITATION, not a contract. It asserted `expect(fetchMock).not
  // .toHaveBeenCalled()` for the WHOLE registry, which is precisely the
  // behavior the probes in `lib/key-validation.ts` remove — and it left the
  // `valid` / `invalid` arms of `KeyValidation` declared but unreachable, so
  // the branches handling them in settings.js and launch.js were dead code.
  // Its own comment said as much: "When a real probe lands, THIS is the test
  // to split back apart". This is that split; the provider-shaped detail lives
  // in `lib/key-validation.test.ts`, and what stays here is the DELEGATION.
  it('delegates to the provider probe — a 401 is refused, a 5xx only warns', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await validateKeyValue(findSpec('deepseek')!, 'sk-rejected')).toEqual({
      status: 'invalid',
      httpStatus: 401,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })),
    );
    // Not `invalid`: a broken provider is not proof of a broken key, and
    // `invalid` is the branch that hard-blocks the user.
    expect(await validateKeyValue(findSpec('deepseek')!, 'sk-rejected')).toMatchObject({
      status: 'unverifiable',
    });
  });

  it('still answers unverifiable, with no fetch, for the specs that have no probe', async () => {
    // Iterate the REGISTRY, not a hand-written list: a fixed list silently
    // stops covering whatever spec is appended next. The three keys the setup
    // flow asks for (deepseek, openrouter, brave) now have real probes and are
    // covered in lib/key-validation.test.ts; what is left here is everything
    // that genuinely cannot be checked.
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const probeless = API_KEY_REGISTRY.filter((s) => !hasKeyProbe(s));
    // Guard against a vacuous loop: an empty/gutted registry must not make
    // this test pass by iterating nothing.
    expect(probeless.map((s) => s.name)).toEqual(
      expect.arrayContaining(['artificialAnalysis', 'tavily', 'parallel']),
    );
    for (const spec of probeless) {
      // A value SHAPED LIKE THIS SPEC's own key: the cross-spec guard must not
      // fire, so what is left is the "no probe" answer this test is about.
      const own = `${spec.validatePrefix ?? ''}whatever`;
      expect(await validateKeyValue(spec, own), `spec ${spec.name}`).toEqual({
        status: 'unverifiable',
        reason: 'no validator for this key',
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('listDirs', () => {
  it('lists sub-directories, follows directory symlinks, and excludes files, file-symlinks and dotfolders', () => {
    // Real filesystem (the repo convention — no fs mocks). The web folder picker
    // marks project FOLDERS, so a symlinked file (e.g. CLAUDE.md -> AGENTS.md)
    // must not appear as a navigable/markable entry.
    const root = mkdtempSync(join(tmpdir(), 'huu-folders-'));
    mkdirSync(join(root, 'alpha'));
    mkdirSync(join(root, 'beta'));
    mkdirSync(join(root, '.hidden'));                                 // dotfolder → excluded
    writeFileSync(join(root, 'file.txt'), 'x');                       // plain file → excluded
    symlinkSync(join(root, 'alpha'), join(root, 'link-dir'));         // → dir → included
    symlinkSync(join(root, 'file.txt'), join(root, 'link-file'));     // → file → excluded
    symlinkSync(join(root, 'does-not-exist'), join(root, 'broken'));  // broken → excluded

    const d = listDirs(root);
    expect(d.path).toBe(root);
    expect(d.entries.map((e) => e.name)).toEqual(['alpha', 'beta', 'link-dir']);
    expect(d.entries.every((e) => e.path === join(root, e.name))).toBe(true);
    expect(d.isGitRepo).toBe(false);
    expect(d.parent).toBeTruthy();   // has a parent (not at filesystem root)
  });

  it('flags a directory as a git repo when it holds a .git entry', () => {
    const root = mkdtempSync(join(tmpdir(), 'huu-folders-'));
    mkdirSync(join(root, '.git'));
    expect(listDirs(root).isGitRepo).toBe(true);
  });

  it('falls back to the process cwd for a non-existent path', () => {
    expect(listDirs(join(tmpdir(), 'huu-nope-' + 'zzz', 'missing')).path).toBe(process.cwd());
  });
});

/**
 * The browser's half of the BLOCK. `GET /api/keys` gates the Run button and
 * `GET /api/providers` paints the provider segment; both used to answer for
 * jcode's FIRST provider, so an OpenRouter user with a valid OpenRouter key was
 * told `deepseek` was missing and could not launch.
 */
describe('keyStatus / listProvidersInfo — provider-keyed, not backend-keyed', () => {
  const TRACKED = [
    'DEEPSEEK_API_KEY',
    'DEEPSEEK_API_KEY_FILE',
    'OPENROUTER_API_KEY',
    'OPENROUTER_API_KEY_FILE',
    'XDG_CONFIG_HOME',
    'HUU_CONFIG_DIR',
  ] as const;
  const saved: Record<string, string | undefined> = {};
  let cfg: string;

  beforeEach(() => {
    for (const k of TRACKED) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    cfg = mkdtempSync(join(tmpdir(), 'huu-keystatus-'));
    process.env.XDG_CONFIG_HOME = cfg;
  });
  afterEach(() => {
    for (const k of TRACKED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(cfg, { recursive: true, force: true });
  });

  it('with ONLY the OpenRouter key, an OpenRouter run is ready and asks for nothing', () => {
    // MUTATION KILLED: dropping the `provider` argument (or ignoring it) so
    // this resolves the backend's first provider — the exact regression, which
    // reports `deepseek` missing on a machine that only has an OpenRouter key.
    process.env.OPENROUTER_API_KEY = 'sk-or-only-this-one';
    expect(keyStatus('jcode', 'openrouter')).toEqual({ ok: true, missing: [] });
    expect(keyStatus('jcode', 'deepseek').missing.map((m) => m.name)).toEqual(['deepseek']);
    const provs = listProvidersInfo();
    expect(provs.find((p) => p.id === 'openrouter')?.hasKey).toBe(true);
    expect(provs.find((p) => p.id === 'deepseek')?.hasKey).toBe(false);
  });

  it('with ONLY the DeepSeek key, an OpenRouter run is NOT ready', () => {
    // The other half of the invariant: readiness must not be inherited from
    // the sibling provider, or the launch form green-lights a run the server
    // will refuse (or, worse, silently reroute).
    process.env.DEEPSEEK_API_KEY = 'sk-deepseek-only';
    expect(keyStatus('jcode', 'deepseek')).toEqual({ ok: true, missing: [] });
    const or = keyStatus('jcode', 'openrouter');
    expect(or.ok).toBe(false);
    expect(or.missing.map((m) => m.name)).toEqual(['openrouter']);
  });

  it('stub stays keyless whatever provider is passed', () => {
    expect(keyStatus('stub')).toEqual({ ok: true, missing: [] });
    expect(keyStatus('stub', 'openrouter')).toEqual({ ok: true, missing: [] });
  });
});

describe('validateKeyValue — the wrong-provider key is refused before it is saved', () => {
  it('rejects an sk-or- value offered as the DeepSeek key', async () => {
    // MUTATION KILLED: letting `validateKeyValue` return `unverifiable` for a
    // cross-spec match. `unverifiable` is the ACCEPT-WITH-WARNING branch in
    // both clients, so the OpenRouter key would be persisted under the name
    // `deepseek` and shipped to api.deepseek.com — silently, because
    // `sk-or-…` also satisfies the `sk-` prefix hint.
    const deepseek = findSpec('deepseek')!;
    expect(await validateKeyValue(deepseek, 'sk-or-v1-abcdef')).toEqual({
      status: 'wrong-key',
      belongsTo: 'openrouter',
      label: 'OpenRouter',
    });
  });

  it('rejects a plain sk- value offered as the OpenRouter key', async () => {
    const openrouter = findSpec('openrouter')!;
    expect(await validateKeyValue(openrouter, 'sk-abcdef')).toMatchObject({
      status: 'wrong-key',
      belongsTo: 'deepseek',
    });
  });

  it('rejects an sk-or- value offered as the BRAVE key, without probing Brave', async () => {
    // The web boundary of the leak: all three key endpoints in `server.ts`
    // (`/api/keys/validate`, `/api/keys/pool`, `/api/keys/pool/validate`) come
    // through this function, and `brave` is the one non-LLM spec that owns a
    // probe. While `brave` declared no `validatePrefix` the cross-spec guard
    // could not judge it at all, so an OpenRouter secret pasted here was sent
    // to api.search.brave.com in an `X-Subscription-Token` header before
    // anyone could object.
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await validateKeyValue(findSpec('brave')!, 'sk-or-v1-abcdef')).toEqual({
      status: 'wrong-key',
      belongsTo: 'openrouter',
      label: 'OpenRouter',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still accepts each provider its own key shape — and only then probes it', async () => {
    // The cross-spec guard must not fire on a value that IS this spec's key.
    // Previously both of these answered `unverifiable` because no probe
    // existed; now they reach the provider, so what this pins is that the
    // guard stayed out of the way and the probe took over.
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await validateKeyValue(findSpec('deepseek')!, 'sk-abcdef')).toEqual({
      status: 'valid',
    });
    expect(await validateKeyValue(findSpec('openrouter')!, 'sk-or-v1-abcdef')).toEqual({
      status: 'valid',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('listModelsForBackend — filtered by the PROVIDER the browser picked', () => {
  it('offers only the chosen provider\'s models, not everything jcode could dispatch', async () => {
    // MUTATION KILLED: dropping the `provider` argument. `jcode` serves both
    // providers, so a backend-only filter leaves Claude entries in a DeepSeek
    // picker — a model the run cannot serve, one click away.
    const dir = mkdtempSync(join(tmpdir(), 'huu-models-'));
    try {
      writeFileSync(
        join(dir, 'recommended-models.json'),
        JSON.stringify({
          models: [
            { id: 'deepseek/deepseek-v4-flash', label: 'DS', provider: 'deepseek' },
            { id: 'anthropic/claude-sonnet-4', label: 'Claude', provider: 'openrouter' },
          ],
        }),
      );
      const ds = await listModelsForBackend(dir, 'jcode', '', 'deepseek');
      expect(ds.models.map((m) => m.id)).toEqual(['deepseek/deepseek-v4-flash']);
      const or = await listModelsForBackend(dir, 'jcode', '', 'openrouter');
      expect(or.models.map((m) => m.id)).toEqual(['anthropic/claude-sonnet-4']);
      // No provider named → the backend's default, still a single provider's list.
      const fallback = await listModelsForBackend(dir, 'jcode', '');
      expect(fallback.models.map((m) => m.id)).toEqual(['deepseek/deepseek-v4-flash']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { API_KEY_REGISTRY, findSpec } from '../lib/api-key.js';
import { listBackendsInfo, listDirs, listModelsForBackend, validateKeyValue } from './api-data.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listBackendsInfo', () => {
  it('exposes apiKeySpecName so the browser can look up its session key', () => {
    const backends = listBackendsInfo();
    expect(backends.find((b) => b.id === 'jcode')?.apiKeySpecName).toBe('deepseek');
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

  it('returns unverifiable for every registered spec — no provider has a cheap probe', async () => {
    // The OpenRouter (200 → valid / 401 → invalid) and Azure (endpoint first)
    // reachability probes went away with the pi/azure backends in v3.0, and
    // DeepSeek exposes no cheap check. A pasted key is therefore accepted with
    // a warning rather than hard-blocking an offline/VPN user.
    // When a real probe lands, THIS is the test to split back apart: a key the
    // provider actively rejects (401) must come back `invalid` and never be
    // accepted, while a network failure must stay `unverifiable`.
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    // Iterate the REGISTRY, not a hand-written list: a fixed list silently
    // stops covering whatever spec is appended next (and a spec that grew a
    // real validator would slip through unnoticed).
    const names = API_KEY_REGISTRY.map((s) => s.name);
    // Guard against a vacuous loop: an empty/gutted registry must not make
    // this test pass by iterating nothing. The named specs must EXIST.
    expect(names).toEqual(
      expect.arrayContaining(['deepseek', 'openrouter', 'artificialAnalysis']),
    );
    for (const spec of API_KEY_REGISTRY) {
      expect(await validateKeyValue(spec, 'sk-whatever'), `spec ${spec.name}`).toEqual({
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

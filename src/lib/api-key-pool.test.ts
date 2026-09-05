import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configFilePath, findSpec, saveApiKey } from './api-key.js';
import {
  addPoolKey,
  blankPool,
  cooldownActive,
  createKeyPoolHandle,
  createKeyPoolHandleByName,
  loadKeyPool,
  markBurned,
  nextUsableKeyIndex,
  normalizePool,
  POOL_STORE_FIELD,
  removePoolKey,
  saveKeyPool,
  setCooldown,
  type KeyPoolState,
} from './api-key-pool.js';

describe('api-key-pool', () => {
  // Every test writes through a throwaway HUU_CONFIG_DIR so the user's real
  // ~/.config/huu/config.json is never touched.
  const TRACKED_ENV = [
    'HUU_CONFIG_DIR',
    'XDG_CONFIG_HOME',
    'HUU_KEY_COOLDOWN_MS',
    'HUU_KEY_QUOTA_COOLDOWN_MS',
    'OPENROUTER_API_KEY',
    'OPENROUTER_API_KEY_FILE',
  ] as const;
  const saved: Record<string, string | undefined> = {};
  let tmpDir: string;
  const spec = findSpec('openrouter')!;

  const readRawStore = (): Record<string, unknown> =>
    JSON.parse(readFileSync(configFilePath(), 'utf8'));

  beforeEach(() => {
    for (const k of TRACKED_ENV) saved[k] = process.env[k];
    for (const k of TRACKED_ENV) delete process.env[k];
    tmpDir = mkdtempSync(join(tmpdir(), 'huu-key-pool-test-'));
    process.env.HUU_CONFIG_DIR = join(tmpDir, 'cfg');
  });

  afterEach(() => {
    for (const k of TRACKED_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('store schema (additive + mirrored)', () => {
    it('reads a LEGACY single-key config as a pool of one (zero migration)', () => {
      saveApiKey(spec, 'sk-or-LEGACY');
      const pool = loadKeyPool(spec);
      expect(pool.keys).toEqual(['sk-or-LEGACY']);
      expect(pool.current).toBe(0);
      expect(pool.burned).toEqual([]);
      // The store on disk is still the plain field — nothing was rewritten.
      expect(readRawStore()).not.toHaveProperty(POOL_STORE_FIELD);
    });

    it('returns an empty pool when nothing is stored', () => {
      expect(loadKeyPool(spec)).toEqual(blankPool());
    });

    it('addPoolKey MIRRORS keys[0] into the flat field (the whole compat contract)', () => {
      addPoolKey(spec, 'sk-or-A');
      addPoolKey(spec, 'sk-or-B');

      const store = readRawStore();
      // An OLDER huu (or an older image sharing HUU_CONFIG_DIR) knows nothing
      // about _pools — it must still find a usable key in the flat field.
      expect(store.openrouter).toBe('sk-or-A');
      expect((store[POOL_STORE_FIELD] as Record<string, KeyPoolState>).openrouter.keys).toEqual([
        'sk-or-A',
        'sk-or-B',
      ]);
      expect(loadKeyPool(spec).keys).toEqual(['sk-or-A', 'sk-or-B']);
    });

    it('the pool wins over the flat field once it has keys', () => {
      saveApiKey(spec, 'sk-or-FLAT');
      addPoolKey(spec, 'sk-or-POOL-1');
      // addPoolKey read the flat key as a pool of one, then appended.
      expect(loadKeyPool(spec).keys).toEqual(['sk-or-FLAT', 'sk-or-POOL-1']);
      expect(readRawStore().openrouter).toBe('sk-or-FLAT');
    });

    it('addPoolKey ignores empty values and duplicates', () => {
      addPoolKey(spec, 'sk-or-A');
      addPoolKey(spec, '   ');
      addPoolKey(spec, 'sk-or-A');
      expect(loadKeyPool(spec).keys).toEqual(['sk-or-A']);
    });

    it('emptying the pool clears the mirror too (a removed key must not resurrect)', () => {
      addPoolKey(spec, 'sk-or-ONLY');
      removePoolKey(spec, 0);
      const store = readRawStore();
      expect(store).not.toHaveProperty('openrouter');
      expect(store).not.toHaveProperty(POOL_STORE_FIELD);
      expect(loadKeyPool(spec).keys).toEqual([]);
    });

    it('keeps OTHER specs in the store untouched', () => {
      // Any OTHER surviving spec does: the azure pair this used to use went
      // away with the azure backend, but the isolation it pinned is live —
      // the pool may only ever rewrite its own flat field and its own
      // `_pools` entry.
      const other = findSpec('artificialAnalysis')!;
      saveApiKey(other, 'aa-keep');
      addPoolKey(spec, 'sk-or-A');
      expect(readRawStore().artificialAnalysis).toBe('aa-keep');
      // ...and the pool's own mirror still landed.
      expect(readRawStore().openrouter).toBe('sk-or-A');
    });

    it('a corrupt store degrades to an empty pool instead of throwing', () => {
      mkdirSync(join(tmpDir, 'cfg'), { recursive: true });
      writeFileSync(configFilePath(), '{ not json');
      expect(loadKeyPool(spec)).toEqual(blankPool());
      expect(() => saveKeyPool(spec, { ...blankPool(), keys: ['sk-or-A'] })).not.toThrow();
    });
  });

  describe('normalizePool', () => {
    it('repairs indices: drops junk keys, clamps current, drops out-of-range entries', () => {
      const pool = normalizePool({
        keys: ['a', '', '  b  ', 42, null, 'c'],
        current: 99,
        burned: [{ index: 1, at: 'x', reason: 'auth' }, { index: 7 }, 'nope'],
        cooldowns: [{ index: 12, until: future() }],
      });
      expect(pool.keys).toEqual(['a', 'b', 'c']);
      expect(pool.current).toBe(2); // clamped to keys.length - 1
      expect(pool.burned.map((b) => b.index)).toEqual([1]);
      expect(pool.cooldowns).toEqual([]); // index 12 doesn't exist
    });

    it('prunes EXPIRED cooldowns and keeps active ones', () => {
      const pool = normalizePool({
        keys: ['a', 'b'],
        current: 0,
        burned: [],
        cooldowns: [
          { index: 0, until: new Date(Date.now() - 1000).toISOString() },
          { index: 1, until: future() },
        ],
      });
      expect(pool.cooldowns.map((c) => c.index)).toEqual([1]);
    });

    it('caps burned at 50, dropping the oldest', () => {
      const keys = Array.from({ length: 60 }, (_, i) => `k${i}`);
      const burned = keys.map((_, i) => ({ index: i, at: 'x', reason: 'auth' }));
      const pool = normalizePool({ keys, current: 0, burned, cooldowns: [] });
      expect(pool.burned).toHaveLength(50);
      expect(pool.burned[0].index).toBe(10);
    });

    it('accepts garbage without throwing', () => {
      expect(normalizePool(null)).toEqual(blankPool());
      expect(normalizePool('nope')).toEqual(blankPool());
      expect(normalizePool([])).toEqual(blankPool());
    });
  });

  describe('nextUsableKeyIndex (round-robin)', () => {
    it('SKIPS burned and cooling keys', () => {
      const state: KeyPoolState = {
        keys: ['a', 'b', 'c'],
        current: 1,
        burned: [{ index: 1, at: 'x', reason: 'auth' }],
        cooldowns: [{ index: 2, until: future() }],
      };
      expect(nextUsableKeyIndex(state)).toBe(0);
      expect(cooldownActive(state, 2)).toBe(true);
      expect(cooldownActive(state, 0)).toBe(false);
    });

    it('honors skipIndex and wraps around from current', () => {
      const state: KeyPoolState = { keys: ['a', 'b', 'c'], current: 2, burned: [], cooldowns: [] };
      expect(nextUsableKeyIndex(state)).toBe(2);
      expect(nextUsableKeyIndex(state, 2)).toBe(0);
    });

    it('returns -1 when nothing is usable', () => {
      const state: KeyPoolState = {
        keys: ['a'],
        current: 0,
        burned: [{ index: 0, at: 'x', reason: 'auth' }],
        cooldowns: [],
      };
      expect(nextUsableKeyIndex(state)).toBe(-1);
      expect(nextUsableKeyIndex(blankPool())).toBe(-1);
    });

    it('setCooldown/markBurned are idempotent and range-checked', () => {
      const state: KeyPoolState = { keys: ['a'], current: 0, burned: [], cooldowns: [] };
      markBurned(state, 0, 'auth');
      markBurned(state, 0, 'auth-again');
      markBurned(state, 5, 'out-of-range');
      expect(state.burned).toHaveLength(1);
      expect(state.burned[0].reason).toBe('auth');

      setCooldown(state, 0, Date.now() + 1000);
      setCooldown(state, 0, Date.now() + 5000);
      setCooldown(state, 9, Date.now() + 1000);
      expect(state.cooldowns).toHaveLength(1);
    });
  });

  describe('removePoolKey', () => {
    it('REINDEXES burned/cooldowns/current so entries keep their key', () => {
      addPoolKey(spec, 'A');
      addPoolKey(spec, 'B');
      addPoolKey(spec, 'C');
      const state = loadKeyPool(spec);
      markBurned(state, 2, 'auth'); // C is burned
      setCooldown(state, 1, Date.now() + 60_000); // B is cooling
      state.current = 2;
      saveKeyPool(spec, state);

      removePoolKey(spec, 0); // drop A

      const after = loadKeyPool(spec);
      expect(after.keys).toEqual(['B', 'C']);
      expect(after.burned.map((b) => b.index)).toEqual([1]); // still C
      expect(after.cooldowns.map((c) => c.index)).toEqual([0]); // still B
      expect(after.current).toBe(1); // still C
      // …and the mirror followed the new head.
      expect(readRawStore().openrouter).toBe('B');
    });

    it('drops the removed key’s own burn record', () => {
      addPoolKey(spec, 'A');
      addPoolKey(spec, 'B');
      const state = loadKeyPool(spec);
      markBurned(state, 0, 'auth');
      saveKeyPool(spec, state);

      removePoolKey(spec, 0);
      const after = loadKeyPool(spec);
      expect(after.keys).toEqual(['B']);
      expect(after.burned).toEqual([]);
    });

    it('is a no-op for an out-of-range index', () => {
      addPoolKey(spec, 'A');
      expect(removePoolKey(spec, 9).keys).toEqual(['A']);
      expect(removePoolKey(spec, -1).keys).toEqual(['A']);
    });
  });

  describe('createKeyPoolHandle', () => {
    it('rotates on a rate limit and persists the cooldown', () => {
      addPoolKey(spec, 'sk-or-A');
      addPoolKey(spec, 'sk-or-B');
      const handle = createKeyPoolHandle(spec, 'sk-or-A');

      expect(handle.size()).toBe(2);
      expect(handle.current()).toBe('sk-or-A');
      expect(handle.report('rate_limit', 'sk-or-A')).toBe(true);
      expect(handle.current()).toBe('sk-or-B');

      const persisted = loadKeyPool(spec);
      expect(persisted.cooldowns.map((c) => c.index)).toEqual([0]);
      expect(persisted.current).toBe(1);
      // The mirror still names keys[0] — rotation never rewrites the array.
      expect(readRawStore().openrouter).toBe('sk-or-A');
    });

    it('burns on auth and persists the burn', () => {
      addPoolKey(spec, 'sk-or-A');
      addPoolKey(spec, 'sk-or-B');
      const handle = createKeyPoolHandle(spec, 'sk-or-A');

      expect(handle.report('auth', 'sk-or-A')).toBe(true);
      expect(handle.current()).toBe('sk-or-B');
      expect(loadKeyPool(spec).burned.map((b) => b.index)).toEqual([0]);
    });

    it('reports false (no rotation) when no other key is usable', () => {
      addPoolKey(spec, 'sk-or-ONLY');
      const handle = createKeyPoolHandle(spec, 'sk-or-ONLY');
      expect(handle.size()).toBe(1);
      expect(handle.report('rate_limit', 'sk-or-ONLY')).toBe(false);
      // …but the cooldown is still recorded for the NEXT process.
      expect(loadKeyPool(spec).cooldowns).toHaveLength(1);
    });

    it("'other' errors say nothing about the key: no cooldown, no burn, no rotation", () => {
      addPoolKey(spec, 'sk-or-A');
      addPoolKey(spec, 'sk-or-B');
      const handle = createKeyPoolHandle(spec, 'sk-or-A');
      expect(handle.report('other', 'sk-or-A')).toBe(false);
      expect(handle.current()).toBe('sk-or-A');
      const after = loadKeyPool(spec);
      expect(after.burned).toEqual([]);
      expect(after.cooldowns).toEqual([]);
    });

    it('ignores a report about a key that is not in the pool', () => {
      addPoolKey(spec, 'sk-or-A');
      addPoolKey(spec, 'sk-or-B');
      const handle = createKeyPoolHandle(spec, 'sk-or-A');
      expect(handle.report('auth', 'sk-or-SOMEONE-ELSE')).toBe(false);
      expect(loadKeyPool(spec).burned).toEqual([]);
    });

    it('SINGLETON: a seed outside the pool NEVER rotates (pickRunKey precedence)', () => {
      // The browser sends a per-session key with the run, and the Docker
      // secret mount outranks the store — in both cases the run is using a
      // key the pool does not own, and swapping it silently would break the
      // user's explicit choice.
      addPoolKey(spec, 'sk-or-A');
      addPoolKey(spec, 'sk-or-B');
      const handle = createKeyPoolHandle(spec, 'sk-or-SESSION');

      expect(handle.size()).toBe(1);
      expect(handle.current()).toBe('sk-or-SESSION');
      expect(handle.report('rate_limit', 'sk-or-SESSION')).toBe(false);
      expect(handle.report('auth', 'sk-or-A')).toBe(false);
      expect(handle.current()).toBe('sk-or-SESSION');

      // Nothing was learned about the pool — it is untouched on disk.
      const after = loadKeyPool(spec);
      expect(after.burned).toEqual([]);
      expect(after.cooldowns).toEqual([]);
    });

    it('an empty seed with an empty pool is a size-0 no-op handle', () => {
      const handle = createKeyPoolHandle(spec, '');
      expect(handle.size()).toBe(0);
      expect(handle.current()).toBe('');
      expect(handle.report('auth', '')).toBe(false);
    });

    it('skips a key that is ALREADY cooling when seeded (round-robin, not restart)', () => {
      addPoolKey(spec, 'A');
      addPoolKey(spec, 'B');
      addPoolKey(spec, 'C');
      const state = loadKeyPool(spec);
      setCooldown(state, 1, Date.now() + 60_000); // B cooling
      saveKeyPool(spec, state);

      const handle = createKeyPoolHandle(spec, 'A');
      expect(handle.report('rate_limit', 'A')).toBe(true);
      expect(handle.current()).toBe('C'); // B skipped
    });

    it('createKeyPoolHandleByName degrades to a singleton for an unknown spec', () => {
      const handle = createKeyPoolHandleByName('does-not-exist', 'seed-value');
      expect(handle.size()).toBe(1);
      expect(handle.current()).toBe('seed-value');
      expect(handle.report('auth', 'seed-value')).toBe(false);
    });

    it('createKeyPoolHandleByName resolves a real spec', () => {
      addPoolKey(spec, 'sk-or-A');
      addPoolKey(spec, 'sk-or-B');
      const handle = createKeyPoolHandleByName('openrouter', 'sk-or-A');
      expect(handle.size()).toBe(2);
      expect(handle.report('rate_limit', 'sk-or-A')).toBe(true);
    });
  });

  function future(msFromNow = 60_000): string {
    return new Date(Date.now() + msFromNow).toISOString();
  }
});

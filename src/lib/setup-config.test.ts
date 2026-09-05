import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configFilePath, findSpec, loadStoredApiKey, saveApiKey } from './api-key.js';
import { addPoolKey, loadKeyPool, POOL_STORE_FIELD } from './api-key-pool.js';
import {
  clearSetupConfig,
  DEFAULT_SETUP_INTERFACE,
  DEFAULT_SETUP_RUNTIME,
  defaultSetupConfig,
  isSetupComplete,
  isSetupInterface,
  isSetupRuntime,
  loadSetupConfig,
  markSetupComplete,
  saveSetupConfig,
  SETUP_CONFIG_VERSION,
  SETUP_STORE_FIELD,
  setupConfigPath,
  type SetupConfig,
} from './setup-config.js';

describe('setup-config', () => {
  // Every test writes through a throwaway HUU_CONFIG_DIR so the user's real
  // ~/.config/huu/config.json is never touched.
  const TRACKED_ENV = [
    'HUU_CONFIG_DIR',
    'XDG_CONFIG_HOME',
    'DEEPSEEK_API_KEY',
    'DEEPSEEK_API_KEY_FILE',
    'OPENROUTER_API_KEY',
    'OPENROUTER_API_KEY_FILE',
  ] as const;
  const saved: Record<string, string | undefined> = {};
  let tmpDir: string;

  const readRawStore = (): Record<string, unknown> =>
    JSON.parse(readFileSync(configFilePath(), 'utf8')) as Record<string, unknown>;

  /** Overwrite config.json wholesale — the "hand-edited by a human" scenario. */
  const writeRaw = (contents: string): void => {
    const path = configFilePath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, contents, { mode: 0o600 });
  };

  beforeEach(() => {
    for (const k of TRACKED_ENV) saved[k] = process.env[k];
    for (const k of TRACKED_ENV) delete process.env[k];
    tmpDir = mkdtempSync(join(tmpdir(), 'huu-setup-config-test-'));
    process.env.HUU_CONFIG_DIR = join(tmpDir, 'cfg');
  });

  afterEach(() => {
    for (const k of TRACKED_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('first run (no config file at all)', () => {
    it('reports the setup as INCOMPLETE and never throws', () => {
      expect(() => loadSetupConfig()).not.toThrow();
      const config = loadSetupConfig();
      expect(config.completed).toBe(false);
      expect(isSetupComplete(config)).toBe(false);
      expect(isSetupComplete()).toBe(false);
    });

    it('hands back sensible defaults instead of undefined choices', () => {
      const config = loadSetupConfig();
      expect(config.interface).toBe(DEFAULT_SETUP_INTERFACE);
      expect(config.runtime).toBe(DEFAULT_SETUP_RUNTIME);
      expect(config.version).toBe(SETUP_CONFIG_VERSION);
      expect(config.completedAt).toBeUndefined();
      expect(config).toEqual(defaultSetupConfig());
    });

    it('does not CREATE the config file just by being read', () => {
      loadSetupConfig();
      expect(() => statSync(configFilePath())).toThrow();
    });

    it('returns a fresh default object each call (a mutation cannot leak)', () => {
      const first = loadSetupConfig();
      first.interface = 'cli';
      expect(loadSetupConfig().interface).toBe(DEFAULT_SETUP_INTERFACE);
    });
  });

  describe('write then read back', () => {
    it('round-trips the interface + runtime pair and marks the setup complete', () => {
      expect(saveSetupConfig({ interface: 'cli', runtime: 'native' })).toBe(true);
      const config = loadSetupConfig();
      expect(config.interface).toBe('cli');
      expect(config.runtime).toBe('native');
      expect(config.completed).toBe(true);
      expect(isSetupComplete(config)).toBe(true);
      expect(typeof config.completedAt).toBe('string');
      expect(Number.isNaN(Date.parse(config.completedAt!))).toBe(false);
    });

    it('round-trips the OTHER pair too (the value is stored, not hard-coded)', () => {
      expect(saveSetupConfig({ interface: 'web', runtime: 'docker' })).toBe(true);
      const config = loadSetupConfig();
      expect(config.interface).toBe('web');
      expect(config.runtime).toBe('docker');
      expect(isSetupComplete(config)).toBe(true);
    });

    it('markSetupComplete is the same write in one call', () => {
      expect(markSetupComplete('cli', 'docker')).toBe(true);
      const config = loadSetupConfig();
      expect([config.interface, config.runtime, config.completed]).toEqual([
        'cli',
        'docker',
        true,
      ]);
    });

    it('MERGES a partial update over the stored choices', () => {
      markSetupComplete('cli', 'native');
      expect(saveSetupConfig({ runtime: 'docker' })).toBe(true);
      const config = loadSetupConfig();
      expect(config.interface).toBe('cli'); // untouched by the partial write
      expect(config.runtime).toBe('docker');
    });

    it('completed:false stages a choice WITHOUT ending the flow', () => {
      expect(saveSetupConfig({ interface: 'cli', completed: false })).toBe(true);
      const config = loadSetupConfig();
      expect(config.interface).toBe('cli');
      expect(config.completed).toBe(false);
      expect(isSetupComplete(config)).toBe(false);
      expect(config.completedAt).toBeUndefined();
    });

    it('stores the record under the `_setup` field of config.json', () => {
      markSetupComplete('web', 'native');
      const record = readRawStore()[SETUP_STORE_FIELD] as Record<string, unknown>;
      expect(record).toMatchObject({
        version: SETUP_CONFIG_VERSION,
        interface: 'web',
        runtime: 'native',
        completed: true,
      });
    });
  });

  describe('the other config fields SURVIVE a setup write', () => {
    it('keeps API keys and `_pools` intact (the credential-destruction guard)', () => {
      const deepseek = findSpec('deepseek')!;
      const openrouter = findSpec('openrouter')!;
      saveApiKey(deepseek, 'sk-ds-PRIMARY');
      addPoolKey(openrouter, 'sk-or-A');
      addPoolKey(openrouter, 'sk-or-B');
      const before = readRawStore();

      expect(markSetupComplete('cli', 'native')).toBe(true);

      // Resolved through the owning modules…
      expect(loadStoredApiKey(deepseek)).toBe('sk-ds-PRIMARY');
      expect(loadKeyPool(openrouter).keys).toEqual(['sk-or-A', 'sk-or-B']);
      // …and byte-for-byte in the raw store.
      const after = readRawStore();
      expect(after[deepseek.name]).toEqual(before[deepseek.name]);
      expect(after[openrouter.name]).toEqual(before[openrouter.name]);
      expect(after[POOL_STORE_FIELD]).toEqual(before[POOL_STORE_FIELD]);
      expect(after[SETUP_STORE_FIELD]).toBeDefined();
    });

    it('preserves UNKNOWN fields a future huu (or a human) put in the file', () => {
      writeRaw(JSON.stringify({ deepseek: 'sk-ds-X', _future: { a: 1 }, keep: 'me' }));
      expect(markSetupComplete('web', 'docker')).toBe(true);
      const after = readRawStore();
      expect(after.deepseek).toBe('sk-ds-X');
      expect(after._future).toEqual({ a: 1 });
      expect(after.keep).toBe('me');
    });

    it('saving a key AFTER the setup does not wipe the setup record', () => {
      markSetupComplete('cli', 'native');
      saveApiKey(findSpec('deepseek')!, 'sk-ds-LATER');
      const config = loadSetupConfig();
      expect(config.interface).toBe('cli');
      expect(config.runtime).toBe('native');
      expect(config.completed).toBe(true);
    });
  });

  describe('corrupt / hostile config (must degrade, never throw)', () => {
    it('invalid JSON → defaults', () => {
      writeRaw('{ this is not json ');
      expect(() => loadSetupConfig()).not.toThrow();
      expect(loadSetupConfig()).toEqual(defaultSetupConfig());
      expect(isSetupComplete()).toBe(false);
    });

    it('a JSON file that is not an object → defaults', () => {
      writeRaw('[1, 2, 3]');
      expect(loadSetupConfig()).toEqual(defaultSetupConfig());
    });

    it('`_setup: null` → defaults', () => {
      writeRaw(JSON.stringify({ deepseek: 'sk', [SETUP_STORE_FIELD]: null }));
      expect(() => loadSetupConfig()).not.toThrow();
      expect(loadSetupConfig()).toEqual(defaultSetupConfig());
    });

    it('`_setup: []` → defaults', () => {
      writeRaw(JSON.stringify({ [SETUP_STORE_FIELD]: [] }));
      expect(loadSetupConfig()).toEqual(defaultSetupConfig());
    });

    it('`_setup` as a string → defaults', () => {
      writeRaw(JSON.stringify({ [SETUP_STORE_FIELD]: 'web' }));
      expect(loadSetupConfig()).toEqual(defaultSetupConfig());
    });

    it('a field with the WRONG TYPE → defaults, setup incomplete', () => {
      writeRaw(
        JSON.stringify({
          [SETUP_STORE_FIELD]: {
            version: SETUP_CONFIG_VERSION,
            interface: 42,
            runtime: { nested: true },
            completed: true,
          },
        }),
      );
      const config = loadSetupConfig();
      expect(config).toEqual(defaultSetupConfig());
      expect(isSetupComplete(config)).toBe(false);
    });

    it('an out-of-enum choice is NOT trusted, even with completed:true', () => {
      writeRaw(
        JSON.stringify({
          [SETUP_STORE_FIELD]: {
            version: SETUP_CONFIG_VERSION,
            interface: 'banana',
            runtime: 'docker',
            completed: true,
          },
        }),
      );
      expect(isSetupComplete(loadSetupConfig())).toBe(false);
      expect(loadSetupConfig().interface).toBe(DEFAULT_SETUP_INTERFACE);
    });

    it('`completed: "yes"` is not `true` → incomplete', () => {
      writeRaw(
        JSON.stringify({
          [SETUP_STORE_FIELD]: {
            version: SETUP_CONFIG_VERSION,
            interface: 'cli',
            runtime: 'native',
            completed: 'yes',
          },
        }),
      );
      const config = loadSetupConfig();
      expect(config.completed).toBe(false);
      // The valid choices still come back as pre-selections.
      expect(config.interface).toBe('cli');
      expect(config.runtime).toBe('native');
    });

    it('an UNKNOWN schema version → defaults (the v1 migration policy)', () => {
      writeRaw(
        JSON.stringify({
          [SETUP_STORE_FIELD]: {
            version: SETUP_CONFIG_VERSION + 99,
            interface: 'cli',
            runtime: 'native',
            completed: true,
          },
        }),
      );
      expect(loadSetupConfig()).toEqual(defaultSetupConfig());
    });

    it('a MISSING version → defaults', () => {
      writeRaw(
        JSON.stringify({
          [SETUP_STORE_FIELD]: { interface: 'cli', runtime: 'native', completed: true },
        }),
      );
      expect(loadSetupConfig()).toEqual(defaultSetupConfig());
    });

    it('an unreadable config path degrades on read and reports failure on write', () => {
      // A directory where the file should be: readFileSync/writeFileSync both
      // raise EISDIR, which is the closest portable stand-in for "no permission".
      mkdirSync(configFilePath(), { recursive: true });
      expect(() => loadSetupConfig()).not.toThrow();
      expect(loadSetupConfig()).toEqual(defaultSetupConfig());
      expect(() => saveSetupConfig({ interface: 'cli' })).not.toThrow();
      expect(saveSetupConfig({ interface: 'cli' })).toBe(false);
      expect(() => clearSetupConfig()).not.toThrow();
    });
  });

  describe('reset (huu setup)', () => {
    it('removes ONLY `_setup` and preserves every other field', () => {
      saveApiKey(findSpec('deepseek')!, 'sk-ds-KEEP');
      addPoolKey(findSpec('openrouter')!, 'sk-or-KEEP');
      markSetupComplete('cli', 'native');

      expect(clearSetupConfig()).toBe(true);

      const after = readRawStore();
      expect(SETUP_STORE_FIELD in after).toBe(false);
      expect(after.deepseek).toBe('sk-ds-KEEP');
      expect(loadKeyPool(findSpec('openrouter')!).keys).toEqual(['sk-or-KEEP']);
      expect(isSetupComplete()).toBe(false);
      expect(loadSetupConfig()).toEqual(defaultSetupConfig());
    });

    it('is a no-op that reports false when there is nothing stored', () => {
      expect(clearSetupConfig()).toBe(false);
      writeRaw(JSON.stringify({ deepseek: 'sk-ds-ONLY' }));
      expect(clearSetupConfig()).toBe(false);
      expect(readRawStore().deepseek).toBe('sk-ds-ONLY');
    });

    it('lets the user choose again after a reset', () => {
      markSetupComplete('cli', 'native');
      clearSetupConfig();
      expect(markSetupComplete('web', 'docker')).toBe(true);
      expect(loadSetupConfig()).toMatchObject({
        interface: 'web',
        runtime: 'docker',
        completed: true,
      });
    });
  });

  describe('file permissions (the file holds credentials)', () => {
    it('stays 0600 after a setup write', () => {
      markSetupComplete('cli', 'native');
      expect(statSync(configFilePath()).mode & 0o777).toBe(0o600);
    });

    it('stays 0600 after a reset', () => {
      markSetupComplete('cli', 'native');
      clearSetupConfig();
      expect(statSync(configFilePath()).mode & 0o777).toBe(0o600);
    });

    it('tightens a file that was left world-readable', () => {
      writeRaw(JSON.stringify({ deepseek: 'sk' }));
      // Loosen it the way an old huu / a wide umask would have.
      chmodSync(configFilePath(), 0o644);
      markSetupComplete('web', 'docker');
      expect(statSync(configFilePath()).mode & 0o777).toBe(0o600);
    });
  });

  describe('config location', () => {
    it('HUU_CONFIG_DIR decides where the record lands', () => {
      const expected = join(tmpDir, 'cfg', 'config.json');
      expect(setupConfigPath()).toBe(expected);
      markSetupComplete('cli', 'native');
      expect(statSync(expected).isFile()).toBe(true);
      expect((readRawStore()[SETUP_STORE_FIELD] as Record<string, unknown>).interface).toBe(
        'cli',
      );
    });

    it('falls back to XDG_CONFIG_HOME/huu when HUU_CONFIG_DIR is unset', () => {
      delete process.env.HUU_CONFIG_DIR;
      process.env.XDG_CONFIG_HOME = join(tmpDir, 'xdg');
      expect(setupConfigPath()).toBe(join(tmpDir, 'xdg', 'huu', 'config.json'));
      expect(markSetupComplete('web', 'native')).toBe(true);
      expect(loadSetupConfig().runtime).toBe('native');
    });

    it('two different config dirs do not see each other', () => {
      markSetupComplete('cli', 'native');
      process.env.HUU_CONFIG_DIR = join(tmpDir, 'other');
      expect(isSetupComplete()).toBe(false);
      process.env.HUU_CONFIG_DIR = join(tmpDir, 'cfg');
      expect(isSetupComplete()).toBe(true);
    });
  });

  // `isSetupComplete` is the gate `npm start` asks before skipping the flow, and
  // every other test reaches it through `loadSetupConfig`, which has ALREADY
  // sanitized the record. So nothing pinned the validation inside the gate
  // itself: an implementation that trusted `completed` alone passed the whole
  // suite. These call it directly with a hand-made object — the shape a caller
  // that built a config in memory (or a future migration) can actually hand it.
  describe('isSetupComplete validates the config it is HANDED, not just its flag', () => {
    const complete = (over: Partial<Record<keyof SetupConfig, unknown>>): SetupConfig =>
      ({
        version: SETUP_CONFIG_VERSION,
        interface: 'cli',
        runtime: 'native',
        completed: true,
        ...over,
      }) as unknown as SetupConfig;

    it('accepts a hand-made config whose every field is valid', () => {
      expect(isSetupComplete(complete({}))).toBe(true);
    });

    it('rejects out-of-enum choices even though `completed` is literally true', () => {
      expect(isSetupComplete(complete({ interface: 'banana', runtime: 'podman' }))).toBe(false);
      expect(isSetupComplete(complete({ interface: 'banana' }))).toBe(false);
      expect(isSetupComplete(complete({ runtime: 'podman' }))).toBe(false);
    });

    it('rejects a version this huu does not understand', () => {
      expect(isSetupComplete(complete({ version: SETUP_CONFIG_VERSION + 98 }))).toBe(false);
      expect(isSetupComplete(complete({ version: undefined }))).toBe(false);
      expect(isSetupComplete(complete({ version: String(SETUP_CONFIG_VERSION) }))).toBe(false);
    });

    it('rejects missing or wrongly-typed choices', () => {
      expect(isSetupComplete(complete({ interface: undefined }))).toBe(false);
      expect(isSetupComplete(complete({ runtime: 42 }))).toBe(false);
    });

    it('still requires the flag itself', () => {
      expect(isSetupComplete(complete({ completed: false }))).toBe(false);
      expect(isSetupComplete(complete({ completed: 'yes' }))).toBe(false);
    });
  });

  describe('type guards', () => {
    it('accept only the documented literals', () => {
      expect(isSetupInterface('web')).toBe(true);
      expect(isSetupInterface('cli')).toBe(true);
      expect(isSetupInterface('tui')).toBe(false);
      expect(isSetupInterface(undefined)).toBe(false);
      expect(isSetupRuntime('docker')).toBe(true);
      expect(isSetupRuntime('native')).toBe(true);
      expect(isSetupRuntime('podman')).toBe(false);
      expect(isSetupRuntime(null)).toBe(false);
    });
  });
});

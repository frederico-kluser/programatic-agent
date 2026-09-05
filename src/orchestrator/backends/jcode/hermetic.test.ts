import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  JCODE_CONFIG_FILENAME,
  JCODE_CONFIG_TOML,
  JCODE_PROVIDER_PROFILE,
  jcodeApiKeyEnvVar,
  jcodeProviderProfile,
  buildJcodeSessionEnvironment,
  ensureJcodeConfig,
  jcodeConfigHomeDir,
} from './hermetic.js';
import { PROVIDERS } from '../../../lib/providers.js';

// ---------------------------------------------------------------------------
// Real filesystem, real temp home. `getHuuHome()` reads HUU_HOST_HOME from
// process.env, so pointing that at a mkdtemp dir moves the WHOLE `~/.huu`
// namespace (agent dir + config home) into throwaway space — no mocks, and the
// developer's real home is never touched by these tests.
// ---------------------------------------------------------------------------

describe('jcode hermetic — huu-owned config.toml + JCODE_HOME', () => {
  let home: string;
  let savedHostHome: string | undefined;

  beforeEach(() => {
    savedHostHome = process.env.HUU_HOST_HOME;
    home = mkdtempSync(join(tmpdir(), 'huu-jcode-hermetic-'));
    process.env.HUU_HOST_HOME = home;
  });

  afterEach(() => {
    if (savedHostHome === undefined) delete process.env.HUU_HOST_HOME;
    else process.env.HUU_HOST_HOME = savedHostHome;
    rmSync(home, { recursive: true, force: true });
  });

  // -- the fix itself ------------------------------------------------------

  it('hermetic env exports JCODE_HOME pointing at the huu-owned config dir', () => {
    const result = buildJcodeSessionEnvironment({ env: {} as NodeJS.ProcessEnv });

    expect(result.hermetic).toBe(true);
    expect(result.configHome).toBe(join(home, '.huu', 'jcode-home'));
    expect(result.env.JCODE_HOME).toBe(result.configHome);
    // The config dir is NOT the runtime dir: the two vars isolate different things.
    expect(result.env.JCODE_HOME).not.toBe(result.env.JCODE_AGENT_DIR);
  });

  it('writes config.toml DIRECTLY under JCODE_HOME (no .jcode segment)', () => {
    const result = buildJcodeSessionEnvironment({ env: {} as NodeJS.ProcessEnv });
    const configHome = result.env.JCODE_HOME as string;

    // jcode reads `$JCODE_HOME/config.toml`, measured — not
    // `$JCODE_HOME/.jcode/config.toml`. Getting this wrong resolves nothing.
    const expected = join(configHome, 'config.toml');
    expect(result.configPath).toBe(expected);
    expect(existsSync(expected)).toBe(true);
    expect(existsSync(join(configHome, '.jcode', 'config.toml'))).toBe(false);
  });

  it('the materialized config declares the deepseek-v4-pro profile jcode is spawned with', () => {
    const result = buildJcodeSessionEnvironment({ env: {} as NodeJS.ProcessEnv });
    const toml = readFileSync(result.configPath as string, 'utf8');

    // These four lines are what turns "Unknown provider profile
    // 'deepseek-v4-pro'" into a working spawn.
    expect(toml).toContain(`[providers.${JCODE_PROVIDER_PROFILE}]`);
    expect(toml).toContain(`[[providers.${JCODE_PROVIDER_PROFILE}.models]]`);
    expect(toml).toContain('type = "openai-compatible"');
    expect(toml).toContain('base_url = "https://api.deepseek.com/v1"');
    expect(toml).toContain('api_key_env = "DEEPSEEK_API_KEY"');
    expect(toml).toContain('requires_api_key = true');
    expect(toml).toContain('context_window = 1000000');
    expect(toml).toContain('max_tokens = 384000');
    expect(toml).toBe(JCODE_CONFIG_TOML);
  });

  // MUTATION KILLED: dropping a profile block (or writing only the run's
  // current provider). jcode refuses to start on an unknown
  // `--provider-profile`, so a provider huu offers in the selector but omits
  // here is a provider that cannot run — and the previous shape of this module
  // "fixed" that by sending it to the DeepSeek profile instead.
  it('declares ONE profile per provider huu exposes, each with its own host and var', () => {
    const result = buildJcodeSessionEnvironment({ env: {} as NodeJS.ProcessEnv });
    const toml = readFileSync(result.configPath as string, 'utf8');

    for (const info of PROVIDERS) {
      const profile = jcodeProviderProfile(info.id);
      expect(toml).toContain(`[providers.${profile}]`);
      expect(toml).toContain(`[[providers.${profile}.models]]`);
      // The block is derived from the provider table, so the URL jcode dials is
      // the URL huu's own LangChain clients dial. A literal here would be a
      // second source of truth for the one string that decides WHERE the
      // credential goes.
      const block = toml.slice(toml.indexOf(`[providers.${profile}]`));
      expect(block).toContain(`base_url = "${info.defaultBaseUrl}"`);
      expect(block).toContain(`api_key_env = "${jcodeApiKeyEnvVar(info.id)}"`);
    }
    expect(toml).toContain('[providers.openrouter]');
    expect(toml).toContain('base_url = "https://openrouter.ai/api/v1"');
    expect(toml).toContain('api_key_env = "OPENROUTER_API_KEY"');
  });

  it('writes each profile’s default_model in THAT endpoint’s namespace', () => {
    const result = buildJcodeSessionEnvironment({ env: {} as NodeJS.ProcessEnv });
    const toml = readFileSync(result.configPath as string, 'utf8');
    // api.deepseek.com names its models bare; openrouter.ai routes on the
    // vendor prefix. Same rule `--model` goes through, so the declared default
    // and the spawned model are written in ONE namespace per endpoint.
    expect(toml).toContain('default_model = "deepseek-v4-pro"');
    expect(toml).toContain('default_model = "deepseek/deepseek-v4-pro"');
  });

  it('never writes a credential into the config — only the env var NAME', () => {
    const result = buildJcodeSessionEnvironment({
      env: {
        DEEPSEEK_API_KEY: 'sk-super-secret-value',
        OPENROUTER_API_KEY: 'sk-or-v1-super-secret-value',
      } as NodeJS.ProcessEnv,
    });
    const toml = readFileSync(result.configPath as string, 'utf8');

    expect(toml).not.toContain('sk-super-secret-value');
    expect(toml).not.toContain('sk-or-v1-super-secret-value');
    // No inline `api_key = "…"` key: only `api_key_env`, which names a variable.
    // (Anchored per line — `requires_api_key = true` legitimately ends in `_api_key =`.)
    expect(toml.split('\n').filter((l) => /^\s*api_key\s*=/.test(l))).toEqual([]);
    expect(toml).toContain('api_key_env = "DEEPSEEK_API_KEY"');
    expect(toml).toContain('api_key_env = "OPENROUTER_API_KEY"');
    // The keys still reach the child, just through the env. (The per-run
    // narrowing to ONE provider's key happens later, in `withJcodeApiKey`.)
    expect(result.env.DEEPSEEK_API_KEY).toBe('sk-super-secret-value');
    expect(result.env.OPENROUTER_API_KEY).toBe('sk-or-v1-super-secret-value');
  });

  // -- idempotency / self-heal --------------------------------------------

  it('is idempotent: a second spawn does not rewrite an already-correct file', () => {
    const first = ensureJcodeConfig();
    expect(first).not.toBeNull();
    const before = statSync(first as string);

    const second = ensureJcodeConfig();
    expect(second).toBe(first);
    const after = statSync(second as string);

    // tmp+rename ALWAYS produces a new inode, so an unchanged inode is proof
    // that no write happened — not merely that the content ended up equal.
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('self-heals: a user-edited config is restored on the next spawn', () => {
    const path = ensureJcodeConfig() as string;
    const before = statSync(path);

    writeFileSync(path, '[provider]\ndefault_provider = "totally-broken"\n', 'utf8');
    expect(readFileSync(path, 'utf8')).not.toBe(JCODE_CONFIG_TOML);

    const healed = ensureJcodeConfig();
    expect(healed).toBe(path);
    expect(readFileSync(path, 'utf8')).toBe(JCODE_CONFIG_TOML);
    // A real rewrite happened (new inode), so the previous assertion cannot be
    // passing because nothing was ever changed.
    expect(statSync(path).ino).not.toBe(before.ino);
  });

  it('leaves no staging file behind (the tmp+rename is not observable)', () => {
    ensureJcodeConfig();
    ensureJcodeConfig();
    ensureJcodeConfig();

    const entries = readdirSync(jcodeConfigHomeDir());
    expect(entries).toEqual([JCODE_CONFIG_FILENAME]);
  });

  it('keeps the config readable by other UIDs even under a restrictive umask', () => {
    // `mode:` on writeFileSync/mkdirSync is only a request — open(2)/mkdir(2)
    // mask it with the process umask, so `umask 077` silently produces
    // 0o600/0o700. That breaks the ONE property these bits exist for: the
    // container can run as a different UID than the one that created the file
    // (docker/entrypoint.sh synthesizes a HOME for an unknown `--user`), and
    // owner-only bits lock jcode out of its own config.
    if (process.platform === 'win32') return;
    const previousUmask = process.umask(0o077);
    try {
      const path = ensureJcodeConfig() as string;
      expect(statSync(path).mode & 0o777).toBe(0o644);
      expect(statSync(jcodeConfigHomeDir()).mode & 0o777).toBe(0o755);
    } finally {
      process.umask(previousUmask);
    }
  });

  // -- degradation ---------------------------------------------------------

  it('degrades instead of throwing when the config cannot be written', () => {
    // A regular FILE where `~/.huu` must be a directory ⇒ every mkdir/write
    // under it fails with ENOTDIR.
    writeFileSync(join(home, '.huu'), 'not a directory', 'utf8');

    let result: ReturnType<typeof buildJcodeSessionEnvironment> | undefined;
    expect(() => {
      result = buildJcodeSessionEnvironment({ env: {} as NodeJS.ProcessEnv });
    }).not.toThrow();

    // Still hermetic for everything that does not need the disk…
    expect(result!.hermetic).toBe(true);
    expect(result!.env.JCODE_MEMORY_ENABLED).toBe('false');
    // …but JCODE_HOME is dropped, so jcode falls back to the host lookup
    // (pre-existing behavior) rather than being pointed at a config-less dir.
    expect(result!.env.JCODE_HOME).toBeUndefined();
    expect(result!.configHome).toBeUndefined();
    expect(result!.configPath).toBeUndefined();
  });

  it('an ambient JCODE_HOME is overridden — the host must not own the config', () => {
    const result = buildJcodeSessionEnvironment({
      env: { JCODE_HOME: '/somewhere/on/the/host' } as NodeJS.ProcessEnv,
    });

    expect(result.env.JCODE_HOME).toBe(join(home, '.huu', 'jcode-home'));
  });

  // -- the escape hatch must stay byte-for-byte host-global -----------------

  it('HUU_JCODE_HERMETIC=0: no JCODE_HOME, and NOTHING is written to disk', () => {
    const parent = { HUU_JCODE_HERMETIC: '0', EXISTING: 'yes' } as NodeJS.ProcessEnv;
    const result = buildJcodeSessionEnvironment({ env: parent });

    expect(result.hermetic).toBe(false);
    expect(result.env.EXISTING).toBe('yes');
    expect(result.env.JCODE_HOME).toBeUndefined();
    expect(result.configHome).toBeUndefined();
    expect(result.configPath).toBeUndefined();
    // Not one byte under the huu home — the branch exists to reproduce the
    // host-global behavior exactly.
    expect(existsSync(join(home, '.huu'))).toBe(false);
  });

  it('HUU_JCODE_HERMETIC=0 keeps an ambient JCODE_HOME untouched', () => {
    const result = buildJcodeSessionEnvironment({
      env: { HUU_JCODE_HERMETIC: '0', JCODE_HOME: '/host/owned' } as NodeJS.ProcessEnv,
    });

    expect(result.env.JCODE_HOME).toBe('/host/owned');
  });

  // Guards the previous assertion against becoming vacuous: the SAME temp home
  // does get populated when hermetic is on.
  it('control: the hermetic branch DOES populate the huu home', () => {
    buildJcodeSessionEnvironment({ env: {} as NodeJS.ProcessEnv });
    expect(existsSync(join(home, '.huu', 'jcode-agent'))).toBe(true);
    expect(existsSync(join(home, '.huu', 'jcode-home', 'config.toml'))).toBe(true);
  });
});

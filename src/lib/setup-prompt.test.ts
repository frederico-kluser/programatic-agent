import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { findSpec, loadStoredApiKey, readConfigStore } from './api-key.js';
import { initI18n } from './i18n/index.js';
import { resetCapabilitiesCache } from './openrouter.js';
import { loadSetupConfig, markSetupComplete, SETUP_STORE_FIELD } from './setup-config.js';
import type { SetupQuestion } from './setup-flow.js';
import {
  collectKeyStates,
  createStdioPrompter,
  isInteractiveStdin,
  runSetupGate,
  type SetupPrompter,
} from './setup-prompt.js';

beforeAll(() => {
  initI18n({ HUU_LANG: 'en' });
});

// Every test writes through a throwaway HUU_CONFIG_DIR so the developer's real
// ~/.config/huu/config.json is never touched, and stubs `fetch` so no probe can
// reach a provider or spend anybody's quota.
const TRACKED_ENV = [
  'HUU_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_API_KEY_FILE',
  'OPENROUTER_API_KEY',
  'OPENROUTER_API_KEY_FILE',
  'BRAVE_API_KEY',
  'BRAVE_API_KEY_FILE',
];

let dir: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of TRACKED_ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), 'huu-setup-prompt-'));
  process.env.HUU_CONFIG_DIR = dir;
  // Any probe that escapes the test is a bug; make it loud instead of slow.
  vi.stubGlobal('fetch', async () => {
    throw new Error('no network in tests');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetCapabilitiesCache();
  rmSync(dir, { recursive: true, force: true });
  for (const k of TRACKED_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

/** Swallow the flow's chrome; these tests assert on the outcome, not on text. */
const noop = (): void => {};

/** A prompter that replays a script and records what it was asked. */
function scripted(answers: (string | null)[]): SetupPrompter & { asked: SetupQuestion[] } {
  const queue = [...answers];
  const asked: SetupQuestion[] = [];
  return {
    asked,
    ask: async (q: SetupQuestion) => {
      asked.push(q);
      return queue.length ? queue.shift()! : null;
    },
    close: () => {},
  };
}

// ───────────────────────────── collectKeyStates ─────────────────────────────

describe('collectKeyStates', () => {
  it('reports nothing when no credential is reachable', () => {
    const states = collectKeyStates();
    expect(states.brave).toEqual({ source: 'none', masked: '' });
  });

  it('sees an env var, and never returns the raw value', () => {
    process.env.BRAVE_API_KEY = 'BSAsupersecretvalue0001';
    const states = collectKeyStates();
    expect(states.brave!.source).toBe('env');
    expect(states.brave!.masked).toBe('BSAsup…0001');
    expect(JSON.stringify(states)).not.toContain('supersecretvalue');
  });
});

// ───────────────────────────── the gate ─────────────────────────────

describe('runSetupGate', () => {
  it('asks nothing once the setup is complete and every key resolves', async () => {
    markSetupComplete('cli', 'native');
    process.env.OPENROUTER_API_KEY = 'sk-or-x1';
    process.env.BRAVE_API_KEY = 'BSAx1';
    process.env.DEEPSEEK_API_KEY = 'sk-x1';

    const prompter = scripted([]);
    const res = await runSetupGate({ args: [], env: {}, openPrompter: () => prompter, interactive: true, write: noop });

    expect(prompter.asked).toEqual([]);
    expect(res.ran).toBe(false);
    expect(res.plan.empty).toBe(true);
    // …and the saved choices are what the caller gets back.
    expect(res.config).toMatchObject({ interface: 'cli', runtime: 'native', completed: true });
  });

  it('does not so much as BUILD a prompter when there is nothing to ask', async () => {
    // Constructing one opens readline on stdin, changes the stream's mode and
    // holds the event loop. On an already-configured machine — every start
    // after the first — that must not happen at all.
    markSetupComplete('web', 'docker');
    process.env.OPENROUTER_API_KEY = 'sk-or-x1';
    process.env.BRAVE_API_KEY = 'BSAx1';
    process.env.DEEPSEEK_API_KEY = 'sk-x1';

    let opened = 0;
    const res = await runSetupGate({
      args: [],
      env: {},
      interactive: true,
      write: noop,
      openPrompter: () => {
        opened += 1;
        return scripted([]);
      },
    });
    expect(opened).toBe(0);
    expect(res.ran).toBe(false);
  });

  it('never opens the conversation inside the container', async () => {
    const prompter = scripted(['1', '1']);
    const res = await runSetupGate({
      args: [],
      env: { HUU_IN_CONTAINER: '1' },
      openPrompter: () => prompter,
      interactive: true,
      write: noop,
    });
    expect(res.considered).toBe(false);
    expect(prompter.asked).toEqual([]);
  });

  it('never opens it twice when the start wrapper already ran it', async () => {
    const prompter = scripted(['1', '1']);
    const res = await runSetupGate({
      args: [],
      env: { HUU_SETUP_GATE_DONE: '1' },
      openPrompter: () => prompter,
      interactive: true,
      write: noop,
    });
    expect(res.considered).toBe(false);
    expect(prompter.asked).toEqual([]);
  });

  it('persists the first-run choices and the accepted keys', async () => {
    // brave: a value the (stubbed) probe cannot check → unverifiable → kept.
    const prompter = scripted(['2', '1', 'sk-or-realkey', 'BSArealkey', '']);
    const lines: string[] = [];
    const res = await runSetupGate({
      args: [],
      env: {},
      openPrompter: () => prompter,
      interactive: true,
      write: (l) => lines.push(l),
    });

    expect(res.ran).toBe(true);
    expect(res.outcome).toMatchObject({ interface: 'cli', runtime: 'docker', completed: true });
    expect(res.config).toMatchObject({ interface: 'cli', runtime: 'docker', completed: true });

    // Written where the next start will read it — the same config.json.
    expect(loadSetupConfig()).toMatchObject({ interface: 'cli', runtime: 'docker' });
    expect(loadStoredApiKey(findSpec('openrouter')!)).toBe('sk-or-realkey');
    expect(loadStoredApiKey(findSpec('brave')!)).toBe('BSArealkey');
    // DeepSeek was skipped with a bare Enter and is genuinely not stored.
    expect(loadStoredApiKey(findSpec('deepseek')!)).toBe('');
    expect(res.outcome.skippedKeys).toEqual(['deepseek']);

    // The keys and the setup record share one file, and neither clobbered the
    // other.
    const store = readConfigStore();
    expect(Object.keys(store).sort()).toEqual(
      [SETUP_STORE_FIELD, 'brave', 'openrouter'].sort(),
    );
  });

  it('does not ask for a key that is already in the environment', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-fromenv';
    process.env.BRAVE_API_KEY = 'BSAfromenv';
    process.env.DEEPSEEK_API_KEY = 'sk-fromenv';

    const prompter = scripted(['1', '1']);
    const res = await runSetupGate({ args: [], env: {}, openPrompter: () => prompter, interactive: true, write: noop });

    expect(res.plan.keys).toEqual([]);
    // Two questions asked: interface and runtime. No key prompt at all.
    expect(prompter.asked).toHaveLength(2);
    // Nothing was copied into the store — the env var stays the source.
    expect(loadStoredApiKey(findSpec('brave')!)).toBe('');
  });

  it('does NOT hang without a TTY, and persists nothing', async () => {
    const lines: string[] = [];
    const res = await runSetupGate({
      args: [],
      env: {},
      interactive: false,
      write: (l) => lines.push(l),
    });
    expect(res.outcome.completed).toBe(false);
    expect(res.config.interface).toBe('web');
    expect(res.config.runtime).toBe('docker');
    expect(loadSetupConfig().completed).toBe(false);
    expect(lines.join('\n')).toMatch(/not a TTY/);
  });

  it('`huu setup` reopens everything even when the setup is complete', async () => {
    markSetupComplete('web', 'docker');
    process.env.OPENROUTER_API_KEY = 'sk-or-x1';
    process.env.BRAVE_API_KEY = 'BSAx1';
    process.env.DEEPSEEK_API_KEY = 'sk-x1';

    const prompter = scripted(['2', '1', '', '', '']);
    const res = await runSetupGate({ args: ['setup'], env: {}, openPrompter: () => prompter, interactive: true, write: noop });

    expect(res.ran).toBe(true);
    expect(res.plan.keys.map((k) => k.spec.name)).toEqual(['openrouter', 'brave', 'deepseek']);
    expect(loadSetupConfig().interface).toBe('cli');
  });

  it('an UNWRITABLE store never reports a key as saved', async () => {
    // The whole finding, end to end, against the real config layer.
    //
    // `<dir>/blocked` is a regular FILE, so `mkdirSync(<dir>/blocked/huu,
    // {recursive:true})` fails with ENOTDIR — for every user, root included.
    // Same end state as `~/.config/huu` left root-owned by a `sudo npm start`,
    // without a chmod that a root CI would sail straight through.
    writeFileSync(join(dir, 'blocked'), 'not a directory');
    process.env.HUU_CONFIG_DIR = join(dir, 'blocked', 'huu');

    const secret = 'sk-or-supersecretvalue0001';
    const prompter = scripted(['2', '1', secret, '', '']);
    const lines: string[] = [];
    const res = await runSetupGate({
      args: [],
      env: {},
      openPrompter: () => prompter,
      interactive: true,
      write: (l) => lines.push(l),
    });
    const said = lines.join('\n');

    // The key: accepted by the (stubbed, unreachable) probe, refused by the
    // disk — and SAID so, instead of the "OpenRouter: saved (sk-or-…0001)"
    // that sent the user off believing they were configured.
    expect(res.outcome.savedKeys).toEqual([]);
    expect(res.outcome.unsavedKeys).toEqual(['openrouter']);
    expect(said).toMatch(/NOT SAVED/);
    expect(said).toContain('OPENROUTER_API_KEY');
    expect(said).not.toContain(secret);
    expect(loadStoredApiKey(findSpec('openrouter')!)).toBe('');

    // The choices: also unwritten, also said out loud…
    expect(res.outcome.completed).toBe(false);
    expect(said).toMatch(/could not be written/);
    expect(loadSetupConfig()).toMatchObject({ interface: 'web', runtime: 'docker', completed: false });

    // …and yet the caller is handed the answers the user actually gave. THIS
    // is the object the wrapper must propagate to its child: the disk no
    // longer holds it, so nothing else can.
    expect(res.config).toMatchObject({ interface: 'cli', runtime: 'docker' });
  });

  it('an aborted flow leaves the previous choices untouched', async () => {
    markSetupComplete('cli', 'docker');
    const prompter = scripted([null]);
    const res = await runSetupGate({ args: ['setup'], env: {}, openPrompter: () => prompter, interactive: true, write: noop });
    expect(res.outcome.aborted).toBe(true);
    expect(loadSetupConfig()).toMatchObject({ interface: 'cli', runtime: 'docker', completed: true });
  });
});

// ───────────────────────────── the prompter ─────────────────────────────

describe('createStdioPrompter', () => {
  it('returns the typed line', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const p = createStdioPrompter(input as never, output);
    const answer = p.ask({ text: 'name? ' });
    input.write('huu\n');
    expect(await answer).toBe('huu');
    p.close();
  });

  it('keeps a secret OFF the terminal', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const seen: string[] = [];
    output.on('data', (c: Buffer) => seen.push(c.toString()));
    const p = createStdioPrompter(input as never, output);
    const answer = p.ask({ text: 'key: ', secret: true });
    input.write('BSAsupersecretvalue0001\n');
    expect(await answer).toBe('BSAsupersecretvalue0001');
    p.close();
    const printed = seen.join('');
    expect(printed).not.toContain('BSAsupersecretvalue0001');
    // The question itself still had to be visible.
    expect(printed).toContain('key:');
  });

  it('resolves null when the input closes — the abort signal', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const p = createStdioPrompter(input as never, output);
    const answer = p.ask({ text: 'q? ' });
    p.close();
    expect(await answer).toBeNull();
  });

  it('answers null after it is closed, instead of hanging', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const p = createStdioPrompter(input as never, output);
    p.close();
    expect(await p.ask({ text: 'q? ' })).toBeNull();
    // close() is idempotent.
    p.close();
  });
});

describe('isInteractiveStdin', () => {
  it('coerces the undefined a pipe reports into a real false', () => {
    // `stdin.isTTY` is `undefined` (not `false`) on a pipe. Returning that
    // straight through is the shape that made Ink throw on mount elsewhere in
    // this codebase, so the coercion is the assertion.
    const piped = { isTTY: undefined } as unknown as NodeJS.ReadStream;
    expect(isInteractiveStdin(piped)).toBe(false);
    const tty = { isTTY: true } as unknown as NodeJS.ReadStream;
    expect(isInteractiveStdin(tty)).toBe(true);
  });
});

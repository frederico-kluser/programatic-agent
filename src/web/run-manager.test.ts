import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  WebRunManager,
  applyResolverModel,
  applyTimeout,
  pickRunKey,
  runCredential,
  type RunSnapshot,
} from './run-manager.js';
import { findMissingKeysForProvider, findSpec, saveApiKey } from '../lib/api-key.js';
import type { Pipeline } from '../lib/types.js';

function setupRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'huu-rm-'));
  execSync('git init --initial-branch=main', { cwd: dir, encoding: 'utf8' });
  execSync('git config user.email "t@t.com" && git config user.name "t"', {
    cwd: dir,
    shell: '/bin/bash',
  });
  writeFileSync(join(dir, 'README.md'), '# init\n', 'utf8');
  writeFileSync(join(dir, '.gitignore'), '.huu-worktrees/\n', 'utf8');
  execSync('git add -A && git commit -m init', { cwd: dir, encoding: 'utf8' });
  return dir;
}

function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (pred()) {
        clearInterval(iv);
        resolve(true);
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(iv);
        resolve(false);
      }
    }, 5);
  });
}

describe('applyResolverModel', () => {
  const base: Pipeline = { name: 'p', steps: [{ name: 's', prompt: 'x', files: [] }] };

  it('pins integrationModelId from a non-empty conflict-resolver model', () => {
    const out = applyResolverModel(base, 'deepseek/deepseek-v4-pro');
    expect(out.integrationModelId).toBe('deepseek/deepseek-v4-pro');
    expect(out).not.toBe(base); // new object, original untouched
    expect(base.integrationModelId).toBeUndefined();
  });

  it('leaves the pipeline untouched (resolver inherits run model) when empty', () => {
    expect(applyResolverModel(base, undefined)).toBe(base);
    expect(applyResolverModel(base, '')).toBe(base);
    expect(applyResolverModel(base, '   ')).toBe(base);
  });

  it('trims the supplied model id', () => {
    expect(applyResolverModel(base, '  resolver-x  ').integrationModelId).toBe('resolver-x');
  });
});

describe('applyTimeout', () => {
  // The web launch "Max time per agent" field flows here via RunParams.timeoutMinutes:
  // one value caps every agent across the whole pipeline (both card timeouts).
  const base: Pipeline = { name: 'p', steps: [{ name: 's', prompt: 'x', files: [] }] };

  it('sets BOTH card timeouts from the per-agent minutes', () => {
    const out = applyTimeout(base, 15);
    expect(out.cardTimeoutMs).toBe(15 * 60_000);
    expect(out.singleFileCardTimeoutMs).toBe(15 * 60_000);
    expect(out).not.toBe(base); // new object, original untouched
    expect(base.cardTimeoutMs).toBeUndefined();
  });

  it('floors fractional minutes to whole milliseconds', () => {
    expect(applyTimeout(base, 1.5).cardTimeoutMs).toBe(90_000);
  });

  it('leaves the pipeline on its built-in default when no timeout is given', () => {
    expect(applyTimeout(base, undefined)).toBe(base);
    expect(applyTimeout(base, 0)).toBe(base);
    expect(applyTimeout(base, -5)).toBe(base);
  });
});

describe('WebRunManager — simulation', () => {
  it('drives a synthetic run to done over the same snapshot channel as a real run', async () => {
    const snaps: RunSnapshot[] = [];
    const chunks: Array<{ agentId: number }> = [];
    const mgr = new WebRunManager(
      process.cwd(),
      (s) => snaps.push(s),
      (_runId, c) => chunks.push(c),
    );

    const first = mgr.startSimulation({
      runId: 'sim-x',
      modelIds: ['openrouter/a'],
      fileCount: 4,
      concurrency: 2,
      tickMs: 1,
    });
    expect(first.phase).toBe('running');
    expect(first.pipelineName).toBeTruthy();
    // Sims report the server cwd as their project so the selector can label them.
    expect(first.runDirectory).toBe(process.cwd());
    expect(mgr.isActive()).toBe(true);

    const done = await waitFor(() => mgr.getSnapshot('sim-x').phase === 'done', 5000);
    expect(done).toBe(true);

    const final = mgr.getSnapshot('sim-x');
    expect(final.state).toBeTruthy();
    expect(final.state!.completedTasks).toBe(final.state!.totalTasks);
    expect(final.state!.totalTasks).toBeGreaterThan(0);
    expect(mgr.isActive()).toBe(false);
    // The firehose was relayed (no real LLM, but the stream is synthesized).
    expect(chunks.length).toBeGreaterThan(0);
    // Snapshots flowed through the throttle-less manager channel.
    expect(snaps.length).toBeGreaterThan(2);
  });
});

describe('WebRunManager — multi-run', () => {
  it('runs multiple simulations concurrently (no 409) and tracks each by runId', async () => {
    const mgr = new WebRunManager(process.cwd(), () => {});
    const a = mgr.startSimulation({ runId: 'sim-a', modelIds: [], fileCount: 3, concurrency: 1, tickMs: 1 });
    const b = mgr.startSimulation({ runId: 'sim-b', modelIds: [], fileCount: 3, concurrency: 1, tickMs: 1 });

    // Both accepted — no "already in progress" refusal.
    expect(a.runId).toBe('sim-a');
    expect(b.runId).toBe('sim-b');
    expect(a.phase).toBe('running');
    expect(b.phase).toBe('running');

    // Each is tracked independently, keyed by runId.
    expect(mgr.getSnapshots().map((s) => s.runId).sort()).toEqual(['sim-a', 'sim-b']);
    expect(mgr.getSnapshot('sim-a').runId).toBe('sim-a');
    expect(mgr.getSnapshot('sim-b').runId).toBe('sim-b');

    mgr.abort();
    expect(await waitFor(() => !mgr.isActive(), 3000)).toBe(true);
  });

  it('admits a new run while another is already in flight (add-to-queue while running)', async () => {
    // The backend guarantee the launch-view "add while running" feature relies
    // on: a run started AFTER another is already streaming is accepted (no
    // refusal) and driven to done automatically — no second user action.
    const mgr = new WebRunManager(process.cwd(), () => {});
    // A long first run, so it's demonstrably still going when we add the second.
    mgr.startSimulation({ runId: 'sim-first', modelIds: [], fileCount: 40, concurrency: 2, tickMs: 8 });
    expect(await waitFor(() => mgr.getSnapshot('sim-first').state != null, 3000)).toBe(true);
    expect(mgr.getSnapshot('sim-first').phase).toBe('running');

    // Add a second run mid-flight — accepted and tracked alongside the first.
    const late = mgr.startSimulation({ runId: 'sim-late', modelIds: [], fileCount: 4, concurrency: 2, tickMs: 4 });
    expect(late.phase).toBe('running');
    expect(mgr.getSnapshots().map((s) => s.runId).sort()).toEqual(['sim-first', 'sim-late']);

    // The late-added run reaches done on its own while the first still runs.
    expect(await waitFor(() => mgr.getSnapshot('sim-late').phase === 'done', 5000)).toBe(true);
    expect(mgr.getSnapshot('sim-first').phase).toBe('running');

    mgr.abort();
    expect(await waitFor(() => !mgr.isActive(), 3000)).toBe(true);
  });

  it('aborts one run by runId, leaving the other running', async () => {
    const mgr = new WebRunManager(process.cwd(), () => {});
    // Long sims so the survivor is still running after we kill the other.
    mgr.startSimulation({ runId: 'sim-keep', modelIds: [], fileCount: 60, concurrency: 1, tickMs: 25 });
    mgr.startSimulation({ runId: 'sim-kill', modelIds: [], fileCount: 60, concurrency: 1, tickMs: 25 });

    mgr.abort('sim-kill');
    expect(await waitFor(() => mgr.getSnapshot('sim-kill').phase !== 'running', 3000)).toBe(true);
    // The other run is untouched.
    expect(mgr.getSnapshot('sim-keep').phase).toBe('running');

    mgr.abort();
    expect(await waitFor(() => !mgr.isActive(), 3000)).toBe(true);
  });

  it('pause/abort are per-run-id and safe', async () => {
    const mgr = new WebRunManager(process.cwd(), () => {});
    mgr.startSimulation({ runId: 'sim-c', modelIds: [], fileCount: 6, concurrency: 2, tickMs: 1 });
    mgr.setPaused('sim-c', true);
    mgr.setPaused('sim-c', false);
    mgr.setPaused('sim-unknown', true); // no-op for unknown id
    mgr.abort('sim-c');
    expect(await waitFor(() => !mgr.isActive(), 2000)).toBe(true);
  });
});

describe('WebRunManager — lazy admission (real stub runs)', () => {
  const repos: string[] = [];
  afterEach(() => {
    for (const d of repos.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort temp cleanup */
      }
    }
  });

  const trivial: Pipeline = { name: 'p', steps: [{ name: 's', prompt: 'x', files: [] }] };

  it('admits the first run immediately and QUEUES the rest (server-paced, not all-at-once)', async () => {
    const dirA = setupRepo();
    const dirB = setupRepo();
    repos.push(dirA, dirB);

    const mgr = new WebRunManager(process.cwd(), () => {});

    // Two runs dispatched back-to-back (as the web client does for a queue).
    const r1 = mgr.start({
      pipeline: trivial,
      backend: 'stub',
      modelId: 'stub-model',
      runDirectory: dirA,
    });
    const r2 = mgr.start({
      pipeline: trivial,
      backend: 'stub',
      modelId: 'stub-model',
      runDirectory: dirB,
    });

    // The FIRST is admitted immediately; the SECOND waits in the queue — the
    // server paces them instead of spawning both at once (the OOM fix).
    expect(r1.phase).toBe('running');
    expect(r2.phase).toBe('queued');

    // Both still drain to a terminal phase (the queue never deadlocks).
    expect(
      await waitFor(() => {
        const s1 = mgr.getSnapshot(r1.runId).phase;
        const s2 = mgr.getSnapshot(r2.runId).phase;
        return (s1 === 'done' || s1 === 'error') && (s2 === 'done' || s2 === 'error');
      }, 30000),
    ).toBe(true);

    mgr.abort();
    expect(await waitFor(() => !mgr.isActive(), 5000)).toBe(true);
  }, 30000);
});

describe('pickRunKey (web run key precedence)', () => {
  // Hermetic: pickRunKey's third tier is the disk/env resolver — sandbox the
  // ambient env + point the store at a tmpdir so the user's real key never
  // leaks into (or out of) the assertions.
  const TRACKED = [
    'OPENROUTER_API_KEY',
    'OPENROUTER_API_KEY_FILE',
    'XDG_CONFIG_HOME',
    'HUU_CONFIG_DIR',
  ] as const;
  const saved: Record<string, string | undefined> = {};
  let cfgHome: string;

  beforeEach(() => {
    for (const k of TRACKED) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    cfgHome = mkdtempSync(join(tmpdir(), 'huu-pickkey-'));
    process.env.XDG_CONFIG_HOME = cfgHome;
  });

  afterEach(() => {
    for (const k of TRACKED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(cfgHome, { recursive: true, force: true });
  });

  it('the key the browser sent with the run wins over everything', () => {
    const spec = findSpec('openrouter')!;
    saveApiKey(spec, 'sk-or-stored');
    process.env.OPENROUTER_API_KEY = 'sk-or-env';
    expect(pickRunKey('sk-or-request', 'sk-or-options', spec)).toEqual({
      value: 'sk-or-request',
      source: 'request',
      storedOverridesEnv: false,
    });
  });

  it('a key saved via web Options beats the disk/env resolver', () => {
    const spec = findSpec('openrouter')!;
    saveApiKey(spec, 'sk-or-stored');
    process.env.OPENROUTER_API_KEY = 'sk-or-env';
    expect(pickRunKey(undefined, 'sk-or-options', spec)).toEqual({
      value: 'sk-or-options',
      source: 'options',
      storedOverridesEnv: false,
    });
    expect(pickRunKey('   ', 'sk-or-options', spec).source).toBe('options');
  });

  it('falls back to the resolver: stored outranks env and flags the override', () => {
    const spec = findSpec('openrouter')!;
    saveApiKey(spec, 'sk-or-stored');
    process.env.OPENROUTER_API_KEY = 'sk-or-env';
    expect(pickRunKey(undefined, undefined, spec)).toEqual({
      value: 'sk-or-stored',
      source: 'stored',
      storedOverridesEnv: true,
    });
  });

  it('env is the last tier; no spec (or nothing set) → none', () => {
    const spec = findSpec('openrouter')!;
    process.env.OPENROUTER_API_KEY = 'sk-or-env';
    expect(pickRunKey(undefined, undefined, spec)).toMatchObject({
      value: 'sk-or-env',
      source: 'env',
    });
    delete process.env.OPENROUTER_API_KEY;
    expect(pickRunKey(undefined, undefined, spec)).toMatchObject({ value: '', source: 'none' });
    expect(pickRunKey(undefined, undefined, undefined)).toEqual({
      value: '',
      source: 'none',
      storedOverridesEnv: false,
    });
  });
});

/**
 * THE BLOCK, pinned. The reviewer's matrix, executed at the REAL web gate.
 *
 * Before this fix the credential came from `selectBackend(backend).apiKeySpecName`
 * — hard-coded `'deepseek'` — so `params.provider` was accepted, stored for
 * display, and then ignored. Three cells were wrong at once:
 *   · only OPENROUTER_API_KEY + provider openrouter → REFUSED ("jcode needs an
 *     API key"), holding a perfectly good key;
 *   · only DEEPSEEK_API_KEY + provider openrouter → ACCEPTED and run against
 *     DeepSeek, silently ignoring the user's choice;
 *   · the AppConfig handed to the orchestrator carried no provider at all.
 */
describe('the provider decides the credential (web run gate)', () => {
  const TRACKED = [
    'DEEPSEEK_API_KEY',
    'DEEPSEEK_API_KEY_FILE',
    'OPENROUTER_API_KEY',
    'OPENROUTER_API_KEY_FILE',
    'XDG_CONFIG_HOME',
    'HUU_CONFIG_DIR',
  ] as const;
  const saved: Record<string, string | undefined> = {};
  let cfgHome: string;

  beforeEach(() => {
    for (const k of TRACKED) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    cfgHome = mkdtempSync(join(tmpdir(), 'huu-runcred-'));
    process.env.XDG_CONFIG_HOME = cfgHome;
  });
  afterEach(() => {
    for (const k of TRACKED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(cfgHome, { recursive: true, force: true });
  });

  it('names the OpenRouter spec for an OpenRouter run and the DeepSeek spec for a DeepSeek run', () => {
    // MUTATION KILLED: `runCredential` going back to
    // `selectBackend(backend).apiKeySpecName` (or to any backend-keyed
    // lookup). Both providers share the `jcode` backend, so a backend-keyed
    // answer is identical for both — this assertion separates them.
    expect(runCredential('jcode', 'openrouter').spec?.envVar).toBe('OPENROUTER_API_KEY');
    expect(runCredential('jcode', 'deepseek').spec?.envVar).toBe('DEEPSEEK_API_KEY');
    // A backend that serves no provider spends no credential.
    expect(runCredential('stub').spec).toBeUndefined();
    expect(runCredential('stub').provider).toBeUndefined();
    // No pick → the backend's first provider, never "both" and never "none".
    expect(runCredential('jcode').provider).toBe('deepseek');
  });

  it('only OPENROUTER_API_KEY: an OpenRouter run resolves a key and never asks for DEEPSEEK_API_KEY', () => {
    // The exact state of the machine that triggered the BLOCK.
    process.env.OPENROUTER_API_KEY = 'sk-or-only-this-one';
    const { provider, spec } = runCredential('jcode', 'openrouter');
    expect(provider).toBe('openrouter');
    expect(spec?.envVar).toBe('OPENROUTER_API_KEY');
    // These two calls ARE what `WebRunManager.start` does, in this order.
    const picked = pickRunKey(undefined, undefined, spec);
    expect(picked.value).toBe('sk-or-only-this-one');
    expect(picked.source).toBe('env');
    // Nothing in the chain names the other provider's variable.
    expect(spec?.envVar).not.toBe('DEEPSEEK_API_KEY');
    expect(findMissingKeysForProvider('openrouter')).toEqual([]);
  });

  it('only DEEPSEEK_API_KEY: an OpenRouter run is REFUSED, not silently run as DeepSeek', async () => {
    // MUTATION KILLED: falling back to the backend's default provider when
    // `params.provider` names one whose key is missing. That fallback is the
    // silent-substitution bug — the user picks OpenRouter, pays DeepSeek.
    process.env.DEEPSEEK_API_KEY = 'sk-deepseek-only';
    const { spec } = runCredential('jcode', 'openrouter');
    expect(spec?.envVar).toBe('OPENROUTER_API_KEY');
    expect(pickRunKey(undefined, undefined, spec).value).toBe('');

    const dir = setupRepo();
    try {
      const mgr = new WebRunManager(dir, () => {});
      const pipeline: Pipeline = { name: 'p', steps: [{ name: 's', prompt: 'x', files: [] }] };
      // The refusal happens BEFORE any orchestrator is constructed, so this
      // never spawns an agent.
      expect(() =>
        mgr.start({
          pipeline,
          pipelineName: 'p',
          backend: 'jcode',
          provider: 'openrouter',
          modelId: 'anthropic/claude-sonnet-4',
        }),
      ).toThrow(/OpenRouter/i);
      // And the same run with the provider the key belongs to is NOT refused
      // for a credential reason — proof the refusal is about the PROVIDER, not
      // about the run being unlaunchable in this environment.
      expect(runCredential('jcode', 'deepseek').spec?.envVar).toBe('DEEPSEEK_API_KEY');
      expect(pickRunKey(undefined, undefined, runCredential('jcode', 'deepseek').spec).value).toBe(
        'sk-deepseek-only',
      );
      mgr.abort();
      await waitFor(() => !mgr.isActive(), 3000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  it('no key at all: each provider asks for ITS OWN variable, never for both', () => {
    expect(findMissingKeysForProvider('deepseek').map((s) => s.envVar)).toEqual([
      'DEEPSEEK_API_KEY',
    ]);
    expect(findMissingKeysForProvider('openrouter').map((s) => s.envVar)).toEqual([
      'OPENROUTER_API_KEY',
    ]);
  });
});

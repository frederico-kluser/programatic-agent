import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createWebServer } from './server.js';
import type { KeyValidation } from './api-data.js';
import type { WebRunManager } from './run-manager.js';
import type { Pipeline } from '../lib/types.js';

// ── The provider-validation seam ─────────────────────────────────────────
//
// `validateKeyValue` is api-data's business, and it is provider-shaped: it
// probes whatever the credential belongs to. What THIS file owns is the
// SERVER's validate-then-persist policy — a key the provider REJECTS answers
// 400, carries the httpStatus, and never reaches the store — and that policy
// is only observable when the verdict can be dictated. So the seam is stubbed
// here (the same technique dev-manager.test.ts uses on the manager -> driver
// seam), which also keeps these tests hermetic without guessing a provider's
// probe URL. `seam.validation = null` (the default, restored after every
// test) delegates to the REAL implementation, so nothing else in this file is
// mocked.
const seam = vi.hoisted(() => ({ validation: null as KeyValidation | null }));
vi.mock('./api-data.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./api-data.js')>();
  return {
    ...mod,
    validateKeyValue: async (
      spec: Parameters<typeof mod.validateKeyValue>[0],
      value: string,
      opts?: Parameters<typeof mod.validateKeyValue>[2],
    ): Promise<KeyValidation> => seam.validation ?? mod.validateKeyValue(spec, value, opts),
  };
});

function setupRepo(dir: string): void {
  execSync('git init --initial-branch=main', { cwd: dir, encoding: 'utf8' });
  execSync('git config user.email "t@t.com" && git config user.name "t"', {
    cwd: dir,
    shell: '/bin/bash',
  });
  writeFileSync(join(dir, 'README.md'), '# init\n', 'utf8');
  writeFileSync(join(dir, '.gitignore'), '.huu-worktrees/\n.huu/\n', 'utf8');
  execSync('git add -A && git commit -m init', { cwd: dir, encoding: 'utf8' });
}

const PIPELINE: Pipeline = {
  name: 'web-test-pipe',
  steps: [
    {
      type: 'work',
      name: 'Write note',
      prompt: 'Write a short note file.',
      files: [],
      scope: 'project',
    },
  ],
};

async function listenEphemeral(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe('web server', () => {
  let repo: string;
  let server: Server;
  let manager: WebRunManager;
  let base: string;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'huu-web-'));
    setupRepo(repo);
    ({ server, manager } = createWebServer({
      cwd: repo,
      defaultAutoScale: true,
      initialPipeline: PIPELINE,
    }));
    base = await listenEphemeral(server);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(repo, { recursive: true, force: true });
  });

  it('serves the SPA shell at / with the right content type', async () => {
    const res = await fetch(base + '/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('huu');
    expect(html).toContain('app.js');
  });

  it('serves static client assets', async () => {
    for (const [path, ct] of [
      ['/app.js', 'javascript'],
      ['/styles.css', 'css'],
      ['/favicon.svg', 'svg'],
    ] as const) {
      const res = await fetch(base + path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type'), path).toContain(ct);
    }
  });

  it('answers /api/health', async () => {
    const res = await fetch(base + '/api/health');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.name).toBe('huu');
  });

  it('bootstrap lists backends, defaults, and the preloaded pipeline', async () => {
    const json = await (await fetch(base + '/api/bootstrap')).json();
    expect(Array.isArray(json.backends)).toBe(true);
    expect(json.backends.some((b: { id: string }) => b.id === 'jcode')).toBe(true);
    expect(json.backends.some((b: { id: string }) => b.id === 'stub')).toBe(true);
    expect(json.initialPipeline).toBe('web-test-pipe');
    // Multi-run bootstrap returns a runs[] array (empty before any run starts).
    expect(json.runs).toEqual([]);
  });

  it('serves the model catalog for a backend and 400s on an unknown one', async () => {
    // The LIVE OpenRouter catalog died with the pi backend: DeepSeek exposes no
    // public /models endpoint, so `listModelsForBackend` now serves the static
    // recommended catalog and must NEVER touch the network — a re-introduced
    // fetch here would hang the picker of an offline (or VPN'd) user. Watch
    // every non-localhost call instead of stubbing one host, so a probe to ANY
    // provider trips this.
    const realFetch = globalThis.fetch;
    const external = vi.fn();
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const u =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;
      if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(u)) external(u);
      return realFetch(input, init);
    });
    try {
      const ok = await fetch(base + '/api/models?backend=jcode');
      expect(ok.status).toBe(200);
      const body = await ok.json();
      expect(body.source).toBe('recommended');
      expect(body.models.length).toBeGreaterThan(0);
      // Every entry carries the capability annotations the picker badges.
      expect(body.models[0]).toMatchObject({ id: expect.any(String), label: expect.any(String) });
      expect(external).not.toHaveBeenCalled();

      const bad = await fetch(base + '/api/models?backend=nope');
      expect(bad.status).toBe(400);
      // `pi` USED to be a backend kind. It is not one any more, so it must 400
      // like any other unknown id instead of quietly serving a default catalog.
      expect((await fetch(base + '/api/models?backend=pi')).status).toBe(400);
    } finally {
      spy.mockRestore();
    }
  });

  it('reports stub needs no key', async () => {
    const json = await (await fetch(base + '/api/keys?backend=stub')).json();
    expect(json.ok).toBe(true);
    expect(json.missing).toEqual([]);
  });

  it('opens an SSE stream and replays a frame immediately', async () => {
    const res = await fetch(base + '/events');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain('data:');
    await reader.cancel();
  });

  it('streams live agent output as agent-stream SSE frames AND into the run log', async () => {
    // Open the firehose BEFORE the run so we catch frames from the first delta.
    const sse = await fetch(base + '/events');
    const reader = sse.body!.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    const readFrames = async (): Promise<Record<string, unknown>[]> => {
      const { value, done } = await reader.read();
      if (done) return [];
      pending += decoder.decode(value, { stream: true });
      const out: Record<string, unknown>[] = [];
      let sep: number;
      while ((sep = pending.indexOf('\n\n')) !== -1) {
        const block = pending.slice(0, sep);
        pending = pending.slice(sep + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try {
            out.push(JSON.parse(line.slice(5).trim()));
          } catch {
            /* keep-alive comment or partial — ignore */
          }
        }
      }
      return out;
    };

    await fetch(base + '/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pipelineName: 'web-test-pipe', backend: 'stub', modelId: 'stub' }),
    });

    // Read frames until the stub's first assistant line surfaces on the firehose.
    const deadline = Date.now() + 25_000;
    let assistant: Record<string, unknown> | undefined;
    const channels = new Set<string>();
    while (!assistant && Date.now() < deadline) {
      const frames = await readFrames();
      for (const f of frames) {
        if (f.type !== 'agent-stream') continue;
        channels.add(String(f.channel));
        if (f.channel === 'assistant') assistant = f;
      }
    }
    await reader.cancel();

    expect(assistant, 'never received an assistant agent-stream frame').toBeDefined();
    expect(String(assistant!.text)).toMatch(/simulating LLM call/);
    expect(typeof assistant!.agentId).toBe('number');
    // The thinking channel is mirrored to the firehose too (console-only).
    expect(channels.has('thinking')).toBe(true);

    // Same assistant line must also have advanced the visible run log (request #1):
    // not just the console firehose (request #2).
    const logs = manager.getSnapshot().state?.logs ?? [];
    expect(logs.some((l) => /simulating LLM call/.test(l.message))).toBe(true);

    manager.abort();
  }, 30_000);

  it('drives a full stub run from POST /api/run to done', async () => {
    const res = await fetch(base + '/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pipelineName: 'web-test-pipe',
        backend: 'stub',
        modelId: 'stub',
      }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);

    // Poll the manager until the run settles (or time out).
    const deadline = Date.now() + 25_000;
    let phase = manager.getSnapshot().phase;
    while ((phase === 'running' || phase === 'idle') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
      phase = manager.getSnapshot().phase;
    }
    const snap = manager.getSnapshot();
    expect(phase, snap.errorReason ?? 'no error reason').toBe('done');
    expect(snap.state).not.toBeNull();
    // The snapshot carries the project directory it ran in (defaults to cwd),
    // so the client can label the run selector by project, not just pipeline.
    expect(snap.runDirectory).toBe(repo);
  }, 30_000);

  it('validates POST /api/run/retry and no-ops an unknown run', async () => {
    // Missing/invalid agentId is a 400.
    const bad = await fetch(base + '/api/run/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: 'nope' }),
    });
    expect(bad.status).toBe(400);

    // Well-formed payload for an unknown run id is accepted as a silent no-op
    // (the run may have already finalized) — never a 500.
    const ok = await fetch(base + '/api/run/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: 'nope', agentId: 1, timeoutMinutes: 7 }),
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).ok).toBe(true);
  });

  it('accepts POST /api/run/finish for any run id', async () => {
    const res = await fetch(base + '/api/run/finish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: 'nope' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it('accepts conflictResolverModelId on POST /api/run and starts the run', async () => {
    const res = await fetch(base + '/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pipelineName: 'web-test-pipe',
        backend: 'stub',
        modelId: 'stub',
        conflictResolverModelId: 'deepseek/deepseek-v4-pro',
      }),
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.run.runId).toBeTruthy();
    manager.abort();
  }, 30_000);

  it('accepts concurrent runs (no 409) and tracks each by a distinct runId', async () => {
    const post = (): Promise<Response> =>
      fetch(base + '/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pipelineName: 'web-test-pipe', backend: 'stub', modelId: 'stub' }),
      });
    const [r1, r2] = await Promise.all([post(), post()]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const j1 = await r1.json();
    const j2 = await r2.json();
    expect(j1.run.runId).toBeTruthy();
    expect(j2.run.runId).toBeTruthy();
    expect(j1.run.runId).not.toBe(j2.run.runId);
    // The serialized snapshot exposes the run directory for the project selector.
    expect(j1.run.runDirectory).toBe(repo);
    expect(j2.run.runDirectory).toBe(repo);
    // Both runs are tracked by the manager (same repo → repo-lock serializes git).
    const ids = manager.getSnapshots().map((s) => s.runId);
    expect(ids).toContain(j1.run.runId);
    expect(ids).toContain(j2.run.runId);
    manager.abort();
  }, 30_000);

  it('keeps the run alive when the browser (SSE) disconnects — closing the site never aborts', async () => {
    // Start a stub run. Stub agents sleep 2–5s, so the run stays active well
    // past the disconnect below — the assertion can't race the run settling.
    await fetch(base + '/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pipelineName: 'web-test-pipe', backend: 'stub', modelId: 'stub' }),
    });
    expect(manager.isActive()).toBe(true);

    // Open the SSE stream (a "browser"), read its first replayed frame, then
    // drop the connection — exactly what closing the tab does.
    const sse = await fetch(base + '/events');
    const reader = sse.body!.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 150)); // let req 'close' land server-side

    // The run lives in the server process, not the browser: disconnect ≠ abort.
    expect(manager.isActive()).toBe(true);
    // A freshly reopened page re-syncs to the still-running run. Bootstrap
    // reports every tracked run under `runs[]` (multi-run); the stub run we
    // started must still be in there as 'running'.
    const boot = await (await fetch(base + '/api/bootstrap')).json();
    expect(boot.runs.some((r: { phase: string }) => r.phase === 'running')).toBe(true);

    manager.abort();
  });

  it('404s unknown API routes and missing assets', async () => {
    expect((await fetch(base + '/api/nope')).status).toBe(404);
    expect((await fetch(base + '/does-not-exist.js')).status).toBe(404);
  });

  it('configures SSE-safe HTTP timeouts (request-receipt timer off, slowloris guard on)', () => {
    // Node's default 5-minute requestTimeout must never sit under the
    // long-lived /events stream; the client watchdog is the primary defense,
    // this is the belt.
    expect(server.requestTimeout).toBe(0);
    expect(server.headersTimeout).toBe(60_000);
  });
});

describe('web server — SSE heartbeat', () => {
  let repo: string;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'huu-web-hb-'));
    setupRepo(repo);
    // Injectable interval so the test observes a ping in milliseconds, not 25 s.
    ({ server } = createWebServer({ cwd: repo, defaultAutoScale: true, heartbeatMs: 40 }));
    base = await listenEphemeral(server);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(repo, { recursive: true, force: true });
  });

  it('emits the keep-alive as a REAL `event: ping` frame, not an invisible comment', async () => {
    // An SSE comment (`: ping`) never reaches the browser's EventSource API,
    // which is why the client could not tell a quiet stream from a dead one.
    // The heartbeat must be a named event the client watchdog can observe.
    const res = await fetch(base + '/events');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const deadline = Date.now() + 2_000;
    while (!text.includes('event: ping') && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
    expect(text).toContain('event: ping');
    expect(text).not.toContain('\n: ping'); // the old comment form is gone
  });
});

describe('web server token gate', () => {
  let repo: string;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'huu-web-tok-'));
    setupRepo(repo);
    ({ server } = createWebServer({ cwd: repo, defaultAutoScale: true, token: 'sekret' }));
    base = await listenEphemeral(server);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(repo, { recursive: true, force: true });
  });

  it('serves the shell without a token but gates /api', async () => {
    expect((await fetch(base + '/')).status).toBe(200);
    expect((await fetch(base + '/api/bootstrap')).status).toBe(401);
    expect((await fetch(base + '/api/bootstrap?token=sekret')).status).toBe(200);
    const viaHeader = await fetch(base + '/api/bootstrap', {
      headers: { 'x-huu-token': 'sekret' },
    });
    expect(viaHeader.status).toBe(200);
  });
});

describe('web server — machine-global settings (/api/settings)', () => {
  let repo: string;
  let cfgHome: string;
  let server: Server;
  let base: string;
  let savedXdg: string | undefined;

  beforeEach(async () => {
    // Hermetic settings location: webSettingsPath() honors XDG_CONFIG_HOME, so
    // the test never touches the user's real ~/.config/huu.
    savedXdg = process.env.XDG_CONFIG_HOME;
    cfgHome = mkdtempSync(join(tmpdir(), 'huu-web-cfg-'));
    process.env.XDG_CONFIG_HOME = cfgHome;
    repo = mkdtempSync(join(tmpdir(), 'huu-web-'));
    setupRepo(repo);
    ({ server } = createWebServer({
      cwd: repo,
      defaultAutoScale: true,
      initialPipeline: PIPELINE,
    }));
    base = await listenEphemeral(server);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(repo, { recursive: true, force: true });
    rmSync(cfgHome, { recursive: true, force: true });
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
  });

  it('POST /api/settings applies + persists the dial and echoes the effective value', async () => {
    const res = await fetch(base + '/api/settings', {
      method: 'POST',
      body: JSON.stringify({ ramPercent: 50 }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; ramPercent: number };
    expect(json.ok).toBe(true);
    expect(json.ramPercent).toBe(50);

    // Persisted server-side…
    const onDisk = JSON.parse(
      readFileSync(join(cfgHome, 'huu', 'web-settings.json'), 'utf8'),
    ) as { ramPercent: number };
    expect(onDisk.ramPercent).toBe(50);

    // …and read back by bootstrap (the ⚙ modal's source of truth).
    const boot = (await (await fetch(base + '/api/bootstrap')).json()) as {
      settings: { ramPercent: number };
    };
    expect(boot.settings.ramPercent).toBe(50);
  });

  it('clamps out-of-range dials and clears the override on null', async () => {
    const over = (await (
      await fetch(base + '/api/settings', {
        method: 'POST',
        body: JSON.stringify({ ramPercent: 999 }),
      })
    ).json()) as { ramPercent: number };
    expect(over.ramPercent).toBe(95);

    const cleared = (await (
      await fetch(base + '/api/settings', {
        method: 'POST',
        body: JSON.stringify({ ramPercent: null }),
      })
    ).json()) as { ramPercent: number };
    expect(cleared.ramPercent).toBe(70); // env unset in tests → default
  });

  it('POST /api/run no longer honors a body ramPercent (settings own the dial)', async () => {
    // Regression for the silent-85% hole: a run POST carrying ramPercent must
    // not change the effective setting.
    await fetch(base + '/api/settings', {
      method: 'POST',
      body: JSON.stringify({ ramPercent: 40 }),
    });
    await fetch(base + '/api/run', {
      method: 'POST',
      body: JSON.stringify({
        backend: 'stub',
        pipelineName: 'web-test-pipe',
        modelId: 'stub',
        ramPercent: 90,
        runDirectory: repo,
      }),
    }).then((r) => r.json());
    const boot = (await (await fetch(base + '/api/bootstrap')).json()) as {
      settings: { ramPercent: number };
    };
    expect(boot.settings.ramPercent).toBe(40);
  });
});

describe('web server — DeepSeek key management (⚙ Options)', () => {
  let repo: string;
  let cfgHome: string;
  let server: Server;
  let base: string;
  // Hermetic: the key store honors XDG_CONFIG_HOME (and HUU_CONFIG_DIR would
  // override it), and the status endpoint reads the ambient env var — sandbox
  // all of them so the suite never touches the user's real key.
  const TRACKED = [
    'XDG_CONFIG_HOME',
    'HUU_CONFIG_DIR',
    'DEEPSEEK_API_KEY',
    'DEEPSEEK_API_KEY_FILE',
  ] as const;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const k of TRACKED) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    cfgHome = mkdtempSync(join(tmpdir(), 'huu-web-cfg-'));
    process.env.XDG_CONFIG_HOME = cfgHome;
    repo = mkdtempSync(join(tmpdir(), 'huu-web-'));
    setupRepo(repo);
    ({ server } = createWebServer({ cwd: repo, defaultAutoScale: true, initialPipeline: PIPELINE }));
    base = await listenEphemeral(server);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(repo, { recursive: true, force: true });
    rmSync(cfgHome, { recursive: true, force: true });
    for (const k of TRACKED) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('status → save → status → clear round-trip (masked, never the raw value)', async () => {
    // Nothing anywhere yet.
    let st = (await (await fetch(base + '/api/keys/status?name=deepseek')).json()) as Record<
      string,
      unknown
    >;
    expect(st).toMatchObject({ name: 'deepseek', source: 'none', masked: null });

    // Ambient env var → the fallback tier.
    process.env.DEEPSEEK_API_KEY = 'sk-ds-envkey-12345678';
    st = (await (await fetch(base + '/api/keys/status?name=deepseek')).json()) as Record<
      string,
      unknown
    >;
    expect(st.source).toBe('env');
    expect(st.masked).toBe('sk-ds-…5678');
    expect(st.envPresent).toBe(true);

    // Save via POST /api/keys: persisted to the config store AND registered as
    // the live in-session override — the status flips to 'options'.
    const save = await fetch(base + '/api/keys', {
      method: 'POST',
      body: JSON.stringify({ name: 'deepseek', value: 'sk-ds-saved-abcdefgh' }),
    });
    expect(save.status).toBe(200);
    expect((await save.json()) as Record<string, unknown>).toMatchObject({
      ok: true,
      masked: 'sk-ds-…efgh',
    });
    const onDisk = JSON.parse(readFileSync(join(cfgHome, 'huu', 'config.json'), 'utf8')) as {
      deepseek: string;
    };
    expect(onDisk.deepseek).toBe('sk-ds-saved-abcdefgh');
    st = (await (await fetch(base + '/api/keys/status?name=deepseek')).json()) as Record<
      string,
      unknown
    >;
    expect(st.source).toBe('options');
    expect(st.masked).toBe('sk-ds-…efgh');
    expect(JSON.stringify(st)).not.toContain('sk-ds-saved-abcdefgh'); // masked only

    // Clear: store entry removed + override dropped → env is the fallback again.
    const del = (await (
      await fetch(base + '/api/keys?name=deepseek', { method: 'DELETE' })
    ).json()) as Record<string, unknown>;
    expect(del).toMatchObject({ ok: true, cleared: true, fallback: 'env' });
    st = (await (await fetch(base + '/api/keys/status?name=deepseek')).json()) as Record<
      string,
      unknown
    >;
    expect(st.source).toBe('env');
    expect(st.masked).toBe('sk-ds-…5678');
  });

  it('rejects unknown spec names on status/save/clear', async () => {
    expect((await fetch(base + '/api/keys/status?name=nope')).status).toBe(400);
    expect((await fetch(base + '/api/keys?name=nope', { method: 'DELETE' })).status).toBe(400);
    const post = await fetch(base + '/api/keys', {
      method: 'POST',
      body: JSON.stringify({ name: 'nope', value: 'x' }),
    });
    expect(post.status).toBe(400);
  });
});

describe('web server — key POOL endpoints (⚙ Settings, multi-key rotation)', () => {
  let repo: string;
  let cfgHome: string;
  let server: Server;
  let base: string;
  // Same sandbox as the single-key suite: the pool lives in the very same
  // config store, so a leak here would rewrite the user's real key file.
  const TRACKED = [
    'XDG_CONFIG_HOME',
    'HUU_CONFIG_DIR',
    'DEEPSEEK_API_KEY',
    'DEEPSEEK_API_KEY_FILE',
  ] as const;
  const savedEnv: Record<string, string | undefined> = {};
  /** What the provider says about a key — driven through the seam at the top. */
  const provider = (validation: KeyValidation): void => {
    seam.validation = validation;
  };

  beforeEach(async () => {
    for (const k of TRACKED) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    cfgHome = mkdtempSync(join(tmpdir(), 'huu-web-pool-'));
    process.env.XDG_CONFIG_HOME = cfgHome;
    repo = mkdtempSync(join(tmpdir(), 'huu-web-'));
    setupRepo(repo);

    // Hermetic validate-then-persist: the pool endpoints run their REAL
    // validation branch, with the provider's verdict dictated instead of
    // fetched. A key the provider accepts is the default.
    provider({ status: 'valid' });

    ({ server } = createWebServer({ cwd: repo, defaultAutoScale: true, initialPipeline: PIPELINE }));
    base = await listenEphemeral(server);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    seam.validation = null;
    rmSync(repo, { recursive: true, force: true });
    rmSync(cfgHome, { recursive: true, force: true });
    for (const k of TRACKED) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  const getPool = async (name = 'deepseek'): Promise<any> =>
    (await fetch(`${base}/api/keys/pool?name=${name}`)).json();

  const addKey = async (value: string): Promise<{ status: number; json: any }> => {
    const res = await fetch(base + '/api/keys/pool', {
      method: 'POST',
      body: JSON.stringify({ name: 'deepseek', value }),
    });
    return { status: res.status, json: await res.json() };
  };

  it('lists an empty pool and mirrors a legacy single key as a pool of one', async () => {
    let pool = await getPool();
    expect(pool).toMatchObject({ name: 'deepseek', current: 0, keys: [] });
    expect(typeof pool.label).toBe('string');
    expect(typeof pool.source).toBe('string');

    // The legacy flat field is the whole backwards-compat contract: an older
    // config (or an older huu writing one) must read back as a usable pool.
    await fetch(base + '/api/keys', {
      method: 'POST',
      body: JSON.stringify({ name: 'deepseek', value: 'sk-ds-legacy-11112222' }),
    });
    pool = await getPool();
    expect(pool.keys).toHaveLength(1);
    expect(pool.keys[0]).toMatchObject({ index: 0, masked: 'sk-ds-…2222', state: 'active' });
  });

  it('POST validates BEFORE persisting and NEVER returns a key value', async () => {
    const first = await addKey('sk-ds-poolkey-aaaabbbb');
    expect(first.status).toBe(200);
    expect(first.json.ok).toBe(true);
    // The verdict the provider gave is echoed back — the client badges it.
    expect(first.json.validation).toEqual({ status: 'valid' });
    expect(first.json.keys).toHaveLength(1);
    expect(first.json.keys[0].masked).toBe('sk-ds-…bbbb');
    // The raw value must not appear ANYWHERE in the payload.
    expect(JSON.stringify(first.json)).not.toContain('sk-ds-poolkey-aaaabbbb');

    const second = await addKey('sk-ds-poolkey-ccccdddd');
    expect(second.json.keys.map((k: { masked: string }) => k.masked)).toEqual([
      'sk-ds-…bbbb',
      'sk-ds-…dddd',
    ]);

    // The compatibility mirror: keys[0] is written back to the flat field so an
    // older huu sharing the same HUU_CONFIG_DIR still finds a usable key.
    const onDisk = JSON.parse(readFileSync(join(cfgHome, 'huu', 'config.json'), 'utf8')) as {
      deepseek: string;
      _pools: { deepseek: { keys: string[] } };
    };
    expect(onDisk.deepseek).toBe('sk-ds-poolkey-aaaabbbb');
    expect(onDisk._pools.deepseek.keys).toHaveLength(2);
  });

  // A provider with no cheap probe (DeepSeek today) answers `unverifiable`.
  // Policy: accepted WITH the reason echoed back, never hard-blocked — an
  // offline user must still be able to save the key they just pasted.
  it('an unverifiable key is still accepted, with the reason echoed back', async () => {
    provider({ status: 'unverifiable', reason: 'no validator for this key' });
    const res = await addKey('sk-ds-unverified-77778888');
    expect(res.status).toBe(200);
    expect(res.json.validation).toEqual({
      status: 'unverifiable',
      reason: 'no validator for this key',
    });
    expect(res.json.keys).toHaveLength(1);
    expect(JSON.stringify(res.json)).not.toContain('sk-ds-unverified-77778888');
  });

  it('a key the provider rejects is a 400 CARRYING the httpStatus, and is never stored', async () => {
    provider({ status: 'invalid', httpStatus: 401 });
    const res = await fetch(base + '/api/keys/pool', {
      method: 'POST',
      body: JSON.stringify({ name: 'deepseek', value: 'sk-ds-rejected-99998888' }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { httpStatus: number; validation: { status: string } };
    // The status is what lets the client say "401 — check the key" instead of
    // a generic failure; it is the reason this is not a bare 400.
    expect(json.httpStatus).toBe(401);
    expect(json.validation.status).toBe('invalid');
    // Not even the refusal may carry the value back.
    expect(JSON.stringify(json)).not.toContain('sk-ds-rejected-99998888');

    expect((await getPool()).keys).toEqual([]);
  });

  it('DELETE removes by index and reindexes what is left', async () => {
    await addKey('sk-ds-first-11112222');
    await addKey('sk-ds-second-33334444');
    const del = await fetch(base + '/api/keys/pool?name=deepseek&index=0', { method: 'DELETE' });
    expect(del.status).toBe(200);
    const json = (await del.json()) as { keys: { index: number; masked: string }[] };
    expect(json.keys).toHaveLength(1);
    expect(json.keys[0]).toMatchObject({ index: 0, masked: 'sk-ds-…4444' });

    // A missing / non-numeric index is a 400, not a silent no-op.
    expect((await fetch(base + '/api/keys/pool?name=deepseek', { method: 'DELETE' })).status).toBe(400);
  });

  it('validate re-probes a STORED key, burning it on 401 — and reset clears that', async () => {
    await addKey('sk-ds-probe-55556666');

    provider({ status: 'invalid', httpStatus: 403 });
    const bad = (await (
      await fetch(base + '/api/keys/pool/validate', {
        method: 'POST',
        body: JSON.stringify({ name: 'deepseek', index: 0 }),
      })
    ).json()) as { validation: { status: string }; keys: { state: string; reason?: string }[] };
    expect(bad.validation.status).toBe('invalid');
    expect(bad.keys[0]!.state).toBe('burned');
    expect(bad.keys[0]!.reason).toBe('403');

    // reset clears the learned sidelining so the key rotates again.
    const reset = (await (
      await fetch(base + '/api/keys/pool/reset', {
        method: 'POST',
        body: JSON.stringify({ name: 'deepseek' }),
      })
    ).json()) as { keys: { state: string }[] };
    expect(reset.keys[0]!.state).toBe('active');

    // A successful re-probe also un-burns, so the user need not reset by hand.
    provider({ status: 'invalid', httpStatus: 401 });
    await fetch(base + '/api/keys/pool/validate', {
      method: 'POST',
      body: JSON.stringify({ name: 'deepseek', index: 0 }),
    });
    expect((await getPool()).keys[0].state).toBe('burned');
    provider({ status: 'valid' });
    const good = (await (
      await fetch(base + '/api/keys/pool/validate', {
        method: 'POST',
        body: JSON.stringify({ name: 'deepseek', index: 0 }),
      })
    ).json()) as { validation: { status: string }; keys: { state: string }[] };
    expect(good.validation.status).toBe('valid');
    expect(good.keys[0]!.state).toBe('active');
    // Nothing the endpoint returns ever carries the stored value.
    expect(JSON.stringify(good)).not.toContain('sk-ds-probe-55556666');
  });

  it('rejects unknown spec names and out-of-range indexes on every pool route', async () => {
    expect((await fetch(base + '/api/keys/pool?name=nope')).status).toBe(400);
    expect((await fetch(base + '/api/keys/pool?name=nope&index=0', { method: 'DELETE' })).status).toBe(400);
    for (const path of ['/api/keys/pool', '/api/keys/pool/reset', '/api/keys/pool/validate']) {
      const res = await fetch(base + path, {
        method: 'POST',
        body: JSON.stringify({ name: 'nope', value: 'x', index: 0 }),
      });
      expect(res.status, path).toBe(400);
    }
    // A well-known spec with nothing at that index is still a 400 (not a 500).
    const oob = await fetch(base + '/api/keys/pool/validate', {
      method: 'POST',
      body: JSON.stringify({ name: 'deepseek', index: 7 }),
    });
    expect(oob.status).toBe(400);
  });
});

describe('web server — dev-mode routing contract on /api/bootstrap', () => {
  let repo: string;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'huu-web-boot-'));
    setupRepo(repo);
    ({ server } = createWebServer({ cwd: repo, defaultAutoScale: true }));
    base = await listenEphemeral(server);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(repo, { recursive: true, force: true });
  });

  it('serves the presets and the role list the client must not hardcode', async () => {
    const boot = (await (await fetch(base + '/api/bootstrap')).json()) as {
      devModelPresets: Record<string, Record<string, string>>;
      devModelRoles: string[];
    };
    // The named presets, served from the same constant the compilers read.
    expect(Object.keys(boot.devModelPresets).sort()).toEqual([
      'hetero',
      'monoculture',
      'roster',
      'thrifty',
      'uniform',
    ]);
    // STILL A FLAT role → string MAP, and that is load-bearing: the browser
    // reads these values straight into text inputs and posts the same strings
    // back. A role that pins an endpoint says so with a `<provider>:` prefix
    // — the one shape that survives a JSON round trip through a plain string.
    for (const preset of Object.values(boot.devModelPresets)) {
      for (const value of Object.values(preset)) expect(typeof value).toBe('string');
    }
    // `hetero` is the default and its critic is deliberately cross-family —
    // which is only reachable through the aggregator, so it names it.
    expect(boot.devModelPresets.hetero!.critic).toBe('openrouter:moonshotai/kimi-k2.6');
    expect(boot.devModelPresets.hetero!.worker).toBe('deepseek/deepseek-v4-pro');
    // `uniform` routes nothing — it IS today's behavior.
    expect(boot.devModelPresets.uniform).toEqual({});
    expect(boot.devModelRoles).toEqual([
      'planner',
      'recon',
      'worker',
      'critic',
      'reporter',
      'judge',
      'integration',
    ]);
  });

  it('409s the resume and orphan gates when no session is waiting', async () => {
    for (const [path, body] of [
      ['/api/dev/resume', { accept: true }],
      ['/api/dev/orphans', { action: 'land' }],
    ] as const) {
      const res = await fetch(base + path, { method: 'POST', body: JSON.stringify(body) });
      expect(res.status, path).toBe(409);
      expect((await res.json()).error, path).toBeTruthy();
    }
  });
});

describe('web server — translation catalog (/api/i18n)', () => {
  let repo: string;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'huu-web-i18n-'));
    setupRepo(repo);
    ({ server } = createWebServer({ cwd: repo, defaultAutoScale: true }));
    base = await listenEphemeral(server);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(repo, { recursive: true, force: true });
  });

  it('serves the whole catalog for the requested locale', async () => {
    const res = await fetch(base + '/api/i18n?locale=pt-BR');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      locale: string;
      defaultLocale: string;
      locales: Array<{ id: string; label: string }>;
      messages: Record<string, string>;
    };
    expect(body.locale).toBe('pt-BR');
    expect(body.defaultLocale).toBe('en');
    expect(body.locales.map((l) => l.id)).toEqual(['en', 'pt-BR']);
    expect(body.messages['web.settings.title']).toBe('Configurações');
    expect(Object.keys(body.messages).length).toBeGreaterThan(400);
  });

  it('serves English for en and translates the same key differently', async () => {
    const en = (await (await fetch(base + '/api/i18n?locale=en')).json()) as {
      messages: Record<string, string>;
    };
    const pt = (await (await fetch(base + '/api/i18n?locale=pt-BR')).json()) as {
      messages: Record<string, string>;
    };
    expect(en.messages['web.settings.title']).toBe('Settings');
    expect(Object.keys(en.messages).sort()).toEqual(Object.keys(pt.messages).sort());
  });

  it('falls back to the process locale for an unknown one', async () => {
    const body = (await (await fetch(base + '/api/i18n?locale=klingon')).json()) as {
      locale: string;
    };
    expect(['en', 'pt-BR']).toContain(body.locale);
  });

  it('is reachable WITHOUT a token — the client paints its chrome before auth', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const gated = createWebServer({ cwd: repo, defaultAutoScale: true, token: 'sekret' });
    server = gated.server;
    base = await listenEphemeral(server);
    expect((await fetch(base + '/api/i18n')).status).toBe(200);
    expect((await fetch(base + '/api/bootstrap')).status).toBe(401);
  });
});

describe('web server — hand-drawn methods (/api/graphs + /graph)', () => {
  let repo: string;
  let server: Server;
  let base: string;

  /** The smallest graph the schema accepts — the root prompt node, nothing else. */
  const NOW = '2026-08-03T12:00:00.000Z';
  const emptyGraph = (id: string, name = `Graph ${id}`): Record<string, unknown> => ({
    _format: 'huu-devgraph-v1',
    id,
    name,
    createdAt: NOW,
    updatedAt: NOW,
    meta: {},
    nodes: [
      {
        id: 'prompt-1',
        kind: 'prompt',
        label: 'Entrada do prompt',
        position: { x: 0, y: 0 },
        goal: 'Objetivo de teste.',
      },
    ],
    edges: [],
  });

  const postJson = (path: string, body: unknown): Promise<Response> =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'huu-web-graph-'));
    setupRepo(repo);
    ({ server } = createWebServer({ cwd: repo, defaultAutoScale: true }));
    base = await listenEphemeral(server);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(repo, { recursive: true, force: true });
  });

  it('serves the SPA shell at /graph and /graph/ — a deep link is not a missing asset', async () => {
    for (const path of ['/graph', '/graph/']) {
      const res = await fetch(base + path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type'), path).toContain('text/html');
      expect(await res.text(), path).toContain('app.js');
    }
  });

  it('serves the whole editor catalog in one call', async () => {
    const res = await fetch(base + '/api/graphs/catalog');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      blocks: { id: string; promptTemplate: string }[];
      kinds: { kind: string }[];
      methodologies: { key: string }[];
      samples: { id: string; name: string; description: string }[];
    };
    expect(body.blocks.length).toBeGreaterThan(0);
    expect(body.kinds.map((k) => k.kind).sort()).toEqual(['action', 'gate', 'prompt', 'research']);
    expect(body.methodologies.length).toBeGreaterThan(0);
    expect(body.samples.length).toBeGreaterThan(0);
    // The catalog is the FULL block — the node editor shows the template.
    expect(body.blocks.find((b) => b.id === 'recon')?.promptTemplate).toContain('$goal');
    // Samples cross the wire without their builders.
    expect(Object.keys(body.samples[0]!).sort()).toEqual(['description', 'id', 'name']);
  });

  it('PUT → GET → list → DELETE round-trips a graph through the real server', async () => {
    const put = await fetch(base + '/api/graphs/alpha', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ graph: emptyGraph('alpha', 'Alpha') }),
    });
    expect(put.status).toBe(200);
    expect(((await put.json()) as { ok: boolean }).ok).toBe(true);

    const got = await fetch(base + '/api/graphs/alpha');
    expect(got.status).toBe(200);
    expect(((await got.json()) as { graph: { name: string } }).graph.name).toBe('Alpha');

    const listed = (await (await fetch(base + '/api/graphs')).json()) as {
      graphs: { id: string; valid: boolean }[];
    };
    expect(listed.graphs.map((g) => g.id)).toEqual(['alpha']);
    expect(listed.graphs[0]!.valid).toBe(true);

    const del = await fetch(base + '/api/graphs/alpha', { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect((await fetch(base + '/api/graphs/alpha')).status).toBe(404);
    expect(
      ((await (await fetch(base + '/api/graphs')).json()) as { graphs: unknown[] }).graphs,
    ).toEqual([]);
  });

  it('404s a graph nobody saved and 400s a hostile id', async () => {
    const missing = await fetch(base + '/api/graphs/never-saved');
    expect(missing.status).toBe(404);
    expect(String(((await missing.json()) as { error: string }).error)).toMatch(/^not-found:/);

    const hostile = await fetch(base + '/api/graphs/..%2F..%2Fetc%2Fpasswd');
    expect(hostile.status).toBe(400);
    expect(String(((await hostile.json()) as { error: string }).error)).toMatch(/^invalid-id:/);
  });

  it('honors ?dir= so the editor can address another project', async () => {
    const other = mkdtempSync(join(tmpdir(), 'huu-web-graph-other-'));
    try {
      const put = await fetch(base + '/api/graphs/beta', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: other, graph: emptyGraph('beta') }),
      });
      expect(put.status).toBe(200);
      const here = (await (await fetch(base + '/api/graphs')).json()) as { graphs: unknown[] };
      expect(here.graphs).toEqual([]);
      const there = (await (
        await fetch(base + '/api/graphs?dir=' + encodeURIComponent(other))
      ).json()) as { graphs: { id: string }[] };
      expect(there.graphs.map((g) => g.id)).toEqual(['beta']);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('validate answers 200 for a BAD graph — a half-drawn method is not a transport error', async () => {
    const res = await postJson('/api/graphs/validate', {
      graph: { ...emptyGraph('alpha'), nodes: [] },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; errors: { code: string }[] };
    expect(body.ok).toBe(false);
    expect(body.errors.map((e) => e.code)).toContain('no-prompt-node');
  });

  it('validate reports a payload that is not a graph as invalid-schema, still 200', async () => {
    const res = await postJson('/api/graphs/validate', { graph: 'not a graph' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; errors: { code: string }[] };
    expect(body.ok).toBe(false);
    expect(body.errors[0]!.code).toBe('invalid-schema');
  });

  it('compiles a sample the server itself created, end to end', async () => {
    const created = await postJson('/api/graphs/from-sample', { sampleId: 'recon-fanout' });
    expect(created.status).toBe(200);
    const { graph } = (await created.json()) as { graph: Record<string, unknown> };
    expect(graph.id).toBe('recon-fanout');

    const compiled = await postJson('/api/graphs/compile', { graph });
    expect(compiled.status).toBe(200);
    const body = (await compiled.json()) as {
      ok: boolean;
      pipeline: { steps: unknown[] };
      nodeOrder: string[];
      stepsByNode: Record<string, string[]>;
      warnings: string[];
    };
    expect(body.ok).toBe(true);
    expect(body.pipeline.steps.length).toBeGreaterThan(0);
    expect(body.nodeOrder.length).toBeGreaterThan(0);
    expect(Object.keys(body.stepsByNode).length).toBeGreaterThan(0);
    expect(Array.isArray(body.warnings)).toBe(true);

    // …and the sample really landed on disk under the server's cwd.
    const listed = (await (await fetch(base + '/api/graphs')).json()) as { graphs: { id: string }[] };
    expect(listed.graphs.map((g) => g.id)).toContain('recon-fanout');
  });

  it('compile answers 400 — never a bare 500 — for a graph that cannot compile', async () => {
    const res = await postJson('/api/graphs/compile', {
      graph: { ...emptyGraph('alpha'), nodes: [] },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string; errors: { code: string }[] };
    expect(body.ok).toBe(false);
    expect(body.error).toBeTruthy();
    expect(body.errors.map((e) => e.code)).toContain('no-prompt-node');
  });

  it('405s a verb the route does not implement and 404s a nested path', async () => {
    expect((await fetch(base + '/api/graphs/catalog', { method: 'DELETE' })).status).toBe(405);
    expect((await fetch(base + '/api/graphs', { method: 'DELETE' })).status).toBe(405);
    expect((await fetch(base + '/api/graphs/a/b')).status).toBe(404);
  });

  it('400s a malformed JSON body instead of the catch-all 500', async () => {
    const res = await fetch(base + '/api/graphs/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ not json',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/invalid JSON/);
  });

  it('serves the palette on /api/bootstrap, projected from the single sources', async () => {
    const boot = (await (await fetch(base + '/api/bootstrap')).json()) as {
      graphBlocks: Record<string, unknown>[];
      graphNodeKinds: { kind: string }[];
      graphSamples: Record<string, unknown>[];
    };
    expect(boot.graphBlocks.length).toBeGreaterThan(0);
    expect(boot.graphNodeKinds.map((k) => k.kind).sort()).toEqual([
      'action',
      'gate',
      'prompt',
      'research',
    ]);
    expect(boot.graphSamples.length).toBeGreaterThan(0);
    // The palette projection carries the browser-facing columns only…
    expect(Object.keys(boot.graphBlocks[0]!).sort()).toEqual([
      'defaultScope',
      'description',
      'id',
      'label',
      'produces',
      'readOnly',
      'review',
    ]);
    expect(Object.keys(boot.graphSamples[0]!).sort()).toEqual(['description', 'id', 'name']);
    // …and no agent prompt rides on a payload fetched at every page load.
    expect(JSON.stringify(boot.graphBlocks)).not.toContain('$goal');

    // The catalog is the same set, so the two can never disagree about ids.
    const catalog = (await (await fetch(base + '/api/graphs/catalog')).json()) as {
      blocks: { id: string }[];
      samples: { id: string }[];
    };
    expect(catalog.blocks.map((b) => b.id)).toEqual(
      boot.graphBlocks.map((b) => b.id as string),
    );
    expect(catalog.samples.map((s) => s.id)).toEqual(boot.graphSamples.map((s) => s.id as string));
  });
});

describe('web server — /api/graphs behind the token gate', () => {
  let repo: string;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'huu-web-graph-tok-'));
    setupRepo(repo);
    ({ server } = createWebServer({ cwd: repo, defaultAutoScale: true, token: 'sekret' }));
    base = await listenEphemeral(server);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(repo, { recursive: true, force: true });
  });

  it('gates every graph route but still serves the /graph shell', async () => {
    expect((await fetch(base + '/graph')).status).toBe(200);
    expect((await fetch(base + '/api/graphs')).status).toBe(401);
    expect((await fetch(base + '/api/graphs/catalog')).status).toBe(401);
    expect((await fetch(base + '/api/graphs/alpha')).status).toBe(401);
    expect(
      (await fetch(base + '/api/graphs/validate', { method: 'POST', body: '{}' })).status,
    ).toBe(401);
    expect((await fetch(base + '/api/graphs?token=sekret')).status).toBe(200);
    expect(
      (await fetch(base + '/api/graphs/catalog', { headers: { 'x-huu-token': 'sekret' } })).status,
    ).toBe(200);
  });
});

describe('web server — folder-picker workspace (HUU_WORKSPACE)', () => {
  let repo: string;
  let workspace: string;
  let server: Server;
  let base: string;
  let savedWs: string | undefined;

  beforeEach(async () => {
    savedWs = process.env.HUU_WORKSPACE;
    workspace = mkdtempSync(join(tmpdir(), 'huu-ws-'));
    // A sub-folder so the listing has an entry to assert on.
    execSync(`mkdir -p ${join(workspace, 'projectA')}`, { encoding: 'utf8' });
    process.env.HUU_WORKSPACE = workspace;
    repo = mkdtempSync(join(tmpdir(), 'huu-web-'));
    setupRepo(repo);
    ({ server } = createWebServer({ cwd: repo, defaultAutoScale: true, initialPipeline: PIPELINE }));
    base = await listenEphemeral(server);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(repo, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
    if (savedWs === undefined) delete process.env.HUU_WORKSPACE;
    else process.env.HUU_WORKSPACE = savedWs;
  });

  it('bootstrap exposes the workspace root', async () => {
    const boot = (await (await fetch(base + '/api/bootstrap')).json()) as { workspace: string };
    expect(boot.workspace).toBe(workspace);
  });

  it('a bare /api/folders opens at the workspace root, not the cwd', async () => {
    const d = (await (await fetch(base + '/api/folders')).json()) as {
      path: string;
      entries: Array<{ name: string }>;
    };
    expect(d.path).toBe(workspace);
    expect(d.entries.map((e) => e.name)).toContain('projectA');
  });

  it('an explicit ?path still navigates anywhere reachable', async () => {
    const d = (await (
      await fetch(base + '/api/folders?path=' + encodeURIComponent(repo))
    ).json()) as { path: string };
    expect(d.path).toBe(repo);
  });
});

// ── /api/dev RUNS the methods /api/graphs saves ────────────────────────────
//
// The two namespaces are one feature seen from two ends: `/api/graphs` is where
// a method is drawn and saved, `/api/dev` is where it is RUN. This block pins
// the wiring between them at the ROUTE level — the coercion `POST /api/dev`
// performs on `graph`/`graphId`, the status + reason code it answers with, and
// the one property that makes the pair usable at all: both address the SAME
// store for the same directory string. `dev-manager.test.ts` covers what the
// session then becomes; neither file is a substitute for the other.

describe('web server — /api/dev runs the methods /api/graphs saves', () => {
  let repo: string;
  let server: Server;
  let base: string;

  const NOW = '2026-08-03T12:00:00.000Z';

  /** The smallest drawing that COMPILES: one objective, one box. */
  const drawnGraph = (id: string): Record<string, unknown> => ({
    _format: 'huu-devgraph-v1',
    id,
    name: `Método ${id}`,
    createdAt: NOW,
    updatedAt: NOW,
    meta: {},
    nodes: [
      {
        id: 'entrada',
        kind: 'prompt',
        label: 'Entrada do prompt',
        position: { x: 0, y: 0 },
        goal: 'audite o repositório',
      },
      {
        id: 'auditar',
        kind: 'action',
        label: 'Auditar',
        position: { x: 360, y: 0 },
        block: 'security-review',
        scope: 'project',
        join: { mode: 'all' },
      },
    ],
    edges: [{ id: 'e-1', source: 'entrada', target: 'auditar' }],
  });

  const postJson = async (
    path: string,
    body: unknown,
  ): Promise<{ status: number; json: any }> => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };

  /** A dev session that parks at the approval gate — nothing runs until asked. */
  const startDev = (extra: Record<string, unknown>): Promise<{ status: number; json: any }> =>
    postJson('/api/dev', {
      goal: 'rodar o método desenhado',
      modelId: 'stub-model',
      backend: 'stub',
      approval: 'each-epoch',
      skipKnowledgeBootstrap: true,
      ...extra,
    });

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'huu-web-dev-graph-route-'));
    setupRepo(repo);
    ({ server } = createWebServer({ cwd: repo, defaultAutoScale: true }));
    base = await listenEphemeral(server);
  });

  afterEach(async () => {
    await postJson('/api/dev/abort', {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(repo, { recursive: true, force: true });
  });

  it('runs a method the editor saved one request earlier', async () => {
    const put = await fetch(base + '/api/graphs/metodo-salvo', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ graph: drawnGraph('metodo-salvo') }),
    });
    expect(put.status).toBe(200);

    const started = await startDev({ graphId: 'metodo-salvo' });
    expect(started.status).toBe(200);
    expect(started.json.sessionId).toBeTruthy();

    const session = (await (await fetch(base + '/api/dev')).json()).session;
    expect(session.drawnMethod).toMatchObject({ id: 'metodo-salvo' });
  });

  // The editor addresses a project with `?dir=`, the runner with
  // `runDirectory`. They resolve through the SAME policy on purpose: a method
  // saved through one and unreachable from the other is a feature with a hole
  // in the middle.
  it('addresses the same store from ?dir= and from runDirectory', async () => {
    const other = mkdtempSync(join(tmpdir(), 'huu-web-dev-graph-other-'));
    try {
      setupRepo(other);
      const put = await fetch(base + '/api/graphs/em-outro-projeto', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: other, graph: drawnGraph('em-outro-projeto') }),
      });
      expect(put.status).toBe(200);

      // Not in THIS repository — and the runner says so instead of guessing.
      const here = await startDev({ graphId: 'em-outro-projeto' });
      expect(here.status).toBe(400);
      expect(here.json.reason).toBe('graph-not-found');

      // …and it IS reachable when the run addresses the same directory.
      const there = await startDev({ graphId: 'em-outro-projeto', runDirectory: other });
      expect(there.status).toBe(200);
    } finally {
      await postJson('/api/dev/abort', {});
      rmSync(other, { recursive: true, force: true });
    }
  });

  // Reason CODES, not prose: the browser has to tell "the drawing is gone" from
  // "the drawing does not compile" from "you asked for something a graph cannot
  // do", and English is not a stable handle on that.
  it('answers every refusal with a machine-readable reason code', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ graphId: 'nunca-salvo' }, 'graph-not-found'],
      [{ graphId: 'metodo-x', maxEpochs: 4 }, 'graph-conflict'],
      [{ graph: drawnGraph('a-graph'), graphId: 'outro' }, 'graph-conflict'],
      [{ graph: { ...drawnGraph('sem-prompt'), nodes: [] } }, 'graph-invalid'],
      [{ graph: 'não é um grafo' }, 'invalid-schema'],
      [{ graphId: 42 }, 'invalid-id'],
    ];
    for (const [body, reason] of cases) {
      const { status, json } = await startDev(body);
      expect(status, JSON.stringify(body)).toBe(400);
      expect(json.reason, JSON.stringify(body)).toBe(reason);
      expect(typeof json.error, JSON.stringify(body)).toBe('string');
    }
    // Six refusals, and not one of them opened a session.
    expect((await (await fetch(base + '/api/dev')).json()).session).toBeNull();
  });

  // The compile route and the run route must agree: a drawing `/api/graphs/
  // compile` refuses is a drawing `/api/dev` refuses, and for the same reason.
  it('refuses what /api/graphs/compile refuses, instead of running it', async () => {
    const broken = { ...drawnGraph('quebrado'), nodes: [] };
    const compiled = await postJson('/api/graphs/compile', { graph: broken });
    expect(compiled.status).toBe(400);
    expect(compiled.json.errors.map((e: { code: string }) => e.code)).toContain('no-prompt-node');

    const started = await startDev({ graph: broken });
    expect(started.status).toBe(400);
    expect(started.json.reason).toBe('graph-invalid');
    expect(started.json.error).toContain('no-prompt-node');
  });

  // The additive half: a /dev request that names no drawing is the request it
  // was before this route learned the word "graph".
  it('leaves a request that names no drawing on the planner path', async () => {
    const started = await startDev({});
    expect(started.status).toBe(200);
    const session = (await (await fetch(base + '/api/dev')).json()).session;
    expect(session.drawnMethod).toBeUndefined();
    expect(session.graph).toBeUndefined();
    expect(session.maxEpochs).toBeNull();
  });
});

// ── A body huu cannot parse is the CALLER's error, on /api/dev too ──────────
//
// `/api/graphs` grew an explicit 400 for this; the `/api/dev` namespace did
// not, so `{ not json` fell through to the server's catch-all and came back as
// a 500. The status is the only handle a browser (or a log) has on "retry with
// a different body" versus "huu broke", and 500 says the wrong one.

describe('web server — a malformed body on /api/dev is a 400, never a 500', () => {
  let repo: string;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'huu-web-dev-badbody-'));
    setupRepo(repo);
    ({ server } = createWebServer({ cwd: repo, defaultAutoScale: true }));
    base = await listenEphemeral(server);
  });

  afterEach(async () => {
    await fetch(base + '/api/dev/abort', { method: 'POST' });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(repo, { recursive: true, force: true });
  });

  const postRaw = (path: string, body: string): Promise<Response> =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

  // EVERY route in the namespace that reads a body — the hole was never
  // specific to `/api/dev`, it was specific to reading one without a guard.
  const BODY_ROUTES = [
    '/api/dev',
    '/api/dev/approve',
    '/api/dev/resume',
    '/api/dev/orphans',
    '/api/dev/transcribe',
  ];

  it('answers 400 with the reason for every unparseable body', async () => {
    for (const path of BODY_ROUTES) {
      for (const body of ['{', 'não é json', '[1,2,3', '{"a":']) {
        const res = await postRaw(path, body);
        expect(res.status, `${path} ← ${body}`).toBe(400);
        expect(((await res.json()) as { error: string }).error).toMatch(/invalid JSON/);
      }
    }
  });

  // An EMPTY body is not malformed — `readJsonBody` reads it as `{}`, and the
  // route's own validation decides. It must land on that validation's answer
  // (400 "goal is required"), never on a 500 and never on a started session.
  it('reads an empty body as {} and lets the route validate it', async () => {
    const res = await postRaw('/api/dev', '');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/goal is required/);
    expect((await (await fetch(base + '/api/dev')).json()).session).toBeNull();
  });

  // The point of the guard is that it is UNREACHABLE for a body that parses:
  // every valid request keeps the exact status it had before.
  it('changes nothing for a body that parses', async () => {
    // Gates with nothing waiting still answer 409, not 400.
    for (const [path, body] of [
      ['/api/dev/approve', { approved: true }],
      ['/api/dev/resume', { accept: true }],
      ['/api/dev/orphans', { action: 'land' }],
    ] as const) {
      const res = await postRaw(path, JSON.stringify(body));
      expect(res.status, path).toBe(409);
    }
    // …and a well-formed start is still a 200 that opens a session.
    const started = await postRaw(
      '/api/dev',
      JSON.stringify({
        goal: 'corpo válido',
        modelId: 'stub-model',
        backend: 'stub',
        approval: 'each-epoch',
        skipKnowledgeBootstrap: true,
      }),
    );
    expect(started.status).toBe(200);
    expect((await started.json()).sessionId).toBeTruthy();
  });
});

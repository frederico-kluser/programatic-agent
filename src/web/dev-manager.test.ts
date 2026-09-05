import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createWebServer } from './server.js';
import { runDevMode } from '../lib/dev-mode/dev-driver.js';
import { DEV_METHODOLOGIES } from '../lib/dev-mode/methodology-registry.js';
import { GRAPHS_DIR, writeGraph } from '../lib/dev-graph/graph-store.js';
import type { DevGraph } from '../lib/dev-graph/graph-types.js';

// Spy on the manager→driver seam: the REAL driver still runs underneath (the
// stub backend carries every session in this file), the wrapper only records
// what the manager handed over — the direct proof that a posted `methodology`
// reaches runDevMode, and that an absent one stays absent.
vi.mock('../lib/dev-mode/dev-driver.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../lib/dev-mode/dev-driver.js')>();
  return { ...mod, runDevMode: vi.fn(mod.runDevMode) };
});

function setupRepo(dir: string): void {
  execSync('git init --initial-branch=main', { cwd: dir, encoding: 'utf8' });
  execSync('git config user.email "t@t.com" && git config user.name "t"', { cwd: dir, shell: '/bin/bash' });
  writeFileSync(join(dir, 'README.md'), '# init\n', 'utf8');
  writeFileSync(join(dir, '.gitignore'), '.huu-worktrees/\n.huu/\n', 'utf8');
  execSync('git add -A && git commit -m init', { cwd: dir, encoding: 'utf8' });
}

async function listenEphemeral(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function post(base: string, path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

describe('web server — development mode', () => {
  let repo: string;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'huu-web-dev-'));
    setupRepo(repo);
    ({ server } = createWebServer({ cwd: repo, defaultAutoScale: true }));
    base = await listenEphemeral(server);
  });

  afterEach(async () => {
    await post(base, '/api/dev/abort', {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(repo, { recursive: true, force: true });
  });

  it('serves the SPA shell at /dev (client routes on pathname)', async () => {
    for (const path of ['/dev', '/dev/']) {
      const res = await fetch(base + path);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(await res.text()).toContain('app.js');
    }
  });

  // Discoverability: /dev is reachable ONLY by URL unless the shell links to
  // it. It first shipped without a single link and was effectively invisible.
  // The mode switch IS the entry point now — pin its shape.
  it('renders the mode switch so development mode is discoverable', async () => {
    const html = await (await fetch(base + '/')).text();
    expect(html).toContain('id="modeSwitch"');
    expect(html).toContain('id="modePipelines"');
    expect(html).toContain('id="modeDev"');
    expect(html).toContain('href="/dev"');
    // Both halves must be real links (bookmarkable, middle-clickable); the
    // client intercepts plain clicks to swap views without a reload.
    expect(html).toMatch(/<a[^>]+id="modeDev"[^>]+href="\/dev"/);
    expect(html).toMatch(/data-mode="launch"/);
    expect(html).toMatch(/data-mode="dev"/);
  });

  // Both routes serve the SAME shell, so the switch is present either way —
  // that is what lets /dev switch BACK to pipelines without a page load.
  it('serves the same switch on /dev', async () => {
    const html = await (await fetch(base + '/dev')).text();
    expect(html).toContain('id="modeSwitch"');
    expect(html).toContain('id="viewLaunch"');
    expect(html).toContain('id="viewDev"');
  });

  // The dev form's controls are the user's whole contract with the mode. Pin
  // them so a refactor that drops one fails here instead of silently.
  it('serves the dev form with its controls', async () => {
    const html = await (await fetch(base + '/dev')).text();
    for (const id of [
      'devGoal',          // the goal textarea
      'devMic',           // dictation
      'devFolderList',    // project selector (the pipeline picker, single-select)
      'devFolderHome',
      'devFolderUp',
      'devProviderSeg',
      'devModel',
      'devApprovalSeg',
      'devFrontsSeg',     // Auto | Manual, mirroring the pipeline concurrency seg
      'devFronts',
      'devMethodPanel',   // the methodology toggles, rendered from /api/bootstrap
      'devMethodList',
      'devStartBtn',
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    // Both segmented controls must use the design system's classes, or they
    // render unstyled and the selection is invisible (this happened once).
    expect(html).toMatch(/<div class="segmented" id="devApprovalSeg">/);
    expect(html).toMatch(/<div class="segmented segmented--sm" id="devFrontsSeg">/);
  });

  // The user asked for no epoch cap: the session runs until the goal is
  // reported complete or they stop it.
  it('offers no epoch-limit control', async () => {
    const html = await (await fetch(base + '/dev')).text();
    expect(html).not.toContain('id="devEpochs"');
    expect(html).toContain('There is no epoch limit');
  });

  it('reports no session before one is started', async () => {
    const res = await fetch(base + '/api/dev');
    expect(res.status).toBe(200);
    expect((await res.json()).session).toBeNull();
  });

  it('rejects a session with no goal', async () => {
    const { status, json } = await post(base, '/api/dev', { modelId: 'stub-model', backend: 'stub' });
    expect(status).toBe(400);
    expect(json.error).toMatch(/goal is required/);
  });

  it('rejects a session with no model', async () => {
    const { status, json } = await post(base, '/api/dev', { goal: 'fazer algo', backend: 'stub' });
    expect(status).toBe(400);
    expect(json.error).toMatch(/modelId is required/);
  });

  it('starts a session and exposes it over /api/dev', async () => {
    const { status, json } = await post(base, '/api/dev', {
      goal: 'adicionar validação',
      modelId: 'stub-model',
      backend: 'stub',
      maxEpochs: 1,
      approval: 'each-epoch',
      skipKnowledgeBootstrap: true,
    });
    expect(status).toBe(200);
    expect(json.sessionId).toBeTruthy();

    const session = (await (await fetch(base + '/api/dev')).json()).session;
    expect(session.goal).toBe('adicionar validação');
    expect(session.approval).toBe('each-epoch');
    expect(session.maxEpochs).toBe(1);
    expect(session.runDirectory).toContain(repo.replace(/^\/private/, ''));
  });

  it('runs unbounded when the client sends no epoch ceiling', async () => {
    await post(base, '/api/dev', {
      goal: 'sem teto',
      modelId: 'stub-model',
      backend: 'stub',
      approval: 'each-epoch',
      skipKnowledgeBootstrap: true,
    });
    const session = (await (await fetch(base + '/api/dev')).json()).session;
    expect(session.maxEpochs).toBeNull();
  });

  // One session at a time: every epoch ends in a merge into the working
  // branch, so two concurrent sessions on one repo would race that merge.
  it('refuses a second concurrent session with 409', async () => {
    await post(base, '/api/dev', {
      goal: 'primeiro',
      modelId: 'stub-model',
      backend: 'stub',
      approval: 'each-epoch',
      skipKnowledgeBootstrap: true,
    });
    const second = await post(base, '/api/dev', {
      goal: 'segundo',
      modelId: 'stub-model',
      backend: 'stub',
      skipKnowledgeBootstrap: true,
    });
    expect(second.status).toBe(409);
    expect(second.json.error).toMatch(/already running/);
  });

  it('answers 409 when approving with no plan pending', async () => {
    const { status, json } = await post(base, '/api/dev/approve', { approved: true });
    expect(status).toBe(409);
    expect(json.error).toMatch(/awaiting approval/);
  });

  it('parks at the approval gate and runs nothing until approved', async () => {
    await post(base, '/api/dev', {
      goal: 'objetivo com portão',
      modelId: 'stub-model',
      backend: 'stub',
      maxEpochs: 1,
      approval: 'each-epoch',
      skipKnowledgeBootstrap: true,
    });

    // The stub planner resolves immediately, so the gate opens fast.
    let session: any;
    for (let i = 0; i < 60; i++) {
      session = (await (await fetch(base + '/api/dev')).json()).session;
      if (session?.awaitingApproval) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(session.awaitingApproval).toBe(true);
    expect(session.phase).toBe('awaiting-approval');
    expect(session.plan.fronts.length).toBeGreaterThan(0);
    // Nothing ran: no epoch record, no run ids.
    expect(session.epochs).toEqual([]);
    expect(session.runIds).toEqual([]);

    // Rejecting ends the session without running the swarm.
    const rejected = await post(base, '/api/dev/approve', { approved: false });
    expect(rejected.status).toBe(200);

    for (let i = 0; i < 60; i++) {
      session = (await (await fetch(base + '/api/dev')).json()).session;
      if (!session.active) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(session.active).toBe(false);
    expect(session.stoppedBecause).toBe('plan-rejected');
    expect(session.epochs).toEqual([]);
  });

  it('aborts an in-flight session', async () => {
    await post(base, '/api/dev', {
      goal: 'para abortar',
      modelId: 'stub-model',
      backend: 'stub',
      approval: 'each-epoch',
      skipKnowledgeBootstrap: true,
    });

    for (let i = 0; i < 60; i++) {
      const s = (await (await fetch(base + '/api/dev')).json()).session;
      if (s?.awaitingApproval) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const { status, json } = await post(base, '/api/dev/abort', {});
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
  });

  it('reports abort as a no-op when nothing is running', async () => {
    const { status, json } = await post(base, '/api/dev/abort', {});
    expect(status).toBe(200);
    expect(json.ok).toBe(false);
  });

  // ── Per-role model routing ──────────────────────────────────────────────

  // The COMPATIBILITY PROOF. A body carrying none of the new fields must reach
  // the driver with no policy at all, so every emitted step omits `modelId` and
  // the pipeline compiled is the one compiled before this feature existed.
  it('a body with no models routes nothing — every role reads back as modelId', async () => {
    await post(base, '/api/dev', {
      goal: 'sem roteamento',
      modelId: 'stub-model',
      backend: 'stub',
      approval: 'each-epoch',
      skipKnowledgeBootstrap: true,
    });
    const session = (await (await fetch(base + '/api/dev')).json()).session;
    expect(Object.keys(session.models).sort()).toEqual(
      ['critic', 'integration', 'judge', 'planner', 'recon', 'reporter', 'worker'].sort(),
    );
    for (const [role, id] of Object.entries(session.models)) {
      expect(id, role).toBe('stub-model');
    }
    expect(session.resumed).toBe(false);
    expect(session.awaitingResume).toBe(false);
    expect(session.awaitingOrphans).toBe(false);
  });

  it('an explicit per-role policy resolves, with modelId as the fallback', async () => {
    await post(base, '/api/dev', {
      goal: 'com roteamento',
      modelId: 'stub-model',
      backend: 'stub',
      approval: 'each-epoch',
      skipKnowledgeBootstrap: true,
      models: { planner: 'z-ai/glm-5.2', critic: '  moonshotai/kimi-k2.6  ', bogus: 'x', judge: 7 },
    });
    const session = (await (await fetch(base + '/api/dev')).json()).session;
    expect(session.models.planner).toBe('z-ai/glm-5.2');
    expect(session.models.critic).toBe('moonshotai/kimi-k2.6'); // trimmed
    // Unknown roles are dropped, non-strings are dropped, and everything the
    // policy did not name falls back — never throws, never refuses the run.
    expect(session.models.judge).toBe('stub-model');
    expect(session.models.worker).toBe('stub-model');
    expect(session.models).not.toHaveProperty('bogus');
  });

  it('a preset seeds the policy and explicit roles layer over it', async () => {
    await post(base, '/api/dev', {
      goal: 'com preset',
      modelId: 'fallback-model',
      backend: 'jcode',
      // `hetero` is an OPENROUTER preset: a cross-family critic needs an
      // endpoint that fronts more than one family, and that is the only one.
      provider: 'openrouter',
      apiKey: 'sk-or-test-key-0000',
      approval: 'each-epoch',
      skipKnowledgeBootstrap: true,
      modelsPreset: 'hetero',
      models: { reporter: 'deepseek/deepseek-v4-flash' },
    });
    const session = (await (await fetch(base + '/api/dev')).json()).session;
    expect(session.models.worker).toBe('deepseek/deepseek-v4-pro'); // from the preset
    expect(session.models.critic).toBe('moonshotai/kimi-k2.6'); // cross-family, from the preset
    expect(session.models.reporter).toBe('deepseek/deepseek-v4-flash'); // explicit wins
  });

  // The browser derives the required `modelId` from the `worker` role input,
  // and a preset now shows `<provider>:`-prefixed ids in those inputs. The
  // run-level model carries NO provider (`AppConfig.provider` already says
  // which endpoint the session spends on), so the prefix must be stripped here.
  //
  // MUTATION KILLED: passing `params.modelId` straight through. Every step
  // nothing routed would be stamped `openrouter:vendor/model` and the endpoint
  // would answer "model not found" on a name huu invented.
  it('strips a provider prefix from the run-level modelId', async () => {
    await post(base, '/api/dev', {
      goal: 'prefixo no modelo do run',
      modelId: 'openrouter:anthropic/claude-opus-5',
      backend: 'jcode',
      provider: 'openrouter',
      apiKey: 'sk-or-test-key-0000',
      approval: 'each-epoch',
      skipKnowledgeBootstrap: true,
    });
    const session = (await (await fetch(base + '/api/dev')).json()).session;
    expect(session.modelId).toBe('anthropic/claude-opus-5');
    // …and every unrouted role reads back the same bare id.
    expect(session.models.worker).toBe('anthropic/claude-opus-5');
  });

  // THE BUG THIS WAVE FIXES, at the web border. `hetero` routes two roles to
  // ids only openrouter.ai serves, while `AppConfig.provider` is ONE provider
  // for the whole run — so on DeepSeek those two ids used to reach
  // api.deepseek.com and die inside the first agent, after its worktree and
  // branch already existed.
  //
  // READ THIS WITH ITS OTHER HALF. The body below is assembled BY HAND: it
  // pairs a preset with a provider that cannot serve it, which is precisely
  // what the border exists to refuse, and refusing it must never be relaxed.
  // What the browser assembles ON ITS OWN is a different question and it has a
  // different answer — `client/dev-default-path.test.js` posts the untouched
  // form's body at this same server, for EVERY provider, and requires 200.
  // Pinning only this half is how the default `/dev` path stayed a 400.
  //
  // MUTATION KILLED: dropping the `checkDevModelPolicy` refusal from
  // `DevSessionManager.start` (or letting the preset's `openrouter:` prefixes
  // be parsed away). The POST goes back to 200 and a doomed session opens.
  it('REFUSES a hand-assembled preset/provider pair the endpoint cannot serve', async () => {
    const { status, json } = await post(base, '/api/dev', {
      goal: 'preset no provedor errado',
      modelId: 'deepseek/deepseek-v4-pro',
      backend: 'jcode',
      provider: 'deepseek',
      apiKey: 'sk-test-key-0000',
      approval: 'each-epoch',
      skipKnowledgeBootstrap: true,
      modelsPreset: 'hetero',
    });
    expect(status).toBe(400);
    // Actionable: which roles, which ids, and where they DO work.
    expect(json.error).toContain('planner');
    expect(json.error).toContain('critic');
    expect(json.error).toContain('z-ai/glm-5.2');
    expect(json.error).toContain('openrouter');
    // No session was opened.
    expect((await (await fetch(base + '/api/dev')).json()).session).toBeNull();
  });

  // Credential routing: the spec name comes from `selectBackend(kind)`, never
  // from a `azure ? azureApiKey : openrouter` ternary. With the ternary, a
  // jcode session demanded the OPENROUTER key — refusing to start on a machine
  // that only has DEEPSEEK_API_KEY, and (worse) starting with an OpenRouter key
  // jcode never uses on a machine that has one.
  it('a jcode session gates on the DeepSeek key, never the OpenRouter one', async () => {
    // Isolated on purpose: the assertion must not depend on the developer's
    // ambient keys — a real DEEPSEEK_API_KEY would start a real session, and an
    // ambient OPENROUTER_API_KEY would let the OLD code through.
    const TRACKED = [
      'DEEPSEEK_API_KEY',
      'DEEPSEEK_API_KEY_FILE',
      'OPENROUTER_API_KEY',
      'OPENROUTER_API_KEY_FILE',
      'XDG_CONFIG_HOME',
      'HUU_CONFIG_DIR',
    ] as const;
    const savedEnv: Record<string, string | undefined> = {};
    for (const k of TRACKED) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    const configHome = mkdtempSync(join(tmpdir(), 'huu-dev-keys-'));
    process.env.XDG_CONFIG_HOME = configHome;
    try {
      const { status, json } = await post(base, '/api/dev', {
        goal: 'sessao jcode sem chave',
        modelId: 'deepseek-v4-pro',
        backend: 'jcode',
        skipKnowledgeBootstrap: true,
      });
      expect(status).toBe(400);
      expect(String(json.error)).toContain('DeepSeek');
      expect(String(json.error)).not.toContain('OpenRouter');
    } finally {
      for (const k of TRACKED) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
      rmSync(configHome, { recursive: true, force: true });
    }
  });

  // The proof that the routing policy REACHES `runDevMode`: the manager -> driver
  // seam is spied at the top of this file, so the `dev` literal the manager
  // handed over is directly observable.
  //
  // The OLD vehicle was the pi model-registry preflight inside the driver: an
  // unknown worker id stopped the session with `model-preflight-failed`. That
  // registry left with the pi backend — `dev-driver.ts` now says "Model
  // preflight skipped in v3.0 — the model registry is not available", and an
  // unknown id is caught at the factory when the first agent is built. So the
  // side effect is gone; the thing it was proving is asserted head-on instead.
  it('the policy reaches runDevMode — verbatim, in the dev literal', async () => {
    vi.mocked(runDevMode).mockClear();
    const { status } = await post(base, '/api/dev', {
      goal: 'roteamento chega ao driver',
      modelId: 'stub-model',
      backend: 'stub',
      approval: 'each-epoch',
      skipKnowledgeBootstrap: true,
      models: { worker: 'nobody/invented-this-model', planner: 'z-ai/glm-5.2', bogus: 'x' },
    });
    expect(status).toBe(200);

    const spy = vi.mocked(runDevMode);
    expect(spy).toHaveBeenCalledTimes(1);
    const dev = spy.mock.calls[0]![0].dev;
    // VERBATIM: what the browser routed is what the driver runs — the manager
    // re-derives nothing and substitutes nothing. An id no catalog has heard of
    // travels untouched, which is exactly what makes a typo debuggable.
    expect(dev.models).toEqual({
      worker: { model: 'nobody/invented-this-model' },
      planner: { model: 'z-ai/glm-5.2' },
    });
    // …and the unknown ROLE never crosses the seam.
    expect(dev.models).not.toHaveProperty('bogus');

    // The snapshot the browser reads back is that same policy, with every role
    // it did not name falling back to `modelId`.
    const session = (await (await fetch(base + '/api/dev')).json()).session;
    expect(session.models.worker).toBe('nobody/invented-this-model');
    expect(session.models.planner).toBe('z-ai/glm-5.2');
    expect(session.models.judge).toBe('stub-model');
  });

  // ── runIds carry the run's phase ────────────────────────────────────────

  // An epoch is two runs now, so the epoch number alone no longer identifies a
  // run. Under `--stub` the planner declares no knowledge gaps, so an approved
  // epoch produces exactly ONE `work` run — which is precisely the entry whose
  // phase we can pin without an LLM.
  it('registers each run with its phase in runIds', async () => {
    await post(base, '/api/dev', {
      goal: 'registrar fases',
      modelId: 'stub-model',
      backend: 'stub',
      maxEpochs: 1,
      approval: 'each-epoch',
      skipKnowledgeBootstrap: true,
    });

    let session: any;
    for (let i = 0; i < 80; i++) {
      session = (await (await fetch(base + '/api/dev')).json()).session;
      if (session?.awaitingApproval) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(session.awaitingApproval).toBe(true);
    expect(session.runIds).toEqual([]);

    await post(base, '/api/dev/approve', { approved: true });
    for (let i = 0; i < 200; i++) {
      session = (await (await fetch(base + '/api/dev')).json()).session;
      if (session.runIds.length > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(session.runIds.length).toBeGreaterThan(0);
    expect(session.runIds[0]).toMatchObject({ epoch: 1, phase: 'work' });
    expect(typeof session.runIds[0].runId).toBe('string');
    // Every entry carries one of the three known phases — never undefined.
    for (const entry of session.runIds) {
      expect(['bootstrap', 'knowledge', 'work']).toContain(entry.phase);
    }
  }, 60_000);

  // ── Methodology checkboxes ────────────────────────────────────────────

  // The /dev "Metodologia" toggles: the catalog rides /api/bootstrap (the
  // client never hardcodes the list), and POST /api/dev coerces the field
  // defensively — only `true` under a KNOWN key survives, and a body that
  // enables nothing carries no `methodology` at all, which is what keeps such
  // a request compiling the exact pipeline it compiles today.
  describe('methodology plumbing', () => {
    beforeEach(() => {
      vi.mocked(runDevMode).mockClear();
    });

    const startWith = (extra: Record<string, unknown>): Promise<{ status: number; json: any }> =>
      post(base, '/api/dev', {
        goal: 'sessão com metodologia',
        modelId: 'stub-model',
        backend: 'stub',
        approval: 'each-epoch',
        skipKnowledgeBootstrap: true,
        ...extra,
      });

    /** The `dev` literal the manager handed runDevMode (the spy saw it). */
    const postedDev = () => {
      const spy = vi.mocked(runDevMode);
      expect(spy).toHaveBeenCalledTimes(1);
      return spy.mock.calls[0]![0].dev;
    };

    it('bootstrap serves the methodology catalog the /dev form renders', async () => {
      const boot = (await (await fetch(base + '/api/bootstrap')).json()) as {
        devMethodologyOptions: { key: string; label: string; description: string }[];
      };
      // The catalog IS the registry, projected — the browser must never see a
      // list that drifted from the CLI flags or the compiler.
      expect(boot.devMethodologyOptions.map((o) => o.key)).toEqual(
        DEV_METHODOLOGIES.map((d) => d.key),
      );
      // Only the browser-facing columns cross the wire.
      for (const opt of boot.devMethodologyOptions) {
        expect(Object.keys(opt).sort()).toEqual(['description', 'key', 'label']);
      }
      for (const opt of boot.devMethodologyOptions) {
        expect(opt.label).toBeTruthy();
        expect(opt.description).toBeTruthy();
      }
    });

    it('a posted methodology reaches runDevMode with exactly those keys', async () => {
      const { status } = await startWith({ methodology: { tdd: true, standards: true } });
      expect(status).toBe(200);
      expect(postedDev().methodology).toEqual({ tdd: true, standards: true });
    });

    // The COMPATIBILITY PROOF for this feature: no methodology in the body ⇒
    // the field is OMITTED from the dev literal, not merely undefined-valued.
    it('no methodology in the body ⇒ the field is omitted from the dev literal', async () => {
      const { status } = await startWith({});
      expect(status).toBe(200);
      expect('methodology' in postedDev()).toBe(false);
    });

    it('junk is coerced away — truthy strings and unknown keys survive nothing', async () => {
      const { status } = await startWith({ methodology: { tdd: 'yes', evil: true } });
      expect(status).toBe(200);
      expect('methodology' in postedDev()).toBe(false);
    });

    it('an all-false methodology is omitted too', async () => {
      const { status } = await startWith({ methodology: { tdd: false, lintGate: false } });
      expect(status).toBe(200);
      expect('methodology' in postedDev()).toBe(false);
    });

    it('a non-object methodology is omitted too', async () => {
      const { status } = await startWith({ methodology: 'tdd' });
      expect(status).toBe(200);
      expect('methodology' in postedDev()).toBe(false);
    });
  });
});

// ── The resume gate ───────────────────────────────────────────────────────

/** A previous session's state file, as `readDevState` expects to find it. */
function seedPreviousSession(repo: string, goal: string, sessionId: string): void {
  mkdirSync(join(repo, '.huu', 'dev'), { recursive: true });
  writeFileSync(
    join(repo, '.huu', 'dev', 'state.json'),
    JSON.stringify(
      {
        _format: 'huu-devstate-v2',
        goal,
        doneWhen: '',
        epochs: [],
        goalComplete: false,
        updatedAt: new Date().toISOString(),
        sessionId,
      },
      null,
      2,
    ),
    'utf8',
  );
}

describe('web server — development mode resume gate', () => {
  const GOAL = 'objetivo retomável';
  let repo: string;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'huu-web-dev-resume-'));
    setupRepo(repo);
    seedPreviousSession(repo, GOAL, 'sessao-anterior');
    ({ server } = createWebServer({ cwd: repo, defaultAutoScale: true }));
    base = await listenEphemeral(server);
  });

  afterEach(async () => {
    await post(base, '/api/dev/abort', {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(repo, { recursive: true, force: true });
  });

  const startSession = (extra: Record<string, unknown> = {}): Promise<{ status: number; json: any }> =>
    post(base, '/api/dev', {
      goal: GOAL,
      modelId: 'stub-model',
      backend: 'stub',
      maxEpochs: 1,
      approval: 'each-epoch',
      skipKnowledgeBootstrap: true,
      ...extra,
    });

  const waitFor = async (predicate: (s: any) => boolean, tries = 80): Promise<any> => {
    let session: any;
    for (let i = 0; i < tries; i++) {
      session = (await (await fetch(base + '/api/dev')).json()).session;
      if (session && predicate(session)) return session;
      await new Promise((r) => setTimeout(r, 50));
    }
    return session;
  };

  it('parks at the resume gate and describes the session on offer', async () => {
    await startSession();
    const session = await waitFor((s) => s.awaitingResume === true);
    expect(session.awaitingResume).toBe(true);
    expect(session.resumeOffer).toEqual({
      sessionId: 'sessao-anterior',
      goal: GOAL,
      epochsDone: 0,
      nextEpoch: 1,
    });
    // The other half of the additive contract (see the DRAWN block below): a
    // session the LLM planner wrote carries no drawing, so the offer carries no
    // `drawnMethod` — and the browser has nothing extra to ask the human for.
    expect(session.resumeOffer.drawnMethod).toBeUndefined();
    // The gate is a QUESTION during probing — it does not claim a new phase.
    expect(session.phase).toBe('probing');

    // Accepting adopts the previous namespace so the browser watches the right
    // directory, and releases the driver.
    const answered = await post(base, '/api/dev/resume', { accept: true });
    expect(answered.status).toBe(200);
    const after = await waitFor((s) => s.awaitingResume === false);
    expect(after.resumed).toBe(true);
    expect(after.sessionId).toBe('sessao-anterior');

    // A second answer is a 409 — a stale click can never pass for an answer.
    const stale = await post(base, '/api/dev/resume', { accept: true });
    expect(stale.status).toBe(409);
  });

  it('declining the gate starts a fresh session', async () => {
    await startSession();
    await waitFor((s) => s.awaitingResume === true);
    expect((await post(base, '/api/dev/resume', { accept: false })).status).toBe(200);
    const after = await waitFor((s) => s.awaitingResume === false);
    expect(after.resumed).toBe(false);
    expect(after.sessionId).not.toBe('sessao-anterior');
  });

  it('resume:"never" skips the gate entirely (today\'s behavior)', async () => {
    await startSession({ resume: 'never' });
    // The session runs straight through to the approval gate without ever
    // asking — the proof that an opted-out caller is unaffected.
    const session = await waitFor((s) => s.awaitingApproval === true);
    expect(session.awaitingApproval).toBe(true);
    expect(session.awaitingResume).toBe(false);
    expect(session.resumeOffer).toBeUndefined();
  });

  it('fails CLOSED: aborting while parked declines the resume', async () => {
    await startSession();
    await waitFor((s) => s.awaitingResume === true);
    expect((await post(base, '/api/dev/abort', {})).json.ok).toBe(true);
    const after = await waitFor((s) => s.active === false);
    expect(after.active).toBe(false);
    expect(after.awaitingResume).toBe(false);
    // Never adopted the previous namespace — an abort must not resume.
    expect(after.resumed).toBe(false);
    expect(after.sessionId).not.toBe('sessao-anterior');
  });
});

// ── The orphan-branch gate ────────────────────────────────────────────────

describe('web server — development mode orphan-branch gate', () => {
  let repo: string;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'huu-web-dev-orphan-'));
    setupRepo(repo);
    // A real integration branch HEAD does not contain — exactly what a crash
    // mid-session leaves behind. `git status` stays clean; the work is simply
    // not there, which is why it has to be REPORTED rather than logged.
    execSync('git checkout -b huu/lostrun/integration', { cwd: repo, encoding: 'utf8' });
    writeFileSync(join(repo, 'orphan.txt'), 'lost work\n', 'utf8');
    execSync('git add -A && git commit -m orphan', { cwd: repo, encoding: 'utf8', shell: '/bin/bash' });
    execSync('git checkout main', { cwd: repo, encoding: 'utf8' });
    ({ server } = createWebServer({ cwd: repo, defaultAutoScale: true }));
    base = await listenEphemeral(server);
  });

  afterEach(async () => {
    await post(base, '/api/dev/abort', {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(repo, { recursive: true, force: true });
  });

  const startSession = (): Promise<{ status: number; json: any }> =>
    post(base, '/api/dev', {
      goal: 'sessão com órfãos',
      modelId: 'stub-model',
      backend: 'stub',
      maxEpochs: 1,
      approval: 'each-epoch',
      skipKnowledgeBootstrap: true,
    });

  const waitFor = async (predicate: (s: any) => boolean, tries = 80): Promise<any> => {
    let session: any;
    for (let i = 0; i < tries; i++) {
      session = (await (await fetch(base + '/api/dev')).json()).session;
      if (session && predicate(session)) return session;
      await new Promise((r) => setTimeout(r, 50));
    }
    return session;
  };

  it('parks on the orphan branches it found and continues once answered', async () => {
    await startSession();
    const session = await waitFor((s) => s.awaitingOrphans === true);
    expect(session.awaitingOrphans).toBe(true);
    expect(session.orphans).toHaveLength(1);
    expect(session.orphans[0]).toMatchObject({
      branch: 'huu/lostrun/integration',
      runId: 'lostrun',
      ahead: 1,
    });

    const answered = await post(base, '/api/dev/orphans', { action: 'ignore' });
    expect(answered.status).toBe(200);
    expect(answered.json).toMatchObject({ ok: true, action: 'ignore' });

    // A forgotten branch must never BLOCK: the session proceeds to planning.
    const after = await waitFor((s) => s.awaitingApproval === true);
    expect(after.awaitingApproval).toBe(true);
    expect(after.awaitingOrphans).toBe(false);

    // Stale answer → 409.
    expect((await post(base, '/api/dev/orphans', { action: 'land' })).status).toBe(409);
  });

  it('fails CLOSED: aborting while parked answers "ignore" — nothing is merged', async () => {
    await startSession();
    await waitFor((s) => s.awaitingOrphans === true);
    expect((await post(base, '/api/dev/abort', {})).json.ok).toBe(true);
    const after = await waitFor((s) => s.active === false);
    expect(after.active).toBe(false);
    expect(after.awaitingOrphans).toBe(false);
    // The branch is still unmerged — an abort never lands work behind the user.
    const contained = execSync('git branch --contains huu/lostrun/integration', {
      cwd: repo,
      encoding: 'utf8',
    });
    expect(contained).not.toMatch(/^\*?\s*main$/m);
  });
});

// ── The DRAWN METHOD (`huu-devgraph-v1`) over POST /api/dev ─────────────────
//
// THE HOLE THIS CLOSES. The browser could already draw a method, validate it
// and compile it through `/api/graphs` — and then had nowhere to run it:
// `dev-manager.ts` is the ONLY web path into `runDevMode` and it knew nothing
// about graphs. A user could produce a method and never execute it.
//
// Everything below drives the REAL HTTP server against a REAL git repository in
// a temp dir, with the stub backend and no browser. The only stand-in is the
// `runDevMode` spy this file already installs at the top, which lets a test
// read the `dev` literal the manager handed the driver — the direct proof that
// a posted drawing crosses the seam (and that an absent one leaves no trace).
//
// TWO PROPERTIES ARE LOAD-BEARING HERE, and both have several tests each:
//
//  1. A REFUSAL COSTS NOTHING. `resolveDevGraph` runs at the BORDER, so a
//     drawing the driver would stop on is a 400 before a session exists — no
//     worktree, no run id, no lock. Every refusal below asserts `runDevMode`
//     was never called AND that `/api/dev` still reports no session.
//  2. NEVER A FALLBACK. A `graph`/`graphId` that is present and unusable is
//     refused, never dropped: the fallback for "your method could not be read"
//     would be the LLM PLANNER, i.e. silently swapping the human's topology for
//     a model's — the exact thing `dev-driver.ts` refuses at every other layer.

const GRAPH_STAMP = '2026-08-03T00:00:00.000Z';

/** The smallest drawing that compiles: one objective, one box. */
function tinyGraph(over: Partial<DevGraph> = {}): DevGraph {
  return {
    _format: 'huu-devgraph-v1',
    id: 'metodo-minimo',
    name: 'Método mínimo',
    description: 'Um objetivo e uma auditoria.',
    createdAt: GRAPH_STAMP,
    updatedAt: GRAPH_STAMP,
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
    ...over,
  };
}

describe('web server — running a DRAWN method (POST /api/dev with a graph)', () => {
  let repo: string;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'huu-web-dev-graph-'));
    setupRepo(repo);
    // The human saved a drawing through the editor. Nothing loads it behind
    // anyone's back — a session names the method it runs.
    const written = writeGraph(repo, tinyGraph(), GRAPH_STAMP);
    if (!written.ok) throw new Error(`could not seed the graph: ${written.reason}`);
    ({ server } = createWebServer({ cwd: repo, defaultAutoScale: true }));
    base = await listenEphemeral(server);
    vi.mocked(runDevMode).mockClear();
  });

  afterEach(async () => {
    await post(base, '/api/dev/abort', {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(repo, { recursive: true, force: true });
  });

  const startWith = (extra: Record<string, unknown>): Promise<{ status: number; json: any }> =>
    post(base, '/api/dev', {
      goal: 'rodar o método que eu desenhei',
      modelId: 'stub-model',
      backend: 'stub',
      approval: 'each-epoch',
      skipKnowledgeBootstrap: true,
      ...extra,
    });

  const waitFor = async (predicate: (s: any) => boolean, tries = 120): Promise<any> => {
    let session: any;
    for (let i = 0; i < tries; i++) {
      session = (await (await fetch(base + '/api/dev')).json()).session;
      if (session && predicate(session)) return session;
      await new Promise((r) => setTimeout(r, 50));
    }
    return session;
  };

  /** The `dev` literal the manager handed runDevMode (the spy saw it). */
  const postedDev = () => {
    const spy = vi.mocked(runDevMode);
    expect(spy).toHaveBeenCalledTimes(1);
    return spy.mock.calls[0]![0].dev;
  };

  /** Nothing was started: no driver call, and no session to show for it. */
  const assertNothingStarted = async (): Promise<void> => {
    expect(vi.mocked(runDevMode)).not.toHaveBeenCalled();
    const { session } = (await (await fetch(base + '/api/dev')).json()) as { session: unknown };
    expect(session).toBeNull();
  };

  // ── Refusals: a bad drawing never buys a session ─────────────────────────

  it('400s a graphId that names nothing, BEFORE opening a session', async () => {
    const { status, json } = await startWith({ graphId: 'nao-existe' });
    expect(status).toBe(400);
    expect(json.reason).toBe('graph-not-found');
    expect(json.error).toContain('nao-existe');
    await assertNothingStarted();
  });

  it('400s an id that is not even a slug — refused before a path is built', async () => {
    const { status, json } = await startWith({ graphId: '../../etc/passwd' });
    expect(status).toBe(400);
    expect(json.reason).toBe('graph-not-found');
    expect(json.error).toContain('invalid-id');
    await assertNothingStarted();
  });

  it('400s a stored file that is not a huu-devgraph-v1', async () => {
    mkdirSync(join(repo, GRAPHS_DIR), { recursive: true });
    writeFileSync(join(repo, GRAPHS_DIR, 'quebrado.json'), '{"_format":"outra-coisa"}', 'utf8');
    const { status, json } = await startWith({ graphId: 'quebrado' });
    expect(status).toBe(400);
    expect(json.reason).toBe('graph-invalid');
    await assertNothingStarted();
  });

  it('400s a stored file that is not JSON at all', async () => {
    mkdirSync(join(repo, GRAPHS_DIR), { recursive: true });
    writeFileSync(join(repo, GRAPHS_DIR, 'quebrado.json'), '{ not json', 'utf8');
    const { status, json } = await startWith({ graphId: 'quebrado' });
    expect(status).toBe(400);
    expect(json.reason).toBe('graph-invalid');
    await assertNothingStarted();
  });

  // The picker saying "that drawing does not compile" beats a session that
  // opens and immediately stops — and the human gets their own node ids back.
  it('400s an inline drawing with no prompt node, naming the blocking issue', async () => {
    const broken = tinyGraph({
      nodes: [
        {
          id: 'auditar',
          kind: 'action',
          label: 'Auditar',
          position: { x: 0, y: 0 },
          block: 'security-review',
          scope: 'project',
          join: { mode: 'all' },
        },
      ],
      edges: [],
    });
    const { status, json } = await startWith({ graph: broken });
    expect(status).toBe(400);
    expect(json.reason).toBe('graph-invalid');
    expect(json.error).toContain('no-prompt-node');
    await assertNothingStarted();
  });

  it('400s an inline payload that is not a devgraph at all (invalid-schema)', async () => {
    const { status, json } = await startWith({ graph: { foo: 1 } });
    expect(status).toBe(400);
    expect(json.reason).toBe('invalid-schema');
    await assertNothingStarted();
  });

  // NEVER A FALLBACK: dropping a malformed `graph` the way an unknown model
  // role is dropped would start a PLANNER session under a request that asked
  // for a drawing.
  it('400s a "graph" that is a string instead of quietly starting the planner', async () => {
    const { status, json } = await startWith({ graph: 'metodo-minimo' });
    expect(status).toBe(400);
    expect(json.reason).toBe('invalid-schema');
    await assertNothingStarted();
  });

  it('400s a "graph" that is an array', async () => {
    const { status, json } = await startWith({ graph: [] });
    expect(status).toBe(400);
    expect(json.reason).toBe('invalid-schema');
    await assertNothingStarted();
  });

  it('400s a non-string graphId', async () => {
    const { status, json } = await startWith({ graphId: 7 });
    expect(status).toBe(400);
    expect(json.reason).toBe('invalid-id');
    await assertNothingStarted();
  });

  // A graph is the COMPLETE method, so a graph session is exactly one epoch.
  // Refusing here beats a session that opens and dies with `graph-conflict`.
  it('400s maxEpochs >= 2 posted together with a graphId', async () => {
    const { status, json } = await startWith({ graphId: 'metodo-minimo', maxEpochs: 3 });
    expect(status).toBe(400);
    expect(json.reason).toBe('graph-conflict');
    expect(json.error).toContain('maxEpochs=3');
    expect(json.error).toContain('exactly one epoch');
    await assertNothingStarted();
  });

  it('400s maxEpochs >= 2 posted together with an inline graph', async () => {
    const { status, json } = await startWith({ graph: tinyGraph(), maxEpochs: 2 });
    expect(status).toBe(400);
    expect(json.reason).toBe('graph-conflict');
    await assertNothingStarted();
  });

  it('400s an inline graph and a graphId that name DIFFERENT drawings', async () => {
    const { status, json } = await startWith({ graph: tinyGraph(), graphId: 'outro-metodo' });
    expect(status).toBe(400);
    expect(json.reason).toBe('graph-conflict');
    expect(json.error).toContain('metodo-minimo');
    expect(json.error).toContain('outro-metodo');
    await assertNothingStarted();
  });

  // The pure-CONFIGURATION refusal is checked before anything is read from
  // disk, so a caller with both problems hears about the one they can fix
  // without touching the repository.
  it('reports the epoch ceiling, not the missing file, when both are wrong', async () => {
    const { status, json } = await startWith({ graphId: 'nao-existe', maxEpochs: 2 });
    expect(status).toBe(400);
    expect(json.reason).toBe('graph-conflict');
    await assertNothingStarted();
  });

  it('a refusal leaves no session behind — the next valid start still works', async () => {
    expect((await startWith({ graphId: 'nao-existe' })).status).toBe(400);
    await assertNothingStarted();
    const ok = await startWith({ graphId: 'metodo-minimo' });
    expect(ok.status).toBe(200);
    expect(ok.json.sessionId).toBeTruthy();
    expect(vi.mocked(runDevMode)).toHaveBeenCalledTimes(1);
  });

  // ── Accepted: what the session becomes ───────────────────────────────────

  it('accepts maxEpochs: 1 — the ceiling a drawing already is', async () => {
    const { status } = await startWith({ graphId: 'metodo-minimo', maxEpochs: 1 });
    expect(status).toBe(200);
    expect(postedDev().maxEpochs).toBe(1);
  });

  it('exposes the drawing on the snapshot from the very first frame', async () => {
    const { status, json } = await startWith({ graphId: 'metodo-minimo' });
    expect(status).toBe(200);
    expect(json.sessionId).toBeTruthy();

    const session = (await (await fetch(base + '/api/dev')).json()).session;
    expect(session.drawnMethod).toEqual({
      id: 'metodo-minimo',
      name: 'Método mínimo',
      description: 'Um objetivo e uma auditoria.',
    });
    // Every pre-existing field survives — the client renders the whole snapshot.
    expect(session.goal).toBe('rodar o método que eu desenhei');
    expect(session.approval).toBe('each-epoch');
    expect(session.backend).toBe('stub');
    expect(session.methodologies).toEqual([]);
    expect(Object.keys(session.models).length).toBeGreaterThan(0);
  });

  // The driver pins a graph session to ONE epoch, so a snapshot claiming "no
  // ceiling" would contradict the session it describes.
  it('reads the epoch ceiling back as 1 even though the browser posts none', async () => {
    await startWith({ graphId: 'metodo-minimo' });
    const session = (await (await fetch(base + '/api/dev')).json()).session;
    expect(session.maxEpochs).toBe(1);
  });

  // THE SEAM PROOF: the resolved drawing crosses BY VALUE, so the store is read
  // once and a file rewritten in between cannot swap the method mid-session.
  it('hands runDevMode the RESOLVED drawing, by value, plus the id that named it', async () => {
    await startWith({ graphId: 'metodo-minimo' });
    const dev = postedDev();
    expect(dev.graphId).toBe('metodo-minimo');
    expect(dev.graph).toEqual(tinyGraph());
  });

  // The web deliberately sends no ceiling; the driver must see `undefined`, not
  // a number this layer invented.
  it('still sends NO epoch ceiling to the driver on the graph path', async () => {
    await startWith({ graphId: 'metodo-minimo' });
    expect(postedDev().maxEpochs).toBeUndefined();
  });

  it('accepts an inline graph with no id field posted beside it', async () => {
    const { status } = await startWith({ graph: tinyGraph() });
    expect(status).toBe(200);
    const dev = postedDev();
    expect(dev.graph).toEqual(tinyGraph());
    expect('graphId' in dev).toBe(false);
    const session = (await (await fetch(base + '/api/dev')).json()).session;
    expect(session.drawnMethod.id).toBe('metodo-minimo');
  });

  it('propagates the `planned` announcement onto the snapshot', async () => {
    await startWith({ graphId: 'metodo-minimo' });
    const session = await waitFor((s) => s.graph !== undefined);
    expect(session.graph.id).toBe('metodo-minimo');
    expect(session.graph.name).toBe('Método mínimo');
    // The prompt node emits nothing, so it is absent from the emission order.
    expect(session.graph.nodeOrder).toEqual(['auditar']);
    expect(session.graph.stepsByNode.auditar).toHaveLength(1);
    expect(session.graph.stepsByNode.auditar[0]).toContain('[auditar]');
  });

  it('namespaces the announced blackboard root by session AND epoch', async () => {
    const { json } = await startWith({ graphId: 'metodo-minimo' });
    const session = await waitFor((s) => s.graph !== undefined);
    expect(session.graph.graphRoot).toContain(json.sessionId);
    expect(session.graph.graphRoot).toContain('epoch-1');
  });

  // The synthetic `DevPlan` is what every existing panel already renders — the
  // graph rides BESIDE it, it does not replace it.
  it('still fills session.plan, so the panels that exist keep working', async () => {
    await startWith({ graphId: 'metodo-minimo' });
    const session = await waitFor((s) => s.awaitingApproval === true);
    expect(session.plan.epochGoal).toBe('Método mínimo');
    expect(session.plan.goalComplete).toBe(false);
    expect(session.plan.fronts).toHaveLength(1);
    expect(session.plan.fronts[0].title).toBe('Auditar');
  });

  // WHERE THE HUMAN FINDS OUT their checkboxes were not compiled: a drawing
  // expresses method by DRAWING it, so the flags are WARNED, never applied.
  it('warns that the methodology checkboxes were NOT compiled into the drawing', async () => {
    await startWith({ graphId: 'metodo-minimo', methodology: { tdd: true, standards: true } });
    const session = await waitFor((s) => s.planWarnings.length > 0);
    const joined = session.planWarnings.join('\n');
    expect(joined).toContain('tdd');
    expect(joined).toContain('standards');
    expect(joined).toMatch(/does NOT compile the methodology flags/);
    // …and the flags still reach the driver: the warning is the driver's, which
    // is only possible because the session really carries them.
    expect(postedDev().methodology).toEqual({ tdd: true, standards: true });
  });

  it('warns that per-role model routing was NOT applied to the drawing', async () => {
    await startWith({ graphId: 'metodo-minimo', models: { worker: 'algum/modelo' } });
    const session = await waitFor((s) => s.planWarnings.length > 0);
    const joined = session.planWarnings.join('\n');
    expect(joined).toContain('worker');
    expect(joined).toMatch(/NOT applied to a drawn method/);
  });

  // The gate still gates, and it still fails CLOSED: a method drawn last week
  // is not automatically the method the human wants run right now.
  it('parks a drawn session at the approval gate and stops when it is rejected', async () => {
    await startWith({ graphId: 'metodo-minimo' });
    const parked = await waitFor((s) => s.awaitingApproval === true);
    expect(parked.phase).toBe('awaiting-approval');
    expect(parked.graph.id).toBe('metodo-minimo');
    expect(parked.epochs).toEqual([]);
    expect(parked.runIds).toEqual([]);

    expect((await post(base, '/api/dev/approve', { approved: false })).status).toBe(200);
    const done = await waitFor((s) => s.active === false);
    expect(done.stoppedBecause).toBe('plan-rejected');
    expect(done.epochs).toEqual([]);
    // The drawing stays on the snapshot after the stop — the panel still has
    // something to explain the session with.
    expect(done.drawnMethod.id).toBe('metodo-minimo');
  });

  // One session at a time still holds: every epoch ends in a merge into the
  // working branch, and a drawing is no exception.
  it('refuses a second concurrent session with 409, drawn or not', async () => {
    expect((await startWith({ graphId: 'metodo-minimo' })).status).toBe(200);
    const second = await startWith({ goal: 'outro', graphId: 'metodo-minimo' });
    expect(second.status).toBe(409);
    expect(second.json.error).toMatch(/already running/);
  });

  // THE ONE THAT PROVES THE HOLE IS CLOSED: a method drawn by a human, started
  // from the browser's own endpoint, running to completion through the real
  // orchestrator (stub backend, real worktrees, real merge).
  it('runs a drawn method end to end from POST /api/dev', async () => {
    const { status } = await startWith({
      goal: 'auditar o repositório com o meu método',
      graphId: 'metodo-minimo',
      approval: 'autonomous',
    });
    expect(status).toBe(200);

    const done = await waitFor((s) => s.active === false, 2400);
    expect(done.active).toBe(false);
    expect(done.stoppedBecause).toBe('max-epochs');
    expect(done.detail).toContain('COMPLETE method');
    expect(done.phase).toBe('done');
    // Exactly one epoch, and exactly one run inside it: Phases A and B never
    // happened, so there is no knowledge run to find.
    expect(done.epochs).toHaveLength(1);
    expect(done.runIds).toHaveLength(1);
    expect(done.runIds[0].phase).toBe('work');
    expect(done.runIds[0].epoch).toBe(1);
    // The LLM planner was never called — the topology is the human's.
    expect(postedDev().graph?.id).toBe('metodo-minimo');
    // The epoch really LANDED on the working branch, and the working tree came
    // out clean — a session that stops for a clean reason having merged nothing
    // is the failure mode this assertion exists to catch.
    expect(done.epochs[0].status).toBe('done');
    expect(done.epochs[0].landedCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(execSync('git status --porcelain', { cwd: repo, encoding: 'utf8' }).trim()).toBe('');
    expect(
      execSync(`git merge-base --is-ancestor ${done.epochs[0].landedCommit} HEAD`, {
        cwd: repo,
        encoding: 'utf8',
      }),
    ).toBe('');
    // The drawn box really produced work: the stub agent's marker rode the
    // integration merge into the user's branch.
    expect(execSync('git ls-files', { cwd: repo, encoding: 'utf8' })).toMatch(/STUB_/);
  }, 180_000);

  // ── The additive contract: no drawing ⇒ nothing changed ──────────────────

  it('treats graph:null and a blank graphId as no drawing at all', async () => {
    const { status } = await startWith({ graph: null, graphId: '   ' });
    expect(status).toBe(200);
    const dev = postedDev();
    expect('graph' in dev).toBe(false);
    expect('graphId' in dev).toBe(false);
    const session = (await (await fetch(base + '/api/dev')).json()).session;
    expect(session.drawnMethod).toBeUndefined();
    // No drawing ⇒ the web's "no ceiling" survives untouched.
    expect(session.maxEpochs).toBeNull();
  });

  it('a session with no graph fields is exactly the session it was before', async () => {
    const { status } = await startWith({});
    expect(status).toBe(200);
    const dev = postedDev();
    expect('graph' in dev).toBe(false);
    expect('graphId' in dev).toBe(false);
    expect(dev.maxEpochs).toBeUndefined();

    const session = await waitFor((s) => s.awaitingApproval === true);
    expect(session.drawnMethod).toBeUndefined();
    expect(session.graph).toBeUndefined();
    expect(session.maxEpochs).toBeNull();
    // …and it planned, which is the tell: the planner still owns the topology
    // when nobody drew one.
    expect(session.plan.fronts.length).toBeGreaterThan(0);
  });
});

// ── Resuming a DRAWN session ───────────────────────────────────────────────
//
// A resume re-opens a SESSION; it does not re-open the ARGUMENTS the session
// was started with. `resolveDevGraph` only ever reads `dev.graph`/`dev.graphId`,
// which nobody but the caller can supply — so a surface that forgets to re-send
// the selection would hand epoch 2 of a session a human opened as a DRAWING
// over to the LLM planner, with nothing on screen saying so. The driver refuses
// (`graph-missing-on-resume`); these tests prove the WEB surface is on the
// right side of that refusal — it re-supplies the drawing whenever the browser
// re-posts the id, and it surfaces the refusal when it does not.

/** A previous session's state file, drawn rather than planned. */
function seedDrawnSession(repo: string, goal: string, sessionId: string, graph: DevGraph): void {
  mkdirSync(join(repo, '.huu', 'dev'), { recursive: true });
  writeFileSync(
    join(repo, '.huu', 'dev', 'state.json'),
    JSON.stringify(
      {
        _format: 'huu-devstate-v2',
        goal,
        doneWhen: '',
        epochs: [],
        goalComplete: false,
        updatedAt: new Date().toISOString(),
        sessionId,
        drawnMethod: { graphId: graph.id, graphName: graph.name },
      },
      null,
      2,
    ),
    'utf8',
  );
}

describe('web server — resuming a session that was DRAWN', () => {
  const GOAL = 'continuar o método que eu desenhei';
  const PREVIOUS = 'sessao-desenhada';
  let repo: string;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'huu-web-dev-graph-resume-'));
    setupRepo(repo);
    for (const graph of [tinyGraph(), tinyGraph({ id: 'outro-metodo', name: 'Outro método' })]) {
      const written = writeGraph(repo, graph, GRAPH_STAMP);
      if (!written.ok) throw new Error(`could not seed the graph: ${written.reason}`);
    }
    seedDrawnSession(repo, GOAL, PREVIOUS, tinyGraph());
    ({ server } = createWebServer({ cwd: repo, defaultAutoScale: true }));
    base = await listenEphemeral(server);
  });

  afterEach(async () => {
    await post(base, '/api/dev/abort', {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(repo, { recursive: true, force: true });
  });

  const startSession = (extra: Record<string, unknown> = {}): Promise<{ status: number; json: any }> =>
    post(base, '/api/dev', {
      goal: GOAL,
      modelId: 'stub-model',
      backend: 'stub',
      approval: 'each-epoch',
      skipKnowledgeBootstrap: true,
      ...extra,
    });

  const waitFor = async (predicate: (s: any) => boolean, tries = 160): Promise<any> => {
    let session: any;
    for (let i = 0; i < tries; i++) {
      session = (await (await fetch(base + '/api/dev')).json()).session;
      if (session && predicate(session)) return session;
      await new Promise((r) => setTimeout(r, 50));
    }
    return session;
  };

  // THE TRAP THIS CLOSES: the driver refuses a resume that does not bring the
  // drawing back, and it is right to — but the offer used to say only "resume
  // session X". The human clicked "retomar" on a session whose next epoch could
  // not start, with nothing on screen naming the drawing to re-select. The
  // offer now carries the previous session's `drawnMethod` verbatim, so the
  // button can both SAY which method it was and re-select it.
  it('names the drawing the previous session ran, so the resume can bring it back', async () => {
    expect((await startSession({ graphId: 'metodo-minimo' })).status).toBe(200);
    const session = await waitFor((s) => s.awaitingResume === true);

    expect(session.resumeOffer).toEqual({
      sessionId: PREVIOUS,
      goal: GOAL,
      epochsDone: 0,
      nextEpoch: 1,
      drawnMethod: { graphId: 'metodo-minimo', graphName: 'Método mínimo' },
    });
    // Said in the log too, so a client that has not learned the field still
    // shows the human what the accept depends on.
    expect(
      session.logs.some(
        (l: { level: string; message: string }) =>
          l.level === 'warn' && l.message.includes('metodo-minimo'),
      ),
    ).toBe(true);
  });

  // The offer describes the SESSION ON DISK, not the request: a browser that
  // forgot the drawing is exactly the case the field exists for, so the offer
  // must still name it (that is what lets the UI recover instead of failing).
  it('names it even when the start request carried no drawing at all', async () => {
    expect((await startSession({})).status).toBe(200);
    const session = await waitFor((s) => s.awaitingResume === true);
    expect(session.resumeOffer.drawnMethod).toEqual({
      graphId: 'metodo-minimo',
      graphName: 'Método mínimo',
    });
  });

  it('continues the session when the browser re-posts the same drawing', async () => {
    expect((await startSession({ graphId: 'metodo-minimo' })).status).toBe(200);
    await waitFor((s) => s.awaitingResume === true);
    expect((await post(base, '/api/dev/resume', { accept: true })).status).toBe(200);

    const session = await waitFor((s) => s.awaitingApproval === true);
    expect(session.awaitingApproval).toBe(true);
    expect(session.resumed).toBe(true);
    expect(session.sessionId).toBe(PREVIOUS);
    // Still a drawing, and still the SAME drawing — the planner never got it.
    expect(session.drawnMethod.id).toBe('metodo-minimo');
    expect(session.graph.nodeOrder).toEqual(['auditar']);
    expect(session.stoppedBecause).toBeUndefined();
  });

  // The refusal the driver exists to make, seen from the browser.
  it('refuses the resume when the drawing is not re-supplied', async () => {
    expect((await startSession({})).status).toBe(200);
    await waitFor((s) => s.awaitingResume === true);
    expect((await post(base, '/api/dev/resume', { accept: true })).status).toBe(200);

    const session = await waitFor((s) => s.active === false);
    expect(session.stoppedBecause).toBe('graph-missing-on-resume');
    expect(session.detail).toContain('metodo-minimo');
    expect(session.phase).toBe('error');
    // Nothing ran: the refusal precedes every side effect.
    expect(session.epochs).toEqual([]);
    expect(session.runIds).toEqual([]);
  });

  // Two layers, two refusals: the BORDER refuses a drawing it cannot read, the
  // DRIVER refuses a drawing that does not belong to the session being resumed.
  it('refuses a resume that carries a DIFFERENT drawing', async () => {
    expect((await startSession({ graphId: 'outro-metodo' })).status).toBe(200);
    await waitFor((s) => s.awaitingResume === true);
    expect((await post(base, '/api/dev/resume', { accept: true })).status).toBe(200);

    const session = await waitFor((s) => s.active === false);
    expect(session.stoppedBecause).toBe('graph-conflict');
    expect(session.detail).toContain('metodo-minimo');
    expect(session.detail).toContain('outro-metodo');
    expect(session.epochs).toEqual([]);
  });

  // Declining the offer is not the refusal path: a NEW session under the same
  // goal is the human's call, and it runs their drawing from epoch 1.
  it('starts a fresh drawn session when the human declines the resume', async () => {
    const { json } = await startSession({ graphId: 'metodo-minimo' });
    await waitFor((s) => s.awaitingResume === true);
    expect((await post(base, '/api/dev/resume', { accept: false })).status).toBe(200);

    const session = await waitFor((s) => s.awaitingApproval === true);
    expect(session.resumed).toBe(false);
    expect(session.sessionId).toBe(json.sessionId);
    expect(session.drawnMethod.id).toBe('metodo-minimo');
    expect(session.stoppedBecause).toBeUndefined();
  });
});

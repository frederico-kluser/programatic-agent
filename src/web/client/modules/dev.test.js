// @vitest-environment jsdom
/* huu web UI — development mode, wired against the REAL index.html.
   ================================================================

   WHAT THIS SUITE IS FOR. `POST /api/dev` already accepted `graphId`, already
   refused an unusable one with a 400, and already reported `drawnMethod`,
   `graph` and `planWarnings` back on the session snapshot. NOTHING in the
   browser sent or rendered any of it. So the assertions below are almost all
   about ONE thing: the exact bytes the form puts on the wire, and the exact
   sentences the session panel puts on screen.

   HOW IT MOUNTS, since `dev.js` is not a pure module. It wires the form and
   calls `boot()` at import time, and `launch.js` (which it imports) touches
   `#backToLaunch` at import time too. So the whole thing is bootstrapped the
   way the browser bootstraps it:

     • the BODY of the real `client/index.html` is parsed into the document —
       not a fixture, so an id renamed in the markup fails here instead of
       silently rendering nothing (scripts inserted through `innerHTML` never
       execute, so `app.js` does not run twice);
     • `fetch` is replaced by a small router that answers the endpoints boot
       needs and RECORDS every request, which is what makes "the POST carried
       graphId and no maxEpochs" an assertion about the wire rather than about
       a helper;
     • `EventSource` is a stub: the SSE stream is not what is under test, and
       jsdom has none.

   Then the module is imported ONCE and the tests drive the DOM it wired. The
   consequence, stated so nobody is surprised: module state (the picker, the
   methodology set) is SHARED, so each test resets what it depends on through
   `resetForm()` instead of assuming a fresh module.

   WHAT IT CANNOT SEE. jsdom has no layout and no rendering: `hidden` and class
   names are asserted, visibility is not. It also does not run the SERVER — the
   400s this UI is designed to avoid (`graph-conflict`, `graph-not-found`,
   `graph-missing-on-resume`) are pinned by `src/web/dev-manager.test.ts`
   against a real server; here we prove the browser sends what that server
   needs. */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { messagesFor } from '../../../lib/i18n/index.js';
import { DEV_METHODOLOGIES } from '../../../lib/dev-mode/methodology-registry.js';

/* ── The fake wire ──────────────────────────────────────────────────────── */

/** Every request the client made, in order: `{method, path, body}`. */
let calls = [];
/** path (without query) → handler(body, url) → any JSON, or a `Response`. */
let routes = {};

const GRAPHS = [
  {
    id: 'auditoria',
    name: 'Auditoria paralela',
    updatedAt: '2026-01-02T00:00:00.000Z',
    nodeCount: 4,
    edgeCount: 3,
    valid: true,
  },
  {
    id: 'quebrado',
    name: 'Meio desenhado',
    updatedAt: '2026-01-01T00:00:00.000Z',
    nodeCount: 2,
    edgeCount: 0,
    valid: false,
  },
];

const BOOTSTRAP = {
  repo: 'huu',
  cwd: '/repo',
  workspace: '/repo',
  pipelines: [],
  runs: [],
  providers: [
    { id: 'openrouter', label: 'OpenRouter', description: 'x', backend: 'pi', hasKey: true, keySpecs: [] },
    { id: 'deepseek', label: 'DeepSeek', description: 'y', backend: 'pi', hasKey: true, keySpecs: [] },
  ],
  backends: [{ id: 'pi', apiKeySpecName: 'openrouter' }],
  devModelRoles: ['planner', 'worker', 'critic'],
  devModelPresets: {
    hetero: { planner: 'z-ai/glm-5.2', worker: 'deepseek/deepseek-v4-flash', critic: 'anthropic/claude-sonnet-4' },
    roster: { planner: 'openrouter:anthropic/claude-opus-5', worker: 'deepseek/deepseek-v4-flash', critic: 'openrouter:openai/gpt-5.6-sol' },
    uniform: {},
  },
  // The server's own verdict (`checkDevModelPolicy` per provider), shipped so
  // the form never reimplements the rule it has to obey.
  devModelPresetProviders: {
    hetero: ['openrouter'],
    roster: ['openrouter'],
    uniform: ['deepseek', 'openrouter'],
  },
  devMethodologyOptions: DEV_METHODOLOGIES.map(({ key, label, description }) => ({ key, label, description })),
  // The graph catalog projection: its presence is what un-hides the method panel.
  graphNodeKinds: [{ kind: 'prompt', label: 'Prompt' }, { kind: 'action', label: 'Action' }],
  graphBlocks: [],
  graphSamples: [],
  defaults: {},
};

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

function installFetch() {
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const path = url.split('?')[0];
    const method = (init.method || 'GET').toUpperCase();
    let body;
    if (typeof init.body === 'string' && init.body) {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    calls.push({ method, path, body, url });
    const route = routes[`${method} ${path}`] || routes[path];
    if (!route) return jsonResponse({ error: `no route for ${method} ${path}` }, 404);
    const answer = await route(body, url);
    return answer && typeof answer.json === 'function' ? answer : jsonResponse(answer);
  };
}

function baseRoutes() {
  return {
    '/api/i18n': () => ({
      locale: 'en',
      defaultLocale: 'en',
      locales: [{ id: 'en', label: 'English' }],
      messages: messagesFor('en'),
    }),
    '/api/bootstrap': () => BOOTSTRAP,
    '/api/models': () => ({ models: [{ id: 'deepseek/deepseek-v4-flash', label: 'ds' }], source: 'live' }),
    '/api/keys/status': () => ({ ok: true, missing: [] }),
    '/api/folders': () => ({
      path: '/repo',
      parent: null,
      isGitRepo: true,
      entries: [{ path: '/repo/sub', name: 'sub' }],
    }),
    '/api/graphs': () => ({ graphs: GRAPHS }),
    'GET /api/dev': () => ({ session: null }),
    'POST /api/dev': () => ({ sessionId: 'sessao-1', ok: true }),
    'POST /api/dev/abort': () => ({ ok: true }),
    'POST /api/dev/resume': () => ({ ok: true, accept: true }),
    'POST /api/dev/approve': () => ({ ok: true }),
    // The SETTLED half of the debate chat. `present: false` is the DEFAULT
    // answer the server gives (`--debate` is off unless asked for), so the
    // chat below renders off the LIVE half alone unless a test overrides it.
    '/api/dev/debate': () => ({ present: false }),
  };
}

/* ── The module under test, imported once the document exists ───────────── */

/** @type {any} */
let dev;
/** @type {any} */
let state;
/** @type {any} */
let board;
/** @type {any} */
let launch;
/** The EventSource `connectSse()` last built — the seam the SSE tests drive. */
/** @type {any} */
let lastEventSource = null;

const $ = (id) => document.getElementById(id);

/** Wait for the microtask + timer queues the client uses. */
async function flush(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** Real wall-clock wait — the debate chat coalesces its repaints on a 120ms
 *  trailing timer, which `flush()`'s 1ms ticks never reach. */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The BODY of the real index.html, parsed into a detached fragment.
 *  Used to assert on the markup AS SHIPPED, before any render touched it. */
function parseIndexBody() {
  const here = dirname(fileURLToPath(import.meta.url));
  const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
  const body = html.slice(html.indexOf('<body'), html.lastIndexOf('</body>'));
  const tpl = document.createElement('template');
  tpl.innerHTML = body.slice(body.indexOf('>') + 1);
  return tpl.content;
}

beforeAll(async () => {
  // `fileURLToPath(import.meta.url)` takes the STRING: jsdom replaces the
  // global `URL` constructor, and a whatwg-url instance is not what node:url
  // accepts ("The URL must be of scheme file").
  const here = dirname(fileURLToPath(import.meta.url));
  const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
  const body = html.slice(html.indexOf('<body'), html.lastIndexOf('</body>'));
  document.body.innerHTML = body.slice(body.indexOf('>') + 1);
  // The SSE stream is not what is under test and jsdom has none; the cast is
  // because this stub only implements what `connectSse` actually touches.
  globalThis.EventSource = /** @type {any} */ (
    class {
      constructor() {
        this.readyState = 1;
        // Recorded so a test can push a frame through the REAL `es.onmessage`
        // handler in board.js — which is where the firehose is forked into the
        // console mirror and the debate chat.
        lastEventSource = this;
      }
      addEventListener() {}
      close() {}
      static get CLOSED() { return 2; }
    }
  );
  // `renderBoard` asks the platform whether to animate (`prefers-reduced-
  // motion`); jsdom has no media queries, and without this the FIRST run
  // snapshot pushed through `ingestRun` throws before anything is asserted.
  globalThis.matchMedia =
    globalThis.matchMedia ||
    /** @type {any} */ (
      (query) => ({
        media: query,
        matches: true,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
      })
    );
  // Switching to /graph mounts React Flow for real, and it measures the pane.
  globalThis.ResizeObserver =
    globalThis.ResizeObserver ||
    /** @type {any} */ (
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
  routes = baseRoutes();
  installFetch();
  dev = await import('./dev.js');
  state = await import('./state.js');
  // Same module instances dev.js already pulled in — the wiring under test in
  // section 8 lives in board.js, and the view switching in launch.js.
  board = await import('./board.js');
  launch = await import('./launch.js');
  // `boot()` fires at import time; let it settle before anything is asserted.
  await flush(30);
  dev.initDevSurface();
  await flush(20);
});

/** Put the form back on its defaults — module state is shared across tests. */
function resetForm(overrides = {}) {
  calls = [];
  routes = { ...baseRoutes(), ...(overrides.routes || {}) };
  state.S.devDir = overrides.devDir === undefined ? '/repo' : overrides.devDir;
  state.S.provider = 'openrouter';
  state.S.backend = 'pi';
  state.S.devSession = null;
  state.S.devGraphId = '';
  state.S.devGraphName = '';
  /** @type {HTMLTextAreaElement} */ ($('devGoal')).value = overrides.goal ?? 'migrar o parser';
  dev.setDevMethodSource('planner');
  dev.selectDevGraph('');
  // Approval + fronts back to the shipped defaults.
  for (const b of Array.from($('devApprovalSeg').querySelectorAll('[data-approval]'))) {
    b.classList.toggle('on', b.getAttribute('data-approval') === 'autonomous');
  }
  for (const b of Array.from($('devFrontsSeg').querySelectorAll('[data-fronts-mode]'))) {
    b.classList.toggle('on', b.getAttribute('data-fronts-mode') === 'auto');
  }
  $('devFrontsRow').hidden = true;
}

beforeEach(() => {
  resetForm();
});

afterEach(() => {
  calls = [];
});

/** Submit the dev form for real and wait for the POST to land. */
async function submitDevForm() {
  $('devForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush(12);
  return calls.find((c) => c.method === 'POST' && c.path === '/api/dev');
}

function click(el) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function pickMethodSource(value) {
  click($('devMethodSourceSeg').querySelector(`[data-method-source="${value}"]`));
}

/* ─────────────────────────────────────────────────────────────────────────
   1. THE PLANNER PATH IS UNTOUCHED.

   This is the invariant the whole wave is measured against: a dev session with
   no drawing has to post the body it posted before the drawing existed. It is
   asserted FIRST, and asserted against the literal object rather than against
   "contains", so a field ADDED by accident fails just as loudly as one removed.
   ───────────────────────────────────────────────────────────────────────── */
describe('dev form — a session with NO drawing posts the body it always posted', () => {
  it('sends exactly the historical fields, and never maxEpochs', async () => {
    const post = await submitDevForm();
    expect(post).toBeTruthy();
    expect(post.body).toEqual({
      goal: 'migrar o parser',
      provider: 'openrouter',
      modelId: 'deepseek/deepseek-v4-flash',
      runDirectory: '/repo',
      approval: 'autonomous',
      // `models` is ABSENT: nothing was typed over the preset, so
      // `buildDevModelsPayload` sends the preset NAME alone and the server
      // expands it. That is the shape this form has always posted.
      modelsPreset: 'hetero',
    });
    // The two fields this wave is about are ABSENT, not empty.
    expect('graphId' in post.body).toBe(false);
    expect('maxEpochs' in post.body).toBe(false);
    // `apiKey` and `maxFronts` are undefined on this path and JSON drops them.
    expect('apiKey' in post.body).toBe(false);
    expect('maxFronts' in post.body).toBe(false);
  });

  it('keeps maxFronts when the human pins it — the planner half still works', async () => {
    click($('devFrontsSeg').querySelector('[data-fronts-mode="manual"]'));
    /** @type {HTMLInputElement} */ ($('devFronts')).value = '2';
    const post = await submitDevForm();
    expect(post.body.maxFronts).toBe(2);
    expect('graphId' in post.body).toBe(false);
  });

  it('builds the same body through devStartBody as the submit puts on the wire', async () => {
    const post = await submitDevForm();
    expect(dev.devStartBody('migrar o parser', 'deepseek/deepseek-v4-flash')).toEqual(post.body);
  });

  it('reports the planner as the default source, with no drawing selected', () => {
    expect(dev.devMethodSource()).toBe('planner');
    expect(dev.devSelectedGraph()).toBeNull();
    expect(dev.devGraphPayload()).toEqual({});
  });

  it('leaves the two metadata warnings hidden', () => {
    expect($('devModelsMetaWarn').hidden).toBe(true);
    expect($('devMethodMetaWarn').hidden).toBe(true);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   2. CHOOSING A DRAWING IN THE /dev FORM.
   ───────────────────────────────────────────────────────────────────────── */
describe('dev form — choosing a method the human drew', () => {
  it('shows the method panel only because the server advertised the catalog', () => {
    expect($('devMethodSourcePanel').hidden).toBe(false);
    expect(dev.devGraphAvailable()).toBe(true);
  });

  it('hides the picker row until "drawn method" is chosen', () => {
    expect($('devGraphPickRow').hidden).toBe(true);
    pickMethodSource('graph');
    expect($('devGraphPickRow').hidden).toBe(false);
  });

  it('lists the project’s saved methods from GET /api/graphs?dir=', async () => {
    pickMethodSource('graph');
    await dev.loadDevGraphs(true);
    const listing = calls.filter((c) => c.path === '/api/graphs');
    expect(listing.length).toBeGreaterThan(0);
    expect(listing[listing.length - 1].url).toContain('dir=' + encodeURIComponent('/repo'));

    const options = Array.from($('devGraphSelect').querySelectorAll('option'));
    // The placeholder plus one row per saved method, invalid ones included.
    expect(options.map((o) => o.value)).toEqual(['', 'auditoria', 'quebrado']);
  });

  it('tags an INVALID method instead of hiding it', async () => {
    pickMethodSource('graph');
    await dev.loadDevGraphs(true);
    const bad = Array.from($('devGraphSelect').querySelectorAll('option')).find((o) => o.value === 'quebrado');
    expect(bad.textContent).toContain('has problems');
  });

  it('swaps the hint when the source changes', () => {
    expect($('devMethodSourceHint').textContent).toContain('planner decomposes');
    pickMethodSource('graph');
    expect($('devMethodSourceHint').textContent).toContain('one epoch, no planner');
  });

  it('carries graphId on the POST — and still no maxEpochs', async () => {
    pickMethodSource('graph');
    await dev.loadDevGraphs(true);
    dev.selectDevGraph('auditoria');
    const post = await submitDevForm();
    expect(post.body.graphId).toBe('auditoria');
    expect('maxEpochs' in post.body).toBe(false);
    // Everything else is the body the form always sent.
    expect(post.body.goal).toBe('migrar o parser');
    expect(post.body.runDirectory).toBe('/repo');
  });

  it('still requires the goal — the driver has no default for it', async () => {
    resetForm({ goal: '   ' });
    pickMethodSource('graph');
    await dev.loadDevGraphs(true);
    dev.selectDevGraph('auditoria');
    const post = await submitDevForm();
    expect(post).toBeUndefined();
    expect(dev.devSubmitBlocker('', 'm').message).toContain('goal');
  });

  it('refuses to submit "drawn method" with nothing chosen', async () => {
    pickMethodSource('graph');
    await dev.loadDevGraphs(true);
    dev.selectDevGraph('');
    const post = await submitDevForm();
    expect(post).toBeUndefined();
  });

  it('refuses to submit a method the validator already rejected', async () => {
    pickMethodSource('graph');
    await dev.loadDevGraphs(true);
    dev.selectDevGraph('quebrado');
    expect(dev.devSubmitBlocker('goal', 'model').message).toContain('problems');
    const post = await submitDevForm();
    expect(post).toBeUndefined();
  });

  it('goes back to the planner body, byte for byte, when the source is switched back', async () => {
    pickMethodSource('graph');
    await dev.loadDevGraphs(true);
    dev.selectDevGraph('auditoria');
    const withGraph = dev.devStartBody('g', 'm');
    pickMethodSource('planner');
    const without = dev.devStartBody('g', 'm');
    expect(withGraph.graphId).toBe('auditoria');
    expect('graphId' in without).toBe(false);
    delete withGraph.graphId;
    expect(without).toEqual(withGraph);
  });

  it('shows the node/edge count of the chosen method', async () => {
    pickMethodSource('graph');
    await dev.loadDevGraphs(true);
    dev.selectDevGraph('auditoria');
    expect($('devGraphHint').textContent).toContain('4 node(s)');
    expect($('devGraphPickedName').textContent).toBe('Auditoria paralela');
  });

  it('says so when the project has no saved method at all', async () => {
    resetForm({ routes: { '/api/graphs': () => ({ graphs: [] }) } });
    pickMethodSource('graph');
    await dev.loadDevGraphs(true);
    expect($('devGraphHint').textContent).toContain('no saved method');
  });

  it('reports a listing failure instead of pretending the library is empty', async () => {
    resetForm({
      routes: { '/api/graphs': () => jsonResponse({ error: 'permission denied' }, 500) },
    });
    pickMethodSource('graph');
    await dev.loadDevGraphs(true);
    expect($('devGraphHint').textContent).toContain('permission denied');
    expect($('devGraphHint').className).toContain('dev-graph-hint--bad');
  });

  it('re-lists — and drops the selection — when the project changes', async () => {
    pickMethodSource('graph');
    await dev.loadDevGraphs(true);
    dev.selectDevGraph('auditoria');
    expect(dev.devSelectedGraph()).toBeTruthy();

    routes['/api/graphs'] = () => ({ graphs: [{ id: 'outro', name: 'Outro', updatedAt: '', nodeCount: 1, edgeCount: 0, valid: true }] });
    dev.selectDevDir('/outro-repo');
    await flush(10);
    // The old id does not exist in the new project — keeping it would post a
    // `graphId` the server can only answer with `graph-not-found`.
    expect(dev.devSelectedGraph()).toBeNull();
    expect(dev.devGraphPayload()).toEqual({});
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   3. THE METADATA WARNING — announced, never hidden.
   ───────────────────────────────────────────────────────────────────────── */
describe('dev form — the methodology boxes and the role routing are ANNOUNCED', () => {
  it('warns on both panels the moment a drawing is chosen', () => {
    pickMethodSource('graph');
    expect($('devModelsMetaWarn').hidden).toBe(false);
    expect($('devMethodMetaWarn').hidden).toBe(false);
  });

  it('keeps the twelve boxes on screen and usable', () => {
    pickMethodSource('graph');
    // The panel is the server's list, rendered; the warning sits ABOVE it.
    expect($('devMethodPanel').hidden).toBe(false);
    expect($('devMethodList').querySelectorAll('[data-method]').length)
      .toBe(DEV_METHODOLOGIES.length);
    expect($('devModelsPanel').hidden).toBe(false);
    expect($('devRoleFields').querySelectorAll('input[data-role]').length).toBe(3);
  });

  it('still SENDS the methodology and the routing — the driver reports them back', async () => {
    pickMethodSource('graph');
    await dev.loadDevGraphs(true);
    dev.selectDevGraph('auditoria');
    click($('devMethodList').querySelector('[data-method="tdd"]'));
    const post = await submitDevForm();
    expect(post.body.graphId).toBe('auditoria');
    expect(post.body.methodology).toEqual({ tdd: true });
    expect(post.body.modelsPreset).toBe('hetero');
    // Turn it back off so the shared module state does not leak.
    click($('devMethodList').querySelector('[data-method="tdd"]'));
  });

  it('takes the warnings away when the planner is chosen again', () => {
    pickMethodSource('graph');
    pickMethodSource('planner');
    expect($('devModelsMetaWarn').hidden).toBe(true);
    expect($('devMethodMetaWarn').hidden).toBe(true);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   4. THE HAND-OFF FROM THE CANVAS.
   ───────────────────────────────────────────────────────────────────────── */
describe('the canvas hand-off — huu:run-graph', () => {
  it('selects the method, switches to /dev and never posts by itself', async () => {
    document.dispatchEvent(
      new CustomEvent('huu:run-graph', { detail: { id: 'auditoria', name: 'Auditoria paralela' } }),
    );
    await flush(10);
    expect(dev.devMethodSource()).toBe('graph');
    expect(dev.devSelectedGraph().id).toBe('auditoria');
    expect($('viewDev').hidden).toBe(false);
    expect($('viewGraph').hidden).toBe(true);
    // The canvas hands OVER; it does not start a session.
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/dev')).toBe(false);
  });

  it('re-lists the library, because the method may have been saved a second ago', async () => {
    calls = [];
    document.dispatchEvent(
      new CustomEvent('huu:run-graph', { detail: { id: 'auditoria', name: 'Auditoria paralela' } }),
    );
    await flush(10);
    expect(calls.some((c) => c.path === '/api/graphs')).toBe(true);
  });

  it('and THEN the ordinary submit carries the graphId', async () => {
    document.dispatchEvent(
      new CustomEvent('huu:run-graph', { detail: { id: 'auditoria', name: 'Auditoria paralela' } }),
    );
    await flush(10);
    const post = await submitDevForm();
    expect(post.body.graphId).toBe('auditoria');
    expect('maxEpochs' in post.body).toBe(false);
  });

  it('ignores a hand-off with no id', async () => {
    document.dispatchEvent(new CustomEvent('huu:run-graph', { detail: { name: 'x' } }));
    await flush(6);
    expect(dev.devMethodSource()).toBe('planner');
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   5. THE SESSION PANEL — a drawing is not a list of fronts.
   ───────────────────────────────────────────────────────────────────────── */
const PLANNER_SESSION = {
  active: true,
  sessionId: 'sess-1',
  resumed: false,
  goal: 'objetivo',
  runDirectory: '/repo',
  approval: 'autonomous',
  phase: 'planning',
  modelId: 'm',
  models: {},
  methodologies: [],
  backend: 'pi',
  maxEpochs: null,
  maxFronts: 4,
  currentEpoch: 1,
  knowledgeBootstrapped: false,
  planWarnings: [],
  awaitingApproval: false,
  epochs: [],
  runIds: [],
  awaitingResume: false,
  awaitingOrphans: false,
  logs: [],
  startedAt: 0,
  plan: {
    epochGoal: 'fechar a lacuna',
    doneWhen: 'os testes passam',
    fronts: [
      { id: 'F1', title: 'Parser', rationale: 'porque sim', maxTasks: 3, dependsOnFronts: [] },
    ],
  },
};

const DRAWN_SESSION = {
  ...PLANNER_SESSION,
  maxEpochs: 1,
  drawnMethod: { id: 'auditoria', name: 'Auditoria paralela', description: 'varre o repo' },
  graph: {
    id: 'auditoria',
    name: 'Auditoria paralela',
    nodeOrder: ['recon', 'auditar', 'portao'],
    stepsByNode: { recon: ['Recon'], auditar: ['Auditar'], portao: ['Portão', 'Portão check'] },
    graphRoot: '.huu/dev/auditoria',
  },
  plan: PLANNER_SESSION.plan,
};

describe('session panel — showing that the session IS a drawing', () => {
  it('names the drawn method from the very first frame, before any compile', () => {
    const early = { ...DRAWN_SESSION, graph: undefined, plan: undefined, phase: 'probing' };
    dev.renderDevSession(early);
    expect($('devStatus').textContent).toContain('Auditoria paralela');
    expect($('devStatus').textContent).toContain('auditoria');
    expect($('devPlan').textContent).toContain('Compiling the drawing');
  });

  it('renders the NODES the drawing compiled to, in order', () => {
    dev.renderDevSession(DRAWN_SESSION);
    const nodes = Array.from($('devPlan').querySelectorAll('.dev-graph-node'));
    expect(nodes.map((n) => n.textContent.replace(/\s+/g, ' ').trim())).toEqual([
      '1recon1 step(s)',
      '2auditar1 step(s)',
      '3portao2 step(s)',
    ]);
  });

  it('says where the drawing’s artifacts land', () => {
    dev.renderDevSession(DRAWN_SESSION);
    expect($('devPlan').textContent).toContain('.huu/dev/auditoria');
  });

  it('does NOT print planner fronts over a drawing', () => {
    dev.renderDevSession(DRAWN_SESSION);
    expect($('devPlan').querySelectorAll('.dev-front')).toHaveLength(0);
    expect($('devPlan').textContent).not.toContain('Parser');
  });

  it('keeps the planner rendering exactly as it was', () => {
    dev.renderDevSession(PLANNER_SESSION);
    const html = $('devPlan').innerHTML;
    expect(html).toContain('dev-plan__head');
    expect(html).toContain('fechar a lacuna');
    expect(html).toContain('Done when: os testes passam');
    expect($('devPlan').querySelectorAll('.dev-front')).toHaveLength(1);
    expect($('devPlan').querySelectorAll('.dev-graph-node')).toHaveLength(0);
    expect($('devStatus').textContent).not.toContain('Drawn method');
  });

  it('shows planWarnings — where the human learns the methodology was NOT compiled', () => {
    dev.renderDevSession({
      ...DRAWN_SESSION,
      planWarnings: [
        'the session turned on tdd, and a drawn method does NOT compile the methodology flags',
        'per-role model routing (planner) is NOT applied to a drawn method',
      ],
    });
    const warns = Array.from($('devPlan').querySelectorAll('.dev-warn'));
    expect(warns).toHaveLength(2);
    expect(warns[0].textContent).toContain('does NOT compile the methodology flags');
    expect($('devPlan').textContent).toContain('Read this before approving');
  });

  it('shows planWarnings even when there is no plan at all yet', () => {
    dev.renderDevSession({ ...DRAWN_SESSION, plan: undefined, graph: undefined, planWarnings: ['cuidado'] });
    expect($('devPlan').querySelectorAll('.dev-warn')).toHaveLength(1);
  });

  it('renders no plan block for a planner session that has none', () => {
    dev.renderDevSession({ ...PLANNER_SESSION, plan: undefined });
    expect($('devPlan').innerHTML).toBe('');
  });

  it('devPlanHtml is pure — same session in, same html out', () => {
    expect(dev.devPlanHtml(DRAWN_SESSION)).toBe(dev.devPlanHtml(DRAWN_SESSION));
    expect(dev.devPlanHtml(PLANNER_SESSION)).not.toBe(dev.devPlanHtml(DRAWN_SESSION));
  });

  it('escapes what the drawing named its nodes', () => {
    const html = dev.devPlanHtml({
      ...DRAWN_SESSION,
      graph: { ...DRAWN_SESSION.graph, nodeOrder: ['<img src=x>'], stepsByNode: {} },
    });
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain('&lt;img');
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   6. THE RESUME THAT KNOWS ABOUT THE DRAWING.

   `POST /api/dev/resume` carries one bit. The drawing only ever reaches the
   driver through the START request, so an accept that is not already carrying
   the previous session's method has to re-issue the start — otherwise the
   driver answers `graph-missing-on-resume` and the human sees a dead button.
   ───────────────────────────────────────────────────────────────────────── */
const RESUME_OFFER = {
  sessionId: 'sessao-anterior',
  goal: 'objetivo',
  epochsDone: 2,
  nextEpoch: 3,
  drawnMethod: { graphId: 'auditoria', graphName: 'Auditoria paralela' },
};

function awaitingResume(extra = {}) {
  return {
    ...PLANNER_SESSION,
    awaitingResume: true,
    resumeOffer: RESUME_OFFER,
    ...extra,
  };
}

describe('resume gate — it names the drawing, and brings it back', () => {
  it('reads the OFFER’s key names, not the live session’s', () => {
    expect(dev.resumeOfferGraph(awaitingResume())).toEqual({
      graphId: 'auditoria',
      graphName: 'Auditoria paralela',
    });
    // `{id, name}` is the LIVE session's shape and must not be read here.
    expect(dev.resumeOfferGraph({ resumeOffer: { drawnMethod: { id: 'x', name: 'y' } } })).toBeNull();
    expect(dev.resumeOfferGraph({ resumeOffer: {} })).toBeNull();
    expect(dev.resumeOfferGraph(null)).toBeNull();
  });

  it('names the drawn method inside the gate', () => {
    dev.renderDevSession(awaitingResume());
    expect($('devResumeGate').hidden).toBe(false);
    expect($('devResumeBody').textContent).toContain('Auditoria paralela');
    expect($('devResumeBody').textContent).toContain('auditoria');
  });

  it('warns when this attempt is NOT carrying the method', () => {
    dev.renderDevSession(awaitingResume());
    const warn = $('devResumeBody').querySelector('.dev-warn');
    expect(warn).toBeTruthy();
    expect(warn.textContent).toContain('auditoria');
  });

  it('says it is already carried when the live session resolved the same drawing', () => {
    dev.renderDevSession(
      awaitingResume({ drawnMethod: { id: 'auditoria', name: 'Auditoria paralela' } }),
    );
    expect($('devResumeBody').querySelector('.dev-warn')).toBeNull();
    expect($('devResumeBody').textContent).toContain('re-sends it');
  });

  it('labels the accept button with the method’s name', () => {
    dev.renderDevSession(awaitingResume());
    expect($('devResumeAccept').textContent).toContain('Auditoria paralela');
  });

  it('goes back to the plain label for a session that was never a drawing', () => {
    dev.renderDevSession({ ...PLANNER_SESSION, awaitingResume: true, resumeOffer: { ...RESUME_OFFER, drawnMethod: undefined } });
    expect($('devResumeAccept').textContent).toBe('Continue it');
    expect($('devResumeBody').querySelector('.dev-warn')).toBeNull();
  });

  it('answers with ONE bit when the drawing is already carried', async () => {
    state.S.devSession = awaitingResume({ drawnMethod: { id: 'auditoria', name: 'A' } });
    await dev.acceptDevResume();
    const resume = calls.find((c) => c.path === '/api/dev/resume');
    expect(resume.body).toEqual({ accept: true });
    expect(calls.some((c) => c.path === '/api/dev/abort')).toBe(false);
  });

  it('answers with ONE bit when there was never a drawing', async () => {
    state.S.devSession = { ...PLANNER_SESSION, awaitingResume: true, resumeOffer: { ...RESUME_OFFER, drawnMethod: undefined } };
    await dev.acceptDevResume();
    expect(calls.find((c) => c.path === '/api/dev/resume').body).toEqual({ accept: true });
  });

  it('RE-ISSUES the start with the graphId when the drawing is missing', async () => {
    routes['GET /api/dev'] = () => ({ session: { ...PLANNER_SESSION, active: false } });
    state.S.devSession = awaitingResume();
    await dev.acceptDevResume();
    await flush(10);

    // It stops the doomed attempt first…
    expect(calls.some((c) => c.path === '/api/dev/abort')).toBe(true);
    // …then starts again WITH the method, asking for the same session.
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/dev');
    expect(post.body.graphId).toBe('auditoria');
    expect(post.body.resume).toBe('auto');
    expect(post.body.goal).toBe('objetivo');
    expect(post.body.runDirectory).toBe('/repo');
    // Still one epoch, still never asked for.
    expect('maxEpochs' in post.body).toBe(false);
    // And it never sends the one-bit resume, which would have been refused.
    expect(calls.some((c) => c.path === '/api/dev/resume')).toBe(false);
  });

  it('adopts the re-sent method in the FORM too, so both agree', async () => {
    routes['GET /api/dev'] = () => ({ session: { ...PLANNER_SESSION, active: false } });
    state.S.devSession = awaitingResume();
    await dev.acceptDevResume();
    await flush(10);
    expect(dev.devMethodSource()).toBe('graph');
    expect(state.S.devGraphId).toBe('auditoria');
  });

  it('re-issues when the attempt carries a DIFFERENT drawing', async () => {
    routes['GET /api/dev'] = () => ({ session: { ...PLANNER_SESSION, active: false } });
    state.S.devSession = awaitingResume({ drawnMethod: { id: 'outro-metodo', name: 'Outro' } });
    await dev.acceptDevResume();
    await flush(10);
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/dev');
    expect(post.body.graphId).toBe('auditoria');
  });

  it('waits for the abort to land before starting again', async () => {
    let active = true;
    routes['GET /api/dev'] = () => ({ session: { ...PLANNER_SESSION, active } });
    routes['POST /api/dev/abort'] = () => { active = false; return { ok: true }; };
    state.S.devSession = awaitingResume();
    await dev.acceptDevResume();
    const order = calls.map((c) => `${c.method} ${c.path}`);
    expect(order.indexOf('POST /api/dev/abort')).toBeLessThan(order.lastIndexOf('POST /api/dev'));
    expect(order).toContain('GET /api/dev');
  });

  it('waitForDevIdle gives up rather than looping forever', async () => {
    routes['GET /api/dev'] = () => ({ session: { ...PLANNER_SESSION, active: true } });
    expect(await dev.waitForDevIdle(2, 1)).toBe(false);
  });

  it('waitForDevIdle stops the moment the manager reports no session', async () => {
    routes['GET /api/dev'] = () => ({ session: null });
    expect(await dev.waitForDevIdle(5, 1)).toBe(true);
  });

  it('surfaces a failed re-start instead of leaving a dead button', async () => {
    routes['GET /api/dev'] = () => ({ session: { ...PLANNER_SESSION, active: false } });
    routes['POST /api/dev'] = () => jsonResponse({ error: 'graph-not-found: auditoria' }, 400);
    state.S.devSession = awaitingResume();
    await dev.acceptDevResume();
    await flush(10);
    expect(document.querySelector('.toast, #toast')?.textContent || document.body.textContent)
      .toContain('auditoria');
  });

  it('the REJECT button is still one bit, whatever the drawing was', async () => {
    state.S.devSession = awaitingResume();
    click($('devResumeReject'));
    await flush(8);
    expect(calls.find((c) => c.path === '/api/dev/resume').body).toEqual({ accept: false });
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   7. Small things that are easy to get wrong and impossible to notice.
   ───────────────────────────────────────────────────────────────────────── */
describe('dev form — the seams around the picker', () => {
  it('opens the canvas by swapping the view, never by reloading the page', () => {
    // A real navigation would drop the SSE stream and lose the `?token=`.
    const link = $('devGraphOpenCanvas');
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect($('viewGraph').hidden).toBe(false);
    // Put the dev view back for the tests that follow.
    dev.adoptDevGraphFromCanvas('auditoria', 'Auditoria paralela');
  });

  it('lets a modified click through, so "open in a new tab" still works', () => {
    const link = $('devGraphOpenCanvas');
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
    link.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('lists the library exactly once on the first boot of the surface', () => {
    // `initDevGraphPicker` runs AFTER `S.devDir` is seeded, so the first
    // listing already names the project instead of asking for the server cwd.
    expect(dev.devGraphAvailable()).toBe(true);
    expect($('devMethodSourcePanel').hidden).toBe(false);
  });

  it('degrades to planner-only when the server advertises no graph catalog', () => {
    const saved = state.S.boot.graphNodeKinds;
    state.S.boot.graphNodeKinds = [];
    try {
      expect(dev.devGraphAvailable()).toBe(false);
      dev.initDevGraphPicker();
      expect($('devMethodSourcePanel').hidden).toBe(true);
      expect(dev.devStartBody('g', 'm').graphId).toBeUndefined();
    } finally {
      state.S.boot.graphNodeKinds = saved;
      dev.initDevGraphPicker();
    }
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   5. THE ROUTING PANEL KNOWS WHICH PROVIDER IT IS ON.

   `/dev` opens with a preset ALREADY selected — routing here is a required
   decision, not an opt-in tweak — and most presets route the planner (and
   usually the critic) to ids only openrouter.ai serves. On a machine whose only
   key is DeepSeek, the untouched form therefore assembled a body its own server
   refuses: `HTTP 400 — 2 role(s) refused: planner, critic`. Four of the five
   shipped presets were refused there.

   The server still refuses an impossible body (`dev-manager.test.ts`). What
   changes is that the CLIENT no longer builds one.
   ───────────────────────────────────────────────────────────────────────── */
describe('the routing panel follows the active provider', () => {
  // getElementById/querySelector type as Element; these are our own <button>s.
  const preset = (name) =>
    /** @type {HTMLButtonElement} */ ($('devPresetSeg').querySelector(`[data-preset="${name}"]`));
  const selectedPreset = () =>
    /** @type {HTMLButtonElement} */ ($('devPresetSeg').querySelector('button.on')).dataset.preset;
  const pickProvider = (id) =>
    click(
      Array.from($('devProviderSeg').querySelectorAll('button')).find((b) =>
        b.textContent.startsWith(id === 'deepseek' ? 'DeepSeek' : 'OpenRouter'),
      ),
    );

  afterEach(() => {
    pickProvider('openrouter');
  });

  it('renders the preset LABELS, not the catalog keys', () => {
    // `DEV_PRESET_COPY` holds i18n KEYS; they used to be printed raw, so the
    // buttons read `web.preset.hetero`. `roster` had no entry at all.
    expect(preset('hetero').textContent).toBe('Hetero ★');
    expect(preset('roster').textContent).toBe('Roster');
    expect(preset('uniform').textContent).toBe('Uniform');
  });

  // MUTATION KILLED: dropping the provider argument from `defaultPreset` (or
  // going back to "hetero whenever the table has it"). The panel stays on a
  // preset DeepSeek cannot serve and the POST below carries `modelsPreset`.
  it('re-opens on a preset the provider can serve when the provider changes', async () => {
    expect(selectedPreset()).toBe('hetero');
    pickProvider('deepseek');
    expect(selectedPreset()).toBe('uniform');
    // …and the body it now assembles carries NO preset at all, which is the
    // pre-routing body the border has always accepted.
    expect(dev.devModelsPayload()).toEqual({});
    const post = await submitDevForm();
    expect(post.body.provider).toBe('deepseek');
    expect('modelsPreset' in post.body).toBe(false);
    expect('models' in post.body).toBe(false);
  });

  it('DISABLES the presets this provider cannot run, and says where they do run', () => {
    pickProvider('deepseek');
    expect(preset('hetero').disabled).toBe(true);
    expect(preset('roster').disabled).toBe(true);
    expect(preset('uniform').disabled).toBe(false);
    // The tooltip is the repair, not a stop code.
    expect(preset('hetero').title).toContain('OpenRouter');
    // Back on OpenRouter every preset is selectable again.
    pickProvider('openrouter');
    expect(preset('hetero').disabled).toBe(false);
    expect(preset('roster').disabled).toBe(false);
  });

  it('refuses to select a preset the provider cannot run', () => {
    pickProvider('deepseek');
    click(preset('hetero'));
    expect(selectedPreset()).toBe('uniform');
    expect(dev.devModelsPayload()).toEqual({});
  });

  // The last line of defense, for a state the panel cannot reach on its own
  // (a provider changed behind its back). The form ANSWERS instead of posting.
  it('blocks the submit rather than posting a body the border refuses', () => {
    click(preset('roster'));
    expect(dev.devModelsPayload()).toEqual({ modelsPreset: 'roster' });
    state.S.provider = 'deepseek';
    const blocked = dev.devSubmitBlocker('migrar o parser', 'deepseek/deepseek-v4-flash');
    expect(blocked).toBeTruthy();
    expect(blocked.message).toContain('Roster');
    expect(blocked.message).toContain('OpenRouter');
    state.S.provider = 'openrouter';
    expect(dev.devSubmitBlocker('migrar o parser', 'deepseek/deepseek-v4-flash')).toBeNull();
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   8. THE DEBATE CHAT, AND THE NAVIGATION THAT MAKES IT REACHABLE.

   WHY THESE ARE HERE AND NOT IN debate.test.js. That file proves the MODEL and
   the RENDERER: pure functions, strings in, strings out. It cannot see the
   wiring, and the wiring is where this surface breaks SILENTLY — every seam
   below is null-guarded or conditional, so cutting one produces no error, no
   console warning and no visible symptom other than a chat that is simply not
   there. Each test names the break it dies on.

     • rename any of the five element ids in index.html ....... T1, T4, T5
     • drop `hidden` from the markup ........................... T2 (+T3)
     • drop `onDevRunFrame(run)` from `ingestRun` .............. T7
     • drop `ingestDevAgentStream(frame)` from the SSE fork .... T6
     • invert the `devHold` condition in `renderActiveRun` ..... T8
     • anchor the guard on the SESSION instead of the RUN ...... T9
   ───────────────────────────────────────────────────────────────────────── */

const DEBATE_NAMES = {
  advocate: 'Sustentar as escolhas',
  prosecutor: 'Contestar as escolhas',
  gate: 'Debate resolvido?',
};
const DEV_RUN_ID = 'run-do-debate';

/** A live dev session whose epoch compiled the debate block. */
function debateSession(extra = {}) {
  return {
    ...PLANNER_SESSION,
    phase: 'executing',
    currentEpoch: 3,
    runIds: [{ epoch: 3, runId: DEV_RUN_ID, phase: 'execution' }],
    debate: {
      epoch: 3,
      runId: DEV_RUN_ID,
      names: DEBATE_NAMES,
      roles: { 1: 'advocate', 2: 'prosecutor' },
      matchedBy: 'name',
    },
    ...extra,
  };
}

/** One run snapshot as the SSE `{type:'run'}` frame carries it. */
function runFrame(runId, stateExtra = {}, phase = 'running') {
  return {
    runId,
    phase,
    pipelineName: 'debate',
    projectName: 'huu',
    startedAt: 1,
    state: {
      status: phase === 'running' ? 'running' : phase,
      currentStage: 1,
      totalStages: 1,
      completedTasks: 0,
      totalTasks: 2,
      totalCost: 0,
      startedAt: 1,
      agents: [],
      stageIntegrations: [],
      checkRuns: [],
      // `renderLog` runs on a trailing 100ms timer AFTER the test returns, and
      // it reads `state.logs` unguarded — an absent array surfaces as an
      // unhandled rejection attributed to whatever test is running next.
      logs: [],
      ...stateExtra,
    },
  };
}

const DEBATERS_WRITING = [
  { agentId: 1, stageName: DEBATE_NAMES.advocate, state: 'streaming' },
  { agentId: 2, stageName: DEBATE_NAMES.prosecutor, state: 'streaming' },
];

/** Seed the run the chat reads its structure from, then open the panel. */
function openDebate(session = debateSession(), agents = DEBATERS_WRITING) {
  state.S.runs.set(DEV_RUN_ID, runFrame(DEV_RUN_ID, { agents }));
  dev.renderDevSession(session);
  if ($('devDebate').hidden) click($('devDebateToggle'));
  return session;
}

function resetSurface() {
  if (!$('devDebate').hidden) click($('devDebateToggle'));
  state.S.devSession = null;
  state.S.runs.clear();
  state.S.activeRunId = null;
  state.S.runPinnedId = null;
  state.S.homePinned = false;
  // `devBoardOpened` is module state in board.js with no setter: it is cleared
  // by a render that sees no live session. Without this the latch leaks from
  // one test into the next and the "first frame still opens the board" step
  // silently starts from the guarded state.
  board.renderActiveRun();
  launch.showView('dev');
}

describe('the debate chat — the hosts it needs, and the default path', () => {
  afterEach(() => { resetSurface(); });

  // T1. Every one of these is read through `$(id)` behind an `if (!el) return`
  // or an `if (el)` — rename one in index.html and the chat vanishes with no
  // error at all. This is the cheapest possible tripwire for that.
  it('T1 — finds all five debate hosts under the ids the client asks for', () => {
    for (const id of ['devDebateToggle', 'devDebate', 'devDebateMeta', 'devDebateRefresh', 'devDebateLog']) {
      expect($(id), `#${id} is missing from the real index.html`).toBeTruthy();
    }
  });

  // T2. `renderDebateSurface` only runs on a `{type:'dev'}` frame, and the
  // DEFAULT path never sends a session at all. So on the shipped page the ONLY
  // thing keeping the panel and its button off screen is the `hidden`
  // attribute in the markup — asserted here against the file, not against a
  // rendered document, because a render would put it back.
  it('T2 — ships the panel AND its button hidden in the markup itself', () => {
    const frag = parseIndexBody();
    expect(frag.querySelector('#devDebate').hasAttribute('hidden')).toBe(true);
    expect(frag.querySelector('#devDebateToggle').hasAttribute('hidden')).toBe(true);
  });

  // T3. And the runtime half of the same promise: a session with no `debate`
  // hides both and asks the server for nothing.
  it('T3 — a session without --debate shows no chat and issues ZERO requests', async () => {
    calls = [];
    dev.renderDevSession(PLANNER_SESSION);
    await wait(200);
    expect($('devDebateToggle').hidden).toBe(true);
    expect($('devDebate').hidden).toBe(true);
    expect(calls.filter((c) => c.path === '/api/dev/debate')).toHaveLength(0);
  });

  // T4. The toggle, the panel, the log and the meta line, all four exercised
  // through their ids on the way to one assertion.
  it('T4 — opens the chat and paints both sides plus the round meta', async () => {
    openDebate();
    await wait(200);
    const log = $('devDebateLog');
    expect($('devDebate').hidden).toBe(false);
    expect(log.querySelectorAll('.dbt__msg--advocate').length).toBe(1);
    expect(log.querySelectorAll('.dbt__msg--prosecutor').length).toBe(1);
    expect($('devDebateMeta').textContent).toContain('Epoch 3');
  });

  // T5. The Reload button exists because the settled half is a fetch and a
  // merge can land while the panel is shut. Its listener is `if (btn)`.
  it('T5 — the Reload button re-reads the merged briefs', async () => {
    openDebate();
    await wait(200);
    calls = [];
    click($('devDebateRefresh'));
    await wait(50);
    expect(calls.filter((c) => c.path === '/api/dev/debate')).toHaveLength(1);
  });
});

describe('the debate chat — both feeds arrive through board.js', () => {
  afterEach(() => { resetSurface(); });

  // T6. The LIVE half. board.js forks the un-throttled agent-stream firehose
  // into `logAgentStream` (console) AND `ingestDevAgentStream` (chat). Drop the
  // second call and the console still scrolls, so nothing looks wrong — the
  // chat just never shows a word while the two sides write.
  it('T6 — the firehose reaches the chat through the real SSE handler', async () => {
    openDebate();
    await wait(200);
    board.connectSse();
    expect(lastEventSource, 'connectSse built no EventSource').toBeTruthy();
    lastEventSource.onmessage({
      data: JSON.stringify({
        type: 'agent-stream',
        runId: DEV_RUN_ID,
        agentId: 1,
        channel: 'assistant',
        text: 'D1 — escolhi streaming porque o buffer estoura',
      }),
    });
    await wait(250);
    expect($('devDebateLog').textContent).toContain('escolhi streaming porque o buffer estoura');
  });

  // T7. The STRUCTURE half. The rounds come from the debaters' cards and the
  // gate's ruling from `checkRuns` — both of which live on the RUN snapshot,
  // not on the session frame. Without `onDevRunFrame(run)` in `ingestRun` the
  // verdict sits off screen until the driver happens to log something.
  it('T7 — the gate’s verdict lands because ingestRun hands the snapshot over', async () => {
    openDebate();
    await wait(200);
    expect($('devDebateLog').textContent).not.toContain('convergiu');

    board.ingestRun(
      runFrame(DEV_RUN_ID, {
        agents: [
          { agentId: 1, stageName: DEBATE_NAMES.advocate, state: 'done' },
          { agentId: 2, stageName: DEBATE_NAMES.prosecutor, state: 'done' },
        ],
        checkRuns: [
          { stepName: DEBATE_NAMES.gate, runs: 1, outcomeLabel: 'convergiu', reason: 'tudo coberto' },
        ],
      }),
    );
    await wait(250);
    expect($('devDebateLog').textContent).toContain('convergiu');
    expect($('devDebateLog').textContent).toContain('tudo coberto');
  });
});

/* /dev is not a form the user is done with — it is the live panel that hosts
   the session gates and the debate chat, and they must be able to come BACK to
   it while the swarm runs. The guard that makes that possible is one boolean in
   `renderActiveRun`, and it is the kind of boolean that is "simplified" by
   somebody who does not know why it is there. */
describe('development mode — /dev stays reachable, and a normal run does not', () => {
  afterEach(() => { resetSurface(); });

  // T8. Invert `devHold` (either sense) and the first frame stops opening the
  // board, which is how the bug this fixed was reported: /dev unreachable.
  it('T8 — the first frame still opens the board, and later ones stop dragging you back', () => {
    state.S.runs.clear();
    state.S.activeRunId = null;
    state.S.homePinned = false;
    dev.renderDevSession(debateSession());

    // Unchanged from before dev mode existed: a live run opens the board.
    board.ingestRun(runFrame(DEV_RUN_ID));
    expect($('viewRun').hidden).toBe(false);

    // The human deliberately goes back to the panel…
    launch.showView('dev');
    // …and the next eight snapshots (≈1s of SSE) must leave them there.
    for (let i = 0; i < 8; i += 1) board.ingestRun(runFrame(DEV_RUN_ID));
    expect($('viewDev').hidden).toBe(false);
    expect($('viewRun').hidden).toBe(true);
  });

  // T9. THE REGRESSION THIS SECTION EXISTS FOR. The guard was anchored on the
  // SESSION, so an ordinary pipeline launched in another project mid-session
  // inherited both halves of the dev treatment: it stopped auto-opening the
  // board, and its exit button was relabelled "← Development mode" pointing at
  // /dev. Belonging is a property of the RUN (`session.runIds`), and a run the
  // session does not own must take exactly the branch it took on the base.
  it('T9 — a NORMAL run launched during a live session behaves as it always did', () => {
    state.S.runs.clear();
    state.S.activeRunId = null;
    state.S.homePinned = false;
    dev.renderDevSession(debateSession());

    // Arrange the exact state that used to break it: the board has been opened
    // once by the session's own run, and the human is parked on /dev.
    board.ingestRun(runFrame(DEV_RUN_ID));
    launch.showView('dev');
    board.ingestRun(runFrame(DEV_RUN_ID));
    expect($('viewDev').hidden).toBe(false);

    // The session's epoch settles between its two runs…
    board.ingestRun(runFrame(DEV_RUN_ID, {}, 'done'));
    expect($('viewDev').hidden).toBe(false);

    // …and a pipeline in ANOTHER project starts. It belongs to no session.
    board.ingestRun(runFrame('run-de-outro-projeto'));
    expect(state.S.activeRunId).toBe('run-de-outro-projeto');
    // 1. it opens the board, exactly as on the base branch;
    expect($('viewRun').hidden).toBe(false);
    // 2. and its exit keeps the ordinary rule (hidden while active) and the
    //    ordinary label — never the dev panel's.
    expect($('backToLaunch').hidden).toBe(true);
    expect($('backToLaunch').textContent).not.toContain('Development mode');
  });

  // The other half of T9: the session's OWN run does get the exit, and gets it
  // while the run is live — the one case the ordinary rule hides it for.
  it('T10 — the session’s own run keeps its way back to /dev while it runs', () => {
    state.S.runs.clear();
    state.S.activeRunId = null;
    state.S.homePinned = false;
    dev.renderDevSession(debateSession());
    board.ingestRun(runFrame(DEV_RUN_ID));
    expect($('viewRun').hidden).toBe(false);
    expect($('backToLaunch').hidden).toBe(false);
    expect($('backToLaunch').textContent).toContain('Development mode');
  });
});

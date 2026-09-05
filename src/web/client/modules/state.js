/* huu web UI — application state and infrastructure. */

export const $ = (id) => document.getElementById(id);

// Canonical default model
export const DEFAULT_MODEL_ID = 'deepseek/deepseek-v4-flash';

const _TOKEN = new URLSearchParams(location.search).get('token') || '';
export const TOKEN = _TOKEN;
export const withTok = (url) => (_TOKEN ? url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(_TOKEN) : url);

export async function api(path, opts = {}) {
  const { headers: extra, ...rest } = opts;
  const res = await fetch(withTok(path), {
    headers: {
      'Content-Type': 'application/json',
      ...(_TOKEN ? { 'x-huu-token': _TOKEN } : {}),
      ...extra,
    },
    ...rest,
  });
  const data = await res.json().catch(() => ({}));
  // The BODY travels with the failure. `POST /api/graphs/compile` answers 400
  // with `{ok:false, error, errors[], warnings[]}` — the array being
  // deliberately additive so the canvas can highlight the offending nodes with
  // no second round-trip. Keeping only `data.error` threw that array away and
  // left every caller with a sentence (see the CAVEAT in graph-api-client.js,
  // which reads `err.body`). The cast is because `Error` has no `body`.
  if (!res.ok) {
    const err = /** @type {any} */ (new Error(data.error || `HTTP ${res.status}`));
    err.body = data;
    throw err;
  }
  return data;
}

/* ---------------- Theme ---------------- */
export function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  const btn = $('themeBtn'); if (btn) btn.querySelector('use').setAttribute('href', t === 'light' ? '#ic-sun' : t === 'dark' ? '#ic-moon' : '#ic-auto');
  try { localStorage.setItem('huu.theme', t); } catch {}
}

/* ---------------- Browser-only API keys ---------------- */
export const keyStoreName = (name) => 'huu.key.' + name;
export function sessionKey(name) {
  if (!name) return '';
  try { return sessionStorage.getItem(keyStoreName(name)) || ''; } catch { return ''; }
}
export function setSessionKey(name, value) {
  if (!name) return;
  try { sessionStorage.setItem(keyStoreName(name), value); } catch {}
}
/**
 * @deprecated The BACKEND does not name the credential: `jcode` serves both
 * DeepSeek and OpenRouter, so the server now reports `apiKeySpecName:
 * undefined` for it. Ask the PROVIDER instead — `activeKeySpec(S)`.
 */
export function backendSpecName(id, boot) {
  const b = ((boot && boot.backends) || []).find((x) => x.id === id);
  return b ? b.apiKeySpecName : undefined;
}

/**
 * The credential spec the CURRENTLY SELECTED provider requires, straight from
 * `/api/providers` (`listProvidersInfo` → `keySpecs`). THE single answer to
 * "which key does this run need", client-side.
 *
 * Every hard-coded `'openrouter'` in the ⚙ Settings panel used to answer it
 * instead — which is why a key saved there never reached a DeepSeek run: the
 * run read the ACTIVE provider's spec while the panel wrote to a fixed one.
 *
 * @returns {{name: string, label: string, hint?: string, validatePrefix?: string}|null}
 */
export function activeKeySpec(S) {
  const info = providerInfoById(S, S.provider);
  const specs = (info && info.keySpecs) || [];
  return specs.length ? specs[0] : null;
}

/** The spec NAME of the active provider's credential, or '' when unknown. */
export function activeKeySpecName(S) {
  const spec = activeKeySpec(S);
  return spec ? spec.name : '';
}

/**
 * The spec NAME a GIVEN provider needs — for rows that carry their own
 * provider (the run queue), where `S.provider` is the wrong question.
 */
export function providerKeySpecName(S, id) {
  const p = providerInfoById(S, id);
  const specs = (p && p.keySpecs) || [];
  return specs.length ? specs[0].name : '';
}

/* ---------------- Provider helpers ---------------- */
export const PIPE_ICONS = { test: '✓', audit: '◎', security: '🛡', performance: '⚡', docs: '✦', quality: '◆', refactor: '↻', knowledge: '✸' };
export function pipeIcon(name) {
  const n = name.toLowerCase();
  for (const k in PIPE_ICONS) if (n.includes(k)) return PIPE_ICONS[k];
  return '◇';
}
export function providerInfoById(S, id) {
  return (S.providers || []).find((p) => p.id === id) || null;
}
export function providerBackend(S, id) {
  const p = providerInfoById(S, id);
  return p ? p.backend : id === 'azure' ? 'azure' : 'pi';
}
export function providerReady(S, p) {
  if (!p) return false;
  if (p.hasKey) return true;
  const specs = p.keySpecs || [];
  return specs.length > 0 && specs.every((s) => sessionKey(s.name));
}

export function globalTimeoutMinutes(S) { return S.settings.maxAgentMinutes; }
export function parseRamPercent(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.max(10, Math.min(95, n));
}
export function syncTimeoutField() {
  const g = S.settings.maxAgentMinutes;
  // index.html:220 — <input type="number" id="timeoutInput">, so the input-only
  // .placeholder is safe; getElementById just can't see that statically.
  const el = /** @type {HTMLInputElement | null} */ ($('timeoutInput'));
  if (el) el.placeholder = g ? g + ' (global)' : 'default';
}

/* ---------------- App state ---------------- */
export const S = {
  boot: null,
  pipelines: [],
  selectedPipe: null,
  provider: 'openrouter',
  providers: [],
  backend: 'pi',
  runDir: '',
  cwd: '',
  models: [],
  modelId: '',
  conflictResolverModelId: '',
  modelSource: 'recommended',
  mode: 'auto',
  manualN: 10,
  timeoutMin: '',
  settings: { maxAgentMinutes: undefined, ramPercent: undefined },
  keyStatus: { ok: true, missing: [] },
  run: { phase: 'idle' },
  runs: new Map(),
  activeRunId: null,
  runPinnedId: null,
  openCardKey: null,
  homePinned: false,
  wizard: { step: 1 },
  markedDirs: new Set(),
  sim: false,
  simModels: [],
  simSuggest: [],
  simFiles: 12,
  simAgents: 6,
  simPaused: false,
  lastSim: null,
  logOpen: false,
  logFilter: 'all',
  logAutoExpanded: false,
  logUserToggled: false,
  queue: {
    items: [],
    running: false,
    live: null,
    settled: 0,
    processed: null,
    stopping: false,
    id: '',
  },
  // Dev surface
  devBooted: false,
  devDir: '',
  devSession: null,
  lastBudget: null,
  // Method canvas (/graph). Same shape as the dev surface above: one boolean
  // that makes the lazy init idempotent, plus what has to SURVIVE a view swap.
  // `graphDoc` is the devgraph currently on the canvas — kept here so switching
  // to Pipelines and back does not hand the human an empty drawing; the React
  // root itself is torn down and rebuilt from it.
  graphBooted: false,
  graphDir: '',
  graphDoc: null,
  graphCatalog: null,
  graphMount: null,
  // THE HAND-OFF between the canvas and development mode. `/graph` never starts
  // a session itself — it names the method here and dispatches `huu:run-graph`,
  // and the /dev form (which owns the goal, the project and the model routing)
  // pre-selects it. Kept on S rather than passed as an argument because the two
  // surfaces must not import each other: `launch.js` already imports
  // `graph/canvas.js`, so a canvas → dev import would close an ESM cycle.
  devGraphId: '',
  devGraphName: '',
};

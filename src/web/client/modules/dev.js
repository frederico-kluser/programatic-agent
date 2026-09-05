/* huu web UI — development mode (/dev). */

import { buildDevModelsPayload, describeDevModelsPayload, presetValues } from '../dev-models.js';
import { buildDevMethodologyPayload, parseStoredMethodology } from '../dev-methodology.js';
import { esc, toast, shortDir, projectName } from './utils.js';
import { $, S, api, DEFAULT_MODEL_ID, sessionKey, activeKeySpecName, providerInfoById, providerReady, providerBackend } from './state.js';
import { showView, switchMode, refreshModelsAndKeys, wireModeSwitch } from './launch.js';
import { makeGraphApi } from './graph/graph-api-client.js';
import { RUN_GRAPH_EVENT } from './graph/canvas.js';
import { saveSettings, SETTINGS_LS } from './settings.js';
import { renderActiveRun } from './board.js';
import { boot } from '../app.js';
import { t } from '../i18n.js';

/* ---------------- Development mode (/dev) ----------------
   Goal in, swarm of parallel FRONTS out. Each epoch is an ordinary run, so the
   server pushes it through the SAME `{type:'run'}` frames the board already
   renders — everything below only handles the SESSION layer: the knowledge
   probe, the epoch chain, and the approval gate. */

const DEV_PHASE_LABEL = {
  idle: 'ocioso',
  probing: 'verificando knowledge-skills',
  bootstrapping: 'bootstrap de skills (swarm MAX)',
  // Fase A da época v2: o run de conhecimento (lacunas → briefs → digest) que
  // precede o plano. É um ESTADO próprio, não um "planning" adiantado — sem
  // ele o rótulo cairia no fallback cru e a época pareceria travada.
  knowledge: 'levantando conhecimento (fase A)',
  planning: 'planejando a época',
  'awaiting-approval': 'aguardando sua aprovação',
  running: 'swarm rodando',
  done: 'encerrado',
  error: 'erro',
};

/**
 * Prepare the development surface. Idempotent and LAZY: the launch flow owns
 * boot (SSE, gallery, queue), so this only fills in what is dev-specific, the
 * first time the user actually switches into it.
 */
export function initDevSurface() {
  if (S.devBooted) return;
  S.devBooted = true;
  renderDevProviderSeg();
  initDevModelPanel();
  initDevMethodology();
  // <input id="devModel"> in the dev shell — getElementById only types it as HTMLElement.
  const devModel = /** @type {HTMLInputElement} */ ($('devModel'));
  if (!devModel.value) devModel.value = S.modelId || DEFAULT_MODEL_ID;
  // The launch flow only downloads the model catalog when a PIPELINE is picked
  // — something a direct /dev load never does — so the shared <datalist> behind
  // the per-role fields would sit empty. Fetch it lazily here instead
  // (refreshModelsAndKeys repopulates the datalist itself).
  if (!S.models.length) {
    void refreshModelsAndKeys()
      .then(() => {
        const el = /** @type {HTMLInputElement} */ ($('devModel'));
        if (!el.value) el.value = S.modelId || DEFAULT_MODEL_ID;
      })
      .catch(() => {});
  }
  // Open the browser where the user's projects live, and preselect the repo
  // the server is already running in.
  S.devDir = S.devDir || S.cwd || '';
  // AFTER `S.devDir` is seeded: the method library lives inside the project, so
  // listing it before the project is known would ask the server for its own cwd
  // and then immediately re-ask for the real one.
  initDevGraphPicker();
  loadDevFolder(devFolderState.path || S.boot?.workspace || S.cwd || '');
  renderDevGoalCount();
  // A session may already be running (started from the CLI, another tab, or
  // before a refresh) — re-link instead of showing an empty form.
  api('/api/dev').then((d) => { if (d.session) renderDevSession(d.session); }).catch(() => {});
}

export function renderDevProviderSeg() {
  const seg = $('devProviderSeg');
  if (!seg) return;
  seg.innerHTML = '';
  const locked = !!(S.boot && S.boot.lockedProvider);
  for (const p of S.providers) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = S.provider === p.id ? 'on' : '';
    btn.textContent = p.label + (providerReady(S, p) ? '' : ' •');
    btn.title = p.description + (providerReady(S, p) ? ' · key ✓' : ' · key needed');
    if (locked && p.id !== S.boot.lockedProvider) btn.disabled = true;
    btn.addEventListener('click', () => {
      S.provider = p.id;
      S.backend = providerBackend(S, p.id);
      renderDevProviderSeg();
    });
    seg.appendChild(btn);
  }
}

/* ---------------- Dev: per-role model routing ----------------
   Seven roles, one model each, with named presets. The role list and the preset
   table both come from /api/bootstrap (`devModelRoles` / `devModelPresets`) —
   the same `DEV_MODEL_ROLES` / `DEV_MODEL_PRESETS` the compiler stamps onto the
   steps. ONE source of truth: the client renders the table, it never carries a
   copy that could disagree with what actually runs. A server that doesn't
   advertise them (older build, or the routing turned off) simply gets no panel
   and a POST body identical to today's. Payload shaping is the pure
   `buildDevModelsPayload` in client/dev-models.js. */

// Human copy only — labels, never model ids. An unlisted role still renders
// (with its raw name), so a role added server-side is visible immediately.
const DEV_ROLE_COPY = {
  planner: ['web.role.planner', 'web.role.planner_hint'],
  recon: ['web.role.recon', 'web.role.recon_hint'],
  worker: ['web.role.worker', 'web.role.worker_hint'],
  critic: ['web.role.critic', 'web.role.critic_hint'],
  reporter: ['web.role.reporter', 'web.role.reporter_hint'],
  judge: ['web.role.judge', 'web.role.judge_hint'],
  integration: ['web.role.integration', 'web.role.integration_hint'],
};

const DEV_PRESET_COPY = {
  hetero: ['web.preset.hetero', 'web.preset.hetero_hint'],
  thrifty: ['web.preset.thrifty', 'web.preset.thrifty_hint'],
  // Named honestly: this is the arm of the A/B, not a suggestion.
  monoculture: ['web.preset.monoculture', 'web.preset.monoculture_hint'],
  uniform: ['web.preset.uniform', 'web.preset.uniform_hint'],
};

const devModels = { roles: [], presets: null, preset: 'hetero', values: {} };

/**
 * The fallback id the POST still has to carry (`modelId` is required by the
 * contract) now that the standalone model field is gone from the normal path.
 * Derived from the role fields themselves — `worker` first because it is the
 * role that does most of the work, then `planner`, then whatever is pinned.
 * Falls back to the degraded-path input, and only then to the catalog default.
 */
export function devFallbackModelId() {
  const v = devModels.values || {};
  const pick = (role) => (v[role] || '').trim();
  const derived = pick('worker') || pick('planner')
    || (devModels.roles || []).map(pick).find(Boolean) || '';
  if (derived) return derived;
  const el = /** @type {HTMLInputElement | null} */ ($('devModel'));
  return (el && el.value.trim()) || S.modelId || DEFAULT_MODEL_ID;
}

/** True only when the server advertised BOTH tables. */
export function devModelRoutingAvailable() {
  const b = S.boot || {};
  return Array.isArray(b.devModelRoles) && b.devModelRoles.length > 0
    && !!b.devModelPresets && typeof b.devModelPresets === 'object';
}

export function initDevModelPanel() {
  const panel = $('devModelsPanel');
  const fallback = $('devModelFallbackField');
  if (!panel) return;
  // Exactly one of the two is visible: the role table, or — only when the
  // server never advertised it — the single-model fallback field.
  if (!devModelRoutingAvailable()) {
    panel.hidden = true;
    if (fallback) fallback.hidden = false;
    return;
  }
  panel.hidden = false;
  if (fallback) fallback.hidden = true;
  devModels.roles = S.boot.devModelRoles.slice();
  devModels.presets = S.boot.devModelPresets;
  // Start on `hetero`: routing is a REQUIRED decision here, not an opt-in
  // tweak, so the form opens on the recommended split (strong blind leader,
  // cheap swarm, cross-family critic) rather than on a neutral default that
  // silently collapses every role onto one model.
  const names = Object.keys(devModels.presets);
  devModels.preset = names.includes('hetero') ? 'hetero' : (names[0] || 'hetero');
  devModels.values = presetValues(devModels.roles, devModels.presets, devModels.preset);
  renderDevPresetSeg();
  renderDevRoleFields();
  renderDevModelOptions();
  renderDevModelsSummary();
}

/** Fill the ONE shared <datalist> the seven role inputs point at. */
export function renderDevModelOptions() {
  const list = $('devModelOptions');
  if (!list) return;
  list.innerHTML = (S.models || [])
    .map((m) => `<option value="${esc(m.id)}">${esc(m.label && m.label !== m.id ? m.label : '')}</option>`)
    .join('');
}

export function renderDevPresetSeg() {
  const seg = $('devPresetSeg');
  if (!seg || !devModels.presets) return;
  seg.innerHTML = '';
  for (const name of Object.keys(devModels.presets)) {
    const copy = DEV_PRESET_COPY[name] || [name, ''];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = devModels.preset === name ? 'on' : '';
    btn.dataset.preset = name;
    btn.textContent = copy[0];
    btn.title = copy[1];
    seg.appendChild(btn);
  }
  const hint = $('devPresetHint');
  if (hint) hint.textContent = (DEV_PRESET_COPY[devModels.preset] || ['', ''])[1];
}

export function renderDevRoleFields() {
  const host = $('devRoleFields');
  if (!host) return;
  host.innerHTML = devModels.roles.map((role) => {
    const copy = DEV_ROLE_COPY[role] || [role, ''];
    return `<div class="role">` +
      `<label class="role__label" for="devRole-${esc(role)}">${esc(t(copy[0]))}` +
      `<span class="role__id">${esc(role)}</span></label>` +
      `<input class="role__input" id="devRole-${esc(role)}" data-role="${esc(role)}" type="text"` +
      ` list="devModelOptions" autocomplete="off" spellcheck="false"` +
      ` placeholder="${esc(t('web.role.inherits'))}" value="${esc(devModels.values[role] || '')}" />` +
      (copy[1] ? `<div class="role__hint muted">${esc(t(copy[1]))}</div>` : '') +
      `</div>`;
  }).join('');
}

export function renderDevModelsSummary() {
  const el = $('devModelsSummary');
  if (!el) return;
  el.textContent = describeDevModelsPayload(devModelsPayload());
}

/** The `models` / `modelsPreset` half of the POST body — `{}` when nothing is pinned. */
export function devModelsPayload() {
  if (!devModelRoutingAvailable()) return {};
  return buildDevModelsPayload({
    roles: devModels.roles,
    presets: devModels.presets,
    preset: devModels.preset,
    values: devModels.values,
  });
}

/* ---------------- Dev: methodology toggles ----------------
   The human underwriting the METHOD, not just the goal. The option list comes
   from /api/bootstrap (`devMethodologyOptions`) — the same table the POST
   parser reads — so the panel never carries its own copy. Everything is OFF
   by default, and the selection persists under huu.settings.v1 so the next
   visit restores it. Payload shaping is the pure `buildDevMethodologyPayload`
   in client/dev-methodology.js. */
const devMethods = { options: [], on: new Set() };

/**
 * Render + restore the methodology panel. Called once from initDevSurface,
 * after boot() has the bootstrap payload.
 */
export function initDevMethodology() {
  const panel = $('devMethodPanel');
  if (!panel) return;
  const catalog = S.boot && Array.isArray(S.boot.devMethodologyOptions)
    ? S.boot.devMethodologyOptions
    : [];
  devMethods.options = catalog.filter((o) => o && typeof o.key === 'string');
  // A server that doesn't advertise the catalog (a stale build) gets no panel
  // and a POST body identical to today's — the same degradation as the role
  // panel above.
  panel.hidden = devMethods.options.length === 0;
  if (!devMethods.options.length) return;
  // Restore the persisted selection, limited to keys the server still
  // advertises. The mirror onto S.settings matters: the ⚙ modal's
  // saveSettings() serializes S.settings WHOLESALE, so a selection kept only
  // in this module would be wiped by the next unrelated settings save.
  let stored = [];
  try {
    stored = parseStoredMethodology(
      localStorage.getItem(SETTINGS_LS),
      devMethods.options.map((o) => o.key),
    );
  } catch { /* storage disabled — the selection just won't persist */ }
  devMethods.on = new Set(stored);
  S.settings.devMethodology = [...devMethods.on];
  renderDevMethodology();
}

export function renderDevMethodology() {
  const list = $('devMethodList');
  if (!list) return;
  list.innerHTML = '';
  for (const opt of devMethods.options) {
    const on = devMethods.on.has(opt.key);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'method-check' + (on ? ' on' : '');
    btn.dataset.method = opt.key;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    // The catalog owns the wording, the server owns the LIST. `t()` throws on a
    // missing key, so an option shipped without translations fails loudly here
    // instead of showing English inside a pt-BR page.
    const label = t(`web.dev.method.${opt.key}.label`);
    const desc = t(`web.dev.method.${opt.key}.desc`);
    btn.title = desc;
    btn.innerHTML =
      `<span class="folder-check" aria-hidden="true">${on ? '✓' : ''}</span>` +
      `<span class="method-check__text">` +
      `<span class="method-check__label">${esc(label)}</span>` +
      `<span class="method-check__desc muted">${esc(desc)}</span>` +
      `</span>`;
    list.appendChild(btn);
  }
}

/** The `methodology` half of the POST body — `{}` when nothing is on. */
export function devMethodologyPayload() {
  return buildDevMethodologyPayload([...devMethods.on]);
}

/* ---------------- Dev: the METHOD — planner, or a drawing ----------------
   The one decision MANIFESTO says the human must underwrite: who writes the
   TOPOLOGY. `planner` is what dev mode has always done and stays the default,
   byte for byte — with it selected this module contributes NOTHING to the POST
   body. `graph` names a method saved under `.huu/dev/graphs/` inside the chosen
   project, and adds exactly one field: `graphId`.

   TWO THINGS THAT ARE NOT DETAILS.

   1. `maxEpochs` IS NEVER SENT, and that is load-bearing rather than tidy: a
      drawn session is exactly ONE epoch, and `resolveDevGraph` answers an
      explicit `maxEpochs >= 2` with `graph-conflict` — a 400 before the session
      exists. This form has never sent the field; the rule is to keep it that
      way, not to special-case the graph path.

   2. THE LIST IS PER PROJECT. `GET /api/graphs?dir=` reads the store inside the
      run directory, so changing the project invalidates the list — and a
      `graphId` that belonged to the old project would resolve to
      `graph-not-found` on a server that is otherwise fine. `selectDevDir`
      therefore clears the selection and refetches. */
const devGraphPick = {
  /** @type {'planner' | 'graph'} */
  source: 'planner',
  id: '',
  /** @type {any[]} */
  items: [],
  /** The directory `items` was listed for — '' means "never listed". */
  dir: '',
  loading: false,
  error: '',
};

/** The graph transport, built once over the app's own `api()`. */
const devGraphApi = makeGraphApi(api);

/** True only when the server advertised the graph catalog. */
export function devGraphAvailable() {
  const b = S.boot || {};
  return Array.isArray(b.graphNodeKinds) && b.graphNodeKinds.length > 0;
}

/** `'planner'` (the default) or `'graph'`. */
export function devMethodSource() {
  return devGraphPick.source;
}

/** The summary of the selected drawing, or null. */
export function devSelectedGraph() {
  if (devGraphPick.source !== 'graph' || !devGraphPick.id) return null;
  return devGraphPick.items.find((g) => g && g.id === devGraphPick.id) || null;
}

/**
 * The `graphId` half of the POST body — `{}` on the planner path.
 *
 * Same additive contract as `devModelsPayload` / `devMethodologyPayload`: a
 * form left on the planner posts the body it posted before this panel existed.
 */
export function devGraphPayload() {
  if (devGraphPick.source !== 'graph') return {};
  const id = (devGraphPick.id || '').trim();
  return id ? { graphId: id } : {};
}

/** Render + wire the picker. Idempotent; called once from initDevSurface. */
export function initDevGraphPicker() {
  const panel = $('devMethodSourcePanel');
  if (!panel) return;
  // A server that doesn't advertise the graph catalog gets no panel and a POST
  // body identical to today's — the same degradation as the role and
  // methodology panels above.
  panel.hidden = !devGraphAvailable();
  if (panel.hidden) return;
  // The canvas may have handed a method over BEFORE this surface ever booted
  // (`/graph` → "Rodar este método" → switchMode('dev')), so adopt it here too
  // rather than only in the event listener.
  if (S.devGraphId) {
    devGraphPick.source = 'graph';
    devGraphPick.id = S.devGraphId;
  }
  renderDevMethodSource();
  void loadDevGraphs();
}

/** Paint the segmented control, the hint and the picker row from module state. */
export function renderDevMethodSource() {
  const seg = $('devMethodSourceSeg');
  if (seg) {
    // Array.from: NodeListOf has no Symbol.iterator without the DOM.Iterable lib.
    for (const b of Array.from(seg.querySelectorAll('[data-method-source]'))) {
      b.classList.toggle('on', b.getAttribute('data-method-source') === devGraphPick.source);
    }
  }
  const hint = $('devMethodSourceHint');
  if (hint) {
    hint.textContent =
      devGraphPick.source === 'graph'
        ? t('web.dev.method_source_hint_graph')
        : t('web.dev.method_source_hint_planner');
  }
  const row = $('devGraphPickRow');
  if (row) row.hidden = devGraphPick.source !== 'graph';
  renderDevGraphOptions();
  renderDevGraphMetaWarnings();
}

/**
 * Fill the `<select>` from the listing, and say what the selection implies.
 *
 * An INVALID graph is listed rather than filtered out: it is the human's own
 * drawing, hiding it would read as "it was deleted", and the repair is one
 * click away on the canvas. It carries a tag, and the submit refuses it.
 */
export function renderDevGraphOptions() {
  const sel = /** @type {HTMLSelectElement | null} */ ($('devGraphSelect'));
  if (!sel) return;
  const rows = [`<option value="">${esc(t('web.dev.graph_pick_placeholder'))}</option>`];
  for (const g of devGraphPick.items) {
    const label = `${g.name || g.id}${g.valid === false ? ' ⚠ ' + t('web.dev.graph_invalid_tag') : ''}`;
    rows.push(
      `<option value="${esc(g.id)}"${g.id === devGraphPick.id ? ' selected' : ''}>${esc(label)}</option>`,
    );
  }
  sel.innerHTML = rows.join('');
  sel.value = devGraphPick.id || '';

  const picked = devSelectedGraph();
  const name = $('devGraphPickedName');
  if (name) name.textContent = picked ? picked.name || picked.id : '';
  const hint = $('devGraphHint');
  if (!hint) return;
  hint.classList.remove('dev-graph-hint--bad');
  if (devGraphPick.error) {
    hint.textContent = devGraphPick.error;
    hint.classList.add('dev-graph-hint--bad');
  } else if (!devGraphPick.items.length) {
    hint.textContent = t('web.dev.graph_pick_empty');
  } else if (picked && picked.valid === false) {
    hint.textContent = t('web.dev.err_graph_invalid');
    hint.classList.add('dev-graph-hint--bad');
  } else if (picked) {
    hint.textContent = t('web.dev.graph_meta', {
      nodes: Number(picked.nodeCount) || 0,
      edges: Number(picked.edgeCount) || 0,
    });
  } else {
    hint.textContent = '';
  }
}

/**
 * Say — never hide — that the routing and the methodology are metadata here.
 *
 * The driver records both on the session and warns
 * (`graphSessionWarnings` → `planWarnings`), but compiles neither into a
 * drawing: a devgraph expresses method by BEING drawn, and it has nodes rather
 * than roles. Hiding the panels would teach the opposite lesson — that the
 * choice does not exist — and would silently discard a selection the human
 * still wants the moment they switch back to the planner.
 */
export function renderDevGraphMetaWarnings() {
  const on = devGraphPick.source === 'graph';
  for (const id of ['devModelsMetaWarn', 'devMethodMetaWarn']) {
    const el = $(id);
    if (el) el.hidden = !on;
  }
}

/**
 * List the project's saved methods.
 *
 * Cheap and idempotent: it re-lists only when the directory changed, or when
 * forced (the picker was just opened, or a session refused the selection).
 */
export async function loadDevGraphs(force = false) {
  if (!devGraphAvailable()) return;
  const dir = S.devDir || '';
  if (!force && devGraphPick.dir === dir && devGraphPick.items.length) return;
  devGraphPick.loading = true;
  try {
    const res = await devGraphApi.list(dir);
    devGraphPick.items = Array.isArray(res && res.graphs) ? res.graphs : [];
    devGraphPick.dir = dir;
    devGraphPick.error = '';
    // A selection the new project does not hold is a `graph-not-found` waiting
    // to happen — drop it here, where the human can see the picker go empty.
    if (devGraphPick.id && !devGraphPick.items.some((g) => g && g.id === devGraphPick.id)) {
      devGraphPick.id = '';
    }
  } catch (e) {
    devGraphPick.items = [];
    devGraphPick.dir = dir;
    devGraphPick.error = t('web.dev.graph_pick_failed', { message: e.message });
  } finally {
    devGraphPick.loading = false;
    renderDevGraphOptions();
  }
}

/** Switch between the planner and a drawing. */
export function setDevMethodSource(source) {
  devGraphPick.source = source === 'graph' ? 'graph' : 'planner';
  renderDevMethodSource();
  if (devGraphPick.source === 'graph') void loadDevGraphs();
}

/** Pick (or clear) the drawing this session will run. */
export function selectDevGraph(id) {
  devGraphPick.id = (id || '').trim();
  S.devGraphId = devGraphPick.id;
  renderDevGraphOptions();
}

/**
 * Adopt the method the CANVAS handed over, and show the form.
 *
 * The canvas deliberately does not POST: a session needs a goal, a project and
 * a model routing, and this form already owns all three. So `/graph` names the
 * method and this brings the human here with it selected.
 */
export function adoptDevGraphFromCanvas(id, name) {
  const graphId = (id || '').trim();
  if (!graphId) return;
  S.devGraphId = graphId;
  S.devGraphName = name || graphId;
  devGraphPick.source = 'graph';
  devGraphPick.id = graphId;
  // The dev surface may never have booted (a direct /graph load) — booting it
  // is what fills the folder browser, the models and this very picker.
  if (!S.devBooted) initDevSurface();
  switchMode('dev');
  renderDevMethodSource();
  // Force: the human may have saved this very method seconds ago, so a cached
  // listing from before the save would not contain it.
  void loadDevGraphs(true);
  const goal = /** @type {HTMLTextAreaElement | null} */ ($('devGoal'));
  if (goal) goal.focus();
}

/* ---------------- Dev: project selector ----------------
   The same filesystem browser the pipeline flow uses, but SINGLE-select: a dev
   session ends in a merge into one repo's working branch, so "one project" is
   the invariant, not a limitation. Its own state, so browsing here never
   disturbs a half-built pipeline queue. */
const devFolderState = { path: '', parent: null, listing: null };

export async function loadDevFolder(path) {
  try {
    const d = await api('/api/folders?path=' + encodeURIComponent(path || ''));
    devFolderState.path = d.path;
    devFolderState.parent = d.parent;
    devFolderState.listing = d;
    $('devFolderPath').textContent = d.path;
    $('devFolderPath').title = d.path;
    const git = $('devFolderGit');
    git.textContent = d.isGitRepo ? '✓ git repo' : '⚠ not a git repo';
    git.className = 'folder-modal__git ' + (d.isGitRepo ? 'ok' : 'no');
    /** @type {HTMLButtonElement} */ ($('devFolderUp')).disabled = !d.parent;
    // Landing on a git repo with nothing chosen yet? Pick it — the common case
    // is "the folder I just navigated into IS the project".
    if (d.isGitRepo && !S.devDir) selectDevDir(d.path);
    renderDevFolderList(d);
  } catch (err) { toast(err.message, true); }
}

export function selectDevDir(path) {
  const changed = S.devDir !== path;
  S.devDir = path;
  $('devPickedName').textContent = projectName(path);
  if (devFolderState.listing) renderDevFolderList(devFolderState.listing);
  // The method store lives INSIDE the project (`.huu/dev/graphs/`), so another
  // project is another library. Re-listing here is what stops a `graphId` from
  // the previous project reaching the server as a `graph-not-found`.
  if (changed) void loadDevGraphs(true);
}

export function renderDevFolderList(d) {
  const list = $('devFolderList');
  list.innerHTML = '';
  list.appendChild(devFolderRow(d.path, projectName(d.path) || d.path, { isSelf: true, isGit: d.isGitRepo }));
  if (!d.entries.length) {
    const empty = document.createElement('div');
    empty.className = 'folder-empty';
    empty.textContent = t('web.folder.no_subdirs');
    list.appendChild(empty);
  }
  for (const ent of d.entries) list.appendChild(devFolderRow(ent.path, ent.name, { isSelf: false }));
}

export function devFolderRow(path, label, opts) {
  const picked = S.devDir === path;
  const row = document.createElement('div');
  row.className = 'folder-item' + (opts.isSelf ? ' folder-item--self' : '') + (picked ? ' on' : '');
  const box = document.createElement('button');
  box.type = 'button';
  box.className = 'folder-check folder-check--radio';
  box.setAttribute('aria-pressed', picked ? 'true' : 'false');
  box.title = picked ? t('web.dev.project_selected') : t('web.dev.project_use');
  box.textContent = picked ? '●' : '';
  box.addEventListener('click', (e) => { e.stopPropagation(); selectDevDir(path); });
  row.appendChild(box);
  const name = document.createElement('button');
  name.type = 'button';
  name.className = 'folder-item__label';
  const tail = opts.isSelf
    ? `<span class="folder-item__git ${opts.isGit ? 'ok' : 'no'}">${esc(opts.isGit ? t('web.folder.is_git') : t('web.folder.not_git'))}</span>`
    : '<span class="folder-item__go" aria-hidden="true">›</span>';
  name.innerHTML = `<span class="folder-item__icon" aria-hidden="true">${opts.isSelf ? '📍' : '📁'}</span>`
    + `<span class="folder-item__name">${esc(label)}${opts.isSelf ? ` <span class="muted">· ${esc(t('web.folder.this_folder'))}</span>` : ''}</span>`
    + tail;
  name.addEventListener('click', () => { if (opts.isSelf) selectDevDir(path); else loadDevFolder(path); });
  row.appendChild(name);
  return row;
}

/* ---------------- Dev: dictate the goal ----------------
   OpenRouter accepts wav/mp3/ogg/flac/… for `input_audio` but NOT the webm a
   browser's MediaRecorder produces by default. So: record with MediaRecorder
   (whatever container the browser gives), decode it with the Web Audio API,
   and re-encode 16 kHz mono WAV ourselves. No build step, no library, and it
   behaves the same in Chrome and Firefox. */
const TRANSCRIBE_SAMPLE_RATE = 16000;
let micState = { recorder: null, chunks: [], stream: null, busy: false };

export function setMicUi(mode, hint) {
  const btn = /** @type {HTMLButtonElement | null} */ ($('devMic'));
  if (!btn) return;
  btn.classList.toggle('is-recording', mode === 'recording');
  btn.classList.toggle('is-busy', mode === 'busy');
  btn.disabled = mode === 'busy';
  btn.title = mode === 'recording' ? t('web.dev.mic_stop') : t('web.dev.mic_title');
  if (hint !== undefined) $('devMicHint').textContent = hint;
}

/** AudioBuffer → 16-bit PCM WAV bytes (mono). */
export function encodeWav(samples, sampleRate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

export function bytesToBase64(bytes) {
  let s = '';
  const CHUNK = 0x8000;                      // avoid blowing the argument limit
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

/** Decode any recorded container, downmix to mono and resample to 16 kHz. */
export async function blobToWavBase64(blob) {
  // webkitAudioContext is the legacy Safari alias — absent from the DOM lib types.
  const ctx = new (window.AudioContext || /** @type {any} */ (window).webkitAudioContext)();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const frames = Math.max(1, Math.ceil(decoded.duration * TRANSCRIBE_SAMPLE_RATE));
    const off = new OfflineAudioContext(1, frames, TRANSCRIBE_SAMPLE_RATE);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const rendered = await off.startRendering();
    return bytesToBase64(encodeWav(rendered.getChannelData(0), TRANSCRIBE_SAMPLE_RATE));
  } finally {
    ctx.close().catch(() => {});
  }
}

export function stopMicTracks() {
  if (micState.stream) for (const track of micState.stream.getTracks()) track.stop();
  micState.stream = null;
}

export async function toggleDictation() {
  if (micState.busy) return;
  if (micState.recorder && micState.recorder.state === 'recording') {
    micState.recorder.stop();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    toast(t('web.dev.mic_unsupported'), true);
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    // NotAllowedError is the common one — a denied or dismissed permission.
    toast(e && e.name === 'NotAllowedError' ? t('web.dev.mic_denied') : t('web.dev.mic_absent'), true);
    return;
  }
  micState = { recorder: new MediaRecorder(stream), chunks: [], stream, busy: false };
  micState.recorder.addEventListener('dataavailable', (ev) => { if (ev.data.size) micState.chunks.push(ev.data); });
  micState.recorder.addEventListener('stop', () => { void finishDictation(); });
  micState.recorder.start();
  setMicUi('recording', t('web.dev.mic_recording'));
}

export async function finishDictation() {
  stopMicTracks();
  const blob = new Blob(micState.chunks, { type: micState.chunks[0]?.type || 'audio/webm' });
  micState.recorder = null;
  micState.chunks = [];
  if (!blob.size) { setMicUi('idle', t('web.dev.mic_nothing')); return; }

  micState.busy = true;
  setMicUi('busy', t('web.dev.mic_transcribing'));
  try {
    const audio = await blobToWavBase64(blob);
    // Transcription is OpenRouter-only (Gemini via OpenRouter), so the spec is
    // that provider's by definition — NOT the run's provider, and not a lookup
    // through the backend (which now names no spec at all).
    const specName = 'openrouter';
    const res = await api('/api/dev/transcribe', {
      method: 'POST',
      body: JSON.stringify({ audio, format: 'wav', apiKey: sessionKey(specName) || undefined }),
    });
    const text = (res.text || '').trim();
    if (!text) { setMicUi('idle', t('web.dev.mic_no_speech')); return; }
    // APPEND rather than replace: dictating twice should build up the goal, and
    // silently discarding what the user already typed would be hostile.
    const box = /** @type {HTMLTextAreaElement} */ ($('devGoal'));
    box.value = box.value.trim() ? `${box.value.trim()} ${text}` : text;
    renderDevGoalCount();
    box.focus();
    setMicUi('idle', t('web.dev.mic_done', { model: res.modelId }));
  } catch (e) {
    setMicUi('idle', t('web.dev.mic_failed'));
    toast(e.message, true);
  } finally {
    micState.busy = false;
  }
}

export function renderDevGoalCount() {
  const n = /** @type {HTMLTextAreaElement} */ ($('devGoal')).value.trim().length;
  $('devGoalCount').textContent = n ? t('web.dev.chars', { count: n }) : '';
}

/** `role: id` / `epoch·phase: runId` chips — one compact row, never a wall of text. */
export function devChips(pairs) {
  return `<span class="rolechips">${pairs
    .map(([k, v]) => `<span class="rolechip"><b>${esc(k)}</b>${esc(v)}</span>`)
    .join('')}</span>`;
}

/**
 * The middle of the session panel: WHAT IS ABOUT TO RUN.
 *
 * Three blocks, in this order, and each independent of the others:
 *
 *   1. the METHOD — the drawing's node list when the session is a drawing, the
 *      planner's fronts when it is not. A drawn session has no "fronts"; the
 *      compiler emits nodes, and printing invented fronts over a drawing would
 *      describe a plan nobody wrote;
 *   2. `planWarnings`, ALWAYS. This used to hang off `plan` being truthy, which
 *      made it disappear in exactly the states where it matters most — and it
 *      is where a human discovers that their twelve methodology boxes and their
 *      per-role routing were NOT compiled into the drawing;
 *   3. nothing else. THIS STRING IS REWRITTEN ON EVERY SSE FRAME, so anything
 *      interactive mounted in here would be destroyed a few times a second.
 *      Buttons belong to the stable elements in index.html (`#devGate`,
 *      `#devResumeGate`), which is why the resume recovery is wired there.
 *
 * Pure: a session in, HTML out. That is what lets the shapes be asserted.
 */
export function devPlanHtml(session) {
  const out = [];
  const drawn = session.drawnMethod;
  const graph = session.graph;
  if (drawn && drawn.id) {
    out.push(`<div class="dev-plan__head">${esc(t('web.dev.method_head', { name: drawn.name || drawn.id }))}</div>`);
    if (drawn.description) out.push(`<div class="muted dev-plan__done">${esc(drawn.description)}</div>`);
    const order = graph && Array.isArray(graph.nodeOrder) ? graph.nodeOrder : [];
    if (order.length) {
      const steps = (graph && graph.stepsByNode) || {};
      out.push(`<div class="muted dev-plan__done">${esc(t('web.dev.method_nodes'))}</div>`);
      out.push(
        `<div class="dev-graph-nodes">${order
          .map((nodeId, i) => {
            const n = Array.isArray(steps[nodeId]) ? steps[nodeId].length : 0;
            return `<span class="dev-graph-node"><span class="dev-graph-node__order">${i + 1}</span>` +
              `<span>${esc(nodeId)}</span>` +
              `<span class="dev-graph-node__steps">${esc(t('web.dev.method_steps', { count: n }))}</span></span>`;
          })
          .join('')}</div>`,
      );
      if (graph.graphRoot) {
        out.push(`<div class="dev-graph-root">${esc(t('web.dev.method_root', { path: graph.graphRoot }))}</div>`);
      }
    } else {
      // `drawnMethod` lands at start(), `graph` only on the `planned` event.
      out.push(`<div class="muted dev-plan__done">${esc(t('web.dev.method_compiling'))}</div>`);
    }
  } else if (session.plan) {
    const plan = session.plan;
    out.push(`<div class="dev-plan__head">${esc(plan.epochGoal)}</div>`);
    out.push(`<div class="muted dev-plan__done">${esc(t('web.dev.done_when', { text: plan.doneWhen }))}</div>`);
    for (const f of plan.fronts) {
      out.push(
        `<div class="dev-front"><div class="dev-front__title">${esc(f.title)} <span class="muted">[${esc(f.id)}]</span></div>` +
        `<div class="muted">${esc(f.rationale)}</div>` +
        `<div class="muted dev-front__meta">${esc(t('web.dev.front_max', { count: f.maxTasks }))}` +
        `${f.dependsOnFronts.length ? ' · ' + esc(t('web.dev.front_after', { list: f.dependsOnFronts.join(', ') })) : ' · ' + esc(t('web.dev.front_parallel'))}</div></div>`,
      );
    }
  }
  const warnings = Array.isArray(session.planWarnings) ? session.planWarnings : [];
  if (warnings.length) {
    out.push(`<div class="dev-plan__head">${esc(t('web.dev.plan_warnings'))}</div>`);
    for (const w of warnings) out.push(`<div class="dev-warn">⚠ ${esc(w)}</div>`);
  }
  return out.join('');
}

export function renderDevSession(session) {
  if (!session) return;
  S.devSession = session;
  $('devStatusPanel').hidden = false;
  const phaseEl = $('devPhase');
  phaseEl.textContent = DEV_PHASE_LABEL[session.phase] || session.phase;
  // Expose the raw phase so a state with its own meaning (knowledge) can also
  // read as its own state, not just as another line of grey text.
  phaseEl.dataset.phase = session.phase || '';

  const k = session.knowledge;
  const rows = [
    `<div class="dev-row"><span class="muted">${esc(t('web.dev.row_goal'))}</span><span>${esc(session.goal)}</span></div>`,
    `<div class="dev-row"><span class="muted">${esc(t('web.dev.row_project'))}</span><span>${esc(session.runDirectory)}</span></div>`,
    `<div class="dev-row"><span class="muted">Época</span><span>${session.currentEpoch}${
      session.maxEpochs ? ` / ${session.maxEpochs}` : ` <span class="muted">(${esc(t('web.dev.no_epoch_cap'))})</span>`
    }</span></div>`,
  ];
  if (session.sessionId) {
    rows.push(
      `<div class="dev-row"><span class="muted">${esc(t('web.dev.row_session'))}</span><span><code>${esc(session.sessionId)}</code>` +
      `${session.resumed ? ` <span class="muted">(${esc(t('web.dev.resumed'))})</span>` : ''}</span></div>`,
    );
  }
  // THE DRAWING, FROM THE FIRST FRAME. `drawnMethod` is set at start() — before
  // the knowledge bootstrap, long before the compile — precisely so this row can
  // say "this session is your method, not a model's" while everything else is
  // still empty. Absent ⇒ a planner session, and this row simply is not there.
  const drawn = session.drawnMethod;
  if (drawn && drawn.id) {
    rows.push(
      `<div class="dev-row"><span class="muted">${esc(t('web.dev.row_method'))}</span>` +
      `<span>${esc(drawn.name || drawn.id)} <code>${esc(drawn.id)}</code>` +
      `${drawn.description ? `<br><span class="muted">${esc(drawn.description)}</span>` : ''}</span></div>`,
    );
  }
  // The models that ACTUALLY ran — the effective ids, after preset expansion
  // and fallback. Worth showing: it is the only place the routing is provable.
  const models = session.models && typeof session.models === 'object' ? session.models : null;
  const modelPairs = models ? Object.keys(models).filter((r) => models[r]).map((r) => [r, models[r]]) : [];
  if (modelPairs.length) {
    rows.push(`<div class="dev-row"><span class="muted">${esc(t('web.dev.row_models'))}</span>${devChips(modelPairs)}</div>`);
  }
  const runIds = Array.isArray(session.runIds) ? session.runIds : [];
  if (runIds.length) {
    rows.push(`<div class="dev-row"><span class="muted">Runs</span>${devChips(runIds.map((r) => [
      `${Number(r.epoch) || 0}${r.phase ? '·' + r.phase : ''}`,
      String(r.runId || '').slice(0, 14),
    ]))}</div>`);
  }
  if (k) {
    rows.push(
      `<div class="dev-row"><span class="muted">${esc(t('web.dev.row_knowledge'))}</span><span>${k.present ? '✓ ' : '✗ '}${esc(k.reason)}</span></div>`,
    );
  }
  if (session.stoppedBecause) {
    rows.push(
      `<div class="dev-row"><span class="muted">${esc(t('web.dev.row_stopped'))}</span><span>${esc(session.stoppedBecause)}${session.detail ? ' — ' + esc(session.detail) : ''}</span></div>`,
    );
  }
  $('devStatus').innerHTML = rows.join('');

  $('devPlan').innerHTML = devPlanHtml(session);

  $('devGate').hidden = !session.awaitingApproval;
  renderDevResumeGate(session);
  renderDevOrphanGate(session);

  $('devEpochList').innerHTML = (session.epochs || [])
    .map(
      (e) =>
        `<div class="dev-epoch dev-epoch--${e.landingError ? 'err' : e.status}">` +
        `<span>${esc(t('web.dev.epoch_n', { n: e.epoch }))}</span><span class="muted">${esc(e.epochGoal)}</span>` +
        `<span class="muted">${e.landingError ? '⚠ ' + esc(e.landingError) : '✓ ' + String(e.landedCommit || '').slice(0, 8)}</span></div>`,
    )
    .join('');

  $('devLogs').textContent = (session.logs || []).map((l) => `[${l.level}] ${l.message}`).join('\n');
  $('devLogs').scrollTop = $('devLogs').scrollHeight;

  const running = session.active;
  /** @type {HTMLButtonElement} */ ($('devStartBtn')).disabled = running;
  $('devAbort').hidden = !running;
  // While a session is live the form is noise — and editing it would imply the
  // running session could be reconfigured, which it cannot.
  $('devForm').hidden = running;

  // Mark the mode switch while a session is live, so someone sitting on the
  // Pipelines side can see it — amber when ANY gate is blocking on THEM.
  const opt = $('modeDev');
  if (opt) {
    opt.classList.toggle('is-live', running);
    opt.classList.toggle(
      'is-waiting',
      !!(session.awaitingApproval || session.awaitingResume || session.awaitingOrphans),
    );
  }
}

/* Resume gate: a previous session with THIS goal stopped unfinished. Declining
   is not destructive — it just starts a fresh session (its own blackboard
   namespace), so the old epochs stay on disk. */
/**
 * The drawing the previous session ran, if any — `{graphId, graphName}`.
 *
 * NOTE THE SHAPE. `resumeOffer.drawnMethod` keeps `DevState`'s key names
 * (`graphId`/`graphName`) because it describes what is ON DISK, while the LIVE
 * session's `drawnMethod` is `{id, name}`. Reading one with the other's keys
 * yields `undefined` and a resume that silently loses its method, so the two
 * accessors are separated here and used nowhere else.
 */
export function resumeOfferGraph(session) {
  const o = session && session.resumeOffer;
  const d = o && o.drawnMethod;
  return d && d.graphId ? { graphId: d.graphId, graphName: d.graphName || d.graphId } : null;
}

/** The drawing the LIVE start request resolved to — `{id, name}` shaped. */
export function liveSessionGraphId(session) {
  const d = session && session.drawnMethod;
  return (d && d.id) || '';
}

export function renderDevResumeGate(session) {
  const gate = $('devResumeGate');
  if (!gate) return;
  gate.hidden = !session.awaitingResume;
  const body = $('devResumeBody');
  if (!body) return;
  const o = session.resumeOffer;
  const drawn = resumeOfferGraph(session);
  // THE TRAP THIS CLOSES. `dev-driver.ts` REFUSES a resume that does not bring
  // the same drawing back (`graph-missing-on-resume`) — and it is right to: a
  // session a human opened as a drawing must never continue as a model's plan.
  // But the offer used to say only "resume session X", so the human clicked
  // "continue" on a session whose next epoch could not start, with nothing on
  // screen naming the method to re-select. Now the gate NAMES it, and says
  // whether this attempt is already carrying it.
  const carried = drawn && liveSessionGraphId(session) === drawn.graphId;
  const rows = o
    ? [
        `<div class="dev-row"><span class="muted">${esc(t('web.dev.row_session'))}</span><span><code>${esc(o.sessionId || '')}</code></span></div>`,
        `<div class="dev-row"><span class="muted">${esc(t('web.dev.row_goal'))}</span><span>${esc(o.goal || '')}</span></div>`,
        `<div class="dev-row"><span class="muted">${esc(t('web.dev.row_progress'))}</span><span>${esc(t('web.dev.progress', { done: Number(o.epochsDone) || 0, next: Number(o.nextEpoch) || 1 }))}</span></div>`,
      ]
    : [`<div class="muted">${esc(t('web.dev.resume_generic'))}</div>`];
  if (drawn) {
    rows.push(
      `<div class="dev-row"><span class="muted">${esc(t('web.dev.resume_method'))}</span>` +
      `<span>${esc(drawn.graphName)} <code>${esc(drawn.graphId)}</code></span></div>`,
    );
    rows.push(
      carried
        ? `<div class="muted">${esc(t('web.dev.resume_method_ready'))}</div>`
        : `<div class="dev-warn">⚠ ${esc(t('web.dev.resume_method_missing', { id: drawn.graphId }))}</div>`,
    );
  }
  body.innerHTML = rows.join('');

  // The accept BUTTON is a stable element in index.html — it survives this
  // repaint, which is exactly why the recovery hangs off it and not off
  // anything built here.
  const accept = /** @type {HTMLButtonElement | null} */ ($('devResumeAccept'));
  if (accept) {
    accept.textContent = drawn
      ? t('web.dev.resume_accept_with_graph', { name: drawn.graphName })
      : t('web.dev.resume_accept');
  }
}

/**
 * Answer the resume gate — re-supplying the drawing when it is missing.
 *
 * `POST /api/dev/resume` carries ONE bit (`accept`); the drawing only ever
 * reaches the driver through the START request, because `resolveDevGraph` reads
 * `graph`/`graphId` off the params and a resume re-opens a session, not its
 * arguments. So when this attempt is not already carrying the previous
 * session's method there is nothing to add to the accept: the only honest fix
 * is to stop this attempt and re-issue the START with `graphId` and
 * `resume: 'auto'` — which is the same answer the human just clicked, spelled
 * in the one place the server reads it.
 *
 * Nothing is lost by the restart: the refusal precedes every side effect
 * (no worktree, no run id, no blackboard commit), and `resume: 'auto'` adopts
 * the previous session's id and epoch numbering.
 */
export async function acceptDevResume() {
  const session = S.devSession;
  const drawn = resumeOfferGraph(session);
  if (!drawn || liveSessionGraphId(session) === drawn.graphId) {
    await api('/api/dev/resume', { method: 'POST', body: JSON.stringify({ accept: true }) });
    return;
  }
  toast(t('web.dev.resume_restarting', { id: drawn.graphId }));
  try {
    await api('/api/dev/abort', { method: 'POST', body: '{}' });
    await waitForDevIdle();
    // Adopt it in the FORM too, so the panel and the request agree and a second
    // start from the UI carries the same method.
    devGraphPick.source = 'graph';
    devGraphPick.id = drawn.graphId;
    S.devGraphId = drawn.graphId;
    renderDevMethodSource();
    await api('/api/dev', {
      method: 'POST',
      body: JSON.stringify(
        devStartBody(session.goal || '', session.modelId || devFallbackModelId(), {
          runDirectory: session.runDirectory || S.devDir,
          approval: session.approval || devApprovalMode(),
          graphId: drawn.graphId,
          resume: 'auto',
        }),
      ),
    });
  } catch (e) {
    toast(t('web.dev.resume_restart_failed', { id: drawn.graphId, message: e.message }), true);
  }
}

/** Poll until the manager reports no live session (abort is asynchronous). */
export async function waitForDevIdle(tries = 40, waitMs = 100) {
  for (let i = 0; i < tries; i += 1) {
    let session = null;
    try { session = (await api('/api/dev')).session; } catch { return false; }
    if (!session || session.active === false) return true;
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return false;
}

/* Orphan gate: huu integration branches that are ahead of HEAD, i.e. work an
   earlier session left unlanded. "Ignorar" is always safe — a forgotten branch
   must never block a new session; the log names the branch and the merge. */
export function renderDevOrphanGate(session) {
  const gate = $('devOrphanGate');
  if (!gate) return;
  gate.hidden = !session.awaitingOrphans;
  const body = $('devOrphanBody');
  if (!body) return;
  const list = Array.isArray(session.orphans) ? session.orphans : [];
  body.innerHTML = list.length
    ? list.map((o) =>
        `<div class="dev-orphan"><code>${esc(o.branch || '')}</code>` +
        `<span class="muted">${esc(t('web.dev.commits_ahead', { count: Number(o.ahead) || 0 }))}` +
        `${o.epoch ? ' · ' + esc(t('web.dev.epoch_n', { n: Number(o.epoch) || 0 })) : ''}</span></div>`).join('')
    : `<div class="muted">${esc(t('web.dev.no_branches'))}</div>`;
}

export function devApprovalMode() {
  const on = /** @type {HTMLButtonElement | null} */ ($('devApprovalSeg').querySelector('button.on'));
  return on ? on.dataset.approval : 'autonomous';
}

/** Auto ⇒ let the planner choose (send nothing); Manual ⇒ pin the ceiling. */
export function devFrontsCap() {
  const on = /** @type {HTMLButtonElement | null} */ ($('devFrontsSeg').querySelector('button.on'));
  if (!on || on.dataset.frontsMode !== 'manual') return undefined;
  return Number(/** @type {HTMLInputElement} */ ($('devFronts')).value);
}

/**
 * The whole `POST /api/dev` body, as one value.
 *
 * EXTRACTED SO THE BYTES ARE ASSERTABLE. The invariant this feature has to keep
 * is "a dev session with no drawing is byte-identical to the one before the
 * drawing existed", and the only honest way to pin that is to compare the
 * object two configurations produce — not to read the handler and believe it.
 *
 * `maxEpochs` is absent, deliberately and on BOTH paths (see `devGraphPick`).
 *
 * @param {string} goal
 * @param {string} modelId
 * @param {Record<string, any>} [extra] resume-path overrides; nothing else uses it
 */
export function devStartBody(goal, modelId, extra = {}) {
  // VERBATIM from the submit handler this replaced, `S.boot` included — i.e.
  // NOT included. `backendSpecName(id, boot)` resolves the key-spec name out of
  // `boot.backends`, so omitting the second argument makes it return
  // `undefined` and `apiKey` always undefined here (queue.js passes it; this
  // form never did). That is a pre-existing bug and it is left ALONE on
  // purpose: "a session without a drawing posts the same bytes" is the
  // invariant this wave has to keep, and quietly starting to send a key would
  // break it in the one direction nobody would test for.
  // The ACTIVE PROVIDER's spec. `backendSpecName(S.backend)` could not answer
  // this (jcode serves two providers, so the server reports no spec for it) and
  // was additionally called without `S.boot`, so it always returned undefined.
  const specName = activeKeySpecName(S);
  return {
    goal,
    provider: S.provider,
    modelId,
    apiKey: sessionKey(specName) || undefined,
    runDirectory: S.devDir,
    approval: devApprovalMode(),
    // No maxEpochs on purpose: the session runs until the planner reports
    // the goal complete or the user aborts.
    maxFronts: devFrontsCap(),
    // `models` / `modelsPreset`, or NOTHING when no role is pinned —
    // `modelId` above stays the fallback for every unset role, so an
    // untouched panel POSTs the body this form has always posted.
    ...devModelsPayload(),
    // `methodology`, or NOTHING when every toggle is off — the same
    // byte-identical contract as the routing fields above.
    ...devMethodologyPayload(),
    // `graphId`, or NOTHING on the planner path — same contract again.
    ...devGraphPayload(),
    ...extra,
  };
}

/**
 * Why the form cannot be submitted yet — a translated sentence, or null.
 *
 * The server refuses each of these too (`graph-not-found`, `graph-invalid`), so
 * this is not the gate; it is the ANSWER, given before the round-trip and in
 * terms of the repair rather than a stop code.
 */
export function devSubmitBlocker(goal, modelId) {
  if (!goal) return { message: t('web.dev.err_no_goal'), focus: 'devGoal' };
  if (!modelId) return { message: t('web.dev.err_no_model'), focus: '' };
  if (!S.devDir) return { message: t('web.dev.err_no_dir'), focus: '' };
  if (devMethodSource() === 'graph') {
    const picked = devSelectedGraph();
    if (!picked) return { message: t('web.dev.err_no_graph'), focus: 'devGraphSelect' };
    if (picked.valid === false) {
      return { message: t('web.dev.err_graph_invalid'), focus: 'devGraphSelect' };
    }
  }
  return null;
}

export function wireDev() {
  if (!$('devForm')) return;

  $('devGoal').addEventListener('input', renderDevGoalCount);
  $('devMic').addEventListener('click', () => { void toggleDictation(); });

  $('devFolderUp').addEventListener('click', () => {
    if (devFolderState.parent) loadDevFolder(devFolderState.parent);
  });
  $('devFolderHome').addEventListener('click', () => loadDevFolder(S.boot?.workspace || ''));

  // Both segmented controls follow the design system: `.segmented` + `.on`.
  const wireSeg = (id, attr, after) => {
    $(id).addEventListener('click', (ev) => {
      const btn = /** @type {Element} */ (ev.target).closest(`[data-${attr}]`);
      if (!btn) return;
      // Array.from: NodeListOf has no Symbol.iterator without the DOM.Iterable lib.
      for (const b of Array.from($(id).querySelectorAll(`[data-${attr}]`))) b.classList.toggle('on', b === btn);
      if (after) after(btn);
    });
  };
  wireSeg('devApprovalSeg', 'approval', (btn) => {
    $('devApprovalHint').textContent =
      btn.dataset.approval === 'each-epoch'
        ? t('web.dev.approval_hint_each')
        : t('web.dev.approval_hint_auto');
  });
  wireSeg('devFrontsSeg', 'fronts-mode', (btn) => {
    $('devFrontsRow').hidden = btn.dataset.frontsMode !== 'manual';
  });
  $('devFronts').addEventListener('input', () => { $('devFrontsOut').textContent = /** @type {HTMLInputElement} */ ($('devFronts')).value; });

  // Per-role routing. Both hosts are STABLE containers whose children are
  // rebuilt on every preset switch, so the listeners are delegated and wired
  // once. Null-safe: a stale cached index.html without the panel must degrade
  // to "no routing", never take the whole module down at load.
  const presetSeg = $('devPresetSeg');
  if (presetSeg) presetSeg.addEventListener('click', (ev) => {
    const t = /** @type {Element} */ (ev.target);
    // closest() types as Element; the matches are always our <button>s (dataset).
    const btn = /** @type {HTMLElement | null} */ (t.closest ? t.closest('[data-preset]') : null);
    if (!btn || !devModels.presets) return;
    devModels.preset = btn.dataset.preset;
    devModels.values = presetValues(devModels.roles, devModels.presets, devModels.preset);
    renderDevPresetSeg();
    renderDevRoleFields();
    renderDevModelsSummary();
  });
  const roleFields = $('devRoleFields');
  if (roleFields) roleFields.addEventListener('input', (ev) => {
    const t = /** @type {HTMLInputElement | null} */ (ev.target);
    const role = t && t.dataset ? t.dataset.role : '';
    if (!role) return;
    devModels.values[role] = t.value;
    renderDevModelsSummary();
  });

  // Methodology toggles. The list is a STABLE container whose children are
  // rebuilt on every toggle, so the listener is delegated and wired once —
  // null-safe so a stale cached shell degrades to "no methodology", never a
  // module-load crash. Each toggle persists immediately under
  // huu.settings.v1 (mirrored on S.settings so the ⚙ modal's saves keep it).
  const methodList = $('devMethodList');
  if (methodList) methodList.addEventListener('click', (ev) => {
    // instanceof (not `ev.target.closest ? …`) so the client typecheck sees a
    // real Element instead of adding to its pre-existing TS2339 pile.
    const btn = ev.target instanceof Element ? ev.target.closest('[data-method]') : null;
    if (!btn) return;
    const key = btn.getAttribute('data-method');
    if (!key) return;
    if (devMethods.on.has(key)) devMethods.on.delete(key);
    else devMethods.on.add(key);
    S.settings.devMethodology = [...devMethods.on];
    saveSettings();
    renderDevMethodology();
  });

  // The METHOD panel. Both hosts are stable, so the listeners are delegated and
  // wired once; null-safe so a stale cached shell degrades to "planner only".
  const sourceSeg = $('devMethodSourceSeg');
  if (sourceSeg) sourceSeg.addEventListener('click', (ev) => {
    const btn = ev.target instanceof Element ? ev.target.closest('[data-method-source]') : null;
    if (!btn) return;
    setDevMethodSource(btn.getAttribute('data-method-source'));
  });
  const graphSelect = $('devGraphSelect');
  if (graphSelect) graphSelect.addEventListener('change', (ev) => {
    const el = /** @type {HTMLSelectElement | null} */ (ev.target);
    selectDevGraph(el ? el.value : '');
  });
  // Intercepted, not followed: a real navigation to /graph reloads the page —
  // dropping the SSE stream and the live board — and its href never gets the
  // `?token=` that `tokenizeNavLinks` only adds to the mode-switch anchors.
  const openCanvas = $('devGraphOpenCanvas');
  if (openCanvas) openCanvas.addEventListener('click', (ev) => {
    const mouse = /** @type {MouseEvent} */ (ev);
    if (mouse.metaKey || mouse.ctrlKey || mouse.shiftKey || mouse.altKey || mouse.button !== 0) return;
    ev.preventDefault();
    switchMode('graph');
  });
  // The canvas hands a saved method over through the document (see
  // RUN_GRAPH_EVENT) rather than by importing this module — `launch.js` already
  // imports the canvas, so the reverse import would close an ESM cycle.
  document.addEventListener(RUN_GRAPH_EVENT, (ev) => {
    const detail = /** @type {CustomEvent} */ (ev).detail || {};
    adoptDevGraphFromCanvas(detail.id, detail.name);
  });

  $('devForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const goal = /** @type {HTMLTextAreaElement} */ ($('devGoal')).value.trim();
    const modelId = devFallbackModelId();
    const blocked = devSubmitBlocker(goal, modelId);
    if (blocked) {
      toast(blocked.message, true);
      if (blocked.focus) $(blocked.focus)?.focus();
      return;
    }

    try {
      const res = await api('/api/dev', {
        method: 'POST',
        body: JSON.stringify(devStartBody(goal, modelId)),
      });
      toast(t('web.dev.session_started', { id: res.sessionId }));
    } catch (e) {
      toast(e.message, true);
    }
  });

  $('devApprove').addEventListener('click', async () => {
    try { await api('/api/dev/approve', { method: 'POST', body: JSON.stringify({ approved: true }) }); }
    catch (e) { toast(e.message, true); }
  });
  $('devReject').addEventListener('click', async () => {
    try { await api('/api/dev/approve', { method: 'POST', body: JSON.stringify({ approved: false }) }); }
    catch (e) { toast(e.message, true); }
  });
  $('devAbort').addEventListener('click', async () => {
    try { await api('/api/dev/abort', { method: 'POST', body: '{}' }); }
    catch (e) { toast(e.message, true); }
  });

  // Resume + orphan gates: same shape as the approval gate above — one POST,
  // the server answers 409 when nothing is waiting, and the next SSE frame
  // hides the block. Null-safe so an older cached shell degrades quietly.
  const wireGate = (id, path, body) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('click', async () => {
      try { await api(path, { method: 'POST', body: JSON.stringify(body) }); }
      catch (e) { toast(e.message, true); }
    });
  };
  // Accept is NOT a plain wireGate: when the previous session ran a drawing
  // this attempt is not carrying, accepting has to re-issue the START with the
  // `graphId` (see acceptDevResume). Reject stays one bit.
  const resumeAccept = $('devResumeAccept');
  if (resumeAccept) resumeAccept.addEventListener('click', async () => {
    try { await acceptDevResume(); }
    catch (e) { toast(e.message, true); }
  });
  wireGate('devResumeReject', '/api/dev/resume', { accept: false });
  wireGate('devOrphanLand', '/api/dev/orphans', { action: 'land' });
  wireGate('devOrphanIgnore', '/api/dev/orphans', { action: 'ignore' });

  $('devViewBoard').addEventListener('click', () => { showView('run'); renderActiveRun(); });
}
wireDev();
wireModeSwitch();

/* Pick the surface SYNCHRONOUSLY, before /api/bootstrap is even requested.
   Deciding it after the fetch resolved made a direct /dev load paint the
   pipeline picker first and swap a beat later — a visible flash. This is a
   pure DOM toggle; `initDevSurface()` still runs later, once boot() has the
   providers and models it needs. */
if (location.pathname.replace(/\/+$/, '') === '/dev') showView('dev');

boot().catch((e) => { document.body.insertAdjacentHTML('afterbegin', `<div class="run-error" style="margin:20px">Failed to load huu: ${esc(e.message)}</div>`); });

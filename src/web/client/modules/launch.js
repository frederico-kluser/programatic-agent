/* huu web UI — launch flow: wizard, pipeline gallery, provider/models/keys, combobox, concurrency mode, config step, folder step, views, and mode switch. */

import { uid } from '../db.js';
import { fanOutBatch } from '../queue-util.js';
import { parseTimeoutMinutes } from '../queue-util.js';
import { markAllPlan } from '../folder-select.js';
import { esc, toast, shortDir, projectName } from './utils.js';
import { $, S, api, pipeIcon, sessionKey, setSessionKey, activeKeySpecName, providerInfoById, providerReady, providerBackend, syncTimeoutField, DEFAULT_MODEL_ID, withTok } from './state.js';
import { renderQueue, commitBatch, setAddBtnLabel, addLabel, renderLaunchRunning } from './queue.js';
import { renderActiveRun } from './board.js';
import { initDevSurface } from './dev.js';
import { initGraphSurface } from './graph/canvas.js';
import { t } from '../i18n.js';

/* ---------------- Guided-launch wizard (steps) ----------------
   Four steps toggled by goStep(): 1 pick pipeline · 2 mark projects ·
   3 configure · 4 queue. The stepper chips double as navigation (gated). */
export function canGoStep(n) {
  if (n === 1) return true;
  if (n === 2) return !!S.selectedPipe;                             // a pipeline is picked
  if (n === 3) return !!S.selectedPipe && S.markedDirs.size >= 1;   // …and ≥1 project marked
  if (n === 4) return S.queue.items.length >= 1;                    // something to review/run
  return false;
}

export function renderStepper() {
  const step = S.wizard.step;
  // The stepper chips are real elements (they carry dataset.step).
  const chips = /** @type {HTMLElement[]} */ (Array.from($('stepper').children));
  for (const chip of chips) {
    const n = +chip.dataset.step;
    chip.classList.toggle('is-current', n === step);
    chip.classList.toggle('is-done', n < step);
    chip.classList.toggle('is-disabled', !canGoStep(n));
  }
}

export function goStep(n) {
  S.wizard.step = n;
  for (let i = 1; i <= 4; i++) { const el = $('step' + i); if (el) el.hidden = i !== n; }
  renderStepper();
  if (n === 1) renderGallery();
  else if (n === 2) renderFolderStep();
  else if (n === 3) renderConfigStep();
  else if (n === 4) renderQueue();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Stepper chips are clickable shortcuts back/forward through completed steps.
$('stepper').addEventListener('click', (e) => {
  if (!(e.target instanceof Element)) return;
  // .step-chip is an element with dataset.step.
  const chip = /** @type {HTMLElement | null} */ (e.target.closest('.step-chip'));
  if (!chip) return;
  const n = +chip.dataset.step;
  if (canGoStep(n)) goStep(n);
});
$('step2Back').addEventListener('click', () => goStep(1));
$('step3Back').addEventListener('click', () => goStep(2));
$('addAnotherBtn').addEventListener('click', () => {
  // Commit is already done (we're on step 4). Reset the batch and pick another
  // pipeline; the accumulated queue persists and stays reachable via the chips.
  S.selectedPipe = null;
  S.markedDirs.clear();
  goStep(1);
});

/* ---------------- Launch: pipeline gallery ---------------- */
export function renderGallery() {
  const g = $('pipelineGallery');
  $('pipeCount').textContent = S.pipelines.length ? `${S.pipelines.length}` : '';
  if (!S.pipelines.length) { g.innerHTML = `<div class="lane__empty">${esc(t('web.launch.no_pipelines'))} <code>pipelines/</code>.</div>`; return; }
  g.innerHTML = '';
  for (const p of S.pipelines) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'pipe-card' + (S.selectedPipe && S.selectedPipe.name === p.name ? ' sel' : '');
    el.innerHTML = `
      <div class="pipe-card__icon">${pipeIcon(p.name)}</div>
      <div>
        <div class="pipe-card__name">${esc(p.name)} ${p.isDefault ? '<span class="star" title="default">★</span>' : ''}</div>
        ${p.description ? `<div class="pipe-card__desc">${esc(p.description)}</div>` : ''}
        <div class="pipe-card__sub">${p.workSteps} work · ${p.checkSteps} check · ${p.stepCount} steps</div>
      </div>
      <div class="pipe-card__badges">
        ${p.isDefault ? '<span class="tag tag--default">default</span>' : ''}
        <span class="tag tag--src">${esc(p.source)}</span>
      </div>`;
    el.addEventListener('click', () => selectPipeline(p));
    g.appendChild(el);
  }
}

export function selectPipelineByName(name) {
  const p = S.pipelines.find((x) => x.name === name);
  if (p) selectPipeline(p);
}

export async function selectPipeline(p) {
  S.selectedPipe = p;
  renderGallery();
  goStep(2);                       // picking a pipeline advances to project marking
  // Prepare the config controls in the background so step 3 is ready. These
  // render into the (hidden) step-3 form; refreshModelsAndKeys is async/network.
  renderProviderSeg();
  await refreshModelsAndKeys();
  renderModeSeg();
}

/* ---------------- Launch: provider + models + keys ---------------- */
export function renderProviderSeg() {
  const seg = $('providerSeg');
  seg.innerHTML = '';
  const locked = !!(S.boot && S.boot.lockedProvider);
  for (const p of S.providers) {
    const btn = document.createElement('button');
    btn.type = 'button';
    const ready = providerReady(S, p);
    btn.className = S.provider === p.id ? 'on' : '';
    btn.textContent = p.label + (ready ? '' : ' •');
    btn.title = p.description + (ready ? ' · key ✓' : ' · key needed');
    if (locked && p.id !== S.boot.lockedProvider) btn.disabled = true;
    btn.addEventListener('click', async () => {
      S.provider = p.id;
      S.backend = providerBackend(S, p.id);
      // A typed/custom id is provider-specific — re-seed from the new provider's
      // catalog instead of carrying it across.
      S.modelId = '';
      S.conflictResolverModelId = '';
      renderProviderSeg();
      await refreshModelsAndKeys();
    });
    seg.appendChild(btn);
  }
}

export async function refreshModelsAndKeys() {
  // Models (by provider). OpenRouter's /models is public, so the server returns
  // the FULL live catalog even with no key — the user sees every model the
  // moment this screen opens. We still forward a validated session key when we
  // have one (per-account view); it's optional for listing.
  try {
    // The session key of the ACTIVE PROVIDER's spec — `backendSpecName` cannot
    // answer this any more (jcode serves two providers, so the server reports
    // no spec name for it).
    const orKey = sessionKey(activeKeySpecName(S));
    const m = await api(
      '/api/models?provider=' + encodeURIComponent(S.provider),
      orKey ? { headers: { 'x-huu-key': orKey } } : undefined,
    );
    S.models = m.models || [];
    S.modelSource = m.source || 'recommended';
  } catch { S.models = []; S.modelSource = 'recommended'; }
  // Keep the current pick across a provider/key refresh — INCLUDING a custom id
  // the user typed that isn't in the catalog (that's the point of free-text).
  // Only seed a default when there's no pick at all. The provider switch handler
  // clears S.modelId so a typed id never leaks across providers. Prefer the
  // canonical default model when the catalog offers it (the live OpenRouter list
  // is sorted alphabetically, so models[0] is NOT a meaningful default).
  if (!S.modelId && S.models.length) {
    const preferred = S.models.find((m) => m.id === DEFAULT_MODEL_ID);
    S.modelId = preferred ? preferred.id : S.models[0].id;
  }
  mainCombo.refresh();
  resolverCombo.refresh();
  // The /dev per-role fields share ONE <datalist> fed from the same catalog.
  renderDevModelOptions();
  // Keys (by provider). A spec we already hold a validated key for in THIS
  // browser session is satisfied even though the server — which never saw it —
  // still reports it missing.
  try { S.keyStatus = await api('/api/keys?provider=' + encodeURIComponent(S.provider)); }
  catch { S.keyStatus = { ok: true, missing: [] }; }
  if (S.keyStatus && Array.isArray(S.keyStatus.missing) && S.keyStatus.missing.length) {
    const stillMissing = S.keyStatus.missing.filter((s) => !sessionKey(s.name));
    S.keyStatus = { ok: stillMissing.length === 0, missing: stillMissing };
  }
  renderKeyArea();
  updateRunBtn();
}

/** Fill the ONE shared <datalist> the dev role inputs point at. */
export function renderDevModelOptions() {
  const list = document.getElementById('devModelOptions');
  if (!list) return;
  list.innerHTML = (S.models || [])
    .map((m) => `<option value="${esc(m.id)}">${esc(m.label && m.label !== m.id ? m.label : '')}</option>`)
    .join('');
}

/* Render one row per credential the selected provider needs. Each value can be
   set when missing AND changed when already present. Pasted values are
   validated against the provider and kept in THIS browser session only — never
   written to disk. Endpoint specs use a text input; keys use a password input. */
export function renderKeyArea() {
  const area = $('keyArea');
  const info = providerInfoById(S, S.provider);
  const specs = (info && info.keySpecs) || [];
  if (!specs.length) { area.innerHTML = ''; area.hidden = true; return; }
  area.hidden = false;
  const missing = new Set((S.keyStatus.missing || []).map((m) => m.name));
  const rows = specs
    .map((spec) => {
      const present = !missing.has(spec.name);
      const isText = spec.name === 'azureEndpoint';
      const editorId = `keyEdit-${spec.name}`;
      const inputHtml = `
        <div class="key-row" id="${editorId}" ${present ? 'hidden' : ''}>
          <input type="${isText ? 'text' : 'password'}" data-spec="${esc(spec.name)}"
                 placeholder="${esc(spec.hint || t('web.key.paste_value'))}" autocomplete="off" spellcheck="false" />
          <button type="button" class="btn btn--ghost btn--sm" data-save="${esc(spec.name)}">${esc(t('web.key.validate_use'))}</button>
        </div>
        ${spec.validatePrefix ? `<div class="key-hint">${esc(t('web.key.expected_prefix', { prefix: spec.validatePrefix }))}</div>` : ''}`;
      const status = present
        ? `<div class="key-status"><span class="key-status__ok">${esc(t('web.key.set', { label: spec.label }))}</span>
             <button type="button" class="linkbtn" data-change="${esc(spec.name)}">${esc(t('web.key.change'))}</button></div>`
        : `<div class="key-status"><span class="key-status__need">${esc(t('web.key.needed', { label: spec.label }))}</span></div>`;
      return `<label>${esc(spec.label)}</label>${status}${inputHtml}`;
    })
    .join('<div style="height:6px"></div>');
  area.innerHTML = rows +
    `<div class="model-hint">${esc(t('web.key.session_only'))}</div>`;
}

// Delegated handlers for the dynamic key rows: reveal the "change" editor, or
// validate + accept a pasted value. The value is checked against the provider
// and then kept in THIS browser session only — it is never written to disk
// (we deliberately do NOT call the persistence endpoint POST /api/keys here).
$('keyArea').addEventListener('click', async (e) => {
  // Delegated clicks inside #keyArea always land on an element.
  const target = /** @type {HTMLElement} */ (e.target);
  const changeName = target.getAttribute && target.getAttribute('data-change');
  if (changeName) {
    const row = document.getElementById(`keyEdit-${changeName}`);
    if (row) { row.hidden = false; const inp = row.querySelector('input'); if (inp) inp.focus(); }
    return;
  }
  const saveName = target.getAttribute && target.getAttribute('data-save');
  if (!saveName) return;
  const row = document.getElementById(`keyEdit-${saveName}`);
  const input = row && row.querySelector('input');
  const value = input ? input.value.trim() : '';
  if (!value) return;
  // data-save only exists on the row's "Validate & use" <button>.
  const btn = /** @type {HTMLButtonElement} */ (target);
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = t('web.settings.validating');
  try {
    // Azure's key can only be validated together with its endpoint — read the
    // endpoint the user just typed (if any) or one already held this session.
    const epInput = /** @type {HTMLInputElement | null} */ (document.querySelector('[data-spec="azureEndpoint"]'));
    const endpoint = ((epInput && epInput.value) || sessionKey('azureEndpoint') || '').trim() || undefined;
    // Validate BEFORE accepting — a key the provider rejects (the exact 401
    // that motivated this) is never kept. On success the value lives only in
    // this browser's session memory and is sent with each run.
    const r = await api('/api/keys/validate', {
      method: 'POST',
      body: JSON.stringify({ name: saveName, value, endpoint }),
    });
    if (r.status === 'valid') {
      setSessionKey(saveName, value);
      toast(t('web.key.validated_session'));
      await refreshModelsAndKeys();
    } else if (r.status === 'invalid') {
      toast(t('web.key.rejected', { status: r.httpStatus }), true);
    } else if (r.status === 'wrong-key') {
      // Another provider's credential: refused outright, NOT kept for the
      // session. An `sk-or-…` accepted into the `deepseek` slot would be sent
      // to api.deepseek.com with every run this tab launches.
      toast(t('web.key.wrong_provider', { label: r.label }), true);
    } else {
      // Couldn't reach the provider (offline/VPN) or no validator for this
      // spec (e.g. the Azure endpoint URL) — don't hard-block; keep it for
      // this session with a warning.
      setSessionKey(saveName, value);
      toast(t('web.key.unverified', { reason: r.reason }));
      await refreshModelsAndKeys();
    }
  } catch (err) { toast(err.message, true); }
  finally { btn.disabled = false; btn.textContent = label; }
});

/* ---------------- Searchable model combobox ----------------
   Replaces the old <select>: type to filter the list. For OpenRouter that list
   is the FULL live catalog — every model, no capability filter — downloaded
   from the public /models endpoint with or without a key (see
   refreshModelsAndKeys). Type any id to use one that isn't listed. */
export function modelById(id) { return S.models.find((m) => m.id === id) || null; }

export function fmtCtx(n) {
  if (!n || n <= 0) return '';
  if (n >= 1000000) return (n % 1000000 ? (n / 1000000).toFixed(1) : n / 1000000) + 'M ctx';
  if (n >= 1000) return Math.round(n / 1000) + 'k ctx';
  return n + ' ctx';
}

/**
 * A typed value that isn't already an exact catalog id → offer it verbatim so
 * the user can run ANY OpenRouter model, even one not in the downloaded list
 * (a brand-new model, or one the catalog filter never had). This is the
 * free-text escape hatch: pick it and the raw id is sent to OpenRouter as-is.
 */
export function customCandidate(query) {
  const q = query.trim();
  if (!q) return null;
  if (S.models.some((m) => m.id === q)) return null; // already a real option
  return { id: q, label: q, custom: true };
}

export function comboMatches(query) {
  const q = query.trim().toLowerCase();
  const base = !q
    ? S.models.slice()
    : S.models.filter((m) =>
        m.id.toLowerCase().includes(q) || (m.label || '').toLowerCase().includes(q));
  const custom = customCandidate(query);
  return custom ? base.concat([custom]) : base;
}

export function modelOptionHtml(m, i, active, sel) {
  if (m.inherit) {
    // Resolver combo only: the "clear back to the run model" row.
    return `<li class="combo__opt combo__opt--custom${active ? ' active' : ''}${sel ? ' sel' : ''}" role="option" id="opt-${i}" data-id="${esc(m.id)}" aria-selected="${sel ? 'true' : 'false'}">` +
      `<span class="combo__opt-name">${esc(t('web.config.resolver_placeholder_value'))}</span>` +
      `<span class="combo__opt-id">${esc(t('web.combo.inherit_hint'))}</span></li>`;
  }
  if (m.custom) {
    return `<li class="combo__opt combo__opt--custom${active ? ' active' : ''}" role="option" id="opt-${i}" data-id="${esc(m.id)}" aria-selected="false">` +
      `<span class="combo__opt-name">${esc(t('web.combo.use_custom', { id: m.id }))}</span>` +
      `<span class="combo__badge combo__badge--custom">${esc(t('web.combo.custom_id'))}</span>` +
      `<span class="combo__opt-id">${esc(t('web.combo.as_is'))}</span></li>`;
  }
  const price = m.inputPrice != null ? `$${m.inputPrice}/M·$${m.outputPrice ?? '?'}/M` : '';
  const meta = [m.tier, fmtCtx(m.contextLength), price].filter(Boolean).join(' · ');
  const badges =
    (m.thinking ? `<span class="combo__badge">${esc(t('web.combo.reasoning'))}</span>` : '') +
    // huu's agents need tool calling — flag models that lack it so the choice
    // is informed, without hiding them.
    (m.tools === false ? `<span class="combo__badge combo__badge--warn">${esc(t('web.combo.no_tools'))}</span>` : '');
  return `<li class="combo__opt${active ? ' active' : ''}${sel ? ' sel' : ''}" role="option" id="opt-${i}" data-id="${esc(m.id)}" aria-selected="${sel ? 'true' : 'false'}">` +
    `<span class="combo__opt-name">${esc(m.label || m.id)}</span>` +
    badges +
    (meta ? `<span class="combo__opt-meta">${esc(meta)}</span>` : '') +
    `<span class="combo__opt-id">${esc(m.id)}</span></li>`;
}

/**
 * Build a searchable model combobox bound to a value getter/setter and DOM
 * element ids. Two instances exist: `mainCombo` drives the run model
 * (S.modelId); `resolverCombo` drives the OPTIONAL conflict-resolver model
 * (S.conflictResolverModelId; empty = inherit the run model). Both share the
 * single S.models catalog loaded by refreshModelsAndKeys.
 */
export function makeModelCombo(opts) {
  const state = { open: false, active: -1, matches: [], query: '' };
  const INHERIT = '__INHERIT__';
  // opts.inputId always names an <input> in index.html (modelInput / resolverModelInput).
  const inputEl = () => /** @type {HTMLInputElement} */ ($(opts.inputId));
  const listEl = () => $(opts.listId);
  const get = opts.get;
  const set = opts.set;

  function matchesFor() {
    const base = comboMatches(state.query);
    // The resolver combo offers an explicit "inherit the run model" row at the
    // top when the field is empty/unfiltered, so a prior pick can be cleared.
    if (opts.allowEmpty && !state.query.trim()) {
      return [{ id: INHERIT, label: t('web.config.resolver_placeholder_value'), inherit: true }].concat(base);
    }
    return base;
  }

  const isSelected = (m) => (m.inherit ? !get() : m.id === get());

  /** Reflect the current selection as the input's display value. */
  function syncInput() {
    const input = inputEl();
    if (!input) return;
    const md = modelById(get());
    // A custom id the user typed isn't in the catalog — show the id verbatim so
    // they can see exactly what will run, instead of a blank field.
    input.value = md ? md.label : (get() || '');
    // `placeholder`/`emptyHint` arrive as FUNCTIONS, never as strings — see the
    // comment on `resolverCombo` below: a `t()` evaluated in the options object
    // would run at module-evaluation time, before `initI18n()` has a catalog.
    const ph = typeof opts.placeholder === 'function' ? opts.placeholder() : opts.placeholder;
    input.placeholder = ph
      || (S.models.length ? t('web.combo.search_placeholder') : t('web.combo.type_placeholder'));
  }

  function updateHint() {
    if (!opts.hintId) return;
    const h = $(opts.hintId);
    if (!h) return;
    const md = modelById(get());
    if (!md) {
      // Custom / free-typed id (or no pick yet): no catalog metadata to show.
      h.innerHTML = get()
        ? `<span class="custom">${esc(t('web.combo.custom_model_id'))}</span> · ${esc(t('web.combo.as_is'))}`
        : ((typeof opts.emptyHint === 'function' ? opts.emptyHint() : opts.emptyHint) || '');
      return;
    }
    const price = md.inputPrice != null ? `$${md.inputPrice}/M in · $${md.outputPrice ?? '?'}/M out` : '';
    const head = [md.thinking ? `<span class="thinking">${esc(t('web.combo.thinking'))}</span>` : '', esc(md.description || '')]
      .filter(Boolean).join(' · ');
    const tail = [price, fmtCtx(md.contextLength)].filter(Boolean).join(' · ');
    h.innerHTML = [head, tail].filter(Boolean).join('<br>');
  }

  function updateCap() {
    if (!opts.capId) return;
    const cap = $(opts.capId);
    if (!cap) return;
    const n = S.models.length;
    if (S.provider !== 'openrouter') {
      cap.textContent = n
        ? (n === 1
            ? t('web.combo.available_one', { count: n })
            : t('web.combo.available_other', { count: n }))
        : '';
      return;
    }
    if (S.modelSource === 'openrouter-live') {
      cap.innerHTML = `<span class="live">${esc(t('web.combo.models_count', { count: n }))}</span> · ${esc(t('web.combo.full_catalog'))}`;
    } else {
      cap.textContent = t('web.combo.catalog_offline');
    }
  }

  function render() {
    const list = listEl();
    if (!list) return;
    const matches = matchesFor();
    state.matches = matches;
    if (state.active >= matches.length) state.active = matches.length - 1;
    // With the free-text candidate, a non-empty query always yields at least one
    // row; an empty list means "no catalog and nothing typed yet".
    if (!matches.length) {
      list.innerHTML = S.models.length
        ? '<li class="combo__empty">No matches — type a full model id to use it as-is</li>'
        : '<li class="combo__empty">Type a model id, e.g. deepseek/deepseek-v4-flash</li>';
      return;
    }
    list.innerHTML = matches.map((m, i) => modelOptionHtml(m, i, i === state.active, isSelected(m))).join('');
    const input = inputEl();
    if (state.active >= 0) input.setAttribute('aria-activedescendant', 'opt-' + state.active);
    else input.removeAttribute('aria-activedescendant');
    const act = list.querySelector('.combo__opt.active');
    if (act) act.scrollIntoView({ block: 'nearest' });
  }

  function open() {
    if (!state.open) { state.open = true; inputEl().setAttribute('aria-expanded', 'true'); listEl().hidden = false; }
    render();
  }
  function close() {
    state.open = false; state.active = -1;
    inputEl().setAttribute('aria-expanded', 'false');
    listEl().hidden = true;
  }
  function select(id) {
    // Accept ANY non-empty id — catalog model OR a free-typed custom id — plus
    // the inherit sentinel (resolver only), which clears back to the run model.
    if (id === INHERIT) id = '';
    else if (!id) return;
    set(id);
    state.query = '';
    syncInput();
    close();
    updateHint();
  }

  function refresh() {
    syncInput();
    updateCap();
    if (state.open) render();
    updateHint();
  }

  const input = inputEl();
  const list = listEl();
  if (input && list) {
    input.addEventListener('focus', () => {
      // Clear to an empty filter so the user sees the COMPLETE list and can type
      // to narrow it; the current pick is restored on blur/Escape if untouched.
      state.query = '';
      input.value = '';
      const all = matchesFor();
      state.active = Math.max(0, all.findIndex((m) => isSelected(m)));
      open();
    });
    input.addEventListener('input', () => { state.query = input.value; state.active = -1; open(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!state.open) { open(); return; }
        state.active = Math.min(state.active + 1, state.matches.length - 1);
        render();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        state.active = Math.max(state.active - 1, 0);
        render();
      } else if (e.key === 'Enter') {
        e.preventDefault(); // never submit the run form from the model field
        if (state.open && state.matches.length) {
          const pick = state.active >= 0 ? state.matches[state.active] : state.matches[0];
          if (pick) select(pick.id);
        } else open();
      } else if (e.key === 'Escape') {
        if (state.open) { e.preventDefault(); state.query = ''; syncInput(); close(); }
      }
    });
    // Delay so a click on an option (mousedown below) wins over the blur-close.
    input.addEventListener('blur', () => { setTimeout(() => { state.query = ''; syncInput(); close(); }, 150); });
    // mousedown (not click) fires before the input blur, so the selection sticks.
    list.addEventListener('mousedown', (e) => {
      // .combo__opt rows are <li> elements with dataset.id.
      const li = e.target instanceof Element
        ? /** @type {HTMLElement | null} */ (e.target.closest('.combo__opt'))
        : null;
      if (!li || !li.dataset.id) return;
      e.preventDefault();
      select(li.dataset.id);
    });
  }

  return { refresh, syncInput, updateHint, open, close, select };
}

const mainCombo = makeModelCombo({
  inputId: 'modelInput', listId: 'modelList', hintId: 'modelHint', capId: 'modelCap',
  get: () => S.modelId, set: (v) => { S.modelId = v; },
});

const resolverCombo = makeModelCombo({
  inputId: 'resolverModelInput', listId: 'resolverModelList', hintId: 'resolverModelHint',
  get: () => S.conflictResolverModelId, set: (v) => { S.conflictResolverModelId = v; },
  allowEmpty: true,
  // LAZY, AND THAT IS NOT A STYLE CHOICE. These two used to be `t(...)` called
  // right here, in a module-level object literal — so they ran at IMPORT time,
  // before `boot()` ever awaited `initI18n()`, with the catalog still `{}`. The
  // browser `t()` THROWS on a key it cannot find (deliberately: an untranslated
  // string must never reach a screen), so the throw happened while the module
  // graph was still being evaluated and took the WHOLE page down — every route,
  // on first load, with nothing but a console error. Nothing caught it because
  // no test imported this module. Keep every `t()` in this file inside a
  // function; `editorNavHints()` in PipelineEditor.tsx is the same fix on the
  // Ink side, and `dev.test.js` now imports the real entry so a relapse fails
  // the suite.
  placeholder: () => t('web.config.resolver_placeholder_value'),
  emptyHint: () => t('web.config.resolver_hint'),
});

/* ---------------- Launch: concurrency mode ---------------- */
export function renderModeSeg() {
  // modeSeg's children are the mode <button>s (they carry dataset.mode).
  const btns = /** @type {HTMLElement[]} */ (Array.from($('modeSeg').children));
  for (const btn of btns) btn.classList.toggle('on', btn.dataset.mode === S.mode);
  $('manualRow').hidden = S.mode !== 'manual';
  // concRange is the manual-N <input type="range">.
  const range = /** @type {HTMLInputElement} */ ($('concRange'));
  range.value = String(S.manualN); $('concOut').textContent = String(S.manualN);
}
// modeSeg's children are the mode <button>s (they carry dataset.mode).
for (const btn of /** @type {HTMLElement[]} */ (Array.from($('modeSeg').children))) {
  btn.addEventListener('click', () => { S.mode = btn.dataset.mode; renderModeSeg(); });
}
$('concRange').addEventListener('input', (e) => {
  // Listener attached to the range <input> itself.
  const t = /** @type {HTMLInputElement} */ (e.target);
  S.manualN = +t.value; $('concOut').textContent = String(S.manualN);
});
$('timeoutInput').addEventListener('input', (e) => {
  const t = /** @type {HTMLInputElement} */ (e.target);
  S.timeoutMin = t.value;
});

export function updateRunBtn() {
  // The form now ADDS a project to the queue; a key isn't required to add (it's
  // resolved per project at run time, and the queued item shows a "key needed"
  // marker until then). Enable as soon as a pipeline is selected.
  /** @type {HTMLButtonElement} */ ($('addBtn')).disabled = !S.selectedPipe;
}


/* ---------------- Wizard step 3: configure + fan out to the queue ---------------- */
/** Populate the step-3 panel: pipeline label, marked-projects summary, combos. */
export function renderConfigStep() {
  if (!S.selectedPipe) { goStep(1); return; }
  $('selectedPipe').textContent = S.selectedPipe.name;
  $('selectedPipeDesc').textContent = S.selectedPipe.description || '';
  const dirs = [...S.markedDirs];
  $('cfgProjCount').textContent = dirs.length ? String(dirs.length) : '';
  $('cfgProjects').innerHTML = dirs.length
    ? dirs.map((p) => `<span class="cfg-proj" title="${esc(p)}">${esc(projectName(p))}</span>`).join('')
    : '<span class="muted">No projects marked</span>';
  mainCombo.syncInput();
  resolverCombo.syncInput();
  renderModeSeg();
  syncTimeoutField();
  /** @type {HTMLInputElement} */ ($('timeoutInput')).value = S.timeoutMin || '';
  setAddBtnLabel(addLabel());
  updateRunBtn();
}


/* ---------------- Wizard step 2: mark project folders ----------------
   A multi-select filesystem browser. Ticking a folder adds its ABSOLUTE path to
   S.markedDirs (which persists across navigation); clicking a sub-folder's name
   navigates into it. Each marked folder becomes its own run at fan-out. */
export const folderState = { path: '', parent: null, listing: null };

$('folderUp').addEventListener('click', () => { if (folderState.parent) loadFolder(folderState.parent); });
$('folderUse').addEventListener('click', () => { if (S.markedDirs.size >= 1) goStep(3); });
// Jump to the workspace root (HUU_WORKSPACE, default $HOME) — where projects
// live. A bare /api/folders (no path) resolves to it server-side.
$('folderHome').addEventListener('click', () => loadFolder(S.boot?.workspace || ''));
// Bulk mark: every sub-folder of the CURRENT directory becomes a project in
// one click (the "run this pipeline over ~/Projects/*" case). When all of
// them are already marked the same button unmarks them; marks made in OTHER
// directories are never touched (markAllPlan only returns this listing).
$('folderMarkAll').addEventListener('click', () => {
  const plan = markAllPlan(S.markedDirs, listingEntryPaths());
  if (plan.action === 'mark') for (const p of plan.paths) S.markedDirs.add(p);
  else if (plan.action === 'unmark') for (const p of plan.paths) S.markedDirs.delete(p);
  renderFolderStepUi();
});

/** Absolute paths of the sub-folders in the cached /api/folders listing. */
export function listingEntryPaths() {
  return ((folderState.listing && folderState.listing.entries) || []).map((e) => e.path);
}

/** Enter step 2 → open at the last-visited folder, else the workspace root
    (where the user's projects live), else the server cwd. */
export function renderFolderStep() { loadFolder(folderState.path || S.boot?.workspace || S.runDir || S.cwd); }

export async function loadFolder(path) {
  try {
    const d = await api('/api/folders?path=' + encodeURIComponent(path || ''));
    folderState.path = d.path;
    folderState.parent = d.parent;
    folderState.listing = d;
    $('folderPath').textContent = d.path;
    $('folderPath').title = d.path;
    const git = $('folderGit');
    git.textContent = d.isGitRepo ? '✓ git repo' : '⚠ not a git repo';
    git.className = 'folder-modal__git ' + (d.isGitRepo ? 'ok' : 'no');
    /** @type {HTMLButtonElement} */ ($('folderUp')).disabled = !d.parent;
    renderFolderStepUi();
  } catch (err) { toast(err.message, true); }
}

/** Re-render list + chips + footer from the cached listing (no refetch). */
export function renderFolderStepUi() {
  if (folderState.listing) renderFolderList(folderState.listing);
  renderMarkedChips();
  updateMarkAllBtn();
  updateUseBtn();
}

/** Keep the bulk-mark button honest with the current listing + marks. */
export function updateMarkAllBtn() {
  const btn = $('folderMarkAll');
  if (!btn) return;
  const plan = markAllPlan(S.markedDirs, listingEntryPaths());
  btn.hidden = plan.action === 'none';   // nothing listed → nothing to bulk-mark
  if (plan.action === 'none') return;
  btn.textContent = plan.action === 'unmark'
    ? t('web.folder.unmark_all_n', { count: plan.total })
    : t('web.folder.mark_all_n', { count: plan.total });
  btn.title = plan.action === 'unmark'
    ? t('web.folder.unmark_all_title')
    : t('web.folder.mark_all_title_n', { count: plan.total });
}

export function renderFolderList(d) {
  const list = $('folderList');
  list.innerHTML = '';
  // Row to mark the CURRENT directory itself (its git status is known here; the
  // /api/folders listing only reports isGitRepo for the path being browsed).
  list.appendChild(folderRow(d.path, projectName(d.path) || d.path, { isSelf: true, isGit: d.isGitRepo }));
  if (!d.entries.length) {
    const empty = document.createElement('div');
    empty.className = 'folder-empty';
    empty.textContent = t('web.folder.no_subdirs');
    list.appendChild(empty);
  }
  for (const ent of d.entries) list.appendChild(folderRow(ent.path, ent.name, { isSelf: false }));
}

export function folderRow(path, label, opts) {
  const marked = S.markedDirs.has(path);
  const row = document.createElement('div');
  row.className = 'folder-item' + (opts.isSelf ? ' folder-item--self' : '') + (marked ? ' on' : '');
  // Checkbox — mark/unmark this folder as a project target.
  const box = document.createElement('button');
  box.type = 'button';
  box.className = 'folder-check';
  box.setAttribute('aria-pressed', marked ? 'true' : 'false');
  box.title = marked ? t('web.folder.unmark') : t('web.folder.mark');
  box.textContent = marked ? '✓' : '';
  box.addEventListener('click', (e) => { e.stopPropagation(); toggleMarked(path); });
  row.appendChild(box);
  // Label — navigate INTO sub-folders; for the self row, tick it instead.
  const name = document.createElement('button');
  name.type = 'button';
  name.className = 'folder-item__label';
  const icon = opts.isSelf ? '📍' : '📁';
  const tail = opts.isSelf
    ? `<span class="folder-item__git ${opts.isGit ? 'ok' : 'no'}">${esc(opts.isGit ? t('web.folder.is_git') : t('web.folder.not_git'))}</span>`
    : '<span class="folder-item__go" aria-hidden="true">›</span>';
  name.innerHTML = `<span class="folder-item__icon" aria-hidden="true">${icon}</span>`
    + `<span class="folder-item__name">${esc(label)}${opts.isSelf ? ` <span class="muted">· ${esc(t('web.folder.this_folder'))}</span>` : ''}</span>`
    + tail;
  name.addEventListener('click', () => { if (opts.isSelf) toggleMarked(path); else loadFolder(path); });
  row.appendChild(name);
  return row;
}

export function toggleMarked(path) {
  if (S.markedDirs.has(path)) S.markedDirs.delete(path);
  else S.markedDirs.add(path);
  renderFolderStepUi();
}

export function renderMarkedChips() {
  const wrap = $('markedChips');
  if (!wrap) return;
  const dirs = [...S.markedDirs];
  const cnt = $('markedCount');
  if (cnt) cnt.textContent = dirs.length ? String(dirs.length) : '';
  if (!dirs.length) {
    wrap.innerHTML = '<span class="muted">No folders marked yet — tick the ones you want.</span>';
    return;
  }
  wrap.innerHTML = '';
  for (const p of dirs) {
    const chip = document.createElement('span');
    chip.className = 'marked-chip';
    chip.innerHTML = `<span class="marked-chip__name" title="${esc(p)}">${esc(projectName(p))}</span>`
      + `<button type="button" class="marked-chip__x" aria-label="${esc(t('web.common.remove'))}">×</button>`;
    chip.querySelector('button').addEventListener('click', () => toggleMarked(p));
    wrap.appendChild(chip);
  }
}

export function updateUseBtn() {
  const n = S.markedDirs.size;
  const nEl = $('markedUseN');
  if (nEl) nEl.textContent = String(n);
  const btn = /** @type {HTMLButtonElement | null} */ ($('folderUse'));
  if (btn) btn.disabled = n === 0;
  renderStepper();   // the step-3 chip enables once ≥1 folder is marked
}

/* ---------------- Views ---------------- */
export function showView(which) {
  $('viewLaunch').hidden = which !== 'launch';
  $('viewRun').hidden = which !== 'run';
  $('viewSim').hidden = which !== 'sim';
  $('viewDev').hidden = which !== 'dev';
  $('viewGraph').hidden = which !== 'graph';
  // The mode switch only makes sense while CHOOSING work. On the board (or the
  // synthetic /simulation surface) it would be a way to silently navigate away
  // from a live run, so it hides.
  const sw = $('modeSwitch');
  if (sw) {
    sw.hidden = !(which === 'launch' || which === 'dev' || which === 'graph');
    // The mode-switch options are elements carrying data-mode.
    for (const opt of /** @type {HTMLElement[]} */ (Array.from(sw.querySelectorAll('[data-mode]')))) {
      const on = opt.dataset.mode === which;
      opt.classList.toggle('is-on', on);
      if (on) opt.setAttribute('aria-current', 'page');
      else opt.removeAttribute('aria-current');
    }
  }
}

/* ---------------- Mode switch (Pipelines ⇄ Development) ----------------
   The two surfaces are separate ROUTES (/ and /dev) so they stay bookmarkable
   and the server can serve either shell — but switching between them must not
   reload the page and drop the SSE stream, the run board or a half-built
   queue. So the anchors are intercepted: swap the view in place, pushState the
   URL, and let popstate handle Back. A modified click (ctrl/cmd/middle) falls
   through to the browser so "open in new tab" still works. */
/* Every choosing-surface mode ⇄ its route. The single table both switchMode()
   and popstate read, so adding a surface is one row here. */
export const MODE_PATHS = { launch: '/', dev: '/dev', graph: '/graph' };
export function pathToMode(p) {
  const norm = (p || '').replace(/\/+$/, '') || '/';
  return Object.keys(MODE_PATHS).find((m) => MODE_PATHS[m] === norm) || 'launch';
}

export function switchMode(mode, { push = true } = {}) {
  if (mode === 'dev' && !S.devBooted) initDevSurface();
  // Same lazy contract as the dev surface: the React root (and the vendored
  // React Flow bundle it drives) is only built the first time the human opens
  // the canvas, and `initGraphSurface` is a no-op on every later switch.
  if (mode === 'graph' && !S.graphBooted) initGraphSurface();
  showView(mode);
  if (!push) return;
  const path = MODE_PATHS[mode] || '/';
  if (location.pathname.replace(/\/+$/, '') !== path.replace(/\/+$/, '')) {
    history.pushState({ mode }, '', withTok(path));
  }
}

export function wireModeSwitch() {
  const sw = $('modeSwitch');
  if (!sw) return;
  sw.addEventListener('click', (ev) => {
    if (!(ev.target instanceof Element)) return;
    // Mode-switch options are elements carrying data-mode.
    const opt = /** @type {HTMLElement | null} */ (ev.target.closest('[data-mode]'));
    if (!opt) return;
    // Let the browser own modified clicks — new tab / new window must work.
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button !== 0) return;
    ev.preventDefault();
    switchMode(opt.dataset.mode);
  });
  window.addEventListener('popstate', () => {
    // Never yank the user off a live board via Back — only the choosing
    // surfaces participate in this history.
    if ($('viewRun').hidden === false || $('viewSim').hidden === false) return;
    switchMode(pathToMode(location.pathname), { push: false });
  });
}
$('backToLaunch').addEventListener('click', () => {
  if (S.sim) { showView('sim'); return; }
  // Came from development mode → go BACK to it, not to the pipeline picker.
  // The board is shared by both surfaces, so "back" has to mean the one the
  // user actually came from.
  if (S.devSession?.active) { switchMode('dev'); return; }
  // Leaving the board while the queue is live → pin home so the per-frame
  // auto-switch doesn't drag us back; the runs keep streaming in the background.
  if (S.queue.running) S.homePinned = true;
  showView('launch');
  // Fresh batch back at step 1; any running/queued items stay reachable via the
  // "Queue" step chip (enabled while items exist).
  S.selectedPipe = null;
  S.markedDirs.clear();
  goStep(1);
  renderLaunchRunning();
});
// "View board →" on the launch running-banner: unpin and jump to the board.
$('launchViewBoard').addEventListener('click', () => {
  S.homePinned = false;
  showView('run');
  renderActiveRun();
});


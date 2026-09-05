/* huu web UI — settings panel and OpenRouter key management. */

import { esc, toast } from './utils.js';
import { applyI18n, availableLocales, getLocale, initI18n, saveLocale, t } from '../i18n.js';
import { $, S, api, activeKeySpec, sessionKey, setSessionKey, keyStoreName } from './state.js';
import { parseTimeoutMinutes } from '../queue-util.js';
import { poolNeedsReset, poolRows } from '../key-pool.js';
import { refreshModelsAndKeys } from './launch.js';
import { renderQueue } from './queue.js';


/* ---------------- Web UI settings (browser-local; ⚙ in the topbar) ----------------
   A GLOBAL default that applies to every run started from THIS browser. The CLI
   keeps its own rules. Persisted (no keys) under huu.settings.v1. */
export const SETTINGS_LS = 'huu.settings.v1';
export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_LS);
    if (raw) {
      const o = JSON.parse(raw);
      S.settings.maxAgentMinutes = parseTimeoutMinutes(o.maxAgentMinutes);
      S.settings.ramPercent = parseRamPercent(o.ramPercent);
    }
  } catch { /* corrupt / disabled — keep defaults */ }
}
export function saveSettings() {
  try { localStorage.setItem(SETTINGS_LS, JSON.stringify(S.settings)); }
  catch { /* storage disabled — settings just won't persist */ }
}
/** The global default "max time per agent" (minutes), or undefined = pipeline default. */
export function globalTimeoutMinutes() { return S.settings.maxAgentMinutes; }
/** Parse a RAM-budget percent (10–95 int), or undefined for the 70% default. */
export function parseRamPercent(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.max(10, Math.min(95, n));
}
/** Reflect the global default into the per-project field's placeholder (blank inherits it). */
export function syncTimeoutField() {
  const g = S.settings.maxAgentMinutes;
  const el = /** @type {HTMLInputElement|null} */ ($('timeoutInput')); // per-project timeout field
  if (el) el.placeholder = g ? t('web.settings.timeout_global', { minutes: g }) : t('web.common.default');
}

$('settingsBtn').addEventListener('click', openSettings);
$('settingsClose').addEventListener('click', closeSettings);
$('settingsScrim').addEventListener('click', closeSettings);
export function openSettings() {
  /** @type {HTMLInputElement} */ ($('globalTimeoutInput')).value = S.settings.maxAgentMinutes ? String(S.settings.maxAgentMinutes) : '';
  /** @type {HTMLInputElement} */ ($('globalRamPercentInput')).value = S.settings.ramPercent ? String(S.settings.ramPercent) : '';
  $('settingsScrim').hidden = false;
  $('settingsModal').hidden = false;
  renderLangSelect();
  refreshOrKeyPanel(); // async; the panel shows "Checking…" meanwhile
}
export function closeSettings() { $('settingsScrim').hidden = true; $('settingsModal').hidden = true; }

/* Language picker. Browser-local (localStorage `huu.lang`); the terminal UI
   follows HUU_LANG independently. Switching refetches the catalog and repaints
   every `data-i18n` node — no reload, so a running board is never dropped. */
export function renderLangSelect() {
  const sel = /** @type {HTMLSelectElement|null} */ ($('langSelect'));
  if (!sel) return;
  const cur = getLocale();
  sel.innerHTML = availableLocales()
    .map((l) => `<option value="${esc(l.id)}"${l.id === cur ? ' selected' : ''}>${esc(l.label)}</option>`)
    .join('');
}
if ($('langSelect')) {
  $('langSelect').addEventListener('change', async (e) => {
    const locale = /** @type {HTMLSelectElement} */ (e.target).value; // listener bound to the select itself
    try {
      saveLocale(locale);
      await initI18n(api, locale);
      applyI18n();
      renderLangSelect();
      renderQueue();
      await refreshOrKeyPanel();
      syncTimeoutField();
      toast(t('web.settings.language_changed'));
    } catch (err) { toast(err.message, true); }
  });
}
$('globalTimeoutInput').addEventListener('input', (e) => {
  S.settings.maxAgentMinutes = parseTimeoutMinutes(/** @type {HTMLInputElement} */ (e.target).value); // listener bound to the input itself
  saveSettings();
  syncTimeoutField();   // the per-project placeholder follows the global
  renderQueue();        // queued cards show the effective (override ?? global) timeout
});
$('globalRamPercentInput').addEventListener('input', (e) => {
  S.settings.ramPercent = parseRamPercent(/** @type {HTMLInputElement} */ (e.target).value); // listener bound to the input itself
  saveSettings();       // local cache only — the server is the source of truth
});
// Commit (blur/Enter) → POST to the server, which applies the dial to the
// shared budget IMMEDIATELY (current AND future runs) and persists it across
// restarts. The response echoes the EFFECTIVE value — no more "did 50% take?".
$('globalRamPercentInput').addEventListener('change', async (e) => {
  const input = /** @type {HTMLInputElement} */ (e.target); // listener bound to the RAM% input itself
  const pct = parseRamPercent(input.value);
  try {
    const r = await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ ramPercent: pct ?? null }),
    });
    if (pct) {
      S.settings.ramPercent = r.ramPercent;
      input.value = String(r.ramPercent);
    } else {
      S.settings.ramPercent = undefined; // cleared → server default (placeholder shows it)
    }
    saveSettings();
    toast(t('web.settings.ram_applied', { percent: r.ramPercent }));
  } catch (err) {
    toast(err.message, true);
  }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('settingsModal').hidden) closeSettings(); });

/* ---------------- Provider key in ⚙ Settings (server-persisted) ----------------
   NAMED BY THE ACTIVE PROVIDER, not hard-coded. This panel used to read and
   write the spec `'openrouter'` literally while a run resolved the credential
   of whatever provider was selected — so a key saved here never reached the
   run unless the two happened to coincide. `activeKeySpec(S)` comes from
   /api/providers → keySpecs, the same projection the launch form gates on.
   Unlike the launch-form key rows (session-only, gone with the tab), this panel
   SAVES: the key is validated against OpenRouter and, only if not rejected,
   persisted server-side (config store — host-mounted under Docker so it survives
   the container) AND mirrored into this tab's sessionStorage. Every new run then
   uses it; the server also logs each step to the huu terminal. */
/** The spec this panel is currently operating on. Never a literal. */
function panelSpec() {
  return activeKeySpec(S) || { name: 'deepseek', label: 'DeepSeek' };
}

export const OR_SOURCE_KEY = {
  options: 'web.keysrc.options',
  stored: 'web.keysrc.stored',
  'secret-mount': 'web.keysrc.secret_mount',
  'env-file': 'web.keysrc.env_file',
  env: 'web.keysrc.env',
};
/* The POOL list under the status line. The server owns the rotation state
   (which key is current, what is burned, what is cooling) and never returns a
   key's value — the row is built entirely from `masked` + `state`. A server
   without the endpoint leaves the list hidden, so the panel degrades to exactly
   the single masked line it was before. */
export async function refreshOrKeyPool() {
  const host = $('orKeyPool');
  if (!host) return;
  let pool = null;
  const spec = panelSpec();
  try { pool = await api('/api/keys/pool?name=' + encodeURIComponent(spec.name)); } catch { pool = null; }
  const rows = poolRows(pool);
  if (!rows.length) { host.hidden = true; host.innerHTML = ''; return; }
  host.hidden = false;
  const list = rows.map((r) =>
    `<div class="keypool__row${r.isCurrent ? ' is-current' : ''}">` +
    `<code class="keypool__masked">${esc(r.masked)}</code>` +
    `<span class="keychip keychip--${r.chip.cls}">${esc(r.chip.text)}</span>` +
    (r.isCurrent ? `<span class="keypool__cur">${esc(t('web.settings.in_use'))}</span>` : '') +
    `<button type="button" class="keypool__del" data-del-index="${r.index}" ` +
    `title="${esc(t('web.settings.remove_key'))}" aria-label="${esc(t('web.settings.remove_key'))}">✕</button></div>`,
  ).join('');
  const foot = `<div class="key-hint">${esc(
      rows.length === 1
        ? t('web.settings.pool_count_one', { count: rows.length })
        : t('web.settings.pool_count_other', { count: rows.length }),
    )}` +
    (poolNeedsReset(pool)
      ? ` <button type="button" class="linkbtn" id="orKeyPoolReset">${esc(t('web.settings.pool_reset'))}</button>`
      : '') +
    '</div>';
  host.innerHTML = list + foot;
}

export async function refreshOrKeyPanel() {
  const el = $('orKeyStatus');
  if (!el) return;
  void refreshOrKeyPool();
  const spec = panelSpec();
  // The panel header, hint placeholder and every endpoint below follow the
  // ACTIVE provider's spec — the whole point of this fix.
  const labelEl = document.querySelector('label[for="orKeyInput"]');
  if (labelEl) labelEl.textContent = t('web.settings.keys') + ' · ' + spec.label;
  const inputEl = /** @type {HTMLInputElement|null} */ ($('orKeyInput'));
  if (inputEl && spec.hint) inputEl.placeholder = spec.hint;
  try {
    const s = await api('/api/keys/status?name=' + encodeURIComponent(spec.name));
    const bits = [];
    if (!s.masked || s.source === 'none') {
      bits.push(`<span class="key-status__need">${esc(t('web.settings.no_key', { label: spec.label }))}</span>`);
    } else {
      const srcKey = OR_SOURCE_KEY[s.source];
      const label = srcKey ? t(srcKey) : s.source;
      bits.push(
        `<span class="key-status__ok">${esc(t('web.settings.active_key', { masked: s.masked, source: label }))}</span>`,
      );
      if (s.source === 'options' || s.source === 'stored') {
        bits.push(`<button type="button" class="linkbtn" id="orKeyClear">${esc(t('web.settings.clear_saved'))}</button>`);
      }
      if (s.envPresent && s.source !== 'env') {
        bits.push(`<div class="key-hint">${esc(t('web.settings.env_ignored', { envVar: s.envVar }))}</div>`);
      }
    }
    if (sessionKey(spec.name)) {
      bits.push(`<div class="key-hint">${esc(t('web.settings.session_key'))}</div>`);
    }
    el.innerHTML = bits.join(' ');
  } catch (e) {
    el.innerHTML = `<span class="key-status__need">${esc(t('web.settings.status_unavailable', { message: e.message }))}</span>`;
  }
}
// Null-safe wiring: if a stale cached index.html (without the panel) pairs
// with this app.js, a bare addEventListener on a missing node would throw at
// module load and kill the WHOLE app — degrade to "panel absent" instead.
export const orKeySaveBtn = $('orKeySave');
if (orKeySaveBtn) orKeySaveBtn.addEventListener('click', async () => {
  const input = /** @type {HTMLInputElement} */ ($('orKeyInput'));
  const value = (input.value || '').trim();
  const spec = panelSpec();
  if (!value) { toast(t('web.settings.paste_first', { label: spec.label }), true); input.focus(); return; }
  const btn = /** @type {HTMLButtonElement} */ ($('orKeySave'));
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = t('web.settings.validating');
  try {
    const r = await api('/api/keys/validate', {
      method: 'POST',
      body: JSON.stringify({ name: spec.name, value }),
    });
    if (r.status === 'invalid') {
      // The exact 401 class that motivated this panel: never save a key the
      // provider actively rejected.
      toast(t('web.settings.key_rejected', { label: spec.label, status: r.httpStatus }), true);
      return;
    }
    if (r.status === 'wrong-key') {
      // The value is ANOTHER provider's credential (an `sk-or-…` pasted into
      // the DeepSeek panel). Refused, never persisted — saving it would file
      // it under this spec's name and spend it against this spec's host.
      toast(t('web.settings.key_wrong_provider', { label: r.label, expected: spec.label }), true);
      return;
    }
    // Same validate-then-save flow as before, one step longer: append to the
    // POOL when the server has one (it mirrors keys[0] back into the flat
    // field, so nothing regresses), else fall back to the single-key write.
    try {
      await api('/api/keys/pool', { method: 'POST', body: JSON.stringify({ name: spec.name, value }) });
    } catch {
      await api('/api/keys', { method: 'POST', body: JSON.stringify({ name: spec.name, value }) });
    }
    // UNCHANGED sessionStorage semantics: this tab keeps sending the key it
    // just accepted with every run it launches, and that pick still wins over
    // the pool.
    setSessionKey(spec.name, value);
    input.value = '';
    toast(r.status === 'valid'
      ? t('web.settings.key_saved')
      : t('web.settings.key_unverified', { label: spec.label, reason: r.reason }));
    await refreshOrKeyPanel();
    await refreshModelsAndKeys();
  } catch (err) { toast(err.message, true); }
  finally { btn.disabled = false; btn.textContent = label; }
});
// Pool row actions (remove / reset) — delegated from the STABLE container,
// because the rows are rebuilt on every refresh.
export const orKeyPoolEl = $('orKeyPool');
if (orKeyPoolEl) orKeyPoolEl.addEventListener('click', async (e) => {
  const el = /** @type {HTMLElement} */ (e.target); // delegated rows/buttons inside the pool container
  if (!el || !el.getAttribute) return;
  if (el.id === 'orKeyPoolReset') {
    try {
      await api('/api/keys/pool/reset', { method: 'POST', body: JSON.stringify({ name: panelSpec().name }) });
      toast(t('web.settings.pool_reset_done'));
      await refreshOrKeyPanel();
    } catch (err) { toast(err.message, true); }
    return;
  }
  const index = el.getAttribute('data-del-index');
  if (index === null) return;
  try {
    await api(`/api/keys/pool?name=${encodeURIComponent(panelSpec().name)}&index=${encodeURIComponent(index)}`, { method: 'DELETE' });
    toast(t('web.settings.key_removed'));
    await refreshOrKeyPanel();
    await refreshModelsAndKeys();
  } catch (err) { toast(err.message, true); }
});
// The clear button is re-rendered with the status line — delegate from the
// stable container (same pattern as the drawer Retry block).
export const orKeyStatusEl = $('orKeyStatus');
if (orKeyStatusEl) orKeyStatusEl.addEventListener('click', async (e) => {
  const el = /** @type {HTMLElement} */ (e.target); // delegated: the re-rendered clear button
  if (!el || el.id !== 'orKeyClear') return;
  try {
    const spec = panelSpec();
    const r = await api('/api/keys?name=' + encodeURIComponent(spec.name), { method: 'DELETE' });
    try { sessionStorage.removeItem(keyStoreName(spec.name)); } catch {}
    toast(r.note ? t('web.settings.key_cleared_note', { note: r.note }) : t('web.settings.key_cleared'));
    await refreshOrKeyPanel();
    await refreshModelsAndKeys();
  } catch (err) { toast(err.message, true); }
});


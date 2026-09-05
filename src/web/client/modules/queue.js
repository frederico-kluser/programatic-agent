/* huu web UI — queue, runner, history, run-view chrome. */

import { saveRun, listRuns, deleteRun, clearRuns, buildRunRecord, buildSyntheticRecord, exportRunsJson, downloadText, uid } from '../db.js';
import { parseTimeoutMinutes, relinkQueue, settleQueue, summarizeQueue, groupQueueItems, queueGroupKey, fanOutBatch } from '../queue-util.js';
import { esc, toast, shortDir, projectName, fmtDur, fmtNum, humanize } from './utils.js';
import { $, S, api, pipeIcon, providerInfoById, providerReady, sessionKey, providerKeySpecName, globalTimeoutMinutes } from './state.js';
import { renderStepper, goStep, showView } from './launch.js';
import { t } from '../i18n.js';

const QUEUE_LS = 'huu.queue.v1';
let historyCache = [];

export function itemReady(it) { return providerReady(S, providerInfoById(S, it.provider)); }
export function statusBadge(s) {
  if (s === 'queued') return `<span class="queue-status queued">${esc(t('web.qstatus.queued'))}</span>`;
  if (s === 'running') return `<span class="queue-status running">${esc(t('web.qstatus.running'))}</span>`;
  if (s === 'done') return `<span class="queue-status done">${esc(t('web.qstatus.done'))}</span>`;
  if (s === 'error') return `<span class="queue-status error">${esc(t('web.qstatus.failed'))}</span>`;
  return '';
}
export function setAddBtnLabel(label) { const el = $('addBtnLabel'); if (el) el.textContent = label; }
export function addLabel() { return S.queue.running ? t('web.queue.add_start') : t('web.config.add_to_queue'); }
export function queueCtx(item) { return { ...item, queue: { id: S.queue.id, index: S.queue.items.indexOf(item), size: S.queue.items.length } }; }

/** Snapshot the current form into a queue item. */
export function captureFormConfig() {
  if (!S.selectedPipe) return null;
  const md = S.models.find((x) => x.id === S.modelId);
  const prov = providerInfoById(S, S.provider);
  return {
    id: uid(),
    pipelineName: S.selectedPipe.name,
    pipelineDesc: S.selectedPipe.description || '',
    provider: S.provider,
    backend: S.backend,
    modelId: S.modelId,
    modelLabel: md ? md.label : (S.modelId || t('web.queue.default_model')),
    conflictResolverModelId: S.conflictResolverModelId,
    providerLabel: prov ? prov.label : S.provider,
    mode: S.mode,
    concurrency: S.mode === 'manual' ? S.manualN : undefined,
    timeoutMinutes: parseTimeoutMinutes(S.timeoutMin),
    runDirectory: S.runDir || S.cwd,
    status: 'pending',
  };
}

/** Fan the current form config out over the marked project folders. */
export function buildBatchItems() {
  const base = captureFormConfig();
  if (!base) return [];
  const dirs = [...S.markedDirs];
  if (!dirs.length) return [];
  return fanOutBatch(base, dirs, uid(), uid);
}

/** Commit the current (pipeline + projects + config) batch into the queue. */
export function commitBatch() {
  const items = buildBatchItems();
  if (!items.length) { toast(t('web.queue.err_pick_first'), true); return; }
  const re = document.getElementById('runError'); if (re) re.hidden = true;
  const startIdx = S.queue.items.length;
  S.queue.items.push(...items);
  if (S.queue.running) {
    for (let k = 0; k < items.length; k++) dispatchQueueItem(startIdx + k);
    toast(t('web.queue.added_starting', { count: items.length }));
  } else {
    toast(
      items.length === 1
        ? t('web.queue.added_one', { count: items.length })
        : t('web.queue.added_other', { count: items.length }),
    );
  }
  persistQueue();
  S.selectedPipe = null;
  S.markedDirs.clear();
  renderLaunchRunning();
  goStep(4);
}

/* ---------------- Queue rendering ---------------- */
export function renderQueue() {
  const q = S.queue;
  const empty = q.items.length === 0;
  const qc = document.getElementById('queueCount'); if (qc) qc.textContent = empty ? '' : String(q.items.length);
  const emptyEl = document.getElementById('queueEmpty'); if (emptyEl) emptyEl.hidden = !empty;
  const list = document.getElementById('queueList');
  if (!list) return;
  list.innerHTML = '';
  for (const g of groupQueueItems(q.items)) {
    const head = document.createElement('div');
    head.className = 'queue-group__head';
    head.innerHTML = `<span class="ico" aria-hidden="true">${pipeIcon(g.pipelineName)}</span>`
      + `<span class="queue-group__name">${esc(g.pipelineName)}</span>`
      + `<span class="queue-group__count">${esc(
          g.items.length === 1
            ? t('web.queue.project_count_one', { count: g.items.length })
            : t('web.queue.project_count_other', { count: g.items.length }),
        )}</span>`
      + `<button class="qbtn qbtn--danger" data-act="remove-group" data-group="${esc(g.groupId)}" title="${esc(t('web.queue.remove_pipeline'))}" ${q.running ? 'disabled' : ''}>✕</button>`;
    list.appendChild(head);
    for (const it of g.items) list.appendChild(queueItemRow(it, q.items.indexOf(it)));
  }
  const qr = /** @type {HTMLButtonElement|null} */ (document.getElementById('queueRun')); if (qr) qr.disabled = q.running || empty;
  const qrl = document.getElementById('queueRunLabel'); if (qrl) qrl.textContent = q.running ? t('web.queue.running_label') : (empty ? t('web.queue.run') : t('web.queue.run_n', { count: q.items.length }));
  const qcl = /** @type {HTMLButtonElement|null} */ (document.getElementById('queueClear')); if (qcl) qcl.disabled = q.running || empty;
  setAddBtnLabel(addLabel());
  renderStepper();
}

/** One project row inside a pipeline group. */
export function queueItemRow(it, i) {
  const q = S.queue;
  const ready = itemReady(it);
  const mins = it.timeoutMinutes || globalTimeoutMinutes(S);
  const el = document.createElement('div');
  el.className = 'queue-item ' + (it.status || 'pending');
  el.innerHTML = `
    <div class="queue-item__idx">${i + 1}</div>
    <div class="queue-item__main">
      <div class="queue-item__name"><span class="txt">${esc(projectName(it.runDirectory))}</span></div>
      <div class="queue-item__meta">${esc(shortDir(it.runDirectory))}<span class="sep">·</span>${esc(it.modelLabel || t('web.common.default'))}<span class="sep">·</span>${esc(it.providerLabel || it.provider)}${mins ? '<span class="sep">·</span>⏱ ' + mins + 'm' : ''}${ready ? '' : `<span class="sep">·</span><span class="warn">${esc(t('web.queue.key_needed'))}</span>`}</div>
    </div>
    <div class="queue-item__actions">
      ${statusBadge(it.status)}
      <button class="qbtn qbtn--danger" data-act="remove" data-id="${it.id}" title="${esc(t('web.common.remove'))}" ${q.running ? 'disabled' : ''}>✕</button>
    </div>`;
  return el;
}

export function removeQueueItem(id) {
  if (S.queue.running) return;
  S.queue.items = S.queue.items.filter((x) => x.id !== id);
  persistQueue();
  afterQueueEdit();
}
export function removeQueueGroup(groupId) {
  if (S.queue.running) return;
  S.queue.items = S.queue.items.filter((x) => queueGroupKey(x) !== groupId);
  persistQueue();
  afterQueueEdit();
}
export function afterQueueEdit() {
  renderQueue();
  if (!S.queue.items.length && S.wizard.step === 4) goStep(1);
}

/* ---------------- Queue persistence (localStorage; no keys) ---------------- */
export function persistQueue() {
  try {
    const envelope = { schema: 'huu-queue-v2', queueId: S.queue.id, items: S.queue.items };
    localStorage.setItem(QUEUE_LS, JSON.stringify(envelope));
  } catch { /* storage full / disabled */ }
}

export function restoreQueue() {
  try {
    const raw = localStorage.getItem(QUEUE_LS);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      S.queue.items = parsed.map((it) => ({ ...it, status: 'pending', runId: null }));
      return;
    }
    if (!parsed || parsed.schema !== 'huu-queue-v2' || !Array.isArray(parsed.items)) return;
    resumeQueueTracking(parsed);
  } catch { /* corrupt — start empty */ }
}

function resumeQueueTracking(parsed) {
  const q = S.queue;
  const link = relinkQueue(parsed.items, [...S.runs.values()]);
  q.items = link.items;
  if (parsed.queueId) q.id = parsed.queueId;
  q.processed = new Set(link.processed);
  if (link.running) {
    q.running = true;
    q.stopping = false;
    q.live = new Map(link.live.map(([runId, i]) => [runId, q.items[i]]));
    q.settled = link.settledCount;
  }
  persistQueue();
  renderQueue();
  updateQueueChrome();
  const finishRestore = async () => {
    for (const i of link.rearchive) {
      const it = q.items[i];
      const run = it && it.runId ? S.runs.get(it.runId) : null;
      if (run) await archiveRun(run, it);
    }
    for (const i of link.orphaned) {
      await archiveSynthetic(q.items[i], 'run lost across refresh (huu server restarted?)');
    }
    if (link.rearchive.length || link.orphaned.length) refreshHistoryBadge();
    if (q.running) {
      for (const i of link.resume) await dispatchQueueItem(i);
      updateQueueChrome();
      maybeFinishQueue();
    } else if (link.settledCount > 0) {
      q.items = settleQueue(q.items).keep;
      persistQueue();
      renderQueue();
    }
  };
  void finishRestore();
}

/* ---------------- Sequential runner ---------------- */
export async function startQueue() {
  const q = S.queue;
  if (q.running || !q.items.length) return;
  for (const it of q.items) { it.status = 'pending'; it.runId = null; }
  q.running = true;
  q.live = new Map();
  q.settled = 0;
  q.processed = new Set();
  q.stopping = false;
  q.id = uid();
  S.homePinned = false;
  persistQueue();
  renderQueue();
  showView('run');
  updateQueueChrome();
  const n = q.items.length;
  for (let i = 0; i < n; i++) await dispatchQueueItem(i);
}

export function dispatchQueueItem(i) {
  const q = S.queue;
  const item = q.items[i];
  if (!item) return;
  item.status = 'queued';
  persistQueue();
  renderQueue();
  return postRun(i);
}

async function postRun(i) {
  const q = S.queue;
  const item = q.items[i];
  // Keyed on the QUEUED ITEM's provider: two rows in the same queue may target
  // different providers, and the backend they share names neither credential.
  const apiKey = sessionKey(providerKeySpecName(S, item.provider));
  const endpoint = sessionKey('azureEndpoint');
  try {
    const r = await api('/api/run', {
      method: 'POST',
      body: JSON.stringify({
        pipelineName: item.pipelineName,
        provider: item.provider,
        modelId: item.modelId,
        conflictResolverModelId: item.conflictResolverModelId || undefined,
        mode: item.mode,
        concurrency: item.mode === 'manual' ? item.concurrency : undefined,
        timeoutMinutes: item.timeoutMinutes || globalTimeoutMinutes(S) || undefined,
        apiKey: apiKey || undefined,
        endpoint: endpoint || undefined,
        runDirectory: item.runDirectory || undefined,
        priority: i,
      }),
    });
    const runId = r && r.run && r.run.runId;
    if (runId) { item.runId = runId; q.live.set(runId, item); persistQueue(); }
    renderQueue();
  } catch (err) {
    item.status = 'error';
    persistQueue();
    toast(`${projectName(item.runDirectory) || t('web.queue.run_word')}: ${err.message}`, true);
    await archiveSynthetic(item, err.message);
    q.settled++;
    renderQueue();
    refreshHistoryBadge();
    maybeFinishQueue();
  }
}

export function onRunFrame(run) {
  const q = S.queue;
  if (!q.running || !run.runId) return;
  if (q.processed.has(run.runId)) return;
  const item = q.live && q.live.get(run.runId);
  if (!item) return;
  if (run.phase === 'queued' || run.phase === 'running') {
    if (item.status !== run.phase) {
      item.status = run.phase;
      persistQueue();
      renderQueue();
    }
    return;
  }
  if (run.phase !== 'done' && run.phase !== 'error') return;
  q.processed.add(run.runId);
  q.live.delete(run.runId);
  item.status = run.phase === 'done' ? 'done' : 'error';
  persistQueue();
  if (run.phase === 'error') {
    toast(t('web.queue.run_failed', {
      name: projectName(run.runDirectory) || t('web.queue.run_word'),
      reason: run.errorReason || t('web.queue.see_board'),
    }), true);
  }
  archiveRun(run, item);
  q.settled++;
  renderQueue();
  refreshHistoryBadge();
  maybeFinishQueue();
}

async function archiveRun(run, item) {
  try { await saveRun(buildRunRecord({ run, item: queueCtx(item), archivedAt: Date.now() })); }
  catch (e) { console.warn('huu: failed to archive run', e); }
}
async function archiveSynthetic(item, reason) {
  try { await saveRun(buildSyntheticRecord({ item: queueCtx(item), errorReason: reason, archivedAt: Date.now() })); }
  catch (e) { console.warn('huu: failed to archive synthetic run', e); }
}

function maybeFinishQueue() {
  const q = S.queue;
  if (q.stopping) { if (!q.live || q.live.size === 0) stopFinalize(); return; }
  if (q.settled >= q.items.length) finishQueue();
}

function finishQueue() {
  const q = S.queue;
  q.running = false;
  q.live = null;
  S.homePinned = false;
  const { keep, error } = settleQueue(q.items);
  q.items = keep;
  setAddBtnLabel(t('web.config.add_to_queue'));
  persistQueue();
  renderQueue();
  updateQueueChrome();
  toast(error ? t('web.queue.finished_errors', { count: error }) : t('web.queue.finished_ok'));
}

function stopFinalize() {
  const q = S.queue;
  q.running = false;
  q.stopping = false;
  q.live = null;
  S.homePinned = false;
  q.items = settleQueue(q.items).keep;
  persistQueue();
  renderQueue();
  updateQueueChrome();
  toast(t('web.queue.stopped'));
}

/* ---------------- Run-view chrome for the queue ---------------- */
export function updateQueueChrome() {
  let active = false;
  for (const r of S.runs.values()) if (r.phase === 'running' || r.phase === 'queued') { active = true; break; }
  const inQueue = S.queue.running;
  const ab = document.getElementById('abortBtn'); if (ab) ab.hidden = !active || inQueue;
  const sq = document.getElementById('stopQueueBtn'); if (sq) sq.hidden = !inQueue || !active;
  const btl = document.getElementById('backToLaunch');
  if (btl) {
    if (inQueue && active) { btl.hidden = false; btl.textContent = '← Home'; }
    else { btl.textContent = '← New run'; }
  }
  renderQueueProgress();
  renderLaunchRunning();
}

export function renderLaunchRunning() {
  const el = document.getElementById('launchRunning');
  if (!el) return;
  if (!S.queue.running) { el.hidden = true; return; }
  el.hidden = false;
  const { total, running, settled } = summarizeQueue(S.queue.items);
  const lrt = document.getElementById('launchRunningText');
  if (lrt) lrt.innerHTML = `<b>${running}</b> running · ${settled}/${total} done · <span class="muted">new projects start automatically</span>`;
}

function renderQueueProgress() {
  const q = S.queue;
  const el = document.getElementById('queueProgress');
  if (!el) return;
  if (!q.running) { el.hidden = true; return; }
  el.hidden = false;
  const done = q.items.filter((it) => it.status === 'done' || it.status === 'error').length;
  const dots = q.items.map((it) => `<span class="qp-dot ${it.status || 'pending'}"></span>`).join('');
  el.innerHTML = `<span>${done}/${q.items.length} done · running concurrently</span><span class="qp-bar">${dots}</span>`;
}

/* ---------------- History ---------------- */

export async function openHistory() {
  const hs = document.getElementById('historyScrim'); if (hs) hs.hidden = false;
  const hm = document.getElementById('historyModal'); if (hm) hm.hidden = false;
  await renderHistory();
}
export function closeHistory() {
  const hs = document.getElementById('historyScrim'); if (hs) hs.hidden = true;
  const hm = document.getElementById('historyModal'); if (hm) hm.hidden = true;
}

async function renderHistory() {
  const list = document.getElementById('historyList');
  if (!list) return;
  list.innerHTML = `<div class="history-empty">${esc(t('web.common.loading'))}</div>`;
  let runs = [];
  try { runs = await listRuns(); }
  catch (e) { list.innerHTML = `<div class="history-empty">${esc(t('web.history.unavailable', { message: e.message }))}</div>`; return; }
  historyCache = runs;
  const total = runs.reduce((s, r) => s + (r.totalCost || 0), 0);
  const hm = document.getElementById('historyMeta');
  if (hm) hm.textContent = runs.length
    ? (runs.length === 1
        ? t('web.history.meta_one', { count: runs.length, total: total.toFixed(2) })
        : t('web.history.meta_other', { count: runs.length, total: total.toFixed(2) }))
    : t('web.history.none');
  const he = /** @type {HTMLButtonElement|null} */ (document.getElementById('historyExport')); if (he) he.disabled = runs.length === 0;
  const hc = /** @type {HTMLButtonElement|null} */ (document.getElementById('historyClear')); if (hc) hc.disabled = runs.length === 0;
  if (!runs.length) { list.innerHTML = `<div class="history-empty">${esc(t('web.history.empty'))}</div>`; return; }
  list.innerHTML = '';
  for (const r of runs) list.appendChild(historyRow(r));
}

function historyRow(r) {
  const wrap = document.createElement('div');
  wrap.className = 'history-row';
  const when = r.archivedAt ? new Date(r.archivedAt).toLocaleString() : '';
  const cards = r.counts ? r.counts.total : (r.cards || []).length;
  const sub = [shortDir(r.runDirectory), r.modelLabel || r.modelId, r.provider, when].filter(Boolean).map(esc).join(' · ');
  wrap.innerHTML = `
    <button type="button" class="history-row__head">
      <span class="history-row__icon">${pipeIcon(r.pipelineName)}</span>
      <span class="history-row__main">
        <span class="history-row__name">${esc(r.pipelineName)}</span>
        <span class="history-row__sub">${sub} · ${esc(t('web.history.cards', { count: cards }))}</span>
      </span>
      <span class="history-row__status ${r.status}">${esc(r.status === 'done' ? t('web.qstatus.done') : t('web.qstatus.failed'))}</span>
      <span class="history-row__cost">$${(r.totalCost || 0).toFixed(3)}<small>${fmtDur(r.elapsedMs || 0)}</small></span>
      <svg class="history-row__chev" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M7 10l5 5 5-5z" fill="currentColor"/></svg>
    </button>
    <div class="history-cards">${historyCardsHtml(r)}</div>`;
  wrap.querySelector('.history-row__head').addEventListener('click', () => wrap.classList.toggle('open'));
  return wrap;
}

function historyCardsHtml(r) {
  const errLine = r.errorReason ? `<div class="history-err">⚠ ${esc(r.errorReason)}</div>` : '';
  const rows = (r.cards || []).map((c) => {
    const cost = c.cost == null ? '—' : '$' + Number(c.cost).toFixed(4);
    const tok = c.kind === 'agent' ? fmtNum((c.tokensIn || 0) + (c.tokensOut || 0)) : '—';
    return `<tr>
      <td><span class="hc-kind ${c.kind}">${c.kind}</span></td>
      <td class="ttl">${esc(c.title)}${c.error ? ' <span style="color:var(--red)">⚠</span>' : ''}</td>
      <td>${esc(humanize(c.phase || ''))}${c.mergeFailed ? ` <span style="color:var(--yellow)">(${esc(t('web.history.unmerged'))})</span>` : ''}</td>
      <td class="num">${tok}</td>
      <td class="num">${cost}</td>
    </tr>`;
  }).join('');
  const table = (r.cards && r.cards.length)
    ? `<table class="hc-table"><thead><tr><th>${esc(t('web.history.col_kind'))}</th><th>${esc(t('web.history.col_card'))}</th><th>${esc(t('web.history.col_phase'))}</th><th class="num">${esc(t('web.history.col_tokens'))}</th><th class="num">${esc(t('web.history.col_cost'))}</th></tr></thead><tbody>${rows}</tbody></table>`
    : `<div class="history-empty" style="padding:16px 0">${esc(t('web.history.no_cards'))}</div>`;
  const foot = `<div class="queue-foot" style="margin-top:12px">
      <span class="muted" style="font-size:12px">${esc(t('web.history.total_prefix'))} <b style="color:var(--text)">$${(r.totalCost || 0).toFixed(4)}</b> · ${esc(t('web.history.card_sum', { sum: (r.cardCostSum || 0).toFixed(4) }))}</span>
      <button class="btn btn--ghost btn--sm history-del" data-del="${r.id}" style="margin-left:auto">${esc(t('web.common.delete'))}</button>
    </div>`;
  return errLine + table + foot;
}

export async function refreshHistoryBadge() {
  let n = 0;
  try { n = (await listRuns()).length; } catch { /* unavailable */ }
  const b = document.getElementById('historyBadge');
  if (!b) return;
  if (n > 0) { b.textContent = n > 99 ? '99+' : String(n); b.hidden = false; }
  else b.hidden = true;
}

/* ---------------- Wiring ---------------- */
export function wireQueue() {
  document.getElementById('queueList')?.addEventListener('click', (e) => {
    const btn = /** @type {Element} */ (e.target).closest('button[data-act]'); // click target is an Element
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    if (act === 'remove') removeQueueItem(btn.getAttribute('data-id'));
    else if (act === 'remove-group') removeQueueGroup(btn.getAttribute('data-group'));
  });
  document.getElementById('queueClear')?.addEventListener('click', () => {
    if (S.queue.running) return;
    S.queue.items = [];
    persistQueue();
    afterQueueEdit();
  });
  document.getElementById('queueRun')?.addEventListener('click', startQueue);
  document.getElementById('stopQueueBtn')?.addEventListener('click', () => {
    const q = S.queue;
    if (!q.running) return;
    q.stopping = true;
    toast(t('web.queue.stopping'));
    api('/api/run/abort', { method: 'POST' }).catch(() => {});
    if (!q.live || q.live.size === 0) stopFinalize();
  });
  document.getElementById('historyBtn')?.addEventListener('click', openHistory);
  document.getElementById('historyClose')?.addEventListener('click', closeHistory);
  document.getElementById('historyScrim')?.addEventListener('click', closeHistory);
  document.getElementById('historyList')?.addEventListener('click', async (e) => {
    const del = /** @type {Element} */ (e.target).closest('button[data-del]'); // click target is an Element
    if (!del) return;
    e.stopPropagation();
    try { await deleteRun(del.getAttribute('data-del')); } catch { /* ignore */ }
    await renderHistory();
    refreshHistoryBadge();
  });
  document.getElementById('historyExport')?.addEventListener('click', async () => {
    let runs = historyCache;
    try { if (!runs || !runs.length) runs = await listRuns(); } catch { /* ignore */ }
    if (!runs || !runs.length) { toast(t('web.history.nothing_export'), true); return; }
    const { filename, text } = exportRunsJson(runs, Date.now());
    downloadText(filename, text);
    toast(runs.length === 1
      ? t('web.history.exported_one', { count: runs.length })
      : t('web.history.exported_other', { count: runs.length }));
  });
  document.getElementById('historyClear')?.addEventListener('click', async () => {
    if (!confirm(t('web.history.confirm_clear'))) return;
    try { await clearRuns(); } catch { /* ignore */ }
    await renderHistory();
    refreshHistoryBadge();
  });
}

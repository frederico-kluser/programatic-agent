/* huu web UI — board: simulation, SSE, run ingest, project selector, budget, concurrency, board reconciler, drawer, retry, run log. */

import { createBoardOrder } from '../board-order.js';
import { agentCardState as cardStateOf } from '../card-state.js';
import { pickActiveRun } from '../run-select.js';
import { createSseHealth, sseAction } from '../sse-liveness.js';
import { substituteFileInTitle } from '../title-util.js';
import { esc, cap, humanize, fmtNum, fmtCost, fmtDur, toast, shortDir, projectName } from './utils.js';
import { $, S, api, withTok, TOKEN, pipeIcon, sessionKey, backendSpecName } from './state.js';
import { showView, switchMode } from './launch.js';
import { onRunFrame, updateQueueChrome, renderLaunchRunning } from './queue.js';
import { renderDevSession, ingestDevAgentStream, onDevRunFrame } from './dev.js';
import { hasMessage, t } from '../i18n.js';

/* Card phase CODES come from client/card-state.js, which is a locale-blind
   mirror of src/lib/card-state.ts (both pinned by tests). Translate them HERE,
   at the render boundary; anything the catalog doesn't know (a humanized raw
   phase) renders verbatim, exactly as before. */
function phaseLabel(plabel) {
  const key = 'web.phase.' + String(plabel).toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return hasMessage(key) ? t(key) : String(plabel);
}

/* ---------------- Simulation mode (/simulation) ----------------
   A fully synthetic run: no branches, no API key, no LLM. The kanban, logs and
   agents are fabricated server-side by the SimulationEngine and streamed over
   the SAME SSE channel as a real run, so the run view renders unchanged. */
export function bootSimulation(b) {
  S.sim = true;
  document.title = 'huu · simulation';
  $('backToLaunch').textContent = '← New simulation';
  /** @type {HTMLInputElement} */ ($('simFiles')).value = String(S.simFiles); $('simFilesOut').textContent = String(S.simFiles);
  /** @type {HTMLInputElement} */ ($('simAgents')).value = String(S.simAgents); $('simAgentsOut').textContent = String(S.simAgents);
  setPauseLabel();
  renderSimModels();
  fetchSimSuggestions();
  for (const r of b.runs || []) ingestRun(r);
  if (!(b.runs || []).length) showView('sim');
  connectSse();
}

export function setPauseLabel() { const el = $('pauseBtn'); if (el) el.textContent = S.simPaused ? t('web.top.resume') : t('web.top.pause'); }

export function addSimModel(id) {
  id = (id || '').trim();
  if (!id) return;
  if (!S.simModels.includes(id)) S.simModels.push(id);
  /** @type {HTMLInputElement} */ ($('simModelInput')).value = '';
  renderSimModels();
}
export function removeSimModel(id) { S.simModels = S.simModels.filter((x) => x !== id); renderSimModels(); }

export function renderSimModels() {
  const chips = $('simModelChips'); if (!chips) return;
  chips.innerHTML = '';
  for (const id of S.simModels) {
    const el = document.createElement('span'); el.className = 'sim-chip';
    el.innerHTML = `<span>${esc(id)}</span><button type="button" aria-label="${esc(t('web.common.remove'))}">×</button>`;
    el.querySelector('button').addEventListener('click', () => removeSimModel(id));
    chips.appendChild(el);
  }
  const sug = $('simModelSuggest'); if (!sug) return;
  sug.innerHTML = '';
  for (const m of (S.simSuggest || [])) {
    if (S.simModels.includes(m.id)) continue;
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'sim-sug'; btn.title = m.id;
    btn.textContent = m.label || m.id;
    btn.addEventListener('click', () => addSimModel(m.id));
    sug.appendChild(btn);
    if (sug.children.length >= 8) break;
  }
}
export async function fetchSimSuggestions() {
  try {
    const r = await api('/api/models?provider=openrouter');
    S.simSuggest = (r.models || []).slice(0, 20);
    renderSimModels();
  } catch { /* offline / no catalog — the free-text input still works */ }
}

export async function startSimulation(allowRetry = true) {
  const cfg = { simulate: true, modelIds: S.simModels.slice(), fileCount: S.simFiles, concurrency: S.simAgents };
  S.lastSim = cfg;
  S.simPaused = false; setPauseLabel();
  try { const r = await api('/api/run', { method: 'POST', body: JSON.stringify(cfg) }); ingestRun(r.run); }
  catch (e) {
    if (allowRetry && /in progress|409/i.test(e.message)) { setTimeout(() => startSimulation(false), 400); return; }
    toast(e.message, true);
  }
}
export function regenerate() { showView('run'); startSimulation(); }

export async function togglePause() {
  S.simPaused = !S.simPaused; setPauseLabel();
  try { await api('/api/run/pause', { method: 'POST', body: JSON.stringify({ paused: S.simPaused, runId: S.activeRunId }) }); }
  catch (e) { toast(e.message, true); }
}

export function updateSimChrome(run) {
  const active = run.phase === 'running';
  const ended = run.phase === 'done' || run.phase === 'error';
  $('pauseBtn').hidden = !active;
  $('regenBtn').hidden = !ended;
  if (!active && S.simPaused) { S.simPaused = false; setPauseLabel(); }
}

// Controls live in the markup unconditionally; wiring them is harmless on the
// launch page (the elements just stay hidden there).
(function setupSimControls() {
  const form = $('simForm'); if (!form) return;
  form.addEventListener('submit', (e) => { e.preventDefault(); showView('run'); startSimulation(); });
  $('simModelAdd').addEventListener('click', () => addSimModel(/** @type {HTMLInputElement} */ ($('simModelInput')).value));
  $('simModelInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addSimModel(/** @type {HTMLInputElement} */ (e.target).value); }
  });
  $('simFiles').addEventListener('input', (e) => { S.simFiles = +/** @type {HTMLInputElement} */ (e.target).value; $('simFilesOut').textContent = String(S.simFiles); });
  $('simAgents').addEventListener('input', (e) => { S.simAgents = +/** @type {HTMLInputElement} */ (e.target).value; $('simAgentsOut').textContent = String(S.simAgents); });
  $('pauseBtn').addEventListener('click', togglePause);
  $('regenBtn').addEventListener('click', regenerate);
})();

/* ---------------- SSE ----------------
   ONE EventSource carries every run (snapshots, firehose, budget). Native
   EventSource auto-reconnect only fires on a real transport ERROR — a
   half-open (zombie) connection keeps readyState OPEN while delivering
   nothing, which used to freeze the UI until a manual refresh. The watchdog
   below detects staleness via the server's `event: ping` heartbeat (25s) and
   forces a NEW EventSource + a bootstrap resync; the server replays every run
   snapshot on connect, so a reconnect always converges. */
let es = null;
let sseRetryT = null;   // one pending forced-reconnect attempt at a time
let sseWatchT = null;   // module-lifetime staleness watchdog (armed once)
const sseHealth = createSseHealth();

export function connectSse() {
  if (sseRetryT) { clearTimeout(sseRetryT); sseRetryT = null; }
  if (es) es.close();
  es = new EventSource(withTok('/events'));
  sseHealth.connected(Date.now());   // a connect that never delivers is stale too
  es.onmessage = (ev) => {
    sseHealth.seen(Date.now());
    let frame;
    try { frame = JSON.parse(ev.data); } catch { return; }
    if (!frame) return;
    if (frame.type === 'run') ingestRun(frame.run);
    // The RAW firehose feeds two readers: the console mirror, and the debate
    // chat — which is the ONLY place the two sides can be seen while they
    // write, since their briefs reach the blackboard path already finished.
    else if (frame.type === 'agent-stream') { logAgentStream(frame); ingestDevAgentStream(frame); }
    else if (frame.type === 'budget') renderBudget(frame.budget);
    else if (frame.type === 'dev') renderDevSession(frame.session);
  };
  es.addEventListener('ping', () => sseHealth.seen(Date.now()));
  es.onerror = () => {
    // CONNECTING: the native auto-retry (server sends `retry: 2000`) is in
    // flight — leave it alone; the watchdog still catches a retry loop that
    // never lands. CLOSED is permanent (non-200 / wrong content-type): the
    // browser gives up for good, only a NEW EventSource object recovers.
    if (es && es.readyState === EventSource.CLOSED) scheduleSseReconnect('connection closed');
  };
  if (!sseWatchT) sseWatchT = setInterval(sseCheck, 5_000);
}

export function sseCheck() {
  if (!es) return;
  if (sseAction({ readyState: es.readyState, stale: sseHealth.stale(Date.now()) }) === 'reconnect') {
    scheduleSseReconnect('stale stream');
  }
}

export function scheduleSseReconnect(why) {
  if (sseRetryT) return;
  const delay = sseHealth.nextDelay();
  console.warn(`huu: SSE ${why} — reconnecting in ${delay}ms`);
  sseRetryT = setTimeout(() => {
    sseRetryT = null;
    connectSse();
    resyncFromServer();
  }, delay);
}

/* A forced reconnect may have missed frames while the stream was dead. The
   SSE replay covers current snapshots; re-pulling bootstrap as well is cheap,
   idempotent (ingestRun keys by runId) and keeps the budget chip honest. */
export async function resyncFromServer() {
  try {
    const b = await api('/api/bootstrap');
    for (const r of b.runs || []) ingestRun(r);
    if (b.budget) renderBudget(b.budget);
  } catch { /* still unreachable — the watchdog will fire again */ }
}

// Suspended laptops / tab switches / network flips are exactly when zombie
// connections surface — check immediately on wake instead of waiting out the
// (background-throttled) watchdog interval.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') sseCheck();
});
window.addEventListener('online', () => sseCheck());

/* ---------------- Agent output → browser console ----------------
   Every line the pi coding agent streams back (its reply text AND its thinking
   trace) is mirrored here, verbatim and in real time, so you can watch the raw
   agent output in DevTools. Silence it from the console with
   `window.HUU_LOG_STREAM = false`. The on-page run log shows the reply text;
   the thinking trace is console-only (it's verbose). */
const STREAM_STYLE = {
  assistant: 'color:#06b6d4;font-weight:600',  // cyan — visible model reply
  thinking: 'color:#a78bfa',                   // muted violet — reasoning
};
console.info('huu: streaming live pi agent output here. Set window.HUU_LOG_STREAM=false to silence.');
export function logAgentStream(f) {
  if (/** @type {any} */ (window).HUU_LOG_STREAM === false) return;
  // Tag the runId only when more than one run is live, so single-run output
  // stays clean but concurrent runs are disambiguable in the console.
  const rid = f.runId && S.runs.size > 1 ? `${String(f.runId).slice(0, 4)}/` : '';
  const tag = `${rid}#${f.agentId}${f.channel === 'thinking' ? ' 🧠' : ''}`;
  console.log(`%c${tag}%c ${f.text}`, STREAM_STYLE[f.channel] || '', 'color:inherit');
}

/* ---------------- Ingest run snapshot ---------------- */
let lastStartedAt = 0;
export function ingestRun(run) {
  if (!run) return;
  if (run.runId) {
    S.runs.set(run.runId, run);
    // A pin dies with its run (server retention pruned it, or state reset).
    if (S.runPinnedId && !S.runs.has(S.runPinnedId)) S.runPinnedId = null;
    // Follow the ACTION: without an explicit user pick, the pointer must not
    // stay parked on a finished/failed run while another project is running —
    // that left the board closed (auto-switch needs phase 'running') even as
    // nine live runs narrated in the terminal.
    S.activeRunId = pickActiveRun(S.activeRunId, S.runPinnedId, runSelRuns());
  }
  // Queue bookkeeping runs for EVERY run's frame (archive settled + finish the
  // queue when all are done), not just the one being viewed. Sims self-drive.
  if (!S.sim && run.runId) onRunFrame(run);
  renderRunSelector();
  renderActiveRun();
  // A run snapshot carries the debate's cards and the gate's verdict, so the
  // chat has to see it too — the session frame alone would leave the gate's
  // ruling off screen until the next lifecycle transition.
  onDevRunFrame(run);
}

/* ---------------- Development mode owns its own surface ----------------
   A dev session's epochs are ordinary runs, so they render on the SAME board.
   But /dev is not a launch form the user is finished with: it is a LIVE panel
   (session state, the approval/resume/orphan gates, and now the debate chat)
   they must be able to come BACK to while the swarm runs. Two things made that
   impossible, and both fixes below are dev-only — a normal run keeps exactly
   the behavior it had:

     1. the per-frame auto-switch re-asserted the board on EVERY frame, so a
        return to /dev survived until the next SSE tick — i.e. milliseconds,
        and precisely while the debate was being written;
     2. `backToLaunch` (the only exit once showView hides the mode switch) was
        hidden for the whole time a run was active, so the board was a dead end.

   The FIRST live run of a session still opens the board, exactly as before: the
   latch only starts guarding once the board has been opened once.

   THE GUARD IS ANCHORED ON THE RUN, NOT ON THE SESSION. It was on the session
   first, and that quietly changed a run that has nothing to do with dev mode:
   launch an ORDINARY pipeline (another project, another tab) while a dev
   session happens to be alive and it stopped auto-opening the board and grew a
   "← Development mode" exit pointing at /dev. Belonging is a property of the
   RUN — `session.runIds` is the list huu itself stamped, epoch by epoch — so a
   concurrent normal run now takes exactly the branch it took before any of
   this existed. */
let devBoardOpened = false;

function devSessionActive() {
  return !!(S.devSession && S.devSession.active);
}

/** True only for a run the LIVE dev session owns (`{epoch, runId, phase}[]`). */
function isDevRun(run) {
  const s = S.devSession;
  if (!s || !s.active || !run || !run.runId) return false;
  return (s.runIds || []).some((r) => r && r.runId === run.runId);
}

/**
 * Render the board / metrics / log / chrome for the ACTIVE (selected) run.
 * `S.run` is kept as a pointer to it so every other reader (metrics tick,
 * concurrency control, drawer) keeps working unchanged.
 */
export function renderActiveRun() {
  const run = (S.activeRunId && S.runs.get(S.activeRunId)) || { phase: 'idle' };
  S.run = run;
  const active = run.phase === 'running';
  const hasRun = run.phase !== 'idle';

  // Open the run board ONLY while a pipeline is actively running. An
  // idle/done/error run opens on home (the launch view) — so reopening the app
  // after a run finished lands on home, not on a stale board. We only ever
  // switch TO the board here; a run that settles while you're watching it keeps
  // you on the board (the guard simply stops re-asserting the board view).
  // `homePinned` opts out entirely: the user deliberately went home mid-queue to
  // add more projects, so don't drag them back on every frame.
  // Dev-only guard: once this session has opened the board once, sitting on
  // /dev is a deliberate choice and the board must stop re-asserting itself.
  // The latch is cleared with the SESSION (so the next session opens the board
  // again) but consulted per RUN, so a normal run running alongside keeps the
  // original behavior to the letter.
  const devRun = isDevRun(run);
  if (!devSessionActive()) devBoardOpened = false;
  const devHold = devRun && devBoardOpened && $('viewDev').hidden === false;
  if (active && $('viewRun').hidden && !S.homePinned && !devHold) {
    showView('run');
    if (devRun) devBoardOpened = true;
  }
  const onRunView = !$('viewRun').hidden;

  // Topbar run chrome belongs to the board context, not the home screen — so
  // when the user pins home mid-queue (active but !onRunView) it stays hidden.
  $('runStatusGroup').hidden = !hasRun || !onRunView;
  $('concControl').hidden = !active || !onRunView;
  // The per-run abort targets the VIEWED run; hidden during a queue (which uses
  // a queue-wide stop) and handled by updateQueueChrome.
  $('abortBtn').hidden = !active;
  $('backToLaunch').hidden = active || !hasRun;

  // Held open for retries: the run is still 'running' (phase) but its inner
  // status is 'awaiting_retry'. Offer an explicit Finish to leave the hold.
  const awaitingRetry = !!(run.state && run.state.status === 'awaiting_retry');
  $('finishBtn').hidden = !(awaitingRetry && !S.sim);

  setStatus(run.phase, run.state && run.state.status);
  const st = run.state;
  // Gooey morph loader while the orchestrator spins up — shown while the run
  // is live but no cards have landed yet (preflight / worktree creation).
  const cardCount = st
    ? (st.agents || []).length + (st.stageIntegrations || []).length + (st.checkRuns || []).length
    : 0;
  const loader = $('runLoader');
  if (active && cardCount === 0) {
    loader.hidden = false;
    $('runLoaderLabel').textContent = st ? t('web.run.preparing') : t('web.run.spinning_up');
  } else {
    loader.hidden = true;
  }
  if (st) {
    lastStartedAt = st.startedAt || run.startedAt || 0;
    $('mStage').textContent = st.wave != null ? t('web.run.wave', { n: st.wave }) : `${st.currentStage}/${st.totalStages}`;
    $('mTasks').textContent = `${st.completedTasks}/${st.totalTasks}`;
    $('mCost').textContent = fmtCost(st.totalCost || 0);
    updateConc(st);
    if (run.runId && run.runId !== boardRunId) { boardRunId = run.runId; resetBoardState(); }
    renderBoard(st);
    if (S.openCardKey) refreshDrawer(st);
  }
  if (run.phase === 'done' || run.phase === 'error') {
    $('runSummary').innerHTML = run.errorReason
      ? `<b style="color:var(--red)">${esc(t('web.run.failed_label'))}</b> ${esc(run.errorReason)}`
      : `<b>${esc(t('web.run.done_label'))}</b> ${esc(t('web.run.pipeline_finished', { name: run.pipelineName }))}`;
  } else { $('runSummary').textContent = ''; }

  // Run log + live cross-project activity counter — refreshed on EVERY frame,
  // even when the SELECTED run has no state yet but another run is already live
  // (the counter sums all runs, so it must not depend on the viewed run's `st`).
  // Coalesced: with N concurrent runs each frame re-merges EVERY run's logs
  // (O(N·L) + an innerHTML rebuild) at up to N×(1/120ms) frame rates — enough
  // to back up the SSE reader on a big queue. One trailing rebuild per 100ms
  // is indistinguishable to the eye; the UI handlers (log toggle / level
  // filter) keep calling renderLog() directly for instant feedback.
  scheduleRenderLog();

  // /simulation drives its own chrome (pause / run-again); the launch flow
  // drives the concurrent queue (archive + stop-queue strip).
  if (S.sim) updateSimChrome(run);
  else updateQueueChrome();

  // LAST, because updateQueueChrome() rewrites this button's label: while the
  // viewed run IS one of the session's epoch runs, the exit is not "new run",
  // it is the panel the user came from — and it stays reachable WHILE the run
  // is active, which is the one case the rule above deliberately hides it for.
  // The click handler already routes a live dev session back to /dev
  // (launch.js), so only the chrome was missing. A normal run viewed during the
  // same session falls through and keeps the ordinary label and hiding rule.
  if (devRun && hasRun) {
    const btl = $('backToLaunch');
    btl.hidden = false;
    btl.textContent = t('web.dev.back_to_dev');
  }
}

/* ---------------- Project selector (custom simulated dropdown) ----------------
   A Motion-animated listbox listing every concurrent run as "project · pipeline",
   shown only when MORE THAN ONE run is tracked. Picking an option switches the
   viewed run; a leading status dot reflects each run's phase and finished/failed
   runs carry a ✓/✕ mark so the open list stays glanceable.

   Why NOT a native <select>: renderRunSelector() runs on every SSE snapshot
   (~8×/s during a live run), and rebuilding a <select> slammed the OS popup shut
   the instant it opened — the "opens and immediately closes" bug. This dropdown
   keeps its open state in JS (runSel.open) over PERSISTENT DOM whose listeners
   are wired ONCE: live re-renders only refresh the trigger label and (while open)
   the option rows, never the open/closed state — so it stays open while the board
   updates underneath it. */
const runSel = { open: false, active: -1 };

/** The vendored Motion engine (window.Motion) — null-safe so the UI still works
 *  if vendor/motion.js ever fails to load. */
export function motionEngine() { return typeof window !== 'undefined' ? /** @type {Window & { Motion?: any }} */ (window).Motion : null; }
export function runSelMotion() { const m = motionEngine(); return m && m.animate && !prefersReducedMotion() ? m : null; }

export function runSelRuns() { return [...S.runs.values()].filter((r) => r.runId); }
export function runMark(phase) { return phase === 'done' ? '✓' : phase === 'error' ? '✕' : ''; }
export function runLabel(r) { const proj = projectName(r.runDirectory); const pipe = r.pipelineName || r.runId; return proj ? `${proj} · ${pipe}` : pipe; }

export function runSelOptionsHtml(runs) {
  return runs.map((r, i) =>
    `<li class="rsel__opt${r.runId === S.activeRunId ? ' sel' : ''}${i === runSel.active ? ' active' : ''}"`
    + ` role="option" id="rsel-opt-${i}" data-id="${esc(r.runId)}"`
    + ` aria-selected="${r.runId === S.activeRunId ? 'true' : 'false'}">`
    + `<span class="run-select__dot" data-phase="${esc(r.phase || 'idle')}"></span>`
    + `<span class="rsel__opt-label">${esc(runLabel(r))}</span>`
    + `<span class="rsel__opt-mark">${runMark(r.phase)}</span></li>`,
  ).join('');
}

/** Build the trigger + menu shell ONCE and wire listeners once; later renders reuse it. */
export function ensureRunSelDom(el) {
  if ($('runSelTrigger')) return;
  el.innerHTML =
    `<button class="rsel__trigger" id="runSelTrigger" type="button" aria-haspopup="listbox"`
    + ` aria-expanded="false" aria-label="${esc(t('web.run.switch_projects'))}">`
    + `<span class="run-select__dot" id="runSelDot" data-phase="idle"></span>`
    + `<span class="rsel__label" id="runSelLabel"></span>`
    + `<span class="rsel__chev" id="runSelChev" aria-hidden="true">⌄</span></button>`
    + `<ul class="rsel__menu" id="runSelMenu" role="listbox" tabindex="-1" hidden></ul>`;
  const trigger = $('runSelTrigger');
  const menu = $('runSelMenu');
  trigger.addEventListener('click', () => (runSel.open ? closeRunSel() : openRunSel()));
  // All keyboard lives on the trigger (it keeps focus); the menu is presentation.
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (runSel.open) { e.preventDefault(); closeRunSel(); } return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); runSel.open ? moveRunSelActive(1) : openRunSel(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); if (runSel.open) moveRunSelActive(-1); return; }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!runSel.open) { openRunSel(); return; }
      const r = runSelRuns()[runSel.active];
      if (r) pickRun(r.runId);
    }
  });
  // mousedown (not click) so the pick wins before any focus/blur reshuffle.
  menu.addEventListener('mousedown', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);   // mousedown targets here are elements
    const li = t.closest ? /** @type {HTMLElement | null} */ (t.closest('.rsel__opt')) : null;
    if (li && li.dataset.id) { e.preventDefault(); pickRun(li.dataset.id); }
  });
}

/** Refresh ONLY the option rows (keeps open/closed state untouched). */
export function renderRunSelMenu() {
  const menu = $('runSelMenu');
  if (!menu) return;
  menu.innerHTML = runSelOptionsHtml(runSelRuns());
  const trigger = $('runSelTrigger');
  if (trigger) {
    if (runSel.active >= 0) trigger.setAttribute('aria-activedescendant', 'rsel-opt-' + runSel.active);
    else trigger.removeAttribute('aria-activedescendant');
  }
  const act = menu.querySelector('.rsel__opt.active');
  if (act) act.scrollIntoView({ block: 'nearest' });
}

export function moveRunSelActive(d) {
  const runs = runSelRuns();
  if (!runs.length) return;
  if (runSel.active < 0) runSel.active = Math.max(0, runs.findIndex((r) => r.runId === S.activeRunId));
  runSel.active = Math.min(runs.length - 1, Math.max(0, runSel.active + d));
  renderRunSelMenu();
}

export function pickRun(id) {
  S.activeRunId = id;
  // Explicit choice: hold this board even if other runs are (still) running.
  // The pin clears when its run leaves tracking (see ingestRun).
  S.runPinnedId = id;
  closeRunSel();
  renderRunSelector();
  renderActiveRun();
}

export function openRunSel() {
  const menu = $('runSelMenu'), trigger = $('runSelTrigger'), chev = $('runSelChev');
  if (!menu || runSel.open) return;
  runSel.open = true;
  runSel.active = Math.max(0, runSelRuns().findIndex((r) => r.runId === S.activeRunId));
  trigger.setAttribute('aria-expanded', 'true');
  renderRunSelMenu();
  menu.hidden = false;
  const M = runSelMotion();
  if (M) {
    M.animate(menu, { opacity: [0, 1], scale: [0.96, 1], y: [-6, 0] }, { type: 'spring', stiffness: 520, damping: 32 });
    const opts = menu.querySelectorAll('.rsel__opt');
    if (opts.length) M.animate(opts, { opacity: [0, 1], y: [-4, 0] }, { delay: M.stagger(0.025), duration: 0.18, ease: [0.2, 0.7, 0.3, 1] });
    M.animate(chev, { rotate: 180 }, { type: 'spring', stiffness: 500, damping: 30 });
  } else if (chev) { chev.style.transform = 'rotate(180deg)'; }
}

export function closeRunSel() {
  const menu = $('runSelMenu'), trigger = $('runSelTrigger'), chev = $('runSelChev');
  if (!menu || !runSel.open) return;
  runSel.open = false;
  runSel.active = -1;
  trigger.setAttribute('aria-expanded', 'false');
  trigger.removeAttribute('aria-activedescendant');
  const M = runSelMotion();
  if (chev) { if (M) M.animate(chev, { rotate: 0 }, { type: 'spring', stiffness: 500, damping: 30 }); else chev.style.transform = 'rotate(0deg)'; }
  if (M) {
    // Hide only after the exit finishes AND only if still closed (a re-open mid-exit must win).
    const anim = M.animate(menu, { opacity: [1, 0], scale: [1, 0.97], y: [0, -6] }, { duration: 0.14, ease: 'easeIn' });
    const settle = () => { if (!runSel.open) menu.hidden = true; };
    anim.finished.then(settle).catch(settle);
  } else {
    menu.hidden = true;
  }
}

/**
 * Public entry, called on every render. Shows/updates the trigger and, while the
 * menu is open, refreshes its rows — WITHOUT ever forcing it open or closed.
 */
export function renderRunSelector() {
  const el = $('runSelector');
  if (!el) return;
  const runs = runSelRuns();
  if (runs.length <= 1) {
    if (runSel.open) closeRunSel();
    el.hidden = true;
    return;
  }
  ensureRunSelDom(el);
  el.hidden = false;
  const activeRun = (S.activeRunId && S.runs.get(S.activeRunId)) || runs[0];
  const lbl = $('runSelLabel');
  if (lbl) lbl.textContent = runLabel(activeRun);
  const dot = $('runSelDot');
  if (dot) dot.dataset.phase = activeRun.phase || 'idle';
  if (runSel.open) renderRunSelMenu(); // live rows update; open state preserved
}

export function setStatus(phase, innerStatus) {
  // While the run is held open for retries the snapshot phase is still
  // 'running'; surface the inner `awaiting_retry` as a distinct "review" pill.
  if (innerStatus === 'awaiting_retry') {
    $('statusText').textContent = t('web.status.review');
    $('statusPill').dataset.s = 'awaiting';
    return;
  }
  // Grant-starved run: still 'running' but all its agents were paused/withheld
  // by the pressure guard (0 active, work pending, machine under pressure).
  // Worktrees + sessions are preserved; it resumes IN PLACE when RAM frees up.
  // Derived here — no new server state machine.
  if (phase === 'running' && isPressurePaused(S.run)) {
    $('statusText').textContent = t('web.status.paused_ram');
    $('statusPill').dataset.s = 'paused';
    return;
  }
  const KEYS = { idle: 'web.status.idle', queued: 'web.status.queued', running: 'web.status.running', done: 'web.status.done', error: 'web.status.error' };
  const label = KEYS[phase] ? t(KEYS[phase]) : phase;
  $('statusText').textContent = label;
  $('statusPill').dataset.s = phase;
}

/** True when a running run is fully withheld by the memory guard right now. */
export function isPressurePaused(run) {
  const st = run && run.state;
  if (!st) return false;
  const pressure = S.lastBudget ? Number(S.lastBudget.pressureLevel) || 0 : 0;
  return (
    pressure >= 1 &&
    (st.activeAgentCount || 0) === 0 &&
    (st.pendingTaskCount || 0) > 0 &&
    st.status === 'running'
  );
}

// Local 1s tick so elapsed advances smoothly between SSE frames.
setInterval(() => {
  if (S.run.phase === 'running' && lastStartedAt) {
    $('mElapsed').textContent = fmtDur(Date.now() - lastStartedAt);
  } else if (S.run.state && S.run.finishedAt && lastStartedAt) {
    $('mElapsed').textContent = fmtDur(S.run.finishedAt - lastStartedAt);
  }
}, 1000);

/* ---------------- Machine budget chip (topbar) ----------------
   Fed by the 1 Hz `{type:'budget'}` SSE frame (+ bootstrap). Shows the dial
   actually in force, live usage and the guard's pressure level — the feedback
   loop the RAM gear never had. */
const PRESSURE_KEYS = ['', 'web.pressure.over_budget', 'web.pressure.pressure', 'web.pressure.thrash'];
let warnedNoKernelCeiling = false;
export function renderBudget(b) {
  const el = $('budgetChip');
  if (!el || !b) return;
  S.lastBudget = b;
  const gib = (n) => (n / (1024 ** 3)).toFixed(1);
  const psi = b.psiSome10 == null ? t('web.common.na') : `${Number(b.psiSome10).toFixed(1)}%`;
  const level = Number(b.pressureLevel) || 0;
  el.hidden = false;
  el.dataset.level = String(level);
  // The totals here are CONTAINER-scoped (the --memory ceiling), not the
  // machine total — say so whenever the host figure differs, and name the
  // host as the limiting factor while the availability clamp binds.
  const hostDiffers =
    b.containerAware && b.hostTotalBytes && Math.abs(b.hostTotalBytes - b.totalBytes) > b.totalBytes * 0.03;
  const hostNote = hostDiffers
    ? ` · ${t('web.budget.container_scope', { scope: gib(b.totalBytes), host: gib(b.hostTotalBytes) })}` +
      (b.hostAvailableBytes != null ? ` (${t('web.budget.host_avail', { avail: gib(b.hostAvailableBytes) })})` : '')
    : '';
  el.title =
    t('web.budget.tip_head', { percent: b.budgetPercent, gib: gib(b.budgetBytes) }) + ' ' +
    t('web.budget.tip_used', { used: gib(b.usedBytes), total: gib(b.totalBytes), psi }) +
    hostNote +
    (b.hostClampActive ? ' · host availability is the limiting factor' : '') +
    (b.pressureReason ? ` · ${t('web.budget.guard', { reason: b.pressureReason })}` : '') +
    (b.liveAgents != null
      ? ` · ${t('web.budget.agents_live', { live: b.liveAgents, budget: b.budgetB ?? 0 })}` +
        (Number(b.reservedAgents) > 0 ? ` (${t('web.budget.reserved', { count: b.reservedAgents })})` : '')
      : '') +
    ` · ${t('web.budget.footprint', { mib: b.observedAgentMemoryMb })}`;
  // Headline honesty: the used/total pair is huu's own consumption vs huu's
  // ceiling (cgroup scope — blind to every other app on the machine). When
  // the HOST figures exist, show the machine-wide pair with the SAME
  // prominence — tooltip-only host info kept the chip reading "emptier" than
  // the computer actually was.
  const hostBits =
    b.containerAware && b.hostTotalBytes && b.hostAvailableBytes != null
      ? `<span class="budget-chip__use">${esc(t('web.budget.chip_host', { used: gib(b.hostTotalBytes - b.hostAvailableBytes), total: gib(b.hostTotalBytes) }))}</span>`
      : '';
  // Global agent counter: live agents (judges/merge resolvers INCLUDED — they
  // consume budget like any agent) over the current slot budget B. This is the
  // machine-wide truth the per-project board can't show.
  const agentBits =
    b.liveAgents != null
      ? `<span class="budget-chip__use">${esc(t('web.budget.chip_agents', { live: b.liveAgents, budget: b.budgetB ?? 0 }))}` +
        (Number(b.reservedAgents) > 0 ? ` (${esc(t('web.budget.reserved', { count: b.reservedAgents }))})` : '') +
        `</span>`
      : '';
  el.innerHTML =
    `<span class="budget-chip__pct">${esc(t('web.budget.chip_ram', { percent: b.budgetPercent }))}</span>` +
    agentBits +
    `<span class="budget-chip__use">${esc(t('web.budget.chip_huu', { used: gib(b.usedBytes), total: gib(b.totalBytes) }))}</span>` +
    hostBits +
    (b.hostClampActive ? `<span class="budget-chip__lvl">${esc(t('web.budget.host_limited'))}</span>` : '') +
    (level > 0 && PRESSURE_KEYS[level] ? `<span class="budget-chip__lvl">${esc(t(PRESSURE_KEYS[level]))}</span>` : '');
  if (b.noKernelCeiling && !warnedNoKernelCeiling) {
    warnedNoKernelCeiling = true;
    toast('no kernel RAM ceiling — containment is software-only (see huu status)', true);
  }
}

/* ---------------- Concurrency control (topbar) ---------------- */
export function updateConc(st) {
  $('concVal').textContent = st.concurrency;
  const mode = st.autoScale ? st.autoScale.mode : 'manual';
  // 'greedy' only reaches here from legacy state — web runs are scheduler-
  // subordinate, where MAX never drove anything; the toggle now offers
  // auto ⇄ manual only (the RAM dial in ⚙ Settings is the machine lever).
  $('concTag').textContent = mode === 'greedy' ? 'auto' : mode;
}
$('concMode').addEventListener('click', async () => {
  const cur = S.run.state && S.run.state.autoScale ? S.run.state.autoScale.mode : 'manual';
  const next = cur === 'manual' ? 'auto' : 'manual';
  try { await api('/api/run/concurrency', { method: 'POST', body: JSON.stringify({ mode: next, runId: S.activeRunId }) }); } catch (e) { toast(e.message, true); }
});
$('concUp').addEventListener('click', () => adjustConc(1));
$('concDown').addEventListener('click', () => adjustConc(-1));
export async function adjustConc(d) { try { await api('/api/run/concurrency', { method: 'POST', body: JSON.stringify({ delta: d, runId: S.activeRunId }) }); } catch (e) { toast(e.message, true); } }

$('abortBtn').addEventListener('click', async () => {
  // Aborts only the VIEWED run (the queue-wide stop is a separate button).
  try { await api('/api/run/abort', { method: 'POST', body: JSON.stringify({ runId: S.activeRunId }) }); toast(t('web.run.stopping')); } catch (e) { toast(e.message, true); }
});

// Dismiss the project selector on any pointer-down outside it. mousedown (not
// click) so it settles before the menu's own mousedown pick; clicks INSIDE the
// host (trigger toggle, option pick) are handled by their own listeners.
document.addEventListener('mousedown', (e) => {
  if (!runSel.open) return;
  const host = $('runSelector');
  if (host && !host.contains(/** @type {Node} */ (e.target))) closeRunSel();
});

/* ---------------- Board reconciler ---------------- */
const ACTIVE_PHASES = new Set(['worktree_creating','worktree_ready','session_starting','streaming','tool_running','finalizing','validating','committing','pushing','cleaning_up']);
const cardEls = new Map(); // key -> element

// --- Card-move animation (FLIP) ---------------------------------------------
// Cards are REUSED dom nodes keyed by card.key, so a lane change is the SAME
// node re-parented into another lane body. We animate that move with the FLIP
// technique (First/Last/Invert/Play): measure the old box, let the reconciler
// drop the node into the new lane's FIRST slot, then animate old -> new with a
// `transform` only (GPU-composited; never width/height/top/left → no layout
// thrash). Cross-column flights ride a body-level overlay so the lane's
// overflow clip doesn't cut them off mid-air.
const boardOrder = createBoardOrder();  // pure lane-ordering + mover detection (board-order.js)
const ghosts = new Map();     // key -> { node } for an in-flight cross-lane ghost
let boardRunId = null;        // wipe board state when the run changes
let flipLayer = null;         // lazy body-level overlay for cross-column ghosts
const FLIP_MS = 400, FLIP_EASE = 'cubic-bezier(.2,.7,.3,1)', MAX_FLIP_CARDS = 400;

export function prefersReducedMotion() { return matchMedia('(prefers-reduced-motion: reduce)').matches; }
export function ensureFlipLayer() {
  if (!flipLayer) { flipLayer = document.createElement('div'); flipLayer.className = 'flip-layer'; document.body.appendChild(flipLayer); }
  return flipLayer;
}
export function killGhost(key) {
  const g = ghosts.get(key);
  if (!g) return;
  ghosts.delete(key);
  g.node.remove();
  const el = cardEls.get(key);
  if (el) el.style.visibility = '';
}
// Full reset between runs: keys (a1, a2…) repeat across runs, so without this a
// fresh run's pending cards would be mistaken for movers and fly in from nowhere.
export function resetBoardState() {
  for (const k of [...ghosts.keys()]) killGhost(k);
  for (const [, el] of cardEls) el.remove();
  cardEls.clear(); boardOrder.reset();
  for (const lane of ['todo', 'doing', 'done']) { const b = $('lane' + cap(lane)); if (b) b.innerHTML = ''; }
}
export function captureCardRects() {
  const m = new Map();
  for (const [k, el] of cardEls) {
    if (!el.isConnected) continue;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    m.set(k, { left: r.left, top: r.top, width: r.width, height: r.height });
  }
  return m;
}
// Last + Invert + Play. Reads are batched (one layout flush), then all inverts
// are written, then a SINGLE forced reflow commits them, then one rAF plays the
// whole batch — so N moving cards animate in lockstep with zero per-card thrash.
export function playCardFlip(first, movers) {
  /** @type {Array<{ key: any, el: any, last: any, dx: number, dy: number, cross: any, ghost?: any }>} */
  const tasks = [];
  for (const [k, el] of cardEls) {
    const f = first.get(k);
    if (!f || !el.isConnected) continue;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    const dx = f.left - r.left, dy = f.top - r.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    tasks.push({ key: k, el, last: r, dx, dy, cross: movers.has(k) });
  }
  if (!tasks.length) return;

  const layer = tasks.some((t) => t.cross) ? ensureFlipLayer() : null;
  for (const t of tasks) {
    if (t.cross) {
      killGhost(t.key);                                   // re-entrancy: drop any prior ghost
      const g = t.el.cloneNode(true);
      g.className = t.el.className + ' card--ghost';
      g.style.left = t.last.left + 'px';
      g.style.top = t.last.top + 'px';
      g.style.width = t.last.width + 'px';
      g.style.height = t.last.height + 'px';
      g.style.visibility = '';                            // the source may be mid-hide; the ghost must show
      g.style.transition = 'none';
      g.style.transform = `translate(${t.dx}px, ${t.dy}px)`;
      layer.appendChild(g);
      t.el.style.visibility = 'hidden';                   // hold the destination slot; no reflow
      t.ghost = g;
      ghosts.set(t.key, { node: g });
    } else {
      t.el.style.transition = 'none';
      t.el.style.willChange = 'transform';
      t.el.style.transform = `translate(${t.dx}px, ${t.dy}px)`;
    }
  }

  void document.body.offsetWidth;                         // one reflow → commit the inverted state

  requestAnimationFrame(() => {
    for (const t of tasks) {
      const node = t.cross ? t.ghost : t.el;
      let settled = false;
      const finish = () => {
        if (settled) return; settled = true;
        node.removeEventListener('transitionend', onEnd);
        clearTimeout(timer);
        if (t.cross) {
          if (ghosts.get(t.key) && ghosts.get(t.key).node === node) ghosts.delete(t.key);
          node.remove();
          if (t.el.isConnected) t.el.style.visibility = '';
        } else {
          node.style.transition = ''; node.style.willChange = '';
        }
      };
      const onEnd = (e) => { if (!e || e.propertyName === 'transform') finish(); };
      node.addEventListener('transitionend', onEnd);
      const timer = setTimeout(finish, FLIP_MS + 140);    // fallback if transitionend is missed (e.g. backgrounded tab)
      node.style.transition = `transform ${FLIP_MS}ms ${FLIP_EASE}`;
      node.style.transform = t.cross ? 'translate(0, 0)' : '';
    }
  });
}

export function cardsFromState(st) {
  const out = [];
  for (const a of st.agents || []) out.push(agentCard(a));
  for (const m of st.stageIntegrations || []) out.push(mergeCard(m));
  for (const j of st.checkRuns || []) out.push(judgeCard(j));
  return out;
}

export function laneOf(c) {
  if (c.lane) return c.lane;
  return 'done';
}

export function agentCard(a) {
  // Canonical lane/cls/plabel mapping lives in client/card-state.js (the
  // mirror of src/lib/card-state.ts): done = MERGED, ready = awaiting merge,
  // unmerged = orphaned work, paused = re-queued (TODO).
  const { lane, cls, plabel } = cardStateOf(a, humanize);
  const file = (a.currentFile || (a.files && a.files[0]) || '');
  return {
    key: 'a' + a.agentId, kind: 'agent', lane, cls, plabel,
    // Resolve the `$file` fan-out token so the user never sees a literal
    // "$file" in the title (per-file/memory steps); full path stays in `file`.
    title: substituteFileInTitle(a.stageName || t('web.card.task', { id: a.agentId }), file),
    file,
    idText: '#' + a.agentId,
    streaming: a.phase === 'streaming' || a.phase === 'tool_running',
    foot: footBits([
      a.tokensOut ? `${fmtNum(a.tokensIn + a.tokensOut)} tok` : '',
      a.cost ? `$${a.cost.toFixed(3)}` : '',
      a.requeues ? `↻${a.requeues}` : '',
      a.pauses ? `⏸${a.pauses}` : '',
      a.manualRetries ? t('web.card.retry_n', { count: a.manualRetries }) : '',
      // Per-task critic loop: rounds run, and the waive marker for a card that
      // hit the round cap with blockers still open (it merged anyway — the
      // findings are in the drawer).
      a.reviewRounds ? `🔍${a.reviewRounds}` : '',
      a.reviewWaived ? '⚠' : '',
    ], a.requeues),
    raw: a,
  };
}
export function mergeCard(m) {
  let lane = 'doing', cls = 'active';
  if (m.phase === 'done' || m.phase === 'skipped') { lane = 'done'; cls = 'done'; }
  else if (m.phase === 'error') { lane = 'done'; cls = 'err'; }
  else if (m.phase === 'pending') { lane = 'todo'; cls = 'idle'; }
  return {
    key: 'm' + m.visitIndex, kind: 'merge', lane, cls, plabel: humanize(m.phase),
    title: t('web.card.merge') + ' · ' + substituteFileInTitle(m.stageName || '', null),
    file: (m.branchesMerged && m.branchesMerged.length ? t('web.card.merged_n', { count: m.branchesMerged.length }) : ''),
    idText: m.runs > 1 ? `×${m.runs}` : '',
    streaming: m.phase === 'merging' || m.phase === 'conflict_resolving',
    foot: footBits([m.resolverUsed ? t('web.card.resolver') : '', (m.conflicts && m.conflicts.length) ? t('web.card.conflicts_n', { count: m.conflicts.length }) : '']),
    raw: m,
  };
}
export function judgeCard(j) {
  let lane = 'doing', cls = 'active';
  if (j.phase === 'done') { lane = 'done'; cls = 'done'; }
  else if (j.phase === 'error') { lane = 'done'; cls = 'err'; }
  return {
    key: 'j' + j.visitIndex, kind: 'judge', lane, cls, plabel: humanize(j.phase),
    title: t('web.card.judge') + ' · ' + substituteFileInTitle(j.stepName || '', null),
    file: j.outcomeLabel ? `→ ${j.outcomeLabel}` : esc(j.condition || '').slice(0, 60),
    idText: j.runs ? `run ${j.runs}` : '',
    streaming: j.phase === 'judging',
    foot: footBits([j.fromJudge === false ? t('web.card.default') : '', j.nextStepName ? t('web.card.next', { name: j.nextStepName }) : '']),
    raw: j,
  };
}

export function footBits(parts, requeue) {
  return parts.filter(Boolean).map((p) => {
    if (requeue && p.startsWith('↻')) return `<span class="requeue">${p}</span>`;
    // Review markers read as their own thing: neutral-accent for the round
    // count, amber for a waived block (merge/judge cards never emit either).
    if (p.startsWith('🔍')) return `<span class="reviewbit">${esc(p)}</span>`;
    if (p.startsWith('⚠')) return `<span class="waivedbit" title="${esc(t('web.card.review_waived_title'))}">${esc(p)}</span>`;
    return `<span class="metriclet">${esc(p)}</span>`;
  }).join('');
}

export function renderBoard(st) {
  const cards = cardsFromState(st);
  for (const c of cards) c.lane = laneOf(c);   // normalize to todo|doing|done
  const seen = new Set(cards.map((c) => c.key));

  // A card that CHANGED lane floats to the destination's FIRST slot (newest
  // mover on top); new cards keep natural order. See board-order.js.
  const { movers, byLane } = boardOrder.place(cards);

  // Positions only change when a card is added, removed, or moved lane — so only
  // then is it worth measuring boxes for the FLIP (keeps idle frames cheap).
  let structural = movers.size > 0;
  if (!structural) for (const c of cards) if (!cardEls.has(c.key)) { structural = true; break; }
  if (!structural) for (const k of cardEls.keys()) if (!seen.has(k)) { structural = true; break; }
  const animate = structural && !prefersReducedMotion() && !$('viewRun').hidden && cardEls.size <= MAX_FLIP_CARDS;

  // FLIP — First: snapshot current boxes BEFORE mutating the DOM.
  const first = animate ? captureCardRects() : null;

  // Remove stale cards (cancel any in-flight ghost + drop tracking entries).
  for (const [k, el] of cardEls) {
    if (!seen.has(k)) { killGhost(k); el.remove(); cardEls.delete(k); boardOrder.drop(k); }
  }

  // Reconcile each lane in rank order.
  for (const lane of ['todo', 'doing', 'done']) {
    const body = $('lane' + cap(lane));
    const list = byLane[lane];
    $('cnt' + cap(lane)).textContent = String(list.length);
    let anchor = null;
    for (const c of list) {
      let el = cardEls.get(c.key);
      if (!el) { el = document.createElement('button'); el.type = 'button'; el.className = 'card'; cardEls.set(c.key, el); el.addEventListener('click', () => openDrawer(c.key)); }
      paintCard(el, c);
      if (el.parentElement !== body || el.previousElementSibling !== anchor) {
        body.insertBefore(el, anchor ? anchor.nextSibling : body.firstChild);
      }
      anchor = el;
    }
    // empty placeholder
    let ph = body.querySelector('.lane__empty');
    if (!list.length) { if (!ph) { ph = document.createElement('div'); ph.className = 'lane__empty'; ph.textContent = '—'; body.appendChild(ph); } }
    else if (ph) ph.remove();
  }

  // FLIP — Last + Invert + Play.
  if (animate) playCardFlip(first, movers);
}

export function paintCard(el, c) {
  el.dataset.kind = c.kind;
  el.dataset.key = c.key;
  el.classList.toggle('streaming', !!c.streaming);
  el.innerHTML = `
    <div class="card__top">
      <span class="card__kind">${esc(phaseLabel(c.kind))}</span>
      <span class="card__id">${esc(c.idText || '')}</span>
    </div>
    <div class="card__title">${esc(c.title)}</div>
    ${c.file ? `<div class="card__file">${esc(c.file)}</div>` : ''}
    <div class="card__foot">
      <span class="phase ${c.cls}"><i></i>${esc(phaseLabel(c.plabel))}</span>
      ${c.foot}
    </div>`;
}

/* ---------------- Drawer ---------------- */
const scrim = $('drawerScrim'), drawer = $('drawer');
export function closeDrawer() { S.openCardKey = null; drawer.hidden = true; scrim.hidden = true; }
scrim.addEventListener('click', closeDrawer);
$('drawerClose').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

export async function openDrawer(key) {
  S.openCardKey = key;
  drawer.hidden = false; scrim.hidden = false;
  $('drawerLogs').textContent = ''; // fresh element → first render starts pinned to bottom
  if (S.run.state) refreshDrawer(S.run.state);
  if (key[0] === 'a') {
    const id = +key.slice(1);
    try { const r = await api('/api/agent-logs?id=' + id); setDrawerLogs((r.logs || []).join('\n') || '(no logs yet)', true); } catch {}
  }
}

export function findCard(st, key) {
  if (key[0] === 'a') return agentCard((st.agents || []).find((a) => a.agentId === +key.slice(1)) || {});
  if (key[0] === 'm') return mergeCard((st.stageIntegrations || []).find((m) => m.visitIndex === +key.slice(1)) || {});
  if (key[0] === 'j') return judgeCard((st.checkRuns || []).find((j) => j.visitIndex === +key.slice(1)) || {});
  return null;
}

export function refreshDrawer(st) {
  const c = findCard(st, S.openCardKey);
  if (!c || !c.raw) return;
  $('drawerTitle').textContent = c.title;
  $('drawerMeta').innerHTML = drawerMeta(c);
  renderDrawerRetry(c, st);
  if (S.openCardKey[0] === 'a') {
    // live tail from streamed state (full set fetched on open)
    const logs = c.raw.logs;
    if (logs && logs.length) setDrawerLogs(logs.join('\n'));
  } else {
    const lines = [];
    if (c.raw.condition) lines.push(t('web.drawer.condition') + '\n' + c.raw.condition);
    if (c.raw.reason) lines.push('\nReason:\n' + c.raw.reason);
    if (c.raw.lastLog) lines.push('\n' + c.raw.lastLog);
    if (c.raw.error) lines.push('\nError:\n' + c.raw.error);
    setDrawerLogs(lines.join('\n') || '(no detail)');
  }
}

/* Swap the drawer's log text WITHOUT yanking the reader to the bottom on every
   snapshot. Follow the tail only when they were already pinned there (or `force`
   on first open); if they scrolled up to read, their position is preserved.
   Bailing on identical text avoids a needless scroll reset between snapshots. */
const STICK_THRESHOLD_PX = 28;
export function setDrawerLogs(text, force) {
  const el = $('drawerLogs');
  if (el.textContent === text) return;
  const pinned = force || el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX;
  const prevTop = el.scrollTop;
  el.textContent = text;
  el.scrollTop = pinned ? el.scrollHeight : prevTop;
}

export function kv(k, v, opts = {}) {
  if (v === undefined || v === null || v === '') return '';
  return `<div class="kv ${opts.wide ? 'kv--wide' : ''}"><span class="kv__k">${esc(k)}</span><span class="kv__v ${opts.mono ? 'mono' : ''} ${opts.err ? 'err' : ''}">${esc(String(v))}</span></div>`;
}
export function drawerMeta(c) {
  const r = c.raw;
  if (c.kind === 'agent') {
    return [
      kv(t('web.kv.phase'), humanize(r.phase)), kv(t('web.kv.stage'), substituteFileInTitle(r.stageName, r.currentFile)),
      kv(t('web.kv.tokens_in'), fmtNum(r.tokensIn || 0)), kv(t('web.kv.tokens_out'), fmtNum(r.tokensOut || 0)),
      kv(t('web.kv.cost'), r.cost != null ? '$' + r.cost.toFixed(4) : ''), kv(t('web.kv.requeues'), r.requeues || 0),
      // Only present once the per-task critic loop has run — `kv` drops empties.
      kv(t('web.kv.review_rounds'), r.reviewRounds || ''),
      kv(t('web.kv.review'), r.reviewWaived ? t('web.kv.review_waived') : ''),
      kv(t('web.kv.branch'), r.branchName, { mono: true, wide: true }),
      kv(t('web.kv.files'), (r.filesModified || []).join(', '), { mono: true, wide: true }),
      kv(t('web.kv.commit'), r.commitSha ? r.commitSha.slice(0, 10) : '', { mono: true }),
      kv('Push', r.pushStatus),
      r.error ? kv(t('web.kv.error'), r.error, { wide: true, err: true }) : '',
    ].join('');
  }
  if (c.kind === 'merge') {
    return [
      kv(t('web.kv.phase'), humanize(r.phase)), kv(t('web.kv.runs'), r.runs),
      kv(t('web.kv.merged'), (r.branchesMerged || []).length), kv(t('web.kv.pending'), (r.branchesPending || []).length),
      kv(t('web.kv.resolver'), r.resolverUsed ? t('web.kv.used') : t('web.common.no')), kv(t('web.kv.conflicts'), (r.conflicts || []).length),
      kv(t('web.kv.model'), r.modelId, { mono: true, wide: true }),
      r.error ? kv(t('web.kv.error'), r.error, { wide: true, err: true }) : '',
    ].join('');
  }
  return [
    kv(t('web.kv.phase'), humanize(r.phase)), kv(t('web.kv.run'), r.runs),
    kv(t('web.kv.outcome'), r.outcomeLabel), kv(t('web.kv.next'), r.nextStepName),
    kv(t('web.kv.from_judge'), r.fromJudge === false ? t('web.card.default') : t('web.common.yes')),
    kv(t('web.kv.model'), r.modelId, { mono: true, wide: true }),
    r.error ? kv(t('web.kv.error'), r.error, { wide: true, err: true }) : '',
  ].join('');
}

/* Retry controls inside the drawer — shown only for an agent card in `error`
   while the run is held open in `awaiting_retry`. A timed-out card additionally
   offers a new time limit; any other error just re-runs. */
export function renderDrawerRetry(c, st) {
  const el = $('drawerRetry');
  if (!el) return;
  const r = c && c.raw;
  const inError = c && c.kind === 'agent' && r && r.phase === 'error';
  const awaiting = !!(st && st.status === 'awaiting_retry');
  if (!inError || !awaiting) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  const isTimeout = r.errorKind === 'timeout';
  el.innerHTML =
    `<div class="retry-head ${isTimeout ? 'is-timeout' : 'is-failed'}">` +
      (isTimeout
        ? t('web.retry.timed_out')
        : t('web.retry.failed')) +
    `</div>` +
    (isTimeout
      ? `<label class="retry-tmo">${esc(t('web.retry.new_timeout'))}` +
        `<input id="retryMinutes" class="retry-tmo__input" type="number" min="1" step="1" value="15"></label>`
      : '') +
    `<button class="btn btn--primary retry-go" data-agent="${r.agentId}">` +
      esc(isTimeout ? t('web.retry.go_timeout') : t('web.retry.go')) +
    `</button>`;
}

$('drawerRetry').addEventListener('click', async (e) => {
  const el = /** @type {HTMLElement} */ (e.target);   // click targets inside the drawer are elements
  const btn = el.closest && /** @type {HTMLButtonElement | null} */ (el.closest('.retry-go'));
  if (!btn) return;
  const agentId = +btn.dataset.agent;
  const minEl = /** @type {HTMLInputElement | null} */ ($('retryMinutes'));
  const timeoutMinutes = minEl ? Math.max(1, parseInt(minEl.value, 10) || 0) : undefined;
  btn.disabled = true;
  try {
    await api('/api/run/retry', {
      method: 'POST',
      body: JSON.stringify({ runId: S.activeRunId, agentId, timeoutMinutes }),
    });
    toast(t('web.retry.toast', { id: agentId }));
  } catch (err) {
    toast(err.message, true);
    btn.disabled = false;
  }
});

$('finishBtn').addEventListener('click', async () => {
  try {
    await api('/api/run/finish', { method: 'POST', body: JSON.stringify({ runId: S.activeRunId }) });
    toast(t('web.retry.finishing'));
  } catch (e) {
    toast(e.message, true);
  }
});

/* ---------------- Global run log (live activity console) ---------------- */
const LOG_TAIL = 600; // cap rendered lines so a long multi-run stream stays light

export function setLogOpen(open) {
  S.logOpen = open;
  $('logbar').classList.toggle('open', open);
  $('logToggle').setAttribute('aria-expanded', String(open));
  if (open) renderLog();
}
// The whole header toggles (big target); the level filter handles its own clicks.
$('logHead').addEventListener('click', (e) => {
  if (/** @type {Element} */ (e.target).closest('#logFilter')) return;
  S.logUserToggled = true;
  setLogOpen(!S.logOpen);
});
$('logFilter').addEventListener('click', (e) => {
  const chip = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest('.logfilter__chip'));
  if (!chip) return;
  S.logFilter = chip.dataset.lvl || 'all';
  for (const c of Array.from($('logFilter').children)) c.classList.toggle('is-on', c === chip);
  renderLog();
});
$('logJump').addEventListener('click', () => {
  const b = $('logBody');
  b.scrollTop = b.scrollHeight;
  $('logJump').hidden = true;
});
$('logBody').addEventListener('scroll', () => {
  const b = $('logBody');
  $('logJump').hidden = b.scrollHeight - b.scrollTop - b.clientHeight < 48;
});

// Stable per-agent hue from its id (golden-angle spacing → distinct neighbors).
export function agentHue(id) { return Math.round((id * 137.508) % 360); }

// Map a log entry's agentId to a short, glanceable source chip. Task agents get
// a hue; reserved ids (orchestrator / integration / judge) get a semantic class.
export function logSource(l) {
  const id = l.agentId;
  if (id === 9999) return { label: 'INT', cls: 'int', glyph: '◆' };
  if (id === 9998) return { label: 'JDG', cls: 'jdg' };
  if (id < 0) return { label: 'ORQ', cls: 'orq' };
  if (id >= 0 && id < 9000) return { label: 'A' + String(id).padStart(2, '0'), cls: 'agent', hue: agentHue(id) };
  return { label: (l.kind || 'sys').slice(0, 3).toUpperCase(), cls: 'sys' };
}

// Live, cross-project activity: agents running RIGHT NOW summed over EVERY run
// (not just the viewed one), plus queued tasks and how many projects are live.
// Reserved judge/merge agents count too — they hold budget like any agent, so
// this counter and the topbar budget chip agree while a judge deliberates.
export function liveActivity() {
  let running = 0, queued = 0, projects = 0;
  for (const r of S.runs.values()) {
    if (r.phase !== 'running' || !r.state) continue;
    running += (r.state.activeAgentCount || 0) + (r.state.reservedAgentCount || 0);
    queued += r.state.pendingTaskCount || 0;
    projects += 1;
  }
  return { running, queued, projects };
}

// Build the rendered line model. One live run → just its log. Several → a single
// timestamp-ordered stream with each line tagged by its project (the run's dir).
export function buildLogModel() {
  const runs = [...S.runs.values()].filter((r) => r.state && Array.isArray(r.state.logs));
  if (runs.length <= 1) {
    const st = runs[0] ? runs[0].state : (S.run && S.run.state) || null;
    return { rows: st ? st.logs.map((l) => ({ l, proj: null })) : [], multi: false };
  }
  const rows = [];
  for (const r of runs) {
    const proj = projectName(r.runDirectory) || String(r.runId || '').slice(0, 4);
    for (const l of r.state.logs) rows.push({ l, proj });
  }
  rows.sort((a, b) => (a.l.timestamp || 0) - (b.l.timestamp || 0));
  return { rows, multi: true };
}

export function logLineHtml(l, proj, multi) {
  const t = new Date(l.timestamp).toLocaleTimeString('en-GB');
  const s = logSource(l);
  const lvl = l.level || 'info';
  const glyph = lvl === 'error' ? '✕' : lvl === 'warn' ? '⚠' : (s.glyph || '');
  const hue = s.hue != null ? ` style="--ah:${s.hue}"` : '';
  const tag = multi && proj ? `<span class="logline__proj">${esc(proj)}</span>` : '';
  return `<div class="logline logline--${esc(lvl)} src-${s.cls}"${hue}>` +
    `<span class="logline__t">${t}</span>` +
    `<span class="logline__g">${glyph}</span>` +
    `<span class="logline__chip">${esc(s.label)}</span>` +
    tag +
    `<span class="logline__m">${esc(l.message)}</span>` +
    `</div>`;
}

let logRenderPending = false;
export function scheduleRenderLog() {
  if (logRenderPending) return;
  logRenderPending = true;
  // Trailing timer, not requestAnimationFrame: hidden tabs must still drain
  // (rAF freezes in background tabs; the activity counter would go stale).
  setTimeout(() => { logRenderPending = false; renderLog(); }, 100);
}

export function renderLog() {
  // Header activity — GLOBAL, refreshed on every frame from any run.
  const { running, queued, projects } = liveActivity();
  const act = $('logActivity');
  if (projects > 0) {
    act.hidden = false;
    $('actRunning').textContent = String(running);
    $('actProjects').textContent = projects > 1 ? `· ${t('web.log.projects', { count: projects })}` : '';
    $('actQueued').textContent = queued > 0 ? `· ${t('web.log.queued', { count: queued })}` : '';
    $('logbar').classList.toggle('is-live', running > 0);
  } else {
    act.hidden = true;
    $('logbar').classList.remove('is-live');
  }

  const { rows, multi } = buildLogModel();
  const filtered = S.logFilter === 'all' ? rows : rows.filter((r) => (r.l.level || 'info') === S.logFilter);
  $('logMeta').textContent = filtered.length ? t('web.log.lines', { count: filtered.length }) : '';

  // Auto-open the log the first time a run goes live (unless the user already
  // expressed a preference by toggling it). setLogOpen re-enters renderLog.
  if (running > 0 && !S.logAutoExpanded && !S.logUserToggled) {
    S.logAutoExpanded = true;
    setLogOpen(true);
    return;
  }
  if (!S.logOpen) return;

  const body = $('logBody');
  if (!filtered.length) {
    body.innerHTML = `<div class="logbar__empty">${esc(running > 0 ? t('web.log.waiting_first') : t('web.log.empty'))}</div>`;
    $('logJump').hidden = true;
    return;
  }
  const view = filtered.length > LOG_TAIL ? filtered.slice(-LOG_TAIL) : filtered;
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 48;
  body.innerHTML = view.map(({ l, proj }) => logLineHtml(l, proj, multi)).join('');
  if (atBottom) { body.scrollTop = body.scrollHeight; $('logJump').hidden = true; }
  else $('logJump').hidden = false;
}


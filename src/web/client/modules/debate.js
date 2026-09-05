/* huu web UI — the adversarial debate chat (/dev, `--debate` only).

   TWO SOURCES, ONE CONVERSATION. The debate's two briefs (`A.md` / `B.md`) are
   written INSIDE the debater's own worktree and only reach the canonical
   blackboard path once a merge lands them, so a UI that watched the file would
   see it appear ALREADY FINISHED — never filling. Hence:

     LIVE     the un-throttled `{type:'agent-stream'}` firehose, which is
              literally the advocate and the prosecutor talking while they work.
              Buffered here, per agent id, filtered by the debate's run id.
     SETTLED  `GET /api/dev/debate`, which reads the merged markdown and parses
              it with `src/lib/dev-mode/debate-transcript.ts`. The parse is on
              the SERVER on purpose: this client has no bundler and cannot
              import a `.ts` module, and a hand-written JS twin of that parser
              would be a second set of prose rules to keep in sync.

   ROUNDS NEVER MIX. A second round REWRITES `A.md` whole, so pasting round 2's
   file next to round 1's narration would invent a conversation nobody had. The
   separator is the agent id: a rework arm allocates FRESH ids, so the n-th
   advocate id is the n-th round, each round shows its OWN buffered narration,
   and the settled brief attaches to the LAST round that actually finished.

   This module is DOM-free — it buffers, models and renders to STRINGS, so it
   imports cleanly in Node (see debate.test.js). The /dev surface (dev.js) owns
   every element. Every byte of debate content is LLM prose going to innerHTML:
   it goes through `esc()`, with no exception. */

import { esc } from './utils.js';
import { t } from '../i18n.js';

/** Per-agent ceiling on the buffered narration — a chat shows the tail. */
export const MAX_LIVE_CHARS = 40_000;

/* ---------------- The LIVE half: the agent-stream firehose ---------------- */

/**
 * A bounded, per-agent append buffer.
 *
 * Keyed by agent id ALONE, which is safe only because the caller filters by run
 * id first: agent ids restart at 1 in every run, and an epoch is two runs.
 */
export function createStreamBuffer(maxChars = MAX_LIVE_CHARS) {
  const byAgent = new Map();
  return {
    push(agentId, text) {
      const id = Number(agentId);
      if (!Number.isFinite(id) || typeof text !== 'string' || text === '') return;
      let next = (byAgent.get(id) || '') + text;
      if (next.length > maxChars) next = '…' + next.slice(next.length - maxChars);
      byAgent.set(id, next);
    },
    text(agentId) { return byAgent.get(Number(agentId)) || ''; },
    size() { return byAgent.size; },
    clear() { byAgent.clear(); },
  };
}

/** The buffer the /dev surface feeds and reads. */
export const liveStream = createStreamBuffer();

/**
 * Route one `agent-stream` frame into the debate buffer.
 *
 * Returns true when the frame belonged to a debater, which is what tells the
 * caller a repaint is worth scheduling. Only the `assistant` channel is kept:
 * the thinking trace is verbose and stays console-only, exactly as it is for
 * the run log.
 *
 * @param {{runId?: string, agentId?: number, channel?: string, text?: string}} frame
 * @param {{runId?: string, roles?: Record<string, string>}|null|undefined} debate
 */
export function ingestDebateStream(frame, debate, buffer = liveStream) {
  if (!frame || !debate) return false;
  if (frame.channel !== 'assistant') return false;
  if (String(frame.runId || '') !== String(debate.runId || '')) return false;
  const roles = debate.roles || {};
  if (!roles[String(frame.agentId)]) return false;
  buffer.push(frame.agentId, frame.text);
  return true;
}

/* ---------------- Pure model ---------------- */

/**
 * `{agentId: role}` → the agent ids of each side, ASCENDING.
 *
 * Ascending order is the round order: `nextAgentId` only ever grows, and a
 * revisit of the debate steps allocates fresh ids.
 */
export function roleAgents(roles) {
  const out = { advocate: [], prosecutor: [], gate: [] };
  const src = roles || {};
  for (const key of Object.keys(src)) {
    const list = out[src[key]];
    if (!list) continue;
    const id = Number(key);
    if (Number.isFinite(id)) list.push(id);
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => a - b);
  return out;
}

/** The gate's judge visits, oldest first. `runs` IS the round number. */
export function gateRunsOf(state, gateName) {
  const all = (state && state.checkRuns) || [];
  if (!gateName) return [];
  return all
    .filter((c) => c && c.stepName === gateName)
    .slice()
    .sort((a, b) => (Number(a.runs) || 0) - (Number(b.runs) || 0));
}

/** 'waiting' | 'live' | 'done' | 'error' for one debater's card. */
function turnStatus(agent) {
  if (!agent) return 'waiting';
  if (agent.state === 'error') return 'error';
  if (agent.state === 'done') return 'done';
  return 'live';
}

/**
 * The whole conversation, round by round.
 *
 * @param {{
 *   debate?: {epoch?: number, names?: {advocate:string,prosecutor:string,gate:string}, roles?: Record<string,string>, matchedBy?: string}|null,
 *   state?: any,
 *   transcript?: any,
 *   live?: (agentId: number) => string,
 * }} input
 */
export function buildDebateModel(input) {
  const debate = (input && input.debate) || null;
  if (!debate || !debate.names) return null;
  const state = (input && input.state) || {};
  const live = (input && input.live) || (() => '');
  const transcript = (input && input.transcript) || null;
  const sides = roleAgents(debate.roles);
  const gates = gateRunsOf(state, debate.names.gate);

  const agentById = new Map();
  for (const a of state.agents || []) agentById.set(Number(a.agentId), a);

  const count = Math.max(sides.advocate.length, sides.prosecutor.length, gates.length, 1);
  // The merged file belongs to the last round that actually FINISHED — a round
  // still writing has produced nothing to merge, so attaching the brief to it
  // would show round N-1's text under round N's header.
  //
  // A round that ERRORED is in exactly the same position, and used to be
  // counted here as if it had settled. It never can have: the stage merge takes
  // `s.commitSha && s.state === 'done'` (orchestrator/index.ts) — a crashed
  // agent's branch is not merged at all. So the file the reader would see under
  // a crashed round 2 is round 1's text, attributed to a turn that produced
  // none. The crash gets its OWN body (`web.debate.failed_note`) instead.
  const settledIndex = (ids) => {
    let found = -1;
    for (let i = 0; i < ids.length; i += 1) {
      if (turnStatus(agentById.get(ids[i])) === 'done') found = i;
    }
    return found;
  };
  const aAt = settledIndex(sides.advocate);
  const bAt = settledIndex(sides.prosecutor);

  const turn = (side, agentId, brief) => ({
    side,
    agentId: agentId === undefined ? null : agentId,
    status: turnStatus(agentById.get(agentId)),
    live: agentId === undefined ? '' : String(live(agentId) || ''),
    brief: brief || null,
  });

  const rounds = [];
  for (let i = 0; i < count; i += 1) {
    rounds.push({
      round: i + 1,
      advocate: turn('advocate', sides.advocate[i], i === aAt && transcript ? transcript.advocate : null),
      prosecutor: turn('prosecutor', sides.prosecutor[i], i === bAt && transcript ? transcript.prosecutor : null),
      gate: gates[i] || null,
    });
  }

  return {
    epoch: Number(debate.epoch) || 0,
    matchedBy: debate.matchedBy || 'name',
    rounds,
    transcript,
  };
}

/**
 * A cheap fingerprint of everything that can make the MERGED briefs change.
 *
 * The settled half is a fetch, so it needs a trigger. Polling would work and be
 * dumber; this refetches exactly when the debate moved — a new role stamped, a
 * wave merged, the gate ruled, an epoch landed.
 */
export function debateMark(session, run) {
  const debate = session && session.debate;
  if (!debate) return '';
  const st = (run && run.state) || {};
  return [
    debate.epoch,
    debate.runId,
    Object.keys(debate.roles || {}).length,
    (st.agents || []).filter((a) => a && (a.state === 'done' || a.state === 'error')).length,
    (st.stageIntegrations || []).length,
    (st.checkRuns || []).length,
    (session.epochs || []).length,
    session.phase,
  ].join('/');
}

/* ---------------- Render (strings only — dev.js owns the DOM) ---------------- */

const SIDE_KEY = { advocate: 'web.role.advocate', prosecutor: 'web.role.prosecutor' };
/* ONE STATE, ONE LABEL. `error` used to share `web.debate.settled` with `done`,
   so a debater whose agent CRASHED was announced as "merged brief" — next to a
   body that said the side had chosen to write nothing. Both halves were false
   at once. A failure is its own fact and gets its own word. */
const STATUS_KEY = {
  live: 'web.debate.live',
  waiting: 'web.debate.waiting',
  done: 'web.debate.settled',
  error: 'web.debate.failed',
};

function pre(text) {
  return `<pre class="dbt__raw">${esc(text)}</pre>`;
}

function field(labelKey, value) {
  if (!value) return '';
  return `<div class="dbt__f"><span class="muted">${esc(t(labelKey))}</span><span>${esc(value)}</span></div>`;
}

function ids(list) {
  return (Array.isArray(list) ? list : []).join(', ');
}

/** The record (`A.md`) — decisions and the risks its author accepted. */
function briefAHtml(brief) {
  if (!brief || !brief.present) return `<p class="dbt__note">${esc(t('web.debate.silent'))}</p>`;
  if (!brief.parsed) {
    const missing = (brief.missingSections || []).join(', ');
    return (
      `<p class="dbt__note">${esc(t('web.debate.unparsed'))}` +
      (missing ? ` ${esc(t('web.debate.missing_sections', { list: missing }))}` : '') +
      `</p>${pre(brief.raw || '')}`
    );
  }
  const decisions = (brief.decisions || [])
    .map(
      (d) =>
        `<div class="dbt__item"><div class="dbt__item-h"><code>${esc(d.id)}</code> ${esc(d.title || '')}</div>` +
        field('web.debate.chosen', d.escolhido) +
        field('web.debate.rejected', d.rejeitado) +
        field('web.debate.why', d.porQue) +
        field('web.debate.falsify', d.falsificaria) +
        `</div>`,
    )
    .join('');
  const risks = (brief.risks || []).map((r) => `<li>${esc(r.text)}</li>`).join('');
  return (
    `<div class="dbt__sec">${esc(t('web.debate.decisions'))}</div>${decisions}` +
    (risks ? `<div class="dbt__sec">${esc(t('web.debate.risks'))}</div><ul class="dbt__list">${risks}</ul>` : '')
  );
}

/** The attack (`B.md`) — one verdict per decision, plus the objections. */
function briefBHtml(brief) {
  if (!brief || !brief.present) return `<p class="dbt__note">${esc(t('web.debate.silent'))}</p>`;
  if (!brief.parsed) {
    const missing = (brief.missingSections || []).join(', ');
    return (
      `<p class="dbt__note">${esc(t('web.debate.unparsed'))}` +
      (missing ? ` ${esc(t('web.debate.missing_sections', { list: missing }))}` : '') +
      `</p>${pre(brief.raw || '')}`
    );
  }
  const verdicts = (brief.verdicts || [])
    .map(
      (v) =>
        `<div class="dbt__v dbt__v--${v.label === 'CONTESTADA' ? 'against' : 'for'}">` +
        `<code>${esc(v.decisionId)}</code> <b>${esc(v.label || '?')}</b> ` +
        `<span class="muted">${esc(v.reason || '')}</span></div>`,
    )
    .join('');
  const objections = (brief.objections || [])
    .map(
      (o) =>
        `<div class="dbt__item"><div class="dbt__item-h"><code>${esc(o.decisionId)}</code></div>` +
        field('web.debate.failure', o.falhaPrevista) +
        field('web.debate.evidence', o.evidencia) +
        field('web.debate.cheaper', o.alternativaMaisBarata) +
        `</div>`,
    )
    .join('');
  return (
    `<div class="dbt__sec">${esc(t('web.debate.verdicts'))}</div>${verdicts}` +
    (objections ? `<div class="dbt__sec">${esc(t('web.debate.objections'))}</div>${objections}` : '')
  );
}

function note(key) {
  return `<p class="dbt__note">${esc(t(key))}</p>`;
}

/**
 * What this side has to show: the merged brief, else the live narration.
 *
 * The EMPTY states below are four different facts and must never share a
 * sentence — the reader acts differently on each one:
 *
 *   error   the agent crashed. Nothing of its brief was merged (the stage
 *           merge only takes `done` agents), so there is nothing to look for.
 *   done    finished, and NEITHER source has anything. That is NOT "chose not
 *           to write": the live buffer is memory-only, so round 1 loses its
 *           narration the moment round 2 rewrites `A.md` — and every round
 *           loses it on a reload, or when the panel is opened late. All this
 *           screen honestly knows is that it cannot recover the text.
 *   live    writing right now, has said nothing YET.
 *   waiting not scheduled yet.
 *
 * "This side wrote nothing" is a claim about the DEBATE and is made in exactly
 * one place: `briefAHtml`/`briefBHtml`, on a brief the SERVER read off disk and
 * found absent (`present: false`). That is evidence; a missing buffer is not.
 */
function bodyHtml(turn) {
  if (turn.brief) return turn.side === 'advocate' ? briefAHtml(turn.brief) : briefBHtml(turn.brief);
  if (turn.live) return pre(turn.live);
  if (turn.status === 'error') return note('web.debate.failed_note');
  if (turn.status === 'done') return note('web.debate.unrecoverable');
  return note(turn.status === 'live' ? 'web.debate.empty' : 'web.debate.waiting');
}

function turnHtml(turn) {
  const who = esc(t(SIDE_KEY[turn.side] || 'web.role.advocate'));
  // A merged brief outranks the plain lifecycle word. It cannot collide with a
  // failure: `settledIndex` never hands a brief to a crashed round, because a
  // crashed agent's branch is never merged — pinned by "never hands the merged
  // brief to a round that crashed" in debate.test.js.
  const tag = turn.brief ? t('web.debate.settled') : t(STATUS_KEY[turn.status] || 'web.debate.waiting');
  const mod =
    turn.status === 'live' ? ' is-live' : turn.status === 'error' ? ' is-failed' : '';
  return (
    `<div class="dbt__msg dbt__msg--${esc(turn.side)}${mod}">` +
    `<div class="dbt__who"><span>${who}</span><span class="dbt__tag">${esc(tag)}</span></div>` +
    `<div class="dbt__body">${bodyHtml(turn)}</div></div>`
  );
}

function gateHtml(gate) {
  const body = gate
    ? `<b>${esc(gate.outcomeLabel || '—')}</b>` +
      (gate.reason ? `<div class="dbt__gate-why">${esc(gate.reason)}</div>` : '')
    : `<span class="muted">${esc(t('web.debate.gate_pending'))}</span>`;
  return (
    `<div class="dbt__msg dbt__msg--gate"><div class="dbt__who"><span>${esc(t('web.debate.gate'))}</span></div>` +
    `<div class="dbt__body">${body}</div></div>`
  );
}

/** The coverage the gate actually rules on — shown once, under the last round. */
function coverageHtml(transcript) {
  if (!transcript) return '';
  const parts = [];
  if ((transcript.contestedDecisionIds || []).length) {
    parts.push(esc(t('web.debate.contested', { list: ids(transcript.contestedDecisionIds) })));
  }
  if ((transcript.unjudgedDecisionIds || []).length) {
    parts.push(esc(t('web.debate.unjudged', { list: ids(transcript.unjudgedDecisionIds) })));
  }
  if ((transcript.orphanVerdictIds || []).length) {
    parts.push(esc(t('web.debate.orphans', { list: ids(transcript.orphanVerdictIds) })));
  }
  return parts.length ? `<div class="dbt__cover">${parts.join(' · ')}</div>` : '';
}

/**
 * The whole chat as one HTML string.
 *
 * `model === null` means the session compiled no debate — the caller must not
 * be showing the panel at all, so this renders nothing rather than an empty
 * shell.
 */
export function debateHtml(model, opts) {
  const error = (opts && opts.error) || '';
  if (!model) return error ? `<div class="dev-warn">${esc(error)}</div>` : '';
  const head =
    (model.matchedBy === 'structure'
      ? `<div class="dev-warn">${esc(t('web.debate.matched_structure'))}</div>`
      : '') + (error ? `<div class="dev-warn">${esc(error)}</div>` : '');
  // NOTHING HAS HAPPENED YET is ONE message, not two. The panel used to print
  // "Nothing has been said yet." AND, right under it, a full round-1 skeleton
  // saying both sides had not started and the gate had not ruled — the same
  // fact, three times, in a shape that looked like the debate had already run.
  // The skeleton is what goes: it carries no information the sentence lacks.
  if (
    model.rounds.length === 1 &&
    model.rounds[0].advocate.status === 'waiting' &&
    model.rounds[0].prosecutor.status === 'waiting'
  ) {
    return head + note('web.debate.empty');
  }
  const last = model.rounds.length - 1;
  const rounds = model.rounds
    .map(
      (r, i) =>
        `<div class="dbt__round"><div class="dbt__round-h">${esc(t('web.debate.round', { n: r.round }))}</div>` +
        turnHtml(r.advocate) +
        turnHtml(r.prosecutor) +
        gateHtml(r.gate) +
        (i === last ? coverageHtml(model.transcript) : '') +
        `</div>`,
    )
    .join('');
  return head + rounds;
}

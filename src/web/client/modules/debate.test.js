/* The debate chat's model + renderer. Runs in NODE: modules/debate.js touches
   no DOM (it renders to strings) and the only global it needs is the i18n
   catalog, which `setCatalog` injects — the same recipe as i18n.test.js.

   The REAL English catalog is loaded rather than a hand-written stub, because
   `t()` throws on any key missing from the catalog: that makes this file a
   second net under "every string the chat renders is translated". */

import { describe, expect, it, beforeAll } from 'vitest';
import { setCatalog } from '../i18n.js';
import { webEn } from '../../../lib/i18n/locales/en/web.js';
import {
  buildDebateModel,
  createStreamBuffer,
  debateHtml,
  debateMark,
  gateRunsOf,
  ingestDebateStream,
  roleAgents,
} from './debate.js';

beforeAll(() => {
  setCatalog({ locale: 'en', defaultLocale: 'en', locales: [], messages: { ...webEn } });
});

const NAMES = {
  advocate: 'Sustentar as escolhas',
  prosecutor: 'Contestar as escolhas',
  gate: 'Debate resolvido?',
};

/** A debate as `dev-manager.ts` stamps it onto the session frame. */
function debate(roles, extra) {
  return { epoch: 1, runId: 'run-a', names: NAMES, roles, matchedBy: 'name', ...extra };
}

function agent(id, stageName, state) {
  return { agentId: id, stageName, state };
}

describe('roleAgents', () => {
  it('splits the map by side, ascending — the id order IS the round order', () => {
    const out = roleAgents({ 2: 'prosecutor', 1: 'advocate', 16: 'prosecutor', 15: 'advocate' });
    expect(out.advocate).toEqual([1, 15]);
    expect(out.prosecutor).toEqual([2, 16]);
    expect(out.gate).toEqual([]);
  });

  it('survives an empty, absent or foreign map without throwing', () => {
    expect(roleAgents(null).advocate).toEqual([]);
    expect(roleAgents({ x: 'advocate', 3: 'nonsense' }).advocate).toEqual([]);
  });
});

describe('gateRunsOf', () => {
  const state = {
    checkRuns: [
      { stepName: 'Debate resolvido?', runs: 2, outcomeLabel: 'convergiu' },
      { stepName: 'outro portão', runs: 1, outcomeLabel: 'x' },
      { stepName: 'Debate resolvido?', runs: 1, outcomeLabel: 'contestado' },
    ],
  };

  it('keeps only the gate, oldest visit first', () => {
    const out = gateRunsOf(state, NAMES.gate);
    expect(out.map((c) => c.runs)).toEqual([1, 2]);
    expect(out[0].outcomeLabel).toBe('contestado');
  });

  it('answers nothing when the gate name is unknown', () => {
    expect(gateRunsOf(state, '')).toEqual([]);
    expect(gateRunsOf(null, NAMES.gate)).toEqual([]);
  });
});

describe('createStreamBuffer', () => {
  it('appends per agent and keeps the TAIL when it overflows', () => {
    const buf = createStreamBuffer(10);
    buf.push(1, 'abcde');
    buf.push(1, 'fghij');
    expect(buf.text(1)).toBe('abcdefghij');
    buf.push(1, 'KLM');
    expect(buf.text(1).endsWith('KLM')).toBe(true);
    expect(buf.text(1).length).toBeLessThanOrEqual(11); // 10 + the ellipsis
    expect(buf.text(2)).toBe('');
  });

  it('ignores junk instead of storing it', () => {
    const buf = createStreamBuffer();
    buf.push('nope', 'x');
    buf.push(1, undefined);
    expect(buf.size()).toBe(0);
  });
});

describe('ingestDebateStream', () => {
  const d = debate({ 1: 'advocate', 2: 'prosecutor' });

  it('buffers a debater assistant frame from THIS run', () => {
    const buf = createStreamBuffer();
    expect(ingestDebateStream({ runId: 'run-a', agentId: 1, channel: 'assistant', text: 'hi' }, d, buf)).toBe(true);
    expect(buf.text(1)).toBe('hi');
  });

  // An epoch is TWO runs and agent ids restart at 1 in each, so a frame from
  // the knowledge run would otherwise be spliced into the advocate's turn.
  it('drops a frame from another run, even with a matching agent id', () => {
    const buf = createStreamBuffer();
    expect(ingestDebateStream({ runId: 'run-b', agentId: 1, channel: 'assistant', text: 'x' }, d, buf)).toBe(false);
    expect(buf.size()).toBe(0);
  });

  it('drops non-debaters and the thinking channel', () => {
    const buf = createStreamBuffer();
    expect(ingestDebateStream({ runId: 'run-a', agentId: 7, channel: 'assistant', text: 'x' }, d, buf)).toBe(false);
    expect(ingestDebateStream({ runId: 'run-a', agentId: 1, channel: 'thinking', text: 'x' }, d, buf)).toBe(false);
    expect(buf.size()).toBe(0);
  });

  it('is a no-op when the session carries no debate', () => {
    expect(ingestDebateStream({ runId: 'run-a', agentId: 1, channel: 'assistant', text: 'x' }, null)).toBe(false);
  });
});

describe('buildDebateModel', () => {
  it('is null when the session compiled no debate — the DEFAULT path', () => {
    expect(buildDebateModel({ debate: null })).toBeNull();
    expect(buildDebateModel({})).toBeNull();
  });

  it('renders one round per advocate id and pairs the gate visit with it', () => {
    const model = buildDebateModel({
      debate: debate({ 1: 'advocate', 2: 'prosecutor', 15: 'advocate', 16: 'prosecutor' }),
      state: {
        agents: [
          agent(1, NAMES.advocate, 'done'),
          agent(2, NAMES.prosecutor, 'done'),
          agent(15, NAMES.advocate, 'streaming'),
          agent(16, NAMES.prosecutor, 'idle'),
        ],
        checkRuns: [{ stepName: NAMES.gate, runs: 1, outcomeLabel: 'contestado', reason: 'D2 falhou' }],
      },
      live: (id) => (id === 15 ? 'writing round two' : ''),
    });
    expect(model.rounds).toHaveLength(2);
    expect(model.rounds[0].gate.outcomeLabel).toBe('contestado');
    expect(model.rounds[1].gate).toBeNull();
    expect(model.rounds[0].advocate.status).toBe('done');
    expect(model.rounds[1].advocate.status).toBe('live');
    expect(model.rounds[1].advocate.live).toBe('writing round two');
    // Round 1's narration must NOT leak into round 2's bubble.
    expect(model.rounds[0].advocate.live).toBe('');
  });

  // A second round REWRITES A.md whole, so the file on disk belongs to the last
  // round that FINISHED — never to the one still writing.
  it('attaches the merged brief to the last FINISHED round only', () => {
    const transcript = {
      advocate: { side: 'A', present: true, parsed: true, decisions: [], risks: [] },
      prosecutor: { side: 'B', present: true, parsed: true, verdicts: [], objections: [] },
    };
    const model = buildDebateModel({
      debate: debate({ 1: 'advocate', 2: 'prosecutor', 15: 'advocate', 16: 'prosecutor' }),
      state: {
        agents: [
          agent(1, NAMES.advocate, 'done'),
          agent(2, NAMES.prosecutor, 'done'),
          agent(15, NAMES.advocate, 'streaming'),
          agent(16, NAMES.prosecutor, 'idle'),
        ],
      },
      transcript,
    });
    expect(model.rounds[0].advocate.brief).toBe(transcript.advocate);
    expect(model.rounds[1].advocate.brief).toBeNull();
    expect(model.rounds[1].prosecutor.brief).toBeNull();
  });

  it('shows a single waiting round before either side has been scheduled', () => {
    const model = buildDebateModel({ debate: debate({}) });
    expect(model.rounds).toHaveLength(1);
    expect(model.rounds[0].advocate.status).toBe('waiting');
  });
});

describe('debateMark', () => {
  it('is empty without a debate, and moves when the debate moves', () => {
    expect(debateMark({ phase: 'running' }, null)).toBe('');
    const session = { phase: 'running', debate: debate({ 1: 'advocate' }), epochs: [] };
    const before = debateMark(session, { state: { agents: [], checkRuns: [], stageIntegrations: [] } });
    const after = debateMark(session, {
      state: { agents: [agent(1, NAMES.advocate, 'done')], checkRuns: [], stageIntegrations: [{}] },
    });
    expect(before).not.toBe(after);
  });
});

describe('debateHtml', () => {
  const state = {
    agents: [agent(1, NAMES.advocate, 'done'), agent(2, NAMES.prosecutor, 'done')],
    checkRuns: [{ stepName: NAMES.gate, runs: 1, outcomeLabel: 'convergiu', reason: 'tudo coberto' }],
  };

  it('renders nothing at all when there is no debate', () => {
    expect(debateHtml(null)).toBe('');
  });

  it('renders the structured brief when the parse succeeded', () => {
    const transcript = {
      advocate: {
        side: 'A',
        present: true,
        parsed: true,
        decisions: [
          {
            id: 'D1',
            title: 'stream the parser',
            escolhido: 'streaming',
            rejeitado: 'buffered',
            porQue: 'memory',
            falsificaria: 'a 2x slowdown',
            raw: '',
          },
        ],
        risks: [{ text: 'back-pressure untested' }],
      },
      prosecutor: {
        side: 'B',
        present: true,
        parsed: true,
        verdicts: [{ decisionId: 'D1', label: 'CONTESTADA', reason: 'no benchmark', raw: '' }],
        objections: [
          { decisionId: 'D1', falhaPrevista: 'stalls', evidencia: 'none', alternativaMaisBarata: 'chunking', raw: '' },
        ],
      },
      contestedDecisionIds: ['D1'],
      unjudgedDecisionIds: [],
      orphanVerdictIds: [],
    };
    const html = debateHtml(
      buildDebateModel({ debate: debate({ 1: 'advocate', 2: 'prosecutor' }), state, transcript }),
    );
    expect(html).toContain('stream the parser');
    expect(html).toContain('back-pressure untested');
    expect(html).toContain('CONTESTADA');
    expect(html).toContain('dbt__v--against');
    expect(html).toContain('convergiu');
    expect(html).toContain('D1');
  });

  // parsed:false must degrade to the verbatim markdown, never to a blank panel.
  it('falls back to the RAW markdown when the parse failed', () => {
    const transcript = {
      advocate: { side: 'A', present: true, parsed: false, missingSections: ['riscos'], raw: '## whatever <b>x</b>' },
      prosecutor: { side: 'B', present: false, parsed: false, missingSections: [], raw: '' },
    };
    const html = debateHtml(
      buildDebateModel({ debate: debate({ 1: 'advocate', 2: 'prosecutor' }), state, transcript }),
    );
    expect(html).toContain('dbt__raw');
    expect(html).toContain('## whatever');
    // present:false is a legitimate state — the gate may forward without a brief.
    expect(html).toContain(webEn['web.debate.silent']);
  });

  // LLM prose going to innerHTML is untrusted input, without exception.
  it('escapes every byte of debate content', () => {
    const buf = createStreamBuffer();
    buf.push(2, '<img src=x onerror="alert(1)">');
    const html = debateHtml(
      buildDebateModel({
        debate: debate({ 1: 'advocate', 2: 'prosecutor' }),
        state: {
          agents: [agent(1, NAMES.advocate, 'done'), agent(2, NAMES.prosecutor, 'streaming')],
          checkRuns: [{ stepName: NAMES.gate, runs: 1, outcomeLabel: '<b>hi</b>', reason: '<script>' }],
        },
        live: (id) => buf.text(id),
      }),
    );
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img');
    expect(html).toContain('&lt;b&gt;hi&lt;/b&gt;');
  });

  /* THE FOUR EMPTY STATES ARE FOUR SENTENCES.

     Three of them used to be one. `done` and `error` shared `web.debate.settled`
     on the tag AND `web.debate.silent` in the body, so a debater whose agent
     CRASHED was reported as `Advocate · merged brief` over "this side wrote
     nothing — the gate may still forward": both halves false, and the second
     one an invitation to let the gate through. The same sentence also covered a
     round whose live narration had merely fallen out of memory. */
  const bodyOf = (state, extra) =>
    debateHtml(buildDebateModel({ debate: debate({ 1: 'advocate' }), state, ...extra }));

  it('says "nothing YET" for a side that is still writing', () => {
    expect(bodyOf({ agents: [agent(1, NAMES.advocate, 'streaming')] }))
      .toContain(webEn['web.debate.empty']);
  });

  it('says the AGENT FAILED — never "merged brief", never "wrote nothing"', () => {
    const html = bodyOf({ agents: [agent(1, NAMES.advocate, 'error')] });
    expect(html).toContain(webEn['web.debate.failed']);
    expect(html).toContain(webEn['web.debate.failed_note']);
    expect(html).not.toContain(webEn['web.debate.settled']);
    expect(html).not.toContain(webEn['web.debate.silent']);
    expect(html).toContain('is-failed');
  });

  // A crashed agent's branch is never merged (the stage merge takes
  // `commitSha && state === 'done'`), so the file on disk is some EARLIER
  // round's. Attributing it to the crash would print round N-1's text under
  // round N's header — the very thing the round split exists to prevent.
  it('never hands the merged brief to a round that crashed', () => {
    const transcript = {
      advocate: { side: 'A', present: true, parsed: true, decisions: [], risks: [] },
      prosecutor: { side: 'B', present: true, parsed: true, verdicts: [], objections: [] },
    };
    const model = buildDebateModel({
      debate: debate({ 1: 'advocate', 2: 'prosecutor', 15: 'advocate', 16: 'prosecutor' }),
      state: {
        agents: [
          agent(1, NAMES.advocate, 'done'),
          agent(2, NAMES.prosecutor, 'done'),
          agent(15, NAMES.advocate, 'error'),
          agent(16, NAMES.prosecutor, 'error'),
        ],
      },
      transcript,
    });
    expect(model.rounds[0].advocate.brief).toBe(transcript.advocate);
    expect(model.rounds[1].advocate.brief).toBeNull();
    expect(model.rounds[1].prosecutor.brief).toBeNull();
  });

  /* "Wrote nothing" is a claim about the DEBATE and needs evidence: the server
     read the file and found none. A finished round with no buffered narration
     is a claim about the UI — the live buffer is memory-only, so round 1 loses
     its narration when round 2 rewrites A.md, and every round loses it on a
     reload or when the panel is opened late. */
  it('says the narration is UNRECOVERABLE, not that the side stayed quiet', () => {
    const html = bodyOf({ agents: [agent(1, NAMES.advocate, 'done')] });
    expect(html).toContain(webEn['web.debate.unrecoverable']);
    expect(html).not.toContain(webEn['web.debate.silent']);
  });

  it('keeps round 1 honest once round 2 has taken the merged brief', () => {
    const transcript = {
      advocate: { side: 'A', present: true, parsed: true, decisions: [], risks: [] },
      prosecutor: { side: 'B', present: false, parsed: false, missingSections: [], raw: '' },
    };
    const html = debateHtml(
      buildDebateModel({
        debate: debate({ 1: 'advocate', 2: 'prosecutor', 15: 'advocate', 16: 'prosecutor' }),
        state: {
          agents: [
            agent(1, NAMES.advocate, 'done'),
            agent(2, NAMES.prosecutor, 'done'),
            agent(15, NAMES.advocate, 'done'),
            agent(16, NAMES.prosecutor, 'done'),
          ],
        },
        transcript,
        // Round 2 is the one still in the buffer; round 1's is long gone.
        live: (id) => (id === 16 ? 'round two, live' : ''),
      }),
    );
    // Round 1 has no source at all — and says exactly that.
    expect(html).toContain(webEn['web.debate.unrecoverable']);
    // And the ONE place "wrote nothing" appears is the brief the server read
    // off disk and found absent.
    expect(html).toContain(webEn['web.debate.silent']);
  });

  // Nothing has happened yet is ONE message. It used to be the sentence PLUS a
  // full round-1 skeleton restating it twice more.
  it('shows the empty sentence alone, with no phantom round under it', () => {
    const html = debateHtml(buildDebateModel({ debate: debate({}) }));
    expect(html).toContain(webEn['web.debate.empty']);
    expect(html).not.toContain('dbt__round');
    expect(html).not.toContain(webEn['web.debate.gate_pending']);
    expect(html).not.toContain(webEn['web.debate.waiting']);
  });

  it('says out loud when the steps were found by SHAPE instead of by name', () => {
    const html = debateHtml(
      buildDebateModel({ debate: debate({ 1: 'advocate' }, { matchedBy: 'structure' }), state }),
    );
    expect(html).toContain(webEn['web.debate.matched_structure']);
  });
});

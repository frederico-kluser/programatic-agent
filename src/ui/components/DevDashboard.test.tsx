/**
 * What this file proves.
 *
 * TWO halves, and the second one is the one a regression would ride in on.
 *
 *  1. The PURE view reducer the board renders from — cards follow the
 *     orchestrator as it allocates agents mid-flight, an epoch change is
 *     ANNOUNCED so an emptied board never reads as a bug, and the narrative is
 *     bounded so a long session cannot grow without limit.
 *
 *  2. The IMPURE Ink bridge, `createDevDashboardPresenter`, MOUNTED FOR REAL
 *     against a fake stdin and with `process.stdout` / `process.stderr`
 *     captured at the process level. That half exists because of a hole this
 *     file used to have: the whole feature rests on "the board paints on
 *     stderr, never stdout", and until these tests landed NOTHING executed the
 *     line that chooses the stream. Flipping `process.stderr` to
 *     `process.stdout` in the presenter left tsc, the entire suite and the
 *     smoke script green while `huu dev --cli` poured 650 KB of ANSI into the
 *     byte stream a script parses. The tests below fail on exactly that edit —
 *     that IS their acceptance criterion.
 *
 * Ink DOES mount under vitest (no `ink-testing-library` needed): `render()`
 * takes the streams as options, so a `PassThrough` dressed up as a raw-mode
 * TTY is a complete stdin and the process streams can be swapped underneath it.
 * What still is NOT covered here is the LAYOUT against a real terminal size and
 * a real dev session — that remains `scripts/smoke-dev-dashboard.tsx`'s job.
 */

import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  LOG_CAP,
  applyDevUpdate,
  createDevDashboardPresenter,
  emptyDevView,
  epochDivider,
  phaseLabel,
  type DevDashboardView,
} from './DevDashboard.js';
import type { AgentStatus, OrchestratorState, Pipeline } from '../../lib/types.js';
import type { DevEpochRecord } from '../../lib/types.js';

const PIPELINE: Pipeline = {
  name: 'epoch-1',
  steps: [{ name: '0. recon', prompt: 'look', files: [] }],
};

function agent(id: number, state: AgentStatus['state']): AgentStatus {
  return {
    agentId: id,
    stageIndex: 0,
    stageName: '0. recon',
    state,
    branch: `huu/r/agent-${id}`,
    worktree: `/tmp/wt-${id}`,
    filesModified: [],
    logs: [`agent ${id} log`],
    actionCounts: {},
  } as unknown as AgentStatus;
}

function runState(agents: AgentStatus[]): OrchestratorState {
  return {
    status: 'running',
    agents,
    logs: [],
    currentStage: 1,
    totalStages: 1,
    completedTasks: 0,
    totalTasks: agents.length,
    concurrency: agents.length,
    elapsedMs: 1_000,
    startedAt: Date.now(),
    totalCost: 0,
    integrationStatus: { conflicts: [] },
    stageIntegrations: [],
    checkRuns: [],
  } as unknown as OrchestratorState;
}

function started(view: DevDashboardView, epoch: number): DevDashboardView {
  return applyDevUpdate(view, {
    kind: 'run-started',
    epoch,
    phase: 'work',
    pipeline: PIPELINE,
    runId: `run-${epoch}`,
  });
}

describe('applyDevUpdate — the live board follows the run', () => {
  it('adopts every new agent the orchestrator allocates mid-flight', () => {
    // THE POINT OF THE BOARD. Tasks are decomposed while the stage runs, so a
    // surface that snapshotted the agent list once would show a frozen board
    // for the rest of the epoch.
    let view = started(emptyDevView(), 1);
    view = applyDevUpdate(view, { kind: 'run-state', state: runState([agent(1, 'streaming')]) });
    expect(view.run?.agents).toHaveLength(1);

    view = applyDevUpdate(view, {
      kind: 'run-state',
      state: runState([agent(1, 'done'), agent(2, 'streaming'), agent(3, 'idle')]),
    });
    expect(view.run?.agents.map((a) => a.agentId)).toEqual([1, 2, 3]);
  });

  it('never mutates the view it was given', () => {
    const before = started(emptyDevView(), 1);
    const linesBefore = before.lines.length;
    const after = applyDevUpdate(before, { kind: 'log', line: 'x' });
    expect(after).not.toBe(before);
    expect(before.lines).toHaveLength(linesBefore);
  });
});

describe('applyDevUpdate — an epoch change is announced, not implied', () => {
  it('clears the board AND drops a marker naming the new epoch', () => {
    let view = started(emptyDevView(), 1);
    view = applyDevUpdate(view, { kind: 'run-state', state: runState([agent(1, 'done')]) });
    expect(view.run).not.toBeNull();

    view = started(view, 2);
    // Emptied — the previous epoch's cards belong to the previous epoch…
    expect(view.run).toBeNull();
    // …and the reason is IN the narrative, which is what stops it reading as
    // "the board bugged".
    const marker = view.lines.at(-1);
    expect(marker).toEqual({ kind: 'epoch', epoch: 2, phase: 'work' });
    expect(view.epoch).toBe(2);
  });

  it('keeps one badge per epoch, in order, and lands it from epoch-done', () => {
    let view = started(emptyDevView(), 1);
    expect(view.epochs).toEqual([{ epoch: 1, status: 'running' }]);

    // The knowledge run and the work run are both epoch 1: two `run-started`,
    // still ONE badge.
    view = applyDevUpdate(view, {
      kind: 'run-started',
      epoch: 1,
      phase: 'knowledge',
      pipeline: PIPELINE,
      runId: 'run-k',
    });
    expect(view.epochs).toHaveLength(1);

    const record = {
      epoch: 1,
      runId: 'run-1',
      epochGoal: 'g',
      frontIds: [],
      status: 'done',
      landedCommit: 'abcdef1234567890',
      startedAt: 'a',
      finishedAt: 'b',
    } as DevEpochRecord;
    view = applyDevUpdate(view, { kind: 'event', event: { type: 'epoch-done', record } });
    expect(view.epochs).toEqual([{ epoch: 1, status: 'landed', detail: 'abcdef12' }]);

    view = started(view, 2);
    expect(view.epochs.map((b) => b.epoch)).toEqual([1, 2]);
  });

  it('reports a landing failure as a failed badge carrying the reason', () => {
    let view = started(emptyDevView(), 1);
    view = applyDevUpdate(view, {
      kind: 'event',
      event: {
        type: 'epoch-done',
        record: {
          epoch: 1,
          runId: 'r',
          epochGoal: 'g',
          frontIds: [],
          status: 'error',
          landingError: 'merge conflict',
          startedAt: 'a',
          finishedAt: 'b',
        } as DevEpochRecord,
      },
    });
    expect(view.epochs[0]).toEqual({ epoch: 1, status: 'failed', detail: 'merge conflict' });
  });

  it('labels the planning stretch, when no orchestrator exists at all', () => {
    // Phase B runs no orchestrator, and it is the longest a user stares at an
    // empty board. Leaving `phase` on the previous run would label that wait
    // with the wrong activity.
    let view = started(emptyDevView(), 1);
    view = applyDevUpdate(view, { kind: 'run-state', state: runState([agent(1, 'streaming')]) });
    view = applyDevUpdate(view, { kind: 'event', event: { type: 'planning', epoch: 2 } });
    expect(view.phase).toBe('planning');
    expect(view.pipeline).toBeNull();
    expect(view.run).toBeNull();
    expect(view.lines.at(-1)).toEqual({ kind: 'epoch', epoch: 2, phase: 'planning' });
  });

  it('records the stop reason so the header can say the session ended', () => {
    const view = applyDevUpdate(emptyDevView(), {
      kind: 'event',
      event: { type: 'stopped', reason: 'max-epochs', detail: 'reached the ceiling' },
    });
    expect(view.stopped).toEqual({ reason: 'max-epochs', detail: 'reached the ceiling' });
  });

  it('ignores the events `describeEvent` already funnels into the narrative', () => {
    // Rendering them here too would print every line twice.
    const before = started(emptyDevView(), 1);
    const after = applyDevUpdate(before, {
      kind: 'event',
      event: { type: 'log', level: 'warn', message: 'careful' },
    });
    expect(after).toEqual(before);
  });
});

describe('applyDevUpdate — bounded narrative and the gate', () => {
  it('keeps only the last LOG_CAP entries', () => {
    let view = emptyDevView();
    for (let i = 0; i < LOG_CAP + 25; i += 1) {
      view = applyDevUpdate(view, { kind: 'log', line: `line ${i}` });
    }
    expect(view.lines).toHaveLength(LOG_CAP);
    expect(view.lines.at(-1)).toEqual({ kind: 'log', text: `line ${LOG_CAP + 24}` });
  });

  it('opens and closes the y/N gate', () => {
    let view = applyDevUpdate(emptyDevView(), { kind: 'question', question: 'Rodar a época 1?' });
    expect(view.question).toBe('Rodar a época 1?');
    view = applyDevUpdate(view, { kind: 'question', question: null });
    expect(view.question).toBeNull();
  });

  it('marks the run as over without throwing the last board away', () => {
    let view = started(emptyDevView(), 1);
    view = applyDevUpdate(view, { kind: 'run-state', state: runState([agent(1, 'done')]) });
    view = applyDevUpdate(view, { kind: 'run-ended' });
    // The DONE column has to stay readable while the driver lands the epoch.
    expect(view.runActive).toBe(false);
    expect(view.run?.agents).toHaveLength(1);
  });
});

describe('epochDivider', () => {
  it('fills the pane whatever the translated label is', () => {
    for (const label of ['epoch 2 · execution', 'época 2 · execução']) {
      expect(epochDivider(label, 80)).toHaveLength(80);
    }
  });

  it('never collapses to nothing on an absurdly narrow pane', () => {
    expect(epochDivider('epoch 2 · execution', 4).endsWith('───')).toBe(true);
  });
});

describe('phaseLabel', () => {
  it('has a label for every phase the board can be in', () => {
    for (const phase of ['planning', 'bootstrap', 'knowledge', 'work'] as const) {
      expect(phaseLabel(phase).length).toBeGreaterThan(0);
    }
  });
});

// ───────────── the Ink bridge, mounted: stdout is a machine contract ─────────

/**
 * `huu dev` writes ONE machine-readable JSON object on stdout and nothing else.
 * Ink's `render()` defaults to `process.stdout`, so the presenter is exactly
 * one `??` away from destroying that contract forever — and a fake presenter
 * (which is what `dev-cli.test.ts` injects) writes to no stream at all, so it
 * can never notice.
 *
 * These tests therefore build the REAL presenter, with NO `stdout` option, so
 * the `?? process.stderr` default is the line under test.
 */
describe('createDevDashboardPresenter — the board never writes to stdout', () => {
  const GOAL = 'objetivo do teste';

  const SESSION = {
    goal: GOAL,
    repoRoot: '/tmp/repo-do-teste',
    modelId: 'stub-model',
    backend: 'stub',
    maxEpochs: 2,
  };

  /**
   * A stdin Ink will accept in RAW MODE. `isTTY` is what Ink reads to decide
   * `isRawModeSupported`; `setRawMode`/`ref`/`unref` are the three methods it
   * calls that a plain `PassThrough` does not have.
   */
  function fakeRawTty(): NodeJS.ReadStream & { rawMode: boolean } {
    const stream = new PassThrough() as unknown as NodeJS.ReadStream & { rawMode: boolean };
    Object.assign(stream, {
      isTTY: true,
      rawMode: false,
      setRawMode(value: boolean) {
        stream.rawMode = value;
        return stream;
      },
      ref: () => stream,
      unref: () => stream,
    });
    return stream;
  }

  /**
   * Swap BOTH process streams for recorders around `body`, and hand back what
   * each of them received. Process-level rather than stream-level on purpose:
   * the presenter picks its stream itself, and intercepting the pick is exactly
   * the mistake that made the old coverage vacuous.
   */
  async function withCapturedStdio(
    body: () => Promise<void>,
  ): Promise<{ stdout: string; stderr: string }> {
    const out: string[] = [];
    const errs: string[] = [];
    const realOut = process.stdout.write.bind(process.stdout);
    const realErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      errs.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await body();
    } finally {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
    }
    return { stdout: out.join(''), stderr: errs.join('') };
  }

  /** Ink enables raw mode from an effect, one tick after the mount. */
  async function waitForRawMode(stdin: { rawMode: boolean }): Promise<void> {
    for (let i = 0; i < 200 && !stdin.rawMode; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  /**
   * Type `y` until the gate answers. ONE keystroke would be a race, not a
   * flake to paper over: `useInput`'s handler closes over the view it was
   * rendered with, so a key that lands before React has flushed the effects of
   * the repaint that OPENED the gate is read by the previous frame's handler —
   * which sees `question === null` and drops it. Repeating is what a human
   * does too, and every extra key after the answer is a no-op.
   */
  async function typeUntilAnswered(
    stdin: NodeJS.ReadStream,
    pending: Promise<boolean>,
  ): Promise<boolean> {
    let settled = false;
    const watched = pending.then((value) => {
      settled = true;
      return value;
    });
    for (let i = 0; i < 200 && !settled; i += 1) {
      (stdin as unknown as PassThrough).write('y');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return watched;
  }

  it('paints a whole session on stderr and leaves stdout byte-empty', async () => {
    const stdin = fakeRawTty();
    const captured = await withCapturedStdio(async () => {
      // No `stdout:` option — THAT is the point. The default is under test.
      const presenter = createDevDashboardPresenter({
        stdin,
        debug: true,
        onQuit: () => undefined,
      });
      presenter.session(SESSION);
      presenter.runStarted({ epoch: 1, phase: 'work', pipeline: PIPELINE, runId: 'run-1' });
      presenter.runState(runState([agent(1, 'streaming'), agent(2, 'done')]));
      presenter.log('uma linha de narrativa');
      presenter.runEnded();
      await presenter.close();
    });

    // Non-vacuous FIRST: a board that painted nothing anywhere would satisfy
    // the stdout assertion for the wrong reason.
    expect(captured.stderr).toContain('╭');
    expect(captured.stderr).toContain(GOAL);
    expect(captured.stderr).toContain('uma linha de narrativa');
    // …and THE CONTRACT: not one byte on the stream a script parses.
    expect(captured.stdout).toBe('');
  });

  it('keeps stdout empty through a y/N gate answered by a real keystroke', async () => {
    // The gate is the one moment the board owns stdin AND repaints out of the
    // throttle cycle — and `confirm()` is the seam `dev-cli.ts` hands its
    // readline prompts to. A fake presenter cannot exercise either.
    const stdin = fakeRawTty();
    let answered: boolean | null = null;
    const captured = await withCapturedStdio(async () => {
      const presenter = createDevDashboardPresenter({
        stdin,
        debug: true,
        onQuit: () => undefined,
      });
      presenter.session(SESSION);
      await waitForRawMode(stdin);
      answered = await typeUntilAnswered(stdin, presenter.confirm('Rodar a época 1?'));
      await presenter.close();
    });

    expect(answered).toBe(true);
    expect(captured.stderr).toContain('Rodar a época 1?');
    expect(captured.stdout).toBe('');
  });

  it('mounts on a NON-TTY stdin instead of throwing — the raw-mode guard', async () => {
    // `useInput({ isActive: Boolean(isRawModeSupported) })` is load-bearing:
    // Ink only skips raw mode when `isActive` is strictly `false`, and
    // `stdin.isTTY` is UNDEFINED (not false) on a pipe. Without the `Boolean`
    // the board threw "Raw mode is not supported" the moment it mounted with
    // stdin redirected — which is every CI shell.
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    const captured = await withCapturedStdio(async () => {
      const presenter = createDevDashboardPresenter({
        stdin,
        debug: true,
        onQuit: () => undefined,
      });
      presenter.session(SESSION);
      presenter.log('sem tty, ainda assim desenha');
      await presenter.close();
    });

    expect(captured.stderr).toContain(GOAL);
    expect(captured.stderr).toContain('sem tty, ainda assim desenha');
    expect(captured.stderr).not.toContain('Raw mode is not supported');
    expect(captured.stdout).toBe('');
  });
});

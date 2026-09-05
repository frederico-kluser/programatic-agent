/**
 * THE LIVE BOARD OF A DEV SESSION — `huu dev "<objetivo>" --cli`.
 *
 * `huu dev` is headless by design: human-readable progress on stderr, ONE
 * machine-readable JSON object on stdout at the end. That contract is not
 * negotiable, so this surface does NOT replace it — it renders the same
 * human-readable channel as a kanban, and stdout is left completely alone.
 * Two consequences shape everything below:
 *
 *  1. **Ink renders to stderr here**, never stdout. `render()` defaults to
 *     `process.stdout`, which is exactly the byte stream a script parses, so
 *     the presenter passes `process.stderr` as Ink's output stream. With the
 *     board on or off, `huu dev`'s stdout is byte-identical.
 *  2. **The gates move inside the frame.** Ink holds stdin in raw mode; the
 *     `readline` prompts `dev-cli.ts` uses for `--approve-each`, the resume
 *     offer and the orphan-branch offer would fight it for keystrokes. The
 *     presenter answers `DevCliPresenter.confirm()` with an overlay instead.
 *
 * The module is split in three so the interesting half is testable without an
 * Ink renderer (huu ships none): a PURE view model + reducer
 * ({@link applyDevUpdate}), a pure component that renders it, and the impure
 * Ink bridge ({@link createDevDashboardPresenter}).
 *
 * `theme.ai` (magenta) is the chrome on purpose. It is reserved for AI-driven
 * UI, and dev mode is the most AI-driven surface huu has — a planner writes
 * the pipeline at run time.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, render, useInput, useStdin, useStdout } from 'ink';
import type { OrchestratorState, Pipeline } from '../../lib/types.js';
import type { DevCliPresenter } from '../../lib/dev-mode/dev-cli.js';
import type { DevEvent, DevRunPhase } from '../../lib/dev-mode/dev-driver.js';
import { RunKanban } from './RunKanban.js';
import { LogArea } from './LogArea.js';
import { MorphLoader, MorphMark } from './MorphLoader.js';
import { formatCost } from '../../lib/format-cost.js';
import { theme } from '../theme.js';
import { t, translate } from '../../lib/i18n/index.js';

// ───────────────────────────── the view model ────────────────────────────────

/**
 * What the header calls the current activity. `'planning'` is not a
 * {@link DevRunPhase} — no orchestrator exists during Phase B — but it is the
 * longest stretch a user stares at an empty board, so it gets a label.
 */
export type DevPhaseLabel = DevRunPhase | 'planning';

/** One entry of the session narrative. Translated at RENDER time, never here. */
export type DevLogLine =
  | { kind: 'log'; text: string }
  | { kind: 'epoch'; epoch: number; phase: DevPhaseLabel };

/** How one epoch of the session ended up, for the header strip. */
export interface DevEpochBadge {
  epoch: number;
  status: 'running' | 'landed' | 'failed';
  /** Short commit for `landed`, the failure reason for `failed`. */
  detail?: string;
}

export interface DevDashboardView {
  goal: string;
  repoRoot: string;
  modelId: string;
  backend: string;
  maxEpochs: number;
  /** Session narrative, newest last, capped at {@link LOG_CAP}. */
  lines: DevLogLine[];
  epochs: DevEpochBadge[];
  epoch: number | null;
  phase: DevPhaseLabel | null;
  runId: string | null;
  /** The compiled pipeline of the live run — `RunKanban` cannot render without it. */
  pipeline: Pipeline | null;
  run: OrchestratorState | null;
  /** False once the run resolved; the last board stays up while the epoch lands. */
  runActive: boolean;
  /** Non-null while a y/N gate is waiting for a keystroke. */
  question: string | null;
  stopped: { reason: string; detail?: string } | null;
}

/** Every mutation the presenter can apply. Keep it total — the reducer switches on it. */
export type DevViewUpdate =
  | {
      kind: 'session';
      goal: string;
      repoRoot: string;
      modelId: string;
      backend: string;
      maxEpochs: number;
    }
  | { kind: 'log'; line: string }
  | { kind: 'event'; event: DevEvent }
  | {
      kind: 'run-started';
      epoch: number;
      phase: DevRunPhase;
      pipeline: Pipeline;
      runId: string;
    }
  | { kind: 'run-state'; state: OrchestratorState }
  | { kind: 'run-ended' }
  | { kind: 'question'; question: string | null };

/**
 * How many narrative entries are retained. A long session emits thousands of
 * lines and only the tail is ever rendered; keeping the whole history would
 * grow without bound for no visible benefit.
 */
export const LOG_CAP = 300;

export function emptyDevView(): DevDashboardView {
  return {
    goal: '',
    repoRoot: '',
    modelId: '',
    backend: '',
    maxEpochs: 0,
    lines: [],
    epochs: [],
    epoch: null,
    phase: null,
    runId: null,
    pipeline: null,
    run: null,
    runActive: false,
    question: null,
    stopped: null,
  };
}

function pushLine(lines: readonly DevLogLine[], line: DevLogLine): DevLogLine[] {
  const next = [...lines, line];
  return next.length > LOG_CAP ? next.slice(next.length - LOG_CAP) : next;
}

/** Insert-or-replace, keyed on the epoch number and kept in ascending order. */
function upsertBadge(
  badges: readonly DevEpochBadge[],
  badge: DevEpochBadge,
): DevEpochBadge[] {
  const idx = badges.findIndex((b) => b.epoch === badge.epoch);
  if (idx < 0) return [...badges, badge].sort((a, b) => a.epoch - b.epoch);
  const next = [...badges];
  next[idx] = badge;
  return next;
}

/**
 * The whole surface's state transition, PURE — no Ink, no clock, no i18n.
 *
 * Two behaviours here are the ones a user actually judges the board by:
 *
 *  • **Cards appear as tasks are born.** `run-state` simply adopts the newest
 *    `OrchestratorState`; the orchestrator allocates agent ids mid-flight and
 *    the board follows, because nothing here caches or freezes an agent list.
 *  • **An epoch change is announced, not implied.** Every `run-started` and
 *    every `planning` event drops an `epoch` marker into the narrative and
 *    clears `run`, so a board that empties reads as "epoch N+1 is starting",
 *    not as "the board broke".
 */
export function applyDevUpdate(
  view: DevDashboardView,
  update: DevViewUpdate,
): DevDashboardView {
  switch (update.kind) {
    case 'session':
      return {
        ...view,
        goal: update.goal,
        repoRoot: update.repoRoot,
        modelId: update.modelId,
        backend: update.backend,
        maxEpochs: update.maxEpochs,
      };

    case 'log':
      return { ...view, lines: pushLine(view.lines, { kind: 'log', text: update.line }) };

    case 'run-started':
      return {
        ...view,
        epoch: update.epoch,
        phase: update.phase,
        pipeline: update.pipeline,
        runId: update.runId,
        // Cleared on purpose: the previous run's cards belong to the previous
        // run. The marker line below is what tells the user why.
        run: null,
        runActive: true,
        epochs: upsertBadge(view.epochs, { epoch: update.epoch, status: 'running' }),
        lines: pushLine(view.lines, {
          kind: 'epoch',
          epoch: update.epoch,
          phase: update.phase,
        }),
      };

    case 'run-state':
      return { ...view, run: update.state };

    case 'run-ended':
      return { ...view, runActive: false };

    case 'question':
      return { ...view, question: update.question };

    case 'event':
      return applyDevEvent(view, update.event);
  }
}

function applyDevEvent(view: DevDashboardView, event: DevEvent): DevDashboardView {
  switch (event.type) {
    case 'planning':
      return {
        ...view,
        epoch: event.epoch,
        phase: 'planning',
        pipeline: null,
        run: null,
        runActive: false,
        epochs: upsertBadge(view.epochs, { epoch: event.epoch, status: 'running' }),
        lines: pushLine(view.lines, { kind: 'epoch', epoch: event.epoch, phase: 'planning' }),
      };

    case 'epoch-done': {
      const { record } = event;
      const badge: DevEpochBadge = record.landedCommit
        ? { epoch: record.epoch, status: 'landed', detail: record.landedCommit.slice(0, 8) }
        : {
            epoch: record.epoch,
            status: 'failed',
            ...(record.landingError ? { detail: record.landingError } : { detail: record.status }),
          };
      return { ...view, epochs: upsertBadge(view.epochs, badge) };
    }

    case 'stopped':
      return {
        ...view,
        stopped: { reason: event.reason, ...(event.detail ? { detail: event.detail } : {}) },
      };

    // Everything else already reaches the narrative through `describeEvent`,
    // which `dev-cli.ts` funnels into `log`. Rendering it twice would double
    // every line.
    default:
      return view;
  }
}

// ────────────────────────────── presentation ─────────────────────────────────

const PHASE_KEY: Record<DevPhaseLabel, string> = {
  planning: 'tui.dev.phase_planning',
  knowledge: 'tui.dev.phase_knowledge',
  bootstrap: 'tui.dev.phase_bootstrap',
  work: 'tui.dev.phase_work',
};

/** Locale-aware label for a phase. Deliberately outside the pure reducer. */
export function phaseLabel(phase: DevPhaseLabel): string {
  return translate(PHASE_KEY[phase]);
}

const BADGE_COLOR: Record<DevEpochBadge['status'], string> = {
  running: theme.aiAccent,
  landed: theme.success,
  failed: theme.error,
};

const BADGE_MARK: Record<DevEpochBadge['status'], string> = {
  running: '●',
  landed: '✔',
  failed: '✖',
};

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * `── epoch 2 · execution ────…` padded to the pane width. Measured from the
 * TRANSLATED label rather than a fixed offset: `epoch` and `época` are not the
 * same length, and a hard-coded pad leaves a ragged rule in one of the locales.
 */
export function epochDivider(label: string, width: number): string {
  const prefix = `── ${label} `;
  return prefix + '─'.repeat(Math.max(3, width - prefix.length));
}

/** Width of the run-log sidebar; mirrors `RunDashboard`'s own budget. */
const LOG_SIDEBAR_WIDTH = 42;
const LOG_SIDEBAR_MIN_TERMINAL_COLS = 100;
/**
 * Same 60% ceiling `RunDashboard` uses: the board may never grow so tall that
 * the header (which epoch, which phase) or the footer scroll off screen.
 */
const KANBAN_HEIGHT_RATIO = 0.6;
/** border(2) + column title(1) + marginTop(1) + one row of slack for wrapping. */
const KANBAN_COLUMN_CHROME_ROWS = 5;

export interface DevDashboardProps {
  view: DevDashboardView;
  /** Answers an open gate. Ignored when `view.question` is null. */
  onAnswer: (yes: boolean) => void;
  /** Ctrl+C — the only key that ends a dev session from here. */
  onQuit: () => void;
}

export function DevDashboard({ view, onAnswer, onQuit }: DevDashboardProps): React.JSX.Element {
  const { stdout } = useStdout();
  const { isRawModeSupported } = useStdin();
  const [terminalRows, setTerminalRows] = useState<number>(() => stdout.rows ?? 24);
  const [terminalCols, setTerminalCols] = useState<number>(() => stdout.columns ?? 80);
  useEffect(() => {
    const handler = (): void => {
      setTerminalRows(stdout.rows ?? 24);
      setTerminalCols(stdout.columns ?? 80);
    };
    stdout.on('resize', handler);
    return () => {
      stdout.off('resize', handler);
    };
  }, [stdout]);

  // The kanban renders live elapsed timers off a `nowMs` snapshot rather than
  // one interval per card. 1 Hz is enough resolution for MM:SS.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    id.unref?.();
    return () => clearInterval(id);
  }, []);

  // Raw mode is unavailable when stdin is not a TTY (a pipe, CI, the smoke
  // script). Ink THROWS if `useInput` tries to enable it there, so the hook is
  // gated instead of the component — the board still renders, it just cannot
  // be typed at. `confirm()` never reaches this surface in that case: dev-cli
  // answers a non-TTY gate with NO before consulting any presenter.
  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c') {
        onQuit();
        return;
      }
      if (view.question === null) return;
      // Same answer set as the headless `confirm()`: y/s means yes, anything
      // else — including ENTER — means no.
      onAnswer(input === 'y' || input === 'Y' || input === 's' || input === 'S');
    },
    // `Boolean` is load-bearing: Ink reads `isRawModeSupported` off
    // `stdin.isTTY`, which is UNDEFINED (not false) on a pipe — and `useInput`
    // only skips raw mode when `isActive` is strictly `false`. Passing the raw
    // value through made Ink throw "Raw mode is not supported" the moment the
    // board mounted with stdin redirected.
    { isActive: Boolean(isRawModeSupported) },
  );

  const lastLogByAgent = useMemo(() => {
    const map = new Map<number, string>();
    for (const a of view.run?.agents ?? []) {
      const last = a.logs[a.logs.length - 1];
      if (last) map.set(a.agentId, last);
    }
    return map;
  }, [view.run]);

  const maxKanbanRows = Math.max(5, Math.floor(terminalRows * KANBAN_HEIGHT_RATIO));
  const maxCardRows = Math.max(3, maxKanbanRows - KANBAN_COLUMN_CHROME_ROWS);
  // What is left after header(2) + footer(1) + the session box's own chrome(3).
  const sessionLogRows = Math.max(2, Math.min(8, terminalRows - maxKanbanRows - 6));
  const showLogSidebar = terminalCols >= LOG_SIDEBAR_MIN_TERMINAL_COLS;

  // A gate replaces the whole frame. The plan the user is being asked to
  // approve arrived through the narrative, and a 4-line log pane cannot show
  // it — so the overlay gives the tail of the session everything it has.
  if (view.question !== null) {
    return (
      <Box flexDirection="column" width="100%">
        <SessionLog
          lines={view.lines}
          rows={Math.max(4, terminalRows - 7)}
          cols={terminalCols}
        />
        <Box
          borderStyle="round"
          borderColor={theme.warning}
          paddingX={1}
          flexDirection="column"
          width="100%"
        >
          <Text bold color={theme.warning}>
            {t('tui.dev.gate_title')}
          </Text>
          <Text>{view.question}</Text>
          <Text dimColor>{t('tui.dev.gate_hint')}</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width="100%">
      <DevHeader view={view} cols={terminalCols} />
      <Box flexDirection="row" height={maxKanbanRows} flexShrink={0}>
        {view.run && view.pipeline ? (
          <RunKanban
            agents={view.run.agents}
            pipeline={view.pipeline}
            defaultModelId={view.modelId}
            focusedKey={null}
            nowMs={nowMs}
            lastLogByAgent={lastLogByAgent}
            stageIntegrations={view.run.stageIntegrations}
            checkRuns={view.run.checkRuns}
            maxCardRows={maxCardRows}
          />
        ) : (
          <Box
            borderStyle="round"
            borderColor={theme.ai}
            paddingX={1}
            flexGrow={1}
            alignItems="center"
            justifyContent="center"
          >
            <MorphLoader label={waitingLabel(view)} />
          </Box>
        )}
        {showLogSidebar && view.run && (
          <LogArea
            logs={view.run.logs}
            maxLines={maxCardRows}
            runStartedAt={view.run.startedAt || undefined}
            width={LOG_SIDEBAR_WIDTH}
          />
        )}
      </Box>
      <SessionLog lines={view.lines} rows={sessionLogRows} cols={terminalCols} />
      <Box paddingX={1} width="100%">
        <Text dimColor>
          {t('tui.dev.hint_live')} · <Text bold>Ctrl+C</Text> {t('tui.dev.hint_quit')}
        </Text>
      </Box>
    </Box>
  );
}

/** What the empty board says it is waiting for — never a blank rectangle. */
function waitingLabel(view: DevDashboardView): string {
  if (view.epoch === null || view.phase === null) return t('tui.dev.session_waiting');
  if (view.phase === 'planning') return t('tui.dev.board_planning', { epoch: view.epoch });
  return t('tui.dev.board_waiting', { phase: phaseLabel(view.phase), epoch: view.epoch });
}

function DevHeader({ view, cols }: { view: DevDashboardView; cols: number }): React.JSX.Element {
  const run = view.run;
  const elapsed = Math.floor((run?.elapsedMs ?? 0) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');
  return (
    <Box flexDirection="column" width="100%">
      <Box paddingX={1} width="100%" flexWrap="wrap">
        <MorphMark active={view.stopped === null} />
        <Text> </Text>
        <Text bold color={theme.ai}>
          {t('tui.dev.title')}
        </Text>
        <Text dimColor>{'  ·  '}</Text>
        <Text>
          {t('tui.dev.goal')}{' '}
          <Text bold color={theme.aiAccent}>
            {truncate(view.goal, Math.max(20, cols - 42))}
          </Text>
        </Text>
        <Text dimColor>{'  ·  '}</Text>
        <Text>
          <Text bold>{view.modelId}</Text> ({view.backend})
        </Text>
        {run && (
          <>
            <Text dimColor>{'  ·  '}</Text>
            <Text>
              {t('tui.dash.stage')}{' '}
              <Text bold>
                {run.currentStage}/{run.totalStages}
              </Text>
            </Text>
            <Text dimColor>{'  ·  '}</Text>
            <Text>
              {t('tui.dash.concurrency')} <Text bold color={theme.warning}>{run.concurrency}</Text>
            </Text>
            <Text dimColor>{'  ·  '}</Text>
            <Text>
              {t('tui.dash.elapsed')} {mm}:{ss}
            </Text>
            <Text dimColor>{'  ·  '}</Text>
            <Text>
              {run.completedTasks}/{run.totalTasks} {t('tui.dash.done')}
            </Text>
            {run.totalCost > 0 && (
              <>
                <Text dimColor>{'  ·  '}</Text>
                <Text>
                  {t('tui.dash.cost')}{' '}
                  <Text bold color={theme.success}>
                    {formatCost(run.totalCost)}
                  </Text>
                </Text>
              </>
            )}
            {!view.runActive && (
              <>
                <Text dimColor>{'  ·  '}</Text>
                <Text color={theme.warning}>{t('tui.dev.run_over')}</Text>
              </>
            )}
          </>
        )}
      </Box>
      <Box paddingX={1} width="100%" flexWrap="wrap">
        <Text dimColor>{t('tui.dev.epochs')}: </Text>
        {view.epochs.length === 0 ? (
          <Text dimColor>—</Text>
        ) : (
          view.epochs.map((badge) => (
            <Text key={badge.epoch}>
              <Text color={BADGE_COLOR[badge.status]}>
                {BADGE_MARK[badge.status]} {badge.epoch}
              </Text>
              <Text dimColor>
                {' '}
                {badge.status === 'landed'
                  ? t('tui.dev.badge_landed', { commit: badge.detail ?? '' })
                  : badge.status === 'failed'
                  ? `${t('tui.dev.badge_failed')}${badge.detail ? ` (${truncate(badge.detail, 40)})` : ''}`
                  : t('tui.dev.badge_running')}
                {'   '}
              </Text>
            </Text>
          ))
        )}
        {view.epoch !== null && (
          <Text>
            <Text dimColor>{'  ·  '}</Text>
            {t('tui.dev.epoch')} <Text bold color={theme.aiAccent}>{view.epoch}</Text>{' '}
            {t('tui.dev.of_max', { max: view.maxEpochs })}
            {view.phase !== null && (
              <Text color={theme.ai}> [{phaseLabel(view.phase)}]</Text>
            )}
          </Text>
        )}
        {view.stopped && (
          <Text color={theme.warning}>
            <Text dimColor>{'  ·  '}</Text>
            {t('tui.dev.stopped', { reason: view.stopped.reason })}
          </Text>
        )}
      </Box>
    </Box>
  );
}

/**
 * The session narrative — the driver's own voice (planning, knowledge, epoch
 * landings, warnings), as opposed to the agent logs the sidebar shows.
 */
function SessionLog({
  lines,
  rows,
  cols,
}: {
  lines: readonly DevLogLine[];
  rows: number;
  cols: number;
}): React.JSX.Element {
  const visible = lines.slice(-rows);
  const width = Math.max(20, cols - 4);
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.ai}
      paddingX={1}
      width="100%"
    >
      <Text bold color={theme.ai}>
        {t('tui.dev.session_title')}
      </Text>
      {visible.length === 0 ? (
        <Text dimColor>{t('tui.dev.session_waiting')}</Text>
      ) : (
        visible.map((line, i) =>
          line.kind === 'epoch' ? (
            <Text key={i} bold color={theme.aiAccent}>
              {epochDivider(
                t('tui.dev.epoch_divider', {
                  epoch: line.epoch,
                  phase: phaseLabel(line.phase),
                }),
                width,
              )}
            </Text>
          ) : (
            <Text key={i} dimColor>
              {truncate(line.text.replace(/\s+/g, ' ').trim(), width)}
            </Text>
          ),
        )
      )}
    </Box>
  );
}

// ─────────────────────────── the Ink bridge (impure) ─────────────────────────

/**
 * Repaint budget. The orchestrator emits hundreds of states per second under
 * concurrency; repainting on each one starves Ink's stdin pump (the same
 * reason `RunDashboard` throttles at 125 ms) and floods stderr.
 */
export const DEV_FLUSH_INTERVAL_MS = 125;

export interface DevDashboardPresenterOptions {
  /**
   * Where the board is painted. Defaults to **stderr** — see the module
   * header: stdout is a machine contract and Ink must never touch it.
   */
  stdout?: NodeJS.WriteStream;
  stdin?: NodeJS.ReadStream;
  /** Ink's non-destructive mode: every frame appended instead of replacing. */
  debug?: boolean;
  /** Ctrl+C. Defaults to unmounting and exiting 130, like an unhandled SIGINT. */
  onQuit?: () => void;
}

/**
 * Mount the board and hand back the seam `runDevCli` drives it through.
 *
 * Lives here rather than in `src/cli.tsx` so the CLI's dev branch stays three
 * lines, and cannot live in `src/lib/dev-mode/` at all: `lib` never imports
 * `ui`. `src/cli.tsx` is the one layer allowed to know about both.
 */
export function createDevDashboardPresenter(
  options: DevDashboardPresenterOptions = {},
): DevCliPresenter {
  const stream = options.stdout ?? (process.stderr as unknown as NodeJS.WriteStream);
  let view = emptyDevView();
  let dirty = false;
  let answer: ((yes: boolean) => void) | null = null;
  let closed = false;

  const handleAnswer = (yes: boolean): void => {
    const resolve = answer;
    if (!resolve) return;
    answer = null;
    view = applyDevUpdate(view, { kind: 'question', question: null });
    flush();
    resolve(yes);
  };

  const element = (): React.JSX.Element => (
    <DevDashboard view={view} onAnswer={handleAnswer} onQuit={() => quit()} />
  );

  const instance = render(element(), {
    stdout: stream,
    stdin: options.stdin ?? process.stdin,
    patchConsole: false,
    // Ink's own Ctrl+C handler only UNMOUNTS, which would leave a dev session
    // running with no face and no way back. The keystroke is handled by the
    // component instead.
    exitOnCtrlC: false,
    ...(options.debug ? { debug: true } : {}),
  });

  function flush(): void {
    dirty = false;
    if (!closed) instance.rerender(element());
  }

  const quit = (): void => {
    instance.unmount();
    if (options.onQuit) {
      options.onQuit();
      return;
    }
    // 130 = the conventional shell code for "terminated by SIGINT", which is
    // exactly what Ctrl+C did to `huu dev` before this surface existed.
    process.exit(130);
  };

  const timer = setInterval(() => {
    if (dirty) flush();
  }, DEV_FLUSH_INTERVAL_MS);
  timer.unref?.();

  const push = (update: DevViewUpdate): void => {
    view = applyDevUpdate(view, update);
    dirty = true;
  };

  return {
    session(info) {
      push({ kind: 'session', ...info });
      flush();
    },
    log(line) {
      push({ kind: 'log', line });
    },
    event(event) {
      push({ kind: 'event', event });
    },
    runStarted(info) {
      push({ kind: 'run-started', ...info });
      flush();
    },
    runState(state) {
      push({ kind: 'run-state', state });
    },
    runEnded() {
      push({ kind: 'run-ended' });
      flush();
    },
    confirm(question) {
      return new Promise<boolean>((resolve) => {
        answer = resolve;
        push({ kind: 'question', question });
        // A gate is the one update that must not wait for the repaint tick.
        flush();
      });
    },
    async close() {
      if (closed) return;
      clearInterval(timer);
      flush();
      closed = true;
      // Ink throttles its own renders at 32 ms; give the last frame a window to
      // reach the terminal before the instance tears the reconciler down.
      await new Promise((resolve) => setTimeout(resolve, DEV_FLUSH_INTERVAL_MS));
      instance.unmount();
    },
  };
}

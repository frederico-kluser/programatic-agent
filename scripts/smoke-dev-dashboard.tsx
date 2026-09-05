/**
 * Smoke test for the `huu dev --cli` board — the sibling of
 * `scripts/smoke-dashboard.tsx`, and a step of `scripts/gate.sh`.
 *
 *     npx tsx scripts/smoke-dev-dashboard.tsx      # ~46 s, see the gate note
 *
 * WHY THIS EXISTS. A unit test can mount Ink (see the tail of
 * `src/ui/components/DevDashboard.test.tsx`), but it cannot prove that a REAL
 * dev session — a real orchestrator, a real pipeline, real git worktrees, two
 * epochs and an epoch-to-epoch transition — still ends with a clean stdout and
 * a board that actually drew cards. This script does, with the stub backend in
 * a throwaway git repo.
 *
 * THE CONTRACT IT GUARDS. `huu dev` writes ONE machine-readable JSON object on
 * stdout and nothing else; scripts parse it. Ink's `render()` defaults to
 * `process.stdout`, so the board is one `??` away from destroying that stream
 * forever. This script therefore builds the presenter WITHOUT a `stdout:`
 * option — the `?? process.stderr` default is the line under test — and
 * captures `process.stdout` / `process.stderr` at the PROCESS level. An earlier
 * version passed `stdout: captured`, which meant it exercised the override and
 * never the default: it stayed green with the board pointed at stdout.
 *
 * It also drives the board through `presenterFactory`, the same lazy seam
 * `src/cli.tsx` uses, so the mount happens where the CLI mounts it: after
 * `runDevCli` has had every chance to refuse the flags.
 *
 * On a real terminal the frames are TEED to it, so a human watches the live
 * board while the script still measures every byte. With stderr redirected
 * (CI, a pipe, an agent shell) it renders in Ink's `debug` mode — every frame
 * appended in plain text — into a stand-in 140x44 terminal, and prints the LAST
 * FRAME plus a frame count at the end.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initI18n, t } from '../src/lib/i18n/index.js';
import { createDevDashboardPresenter } from '../src/ui/components/DevDashboard.js';
import { runDevCli } from '../src/lib/dev-mode/dev-cli.js';

initI18n(process.env);

const GOAL = 'documentar o fluxo de execucao do smoke';

/** A throwaway repository — dev mode commits its blackboard, so it needs one. */
function scratchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'huu-smoke-dev-'));
  const git = (...args: string[]): void => {
    execFileSync('git', args, {
      cwd: dir,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'huu smoke',
        GIT_AUTHOR_EMAIL: 'smoke@huu.invalid',
        GIT_COMMITTER_NAME: 'huu smoke',
        GIT_COMMITTER_EMAIL: 'smoke@huu.invalid',
      },
    });
  };
  git('init', '-b', 'main');
  git('config', 'user.name', 'huu smoke');
  git('config', 'user.email', 'smoke@huu.invalid');
  writeFileSync(join(dir, 'README.md'), '# smoke\n', 'utf8');
  writeFileSync(join(dir, 'src.ts'), 'export const smoke = true;\n', 'utf8');
  git('add', '-A');
  git('commit', '-m', 'init');
  return dir;
}

/**
 * What the board reads to lay itself out. A redirected stderr reports no size
 * at all, and Ink's 80x24 fallback is too narrow for the kanban to show cards —
 * so the script lends it a plausible terminal instead of measuring a layout no
 * user has. The stream OBJECT stays `process.stderr`: swapping it for a fake
 * is exactly what made the old version of this script vacuous.
 */
function lendTerminalSize(columns: number, rows: number): void {
  Object.assign(process.stderr, { columns, rows });
}

interface Captured {
  /** Every chunk written to the machine-contract stream. Must be one JSON. */
  stdout: string[];
  /** Every chunk written to the human stream — the board's frames. */
  stderr: string[];
  restore: () => void;
}

/**
 * Record both process streams. `tee` keeps a real terminal painting while the
 * bytes are still counted; without it a developer running this on a TTY would
 * stare at a frozen screen for the whole session.
 */
function captureStdio(tee: boolean): Captured {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const realStdout = process.stdout.write.bind(process.stdout);
  const realStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr.push(String(chunk));
    if (tee) realStderr(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return {
    stdout,
    stderr,
    restore: () => {
      process.stdout.write = realStdout;
      process.stderr.write = realStderr;
    },
  };
}

async function main(): Promise<void> {
  const repo = scratchRepo();
  const live = Boolean(process.stderr.isTTY);
  if (!live) lendTerminalSize(140, 44);

  const io = captureStdio(live);

  let code = 1;
  try {
    code = await runDevCli({
      args: [
        GOAL,
        '--stub',
        // Two epochs: the epoch-to-epoch transition is half of what this board
        // has to make legible, and one epoch would never exercise it.
        '--epochs=2',
        // The knowledge phase needs a model; the stub plan does not.
        '--skip-knowledge',
        '--no-resume',
        `--run-dir=${repo}`,
      ],
      cwd: repo,
      backend: 'stub',
      // THE SAME SEAM `src/cli.tsx` USES. No `stdout:` option — the presenter's
      // `?? process.stderr` default is what this script exists to measure.
      presenterFactory: () =>
        createDevDashboardPresenter({
          ...(live ? {} : { debug: true }),
          // Never let the smoke script take the process down on a stray keystroke.
          onQuit: () => undefined,
        }),
    });
  } finally {
    io.restore();
    rmSync(repo, { recursive: true, force: true });
  }

  const stdout = io.stdout.join('');
  const stderr = io.stderr.join('');
  const drawn = io.stderr.filter((f) => f.includes('╭'));

  if (!live) {
    const last = drawn[drawn.length - 1] ?? '';
    process.stderr.write(
      `\n[SMOKE] stderr writes: ${io.stderr.length} · drawn frames: ${drawn.length}\n`,
    );
    process.stderr.write(`[SMOKE] stdout writes: ${io.stdout.length} · ${stdout.length} bytes\n`);
    process.stderr.write('[SMOKE] last drawn frame:\n');
    process.stderr.write(last.endsWith('\n') ? last : `${last}\n`);
  }

  // Does stdout hold exactly the machine verdict, and nothing else?
  let verdict: { sessionId?: string; epochs?: unknown[] } | null = null;
  try {
    verdict = JSON.parse(stdout) as { sessionId?: string; epochs?: unknown[] };
  } catch {
    verdict = null;
  }

  // Five assertions: three for the board a user has to read, two for the byte
  // stream a script has to parse.
  const checks: Array<[string, boolean]> = [
    ['rendered at least one frame', drawn.length > 0],
    [
      'the kanban columns appeared (cards, not just the loader)',
      stderr.includes(t('tui.kanban.col_doing')),
    ],
    [
      'the epoch-2 transition was announced in the session log',
      stderr.includes(t('tui.dev.epoch_divider', { epoch: 2, phase: t('tui.dev.phase_work') })),
    ],
    // THE CONTRACT. Not "stdout looks fine" — stdout PARSES, in ONE write, and
    // carries the fields a script reads. With the board pointed at stdout this
    // is 600+ KB of ANSI and `JSON.parse` throws.
    [
      'stdout is exactly ONE json object — the machine verdict',
      io.stdout.length === 1 && verdict !== null && Array.isArray(verdict.epochs),
    ],
    [
      'stdout carries no terminal control bytes at all',
      !stdout.includes('\u001B') && !stdout.includes('╭'),
    ],
  ];
  let failed = false;
  for (const [label, ok] of checks) {
    process.stderr.write(`[SMOKE] ${ok ? 'OK  ' : 'FAIL'} ${label}\n`);
    if (!ok) failed = true;
  }

  process.stderr.write(`[SMOKE] runDevCli exit code: ${code}\n`);
  if (failed) {
    // The first 400 bytes of a polluted stdout say more than any message.
    process.stderr.write(`[SMOKE] stdout head: ${JSON.stringify(stdout.slice(0, 400))}\n`);
    process.exit(1);
  }
  // The verdict was captured, not swallowed: hand it to the real stdout so this
  // script stays as pipe-friendly as the command it exercises.
  process.stdout.write(stdout);
  process.exit(code === 0 ? 0 : 1);
}

void main();

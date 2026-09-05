/**
 * `npm start`, reordered so the user can actually be asked something.
 *
 * ## The ordering bug this file exists to fix
 *
 * The old script was:
 *
 * ```
 * "start": "./scripts/ensure-image.sh && HUU_IMAGE=… tsx src/cli.tsx"
 * ```
 *
 * `ensure-image.sh` runs a `docker build` BEFORE the CLI exists, and `&&`
 * makes its exit status a veto. Two measured consequences:
 *
 *   · daemon stopped → the script exits 1 → the `&&` cuts → **the CLI never
 *     runs**. That is precisely why huu could not offer "want to run without
 *     Docker?" — the Docker failure happened before any question could exist.
 *   · user prefers native → the image was built for nothing.
 *
 * So the order is inverted here: **ask first, build second, and only if the
 * answer needs an image.** `npm start` stays ONE command; what changed is who
 * is in charge of it.
 *
 * ```
 *   setup gate  →  decideReexec (flag > env > saved config)  →  build?  →  CLI
 *      ↑ host terminal            ↑ pure, testable            ↑ only when
 *        the flow needs                                         the run will
 *                                                               land in Docker
 * ```
 *
 * The *stale-image trap* the `ensure-image.sh` header documents is preserved
 * exactly where it matters: whenever the run WILL execute in the container, the
 * image is refreshed from the working tree first, and a failed build still
 * stops the start — it just gets to explain itself and offer a way forward
 * instead of vanishing behind a severed `&&`.
 *
 * Every side effect is injected so the decision table can be tested in Node
 * with no Docker, no terminal and no child process. `createStartDeps` supplies
 * the real ones.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { decideReexec, isDockerInstalled } from './docker-reexec.js';
import { t } from './i18n/index.js';
import { setupGateEnv, SETUP_SUBCOMMAND } from './setup-flow.js';
import { createStdioPrompter, isInteractiveStdin, runSetupGate, type SetupGateResult } from './setup-prompt.js';

/**
 * The CLI entrypoint this wrapper launches, repo-root-relative.
 *
 * One path literal, prefix included, rather than a `join(root, …, <basename>)`
 * whose last segment is the bare file name. That basename is KEY-SHAPED and
 * sits in the `cli.` namespace, so the i18n coverage scanner
 * (`i18n/coverage.test.ts`) would read it as a translation key and fail the
 * suite over a message that does not exist. The `src/` prefix takes the literal
 * out of the namespace — cheap, and it keeps the path in one readable piece.
 */
const CLI_ENTRYPOINT = 'src/cli.tsx';

/** Exit code for "the user interrupted us" — the shell's own convention. */
export const EXIT_SIGINT = 130;

export interface StartDeps {
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Run the first-run setup and report the choices in force afterwards. */
  gate: (args: string[], env: NodeJS.ProcessEnv) => Promise<SetupGateResult>;
  /**
   * Is the `docker` binary even installed? Asked BEFORE the build, because a
   * missing docker makes `ensure-image.sh` exit 0 with a warning — the start
   * would otherwise glide past the failure and die later, inside the re-exec,
   * with no offer of a way forward.
   */
  dockerAvailable: () => boolean;
  /** Refresh `huu:local` from the working tree. Returns a process exit code. */
  buildImage: (env: NodeJS.ProcessEnv) => number;
  /** Ask a yes/no. `null` when there is nobody to ask. */
  confirm: (text: string) => Promise<boolean | null>;
  /** Start the actual CLI and wait for it. Returns its exit code. */
  spawnCli: (args: string[], env: NodeJS.ProcessEnv) => Promise<number>;
  write: (line: string) => void;
}

/**
 * The whole of `npm start`, as a function.
 *
 * Returns the exit code the wrapper should exit with. Never throws: a thrown
 * error here would be a `npm start` that dies before saying why, which is the
 * exact failure this module was written to remove.
 */
export async function runStart(deps: StartDeps): Promise<number> {
  const { args, env } = deps;

  const gate = await deps.gate(args, env);
  if (gate.outcome.aborted) return EXIT_SIGINT;

  // `npm start setup` (or `npm start -- setup`) configures and stops — the gate
  // above already did the work, and there is nothing left to launch.
  if (args.find((a) => !a.startsWith('-')) === SETUP_SUBCOMMAND) return 0;

  // The child inherits the pin `npm start` has always applied, the marker
  // saying the gate already ran (so `cli.tsx` does not open the same
  // conversation a second time) and — the part that keeps the two processes
  // honest — THE CHOICES THE GATE JUST RESOLVED.
  //
  // Without that last piece the wrapper decides from memory while the child
  // re-reads the disk, and the two agree only for as long as the write
  // succeeded. `markSetupComplete` is best-effort: an unwritable config dir (a
  // `sudo npm start` that left `config.json` owned by root is enough) makes it
  // return false, and the measured result was both axes inverted in a single
  // start — the wrapper honouring `interface=cli, runtime=native`, SKIPPING the
  // image build, and the child re-execing into Docker anyway. A `docker run`
  // with no preceding build is the stale-image trap `ensure-image.sh` exists to
  // close, so the user would have been running whatever the last build baked,
  // in a container they had just asked not to use.
  //
  // `setupGateEnv` carries the pair at the CONFIG tier (see SETUP_GATE_ENV):
  // NOT as `HUU_NO_DOCKER` / `HUU_CLI`, which are the ENV tier and would
  // outrank `--docker` — the one thing that must keep beating a saved `native`.
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    HUU_IMAGE: env.HUU_IMAGE ?? 'huu:local',
    ...setupGateEnv(gate.config),
  };

  // THE decision, made once, by the same pure function the CLI itself uses,
  // over the same inputs the child will see — so "will this build an image?"
  // and "will this run in a container?" can never disagree.
  const decision = decideReexec(args, childEnv, gate.config);

  if (!decision.shouldReexec) {
    // Only say it when the user actually chose the host. `--help` and
    // `huu status` are native too and have no business mentioning images.
    if (decision.nativeByChoice) deps.write(t('cli.start_skip_build_native'));
    return deps.spawnCli(args, childEnv);
  }

  // Two different ways Docker can be unusable, ONE way out of both.
  //
  // `docker` not installed at all: `ensure-image.sh` deliberately warns and
  // exits 0 there (so `huu status` and `--help` keep working), so the build's
  // status cannot detect this case — ask first.
  if (!deps.dockerAvailable()) {
    deps.write(t('cli.start_docker_missing'));
    return offerNativeOrStop(deps, args, childEnv, 127);
  }

  // Installed but broken: daemon stopped, socket permission, a failed build.
  // `ensure-image.sh` has already printed its own diagnosis above.
  const buildCode = deps.buildImage(childEnv);
  if (buildCode !== 0) {
    deps.write(t('cli.start_image_failed'));
    return offerNativeOrStop(deps, args, childEnv, buildCode);
  }

  return deps.spawnCli(args, childEnv);
}

/**
 * The offer the severed `&&` made impossible: "Docker is not going to work —
 * run on the host instead?"
 *
 * A yes runs natively FOR THIS INVOCATION ONLY, through the env var. Not the
 * saved config: the user answered a question about right now, and env is
 * precisely the precedence tier that outranks the standing preference without
 * overwriting it. Anything else — a no, or nobody there to answer — stops with
 * the failure's own exit code and says what to fix.
 */
async function offerNativeOrStop(
  deps: StartDeps,
  args: string[],
  childEnv: NodeJS.ProcessEnv,
  failureCode: number,
): Promise<number> {
  const yes = await deps.confirm(t('cli.start_offer_native'));
  if (yes !== true) {
    deps.write(t('cli.start_docker_required'));
    return failureCode;
  }
  childEnv.HUU_NO_DOCKER = '1';
  deps.write(t('cli.start_native_accepted'));
  return deps.spawnCli(args, childEnv);
}

// ─────────────────────────── the real side effects ───────────────────────────

/**
 * Refresh `huu:local` by running `scripts/ensure-image.sh`.
 *
 * A missing script is NOT a failure: an installed huu has no repo to build
 * from, and there the wrapper resolves a published image instead. Only a script
 * that ran and failed vetoes the start.
 */
export function buildImageWithScript(repoRoot: string, env: NodeJS.ProcessEnv): number {
  const script = join(repoRoot, 'scripts', 'ensure-image.sh');
  if (!existsSync(script)) return 0;
  const r = spawnSync('bash', [script], { stdio: 'inherit', env });
  if (r.error) return 1;
  return r.status ?? 1;
}

/** Path to the repo-local `tsx`, falling back to whatever is on PATH. */
export function resolveTsxBin(repoRoot: string): string {
  const local = join(repoRoot, 'node_modules', '.bin', 'tsx');
  return existsSync(local) ? local : 'tsx';
}

/**
 * Start `tsx src/cli.tsx` and wait for it.
 *
 * `stdio: 'inherit'` hands the terminal straight to the CLI, so the TUI, the
 * web banner and Ctrl+C all behave exactly as they did when `npm start` invoked
 * tsx directly. The parent IGNORES the terminal signals on purpose: they reach
 * the child through the shared process group, and a parent that dies first
 * would orphan the run and hide its exit code.
 */
export function spawnCliProcess(
  repoRoot: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise<number>((resolve) => {
    const child = spawn(resolveTsxBin(repoRoot), [join(repoRoot, CLI_ENTRYPOINT), ...args], {
      stdio: 'inherit',
      env,
    });
    const ignore = () => {};
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    for (const sig of signals) process.on(sig, ignore);
    const cleanup = () => {
      for (const sig of signals) process.removeListener(sig, ignore);
    };
    child.on('error', () => {
      cleanup();
      resolve(1);
    });
    child.on('exit', (code, signal) => {
      cleanup();
      // A child killed by a signal reports 128+n, the shell's convention.
      if (signal) resolve(128 + (signal === 'SIGINT' ? 2 : signal === 'SIGTERM' ? 15 : 1));
      else resolve(code ?? 0);
    });
  });
}

/**
 * Wire {@link runStart} to the real world. Kept here (and not in `scripts/`) so
 * it is type-checked and reachable from the test suite — `tsconfig.json` only
 * includes `src/**`.
 */
export function createStartDeps(
  repoRoot: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): StartDeps {
  return {
    args,
    env,
    gate: (a, e) => runSetupGate({ args: a, env: e }),
    dockerAvailable: isDockerInstalled,
    buildImage: (e) => buildImageWithScript(repoRoot, e),
    confirm: async (text: string) => {
      if (!isInteractiveStdin()) return null;
      const prompter = createStdioPrompter();
      try {
        const answer = await prompter.ask({ text });
        if (answer === null) return null;
        const v = answer.trim().toLowerCase();
        return v === 'y' || v === 'yes' || v === 's' || v === 'sim';
      } finally {
        prompter.close();
      }
    },
    spawnCli: (a, e) => spawnCliProcess(repoRoot, a, e),
    write: (line) => process.stderr.write(line + '\n'),
  };
}

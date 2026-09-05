#!/usr/bin/env node
// Top-level docker re-exec gate. Must be evaluated BEFORE the Ink/React
// imports below so that on the host (re-exec path) we don't pay the
// cost of mounting React or pulling in the LLM SDKs we never use.
//
// The check is intentionally placed before any other side-effect:
// running `huu` in a host shell should be indistinguishable from
// running it inside the container — the only thing the user notices
// is a slightly slower first invocation while the image pulls.
import { resolve as resolvePath } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import {
  decideReexec,
  hasNativeBypass,
  isDevNativeMode,
  reexecInDocker,
} from './lib/docker-reexec.js';
import { ensureSurfKeysInContainer } from './lib/surf-research.js';
import { decideCgroupWrap, reexecInCgroupScope } from './lib/cgroup-self-wrap.js';
import { API_KEY_REGISTRY, configFilePath } from './lib/api-key.js';
import { preflightGitOnHost } from './lib/git-preflight.js';
// Pure, dependency-light: safe to load on the wrapper path without pulling
// in React/Ink (which we deliberately avoid until after the re-exec gate).
import { decideInterfaceMode, resolveWebPort } from './web/interface-mode.js';
import { applyOomScoreAdj } from './lib/oom-score.js';
import { startOomChildWatcher } from './lib/oom-child-watcher.js';
// Dependency-free (no React, no SDKs) — safe on the wrapper path.
import { initI18n, t } from './lib/i18n/index.js';

// Resolve the locale and AUDIT the catalogs before anything is printed. A key
// missing a translation in any shipped locale aborts here, loudly, instead of
// surfacing as a half-English screen three menus in. `HUU_I18N_STRICT=0`
// downgrades it to a warning. `HUU_LANG=pt-BR` (or the POSIX LANG chain)
// selects the language.
initI18n(process.env);

// `--dir=<path>` chooses WHERE to run — the default is the current directory.
// Honor it at the very top (before the Docker gate) so every downstream
// consumer — the container mount, the host git preflight, the web/headless
// working dir and the TUI repo root — sees the chosen directory through
// `process.cwd()`. Runtime folder-picking (web/TUI) threads a per-run cwd
// instead; this flag only moves the process baseline.
{
  const dirArg = process.argv.slice(2).find((a) => a.startsWith('--dir='));
  if (dirArg) {
    const target = resolvePath(dirArg.slice('--dir='.length));
    if (!existsSync(target) || !statSync(target).isDirectory()) {
      process.stderr.write(t('cli.err_dir_not_directory', { path: target }) + '\n');
      process.exit(1);
    }
    process.chdir(target);
  }
}

const reexec = decideReexec(process.argv.slice(2), process.env);
if (reexec.shouldReexec) {
  // Defensive: with the bypasses honored in decideReexec (--yolo/--no-docker/
  // HUU_NO_DOCKER), no bypass can coexist with a re-exec — any of them
  // short-circuits before this branch. Belt-and-suspenders in case a future
  // bypass spelling ever diverges from decideReexec's own checks.
  if (hasNativeBypass(process.argv.slice(2), process.env)) {
    process.stderr.write(t('cli.warn_native_removed') + '\n');
  }
  // Host-side git preflight: fail fast BEFORE pulling/launching docker.
  // Also discovers any git paths (worktree common-dir, parent toplevel)
  // that the wrapper must additionally bind-mount so `git` resolves
  // inside the container with only `-v <cwd>:<cwd>` otherwise in effect.
  const pre = preflightGitOnHost(process.cwd());
  if (!pre.ok) {
    process.stderr.write(pre.message);
    process.exit(1);
  }
  // Web is the default front-end. When the run will land in the container,
  // publish the web port so the host browser reaches the in-container
  // server, and pin HUU_WEB_PORT so both sides agree on the number.
  const webMode = decideInterfaceMode(process.argv.slice(2), process.env) === 'web';
  const webPort = resolveWebPort(process.argv.slice(2), process.env);
  if (webMode) {
    process.env.HUU_WEB_PORT = String(webPort);
    process.stderr.write(
      '\n' +
        t('cli.web_launching', { url: `\x1b[1mhttp://localhost:${webPort}\x1b[0m` }) +
        '\n     ' +
        t('cli.web_prefer_tui', { command: '\x1b[1mhuu --cli\x1b[0m' }) +
        '\n\n',
    );
  }
  // Top-level await is fine here: tsconfig targets ES2022 / ESNext
  // module, both of which support it. The await blocks the rest of the
  // module from evaluating, so none of the React/Ink imports below
  // ever load when we're going to re-exec.
  const code = await reexecInDocker(process.argv.slice(2), {
    extraMounts: pre.extraGitMounts,
    publishPorts: webMode ? [webPort] : [],
  });
  process.exit(code);
}

// `npm run dev` (HUU_DEV_NATIVE=1) skipped the container. That is a
// contributor convenience, never a silent one: say out loud that the isolation
// and the container memory ceiling the product promises are both absent. Once
// per invocation — the cgroup self-wrap below re-execs this same process, and
// the wrapped pass inherits the var.
if (isDevNativeMode(process.env) && process.env.HUU_CGROUP_WRAPPED !== '1') {
  process.stderr.write('\n' + t('cli.warn_dev_native') + '\n\n');
}

// Native Linux (the path where the host actually froze): wrap ourselves in a
// transient systemd USER scope with memory.high/max sized from the OS reserve
// (ROADMAP Fase 2.1). memory.high makes the KERNEL throttle huu's whole tree
// before the host thrashes; memory.max turns the absolute worst case into
// "huu's process dies inside its scope" instead of "the machine freezes". The
// sampler is already cgroup-aware, so the budget/PSI machinery becomes
// scope-relative automatically. Degrades silently to unwrapped when systemd
// isn't usable; HUU_NO_CGROUP=1 opts out. Placed before the heavy imports for
// the same reason as the docker gate — the wrapped child does all the work.
{
  const cgroupWrap = decideCgroupWrap(process.argv.slice(2), process.env);
  if (cgroupWrap.shouldWrap) {
    const code = await reexecInCgroupScope();
    if (code !== null) process.exit(code);
    process.stderr.write(t('cli.warn_no_cgroup') + '\n');
  }
}

// Past the gate we ARE the app process (in-container, --no-docker, or a native
// subcommand) — never the host docker wrapper. Bias the kernel OOM-killer to
// prefer other processes over huu. Best-effort + conservative by default (does
// NOT immunize); configurable via HUU_OOM_SCORE_ADJ. No-op without privilege
// (so a non-root native user is unaffected; it takes effect in the root
// container). See lib/oom-score.
applyOomScoreAdj();
// …and make agent TOOL SUBPROCESSES (vitest workers, npm, builds) the
// PREFERRED kernel-OOM victims (+500): they inherit huu's protective score
// otherwise, and a killed test runner surfaces as a task retry — a killed
// orchestrator (or compositor) does not. Best-effort /proc sweep, Linux only.
startOomChildWatcher();

import { execFileSync } from 'node:child_process';
import React from 'react';
import { render } from 'ink';
import { App } from './app.js';
import { importPipeline } from './lib/pipeline-io.js';
import { runInitDockerCli } from './lib/init-docker.js';
import { runStatusCli } from './lib/status.js';
import { runPruneCli } from './lib/prune.js';
import { loadRunConfig, applyRunConfig } from './lib/run-config.js';
import { runHeadless } from './lib/headless-run.js';
import { runDevCli, type DevCliPresenter } from './lib/dev-mode/dev-cli.js';
import { createDevDashboardPresenter } from './ui/components/DevDashboard.js';
import { runGraphCli } from './lib/graph-cli.js';

import { installCrashGuard } from './lib/crash-guard.js';
import { resolveRamPercent } from './lib/budget.js';
import { findSpec, resolveApiKey } from './lib/api-key.js';
import {
  clearActiveRunSentinel,
  writeActiveRunSentinel,
} from './lib/active-run-sentinel.js';
import {
  selectBackend,
  parseBackendKind,
  ALL_BACKENDS,
  type AgentBackendKind,
} from './orchestrator/backends/registry.js';
import {
  PROVIDERS,
  parseProvider,
  providerInfo,
  providerToBackend,
  resolveRunProvider,
} from './lib/providers.js';
import type { AppConfig, Pipeline } from './lib/types.js';
import type { LlmProvider } from './lib/providers.js';
import { installSafeTerminal } from './ui/safe-terminal.js';
import { initDebugLogger, log as dlog } from './lib/debug-logger.js';
import { enqueueProcessLog } from './lib/process-log-bridge.js';
import { startWebServer } from './web/serve.js';
import { EventEmitter, setMaxListeners } from 'node:events';

// Subcommands that don't render the TUI shouldn't pay the side-effects
// of the lifecycle logger (creating .huu/) or terminal restorers. We
// detect them BEFORE initializing those layers — the user expects a
// scaffolding command to be a quiet Unix citizen.
// NOTE: this set is about the TUI LIFECYCLE (debug logger, safe terminal,
// active-run sentinel), NOT about Docker. `graph` is here because it is a quiet
// file inspector that must not create `.huu/debug-*.log` just to print a
// listing; where it RUNS is decided by `decideReexec`, which re-execs it into
// the container exactly like `huu dev`.
const NON_TUI_SUBCOMMANDS = new Set(['init-docker', 'status', 'prune', 'graph']);
const firstNonFlagArg = process.argv.slice(2).find((a) => !a.startsWith('-'));
const isNonTui = firstNonFlagArg !== undefined && NON_TUI_SUBCOMMANDS.has(firstNonFlagArg);

if (!isNonTui) {
  // Init the debug logger BEFORE installSafeTerminal so the SIGINT/exit
  // handlers from both layers are recorded in order. Logger writes to
  // `<cwd>/.huu/debug-<ISO>.log` so a freeze leaves a complete trail.
  initDebugLogger(process.cwd());

  // Install BEFORE render() so even a crash during initial mount restores
  // the terminal. Ink's signal-exit covers clean unmounts, but uncaught
  // rejections from the orchestrator (e.g., a worktree teardown failure
  // during the summary transition) can land outside ink's reach.
  installSafeTerminal();

  // Record the cwd of this run at /tmp/huu/active so a Docker
  // HEALTHCHECK probe (which runs from / with no inherited WORKDIR)
  // can find the .huu/debug-*.log to inspect. Cleared by the exit
  // handlers below.
  writeActiveRunSentinel(process.cwd());
}

/**
 * Hard-fail if `cwd` is not inside a git repository. huu's whole model
 * is "isolate each agent in a worktree" — without git there's nothing
 * to branch from.
 *
 * Authoritative gate is `preflightGitOnHost` at the top of this file
 * (runs BEFORE the docker re-exec). This function remains as a defensive
 * backup for the in-container path and for `--yolo` native runs, where
 * the host preflight didn't fire (`shouldReexec === false`).
 *
 * If `git` itself isn't on PATH (ENOENT), defer to upstream: an ENOENT
 * inside the container would be a packaging bug; on the host with --yolo
 * we let the orchestrator's git layer surface the real error.
 */
function ensureGitRepoOrExit(cwd: string): void {
  try {
    execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return;
    process.stderr.write(t('cli.err_not_a_repo', { cwd }) + '\n');
    process.exit(1);
  }
}

function printUsage(): void {
  const envLines = API_KEY_REGISTRY.map(
    (s) => `  ${s.envVar.padEnd(34)} ${t('cli.help_env_key', { label: s.label })}`,
  ).join('\n');
  console.log(t('cli.help', { envLines, configPath: configFilePath() }));
}


// Belt-and-suspenders terminal restore. Ink's componentWillUnmount already
// disables raw mode and shows the cursor on a clean exit, but it relies on
// React's reconciler running cleanups synchronously inside signal-exit. On
// uncaughtException, SIGTERM, EPIPE during a child execSync, or any path
// where the React tree is torn down asynchronously, the terminal can be left
// in raw mode with the cursor hidden — making the user's shell appear
// "stuck" (typed keys don't echo, no cursor) until they run `stty sane` or
// reopen the terminal. These handlers force-restore the bare minimum (raw
// mode off, cursor visible, mouse tracking off) on every exit path.
let terminalRestored = false;
function restoreTerminal(): void {
  if (terminalRestored) return;
  terminalRestored = true;
  try {
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
      process.stdin.setRawMode(false);
    }
  } catch {
    /* best effort */
  }
  try {
    if (process.stdout.isTTY) {
      // Show cursor + disable any mouse tracking modes that might have been
      // enabled by a third-party Ink component or a stray ANSI sequence.
      process.stdout.write('\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l');
    }
  } catch {
    /* best effort */
  }
  // Drop the HEALTHCHECK sentinel as part of the exit dance. Cheap,
  // best-effort, and prevents stale pointers if the same /tmp survives
  // between runs (rare outside containers, but possible).
  if (!isNonTui) {
    clearActiveRunSentinel(process.cwd());
  }
}

process.on('exit', restoreTerminal);
process.on('SIGINT', () => {
  restoreTerminal();
  process.exit(130);
});
process.on('SIGTERM', () => {
  restoreTerminal();
  process.exit(143);
});
process.on('SIGHUP', () => {
  restoreTerminal();
  process.exit(129);
});
// The SINGLE authoritative uncaught/unhandled handler. Default is FATAL — a
// one-shot `huu auto` and the TUI want to fail loud (and a TUI in a corrupted
// state isn't worth resuming). The web server flips this to RESILIENT once it is
// listening (see web/serve.ts), so a detached-timer / library error inside one
// agent can no longer take down the whole multi-run fleet + the server. This
// REPLACES the old blanket `process.exit(1)` on any uncaught error, and is the
// only exit-on-uncaught handler (safe-terminal + debug-logger only LOG now).
installCrashGuard({ onFatalCleanup: restoreTerminal });

// Installed exactly once. Idempotent so accidental re-entry is harmless.
let logCapturesInstalled = false;

/**
 * Redirect Node `warning` events and every `console.*` call into the
 * process log bridge so they surface inside LogArea (the "Logs (all)"
 * panel) instead of bleeding above the Ink frame and corrupting the
 * rendered kanban.
 *
 * Must run BEFORE `render(<App />, { patchConsole: false })` — flipping
 * Ink's patchConsole off without our own console patch in place would
 * let any stray `console.log` mangle the rendered frame directly.
 */
function installLogCaptures(): void {
  if (logCapturesInstalled) return;
  logCapturesInstalled = true;

  // Most MaxListenersExceededWarning hits in this codebase are benign:
  // workers + integrators all subscribe to the same abort/signal emitter
  // for the duration of a stage, and the pi SDK adds ONE abort listener
  // per tool call to its session AbortSignal — any session with >32 tool
  // calls tripped the warning on every subsequent call (the 8-project
  // storm log). `EventEmitter.defaultMaxListeners` does NOT govern
  // EventTargets (AbortSignal is one), so use events.setMaxListeners(),
  // which raises the default for both. HUU_MAX_EVENT_LISTENERS overrides
  // (0 = leave Node's defaults untouched); a real leak still surfaces —
  // just at the higher line — through the warning hook below.
  const rawMaxListeners = Number(process.env.HUU_MAX_EVENT_LISTENERS ?? '256');
  if (Number.isFinite(rawMaxListeners) && rawMaxListeners > 0) {
    setMaxListeners(Math.floor(rawMaxListeners));
  } else {
    EventEmitter.defaultMaxListeners = 32; // legacy floor when disabled
  }

  // Node attaches a default 'warning' listener that prints to stderr;
  // that print is exactly what bleeds above the kanban. Drop it before
  // adding ours so the warning surfaces ONLY in LogArea + debug log.
  // (Setting NODE_NO_WARNINGS at runtime is a no-op — Node caches it at
  // process start, so we have to take ownership of the listener instead.)
  process.removeAllListeners('warning');
  process.on('warning', (w) => {
    const msg = w.stack ? `${w.name}: ${w.message}\n${w.stack}` : `${w.name}: ${w.message}`;
    enqueueProcessLog({ level: 'warn', source: 'node-warning', message: msg });
    try {
      dlog('warning', w.name, { msg: w.message, stack: w.stack });
    } catch {
      /* debug-logger may not be initialized yet (unlikely on this path) */
    }
  });

  // Patch every console method. Originals are captured for *this scope
  // only* — we deliberately don't re-export them. Any code path that
  // legitimately needs to write to the terminal after this point should
  // use process.stderr.write/process.stdout.write directly (see the
  // fatal-path handlers at the top of this file).
  const LEVEL_MAP: Record<string, 'info' | 'warn' | 'error' | 'debug'> = {
    log: 'info',
    info: 'info',
    warn: 'warn',
    error: 'error',
    debug: 'debug',
  };
  const format = (args: unknown[]): string =>
    args
      .map((a) => {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.stack ?? a.message;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(' ');

  for (const method of Object.keys(LEVEL_MAP) as Array<keyof typeof LEVEL_MAP>) {
    const level = LEVEL_MAP[method];
    (console as unknown as Record<string, (...a: unknown[]) => void>)[method] = (
      ...args: unknown[]
    ): void => {
      const msg = format(args);
      enqueueProcessLog({ level, source: 'console', message: msg });
      try {
        dlog('console', method, { msg });
      } catch {
        /* same */
      }
    };
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Materialize the surf web-research keys inside the container so any agent
  // that shells out to `surf-research-skill` finds `~/.config/surf/keys.json`.
  // The bridge reads huu's key registry + pools; without this the mounted
  // tavily/parallel/brave secrets never reach the CLI. No-op on the host,
  // non-fatal by construction — web research is optional.
  try {
    const surf = ensureSurfKeysInContainer();
    if (surf?.written) dlog('surf', 'keys_materialized', { providers: surf.providers, keyCount: surf.keyCount });
    else if (surf && surf.reason) dlog('surf', 'keys_skipped', { reason: surf.reason });
  } catch {
    /* ensureSurfKeysInContainer never throws; belt-and-suspenders */
  }

  const useStub = args.includes('--stub');
  // Any native bypass — flag or env — triggers the same no-isolation warning.
  const useYolo =
    args.includes('--yolo') ||
    args.includes('--no-docker') ||
    process.env.HUU_NO_DOCKER === '1' ||
    process.env.HUU_NO_DOCKER === 'true';
  const concurrencyArg = args
    .filter((a) => a.startsWith('--concurrency='))
    .map((a) => Number(a.slice('--concurrency='.length)))
    .filter((n) => Number.isFinite(n) && n >= 1)
    .map((n) => Math.floor(n))
    .pop();
  // Memory-aware auto-scale is the DEFAULT. --no-auto-scale pins manual
  // concurrency; --concurrency=N alone also pins manual at N (adding the
  // legacy --auto-scale flag keeps auto mode and only seeds the start
  // value). The memory guard runs in both modes.
  const autoScale = args.includes('--no-auto-scale')
    ? false
    : concurrencyArg !== undefined
      ? args.includes('--auto-scale')
      : true;

  // --ram-percent=N sets the MACHINE-GLOBAL RAM budget dial (the admission
  // ceiling). Exposed as an env var so every run path — single-run, headless,
  // web, and the multi-run scheduler — picks it up uniformly via
  // resolveRamPercent(). See src/lib/budget.ts.
  const ramPercentArg = args
    .filter((a) => a.startsWith('--ram-percent='))
    .map((a) => Number(a.slice('--ram-percent='.length)))
    .filter((n) => Number.isFinite(n))
    .pop();
  if (ramPercentArg !== undefined) {
    process.env.HUU_RAM_PERCENT = String(resolveRamPercent(ramPercentArg));
  }

  // --provider=<name> picks the LLM provider jcode dispatches to. It is a
  // SEPARATE axis from --backend: both providers map to the same `jcode` kind,
  // so the choice has to travel on its own all the way to the credential.
  const providerArg = args
    .filter((a) => a.startsWith('--provider='))
    .map((a) => a.slice('--provider='.length))
    .pop();
  let providerFromCli: LlmProvider | null = null;
  if (providerArg !== undefined) {
    const parsed = parseProvider(providerArg);
    if (!parsed) {
      console.error(
        t('cli.err_unknown_provider', {
          value: providerArg,
          valid: PROVIDERS.map((p) => p.id).join(', '),
        }),
      );
      process.exit(1);
    }
    providerFromCli = parsed;
  }

  // --backend=<kind> takes precedence over --provider/--stub aliases. Last wins
  // so the user can override an alias they pre-set somewhere.
  const backendArg = args
    .filter((a) => a.startsWith('--backend='))
    .map((a) => a.slice('--backend='.length))
    .pop();

  let backendKindFromCli: AgentBackendKind | null = null;
  if (backendArg !== undefined) {
    const parsed = parseBackendKind(backendArg);
    if (!parsed) {
      console.error(
        t('cli.err_unknown_backend', { value: backendArg, valid: ALL_BACKENDS.join(', ') }),
      );
      process.exit(1);
    }
    backendKindFromCli = parsed;
  } else if (providerFromCli) {
    backendKindFromCli = providerToBackend(providerFromCli);
  } else if (useStub) {
    backendKindFromCli = 'stub';
  }

  // These flags are CLI-only; the rest of the pipeline (subcommand dispatch,
  // pipeline import) must not see them.
  const filtered = args.filter(
    (a) =>
      a !== '--stub' &&
      a !== '--yolo' &&
      a !== '--no-docker' &&
      a !== '--auto-scale' &&
      a !== '--no-auto-scale' &&
      a !== '--cli' &&
      a !== '--tui' &&
      a !== '--web' &&
      !a.startsWith('--backend=') &&
      !a.startsWith('--provider=') &&
      !a.startsWith('--dir=') &&
      !a.startsWith('--concurrency=') &&
      !a.startsWith('--ram-percent=') &&
      !a.startsWith('--port='),
  );

  if (filtered.includes('--help') || filtered.includes('-h')) {
    printUsage();
    return;
  }

  // The Docker bypass already happened in decideReexec at the top of this
  // file. The warning surfaces the security trade-off the user just opted
  // into, mirroring the message in reexecInDocker for the inverse case.
  // Suppressed inside the container because --yolo would be a no-op there.
  if (useYolo && process.env.HUU_IN_CONTAINER !== '1') {
    process.stderr.write(t('cli.warn_yolo') + '\n');
  }

  // Non-TUI subcommands are handled BEFORE the Ink render path so they
  // don't pay the cost of mounting the React tree, opening the debug
  // logger, etc. They print to stdout/stderr like normal Unix CLIs.
  if (filtered[0] === 'init-docker') {
    const code = runInitDockerCli(filtered.slice(1), process.cwd());
    process.exit(code);
  }

  if (filtered[0] === 'status') {
    const code = runStatusCli({ args: filtered.slice(1), cwd: process.cwd() });
    process.exit(code);
  }

  if (filtered[0] === 'prune') {
    const code = runPruneCli({ args: filtered.slice(1) });
    process.exit(code);
  }

  // `huu graph <subcommand>` — inspect, validate and compile the DRAWN methods
  // saved under `.huu/dev/graphs/`. Dispatched here, ahead of the git gate, on
  // purpose: reading a drawing is a file operation, and refusing to show a
  // method because the directory is not a repo would be a gate with nothing
  // behind it. Running one still needs a repo — that is `huu dev --graph`.
  if (filtered[0] === 'graph') {
    const code = runGraphCli({ args: filtered.slice(1), cwd: process.cwd() });
    process.exit(code);
  }

  // Block fast on the only hard prerequisite for the TUI/run path: a git
  // repo. The orchestrator's preflight already enforces this, but it ran
  // AFTER the user configured pipeline + backend + model — getting stopped
  // at the last step after committing all that effort is a bad UX.
  // Doing it here means the user sees the error before any pipeline work.
  // Runs both for `huu` (welcome) and `huu run <pipeline>` (auto-start).
  ensureGitRepoOrExit(process.cwd());

  // `huu auto <pipeline> --config <config>` — headless one-command run.
  // Bypasses Ink entirely; drives the same Orchestrator the TUI uses,
  // with file selection and model/backend supplied via the config JSON.
  if (filtered[0] === 'auto') {
    const pipelinePath = filtered[1];
    if (!pipelinePath) {
      console.error(t('cli.usage_auto'));
      process.exit(1);
    }
    let configPath: string | undefined;
    const eqFlag = filtered.find((a) => a.startsWith('--config='));
    if (eqFlag) {
      configPath = eqFlag.slice('--config='.length);
    } else {
      const spaceIdx = filtered.indexOf('--config');
      if (spaceIdx >= 0) configPath = filtered[spaceIdx + 1];
    }
    if (!configPath) {
      console.error(t('cli.usage_auto'));
      process.exit(1);
    }

    let pipelineForAuto: Pipeline;
    try {
      pipelineForAuto = importPipeline(pipelinePath);
    } catch (err) {
      console.error(
        t('cli.err_import_pipeline', {
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      process.exit(1);
    }

    let runConfig;
    try {
      runConfig = loadRunConfig(configPath);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    const { pipeline: mergedPipeline, warnings } = applyRunConfig(
      pipelineForAuto,
      runConfig,
    );
    for (const w of warnings) process.stderr.write(`[${t('cli.warn_tag')}] ${w}\n`);

    // Per-file steps must have concrete files by now (from the pipeline or
    // config.files) — failing here beats spawning a misconfigured run.
    // `memory` steps are exempt on purpose: their list materializes at run
    // time from the filesFrom memory file an earlier step writes.
    for (const step of mergedPipeline.steps) {
      if (!('files' in step)) continue;
      if (step.scope === 'per-file' && step.files.length === 0) {
        console.error(t('cli.err_per_file_no_files', { name: step.name }));
        process.exit(1);
      }
    }

    // The `provider` field (when set) is the source of truth and overrides
    // `backend`: both providers map to jcode. Falls back to `backend` for
    // configs written before provider selection existed.
    const effectiveBackend: AgentBackendKind = runConfig.provider
      ? providerToBackend(runConfig.provider)
      : runConfig.backend;
    // `resolveRunProvider` — never `defaultProviderForBackend` — because a
    // `stub` run must resolve to NO provider (and therefore no credential),
    // not to the fallback DeepSeek.
    const effectiveProvider = resolveRunProvider(effectiveBackend, runConfig.provider);
    const bundle = selectBackend(effectiveBackend);
    let apiKey = '';
    let endpoint: string | undefined;
    if (bundle.requiresApiKey) {
      // The PROVIDER owns the name of the credential, not the bundle:
      // `selectBackend('jcode').apiKeySpecName` is undefined precisely because
      // jcode serves two providers. Reading it here is what made a
      // `provider: "openrouter"` config hard-exit demanding DEEPSEEK_API_KEY
      // while a perfectly good OPENROUTER_API_KEY was exported.
      const info = effectiveProvider ? providerInfo(effectiveProvider) : undefined;
      const spec = info ? findSpec(info.apiKeySpecName) : undefined;
      if (spec) apiKey = resolveApiKey(spec);
      if (!apiKey) {
        console.error(
          t('cli.err_auto_no_key', {
            provider: info?.label ?? spec?.label ?? bundle.label,
            envVar: spec?.envVar ?? info?.apiKeySpecName ?? 'API key',
            secretPath: spec?.secretMountPath ?? '/run/secrets/<key>',
          }),
        );
        process.exit(1);
      }

    }

    const appConfig: AppConfig = {
      apiKey: apiKey || 'stub',
      modelId: runConfig.modelId,
      backend: effectiveBackend,
      provider: effectiveProvider,
      endpoint,
    };

    // A config-supplied ramPercent feeds the same machine-global env dial; an
    // explicit --ram-percent flag (already applied above) takes precedence.
    if (ramPercentArg === undefined && runConfig.ramPercent !== undefined) {
      process.env.HUU_RAM_PERCENT = String(resolveRamPercent(runConfig.ramPercent));
    }

    const code = await runHeadless({
      pipeline: mergedPipeline,
      config: appConfig,
      cwd: runConfig.workingDirectory ? resolvePath(runConfig.workingDirectory) : process.cwd(),
      agentFactory: bundle.agentFactory,
      conflictResolverFactory: bundle.conflictResolverFactory,
      concurrency: runConfig.concurrency,
      autoScale: runConfig.autoScale,
    });
    process.exit(code);
  }

  // `huu dev "<objetivo>"` — development mode. Unlike `auto`, there is no
  // pipeline file: the planner writes one per epoch and huu compiles it into
  // the same `dependsOn` wave graph a hand-authored pipeline would produce.
  if (filtered[0] === 'dev') {
    // THE LIVE BOARD, and why it reads `args` instead of `filtered`.
    //
    // `--cli`/`--tui`/`--web` are CLI-GLOBAL flags: they were stripped from
    // `filtered` above so no subcommand parser ever sees them, which means
    // `runDevCli` cannot discover the user's front-end choice on its own. The
    // decision therefore happens HERE, off the unfiltered argv, through the
    // very same `decideInterfaceMode` the front-end fork below uses — a dev
    // session should not need a second vocabulary for "give me the TUI".
    //
    // Only an EXPLICIT 'cli' opts in. `decideInterfaceMode` defaults to `web`,
    // but `huu dev`'s default is neither web nor TUI: it is the headless log
    // plus one JSON object on stdout, and that is a contract scripts consume.
    // So a plain `huu dev` keeps behaving exactly as it does today, and
    // `huu dev --cli` (or `--tui`, or `HUU_CLI=1`) renders the kanban.
    //
    // The board paints on STDERR — never stdout — so even with it on, the JSON
    // verdict is byte-identical. See src/ui/components/DevDashboard.tsx.
    //
    // A FACTORY, not an instance. `runDevCli` refuses a bad flag, a missing
    // `--model`, an unknown graph and an unroutable model BEFORE any session
    // opens, and those refusals are plain stderr text the user has to read.
    // Mounting Ink here — the moment `--cli` is seen, before argv is even
    // parsed — painted an empty 31-line board on top of every one of them, and
    // never unmounted it (the early `return 1` never reaches `close()`). So the
    // decision is made here and the MOUNT happens inside `runDevCli`, at the
    // one line where the session is actually about to start.
    let devPresenterFactory: (() => DevCliPresenter) | undefined;
    if (decideInterfaceMode(args, process.env) === 'cli') {
      if (process.stderr.isTTY) {
        devPresenterFactory = () => createDevDashboardPresenter();
      } else {
        // No terminal to draw on (a pipe, a log file, CI). Refusing the run
        // would be hostile; silently drawing a board nobody can read would be
        // worse. Say it once and keep the plain log.
        process.stderr.write(t('tui.dev.no_tty') + '\n');
      }
    }
    // The provider travels WITH the backend, never re-derived downstream: it is
    // what names the credential `runDevCli` resolves, the base URL the planner's
    // chat client dials and the `--provider-profile` every jcode agent spawns
    // with. This used to be dropped here — `huu dev --provider=openrouter` was
    // REFUSED for exactly that reason — and dropping it is what would make a
    // session resolve one provider's key and spend it at the other's endpoint.
    const code = await runDevCli({
      args: filtered.slice(1),
      cwd: process.cwd(),
      backend: backendKindFromCli ?? 'jcode',
      ...(providerFromCli ? { provider: providerFromCli } : {}),
      concurrency: concurrencyArg,
      autoScale,
      ...(devPresenterFactory ? { presenterFactory: devPresenterFactory } : {}),
    });
    process.exit(code);
  }

  let initialPipeline: Pipeline | undefined;
  let autoStart = false;

  if (filtered[0] === 'run') {
    const path = filtered[1];
    if (!path) {
      console.error(t('cli.usage_run'));
      process.exit(1);
    }
    try {
      initialPipeline = importPipeline(path);
      autoStart = true;
    } catch (err) {
      console.error(
        t('cli.err_import_pipeline', {
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      process.exit(1);
    }
  }

  // When the user explicitly picked a backend on the CLI, lock it in.
  // When they didn't, defer to the App: it'll show the BackendSelector
  // screen so the choice is explicit before launch (avoids the foot-gun
  // where someone runs `huu run` and silently burns API quota).
  const lockedBackend = backendKindFromCli ?? undefined;

  // Front-end fork: the BROWSER UI is the default; `--cli`/`--tui` (or
  // HUU_CLI=1) keep the Ink TUI. Both drive the same Orchestrator — the
  // only difference is the face the user sees. Decided AFTER the git +
  // subcommand gates so `huu auto/status/init-docker/--help` are unaffected.
  const interfaceMode = decideInterfaceMode(args, process.env);

  // Capture stray console.* + Node `warning` events into the process log
  // bridge. For the TUI (patchConsole:false below) this stops stray writes
  // from corrupting the kanban; for the web UI it keeps the launching
  // terminal clean and feeds those lines into the run's log stream.
  installLogCaptures();

  if (interfaceMode === 'web') {
    dlog('lifecycle', 'web_start', {
      backend: lockedBackend ?? 'unspecified',
      hasInitialPipeline: Boolean(initialPipeline),
    });
    await startWebServer({
      cwd: process.cwd(),
      args,
      env: process.env,
      lockedBackend,
      // Carried explicitly: `providerToBackend` is many-to-one, so the server
      // cannot recover `--provider=openrouter` from `lockedBackend` alone.
      lockedProvider: providerFromCli ?? undefined,
      initialPipeline,
      defaultAutoScale: autoScale,
      defaultConcurrency: concurrencyArg,
    });
    dlog('lifecycle', 'web_server_closed');
    return;
  }

  const initialBundle = selectBackend(lockedBackend ?? 'jcode');

  dlog('lifecycle', 'render_start', {
    useStub,
    provider: providerFromCli ?? 'unspecified',
    backend: lockedBackend ?? 'unspecified',
    autoStart,
  });

  const { waitUntilExit } = render(
    <App
      initialPipeline={initialPipeline}
      agentFactory={initialBundle.agentFactory}
      conflictResolverFactory={initialBundle.conflictResolverFactory}
      requiresApiKey={initialBundle.requiresApiKey}
      backend={lockedBackend}
      provider={providerFromCli ?? undefined}
      autoStart={autoStart}
      autoScale={autoScale}
      concurrency={concurrencyArg}
    />,
    { patchConsole: false },
  );
  await waitUntilExit();
  dlog('lifecycle', 'wait_until_exit_resolved');
}

main().catch((err) => {
  process.stderr.write(`${t('cli.fatal')}: ${err?.stack ?? String(err)}\n`);
  process.exit(1);
});

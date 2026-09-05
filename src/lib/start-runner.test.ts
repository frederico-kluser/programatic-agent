import { beforeAll, describe, expect, it } from 'vitest';
import { decideReexec } from './docker-reexec.js';
import { initI18n } from './i18n/index.js';
import { EXIT_SIGINT, runStart, type StartDeps } from './start-runner.js';
import { SETUP_CONFIG_VERSION, type SetupConfig } from './setup-config.js';
import type { SetupGateResult } from './setup-prompt.js';
import {
  resolveSetupChoices,
  SETUP_GATE_ENV,
  type SetupOutcome,
  type SetupPlan,
} from './setup-flow.js';
// Reaches "up" into `web/` deliberately: the property under test is that the
// wrapper and the CHILD agree on BOTH axes, and the interface axis is decided
// there. `interface-mode.ts` is pure, and no production module in `lib/` gains
// an edge from a test import.
import { decideInterfaceMode } from '../web/interface-mode.js';

beforeAll(() => {
  initI18n({ HUU_LANG: 'en' });
});

const EMPTY_PLAN: SetupPlan = { askInterface: false, askRuntime: false, keys: [], empty: true };

function config(runtime: 'docker' | 'native', ui: 'web' | 'cli' = 'web'): SetupConfig {
  return { version: SETUP_CONFIG_VERSION, interface: ui, runtime, completed: true };
}

function outcome(over: Partial<SetupOutcome> = {}): SetupOutcome {
  return {
    interface: 'web',
    runtime: 'docker',
    completed: false,
    asked: false,
    savedKeys: [],
    skippedKeys: [],
    unsavedKeys: [],
    aborted: false,
    ...over,
  };
}

/**
 * What `cli.tsx` does with the environment the wrapper handed it — the two
 * lines at the top of the file, verbatim: resolve the choices in force, then
 * put them through both deciders. `disk` is what `loadSetupConfig()` would
 * return in the child, which after a FAILED save is not what the user answered.
 */
function childSees(
  args: string[],
  env: NodeJS.ProcessEnv,
  disk: SetupConfig,
): { dockerRun: boolean; ui: 'web' | 'cli' } {
  const saved = resolveSetupChoices(disk, env);
  return {
    dockerRun: decideReexec(args, env, saved).shouldReexec,
    ui: decideInterfaceMode(args, env, saved),
  };
}

interface Recorder {
  deps: StartDeps;
  builds: number;
  spawned: Array<{ args: string[]; env: NodeJS.ProcessEnv }>;
  confirms: string[];
  written: string[];
}

function recorder(opts: {
  args?: string[];
  env?: NodeJS.ProcessEnv;
  gate?: SetupGateResult;
  buildCode?: number;
  dockerAvailable?: boolean;
  confirmAnswer?: boolean | null;
  cliExit?: number;
}): Recorder {
  const builds = { n: 0 };
  const spawned: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const confirms: string[] = [];
  const written: string[] = [];
  const gate: SetupGateResult = opts.gate ?? {
    considered: true,
    ran: false,
    config: config('docker'),
    plan: EMPTY_PLAN,
    outcome: outcome(),
  };

  const deps: StartDeps = {
    args: opts.args ?? [],
    env: opts.env ?? {},
    gate: async () => gate,
    dockerAvailable: () => opts.dockerAvailable ?? true,
    buildImage: () => {
      builds.n += 1;
      return opts.buildCode ?? 0;
    },
    confirm: async (text) => {
      confirms.push(text);
      return opts.confirmAnswer ?? null;
    },
    spawnCli: async (args, env) => {
      spawned.push({ args, env });
      return opts.cliExit ?? 0;
    },
    write: (line) => written.push(line),
  };

  return {
    deps,
    get builds() {
      return builds.n;
    },
    spawned,
    confirms,
    written,
  };
}

describe('runStart — npm start, reordered', () => {
  it('BUILDS the image when the run will land in the container', async () => {
    const r = recorder({ gate: undefined });
    expect(await runStart(r.deps)).toBe(0);
    expect(r.builds).toBe(1);
    expect(r.spawned).toHaveLength(1);
  });

  it('does NOT build when the saved runtime is native', async () => {
    const r = recorder({
      gate: {
        considered: true,
        ran: false,
        config: config('native'),
        plan: EMPTY_PLAN,
        outcome: outcome({ runtime: 'native' }),
      },
    });
    expect(await runStart(r.deps)).toBe(0);
    expect(r.builds).toBe(0);
    // The CLI still starts — native is a runtime, not a refusal.
    expect(r.spawned).toHaveLength(1);
    expect(r.written.join('\n')).toMatch(/skipping the container image build/);
  });

  it('does NOT build for --no-docker, whatever the saved runtime says', async () => {
    const r = recorder({ args: ['--no-docker'] });
    expect(await runStart(r.deps)).toBe(0);
    expect(r.builds).toBe(0);
  });

  it('does NOT build for --help, and says nothing about images', async () => {
    const r = recorder({ args: ['--help'] });
    expect(await runStart(r.deps)).toBe(0);
    expect(r.builds).toBe(0);
    expect(r.written.join('\n')).not.toMatch(/image/i);
  });

  it('BUILDS for --docker even when native is the saved runtime', async () => {
    const r = recorder({
      args: ['--docker'],
      gate: {
        considered: true,
        ran: false,
        config: config('native'),
        plan: EMPTY_PLAN,
        outcome: outcome({ runtime: 'native' }),
      },
    });
    expect(await runStart(r.deps)).toBe(0);
    expect(r.builds).toBe(1);
  });

  it('pins HUU_IMAGE=huu:local and marks the gate as already run', async () => {
    const r = recorder({});
    await runStart(r.deps);
    expect(r.spawned[0]!.env.HUU_IMAGE).toBe('huu:local');
    expect(r.spawned[0]!.env.HUU_SETUP_GATE_DONE).toBe('1');
  });

  it('respects an explicitly pinned HUU_IMAGE', async () => {
    const r = recorder({ env: { HUU_IMAGE: 'ghcr.io/frederico-kluser/huu:latest' } });
    await runStart(r.deps);
    expect(r.spawned[0]!.env.HUU_IMAGE).toBe('ghcr.io/frederico-kluser/huu:latest');
  });

  it('forwards the user argv to the CLI untouched', async () => {
    const r = recorder({ args: ['run', 'p.json', '--cli'] });
    await runStart(r.deps);
    expect(r.spawned[0]!.args).toEqual(['run', 'p.json', '--cli']);
  });

  // ── the failure the old `&&` swallowed ────────────────────────────────
  it('OFFERS the native runtime when the image build fails', async () => {
    const r = recorder({ buildCode: 1, confirmAnswer: true });
    expect(await runStart(r.deps)).toBe(0);
    expect(r.confirms).toHaveLength(1);
    expect(r.confirms[0]).toMatch(/WITHOUT the container/);
    // Accepted → the CLI runs, natively, for this invocation only.
    expect(r.spawned).toHaveLength(1);
    expect(r.spawned[0]!.env.HUU_NO_DOCKER).toBe('1');
  });

  it('stops with the build’s exit code when the native offer is declined', async () => {
    const r = recorder({ buildCode: 1, confirmAnswer: false });
    expect(await runStart(r.deps)).toBe(1);
    expect(r.spawned).toEqual([]);
    expect(r.written.join('\n')).toMatch(/nothing was started/i);
  });

  it('does not hang when there is nobody to answer the native offer', async () => {
    const r = recorder({ buildCode: 1, confirmAnswer: null });
    expect(await runStart(r.deps)).toBe(1);
    expect(r.spawned).toEqual([]);
  });

  it('never writes the native choice into the saved config', async () => {
    // The offer is about THIS run. Nothing here may call saveSetupConfig —
    // the only channel is the env var handed to the child.
    const r = recorder({ buildCode: 1, confirmAnswer: true });
    await runStart(r.deps);
    expect(r.deps.env.HUU_NO_DOCKER).toBeUndefined();
    expect(r.spawned[0]!.env.HUU_NO_DOCKER).toBe('1');
  });

  it('offers the native runtime when docker is NOT INSTALLED at all', async () => {
    // `ensure-image.sh` exits 0 when docker is missing (native-only
    // subcommands must keep working), so the build status cannot see this —
    // the check has to happen before it, or the start glides into a re-exec
    // that dies with no way forward.
    const r = recorder({ dockerAvailable: false, confirmAnswer: true });
    expect(await runStart(r.deps)).toBe(0);
    expect(r.builds).toBe(0);
    expect(r.written.join('\n')).toMatch(/docker is not installed/);
    expect(r.spawned[0]!.env.HUU_NO_DOCKER).toBe('1');
  });

  it('stops with 127 when docker is missing and the offer is declined', async () => {
    const r = recorder({ dockerAvailable: false, confirmAnswer: false });
    expect(await runStart(r.deps)).toBe(127);
    expect(r.builds).toBe(0);
    expect(r.spawned).toEqual([]);
  });

  it('does not even ask about docker when the runtime is native', async () => {
    const r = recorder({
      dockerAvailable: false,
      gate: {
        considered: true,
        ran: false,
        config: config('native'),
        plan: EMPTY_PLAN,
        outcome: outcome({ runtime: 'native' }),
      },
    });
    expect(await runStart(r.deps)).toBe(0);
    expect(r.confirms).toEqual([]);
    expect(r.spawned).toHaveLength(1);
  });

  // ── the ways out ──────────────────────────────────────────────────────
  it('exits 130 when the setup was interrupted, without building or spawning', async () => {
    const r = recorder({
      gate: {
        considered: true,
        ran: true,
        config: config('docker'),
        plan: EMPTY_PLAN,
        outcome: outcome({ asked: true, aborted: true }),
      },
    });
    expect(await runStart(r.deps)).toBe(EXIT_SIGINT);
    expect(r.builds).toBe(0);
    expect(r.spawned).toEqual([]);
  });

  it('`npm start setup` configures and stops — no build, no CLI', async () => {
    const r = recorder({ args: ['setup'] });
    expect(await runStart(r.deps)).toBe(0);
    expect(r.builds).toBe(0);
    expect(r.spawned).toEqual([]);
  });

  it('propagates the CLI exit code', async () => {
    const r = recorder({ cliExit: 42 });
    expect(await runStart(r.deps)).toBe(42);
  });
});

// ─── the wrapper and the child must never disagree (WARNING finding A) ───
//
// `runStart` decides from the config it holds IN MEMORY; the child re-reads the
// disk. They are the same object only while the write SUCCEEDED, and
// `markSetupComplete` is best-effort: an unwritable `~/.config/huu` (a previous
// `sudo npm start` leaving `config.json` root-owned is enough) makes it return
// false. Measured before the fix, answering interface=cli / runtime=native:
//
//   huu: the setup choices could not be written to disk — …
//   huu is set up: interface=cli, runtime=native.
//   huu: runtime is native — skipping the container image build.
//   huu: launching the web UI inside Docker — open http://localhost:4888 …
//
// Both axes inverted in ONE start, and the part that bites: the build was
// skipped while the `docker run` happened anyway — the stale-image trap
// `ensure-image.sh` exists to close, in a container the user had just declined.
describe('runStart — a save that failed must not split the two processes', () => {
  /** What the disk still says after `markSetupComplete` returned false. */
  const DISK_AFTER_FAILED_SAVE = config('docker', 'web');

  function failedSave(ui: 'web' | 'cli', runtime: 'docker' | 'native'): SetupGateResult {
    return {
      considered: true,
      ran: true,
      // Exactly what `runSetupGate` returns when the write failed: the answers,
      // over a config that never reached the disk, still not `completed`.
      config: { ...DISK_AFTER_FAILED_SAVE, interface: ui, runtime, completed: false },
      plan: { askInterface: true, askRuntime: true, keys: [], empty: false },
      outcome: outcome({ interface: ui, runtime, asked: true, completed: false }),
    };
  }

  it('cli + native survive a failed save: no build, and NO docker run', async () => {
    const r = recorder({ gate: failedSave('cli', 'native') });
    expect(await runStart(r.deps)).toBe(0);

    // The wrapper obeys the answers…
    expect(r.builds).toBe(0);
    expect(r.spawned).toHaveLength(1);

    // …and hands them down, so the child obeys the same ones.
    const env = r.spawned[0]!.env;
    expect(env[SETUP_GATE_ENV.interface]).toBe('cli');
    expect(env[SETUP_GATE_ENV.runtime]).toBe('native');

    const child = childSees(r.deps.args, env, DISK_AFTER_FAILED_SAVE);
    expect(child.dockerRun).toBe(false); // ← the docker run that must not happen
    expect(child.ui).toBe('cli');
  });

  it('the reverse direction too: docker chosen over a native file', async () => {
    // Disk holds `native` (from an earlier run, or a half-written record); the
    // user just picked docker and the save failed. The wrapper builds the
    // image, so the child MUST be the one that uses it.
    const disk = config('native', 'cli');
    const r = recorder({
      gate: {
        considered: true,
        ran: true,
        config: { ...disk, interface: 'web', runtime: 'docker', completed: false },
        plan: { askInterface: true, askRuntime: true, keys: [], empty: false },
        outcome: outcome({ asked: true, completed: false }),
      },
    });
    expect(await runStart(r.deps)).toBe(0);
    expect(r.builds).toBe(1);

    const child = childSees(r.deps.args, r.spawned[0]!.env, disk);
    expect(child.dockerRun).toBe(true);
    expect(child.ui).toBe('web');
  });

  it('a build the wrapper skipped is never followed by a child that re-execs', async () => {
    // The invariant, stated as itself and checked over the whole matrix: no
    // combination of stored choices and answers may produce "0 builds + the
    // child re-execs". That pairing IS the stale-image trap.
    for (const diskRuntime of ['docker', 'native'] as const) {
      for (const chosen of ['docker', 'native'] as const) {
        const disk = config(diskRuntime);
        const r = recorder({
          gate: {
            considered: true,
            ran: true,
            config: { ...disk, runtime: chosen, completed: false },
            plan: { askInterface: false, askRuntime: true, keys: [], empty: false },
            outcome: outcome({ runtime: chosen, asked: true, completed: false }),
          },
        });
        await runStart(r.deps);
        const child = childSees(r.deps.args, r.spawned[0]!.env, disk);
        expect(
          child.dockerRun && r.builds === 0,
          `disk=${diskRuntime} chosen=${chosen}: docker run with no image build`,
        ).toBe(false);
        // And the two agree on the axis outright.
        expect(child.dockerRun, `disk=${diskRuntime} chosen=${chosen}`).toBe(chosen === 'docker');
      }
    }
  });

  it('the one-shot native offer still outranks the handed-down docker choice', async () => {
    // Docker is broken, the user accepts the host for THIS run. The env-tier
    // bypass must beat the config-tier channel — otherwise the offer is a lie.
    const r = recorder({ dockerAvailable: false, confirmAnswer: true });
    expect(await runStart(r.deps)).toBe(0);
    const env = r.spawned[0]!.env;
    expect(env.HUU_NO_DOCKER).toBe('1');
    expect(env[SETUP_GATE_ENV.runtime]).toBe('docker');
    expect(childSees(r.deps.args, env, config('docker')).dockerRun).toBe(false);
  });

  it('`--docker` on the command line still beats a handed-down `native`', async () => {
    const r = recorder({ args: ['--docker'], gate: failedSave('web', 'native') });
    await runStart(r.deps);
    expect(r.builds).toBe(1);
    expect(childSees(['--docker'], r.spawned[0]!.env, DISK_AFTER_FAILED_SAVE).dockerRun).toBe(true);
  });
});

import { beforeAll, describe, expect, it } from 'vitest';
import { findSpec } from './api-key.js';
import { decideReexec, NATIVE_ONLY_SUBCOMMANDS } from './docker-reexec.js';
// Reaches "up" into `web/` on purpose, exactly like the hermetic-hatch
// regression below reaches into `orchestrator/`: the contract under test is
// that the choices this module hands down land at the CONFIG tier of BOTH
// deciders, and only the deciders themselves can prove it. `interface-mode.ts`
// is pure; no production module in `lib/` gains an edge from this import.
import { decideInterfaceMode } from '../web/interface-mode.js';
import { initI18n } from './i18n/index.js';
import type { KeyVerdict } from './key-validation.js';
import type { ApiKeySpec } from './api-key-registry.js';
import {
  decideSetupGate,
  MAX_ATTEMPTS,
  planSetup,
  resolveSetupChoices,
  runSetupFlow,
  SETUP_EXEMPT_SUBCOMMANDS,
  SETUP_GATE_ENV,
  SETUP_KEY_ROLES,
  setupGateEnv,
  type SetupFlowDeps,
  type SetupKeyState,
  type SetupPlan,
  type SetupQuestion,
} from './setup-flow.js';
import {
  defaultSetupConfig,
  SETUP_CONFIG_VERSION,
  type SetupConfig,
} from './setup-config.js';

// `t()` throws on a key missing from ANY shipped locale, so the flow cannot
// render a single line until the catalogs are audited. Doing it once here is
// also the cheapest possible regression test for the keys this feature added.
beforeAll(() => {
  initI18n({ HUU_LANG: 'en' });
});

const NOTHING: Record<string, SetupKeyState> = {};

function present(source: SetupKeyState['source'] = 'env'): SetupKeyState {
  return { source, masked: 'sk-abc…7890' };
}

function completeConfig(over: Partial<SetupConfig> = {}): SetupConfig {
  return {
    version: SETUP_CONFIG_VERSION,
    interface: 'web',
    runtime: 'docker',
    completed: true,
    ...over,
  };
}

// ─────────────────────────────── planSetup ───────────────────────────────

describe('planSetup — what the flow will ask', () => {
  it('asks everything on the very first run', () => {
    const plan = planSetup({
      config: defaultSetupConfig(),
      forced: false,
      keys: NOTHING,
      findSpec,
    });
    expect(plan.askInterface).toBe(true);
    expect(plan.askRuntime).toBe(true);
    expect(plan.keys.map((k) => k.spec.name)).toEqual(['openrouter', 'brave', 'deepseek']);
    expect(plan.empty).toBe(false);
  });

  it('asks NOTHING once the setup is complete and every key resolves', () => {
    const plan = planSetup({
      config: completeConfig(),
      forced: false,
      keys: { openrouter: present(), brave: present(), deepseek: present() },
      findSpec,
    });
    expect(plan.askInterface).toBe(false);
    expect(plan.askRuntime).toBe(false);
    expect(plan.keys).toEqual([]);
    expect(plan.empty).toBe(true);
  });

  it('does not re-ask a key that is already in the environment', () => {
    const plan = planSetup({
      config: completeConfig(),
      forced: false,
      // openrouter comes from a shell env var; brave from the saved store.
      keys: { openrouter: present('env'), brave: present('stored') },
      findSpec,
    });
    expect(plan.keys).toEqual([]);
  });

  it('reopens ONLY the missing required key after the setup is complete', () => {
    const plan = planSetup({
      config: completeConfig(),
      forced: false,
      keys: { openrouter: present('env') },
      findSpec,
    });
    // brave is required and missing → asked. deepseek is optional and was
    // already offered during the first run → never nagged again.
    expect(plan.keys.map((k) => k.spec.name)).toEqual(['brave']);
    expect(plan.askInterface).toBe(false);
    expect(plan.empty).toBe(false);
  });

  it('offers the OPTIONAL key only during the first run', () => {
    const firstRun = planSetup({
      config: defaultSetupConfig(),
      forced: false,
      keys: { openrouter: present(), brave: present() },
      findSpec,
    });
    expect(firstRun.keys.map((k) => k.spec.name)).toEqual(['deepseek']);
    expect(firstRun.keys[0]!.role).toBe('optional');

    const later = planSetup({
      config: completeConfig(),
      forced: false,
      keys: { openrouter: present(), brave: present() },
      findSpec,
    });
    expect(later.keys).toEqual([]);
  });

  it('huu setup reopens every question, including keys already set', () => {
    const plan = planSetup({
      config: completeConfig(),
      forced: true,
      keys: { openrouter: present(), brave: present(), deepseek: present() },
      findSpec,
    });
    expect(plan.askInterface).toBe(true);
    expect(plan.askRuntime).toBe(true);
    expect(plan.keys.map((k) => k.spec.name)).toEqual(['openrouter', 'brave', 'deepseek']);
    expect(plan.keys.every((k) => k.present !== null)).toBe(true);
  });

  it('treats deepseek as optional and the other two as required', () => {
    const roles = Object.fromEntries(SETUP_KEY_ROLES.map((r) => [r.name, r.role]));
    expect(roles).toEqual({ openrouter: 'required', brave: 'required', deepseek: 'optional' });
  });

  it('ignores a role entry whose registry spec disappeared', () => {
    const plan = planSetup({
      config: defaultSetupConfig(),
      forced: false,
      keys: NOTHING,
      findSpec: (name) => (name === 'brave' ? findSpec(name) : undefined),
    });
    expect(plan.keys.map((k) => k.spec.name)).toEqual(['brave']);
  });
});

// ───────────────────────────── decideSetupGate ─────────────────────────────

describe('decideSetupGate — when the flow is even consulted', () => {
  it('never runs inside the container', () => {
    const d = decideSetupGate([], { HUU_IN_CONTAINER: '1' });
    expect(d.run).toBe(false);
  });

  it('never runs twice when the start wrapper already ran it', () => {
    expect(decideSetupGate([], { HUU_SETUP_GATE_DONE: '1' }).run).toBe(false);
  });

  it('honours the HUU_SKIP_SETUP escape hatch', () => {
    expect(decideSetupGate([], { HUU_SKIP_SETUP: '1' }).run).toBe(false);
    expect(decideSetupGate([], { HUU_SKIP_SETUP: 'true' }).run).toBe(false);
    expect(decideSetupGate([], { HUU_SKIP_SETUP: '0' }).run).toBe(true);
  });

  it('runs FORCED for `huu setup`, even with flags in front of it', () => {
    expect(decideSetupGate(['setup'], {})).toMatchObject({ run: true, forced: true });
    expect(decideSetupGate(['--cli', 'setup'], {})).toMatchObject({ run: true, forced: true });
  });

  it('`huu setup` BEATS an exported HUU_SKIP_SETUP', () => {
    // A command the user typed outranks an env var they exported months ago —
    // the same flag > env rule the runtime and interface deciders follow. The
    // alternative is `huu setup` silently doing nothing, which is the worst
    // answer available.
    expect(decideSetupGate(['setup'], { HUU_SKIP_SETUP: '1' })).toMatchObject({
      run: true,
      forced: true,
    });
  });

  it('but nothing beats the container guard', () => {
    // The ONE thing above `huu setup`: inside the container there is no
    // terminal to answer on, so prompting would deadlock the path that cannot
    // be interrupted.
    expect(decideSetupGate(['setup'], { HUU_IN_CONTAINER: '1' }).run).toBe(false);
  });

  it('`huu setup` BEATS the wrapper marker too — no env silences it', () => {
    // Same rule as HUU_SKIP_SETUP, and it was the last hole left: with
    // HUU_SETUP_GATE_DONE=1 exported (a stale export, or a user driving the
    // CLI by hand after a `npm start`), `huu setup` asked NOTHING and exited 0
    // in silence. The wrapper itself never spawns a child carrying `setup` in
    // argv — it configures and stops — so this branch costs the wrapper
    // nothing and buys the user a command that always does what it says.
    expect(decideSetupGate(['setup'], { [SETUP_GATE_ENV.done]: '1' })).toMatchObject({
      run: true,
      forced: true,
    });
    expect(
      decideSetupGate(['setup'], { [SETUP_GATE_ENV.done]: '1', HUU_SKIP_SETUP: '1' }),
    ).toMatchObject({ run: true, forced: true });
    // …while a NORMAL start still honours the marker: no double conversation.
    expect(decideSetupGate([], { [SETUP_GATE_ENV.done]: '1' }).run).toBe(false);
  });

  it('stays out of --help and the host utilities', () => {
    expect(decideSetupGate(['--help'], {}).run).toBe(false);
    expect(decideSetupGate(['-h'], {}).run).toBe(false);
    for (const sub of SETUP_EXEMPT_SUBCOMMANDS) {
      expect(decideSetupGate([sub], {}).run).toBe(false);
    }
  });

  it('runs, unforced, for a normal start', () => {
    expect(decideSetupGate([], {})).toMatchObject({ run: true, forced: false });
    expect(decideSetupGate(['run', 'p.json'], {})).toMatchObject({ run: true, forced: false });
  });

  it('exempts every natively-run subcommand except `setup` itself', () => {
    // The two lists live in different modules on purpose (the gate must stay
    // free of docker-reexec's spawn imports); this pins them together.
    for (const sub of NATIVE_ONLY_SUBCOMMANDS) {
      if (sub === 'setup') continue;
      expect(SETUP_EXEMPT_SUBCOMMANDS.has(sub)).toBe(true);
    }
    expect(SETUP_EXEMPT_SUBCOMMANDS.has('setup')).toBe(false);
  });
});

// ───────────────────────────── runSetupFlow ─────────────────────────────

interface Harness {
  deps: SetupFlowDeps;
  asked: string[];
  written: string[];
  savedKeys: Array<{ name: string; value: string }>;
  savedChoices: Array<{ ui: string; runtime: string }>;
}

/**
 * Drive the flow with a scripted list of answers. `null` in the script means
 * "the input closed here" — the abort path. Running out of answers is also an
 * abort, so a flow that asks more than the test scripted can never hang.
 */
function harness(opts: {
  plan: SetupPlan;
  config?: SetupConfig;
  answers: (string | null)[];
  verdicts?: Record<string, KeyVerdict[]>;
  interactive?: boolean;
  /** `false` = the config store refuses every key write (unwritable dir). */
  keySaveOk?: boolean;
}): Harness {
  const keySaveOk = opts.keySaveOk ?? true;
  const asked: string[] = [];
  const written: string[] = [];
  const savedKeys: Array<{ name: string; value: string }> = [];
  const savedChoices: Array<{ ui: string; runtime: string }> = [];
  const script = [...opts.answers];
  const verdicts: Record<string, KeyVerdict[]> = { ...(opts.verdicts ?? {}) };

  const deps: SetupFlowDeps = {
    plan: opts.plan,
    config: opts.config ?? defaultSetupConfig(),
    interactive: opts.interactive ?? true,
    ask: async (q: SetupQuestion) => {
      asked.push(q.text);
      return script.length > 0 ? script.shift()! : null;
    },
    write: (line) => written.push(line),
    validate: async (spec: ApiKeySpec) => {
      const queue = verdicts[spec.name];
      const next = queue?.shift();
      return next ?? { status: 'valid' };
    },
    saveKey: (spec, value) => {
      savedKeys.push({ name: spec.name, value });
      return keySaveOk;
    },
    saveChoices: (ui, runtime) => {
      savedChoices.push({ ui, runtime });
      return true;
    },
  };
  return { deps, asked, written, savedKeys, savedChoices };
}

const CHOICES_ONLY: SetupPlan = {
  askInterface: true,
  askRuntime: true,
  keys: [],
  empty: false,
};

function keyPlan(names: string[], role: 'required' | 'optional' = 'required'): SetupPlan {
  return {
    askInterface: false,
    askRuntime: false,
    keys: names.map((n) => ({ spec: findSpec(n)!, role, present: null })),
    empty: false,
  };
}

describe('runSetupFlow — the conversation', () => {
  it('records the choices the user typed', async () => {
    const h = harness({ plan: CHOICES_ONLY, answers: ['2', '1'] });
    const out = await runSetupFlow(h.deps);
    expect(out).toMatchObject({ interface: 'cli', runtime: 'docker', completed: true });
    expect(h.savedChoices).toEqual([{ ui: 'cli', runtime: 'docker' }]);
  });

  it('takes the defaults on bare Enter', async () => {
    const h = harness({ plan: CHOICES_ONLY, answers: ['', ''] });
    const out = await runSetupFlow(h.deps);
    expect(out).toMatchObject({ interface: 'web', runtime: 'docker' });
  });

  it('accepts the word spellings, not only the numbers', async () => {
    const h = harness({ plan: CHOICES_ONLY, answers: ['cli', 'docker'] });
    expect(await runSetupFlow(h.deps)).toMatchObject({ interface: 'cli', runtime: 'docker' });
  });

  it('re-asks a choice it does not understand, then falls back to the default', async () => {
    const h = harness({ plan: CHOICES_ONLY, answers: ['banana', 'melon', 'kiwi', 'docker'] });
    const out = await runSetupFlow(h.deps);
    // Three rejected answers exhaust the attempts for the interface question;
    // the flow says so and uses the default rather than looping forever.
    expect(out.interface).toBe('web');
    expect(out.runtime).toBe('docker');
  });

  it('asks nothing at all when the plan is empty', async () => {
    const h = harness({
      plan: { askInterface: false, askRuntime: false, keys: [], empty: true },
      answers: [],
    });
    const out = await runSetupFlow(h.deps);
    expect(h.asked).toEqual([]);
    expect(h.written).toEqual([]);
    expect(out.asked).toBe(false);
    expect(out.completed).toBe(false);
  });

  // ── the native runtime shows its price ──────────────────────────────
  it('shows the cost of native and only accepts it on an explicit yes', async () => {
    const h = harness({ plan: CHOICES_ONLY, answers: ['1', '2', 'y'] });
    const out = await runSetupFlow(h.deps);
    expect(out.runtime).toBe('native');
    // The two things a native run actually loses, both named.
    const cost = h.written.join('\n');
    expect(cost).toMatch(/~\/\.ssh/);
    expect(cost).toMatch(/memory ceiling/i);
  });

  it('falls back to docker when the native confirmation is declined', async () => {
    const h = harness({ plan: CHOICES_ONLY, answers: ['1', 'native', ''] });
    const out = await runSetupFlow(h.deps);
    expect(out.runtime).toBe('docker');
    expect(h.savedChoices).toEqual([{ ui: 'web', runtime: 'docker' }]);
  });

  // ── keys ────────────────────────────────────────────────────────────
  it('saves a key the provider accepted', async () => {
    const h = harness({ plan: keyPlan(['brave']), answers: ['BSAgoodkey'] });
    const out = await runSetupFlow(h.deps);
    expect(h.savedKeys).toEqual([{ name: 'brave', value: 'BSAgoodkey' }]);
    expect(out.savedKeys).toEqual(['brave']);
  });

  it('re-asks after `invalid` and keeps the second, accepted key', async () => {
    const h = harness({
      plan: keyPlan(['openrouter']),
      answers: ['sk-or-bad', 'sk-or-good'],
      verdicts: { openrouter: [{ status: 'invalid', httpStatus: 401 }, { status: 'valid' }] },
    });
    const out = await runSetupFlow(h.deps);
    expect(h.savedKeys).toEqual([{ name: 'openrouter', value: 'sk-or-good' }]);
    expect(out.savedKeys).toEqual(['openrouter']);
    expect(h.written.join('\n')).toMatch(/401/);
  });

  it('re-asks after `wrong-key` — a foreign credential must never be saved', async () => {
    const h = harness({
      plan: keyPlan(['deepseek'], 'optional'),
      answers: ['sk-or-openrouter', 'sk-deepseek'],
      verdicts: {
        deepseek: [{ status: 'wrong-key', belongsTo: 'openrouter', label: 'OpenRouter' }],
      },
    });
    await runSetupFlow(h.deps);
    expect(h.savedKeys).toEqual([{ name: 'deepseek', value: 'sk-deepseek' }]);
    expect(h.written.join('\n')).toMatch(/OpenRouter/);
  });

  it('lets an UNVERIFIABLE key through with a warning', async () => {
    const h = harness({
      plan: keyPlan(['brave']),
      answers: ['BSAmaybe'],
      verdicts: { brave: [{ status: 'unverifiable', reason: 'timed out after 8000ms' }] },
    });
    const out = await runSetupFlow(h.deps);
    expect(h.savedKeys).toEqual([{ name: 'brave', value: 'BSAmaybe' }]);
    expect(out.savedKeys).toEqual(['brave']);
    expect(h.written.join('\n')).toMatch(/timed out/);
  });

  it('gives up on a key after MAX_ATTEMPTS instead of trapping the user', async () => {
    const rejected: KeyVerdict = { status: 'invalid', httpStatus: 403 };
    const h = harness({
      plan: keyPlan(['openrouter']),
      answers: ['a', 'b', 'c', 'd'],
      verdicts: { openrouter: [rejected, rejected, rejected, rejected] },
    });
    const out = await runSetupFlow(h.deps);
    expect(h.savedKeys).toEqual([]);
    expect(out.skippedKeys).toEqual(['openrouter']);
    // Exactly MAX_ATTEMPTS prompts for that key — never a fourth.
    expect(h.asked.filter((q) => /OpenRouter/.test(q))).toHaveLength(MAX_ATTEMPTS);
    // …and the start still completes.
    expect(out.completed).toBe(true);
  });

  it('skips the optional key on a bare Enter and still completes', async () => {
    const h = harness({ plan: keyPlan(['deepseek'], 'optional'), answers: [''] });
    const out = await runSetupFlow(h.deps);
    expect(h.savedKeys).toEqual([]);
    expect(out.skippedKeys).toEqual(['deepseek']);
    expect(out.completed).toBe(true);
  });

  it('keeps — never re-saves — a key that was already set', async () => {
    const plan: SetupPlan = {
      askInterface: false,
      askRuntime: false,
      keys: [{ spec: findSpec('brave')!, role: 'required', present: { source: 'env', masked: 'BSAxx…1234' } }],
      empty: false,
    };
    const h = harness({ plan, answers: [''] });
    const out = await runSetupFlow(h.deps);
    expect(h.savedKeys).toEqual([]);
    expect(out.skippedKeys).toEqual([]);
    expect(h.written.join('\n')).toMatch(/BSAxx…1234/);
  });

  it('never echoes a raw key back to the user', async () => {
    const secret = 'BSAsupersecretvalue0001';
    const h = harness({ plan: keyPlan(['brave']), answers: [secret] });
    await runSetupFlow(h.deps);
    expect(h.written.join('\n')).not.toContain(secret);
    // …but it does confirm WHICH key landed, by fingerprint.
    expect(h.written.join('\n')).toMatch(/BSAsup…0001/);
  });

  it('asks for the credential with the echo muted', async () => {
    const h = harness({ plan: keyPlan(['brave']), answers: ['BSAx'] });
    const secretFlags: boolean[] = [];
    const inner = h.deps.ask;
    h.deps.ask = async (q) => {
      secretFlags.push(q.secret === true);
      return inner(q);
    };
    await runSetupFlow(h.deps);
    expect(secretFlags).toEqual([true]);
  });

  // ── the ways out ────────────────────────────────────────────────────
  it('does NOT block without a TTY — it reports the defaults and returns', async () => {
    const h = harness({ plan: CHOICES_ONLY, answers: [], interactive: false });
    const out = await runSetupFlow(h.deps);
    expect(h.asked).toEqual([]);
    expect(out).toMatchObject({
      interface: 'web',
      runtime: 'docker',
      completed: false,
      asked: false,
      aborted: false,
    });
    // Nothing persisted: the next interactive start still asks.
    expect(h.savedChoices).toEqual([]);
    expect(h.written.join('\n')).toMatch(/not a TTY/);
  });

  it('aborts cleanly when the input closes mid-question', async () => {
    const h = harness({ plan: CHOICES_ONLY, answers: [null] });
    const out = await runSetupFlow(h.deps);
    expect(out.aborted).toBe(true);
    expect(out.completed).toBe(false);
    expect(h.savedChoices).toEqual([]);
  });

  it('aborts cleanly when the input closes during a key prompt', async () => {
    const h = harness({ plan: keyPlan(['brave']), answers: [null] });
    const out = await runSetupFlow(h.deps);
    expect(out.aborted).toBe(true);
    expect(h.savedKeys).toEqual([]);
    expect(h.savedChoices).toEqual([]);
  });

  it('says NOT SAVED when the store refuses the key — never "saved"', async () => {
    // The measured bug: with a read-only config dir the flow printed
    // "OpenRouter: saved (sk-or-…DKEY)" and nothing reached the disk. The user
    // closes the terminal believing they are configured.
    const h = harness({ plan: keyPlan(['openrouter']), answers: ['sk-or-good'], keySaveOk: false });
    const out = await runSetupFlow(h.deps);
    const said = h.written.join('\n');

    expect(out.savedKeys).toEqual([]);
    expect(out.unsavedKeys).toEqual(['openrouter']);
    expect(said).not.toMatch(/saved \(/);
    expect(said).toMatch(/NOT SAVED/);
    // …and it says what to do instead, by naming the env var to export.
    expect(said).toContain('OPENROUTER_API_KEY');
    // WARN, do not block: the start still completes, because a key in the
    // environment makes huu perfectly usable and a lockout would be worse.
    expect(out.completed).toBe(true);
    expect(out.aborted).toBe(false);
  });

  it('a key that could not be persisted is not echoed raw either', async () => {
    const secret = 'sk-or-supersecretvalue0001';
    const h = harness({ plan: keyPlan(['openrouter']), answers: [secret], keySaveOk: false });
    await runSetupFlow(h.deps);
    expect(h.written.join('\n')).not.toContain(secret);
  });

  it('warns for an UNVERIFIABLE key the store also refused', async () => {
    // Two independent facts, both true, both said: we could not check it, and
    // we could not keep it.
    const h = harness({
      plan: keyPlan(['brave']),
      answers: ['BSAmaybe'],
      verdicts: { brave: [{ status: 'unverifiable', reason: 'timed out after 8000ms' }] },
      keySaveOk: false,
    });
    const out = await runSetupFlow(h.deps);
    expect(out.savedKeys).toEqual([]);
    expect(out.unsavedKeys).toEqual(['brave']);
    const said = h.written.join('\n');
    expect(said).toMatch(/timed out/);
    expect(said).toMatch(/NOT SAVED/);
  });

  it('reports a failed save instead of pretending the setup is complete', async () => {
    const h = harness({ plan: CHOICES_ONLY, answers: ['', ''] });
    h.deps.saveChoices = () => false;
    const out = await runSetupFlow(h.deps);
    expect(out.completed).toBe(false);
    expect(h.written.join('\n')).toMatch(/could not be written/);
  });
});

// ─────────────── the channel that keeps wrapper and child honest ───────────────

describe('setupGateEnv + resolveSetupChoices', () => {
  const disk = (over: Partial<SetupConfig> = {}): SetupConfig => completeConfig(over);

  it('hands both axes down, as literals', () => {
    expect(setupGateEnv({ interface: 'cli', runtime: 'native' })).toEqual({
      [SETUP_GATE_ENV.done]: '1',
      [SETUP_GATE_ENV.interface]: 'cli',
      [SETUP_GATE_ENV.runtime]: 'native',
    });
  });

  it('the handed-down choices win over the disk', () => {
    const out = resolveSetupChoices(disk(), setupGateEnv({ interface: 'cli', runtime: 'native' }));
    expect(out).toMatchObject({ interface: 'cli', runtime: 'native' });
  });

  it('falls back to the disk when the channel is empty, partial or garbage', () => {
    expect(resolveSetupChoices(disk({ interface: 'cli' }), {})).toMatchObject({
      interface: 'cli',
      runtime: 'docker',
    });
    // One axis handed down, the other left to the file — taken independently.
    expect(
      resolveSetupChoices(disk({ runtime: 'native' }), { [SETUP_GATE_ENV.interface]: 'cli' }),
    ).toMatchObject({ interface: 'cli', runtime: 'native' });
    // A value this version does not understand is not a reason to lose the
    // stored one: degrade to the file, never to a default.
    expect(
      resolveSetupChoices(disk({ interface: 'cli', runtime: 'native' }), {
        [SETUP_GATE_ENV.interface]: 'gtk',
        [SETUP_GATE_ENV.runtime]: 'podman',
      }),
    ).toMatchObject({ interface: 'cli', runtime: 'native' });
  });

  it('does not invent a completed setup', () => {
    // The channel carries CHOICES, not the fact that the user finished the
    // flow — and after a failed save they genuinely have not.
    const fresh: SetupConfig = { ...defaultSetupConfig(), completed: false };
    const out = resolveSetupChoices(fresh, setupGateEnv({ interface: 'cli', runtime: 'native' }));
    expect(out.completed).toBe(false);
  });

  it('lands at the CONFIG tier of both deciders — flags still outrank it', () => {
    const handed = setupGateEnv({ interface: 'cli', runtime: 'native' });
    const saved = resolveSetupChoices(defaultSetupConfig(), handed);

    // Nothing typed: the handed-down pair governs.
    expect(decideReexec([], handed, saved).shouldReexec).toBe(false);
    expect(decideInterfaceMode([], handed, saved)).toBe('cli');

    // …and a flag on the command line still beats it, in BOTH directions.
    expect(decideReexec(['--docker'], handed, saved).shouldReexec).toBe(true);
    expect(decideInterfaceMode(['--web'], handed, saved)).toBe('web');

    const toDocker = setupGateEnv({ interface: 'web', runtime: 'docker' });
    const savedDocker = resolveSetupChoices(defaultSetupConfig(), toDocker);
    expect(decideReexec(['--no-docker'], toDocker, savedDocker).shouldReexec).toBe(false);
    expect(
      decideInterfaceMode(['--cli'], toDocker, savedDocker),
    ).toBe('cli');
    // The ENV tier keeps outranking it too — that is why the channel is not
    // spelled HUU_NO_DOCKER / HUU_CLI in the first place.
    expect(
      decideReexec([], { ...toDocker, HUU_NO_DOCKER: '1' }, savedDocker).shouldReexec,
    ).toBe(false);
    expect(decideInterfaceMode([], { ...toDocker, HUU_CLI: '1' }, savedDocker)).toBe('cli');
  });
});

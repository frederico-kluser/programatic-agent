/**
 * The FIRST-RUN SETUP FLOW: the conversation that turns a fresh checkout into
 * a huu that is ready to operate, the way the user wants it.
 *
 * It answers three questions and nothing else:
 *   1. which front-end — the browser UI (`web`, huu's default) or the Ink TUI;
 *   2. which runtime — inside the container (`docker`, the default) or
 *      straight on the host (`native`, which costs isolation and is therefore
 *      shown its price before it can be confirmed);
 *   3. which credentials are missing — OpenRouter and Brave are what huu needs
 *      to operate; DeepSeek is offered once and genuinely skippable.
 *
 * ## Why this file is pure and the I/O is injected
 *
 * The flow has to be provable without a terminal. `runSetupFlow` therefore
 * takes every side effect as a dependency — asking, writing, validating,
 * saving — so the whole conversation can be driven from a Node test with
 * scripted answers and a fake validator, and the assertions land on the
 * structured {@link SetupOutcome} instead of on screen text. {@link planSetup}
 * is pure on top of that: given the stored config and which keys already
 * resolve, it decides WHAT will be asked, with no clock, disk or network.
 *
 * The real wiring lives in `setup-prompt.ts` (readline + the registry + the
 * key validator). Nothing here imports it — the dependency points that way on
 * purpose.
 *
 * ## The three rules the flow may never break
 *
 * - **It never traps the user.** Every question has a bounded number of
 *   attempts, `null` (EOF / Ctrl+D / a closed stream) aborts cleanly, and a
 *   non-interactive process skips the whole conversation instead of waiting on
 *   a stdin that will never produce a line.
 * - **Only a REJECTED key blocks.** `invalid` (the provider said 401/403) and
 *   `wrong-key` (this is some other provider's credential) re-ask.
 *   `unverifiable` — network down, timeout, 429, 5xx — warns and lets the user
 *   through, because "we could not check" is not "it is bad". That split is
 *   `key-validation.ts`'s whole design and this module only consumes it.
 * - **A raw key never reaches the output.** Values are echoed back through
 *   `maskKey` only; the flow writes the label and a fingerprint, never the
 *   credential.
 *
 * Pure + leaf (`src/lib`), no upward imports.
 */

import type { ApiKeySource } from './api-key.js';
import { maskKey } from './api-key.js';
import type { ApiKeySpec } from './api-key-registry.js';
import type { KeyVerdict } from './key-validation.js';
import { t } from './i18n/index.js';
import {
  isSetupComplete,
  isSetupInterface,
  isSetupRuntime,
  type SetupConfig,
  type SetupInterface,
  type SetupRuntime,
} from './setup-config.js';

// ───────────────────────────── what gets asked ─────────────────────────────

/**
 * How badly huu wants a credential.
 *
 * `required` — huu cannot do the job without it, so a missing one reopens the
 * question on every start until it is supplied (that IS "depois só o que
 * faltar"). `optional` — offered exactly once, during the first run, and never
 * nagged about again; `huu setup` re-offers it on demand.
 */
export type SetupKeyRole = 'required' | 'optional';

/**
 * The credentials the setup flow knows how to ask for, in the order it asks.
 *
 * OpenRouter first because it is the credential a RUN spends — without it huu
 * has no model. Brave second: it is the only search backend the `external`
 * research lane has, so a missing one degrades a capability rather than
 * stopping a run. DeepSeek last and OPTIONAL, exactly as the product owner
 * framed it ("e opcionalmente do deepseek") — huu already ships a second
 * provider, so a user who only has one key must never be made to feel they are
 * missing something mandatory.
 *
 * Names are `ApiKeySpec.name` values from `api-key-registry.ts`; a name with no
 * spec is silently ignored, so the flow can never crash on a registry rename.
 */
export const SETUP_KEY_ROLES: readonly { readonly name: string; readonly role: SetupKeyRole }[] = [
  { name: 'openrouter', role: 'required' },
  { name: 'brave', role: 'required' },
  { name: 'deepseek', role: 'optional' },
];

/** What the resolver already knows about one credential, value-free. */
export interface SetupKeyState {
  /** Which tier supplied a value (`'none'` when nothing did). */
  source: ApiKeySource;
  /** Masked fingerprint of the resolved value — `''` when there is none. */
  masked: string;
}

/** One credential the flow intends to ask about. */
export interface SetupKeyRequest {
  spec: ApiKeySpec;
  role: SetupKeyRole;
  /** The value huu can already resolve, if any. Never the raw key. */
  present: SetupKeyState | null;
}

/** Everything the flow will ask, decided before a single character is read. */
export interface SetupPlan {
  askInterface: boolean;
  askRuntime: boolean;
  keys: SetupKeyRequest[];
  /** True when there is literally nothing to ask — boot straight through. */
  empty: boolean;
}

export interface SetupPlanInput {
  /** The stored choices, as `loadSetupConfig()` returned them. */
  config: SetupConfig;
  /** `huu setup`: re-open everything, including what is already answered. */
  forced: boolean;
  /** Per-spec resolver state, keyed by `ApiKeySpec.name`. */
  keys: Record<string, SetupKeyState>;
  /** The registry lookup — injected so the planner stays pure. */
  findSpec: (name: string) => ApiKeySpec | undefined;
}

/**
 * Decide what the flow will ask. Pure: no disk, no clock, no network.
 *
 * The interface and runtime questions are asked when the setup has never been
 * completed, or when the user explicitly reopened it. Credentials follow the
 * role table: a missing `required` key is asked every time (huu genuinely
 * cannot operate without it), a missing `optional` key only during the first
 * run, and a key that already resolves is only revisited under `huu setup` —
 * which is what "não deve ser pedida de novo" means for a value already sitting
 * in an env var or the config store.
 */
export function planSetup(input: SetupPlanInput): SetupPlan {
  const firstRun = !isSetupComplete(input.config);
  const askInterface = input.forced || firstRun;
  const askRuntime = input.forced || firstRun;

  const keys: SetupKeyRequest[] = [];
  for (const entry of SETUP_KEY_ROLES) {
    const spec = input.findSpec(entry.name);
    if (!spec) continue;
    const state = input.keys[entry.name];
    const present = state && state.source !== 'none' ? state : null;

    if (input.forced) {
      keys.push({ spec, role: entry.role, present });
      continue;
    }
    if (present) continue; // already resolvable — never ask again
    if (entry.role === 'required' || firstRun) {
      keys.push({ spec, role: entry.role, present: null });
    }
  }

  return {
    askInterface,
    askRuntime,
    keys,
    empty: !askInterface && !askRuntime && keys.length === 0,
  };
}

// ─────────────────────────── when the gate opens ───────────────────────────

/**
 * The `huu <sub>` spellings that must NEVER be gated by the setup flow.
 *
 * They either print (`--help`), inspect the host (`status`, `prune`,
 * `init-docker`, `lab`) or read a file (`graph`) — none of them spends a
 * credential or needs a front-end, so stopping them to ask which UI the user
 * prefers would be a toll with nothing behind it. `huu status` in particular is
 * what somebody types when huu is already misbehaving.
 *
 * It covers `docker-reexec.ts`'s `NATIVE_ONLY_SUBCOMMANDS` with EXACTLY ONE
 * exception, and the exception is the point: `setup` runs natively too, but it
 * is the command that OPENS this flow — exempting it here would make `huu
 * setup` a no-op. It is handled above instead, as the forced reopen. In the
 * other direction the list is wider: `graph` is not native-only (it re-execs
 * into the container like any run) yet still must not be interrupted, because
 * it only prints a file listing.
 *
 * So: `NATIVE_ONLY_SUBCOMMANDS − {setup} ⊆ SETUP_EXEMPT_SUBCOMMANDS`, and
 * `setup` is deliberately absent. `setup-flow.test.ts` pins both halves of that
 * relationship so the two sets cannot drift apart silently.
 */
export const SETUP_EXEMPT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'init-docker',
  'status',
  'prune',
  'lab',
  'graph',
]);

/** The subcommand that reopens the flow on demand. */
export const SETUP_SUBCOMMAND = 'setup';

/**
 * The env channel the `npm start` wrapper uses to hand its CHILD the choices
 * the gate just resolved.
 *
 * ## The divergence this closes
 *
 * The wrapper decides with the config it holds IN MEMORY; the child re-reads
 * the disk. Those two are the same object exactly as long as the write
 * succeeded — and `markSetupComplete` is best-effort by design, so it can
 * return `false` (config dir not writable; a `sudo npm start` that left
 * `config.json` owned by root; a full disk). In that state the wrapper obeyed
 * `interface=cli, runtime=native` while the child read the defaults and
 * re-execed into Docker: BOTH axes inverted in one start, and — the part that
 * actually bites — the image build was SKIPPED (native) while the `docker run`
 * happened anyway, which is precisely the stale-image trap `ensure-image.sh`
 * exists to close.
 *
 * So the resolved choices travel out-of-band, next to the `done` marker that
 * already says "the gate ran".
 *
 * ## Why this tier and not `HUU_NO_DOCKER=1` / `HUU_CLI=1`
 *
 * Those two are the ENV tier: they outrank the saved config *and* `--docker`
 * (`decideReexec` puts the bypasses above it, deliberately). Re-broadcasting a
 * CONFIG-tier answer through an ENV-tier var would therefore invert the
 * precedence the moment the flags disagree — `--docker` on a machine whose
 * saved runtime is `native` must still get the container — and it only carries
 * one direction anyway (there is no "force docker" env var, so a user who just
 * switched native→docker under a failed save would still diverge).
 *
 * These vars are read by {@link resolveSetupChoices} and fed to `decideReexec`
 * / `decideInterfaceMode` in the SAME argument the disk config would have
 * occupied. Precedence is untouched: flag > env > (this, or the disk) >
 * default.
 */
export const SETUP_GATE_ENV = {
  /** "The gate already ran — do not open the conversation again." */
  done: 'HUU_SETUP_GATE_DONE',
  /** The front-end the gate settled on, as a {@link SetupInterface} literal. */
  interface: 'HUU_SETUP_GATE_INTERFACE',
  /** The runtime the gate settled on, as a {@link SetupRuntime} literal. */
  runtime: 'HUU_SETUP_GATE_RUNTIME',
} as const;

/**
 * The env the start wrapper adds to its child: the marker plus the two choices
 * in force. Pure — the caller merges it into the child environment.
 */
export function setupGateEnv(config: Pick<SetupConfig, 'interface' | 'runtime'>): Record<string, string> {
  return {
    [SETUP_GATE_ENV.done]: '1',
    [SETUP_GATE_ENV.interface]: config.interface,
    [SETUP_GATE_ENV.runtime]: config.runtime,
  };
}

/**
 * The choices a process should obey: what the gate resolved when it was handed
 * down, otherwise what is on disk.
 *
 * Each axis is taken independently, and only when the value is a literal this
 * version understands — a garbled or partial channel degrades to the stored
 * value rather than to a default, so this can never be worse than not reading
 * the env at all. `completed` is left as the disk reported it: it answers "has
 * the user been through the flow", which a handed-down choice does not change
 * (and a failed save genuinely leaves it `false`).
 *
 * Pure over (config, env) so every precedence branch is testable with no disk.
 */
export function resolveSetupChoices(stored: SetupConfig, env: NodeJS.ProcessEnv): SetupConfig {
  const ui = env[SETUP_GATE_ENV.interface];
  const runtime = env[SETUP_GATE_ENV.runtime];
  if (!isSetupInterface(ui) && !isSetupRuntime(runtime)) return stored;
  return {
    ...stored,
    interface: isSetupInterface(ui) ? ui : stored.interface,
    runtime: isSetupRuntime(runtime) ? runtime : stored.runtime,
  };
}

export interface SetupGateDecision {
  /** Whether the setup flow should be consulted at all on this invocation. */
  run: boolean;
  /** `huu setup`: re-ask everything, not only what is missing. */
  forced: boolean;
  reason: string;
}

/**
 * Should this invocation consult the setup flow? Pure over argv + env.
 *
 * The order is the contract:
 *   1. inside the container — the HOST already answered, and the container has
 *      no terminal of its own to answer with. Prompting here would deadlock the
 *      one path that cannot be interrupted.
 *   2. `huu setup` — the explicit reopen. It sits ABOVE BOTH env markers and
 *      every exemption below, for the same reason a flag outranks an env var
 *      everywhere else in this codebase: a user who TYPED the command means it,
 *      and an env var exported in a shell profile silently doing nothing would
 *      be the worst possible answer to it. That covers `HUU_SETUP_GATE_DONE`
 *      too — the marker is the wrapper telling the CHILD "already asked", and
 *      the wrapper never spawns a child with `setup` in argv (it configures and
 *      stops), so a `setup` that reaches here WITH the marker set is either a
 *      stale export or a user driving the CLI by hand. Both mean the same
 *      thing: they typed `setup`, so ask.
 *   3. `HUU_SETUP_GATE_DONE=1` — `npm start`'s host orchestrator ran the flow
 *      moments ago and is now spawning the CLI; asking twice is a bug.
 *   4. `HUU_SKIP_SETUP=1` — the operator escape hatch. Documented, and the
 *      reason automation never has to fight this feature.
 *   5. `--help` and the host utilities — see {@link SETUP_EXEMPT_SUBCOMMANDS}.
 *   6. otherwise: consult it. Whether anything is actually ASKED is then
 *      {@link planSetup}'s decision, not this one.
 */
export function decideSetupGate(args: string[], env: NodeJS.ProcessEnv): SetupGateDecision {
  if (env.HUU_IN_CONTAINER === '1') {
    return { run: false, forced: false, reason: 'inside the container — the host already asked' };
  }
  const firstNonFlag = args.find((a) => !a.startsWith('-'));
  if (firstNonFlag === SETUP_SUBCOMMAND) {
    return { run: true, forced: true, reason: 'huu setup — reopening every question' };
  }
  if (env[SETUP_GATE_ENV.done] === '1') {
    return { run: false, forced: false, reason: 'the start wrapper already ran the setup gate' };
  }
  if (env.HUU_SKIP_SETUP === '1' || env.HUU_SKIP_SETUP === 'true') {
    return { run: false, forced: false, reason: 'HUU_SKIP_SETUP=1' };
  }
  if (args.includes('--help') || args.includes('-h')) {
    return { run: false, forced: false, reason: 'help flag — prints and exits' };
  }
  if (firstNonFlag && SETUP_EXEMPT_SUBCOMMANDS.has(firstNonFlag)) {
    return { run: false, forced: false, reason: `${firstNonFlag} never needs the setup` };
  }
  return { run: true, forced: false, reason: 'normal start — ask for whatever is missing' };
}

// ───────────────────────────── running the flow ─────────────────────────────

/** One question put to the user. `text` is already translated. */
export interface SetupQuestion {
  text: string;
  /** Hide the typed characters — used for credentials only. */
  secret?: boolean;
}

/**
 * Ask one question. Resolves with the raw line, or `null` when there is no
 * answer to be had (EOF, Ctrl+D, a closed stream, an aborted flow). `null` is
 * an ABORT signal, never an empty answer: an empty answer is `''`.
 */
export type SetupAsk = (question: SetupQuestion) => Promise<string | null>;

export interface SetupFlowDeps {
  plan: SetupPlan;
  config: SetupConfig;
  /**
   * Whether a human can actually answer. `false` (a pipe, CI, `npm start` from
   * a script) makes the flow return the current choices untouched instead of
   * blocking on a stdin nobody will type into.
   */
  interactive: boolean;
  ask: SetupAsk;
  /** Emit one already-translated line of chrome. Goes to stderr in production. */
  write: (line: string) => void;
  validate: (spec: ApiKeySpec, value: string) => Promise<KeyVerdict>;
  /**
   * Persist one accepted credential. Returns FALSE when the value could not be
   * written (an unwritable config dir, a `config.json` owned by root, a full
   * disk) — never throws, and never reports success it did not have. The flow
   * turns a `false` into a warning the user can act on; telling them a key was
   * "saved" when nothing reached the disk is how somebody closes the terminal
   * believing they are configured.
   */
  saveKey: (spec: ApiKeySpec, value: string) => boolean;
  saveChoices: (ui: SetupInterface, runtime: SetupRuntime) => boolean;
}

/** What the flow settled on — the structured record tests assert against. */
export interface SetupOutcome {
  interface: SetupInterface;
  runtime: SetupRuntime;
  /** True when the choices were persisted and the setup is now complete. */
  completed: boolean;
  /** False when the flow never asked anything (non-interactive, or nothing to do). */
  asked: boolean;
  /** Spec names whose key was accepted AND actually written to disk. */
  savedKeys: string[];
  /** Spec names the user (or the flow) left unset. */
  skippedKeys: string[];
  /**
   * Spec names the user supplied and the provider accepted, but that the store
   * REFUSED to keep. Not `savedKeys` (nothing was saved) and not `skippedKeys`
   * (the user did supply one) — a third state, because the fix is a third
   * thing: make the config dir writable, or export the env var for this shell.
   */
  unsavedKeys: string[];
  /** True when the user closed the input mid-flow; nothing was persisted. */
  aborted: boolean;
}

/** How many times a question is re-asked before the flow gives up on it. */
export const MAX_ATTEMPTS = 3;

function outcomeFromConfig(config: SetupConfig, patch: Partial<SetupOutcome>): SetupOutcome {
  return {
    interface: config.interface,
    runtime: config.runtime,
    completed: false,
    asked: false,
    savedKeys: [],
    skippedKeys: [],
    unsavedKeys: [],
    aborted: false,
    ...patch,
  };
}

/** The human name of the tier a key came from, for the "already set" line. */
function sourceLabel(source: ApiKeySource): string {
  switch (source) {
    case 'env':
      return t('cli.setup_src_env');
    case 'env-file':
      return t('cli.setup_src_env_file');
    case 'stored':
      return t('cli.setup_src_stored');
    case 'secret-mount':
      return t('cli.setup_src_mount');
    default:
      return t('cli.setup_src_none');
  }
}

/**
 * Ask a two-option question and return the chosen literal.
 *
 * An empty line takes the default (shown in the prompt). Anything the parser
 * does not recognise is re-asked up to {@link MAX_ATTEMPTS} times and then
 * falls back to the default — a typo must cost a retry, never the session.
 * `null` from `ask` aborts, and the caller distinguishes that from a default.
 */
async function askChoice<T extends string>(
  deps: Pick<SetupFlowDeps, 'ask' | 'write'>,
  text: string,
  parse: (raw: string) => T | undefined,
  fallback: T,
): Promise<T | null> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const line = await deps.ask({ text });
    if (line === null) return null;
    const trimmed = line.trim();
    if (!trimmed) return fallback;
    const parsed = parse(trimmed.toLowerCase());
    if (parsed) return parsed;
    deps.write(t('cli.setup_invalid_choice', { value: trimmed }));
  }
  deps.write(t('cli.setup_using_default', { value: fallback }));
  return fallback;
}

/** `y`/`yes`/`s`/`sim` is a yes; everything else (including empty) is a no. */
function isYes(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  return v === 'y' || v === 'yes' || v === 's' || v === 'sim';
}

/**
 * Run the setup conversation.
 *
 * Never throws, never blocks without a human, and never persists a partial
 * answer: the choices are written in ONE call at the end, so a Ctrl+C halfway
 * through leaves the previous state exactly as it was and the flow simply runs
 * again next time. Keys are the exception, and deliberately so — a validated
 * credential is saved the moment it is accepted, because losing a key the user
 * just pasted (and huu just confirmed) to a later abort would be gratuitous.
 */
export async function runSetupFlow(deps: SetupFlowDeps): Promise<SetupOutcome> {
  const { plan, config } = deps;

  if (plan.empty) return outcomeFromConfig(config, {});

  // No terminal: state the defaults being used and get out of the way. This is
  // the CI / pipe / `npm start` inside a script path — hanging on a stdin that
  // will never deliver a line is the one failure mode this flow must not have.
  // Nothing is persisted, so the next interactive start still asks.
  if (!deps.interactive) {
    deps.write(
      t('cli.setup_no_tty', { ui: config.interface, runtime: config.runtime }),
    );
    return outcomeFromConfig(config, {});
  }

  deps.write(t('cli.setup_title'));
  deps.write(t('cli.setup_intro'));

  let ui = config.interface;
  let runtime = config.runtime;
  const savedKeys: string[] = [];
  const skippedKeys: string[] = [];
  const unsavedKeys: string[] = [];

  // ── 1. the front-end ──────────────────────────────────────────────────
  if (plan.askInterface) {
    deps.write(t('cli.setup_opt_interface_web'));
    deps.write(t('cli.setup_opt_interface_cli'));
    const answer = await askChoice<SetupInterface>(
      deps,
      t('cli.setup_q_interface', { default: ui }),
      (raw) => {
        if (raw === '1' || raw === 'web' || raw === 'w') return 'web';
        if (raw === '2' || raw === 'cli' || raw === 'tui' || raw === 'c') return 'cli';
        return undefined;
      },
      ui,
    );
    if (answer === null) {
      deps.write(t('cli.setup_aborted'));
      return outcomeFromConfig(config, {
        asked: true,
        aborted: true,
        savedKeys,
        skippedKeys,
        unsavedKeys,
      });
    }
    ui = answer;
  }

  // ── 2. the runtime, and the price of leaving the container ────────────
  if (plan.askRuntime) {
    deps.write(t('cli.setup_opt_runtime_docker'));
    deps.write(t('cli.setup_opt_runtime_native'));
    const answer = await askChoice<SetupRuntime>(
      deps,
      t('cli.setup_q_runtime', { default: runtime }),
      (raw) => {
        if (raw === '1' || raw === 'docker' || raw === 'd') return 'docker';
        if (raw === '2' || raw === 'native' || raw === 'n' || raw === 'host') return 'native';
        return undefined;
      },
      runtime,
    );
    if (answer === null) {
      deps.write(t('cli.setup_aborted'));
      return outcomeFromConfig(config, {
        asked: true,
        aborted: true,
        savedKeys,
        skippedKeys,
        unsavedKeys,
      });
    }
    runtime = answer;

    // Choosing `native` SHOWS THE COST BEFORE IT CONFIRMS. The two things lost
    // are not invented here: they are what `cli.warn_dev_native` already tells
    // contributors on every `npm run dev` — the agent reaches the shell
    // credentials the container was hiding (~/.ssh, ~/.aws, …), and the
    // container's kernel memory ceiling is gone.
    if (runtime === 'native') {
      deps.write(t('cli.setup_native_cost'));
      const confirm = await deps.ask({ text: t('cli.setup_native_confirm') });
      if (confirm === null) {
        deps.write(t('cli.setup_aborted'));
        return outcomeFromConfig(config, {
        asked: true,
        aborted: true,
        savedKeys,
        skippedKeys,
        unsavedKeys,
      });
      }
      if (!isYes(confirm)) {
        runtime = 'docker';
        deps.write(t('cli.setup_native_declined'));
      }
    }
  }

  // ── 3. the credentials ────────────────────────────────────────────────
  if (plan.keys.length > 0) deps.write(t('cli.setup_keys_header'));

  /**
   * Accept one credential: persist it, then say WHAT ACTUALLY HAPPENED.
   *
   * A store that refuses the write WARNS, it does not block — three reasons,
   * in order of weight. (1) The flow's first rule is that it never traps the
   * user: an unwritable `~/.config/huu` would otherwise become a hard lockout
   * from a tool that can still run perfectly well with the key exported into
   * the environment. (2) It would be inconsistent with the choices right below,
   * where a failed save already degrades to "you will be asked again". (3) The
   * only harm in the finding was the LIE — "saved" printed over a disk that
   * received nothing — and the honest line fixes exactly that: it names the env
   * var to export, and the key never enters `savedKeys`.
   */
  const keep = (spec: ApiKeySpec, value: string): void => {
    if (deps.saveKey(spec, value)) {
      savedKeys.push(spec.name);
      deps.write(t('cli.setup_key_saved', { label: spec.label, masked: maskKey(value) }));
      return;
    }
    unsavedKeys.push(spec.name);
    deps.write(t('cli.setup_key_save_failed', { label: spec.label, envVar: spec.envVar }));
  };

  for (const req of plan.keys) {
    const { spec } = req;
    if (req.present) {
      deps.write(
        t('cli.setup_key_present', {
          label: spec.label,
          source: sourceLabel(req.present.source),
          masked: req.present.masked,
        }),
      );
    }
    deps.write(
      req.role === 'optional'
        ? t('cli.setup_key_optional_hint', { label: spec.label })
        : t('cli.setup_key_required_hint', { label: spec.label }),
    );
    if (spec.hint) deps.write(t('cli.setup_key_hint', { hint: spec.hint }));

    let settled = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS && !settled; attempt++) {
      const line = await deps.ask({
        text: t('cli.setup_key_prompt', { label: spec.label }),
        secret: true,
      });
      if (line === null) {
        deps.write(t('cli.setup_aborted'));
        return outcomeFromConfig(config, {
          interface: ui,
          runtime,
          asked: true,
          aborted: true,
          savedKeys,
          skippedKeys,
          unsavedKeys,
        });
      }

      const value = line.trim();
      if (!value) {
        // Empty = "not now". Keeping an existing value is not a skip.
        if (req.present) {
          deps.write(t('cli.setup_key_kept', { label: spec.label }));
        } else {
          skippedKeys.push(spec.name);
          deps.write(
            req.role === 'optional'
              ? t('cli.setup_key_skipped_optional', { label: spec.label })
              : t('cli.setup_key_skipped_required', { label: spec.label }),
          );
        }
        settled = true;
        break;
      }

      const verdict = await deps.validate(spec, value);
      switch (verdict.status) {
        case 'valid':
          keep(spec, value);
          settled = true;
          break;
        case 'unverifiable':
          // We could not find out. That is not evidence against the key, so it
          // warns and passes — the user is not locked out by a flaky network.
          deps.write(
            t('cli.setup_key_unverifiable', { label: spec.label, reason: verdict.reason }),
          );
          keep(spec, value);
          settled = true;
          break;
        case 'invalid':
          // The provider itself rejected it. The only blocking verdict.
          deps.write(
            t('cli.setup_key_invalid', { label: spec.label, status: String(verdict.httpStatus) }),
          );
          break;
        case 'wrong-key':
          // A credential that belongs somewhere else. Blocking too: saving it
          // here would ship one provider's secret to another provider's host.
          deps.write(
            t('cli.setup_key_wrong', { label: spec.label, belongsTo: verdict.label }),
          );
          break;
      }
    }

    if (!settled) {
      // Attempts exhausted. Say so and move on — a rejected key must not be
      // able to hold the whole start hostage.
      skippedKeys.push(spec.name);
      deps.write(t('cli.setup_key_attempts', { label: spec.label }));
    }
  }

  // ── 4. persist, in one write ──────────────────────────────────────────
  const saved = deps.saveChoices(ui, runtime);
  if (!saved) deps.write(t('cli.setup_save_failed'));
  deps.write(t('cli.setup_done', { ui, runtime }));
  deps.write(t('cli.setup_reopen_hint'));

  return {
    interface: ui,
    runtime,
    completed: saved,
    asked: true,
    savedKeys,
    skippedKeys,
    unsavedKeys,
    aborted: false,
  };
}

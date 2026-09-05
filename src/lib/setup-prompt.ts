/**
 * The I/O half of the first-run setup: a readline prompter and the composition
 * root that wires `setup-flow.ts`'s pure conversation to the real registry, the
 * real key validator and the real config store.
 *
 * ## Why readline and not Ink
 *
 * This runs at the very TOP of `cli.tsx`, before the Docker gate and therefore
 * before React/Ink are imported — the module-purity rule the wrapper path
 * depends on (see following-architecture-conventions: "cli.tsx runs the Docker
 * re-exec gate at the very top … any module side effect would also run on the
 * host wrapper path, where the TUI must not initialize"). Mounting Ink here
 * would pay for React on every host invocation AND put two stdin consumers in
 * the same process, which is the documented way to make an Ink app and a
 * readline fight over raw mode. `node:readline` is dependency-free, needs no
 * raw mode of its own, and is torn down before anything else touches stdin.
 *
 * ## Credential echo is MUTED
 *
 * A pasted key would otherwise sit in the terminal's scrollback forever. The
 * masking uses readline's `_writeToOutput` seam — the canonical Node recipe —
 * and is written so that if that seam ever disappears the prompt still WORKS,
 * merely unmasked: a Node upgrade must not be able to make huu unable to ask
 * for a key. After a key is accepted the flow echoes `maskKey(value)` so the
 * user can still confirm which credential landed.
 */

import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { API_KEY_REGISTRY, findSpec, maskKey, resolveApiKeyWithSource, saveApiKey } from './api-key.js';
import type { ApiKeySpec } from './api-key-registry.js';
import { validateKeyForSpec } from './key-validation.js';
import {
  loadSetupConfig,
  markSetupComplete,
  type SetupConfig,
} from './setup-config.js';
import {
  decideSetupGate,
  planSetup,
  runSetupFlow,
  type SetupKeyState,
  type SetupOutcome,
  type SetupPlan,
  type SetupQuestion,
} from './setup-flow.js';

/** A live prompter over a pair of streams. `close()` releases stdin. */
export interface SetupPrompter {
  ask: (question: SetupQuestion) => Promise<string | null>;
  close: () => void;
}

/**
 * True when a human can actually answer on this stdin.
 *
 * `Boolean(...)` is load-bearing: `stdin.isTTY` is `undefined` — not `false` —
 * when stdin is a pipe, and a bare `undefined` propagated into a consumer that
 * expects a boolean is exactly the shape that made Ink throw on mount
 * elsewhere in this codebase. Read it once, coerce it once.
 */
export function isInteractiveStdin(
  stdin: NodeJS.ReadStream = process.stdin,
): boolean {
  return Boolean(stdin.isTTY);
}

/**
 * Build a readline-backed prompter.
 *
 * `close()` is idempotent and MUST be called: an open readline interface keeps
 * the event loop alive and holds stdin in a mode the TUI would otherwise
 * inherit. Ctrl+C closes the interface, which makes the pending `ask` resolve
 * `null` — the flow reads that as an abort and unwinds cleanly instead of the
 * process dying mid-question.
 */
export function createStdioPrompter(
  input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
): SetupPrompter {
  const rl: ReadlineInterface = createInterface({
    input,
    output,
    terminal: true,
  });

  let closed = false;
  const markClosed = () => {
    closed = true;
  };
  rl.once('close', markClosed);
  // With `terminal: true` readline swallows the default SIGINT behaviour and
  // emits this instead. Close, so the pending question resolves `null` and the
  // caller decides how to exit — the alternative is a Ctrl+C the flow ignores.
  rl.on('SIGINT', () => {
    rl.close();
  });

  // ── credential echo masking (best-effort, never load-bearing) ──────────
  let muted = false;
  const seam = rl as unknown as { _writeToOutput?: (s: string) => void };
  const originalWrite = seam._writeToOutput;
  if (typeof originalWrite === 'function') {
    seam._writeToOutput = function patched(this: unknown, s: string): void {
      if (!muted) {
        originalWrite.call(this, s);
        return;
      }
      // One bullet per output event. Backspaces add a bullet rather than
      // removing one — visually imperfect, but it can never leak a character.
      output.write('*');
    };
  }

  const ask = (question: SetupQuestion): Promise<string | null> =>
    new Promise<string | null>((resolve) => {
      if (closed) {
        resolve(null);
        return;
      }
      let done = false;
      const finish = (value: string | null) => {
        if (done) return;
        done = true;
        muted = false;
        rl.removeListener('close', onClose);
        resolve(value);
      };
      const onClose = () => finish(null);
      rl.once('close', onClose);

      // `rl.question` writes the prompt SYNCHRONOUSLY, so muting immediately
      // after the call hides the typed characters while leaving the question
      // itself on screen.
      rl.question(question.text, (answer) => {
        if (question.secret) output.write('\n');
        finish(answer);
      });
      if (question.secret) muted = true;
    });

  return {
    ask,
    close: () => {
      if (!closed) rl.close();
    },
  };
}

/** Everything the gate needs, with every side effect overridable for tests. */
export interface SetupGateOptions {
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Override the argv/env decision (used by the `setup` subcommand). */
  forced?: boolean;
  /** Override TTY detection. */
  interactive?: boolean;
  /**
   * How to obtain a prompter. A FACTORY, not an instance, and deliberately so:
   * building one opens readline on stdin, which changes the stream's mode and
   * keeps the event loop alive. On the overwhelmingly common path — a machine
   * that is already set up — the gate must not touch stdin at all, so nothing
   * may be constructed until there is a question to ask. Injected by tests.
   */
  openPrompter?: () => SetupPrompter;
  write?: (line: string) => void;
}

export interface SetupGateResult {
  /** Whether the gate even considered running (argv/env said yes). */
  considered: boolean;
  /** Whether the flow actually ran a conversation. */
  ran: boolean;
  /** The choices in force AFTER the gate — what the caller should obey. */
  config: SetupConfig;
  outcome: SetupOutcome;
  plan: SetupPlan;
}

/** Value-free snapshot of what the resolver can already find, per spec. */
export function collectKeyStates(): Record<string, SetupKeyState> {
  const states: Record<string, SetupKeyState> = {};
  for (const spec of API_KEY_REGISTRY) {
    const res = resolveApiKeyWithSource(spec);
    states[spec.name] = {
      source: res.source,
      masked: res.value ? maskKey(res.value) : '',
    };
  }
  return states;
}

/**
 * Run the first-run setup when it is needed, and report the choices in force.
 *
 * Never throws: a failed save degrades to "ask again next time", and a config
 * store that cannot be read already degrades to defaults inside
 * `loadSetupConfig`. The returned `config` is always usable — on the paths
 * where nothing was asked it is simply what was already on disk.
 */
export async function runSetupGate(opts: SetupGateOptions): Promise<SetupGateResult> {
  const decision = decideSetupGate(opts.args, opts.env);
  const forced = opts.forced ?? decision.forced;
  const config = loadSetupConfig();

  const emptyPlan: SetupPlan = { askInterface: false, askRuntime: false, keys: [], empty: true };
  if (!decision.run && !opts.forced) {
    return {
      considered: false,
      ran: false,
      config,
      plan: emptyPlan,
      outcome: {
        interface: config.interface,
        runtime: config.runtime,
        completed: false,
        asked: false,
        savedKeys: [],
        skippedKeys: [],
        unsavedKeys: [],
        aborted: false,
      },
    };
  }

  const plan = planSetup({ config, forced, keys: collectKeyStates(), findSpec });
  const write = opts.write ?? ((line: string) => process.stderr.write(line + '\n'));

  // Nothing to ask: do not so much as open stdin.
  if (plan.empty) {
    return {
      considered: true,
      ran: false,
      config,
      plan,
      outcome: {
        interface: config.interface,
        runtime: config.runtime,
        completed: false,
        asked: false,
        savedKeys: [],
        skippedKeys: [],
        unsavedKeys: [],
        aborted: false,
      },
    };
  }

  const interactive = opts.interactive ?? isInteractiveStdin();
  // A prompter is only built when someone can answer — opening readline on a
  // pipe would put stdin into a mode the rest of the process then inherits.
  const open = opts.openPrompter ?? createStdioPrompter;
  const prompter = interactive ? open() : null;

  try {
    const outcome = await runSetupFlow({
      plan,
      config,
      interactive: interactive && prompter !== null,
      ask: prompter ? prompter.ask : async () => null,
      write,
      validate: (spec: ApiKeySpec, value: string) => validateKeyForSpec(spec, value),
      saveKey: (spec: ApiKeySpec, value: string) => {
        try {
          saveApiKey(spec, value);
          return true;
        } catch {
          // A key we could not persist is not a reason to abort the start — the
          // user can still export the env var — but it IS a reason to say so.
          // Swallowing this is what printed "OpenRouter: saved (sk-or-…DKEY)"
          // over a config dir that received nothing, and sent the user off
          // believing they were configured. The `false` travels to
          // `runSetupFlow`, which warns and keeps the name out of `savedKeys`.
          // Never surface the value, here or there.
          return false;
        }
      },
      saveChoices: markSetupComplete,
    });

    return {
      considered: true,
      ran: outcome.asked,
      config: outcome.completed ? loadSetupConfig() : { ...config, interface: outcome.interface, runtime: outcome.runtime },
      plan,
      outcome,
    };
  } finally {
    // Always released: a readline interface left open holds stdin in a mode
    // the TUI would inherit, and keeps the process alive after the CLI is done.
    prompter?.close();
  }
}

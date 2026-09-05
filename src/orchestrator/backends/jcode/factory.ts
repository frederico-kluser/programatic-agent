import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { API_KEY_REGISTRY } from '../../../lib/api-key-registry.js';
import {
  jcodeMissingApiKeyMessage,
  jcodeMissingExecutableMessage,
} from '../../../lib/jcode-bundle.js';
import {
  modelIdForProvider,
  resolveRunProvider,
  DEFAULT_PROVIDER,
  type LlmProvider,
} from '../../../lib/providers.js';
import type { AgentEvent, AgentFactory, SpawnedAgent } from '../../types.js';
import { buildAgentMessageHeader } from '../_shared/build-message.js';
import { createDisposableState } from '../_shared/lifecycle.js';
import { translateJcodeOutput } from './event-mapper.js';
import {
  buildJcodeSessionEnvironment,
  jcodeApiKeyEnvVar,
  jcodeProviderProfile,
} from './hermetic.js';

/**
 * jcodeAgentFactory — spawns `jcode run` as a subprocess.
 *
 * Unlike the pi backend which uses the `@mariozechner/pi-coding-agent` SDK,
 * this backend invokes the `jcode` CLI via `child_process.spawn`. The
 * subprocess emits tagged stdout lines (`[write]`, `[tokens]`, `[thinking]`,
 * etc.) that the event mapper translates into uniform AgentEvents, and exits
 * when the turn completes.
 *
 * HOW THE PROMPT TRAVELS — argv, never stdin.
 * `jcode run --help` declares `Usage: jcode run [OPTIONS] <MESSAGE>`, where
 * `<MESSAGE>` ("The message to send") is a REQUIRED POSITIONAL. jcode has no
 * stdin channel at all: measured against jcode v0.67.1, the conventional `-`
 * sentinel was taken as the LITERAL message (the model replied to it) while
 * stdin was ignored.
 *
 * An earlier version of this header claimed "the subprocess receives the
 * prompt on stdin". That was false, and the argv this module built alongside it
 * carried no positional — so EVERY jcode spawn died at argument parsing with
 * `error: the following required arguments were not provided: <MESSAGE>`,
 * before the config, the profile or the key could matter. The backend had never
 * worked in any mode. {@link buildJcodeArgs} is now the single place that
 * decides argv, and {@link jcodeOversizedPromptMessage} guards the one limit
 * that carrying a prompt in argv imposes.
 *
 * Hermetic by default:
 *  - `JCODE_MEMORY_ENABLED=false` — zero embeddings, stateless runs.
 *  - `JCODE_NO_TELEMETRY=1` — no external telemetry.
 *  - Agent dir → `~/.huu/jcode-agent` — isolated runtime.
 *
 * The escape hatch `HUU_JCODE_HERMETIC=0` reverts to host-global jcode config.
 *
 * PROVIDER-DRIVEN, end to end. jcode serves BOTH providers huu exposes, and
 * three things must agree on which one this spawn is for:
 *   · `--provider-profile` — the `[providers.<name>]` block in the hermetic
 *     config.toml, i.e. the BASE URL the request is sent to;
 *   · `--model` — rendered in that endpoint's namespace
 *     ({@link modelIdForProvider});
 *   · the credential env var the profile reads (`api_key_env`).
 * All three are derived from `config.provider` here. Pinning any of them to a
 * constant is a CREDENTIAL LEAK, not a cosmetic bug: this module used to pass
 * `--provider-profile deepseek-v4-pro` unconditionally while injecting the key
 * huu resolved, so an OpenRouter run shipped its `sk-or-…` secret to
 * api.deepseek.com as a Bearer token.
 *
 * Credential: a subprocess has no channel but the environment, so
 * {@link withJcodeApiKey} injects the key huu already resolved
 * (`config.apiKey`) into the variable THAT provider's profile names. See that
 * function for why inheriting the parent's env is not enough (the container
 * gets the key as a secret MOUNT, never as an env var) and for why the OTHER
 * provider's key is stripped from the child env.
 */

/** CLI arguments common to every jcode spawn. */
const JCODE_BASE_ARGS = ['run', '--no-update'] as const;

/**
 * The argv for one `jcode run`, in the ONE order the CLI accepts.
 *
 * `jcode run --help` declares `Usage: jcode run [OPTIONS] <MESSAGE>`: every
 * option first, the message LAST and REQUIRED. Ordering is not stylistic —
 * options after the positional are read as a second positional and rejected.
 *
 * The `--` is not decoration either. Without it, a prompt whose first character
 * is `-` is parsed as a flag: measured, `jcode run … "--fix the bug"` dies with
 * `error: unexpected argument '--fix the bug' found` and jcode's own tip is
 * "to pass '--fix the bug' as a value, use '-- --fix the bug'". jcode consumes
 * the separator (verified: the model saw only the message). Today's header
 * always opens with `# Agent N — …`, but the prompt is user-authored text and
 * this backend must not depend on its first byte.
 *
 * The profile NAME comes from `hermetic.ts`, which writes the very same string
 * into the materialized config.toml. A literal here would be a second source of
 * truth for a string that MUST match: a rename on either side would leave jcode
 * dying on "Unknown provider profile …" instead of failing to compile.
 *
 * And it is keyed on the PROVIDER, never fixed. `--provider-profile <NAME>`
 * selects `[providers.<NAME>]`, i.e. the base_url and the api_key_env — measured
 * against jcode v0.81.4, it also implies `--provider openai-compatible`. A
 * constant profile therefore sends every run to ONE vendor whatever the user
 * chose, which is how an `sk-or-…` key ended up as a Bearer token at
 * api.deepseek.com.
 *
 * `--model` is rendered through {@link modelIdForProvider} for the same reason
 * in the other direction: jcode passes it VERBATIM to the endpoint (the
 * `[[providers.X.models]]` list is NOT an allowlist — an undeclared model goes
 * through untouched), so the id must already be written in that endpoint's
 * namespace. huu's catalog is OpenRouter-shaped (`vendor/model`); OpenRouter
 * takes it as-is, api.deepseek.com wants it bare.
 *
 * `provider` may be `undefined` — a caller that predates the choice. It then
 * resolves to the backend's default via {@link resolveRunProvider}, which also
 * discards a provider jcode does not serve rather than trusting it.
 */
export function buildJcodeArgs(
  modelId: string,
  promptText: string,
  provider?: LlmProvider,
): string[] {
  const active = resolveRunProvider('jcode', provider) ?? DEFAULT_PROVIDER;
  return [
    ...JCODE_BASE_ARGS,
    '--provider-profile',
    jcodeProviderProfile(active),
    '--model',
    modelIdForProvider(active, modelId),
    '--',
    promptText,
  ];
}

/**
 * Ceiling for the prompt, in BYTES, because it travels as ONE argv string.
 *
 * Linux caps a single argv entry at `MAX_ARG_STRLEN` = 32 pages, independently
 * of the far larger total `ARG_MAX`. MEASURED on this machine by binary search
 * over real `execve` calls: 131071 bytes accepted, 131072 → `E2BIG`. The total
 * budget is 2 MiB (1.5 MiB of argv accepted, 2 MiB refused), so the
 * PER-ARGUMENT cap is the one that binds — huu's argv is the prompt plus six
 * short options.
 *
 * 32 × 4 KiB is also the Linux FLOOR: 4 KiB is the smallest page size Linux
 * runs with, an arm64 kernel with 16 KiB pages allows 4× more, and macOS has no
 * per-argument cap at all. So this constant is safe everywhere huu runs, and
 * conservative on some.
 *
 * For scale — measured over all 60 steps of huu's 7 bundled pipelines, building
 * each full first-turn message through `buildAgentMessageHeader`: max 12581
 * bytes (`huu Knowledge System` step 1), p90 7260, p50 4524, and the fixed
 * header costs 1514. Real work therefore sits an order of magnitude under this
 * line; the guard exists for the pathological case (a hand-written step prompt,
 * or a `memory` spec that hands one agent thousands of owned paths), not the
 * normal one.
 */
export const JCODE_MAX_PROMPT_BYTES = 32 * 4096;

/**
 * `null` when the prompt fits in argv, otherwise the ACTIONABLE refusal.
 *
 * Why a guard instead of letting `execve` answer: Node reports `E2BIG` by
 * THROWING out of `spawn()` synchronously. libuv defers only
 * EAGAIN/EACCES/EMFILE/ENFILE/ENOENT to the `'error'` event, so an oversized
 * argv never reaches this module's `proc.on('error')` handler — the raw failure
 * is a bare `Error: spawn E2BIG` that lands on no agent log and names neither
 * jcode nor the prompt. (Measured, not inferred; it is the same class of
 * silent-failure this module already fixes for ENOENT and the missing key.)
 *
 * The boundary is exact rather than padded: `execve` accepts a string of at
 * most `JCODE_MAX_PROMPT_BYTES - 1` bytes because the kernel counts the NUL
 * terminator — hence `>=`, not `>`. Bytes, not characters: a prompt is UTF-8 on
 * the wire and one emoji costs four.
 */
export function jcodeOversizedPromptMessage(promptText: string): string | null {
  const bytes = Buffer.byteLength(promptText, 'utf8');
  if (bytes < JCODE_MAX_PROMPT_BYTES) return null;
  return [
    `jcode: prompt too large to spawn — ${bytes} bytes, and the limit is ${
      JCODE_MAX_PROMPT_BYTES - 1
    }.`,
    '',
    '`jcode run` takes its whole instruction as the <MESSAGE> positional, and',
    'Linux caps one argv string at MAX_ARG_STRLEN (32 pages = 128 KiB). That is',
    'an execve limit, not a huu policy: no jcode flag lifts it.',
    "For scale, huu's own bundled pipelines top out near 13 KB per agent, so a",
    'prompt this size almost always means one of:',
    '  1. a hand-written step `prompt` in the pipeline JSON that should be split',
    '     across steps — or trimmed to the instruction, pointing at a file the',
    '     agent reads for itself;',
    "  2. one task owning an enormous file list — narrow the step's scope so the",
    '     decomposer hands each agent fewer files; or',
    '  3. a `memory` spec whose "Files this task OWNS" section grew unbounded.',
    'If the prompt genuinely must stay this big, the pi backend has no such',
    'limit — it is an in-process SDK, not a subprocess.',
  ].join('\n');
}

/** Which tier supplied the credential the subprocess will see. */
export type JcodeApiKeySource = 'config' | 'env' | 'none';

export interface JcodeApiKeyInjection {
  /** A NEW env object (the input is never mutated) for `spawn`. */
  env: NodeJS.ProcessEnv;
  /** `config` = huu's resolved key, `env` = inherited, `none` = nothing to use. */
  source: JcodeApiKeySource;
  /** The provider the injection was made FOR, after resolution. */
  provider: LlmProvider;
  /** The variable {@link provider}'s jcode profile reads — where the key went. */
  envVar: string;
}

/**
 * Strip every OTHER LLM provider's credential out of the child environment.
 *
 * The active provider's profile reads exactly one variable, so an inherited
 * `DEEPSEEK_API_KEY` sitting next to an OpenRouter run is not read by jcode —
 * but it IS handed to an agent that runs arbitrary shell commands in the
 * worktree. A run must carry the credential it was authorized to spend and no
 * other, so the unrelated ones (and their `_FILE` companions, which point at a
 * file holding the same value) are removed.
 *
 * Only `providerBound` specs are touched: the research keys (Brave, Tavily,
 * Parallel) and Artificial Analysis are not provider credentials and the agent
 * tooling legitimately uses them. Mutates the object it is given — always a
 * fresh copy made by the caller.
 */
function stripForeignProviderKeys(
  env: NodeJS.ProcessEnv,
  active: LlmProvider,
): NodeJS.ProcessEnv {
  for (const spec of API_KEY_REGISTRY) {
    if (!spec.providerBound || spec.providerBound === active) continue;
    delete env[spec.envVar];
    delete env[spec.envFileVar];
  }
  return env;
}

/**
 * Put the credential huu ALREADY resolved into the env the jcode subprocess
 * inherits — the whole point of this module's existence.
 *
 * jcode is a subprocess, not an SDK: unlike the pi backend (which hands
 * `config.apiKey` straight to the session), the only channel to it is the
 * environment. Handing it a bare copy of `process.env` breaks in the case huu
 * ships by default — INSIDE the container the key arrives as a secret MOUNT and
 * the wrapper deliberately excludes the env var (`excludeFromEnv` in
 * `lib/docker-reexec.ts`), so `process.env.DEEPSEEK_API_KEY` does not exist and
 * jcode dies with "DEEPSEEK_API_KEY not found in environment". Same outcome on
 * the host whenever the user SAVED the key in huu's store instead of exporting
 * it. `config.apiKey` is the resolver's answer (mount → store → `_FILE` → env),
 * so it must win.
 *
 * WHICH VARIABLE — the part that leaked. The name is derived from `provider`
 * through `jcodeApiKeyEnvVar` → the provider table → `API_KEY_REGISTRY`, the
 * same chain that resolved `configApiKey` in the first place and the same one
 * `hermetic.ts` writes as `api_key_env`. A constant here (it used to be
 * `DEEPSEEK_API_KEY`) puts whatever key huu resolved into DeepSeek's variable,
 * and the constant `--provider-profile` then pointed it at api.deepseek.com:
 * an OpenRouter user's secret, sent to another vendor as a Bearer token. The
 * key is NEVER written into a variable belonging to a provider other than the
 * one it was resolved for — and the other providers' variables are stripped
 * from the child env entirely ({@link stripForeignProviderKeys}).
 *
 * Precedence, and the one rule that is easy to get wrong:
 *  1. `configApiKey` when non-empty — what huu resolved for this run.
 *  2. otherwise the provider's own inherited variable, left EXACTLY as it is.
 *  3. otherwise nothing — the caller fails with an actionable message.
 *
 * Step 2 is why this never assigns an empty string: writing `<VAR>: ''` would
 * SHADOW a perfectly good value the parent process exported, turning "huu has
 * no key of its own" into "jcode has no key at all". Pure and env-injected, so
 * the precedence is unit-testable without a spawn.
 */
export function withJcodeApiKey(
  env: NodeJS.ProcessEnv,
  configApiKey: string | undefined,
  provider?: LlmProvider,
): JcodeApiKeyInjection {
  const active = resolveRunProvider('jcode', provider) ?? DEFAULT_PROVIDER;
  const envVar = jcodeApiKeyEnvVar(active);
  const next = stripForeignProviderKeys({ ...env }, active);
  const resolved = (configApiKey ?? '').trim();
  if (resolved) {
    return { env: { ...next, [envVar]: resolved }, source: 'config', provider: active, envVar };
  }
  const inherited = (next[envVar] ?? '').trim();
  return { env: next, source: inherited ? 'env' : 'none', provider: active, envVar };
}

/** One `jcode run` invocation — the unit `prompt()` awaits. */
interface JcodeTurn {
  /** Settles when THIS subprocess exits; rejects on spawn error / non-zero exit. */
  done: Promise<void>;
  /** Index in `transcriptLines` of the first line this turn produced. */
  firstLine: number;
}

export const jcodeAgentFactory: AgentFactory = async (
  task,
  config,
  _systemPromptHint,
  cwd,
  onEvent,
  runtimeContext,
) => {
  const modelId = config.modelId.trim();
  if (!modelId) throw new Error('Model ID missing.');

  // THE provider decision, made ONCE and reused for the profile, the model
  // namespace and the credential variable. `resolveRunProvider` also discards a
  // provider jcode does not serve, so a mismatched pair can never send one
  // provider's key to another's host.
  const provider = resolveRunProvider('jcode', config.provider) ?? DEFAULT_PROVIDER;

  // Hermetic composition: huu-owned agent dir, no embeddings, no telemetry.
  const jcodeEnv = buildJcodeSessionEnvironment();
  if (jcodeEnv.hermetic) {
    onEvent({
      type: 'log',
      message: `jcode hermetic: agent dir=${jcodeEnv.agentDir}, memory=off, telemetry=off`,
    });
  }

  // The credential. The subprocess reads it from the environment and nowhere
  // else, so this is the ONLY place the key huu resolved can reach jcode — and
  // it lands in the variable THIS provider's profile reads, never another's.
  const key = withJcodeApiKey(jcodeEnv.env, config.apiKey, provider);
  if (key.source === 'none') {
    // Fail HERE rather than let jcode spawn and die on its own message: this
    // one names the variable and every way to set it (mirrors the pi backend,
    // which also refuses before creating a session).
    const message = jcodeMissingApiKeyMessage(provider);
    onEvent({ type: 'error', message });
    throw new Error(message);
  }
  onEvent({
    type: 'log',
    message:
      key.source === 'config'
        ? `jcode auth: ${key.envVar} set from the key huu resolved for this ${provider} run`
        : `jcode auth: inheriting ${key.envVar} from the environment (${provider})`,
  });
  const spawnEnv = key.env;

  const lifecycle = createDisposableState([]);

  // Track the full transcript for getTranscript() — every stdout line.
  const transcriptLines: string[] = [];

  let child: ChildProcess | null = null;

  function spawnJcode(promptText: string): JcodeTurn {
    const args = buildJcodeArgs(modelId, promptText, provider);

    // Log the OPTIONS, never the prompt: the positional is the agent's entire
    // briefing (2–13 KB for this repo's own pipelines) and would bury the log.
    // Its size is the part a reader actually needs, next to the flags that
    // reproduce the call.
    onEvent({
      type: 'log',
      message: `jcode spawn: jcode ${args.slice(0, -1).join(' ')} <prompt ${Buffer.byteLength(
        promptText,
        'utf8',
      )}B>`,
    });

    // Completion is PER TURN, not per agent. `prompt()` is called more than
    // once on the same agent — the review loop drives a fix round per blocking
    // finding (`review-loop.ts`) — and a single agent-scoped promise settles on
    // the FIRST exit, so every later turn would return instantly while its
    // subprocess was still running (and then be SIGKILLed by dispose).
    const firstLine = transcriptLines.length;
    let settle: () => void = () => {};
    let fail: (err: Error) => void = () => {};
    const done = new Promise<void>((resolve, reject) => {
      // `close` can arrive after `error`; whichever lands first owns the turn.
      let settled = false;
      settle = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      fail = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
    });

    let proc: ChildProcess;
    try {
      proc = spawn('jcode', args, {
        cwd,
        env: spawnEnv,
        // stdin is /dev/null on purpose: jcode reads nothing from it (measured
        // — the `-` sentinel was treated as the literal message), so an open
        // pipe would only be a channel that never carries anything and a way
        // for the child to block on a read that never ends.
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      // spawn() THROWS synchronously for every errno outside libuv's
      // EAGAIN/EACCES/EMFILE/ENFILE/ENOENT allow-list, so this path never
      // reaches the proc.on('error') handler below. Measured with E2BIG, which
      // arrived as a bare `Error: spawn E2BIG` — no jcode, no agent log, no
      // clue. Mirror it so no spawn failure is ever invisible.
      const message = `jcode spawn failed: ${err instanceof Error ? err.message : String(err)}`;
      onEvent({ type: 'error', message });
      throw err;
    }

    child = proc;

    // ---- stdout: translate each line through the event mapper ----
    const stdout = createInterface({ input: proc.stdout! });
    stdout.on('line', (line: string) => {
      transcriptLines.push(line);
      try {
        translateJcodeOutput(line, onEvent);
      } catch (err) {
        onEvent({
          type: 'log',
          level: 'warn',
          message: `jcode event translate error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
    });

    // ---- stderr: surface as warn-level logs ----
    const stderr = createInterface({ input: proc.stderr! });
    stderr.on('line', (line: string) => {
      transcriptLines.push(`[stderr] ${line}`);
      onEvent({
        type: 'log',
        level: 'warn',
        message: `jcode stderr: ${line}`,
      });
    });

    // ---- lifecycle events ----
    proc.on('error', (err) => {
      // ENOENT means the `jcode` binary is simply not in this environment.
      // Raw, that reads as `spawn jcode ENOENT` — true and useless. huu runs
      // every pipeline inside its container, and the image does NOT ship
      // jcode; the host wrapper lends its own install via a read-only mount at
      // /opt/jcode when it finds one. So the ONLY fixes are host-side, and the
      // message says which. Any other spawn error keeps the raw text.
      const isMissing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      const message = isMissing
        ? jcodeMissingExecutableMessage()
        : `jcode spawn error: ${err.message}`;
      onEvent({ type: 'error', message });
      fail(isMissing ? new Error(message) : err);
    });

    proc.on('close', (code, signal) => {
      if (signal) {
        onEvent({
          type: 'log',
          message: `jcode process killed by signal ${signal}`,
        });
      }
      if (code !== 0 && code !== null && !signal) {
        const msg = `jcode exited with code ${code}`;
        onEvent({ type: 'error', message: msg });
        fail(new Error(msg));
        return;
      }
      settle();
    });

    // No stdin write: the prompt already left with argv, as the <MESSAGE>
    // positional buildJcodeArgs put last.
    return { done, firstLine };
  }

  const spawned: SpawnedAgent = {
    agentId: task.agentId,
    task,

    async abort(): Promise<void> {
      // SIGTERM tells jcode to stop the current model call gracefully. The
      // subprocess will emit any remaining output and exit. If it doesn't exit
      // within a reasonable time, the orchestrator's dispose() will handle it.
      if (lifecycle.isDisposed()) return;
      if (child && !child.killed) {
        child.kill('SIGTERM');
      }
    },

    async checkpoint(): Promise<string | null> {
      // jcode runs as a subprocess with no persistent session file — there is
      // no checkpoint to capture. The orchestrator falls back to kill+requeue
      // (today's behavior), which is correct: jcode is stateless with
      // JCODE_MEMORY_ENABLED=false, so the re-ran agent just re-reads the
      // worktree files and continues idempotently.
      return null;
    },

    async steer(_message: string): Promise<void> {
      // `jcode run` is one-shot: it receives its entire instruction as the
      // <MESSAGE> positional at exec time and exits when that turn ends, so
      // there is no channel into a call already in flight. (Not "stdin was
      // closed after the prompt" — the prompt never went through stdin, and
      // stdin here is /dev/null because jcode reads nothing from it.) The
      // orchestrator simply logs the steer message as an event.
      onEvent({
        type: 'log',
        level: 'warn',
        message: 'jcode backend does not support steer(); message dropped',
      });
    },

    /**
     * Run ONE `jcode run` to completion — what this method actually does:
     *
     *  1. wraps `message` in the role/scope/rules header every backend sends;
     *  2. refuses up front if the result cannot fit in a single argv string
     *     (see {@link jcodeOversizedPromptMessage} — `spawn` would otherwise
     *     throw a contextless E2BIG straight past the error handler);
     *  3. spawns `jcode run … -- <message>`, streaming stdout through the event
     *     mapper, and awaits THAT subprocess's exit;
     *  4. rejects on a non-zero exit, on a spawn error, or on a jcode `[error]`
     *     line emitted by this turn — otherwise emits `done`.
     *
     * Callable more than once: each call is a fresh subprocess with its own
     * completion promise and its own slice of the transcript, which is what the
     * review loop's fix rounds need.
     */
    async prompt(message: string): Promise<void> {
      lifecycle.assertLive();

      const fullMessage = buildAgentMessageHeader(
        task,
        message,
        cwd,
        runtimeContext?.ports,
        runtimeContext?.shimAvailable ?? false,
      );

      // Before spawn(), not after: an oversized argv makes spawn() throw
      // synchronously, bypassing proc.on('error') and every event this backend
      // emits. Failing here keeps the refusal on the agent log, like the
      // missing-binary and missing-key paths.
      const oversized = jcodeOversizedPromptMessage(fullMessage);
      if (oversized) {
        onEvent({ type: 'error', message: oversized });
        throw new Error(oversized);
      }

      // The prompt rides in argv as the <MESSAGE> positional; nothing is
      // written to the child's stdin.
      const turn = spawnJcode(fullMessage);

      // Rejects on spawn error / non-zero exit; the message is already on the
      // agent log by then, and re-throwing lets the orchestrator record the
      // failure on the task.
      await turn.done;

      // The subprocess exited 0 but jcode itself may have reported a logical
      // error. Scan only THIS turn's lines — an earlier turn's `[error]` is
      // already resolved history and would fail every later round.
      const lastError = findLastError(transcriptLines, turn.firstLine);
      if (lastError) {
        onEvent({ type: 'error', message: lastError });
        throw new Error(lastError);
      }

      onEvent({ type: 'done' });
    },

    async getTranscript(): Promise<string> {
      // The raw stdout transcript, one line per entry. Callers (e.g. the
      // CheckStep judge) use this as a SECOND verdict source when events may
      // have been dropped or truncated. Never throws.
      try {
        return transcriptLines.join('\n');
      } catch {
        return '';
      }
    },

    dispose: async () => {
      if (lifecycle.isDisposed()) return;
      // Kill the child if still running. SIGKILL is the dispose guarantee:
      // we've already attempted a graceful abort (SIGTERM) before dispose,
      // so at this point the agent MUST stop.
      if (child && !child.killed) {
        child.kill('SIGKILL');
        child = null;
      }
      await lifecycle.dispose();
    },
  };

  return spawned;
};

/**
 * Scan the transcript for a jcode `[error]` line and return the message.
 * Used after the subprocess exits successfully (code 0) but jcode itself
 * reported a logical error.
 *
 * `from` bounds the scan to the CURRENT turn. The transcript accumulates across
 * every `prompt()` call on the agent, so an unbounded scan would keep finding
 * the first turn's error and fail every fix round after it.
 */
function findLastError(lines: string[], from = 0): string | null {
  for (let i = lines.length - 1; i >= from; i--) {
    const m = lines[i]!.match(/^\[error\]\s?(.+)$/i);
    if (m) return m[1]!;
  }
  return null;
}

/**
 * Decide which front-end huu presents, and on what address the web server
 * binds. Pure functions so the CLI gate AND the test-suite can drive every
 * branch without spinning a server.
 *
 * huu's default front-end is the BROWSER UI (this directory). The Ink TUI
 * still ships and is one flag away (`--cli`). This is orthogonal to the
 * Docker re-exec decision in `lib/docker-reexec.ts`: web vs CLI is "which
 * face does the user see", Docker vs native is "where does it run". Every
 * combination is valid — e.g. `huu --yolo` is the web UI running natively,
 * `huu --cli` is the TUI inside Docker.
 */

export type InterfaceMode = 'web' | 'cli';

/** Default port for the web UI. Mnemonic: h-u-u on a phone keypad (4-8-8). */
export const DEFAULT_WEB_PORT = 4888;

/** Bind address used inside the Docker container (published port needs it). */
export const CONTAINER_BIND_HOST = '0.0.0.0';

/** Default native bind address — every interface, so the LAN can reach it. */
export const DEFAULT_WEB_HOST = '0.0.0.0';

/**
 * The CLI flags that select / configure the front-end. Filtered out before
 * subcommand dispatch and pipeline import so they never reach those parsers.
 * `--port=N` is matched by prefix separately.
 */
export const INTERFACE_FLAGS = ['--cli', '--tui', '--web'] as const;

/**
 * Web is the default. `--cli`/`--tui` force the Ink TUI; `--web` is the
 * explicit opt-in (useful to override `HUU_CLI=1`). The `HUU_CLI` env var
 * lets a shell default to the TUI without typing the flag every time.
 *
 * ## PRECEDENCE — flag > env > saved config > default
 *
 * ```
 *   --web                     FLAG: this invocation is the browser UI
 *   --cli / --tui             FLAG: this invocation is the Ink TUI
 *   HUU_CLI=1                 ENV: this shell defaults to the TUI
 *   setup.interface           CONFIG: the standing choice from `huu setup`
 *   (default)                 web
 * ```
 *
 * The saved choice sits BELOW the flag and the env var, and that is the rule
 * the product owner asked for in as many words: someone who types `--web`
 * wants web THIS time, even with `cli` saved. Flags and env vars are
 * statements about one invocation; the config is a standing preference, and a
 * standing preference never overrules something the user just typed.
 *
 * Mirrors `decideReexec`'s ordering in `lib/docker-reexec.ts` — the two axes
 * (which face, which runtime) are independent, but they must not disagree
 * about what "explicit" means.
 *
 * `setup` is optional: every existing two-argument call keeps its behaviour,
 * which is what makes this a widening rather than a change.
 */
export function decideInterfaceMode(
  args: string[],
  env: NodeJS.ProcessEnv,
  setup?: { interface: InterfaceMode },
): InterfaceMode {
  if (args.includes('--web')) return 'web';
  if (args.includes('--cli') || args.includes('--tui')) return 'cli';
  if (env.HUU_CLI === '1' || env.HUU_CLI === 'true') return 'cli';
  if (setup?.interface === 'cli') return 'cli';
  return 'web';
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return undefined;
  return n;
}

/**
 * Resolve the web port. Precedence: `--port=N` flag → `HUU_WEB_PORT` env →
 * {@link DEFAULT_WEB_PORT}. Invalid values are ignored (fall through), never
 * fatal — a typo shouldn't stop the UI from coming up on the default.
 */
export function resolveWebPort(args: string[], env: NodeJS.ProcessEnv): number {
  const fromFlag = args
    .filter((a) => a.startsWith('--port='))
    .map((a) => parsePort(a.slice('--port='.length)))
    .filter((n): n is number => n !== undefined)
    .pop();
  if (fromFlag !== undefined) return fromFlag;

  const fromEnv = parsePort(env.HUU_WEB_PORT);
  if (fromEnv !== undefined) return fromEnv;

  return DEFAULT_WEB_PORT;
}

/**
 * Resolve the bind host. Inside the container we MUST bind 0.0.0.0 so the
 * published port maps through, regardless of any host override. Natively,
 * `HUU_WEB_HOST` can pin it to `127.0.0.1` for a localhost-only surface.
 */
export function resolveWebHost(env: NodeJS.ProcessEnv): string {
  if (env.HUU_IN_CONTAINER === '1') return CONTAINER_BIND_HOST;
  const explicit = env.HUU_WEB_HOST?.trim();
  return explicit || DEFAULT_WEB_HOST;
}

/** True when the given args/env select the web front-end. Convenience wrapper. */
export function isWebMode(
  args: string[],
  env: NodeJS.ProcessEnv,
  setup?: { interface: InterfaceMode },
): boolean {
  return decideInterfaceMode(args, env, setup) === 'web';
}

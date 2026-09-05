import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { API_KEY_REGISTRY, resolveApiKeyWithSource } from './api-key.js';
import { osReserveBytes } from './budget.js';
import { detectHostJcodeBundle } from './jcode-bundle.js';

/**
 * Transparent re-exec from the host into the official Docker image.
 *
 * Why this exists: typing `huu` in any folder should run huu against
 * that folder, isolated. Without re-exec, the user has to either
 * remember a long `docker run -v ... -w ... huu:latest run x.json`
 * incantation or `npm install` the heavy LLM SDK deps locally and
 * accept that the agent has access to ~/.ssh, ~/.aws, etc. Neither
 * matches the design intent.
 *
 * What we DO NOT rely on: docker's own signal forwarding when a TTY
 * is attached. moby#28872 documents that `docker run -it` sometimes
 * drops SIGINT/SIGHUP. Instead we trap in the wrapper and issue an
 * explicit `docker kill <cid>` from our own handlers. The container
 * also has tini as PID 1 for in-container signal hygiene, but that's
 * unrelated to the wrapper-side problem.
 *
 * Edge cases handled:
 * - Stdin not a TTY (piped input, CI): omit `-t` so docker doesn't error.
 * - Wrapper SIGKILL (no trap fires): next invocation prunes any
 *   orphan containers whose parent PID is dead.
 * - Contributor opt-out: HUU_DEV_NATIVE=1 skips the re-exec entirely so
 *   `npm run dev` can iterate on huu itself without a docker daemon. NOT a
 *   product feature — see `isDevNativeMode` below for the full rationale.
 * - User-facing native bypass: `--yolo` / `--no-docker` / `HUU_NO_DOCKER=1`
 *   also skip the re-exec and run the whole CLI on the host. Deliberate and
 *   loud: no container isolation, no kernel memory ceiling — cli.tsx prints
 *   the trade-off on every such start. Use case: targets that run their own
 *   Docker (e.g. automation targets), where nesting containers is the problem.
 * - Inside the container: HUU_IN_CONTAINER=1 (set by the Dockerfile)
 *   short-circuits to native execution. Prevents recursion.
 * - Subcommands that operate on the host filesystem (status, init-docker)
 *   or just print (help): run native, no docker pull required.
 */

const DEFAULT_IMAGE = 'ghcr.io/frederico-kluser/huu:latest';
export const CIDFILE_DIR = join(tmpdir(), 'huu-cids');
export const ORPHAN_LABEL = 'org.opencontainers.image.source=huu-wrapper';

/**
 * Standard docker bridge MTU. If the host's default-route MTU is
 * smaller (typical of VPN tunnels: WireGuard ~1420, OpenVPN ~1500-overhead,
 * Tailscale ~1280), the bridge silently drops TLS ClientHello packets
 * larger than the tunnel and every HTTPS handshake hangs. We
 * auto-create a per-MTU docker network when this is the case.
 */
const DOCKER_BRIDGE_DEFAULT_MTU = 1500;
/** Floor — below this we don't bother creating a network and just refuse politely. */
const MIN_USABLE_MTU = 576;

/**
 * Detect the MTU of the host interface carrying the default IPv4 route.
 * Linux-only (parses `ip route get` + `/sys/class/net/<iface>/mtu`).
 * Returns null on any platform where we can't determine it cheaply —
 * caller falls back to the docker default bridge in that case.
 */
export function detectDefaultRouteMtu(): number | null {
  // `ip` only ships on Linux distros by default; macOS/Windows Docker
  // Desktop runs on top of a VM that hides the host's networking, so
  // probing host MTU there is meaningless anyway.
  if (process.platform !== 'linux') return null;
  const r = spawnSync('ip', ['route', 'get', '1.1.1.1'], { encoding: 'utf8', timeout: 2000 });
  if (r.status !== 0 || !r.stdout) return null;
  // Sample output: "1.1.1.1 dev surfshark_wg table 300000 src 10.14.0.2 uid 1000"
  // or:           "1.1.1.1 via 192.168.1.1 dev wlp0s20f3 src 192.168.1.42 uid 1000"
  const m = /\bdev\s+(\S+)/.exec(r.stdout);
  if (!m) return null;
  const iface = m[1]!;
  try {
    const mtu = Number(readFileSync(`/sys/class/net/${iface}/mtu`, 'utf8').trim());
    return Number.isFinite(mtu) && mtu >= MIN_USABLE_MTU ? mtu : null;
  } catch {
    return null;
  }
}

/**
 * Ensure a docker bridge network exists with the requested MTU and
 * return its name. Idempotent — networks are named by MTU so multiple
 * concurrent VPN configurations don't collide and old networks linger
 * harmlessly. Returns null if the docker command fails (no daemon
 * permission, etc.) — caller falls back to the default bridge.
 */
export function ensureHuuDockerNetwork(mtu: number): string | null {
  const name = `huu-net-mtu${mtu}`;
  // Cheap fast-path: if it already exists, reuse.
  const inspect = spawnSync('docker', ['network', 'inspect', name], { stdio: 'ignore' });
  if (inspect.status === 0) return name;
  const create = spawnSync('docker', [
    'network', 'create',
    '--driver', 'bridge',
    '--opt', `com.docker.network.driver.mtu=${mtu}`,
    '--label', ORPHAN_LABEL,
    name,
  ], { stdio: 'ignore' });
  return create.status === 0 ? name : null;
}

/**
 * Decide the value for `docker run --network=…`. Resolution order:
 *   1. `HUU_DOCKER_NETWORK` env (explicit override, any value passed verbatim).
 *   2. Linux + default-route MTU < 1500 → auto-create / reuse `huu-net-mtu<N>`.
 *   3. Otherwise undefined → docker default bridge.
 *
 * Step 2 is what makes huu "just work" on VPN without the user opting in.
 * Exposed for testing.
 */
export function pickDockerNetwork(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const explicit = env.HUU_DOCKER_NETWORK?.trim();
  if (explicit) return explicit;
  const mtu = detectDefaultRouteMtu();
  if (mtu === null || mtu >= DOCKER_BRIDGE_DEFAULT_MTU) return undefined;
  const name = ensureHuuDockerNetwork(mtu);
  return name ?? undefined;
}

/**
 * The `--memory` ceiling the wrapper would give the container: the
 * `HUU_DOCKER_MEMORY_MB` override, else `hostTotal − the adaptive OS reserve`
 * (floored at 512 MiB). null when memory limiting is disabled via
 * `HUU_NO_MEM_LIMIT`. Pure over env + injectable total — shared with the
 * ram-doctor's container preview so `huu status` shows the same figure the
 * wrapper will enforce.
 */
export function dockerMemoryLimitBytes(
  env: NodeJS.ProcessEnv = process.env,
  totalBytes: number = totalmem(),
): number | null {
  if (env.HUU_NO_MEM_LIMIT === '1' || env.HUU_NO_MEM_LIMIT === 'true') return null;
  const mib = 1024 * 1024;
  const overrideMb = Number(env.HUU_DOCKER_MEMORY_MB?.trim() || NaN);
  return Number.isFinite(overrideMb) && overrideMb > 0
    ? Math.floor(overrideMb) * mib
    : Math.max(512 * mib, Math.floor(totalBytes - osReserveBytes(totalBytes, env)));
}

/**
 * `docker run` memory-limit flags derived from the host (the wrapper runs
 * host-side). `--memory` → cgroup memory.max; `--memory-swap` = memory + a
 * bounded swap allowance (HUU_SWAP_MAX_MB, default 4096 — 0 pins swap off for
 * the container). Pure over env + injectable total so tests drive it directly.
 */
export function buildMemoryLimitArgs(
  env: NodeJS.ProcessEnv = process.env,
  totalBytes: number = totalmem(),
): string[] {
  const memoryBytes = dockerMemoryLimitBytes(env, totalBytes);
  if (memoryBytes === null) return [];
  const mib = 1024 * 1024;
  const rawSwap = Number(env.HUU_SWAP_MAX_MB?.trim() || NaN);
  const swapAllowanceBytes =
    (Number.isFinite(rawSwap) && rawSwap >= 0 ? Math.floor(rawSwap) : 4096) * mib;
  return [
    '--memory',
    String(memoryBytes),
    '--memory-swap',
    String(memoryBytes + swapAllowanceBytes),
    '--pids-limit',
    '8192',
  ];
}

/**
 * Can this daemon/kernel enforce memory limits? Rootless Docker without
 * memory-controller delegation and old kernels reject `--memory` outright —
 * for those, run unlimited like before (degrade, never block). Best-effort:
 * an unreadable probe assumes support (the common case).
 */
export function probeDockerMemoryLimitSupport(): boolean {
  try {
    const r = spawnSync('docker', ['info', '--format', '{{.MemoryLimit}}'], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    if (r.status !== 0) return true;
    return r.stdout.trim() !== 'false';
  } catch {
    return true;
  }
}

/** True when `child` is `root` or nested under it (both absolute, normalized). */
export function isPathInside(child: string, root: string): boolean {
  const c = resolve(child);
  const r = resolve(root);
  return c === r || c.startsWith(r.endsWith('/') ? r : `${r}/`);
}

/**
 * The host directory the web folder-picker may browse (and that agents in
 * mounted runs can therefore reach). `HUU_WORKSPACE` when it names an existing
 * directory; otherwise `$HOME`. Degrade-never-block: a missing/invalid value
 * falls back to home rather than throwing.
 */
export function resolveWorkspaceRoot(
  hostHome: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = env.HUU_WORKSPACE?.trim();
  if (raw) {
    const abs = resolve(raw);
    try {
      if (existsSync(abs) && statSync(abs).isDirectory()) return abs;
    } catch {
      /* fall through to home */
    }
  }
  return hostHome;
}

/**
 * The HOST's huu config dir (`$XDG_CONFIG_HOME/huu`, default `~/.config/huu`)
 * — home of the saved-key store (`config.json`) and `web-settings.json`.
 * Bind-mounted RW into the container and exported as `HUU_CONFIG_DIR` so a
 * key/setting saved from INSIDE the container (web ⚙ Options, TUI "save
 * key") lands on the HOST and survives `docker run --rm`. Without this the
 * in-container store was the ephemeral `/tmp/.config` — "update the saved
 * key in Options" was literally impossible from a Docker run, which is how a
 * stale saved key became unfixable and 401'd every run.
 */
export function resolveHostConfigDir(
  hostHome: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return join(xdg || join(hostHome, '.config'), 'huu');
}

/** Subcommands that run native — no docker pull, no bind mount needed. */
const NATIVE_ONLY_SUBCOMMANDS = new Set(['init-docker', 'status', 'prune', 'lab']);

/**
 * CONTRIBUTOR escape hatch: run the whole CLI on the host, no docker daemon.
 *
 * The user-facing bypasses (`--yolo` / `--no-docker` / `HUU_NO_DOCKER=1`) are
 * honored again (see decideReexec) — they run huu natively with a loud
 * no-isolation warning. This is a DIFFERENT door, for working ON huu: editing
 * `src/` and re-running it every few seconds, where each iteration would
 * otherwise cost a `docker build` + a `docker run` even when the daemon is
 * off. `npm run dev` sets this var so the edit→run loop is instant;
 * `npm run dev:docker` is the faithful rehearsal of what a user actually
 * gets.
 *
 * Deliberately env-only (no CLI flag): `HUU_DEV_NATIVE` is a contributor
 * loop, not a user-facing spelling. A native run has NO container isolation
 * and NO `--memory` ceiling — on Linux the systemd self-wrap
 * (cgroup-self-wrap.ts) becomes reachable again and supplies the kernel
 * ceiling; everywhere else the software guard is all that's left. cli.tsx
 * says so, loudly, on every start.
 */
export function isDevNativeMode(env: NodeJS.ProcessEnv): boolean {
  return env.HUU_DEV_NATIVE === '1' || env.HUU_DEV_NATIVE === 'true';
}

export interface ReexecDecision {
  shouldReexec: boolean;
  reason: string;
}

/**
 * Decide whether the current invocation should re-exec into docker.
 * Pure function so tests can drive every branch directly.
 */
export function decideReexec(args: string[], env: NodeJS.ProcessEnv): ReexecDecision {
  if (env.HUU_IN_CONTAINER === '1') {
    return { shouldReexec: false, reason: 'already inside the huu container' };
  }
  // Contributor loop (`npm run dev`): run on the host so editing src/ and
  // re-running doesn't cost a docker build + docker run every iteration. Env
  // only, never a flag — see isDevNativeMode.
  if (isDevNativeMode(env)) {
    return { shouldReexec: false, reason: 'HUU_DEV_NATIVE=1 — contributor native run (no Docker)' };
  }
  // USER-FACING native bypass: `--yolo` / `--no-docker` / `HUU_NO_DOCKER=1`
  // run the WHOLE CLI on the host, no container. Docker remains the default —
  // the container carries the kernel memory ceiling (`--memory`) and
  // credential isolation, and both machine freezes happened on native runs —
  // so this door is deliberate and LOUD: cli.tsx prints the no-isolation
  // trade-off on every such start. Use case: targets that run their own
  // Docker (automation targets), where nesting containers is the problem.
  if (
    args.includes('--yolo') ||
    args.includes('--no-docker') ||
    env.HUU_NO_DOCKER === '1' ||
    env.HUU_NO_DOCKER === 'true'
  ) {
    return { shouldReexec: false, reason: '--yolo/--no-docker: native run (no container)' };
  }
  // What still runs on the host WITHOUT a bypass is NOT pipeline execution:
  // `--help` (pure print) and the host utilities below (they operate on the
  // host fs / docker daemon).
  if (args.includes('--help') || args.includes('-h')) {
    return { shouldReexec: false, reason: 'help flag — runs native' };
  }
  const firstNonFlag = args.find((a) => !a.startsWith('-'));
  if (firstNonFlag && NATIVE_ONLY_SUBCOMMANDS.has(firstNonFlag)) {
    return { shouldReexec: false, reason: `${firstNonFlag} runs native (operates on host fs)` };
  }
  return { shouldReexec: true, reason: 'docker-only — every run executes inside the container' };
}

/**
 * Flags that were once stripped-and-warned as "removed". Empty now: the
 * bypasses are honored again (see decideReexec), so there is nothing left to
 * strip — `stripRemovedNativeFlags` is a no-op kept for the wrapper path.
 */
export const REMOVED_NATIVE_FLAGS = [] as const;

/** True when the invocation carries a native-mode bypass (--yolo / --no-docker / HUU_NO_DOCKER). */
export function hasNativeBypass(args: string[], env: NodeJS.ProcessEnv): boolean {
  return (
    args.includes('--yolo') ||
    args.includes('--no-docker') ||
    env.HUU_NO_DOCKER === '1' ||
    env.HUU_NO_DOCKER === 'true'
  );
}

/**
 * Historically stripped the removed native-mode flags before re-exec so the
 * in-container CLI never saw them. The bypasses are honored again and never
 * reach the container (decideReexec short-circuits before any re-exec), so
 * this is an identity no-op — kept so the wrapper path stays explicit.
 */
export function stripRemovedNativeFlags(args: string[]): string[] {
  return [...args];
}

/** A host path exposed inside the container as a read-only bind mount. */
export interface ReadonlyMount {
  /** Absolute path on the host. */
  hostPath: string;
  /** Path to expose inside the container. */
  containerPath: string;
}

/**
 * A {@link ReadonlyMount} whose content is a secret VALUE the wrapper writes
 * before `docker run` and unlinks after it exits.
 */
export type SecretMount = ReadonlyMount;

export interface DockerCommandOptions {
  cwd: string;
  image: string;
  cidfile: string;
  args: string[];
  hasTTY: boolean;
  uid: number;
  gid: number;
  /**
   * Files to bind-mount read-only into the container. Used for
   * OPENROUTER_API_KEY so the value is reachable inside the container
   * (via the existing /run/secrets/openrouter_api_key resolver in
   * lib/api-key.ts) WITHOUT being exposed in `docker inspect` (which
   * is what `-e KEY=value` would do).
   */
  secretMounts?: SecretMount[];
  /**
   * Env var names that must be excluded from the regular `-e` passthrough
   * — typically because they're being delivered via secretMounts instead.
   */
  excludeFromEnv?: Set<string>;
  /**
   * Additional host paths to bind-mount read-write, same path host and
   * container. Computed by `preflightGitOnHost` to expose the parent
   * repo's `.git` (worktree case) or a parent toplevel (subdir case).
   * git needs to write into `.git/worktrees/<name>/HEAD` etc., so the
   * mount is rw, not ro.
   */
  extraMounts?: string[];
  /**
   * Host paths bind-mounted READ-ONLY at a DIFFERENT path inside the container
   * (unlike `extraMounts`, which are rw and same-path). Today's only user is
   * the host jcode bundle → `/opt/jcode`: the image cannot ship jcode (no
   * public distribution URL exists), so the wrapper lends the host's copy.
   * Read-only because the container has no business writing into a host
   * toolchain.
   */
  readonlyMounts?: ReadonlyMount[];
  /**
   * `docker run --network=<value>`. Opt-in via `HUU_DOCKER_NETWORK`.
   * Use case: VPN users (WireGuard/OpenVPN) whose tunnel MTU is below
   * 1500 — the default `docker0` bridge silently drops large TLS
   * ClientHello packets, manifesting as "Request timed out" on every
   * agent. Setting `host` makes the container share the host netns and
   * inherit MSS-clamping. Omitted → docker default (bridge).
   */
  network?: string;
  /**
   * TCP ports to publish host→container (`docker run -p <p>:<p>`). Used by
   * web-UI mode so the browser on the host reaches the server that runs
   * INSIDE the container. Same number both sides — the container binds the
   * port it's told via HUU_WEB_PORT (forwarded through the passthrough env
   * set). Empty/omitted for the TUI (CLI) path.
   */
  publishPorts?: number[];
  /**
   * Whether the daemon/kernel can enforce memory limits (probed via
   * `docker info {{.MemoryLimit}}`). false → the --memory flags are omitted so
   * `docker run` doesn't REJECT the container outright (rootless without
   * memory delegation, kernels without memcg limits) — degrade to the old
   * unlimited behavior, never block. Default true.
   */
  memoryLimitSupported?: boolean;
}

/**
 * Build the argv we pass to spawn(). Returns array form (no shell).
 * Exposed so tests can assert on the command shape without invoking
 * docker.
 */
export function buildDockerArgv(opts: DockerCommandOptions): string[] {
  const argv: string[] = ['run', '--rm', '-i'];
  // -t requires a real terminal; passing it without one makes docker
  // error out with "the input device is not a TTY".
  if (opts.hasTTY) argv.push('-t');
  if (opts.network) argv.push('--network', opts.network);
  // Kernel memory ceiling for the container (cgroup memory.max via --memory):
  // an unlimited container can consume 100% of host RAM and freeze the box —
  // the 33-run incident class. Sized like the native systemd scope: host total
  // minus the adaptive OS reserve, plus a bounded swap allowance. Worst case
  // becomes "the container dies with 137" instead of "the host dies".
  // HUU_DOCKER_MEMORY_MB overrides; HUU_NO_MEM_LIMIT=1 restores the old
  // unlimited behavior; a daemon without memory-limit support (probed by the
  // caller) skips the flags entirely — degrade, never block.
  // --pids-limit is the runaway-fork backstop.
  if (opts.memoryLimitSupported !== false) {
    for (const flag of buildMemoryLimitArgs(process.env)) argv.push(flag);
  }
  // Publish the web-UI port(s) so the host browser can reach the in-container
  // server. Bound to the same number inside (HUU_WEB_PORT) and out.
  for (const port of opts.publishPorts ?? []) {
    argv.push('-p', `${port}:${port}`);
  }
  argv.push(
    '--cidfile', opts.cidfile,
    '--user', `${opts.uid}:${opts.gid}`,
    '--label', ORPHAN_LABEL,
    '--label', `huu.parent-pid=${process.pid}`,
    '-v', `${opts.cwd}:${opts.cwd}`,
    '-w', opts.cwd,
  );

  // Extra mounts discovered by the host-side git preflight: parent repo
  // .git for the worktree case, parent toplevel for the subdirectory
  // case. Same path host and container so absolute paths the .git file
  // points at resolve identically inside.
  for (const path of opts.extraMounts ?? []) {
    argv.push('-v', `${path}:${path}`);
  }

  // Read-only tool mounts (today: the host jcode bundle → /opt/jcode). Same
  // `--mount ...,readonly` form as the secrets below — the container gets the
  // directory, never write access to it.
  for (const m of opts.readonlyMounts ?? []) {
    argv.push(
      '--mount',
      `type=bind,src=${m.hostPath},dst=${m.containerPath},readonly`,
    );
  }

  // Secret-file mounts (e.g. OPENROUTER_API_KEY → /run/secrets/...).
  // Read-only bind so the container can't accidentally clobber the
  // host file even if it tried.
  for (const m of opts.secretMounts ?? []) {
    argv.push(
      '--mount',
      `type=bind,src=${m.hostPath},dst=${m.containerPath},readonly`,
    );
  }

  // Pass-through env. Always include keys the Pi SDK / git layer reads;
  // additional env keys can be added via HUU_DOCKER_PASS_ENV.
  //
  // We use the VALUELESS form (`-e KEY` instead of `-e KEY=value`) for
  // two reasons:
  //   1. argv (visible via /proc/<pid>/cmdline → `ps auxf`) only contains
  //      the variable name, never the value.
  //   2. The docker client reads its own env at run time and forwards
  //      to the daemon over the socket — same end behavior in the
  //      container, less leakage on the host.
  // Secrets that should ALSO be hidden from `docker inspect` go through
  // secretMounts above, not env at all.
  const passthrough = new Set<string>([
    'HUU_CHECK_PUSH', 'HUU_WORKTREE_BASE', 'TERM',
    // Web-UI knobs: the in-container server must bind the SAME port the
    // wrapper published, and honor the host's front-end + token choices.
    'HUU_WEB_PORT', 'HUU_WEB_HOST', 'HUU_WEB_TOKEN', 'HUU_CLI',
    // Tells the in-container code (via getHuuHome()) where the host's
    // home is, so writes to `~/.huu/` and `~/Downloads/` land on the
    // bind-mounted host filesystem instead of the container's ephemeral
    // $HOME. Paired with the host-home bind mounts added below.
    'HUU_HOST_HOME',
    // Host config dir (saved-key store + web-settings), bind-mounted RW by
    // the wrapper. configFilePath()/webSettingsPath() prefer it, so keys and
    // settings saved in-container persist on the host across containers.
    'HUU_CONFIG_DIR',
    // The folder-picker workspace root — the in-container web server reads it
    // to know where to open the picker.
    'HUU_WORKSPACE',
    // Host git identity — populated by resolveHostGitIdentity() so the
    // container inherits the same author/committer as the host user.
    'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL',
    'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
    // Hermetic-jcode escape hatch + RAM-tuning knobs must reach the
    // in-container orchestrator. The name matters: the ONLY variable anything
    // reads is `HUU_JCODE_HERMETIC` (backends/jcode/hermetic.ts →
    // resolveHermeticEnabled). This slot used to hold `HUU_PI_HERMETIC`, left
    // behind when the pi backend was deleted — a name nothing reads, so the
    // documented escape hatch never crossed into the container and, huu being
    // docker-only, never worked at all. Deliberately NOT forwarding
    // JCODE_HOME / JCODE_AGENT_DIR: the container has no host ~/.jcode to leak
    // from, and the hermetic composition sets its own huu-owned dirs.
    'HUU_JCODE_HERMETIC', 'HUU_AGENT_MEM_SEED_MB', 'HUU_AGENT_MEM_EMA_ALPHA',
    // RAM-safety knobs (dial, guard ladder, admission, OS reserve, pause) —
    // set on the host, they must govern the in-container scheduler too.
    // (Before this passthrough a host HUU_RAM_PERCENT was silently ignored
    // inside the container.)
    'HUU_RAM_PERCENT', 'HUU_OOM_SCORE_ADJ', 'HUU_NO_PAUSE', 'HUU_OS_RESERVE_MB',
    'HUU_MAX_LIVE_RUNS', 'HUU_MAX_QUEUED_RUNS', 'HUU_RUN_BASELINE_MB',
    'HUU_GUARD_AVAIL_PCT', 'HUU_GUARD_SWAP_FREE_PCT',
    'HUU_GUARD_AVAIL_PCT_EMERGENCY', 'HUU_GUARD_SWAP_FREE_PCT_EMERGENCY',
    'HUU_GUARD_PSI_FULL_HIGH', 'HUU_GUARD_PSI_FULL_EMERGENCY',
    'HUU_GUARD_SWAPIN_PAGES_SEC', 'HUU_GUARD_SWAPIN_SUSTAIN_MS',
    'HUU_GUARD_OVER_BUDGET_MS', 'HUU_GUARD_DESTROY_PCT', 'HUU_GUARD_L1_REPREEMPT_MS',
    'HUU_GUARD_CONTAINER_SWAP_PCT', 'HUU_NO_HOST_CLAMP', 'HUU_PAUSE_BACKOFF_MS',
    'HUU_GUARD_REOPEN_CALM_MS', 'HUU_MAX_EVENT_LISTENERS',
    // surf (web-research CLI) knobs. The CLI runs INSIDE the container, so a
    // budget/timeout/verbosity the user tuned on the host must reach it —
    // otherwise the image ENV defaults silently win. Keys are NOT here: the
    // surf CLI reads only ~/.config/surf/keys.json, which `ensureSurfKeys()`
    // materializes in-container from the registry (see surf-research.ts).
    'SURF_AGENT_BUDGET_MS', 'SURF_TIMEOUT_MS', 'SURF_NO_TIMEOUT', 'SURF_QUIET',
    'SURF_RATE_LIMIT_COOLDOWN_MS', 'SURF_MAX_CONTENT_CHARS',
    'SURF_ALLOW_EXPENSIVE', 'SURF_CACHE_TTL',
  ]);
  // Every API key spec contributes both `<NAME>` and `<NAME>_FILE` to the
  // passthrough — secret-mounting (when present) supersedes it via
  // excludeFromEnv, but we still want the `_FILE` path forwarded for the
  // dev-only path where the user mounts a file outside Docker.
  for (const spec of API_KEY_REGISTRY) {
    passthrough.add(spec.envVar);
    passthrough.add(spec.envFileVar);
  }
  const extra = (process.env.HUU_DOCKER_PASS_ENV ?? '').split(/\s+/).filter(Boolean);
  for (const k of extra) passthrough.add(k);
  const exclude = opts.excludeFromEnv ?? new Set<string>();

  for (const k of passthrough) {
    if (exclude.has(k)) continue;
    if (process.env[k] !== undefined) argv.push('-e', k);
  }

  argv.push(opts.image);
  if (opts.args.length > 0) {
    argv.push(...opts.args);
  } else {
    // No user args = bare `huu` invocation. Without this branch docker
    // would fall back to the image CMD (which is ["huu", "--help"]) and
    // the user would see the help text instead of the TUI welcome.
    // Passing an explicit `huu` makes the entrypoint exec it with no
    // args, which opens the TUI as expected.
    argv.push('huu');
  }
  return argv;
}

/**
 * Read the host git user.name / user.email (respecting local > global >
 * system chain) and populate GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL,
 * GIT_COMMITTER_NAME, GIT_COMMITTER_EMAIL so they flow into the
 * container via the passthrough set.
 *
 * Only sets a var when it is not already in the environment -- explicit env
 * from the caller always wins.
 */
export function resolveHostGitIdentity(): void {
  const pairs: [string, string, string][] = [
    ['user.name', 'GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME'],
    ['user.email', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL'],
  ];
  for (const [key, authorVar, committerVar] of pairs) {
    if (process.env[authorVar] && process.env[committerVar]) continue;
    const r = spawnSync('git', ['config', key], { encoding: 'utf8', timeout: 3000 });
    const val = r.stdout?.trim();
    if (!val) continue;
    if (!process.env[authorVar]) process.env[authorVar] = val;
    if (!process.env[committerVar]) process.env[committerVar] = val;
  }
}

function isDockerInstalled(): boolean {
  const r = spawnSync('docker', ['--version'], { stdio: 'ignore' });
  return r.status === 0;
}

/**
 * Check whether a docker image is already present locally. Used to
 * decide whether to surface a "pulling first time" message before the
 * `docker run` blocks for several minutes on a fresh machine.
 */
export function imageIsLocal(image: string): boolean {
  const r = spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' });
  return r.status === 0;
}

/**
 * Best-effort cleanup of orphan containers. Reads cidfiles whose parent
 * PID is no longer alive on the host and `docker kill`s the recorded
 * container. Safe to call on every invocation — doesn't kill the
 * current run because we use the live process.pid to avoid self-prune.
 */
function pruneOrphans(): void {
  try {
    if (existsSync(CIDFILE_DIR)) {
      for (const name of readdirSync(CIDFILE_DIR)) {
        const path = join(CIDFILE_DIR, name);
        // Parse pid from filename: cid-<pid>-<random>.id
        const m = /^cid-(\d+)-/.exec(name);
        if (!m) continue;
        const pid = Number(m[1]);
        if (pid === process.pid) continue;
        // process.kill(pid, 0) probes liveness without sending a signal.
        // Throws ESRCH when the process is gone, EPERM when it exists
        // but we can't signal it (still alive — leave the cidfile alone).
        try {
          process.kill(pid, 0);
          continue; // alive → don't prune
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'EPERM') continue; // alive
        }
        // Dead. Read cid and kill.
        let cid = '';
        try {
          cid = readFileSync(path, 'utf8').trim();
        } catch {
          /* ignore */
        }
        if (cid) {
          spawnSync('docker', ['kill', cid], { stdio: 'ignore' });
        }
        try {
          unlinkSync(path);
        } catch {
          /* ignore */
        }
      }
    }
    // Same prune pass for orphan secret files. SIGKILL of the wrapper
    // (no traps fire) leaves these in /dev/shm or os.tmpdir() with
    // mode 0600 — harmless to anyone but the original user, but worth
    // sweeping so /dev/shm doesn't accumulate forever. The registry
    // owns the list of scope prefixes — adding a new key here is
    // automatic.
    const scopePatterns = API_KEY_REGISTRY.map(
      (s) => new RegExp(`^${escapeRegex(s.hostSecretScope)}-(\\d+)-`),
    );
    for (const dir of ['/dev/shm', tmpdir()]) {
      try {
        if (!existsSync(dir)) continue;
        for (const name of readdirSync(dir)) {
          let pid: number | null = null;
          for (const re of scopePatterns) {
            const m = re.exec(name);
            if (m) {
              pid = Number(m[1]);
              break;
            }
          }
          if (pid === null) continue;
          if (pid === process.pid) continue;
          try {
            process.kill(pid, 0);
            continue; // alive
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'EPERM') continue;
          }
          try {
            unlinkSync(join(dir, name));
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* readdir on a strange fs — skip */
      }
    }
  } catch {
    /* never let pruning crash the wrapper */
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeCidfilePath(): string {
  if (!existsSync(CIDFILE_DIR)) {
    mkdirSync(CIDFILE_DIR, { recursive: true, mode: 0o700 });
  }
  const rand = Math.random().toString(36).slice(2, 10);
  return join(CIDFILE_DIR, `cid-${process.pid}-${rand}.id`);
}

/**
 * Write a secret value to a host file with restrictive permissions and
 * return the path. The wrapper bind-mounts this read-only into the
 * container at `/run/secrets/<name>` and unlinks it on exit.
 *
 * Storage location: `/dev/shm` on Linux (tmpfs — never hits the disk),
 * `os.tmpdir()` everywhere else (macOS APFS, Windows). On Linux this
 * means a wrapper crash before unlink leaves the secret in RAM only.
 */
export function makeSecretFile(value: string, scope: string = 'huu-secret'): string {
  const shm = '/dev/shm';
  const baseDir = existsSync(shm) ? shm : tmpdir();
  const rand = randomBytes(8).toString('hex');
  const path = join(baseDir, `${scope}-${process.pid}-${rand}`);
  writeFileSync(path, value, { mode: 0o600 });
  return path;
}

export interface ReexecOptions {
  /** Extra host paths to bind-mount (forwarded to buildDockerArgv). */
  extraMounts?: string[];
  /**
   * TCP ports to publish host→container. Web-UI mode passes the resolved
   * web port so the host browser reaches the in-container server.
   */
  publishPorts?: number[];
}

/**
 * Spawn docker run, install signal traps, propagate exit code.
 *
 * Returns a Promise that resolves with the exit code. Caller is expected
 * to call `process.exit(code)` after — we don't do it here so unit tests
 * can inspect the result.
 */
export async function reexecInDocker(
  rawArgs: string[],
  opts: ReexecOptions = {},
): Promise<number> {
  // Docker-only: the removed native-mode flags must never reach the
  // in-container CLI (it would treat them as unknown input).
  const args = stripRemovedNativeFlags(rawArgs);
  if (!isDockerInstalled()) {
    process.stderr.write(
      'huu: docker is not installed.\n\n' +
        'huu is DOCKER-ONLY: every run executes inside a container so the\n' +
        'LLM agents are isolated from your shell credentials (~/.ssh, ~/.aws,\n' +
        '~/.npmrc tokens, …) and the container carries a kernel memory\n' +
        'ceiling that keeps the machine from ever freezing. Install Docker:\n' +
        '  https://docs.docker.com/engine/install/\n',
    );
    return 127;
  }

  // Best-effort orphan sweep before starting a new run.
  pruneOrphans();

  // Friendly first-run UX: warn the user that the next ~30s is a pull,
  // not a hang. docker run pulls implicitly on demand and prints its
  // own progress, but without context the silence-then-progress-bar
  // sequence is confusing to a new user.
  const image = process.env.HUU_IMAGE ?? DEFAULT_IMAGE;
  if (!imageIsLocal(image)) {
    process.stderr.write(
      `huu: pulling ${image} (~600MB, first time only — subsequent runs are instant)\n`,
    );
  }

  // Capture the host git identity (user.name / user.email) as env vars
  // so the container's git commits are attributed to the same person.
  resolveHostGitIdentity();

  // Persist huu state on the host: bind-mount `~/.huu` (and `~/Downloads`
  // when it exists) into the container at the same absolute path. The
  // in-container code reads HUU_HOST_HOME via getHuuHome() to resolve
  // saves to these host-side paths. Without this, "save pipeline" lands
  // in the container's ephemeral $HOME and is wiped by `docker run --rm`.
  const hostHome = homedir();
  const hostHuuDir = join(hostHome, '.huu');
  if (!existsSync(hostHuuDir)) {
    mkdirSync(hostHuuDir, { recursive: true, mode: 0o700 });
  }
  const hostHomeMounts: string[] = [hostHuuDir];
  const hostDownloadsDir = join(hostHome, 'Downloads');
  if (existsSync(hostDownloadsDir)) {
    hostHomeMounts.push(hostDownloadsDir);
  }
  process.env.HUU_HOST_HOME = hostHome;

  // The saved-key store + web settings live in the host config dir. Mount it
  // RW and tell the in-container resolvers where it is (HUU_CONFIG_DIR), so
  // "Validate & save" in the web ⚙ Options — running INSIDE the container —
  // updates the HOST store the next `huu` start resolves from. mkdir first:
  // docker would otherwise create a root-owned dir at the mount point.
  const hostConfigDir = resolveHostConfigDir(hostHome);
  if (!existsSync(hostConfigDir)) {
    mkdirSync(hostConfigDir, { recursive: true, mode: 0o700 });
  }
  hostHomeMounts.push(hostConfigDir);
  process.env.HUU_CONFIG_DIR = hostConfigDir;

  // WORKSPACE ROOT: the host directory the web folder-picker can browse (and
  // therefore the tree agents in mounted runs can reach). Default $HOME so the
  // picker sees every project under home; `HUU_WORKSPACE` tightens it (e.g.
  // ~/Projects) or widens it (`/`). This is a DELIBERATE, user-chosen
  // relaxation of the Docker isolation: mounting it RW means an agent's shell
  // can read/write anything under it — including ~/.ssh etc. when it's $HOME.
  // Keep it as small as your projects allow. Mounted at the same absolute path
  // so a picked runDirectory resolves identically inside the container; the
  // narrower state mounts nested under it are dropped (the workspace covers
  // them).
  const workspaceRoot = resolveWorkspaceRoot(hostHome);
  process.env.HUU_WORKSPACE = workspaceRoot;
  const workspaceMounts = [
    workspaceRoot,
    ...hostHomeMounts.filter((m) => !isPathInside(m, workspaceRoot)),
  ];

  const cidfile = makeCidfilePath();

  // For every API key in the registry, hand the value to the container
  // as a bind-mounted secret file rather than via -e KEY=value. The
  // container's resolver already checks `spec.secretMountPath` first
  // (lib/api-key.ts). Two wins over plain env:
  //   1. Value stays out of `docker inspect`.
  //   2. Value stays off `ps`/proc listings.
  //
  // resolveApiKey() walks secret-mount → global config store → `_FILE` → env,
  // so a key the user persisted in `~/.config/huu/config.json` wins over a
  // stale shell `OPENROUTER_API_KEY` and is forwarded automatically without
  // having to re-enter it.
  const secretMounts: SecretMount[] = [];
  const excludeFromEnv = new Set<string>();
  for (const spec of API_KEY_REGISTRY) {
    const res = resolveApiKeyWithSource(spec);
    if (!res.value) continue;
    // The saved key now takes precedence over the env var. When a saved key
    // wins while a DIFFERENT env var is also set, say so here on the host —
    // otherwise a user who expected the env var to apply is left wondering
    // why huu used another key (the in-container resolver can't see this,
    // since the key arrives pre-resolved via the secret mount).
    if (res.storedOverridesEnv) {
      process.stderr.write(
        `huu: note: ${spec.envVar} is set in your environment, but huu is using the ` +
          `${spec.label} key you saved in Options (a saved key takes precedence) — forwarding the ` +
          `saved key into the container. Clear the saved key in Options to use ${spec.envVar} instead.\n`,
      );
    }
    secretMounts.push({
      hostPath: makeSecretFile(res.value, spec.hostSecretScope),
      containerPath: spec.secretMountPath,
    });
    excludeFromEnv.add(spec.envVar);
  }

  // jcode is NOT in the image (there is no public distribution URL for it), so
  // the wrapper lends the host's install: a read-only bind of the bundle dir at
  // /opt/jcode, which the Dockerfile symlinks onto PATH as `jcode`.
  //
  // OPPORTUNISTIC by necessity: this code runs BEFORE any UI, and the backend
  // is picked later (web UI, TUI, or per pipeline step) — "will this run use
  // jcode?" is unknowable here. So we mount whenever the host has a usable
  // bundle (free: read-only, zero image bytes) and mount nothing when it
  // doesn't. A host without jcode NEVER fails to start; the jcode backend is
  // the one that fails, loudly and actionably, if a run actually reaches for it
  // (see jcodeMissingExecutableMessage).
  const jcodeBundle = detectHostJcodeBundle();
  const readonlyMounts = jcodeBundle
    ? [{ hostPath: jcodeBundle.hostDir, containerPath: jcodeBundle.containerDir }]
    : [];

  const argv = buildDockerArgv({
    cwd: process.cwd(),
    image,
    cidfile,
    args,
    hasTTY: Boolean(process.stdin.isTTY),
    uid: typeof process.getuid === 'function' ? process.getuid() : 0,
    gid: typeof process.getgid === 'function' ? process.getgid() : 0,
    secretMounts,
    excludeFromEnv,
    extraMounts: [...(opts.extraMounts ?? []), ...workspaceMounts],
    readonlyMounts,
    network: pickDockerNetwork(),
    publishPorts: opts.publishPorts,
    memoryLimitSupported: probeDockerMemoryLimitSupport(),
  });

  const child = spawn('docker', argv, { stdio: 'inherit' });

  let killed = false;
  const killContainer = (signal: NodeJS.Signals): void => {
    if (killed) return;
    killed = true;
    // Read the cid recorded by docker run --cidfile. May not yet exist
    // if the user hammered Ctrl+C before docker had a chance to start.
    let cid = '';
    try {
      // Wait briefly for the cidfile to materialize. Docker writes it
      // very early in the run, but there's a small race window.
      for (let i = 0; i < 20 && !cid; i++) {
        try {
          if (existsSync(cidfile)) {
            cid = readFileSync(cidfile, 'utf8').trim();
            if (cid) break;
          }
        } catch {
          /* ignore */
        }
        // Tight sleep without using setTimeout (we may be in a sync
        // signal handler). 50ms total max.
        const end = Date.now() + 5;
        while (Date.now() < end) {
          /* spin */
        }
      }
    } catch {
      /* ignore */
    }
    if (cid) {
      // SIGTERM by default; the container's tini forwards to huu's
      // signal-exit cleanup chain, which restores the terminal and
      // drops the active-run sentinel before exiting.
      spawnSync('docker', ['kill', '--signal', signal === 'SIGINT' ? 'INT' : 'TERM', cid], {
        stdio: 'ignore',
      });
    } else {
      // No cid yet → docker run is still starting. Killing the docker
      // client itself is the only lever we have.
      try {
        child.kill(signal);
      } catch {
        /* ignore */
      }
    }
  };

  // Trap host signals. moby#28872 means we can't trust docker's own
  // sig-proxy with -t attached; explicit kill is the reliable path.
  process.on('SIGINT', () => killContainer('SIGINT'));
  process.on('SIGTERM', () => killContainer('SIGTERM'));
  process.on('SIGHUP', () => killContainer('SIGHUP'));

  // Wait for the child to exit, then clean up.
  const exitCode = await new Promise<number>((resolve) => {
    child.on('exit', (code, signal) => {
      // Code 130 = 128 + SIGINT (2), 143 = 128 + SIGTERM (15), etc.
      // Match the shell convention so callers can branch on it.
      if (signal) resolve(128 + (signal === 'SIGINT' ? 2 : signal === 'SIGTERM' ? 15 : 1));
      else resolve(code ?? 0);
    });
    child.on('error', (err) => {
      process.stderr.write(`huu: failed to spawn docker: ${err.message}\n`);
      resolve(127);
    });
  });

  // Cleanup cidfile (docker --rm already removed the container).
  try {
    if (existsSync(cidfile)) unlinkSync(cidfile);
  } catch {
    /* ignore */
  }
  // Cleanup any secret files we created. The container is gone, so the
  // bind mount is gone with it; the host file is now harmless to remove.
  for (const m of secretMounts) {
    try {
      if (existsSync(m.hostPath)) unlinkSync(m.hostPath);
    } catch {
      /* ignore */
    }
  }

  return exitCode;
}

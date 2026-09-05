/**
 * HOST-side discovery of a usable `jcode` bundle, so the Docker wrapper can
 * bind-mount it READ-ONLY into the container at {@link JCODE_CONTAINER_DIR}.
 *
 * Why a bind-mount and not a layer in the Dockerfile: there is no public
 * distribution URL for jcode anywhere in this repo, so the image cannot fetch
 * it. The host that wants the jcode backend already has the bundle installed —
 * mounting it costs zero image bytes and always matches the version the user
 * actually runs.
 *
 * Why OPPORTUNISTIC (mount whenever the host has one, never gate on "the user
 * picked jcode"): the re-exec gate runs at the very top of `cli.tsx`, BEFORE
 * any UI. The backend is chosen later — interactively in the web UI or the TUI,
 * or per-step by a pipeline — so at `docker run` time "will this run use jcode?"
 * is genuinely unknown. A read-only mount of an already-present host directory
 * is cheap and side-effect free, so we pay it always rather than guess. The
 * symmetric consequence is that a host WITHOUT jcode must never fail startup:
 * every probe here degrades to `null` ("don't mount") instead of throwing.
 *
 * What the bundle actually is (measured on a real install, jcode 0.67.1):
 *   ~/.local/bin/jcode                     → symlink
 *   ~/.jcode/builds/stable/jcode           → symlink
 *   ~/.jcode/builds/versions/<v>/jcode     → 505-byte /bin/sh WRAPPER that
 *       exports LD_LIBRARY_PATH=<its own dir> and execs …/jcode-linux-x86_64.bin
 *   ~/.jcode/builds/versions/<v>/jcode-linux-x86_64.bin  → the 155 MB ELF
 * The wrapper and the payload MUST travel together, which is why the unit we
 * mount is the DIRECTORY, never a single file.
 *
 * Shape follows `init-docker.ts` / `jcode-doctor.ts`: a PURE core
 * ({@link resolveJcodeBundle}) whose every input is injected, plus thin impure
 * probes and one gatherer ({@link detectHostJcodeBundle}).
 */
import {
  accessSync,
  closeSync,
  constants,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, delimiter, dirname, join } from 'node:path';
import { findSpec } from './api-key-registry.js';
import { DEFAULT_PROVIDER, providerInfo, type LlmProvider } from './providers.js';

/** Where the wrapper mounts the host bundle. Stable — the Dockerfile symlinks into it. */
export const JCODE_CONTAINER_DIR = '/opt/jcode';

/** The launcher's file name, on the host PATH and inside the mounted bundle. */
export const JCODE_EXECUTABLE_NAME = 'jcode';

/** `/usr/local/bin/jcode` → this. Created by the Dockerfile (dangles when unmounted). */
export const JCODE_CONTAINER_EXECUTABLE = `${JCODE_CONTAINER_DIR}/${JCODE_EXECUTABLE_NAME}`;

/**
 * ELF `e_machine` expected for each Node `process.arch`. The container runs the
 * host's architecture (docker picks the matching manifest), so the host binary
 * only executes inside if its ELF machine matches. An arch missing from this
 * map resolves to "unknown" → we refuse to mount rather than guess.
 */
const ELF_MACHINE_BY_NODE_ARCH: Readonly<Record<string, number>> = {
  x64: 0x3e, // EM_X86_64
  arm64: 0xb7, // EM_AARCH64
  arm: 0x28, // EM_ARM
  ia32: 0x03, // EM_386
  ppc64: 0x15, // EM_PPC64
  s390x: 0x16, // EM_S390
  riscv64: 0xf3, // EM_RISCV
};

/**
 * Directories we refuse to mount even when `jcode` resolves inside them: they
 * are SHARED system bin dirs, so the mount would drag the host's whole userland
 * under `/opt/jcode` for no benefit. A jcode installed there is also not a
 * self-contained bundle (no sidecar payload next to it), so the mount would not
 * work anyway — degrade to "no mount" and let the backend's ENOENT message
 * point the user at a native run.
 */
const SHARED_SYSTEM_BIN_DIRS: ReadonlySet<string> = new Set([
  '/bin',
  '/sbin',
  '/usr/bin',
  '/usr/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
  '/opt/homebrew/bin',
]);

/** A host jcode install the wrapper considers usable inside the Linux container. */
export interface JcodeBundle {
  /** Absolute HOST directory holding the launcher AND its native payload. */
  hostDir: string;
  /** Absolute HOST path of the launcher (always `<hostDir>/jcode`). */
  hostExecutable: string;
  /** Where {@link hostDir} is exposed inside the container. */
  containerDir: string;
  /** ELF `e_machine` of the payload — proof it can execute in the container. */
  payloadMachine: number;
}

/** Everything {@link resolveJcodeBundle} needs, all injectable. */
export interface JcodeBundleInputs {
  /** `process.platform` of the HOST. */
  platform: NodeJS.Platform;
  /** `process.arch` of the HOST. */
  arch: string;
  /** Fully symlink-resolved `jcode` from PATH; null when absent/not executable. */
  executablePath: string | null;
  /** ELF `e_machine` of the native payload in the bundle dir; null when none. */
  payloadMachine: number | null;
}

/**
 * PURE: decide whether the host bundle may be mounted. No fs, no env, no exec.
 *
 * Every rejection returns null — "don't mount" is always a valid answer, and a
 * run that never touches jcode must not care.
 */
export function resolveJcodeBundle(inputs: JcodeBundleInputs): JcodeBundle | null {
  // GUARD 1 — the container is Linux. A macOS host's jcode is a Mach-O binary
  // and a Windows host's is a PE; neither executes under the Linux kernel the
  // container shares. (The ELF check below would also catch it, but saying so
  // explicitly keeps the intent readable.)
  if (inputs.platform !== 'linux') return null;

  const executable = inputs.executablePath;
  if (!executable) return null;

  // GUARD 2 — the launcher must be named `jcode`: the container reaches it via
  // a STATIC symlink `/usr/local/bin/jcode -> /opt/jcode/jcode`, so a bundle
  // whose launcher has another name would mount fine and still not be callable.
  if (basename(executable) !== JCODE_EXECUTABLE_NAME) return null;

  const hostDir = dirname(executable);
  // GUARD 3 — never mount a shared system bin dir (see the constant).
  if (SHARED_SYSTEM_BIN_DIRS.has(hostDir)) return null;

  // GUARD 4 — architecture. The payload's ELF machine must match what the
  // container will run. An arch we can't map is treated as a mismatch.
  const expected = ELF_MACHINE_BY_NODE_ARCH[inputs.arch];
  if (expected === undefined) return null;
  if (inputs.payloadMachine === null || inputs.payloadMachine !== expected) return null;

  return {
    hostDir,
    hostExecutable: executable,
    containerDir: JCODE_CONTAINER_DIR,
    payloadMachine: inputs.payloadMachine,
  };
}

/**
 * Read the ELF `e_machine` of a file, or null when it isn't an ELF (a shell
 * wrapper, a Mach-O, a directory, an unreadable path). 20 bytes off the head —
 * no full read of a 155 MB binary.
 */
export function readElfMachine(path: string): number | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const head = Buffer.alloc(20);
    if (readSync(fd, head, 0, 20, 0) < 20) return null;
    // e_ident[0..3] = \x7F E L F
    if (head[0] !== 0x7f || head[1] !== 0x45 || head[2] !== 0x4c || head[3] !== 0x46) {
      return null;
    }
    // e_ident[5] = EI_DATA: 1 little-endian, 2 big-endian. e_machine at offset 18.
    return head[5] === 2 ? head.readUInt16BE(18) : head.readUInt16LE(18);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Find `jcode` on `env.PATH` and return its FULLY resolved path (symlinks
 * followed to the real file), or null. The host install is a chain of symlinks
 * — `~/.local/bin/jcode` → `builds/stable/jcode` → `builds/versions/<v>/jcode`
 * — and only the final location has the payload next to it, so resolving is
 * what makes the mount correct.
 */
export function findJcodeExecutable(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const entry of (env.PATH ?? '').split(delimiter)) {
    const dir = entry.trim();
    if (!dir) continue;
    const candidate = join(dir, JCODE_EXECUTABLE_NAME);
    try {
      // X_OK follows symlinks, so a dangling link throws and we move on.
      accessSync(candidate, constants.X_OK);
      const real = realpathSync(candidate);
      if (!statSync(real).isFile()) continue;
      return real;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * The ELF machine of the bundle's native payload. The launcher itself is a
 * `/bin/sh` wrapper on today's builds, so the answer normally comes from a
 * sibling (`jcode-linux-x86_64.bin`); a future build that ships the binary
 * directly as `jcode` is handled by checking the launcher first.
 *
 * Never throws — an unreadable directory answers null ("can't prove it runs").
 */
export function detectBundlePayloadMachine(executable: string): number | null {
  const own = readElfMachine(executable);
  if (own !== null) return own;

  const dir = dirname(executable);
  const self = basename(executable);
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() || e.isSymbolicLink())
      .map((e) => e.name)
      .sort();
  } catch {
    return null;
  }
  // Siblings named after the launcher first (`jcode-linux-x86_64.bin`), so the
  // common layout resolves without opening every file in the directory.
  const ordered = [
    ...names.filter((n) => n !== self && n.startsWith(self)),
    ...names.filter((n) => n !== self && !n.startsWith(self)),
  ];
  for (const name of ordered) {
    const machine = readElfMachine(join(dir, name));
    if (machine !== null) return machine;
  }
  return null;
}

/**
 * IMPURE gatherer — probe the host and hand the pure core its inputs. Returns
 * the bundle to mount, or null. Swallows everything: a wrapper that crashed
 * because a host had a weird `PATH` would break runs that never use jcode.
 */
export function detectHostJcodeBundle(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): JcodeBundle | null {
  try {
    const executablePath = findJcodeExecutable(env);
    return resolveJcodeBundle({
      platform,
      arch,
      executablePath,
      payloadMachine: executablePath ? detectBundlePayloadMachine(executablePath) : null,
    });
  } catch {
    return null;
  }
}

/**
 * The message the jcode backend shows when `spawn('jcode')` fails with ENOENT.
 *
 * Actionable by construction: the user cannot install jcode INTO the container
 * (the image doesn't ship it and can't fetch it), so the two real exits are
 * "install it on the host so the wrapper can mount it" and "run huu natively,
 * where the host PATH already has it".
 */
export function jcodeMissingExecutableMessage(): string {
  return [
    'jcode: executable not found in this environment (spawn ENOENT).',
    '',
    'The huu image does NOT ship jcode. The host wrapper bind-mounts a host',
    `install read-only at ${JCODE_CONTAINER_DIR} (reached as \`jcode\` on PATH), and no`,
    'usable bundle was found on the host. Either:',
    '  1. install jcode on the host so `which jcode` resolves — it must be a',
    '     Linux build matching this machine\'s architecture, since a macOS',
    '     (Mach-O) build cannot execute inside the Linux container; or',
    '  2. run huu natively, where your host jcode is already on PATH:',
    '       huu --no-docker …   (or --yolo)   — no container isolation',
    '       npm run dev                        — contributors, from a checkout',
  ].join('\n');
}

/**
 * The message the jcode backend shows when it has NO credential to hand the
 * subprocess — neither one huu resolved for the run nor one inherited from the
 * environment.
 *
 * Sibling of {@link jcodeMissingExecutableMessage}, same shape and same reason:
 * the raw failure ("DEEPSEEK_API_KEY not found in environment", emitted by
 * jcode itself several seconds into a spawn) names a variable the user never
 * set and never sees — inside the container huu deliberately does NOT forward
 * it as an env var, it arrives as a secret MOUNT. So the message must say which
 * variable the provider profile reads and every way to supply it.
 *
 * Keyed on the PROVIDER, defaulting to {@link DEFAULT_PROVIDER}: jcode serves
 * two, and telling an OpenRouter user to export `DEEPSEEK_API_KEY` would send
 * them to set up exactly the credential the run must NOT spend. Every name is
 * read from that provider's spec in the registry, so the profile's
 * `api_key_env`, the Docker wrapper's mount and this text cannot drift apart.
 */
export function jcodeMissingApiKeyMessage(
  provider: LlmProvider = DEFAULT_PROVIDER,
): string {
  const info = providerInfo(provider);
  const spec = findSpec(info.apiKeySpecName);
  const envVar = spec?.envVar ?? 'DEEPSEEK_API_KEY';
  const envFileVar = spec?.envFileVar ?? 'DEEPSEEK_API_KEY_FILE';
  const secretMountPath = spec?.secretMountPath ?? '/run/secrets/deepseek_api_key';
  return [
    `jcode: no ${info.label} API key available (${envVar} would reach the subprocess empty).`,
    '',
    `The jcode provider profile for ${info.label} reads its credential from the`,
    `${envVar} environment variable (\`api_key_env\` in jcode's config.toml —`,
    'see docs/jcode-setup-guide.md §3.1), and huu resolved no key to put there.',
    'Supply it in ANY of these ways:',
    '  1. save the key inside huu (TUI API-key screen, or web ⚙ Options) — a',
    '     saved key outranks the environment and is the one form that survives',
    `     into the container, where it arrives as ${secretMountPath};`,
    `  2. export ${envVar}=<key> before starting huu; or`,
    `  3. point ${envFileVar} at a file containing the key.`,
    `Keys are issued at ${info.keysUrl}.`,
  ].join('\n');
}

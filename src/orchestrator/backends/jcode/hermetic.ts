/**
 * Hermetic jcode-session composition — huu's OWN clean jcode runtime.
 *
 * Why this exists: jcode resolves its provider config from the user's home
 * (`$HOME/.jcode/config.toml`) and may auto-discover extensions, send telemetry
 * and persist embeddings. huu wants none of that — and inside the huu container
 * `$HOME/.jcode/config.toml` does not exist at all, so a jcode spawn that
 * trusted the host config died on
 * `Unknown provider profile 'deepseek-v4-pro'. Add [providers.deepseek-v4-pro]
 * to config.toml.` A clean host install failed the same way until the user
 * hand-wrote that TOML.
 *
 * TWO env vars do TWO different jobs here. Both statements below were MEASURED
 * against a real jcode, not inferred:
 *
 *  - `JCODE_AGENT_DIR` isolates the RUNTIME dir. It does NOT move the config
 *    lookup: a `config.toml` dropped in that dir is ignored and the profile
 *    still fails to resolve. (An earlier version of this header claimed this
 *    var alone made jcode "never read host-global config" — that was false.)
 *  - `JCODE_HOME` isolates the CONFIG. `JCODE_HOME=<dir>` makes jcode read
 *    `<dir>/config.toml` — directly, with NO `.jcode` segment in between — and
 *    it wins even when `$HOME/.jcode/config.toml` exists and lacks the profile.
 *
 * So the hermetic branch MATERIALIZES huu's own `config.toml` under
 * `~/.huu/jcode-home/` and points `JCODE_HOME` at that directory. The backend
 * then works identically on a clean host and inside the container, with no
 * hand-written `~/.jcode/config.toml` anywhere.
 *
 * The file declares ONE openai-compatible profile PER PROVIDER huu exposes
 * (`deepseek-v4-pro` → api.deepseek.com, `openrouter` → openrouter.ai), each
 * derived from the provider table in `lib/providers.ts`. It is a static
 * CATALOG: `--provider-profile` is what picks from it per spawn
 * ({@link jcodeProviderProfile}). Writing only the current run's provider
 * would make two runs of different providers fight over the same self-healing
 * file forever — and pinning ONE profile for every run, which is what this
 * module used to do, sent an OpenRouter user's `sk-or-…` key to
 * api.deepseek.com as a Bearer token.
 *
 * Note what is NOT in the file: the credential. Each profile only NAMES its
 * variable via `api_key_env`; huu's api-key chain
 * (`lib/api-key-registry.ts`) puts the value in the spawn env, and
 * `withJcodeApiKey` narrows it to the ONE provider the run chose.
 *
 * The rest of the isolation, unchanged:
 *  - Zero embeddings (`JCODE_MEMORY_ENABLED=false`) — each agent run is
 *    stateless; the transcript is the memory.
 *  - No telemetry (`JCODE_NO_TELEMETRY=1`) — huu is the caller and handles its
 *    own observability.
 *
 * The single escape hatch is `HUU_JCODE_HERMETIC=0`: it writes NO file, sets NO
 * variable and hands the child `process.env` untouched, so jcode resolves its
 * config from the host home exactly as it did before this module existed
 * (debugging parity — that is the whole point of the branch).
 */
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { findSpec } from '../../../lib/api-key-registry.js';
import { getHuuHome } from '../../../lib/huu-home.js';
import {
  DEFAULT_PROVIDER,
  PROVIDERS,
  apiKeySpecNameForProvider,
  providerInfo,
  type LlmProvider,
} from '../../../lib/providers.js';

/**
 * Hermetic is the DEFAULT. Only an explicit `HUU_JCODE_HERMETIC=0|false`
 * opts a run back into the legacy host-global jcode behavior.
 */
export function resolveHermeticEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.HUU_JCODE_HERMETIC?.trim().toLowerCase();
  return raw !== '0' && raw !== 'false';
}

/**
 * The huu-owned jcode agent dir: `~/.huu/jcode-agent` — mirrors the
 * pi-agent convention so both backends share the `~/.huu/` namespace.
 */
export function jcodeAgentDir(): string {
  return join(getHuuHome(), '.huu', 'jcode-agent');
}

/**
 * jcode profile shape for ONE provider: the `[providers.<name>]` block the
 * materialized config declares and `--provider-profile` selects.
 *
 * `base_url` and `api_key_env` are NOT stored here — they are derived from the
 * provider table (`lib/providers.ts`) and the credential registry
 * (`lib/api-key-registry.ts`) when the TOML is composed, so the URL jcode dials
 * and the variable it reads can never disagree with the URL huu's own LangChain
 * clients dial or the key huu's resolver fills. That divergence is exactly the
 * bug this module shipped: a `--provider-profile` pinned to DeepSeek while the
 * user had chosen OpenRouter sent an `sk-or-…` secret to api.deepseek.com.
 */
interface JcodeProfile {
  /** Profile name — the `<name>` in `[providers.<name>]` and `--provider-profile <name>`. */
  name: string;
  /** `default_model` for the profile, in the shape THAT endpoint expects. */
  defaultModel: string;
  contextWindow: number;
  maxTokens: number;
}

/**
 * One profile per provider, exhaustive BY TYPE: `Record<LlmProvider, …>` makes
 * a new member of {@link LlmProvider} a COMPILE error here instead of a run
 * that silently falls back to somebody else's endpoint.
 *
 * `deepseek`'s profile name stays `deepseek-v4-pro` on purpose — it is the
 * exact string `docs/jcode-setup-guide.md` §3 documents and the one clean-host
 * combination proven to resolve; renaming it would only strand that doc.
 */
const JCODE_PROFILES: Readonly<Record<LlmProvider, JcodeProfile>> = {
  deepseek: {
    name: 'deepseek-v4-pro',
    // BARE, not `deepseek/deepseek-v4-pro`: api.deepseek.com is a
    // single-vendor endpoint. Same rule `modelIdForProvider` applies to the
    // `--model` huu actually passes, so the declared default and the spawned
    // model are written in ONE namespace.
    defaultModel: 'deepseek-v4-pro',
    contextWindow: 1000000,
    maxTokens: 384000,
  },
  openrouter: {
    name: 'openrouter',
    // PREFIXED: openrouter.ai routes ON the vendor segment.
    defaultModel: 'deepseek/deepseek-v4-pro',
    contextWindow: 1048576,
    maxTokens: 384000,
  },
};

/** The `--provider-profile` name for a provider. */
export function jcodeProviderProfile(p: LlmProvider): string {
  return JCODE_PROFILES[p].name;
}

/**
 * The env var a provider's jcode profile reads (`api_key_env`). Taken from the
 * credential registry through the provider table, so the profile, the Docker
 * wrapper's secret mount and the spawn env can never name three different
 * variables.
 */
export function jcodeApiKeyEnvVar(p: LlmProvider): string {
  const specName = apiKeySpecNameForProvider(p);
  const envVar = specName ? findSpec(specName)?.envVar : undefined;
  if (!envVar) {
    // Unreachable while every provider's `apiKeySpecName` names a registry
    // entry — and a THROW is the right answer if that ever stops being true.
    // Guessing a variable name here is how a credential ends up in the wrong
    // one; refusing keeps the spawn from starting at all.
    throw new Error(`jcode: provider "${p}" has no credential spec in API_KEY_REGISTRY`);
  }
  return envVar;
}

/**
 * The profile the factory spawns with WHEN THE CALLER PICKED NO PROVIDER.
 *
 * Read the name literally — it is a DEFAULT, not "the jcode profile". jcode
 * serves every provider in {@link PROVIDERS}; anything that knows which one the
 * user chose must call {@link jcodeProviderProfile} with it.
 */
export const JCODE_PROVIDER_PROFILE = jcodeProviderProfile(DEFAULT_PROVIDER);

/** jcode reads exactly this file name from `$JCODE_HOME`. */
export const JCODE_CONFIG_FILENAME = 'config.toml';

/**
 * The huu-owned jcode CONFIG home: `~/.huu/jcode-home`, the directory
 * `JCODE_HOME` points at (so jcode reads `~/.huu/jcode-home/config.toml`).
 *
 * Deliberately NOT the agent dir: `JCODE_HOME` is a home-shaped root that jcode
 * also resolves other paths under (e.g. `<JCODE_HOME>/config/jcode/*.env`), and
 * mixing that with the runtime dir would blur which variable owns what. Honors
 * `HUU_HOST_HOME` through `getHuuHome()`, so in-container it lands on the
 * bind-mounted host `~/.huu` and survives `docker run --rm`.
 */
export function jcodeConfigHomeDir(): string {
  return join(getHuuHome(), '.huu', 'jcode-home');
}

/** One `[providers.<name>]` + `[[providers.<name>.models]]` pair. */
function jcodeProfileBlock(p: LlmProvider): string {
  const profile = JCODE_PROFILES[p];
  const info = providerInfo(p);
  return `[providers.${profile.name}]
type = "openai-compatible"
base_url = "${info.defaultBaseUrl}"
auth = "bearer"
api_key_env = "${jcodeApiKeyEnvVar(p)}"
default_model = "${profile.defaultModel}"
requires_api_key = true

[[providers.${profile.name}.models]]
id = "${profile.defaultModel}"
context_window = ${profile.contextWindow}
max_tokens = ${profile.maxTokens}
`;
}

/**
 * huu's own jcode provider config — ONE profile per provider huu exposes.
 *
 * Why every provider and not just the chosen one: `ensureJcodeConfig` compares
 * bytes and self-heals, and N agents spawn in parallel. A file whose CONTENT
 * depended on the current run's provider would be rewritten on every run that
 * switched, and two runs of different providers racing would fight over it
 * forever. The file is a static CATALOG; `--provider-profile` is what selects
 * from it per spawn.
 *
 * The DeepSeek block is byte-for-byte the profile documented in
 * `docs/jcode-setup-guide.md` §3 — the one combination proven to resolve — plus
 * a leading banner (TOML comments, verified harmless: jcode parses this file and
 * reaches the "DEEPSEEK_API_KEY not found" stage, i.e. the profile resolved).
 *
 * No secret lives here. Each profile only NAMES its variable via `api_key_env`;
 * the value arrives in the spawn env (`withJcodeApiKey`).
 */
export const JCODE_CONFIG_TOML = `# Managed by huu — this file is owned by the jcode backend and any local edit
# is silently reverted on the next agent spawn. Do not put secrets here: each
# profile only NAMES its credential variable via api_key_env, and huu puts the
# value in the spawn environment.
# Source: src/orchestrator/backends/jcode/hermetic.ts

[provider]
default_provider = "${JCODE_PROFILES[DEFAULT_PROVIDER].name}"
default_model = "${JCODE_PROFILES[DEFAULT_PROVIDER].defaultModel}"

${PROVIDERS.map((info) => jcodeProfileBlock(info.id)).join('\n')}`;

/**
 * Materialize `<dir>/config.toml` so jcode can resolve
 * {@link JCODE_PROVIDER_PROFILE}. Returns the file path once the canonical
 * bytes are on disk, or `null` when they could not be put there.
 *
 * WRITE POLICY — self-heal, not blind rewrite. The on-disk bytes are compared
 * against {@link JCODE_CONFIG_TOML} and only a mismatch (or an absent file)
 * triggers a write. That gives both properties the two obvious policies each
 * give only one of: a user edit CANNOT leave the backend broken (unlike
 * create-if-missing, which would honor a hand-broken file forever), and the
 * steady state costs one ~600-byte read instead of a write per agent spawn
 * (unlike always-overwrite, which would have every parallel agent rewriting the
 * same file at fleet start-up).
 *
 * RACE SAFETY — several jcode agents spawn at once, all calling this. The write
 * is staged in a per-call uniquely named temp file in the SAME directory
 * (`rename` is only atomic within a filesystem) and then `rename`d over the
 * target: a concurrent reader sees either the whole old file or the whole new
 * one, never a truncated one, and two writers racing produce IDENTICAL bytes so
 * whichever rename lands last is still correct. Same recipe as
 * `lib/dev-graph/graph-store.ts`.
 *
 * NEVER THROWS — a config that cannot be written is a degradation, not a crash:
 * the caller drops `JCODE_HOME` and jcode falls back to the host lookup, which
 * is exactly the pre-existing behavior. Failing the spawn instead would turn a
 * read-only `~/.huu` into a dead backend.
 */
export function ensureJcodeConfig(dir: string = jcodeConfigHomeDir()): string | null {
  const path = join(dir, JCODE_CONFIG_FILENAME);

  // Steady state: the bytes are already ours — nothing to do.
  try {
    if (readFileSync(path, 'utf8') === JCODE_CONFIG_TOML) return path;
  } catch {
    /* absent / unreadable / mid-rename — fall through and (re)write */
  }

  const tmp = `${path}.${process.pid}-${Math.random().toString(36).slice(2, 10)}.huu.tmp`;
  try {
    // 0o755 / 0o644, not the 0o700 / 0o600 used for huu's secret-bearing files:
    // this one holds no credential, and the container can run as a different
    // UID than the one that created it (docker/entrypoint.sh synthesizes a HOME
    // for an unknown `--user`), where owner-only bits would lock jcode out of
    // its own config.
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    writeFileSync(tmp, JCODE_CONFIG_TOML, { encoding: 'utf8', mode: 0o644 });
    // The `mode` above is only a REQUEST: mkdir(2)/open(2) mask it with the
    // process umask, so a hardened `umask 077` silently yields 0o700/0o600 —
    // measured — i.e. exactly the owner-only bits the paragraph above argues
    // must not happen. chmod(2) is NOT masked, so re-assert both. Best effort
    // in its own try: a filesystem that cannot chmod (a Windows/CIFS-backed
    // bind mount) must degrade to "wrong bits", never to "no config at all".
    try {
      chmodSync(tmp, 0o644);
      chmodSync(dir, 0o755);
    } catch {
      /* keep whatever the umask allowed — still readable by its owner */
    }
    renameSync(tmp, path);
    return path;
  } catch {
    // A staging file left behind would be listed by nothing and cleaned by
    // nobody. Best effort: if even this fails, the write failure is the news.
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* nothing left to try */
    }
    return null;
  }
}

export interface JcodeSessionEnvironment {
  /** False only under the HUU_JCODE_HERMETIC=0 escape hatch. */
  hermetic: boolean;
  /** huu-owned agent dir; set only when hermetic. */
  agentDir?: string;
  /**
   * huu-owned config home — the value exported as `JCODE_HOME`. Set only when
   * hermetic AND the config was actually materialized; `undefined` therefore
   * means "degraded to the host config lookup".
   */
  configHome?: string;
  /** Absolute path of the materialized `config.toml`; same condition as {@link configHome}. */
  configPath?: string;
  /** The env object to pass to child_process.spawn. */
  env: NodeJS.ProcessEnv;
}

/**
 * Compose the environment object for `child_process.spawn('jcode', …)`.
 *
 * Hermetic branch (default):
 *  - `JCODE_MEMORY_ENABLED=false` — zero embeddings, stateless runs.
 *  - `JCODE_NO_TELEMETRY=1` — no external telemetry.
 *  - `JCODE_AGENT_DIR` → `~/.huu/jcode-agent` — isolated RUNTIME dir.
 *  - `JCODE_HOME` → `~/.huu/jcode-home` — isolated CONFIG dir, holding a
 *    huu-materialized `config.toml` holding ONE profile per provider. An
 *    ambient `JCODE_HOME` is overridden on purpose: leaving it would hand the
 *    config back to the host, which is the dependency this branch exists to cut.
 *  - Both dirs are created best-effort; a failure degrades (see below) instead
 *    of taking the spawn down.
 *
 * Degradation: if the config cannot be written, `JCODE_HOME` is NOT exported —
 * the parent's own value (usually none) is left exactly as inherited, so jcode
 * resolves its config the way it did before this module: `$JCODE_HOME` when the
 * caller set one, otherwise `$HOME/.jcode/config.toml`. No better than before,
 * but no worse, and never a crash.
 *
 * Legacy escape hatch (`HUU_JCODE_HERMETIC=0`):
 *  - Returns `process.env` as-is and writes nothing — exactly the pre-hermetic
 *    behavior, byte for byte.
 */
export function buildJcodeSessionEnvironment(
  opts?: { env?: NodeJS.ProcessEnv },
): JcodeSessionEnvironment {
  const parentEnv = opts?.env ?? process.env;

  if (!resolveHermeticEnabled(parentEnv)) {
    return { hermetic: false, env: { ...parentEnv } };
  }

  const agentDir = jcodeAgentDir();
  try {
    mkdirSync(agentDir, { recursive: true });
  } catch {
    /* best-effort — jcode may create it on first write */
  }

  const env: NodeJS.ProcessEnv = {
    ...parentEnv,
    JCODE_MEMORY_ENABLED: 'false',
    JCODE_NO_TELEMETRY: '1',
    JCODE_AGENT_DIR: agentDir,
  };

  const configHome = jcodeConfigHomeDir();
  const configPath = ensureJcodeConfig(configHome);
  if (configPath !== null) env.JCODE_HOME = configHome;

  return {
    hermetic: true,
    agentDir,
    ...(configPath !== null ? { configHome, configPath } : {}),
    env,
  };
}

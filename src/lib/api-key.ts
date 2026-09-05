import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  API_KEY_REGISTRY,
  detectForeignKeySpec,
  findSpec,
  type ApiKeySpec,
} from './api-key-registry.js';
import {
  apiKeySpecNameForProvider,
  resolveRunProvider,
  type LlmProvider,
} from './providers.js';
import type { AgentBackendKind } from './types.js';

export { API_KEY_REGISTRY, detectForeignKeySpec, findSpec };
export type { ApiKeySpec };

/** Which precedence tier of the resolver supplied a key value. */
export type ApiKeySource =
  | 'secret-mount'
  | 'env-file'
  | 'env'
  | 'stored'
  | 'none';

export interface ApiKeyResolution {
  /** The resolved value (already trimmed). Empty string if none. */
  value: string;
  /** Which precedence tier supplied `value`. */
  source: ApiKeySource;
  /**
   * True when the user's EXPLICITLY SAVED key won (`source === 'stored'`) AND a
   * DIFFERENT non-empty ambient credential is also present (an `<NAME>_FILE`
   * file, or the `<NAME>` env var) — i.e. huu is deliberately IGNORING an
   * ambient value in favor of what the user saved in Options. This is the
   * inverted successor to the old `shadowsStored`: the resolver now ranks the
   * saved store ABOVE the env var (the explicit choice beats the ambient one),
   * so the old "a stale `OPENROUTER_API_KEY` exported from a shell profile
   * silently shadows the saved key → 401" foot-gun is gone and the diagnostic
   * points the other way. Only ever true when `source === 'stored'`.
   */
  storedOverridesEnv: boolean;
}

/**
 * The ambient (non-explicit) credential for a spec: the `<NAME>_FILE` file
 * contents if set, else the plain `<NAME>` env var (trimmed). Used only to
 * tell whether a winning stored key is overriding something the environment
 * also offers — never as a resolved value on its own.
 */
function ambientEnvValue(spec: ApiKeySpec): string {
  const fileVar = process.env[spec.envFileVar];
  if (fileVar) {
    const fromFile = readKeyFile(fileVar);
    if (fromFile) return fromFile;
  }
  return (process.env[spec.envVar] ?? '').trim();
}

/**
 * Generic resolver for the API keys declared in the registry, reporting
 * WHICH tier won so callers can give an actionable error.
 *
 * Resolution order (first non-empty wins) — the EXPLICIT choice beats the
 * AMBIENT one:
 *   1. Container secret mount (`spec.secretMountPath`). In Docker the host
 *      resolves the key with this same order and re-mounts it here, so the
 *      mount already reflects the host's decision.
 *   2. Persisted global store at `$XDG_CONFIG_HOME/huu/config.json`
 *      (fallback `~/.config/huu/config.json`) — the key the user explicitly
 *      saved via the TUI's "save key globally" path. This now OUTRANKS the
 *      env var, so a stale `OPENROUTER_API_KEY` left in a shell profile no
 *      longer shadows what the user deliberately saved.
 *   3. `<NAME>_FILE` env var pointing at a file with the value.
 *   4. `<NAME>` env var (plain) — the fallback when nothing is saved (the
 *      standard CI / headless path: no Options save, so the env var wins).
 *
 * Never throws on missing files — callers (TUI, agent factory, docker
 * re-exec) handle the empty case explicitly.
 */
export function resolveApiKeyWithSource(spec: ApiKeySpec): ApiKeyResolution {
  const fromMount = readKeyFile(spec.secretMountPath);
  if (fromMount) {
    return { value: fromMount, source: 'secret-mount', storedOverridesEnv: false };
  }

  // The explicitly saved key wins over the ambient env var/file. When it does,
  // flag whether a DIFFERENT ambient value is being ignored so the UI/CLI can
  // say so, instead of leaving the user wondering which key huu used.
  const stored = loadStoredApiKey(spec);
  if (stored !== '') {
    const ambient = ambientEnvValue(spec);
    return {
      value: stored,
      source: 'stored',
      storedOverridesEnv: ambient !== '' && ambient !== stored,
    };
  }

  const fileVar = process.env[spec.envFileVar];
  if (fileVar) {
    const fromFile = readKeyFile(fileVar);
    if (fromFile) {
      return { value: fromFile, source: 'env-file', storedOverridesEnv: false };
    }
  }

  const fromEnv = (process.env[spec.envVar] ?? '').trim();
  if (fromEnv) {
    return { value: fromEnv, source: 'env', storedOverridesEnv: false };
  }

  return { value: '', source: 'none', storedOverridesEnv: false };
}

/** Value-only resolver. Thin wrapper over {@link resolveApiKeyWithSource}. */
export function resolveApiKey(spec: ApiKeySpec): string {
  return resolveApiKeyWithSource(spec).value;
}

/**
 * Human-facing, value-free remediation hint for a key that was rejected
 * (401/403) or is needed. Names the ACTUAL winning source so the fix is
 * actionable. Because the saved store now OUTRANKS the env var, the foot-gun
 * message lives on the `stored` case: an env var can be present but ignored
 * in favor of the key the user explicitly saved in Options.
 */
export function keyRemedyHint(spec: ApiKeySpec, res: ApiKeyResolution): string {
  switch (res.source) {
    case 'stored':
      return res.storedOverridesEnv
        ? `huu used the key you saved in the Options screen (a saved key takes precedence), and ` +
            `it was rejected. ${spec.envVar} is also set in your environment but is IGNORED while ` +
            `a saved key exists — update the saved key in the Options screen, or clear it to fall ` +
            `back to ${spec.envVar}.`
        : `huu used the key saved in the Options screen and it was rejected. Update it there.`;
    case 'env':
      return (
        `huu used the ${spec.envVar} environment variable as the fallback (no key is saved in the ` +
        `Options screen). Correct it where it is exported (shell profile, ~/.secrets, CI secret), ` +
        `or save a key in the Options screen — a saved key takes precedence.`
      );
    case 'env-file':
      return (
        `huu read the key from the file named by ${spec.envFileVar} (no key is saved in the Options ` +
        `screen). Fix that file or unset ${spec.envFileVar}, or save a key in the Options screen — ` +
        `a saved key takes precedence.`
      );
    case 'secret-mount':
      return (
        `huu read the key from the mounted secret ${spec.secretMountPath}. On a Docker run the host ` +
        `resolved this value (the key you saved in Options, or ${spec.envVar}) before forwarding ` +
        `it — fix it on the host.`
      );
    case 'none':
    default:
      return `No ${spec.envVar} key is set. Add one in the Options screen.`;
  }
}

/** Resolve every key in the registry. Map keyed by `spec.name`. */
export function resolveAllApiKeys(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const spec of API_KEY_REGISTRY) {
    out[spec.name] = resolveApiKey(spec);
  }
  return out;
}

/** Specs flagged `required: true` whose value couldn't be resolved. */
export function findMissingRequiredKeys(): ApiKeySpec[] {
  return API_KEY_REGISTRY.filter((s) => s.required && !resolveApiKey(s));
}

/**
 * The run-blocking credential gate, keyed by the PROVIDER that will actually
 * serve the run. This is the PRIMARY form: `deepseek` and `openrouter` both
 * dispatch to the `jcode` backend, so the backend alone no longer identifies
 * a credential — only the provider does.
 *
 * A spec surfaces (i.e. blocks) when it is either:
 *   1. `providerBound` to `provider` and unresolved — enforced REGARDLESS of
 *      `required`, because picking a provider makes its key mandatory. This
 *      is what lets a provider key stay `required: false` (invisible to the
 *      universal gate, so it never blocks the OTHER provider's runs) and
 *      still block its OWN runs.
 *   2. Universal (no `providerBound`), `required: true` and unresolved —
 *      enforced for every run whatever the provider.
 *
 * The invariant: a run demands EXACTLY the credentials of the provider it is
 * about to spend money on. Never both provider keys (that was the trap of
 * binding both specs to `jcode`), and never zero (rule 1 blocks a provider
 * whose own key is missing even when `required` is false).
 *
 * `provider === undefined` means "no provider will be called" — the `stub`
 * backend. Only rule 2 can then surface, and no spec is in that shape today,
 * so `--stub` stays runnable with no key at all.
 */
export function findMissingKeysForProvider(
  provider: LlmProvider | undefined,
): ApiKeySpec[] {
  const out: ApiKeySpec[] = [];
  for (const spec of API_KEY_REGISTRY) {
    const bound = spec.providerBound;
    if (bound) {
      if (bound !== provider) continue;
      // Bound spec for the ACTIVE provider: always enforce, `required` or not.
      if (!resolveApiKey(spec)) out.push(spec);
    } else if (spec.required) {
      if (!resolveApiKey(spec)) out.push(spec);
    }
  }
  return out;
}

/**
 * Backend-keyed wrapper around {@link findMissingKeysForProvider}, for
 * callers that only hold an {@link AgentBackendKind}.
 *
 * It can only answer for the backend's DEFAULT provider — `jcode` serves
 * both `deepseek` and `openrouter`, and demanding both keys would be wrong.
 * A caller that knows which provider the user picked MUST call
 * `findMissingKeysForProvider` directly; otherwise this reports the default
 * provider's missing keys and an OpenRouter-only user looks blocked while
 * holding a perfectly good key.
 *
 * `stub` is served by NO provider (`providersForBackend('stub') === []`), so
 * it resolves to `undefined` and stays keyless by construction rather than
 * by a hardcoded special case.
 */
export function findMissingKeysForBackend(
  backend: AgentBackendKind,
): ApiKeySpec[] {
  return findMissingKeysForProvider(resolveRunProvider(backend));
}

/**
 * The credential spec a run will actually spend, from the provider the user
 * chose. `undefined` when no provider serves the backend (`stub`).
 *
 * Every credential decision goes through here instead of
 * `BackendBundle.apiKeySpecName` — the bundle is keyed on the BACKEND, and
 * `jcode` serves two providers, so it structurally cannot name the right key.
 */
export function specForProvider(
  provider: LlmProvider | undefined,
): ApiKeySpec | undefined {
  const name = apiKeySpecNameForProvider(provider);
  return name ? findSpec(name) : undefined;
}

/**
 * Resolve the credential of the provider a run picked. `''` when there is no
 * provider (stub) or the key is missing — callers gate on
 * {@link findMissingKeysForProvider}, never on this value's emptiness alone.
 */
export function resolveApiKeyForProvider(
  provider: LlmProvider | undefined,
): string {
  const spec = specForProvider(provider);
  return spec ? resolveApiKey(spec) : '';
}

/**
 * Persist `value` for `spec` into the global config file (mode 0600 in a
 * 0700 directory). Subsequent runs on this user/machine will resolve the
 * key without re-prompting.
 */
export function saveApiKey(spec: ApiKeySpec, value: string): void {
  const trimmed = value.trim();
  if (!trimmed) return;
  const store = readConfigStore();
  store[spec.name] = trimmed;
  writeConfigStore(store);
}

/** Read just one key from the global store. Empty string if absent. */
export function loadStoredApiKey(spec: ApiKeySpec): string {
  const store = readConfigStore();
  const v = store[spec.name];
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Path to the global config file. Exposed for help text + tests.
 *
 * `HUU_CONFIG_DIR` (set by the Docker wrapper to the HOST's
 * `$XDG_CONFIG_HOME/huu`, bind-mounted read-write into the container) wins
 * over the local XDG resolution: the container's own $HOME is ephemeral
 * (`/tmp`, wiped by `docker run --rm`), so without the override a key saved
 * from INSIDE the container — web ⚙ Options or the TUI "save key" path —
 * silently vanished on exit and the host kept resolving the stale one.
 */
export function configFilePath(): string {
  const explicit = process.env.HUU_CONFIG_DIR?.trim();
  if (explicit) return join(explicit, 'config.json');
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const dir = xdg ? join(xdg, 'huu') : join(homedir(), '.config', 'huu');
  return join(dir, 'config.json');
}

/**
 * Remove `spec`'s key from the global config store, so resolution falls
 * back to the ambient tiers (env-file / env var). Returns true when a
 * stored value was actually removed. Best-effort like the rest of this
 * module: a missing/corrupt store is just "nothing to clear", never a throw.
 */
export function clearStoredApiKey(spec: ApiKeySpec): boolean {
  const store = readConfigStore();
  if (!(spec.name in store)) return false;
  delete store[spec.name];
  try {
    writeConfigStore(store);
    return true;
  } catch {
    return false;
  }
}

/**
 * Displayable fingerprint of a credential — enough to tell two keys apart
 * (prefix + last 4 chars), never enough to use. Safe for logs and UI status
 * lines. Empty/short input degrades to a fixed mask.
 */
export function maskKey(value: string): string {
  const v = value.trim();
  if (!v) return '(none)';
  if (v.length <= 8) return '••••';
  return `${v.slice(0, 6)}…${v.slice(-4)}`;
}

/**
 * Backwards-compat shim. New code should use
 *   resolveApiKey(findSpec('deepseek')!)
 * but legacy call sites in app.tsx / orchestrator continue to work.
 */
export function resolveDeepSeekApiKey(): string {
  const spec = findSpec('deepseek');
  if (!spec) return '';
  return resolveApiKey(spec);
}

/**
 * Read the whole global config store as a plain object. Missing/corrupt file
 * degrades to `{}` — never throws.
 *
 * Exposed (rather than kept private) because the multi-key POOL schema lives
 * in a sibling module: `api-key-pool.ts` owns the `_pools` sub-object and the
 * `_pools[name].keys[0]` ⇄ `store[name]` compatibility mirror, but this module
 * stays the single owner of the file itself (path resolution, permissions).
 */
export function readConfigStore(): Record<string, unknown> {
  try {
    const raw = readFileSync(configFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Persist the whole global config store (mode 0600 in a 0700 directory).
 * Throws only on real fs failures — callers that must never fail (the key
 * pool) wrap this in their own try/catch.
 */
export function writeConfigStore(store: Record<string, unknown>): void {
  const path = configFilePath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(store, null, 2), { mode: 0o600 });
  // writeFileSync's `mode` is only honored on creation; chmod again so
  // existing files (created with a wider umask earlier) tighten down.
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows / fs without chmod — best effort */
  }
}

function readKeyFile(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    // ENOENT/EACCES/etc. — treat as "not provided" and let the caller
    // fall back. Logging the path here would risk leaking it into
    // .huu/debug-*.log; we deliberately stay silent.
    return '';
  }
}

/**
 * Persistence for huu's FIRST-RUN SETUP choices — the front-end the user wants
 * (`web` | `cli`) and the runtime it should run on (`docker` | `native`).
 *
 * The choices live INSIDE the config store that already exists
 * (`~/.config/huu/config.json`, mode 0600 in a 0700 directory, path resolved by
 * {@link configFilePath}), under a single `_setup` sub-object. Same additive
 * convention `api-key-pool.ts` uses for `_pools`: an `_`-prefixed field can
 * never collide with an `ApiKeySpec.name` (registry names are camelCase), an
 * older huu ignores what it does not know, and — crucially — a machine that
 * already holds API keys keeps them. Every write here goes through
 * {@link readConfigStore} → mutate one field → {@link writeConfigStore}, so the
 * credentials and the `_pools` sub-object survive untouched.
 *
 * ```jsonc
 * {
 *   "deepseek": "sk-ds-…",          // untouched by this module
 *   "_pools":  { … },                 // untouched by this module
 *   "_setup": {
 *     "version": 1,
 *     "interface": "web",
 *     "runtime": "docker",
 *     "completed": true,
 *     "completedAt": "2026-09-05T12:00:00.000Z"
 *   }
 * }
 * ```
 *
 * ## Reading NEVER throws
 *
 * {@link loadSetupConfig} is consulted on the boot path, before anything is on
 * screen. A throw there — invalid JSON, `_setup: null`, `_setup: []`, a field
 * hand-edited to garbage, a config file the process cannot read — would lock
 * the user out of their own application at startup. So every failure degrades
 * to {@link defaultSetupConfig}: sensible defaults, `completed: false`, which
 * simply means "ask again". Being asked once more is a nuisance; a boot crash
 * is a brick.
 *
 * The same rule makes VALIDITY part of completeness: a record is only complete
 * when its `version` is the one we understand, `completed` is literally `true`,
 * and BOTH stored choices are valid literals. A half-written or hand-mangled
 * `_setup` therefore reopens the setup flow instead of silently booting the
 * wrong front-end.
 *
 * Pure + leaf (`src/lib`), no upward imports.
 */

import { configFilePath, readConfigStore, writeConfigStore } from './api-key.js';

/** JSON property inside `config.json` holding the setup record. */
export const SETUP_STORE_FIELD = '_setup';

/**
 * Schema version of the persisted record. A stored record carrying any OTHER
 * version is treated as "not understood" → defaults + `completed: false`, i.e.
 * the setup flow runs again. That refusal IS the v1 migration policy: it costs
 * no code and can never boot a user into a shape we cannot read.
 *
 * READING a record of another version changes nothing on disk — the boot path
 * only reads. But say plainly what happens if the user then FINISHES the
 * reopened flow: {@link saveSetupConfig} replaces the whole `_setup` object, so
 * every field only that other version knew about (a hypothetical v2 `theme`,
 * `webPort`, …) is dropped, and the choices it had stored are already gone from
 * the merge base — `loadSetupConfig` returned the DEFAULTS for it, so an
 * unanswered field lands on `web`/`docker` rather than on what the v2 record
 * said. That is deliberate, not an oversight: carrying fields forward out of a
 * record we have just declared unreadable would write a v1 object decorated
 * with invariants we cannot check, and the flow that re-asks is precisely how
 * the user restates the choices. Sibling top-level fields of `config.json`
 * (API keys, `_pools`, anything unknown) are NEVER touched — only `_setup` is
 * replaced.
 */
export const SETUP_CONFIG_VERSION = 1;

/** The front-end the user picked. `web` is huu's default front-end. */
export type SetupInterface = 'web' | 'cli';

/** How huu executes: inside its container, or straight on the host. */
export type SetupRuntime = 'docker' | 'native';

/** Every accepted {@link SetupInterface}, for UI enumeration + validation. */
export const SETUP_INTERFACES: readonly SetupInterface[] = ['web', 'cli'];

/** Every accepted {@link SetupRuntime}, for UI enumeration + validation. */
export const SETUP_RUNTIMES: readonly SetupRuntime[] = ['docker', 'native'];

/** Default front-end when nothing was chosen yet — matches huu's own default. */
export const DEFAULT_SETUP_INTERFACE: SetupInterface = 'web';

/** Default runtime when nothing was chosen yet — huu is docker-first. */
export const DEFAULT_SETUP_RUNTIME: SetupRuntime = 'docker';

/**
 * The setup choices, always fully populated. `interface`/`runtime` are never
 * undefined so callers can read them without a null check; `completed` is the
 * flag that says whether they are the USER's choices or just the defaults.
 */
export interface SetupConfig {
  /** Schema version of the record this view came from (or the current one). */
  version: number;
  /** Front-end to launch. Defaults to {@link DEFAULT_SETUP_INTERFACE}. */
  interface: SetupInterface;
  /** Runtime to launch on. Defaults to {@link DEFAULT_SETUP_RUNTIME}. */
  runtime: SetupRuntime;
  /**
   * True ONLY when a valid, fully-formed record was read back from disk.
   * `false` means "first run, or the stored record is unusable" — ask again.
   */
  completed: boolean;
  /** ISO timestamp of the write that last confirmed the setup, when known. */
  completedAt?: string;
}

/** Partial update applied over the current on-disk view by {@link saveSetupConfig}. */
export interface SetupConfigInput {
  interface?: SetupInterface;
  runtime?: SetupRuntime;
  /** Defaults to `true` — saving the pair is what "the user chose" means. */
  completed?: boolean;
}

/** True when `value` is one of the accepted front-ends. */
export function isSetupInterface(value: unknown): value is SetupInterface {
  return typeof value === 'string' && (SETUP_INTERFACES as readonly string[]).includes(value);
}

/** True when `value` is one of the accepted runtimes. */
export function isSetupRuntime(value: unknown): value is SetupRuntime {
  return typeof value === 'string' && (SETUP_RUNTIMES as readonly string[]).includes(value);
}

/**
 * The view a machine with no setup record gets: huu's own defaults, explicitly
 * marked as NOT chosen by anyone. Returned fresh each call — callers may mutate
 * their copy without poisoning the next reader.
 */
export function defaultSetupConfig(): SetupConfig {
  return {
    version: SETUP_CONFIG_VERSION,
    interface: DEFAULT_SETUP_INTERFACE,
    runtime: DEFAULT_SETUP_RUNTIME,
    completed: false,
  };
}

/**
 * Path of the file the setup record lives in — the SAME `config.json` that
 * holds the API keys. Exposed for help text, diagnostics and tests; there is
 * deliberately no second config file to keep in sync.
 */
export function setupConfigPath(): string {
  return configFilePath();
}

/**
 * Read the setup choices. NEVER throws: a missing file, invalid JSON, a
 * `_setup` that is `null`/an array/a string, an unknown `version` or a field of
 * the wrong type all degrade to {@link defaultSetupConfig}.
 */
export function loadSetupConfig(): SetupConfig {
  const fallback = defaultSetupConfig();
  let raw: unknown;
  try {
    // readConfigStore already swallows fs/JSON errors, but it is not this
    // module's invariant — wrap it so a future change there cannot leak a
    // throw onto the boot path.
    raw = readConfigStore()[SETUP_STORE_FIELD];
  } catch {
    return fallback;
  }

  // `typeof null === 'object'` and arrays are objects too; both are garbage here.
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fallback;

  const record = raw as Record<string, unknown>;
  if (record.version !== SETUP_CONFIG_VERSION) return fallback;
  if (!isSetupInterface(record.interface) || !isSetupRuntime(record.runtime)) return fallback;
  if (record.completed !== true) {
    // Valid choices, but the flow never confirmed them: surface the choices as
    // the pre-selected defaults and still ask.
    return {
      version: SETUP_CONFIG_VERSION,
      interface: record.interface,
      runtime: record.runtime,
      completed: false,
    };
  }

  const config: SetupConfig = {
    version: SETUP_CONFIG_VERSION,
    interface: record.interface,
    runtime: record.runtime,
    completed: true,
  };
  if (typeof record.completedAt === 'string' && record.completedAt.trim())
    config.completedAt = record.completedAt;
  return config;
}

/**
 * THE question `npm start` asks: may huu skip the first-run flow?
 *
 * Pass an already-loaded config to avoid a second disk read; otherwise it
 * loads one. Never throws.
 */
export function isSetupComplete(config: SetupConfig = loadSetupConfig()): boolean {
  return (
    config.completed === true &&
    config.version === SETUP_CONFIG_VERSION &&
    isSetupInterface(config.interface) &&
    isSetupRuntime(config.runtime)
  );
}

/**
 * Persist the setup choices, MERGED over the CURRENT VIEW of the stored record
 * ({@link loadSetupConfig}), and leave every other field of `config.json` (API
 * keys, `_pools`, unknown fields) untouched.
 *
 * "Merged over the view" is the precise claim, and it has two consequences
 * worth stating instead of leaving to the reader:
 *   - `_setup` itself is REPLACED wholesale, not deep-merged. Fields inside it
 *     that this version does not know (a future v2's `theme`, `webPort`, …) do
 *     not survive the write.
 *   - the merge base is what `loadSetupConfig` could VALIDATE, so a stored
 *     record with an unknown `version` contributes nothing and an unanswered
 *     `interface`/`runtime` falls back to `web`/`docker`.
 * See {@link SETUP_CONFIG_VERSION} for why that is the chosen policy.
 *
 * `completed` defaults to `true`: calling this is what "the user chose" means.
 * Pass `completed: false` to stage a partial choice without ending the flow.
 * A write that ends complete stamps `completedAt` with the current time — it
 * reads as "last confirmed", which is the useful fact.
 *
 * Best-effort like the rest of this layer: returns `false` on a real fs
 * failure instead of throwing (mirrors `saveWebSettings`). The 0600/0700
 * permissions come from {@link writeConfigStore} and are not relaxed here.
 */
export function saveSetupConfig(input: SetupConfigInput): boolean {
  const current = loadSetupConfig();
  const next: SetupConfig = {
    version: SETUP_CONFIG_VERSION,
    interface: isSetupInterface(input.interface) ? input.interface : current.interface,
    runtime: isSetupRuntime(input.runtime) ? input.runtime : current.runtime,
    completed: input.completed ?? true,
  };
  if (next.completed) next.completedAt = new Date().toISOString();

  try {
    const store = readConfigStore();
    store[SETUP_STORE_FIELD] = next;
    writeConfigStore(store);
    return true;
  } catch {
    return false;
  }
}

/**
 * Convenience for the end of the setup flow: record BOTH choices and mark the
 * setup done in one write.
 */
export function markSetupComplete(
  ui: SetupInterface,
  runtime: SetupRuntime,
): boolean {
  return saveSetupConfig({ interface: ui, runtime, completed: true });
}

/**
 * Forget the setup choices so the flow runs again (`huu setup`). Removes ONLY
 * `_setup`; API keys and `_pools` stay exactly where they are.
 *
 * Returns true when a record was actually removed and the file rewritten;
 * false when there was nothing to clear or the write failed. Never throws.
 */
export function clearSetupConfig(): boolean {
  let store: Record<string, unknown>;
  try {
    store = readConfigStore();
  } catch {
    return false;
  }
  if (!(SETUP_STORE_FIELD in store)) return false;
  delete store[SETUP_STORE_FIELD];
  try {
    writeConfigStore(store);
    return true;
  } catch {
    return false;
  }
}

/**
 * Per-role model routing for the `/dev` launch form — the PURE half.
 *
 * The role list and the preset table are NOT defined here: they arrive from
 * `/api/bootstrap` as `devModelRoles` / `devModelPresets`, which are the very
 * `DEV_MODEL_ROLES` / `DEV_MODEL_PRESETS` the compiler and the CLI read. One
 * source of truth — a preset retuned server-side needs no client edit, and the
 * client can never disagree with what actually runs.
 *
 * The only decision made here is what the POST body should carry, and it is
 * deliberately unambiguous — exactly ONE of the two fields, never both:
 *
 *   - untouched, recognized preset → `{ modelsPreset }`, and the SERVER expands
 *     the table (so the ids the run uses are the ones the server knows);
 *   - anything typed by hand      → `{ models }`, the explicit role→id map;
 *   - nothing pinned at all       → `{}` — a body byte-identical to today's,
 *     which is what keeps opening /dev and pressing Start from silently
 *     re-routing a run that works fine.
 *
 * No DOM access at import or call time — `dev-models.test.js` runs it in Node.
 */

/* ── Which presets the ACTIVE PROVIDER can actually run ────────────────────
   `/dev` makes routing a REQUIRED decision: the form opens with a preset
   already selected. That is only honest if the selected preset can RUN — and
   most of them cannot, on most providers: `hetero`, `thrifty` and `monoculture`
   route the planner (and usually the critic) to ids only openrouter.ai serves,
   `roster` routes three roles there, and `AppConfig.provider` is ONE provider
   for the whole session. On a machine with only a DeepSeek key that made the
   DEFAULT path a 400 from `checkDevModelPolicy`, with nothing on screen to
   explain it.

   The verdict is NOT recomputed here. `/api/bootstrap` ships
   `devModelPresetProviders`, produced by the same `checkDevModelPolicy` that
   refuses the POST, so the form and the border can never give two answers. A
   server that doesn't advertise it (an older build) answers "runnable" for
   everything and the worst case is the 400 that already existed — degrading
   toward the server's authority, never around it. */

/**
 * Can `preset` run on `provider`?
 * @param {Record<string, string[]> | null | undefined} table preset → provider ids
 * @param {string} preset
 * @param {string} [provider] the active provider id
 */
export function presetRunnable(table, preset, provider) {
  if (!table || typeof table !== 'object' || !provider) return true;
  const list = table[preset];
  if (!Array.isArray(list)) return true;
  return list.includes(provider);
}

/**
 * The preset the form should OPEN on for `provider` — the recommended split
 * when the provider can serve it, otherwise the best one it CAN serve.
 *
 * Falls back to the raw list when nothing is runnable (a provider huu has no
 * preset for): the server refuses the impossible body either way, and offering
 * an empty selector would be worse than offering a refused one.
 * @param {Record<string, string[]> | null | undefined} table
 * @param {string[]} names preset names, in the server's order
 * @param {string} [provider]
 */
export function defaultPreset(table, names, provider) {
  const list = Array.isArray(names) ? names.filter((n) => typeof n === 'string') : [];
  if (!list.length) return 'hetero';
  const runnable = list.filter((n) => presetRunnable(table, n, provider));
  const pool = runnable.length ? runnable : list;
  return pool.includes('hetero') ? 'hetero' : pool[0];
}

/** The role→id object a preset prescribes; `{}` for an unknown/absent preset. */
export function presetPolicy(presets, preset) {
  if (!presets || typeof presets !== 'object') return {};
  const policy = presets[preset];
  return policy && typeof policy === 'object' && !Array.isArray(policy) ? policy : {};
}

/**
 * Field values for a preset: every role gets an entry, `''` where the preset
 * pins nothing (that role falls back to the form's own model id).
 */
export function presetValues(roles, presets, preset) {
  const policy = presetPolicy(presets, preset);
  /** @type {Record<string, string>} */
  const values = {};
  for (const role of roles || []) {
    values[role] = typeof policy[role] === 'string' ? policy[role] : '';
  }
  return values;
}

/** True when the typed values still say exactly what `preset` prescribes. */
export function matchesPreset(roles, presets, preset, values) {
  const want = presetValues(roles, presets, preset);
  for (const role of roles || []) {
    const a = (want[role] || '').trim();
    const b = ((values && values[role]) || '').trim();
    if (a !== b) return false;
  }
  return true;
}

/**
 * The `models` / `modelsPreset` half of `POST /api/dev`. Both fields are
 * optional in the contract; this returns at most one of them, and `{}` when
 * nothing is pinned.
 * @param {object} [fields]
 * @param {string[]} [fields.roles] role names from devModelRoles
 * @param {Record<string, Record<string, string>>} [fields.presets] preset → role → model id
 * @param {string} [fields.preset] selected preset name
 * @param {Record<string, string>} [fields.values] role → hand-typed model id
 */
export function buildDevModelsPayload({ roles, presets, preset, values } = {}) {
  const list = Array.isArray(roles) ? roles : [];
  const pinned = {};
  for (const role of list) {
    const value = ((values && values[role]) || '').trim();
    if (value) pinned[role] = value;
  }
  const known = !!presets && typeof presets === 'object'
    && Object.prototype.hasOwnProperty.call(presets, preset);
  // An empty pin set means every role inherits the single fallback id —
  // `uniform`, and the pre-routing body. Naming a preset there would be a lie
  // the server would have to undo.
  if (!Object.keys(pinned).length) return {};
  if (known && matchesPreset(list, presets, preset, values)) return { modelsPreset: preset };
  return { models: pinned };
}

/**
 * The fallback id the POST still has to carry (`modelId` is REQUIRED by the
 * contract) derived from the role fields themselves — `worker` first because it
 * is the role that does most of the work, then `planner`, then whatever else is
 * pinned. `''` when the panel pins nothing at all; the caller supplies the
 * catalog default then.
 *
 * Pure and here rather than in `dev.js` so the exact id the form would send is
 * assertable without a DOM — the default `/dev` path is proved end to end by
 * assembling this body and posting it at a real server.
 * @param {string[]} [roles]
 * @param {Record<string, string>} [values]
 */
export function fallbackModelIdFrom(roles, values) {
  const pick = (role) => (((values || {})[role]) || '').trim();
  return pick('worker') || pick('planner') || (roles || []).map(pick).find(Boolean) || '';
}

/** One-line description of what {@link buildDevModelsPayload} will send. */
export function describeDevModelsPayload(payload) {
  if (!payload) return '';
  if (payload.modelsPreset) return `preset “${payload.modelsPreset}”`;
  if (payload.models) {
    const n = Object.keys(payload.models).length;
    return `${n} role${n === 1 ? '' : 's'} pinned by hand`;
  }
  return 'every role on the same model';
}

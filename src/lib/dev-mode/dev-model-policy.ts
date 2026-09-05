/**
 * Per-role model routing for dev mode — pure, no I/O, no fs, no env.
 *
 * The whole point of this module is that it adds NOTHING implicitly. A role
 * left unset resolves to the caller's fallback (`AppConfig.modelId`), which is
 * exactly what every dev-mode step gets today, so a session that never asks
 * for routing compiles the pipeline it compiles today — byte for byte. The
 * defaults live at the SURFACES (CLI flag, web option), never in the driver:
 * that is what makes heterogeneous routing an opt-in instead of a rewrite of
 * everyone's runs.
 *
 * Consumes the contract from `../types.js` ({@link DevModelRole},
 * {@link DevModelRoute}, {@link DevModelPolicy}, {@link DEV_MODEL_PRESETS}) —
 * it does not redefine it.
 *
 * A role's value is a PAIR (model, provider), not an id. `AppConfig.provider`
 * is one provider for the whole run, so without the second half a roster that
 * mixes vendors is inexpressible: the ids simply travel to whichever endpoint
 * the run happens to be on and die inside the first agent. The provider half is
 * also what makes the MODEL PREFLIGHT possible again — see
 * {@link checkDevModelPolicy} for the one rule it follows.
 *
 * A note on the economics, because it reads backwards: splitting roles across
 * models is not a cost optimization (a fan-out costs several times a single
 * agent while the price gap between these models is ~2×). The justification is
 * context isolation, parallelism, and for `critic` specifically a second
 * opinion from another vendor.
 */

import { PROVIDERS, parseProvider, providerInfo, type LlmProvider } from '../providers.js';
import {
  DEV_MODEL_PRESETS,
  type AgentBackendKind,
  type DevModelPolicy,
  type DevModelPolicyInput,
  type DevModelPreset,
  type DevModelRole,
  type DevModelRoute,
  type DevModelRouteInput,
} from '../types.js';

/**
 * Exhaustiveness lock: adding a role to {@link DevModelRole} fails compilation
 * HERE until it is listed, so {@link DEV_MODEL_ROLES} can never silently miss
 * a role and leave it unresolved.
 */
const ALL_ROLES: Record<DevModelRole, true> = {
  planner: true,
  recon: true,
  worker: true,
  critic: true,
  reporter: true,
  judge: true,
  integration: true,
};

/** Every role, in declaration order. */
export const DEV_MODEL_ROLES: readonly DevModelRole[] = Object.keys(ALL_ROLES) as DevModelRole[];

/**
 * A model id, normalized for LOOKUP only (trim + lowercase). Never written
 * back out — the id that reaches a provider is the one the user wrote, because
 * an endpoint that is case-sensitive must be allowed to say so.
 */
function lookupKey(id: string): string {
  return id.trim().toLowerCase();
}

/** The shape {@link buildModelProviderIndex} needs. `ModelEntry` satisfies it. */
export interface ModelCatalogEntry {
  id: string;
  /**
   * Which endpoint serves this id. What an ABSENT field means is decided by the
   * caller, not by this type — see {@link BuildModelProviderIndexOptions}.
   */
  provider?: LlmProvider;
}

/** How to read an entry that names no provider. */
export interface BuildModelProviderIndexOptions {
  /**
   * Provider assumed for an entry with NO `provider` field.
   *
   * `'deepseek'` (the default) is the back-compat rule `src/models/catalog.ts`
   * applies to huu's OWN shipped catalog, written before the field existed —
   * and it is pinned by tests.
   *
   * `null` means "I do not know", and it is the correct reading for any catalog
   * huu did not write. An entry there is a claim that the id EXISTS, never a
   * claim about which endpoint serves it, so inventing `deepseek` would
   * manufacture the one thing {@link checkDevModelPolicy} refuses on: positive
   * evidence of a contradiction. See `model-catalog-index.ts` for the
   * monotonicity this preserves.
   */
  defaultProvider?: LlmProvider | null;
}

/** model id → the providers whose endpoint serves it. */
export type ModelProviderIndex = ReadonlyMap<string, ReadonlySet<LlmProvider>>;

/**
 * Turn catalog entries into "who serves this id".
 *
 * THE POINT: the catalog already answers the question the model preflight used
 * to answer, and it answers it per PROVIDER — an id appears once per endpoint
 * that serves it (`deepseek/deepseek-v4-pro` is listed twice, under `deepseek`
 * and under `openrouter`), so the value is a SET, never one provider. That is
 * why this cannot be a hard-coded vendor→provider table: `deepseek/…` is not
 * "the DeepSeek provider's", it is served by both.
 *
 * Pure and injected rather than importing `src/models/catalog.ts`: that module
 * sits ABOVE `lib/` (it imports from it), and a policy resolver that reads the
 * filesystem is a policy resolver nobody can unit-test.
 */
export function buildModelProviderIndex(
  entries: readonly ModelCatalogEntry[],
  options: BuildModelProviderIndexOptions = {},
): ModelProviderIndex {
  const fallback = options.defaultProvider === undefined ? 'deepseek' : options.defaultProvider;
  const index = new Map<string, Set<LlmProvider>>();
  for (const entry of entries) {
    const key = lookupKey(entry.id ?? '');
    if (!key) continue;
    const provider = entry.provider ?? fallback;
    // `null` fallback ⇒ the entry contributes NOTHING. Not even an empty set:
    // `providersForModel` reads a missing key and an empty set identically
    // ("no evidence"), and materializing the key would only invite a future
    // reader to treat "listed, served by nobody" as a refusal.
    if (!provider) continue;
    const set = index.get(key) ?? new Set<LlmProvider>();
    set.add(provider);
    index.set(key, set);
  }
  return index;
}

/**
 * Union of several indexes — the ONE operation the catalog merge is allowed to
 * perform.
 *
 * Union and never override, because {@link checkDevModelPolicy} refuses on
 * positive evidence: growing an id's provider set can only turn a refusal into
 * a pass, never the reverse. That is the property that makes reading a second
 * catalog safe, and it holds only as long as every contributor states a
 * provider it actually read (see {@link BuildModelProviderIndexOptions}).
 */
export function unionModelProviderIndexes(
  ...indexes: readonly ModelProviderIndex[]
): ModelProviderIndex {
  const out = new Map<string, Set<LlmProvider>>();
  for (const index of indexes) {
    for (const [key, providers] of index) {
      const set = out.get(key) ?? new Set<LlmProvider>();
      for (const provider of providers) set.add(provider);
      out.set(key, set);
    }
  }
  return out;
}

/** An index that knows nothing — every id is "no evidence either way". */
export const EMPTY_MODEL_PROVIDER_INDEX: ModelProviderIndex = new Map();

/**
 * Which providers can serve `id`, most authoritative source first.
 *
 *   1. the route's OWN declared provider — the user (or the preset) said so;
 *   2. the catalog index;
 *   3. nothing — an EMPTY set, which means "no evidence", NOT "nobody".
 *
 * The empty case is the one that must not be confused with a refusal: the
 * shipped catalog is a hand-maintained recommendation list, DeepSeek publishes
 * no models endpoint and OpenRouter's live catalog was removed in v3.0, so huu
 * genuinely cannot enumerate every id a provider serves.
 */
export function providersForModel(
  id: string,
  index: ModelProviderIndex,
  declared?: LlmProvider,
): ReadonlySet<LlmProvider> {
  if (declared) return new Set([declared]);
  return index.get(lookupKey(id)) ?? new Set<LlmProvider>();
}

/**
 * Predicate for rung selection: is this rung NOT positively contradicted for
 * the run we are about to start?
 *
 * Reads as "not known to be wrong", deliberately, not as "known to be right".
 * An id absent from the catalog answers TRUE, so a chain whose first rung is a
 * model released after this catalog shipped keeps the order the user wrote.
 * Only a rung the catalog positively places on ANOTHER endpoint is skipped —
 * which is the same evidence bar {@link checkDevModelPolicy} refuses on.
 */
export type ModelKnownPredicate = (id: string, declared?: LlmProvider) => boolean;

export function modelKnownFor(
  index: ModelProviderIndex,
  runProvider: LlmProvider | undefined,
): ModelKnownPredicate {
  return (id, declared) => {
    const effective = declared ?? runProvider;
    // No provider at all (`stub`) ⇒ nothing will be called, so nothing can be
    // wrong. Returning false here would make every chain skip to its last rung
    // in a smoke run.
    if (!effective) return true;
    const serves = providersForModel(id, index, declared);
    if (serves.size === 0) return true;
    return serves.has(effective);
  };
}

/**
 * Read ONE role's value from any surface into a route.
 *
 * Three accepted forms, and the first two are what makes this back-compatible:
 *   · `"vendor/model"`                  — a bare id; provider inherited.
 *   · `"openrouter:vendor/model"`       — an id with the endpoint that serves it.
 *   · `{ model, provider? }`            — the structured form.
 *
 * The prefix is unambiguous against OpenRouter's own `:free` / `:nitro` /
 * `:thinking` suffixes because it is only read when the segment BEFORE the
 * first colon parses as a provider name AND contains no `/` — and every model
 * id carries its vendor before the slash, never before a colon
 * (`deepseek/deepseek-r1:free` splits at `deepseek/deepseek-r1`, which has a
 * slash, so the colon is left alone).
 *
 * Returns `undefined` for anything that does not name a model, so a malformed
 * value degrades to "no routing for that role" instead of throwing — this is
 * on the path of an untrusted POST body.
 */
export function parseModelRoute(raw: unknown): DevModelRoute | undefined {
  if (typeof raw === 'string') return parseRouteString(raw);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  if (typeof source.model !== 'string') return undefined;
  const parsed = parseRouteString(source.model);
  if (!parsed) return undefined;
  // An explicit `provider` field outranks a prefix inside `model`; an
  // unrecognized one is DROPPED rather than refused, same as every other
  // malformed field on this path.
  const explicit = typeof source.provider === 'string' ? parseProvider(source.provider) : null;
  if (explicit) return { model: parsed.model, provider: explicit };
  return parsed;
}

/**
 * Read ONE rung — a value with no commas in it — into its id and the provider
 * that rung itself declared.
 *
 * `undefined` means the rung names NO MODEL, and there is exactly one way to
 * write that: an empty tail (`"openrouter:"`). It used to fall through and
 * become the literal model id `"openrouter:"`, which then travelled to a
 * provider verbatim; a prefix with nothing after it is a typo, and the honest
 * answer is "this names no model" — the CLI turns that into a usage error and
 * the POST parser drops the role.
 */
function parseRung(raw: string): DevModelRoute | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  const colon = value.indexOf(':');
  if (colon > 0) {
    const head = value.slice(0, colon);
    if (!head.includes('/')) {
      const provider = parseProvider(head);
      if (provider) {
        const rest = value.slice(colon + 1).trim();
        if (!rest) return undefined;
        return { model: rest, provider };
      }
    }
  }
  return { model: value };
}

/**
 * Read a whole value — one rung or a comma-separated CHAIN — into a route.
 *
 * THE RULE THAT MATTERS: the `<provider>:` prefix belongs to the RUNG it is
 * written on, never to the value as a whole. Reading it off the head of the
 * entire string (which is what this did) made the prefix of any rung past the
 * first unreadable: `"z-ai/glm-5.2, openrouter:moonshotai/kimi-k2.6"` picked
 * the second rung and stamped the id `"openrouter:moonshotai/kimi-k2.6"` —
 * prefix included — onto a step, which then reached the endpoint verbatim.
 *
 * So a chain keeps every rung's prefix INLINE and {@link pickModelRoute} reads
 * them one rung at a time. Only a single-rung value hoists its prefix to the
 * route, which is what keeps the overwhelmingly common case shaped exactly as
 * it always was. A route-level `provider` (the object form) still applies as
 * the DEFAULT for rungs that declare none.
 *
 * One unreadable rung poisons the whole value: a chain is an ordered promise,
 * and silently dropping a rung would change which model runs.
 */
function parseRouteString(raw: string): DevModelRoute | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  const rungs = modelRungs(value);
  if (rungs.length === 0) return undefined;
  const parsed: DevModelRoute[] = [];
  for (const rung of rungs) {
    const one = parseRung(rung);
    if (!one) return undefined;
    parsed.push(one);
  }
  const first = parsed[0]!;
  if (parsed.length === 1) return first;
  return { model: parsed.map(formatModelRoute).join(', ') };
}

/** Render a route back into the `<provider>:<id>` string form. Round-trips. */
export function formatModelRoute(route: DevModelRoute): string {
  return route.provider ? `${route.provider}:${route.model}` : route.model;
}

/**
 * Normalize a loose policy (strings and/or routes) into routes. Roles whose
 * value names no model are DROPPED, so "unset" survives normalization — that
 * is the contract the whole routing feature rests on.
 */
export function normalizeDevModelPolicy(
  input: DevModelPolicyInput | undefined,
): DevModelPolicy | undefined {
  if (!input) return undefined;
  const out: DevModelPolicy = {};
  for (const role of DEV_MODEL_ROLES) {
    const route = parseModelRoute(input[role] as DevModelRouteInput | undefined);
    if (route) out[role] = route;
  }
  return out;
}

/**
 * Split a policy value into its ordered fallback RUNGS.
 *
 * A role's value may name one model (`"deepseek/v4-pro"`) or an ordered chain
 * (`"deepseek/v4-pro, z-ai/glm-5.2"`). One id is the overwhelmingly common
 * case and stays exactly what it was; a chain says "use the first of these the
 * registry actually has".
 *
 * WHY A CHAIN AT ALL. A role was one id, and an id the registry has never
 * heard of throws inside the first agent — after its worktree and branch
 * already exist. Model preflight moved that failure to the border,
 * which is better, but the answer was still "refuse the session". A provider
 * dropping a model, or a registry lagging a rename, should cost a rung, not a
 * run.
 *
 * Commas are the separator because the same rule then works for a CLI flag, a
 * web text field and a JSON string with no per-surface parsing. No id in the
 * model registry contains a comma (`vendor/model[:variant]`), so nothing
 * is ambiguous — and an id that somehow did would split into rungs that simply
 * fail the preflight, loudly, rather than misbehaving quietly.
 */
export function modelRungs(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((rung) => rung.trim())
    .filter((rung) => rung.length > 0);
}

/**
 * Collapse a chain to the rung that will actually run.
 *
 * `isKnown` is injected rather than imported so this module stays pure — the
 * catalog lives above `lib/` in `src/models/catalog.ts`, and a policy resolver
 * that reads the filesystem is a policy resolver nobody can unit-test. Build
 * the predicate with {@link modelKnownFor}. With no predicate the first rung
 * wins, which is the pre-chain behavior exactly.
 *
 * `declared` is the route's own provider, passed through so a chain is judged
 * against the endpoint that role will actually reach — not against the run's.
 */
export function pickModelRung(
  value: string | undefined,
  isKnown?: ModelKnownPredicate,
  declared?: LlmProvider,
): string | undefined {
  if (!value) return undefined;
  return pickModelRoute(declared ? { model: value, provider: declared } : { model: value }, isKnown)
    ?.model;
}

/**
 * Collapse a ROUTE's chain, keeping its provider. `undefined` in, `undefined`
 * out — an unset role must stay unset all the way to the compiler.
 */
export function pickModelRoute(
  route: DevModelRoute | undefined,
  isKnown?: ModelKnownPredicate,
): DevModelRoute | undefined {
  if (!route) return undefined;
  // Per RUNG, because that is where a `<provider>:` prefix is written — see
  // `parseRouteString`. The route's own provider is only the DEFAULT for rungs
  // that declare none, so a chain is judged (and stamped) against the endpoint
  // each rung actually names.
  const rungs: DevModelRoute[] = [];
  for (const raw of modelRungs(route.model)) {
    const one = parseRung(raw);
    if (!one) continue;
    const provider = one.provider ?? route.provider;
    rungs.push(provider ? { model: one.model, provider } : { model: one.model });
  }
  if (rungs.length === 0) return undefined;
  const picked = (isKnown && rungs.find((r) => isKnown(r.model, r.provider))) || rungs[0]!;
  return picked;
}

/**
 * Role → the model id that role must actually run on.
 *
 * Deliberately a plain `??`-style resolution with NO hidden defaulting: an
 * absent policy — or any role missing from it, or set to whitespace — falls
 * back to `fallbackModelId`. Callers that want the opinionated routing ask for
 * it explicitly via {@link defaultDevModelPolicy}.
 *
 * Returns bare ids, not routes, because that is what every consumer needs: the
 * compiler stamps `WorkStep.modelId`, the driver passes `models.planner` to the
 * chat client, and the web snapshot renders `role → id` chips. The provider
 * half is enforced by {@link checkDevModelPolicy} at the border, where a
 * mismatch can still be refused.
 *
 * The compiler stamps the result onto `WorkStep.modelId` / `CheckStep.modelId`
 * / `ReviewSpec.modelId` / `Pipeline.integrationModelId` ONLY where a policy
 * actually named a model — a resolved-to-fallback role must keep omitting the
 * field, so the orchestrator's own fallback stays the one authority.
 */
export function resolveDevModels(
  policy: DevModelPolicy | undefined,
  fallbackModelId: string,
  isKnown?: ModelKnownPredicate,
): Record<DevModelRole, string> {
  const resolved = {} as Record<DevModelRole, string>;
  for (const role of DEV_MODEL_ROLES) {
    resolved[role] = pickModelRoute(policy?.[role], isKnown)?.model.trim() || fallbackModelId;
  }
  return resolved;
}

/**
 * The policy the COMPILER should stamp: every role collapsed to its surviving
 * rung, roles the policy never named still absent.
 *
 * Absent-stays-absent is the whole contract of the routing feature — a role the
 * policy does not name must keep OMITTING `modelId` so `AppConfig.modelId`
 * stays the single authority — so this cannot simply reuse
 * {@link resolveDevModels}, which fills every role with the fallback.
 */
export function collapseDevModelPolicy(
  policy: DevModelPolicy | undefined,
  isKnown?: ModelKnownPredicate,
): DevModelPolicy | undefined {
  if (!policy) return undefined;
  const out: DevModelPolicy = {};
  for (const role of DEV_MODEL_ROLES) {
    const picked = pickModelRoute(policy[role], isKnown);
    if (picked && picked.model.trim()) out[role] = { ...picked, model: picked.model.trim() };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The policy a surface should offer for `backend`, defaulting to the `hetero`
 * preset.
 *
 * Returns `{}` for `stub`: the stub backend calls no provider at all, so
 * stamping preset ids onto it would break a run that works fine today.
 *
 * The preset table is written in the loose {@link DevModelPolicyInput} form —
 * a flat `role → string` map, because that is the shape `/api/bootstrap` hands
 * the browser and the shape the browser posts back. Normalizing it here is what
 * lets a preset name an endpoint (`"openrouter:z-ai/glm-5.2"`) without the
 * client having to learn a nested object.
 *
 * The returned routes are FRESH objects, one level deeper than the old shallow
 * spread: a policy value is an object now, so a shallow copy would hand the
 * caller the preset's own route and let `policy.critic.model = …` rewrite the
 * shipped table for the rest of the process.
 */
export function defaultDevModelPolicy(
  backend: AgentBackendKind,
  preset: DevModelPreset = 'hetero',
): DevModelPolicy {
  if (backend !== 'jcode') return {};
  return normalizeDevModelPolicy(DEV_MODEL_PRESETS[preset]) ?? {};
}

/**
 * Defensive parse of an untrusted policy — it arrives in a POST body.
 *
 * Keeps only known roles carrying a value {@link parseModelRoute} can read
 * (a non-empty string, optionally `<provider>:`-prefixed, or a `{model,
 * provider?}` object); drops anything else (unknown role, number, null, an
 * object with no `model`, empty string) WITHOUT throwing, because a malformed
 * field must degrade to "no routing for that role" rather than refuse the run.
 * Iterating over the known roles instead of the input's own keys also makes
 * `__proto__`-style keys structurally unreachable.
 */
export function parseDevModelPolicy(raw: unknown): DevModelPolicy {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const policy: DevModelPolicy = {};
  for (const role of DEV_MODEL_ROLES) {
    const route = parseModelRoute(source[role]);
    if (route) policy[role] = route;
  }
  return policy;
}

/** One thing wrong with a routing decision, in a shape a surface can print. */
export interface DevModelIssue {
  role: DevModelRole;
  /** The rung that will actually be used — never the whole chain. */
  modelId: string;
  /**
   * `refuse` — huu has POSITIVE evidence the run's provider does not serve
   * this id (the route declared another provider, or the catalog places the id
   * on other endpoints only). Nothing can make that call succeed, so a session
   * must not open.
   *
   * `warn` — huu has NO evidence either way: the id is absent from the catalog.
   * The catalog is a hand-maintained recommendation list, not a registry, so
   * refusing here would refuse every model newer than the shipped file.
   */
  severity: 'refuse' | 'warn';
  /** Providers that COULD serve it. Empty ⇒ unknown to the catalog. */
  servedBy: LlmProvider[];
  /** Human-readable, already actionable. */
  message: string;
}

/**
 * The model preflight, restored — and now possible, because the catalog is the
 * registry that went missing when `model-registry-check.ts` was deleted.
 *
 * THE RULE, one sentence: refuse on positive contradiction, warn on absence of
 * evidence. Everything else follows from it.
 *
 *   · A role whose id is served ONLY by providers this run is not on is a
 *     REFUSAL. This is the `hetero`-on-DeepSeek bug: `z-ai/glm-5.2` reaching
 *     api.deepseek.com cannot work, and today it does not fail until the first
 *     agent has already been spawned inside a fresh worktree on a fresh branch.
 *   · A role whose id no catalog entry mentions is a WARNING. huu cannot
 *     enumerate what an endpoint serves (DeepSeek publishes no models endpoint;
 *     OpenRouter's live catalog was removed in v3.0), so "not in the shipped
 *     JSON" is not evidence of absence — and hard-refusing it would make huu
 *     unusable with any model released after its own catalog.
 *   · No provider at all (`stub`) ⇒ NO issues. Nothing is called, so nothing
 *     can be misrouted.
 *
 * The chain is collapsed first, so the id named in a refusal is the rung that
 * would actually have run — never a rung the fallback already skipped past.
 */
export function checkDevModelPolicy(args: {
  policy: DevModelPolicy | undefined;
  /** The provider this run will spend on — `resolveRunProvider(backend, chosen)`. */
  provider: LlmProvider | undefined;
  index: ModelProviderIndex;
}): DevModelIssue[] {
  const { policy, provider, index } = args;
  if (!policy || !provider) return [];
  const isKnown = modelKnownFor(index, provider);
  const issues: DevModelIssue[] = [];
  for (const role of DEV_MODEL_ROLES) {
    const route = pickModelRoute(policy[role], isKnown);
    const modelId = route?.model.trim();
    if (!route || !modelId) continue;
    const serves = providersForModel(modelId, index, route.provider);
    if (serves.has(provider)) continue;
    const servedBy = [...serves];
    if (servedBy.length === 0) {
      issues.push({
        role,
        modelId,
        severity: 'warn',
        servedBy,
        message:
          `${role} → "${modelId}": no catalog entry names this id, so huu cannot confirm ` +
          `${providerInfo(provider).label} serves it. Running anyway — the id is checked for real ` +
          'by the first agent that uses it. Add it to recommended-models.json to silence this.',
      });
      continue;
    }
    issues.push({
      role,
      modelId,
      severity: 'refuse',
      servedBy,
      message:
        `${role} → "${modelId}" is served by ${servedBy.join(', ')}, and this run is on ` +
        `${provider}. ${providerInfo(provider).label} would answer "model not found" — inside ` +
        `the first agent, after its worktree and branch already exist. Fix it with ` +
        `--provider=${servedBy[0]} (key: ${providerInfo(servedBy[0]!).keysUrl}), or route ${role} ` +
        'to an id this provider serves.',
    });
  }
  return issues;
}

/** The refusals only — `checkDevModelPolicy`'s verdict for "may this start?". */
export function devModelRefusals(issues: readonly DevModelIssue[]): DevModelIssue[] {
  return issues.filter((i) => i.severity === 'refuse');
}

/** One printable block for a set of issues. Empty string when there are none. */
export function formatDevModelIssues(issues: readonly DevModelIssue[]): string {
  return issues.map((i) => `  ${i.message}`).join('\n');
}

/**
 * Which providers can run each shipped preset, whole.
 *
 * WHY THIS EXISTS, and it is not a convenience. `/dev` makes routing a REQUIRED
 * decision — the form opens with a preset already selected — so a preset the
 * active provider cannot serve is not an opt-in mistake the user made, it is
 * the default path. Before this, opening `/dev` with only a DeepSeek key and
 * pressing Start POSTed `hetero` and got a 400 from {@link checkDevModelPolicy}
 * with no way to see it coming.
 *
 * The server still refuses an impossible body — that is the invariant, and it
 * does not move. This is the other half: the surfaces get the SAME verdict up
 * front, computed by the same function, so the client never has to reimplement
 * the rule (and never gets to disagree with it).
 *
 * "Runnable" is exactly "{@link checkDevModelPolicy} raises no REFUSAL" —
 * warnings do not disqualify anything, for the same reason they never refuse a
 * run: an id absent from the catalog is not evidence against it.
 */
export function devModelPresetProviders(
  index: ModelProviderIndex,
  providers: readonly LlmProvider[] = PROVIDERS.map((p) => p.id),
): Record<DevModelPreset, LlmProvider[]> {
  const out = {} as Record<DevModelPreset, LlmProvider[]>;
  for (const name of Object.keys(DEV_MODEL_PRESETS) as DevModelPreset[]) {
    const policy = normalizeDevModelPolicy(DEV_MODEL_PRESETS[name]);
    const routed = policy && Object.keys(policy).length > 0 ? policy : undefined;
    out[name] = providers.filter(
      (provider) =>
        devModelRefusals(checkDevModelPolicy({ policy: routed, provider, index })).length === 0,
    );
  }
  return out;
}

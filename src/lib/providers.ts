/**
 * LLM provider model for the agent backends.
 *
 * huu exposes ONE real dispatch backend — jcode — and TWO providers behind
 * it: `deepseek` (api.deepseek.com, direct) and `openrouter`
 * (openrouter.ai, one key fronting many vendors). jcode serves both through
 * its `--provider-profile`; the concrete {@link AgentBackendKind} therefore
 * NO LONGER identifies the credential.
 *
 * The PROVIDER is the axis that decides:
 *   · which credential the run needs (`apiKeySpecName` → `API_KEY_REGISTRY`),
 *   · which OpenAI-compatible base URL the LangChain helpers talk to
 *     (`defaultBaseUrl`),
 *   · which models the catalog may offer (`ModelEntry.provider`).
 * The BACKEND only decides which agent process runs the task.
 *
 * This lives in `lib/` (not the backend registry) so every layer — api-key
 * resolution, the model catalog, the TUI and the web API — can import the
 * mapping without an upward `lib → orchestrator` dependency.
 */
import { z } from 'zod';
import type { AgentBackendKind } from './types.js';

/**
 * Canonical provider enum. THE single source — `run-config.ts` and any other
 * schema that needs to parse a provider imports this instead of redeclaring
 * `z.enum([...])`, so a new provider can never be half-added (a duplicated
 * enum diverges silently; an imported one cannot).
 */
export const LlmProviderSchema = z.enum(['deepseek', 'openrouter']);

/** An LLM provider huu can route a run through. */
export type LlmProvider = z.infer<typeof LlmProviderSchema>;

export interface ProviderInfo {
  id: LlmProvider;
  /** Concrete dispatch backend that serves this provider. */
  backend: AgentBackendKind;
  /** Short label shown in the provider selector. */
  label: string;
  /** One-line description shown under the label. */
  description: string;
  /** `API_KEY_REGISTRY` name of the credential this provider needs. */
  apiKeySpecName: string;
  /** `API_KEY_REGISTRY` name of the endpoint-URL spec, when the provider needs one. */
  endpointSpecName?: string;
  /**
   * OpenAI-compatible base URL the LangChain helper clients
   * (`llm-client-factory.ts`) build against. Canonical form: no trailing
   * slash. This is the DEFAULT — a caller may override it per context, but
   * an override that normalizes to empty is REFUSED rather than silently
   * falling back (an empty `baseURL` makes the openai SDK default to
   * api.openai.com and ship this provider's key to the wrong host).
   */
  defaultBaseUrl: string;
  /**
   * The VENDOR NAMESPACE this provider's endpoint owns, when it is a
   * single-vendor endpoint — i.e. one that names its models BARE.
   *
   * huu's canonical model id is the OpenRouter shape, `vendor/model`
   * (`recommended-models.json`, `DEFAULT_MODEL_ID`). An aggregator consumes
   * that shape verbatim — the prefix IS the routing — so it declares NO
   * namespace. A single-vendor endpoint does not: `api.deepseek.com` knows
   * `deepseek-v4-pro`, never `deepseek/deepseek-v4-pro`, and answers the
   * prefixed form with "model not found".
   *
   * Declaring the namespace is what lets {@link modelIdForProvider} render
   * ONE catalog id for BOTH endpoints with a rule instead of a translation
   * table. See that function for why only the provider's OWN prefix is ever
   * stripped.
   */
  modelNamespace?: string;
  /** Where the user gets a key for this provider. Shown in refusal messages. */
  keysUrl: string;
}

/** Ordered list of user-selectable providers (drives the selector). */
export const PROVIDERS: readonly ProviderInfo[] = [
  {
    id: 'deepseek',
    backend: 'jcode',
    label: 'DeepSeek',
    description: 'DeepSeek V4 Pro/Flash direct via jcode subprocess. Cheapest per token. Key from platform.deepseek.com.',
    apiKeySpecName: 'deepseek',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    // Single-vendor endpoint: it names its own models BARE, so the canonical
    // `deepseek/…` catalog prefix is stripped before the id goes on the wire.
    modelNamespace: 'deepseek',
    keysUrl: 'https://platform.deepseek.com',
  },
  {
    id: 'openrouter',
    backend: 'jcode',
    label: 'OpenRouter',
    description: 'One key fronting many vendors (Claude, GPT, GLM, DeepSeek). Key from openrouter.ai.',
    apiKeySpecName: 'openrouter',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    // Aggregator: `vendor/model` IS its addressing scheme, so NO namespace is
    // declared and every catalog id travels verbatim.
    keysUrl: 'https://openrouter.ai/keys',
  },
];

/**
 * Provider assumed when nothing else says otherwise. NOT "the provider of
 * the jcode backend" — jcode serves every entry in {@link PROVIDERS}; this
 * is only the fallback for callers that never made a choice.
 */
export const DEFAULT_PROVIDER: LlmProvider = 'deepseek';

/** Look up a provider descriptor. Throws on unknown id (programming error). */
export function providerInfo(p: LlmProvider): ProviderInfo {
  const info = PROVIDERS.find((x) => x.id === p);
  if (!info) throw new Error(`Unknown LLM provider: ${String(p)}`);
  return info;
}

/** The concrete dispatch backend that serves a provider. */
export function providerToBackend(p: LlmProvider): AgentBackendKind {
  return providerInfo(p).backend;
}

/**
 * Every provider a dispatch backend can serve, in selector order.
 *
 * `jcode` serves ALL of them; `stub` serves NONE — it never calls a model,
 * so no credential and no provider-scoped catalog filter applies to it. That
 * empty array is load-bearing: it is what lets the credential gate and the
 * model catalog treat "stub" as "no provider" instead of guessing one.
 */
export function providersForBackend(b: AgentBackendKind): readonly LlmProvider[] {
  return PROVIDERS.filter((p) => p.backend === b).map((p) => p.id);
}

/**
 * The provider a backend uses WHEN THE CALLER DID NOT PICK ONE.
 *
 * Read the name literally: this is a DEFAULT, not a fact about the backend.
 * Since `jcode` serves both `deepseek` and `openrouter`, no function can
 * derive the provider from the backend alone — anything that needs the real
 * answer must carry the provider explicitly (`AppConfig.provider`,
 * `RunConfig.provider`, the `?provider=` query, the selector's choice).
 * Callers that legitimately have no provider in hand (a bare `--backend=`
 * flag with no `--provider=`) use this to fill the blank.
 */
export function defaultProviderForBackend(b: AgentBackendKind): LlmProvider {
  return providersForBackend(b).at(0) ?? DEFAULT_PROVIDER;
}

/**
 * @deprecated Ambiguous since OpenRouter rejoined: `jcode` serves TWO
 * providers, so a backend does not determine one. Kept as a thin alias of
 * {@link defaultProviderForBackend} so existing call sites keep compiling —
 * migrate them to carry the user's chosen provider instead of re-deriving
 * it, and use `defaultProviderForBackend` only where a default is genuinely
 * what is wanted.
 */
export function backendToProvider(b: AgentBackendKind): LlmProvider {
  return defaultProviderForBackend(b);
}

/** Parse a CLI/string value into a provider, or null when unrecognized. */
export function parseProvider(s: string): LlmProvider | null {
  const lower = s.trim().toLowerCase();
  if (lower === 'deepseek' || lower === 'ds') return 'deepseek';
  if (lower === 'openrouter' || lower === 'or') return 'openrouter';
  return null;
}

/**
 * THE funnel every credential/model gate must go through.
 *
 * Answers "which provider will actually serve this run?" from the two facts a
 * call site can hold: the dispatch backend it is about to spawn, and the
 * provider the user picked (when it picked one).
 *
 *   · A backend that serves NO provider (`stub`) yields `undefined` — "no
 *     provider will be called", so no credential and no catalog filter apply.
 *     This is the case {@link defaultProviderForBackend} gets WRONG (it falls
 *     back to `DEFAULT_PROVIDER`, inventing a DeepSeek run for a keyless stub),
 *     which is why gates must call THIS function and not that one.
 *   · A `chosen` provider the backend actually serves wins — the user's pick
 *     survives.
 *   · A `chosen` provider the backend cannot serve is discarded in favor of the
 *     backend's first provider, so a mismatched pair can never send one
 *     provider's key to another's host.
 */
export function resolveRunProvider(
  backend: AgentBackendKind,
  chosen?: LlmProvider,
): LlmProvider | undefined {
  const serves = providersForBackend(backend);
  if (serves.length === 0) return undefined;
  if (chosen && serves.includes(chosen)) return chosen;
  return serves[0];
}

/**
 * `API_KEY_REGISTRY` name of the credential a provider spends.
 *
 * The ONLY authority for "which key does this run need". It deliberately takes
 * a PROVIDER: `BackendBundle.apiKeySpecName` cannot answer this since `jcode`
 * serves two providers, and reading it there is exactly the bug that made an
 * OpenRouter run demand `DEEPSEEK_API_KEY`. `undefined` in (no provider, i.e.
 * `stub`) means `undefined` out (no credential).
 */
export function apiKeySpecNameForProvider(p: LlmProvider | undefined): string | undefined {
  return p ? providerInfo(p).apiKeySpecName : undefined;
}

/**
 * Render huu's canonical catalog id (`vendor/model`) the way THIS provider's
 * endpoint names models.
 *
 * The two directions this closes, both measured against the real endpoints:
 *   · `openrouter` — an aggregator. The vendor prefix is its ROUTING, so the
 *     id travels verbatim: `anthropic/claude-opus-5` stays
 *     `anthropic/claude-opus-5`.
 *   · `deepseek` — a single-vendor endpoint. It names its models bare, so the
 *     leading `deepseek/` is stripped: `deepseek/deepseek-v4-flash` becomes
 *     `deepseek-v4-flash`. Without this, EVERY catalog entry died on "model
 *     not found" against api.deepseek.com — the catalog has always been
 *     OpenRouter-shaped, and the jcode backend passes `--model` VERBATIM.
 *
 * A rule, deliberately not a translation table: the only thing ever removed
 * is the provider's OWN namespace. A foreign id (`anthropic/claude-opus-5`
 * aimed at api.deepseek.com) is left EXACTLY as written, so the endpoint
 * answers "unknown model" instead of huu silently mangling it into something
 * that merely looks plausible. Trimmed, never empty-checked: an empty id is
 * the caller's error and is rejected upstream.
 */
export function modelIdForProvider(
  p: LlmProvider | undefined,
  modelId: string,
): string {
  const id = modelId.trim();
  if (!p) return id;
  const namespace = providerInfo(p).modelNamespace;
  if (!namespace) return id;
  const prefix = `${namespace}/`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

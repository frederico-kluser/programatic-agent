/**
 * Minimal OpenRouter client used to detect whether a model supports
 * reasoning/thinking at runtime.
 */
import { providerInfo } from './providers.js';

/**
 * Every request in this file is built on the OpenRouter base URL the PROVIDER
 * TABLE declares — never on a second literal copy of it.
 *
 * Why this matters beyond tidiness: `checkOpenRouterReachable` below is the
 * credential probe `key-validation.ts` runs against a key the user is still
 * typing. A second copy of the host would keep probing the OLD endpoint after
 * `providers.ts` moved, quietly proving a key good against a host huu no longer
 * spends it on — the exact drift the DeepSeek probe avoids by deriving its URL
 * the same way. One declaration, one endpoint, one thing to keep correct.
 *
 * `defaultBaseUrl` is canonically trailing-slash-free; the strip is belt and
 * braces so a future edit cannot produce `…/v1//models`.
 */
const OPENROUTER_API_BASE = providerInfo('openrouter').defaultBaseUrl.replace(/\/+$/, '');
const CAPABILITIES_FETCH_TIMEOUT_MS = 5_000;

export interface OpenRouterModel {
  id: string;
  name: string;
  context_length: number;
  pricing: {
    prompt: string;
    completion: string;
    internal_reasoning?: string;
  };
  supported_parameters?: string[];
}

interface OpenRouterModelsResponse {
  data: OpenRouterModel[];
}

// Per-API-key cache. The previous design used a single global cache,
// which silently returned stale data when two different keys were used in
// the same process (multi-tenant, BYOK swap, key rotation): the second
// key inherited the first key's view of the model catalog. Keying by
// trimmed apiKey isolates each key's view; keys are never logged.
const capabilitiesCacheByKey: Map<string, Map<string, OpenRouterModel>> = new Map();

export function resetCapabilitiesCache(): void {
  capabilitiesCacheByKey.clear();
}

function buildAuthHeaders(apiKey: string): HeadersInit {
  // OpenRouter's GET /models is a PUBLIC endpoint — the full catalog lists with
  // no Authorization. The web picker downloads it BEFORE the user pastes a key,
  // so we omit the header entirely when no key is held (an empty `Bearer ` is
  // rejected as malformed). A non-empty key is still sent so the authenticated
  // probes (auth/key) and any per-account view keep working.
  const headers: Record<string, string> = {
    'HTTP-Referer': 'https://github.com/huu',
    'X-OpenRouter-Title': 'huu',
  };
  const trimmed = apiKey.trim();
  if (trimmed) headers.Authorization = `Bearer ${trimmed}`;
  return headers;
}

export async function fetchModelCapabilities(
  apiKey = '',
): Promise<Map<string, OpenRouterModel>> {
  // Empty key → public catalog fetch (no Authorization header), cached under
  // the '' key like any other. The endpoint needs no auth to list models.
  const key = apiKey.trim();
  const cached = capabilitiesCacheByKey.get(key);
  if (cached) return cached;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CAPABILITIES_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${OPENROUTER_API_BASE}/models`, {
      headers: buildAuthHeaders(key),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`OpenRouter /models returned HTTP ${response.status}`);
    }
    const body = (await response.json()) as OpenRouterModelsResponse;
    const map = new Map(body.data.map((m) => [m.id, m]));
    capabilitiesCacheByKey.set(key, map);
    return map;
  } finally {
    clearTimeout(timer);
  }
}

export function modelSupportsReasoning(
  modelId: string,
  capabilities: Map<string, OpenRouterModel>,
): boolean {
  if (modelId.includes(':thinking')) return true;
  const model = capabilities.get(modelId);
  if (!model) return false;
  return (
    Array.isArray(model.supported_parameters) &&
    model.supported_parameters.includes('reasoning')
  );
}

/**
 * UI-friendly projection of an OpenRouter model: the subset the model picker
 * needs, with prices normalized to USD per 1M tokens.
 */
export interface OpenRouterModelOption {
  id: string;
  name: string;
  /** USD per 1M prompt tokens (undefined when OpenRouter omits a price). */
  inputPricePerM?: number;
  /** USD per 1M completion tokens. */
  outputPricePerM?: number;
  contextLength?: number;
  /** Whether the model advertises OpenAI-style tool calling (`tools`). */
  supportsTools?: boolean;
  /** Whether the model advertises a reasoning/thinking parameter (`reasoning`). */
  supportsReasoning?: boolean;
}

/** OpenRouter quotes prices per token as strings ("0.0000006"); show $/1M. */
function pricePerMillion(perToken?: string): number | undefined {
  if (perToken == null) return undefined;
  const n = Number.parseFloat(perToken);
  if (!Number.isFinite(n) || n < 0) return undefined;
  // Round to 4 decimals so $/1M reads cleanly ($0.6, not $0.5999999999).
  return Math.round(n * 1_000_000 * 1e4) / 1e4;
}

/** Project a raw OpenRouter model to the UI-facing {@link OpenRouterModelOption}. */
function toModelOption(m: OpenRouterModel): OpenRouterModelOption {
  const params = Array.isArray(m.supported_parameters)
    ? m.supported_parameters
    : [];
  return {
    id: m.id,
    name: m.name,
    inputPricePerM: pricePerMillion(m.pricing?.prompt),
    outputPricePerM: pricePerMillion(m.pricing?.completion),
    contextLength: m.context_length,
    supportsTools: params.includes('tools'),
    supportsReasoning: params.includes('reasoning'),
  };
}

/**
 * Keep only the models that support BOTH tool calling (`tools`) and reasoning
 * (`reasoning`) and project them to {@link OpenRouterModelOption}, sorted by id.
 * Pure: takes an already fetched capability map so it is trivially testable.
 *
 * NOTE: the picker no longer hard-filters on this — see {@link projectAllModels}.
 * Kept as a reusable, tested predicate-projection for callers that genuinely
 * want only the dual-capable subset.
 */
export function filterToolReasoningModels(
  capabilities: Map<string, OpenRouterModel>,
): OpenRouterModelOption[] {
  const out: OpenRouterModelOption[] = [];
  for (const m of capabilities.values()) {
    const o = toModelOption(m);
    if (!o.supportsTools || !o.supportsReasoning) continue;
    out.push(o);
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/**
 * Project the ENTIRE OpenRouter catalog to {@link OpenRouterModelOption}, sorted
 * by id, WITHOUT excluding any model by capability. Each option carries
 * `supportsTools`/`supportsReasoning` so the picker can badge capability instead
 * of hiding models: huu's agents need tool calling, but the user underwrites the
 * method and may legitimately want any id — a brand-new model OpenRouter just
 * shipped, a cheaper non-reasoning workhorse, or one typed by hand. Pure.
 */
export function projectAllModels(
  capabilities: Map<string, OpenRouterModel>,
): OpenRouterModelOption[] {
  const out = Array.from(capabilities.values()).map(toModelOption);
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/**
 * Fetch the OpenRouter catalog for `apiKey` and return only the models that
 * support tool calling AND reasoning. Composes the per-key-cached, 5s-timeout
 * {@link fetchModelCapabilities} with {@link filterToolReasoningModels}.
 */
export async function listToolReasoningModels(
  apiKey: string,
): Promise<OpenRouterModelOption[]> {
  return filterToolReasoningModels(await fetchModelCapabilities(apiKey));
}

/**
 * Fetch the FULL OpenRouter catalog (every model, capability-annotated) and
 * project it for the picker. Composes the per-key-cached, 5s-timeout
 * {@link fetchModelCapabilities} with {@link projectAllModels}. This is what the
 * web model picker downloads so the user can pick — or type — any model.
 *
 * `apiKey` is OPTIONAL: OpenRouter's `GET /models` is public, so the picker
 * downloads the ENTIRE catalog BEFORE the user has pasted a key. A key, when
 * held, is forwarded for the per-account view but is never required to list.
 */
export async function listAllModels(
  apiKey = '',
): Promise<OpenRouterModelOption[]> {
  return projectAllModels(await fetchModelCapabilities(apiKey));
}

export async function validateApiKey(apiKey: string): Promise<boolean> {
  const trimmed = apiKey.trim();
  if (!trimmed) return false;
  try {
    const response = await fetch(`${OPENROUTER_API_BASE}/key`, {
      headers: buildAuthHeaders(trimmed),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export type ReachabilityResult =
  | { kind: 'ok' }
  | { kind: 'unauthorized'; status: number }
  | { kind: 'unreachable'; reason: string };

/**
 * Fast HTTPS probe to confirm the process can actually talk to
 * OpenRouter. Returns within `timeoutMs` either way. Used as a
 * pre-run check so we fail loudly in <8s instead of waiting for
 * the pi SDK's 3× retry + orchestrator's 2× retry (~32s each) to
 * exhaust on every agent.
 *
 * Common failure mode this catches: Docker bridge MTU (1500) > VPN
 * tunnel MTU (~1420). DNS resolves, TCP connects, but the TLS
 * ClientHello packet (with SNI + ALPN extensions for Cloudflare)
 * exceeds the tunnel MTU and is silently dropped because PMTUD is
 * broken across most consumer VPNs.
 */
export async function checkOpenRouterReachable(
  apiKey: string,
  timeoutMs = 8_000,
): Promise<ReachabilityResult> {
  const trimmed = apiKey.trim();
  if (!trimmed) return { kind: 'unreachable', reason: 'API key is empty' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${OPENROUTER_API_BASE}/auth/key`, {
      headers: buildAuthHeaders(trimmed),
      signal: controller.signal,
    });
    if (response.ok) return { kind: 'ok' };
    if (response.status === 401 || response.status === 403) {
      return { kind: 'unauthorized', status: response.status };
    }
    return { kind: 'unreachable', reason: `HTTP ${response.status}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: 'unreachable', reason: msg };
  } finally {
    clearTimeout(timer);
  }
}

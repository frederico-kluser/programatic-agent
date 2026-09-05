/**
 * Provider-aware LangChain client factory.
 *
 * Centralizes client construction so every helper (Pipeline Assistant, Smart
 * File Select, Project Recon, the dev-mode planner, check-feasibility,
 * recon-selector, assistant-architect) builds its `ChatOpenAI` against the
 * right host with the right credential.
 *
 * Routing is by PROVIDER, not by backend: `jcode` serves BOTH `deepseek`
 * (api.deepseek.com) and `openrouter` (openrouter.ai), so the backend alone
 * cannot pick a base URL or a key. `ProviderInfo.defaultBaseUrl` and
 * `ProviderInfo.apiKeySpecName` (src/lib/providers.ts) are the single source
 * for both; this module holds no URL table of its own.
 *
 * `stub` never reaches here — the caller short-circuits.
 */
import { ChatOpenAI } from '@langchain/openai';
import { findSpec } from './api-key-registry.js';
import {
  defaultProviderForBackend,
  modelIdForProvider,
  providerInfo,
  type LlmProvider,
} from './providers.js';
import type { AgentBackendKind } from './types.js';

export interface LlmClientContext {
  /** Backend the user selected. Only used to DEFAULT `provider`. */
  backend: AgentBackendKind;
  /**
   * Provider that serves this client — the field that actually decides the
   * base URL and which credential is expected. Omitted means "the backend's
   * default provider" (`defaultProviderForBackend`), which is what every
   * pre-OpenRouter call site implicitly relied on.
   */
  provider?: LlmProvider;
  /** Credential for `provider`. Provider-neutral; preferred when present. */
  apiKey?: string;
  /** Base-URL override for `provider`. Provider-neutral; preferred when present. */
  endpoint?: string;
  /**
   * @deprecated Legacy DeepSeek-named credential. Honored ONLY when the
   * resolved provider is `deepseek` — a DeepSeek key must never be shipped
   * to openrouter.ai just because the field happened to be populated. New
   * call sites pass `apiKey` + `provider`.
   */
  deepseekApiKey?: string;
  /** @deprecated Legacy DeepSeek-named endpoint override. Same provider gate as above. */
  deepseekEndpoint?: string;
}

/** Reasoning/thinking effort for thinking-capable models. */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

export interface ChatClientOptions {
  modelId: string;
  temperature?: number;
  /** Cap completion tokens. */
  maxTokens?: number;
  /** Ask a thinking-capable model to reason harder. */
  reasoningEffort?: ReasoningEffort;
}

/**
 * Build a ChatOpenAI instance bound to the context's provider.
 * Throws if required credentials are missing, or if the endpoint override is
 * degenerate (see below) — never silently degrades.
 */
export function buildChatClient(
  ctx: LlmClientContext,
  opts: ChatClientOptions,
): ChatOpenAI {
  const modelId = opts.modelId.trim();
  if (!modelId) throw new Error('llm-client-factory: modelId is empty.');

  const provider = ctx.provider ?? defaultProviderForBackend(ctx.backend);
  const info = providerInfo(provider);
  const spec = findSpec(info.apiKeySpecName);

  // The legacy `deepseek*` fields are gated on the provider: a context built
  // for OpenRouter that only carries `deepseekApiKey` must FAIL, not send the
  // DeepSeek credential to another vendor's host.
  const legacyKey = provider === 'deepseek' ? ctx.deepseekApiKey : undefined;
  const apiKey = (ctx.apiKey ?? legacyKey ?? '').trim();
  if (!apiKey) {
    const where = spec
      ? `Set ${spec.envVar} or mount ${spec.secretMountPath}.`
      : `Set the ${info.apiKeySpecName} credential.`;
    throw new Error(`${info.label} API key missing. ${where}`);
  }

  // The fallback belongs to the OPTIONAL endpoint, never to the concatenation:
  // `+` binds tighter than `||`, so `endpoint?.trim()… + '/' || DEFAULT` used to
  // evaluate as `(undefined + '/') || DEFAULT` → the truthy string "undefined/",
  // which made the provider default unreachable. Resolve the override FIRST,
  // then normalize once, so the default and an override share the same
  // canonical no-trailing-slash shape.
  const legacyEndpoint = provider === 'deepseek' ? ctx.deepseekEndpoint : undefined;
  const rawEndpoint = (ctx.endpoint ?? legacyEndpoint ?? '').trim();
  let baseURL = info.defaultBaseUrl;
  if (rawEndpoint) {
    const normalized = rawEndpoint.replace(/\/+$/, '');
    if (!normalized) {
      // A degenerate override ("/", "///") normalized to "". The openai SDK
      // reads an EMPTY baseURL as ABSENT and falls back to api.openai.com —
      // silently, while carrying THIS provider's key. Refusing loudly is the
      // only safe answer: a credential leak must never be a fallback path.
      throw new Error(
        `llm-client-factory: endpoint override ${JSON.stringify(rawEndpoint)} normalizes to an ` +
          `empty baseURL. Refusing — an empty baseURL makes the OpenAI SDK default to ` +
          `https://api.openai.com/v1 and would send the ${info.label} key to the wrong host. ` +
          `Pass a full URL (e.g. ${info.defaultBaseUrl}) or leave the override unset.`,
      );
    }
    baseURL = normalized;
  }

  // The id goes on the wire in the ENDPOINT's namespace, not the catalog's.
  // huu's catalog is OpenRouter-shaped (`vendor/model`); openrouter.ai routes on
  // that prefix, while api.deepseek.com names its models bare and answers
  // `deepseek/deepseek-v4-flash` with "model not found". Same rule the jcode
  // backend applies to `--model`, so a helper and an agent pointed at the same
  // provider ask for the same model.
  const wireModelId = modelIdForProvider(provider, modelId);

  return new ChatOpenAI({
    model: wireModelId,
    temperature: opts.temperature ?? 0.4,
    ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    ...(opts.reasoningEffort ? { modelKwargs: { reasoning: { effort: opts.reasoningEffort } } } : {}),
    configuration: {
      baseURL,
      apiKey,
    },
  });
}

/**
 * Resolve a sensible default helper-model ID.
 */
export function defaultHelperModel(_backend: AgentBackendKind): string {
  return 'moonshotai/kimi-k2.6';
}

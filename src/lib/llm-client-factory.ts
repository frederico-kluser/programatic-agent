/**
 * Backend-aware LangChain client factory.
 *
 * huu v3.0: The only real backend is jcode, backed by DeepSeek.
 * This factory centralizes client construction so every helper (Pipeline
 * Assistant, Smart File Select, Project Recon, the dev-mode planner)
 * builds its ChatOpenAI against the DeepSeek API.
 *
 * Routing:
 *   - jcode → DeepSeek API (https://api.deepseek.com/v1, Authorization: Bearer)
 *   - stub  → caller short-circuits; never reaches this factory
 */
import { ChatOpenAI } from '@langchain/openai';
import type { AgentBackendKind } from './types.js';

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';

export interface LlmClientContext {
  /** Backend the user selected. Drives routing decisions. */
  backend: AgentBackendKind;
  /** DeepSeek API key. */
  deepseekApiKey?: string;
  /** DeepSeek API endpoint override (optional). */
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
 * Build a ChatOpenAI instance bound to DeepSeek API.
 * Throws if required credentials are missing.
 */
export function buildChatClient(
  ctx: LlmClientContext,
  opts: ChatClientOptions,
): ChatOpenAI {
  const modelId = opts.modelId.trim();
  if (!modelId) throw new Error('llm-client-factory: modelId is empty.');

  const apiKey = ctx.deepseekApiKey?.trim() ?? '';
  if (!apiKey) {
    throw new Error(
      'DeepSeek API key missing. Set DEEPSEEK_API_KEY or mount /run/secrets/deepseek_api_key.',
    );
  }

  // The fallback belongs to the OPTIONAL endpoint, never to the concatenation:
  // `+` binds tighter than `||`, so `endpoint?.trim()… + '/' || DEFAULT` used to
  // evaluate as `(undefined + '/') || DEFAULT` → the truthy string "undefined/",
  // which made DEEPSEEK_BASE_URL unreachable for every caller (no call site sets
  // `deepseekEndpoint`). Resolve the override FIRST, then normalize once, so the
  // default and an override share the same canonical no-trailing-slash shape.
  const endpoint = ctx.deepseekEndpoint?.trim() ?? '';
  const baseURL = (endpoint || DEEPSEEK_BASE_URL).replace(/\/+$/, '');

  return new ChatOpenAI({
    model: modelId,
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

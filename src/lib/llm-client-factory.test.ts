import { describe, expect, it } from 'vitest';
import { buildChatClient, type LlmClientContext } from './llm-client-factory.js';

/** The shape every real call site passes today: a key, no endpoint override. */
const deepseekCtx: LlmClientContext = {
  backend: 'jcode',
  deepseekApiKey: 'sk-test-key',
};

/** Reach the private-but-observable openai client options the factory built. */
function clientBaseURL(client: ReturnType<typeof buildChatClient>): unknown {
  return (client as unknown as { clientConfig: { baseURL?: string } }).clientConfig.baseURL;
}

describe('buildChatClient baseURL', () => {
  it('falls back to the DeepSeek default when no endpoint override is given', () => {
    // REGRESSION: `endpoint?.trim().replace(…) + '/' || DEFAULT` parsed as
    // `(undefined + '/') || DEFAULT`, because `+` binds tighter than `||`. The
    // literal string "undefined/" is truthy, so the default was unreachable and
    // all seven helpers (dev-mode planner, assistant-architect, assistant-client,
    // project-recon, recon-selector, llm-suggest-files, check-feasibility) built
    // their client against `baseURL: "undefined/"`.
    const client = buildChatClient(deepseekCtx, { modelId: 'deepseek/deepseek-v4-pro' });
    expect(clientBaseURL(client)).toBe('https://api.deepseek.com/v1');
  });

  it('honours an explicit endpoint override', () => {
    const client = buildChatClient(
      { ...deepseekCtx, deepseekEndpoint: 'https://proxy.internal/deepseek/v1' },
      { modelId: 'deepseek/deepseek-v4-pro' },
    );
    expect(clientBaseURL(client)).toBe('https://proxy.internal/deepseek/v1');
  });

  it('normalizes trailing slashes on an override to the canonical form', () => {
    const client = buildChatClient(
      { ...deepseekCtx, deepseekEndpoint: '  https://proxy.internal/deepseek/v1///  ' },
      { modelId: 'deepseek/deepseek-v4-pro' },
    );
    expect(clientBaseURL(client)).toBe('https://proxy.internal/deepseek/v1');
  });

  it('treats a blank endpoint override as absent', () => {
    // Same guard the apiKey line above uses: whitespace is not a configuration.
    const client = buildChatClient(
      { ...deepseekCtx, deepseekEndpoint: '   ' },
      { modelId: 'deepseek/deepseek-v4-pro' },
    );
    expect(clientBaseURL(client)).toBe('https://api.deepseek.com/v1');
  });
});

describe('buildChatClient credentials', () => {
  it('throws when the DeepSeek key is missing', () => {
    expect(() => buildChatClient({ backend: 'jcode' }, { modelId: 'm' })).toThrow(
      /DeepSeek API key missing/,
    );
  });

  it('throws on an empty modelId', () => {
    expect(() => buildChatClient(deepseekCtx, { modelId: '  ' })).toThrow(/modelId is empty/);
  });
});

describe('buildChatClient reasoningEffort', () => {
  it('omits reasoning params by default — byte-identical to legacy helper calls', () => {
    // ChatOpenAI defaults modelKwargs to {} when the caller passes nothing; the
    // whole point of gating on `reasoningEffort` is that existing helpers stay
    // exactly as they were.
    const client = buildChatClient(deepseekCtx, { modelId: 'moonshotai/kimi-k2.6' });
    expect(client.modelKwargs).toEqual({});
  });

  it('sends the OpenAI-compatible nested `reasoning.effort` when requested', () => {
    // One wire shape now that jcode/DeepSeek is the only backend: the flat
    // `reasoning_effort` variant belonged to the deleted azure backend.
    const client = buildChatClient(deepseekCtx, {
      modelId: 'deepseek/deepseek-v4-pro',
      reasoningEffort: 'high',
    });
    expect(client.modelKwargs).toEqual({ reasoning: { effort: 'high' } });
  });
});

import { describe, expect, it } from 'vitest';
import { buildChatClient, type LlmClientContext } from './llm-client-factory.js';

/** The LEGACY shape every pre-OpenRouter call site passes: a DeepSeek-named
 * key, no provider, no endpoint override. */
const deepseekCtx: LlmClientContext = {
  backend: 'jcode',
  deepseekApiKey: 'sk-test-key',
};

/** The provider-explicit shape new call sites pass. */
const openrouterCtx: LlmClientContext = {
  backend: 'jcode',
  provider: 'openrouter',
  apiKey: 'sk-or-test-key',
};

/** Reach the private-but-observable api key the factory bound. */
function clientApiKey(client: ReturnType<typeof buildChatClient>): unknown {
  return (client as unknown as { clientConfig: { apiKey?: string } }).clientConfig.apiKey;
}

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

  it('REFUSES an endpoint that normalizes to an empty baseURL', () => {
    // SECURITY REGRESSION GUARD. `"/"` and `"///"` survive `trim()` (so they
    // are not "absent") but `replace(/\/+$/, '')` reduces them to `""`. The
    // openai SDK reads an EMPTY baseURL as ABSENT and falls back to
    // https://api.openai.com/v1 — silently, while carrying THIS provider's
    // key. Latent until now only because no call site set an endpoint.
    // MUTATION KILLED: `const baseURL = (endpoint || DEFAULT).replace(…)`,
    // i.e. any shape that lets an empty normalization fall back to the default
    // (or through to the SDK) instead of throwing.
    for (const degenerate of ['/', '///', '  //  ']) {
      expect(() =>
        buildChatClient(
          { ...deepseekCtx, deepseekEndpoint: degenerate },
          { modelId: 'deepseek/deepseek-v4-pro' },
        ),
        degenerate,
      ).toThrow(/empty baseURL/);
    }
    // Same refusal on the provider-neutral field, for every provider.
    expect(() =>
      buildChatClient({ ...openrouterCtx, endpoint: '/' }, { modelId: 'anthropic/claude-opus-5' }),
    ).toThrow(/empty baseURL/);
  });
});

describe('buildChatClient provider routing', () => {
  it('routes an openrouter context to openrouter.ai with the openrouter key', () => {
    // MUTATION KILLED: a hardcoded DeepSeek base URL (the pre-wave shape) —
    // the OpenRouter key would be posted to api.deepseek.com.
    const client = buildChatClient(openrouterCtx, { modelId: 'anthropic/claude-opus-5' });
    expect(clientBaseURL(client)).toBe('https://openrouter.ai/api/v1');
    expect(clientApiKey(client)).toBe('sk-or-test-key');
  });

  it('an explicit deepseek provider still routes to api.deepseek.com', () => {
    const client = buildChatClient(
      { backend: 'jcode', provider: 'deepseek', apiKey: 'sk-ds' },
      { modelId: 'deepseek/deepseek-v4-pro' },
    );
    expect(clientBaseURL(client)).toBe('https://api.deepseek.com/v1');
    expect(clientApiKey(client)).toBe('sk-ds');
  });

  it('an omitted provider falls back to the backend DEFAULT (deepseek)', () => {
    // Back-compat: every pre-OpenRouter call site omits `provider`, and must
    // keep talking to DeepSeek exactly as before.
    expect(clientBaseURL(buildChatClient(deepseekCtx, { modelId: 'm' }))).toBe(
      'https://api.deepseek.com/v1',
    );
  });

  it('honours a per-provider endpoint override on openrouter', () => {
    const client = buildChatClient(
      { ...openrouterCtx, endpoint: 'https://gw.internal/or/v1//' },
      { modelId: 'anthropic/claude-opus-5' },
    );
    expect(clientBaseURL(client)).toBe('https://gw.internal/or/v1');
  });

  it('NEVER sends a DeepSeek-named credential to OpenRouter', () => {
    // MUTATION KILLED: reading the legacy `deepseekApiKey`/`deepseekEndpoint`
    // fields unconditionally instead of gating them on `provider === 'deepseek'`.
    // A context half-migrated by a caller (provider switched, credential field
    // not) would then ship the DeepSeek key to openrouter.ai. Failing loud is
    // the only safe answer.
    expect(() =>
      buildChatClient(
        { backend: 'jcode', provider: 'openrouter', deepseekApiKey: 'sk-ds-secret' },
        { modelId: 'anthropic/claude-opus-5' },
      ),
    ).toThrow(/OpenRouter API key missing/);
    // …and the legacy ENDPOINT is ignored the same way (it does not become
    // openrouter's baseURL).
    const client = buildChatClient(
      { ...openrouterCtx, deepseekEndpoint: 'https://api.deepseek.com/v1' },
      { modelId: 'anthropic/claude-opus-5' },
    );
    expect(clientBaseURL(client)).toBe('https://openrouter.ai/api/v1');
  });
});

describe('buildChatClient credentials', () => {
  it('throws when the DeepSeek key is missing', () => {
    expect(() => buildChatClient({ backend: 'jcode' }, { modelId: 'm' })).toThrow(
      /DeepSeek API key missing/,
    );
  });

  it('names the MISSING provider\'s own env var and secret mount', () => {
    // The hint is derived from the provider's API_KEY_REGISTRY spec, so it
    // can never tell an OpenRouter user to set DEEPSEEK_API_KEY.
    expect(() =>
      buildChatClient({ backend: 'jcode', provider: 'openrouter' }, { modelId: 'm' }),
    ).toThrow(/OPENROUTER_API_KEY.*\/run\/secrets\/openrouter_api_key/);
    expect(() => buildChatClient({ backend: 'jcode' }, { modelId: 'm' })).toThrow(
      /DEEPSEEK_API_KEY/,
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

describe('buildChatClient model namespace', () => {
  // Same rule the jcode backend applies to `--model`: huu keeps ONE canonical
  // catalog id (`vendor/model`) and renders it for the endpoint it is dialing.
  // Without this the LangChain helpers asked api.deepseek.com for
  // `deepseek/deepseek-v4-flash` and got "model not found" — the same live bug
  // the agent path had.
  //
  // MUTATION KILLED: reverting to `model: modelId` (passing the catalog id
  // straight through), which breaks the DeepSeek half while leaving OpenRouter
  // green — so only asserting BOTH directions catches it.
  it('strips the vendor prefix for the DeepSeek endpoint', () => {
    const client = buildChatClient(deepseekCtx, { modelId: 'deepseek/deepseek-v4-pro' });
    expect(client.model).toBe('deepseek-v4-pro');
  });

  it('keeps the vendor prefix for OpenRouter — it is the routing', () => {
    const client = buildChatClient(openrouterCtx, { modelId: 'anthropic/claude-opus-5' });
    expect(client.model).toBe('anthropic/claude-opus-5');
    const twin = buildChatClient(openrouterCtx, { modelId: 'deepseek/deepseek-v4-pro' });
    expect(twin.model).toBe('deepseek/deepseek-v4-pro');
  });

  it('leaves a foreign vendor id untouched instead of mangling it', () => {
    // api.deepseek.com must answer "unknown model" — a silently shortened
    // `claude-opus-5` would hide the real mistake.
    const client = buildChatClient(deepseekCtx, { modelId: 'anthropic/claude-opus-5' });
    expect(client.model).toBe('anthropic/claude-opus-5');
  });
});

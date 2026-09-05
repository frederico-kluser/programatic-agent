// Trimmed from pi-orq/src/lib/types.ts — guided-execution-only.
// Removed: parallel/dag/autonomous modes, retries, scaling, safety model, per-step modelId.

/**
 * Which agent SDK is driving execution. The list is duplicated in
 * `src/orchestrator/backends/registry.ts` (as `AgentBackendKind`) — the
 * canonical declaration lives there because it's tightly coupled to the
 * factory dispatch. This local alias avoids a `lib/` → `orchestrator/`
 * import cycle (lib imports must stay backend-agnostic).
 *
 * Only `jcode` is the real backend (a subprocess, serving BOTH the
 * `deepseek` and `openrouter` providers — see `providers.ts`).
 * `stub` is the no-LLM smoke-test backend.
 * (pi and azure — OpenRouter / Azure AI Foundry via @mariozechner/pi-coding-agent — were removed in v3.0.)
 */
export type AgentBackendKind = 'jcode' | 'stub';

// Re-export LlmProvider for backwards compat (canonical source is providers.ts)
export type { LlmProvider } from './providers.js';

export interface AppConfig {
  apiKey: string;
  modelId: string;
  /**
   * The LLM provider the user actually chose — the axis that decides WHICH
   * credential {@link AppConfig.apiKey} is, which base URL the LangChain
   * helpers talk to, and which `--provider-profile` the jcode subprocess must
   * eventually receive. `undefined` means "no provider will be called"
   * (`backend: 'stub'`) or "a caller that predates the choice"; readers then
   * fall back to `resolveRunProvider(config.backend ?? 'jcode')`.
   *
   * This field exists because `backend` CANNOT answer the question: `jcode`
   * serves both `deepseek` and `openrouter`. Dropping the user's pick at this
   * boundary is what made an OpenRouter run demand `DEEPSEEK_API_KEY` (and,
   * when that key happened to exist, silently spend it).
   */
  provider?: import('./providers.js').LlmProvider;
  budgetUsd?: number;
  /**
   * Optional backend-specific endpoint URL.
   */
  endpoint?: string;
  /**
   * Optional. Default `'jcode'`. The concrete dispatch kind.
   * Set directly by `--backend=` / `--stub`.
   */
  backend?: AgentBackendKind;
  /**
   * Optional. Where {@link AppConfig.apiKey} actually came from, when the
   * caller knows. `'request'` = sent by the browser with this run (web
   * sessionStorage key); `'options'` = saved via the web ⚙ Options this
   * server session; the remaining values mirror the `lib/api-key` resolver
   * tiers. Error paths (e.g. the DeepSeek 401 preflight) use it to blame
   * the key that was ACTUALLY used — re-running the resolver at error time
   * misattributes when the run carried its own key.
   */
  apiKeySource?:
    | 'request'
    | 'options'
    | 'secret-mount'
    | 'stored'
    | 'env-file'
    | 'env'
    | 'none';
}

export interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
  selected?: boolean;
  expanded?: boolean;
}

// ── Domain re-exports ────────────────────────────────────────────────

export * from './types/pipeline.js';
export * from './types/orchestrator.js';
export * from './types/git.js';
export * from './types/dev-mode.js';

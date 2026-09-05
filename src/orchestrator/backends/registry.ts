import type { AgentFactory } from '../types.js';
import { stubAgentFactory } from './stub/factory.js';
import { jcodeAgentFactory } from './jcode/factory.js';

/**
 * Single dispatch table from "what kind of agent is the user choosing"
 * to a concrete factory. Adding a new backend is a one-line case append
 * here — `cli.tsx` and `Orchestrator` never need to learn about it.
 *
 * The kind names match user-facing CLI flags (`--backend=<kind>`) and
 * the `AppConfig.backend` field, so changing one means changing both
 * intentionally.
 *
 * `jcode` is the only real backend (a subprocess, serving BOTH the
 * `deepseek` and `openrouter` providers — see `lib/providers.ts`).
 * `stub` is the no-LLM smoke-test backend.
 * (pi and azure — OpenRouter / Azure AI Foundry — were removed in v3.0.)
 */
export type AgentBackendKind = 'jcode' | 'stub';

export const ALL_BACKENDS: ReadonlyArray<AgentBackendKind> = ['jcode', 'stub'];

export interface BackendBundle {
  /** Factory used for regular per-task agents. */
  agentFactory: AgentFactory;
  /**
   * Factory used by `runStageIntegrationWithResolver` to resolve merge
   * conflicts. `undefined` for backends that can't reasonably resolve
   * conflicts (stub) — the orchestrator will fail loud on conflict in
   * that case rather than silently shipping a bad merge.
   */
  conflictResolverFactory: AgentFactory | undefined;
  /** Display label used in the TUI backend selector. */
  label: string;
  /** Short description shown under the label. */
  description: string;
  /**
   * `true` when running this backend requires resolving an API key /
   * token before launch. Stub returns `false` so `--stub` can run
   * without DEEPSEEK_API_KEY. Used by the App to decide whether to
   * open the api-key prompt screen.
   */
  requiresApiKey: boolean;
  /**
   * Name in `API_KEY_REGISTRY` whose presence the App should validate — ONLY
   * for a backend that serves exactly one provider.
   *
   * @deprecated as a credential authority. `jcode` serves BOTH `deepseek` and
   * `openrouter`, so the backend cannot name the key a run will spend; this
   * field is `undefined` there on purpose, and any call site that reads it to
   * pick a credential is asking the wrong object. Ask the PROVIDER instead:
   * `specForProvider(provider)` / `apiKeySpecNameForProvider(provider)`
   * (src/lib/api-key.ts, src/lib/providers.ts). Hard-coding `'deepseek'` here
   * is what made an OpenRouter run demand `DEEPSEEK_API_KEY` in the TUI, the
   * CLI and the web server at once.
   */
  apiKeySpecName?: string;
  /**
   * Whether this backend appears in the user-facing TUI BackendSelector.
   * `false` means "developer/test-only — only reachable via CLI flag".
   * Stub is the only false today: presenting it in a menu where regular
   * users pick a backend is misleading (a stub run won't actually do
   * the work). Surfaces only when `huu --stub` / `--backend=stub` is
   * explicit on the command line.
   */
  userSelectable: boolean;
}

/**
 * Resolve the bundle for a kind. Throws on unknown kind so a typo in
 * a CLI flag fails loudly rather than silently picking a default.
 */
export function selectBackend(kind: AgentBackendKind): BackendBundle {
  switch (kind) {
    case 'jcode':
      return {
        agentFactory: jcodeAgentFactory,
        conflictResolverFactory: jcodeAgentFactory,
        // Provider-NEUTRAL on purpose: jcode serves both `deepseek` and
        // `openrouter`, and the label used to name only the first — a user who
        // had picked OpenRouter read "DeepSeek V4 Pro" on the very screen that
        // was about to spend their OpenRouter key. The provider selector says
        // which vendor; this says which agent process runs the task.
        label: 'jcode',
        description:
          'Runs the jcode CLI as a subprocess, against whichever provider you pick. Stateless — zero embeddings, no memory across turns.',
        requiresApiKey: true,
        // Deliberately ABSENT: jcode is served by two providers (deepseek and
        // openrouter), so no single spec name is correct here. The credential
        // comes from `specForProvider(<the provider the user chose>)`.
        userSelectable: true,
      };
    case 'stub':
      return {
        agentFactory: stubAgentFactory,
        conflictResolverFactory: undefined,
        label: 'Stub',
        description: 'No real LLM. Writes STUB_*.md files and emits fake events. Smoke tests, demos.',
        requiresApiKey: false,
        // Test-only: reachable via `huu --stub` or `--backend=stub`,
        // not exposed in the BackendSelector TUI.
        userSelectable: false,
      };
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unknown agent backend: ${String(exhaustive)}`);
    }
  }
}

/**
 * Parse a string into an AgentBackendKind. Accepts canonical kinds plus
 * legacy aliases. Returns null on unknown input so the caller can produce
 * a friendly error.
 */
export function parseBackendKind(s: string): AgentBackendKind | null {
  const lower = s.trim().toLowerCase();
  if (lower === 'jcode' || lower === 'deepseek') return 'jcode';
  if (lower === 'stub' || lower === 'fake' || lower === 'mock') return 'stub';
  return null;
}

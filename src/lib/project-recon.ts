import { z } from 'zod';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { buildProjectDigest } from './project-digest.js';
import {
  RECON_CATALOG,
  RECON_AGENTS,
  buildReconSystemPrompt,
  type ReconCatalogEntry,
  type ReconCatalogId,
  type ReconAgent,
  type ReconAgentId,
  type ReconRunItem,
} from './project-recon-prompts.js';
import { fallbackCoreItems, resolveSelections } from './recon-resolve.js';
import { runReconSelector } from './recon-selector.js';
import { log as dlog } from './debug-logger.js';
import {
  buildChatClient,
  defaultHelperModel,
  type LlmClientContext,
} from './llm-client-factory.js';
import { specForProvider } from './api-key.js';
import { resolveRunProvider } from './providers.js';

/**
 * Default recon model — minimax is fast, cheap, and supports function calling,
 * so we can fan out up to 10 parallel agents without blowing up
 * the user's wallet on the pre-flight stage.
 */
export const RECON_MODEL = 'minimax/minimax-m2.7';

export const ReconBulletsSchema = z.object({
  bullets: z.array(z.string().min(1).max(240)).min(1).max(6),
});
export type ReconBullets = z.infer<typeof ReconBulletsSchema>;

export type ReconStatus = 'pending' | 'running' | 'done' | 'error';

export interface ReconUpdate {
  /** Stable tag identifying which item this update belongs to. */
  agentId: string;
  status: ReconStatus;
  bullets?: readonly string[];
  error?: string;
}

export interface ReconAgentResult {
  agent: ReconRunItem;
  status: 'done' | 'error';
  bullets: readonly string[];
  error?: string;
}

export interface RunProjectReconOptions {
  apiKey: string;
  repoRoot: string;
  /** Items to run. If omitted, falls back to the 4 core catalog items. */
  items?: readonly ReconRunItem[];
  modelId?: string;
  onUpdate: (update: ReconUpdate) => void;
  signal?: AbortSignal;
  /**
   * Backend-aware context. When provided, routes through the user's chosen
   * backend (jcode/DeepSeek). Required for correct backend routing.
   */
  llmContext?: LlmClientContext;
}

export interface SelectAndRunReconOptions {
  apiKey: string;
  repoRoot: string;
  /** User intent — fed into the selector to decide which processes to run. */
  intent: string;
  modelId?: string;
  /** Called once when the items list is resolved (so the UI can render rows). */
  onItemsResolved?: (items: readonly ReconRunItem[]) => void;
  onUpdate: (update: ReconUpdate) => void;
  signal?: AbortSignal;
  /** See `RunProjectReconOptions.llmContext`. */
  llmContext?: LlmClientContext;
}

export {
  RECON_CATALOG,
  RECON_AGENTS,
  fallbackCoreItems,
  resolveSelections,
  runReconSelector,
};
export type {
  ReconCatalogEntry,
  ReconCatalogId,
  ReconAgent,
  ReconAgentId,
  ReconRunItem,
};

/**
 * Aggregates per-agent bullets into a single markdown chunk that can be
 * embedded in the assistant's system prompt. Skips items that produced no
 * bullets (e.g. errored out) so the assistant doesn't see empty sections.
 */
export function buildReconContextMarkdown(results: readonly ReconAgentResult[]): string {
  const blocks: string[] = [];
  for (const r of results) {
    if (r.bullets.length === 0) continue;
    const lines = r.bullets.map((b) => `- ${b}`).join('\n');
    blocks.push(`### ${r.agent.label}\n${lines}`);
  }
  return blocks.join('\n\n');
}

/**
 * Fires every recon item in parallel against the configured model. Each
 * item receives the same digest but a different mission via its system
 * prompt; results stream through `onUpdate` so the UI can render per-item
 * loaders, and the returned promise resolves once every item has either
 * succeeded or failed (errors are isolated per item — a single timeout
 * doesn't kill the rest).
 */
export async function runProjectRecon(
  opts: RunProjectReconOptions,
): Promise<ReconAgentResult[]> {
  const items = opts.items ?? fallbackCoreItems();
  const stub =
    process.env.HUU_LANGCHAIN_STUB === '1' ||
    opts.apiKey.trim() === 'stub' ||
    opts.llmContext?.backend === 'stub';

  for (const item of items) {
    opts.onUpdate({ agentId: item.tag, status: 'running' });
  }

  if (stub) return runStubRecon(opts, items);

  const apiKey = opts.apiKey.trim();
  const ctxBackend = opts.llmContext?.backend ?? 'jcode';

  // Validate credentials up-front so we fail fast with a single, clear
  // error instead of N parallel per-item failures.
  //
  // SILENT-SKIP TRAP: this used to test ONLY `llmContext.deepseekApiKey`.
  // Migrating the contexts to the provider-neutral `apiKey` field without
  // touching this line would make every recon conclude "no credential" and
  // abort — with a message naming DeepSeek — for a perfectly configured
  // OpenRouter run. Both fields are checked, and the message names the
  // provider the context actually carries.
  const ctxKey = opts.llmContext?.apiKey ?? opts.llmContext?.deepseekApiKey;
  const hasCreds = apiKey.length > 0 || Boolean(ctxKey && ctxKey.trim());
  if (!hasCreds) {
    const missingSpec = specForProvider(
      resolveRunProvider(opts.llmContext?.backend ?? 'jcode', opts.llmContext?.provider),
    );
    const message = missingSpec
      ? `${missingSpec.label} API key missing. Set ${missingSpec.envVar} or mount ${missingSpec.secretMountPath}.`
      : 'API key missing.';
    for (const item of items) {
      opts.onUpdate({ agentId: item.tag, status: 'error', error: message });
    }
    throw new Error(message);
  }

  const fallbackModel = RECON_MODEL;
  const modelId = (opts.modelId ?? fallbackModel).trim();

  // Digest is built once and shared across all items — both faster and more
  // consistent than letting each agent see a different snapshot.
  const digest = buildProjectDigest(opts.repoRoot);

  // Provider-NEUTRAL fallback — the legacy `deepseekApiKey` field is honored
  // only when the resolved provider is `deepseek`.
  const ctx: LlmClientContext = opts.llmContext ?? {
    backend: 'jcode',
    apiKey,
  };

  const promises = items.map(async (item): Promise<ReconAgentResult> => {
    try {
      const chat = buildChatClient(ctx, {
        modelId,
        temperature: 0,
        maxTokens: 1200,
      });
      const structured = chat.withStructuredOutput(ReconBulletsSchema, {
        name: 'ReconBullets',
        method: 'functionCalling',
      });
      const messages = [
        new SystemMessage(
          buildReconSystemPrompt(
            { id: item.source === 'catalog' ? item.tag : undefined, tag: item.tag, mission: item.mission },
            digest.projectName,
          ),
        ),
        new HumanMessage(`Digest do projeto:\n\n${digest.digest}`),
      ];
      const raw = (await structured.invoke(messages, {
        signal: opts.signal,
      })) as ReconBullets;
      const parsed = ReconBulletsSchema.parse(raw);
      opts.onUpdate({
        agentId: item.tag,
        status: 'done',
        bullets: parsed.bullets,
      });
      return { agent: item, status: 'done', bullets: parsed.bullets };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      dlog('error', 'project-recon.agent_failed', { agent: item.tag, message });
      opts.onUpdate({ agentId: item.tag, status: 'error', error: message });
      return { agent: item, status: 'error', bullets: [], error: message };
    }
  });
  return Promise.all(promises);
}

/**
 * High-level recon entry point: runs the selector first to choose which
 * processes apply to the user's intent, then fans out the resolved list in
 * parallel. If the selector itself fails (network, parse, auth), gracefully
 * degrades to the core-4 catalog items so the recon stage never dead-ends.
 */
export async function selectAndRunRecon(
  opts: SelectAndRunReconOptions,
): Promise<{ items: ReconRunItem[]; results: ReconAgentResult[] }> {
  let items: ReconRunItem[];
  try {
    const raw = await runReconSelector({
      apiKey: opts.apiKey,
      intent: opts.intent,
      modelId: opts.modelId,
      signal: opts.signal,
      llmContext: opts.llmContext,
    });
    const resolved = resolveSelections(raw);
    items = resolved.items.length > 0 ? resolved.items : fallbackCoreItems();
    if (resolved.dropped.length > 0) {
      dlog('action', 'project-recon.dropped_selections', {
        dropped: resolved.dropped,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    dlog('error', 'project-recon.selector_failed', { message });
    items = fallbackCoreItems();
  }

  opts.onItemsResolved?.(items);

  const results = await runProjectRecon({
    apiKey: opts.apiKey,
    repoRoot: opts.repoRoot,
    items,
    modelId: opts.modelId,
    onUpdate: opts.onUpdate,
    signal: opts.signal,
    llmContext: opts.llmContext,
  });
  return { items, results };
}

/**
 * Stub bullets for catalog items (deterministic; mirrors the previous
 * behavior). Custom items get a generic placeholder so tests still see
 * non-empty output.
 */
const STUB_BULLETS: Partial<Record<ReconCatalogId, string[]>> = {
  stack: [
    'TypeScript + React (Ink) — CLI/TUI running on Node 20+.',
    'Build via tsc; tests with Vitest; lint not detected.',
    'Scripts: npm run dev / build / test / typecheck.',
  ],
  structure: [
    'src/ top-level: ui, lib, orchestrator, git, models, contracts.',
    'Layers flow downward (UI → orchestrator → git → lib).',
    'Co-located tests (*.test.ts next to the module).',
  ],
  libraries: [
    'ink — React rendering in the terminal.',
    'langchain + @langchain/openai — LLM calls via DeepSeek API.',
    'zod — structured schema validation.',
    'commander — CLI flag parsing.',
  ],
  conventions: [
    'Domain-specific skills in .agents/skills/.',
    'Root CLAUDE.md documents architecture, build, and commit rules.',
    'Conventional commits + no automated CI (typecheck/test manual).',
  ],
};

const CUSTOM_STUB_BULLETS = [
  'Stub custom — bullet 1 (replace when running with a real model).',
  'Stub custom — bullet 2 (replace when running with a real model).',
];

async function runStubRecon(
  opts: RunProjectReconOptions,
  items: readonly ReconRunItem[],
): Promise<ReconAgentResult[]> {
  const results: ReconAgentResult[] = [];
  for (const item of items) {
    let bullets: readonly string[];
    if (item.source === 'catalog') {
      bullets = STUB_BULLETS[item.tag as ReconCatalogId] ?? [
        `Stub bullet for ${item.tag}.`,
      ];
    } else {
      bullets = CUSTOM_STUB_BULLETS;
    }
    opts.onUpdate({ agentId: item.tag, status: 'done', bullets });
    results.push({ agent: item, status: 'done', bullets });
  }
  return results;
}

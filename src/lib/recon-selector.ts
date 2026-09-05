/**
 * Selector LLM: takes the user's intent + a tiny project hint + the catalog
 * description list, and returns an array of selections — each one either a
 * catalog id string or a custom `{title, prompt}` object. The recon stage
 * then resolves these into runnable items and fans them out in parallel.
 *
 * The selector replaces the old "always run all 4 fixed agents" behavior:
 * the AI now picks what's actually needed for the user's intent (max 10),
 * and can also request fully custom missions when the catalog doesn't cover
 * an angle. We keep the call cheap and structured — minimax-m2.7 with
 * function-calling, no chain-of-thought baked in.
 */

import { z } from 'zod';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import {
  RECON_CATALOG,
  type ReconCatalogEntry,
} from './project-recon-prompts.js';
import { MAX_SELECTIONS, type RawSelection } from './recon-resolve.js';
import { log as dlog } from './debug-logger.js';
import {
  buildChatClient,
  defaultHelperModel,
  type LlmClientContext,
} from './llm-client-factory.js';

/**
 * Default selector model — same family/tier as the recon agents themselves,
 * since the work is similar (one structured-output call against a short
 * context). Override via the `modelId` option if you want a heavier brain.
 */
export const SELECTOR_MODEL = 'minimax/minimax-m2.7';

/**
 * Selector output schema. Each `selections[i]` is EITHER a string (catalog
 * id, fuzzy-resolved later) OR an object with `{title, prompt}` for a custom
 * mission. We let zod accept the heterogeneous array because that's the
 * shape the prompt asks for; the resolver downstream is the source of truth
 * for normalization, dedup, and dropping unresolvable strings.
 */
export const SelectionSchema = z.union([
  z.string().min(1).max(80),
  z.object({
    title: z.string().min(1).max(80),
    prompt: z.string().min(20).max(1500),
  }),
]);

export const SelectorOutputSchema = z.object({
  selections: z.array(SelectionSchema).min(1).max(MAX_SELECTIONS),
});
export type SelectorOutput = z.infer<typeof SelectorOutputSchema>;

export interface RunSelectorOptions {
  apiKey: string;
  /** What the user wants the pipeline to do — drives every pick. */
  intent: string;
  /** Optional project hint (name + 1-paragraph summary). Helps the selector
   *  skip catalog items that obviously don't apply. */
  projectHint?: string;
  modelId?: string;
  signal?: AbortSignal;
  /**
   * Backend-aware context. When provided, routes through the user's chosen
   * backend (jcode/DeepSeek). Required for correct backend routing.
   */
  llmContext?: LlmClientContext;
}

function buildCatalogList(catalog: readonly ReconCatalogEntry[]): string {
  return catalog.map((e) => `- ${e.id} — ${e.description}`).join('\n');
}

export function buildSelectorSystemPrompt(
  catalog: readonly ReconCatalogEntry[] = RECON_CATALOG,
): string {
  return `You are the recon SELECTOR. Your single responsibility: given what the user wants to do (intent) and a minimal project hint, pick which recon processes should run to feed the pipeline assistant's interview.

# How it works

- There is a catalog of pre-defined processes (list below). Each one reads a static project digest and returns 2-6 factual bullets.
- The bullets of ALL selected processes are concatenated and injected as context into the next interview. The assistant reads that context before asking the user questions.
- You choose WHAT to run. If a catalog process covers what's needed, return its ID (string). If nothing in the catalog covers some critical aspect, return an object \`{title, prompt}\` with a CUSTOM mission.

# Catalog

${buildCatalogList(catalog)}

# How to decide

- Think: "to answer the user's intent well, which aspects of the project do I need to know?"
- Pick the MINIMUM necessary. More is not better — each extra process is latency and cost. Typically 2-5 processes are enough; only go beyond that if the intent is genuinely multi-domain.
- If the intent is specific ("run prettier on src/"), pick 2-3 relevant processes (\`stack\`, \`quality-tooling\`, \`structure\`).
- If the intent is vague ("improve the project"), pick 4-6 processes to map the terrain.
- If an aspect is not in the catalog (e.g.: "how module X uses module Y", "what's the format of config files in /etc"), use a custom item.

# Hard rule: maximum 10 items in the array.

# Custom items (\`{title, prompt}\`)

- \`title\`: ≤ 60 characters, will be displayed as a label in the UI ("Routing analysis", "Config mapping").
- \`prompt\`: the mission the agent will receive. Be SPECIFIC: say (a) which digest section to look at (\`## File tree\`, \`package.json\`, \`README.md\`, \`CLAUDE.md\`, \`AGENTS.md\`, \`tsconfig.json\`), (b) what to extract, (c) how many bullets to expect (2-6). Use imperative tone, like the catalog missions. Do NOT define output format — that's fixed.

# Strings (catalog refs)

- Whenever possible, use the EXACT catalog ID (e.g.: \`stack\`, \`build-deploy\`, \`pain-points\`).
- We validate with fuzzy match, but exact IDs are faster and more reliable.

# Output

Structured JSON:
\`\`\`
{
  "selections": [
    "stack",
    "structure",
    { "title": "...", "prompt": "..." }
  ]
}
\`\`\`

- Minimum 1, maximum 10 items.
- Each item is ONE STRING (catalog id) OR ONE OBJECT {title, prompt}.
- No extra fields, no comments, no preamble.`;
}

export function buildSelectorHumanMessage(intent: string, projectHint?: string): string {
  const hint = projectHint?.trim();
  const hintBlock = hint ? `\n\n## Project hint\n${hint}` : '';
  return `## User intent\n${intent.trim()}${hintBlock}`;
}

/**
 * Calls the selector LLM and returns the raw (unresolved) array. Throws on
 * network/auth/parse errors — the UI is expected to catch and fall back to
 * the core-4 catalog items so the recon stage never dead-ends.
 */
export async function runReconSelector(
  opts: RunSelectorOptions,
): Promise<RawSelection[]> {
  const stub =
    process.env.HUU_LANGCHAIN_STUB === '1' ||
    opts.apiKey.trim() === 'stub' ||
    opts.llmContext?.backend === 'stub';
  if (stub) return runStubSelector(opts);

  const apiKey = opts.apiKey.trim();
  const ctxBackend = opts.llmContext?.backend ?? 'jcode';
  const fallbackModel = SELECTOR_MODEL;
  const modelId = (opts.modelId ?? fallbackModel).trim();

  // Provider-NEUTRAL fallback: `apiKey` (not the legacy `deepseekApiKey`,
  // which `buildChatClient` honors only when the resolved provider is
  // `deepseek` — passing it here would silently drop the credential of an
  // OpenRouter context).
  const ctx: LlmClientContext = opts.llmContext ?? {
    backend: 'jcode',
    apiKey,
  };
  const chat = buildChatClient(ctx, { modelId, temperature: 0, maxTokens: 800 });
  const structured = chat.withStructuredOutput(SelectorOutputSchema, {
    name: 'ReconSelector',
    method: 'functionCalling',
  });

  const messages = [
    new SystemMessage(buildSelectorSystemPrompt()),
    new HumanMessage(buildSelectorHumanMessage(opts.intent, opts.projectHint)),
  ];

  const raw = (await structured.invoke(messages, {
    signal: opts.signal,
  })) as SelectorOutput;
  const parsed = SelectorOutputSchema.parse(raw);
  dlog('action', 'recon-selector.picked', {
    count: parsed.selections.length,
    catalogRefs: parsed.selections.filter((s) => typeof s === 'string').length,
    custom: parsed.selections.filter((s) => typeof s !== 'string').length,
  });
  return parsed.selections;
}

/**
 * Deterministic stub: returns 3 catalog refs + 1 custom. Exercises both code
 * paths in tests and offline `--stub` runs without touching the network.
 */
async function runStubSelector(_opts: RunSelectorOptions): Promise<RawSelection[]> {
  return [
    'stack',
    'structure',
    'libraries',
    {
      title: 'Stub custom mission',
      prompt:
        'LOOK ONLY at the `## File tree` and list files under `scripts/` if any exist. Otherwise, return a bullet "no scripts/ in file tree".',
    },
  ];
}

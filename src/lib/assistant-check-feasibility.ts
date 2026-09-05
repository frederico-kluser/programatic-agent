import { z } from 'zod';
import type { CheckStep, Pipeline } from './types.js';
import {
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from './assistant-client.js';
import {
  buildChatClient,
  defaultHelperModel,
  type LlmClientContext,
} from './llm-client-factory.js';

export const FeasibilitySchema = z.object({
  feasible: z.boolean(),
  reason: z.string(),
  instructionDraft: z.string(),
  warnings: z.array(z.string()).default([]),
});

export type FeasibilityResult = z.infer<typeof FeasibilitySchema>;

export interface FeasibilityInput {
  step: CheckStep;
  pipeline: Pipeline;
  apiKey: string;
  repoRoot: string;
  modelId?: string;
  /** Backend-aware context. Required for correct backend routing. */
  llmContext?: LlmClientContext;
}

/**
 * Setup-time check: ask an LLM whether the user's natural-language condition
 * can plausibly be evaluated by a judge agent at runtime, given:
 *
 *  - the step's declared outcomes (the judge MUST pick one of these labels)
 *  - the surrounding pipeline (the previous steps that produced the state
 *    the judge will inspect)
 *  - the repo root (so the assistant can mention concrete artifacts —
 *    package.json scripts, coverage tooling, etc.)
 *
 * Returns a stub when `apiKey === 'stub'` or `HUU_LANGCHAIN_STUB=1`, so
 * tests and offline development don't hit the network.
 */
export async function analyzeCheckFeasibility(
  input: FeasibilityInput,
): Promise<FeasibilityResult> {
  const stub =
    input.apiKey === 'stub' ||
    process.env.HUU_LANGCHAIN_STUB === '1' ||
    input.llmContext?.backend === 'stub';
  if (stub) {
    return stubFeasibility(input.step);
  }

  const apiKey = input.apiKey.trim();
  const ctxBackend = input.llmContext?.backend ?? 'jcode';
  const fallbackModel = 'moonshotai/kimi-k2.6';
  const modelId = (input.modelId ?? fallbackModel).trim();

  // Provider-NEUTRAL fallback: `apiKey` (not the legacy `deepseekApiKey`,
  // which `buildChatClient` honors only when the resolved provider is
  // `deepseek` — passing it here would silently drop the credential of an
  // OpenRouter context).
  const ctx: LlmClientContext = input.llmContext ?? {
    backend: 'jcode',
    apiKey,
  };
  let chat;
  try {
    chat = buildChatClient(ctx, { modelId, temperature: 0.2 });
  } catch (err) {
    return {
      feasible: false,
      reason: err instanceof Error ? err.message : String(err),
      instructionDraft: '',
      warnings: ['set the required API key/endpoint or use --stub'],
    };
  }
  const structured = chat.withStructuredOutput(FeasibilitySchema, {
    name: 'CheckFeasibility',
    method: 'functionCalling',
  });

  const messages: BaseMessage[] = [
    new SystemMessage(buildSystem()),
    new HumanMessage(buildUser(input)),
  ];
  const result = (await structured.invoke(messages)) as FeasibilityResult;
  return FeasibilitySchema.parse(result);
}

function buildSystem(): string {
  return [
    'You are an assistant that analyzes the feasibility of a condition for a pipeline decision step.',
    'Your response MUST be strict JSON.',
    '- feasible: true if the judge LLM can, at runtime, with shell access in the worktree, decide between the declared labels.',
    '- reason: brief justification (≤ 200 chars).',
    '- instructionDraft: 2-5 concrete sentences saying HOW the judge should verify (e.g.: "run `npm test -- --coverage`, read `coverage/coverage-summary.json`, compare total.lines.pct against 60").',
    '- warnings: list of warnings (e.g.: command missing in package.json, tool not installed).',
  ].join('\n');
}

function buildUser(input: FeasibilityInput): string {
  const { step, pipeline, repoRoot } = input;
  const lines: string[] = [];
  lines.push(`<repo-root>${repoRoot}</repo-root>`);
  lines.push(`<pipeline-name>${pipeline.name}</pipeline-name>`);
  lines.push('<previous-steps>');
  for (const s of pipeline.steps) {
    if (s.name === step.name) break;
    if (s.type === 'check') {
      lines.push(`- check "${s.name}"`);
    } else {
      lines.push(`- work "${s.name}" — files=${s.files.length === 0 ? 'whole-project' : s.files.join(',')}`);
    }
  }
  lines.push('</previous-steps>');
  lines.push('<check-step>');
  lines.push(`name: ${step.name}`);
  lines.push(`condition: ${step.condition}`);
  lines.push('outcomes:');
  for (const o of step.outcomes) {
    lines.push(`  - label="${o.label}" → "${o.nextStepName}"${o.default ? ' (default)' : ''}`);
  }
  lines.push('</check-step>');
  lines.push('');
  lines.push('Avalie e responda em JSON.');
  return lines.join('\n');
}

function stubFeasibility(step: CheckStep): FeasibilityResult {
  const labels = step.outcomes.map((o) => o.label).join('|');
  return {
    feasible: true,
    reason: 'stub: feasibility analyzer unavailable; assuming runnable.',
    instructionDraft: `Stub draft — replace before running with a real model. Evaluate the condition "${step.condition.slice(0, 80)}" and return a label from {${labels}}.`,
    warnings: ['stub mode — real analysis requires DEEPSEEK_API_KEY'],
  };
}

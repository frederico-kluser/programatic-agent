/**
 * `huu auto` config — the JSON the user passes alongside the pipeline
 * to drive a headless run. It supplies everything the interactive TUI
 * would normally collect (model, backend, file selection per per-file
 * step, timeouts) so the orchestrator can run start-to-finish with no
 * keyboard input.
 *
 * Why this lives next to the pipeline JSON instead of being merged
 * into it: the pipeline is portable and shareable; the config is
 * environment-specific (which files to test on THIS repo, which model
 * to pay for on THIS account). Keeping them split lets `huu Test
 * Suite` ship as a generic pipeline and still drive different repos
 * via different configs.
 */

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Pipeline, PipelineStep } from './types.js';
// IMPORTED, never redeclared: a second `z.enum([...])` of the provider union
// would diverge silently the day a provider is added (the run-config copy was
// still single-member long after `providers.ts` grew a second one).
import { LlmProviderSchema } from './providers.js';

const AgentBackendKindSchema = z.enum(['jcode', 'stub']);

export const RunConfigSchema = z.object({
  modelId: z.string().min(1),
  backend: AgentBackendKindSchema.default('jcode'),
  /**
   * LLM provider: `deepseek` or `openrouter`. When set, the launcher derives
   * `backend` from it (both dispatch to `jcode`) and resolves the matching
   * API key — the provider, not the backend, is what selects the credential.
   * Absent means "the backend's default provider".
   */
  provider: LlmProviderSchema.optional(),
  /**
   * Absolute or cwd-relative path of the directory to run in. The run's
   * git worktrees, preflight and reports all happen here. Defaults to the
   * process working directory when omitted, so existing configs are
   * unaffected.
   */
  workingDirectory: z.string().min(1).optional(),
  /**
   * Map step.name → files. The wrapper injects these into the matching
   * step's `files` array before constructing the Orchestrator. Steps
   * not mentioned keep their pipeline-defined files. Mismatched keys
   * emit a warning but do not fail — surfaces typos early without
   * blocking the run.
   */
  files: z.record(z.string(), z.array(z.string())).optional(),
  /** Whole-project / multi-file card timeout (ms). Falls back to pipeline value. */
  cardTimeoutMs: z.number().int().positive().optional(),
  /** Single-file card timeout (ms). Falls back to pipeline value. */
  singleFileCardTimeoutMs: z.number().int().positive().optional(),
  /** Retries per card on timeout/failure. Falls back to pipeline value. */
  maxRetries: z.number().int().min(0).optional(),
  /** Hard cap on total node visits. Falls back to pipeline value. */
  maxNodeExecutions: z.number().int().positive().optional(),
  /** Initial worker concurrency. When set (and autoScale is absent), pins manual mode. */
  concurrency: z.number().int().positive().optional(),
  /**
   * RAM budget as a percent of TOTAL memory — the machine-global admission
   * dial. Falls back to the `HUU_RAM_PERCENT` env var, then 85. Clamped to
   * [10, 95] at use. See `src/lib/budget.ts`.
   */
  ramPercent: z.number().int().min(1).max(100).optional(),
  /**
   * Memory-aware dynamic concurrency. Defaults: true when `concurrency`
   * is absent, false when it is set (an explicit concurrency means the
   * user wants that exact pool size). The memory guard runs either way.
   */
  autoScale: z.boolean().optional(),
});

export type RunConfig = z.infer<typeof RunConfigSchema>;

export interface ApplyResult {
  pipeline: Pipeline;
  warnings: string[];
}

/**
 * Parse and validate a config JSON from disk. Throws on missing file
 * or zod failure — the caller should surface the error to the user.
 */
export function loadRunConfig(path: string): RunConfig {
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw);
  const result = RunConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid run config at ${path}:\n${issues}`);
  }
  return result.data;
}

/**
 * Merge a {@link RunConfig} into a pipeline. Returns a new pipeline
 * (does not mutate the input) plus any warnings (e.g., config mentions
 * a step name that doesn't exist).
 */
export function applyRunConfig(pipeline: Pipeline, config: RunConfig): ApplyResult {
  const warnings: string[] = [];
  const filesMap = config.files ?? {};
  const stepNames = new Set(pipeline.steps.map((s) => s.name));
  for (const key of Object.keys(filesMap)) {
    if (!stepNames.has(key)) {
      warnings.push(
        `config.files mentions step "${key}" which is not in the pipeline — ignored. ` +
          `Known steps: ${[...stepNames].map((s) => `"${s}"`).join(', ')}`,
      );
    }
  }

  const nextSteps: PipelineStep[] = pipeline.steps.map((step) => {
    const override = filesMap[step.name];
    if (!override || !('files' in step)) return step;
    return { ...step, files: [...override] };
  });

  const next: Pipeline = {
    ...pipeline,
    steps: nextSteps,
    cardTimeoutMs: config.cardTimeoutMs ?? pipeline.cardTimeoutMs,
    singleFileCardTimeoutMs:
      config.singleFileCardTimeoutMs ?? pipeline.singleFileCardTimeoutMs,
    maxRetries: config.maxRetries ?? pipeline.maxRetries,
    maxNodeExecutions: config.maxNodeExecutions ?? pipeline.maxNodeExecutions,
  };

  return { pipeline: next, warnings };
}

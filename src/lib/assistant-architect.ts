// The Architect flow — research-grounded pipeline creation.
//
// Instead of one giant turn that carries all the cognitive load (structure
// + scopes + links + N prompts), creation is decomposed into short phases
// with structured artifacts between them:
//
//   B. SKETCH    ×3 in parallel — structural blueprints under deliberately
//                different lenses (diversity is what makes best-of-N beat
//                single-shot generation).
//   C. SELECT    ×1 — a GENERATIVE selector compares candidates against a
//                mechanical rubric and fuses (LLMs compare better than they
//                score; grafting beats rewriting).
//   D. EXPAND    ×N in parallel — the final prompt for each work step is
//                written in isolation from the fixed blueprint
//                (skeleton-of-thought style).
//   E. VERIFY    mechanical — the REAL zod + topology validation runs; on
//                failure exactly ONE fix call gets the verbatim errors.
//                (Research: self-critique loops degrade good baselines;
//                revision is only reliable with external feedback.)
//
// Latency ≈ 3 sequential calls (B and D are parallel) — comparable to the
// old single shot, with best-of-N quality.

import { HumanMessage } from '@langchain/core/messages';
import { z } from 'zod';
import {
  ARCHITECT_LENSES,
  buildArchitectFixPrompt,
  buildSelectorPrompt,
  buildSketchPrompt,
  buildStepExpansionPrompt,
} from './assistant-prompts.js';
import {
  ArchitectPipelineSchema,
  SelectionSchema,
  SketchSchema,
  StepPromptSchema,
  type ArchitectPipeline,
  type BlueprintStep,
  type PipelineDraft,
  type Selection,
  type Sketch,
} from './assistant-schema.js';
import { buildChatClient, type LlmClientContext } from './llm-client-factory.js';
import { parsePipelineFromJson } from './pipeline-io.js';
import type { Pipeline, PipelineStep } from './types.js';

export type ArchitectPhase = 'sketching' | 'selecting' | 'expanding' | 'verifying' | 'fixing';

export interface ArchitectMeta {
  winnerLens: string;
  reasoning: string;
  grafts: Selection['grafts'];
  retried: boolean;
}

/** One structured LLM call: schema-enforced, temperature-scoped. */
export type ArchitectInvoker = <T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  name: string,
  prompt: string,
  temperature: number,
) => Promise<T>;

export interface RunArchitectOptions {
  apiKey: string;
  modelId: string;
  llmContext?: LlmClientContext;
  intent: string;
  /** Verbatim Q&A transcript from the interview phase ('' when none). */
  transcript: string;
  reconContext?: string;
  /** The interviewer's one-shot draft — competes as candidate 0. */
  baseline?: PipelineDraft;
  onPhase?: (phase: ArchitectPhase, detail: string) => void;
  /** Test seam: replaces the real LLM invoker (network) when provided. */
  invoker?: ArchitectInvoker;
}

export interface ArchitectResult {
  pipeline: Pipeline;
  meta: ArchitectMeta;
}

function blueprintOutline(steps: readonly BlueprintStep[]): string {
  return steps
    .map((s, i) => {
      const shape = s.type === 'check' ? 'check' : (s.scope ?? 'flexible');
      const links = [
        s.dependsOn !== undefined ? `needs:[${s.dependsOn.join(', ')}]` : '',
        s.produces ? `produces:${s.produces}` : '',
        s.filesFrom ? `from:${s.filesFrom}` : '',
      ]
        .filter(Boolean)
        .join(' ');
      return `#${i + 1} ${s.name} [${shape}${links ? ' ' + links : ''}] — ${s.summary}`;
    })
    .join('\n');
}

/** Assemble the runtime Pipeline from a blueprint + per-step prompts. */
function assemblePipeline(
  name: string,
  steps: readonly (BlueprintStep & { prompt?: string })[],
  promptsByName: Map<string, string>,
): Pipeline {
  const out: PipelineStep[] = steps.map((s): PipelineStep => {
    if (s.type === 'check') {
      return {
        type: 'check' as const,
        name: s.name,
        condition: s.condition ?? '',
        outcomes: s.outcomes ?? [],
        ...(s.maxRuns !== undefined ? { maxRuns: s.maxRuns } : {}),
        ...(s.dependsOn !== undefined ? { dependsOn: s.dependsOn } : {}),
        ...(s.modelId ? { modelId: s.modelId } : {}),
      };
    }
    return {
      type: 'work' as const,
      name: s.name,
      prompt: promptsByName.get(s.name) ?? s.prompt ?? '',
      files: [],
      ...(s.scope !== undefined ? { scope: s.scope } : {}),
      ...(s.filesFrom !== undefined ? { filesFrom: s.filesFrom } : {}),
      ...(s.produces !== undefined ? { produces: s.produces } : {}),
      ...(s.dependsOn !== undefined ? { dependsOn: s.dependsOn } : {}),
      ...(s.modelId ? { modelId: s.modelId } : {}),
    };
  });
  return { name, steps: out };
}

/** The REAL mechanical gate: zod schema + topology, exactly what a run uses. */
function validatePipeline(pipeline: Pipeline): { ok: true } | { ok: false; errors: string } {
  try {
    parsePipelineFromJson(JSON.stringify({ _format: 'huu-pipeline-v2', pipeline }));
    return { ok: true };
  } catch (err) {
    return { ok: false, errors: err instanceof Error ? err.message : String(err) };
  }
}

export async function runArchitect(opts: RunArchitectOptions): Promise<ArchitectResult> {
  const stubTrigger =
    !opts.invoker &&
    (process.env.HUU_LANGCHAIN_STUB === '1' ||
      opts.apiKey.trim() === 'stub' ||
      opts.llmContext?.backend === 'stub');
  if (stubTrigger) {
    return runArchitectStub(opts);
  }

  // Provider-NEUTRAL fallback — see `llm-client-factory.ts`: the legacy
  // `deepseekApiKey` field is honored ONLY for the deepseek provider.
  const ctx: LlmClientContext = opts.llmContext ?? { backend: 'jcode', apiKey: opts.apiKey };
  const invoke: ArchitectInvoker =
    opts.invoker ??
    (async <T>(
      schema: z.ZodType<T, z.ZodTypeDef, unknown>,
      name: string,
      prompt: string,
      temperature: number,
    ): Promise<T> => {
      const chat = buildChatClient(ctx, { modelId: opts.modelId, temperature });
      const structured = chat.withStructuredOutput(schema as z.ZodTypeAny, {
        name,
        method: 'functionCalling',
      });
      const result = await structured.invoke([new HumanMessage(prompt)]);
      return schema.parse(result);
    });
  const phase = (p: ArchitectPhase, detail: string): void => opts.onPhase?.(p, detail);

  // --- B. Sketch (parallel, diverse) ---------------------------------------
  phase('sketching', `sketching ${ARCHITECT_LENSES.length} designs in parallel (${ARCHITECT_LENSES.map((l) => l.title).join(' · ')})…`);
  const baselineJson = opts.baseline ? JSON.stringify(opts.baseline) : undefined;
  const sketches: Sketch[] = await Promise.all(
    ARCHITECT_LENSES.map((lens) =>
      invoke(
        SketchSchema,
        'PipelineSketch',
        buildSketchPrompt({
          lens,
          intent: opts.intent,
          transcript: opts.transcript,
          reconContext: opts.reconContext,
          baselineJson,
        }),
        0.7,
      ),
    ),
  );

  // --- C. Select & fuse ------------------------------------------------------
  const candidates: { lens: string; name: string; steps: readonly BlueprintStep[] }[] = [
    ...(opts.baseline
      ? [{
          lens: 'interviewer-baseline',
          name: opts.baseline.name,
          steps: opts.baseline.steps.map((s) => ({
            name: s.name,
            type: 'work' as const,
            summary: s.prompt.slice(0, 300),
            scope: s.scope,
            filesFrom: s.filesFrom,
            produces: s.produces,
            dependsOn: s.dependsOn,
            modelId: s.modelId,
          })),
        }]
      : []),
    ...sketches.map((s) => ({ lens: s.lens, name: s.name, steps: s.steps })),
  ];
  phase('selecting', `comparing ${candidates.length} candidates against the mechanical rubric…`);
  const selection = await invoke(
    SelectionSchema,
    'PipelineSelection',
    buildSelectorPrompt({ intent: opts.intent, candidatesJson: JSON.stringify(candidates) }),
    0.2,
  );
  const winnerLens = candidates[selection.winner]?.lens ?? `candidate ${selection.winner}`;
  phase(
    'selecting',
    `winner: ${winnerLens}${selection.grafts.length > 0 ? ` (+${selection.grafts.length} graft${selection.grafts.length === 1 ? '' : 's'})` : ''}`,
  );

  // --- D. Expand prompts (parallel, one step each) ---------------------------
  const workSteps = selection.steps.filter((s) => s.type !== 'check');
  phase('expanding', `writing ${workSteps.length} step prompt${workSteps.length === 1 ? '' : 's'} in parallel…`);
  const outline = blueprintOutline(selection.steps);
  const prompts = await Promise.all(
    workSteps.map(async (step) => {
      const { prompt } = await invoke(
        StepPromptSchema,
        'StepPrompt',
        buildStepExpansionPrompt({
          intent: opts.intent,
          reconContext: opts.reconContext,
          blueprintOutline: outline,
          stepJson: JSON.stringify(step),
        }),
        0.2,
      );
      return [step.name, prompt] as const;
    }),
  );
  let pipeline = assemblePipeline(selection.name, selection.steps, new Map(prompts));

  // --- E. Verify mechanically (one guided fix at most) -----------------------
  phase('verifying', 'running schema + topology validation…');
  let verdict = validatePipeline(pipeline);
  let retried = false;
  if (!verdict.ok) {
    retried = true;
    phase('fixing', `validation failed — one guided fix with the exact errors…`);
    const fixed: ArchitectPipeline = await invoke(
      ArchitectPipelineSchema,
      'FixedPipeline',
      buildArchitectFixPrompt({ pipelineJson: JSON.stringify(pipeline), errors: verdict.errors }),
      0.2,
    );
    const promptsByName = new Map<string, string>(
      fixed.steps.filter((s) => s.type !== 'check' && s.prompt).map((s) => [s.name, s.prompt!]),
    );
    for (const [name, prompt] of prompts) {
      if (!promptsByName.has(name)) promptsByName.set(name, prompt);
    }
    pipeline = assemblePipeline(fixed.name, fixed.steps, promptsByName);
    verdict = validatePipeline(pipeline);
    if (!verdict.ok) {
      throw new Error(
        `architect produced an invalid pipeline even after one guided fix — ${verdict.errors}`,
      );
    }
  }
  phase('verifying', 'topology ✓');

  return {
    pipeline,
    meta: {
      winnerLens,
      reasoning: selection.reasoning,
      grafts: selection.grafts,
      retried,
    },
  };
}

/** Deterministic stub: a valid 2-step memory pair, phases emitted in order. */
async function runArchitectStub(opts: RunArchitectOptions): Promise<ArchitectResult> {
  const phase = (p: ArchitectPhase, detail: string): void => opts.onPhase?.(p, detail);
  phase('sketching', 'sketching 3 designs in parallel (stub)…');
  phase('selecting', 'winner: maximize-verifiability (stub)');
  phase('expanding', 'writing 2 step prompts in parallel (stub)…');
  const pipeline: Pipeline = {
    name: 'stub-architect-pipeline',
    steps: [
      {
        type: 'work',
        name: '1. Discover targets',
        prompt: 'Stub: list the files that need the work, one reason each.',
        files: [],
        scope: 'project',
        produces: '.huu/memory/stub-targets.json',
      },
      {
        type: 'work',
        name: '2. Act on each target',
        prompt: 'Stub: apply the change to $file. Note: $hint',
        files: [],
        scope: 'memory',
        filesFrom: '.huu/memory/stub-targets.json',
      },
    ],
  };
  phase('verifying', 'topology ✓ (stub)');
  const verdict = validatePipeline(pipeline);
  if (!verdict.ok) throw new Error(`stub pipeline invalid: ${verdict.errors}`);
  return {
    pipeline,
    meta: { winnerLens: 'maximize-verifiability', reasoning: 'stub', grafts: [], retried: false },
  };
}

import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import {
  AssistantTurnSchema,
  normalizeQuestionShape,
  validateQuestionShape,
  type AssistantTurn,
  type PipelineDraft,
} from './assistant-schema.js';
import {
  buildChatClient,
  defaultHelperModel,
  type LlmClientContext,
} from './llm-client-factory.js';

export const DEFAULT_ASSISTANT_MODEL = 'moonshotai/kimi-k2.6';

export interface AssistantChat {
  modelId: string;
  /**
   * Run one turn through the structured-output pipeline. Throws if Zod
   * validation fails (caller decides whether to retry with a correction
   * message or surface the error).
   */
  invokeStructured(messages: BaseMessage[]): Promise<AssistantTurn>;
}

export interface CreateAssistantChatOptions {
  /**
   * Legacy: DeepSeek API key. Used when `llmContext` is not provided
   * (back-compat for older call sites).
   */
  apiKey: string;
  modelId?: string;
  temperature?: number;
  /**
   * Backend-aware context. When provided, routes through the user's chosen
   * backend (jcode/DeepSeek). REQUIRED for correctness.
   */
  llmContext?: LlmClientContext;
}

export { AIMessage, HumanMessage, SystemMessage };
export type { BaseMessage };

/**
 * Bind LangChain's ChatOpenAI to the chosen backend and wrap it with
 * structured-output enforcement against `AssistantTurnSchema`. Returns a
 * stub that emits a deterministic 3-turn-then-pipeline sequence when running
 * with `--stub` (or `HUU_LANGCHAIN_STUB=1`) so smoke tests never touch the
 * network.
 */
export function createAssistantChat(opts: CreateAssistantChatOptions): AssistantChat {
  const stubTrigger =
    process.env.HUU_LANGCHAIN_STUB === '1' ||
    opts.apiKey.trim() === 'stub' ||
    opts.llmContext?.backend === 'stub';
  if (stubTrigger) {
    return new StubAssistantChat();
  }

  // Pick the right default model for the backend.
  const ctxBackend = opts.llmContext?.backend ?? 'jcode';
  const fallbackModel = DEFAULT_ASSISTANT_MODEL;
  const modelId = (opts.modelId ?? fallbackModel).trim();
  if (!modelId) throw new Error('assistant modelId is empty.');

  // Build a backend-aware ChatOpenAI client. If a context was passed, use it
  // — that's the correctness path. Otherwise, fall back to DeepSeek with
  // the legacy apiKey field (back-compat for call sites we haven't migrated).
  // Provider-NEUTRAL fallback: `apiKey` (not the legacy `deepseekApiKey`,
  // which `buildChatClient` honors only when the resolved provider is
  // `deepseek` — passing it here would silently drop the credential of an
  // OpenRouter context).
  const ctx: LlmClientContext = opts.llmContext ?? {
    backend: 'jcode',
    apiKey: opts.apiKey,
  };
  const chat = buildChatClient(ctx, {
    modelId,
    temperature: opts.temperature ?? 0.4,
  });

  const structured = chat.withStructuredOutput(AssistantTurnSchema, {
    name: 'AssistantTurn',
    method: 'functionCalling',
  });

  return {
    modelId,
    async invokeStructured(messages: BaseMessage[]): Promise<AssistantTurn> {
      const result = (await structured.invoke(messages)) as AssistantTurn;
      const parsed = AssistantTurnSchema.parse(result);
      if (parsed.done === false) {
        // Auto-fix the common LLM drift modes (missing/misplaced/duplicated
        // free-text flag) before validating. Without this we used to throw
        // "AssistantTurn invalid: the last option must have isFreeText=true"
        // back to the user whenever the model forgot the flag.
        const fixed = normalizeQuestionShape(parsed);
        validateQuestionShape(fixed);
        return fixed;
      }
      return parsed;
    },
  };
}

/**
 * Stub implementation: 3 canned questions followed by a canned pipeline.
 * Mirrors the AssistantTurn schema exactly. Used by `--stub` runs and by the
 * unit tests below — the assistant TUI never calls the network in either.
 */
class StubAssistantChat implements AssistantChat {
  modelId = 'stub/assistant';
  private turn = 0;

  async invokeStructured(_messages: BaseMessage[]): Promise<AssistantTurn> {
    this.turn += 1;
    if (this.turn === 1) {
      return {
        done: false,
        question: 'What granularity for the pipeline?',
        rationale: 'Stub: question 1 (fixed).',
        options: [
          { label: 'Whole project (1 step, 1 agent)' },
          { label: 'Per file (N parallel agents)' },
          { label: 'Other (type it)', isFreeText: true },
        ],
      };
    }
    if (this.turn === 2) {
      return {
        done: false,
        question: 'How many steps?',
        options: [
          { label: '1 step' },
          { label: '2 steps' },
          { label: '3 steps' },
          { label: 'Other (type it)', isFreeText: true },
        ],
      };
    }
    if (this.turn === 3) {
      return {
        done: false,
        question: 'Main model?',
        options: [
          { label: 'Kimi K2.6 (default)' },
          { label: 'GPT-5.4 Mini (cheaper)' },
          { label: 'Other (type it)', isFreeText: true },
        ],
      };
    }
    const draft: PipelineDraft = {
      name: 'stub-pipeline',
      steps: [
        {
          name: 'step-1',
          prompt: 'Stub step prompt — replace before running with a real model.',
          scope: 'project',
        },
      ],
    };
    return { done: true, pipeline: draft };
  }
}

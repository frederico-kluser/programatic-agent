// The contract the BLIND orchestrator uses to ASK for knowledge, plus the
// contract each answering subagent fills in.
//
// Built by the same rule as `plan-schema.ts`: this schema carries QUESTIONS,
// never STRUCTURE. There is no `steps`, no `dependsOn`, no file path, no step
// name and no agent count anywhere in it — the model that fills it in has not
// read the repository and must not be able to describe a graph it cannot see.
// Turning questions into a runnable epoch (a fixed two-step pipeline over one
// real file per gap) is huu's job, in TypeScript, and keeping that translation
// mechanical is what stops an ungrounded model from emitting an invalid graph.
//
// A `z.object` STRIPS unknown keys instead of rejecting them, and that is the
// wanted behavior on both ends: an orchestrator that hallucinates `steps: []`
// has it silently discarded rather than losing a whole epoch to a failed parse,
// and the key still cannot reach any consumer, because it is not on the
// inferred type either. Both layers say the same thing.
//
// Keep this file pure (no fs / no env) — the CLI, the web server, the planner
// and the blackboard writer all import it.

import { z } from 'zod';
import { DEV_MAX_GAPS } from '../types.js';

/** Gap ids name blackboard files (`G-001-<id>.md`), so they must be path-safe. */
export const GAP_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

/**
 * Which retrieval LANE answers the gap — never which source. The orchestrator
 * declares what it needs to know; naming the file to open, the skill to read or
 * the site to search is the answering agent's job, and it is the one with the
 * shell.
 *
 * - `repo`       — read only the code; every claim cites a path.
 * - `convention` — load the skill/router surface FIRST, then VERIFY it against
 *                  the code (a rule the code contradicts is a finding, not a rule).
 * - `external`   — web research through the surf CLI, with citations. The
 *                  lane is REAL, not decorative: `knowledge-blackboard.ts`
 *                  writes the surf v8 command lines, its exit-code table
 *                  (`78` = no search key, and retrying cannot create one) and
 *                  the URL-plus-excerpt citation rule into the gap spec, and
 *                  every answer it produces travels FENCED — see
 *                  `fenceUntrustedWebContent` and the note on `sources` below.
 *                  Text that came off the web is DATA in this system; it is
 *                  never an instruction to whoever reads it next.
 */
export const KnowledgeGapKindSchema = z.enum(['repo', 'convention', 'external']);

export const KnowledgeGapSchema = z.object({
  id: z.string().regex(GAP_ID_PATTERN, 'gap id must be kebab-case (3-40 chars, a-z0-9-)'),
  kind: KnowledgeGapKindSchema,
  /** One answerable question. Not a topic, not a task — a question. */
  question: z.string().min(1).max(400),
  /**
   * Why the answer matters FOR THIS GOAL. The anti-generic guard: a gap that
   * cannot say what it changes about this goal is a gap the orchestrator
   * invented to look thorough, and it costs a parallel subagent to answer.
   */
  why: z.string().min(1).max(400),
  /**
   * What a good answer looks like — the acceptance criterion the answering
   * agent is graded against, written by the side that knows what it will do
   * with the answer. This is the explicit output contract that keeps the job
   * mechanical enough for a small model.
   */
  goodAnswer: z.string().min(1).max(600),
});

export const KnowledgeRequestSchema = z.object({
  /**
   * The goal in the orchestrator's own words. Cheap comprehension check: drift
   * here is visible to the human at the approval gate, before an epoch runs.
   */
  restatedGoal: z.string().min(1).max(600),
  /**
   * The questions, capped at {@link DEV_MAX_GAPS}.
   *
   * An EMPTY array is legal and MEANINGFUL: it says "I already know enough",
   * and the driver answers it by skipping the knowledge run entirely and going
   * straight to planning. It is not a failed response — a caller that retries
   * on `gaps: []` is retrying a complete answer.
   *
   * Duplicate ids are NOT rejected here: the blackboard writer dedupes them
   * deterministically when it materializes one file per gap. Mechanical repair
   * beats spending a repair round on something TypeScript can fix for free.
   */
  gaps: z.array(KnowledgeGapSchema).max(DEV_MAX_GAPS).default([]),
  /** Free-form notes the orchestrator wants back at planning time. */
  planningNotes: z.string().max(1000).optional(),
});

export type KnowledgeGapKind = z.infer<typeof KnowledgeGapKindSchema>;
export type KnowledgeGap = z.infer<typeof KnowledgeGapSchema>;
export type KnowledgeRequest = z.infer<typeof KnowledgeRequestSchema>;

// --- The answer side -------------------------------------------------------

/**
 * Format tag for the brief shards on disk (`…/knowledge/briefs/<gapId>.json`),
 * written as `{ "_format": "huu-devbrief-v1", …brief }`. The tag is a wrapper
 * concern, not part of the payload contract: the reader checks it before
 * parsing to reject a shard left by an earlier session, and
 * {@link KnowledgeBriefSchema} strips it like any other unknown key.
 */
export const DEV_BRIEF_FORMAT = 'huu-devbrief-v1';

/**
 * How sure the agent is. Advisory to the planner, and a consistency handle for
 * consolidation: `low` with an empty `unknowns` is a contradiction worth
 * flagging — something was not verified, so something belongs in `unknowns`.
 */
export const KnowledgeConfidenceSchema = z.enum(['high', 'medium', 'low']);

export const KnowledgeBriefSchema = z.object({
  /** The gap this answers — matches the `id` of the spec file the agent read. */
  gapId: z.string().regex(GAP_ID_PATTERN, 'gap id must be kebab-case (3-40 chars, a-z0-9-)'),
  /** Echoed from the spec, so consolidation can group without re-reading it. */
  kind: KnowledgeGapKindSchema,
  confidence: KnowledgeConfidenceSchema,
  /** The answer itself, in prose. Consolidation squeezes it into the digest. */
  answer: z.string().min(1).max(2000),
  /**
   * The load-bearing claims, one line each. Every fact must be traceable to a
   * `sources` entry — that pairing is enforced by the PROMPT, not by this
   * schema: a shape that cannot check a citation should not pretend to.
   */
  facts: z.array(z.string().min(1).max(300)).max(20).default([]),
  /**
   * Where the facts were verified: repo-relative paths, or URLs for
   * `external`.
   *
   * Deliberately still a bare string array. A `z.string().url()` here would
   * reject the whole brief over one malformed citation — losing eleven good
   * facts to punish one — and this schema's job is to keep an honest answer
   * parseable, not to grade it. The URL requirement is stated where it can be
   * ACTED on instead: the `external` route block demands a URL plus the
   * shortest proving excerpt, and an `external` section whose `sources` is
   * empty is rendered into the digest saying exactly that ("NENHUMA — nada
   * aqui foi verificado contra a web"), so an uncited web claim is visible
   * rather than silently equal to a cited one.
   */
  sources: z.array(z.string().min(1).max(300)).max(20).default([]),
  /**
   * What the agent could NOT verify. REQUIRED — no default — while `facts` and
   * `sources` both have one. An empty array is a claim ("I checked everything I
   * was asked"), not an omission, and that asymmetry is the whole point.
   *
   * Why the schema forces it: a single plausible-but-wrong distractor measurably
   * degrades a model's accuracy, so near-relevant content in a brief is
   * ACTIVELY HARMFUL, not neutral filler — a wrong fact does not average out
   * against the right ones, it pulls the planner off. An agent with nowhere to
   * say "I couldn't check this" writes confident filler instead: it is graded
   * against `goodAnswer` and has every incentive to look complete. Making the
   * honest answer a mandatory field makes it the cheap one. The prompt's job is
   * to say "an honest gap beats an invented fact"; this field's job is to
   * guarantee there is somewhere to put it.
   */
  unknowns: z.array(z.string().min(1).max(300)).max(10),
});

export type KnowledgeConfidence = z.infer<typeof KnowledgeConfidenceSchema>;
export type KnowledgeBrief = z.infer<typeof KnowledgeBriefSchema>;

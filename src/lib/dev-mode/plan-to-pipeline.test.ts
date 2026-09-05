import { beforeAll, describe, expect, it } from 'vitest';
import { compileEpochPipeline, sortFronts } from './plan-to-pipeline.js';
import { DEV_METHODOLOGIES } from './methodology-registry.js';
import { DEV_STEP_BOUNDARY, ROUTER_PREFIX } from './dev-protocol.js';
import { COORDINATOR_RULES } from '../../orchestrator/review-agent.js';
import { hasDagEdges, computeWave, descendantsOf } from '../../orchestrator/wave-scheduler.js';
import { PipelineSchema, validateTopology } from '../pipeline-io.js';
import {
  DEFAULT_REVIEW_BLOCK_ON,
  DEFAULT_REVIEW_MAX_FINDINGS,
  DEFAULT_REVIEW_MAX_ROUNDS,
  DEV_MAX_FRONTS,
  isCheckStep,
  isWorkStep,
  type DevFront,
  type DevMethodology,
  type DevModelPolicy,
  type DevPlan,
  type Pipeline,
} from '../types.js';

function front(id: string, over: Partial<DevFront> = {}): DevFront {
  return {
    id,
    title: `Front ${id}`,
    rationale: `porque ${id}`,
    dependsOnFronts: [],
    reconPrompt: `mapeie ${id}`,
    workPrompt: `implemente ${id}`,
    verifyCondition: `${id} está pronto`,
    maxTasks: 4,
    ...over,
  };
}

function plan(fronts: DevFront[], over: Partial<DevPlan> = {}): DevPlan {
  return {
    epochGoal: 'entregar a fatia 1',
    doneWhen: 'os testes passam e a API responde',
    goalComplete: false,
    fronts,
    ...over,
  };
}

function compile(fronts: DevFront[], epoch = 1) {
  return compileEpochPipeline({ plan: plan(fronts), epoch, goal: 'construir a coisa' });
}

describe('sortFronts', () => {
  it('keeps plan order when there are no dependencies', () => {
    const { order, warnings } = sortFronts([front('a'), front('b'), front('c')]);
    expect(order.map((f) => f.id)).toEqual(['a', 'b', 'c']);
    expect(warnings).toEqual([]);
  });

  it('orders dependents after their dependencies', () => {
    const { order } = sortFronts([front('a', { dependsOnFronts: ['b'] }), front('b')]);
    expect(order.map((f) => f.id)).toEqual(['b', 'a']);
  });

  it('drops dependencies on unknown fronts', () => {
    const { order, deps, warnings } = sortFronts([front('a', { dependsOnFronts: ['ghost'] })]);
    expect(order.map((f) => f.id)).toEqual(['a']);
    expect(deps.get('a')).toEqual([]);
    expect(warnings[0]).toMatch(/unknown front "ghost"/);
  });

  it('drops self-dependencies', () => {
    const { deps, warnings } = sortFronts([front('a', { dependsOnFronts: ['a'] })]);
    expect(deps.get('a')).toEqual([]);
    expect(warnings[0]).toMatch(/self-dependency/);
  });

  // A cycle must not cost the epoch — the fronts still run, unordered.
  it('breaks a cycle instead of failing', () => {
    const { order, warnings } = sortFronts([
      front('a', { dependsOnFronts: ['b'] }),
      front('b', { dependsOnFronts: ['a'] }),
    ]);
    expect(order.map((f) => f.id).sort()).toEqual(['a', 'b']);
    expect(warnings.some((w) => /break a cycle/.test(w))).toBe(true);
  });
});

describe('compileEpochPipeline', () => {
  it('emits recon + 3 steps per front + 3 tail steps', () => {
    const { pipeline } = compile([front('a'), front('b')]);
    expect(pipeline.steps).toHaveLength(1 + 2 * 3 + 3);
    expect(pipeline.steps[0]!.name).toBe('0. Recon do objetivo');
  });

  // The whole design rests on this: the compiled graph must satisfy the exact
  // rules a real run enforces at load time.
  it('passes validateTopology with no errors', () => {
    const { pipeline } = compile([front('a'), front('b'), front('c')]);
    expect(validateTopology(pipeline)).toEqual([]);
  });

  it('produces a graph the wave scheduler recognizes', () => {
    const { pipeline } = compile([front('a'), front('b')]);
    expect(hasDagEdges(pipeline.steps)).toBe(true);
  });

  // `validateTopology` rejects a dependsOn that points forward, and
  // `descendantsOf` assumes backwards-only edges.
  it('only ever names EARLIER steps in dependsOn', () => {
    const { pipeline } = compile([front('a', { dependsOnFronts: ['b'] }), front('b')]);
    const indexByName = new Map(pipeline.steps.map((s, i) => [s.name, i]));
    for (const [i, step] of pipeline.steps.entries()) {
      for (const dep of step.dependsOn ?? []) {
        expect(indexByName.has(dep)).toBe(true);
        expect(indexByName.get(dep)!).toBeLessThan(i);
      }
    }
  });

  it('runs independent fronts in ONE wave', () => {
    const { pipeline } = compile([front('a'), front('b'), front('c')]);
    const steps = pipeline.steps;
    const pending = new Set(steps.map((s) => s.name));

    const first = computeWave(steps, new Set(), pending);
    expect(first.map((s) => s.name)).toEqual(['0. Recon do objetivo']);

    pending.delete('0. Recon do objetivo');
    const second = computeWave(steps, new Set(['0. Recon do objetivo']), pending);
    // All three front recons become ready together — that is the parallelism.
    expect(second.map((s) => s.name)).toEqual([
      '1a. Front a — recon',
      '2a. Front b — recon',
      '3a. Front c — recon',
    ]);
  });

  it('serializes a front that depends on another', () => {
    const { pipeline } = compile([front('a'), front('b', { dependsOnFronts: ['a'] })]);
    const steps = pipeline.steps;
    const pending = new Set(steps.map((s) => s.name));
    pending.delete('0. Recon do objetivo');

    const wave = computeWave(steps, new Set(['0. Recon do objetivo']), pending);
    // b waits on a's judge, so only a's recon is ready.
    expect(wave.map((s) => s.name)).toEqual(['1a. Front a — recon']);
  });

  it('pairs each front recon (produces) with its memory step (filesFrom)', () => {
    const { pipeline } = compile([front('a', { maxTasks: 6 })]);
    const recon = pipeline.steps.find((s) => s.name === '1a. Front a — recon');
    const work = pipeline.steps.find((s) => s.name === '1b. Front a — implementar');

    expect(isWorkStep(recon!) && recon.produces).toBe('.huu/dev/epoch-1/a/tasks.json');
    expect(isWorkStep(work!) && work.scope).toBe('memory');
    expect(isWorkStep(work!) && work.filesFrom).toBe('.huu/dev/epoch-1/a/tasks.json');
    expect(isWorkStep(work!) && work.maxFiles).toBe(6);
  });

  it('gives every check exactly one forward default and a backward rework', () => {
    const { pipeline } = compile([front('a'), front('b')]);
    const indexByName = new Map(pipeline.steps.map((s, i) => [s.name, i]));

    const checks = pipeline.steps.filter(isCheckStep);
    expect(checks).toHaveLength(3); // one judge per front + the epoch gate

    for (const check of checks) {
      const defaults = check.outcomes.filter((o) => o.default);
      expect(defaults).toHaveLength(1);
      // The default fires on judge failure / unknown label / maxRuns cap, so
      // it must move the run FORWARD, never into the loop.
      expect(indexByName.get(defaults[0]!.nextStepName)!).toBeGreaterThan(indexByName.get(check.name)!);

      const rework = check.outcomes.find((o) => o.label === 'rework')!;
      expect(indexByName.get(rework.nextStepName)!).toBeLessThan(indexByName.get(check.name)!);
    }
  });

  it('makes the epoch consolidation wait on every front judge', () => {
    const { pipeline } = compile([front('a'), front('b'), front('c')]);
    const consolidate = pipeline.steps.find((s) => s.name.startsWith('4. Consolidar'))!;
    expect(consolidate.dependsOn).toEqual([
      '1c. Front a — verificar',
      '2c. Front b — verificar',
      '3c. Front c — verificar',
    ]);
  });

  it('truncates past the front cap and warns', () => {
    const { pipeline, warnings, frontOrder } = compile([
      front('a'),
      front('b'),
      front('c'),
      front('d'),
      front('e'),
    ]);
    expect(frontOrder).toHaveLength(4);
    expect(warnings.some((w) => /truncated to 4/.test(w))).toBe(true);
    expect(validateTopology(pipeline)).toEqual([]);
  });

  // REGRESSION (dossier finding B3): the user's --fronts / Manual N only ever
  // reached the planner's PROMPT. A model that returned more fronts than asked
  // got all of them, so the control was decorative.
  it('enforces the caller front cap, not just the global one', () => {
    const { pipeline, frontOrder, warnings } = compileEpochPipeline({
      plan: plan([front('a'), front('b'), front('c')]),
      epoch: 1,
      goal: 'g',
      maxFronts: 1,
    });

    expect(frontOrder).toEqual(['a']);
    expect(pipeline.steps.filter(isCheckStep)).toHaveLength(2); // 1 front judge + epoch gate
    expect(warnings.some((w) => /truncated to 1/.test(w))).toBe(true);
    expect(validateTopology(pipeline)).toEqual([]);
  });

  it('never lets the caller cap exceed the global ceiling', () => {
    const { frontOrder } = compileEpochPipeline({
      plan: plan([front('a'), front('b'), front('c'), front('d'), front('e')]),
      epoch: 1,
      goal: 'g',
      maxFronts: 99,
    });
    expect(frontOrder).toHaveLength(4);
  });

  it('drops duplicate front ids so step names stay unique', () => {
    const { pipeline, warnings } = compile([front('a'), front('a')]);
    expect(warnings.some((w) => /duplicate front id "a"/.test(w))).toBe(true);
    const names = pipeline.steps.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('stays under the node-execution ceiling with the maximum fan-out', () => {
    const { pipeline } = compile([front('a'), front('b'), front('c'), front('d')]);
    // 1 recon + 4×3 + 3 tail = 16 steps. How many VISITS the rework loops can
    // add is not guessed here any more — `compileEpochPipeline — the
    // node-execution budget` replays `runDagWaves` and measures it, for this
    // shape and for every methodology combination.
    expect(pipeline.steps.length).toBeLessThanOrEqual(20);
    expect(pipeline.maxNodeExecutions).toBe(96);
  });

  // REGRESSION (dossier finding E1): every swarm agent was told to append to
  // ONE shared findings.json. A fan-out wave has N agents doing that, they all
  // commit, and the stage merge is sequential — so every branch after the
  // first conflicted and the whole wave fell to the LLM conflict resolver.
  it('gives every writer its own findings shard, never one shared file', () => {
    const { pipeline } = compile([front('a'), front('b')]);
    const prompts = pipeline.steps.filter(isWorkStep).map((s) => s.prompt).join('\n');

    // No prompt may name a single shared file.
    expect(prompts).not.toContain('.huu/dev/epoch-1/findings.json');
    // The global recon seeds its own shard.
    expect(prompts).toContain('.huu/dev/epoch-1/findings/recon.json');
    // Each front recon writes a distinct one.
    expect(prompts).toContain('.huu/dev/epoch-1/findings/a-recon.json');
    expect(prompts).toContain('.huu/dev/epoch-1/findings/b-recon.json');
    // Task agents derive theirs from their spec filename at run time.
    expect(prompts).toContain('the basename of');
  });

  it('makes the consolidation and the gate read every shard', () => {
    const { pipeline } = compile([front('a')]);
    const consolidate = pipeline.steps.find((s) => s.name.startsWith('2. Consolidar'))!;
    const gate = pipeline.steps.filter(isCheckStep).at(-1)!;

    expect(isWorkStep(consolidate) && consolidate.prompt).toContain('.huu/dev/epoch-1/findings/');
    expect(gate.condition).toContain('.huu/dev/epoch-1/findings/');
    expect(gate.condition).not.toContain('epoch-1/findings.json');
  });

  it('refuses to compile an empty plan (the driver must stop instead)', () => {
    expect(() => compile([])).toThrow(/no fronts/);
  });

  it('quotes the human goal verbatim into the recon prompt', () => {
    const goal = 'migrar o parser para streaming sem quebrar a API pública';
    const { pipeline } = compileEpochPipeline({ plan: plan([front('a')]), epoch: 2, goal });
    const recon = pipeline.steps[0]!;
    expect(isWorkStep(recon) && recon.prompt).toContain(goal);
  });

  it('scopes the blackboard per epoch', () => {
    const { pipeline } = compile([front('a')], 3);
    const work = pipeline.steps.find((s) => s.name === '1b. Front a — implementar')!;
    expect(isWorkStep(work) && work.filesFrom).toBe('.huu/dev/epoch-3/a/tasks.json');
  });
});

// --- Model stamping (§2.2) ---------------------------------------------------
//
// The compatibility half of this contract lives in the block ABOVE: every
// assertion there compiles WITHOUT `models`, `sessionId` or `verifyCommands`
// and still passes unchanged. These tests cover what the options add.

const FULL_POLICY: DevModelPolicy = {
  planner: { model: 'lead/planner' },
  recon: { model: 'swarm/recon' },
  worker: { model: 'swarm/worker' },
  // A role may pin the ENDPOINT that serves it. The compiler stamps only the
  // id (a step has no provider field); the pair is enforced at the border.
  critic: { model: 'other-family/critic', provider: 'openrouter' },
  reporter: { model: 'swarm/reporter' },
  judge: { model: 'swarm/judge' },
  integration: { model: 'swarm/integration' },
  // The debate pair, from two DIFFERENT families on purpose — a policy that
  // put them on one family would trip the heterogeneity warning and turn the
  // "compiles clean" assertion below into a lie about a real defect.
  advocate: { model: 'defence/advocate' },
  prosecutor: { model: 'attack/prosecutor', provider: 'openrouter' },
};

function modelOf(pipeline: Pipeline, name: string): string | undefined {
  const step = pipeline.steps.find((s) => s.name === name);
  expect(step, `step "${name}" not found`).toBeDefined();
  return step!.modelId;
}

describe('compileEpochPipeline — model stamping', () => {
  it('stamps all nine points from a full policy', () => {
    const { pipeline } = compileEpochPipeline({
      plan: plan([front('a')]),
      epoch: 1,
      goal: 'g',
      models: FULL_POLICY,
    });

    // 1 + 2. the global recon and the front recon
    expect(modelOf(pipeline, '0. Recon do objetivo')).toBe('swarm/recon');
    expect(modelOf(pipeline, '1a. Front a — recon')).toBe('swarm/recon');
    // 3. the swarm
    expect(modelOf(pipeline, '1b. Front a — implementar')).toBe('swarm/worker');
    // 4. the per-task critic — cross-family from the worker on purpose
    const work = pipeline.steps.find((s) => s.name === '1b. Front a — implementar')!;
    expect(isWorkStep(work) && work.review?.modelId).toBe('other-family/critic');
    // 5 + 7. both judges
    expect(modelOf(pipeline, '1c. Front a — verificar')).toBe('swarm/judge');
    expect(modelOf(pipeline, '3. Portão de qualidade')).toBe('swarm/judge');
    // 6 + 8. consolidation and sealing
    expect(modelOf(pipeline, '2. Consolidar época 1')).toBe('swarm/reporter');
    expect(modelOf(pipeline, '4. Selar época 1')).toBe('swarm/reporter');
    // 9. the merge-conflict resolver
    expect(pipeline.integrationModelId).toBe('swarm/integration');
  });

  // The `planner` role is the blind orchestrator: it is reached through the
  // structured-output LangChain client, never through a pipeline step. Stamping
  // it anywhere would send an id the pi registry has never heard of to an agent.
  it('never stamps the planner role onto a step', () => {
    const { pipeline } = compileEpochPipeline({
      plan: plan([front('a')]),
      epoch: 1,
      goal: 'g',
      models: FULL_POLICY,
    });
    const stamped = pipeline.steps.map((s) => s.modelId).concat(pipeline.integrationModelId);
    expect(stamped).not.toContain('lead/planner');
  });

  // THE compatibility proof: no policy ⇒ no field ⇒ AppConfig.modelId decides,
  // exactly as it did before this option existed.
  it('omits every modelId when no policy is given', () => {
    const { pipeline } = compile([front('a'), front('b')]);
    for (const step of pipeline.steps) expect(step.modelId).toBeUndefined();
    expect(pipeline.integrationModelId).toBeUndefined();
    const work = pipeline.steps.find((s) => s.name === '1b. Front a — implementar')!;
    expect(isWorkStep(work) && work.review?.modelId).toBeUndefined();
  });

  it('omits the roles a PARTIAL policy leaves unset', () => {
    const { pipeline } = compileEpochPipeline({
      plan: plan([front('a')]),
      epoch: 1,
      goal: 'g',
      models: { worker: { model: 'only/worker' } },
    });
    expect(modelOf(pipeline, '1b. Front a — implementar')).toBe('only/worker');
    expect(modelOf(pipeline, '0. Recon do objetivo')).toBeUndefined();
    expect(modelOf(pipeline, '1c. Front a — verificar')).toBeUndefined();
    expect(pipeline.integrationModelId).toBeUndefined();
  });

  // Whitespace-only is "unset" — `resolveDevModels` trims for the same reason.
  it('treats a blank model id as unset', () => {
    const { pipeline } = compileEpochPipeline({
      plan: plan([front('a')]),
      epoch: 1,
      goal: 'g',
      models: { worker: { model: '   ' }, judge: { model: ' spaced/judge ' } },
    });
    expect(modelOf(pipeline, '1b. Front a — implementar')).toBeUndefined();
    expect(modelOf(pipeline, '1c. Front a — verificar')).toBe('spaced/judge');
  });

  it('still compiles to a schema-valid pipeline with every option set', () => {
    const { pipeline } = compileEpochPipeline({
      plan: plan([front('a'), front('b', { dependsOnFronts: ['a'] })]),
      epoch: 2,
      goal: 'g',
      models: FULL_POLICY,
      sessionId: 'sess-1',
      verifyCommands: ['npm run typecheck', 'npm test'],
      knowledgeSummary: '3 skills under .agents/skills/',
    });
    expect(PipelineSchema.safeParse(pipeline).success).toBe(true);
    expect(validateTopology(pipeline)).toEqual([]);
  });
});

// --- The per-task review (§1.2 + §1.4b) --------------------------------------

describe('compileEpochPipeline — review spec', () => {
  function reviewOf(fronts: DevFront[] = [front('a')], over: Record<string, unknown> = {}) {
    const { pipeline } = compileEpochPipeline({
      plan: plan(fronts),
      epoch: 1,
      goal: 'construir a coisa',
      ...over,
    });
    const work = pipeline.steps.find((s) => s.name === '1b. Front a — implementar')!;
    if (!isWorkStep(work) || !work.review) throw new Error('no review on the work step');
    return { pipeline, review: work.review };
  }

  it('attaches a review to the implementar step only', () => {
    const { pipeline, review } = reviewOf([front('a'), front('b')]);
    expect(review.prompt.length).toBeGreaterThan(0);

    const reviewed = pipeline.steps
      .filter(isWorkStep)
      .filter((s) => s.review !== undefined)
      .map((s) => s.name);
    expect(reviewed).toEqual(['1b. Front a — implementar', '2b. Front b — implementar']);
  });

  it('carries the policy explicitly, from the shared defaults', () => {
    const { review } = reviewOf();
    expect(review.maxRounds).toBe(DEFAULT_REVIEW_MAX_ROUNDS);
    expect(review.blockOn).toEqual(DEFAULT_REVIEW_BLOCK_ON);
    expect(review.maxFindings).toBe(DEFAULT_REVIEW_MAX_FINDINGS);
    // One shard per task, never a shared file — the same anti-conflict rule
    // the findings protocol uses.
    expect(review.findingsDir).toBe('.huu/dev/epoch-1/a/review');
  });

  it('names the three lenses and points them at the epoch atlas', () => {
    const { review } = reviewOf();
    expect(review.prompt).toContain('correctness');
    expect(review.prompt).toContain('pattern');
    expect(review.prompt).toContain('style');
    // The critic LOADS the standard for style/pattern; it does not invent it.
    expect(review.prompt).toContain('.huu/dev/epoch-1/atlas.md');
    expect(review.prompt).toContain('.huu/dev/goal.md');
  });

  // The five measured defences against spurious blocking (§1.4b). Each of
  // these is a rate, not a preference — an LLM critic's dominant failure mode
  // is rejecting CORRECT code, not missing bugs.
  it('orders the critic: run first, prove, then opine', () => {
    const { review } = reviewOf([front('a')], { verifyCommands: ['npm run typecheck'] });
    expect(review.verifyCommands).toEqual(['npm run typecheck']);
    // 1. run the real gate and paste the output BEFORE any finding
    expect(review.prompt).toMatch(/RUN the commands under <verify-commands> FIRST/);
    expect(review.prompt).toMatch(/paste their real output.*BEFORE writing a single finding/s);
    // 2. proved findings first, opinion after
    expect(review.prompt).toMatch(/proof.*Those come first/s);
    expect(review.prompt).toMatch(/ONLY THEN read the diff/);
    // 3. hard caps
    expect(review.prompt).toContain(`At most ${DEFAULT_REVIEW_MAX_FINDINGS} findings`);
    expect(review.prompt).toContain('severity-descending');
    expect(review.prompt).toContain('≤ 15 lines');
    // 4. the two measured hallucination categories
    expect(review.prompt).toContain('CONCRETE COUNTEREXAMPLE');
    expect(review.prompt).toMatch(/expected output.*actual output/);
    expect(review.prompt).toMatch(/Without one it is a `minor`, not a blocker/);
    expect(review.prompt).toContain('Do NOT invent requirements');
    // 5. abstaining is allowed and cheap
    expect(review.prompt).toContain('I could not verify this');
  });

  it('omits verifyCommands when the caller detected none', () => {
    const { review } = reviewOf();
    expect(review.verifyCommands).toBeUndefined();
    // …and tells the critic where to find them instead of inventing one.
    expect(review.prompt).toContain('never invent one');
  });

  it('quotes the human goal and the front into the critic brief', () => {
    const { review } = reviewOf([front('a', { rationale: 'porque a API é uma unidade' })]);
    expect(review.prompt).toContain('construir a coisa');
    expect(review.prompt).toContain('porque a API é uma unidade');
  });

  it('injects the project knowledge surface when there is one', () => {
    const { review } = reviewOf([front('a')], { knowledgeSummary: '19 skills under .agents/skills/' });
    expect(review.prompt).toContain('19 skills under .agents/skills/');
    // …and stays silent about it when there is none, instead of inviting the
    // critic to hold the diff against a convention set that does not exist.
    expect(reviewOf().review.prompt).not.toContain('documented knowledge surface');
  });

  it('tells the worker its diff will be reviewed', () => {
    const { pipeline } = compile([front('a')]);
    const work = pipeline.steps.find((s) => s.name === '1b. Front a — implementar')!;
    expect(isWorkStep(work) && work.prompt).toMatch(/REVIEWED BEFORE IT MERGES/);
  });
});

// --- Session namespacing (§4.1) ----------------------------------------------

describe('compileEpochPipeline — session namespacing', () => {
  const promptsOf = (pipeline: Pipeline): string =>
    pipeline.steps
      .map((s) => (isCheckStep(s) ? s.condition : s.prompt) + (isWorkStep(s) ? (s.review?.prompt ?? '') : ''))
      .join('\n');

  it('uses the legacy layout when no sessionId is given', () => {
    const { pipeline } = compile([front('a')]);
    const recon = pipeline.steps.find((s) => s.name === '1a. Front a — recon')!;
    expect(isWorkStep(recon) && recon.produces).toBe('.huu/dev/epoch-1/a/tasks.json');
    expect(promptsOf(pipeline)).toContain('.huu/dev/epoch-1/atlas.md');
  });

  it('moves every epoch-scoped path under the session segment', () => {
    const { pipeline } = compileEpochPipeline({
      plan: plan([front('a')]),
      epoch: 1,
      goal: 'g',
      sessionId: 'sess-1',
    });
    const recon = pipeline.steps.find((s) => s.name === '1a. Front a — recon')!;
    const work = pipeline.steps.find((s) => s.name === '1b. Front a — implementar')!;

    expect(isWorkStep(recon) && recon.produces).toBe('.huu/dev/sess-1/epoch-1/a/tasks.json');
    expect(isWorkStep(work) && work.filesFrom).toBe('.huu/dev/sess-1/epoch-1/a/tasks.json');
    expect(isWorkStep(work) && work.review?.findingsDir).toBe('.huu/dev/sess-1/epoch-1/a/review');
    expect(promptsOf(pipeline)).toContain('.huu/dev/sess-1/epoch-1/atlas.md');
  });

  // The split-brain guard: the shared `dev-protocol` blocks still address the
  // legacy paths, so a namespaced epoch would otherwise emit prompts pointing
  // half at one tree and half at the other — and `resolveMemoryFiles` validates
  // nothing beyond `existsSync`, which is how a stale file dispatches a swarm.
  it('leaves NO legacy epoch path anywhere in a namespaced epoch', () => {
    const { pipeline } = compileEpochPipeline({
      plan: plan([front('a'), front('b')]),
      epoch: 2,
      goal: 'g',
      sessionId: 'sess-1',
    });
    const text = promptsOf(pipeline);
    expect(text).not.toContain('.huu/dev/epoch-2');
    expect(text).toContain('.huu/dev/sess-1/epoch-2');
    // The findings shards are namespaced too, one per writer as before.
    expect(text).toContain('.huu/dev/sess-1/epoch-2/findings/a-recon.json');
    expect(text).toContain('.huu/dev/sess-1/epoch-2/findings/recon.json');
  });

  // The session INDEX stays at the root: `journal.md` is the one file that must
  // accumulate across sessions, and `goal.md`/`state.json` point INTO them.
  it('keeps goal.md, state.json and journal.md at the blackboard root', () => {
    const { pipeline } = compileEpochPipeline({
      plan: plan([front('a')]),
      epoch: 1,
      goal: 'g',
      sessionId: 'sess-1',
    });
    const text = promptsOf(pipeline);
    expect(text).toContain('.huu/dev/goal.md');
    expect(text).toContain('.huu/dev/journal.md');
    expect(text).toContain('.huu/dev/state.json');
    expect(text).not.toContain('.huu/dev/sess-1/goal.md');
    expect(text).not.toContain('.huu/dev/sess-1/journal.md');
  });

  it('rejects a sessionId that could escape or collapse the namespace', () => {
    for (const bad of ['', '..', 'a/b', 'has space']) {
      expect(() =>
        compileEpochPipeline({ plan: plan([front('a')]), epoch: 1, goal: 'g', sessionId: bad }),
      ).toThrow(/invalid dev session id/);
    }
  });
});

// --- Front repair is untouched by the new options ----------------------------

describe('compileEpochPipeline — plan repair with the new options set', () => {
  const withOptions = (fronts: DevFront[]) =>
    compileEpochPipeline({
      plan: plan(fronts),
      epoch: 1,
      goal: 'g',
      models: FULL_POLICY,
      sessionId: 'sess-1',
      verifyCommands: ['npm test'],
    });

  it('still truncates past the front cap', () => {
    const { frontOrder, warnings } = withOptions([
      front('a'),
      front('b'),
      front('c'),
      front('d'),
      front('e'),
    ]);
    expect(frontOrder).toHaveLength(4);
    expect(warnings.some((w) => /truncated to 4/.test(w))).toBe(true);
  });

  it('still drops duplicate front ids', () => {
    const { pipeline, warnings } = withOptions([front('a'), front('a')]);
    expect(warnings.some((w) => /duplicate front id "a"/.test(w))).toBe(true);
    const names = pipeline.steps.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('still breaks a cycle instead of failing', () => {
    const { pipeline, warnings } = withOptions([
      front('a', { dependsOnFronts: ['b'] }),
      front('b', { dependsOnFronts: ['a'] }),
    ]);
    expect(warnings.some((w) => /break a cycle/.test(w))).toBe(true);
    expect(validateTopology(pipeline)).toEqual([]);
  });

  it('still refuses an empty plan', () => {
    expect(() => withOptions([])).toThrow(/no fronts/);
  });
});

describe('compiled epoch under the real wave walk', () => {
  // Simulates runDagWaves' bookkeeping (without agents) to prove the graph
  // terminates and every step gets a turn.
  function walk(pipeline: Pipeline): string[] {
    const steps = pipeline.steps;
    const done = new Set<string>();
    const pending = new Set(steps.map((s) => s.name));
    const visited: string[] = [];
    let guard = 0;

    while (pending.size > 0 && guard++ < 100) {
      const wave = computeWave(steps, done, pending);
      if (wave.length === 0) break;
      for (const step of wave) {
        visited.push(step.name);
        pending.delete(step.name);
        done.add(step.name);
      }
    }
    return visited;
  }

  it('reaches every step and terminates', () => {
    const { pipeline } = compile([front('a'), front('b'), front('c'), front('d')]);
    const visited = walk(pipeline);
    expect(new Set(visited)).toEqual(new Set(pipeline.steps.map((s) => s.name)));
  });

  it('never batches a check with a work step', () => {
    const { pipeline } = compile([front('a'), front('b')]);
    const steps = pipeline.steps;
    const done = new Set<string>();
    const pending = new Set(steps.map((s) => s.name));
    let guard = 0;

    while (pending.size > 0 && guard++ < 100) {
      const wave = computeWave(steps, done, pending);
      if (wave.length === 0) break;
      if (wave.some(isCheckStep)) expect(wave).toHaveLength(1);
      for (const step of wave) {
        pending.delete(step.name);
        done.add(step.name);
      }
    }
  });
});

// --- Selectable methodologies (Onda 1) ---------------------------------------
//
// Every option is ADDITIVE structure: absent ⇒ the compiled pipeline is
// byte-identical to the one this file always emitted (the same contract the
// `models` block above proves). Each block covers what the option ADDS.

function compileWith(over: Record<string, unknown>, fronts: DevFront[] = [front('a')]) {
  return compileEpochPipeline({ plan: plan(fronts), epoch: 1, goal: 'construir a coisa', ...over });
}

/** Simulates runDagWaves' bookkeeping (no agents) — proves the graph terminates and reaches every step. */
function walkAll(pipeline: Pipeline): string[] {
  const steps = pipeline.steps;
  const done = new Set<string>();
  const pending = new Set(steps.map((s) => s.name));
  const visited: string[] = [];
  let guard = 0;
  while (pending.size > 0 && guard++ < 100) {
    const wave = computeWave(steps, done, pending);
    if (wave.length === 0) break;
    for (const step of wave) {
      visited.push(step.name);
      pending.delete(step.name);
      done.add(step.name);
    }
  }
  return visited;
}

function expectForwardDefaultsAndBackwardReworks(pipeline: Pipeline) {
  const indexByName = new Map(pipeline.steps.map((s, i) => [s.name, i]));
  for (const check of pipeline.steps.filter(isCheckStep)) {
    const defaults = check.outcomes.filter((o) => o.default);
    expect(defaults, `check "${check.name}" must have exactly one default`).toHaveLength(1);
    expect(indexByName.get(defaults[0]!.nextStepName)!).toBeGreaterThan(indexByName.get(check.name)!);
    // The NON-default arm, whatever it is called — `--debate` labels its pair
    // `convergiu`/`contestado`, and the invariant is about DIRECTION, never
    // about a word. Matching on the literal "rework" would silently skip any
    // check that names its loop something else.
    const back = check.outcomes.find((o) => !o.default)!;
    expect(back, `check "${check.name}" must have a non-default arm`).toBeDefined();
    expect(indexByName.get(back.nextStepName)!).toBeLessThan(indexByName.get(check.name)!);
  }
}

describe('compileEpochPipeline — methodology byte-identity', () => {
  // THE prime directive: no methodology ⇒ the pipeline this file always
  // emitted, byte for byte. Mirrors the `models` compatibility proofs.
  it('is byte-identical when methodology is absent, even with command subsets passed', () => {
    const plain = compile([front('a'), front('b', { dependsOnFronts: ['a'] })]);
    const withExtras = compileWith(
      { lintCommands: ['npm run typecheck'], testCommands: ['npm test'] },
      [front('a'), front('b', { dependsOnFronts: ['a'] })],
    );
    expect(JSON.stringify(withExtras.pipeline)).toBe(JSON.stringify(plain.pipeline));
  });

  it('is byte-identical when every methodology flag is unset', () => {
    const plain = compile([front('a'), front('b')]);
    const empty = compileWith({ methodology: {} }, [front('a'), front('b')]);
    const allOff = compileWith(
      {
        methodology: {
          tdd: false,
          lintGate: false,
          standards: false,
          planReview: false,
          writeSet: false,
          debate: false,
        },
      },
      [front('a'), front('b')],
    );
    expect(JSON.stringify(empty.pipeline)).toBe(JSON.stringify(plain.pipeline));
    expect(JSON.stringify(allOff.pipeline)).toBe(JSON.stringify(plain.pipeline));
  });
});

describe('compileEpochPipeline — tdd', () => {
  const tddOpts = { methodology: { tdd: true }, testCommands: ['npm test'] };

  it('splits the front work into tests → implementar, judge at {k}d', () => {
    const { pipeline } = compileWith(tddOpts);
    const names = pipeline.steps.map((s) => s.name);
    expect(names).toEqual([
      '0. Recon do objetivo',
      '1a. Front a — recon',
      '1b. Front a — testes (TDD)',
      '1c. Front a — implementar',
      '1d. Front a — verificar',
      '2. Consolidar época 1',
      '3. Portão de qualidade',
      '4. Selar época 1',
    ]);
    expect(PipelineSchema.safeParse(pipeline).success).toBe(true);
    expect(validateTopology(pipeline)).toEqual([]);
  });

  it('fans BOTH memory steps out over the same tasks.json', () => {
    const { pipeline } = compileWith(tddOpts, [front('a', { maxTasks: 6 })]);
    const tests = pipeline.steps.find((s) => s.name === '1b. Front a — testes (TDD)')!;
    const impl = pipeline.steps.find((s) => s.name === '1c. Front a — implementar')!;
    for (const step of [tests, impl]) {
      expect(isWorkStep(step) && step.scope).toBe('memory');
      expect(isWorkStep(step) && step.filesFrom).toBe('.huu/dev/epoch-1/a/tasks.json');
      expect(isWorkStep(step) && step.maxFiles).toBe(6);
    }
    expect(tests.dependsOn).toEqual(['1a. Front a — recon']);
    expect(impl.dependsOn).toEqual(['1b. Front a — testes (TDD)']);
  });

  it('instructs the red phase in the tests step and forbids implementation', () => {
    const { pipeline } = compileWith(tddOpts);
    const tests = pipeline.steps.find((s) => s.name === '1b. Front a — testes (TDD)')!;
    const prompt = isWorkStep(tests) && tests.prompt;
    expect(prompt).toContain('RED phase of TDD');
    expect(prompt).toContain('CAPTURE THE FAILING OUTPUT');
    expect(prompt).toContain('FORBIDDEN IN THIS STEP');
    expect(prompt).toMatch(/Writing or modifying ANY implementation file/);
    expect(prompt).toContain('npm test');
  });

  it('freezes the test files in the implementar step and demands green at the end', () => {
    const { pipeline } = compileWith(tddOpts);
    const impl = pipeline.steps.find((s) => s.name === '1c. Front a — implementar')!;
    const prompt = isWorkStep(impl) && impl.prompt;
    expect(prompt).toContain('GREEN phase of TDD');
    expect(prompt).toContain('THE TEST FILES ARE FROZEN');
    // A test may only change through the TESTS step's critic loop.
    expect(prompt).toMatch(/critic loop's fix turns of the TESTS step/);
    expect(prompt).toContain('RUN the test command');
  });

  it('adds the TDD clauses to the front judge and reworks to implementar', () => {
    const { pipeline } = compileWith(tddOpts);
    const verify = pipeline.steps.find((s) => s.name === '1d. Front a — verificar')!;
    expect(verify.dependsOn).toEqual(['1c. Front a — implementar']);
    expect(isCheckStep(verify) && verify.condition).toContain('UNCHANGED since that step committed them');
    expect(isCheckStep(verify) && verify.condition).toContain('has a corresponding test');
    expect(isCheckStep(verify) && verify.outcomes).toEqual([
      { label: 'approved', nextStepName: '2. Consolidar época 1', default: true },
      { label: 'rework', nextStepName: '1c. Front a — implementar' },
    ]);
  });

  it('audits each phase with its own critic lens and the test command as the anchor', () => {
    const { pipeline } = compileWith(tddOpts);
    const tests = pipeline.steps.find((s) => s.name === '1b. Front a — testes (TDD)')!;
    const impl = pipeline.steps.find((s) => s.name === '1c. Front a — implementar')!;
    if (!isWorkStep(tests) || !tests.review) throw new Error('tests step must carry a review');
    if (!isWorkStep(impl) || !impl.review) throw new Error('implementar step must carry a review');

    const testsReview = tests.review;
    expect(testsReview.prompt).toContain('THE TDD CONTRACT');
    // The red-phase INVERSION: a failing test run is the proof, not a finding.
    expect(testsReview.prompt).toContain('EXPECTED TO FAIL');
    // Only the test command anchors the red phase — build/lint fail spuriously.
    expect(testsReview.verifyCommands).toEqual(['npm test']);

    const implReview = impl.review;
    expect(implReview.prompt).toContain('THE TDD CONTRACT');
    expect(implReview.prompt).toContain('FROZEN');
    expect(implReview.verifyCommands).toContain('npm test');
    // Any methodology on ⇒ blockers park for a human, never a silent waive.
    expect(implReview.onBlocked).toBe('hold');
    expect(testsReview.onBlocked).toBe('hold');
  });

  it('walks the real wave scheduler to completion', () => {
    const { pipeline } = compileWith(tddOpts, [front('a'), front('b')]);
    expect(new Set(walkAll(pipeline))).toEqual(new Set(pipeline.steps.map((s) => s.name)));
    expectForwardDefaultsAndBackwardReworks(pipeline);
  });
});

describe('compileEpochPipeline — lintGate', () => {
  it('stamps the merge gate from the lint/typecheck subset, joined with &&', () => {
    const { pipeline } = compileWith({
      methodology: { lintGate: true },
      lintCommands: ['npm run lint', 'npm run typecheck'],
    });
    expect(pipeline.mergeGate).toBe('npm run lint && npm run typecheck');
    expect(PipelineSchema.safeParse(pipeline).success).toBe(true);
  });

  it('omits the gate and warns when no lint command was extracted', () => {
    const { pipeline, warnings } = compileWith({ methodology: { lintGate: true } });
    expect(pipeline.mergeGate).toBeUndefined();
    expect(warnings.some((w) => /lintGate is on but no lint\/typecheck commands/.test(w))).toBe(true);
  });

  it('ignores lintCommands entirely when the option is off', () => {
    const { pipeline, warnings } = compileWith({ lintCommands: ['npm run typecheck'] });
    expect(pipeline.mergeGate).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it('holds blockers for a human when the gate is on', () => {
    const { pipeline } = compileWith({ methodology: { lintGate: true }, lintCommands: ['npm run typecheck'] });
    const work = pipeline.steps.find((s) => s.name === '1b. Front a — implementar')!;
    expect(isWorkStep(work) && work.review?.onBlocked).toBe('hold');
  });
});

describe('compileEpochPipeline — standards', () => {
  function reviewPrompt(over: Record<string, unknown>) {
    const { pipeline } = compileWith(over);
    const work = pipeline.steps.find((s) => s.name === '1b. Front a — implementar')!;
    return isWorkStep(work) && work.review!.prompt;
  }

  it('adds the declared-standards rubric to the critic brief', () => {
    const prompt = reviewPrompt({ methodology: { standards: true } });
    expect(prompt).toContain('THE DECLARED STANDARDS');
    // The atlas conventions AND the project's own constitution are THE standard.
    expect(prompt).toContain('.huu/dev/epoch-1/atlas.md');
    expect(prompt).toContain('AGENTS.md');
    // Anti-nitpick: only correctness or a cited declared standard — never taste.
    expect(prompt).toMatch(/Report ONLY violations of correctness or of a declared standard/);
    // The rubric shares the critic's coordinator rules VERBATIM — one source
    // of truth (`review-agent.ts`), so the two prompts can never drift apart.
    expect(prompt).toContain(COORDINATOR_RULES);
    expect(prompt).toContain('Never hand off understanding to another worker.');
  });

  it('leaves the critic brief untouched when the option is off', () => {
    const prompt = reviewPrompt({});
    expect(prompt).not.toContain('DECLARED STANDARDS');
    expect(prompt).not.toContain('rubber-stamp');
  });

  it('holds blockers for a human when standards enforcement is on', () => {
    const { pipeline } = compileWith({ methodology: { standards: true } });
    const work = pipeline.steps.find((s) => s.name === '1b. Front a — implementar')!;
    expect(isWorkStep(work) && work.review?.onBlocked).toBe('hold');
  });
});

describe('compileEpochPipeline — writeSet', () => {
  // Looked up by SUFFIX, not by the `{k}b`/`{k}c` prefix: `tdd` renumbers the
  // front's steps, and one of these cases runs with tdd on.
  function stepsFor(over: Record<string, unknown>) {
    const { pipeline } = compileWith(over);
    const work = pipeline.steps.find((s) => s.name.endsWith('— implementar'))!;
    const judge = pipeline.steps.find((s) => s.name.endsWith('— verificar'))!;
    return {
      review: (isWorkStep(work) && work.review!.prompt) as string,
      condition: (isCheckStep(judge) && judge.condition) as string,
    };
  }

  it('makes the ownership list a mechanical set difference for the critic', () => {
    const { review } = stepsFor({ methodology: { writeSet: true } });
    expect(review).toContain('THE DECLARED WRITE SET');
    expect(review).toContain('Files this task OWNS');
    expect(review).toContain('git diff --name-only');
    // The exclusions must mirror `writeSetViolations` in review-agent.ts —
    // huu's scratch tree is written BY INSTRUCTION, so counting it would make
    // every task a violator of itself.
    expect(review).toContain('.huu/');
    expect(review).toContain('.env.huu');
    // Blocking, and asymmetric: an undeclared write blocks, an unused
    // declaration does not.
    expect(review).toMatch(/left over is a `blocker`/);
    expect(review).toMatch(/converse is NOT a finding/);
  });

  it('adds a write-set clause to the front judge, numbered from the array', () => {
    const { condition } = stepsFor({ methodology: { writeSet: true } });
    expect(condition).toContain('5) Every file this front committed is covered by');
    expect(condition).toContain('.huu/dev/epoch-1/a/T-*.md');
    // Base clauses keep their numbers and their text.
    expect(condition).toContain('1) a está pronto');
    expect(condition).toContain('4) No task left a placeholder');
  });

  it('numbers its clause AFTER tdd when both are on — no two clauses share a number', () => {
    const { condition } = stepsFor({
      methodology: { tdd: true, writeSet: true },
      testCommands: ['npm test'],
    });
    expect(condition).toContain('5) The test files this front');
    expect(condition).toContain('6) Every implementation file');
    expect(condition).toContain('7) Every file this front committed is covered by');
    const numbers = [...condition.matchAll(/^(\d+)\) /gm)].map((m) => Number(m[1]));
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('leaves the critic and the judge untouched when the option is off', () => {
    const { review, condition } = stepsFor({});
    expect(review).not.toContain('DECLARED WRITE SET');
    expect(condition).not.toContain('Every file this front committed is covered by');
    expect(condition).toContain('4) No task left a placeholder');
    expect(condition).not.toContain('5)');
  });

  it('holds blockers for a human when write-set enforcement is on', () => {
    const { pipeline } = compileWith({ methodology: { writeSet: true } });
    const work = pipeline.steps.find((s) => s.name === '1b. Front a — implementar')!;
    expect(isWorkStep(work) && work.review?.onBlocked).toBe('hold');
  });

  it('orders the rubrics standards-then-writeSet when both are on', () => {
    const { review } = stepsFor({ methodology: { standards: true, writeSet: true } });
    expect(review.indexOf('THE DECLARED STANDARDS')).toBeLessThan(
      review.indexOf('THE DECLARED WRITE SET'),
    );
  });
});

describe('compileEpochPipeline — changelogGate', () => {
  // The shell gate itself is proven for real in `merge-gate.test.ts`; what is
  // asserted here is the SPLIT — which half needs a detected surface and which
  // half never does.
  function reviewPrompt(over: Record<string, unknown>) {
    const { pipeline } = compileWith(over);
    const work = pipeline.steps.find((s) => s.name.endsWith('— implementar'))!;
    return isWorkStep(work) && work.review!.prompt;
  }

  it('gates commit format with NO project surface required', () => {
    const { pipeline, warnings } = compileWith({ methodology: { changelogGate: true } });
    expect(pipeline.mergeGate).toContain('Conventional Commit');
    // The critic half is what needs a surface — say so instead of demanding an
    // entry in a file this project does not have.
    expect(warnings.join(' ')).toContain('no changelog surface');
  });

  it('names the DETECTED surface in the critic rubric, and warns about none', () => {
    const withSurface = compileWith({
      methodology: { changelogGate: true },
      changelogPaths: ['.changes/', 'CHANGELOG.md'],
    });
    expect(withSurface.warnings).toEqual([]);

    const prompt = reviewPrompt({
      methodology: { changelogGate: true },
      changelogPaths: ['.changes/', 'CHANGELOG.md'],
    });
    expect(prompt).toContain('THE CHANGELOG');
    expect(prompt).toContain('`.changes/`');
    expect(prompt).toContain('`CHANGELOG.md`');
    // Only user-visible change owes an entry — the anti-noise half.
    expect(prompt).toMatch(/internal-only change .* owes NOTHING here/);
    // And the critic must not duplicate the deterministic gate.
    expect(prompt).toMatch(/Do not review their format here/);
  });

  it('ignores changelogPaths entirely when the option is off', () => {
    const prompt = reviewPrompt({ changelogPaths: ['.changes/'] });
    expect(prompt).not.toContain('THE CHANGELOG');
    expect(compileWith({ changelogPaths: ['.changes/'] }).pipeline.mergeGate).toBeUndefined();
  });

  it('holds blockers for a human when changelog discipline is on', () => {
    const { pipeline } = compileWith({ methodology: { changelogGate: true } });
    const work = pipeline.steps.find((s) => s.name.endsWith('— implementar'))!;
    expect(isWorkStep(work) && work.review?.onBlocked).toBe('hold');
  });
});

describe('compileEpochPipeline — diffBudget', () => {
  function reviewPrompt(over: Record<string, unknown>) {
    const { pipeline } = compileWith(over);
    const work = pipeline.steps.find((s) => s.name.endsWith('— implementar'))!;
    return isWorkStep(work) && work.review!.prompt;
  }

  it('gates the size at merge time and needs no discovered command', () => {
    const { pipeline, warnings } = compileWith({ methodology: { diffBudget: true } });
    expect(pipeline.mergeGate).toContain('git diff --numstat');
    expect(pipeline.mergeGate).toContain('exceeds the budget');
    expect(warnings).toEqual([]);
  });

  it('asks the critic for the CUT, not for the count', () => {
    const prompt = reviewPrompt({ methodology: { diffBudget: true } });
    expect(prompt).toContain('THE DIFF BUDGET');
    expect(prompt).toMatch(/name WHERE the natural cut is/);
    // The anti-noise rules: a restated number wastes a capped slot, and a
    // small diff is never itself a finding.
    expect(prompt).toMatch(/only restates the number is useless/);
    expect(prompt).toMatch(/Under budget is never a finding/);
  });

  it('states the same numbers to the critic and to the gate', () => {
    const { pipeline } = compileWith({ methodology: { diffBudget: true } });
    const prompt = reviewPrompt({ methodology: { diffBudget: true } });
    for (const n of ['400', '12']) {
      expect(pipeline.mergeGate, n).toContain(n);
      expect(prompt, n).toContain(n);
    }
  });

  it('leaves both untouched when the option is off', () => {
    expect(compileWith({}).pipeline.mergeGate).toBeUndefined();
    expect(reviewPrompt({})).not.toContain('THE DIFF BUDGET');
  });
});

describe('compileEpochPipeline — fitnessFunctions', () => {
  function reviewPrompt(over: Record<string, unknown>) {
    const { pipeline } = compileWith(over);
    const work = pipeline.steps.find((s) => s.name.endsWith('— implementar'))!;
    return isWorkStep(work) && work.review!.prompt;
  }

  it('runs the discovered architecture command as a merge gate', () => {
    const { pipeline, warnings } = compileWith({
      methodology: { fitnessFunctions: true },
      fitnessCommands: ['npx depcruise --config .dependency-cruiser.js src'],
    });
    expect(pipeline.mergeGate).toBe('npx depcruise --config .dependency-cruiser.js src');
    expect(warnings).toEqual([]);
  });

  // Most repositories have no such command; inventing one would fail every
  // merge for a reason nobody can act on.
  it('invents no gate when the project reported no architecture check', () => {
    const { pipeline, warnings } = compileWith({ methodology: { fitnessFunctions: true } });
    expect(pipeline.mergeGate).toBeUndefined();
    expect(warnings.join(' ')).toContain('no executable architecture check');
    // The rubric still applies — the atlas is a standard even with no tool.
    expect(reviewPrompt({ methodology: { fitnessFunctions: true } })).toContain(
      'THE ARCHITECTURE RULES',
    );
  });

  it('binds the critic to DECLARED rules only, and names the gate when there is one', () => {
    const prompt = reviewPrompt({
      methodology: { fitnessFunctions: true },
      fitnessCommands: ['npm run depcruise'],
    });
    expect(prompt).toContain('.huu/dev/epoch-1/atlas.md');
    expect(prompt).toContain('`npm run depcruise`');
    expect(prompt).toMatch(/crosses a declared boundary.*is a `blocker`/s);
    // The anti-hallucination clause — this is the failure mode the whole
    // critic brief is calibrated against.
    expect(prompt).toMatch(/no declared rule mentions is NOT a violation/);
  });

  it('tells the critic the atlas is the whole standard when there is no command', () => {
    const prompt = reviewPrompt({ methodology: { fitnessFunctions: true } });
    expect(prompt).toContain('no executable architecture check');
  });

  it('ignores fitnessCommands entirely when the option is off', () => {
    const { pipeline } = compileWith({ fitnessCommands: ['npm run depcruise'] });
    expect(pipeline.mergeGate).toBeUndefined();
    expect(reviewPrompt({ fitnessCommands: ['npm run depcruise'] })).not.toContain(
      'THE ARCHITECTURE RULES',
    );
  });

  it('runs before the commit-format gate when both are on', () => {
    const { pipeline } = compileWith({
      methodology: { fitnessFunctions: true, changelogGate: true },
      fitnessCommands: ['npm run depcruise'],
      changelogPaths: ['.changes/'],
    });
    expect(pipeline.mergeGate!.startsWith('npm run depcruise && ')).toBe(true);
    expect(pipeline.mergeGate).toContain('Conventional Commit');
  });
});

describe('compileEpochPipeline — checklistReview', () => {
  function reviewPrompt(over: Record<string, unknown>): string {
    const { pipeline } = compileWith(over);
    const work = pipeline.steps.find((s) => s.name.endsWith('— implementar'))!;
    return (isWorkStep(work) && work.review!.prompt) as string;
  }

  it('gives the critic a fixed enum and a mandatory evidence column', () => {
    const prompt = reviewPrompt({ methodology: { checklistReview: true } });
    expect(prompt).toContain('THE REVIEW CHECKLIST');
    for (const item of ['C1 VERIFY-RAN', 'C2 DONE-WHEN', 'C3 SPEC-ONLY', 'C4 CONVENTIONS', 'C5 NO-PLACEHOLDER']) {
      expect(prompt, item).toContain(item);
    }
    expect(prompt).toMatch(/`PASS`, `FAIL` or `N-A` and nothing else/);
    expect(prompt).toMatch(/no scores, no percentages/);
  });

  // Without a legal way to abstain the model manufactures a PASS — the exact
  // rubber-stamp the review exists to avoid.
  it('makes abstention a first-class answer', () => {
    const prompt = reviewPrompt({ methodology: { checklistReview: true } });
    expect(prompt).toMatch(/cannot settle is `N-A`/);
    expect(prompt).toMatch(/beats a guess in both directions/);
  });

  it('binds findings to failing items in BOTH directions', () => {
    const prompt = reviewPrompt({ methodology: { checklistReview: true } });
    expect(prompt).toMatch(/EVERY finding must correspond to an item you marked `FAIL`/);
    expect(prompt).toMatch(/marked `FAIL` with no finding is an omission/);
  });

  // The output contract has to come after everything it governs.
  it('renders LAST, after every rubric that adds something to check', () => {
    const prompt = reviewPrompt({
      methodology: { standards: true, writeSet: true, checklistReview: true },
    });
    const checklist = prompt.indexOf('THE REVIEW CHECKLIST');
    expect(checklist).toBeGreaterThan(prompt.indexOf('THE DECLARED STANDARDS'));
    expect(checklist).toBeGreaterThan(prompt.indexOf('THE DECLARED WRITE SET'));
  });

  it('leaves the critic brief untouched when the option is off', () => {
    expect(reviewPrompt({})).not.toContain('REVIEW CHECKLIST');
  });
});

describe('compileEpochPipeline — traceability', () => {
  const on = { methodology: { traceability: true } };

  it('inserts the pair between the consolidation and the epoch gate', () => {
    const { pipeline } = compileWith(on, [front('a'), front('b')]);
    expect(pipeline.steps.map((s) => s.name)).toEqual([
      '0. Recon do objetivo',
      '1a. Front a — recon',
      '1b. Front a — implementar',
      '1c. Front a — verificar',
      '2a. Front b — recon',
      '2b. Front b — implementar',
      '2c. Front b — verificar',
      '3. Consolidar época 1',
      'Mapear rastreabilidade',
      'Rastreabilidade completa?',
      '4. Portão de qualidade',
      '5. Selar época 1',
    ]);
  });

  it('compiles a graph the real validator and wave walk accept', () => {
    const { pipeline } = compileWith(on, [front('a'), front('b', { dependsOnFronts: ['a'] })]);
    expect(PipelineSchema.safeParse(pipeline).success).toBe(true);
    expect(validateTopology(pipeline)).toEqual([]);
    expect(new Set(walkAll(pipeline))).toEqual(new Set(pipeline.steps.map((s) => s.name)));
    expectForwardDefaultsAndBackwardReworks(pipeline);
  });

  // A rejected matrix needs a better MATRIX — looping back to the report would
  // iterate on the wrong artefact.
  it('loops rework back to the matrix step, and defaults forward to the gate', () => {
    const { pipeline } = compileWith(on);
    const check = pipeline.steps.find((s) => s.name === 'Rastreabilidade completa?')!;
    expect(isCheckStep(check) && check.dependsOn).toEqual(['Mapear rastreabilidade']);
    expect(isCheckStep(check) && check.outcomes).toEqual([
      { label: 'approved', nextStepName: '3. Portão de qualidade', default: true },
      { label: 'rework', nextStepName: 'Mapear rastreabilidade' },
    ]);
    expect(isCheckStep(check) && check.maxRuns).toBe(2);
  });

  it('keeps the epoch gate downstream of the traceability check', () => {
    const { pipeline } = compileWith(on);
    const gate = pipeline.steps.find((s) => s.name === '3. Portão de qualidade')!;
    expect(gate.dependsOn).toEqual(['2. Consolidar época 1', 'Rastreabilidade completa?']);
  });

  it('demands BOTH directions and refuses prose where a pointer belongs', () => {
    const { pipeline } = compileWith(on);
    const work = pipeline.steps.find((s) => s.name === 'Mapear rastreabilidade')!;
    const prompt = (isWorkStep(work) && work.prompt) as string;
    expect(prompt).toContain('settled by');
    expect(prompt).toContain('criterion it serves');
    expect(prompt).toContain('## Órfãos');
    expect(prompt).toMatch(/never a paragraph of reasoning/);
    // Reporting an orphan is the job; repairing one is not.
    expect(prompt).toMatch(/Do not repair an orphan by widening a criterion/);

    const check = pipeline.steps.find((s) => s.name === 'Rastreabilidade completa?')!;
    const condition = (isCheckStep(check) && check.condition) as string;
    // A declared orphan must NOT fail the gate — hiding it is the failure.
    expect(condition).toMatch(/DECLARED orphans still passes this gate/);
    expect(condition).toContain(COORDINATOR_RULES);
  });

  it('names every front’s spec directory in the matrix prompt', () => {
    const { pipeline } = compileWith(on, [front('a'), front('b')]);
    const work = pipeline.steps.find((s) => s.name === 'Mapear rastreabilidade')!;
    const prompt = (isWorkStep(work) && work.prompt) as string;
    expect(prompt).toContain('.huu/dev/epoch-1/a/T-*.md');
    expect(prompt).toContain('.huu/dev/epoch-1/b/T-*.md');
  });

  it('adds nothing when the option is off', () => {
    const { pipeline } = compileWith({});
    expect(pipeline.steps.map((s) => s.name)).not.toContain('Mapear rastreabilidade');
    expect(pipeline.steps.find((s) => s.name === '3. Portão de qualidade')!.dependsOn).toEqual([
      '2. Consolidar época 1',
    ]);
  });

  it('composes with planReview — two pairs, one graph, still valid', () => {
    const { pipeline } = compileWith(
      { methodology: { traceability: true, planReview: true } },
      [front('a'), front('b')],
    );
    expect(validateTopology(pipeline)).toEqual([]);
    expectForwardDefaultsAndBackwardReworks(pipeline);
    expect(new Set(walkAll(pipeline))).toEqual(new Set(pipeline.steps.map((s) => s.name)));
  });
});

describe('compileEpochPipeline — characterization', () => {
  const on = { methodology: { characterization: true }, testCommands: ['npm test'] };

  it('inserts a caracterizar step before implementar and renumbers the front', () => {
    const { pipeline } = compileWith(on);
    expect(pipeline.steps.map((s) => s.name)).toEqual([
      '0. Recon do objetivo',
      '1a. Front a — recon',
      '1b. Front a — caracterizar',
      '1c. Front a — implementar',
      '1d. Front a — verificar',
      '2. Consolidar época 1',
      '3. Portão de qualidade',
      '4. Selar época 1',
    ]);
  });

  it('fans the baseline out over the SAME task specs as the implementation', () => {
    const { pipeline } = compileWith(on);
    const snap = pipeline.steps.find((s) => s.name.endsWith('— caracterizar'))!;
    const work = pipeline.steps.find((s) => s.name.endsWith('— implementar'))!;
    expect(isWorkStep(snap) && snap.scope).toBe('memory');
    expect(isWorkStep(snap) && snap.filesFrom).toBe('.huu/dev/epoch-1/a/tasks.json');
    expect(isWorkStep(work) && work.filesFrom).toBe(isWorkStep(snap) && snap.filesFrom);
    // The implementation cannot start until the baseline is committed.
    expect(work.dependsOn).toEqual(['1b. Front a — caracterizar']);
  });

  it('forbids behavior change in the baseline step, including a "correct" one', () => {
    const { pipeline } = compileWith(on);
    const snap = pipeline.steps.find((s) => s.name.endsWith('— caracterizar'))!;
    const prompt = (isWorkStep(snap) && snap.prompt) as string;
    expect(prompt).toMatch(/not necessarily correct/);
    expect(prompt).toMatch(/even one that is clearly right/);
    // The defining rule: observe, never predict.
    expect(prompt).toMatch(/A snapshot you predicted instead of observed is worthless/);
    // Green against UNCHANGED code is the proof, the inverse of TDD's red.
    expect(prompt).toMatch(/confirm the characterization tests PASS against the unchanged code/);
  });

  it('gives the baseline critic the inverted lens and only the test command', () => {
    const { pipeline } = compileWith(on);
    const snap = pipeline.steps.find((s) => s.name.endsWith('— caracterizar'))!;
    const review = isWorkStep(snap) ? snap.review! : undefined!;
    expect(review.prompt).toContain('THE CHARACTERIZATION CONTRACT');
    expect(review.prompt).toMatch(/production file in this diff is a `blocker`/);
    // Reporting captured behavior as a defect is out of scope BY CONSTRUCTION.
    expect(review.prompt).toMatch(/Do NOT report the captured behavior as a defect/);
    expect(review.verifyCommands).toEqual(['npm test']);
  });

  it('freezes the snapshots for the implementation critic unless approved', () => {
    const { pipeline } = compileWith(on);
    const work = pipeline.steps.find((s) => s.name.endsWith('— implementar'))!;
    const prompt = (isWorkStep(work) && work.review!.prompt) as string;
    expect(prompt).toMatch(/SNAPSHOT files are FROZEN unless the change is explicitly approved/);
    expect(prompt).toMatch(/behavior change that erased its own evidence/);
    // An APPROVED change is legitimate — this is not a freeze, it is a signature.
    expect(prompt).toMatch(/changed WITH an approval is legitimate/);
  });

  it('adds a judge clause about silently rewritten snapshots', () => {
    const { pipeline } = compileWith(on);
    const judge = pipeline.steps.find((s) => s.name.endsWith('— verificar'))!;
    const condition = (isCheckStep(judge) && judge.condition) as string;
    expect(condition).toContain('5) The snapshot files this front');
    expect(condition).toMatch(/silently rewritten snapshot is a behavior change nobody signed/);
  });

  it('chains behind tdd — caracterizar, then testes, then implementar', () => {
    const { pipeline } = compileWith({
      methodology: { characterization: true, tdd: true },
      testCommands: ['npm test'],
    });
    expect(pipeline.steps.map((s) => s.name)).toEqual([
      '0. Recon do objetivo',
      '1a. Front a — recon',
      '1b. Front a — caracterizar',
      '1c. Front a — testes (TDD)',
      '1d. Front a — implementar',
      '1e. Front a — verificar',
      '2. Consolidar época 1',
      '3. Portão de qualidade',
      '4. Selar época 1',
    ]);
    // Each link depends on the previous one — no step is orphaned by the other.
    expect(pipeline.steps.find((s) => s.name.endsWith('testes (TDD)'))!.dependsOn).toEqual([
      '1b. Front a — caracterizar',
    ]);
    expect(pipeline.steps.find((s) => s.name.endsWith('— implementar'))!.dependsOn).toEqual([
      '1c. Front a — testes (TDD)',
    ]);
    // Both freeze clauses reach the implementation critic.
    const work = pipeline.steps.find((s) => s.name.endsWith('— implementar'))!;
    const prompt = (isWorkStep(work) && work.review!.prompt) as string;
    expect(prompt).toMatch(/test files are FROZEN/);
    expect(prompt).toMatch(/SNAPSHOT files are FROZEN/);
    expect(validateTopology(pipeline)).toEqual([]);
  });

  it('keeps the plan gate wired to the FIRST step of the chain', () => {
    const { pipeline } = compileWith({
      methodology: { characterization: true, planReview: true },
      testCommands: ['npm test'],
    });
    const snap = pipeline.steps.find((s) => s.name.endsWith('— caracterizar'))!;
    expect(snap.dependsOn).toContain('Plano validado?');
    expect(validateTopology(pipeline)).toEqual([]);
    expect(new Set(walkAll(pipeline))).toEqual(new Set(pipeline.steps.map((s) => s.name)));
  });

  it('adds nothing when the option is off', () => {
    const { pipeline } = compileWith({ testCommands: ['npm test'] });
    expect(pipeline.steps.map((s) => s.name)).not.toContain('1b. Front a — caracterizar');
    const judge = pipeline.steps.find((s) => s.name.endsWith('— verificar'))!;
    expect(isCheckStep(judge) && judge.condition).not.toContain('5)');
  });
});

describe('compileEpochPipeline — front prompt injections (Onda 2.5)', () => {
  const WORKTREE_NOTE =
    'This is a git worktree — an isolated copy of the repository. Run all commands from this directory.';
  const MINIMAL_SCOPE =
    "Don't add features, refactor code, or make 'improvements' beyond what was asked.";

  it('gives both recon templates the exploration discipline', () => {
    const { pipeline } = compile([front('a')]);
    for (const name of ['0. Recon do objetivo', '1a. Front a — recon']) {
      const step = pipeline.steps.find((s) => s.name === name)!;
      const prompt = isWorkStep(step) && step.prompt;
      // The worktree note, verbatim from the front-line leak.
      expect(prompt).toContain(WORKTREE_NOTE);
      // Batch independent tool calls while exploring.
      expect(prompt).toMatch(/Batch independent tool calls into ONE turn/);
      // Durable memory: the files survive context compaction, tool results don't.
      expect(prompt).toMatch(/compacted away later; what lands in the files you write/);
    }
  });

  it('gives the work template the implementation discipline', () => {
    const { pipeline } = compile([front('a')]);
    const work = pipeline.steps.find((s) => s.name === '1b. Front a — implementar')!;
    const prompt = isWorkStep(work) && work.prompt;
    expect(prompt).toContain(WORKTREE_NOTE);
    // Minimal scope, verbatim from the leak.
    expect(prompt).toContain(MINIMAL_SCOPE);
    expect(prompt).toContain("A bug fix doesn't need surrounding code cleaned up.");
    expect(prompt).toContain("A simple feature doesn't need extra configurability.");
    // WHY-only comments.
    expect(prompt).toMatch(/Default to writing no comments\. Only add one when the WHY is non-obvious/);
    // Durable memory into the findings shard.
    expect(prompt).toMatch(/persist every key fact you discovered into your findings shard/);
  });

  it('gives the TDD split steps the same implementation discipline', () => {
    const { pipeline } = compileWith({ methodology: { tdd: true }, testCommands: ['npm test'] });
    for (const name of ['1b. Front a — testes (TDD)', '1c. Front a — implementar']) {
      const step = pipeline.steps.find((s) => s.name === name)!;
      const prompt = isWorkStep(step) && step.prompt;
      expect(prompt).toContain(WORKTREE_NOTE);
      expect(prompt).toContain(MINIMAL_SCOPE);
      expect(prompt).toContain('Default to writing no comments.');
    }
  });

  it('gives every judge the coordinator rules (front, plan gate, epoch gate)', () => {
    const { pipeline } = compileWith({ methodology: { planReview: true } });
    const judges = pipeline.steps.filter((s) => s.type === 'check');
    expect(judges.map((j) => j.name)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('verificar'),
        'Plano validado?',
        expect.stringContaining('Portão de qualidade'),
      ]),
    );
    for (const j of judges) {
      expect(j.type === 'check' && j.condition).toContain(COORDINATOR_RULES);
    }
  });
});

describe('compileEpochPipeline — planReview', () => {
  const prOpts = { methodology: { planReview: true } };

  it('inserts the audit pair after every recon and before any work step', () => {
    const { pipeline } = compileWith(prOpts, [front('a'), front('b')]);
    expect(pipeline.steps.map((s) => s.name)).toEqual([
      '0. Recon do objetivo',
      '1a. Front a — recon',
      '2a. Front b — recon',
      'Revisar as escolhas',
      'Plano validado?',
      '1b. Front a — implementar',
      '1c. Front a — verificar',
      '2b. Front b — implementar',
      '2c. Front b — verificar',
      '3. Consolidar época 1',
      '4. Portão de qualidade',
      '5. Selar época 1',
    ]);
    expect(PipelineSchema.safeParse(pipeline).success).toBe(true);
    expect(validateTopology(pipeline)).toEqual([]);
  });

  it('wires the gate so no work step can start before it routes', () => {
    const { pipeline } = compileWith(prOpts, [front('a'), front('b')]);
    const review = pipeline.steps.find((s) => s.name === 'Revisar as escolhas')!;
    expect(review.dependsOn).toEqual(['1a. Front a — recon', '2a. Front b — recon']);

    const check = pipeline.steps.find((s) => s.name === 'Plano validado?')!;
    expect(check.dependsOn).toEqual(['Revisar as escolhas']);
    expect(isCheckStep(check) && check.maxRuns).toBe(2);
    // approved is the DEFAULT and points forward at the fan-out (cap ⇒ forward
    // with findings recorded — never an infinite loop); rework loops to recon.
    expect(isCheckStep(check) && check.outcomes).toEqual([
      { label: 'approved', nextStepName: '1b. Front a — implementar', default: true },
      { label: 'rework', nextStepName: '0. Recon do objetivo' },
    ]);

    for (const workName of ['1b. Front a — implementar', '2b. Front b — implementar']) {
      const work = pipeline.steps.find((s) => s.name === workName)!;
      expect(work.dependsOn).toContain('Plano validado?');
    }
  });

  it('makes the auditor read the atlas, the goal and every spec — and check the DECLARED write-set disjointness', () => {
    const { pipeline } = compileWith(prOpts, [front('a'), front('b')]);
    const review = pipeline.steps.find((s) => s.name === 'Revisar as escolhas')!;
    const prompt = isWorkStep(review) && review.prompt;
    expect(prompt).toContain('.huu/dev/epoch-1/atlas.md');
    expect(prompt).toContain('.huu/dev/goal.md');
    expect(prompt).toContain('.huu/dev/epoch-1/a/tasks.json');
    expect(prompt).toContain('.huu/dev/epoch-1/b/tasks.json');
    expect(prompt).toContain('.huu/dev/epoch-1/a/T-*.md');
    expect(prompt).toContain('.huu/dev/epoch-1/b/T-*.md');
    // The partition proof the driver lost in Onda 0, now a compiled clause.
    expect(prompt).toContain('DECLARED WRITE-SET DISJOINTNESS');
    // Findings land in the shared-memory tree, where the epoch gate reads them.
    expect(prompt).toContain('.huu/dev/epoch-1/plan-review.md');
    expect(prompt).toContain('.huu/dev/epoch-1/findings/plan-review.json');
    // Anti-nitpick: structural defects, not re-planning.
    expect(prompt).toContain('Anti-nitpick');

    const check = pipeline.steps.find((s) => s.name === 'Plano validado?')!;
    expect(isCheckStep(check) && check.condition).toContain('.huu/dev/epoch-1/plan-review.md');
    expect(isCheckStep(check) && check.condition).toContain('write-set disjointness');
  });

  it('emits a dependent front AFTER its dependency judge — gated transitively, never in a cycle', () => {
    const { pipeline } = compileWith(prOpts, [front('a'), front('b', { dependsOnFronts: ['a'] })]);
    expect(pipeline.steps.map((s) => s.name)).toEqual([
      '0. Recon do objetivo',
      '1a. Front a — recon',
      'Revisar as escolhas',
      'Plano validado?',
      '1b. Front a — implementar',
      '1c. Front a — verificar',
      '2a. Front b — recon',
      '2b. Front b — implementar',
      '2c. Front b — verificar',
      '3. Consolidar época 1',
      '4. Portão de qualidade',
      '5. Selar época 1',
    ]);
    // The audit can only wait on recons that exist before the fan-out.
    const review = pipeline.steps.find((s) => s.name === 'Revisar as escolhas')!;
    expect(review.dependsOn).toEqual(['1a. Front a — recon']);
    // The dependent front is gated through its chain: recon → dep judge →
    // dep work → plan check.
    const depRecon = pipeline.steps.find((s) => s.name === '2a. Front b — recon')!;
    expect(depRecon.dependsOn).toEqual(['0. Recon do objetivo', '1c. Front a — verificar']);
    const depWork = pipeline.steps.find((s) => s.name === '2b. Front b — implementar')!;
    expect(depWork.dependsOn).toEqual(['2a. Front b — recon']);

    expect(PipelineSchema.safeParse(pipeline).success).toBe(true);
    expect(validateTopology(pipeline)).toEqual([]);
  });

  it('walks the real wave scheduler: the check always precedes every work step', () => {
    const { pipeline } = compileWith(prOpts, [front('a'), front('b', { dependsOnFronts: ['a'] }), front('c')]);
    const visited = walkAll(pipeline);
    expect(new Set(visited)).toEqual(new Set(pipeline.steps.map((s) => s.name)));
    const checkAt = visited.indexOf('Plano validado?');
    expect(checkAt).toBeGreaterThan(-1);
    visited.forEach((name, i) => {
      if (name.includes('— implementar')) expect(i).toBeGreaterThan(checkAt);
    });
    expectForwardDefaultsAndBackwardReworks(pipeline);
  });

  it('namespaces the audit pair under the session segment', () => {
    const { pipeline } = compileWith({ ...prOpts, sessionId: 'sess-1' });
    const review = pipeline.steps.find((s) => s.name === 'Revisar as escolhas')!;
    const prompt = isWorkStep(review) && review.prompt;
    expect(prompt).toContain('.huu/dev/sess-1/epoch-1/plan-review.md');
    expect(prompt).toContain('.huu/dev/sess-1/epoch-1/findings/plan-review.json');
    expect(prompt).not.toContain('.huu/dev/epoch-1');
  });
});

// --- The adversarial debate (`--debate`) -------------------------------------
//
// The 13th option, and the only one that compiles a BLOCK of steps rather than
// one. What has to hold: it sits between the recon and the fronts, its gate has
// exactly one FORWARD default, its output reaches the fronts through the only
// channel huu has (a committed file, named in their prompts), and the judge is
// never told whose brief is whose.

describe('compileEpochPipeline — debate', () => {
  const ADVOCATE = 'Sustentar as escolhas';
  const PROSECUTOR = 'Contestar as escolhas';
  const GATE = 'Debate resolvido?';
  const PAIR: DevModelPolicy = {
    advocate: { model: 'defence/opus' },
    prosecutor: { model: 'attack/sol', provider: 'openrouter' },
    judge: { model: 'bench/judge' },
    recon: { model: 'swarm/recon' },
  };
  const debateOpts = { methodology: { debate: true }, models: PAIR };

  it('compiles the block between the global recon and the fan-out', () => {
    const { pipeline } = compileWith(debateOpts, [front('a'), front('b')]);
    expect(pipeline.steps.map((s) => s.name)).toEqual([
      '0. Recon do objetivo',
      ADVOCATE,
      PROSECUTOR,
      GATE,
      '1a. Front a — recon',
      '1b. Front a — implementar',
      '1c. Front a — verificar',
      '2a. Front b — recon',
      '2b. Front b — implementar',
      '2c. Front b — verificar',
      '3. Consolidar época 1',
      '4. Portão de qualidade',
      '5. Selar época 1',
    ]);
    expect(PipelineSchema.safeParse(pipeline).success).toBe(true);
    expect(validateTopology(pipeline)).toEqual([]);
  });

  // The pair is SEQUENTIAL, not a wave: the prosecutor reads a file the
  // advocate wrote, and only a later wave sees a tree where it is merged and
  // committed. Running them in parallel would give the prosecutor nothing.
  it('chains recon → advocate → prosecutor → gate, and gates every front recon', () => {
    const { pipeline } = compileWith(debateOpts, [front('a'), front('b', { dependsOnFronts: ['a'] })]);
    const by = (name: string) => pipeline.steps.find((s) => s.name === name)!;
    expect(by(ADVOCATE).dependsOn).toEqual(['0. Recon do objetivo']);
    expect(by(PROSECUTOR).dependsOn).toEqual([ADVOCATE]);
    expect(by(GATE).dependsOn).toEqual([PROSECUTOR]);
    // Every front's recon waits on the GATE — that edge is the delivery
    // mechanism, not decoration: without it the recon's worktree branches from
    // a tree where the briefs its prompt cites do not exist yet.
    expect(by('1a. Front a — recon').dependsOn).toEqual(['0. Recon do objetivo', GATE]);
    expect(by('2a. Front b — recon').dependsOn).toEqual([
      '0. Recon do objetivo',
      GATE,
      '1c. Front a — verificar',
    ]);
  });

  // MUTATION KILLED: aiming the default at the advocate ("let them settle it")
  // — the default fires on judge failure, on an unknown label AND at the round
  // cap, so a backward default is an epoch that cannot terminate.
  it('routes convergiu FORWARD as the default and contestado BACK to the record', () => {
    const { pipeline } = compileWith(debateOpts, [front('a'), front('b')]);
    const gate = pipeline.steps.find((s) => s.name === GATE)!;
    expect(isCheckStep(gate)).toBe(true);
    if (!isCheckStep(gate)) return;
    expect(gate.outcomes).toEqual([
      { label: 'convergiu', nextStepName: '1a. Front a — recon', default: true },
      { label: 'contestado', nextStepName: ADVOCATE },
    ]);
    expect(gate.outcomes.filter((o) => o.default)).toHaveLength(1);
    // The round cap. It is a CAP, not a target: hitting it takes the forward
    // default with the record as it stands.
    expect(gate.maxRuns).toBe(2);
  });

  // The one channel that exists. `CheckEvaluationResult.reason` never reaches
  // the next step's prompt, so the debate's whole output has to be files —
  // written by the pair, named to the fronts by path.
  it('writes two committed briefs and names both of them to every front recon', () => {
    const { pipeline } = compileWith(debateOpts, [front('a'), front('b')]);
    const A = '.huu/dev/epoch-1/debate/A.md';
    const B = '.huu/dev/epoch-1/debate/B.md';
    const advocate = pipeline.steps.find((s) => s.name === ADVOCATE)!;
    const prosecutor = pipeline.steps.find((s) => s.name === PROSECUTOR)!;
    expect(isWorkStep(advocate) && advocate.prompt).toContain(`WRITE \`${A}\``);
    expect(isWorkStep(prosecutor) && prosecutor.prompt).toContain(`WRITE \`${B}\``);
    // The prosecutor READS A and is forbidden from editing it — a debate where
    // one side rewrites the other's brief has settled nothing.
    expect(isWorkStep(prosecutor) && prosecutor.prompt).toContain(`Never edit \`${A}\``);
    for (const name of ['1a. Front a — recon', '2a. Front b — recon']) {
      const recon = pipeline.steps.find((s) => s.name === name)!;
      const prompt = isWorkStep(recon) ? recon.prompt : '';
      expect(prompt, name).toContain(A);
      expect(prompt, name).toContain(B);
      expect(prompt, name).toContain('SUSTENTADA');
      // Degradation is stated, not assumed: the gate can forward with a brief
      // missing (judge failure, the round cap), and a recon that then invents
      // a verdict is worse than one that says so.
      expect(prompt, name).toContain('Never invent a verdict');
    }
  });

  // NOT `readOnly`. That flag hands the session a tool allowlist with no
  // `write`, and these steps exist to write a file — `graph-to-pipeline.ts`
  // resolves the same contradiction by DROPPING readOnly from a producer.
  //
  // What `writes` buys HERE, exactly: a DECLARATION of surface, plus
  // `validateTopology`'s static disjunction whenever two CONCURRENT steps
  // declare intersecting globs. These two are not concurrent (the prosecutor
  // `dependsOn` the advocate), so that check has no pair to compare; the
  // runtime partition check returns early too, because `files: []` fans each
  // step out to exactly one task. It is NOT containment — no tool restriction,
  // no critic, no merge gate — and the prose carries the "change no source"
  // half. `0. Recon do objetivo` has had the same shape since dev mode
  // existed; the assertion below pins the declaration, not a sandbox.
  it('declares the debate directory as its write-set instead of going readOnly', () => {
    const { pipeline } = compileWith(debateOpts, [front('a')]);
    for (const name of [ADVOCATE, PROSECUTOR]) {
      const step = pipeline.steps.find((s) => s.name === name)!;
      expect(isWorkStep(step) && step.scope, name).toBe('project');
      expect(isWorkStep(step) && step.writes, name).toEqual(['.huu/dev/epoch-1/debate/**']);
      expect(isWorkStep(step) && step.readOnly, name).toBeUndefined();
      expect(isWorkStep(step) && step.prompt, name).toContain('Change no source');
    }
  });

  it('namespaces both briefs under the session segment', () => {
    const { pipeline } = compileWith({ ...debateOpts, sessionId: 'sess-1' }, [front('a')]);
    const gate = pipeline.steps.find((s) => s.name === GATE)!;
    expect(isCheckStep(gate) && gate.condition).toContain('.huu/dev/sess-1/epoch-1/debate/A.md');
    expect(isCheckStep(gate) && gate.condition).toContain('.huu/dev/sess-1/epoch-1/debate/B.md');
    const recon = pipeline.steps.find((s) => s.name === '1a. Front a — recon')!;
    expect(isWorkStep(recon) && recon.prompt).toContain('.huu/dev/sess-1/epoch-1/debate/A.md');
  });
});

// The property the whole option rests on: the judge cannot map a brief to the
// MODEL that wrote it, so it cannot prefer a family (its own included — in the
// `roster` preset the judge and the advocate are both Opus 5).
describe('compileEpochPipeline — the debate judge is anonymized', () => {
  const GATE = 'Debate resolvido?';
  const PAIR: DevModelPolicy = {
    advocate: { model: 'defence/opus' },
    prosecutor: { model: 'attack/sol' },
    judge: { model: 'bench/judge' },
  };
  const compiled = () =>
    compileWith({ methodology: { debate: true }, models: PAIR }, [front('a')]);

  // MUTATION KILLED: "helpfully" interpolating the routed ids into the gate
  // ("brief A was written by defence/opus"). It reads like provenance and it
  // is exactly the position/family bias the rubric exists to remove.
  it('never names either debater’s model in the gate', () => {
    const gate = compiled().pipeline.steps.find((s) => s.name === GATE)!;
    const condition = isCheckStep(gate) ? gate.condition : '';
    expect(condition).not.toContain('defence/opus');
    expect(condition).not.toContain('attack/sol');
    expect(condition).toContain('NOT told which agent or which MODEL wrote either one');
    // …and it does not claim to hide the ROLES, which are structurally
    // impossible to hide: the very next lines of the gate say A is the
    // decision record and B is the attack on it. MODEL anonymity is the
    // property that fights family bias, and it is the one claimed.
    expect(condition).toContain('Their ROLES are plain from the files themselves');
  });

  // MUTATION KILLED: naming the files `advogado.md` / `promotor.md`. A
  // filename is not something a model can be asked to unsee — a prose
  // instruction afterwards takes nothing back.
  it('names the briefs with neutral letters that carry no role', () => {
    const gate = compiled().pipeline.steps.find((s) => s.name === GATE)!;
    const condition = isCheckStep(gate) ? gate.condition : '';
    expect(condition).toContain('.huu/dev/epoch-1/debate/A.md');
    expect(condition).toContain('.huu/dev/epoch-1/debate/B.md');
    for (const leak of ['advogado.md', 'promotor.md', 'advocate.md', 'prosecutor.md', 'defence.md']) {
      expect(condition, leak).not.toContain(leak);
    }
  });

  // The three biases an LLM judge is measurably prone to, each denied by name.
  it('denies length, order and confidence as evidence', () => {
    const gate = compiled().pipeline.steps.find((s) => s.name === GATE)!;
    const condition = isCheckStep(gate) ? gate.condition : '';
    for (const rule of ['LENGTH IS NOT EVIDENCE', 'ORDER IS NOT EVIDENCE', 'CONFIDENCE IS NOT EVIDENCE']) {
      expect(condition, rule).toContain(rule);
    }
    // And it is not picking a winner: the verdict is about the RECORD.
    expect(condition).toContain('You are not picking a winner');
  });

  // Both writers get the SAME anonymity block, byte for byte. Asymmetric
  // instructions would let the judge tell them apart by SHAPE without being
  // told anything.
  it('forbids self-identification in both briefs, in identical words', () => {
    const { pipeline } = compiled();
    const advocate = pipeline.steps.find((s) => s.name === 'Sustentar as escolhas')!;
    const prosecutor = pipeline.steps.find((s) => s.name === 'Contestar as escolhas')!;
    const marker = '=== ANONYMITY (non-negotiable — this is the point of the exercise) ===';
    const blockOf = (p: string) => p.slice(p.indexOf(marker));
    expect(isWorkStep(advocate) && advocate.prompt).toContain(marker);
    expect(isWorkStep(prosecutor) && prosecutor.prompt).toContain(marker);
    expect(blockOf(isWorkStep(advocate) ? advocate.prompt : '')).toBe(
      blockOf(isWorkStep(prosecutor) ? prosecutor.prompt : ''),
    );
    // Neither writer is told the OTHER side's routed model either.
    for (const step of [advocate, prosecutor]) {
      expect(isWorkStep(step) && step.prompt).not.toContain('defence/opus');
      expect(isWorkStep(step) && step.prompt).not.toContain('attack/sol');
    }
  });

  // The gate checks anonymity itself — a clause it can settle WITHOUT knowing
  // the answer, which is what makes it a legitimate check rather than a wish.
  it('makes the gate itself refuse a brief that signed its author', () => {
    const gate = compiled().pipeline.steps.find((s) => s.name === GATE)!;
    const condition = isCheckStep(gate) ? gate.condition : '';
    expect(condition).toContain('ANONYMITY: neither brief identifies the MODEL that wrote it');
    // …while leaving a model discussed as SUBJECT MATTER alone, or the option
    // would loop forever on a repository whose work is about models.
    expect(condition).toContain('a model discussed as SUBJECT MATTER is fine');
  });
});

// Heterogeneity is the mechanism, not a nicety — and the one way to get it
// wrong produces no error at all. So it produces a WARNING, never a refusal.
describe('compileEpochPipeline — the debate warns when it is a monologue', () => {
  const monologue = /monologue|same model|same family|SAME model/;

  it('warns when neither side is routed — both fall back to the run model', () => {
    const { warnings } = compileWith({ methodology: { debate: true } }, [front('a')]);
    expect(warnings.some((w) => /both fall back to the run model/.test(w))).toBe(true);
  });

  it('warns when both sides are routed to the same id', () => {
    const { warnings } = compileWith(
      {
        methodology: { debate: true },
        models: { advocate: { model: 'one/model' }, prosecutor: { model: 'one/model' } },
      },
      [front('a')],
    );
    expect(warnings.some((w) => monologue.test(w))).toBe(true);
  });

  it('warns when the two ids share a family', () => {
    const { warnings } = compileWith(
      {
        methodology: { debate: true },
        models: { advocate: { model: 'vendor/big' }, prosecutor: { model: 'vendor/small' } },
      },
      [front('a')],
    );
    expect(warnings.some((w) => /same family/.test(w))).toBe(true);
  });

  it('is silent when the two sides come from different families', () => {
    const { warnings } = compileWith(
      {
        methodology: { debate: true },
        models: { advocate: { model: 'defence/opus' }, prosecutor: { model: 'attack/sol' } },
      },
      [front('a')],
    );
    expect(warnings).toEqual([]);
  });

  // MUTATION KILLED: emitting the warning unconditionally. A session with the
  // debate OFF has no debate to be a monologue.
  it('says nothing at all when the debate is off', () => {
    const { warnings } = compileWith({ methodology: { tdd: true }, testCommands: ['npm test'] }, [
      front('a'),
    ]);
    expect(warnings.filter((w) => /debate/.test(w))).toEqual([]);
  });
});

describe('compileEpochPipeline — debate model stamping and composition', () => {
  it('stamps each side with its own role and the gate with the judge', () => {
    const { pipeline } = compileWith(
      {
        methodology: { debate: true },
        models: {
          advocate: { model: 'defence/opus' },
          prosecutor: { model: 'attack/sol' },
          judge: { model: 'bench/judge' },
        },
      },
      [front('a')],
    );
    expect(modelOf(pipeline, 'Sustentar as escolhas')).toBe('defence/opus');
    expect(modelOf(pipeline, 'Contestar as escolhas')).toBe('attack/sol');
    expect(modelOf(pipeline, 'Debate resolvido?')).toBe('bench/judge');
  });

  // A role the policy does not name OMITS `modelId`, so `AppConfig.modelId`
  // stays the single authority — the same contract as every other role.
  it('omits modelId on both sides when nothing routes them', () => {
    const { pipeline } = compileWith({ methodology: { debate: true } }, [front('a')]);
    for (const name of ['Sustentar as escolhas', 'Contestar as escolhas', 'Debate resolvido?']) {
      expect(pipeline.steps.find((s) => s.name === name)!.modelId, name).toBeUndefined();
    }
  });

  // Two options that both insert a block before the fan-out. The debate gates
  // the RECONS and the plan review gates the WORK, so they nest rather than
  // fight — and the whole graph still terminates.
  it('composes with plan-review: debate gates the recons, the plan gate the work', () => {
    const { pipeline } = compileWith(
      { methodology: { debate: true, planReview: true } },
      [front('a'), front('b')],
    );
    expect(pipeline.steps.map((s) => s.name)).toEqual([
      '0. Recon do objetivo',
      'Sustentar as escolhas',
      'Contestar as escolhas',
      'Debate resolvido?',
      '1a. Front a — recon',
      '2a. Front b — recon',
      'Revisar as escolhas',
      'Plano validado?',
      '1b. Front a — implementar',
      '1c. Front a — verificar',
      '2b. Front b — implementar',
      '2c. Front b — verificar',
      '3. Consolidar época 1',
      '4. Portão de qualidade',
      '5. Selar época 1',
    ]);
    expect(validateTopology(pipeline)).toEqual([]);
    expect(new Set(walkAll(pipeline))).toEqual(new Set(pipeline.steps.map((s) => s.name)));
    expectForwardDefaultsAndBackwardReworks(pipeline);
  });

  // The real wave walk: the debate must schedule as three separate waves, and
  // a check is always a singleton wave.
  it('terminates under the real wave scheduler with a check per wave', () => {
    const { pipeline } = compileWith({ methodology: { debate: true } }, [front('a'), front('b')]);
    expect(hasDagEdges(pipeline.steps)).toBe(true);
    const done = new Set<string>();
    const pending = new Set(pipeline.steps.map((s) => s.name));
    const waves: string[][] = [];
    let guard = 0;
    while (pending.size > 0 && guard++ < 50) {
      const wave = computeWave(pipeline.steps, done, pending);
      if (wave.length === 0) break;
      waves.push(wave.map((s) => s.name));
      if (wave.some(isCheckStep)) expect(wave).toHaveLength(1);
      for (const step of wave) {
        pending.delete(step.name);
        done.add(step.name);
      }
    }
    expect(pending.size).toBe(0);
    expect(waves.slice(0, 4)).toEqual([
      ['0. Recon do objetivo'],
      ['Sustentar as escolhas'],
      ['Contestar as escolhas'],
      ['Debate resolvido?'],
    ]);
  });
});

describe('compileEpochPipeline — all methodologies on', () => {
  // Built FROM the registry, not from a literal: this is the case that has to
  // fail the day an option is added without being exercised here, and a
  // hand-written literal simply would not know about it.
  const ALL_ON = Object.fromEntries(DEV_METHODOLOGIES.map((d) => [d.key, true]));

  it('compiles a valid graph with every methodology enabled at once', () => {
    const { pipeline, warnings } = compileWith(
      {
        methodology: ALL_ON,
        lintCommands: ['npm run lint', 'npm run typecheck'],
        testCommands: ['npm test'],
        verifyCommands: ['npm run lint', 'npm test', 'npm run typecheck'],
        changelogPaths: ['.changes/'],
        fitnessCommands: ['npm run depcruise'],
        sessionId: 'sess-1',
        models: FULL_POLICY,
      },
      [front('a'), front('b', { dependsOnFronts: ['a'] }), front('c')],
    );

    expect(pipeline.steps.map((s) => s.name)).toEqual([
      '0. Recon do objetivo',
      'Sustentar as escolhas',
      'Contestar as escolhas',
      'Debate resolvido?',
      '1a. Front a — recon',
      '3a. Front c — recon',
      'Revisar as escolhas',
      'Plano validado?',
      '1b. Front a — caracterizar',
      '1c. Front a — testes (TDD)',
      '1d. Front a — implementar',
      '1e. Front a — verificar',
      '2a. Front b — recon',
      '2b. Front b — caracterizar',
      '2c. Front b — testes (TDD)',
      '2d. Front b — implementar',
      '2e. Front b — verificar',
      '3b. Front c — caracterizar',
      '3c. Front c — testes (TDD)',
      '3d. Front c — implementar',
      '3e. Front c — verificar',
      '4. Consolidar época 1',
      'Mapear rastreabilidade',
      'Rastreabilidade completa?',
      '5. Portão de qualidade',
      '6. Selar época 1',
    ]);

    expect(PipelineSchema.safeParse(pipeline).success).toBe(true);
    expect(validateTopology(pipeline)).toEqual([]);
    // Every gate-shaped option contributes to the ONE mergeGate field, in
    // registry order, and none of them erases another.
    expect(pipeline.mergeGate!.startsWith('npm run lint && npm run typecheck && ')).toBe(true);
    for (const fragment of ['npm run depcruise', 'Conventional Commit', 'git diff --numstat']) {
      expect(pipeline.mergeGate, fragment).toContain(fragment);
    }
    // With every surface supplied, a fully-enabled epoch compiles clean.
    expect(warnings).toEqual([]);

    // Every critic carries the hold escape + both rubrics.
    for (const step of pipeline.steps.filter(isWorkStep).filter((s) => s.review)) {
      expect(step.review!.onBlocked).toBe('hold');
      expect(step.review!.prompt).toContain('THE DECLARED STANDARDS');
      expect(step.review!.prompt).toContain('THE DECLARED WRITE SET');
    }

    // Every front judge numbers its clauses contiguously — the proof that two
    // clause-appending methodologies never collide on a number.
    for (const check of pipeline.steps.filter(isCheckStep).filter((s) => s.name.endsWith('— verificar'))) {
      const numbers = [...check.condition.matchAll(/^(\d+)\) /gm)].map((m) => Number(m[1]));
      expect(numbers).toEqual(numbers.map((_, i) => i + 1));
    }

    // The whole graph terminates under the real wave walk and every check is
    // a forward-default/backward-rework pair.
    expect(new Set(walkAll(pipeline))).toEqual(new Set(pipeline.steps.map((s) => s.name)));
    expectForwardDefaultsAndBackwardReworks(pipeline);
  });
});

// ---------------------------------------------------------------------------
// Prompt-cache prefix. The swarm — N agents × long prompts — is where the token
// bill actually is, and it was exactly where fixed and variable text were
// interleaved freely, so no two agents shared a prefix at all.
// ---------------------------------------------------------------------------

describe('the cacheable prefix of a compiled step prompt', () => {
  const compiled = compileEpochPipeline({
    plan: plan([front('api'), front('web')]),
    epoch: 3,
    goal: 'construir a coisa',
    routerPrefix: ROUTER_PREFIX,
  });
  const prompts = compiled.pipeline.steps
    .filter(isWorkStep)
    .map((s) => s.prompt)
    .filter((p) => p.includes(DEV_STEP_BOUNDARY));

  it('marks the split on every recon and work step', () => {
    // Recon (global + per front) and work (per front) — the steps that fan out
    // or repeat. The tail steps run once each, so a shared prefix buys nothing.
    expect(prompts.length).toBeGreaterThanOrEqual(5);
  });

  it('puts NOTHING epoch- or front-specific above the boundary', () => {
    for (const p of prompts) {
      const head = p.slice(0, p.indexOf(DEV_STEP_BOUNDARY));
      expect(head).not.toContain('epoch 3');
      expect(head).not.toContain('época 3');
      expect(head).not.toContain('"api"');
      expect(head).not.toContain('"web"');
      expect(head).not.toContain('construir a coisa');
      expect(head).not.toContain('$file');
    }
  });

  it('gives the two fronts of one epoch a byte-identical prefix', () => {
    const workHeads = compiled.pipeline.steps
      .filter(isWorkStep)
      .filter((s) => s.scope === 'memory')
      .map((s) => s.prompt.slice(0, s.prompt.indexOf(DEV_STEP_BOUNDARY)));
    expect(workHeads.length).toBe(2);
    expect(workHeads[0]).toBe(workHeads[1]);
    expect(workHeads[0]!.length).toBeGreaterThan(200);
  });

  it('starts at the router pointer, which is shared across the whole session', () => {
    for (const p of prompts) expect(p.startsWith(ROUTER_PREFIX)).toBe(true);
  });

  it('holds with EVERY methodology on — the blocks they inject stay below the line', () => {
    // Each methodology adds prompt text, and each is a chance to reintroduce
    // the interleaving this boundary exists to prevent. Enumerated from the
    // registry so a NEW methodology is covered the day it is declared, not the
    // day someone remembers to widen this test.
    const all = Object.fromEntries(DEV_METHODOLOGIES.map((m) => [m.key, true]));
    const withAll = compileEpochPipeline({
      plan: plan([front('api'), front('web')]),
      epoch: 3,
      goal: 'construir a coisa',
      routerPrefix: ROUTER_PREFIX,
      methodology: all,
      testCommands: ['npm test'],
      lintCommands: ['npm run typecheck'],
    });
    const heads = withAll.pipeline.steps
      .filter(isWorkStep)
      .map((s) => s.prompt)
      .filter((p) => p.includes(DEV_STEP_BOUNDARY))
      .map((p) => p.slice(0, p.indexOf(DEV_STEP_BOUNDARY)));

    expect(heads.length).toBeGreaterThanOrEqual(5);
    for (const head of heads) {
      expect(head).not.toContain('epoch 3');
      expect(head).not.toContain('época 3');
      expect(head).not.toContain('"api"');
      expect(head).not.toContain('"web"');
      expect(head).not.toContain('construir a coisa');
      expect(head).not.toContain('$file');
      expect(head).not.toContain('npm test');
    }
  });

});

// ─────────────────── the node-execution budget (a REAL replay) ──────────────
//
// `EPOCH_MAX_NODE_EXECUTIONS` is not decoration: `runDagWaves` answers a blown
// ceiling with `recordRunError`, so an epoch that exceeds it is LOST — the
// sealing step never runs and every agent already paid for is thrown away.
// The comment on that constant used to carry a hand estimate ("4 fronts + tail
// + rework loops ≈ 26" against a cap of 50) that had drifted ~20 executions
// away from what this compiler could actually emit, and nothing noticed
// because nothing measured.
//
// This block measures. It replays the ACTUAL loop of `runDagWaves` — the same
// `computeWave`, the same `descendantsOf` activation cone, the same
// `runs > maxRuns` forcing — over EVERY methodology combination, and fails if
// any of them stops fitting. Enumerated from the registry, so a NEW
// methodology is covered the day it is declared.

/**
 * The pessimal outcome strategy: every gate takes its BACKWARD arm until its
 * own `maxRuns` forces the forward default. It dominates — a backward arm only
 * ever re-pends nodes, while a forward default aims at a step that is still
 * pending and is therefore a no-op — and it was checked against 20 000 random
 * strategies on the worst combination, which never beat it.
 *
 * Mirrors `runDagWaves` exactly: work waves cost `ready.length` visits, a
 * ready check runs as a singleton, and `runsByStep` is cumulative for the
 * whole run (never reset), which is what bounds every loop.
 */
function replayWorstCaseVisits(pipeline: Pipeline): number {
  const steps = pipeline.steps;
  const done = new Set<string>();
  const pending = new Set(steps.map((s) => s.name));
  const runsByStep = new Map<string, number>();
  const known = new Set(steps.map((s) => s.name));
  let visits = 0;

  const activate = (target: string): void => {
    if (!known.has(target)) return; // the driver warns and ignores
    for (const name of [target, ...descendantsOf(steps, target)]) {
      done.delete(name);
      pending.add(name);
    }
  };

  let guard = 0;
  while (pending.size > 0) {
    if (++guard > 10_000) throw new Error('replay did not terminate');
    const ready = computeWave(steps, done, pending);
    if (ready.length === 0) throw new Error(`deadlock: ${[...pending].join(', ')}`);
    visits += ready.length;
    const first = ready[0]!;
    if (isCheckStep(first)) {
      const runs = (runsByStep.get(first.name) ?? 0) + 1;
      runsByStep.set(first.name, runs);
      pending.delete(first.name);
      done.add(first.name);
      const forward = first.outcomes.find((o) => o.default)!;
      const backward = first.outcomes.find((o) => !o.default);
      const forced = first.maxRuns !== undefined && runs > first.maxRuns;
      activate((forced || !backward ? forward : backward).nextStepName);
      continue;
    }
    for (const step of ready) {
      pending.delete(step.name);
      done.add(step.name);
      if (isWorkStep(step) && step.next !== undefined) activate(step.next);
    }
  }
  return visits;
}

describe('compileEpochPipeline — the node-execution budget', () => {
  const keys = DEV_METHODOLOGIES.map((m) => m.key);
  // The compiler can never be handed more than this: `plan-schema` caps the
  // array and `--fronts` is clamped to it.
  const maxFronts = Array.from({ length: DEV_MAX_FRONTS }, (_, i) =>
    front(String.fromCharCode(97 + i)),
  );

  /** Every subset of the registry, `undefined` for the empty one. */
  function everyCombination(): Array<{ label: string; methodology?: DevMethodology }> {
    const out: Array<{ label: string; methodology?: DevMethodology }> = [];
    for (let mask = 0; mask < 1 << keys.length; mask++) {
      const methodology: DevMethodology = {};
      const on: string[] = [];
      keys.forEach((key, i) => {
        if (mask & (1 << i)) {
          methodology[key] = true;
          on.push(key);
        }
      });
      out.push(
        on.length === 0 ? { label: '(none)' } : { label: on.join('+'), methodology },
      );
    }
    return out;
  }

  // 2^13 compiles cost a few seconds, so they run ONCE in beforeAll with an
  // explicit timeout — long enough for a loaded CI box, and paid once for the
  // whole block instead of per assertion.
  let cached: Array<{ label: string; visits: number; cap: number }>;
  function measureAll(): Array<{ label: string; visits: number; cap: number }> {
    return everyCombination().map(({ label, methodology }) => {
      const { pipeline } = compileEpochPipeline({
        plan: plan(maxFronts),
        epoch: 1,
        goal: 'construir a coisa',
        testCommands: ['npm test'],
        lintCommands: ['npm run typecheck'],
        ...(methodology ? { methodology } : {}),
      });
      return {
        label,
        visits: replayWorstCaseVisits(pipeline),
        cap: pipeline.maxNodeExecutions!,
      };
    });
  }

  beforeAll(() => {
    cached = measureAll();
  }, 120_000);

  const worstCases = (): Array<{ label: string; visits: number; cap: number }> => cached;

  it('fits EVERY methodology combination inside maxNodeExecutions', () => {
    const rows = worstCases();
    expect(rows.length).toBe(1 << keys.length);
    const over = rows.filter((r) => r.visits > r.cap);
    expect(
      over.map((r) => `${r.label}: ${r.visits} > ${r.cap}`),
      'a combination that overflows loses the whole epoch on recordRunError',
    ).toEqual([]);
  });

  // PINNED on purpose. The assertion above only says "it fits"; this one says
  // "and by how much", so a change that quietly eats the headroom shows up in
  // review as a number to justify instead of passing unnoticed. When it moves:
  // re-measure, re-state the margin in the comment on
  // EPOCH_MAX_NODE_EXECUTIONS, and update these numbers in the same commit.
  it('pins the worst case and which combination produces it', () => {
    const rows = [...worstCases()].sort((a, b) => b.visits - a.visits);
    const worst = rows[0]!;
    expect(worst.visits).toBe(79);
    expect(worst.label.split('+').sort()).toEqual(
      ['characterization', 'debate', 'planReview', 'tdd', 'traceability'].sort(),
    );
    expect(worst.cap).toBe(96);
  });

  // The coupling the adversarial review found: `--plan-review`'s rework arm
  // re-pends its target's whole cone, and with the debate hanging off the
  // global recon that cone contained the two debaters — so every plan rework
  // re-argued a design nobody had faulted. Aiming the arm at the debate GATE
  // (same coverage: every first-wave recon waits on it) keeps the briefs.
  it('keeps a plan rework from re-arguing the debate', () => {
    const withBoth = compileEpochPipeline({
      plan: plan(maxFronts),
      epoch: 1,
      goal: 'construir a coisa',
      methodology: { planReview: true, debate: true },
    });
    const planGate = withBoth.pipeline.steps.find((s) => s.name === 'Plano validado?')!;
    const rework = (planGate as { outcomes: Array<{ label: string; nextStepName: string }> }).outcomes
      .find((o) => o.label === 'rework')!;
    expect(rework.nextStepName).toBe('Debate resolvido?');
    // The cone still covers everything the arm exists to re-pend…
    const cone = descendantsOf(withBoth.pipeline.steps, rework.nextStepName);
    expect(cone).toContain('1a. Front a — recon');
    expect(cone).toContain('Revisar as escolhas');
    expect(cone).toContain('Plano validado?');
    // …and no longer the two briefs.
    expect(cone).not.toContain('Sustentar as escolhas');
    expect(cone).not.toContain('Contestar as escolhas');
  });

  // Without the debate the arm must stay exactly where it was: the flag-off
  // pipeline is byte-for-byte what this file always emitted.
  it('leaves the plan rework aimed at the global recon when the debate is off', () => {
    const planOnly = compileEpochPipeline({
      plan: plan(maxFronts),
      epoch: 1,
      goal: 'construir a coisa',
      methodology: { planReview: true },
    });
    const planGate = planOnly.pipeline.steps.find((s) => s.name === 'Plano validado?')!;
    const rework = (planGate as { outcomes: Array<{ label: string; nextStepName: string }> }).outcomes
      .find((o) => o.label === 'rework')!;
    expect(rework.nextStepName).toBe('0. Recon do objetivo');
  });
});

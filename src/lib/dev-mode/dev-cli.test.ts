// Contract tests for the `huu dev` command line.
//
// Two of these are compatibility PINS, not feature tests: `--model=<id>` alone
// must keep parsing exactly as it does today (no routing, no policy), and a
// bare invocation without it must keep the same refusal. Per-role routing is
// additive on top of that or it is a breaking change wearing a feature's hat.
//
// A THIRD pin guards the PARSER's boundary: `parseDevCliArgs` is pure, so it
// still takes every id at face value — the model preflight needs the catalog,
// which is I/O, and it runs one layer out in `runDevCli`. What the parser owns
// is the SHAPE: a bare id, or `<provider>:<id>` when the role has to name the
// endpoint that serves it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEV_METHODOLOGIES, methodologyUsageBlock } from './methodology-registry.js';
import {
  DEV_MODEL_ROLE_FLAGS,
  classifyGraphRef,
  describeEvent,
  formatModelRouting,
  formatPlan,
  offerOrphanLanding,
  offerResume,
  parseDevCliArgs,
  runDevCli,
} from './dev-cli.js';
import { GRAPHS_DIR } from '../dev-graph/graph-store.js';
import { findSample } from '../dev-graph/graph-samples.js';
import type { DevGraph } from '../dev-graph/graph-types.js';
import { runDevMode, type DevModeResult } from './dev-driver.js';
import { DEV_MODEL_ROLES, defaultDevModelPolicy, resolveDevModels } from './dev-model-policy.js';
import type { OrphanBranch } from './orphan-branches.js';
import {
  DEV_DEFAULT_MAX_EPOCHS,
  DEV_MAX_FRONTS,
  DEV_MODEL_PRESETS,
  type DevPlan,
  type DevState,
} from '../types.js';

// `runDevMode` is stubbed so the wiring tests can inspect the exact literal the
// CLI calls it with instead of booting a session.
//
// EVERYTHING ELSE STAYS REAL, and `resolveDevGraph` is why. It is the driver's
// border export: the CLI calls it to refuse a bad drawing BEFORE a session
// opens, and a stub of it would make every `--graph` test assert against a
// fake — including the refusals, which are the whole point. Spreading the
// original also means a future driver export cannot silently vanish from this
// module the way a hand-written factory would drop it.
vi.mock('./dev-driver.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./dev-driver.js')>()),
  runDevMode: vi.fn(),
}));

/** `parseDevCliArgs` or a thrown assertion — keeps the happy path unindented. */
function parseOk(args: string[], backend: 'jcode' | 'stub' = 'jcode') {
  const parsed = parseDevCliArgs(args, backend);
  if (!parsed.ok) throw new Error(`expected a parse, got refusal: ${parsed.message}`);
  return parsed.options;
}

function parseFail(args: string[], backend: 'jcode' | 'stub' = 'jcode'): string {
  const parsed = parseDevCliArgs(args, backend);
  if (parsed.ok) throw new Error('expected a refusal, got a parse');
  return parsed.message;
}

describe('parseDevCliArgs — compatibility with today', () => {
  it('parses the invocation that works today, with NO model policy at all', () => {
    const opts = parseOk(['fazer a coisa', '--model=deepseek/deepseek-v4-pro']);
    expect(opts.goal).toBe('fazer a coisa');
    expect(opts.modelId).toBe('deepseek/deepseek-v4-pro');
    // The whole compatibility promise: no routing flags ⇒ no policy ⇒ every
    // compiled step omits `modelId` and falls back to AppConfig.modelId.
    expect(opts.models).toBeUndefined();
    expect(opts.preset).toBeUndefined();
    expect(opts.methodology).toBeUndefined();
    expect(opts.approveEach).toBe(false);
    expect(opts.resume).toBeUndefined();
    expect(opts.landOrphans).toBe(false);
    expect(opts.maxEpochs).toBe(DEV_DEFAULT_MAX_EPOCHS);
    expect(opts.warnings).toEqual([]);
  });

  it('still refuses a run with no --model and no routing at all', () => {
    const message = parseFail(['fazer a coisa']);
    expect(message).toContain('--model=<id> is required');
    expect(message).toContain('--stub');
  });

  it('keeps --stub defaulting the model, and the other existing flags', () => {
    const opts = parseOk(
      ['fazer a coisa', '--epochs=2', '--fronts=2', '--approve-each', '--skip-knowledge', '--run-dir=/tmp/x'],
      'stub',
    );
    expect(opts.modelId).toBe('stub-model');
    expect(opts.maxEpochs).toBe(2);
    expect(opts.maxFronts).toBe(2);
    expect(opts.approveEach).toBe(true);
    expect(opts.skipKnowledge).toBe(true);
    expect(opts.runDir).toBe('/tmp/x');
  });

  it('rejects a non-positive --epochs and clamps --fronts with a warning', () => {
    expect(parseFail(['g', '--model=m', '--epochs=0'])).toContain('--epochs expects a positive integer');
    const opts = parseOk(['g', '--model=m', `--fronts=${DEV_MAX_FRONTS + 3}`]);
    expect(opts.maxFronts).toBe(DEV_MAX_FRONTS);
    expect(opts.warnings.join(' ')).toContain(`capped at ${DEV_MAX_FRONTS}`);
  });

  it('rejects mutually exclusive flags', () => {
    expect(parseFail(['g', '--model=m', '--approve-each', '--autonomous'])).toContain('mutually exclusive');
    expect(parseFail(['g', '--model=m', '--resume', '--no-resume'])).toContain('--resume and --no-resume');
  });

  it('documents every existing flag in the usage line', () => {
    const usage = parseFail([]);
    for (const flag of [
      '--model=',
      '--models=',
      '--worker-model=',
      '--epochs=',
      '--fronts=',
      '--run-dir=',
      '--approve-each',
      '--autonomous',
      '--skip-knowledge',
      '--resume',
      '--no-resume',
      '--land-orphans',
      '--stub',
      // Methodology flags come from the registry — the list cannot go stale.
      ...DEV_METHODOLOGIES.map((d) => `--${d.flag}`),
    ]) {
      expect(usage).toContain(flag);
    }
  });
});

describe('parseDevCliArgs — model routing', () => {
  it('applies a preset on its own', () => {
    const opts = parseOk(['g', '--model=fallback/one', '--models=hetero']);
    expect(opts.preset).toBe('hetero');
    expect(opts.models).toEqual(defaultDevModelPolicy('jcode', 'hetero'));
    // The preset is a DEEP copy — mutating a route must not corrupt the table.
    opts.models!.worker!.model = 'mutated';
    expect(DEV_MODEL_PRESETS.hetero.worker).not.toBe('mutated');
    expect(defaultDevModelPolicy('jcode', 'hetero').worker!.model).not.toBe('mutated');
  });

  it('lets a per-role flag beat the preset, leaving every other role on it', () => {
    const opts = parseOk([
      'g',
      '--model=fallback/one',
      '--models=hetero',
      `--${DEV_MODEL_ROLE_FLAGS.critic}=deepseek/deepseek-v4-pro`,
    ]);
    expect(opts.models?.critic).toEqual({ model: 'deepseek/deepseek-v4-pro' });
    expect(opts.models?.worker).toEqual(defaultDevModelPolicy('jcode', 'hetero').worker);
    expect(opts.models?.planner).toEqual(defaultDevModelPolicy('jcode', 'hetero').planner);
  });

  it('exposes a flag for every role, and reads each one', () => {
    const args = ['g'];
    for (const role of DEV_MODEL_ROLES) args.push(`--${DEV_MODEL_ROLE_FLAGS[role]}=deepseek/deepseek-v4-pro`);
    const opts = parseOk(args);
    for (const role of DEV_MODEL_ROLES) {
      expect(opts.models?.[role], role).toEqual({ model: 'deepseek/deepseek-v4-pro' });
    }
  });

  it('makes --model OPTIONAL once a preset routes every role', () => {
    const opts = parseOk(['g', '--models=hetero']);
    expect(opts.models).toEqual(defaultDevModelPolicy('jcode', 'hetero'));
    // The run-level fallback still has to be a real id — an unstamped step and
    // the knowledge bootstrap run both use it. The worker's model is it, and it
    // is the bare id: `AppConfig.modelId` has never carried a provider.
    expect(opts.modelId).toBe('deepseek/deepseek-v4-pro');
  });

  it('keeps --model REQUIRED when routing leaves roles uncovered', () => {
    // `uniform` is the empty policy by definition: every role falls back.
    const uniform = parseFail(['g', '--models=uniform']);
    expect(uniform).toContain('--model=<id> is required');
    // A single role flag routes one role and leaves six with no model at all.
    const partial = parseFail(['g', `--${DEV_MODEL_ROLE_FLAGS.critic}=moonshotai/kimi-k2.6`]);
    expect(partial).toContain('--model=<id> is required');
    expect(partial).toContain('unrouted');
    expect(partial).toContain('worker');
  });

  it('rejects an unknown preset and an empty per-role id', () => {
    const bad = parseFail(['g', '--model=m', '--models=cheapest']);
    expect(bad).toContain('--models expects one of');
    for (const name of Object.keys(DEV_MODEL_PRESETS)) expect(bad).toContain(name);
    expect(parseFail(['g', '--model=m', `--${DEV_MODEL_ROLE_FLAGS.worker}=  `])).toContain('expects a model id');
  });

  // A PREFIX WITH NOTHING AFTER IT NAMES NO MODEL. It used to parse as the
  // literal id `"openrouter:"` — accepted by the flag (which only rejects
  // `undefined`), stamped onto every worker step, and sent to the endpoint
  // verbatim. A typo must be a usage error, never an id.
  //
  // MUTATION KILLED: `parseRung` falling through to `{ model: value }` when the
  // tail after a recognized `<provider>:` is empty.
  it('rejects a provider prefix with an empty tail', () => {
    for (const raw of ['openrouter:', 'deepseek:', 'openrouter:   ']) {
      expect(
        parseFail(['g', '--model=m', `--${DEV_MODEL_ROLE_FLAGS.worker}=${raw}`]),
        raw,
      ).toContain('expects a model id');
    }
    // …and a chain whose LAST rung is an empty tail is refused whole: dropping
    // the rung silently would change which model actually runs.
    expect(
      parseFail(['g', '--model=m', `--${DEV_MODEL_ROLE_FLAGS.worker}=a/x, openrouter:`]),
    ).toContain('expects a model id');
    // The nearby legitimate shapes still parse.
    expect(
      parseOk(['g', '--model=m', `--${DEV_MODEL_ROLE_FLAGS.worker}=openrouter:z-ai/glm-5.2`]).models,
    ).toEqual({ worker: { model: 'z-ai/glm-5.2', provider: 'openrouter' } });
    expect(
      parseOk(['g', '--model=m', `--${DEV_MODEL_ROLE_FLAGS.worker}=deepseek/deepseek-r1:free`])
        .models,
    ).toEqual({ worker: { model: 'deepseek/deepseek-r1:free' } });
  });

  // MUTATION KILLED: adding a role to `DevModelRole`, being FORCED to list it
  // in `DEV_MODEL_ROLE_FLAGS` by the compile lock, and giving it a flag
  // spelling nothing reads. The record is total; nothing checked that the
  // string it holds is the string argv is parsed for.
  it('routes EVERY role through its own flag', () => {
    for (const role of DEV_MODEL_ROLES) {
      const flag = DEV_MODEL_ROLE_FLAGS[role];
      const opts = parseOk(['g', '--model=fallback/one', `--${flag}=vendor/${role}`]);
      expect(opts.models, role).toEqual({ [role]: { model: `vendor/${role}` } });
    }
  });

  // The `--debate` pair, spelled out: it is the flag family a user reaches for
  // immediately after typing `--debate`, and routing both sides to ONE family
  // is the single way to get that option wrong with no error to show for it.
  it('routes the debate pair to two families, endpoints pinned', () => {
    const opts = parseOk([
      'g',
      '--model=fallback/one',
      '--advocate-model=openrouter:anthropic/claude-opus-5',
      '--prosecutor-model=openrouter:openai/gpt-5.6-sol',
      '--debate',
    ]);
    expect(opts.models).toEqual({
      advocate: { model: 'anthropic/claude-opus-5', provider: 'openrouter' },
      prosecutor: { model: 'openai/gpt-5.6-sol', provider: 'openrouter' },
    });
    expect(opts.methodology).toEqual({ debate: true });
  });

  it('drops a preset on a backend it cannot serve, and says so', () => {
    const opts = parseOk(['g', '--models=hetero'], 'stub');
    expect(opts.models).toEqual({});
    expect(opts.modelId).toBe('stub-model');
    expect(opts.warnings.join(' ')).toContain('--models=hetero ignorado');
  });
});

describe('parseDevCliArgs — the parser reads SHAPE, the preflight reads catalogs', () => {
  // The parser is PURE: the model preflight needs `recommended-models.json`,
  // which is I/O, so it lives in `runDevCli` and in `runDevMode`. What must NOT
  // happen here is a refusal — an id this parser cannot vouch for still parses,
  // and is judged one layer out where the catalog is readable.
  it('accepts a role id no catalog vouches for — nothing validates it here', () => {
    const opts = parseOk(['g', '--model=deepseek/deepseek-v4-pro', `--${DEV_MODEL_ROLE_FLAGS.worker}=z-ai/glm-5.2`]);
    expect(opts.models?.worker).toEqual({ model: 'z-ai/glm-5.2' });
  });

  // MUTATION KILLED: dropping the `<provider>:` form from `parseModelRoute`, or
  // letting `parseModelFlags` store the raw string. A role could then no longer
  // say which endpoint serves it, and the whole mixed roster collapses back to
  // "one provider per run, ids that die inside the first agent".
  it('reads the endpoint a role pins, and leaves a bare id inheriting the run', () => {
    const opts = parseOk([
      'g',
      '--model=deepseek/deepseek-v4-pro',
      `--${DEV_MODEL_ROLE_FLAGS.critic}=openrouter:anthropic/claude-opus-5`,
      `--${DEV_MODEL_ROLE_FLAGS.worker}=deepseek/deepseek-v4-flash`,
    ]);
    expect(opts.models?.critic).toEqual({
      model: 'anthropic/claude-opus-5',
      provider: 'openrouter',
    });
    expect(opts.models?.worker).toEqual({ model: 'deepseek/deepseek-v4-flash' });
  });

  // MUTATION KILLED: passing `--model` through raw. A prefix copy-pasted out of
  // a preset would become part of the model NAME on the wire, on every step the
  // routing did not stamp.
  it('strips a provider prefix from --model — the run-level id carries none', () => {
    const opts = parseOk(['g', '--model=openrouter:anthropic/claude-opus-5']);
    expect(opts.modelId).toBe('anthropic/claude-opus-5');
    expect(opts.models).toBeUndefined();
  });

  it('parses the planner id the factory default depends on', () => {
    // `z-ai/glm-5.2` never belonged to an agent-backend catalog ON PURPOSE:
    // the blind orchestrator is a structured-output call, not an agent. The
    // shipped `hetero` preset routes the planner there — now saying out loud
    // that only OpenRouter serves it.
    const opts = parseOk(['g', '--model=deepseek/deepseek-v4-pro', `--${DEV_MODEL_ROLE_FLAGS.planner}=z-ai/glm-5.2`]);
    expect(opts.models?.planner).toEqual({ model: 'z-ai/glm-5.2' });
    expect(DEV_MODEL_PRESETS.hetero.planner).toBe('openrouter:z-ai/glm-5.2');
    expect(parseOk(['g', '--models=hetero']).models?.planner).toEqual({
      model: 'z-ai/glm-5.2',
      provider: 'openrouter',
    });
  });

  it('every shipped preset parses on the jcode backend', () => {
    // The list is LITERAL on purpose. Driving it from `Object.keys(
    // DEV_MODEL_PRESETS)` compared the catalogue with itself — `PRESET_NAMES`
    // in `dev-cli.ts` IS those same keys — so a preset added, dropped or
    // renamed could never fail here. Spelled out, the shipped set is a
    // decision this test has to be updated to change.
    const SHIPPED = ['hetero', 'thrifty', 'monoculture', 'roster', 'uniform'] as const;
    expect(Object.keys(DEV_MODEL_PRESETS).sort()).toEqual([...SHIPPED].sort());

    for (const name of SHIPPED) {
      const parsed = parseDevCliArgs(['g', '--model=deepseek/deepseek-v4-pro', `--models=${name}`], 'jcode');
      expect(parsed.ok, `preset ${name}: ${parsed.ok ? '' : parsed.message}`).toBe(true);
    }
  });

  it('applies a per-role flag on ANY backend, unlike a preset', () => {
    // A preset is dropped on a backend that cannot serve its ids (pinned
    // above); a flag the human typed for one role is honored everywhere,
    // because a custom deployment id in a worker slot is legitimate.
    const opts = parseOk(['g', `--${DEV_MODEL_ROLE_FLAGS.worker}=vendor/custom-deployment`, '--model=m'], 'stub');
    expect(opts.models?.worker).toEqual({ model: 'vendor/custom-deployment' });
  });
});

describe('parseDevCliArgs — methodology flags', () => {
  // Driven from the registry so a new option cannot ship without a flag that
  // reaches the parser — the whole point of having one declaration surface.
  it('sets each key from its own flag, and ONLY that key', () => {
    for (const def of DEV_METHODOLOGIES) {
      expect(parseOk(['g', `--${def.flag}`], 'stub').methodology, def.flag).toEqual({
        [def.key]: true,
      });
    }
  });

  it('combines every flag into a single object', () => {
    const flags = DEV_METHODOLOGIES.map((d) => `--${d.flag}`);
    const opts = parseOk(['g', ...flags], 'stub');
    expect(opts.methodology).toEqual(Object.fromEntries(DEV_METHODOLOGIES.map((d) => [d.key, true])));
  });

  it('gives every option a UNIQUE key and flag', () => {
    expect(new Set(DEV_METHODOLOGIES.map((d) => d.key)).size).toBe(DEV_METHODOLOGIES.length);
    expect(new Set(DEV_METHODOLOGIES.map((d) => d.flag)).size).toBe(DEV_METHODOLOGIES.length);
  });

  it('lists every flag in the usage text, with a gap after the longest one', () => {
    const usage = methodologyUsageBlock();
    for (const def of DEV_METHODOLOGIES) {
      expect(usage, def.flag).toContain(`--${def.flag}`);
      expect(usage, def.flag).toContain(def.usage);
    }
    // The description column never collides with the flag column.
    for (const line of usage.split('\n').slice(1)) {
      expect(line, line).toMatch(/^ {4}--[a-z-]+ {2,}\S/);
    }
  });

  it('leaves methodology UNDEFINED without any flag — the byte-identical promise', () => {
    // NOT `{}`: a session that asks for none of this must compile exactly the
    // pipeline huu compiles today (same contract as `models`).
    expect(parseOk(['g'], 'stub').methodology).toBeUndefined();
    expect(parseOk(['fazer a coisa', '--model=deepseek/deepseek-v4-pro']).methodology).toBeUndefined();
  });
});

describe('formatPlan', () => {
  const plan: DevPlan = {
    epochGoal: 'entregar o CLI',
    doneWhen: 'os testes passam',
    goalComplete: false,
    fronts: [
      {
        id: 'cli',
        title: 'Superfície de linha de comando',
        rationale: 'porque as flags moram aqui',
        dependsOnFronts: [],
        reconPrompt: 'mapeie',
        workPrompt: 'implemente',
        verifyCondition: 'tsc limpo',
        maxTasks: 3,
      },
      {
        id: 'docs',
        title: 'Documentação',
        rationale: 'para o humano entender',
        dependsOnFronts: ['cli'],
        reconPrompt: 'mapeie',
        workPrompt: 'escreva',
        verifyCondition: 'sem link quebrado',
        maxTasks: 1,
      },
    ],
  };

  it('renders the epoch header, both fronts and their dependency shape', () => {
    const out = formatPlan(plan, 2, ['uma frente foi reparada']);
    expect(out).toContain('── Plano da época 2');
    expect(out).toContain('Objetivo da época: entregar o CLI');
    expect(out).toContain('Pronto quando:     os testes passam');
    expect(out).toContain('1. Superfície de linha de comando [cli] (paralelo)');
    expect(out).toContain('2. Documentação [docs] (depois de: cli)');
    expect(out).toContain('até 3 agente(s) · juiz: tsc limpo');
    expect(out).toContain('⚠ plano ajustado: uma frente foi reparada');
  });
});

describe('formatModelRouting', () => {
  it('lists every role with its effective id, marking the ones on --model', () => {
    const policy = defaultDevModelPolicy('jcode', 'hetero');
    const block = formatModelRouting(resolveDevModels(policy, 'fallback/one'), policy, 'hetero');
    expect(block).toContain('preset hetero');
    for (const role of DEV_MODEL_ROLES) expect(block, role).toContain(role);
    expect(block).toContain('moonshotai/kimi-k2.6');
    // The roles that pin an endpoint say so; the ones that inherit do not.
    // `hetero` pins three: planner, critic and the debate's prosecutor.
    expect(block.match(/@openrouter/g)).toHaveLength(3);
    // The planner id is shown WITH the reason it is exempt from the preflight.
    expect(block).toContain('structured output');
    expect(block).not.toContain('← --model');

    const uniform = formatModelRouting(resolveDevModels(undefined, 'fallback/one'), undefined);
    expect(uniform.match(/← --model/g)).toHaveLength(DEV_MODEL_ROLES.length);
    expect(uniform).not.toContain('preset');
  });
});

describe('interactive gates with no TTY', () => {
  const originalIsTTY = process.stdin.isTTY;
  let originalWrite: typeof process.stderr.write;
  let stderr: string[];

  beforeEach(() => {
    stderr = [];
    originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown): boolean => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    // Forced, not assumed: a test that BLOCKED on a real prompt would be worse
    // than a failing one.
    process.stdin.isTTY = false;
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
    process.stdin.isTTY = originalIsTTY;
  });

  const state: DevState = {
    _format: 'huu-devstate-v2',
    goal: 'fazer a coisa',
    doneWhen: 'pronto',
    goalComplete: false,
    updatedAt: '2026-07-28T00:00:00.000Z',
    sessionId: 'abc123',
    epochs: [
      {
        epoch: 1,
        runId: 'r1',
        epochGoal: 'primeira',
        frontIds: ['cli'],
        status: 'done',
        landedCommit: 'deadbeefcafe',
        startedAt: '2026-07-28T00:00:00.000Z',
        finishedAt: '2026-07-28T00:10:00.000Z',
      },
    ],
  };

  const orphans: OrphanBranch[] = [
    { branch: 'huu/r1/integration', runId: 'r1', ahead: 3, epoch: 1 },
    { branch: 'huu/r2/integration', runId: 'r2', ahead: 1 },
  ];

  it('answers NO to the resume offer, and says why', async () => {
    await expect(offerResume(state, 2)).resolves.toBe(false);
    const out = stderr.join('');
    expect(out).toContain('sem terminal interativo');
    expect(out).toContain('--resume');
    // It still shows what it found — a refused offer must not hide the session.
    expect(out).toContain('abc123');
    expect(out).toContain('fazer a coisa');
  });

  it("answers 'ignore' for orphan branches, naming each one", async () => {
    await expect(offerOrphanLanding(orphans, false)).resolves.toBe('ignore');
    const out = stderr.join('');
    expect(out).toContain('huu/r1/integration');
    expect(out).toContain('huu/r2/integration');
    expect(out).toContain('--land-orphans');
  });

  it("honors --land-orphans without asking anything", async () => {
    await expect(offerOrphanLanding(orphans, true)).resolves.toBe('land');
    expect(stderr.join('')).toContain('--land-orphans');
  });
});

describe('runDevCli — the dev: literal carries the methodology', () => {
  const RESULT: DevModeResult = {
    stoppedBecause: 'max-epochs',
    epochs: [],
    goalComplete: false,
    knowledge: { present: false, skillCount: 0, skills: [], bootstrapMode: 'create', reason: 'sem skills' },
    knowledgeBootstrapped: false,
    sessionId: 'sess-test',
    resumed: false,
  };

  let originalStdout: typeof process.stdout.write;
  let originalStderr: typeof process.stderr.write;

  beforeEach(() => {
    vi.mocked(runDevMode).mockReset();
    vi.mocked(runDevMode).mockResolvedValue(RESULT);
    // runDevCli reports progress on stderr and emits its JSON verdict on
    // stdout — both captured so the wiring test stays silent.
    originalStdout = process.stdout.write.bind(process.stdout);
    originalStderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  });

  it('passes the parsed methodology through to runDevMode', async () => {
    const code = await runDevCli({
      args: ['g', '--tdd', '--lint-gate', '--standards', '--plan-review'],
      cwd: process.cwd(),
      backend: 'stub',
    });
    expect(code).toBe(0);
    const args = vi.mocked(runDevMode).mock.calls[0]?.[0];
    expect(args?.dev.methodology).toEqual({ tdd: true, lintGate: true, standards: true, planReview: true });
  });

  it('omits methodology from the literal entirely when no flag was given', async () => {
    const code = await runDevCli({ args: ['g'], cwd: process.cwd(), backend: 'stub' });
    expect(code).toBe(0);
    const args = vi.mocked(runDevMode).mock.calls[0]?.[0];
    // Not `undefined` under the key — NO key at all, so the compiled pipeline
    // stays byte-identical to the one huu compiles today.
    expect(args?.dev).not.toHaveProperty('methodology');
  });

  // The circuit breaker is NOT a clean stop: it only trips when work stopped
  // making progress, so it exits non-zero like every other failure — even
  // when every executed epoch happened to land its partial work.
  it('exits non-zero on consecutive-failures, even with every epoch landed', async () => {
    vi.mocked(runDevMode).mockResolvedValue({
      ...RESULT,
      stoppedBecause: 'consecutive-failures',
      epochs: [
        {
          epoch: 1,
          runId: 'run-1',
          epochGoal: 'fatia 1',
          frontIds: ['a'],
          status: 'done',
          landedCommit: 'deadbeef',
          startedAt: '2026-07-01T00:00:00.000Z',
          finishedAt: '2026-07-01T01:00:00.000Z',
        },
      ],
    });

    const code = await runDevCli({ args: ['g'], cwd: process.cwd(), backend: 'stub' });
    expect(code).toBe(1);
  });
});

describe('--max-cost', () => {
  const MODEL = '--model=deepseek/deepseek-v4-pro';

  it('accepts a dollar ceiling', () => {
    expect(parseOk(['goal', MODEL, '--max-cost=12.50']).maxCostUsd).toBe(12.5);
  });

  it('refuses a non-positive ceiling instead of silently ignoring it', () => {
    // A ceiling that parses to nothing is worse than no ceiling: the operator
    // believes they set a bound and the session runs unbounded.
    for (const bad of ['0', '-1', 'abc']) {
      expect(parseFail(['goal', MODEL, `--max-cost=${bad}`])).toContain('--max-cost');
    }
  });

  it('is absent by default — no ceiling is still the default', () => {
    expect(parseOk(['goal', MODEL]).maxCostUsd).toBeUndefined();
  });
});

// ─────────────────────────────── the drawn method ────────────────────────────

const DRAWN_STAMP = '2026-08-03T00:00:00.000Z';

/** A tiny drawing that validates: the root prompt plus one action node. */
function drawing(id = 'auditoria', name = 'Auditoria'): DevGraph {
  return {
    _format: 'huu-devgraph-v1',
    id,
    name,
    createdAt: DRAWN_STAMP,
    updatedAt: DRAWN_STAMP,
    meta: {},
    nodes: [
      { id: 'entrada', kind: 'prompt', label: 'Entrada', position: { x: 0, y: 0 }, goal: 'Auditar o repositório.' },
      { id: 'auditar', kind: 'action', label: 'Auditar', position: { x: 1, y: 0 }, block: 'implement', join: { mode: 'all' } },
    ],
    edges: [{ id: 'e-1', source: 'entrada', target: 'auditar' }],
  };
}

describe('parseDevCliArgs — --graph and the epoch-default TRAP', () => {
  const MODEL = '--model=deepseek/deepseek-v4-pro';

  // THE MOST IMPORTANT TEST IN THIS FILE.
  //
  // `parseDevCliArgs` sends `maxEpochs ?? DEV_DEFAULT_MAX_EPOCHS` (3), and the
  // driver REFUSES any `maxEpochs > 1` on a drawn method (`graph-conflict`) —
  // a devgraph is the COMPLETE method, so a graph session is exactly one epoch.
  // Left alone, those two facts mean every single graph session launched from
  // the command line dies on huu's own default, before an agent starts. Not a
  // rare interaction: the DEFAULT path.
  it('does NOT send the 3-epoch default with a drawing — it sends exactly 1', () => {
    const opts = parseOk(['objetivo', MODEL, '--graph=auditoria']);
    expect(opts.maxEpochs).toBe(1);
    expect(opts.maxEpochs).not.toBe(DEV_DEFAULT_MAX_EPOCHS);
    expect(opts.graphRef).toEqual({ kind: 'id', id: 'auditoria' });
  });

  it('keeps the 3-epoch default for a PLANNER session — the compatibility pin', () => {
    const opts = parseOk(['objetivo', MODEL]);
    expect(opts.maxEpochs).toBe(DEV_DEFAULT_MAX_EPOCHS);
    expect(opts.graphRef).toBeUndefined();
  });

  it('refuses --epochs > 1 with --graph in the PARSE, before any file is read', () => {
    for (const epochs of [2, 3, 12]) {
      const message = parseFail(['objetivo', MODEL, '--graph=auditoria', `--epochs=${epochs}`]);
      expect(message, String(epochs)).toContain(`--epochs=${epochs}`);
      expect(message, String(epochs)).toContain('--graph');
      // It says WHY, and what to do instead — a refusal nobody can act on is
      // just a wall.
      expect(message, String(epochs)).toContain('UMA época');
      expect(message, String(epochs)).toContain('rode sem --graph');
    }
  });

  it('accepts the redundant --epochs=1 next to --graph', () => {
    // 1 is what a graph session means, so asking for it is not a contradiction.
    expect(parseOk(['objetivo', MODEL, '--graph=auditoria', '--epochs=1']).maxEpochs).toBe(1);
  });

  it('reads --graph in both spellings', () => {
    expect(parseOk(['objetivo', MODEL, '--graph=auditoria']).graphRef).toEqual({ kind: 'id', id: 'auditoria' });
    expect(parseOk(['objetivo', MODEL, '--graph', 'auditoria']).graphRef).toEqual({ kind: 'id', id: 'auditoria' });
  });

  it('refuses an empty --graph instead of running the planner behind the human\'s back', () => {
    expect(parseFail(['objetivo', MODEL, '--graph='])).toContain('--graph=<id|arquivo.json>');
  });

  it('leaves graphRef ABSENT with no --graph — the byte-identical promise', () => {
    const opts = parseOk(['objetivo', MODEL]);
    expect(opts).not.toHaveProperty('graphRef');
  });

  it('documents --graph in the usage line', () => {
    const usage = parseFail([]);
    expect(usage).toContain('--graph=');
    expect(usage).toContain('huu graph');
  });
});

describe('classifyGraphRef — id vs path, decided with no filesystem', () => {
  it('reads a bare slug as a SAVED graph id', () => {
    for (const id of ['auditoria', 'a', 'portao-de-qualidade', 'x9', 'a'.repeat(40)]) {
      expect(classifyGraphRef(id), id).toEqual({ kind: 'id', id });
    }
  });

  it('reads anything a slug cannot be as a PATH', () => {
    // A slug can hold neither `/` nor `.`, so the two can never be confused —
    // which is what lets the classification stay pure.
    for (const path of [
      './rascunhos/auditoria.json',
      'auditoria.json',
      '/tmp/auditoria.json',
      'rascunhos/auditoria',
      '../auditoria.json',
      'Auditoria',
      'a'.repeat(41),
    ]) {
      expect(classifyGraphRef(path), path).toEqual({ kind: 'path', path });
    }
  });

  it('trims before deciding', () => {
    expect(classifyGraphRef('  auditoria  ')).toEqual({ kind: 'id', id: 'auditoria' });
  });
});

describe('parseDevCliArgs — --graph warns, never refuses, about what a drawing ignores', () => {
  const MODEL = '--model=deepseek/deepseek-v4-pro';

  it('warns that the methodology flags are NOT compiled into a drawing', () => {
    const opts = parseOk(['objetivo', MODEL, '--graph=auditoria', '--tdd', '--lint-gate']);
    const warnings = opts.warnings.join(' ');
    expect(warnings).toContain('--tdd');
    expect(warnings).toContain('--lint-gate');
    expect(warnings).toContain('IGNORA');
    // Warned, NOT refused: a flag left over from an alias must not kill a
    // session whose drawing already carries a tdd block.
    expect(opts.graphRef).toEqual({ kind: 'id', id: 'auditoria' });
    expect(opts.methodology).toEqual({ tdd: true, lintGate: true });
  });

  it('warns that per-role model routing is NOT applied to a drawing', () => {
    const opts = parseOk(['objetivo', MODEL, '--graph=auditoria', '--models=hetero']);
    const warnings = opts.warnings.join(' ');
    expect(warnings).toContain('roteamento por papel');
    expect(warnings).toContain('meta.modelId');
    expect(opts.models).toEqual(defaultDevModelPolicy('jcode', 'hetero'));
  });

  it('stays silent about both when neither was asked for', () => {
    const opts = parseOk(['objetivo', MODEL, '--graph=auditoria']);
    expect(opts.warnings.join(' ')).not.toContain('IGNORA');
  });

  it('does not warn about methodology on a PLANNER session — there it IS compiled', () => {
    const opts = parseOk(['objetivo', MODEL, '--tdd']);
    expect(opts.warnings.join(' ')).not.toContain('IGNORA');
  });
});

describe('describeEvent — a graph session does not end at a ceiling', () => {
  const stopped = { type: 'stopped', reason: 'max-epochs', detail: 'o desenho rodou' } as const;

  it('reports max-epochs as a ceiling on a PLANNER session', () => {
    const line = describeEvent(stopped);
    expect(line).toContain('max-epochs');
    expect(line).not.toContain('desenhado');
  });

  it('reports max-epochs as a COMPLETED DRAWING when the session ran one', () => {
    // `max-epochs` IS the clean stop of a graph session (the drawing ran), and
    // the default sentence for it claims a limit was hit. On a graph that is
    // simply false, and it is how a successful run reads as a truncated one.
    const line = describeEvent(stopped, { drawnMethod: { id: 'auditoria', name: 'Auditoria' } })!;
    expect(line).toContain('auditoria');
    expect(line).toContain('Auditoria');
    expect(line).toContain('rodou de ponta a ponta');
    expect(line).toContain('NÃO é teto de épocas');
    expect(line).toContain('o desenho rodou');
  });

  it('leaves every other stop reason alone on a graph session', () => {
    const line = describeEvent(
      { type: 'stopped', reason: 'landing-failed', detail: 'conflito' },
      { drawnMethod: { id: 'auditoria', name: 'Auditoria' } },
    );
    expect(line).toBe('sessão encerrada: landing-failed — conflito');
  });

  it('reports a drawn method by its NODES, and a plan by its fronts', () => {
    const plan: DevPlan = {
      epochGoal: 'época',
      doneWhen: 'pronto',
      goalComplete: false,
      fronts: [
        {
          id: 'cli',
          title: 'CLI',
          rationale: 'porque sim',
          dependsOnFronts: [],
          reconPrompt: 'mapeie',
          workPrompt: 'implemente',
          verifyCondition: 'passa',
          maxTasks: 1,
        },
      ],
    };
    expect(describeEvent({ type: 'planned', epoch: 1, plan, warnings: [] })).toContain('1 frente(s)');

    const drawn = describeEvent({
      type: 'planned',
      epoch: 1,
      plan,
      warnings: [],
      graph: {
        id: 'auditoria',
        name: 'Auditoria',
        nodeOrder: ['recon', 'auditar'],
        stepsByNode: { recon: ['1 · recon'], auditar: ['2 · auditar'] },
        graphRoot: '.huu/dev/s/graph/epoch-1',
      },
    })!;
    // A drawing has nodes, not fronts. Reporting fronts would credit a planner
    // that never ran.
    expect(drawn).toContain('método desenhado "auditoria"');
    expect(drawn).toContain('recon, auditar');
    expect(drawn).not.toContain('frente(s)');
  });
});

describe('runDevCli — the drawing is resolved AT THE BORDER', () => {
  const RESULT: DevModeResult = {
    stoppedBecause: 'max-epochs',
    epochs: [],
    goalComplete: false,
    knowledge: { present: false, skillCount: 0, skills: [], bootstrapMode: 'create', reason: 'sem skills' },
    knowledgeBootstrapped: false,
    sessionId: 'sess-graph',
    resumed: false,
  };

  let repo: string;
  let originalStdout: typeof process.stdout.write;
  let originalStderr: typeof process.stderr.write;
  let stderrLines: string[];

  function seed(graph: DevGraph): void {
    mkdirSync(join(repo, GRAPHS_DIR), { recursive: true });
    writeFileSync(join(repo, GRAPHS_DIR, `${graph.id}.json`), JSON.stringify(graph, null, 2), 'utf8');
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'huu-dev-graph-'));
    stderrLines = [];
    vi.mocked(runDevMode).mockReset();
    vi.mocked(runDevMode).mockResolvedValue(RESULT);
    originalStdout = process.stdout.write.bind(process.stdout);
    originalStderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown): boolean => {
      stderrLines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    rmSync(repo, { recursive: true, force: true });
  });

  const stderr = (): string => stderrLines.join('');
  const devArgs = () => vi.mocked(runDevMode).mock.calls[0]?.[0]?.dev;

  it('passes a SAVED id through as graphId, with maxEpochs 1 — the trap, end to end', () => {
    seed(drawing());
    return runDevCli({ args: ['objetivo', '--graph=auditoria'], cwd: repo, backend: 'stub' }).then((code) => {
      expect(code).toBe(0);
      const dev = devArgs();
      expect(dev?.graphId).toBe('auditoria');
      expect(dev).not.toHaveProperty('graph');
      // The literal the driver receives: 1, never DEV_DEFAULT_MAX_EPOCHS, or
      // `resolveDevGraph` would refuse it as `graph-conflict`.
      expect(dev?.maxEpochs).toBe(1);
    });
  });

  it('loads a PATH itself and hands the drawing over inline', async () => {
    const file = join(repo, 'rascunho.json');
    writeFileSync(file, JSON.stringify(drawing('do-arquivo', 'Do arquivo')), 'utf8');
    const code = await runDevCli({ args: ['objetivo', '--graph=./rascunho.json'], cwd: repo, backend: 'stub' });
    expect(code).toBe(0);
    const dev = devArgs();
    expect(dev?.graph?.id).toBe('do-arquivo');
    expect(dev).not.toHaveProperty('graphId');
    expect(dev?.maxEpochs).toBe(1);
  });

  it('says the method is DESENHADO in the opening summary, and names the drawing', () => {
    seed(drawing('auditoria', 'Auditoria de segurança'));
    return runDevCli({ args: ['objetivo', '--graph=auditoria'], cwd: repo, backend: 'stub' }).then(() => {
      const out = stderr();
      expect(out).toContain('DESENHADO');
      expect(out).toContain('auditoria');
      expect(out).toContain('Auditoria de segurança');
      expect(out).toContain('nenhum planner LLM');
      // It also corrects the epoch line: "até 3" would be a lie here.
      expect(out).toContain('épocas: 1');
    });
  });

  it('refuses a --graph file that does not exist, WITHOUT starting a session', async () => {
    const code = await runDevCli({ args: ['objetivo', '--graph=./nao-existe.json'], cwd: repo, backend: 'stub' });
    expect(code).toBe(1);
    expect(stderr()).toContain('arquivo não encontrado');
    // The refusal has to happen before anything is written: a session that
    // opens and immediately stops has already touched the repository.
    expect(vi.mocked(runDevMode)).not.toHaveBeenCalled();
  });

  it('refuses a --graph id nothing was saved under, and points at `huu graph list`', async () => {
    const code = await runDevCli({ args: ['objetivo', '--graph=fantasma'], cwd: repo, backend: 'stub' });
    expect(code).toBe(1);
    expect(stderr()).toContain('graph-not-found');
    expect(stderr()).toContain('huu graph list');
    expect(vi.mocked(runDevMode)).not.toHaveBeenCalled();
  });

  it('refuses a --graph file that is not JSON, and one that is not a devgraph', async () => {
    writeFileSync(join(repo, 'lixo.json'), '{ nope', 'utf8');
    expect(await runDevCli({ args: ['objetivo', '--graph=./lixo.json'], cwd: repo, backend: 'stub' })).toBe(1);
    expect(stderr()).toContain('JSON inválido');

    stderrLines = [];
    writeFileSync(join(repo, 'outro.json'), JSON.stringify({ hello: 'world' }), 'utf8');
    expect(await runDevCli({ args: ['objetivo', '--graph=./outro.json'], cwd: repo, backend: 'stub' })).toBe(1);
    expect(stderr()).toContain('não é um huu-devgraph-v1');
    expect(vi.mocked(runDevMode)).not.toHaveBeenCalled();
  });

  it('refuses a drawing that parses but does not compile, naming the defect', async () => {
    // The store saves half-drawn work on purpose, so a graph with a product-rule
    // error is an ordinary thing to find on disk — and never a thing to run.
    const broken = drawing('quebrado');
    seed({
      ...broken,
      nodes: broken.nodes.map((node) => (node.id === 'auditar' ? { ...node, block: 'bloco-inexistente' } : node)),
    });
    const code = await runDevCli({ args: ['objetivo', '--graph=quebrado'], cwd: repo, backend: 'stub' });
    expect(code).toBe(1);
    expect(stderr()).toContain('graph-invalid');
    expect(stderr()).toContain('unknown-block');
    expect(vi.mocked(runDevMode)).not.toHaveBeenCalled();
  });

  it('runs a shipped SAMPLE end to end from a file', async () => {
    const sample = findSample('portao-de-qualidade')!;
    writeFileSync(join(repo, 'amostra.json'), JSON.stringify(sample.build(DRAWN_STAMP)), 'utf8');
    const code = await runDevCli({ args: ['objetivo', '--graph=amostra.json'], cwd: repo, backend: 'stub' });
    expect(code).toBe(0);
    expect(devArgs()?.graph?.id).toBe('portao-de-qualidade');
  });

  it('leaves the dev literal free of BOTH graph keys on a planner session', async () => {
    const code = await runDevCli({ args: ['objetivo'], cwd: repo, backend: 'stub' });
    expect(code).toBe(0);
    const dev = devArgs();
    // Not `undefined` under the keys — NO keys, so a planner session compiles
    // exactly the session huu compiles today.
    expect(dev).not.toHaveProperty('graph');
    expect(dev).not.toHaveProperty('graphId');
    expect(dev?.maxEpochs).toBe(DEV_DEFAULT_MAX_EPOCHS);
    expect(stderr()).not.toContain('DESENHADO');
  });

  it('refuses --epochs=3 with --graph before it ever looks at the disk', async () => {
    // No graph is seeded and no file exists: if the refusal came from the
    // driver or from a file read, this would fail with a different message.
    const code = await runDevCli({ args: ['objetivo', '--graph=auditoria', '--epochs=3'], cwd: repo, backend: 'stub' });
    expect(code).toBe(1);
    expect(stderr()).toContain('--epochs=3');
    expect(stderr()).not.toContain('graph-not-found');
    expect(vi.mocked(runDevMode)).not.toHaveBeenCalled();
  });

  it('carries the ignored-flag warnings to stderr before the session starts', async () => {
    seed(drawing());
    const code = await runDevCli({
      args: ['objetivo', '--graph=auditoria', '--tdd'],
      cwd: repo,
      backend: 'stub',
    });
    expect(code).toBe(0);
    expect(stderr()).toContain('IGNORA as flags de metodologia');
    // Still passed through — the driver logs its own warning and the drawing
    // decides. Refusing here would kill a session over a leftover flag.
    expect(devArgs()?.methodology).toEqual({ tdd: true });
  });
});

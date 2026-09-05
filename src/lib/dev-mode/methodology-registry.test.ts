// The registry is the DECLARATION surface every methodology surface is derived
// from: the CLI flag parse, the CLI usage block, the web checkbox catalog, the
// planner's content bullets and — the one with no error of its own —
// `anyMethodologyOn`, whose omission costs an option its human escape
// (`ReviewSpec.onBlocked: 'hold'`) in total silence.
//
// Before this file the table had NO test at all, which meant the invariant the
// whole MANIFESTO reconciliation rests on ("every option is additive, and off
// means byte-identical") was pinned nowhere. What follows is written to be
// able to say NO: each case names the mutation it kills.

import { describe, expect, it } from 'vitest';
import {
  DEV_METHODOLOGIES,
  activeMethodologies,
  anyMethodologyOn,
  methodologyUsageBlock,
  parseMethodologyFlags,
} from './methodology-registry.js';
import { compileEpochPipeline } from './plan-to-pipeline.js';
import { PipelineSchema, validateTopology } from '../pipeline-io.js';
import { isCheckStep, isWorkStep, type DevFront, type DevMethodology, type DevPlan } from '../types.js';

/**
 * THE EXHAUSTIVENESS LOCK, and the reason it lives in the test rather than in
 * the module.
 *
 * `MethodologyDefinition.key` is `keyof DevMethodology`, so the compiler
 * already refuses an entry the type does not declare. The OTHER direction —
 * a field added to `DevMethodology` that nobody ever put in the table — is
 * exactly what a `keyof` cannot catch, and it is the silent hole: the flag
 * parses nowhere, the checkbox never renders, `anyMethodologyOn` never sees
 * it, and the compiler branch that reads `methodology.<newField>` still works,
 * so the option ships reachable from nothing.
 *
 * This literal closes it. Adding a field to `DevMethodology` fails compilation
 * HERE until it is listed, and then the test below fails until the registry
 * carries it too.
 */
const ALL_METHODOLOGY_KEYS: Record<keyof DevMethodology, true> = {
  tdd: true,
  lintGate: true,
  standards: true,
  planReview: true,
  writeSet: true,
  changelogGate: true,
  diffBudget: true,
  fitnessFunctions: true,
  checklistReview: true,
  traceability: true,
  characterization: true,
  chainOfVerification: true,
  debate: true,
};

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

const PLAN: DevPlan = {
  epochGoal: 'entregar a fatia 1',
  doneWhen: 'os testes passam',
  goalComplete: false,
  fronts: [front('a'), front('b', { dependsOnFronts: ['a'] })],
};

/**
 * Compiled with one option on, and every project surface a METHODOLOGY might
 * read supplied — so an option is never dropped for lack of input.
 *
 * `verifyCommands` is deliberately NOT here: it is the project's real gate,
 * handed to every critic whether or not any option is on, so passing it would
 * make the byte-identity baseline below compare two different things.
 */
function compileWith(methodology: DevMethodology | undefined) {
  return compileEpochPipeline({
    plan: PLAN,
    epoch: 1,
    goal: 'construir a coisa',
    ...(methodology ? { methodology } : {}),
    lintCommands: ['npm run typecheck'],
    testCommands: ['npm test'],
    changelogPaths: ['CHANGELOG.md'],
    fitnessCommands: ['npm run depcruise'],
  });
}

describe('DEV_METHODOLOGIES — the table itself', () => {
  // MUTATION KILLED: adding a field to `DevMethodology` and forgetting the
  // registry entry. The option would then be unreachable from the CLI, absent
  // from the web catalog, invisible to `anyMethodologyOn` — and no other test
  // in this repository would notice.
  it('has exactly one entry per DevMethodology field, and no extras', () => {
    const declared = Object.keys(ALL_METHODOLOGY_KEYS).sort();
    const registered = DEV_METHODOLOGIES.map((d) => d.key).sort();
    expect(registered).toEqual(declared);
  });

  // MUTATION KILLED: a copy-pasted entry that keeps the source's `key`. Two
  // entries for one field renders two checkboxes that set the same thing and
  // makes `activeMethodologies` report it twice to the planner.
  it('never repeats a key', () => {
    const keys = DEV_METHODOLOGIES.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  // MUTATION KILLED: a copy-pasted entry that keeps the source's `flag`.
  // `parseMethodologyFlags` would then set BOTH keys from one flag, so typing
  // `--tdd` would silently also turn on whatever shares the spelling.
  it('never repeats a flag', () => {
    const flags = DEV_METHODOLOGIES.map((d) => d.flag);
    expect(new Set(flags).size).toBe(flags.length);
  });

  // MUTATION KILLED: writing the flag WITH its dashes (`flag: '--tdd'`), which
  // compiles, renders `----tdd` in the usage block and matches nothing in argv.
  it('spells every flag without its dashes and without whitespace', () => {
    for (const def of DEV_METHODOLOGIES) {
      expect(def.flag, def.key).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  // MUTATION KILLED: shipping an entry with an empty description — an
  // unlabeled checkbox in the web form and an empty column in the CLI usage.
  it('gives every option a label, a description, a usage line and a planner bullet', () => {
    for (const def of DEV_METHODOLOGIES) {
      for (const field of ['label', 'description', 'usage', 'plannerBullet'] as const) {
        expect(def[field].trim().length, `${def.key}.${field}`).toBeGreaterThan(0);
      }
      // The bullet reaches the planner as a list item naming its own key —
      // that is what lets the planner tie a constraint back to an option.
      expect(def.plannerBullet, def.key).toContain(`\`${def.key}\``);
      expect(def.plannerBullet.startsWith('- '), def.key).toBe(true);
    }
  });
});

describe('parseMethodologyFlags', () => {
  // MUTATION KILLED: returning `{}` instead of `undefined` for "no flags".
  // Every downstream `?.` treats `{}` as "the human asked for methodology",
  // and the byte-identity contract dies with no error anywhere.
  it('returns undefined — never {} — when no flag was given', () => {
    expect(parseMethodologyFlags([])).toBeUndefined();
    expect(parseMethodologyFlags(['--epochs=2', 'objetivo'])).toBeUndefined();
  });

  // MUTATION KILLED: an entry whose `flag` does not correspond to its `key`
  // (a rename applied to one column only) — the checkbox would exist and the
  // flag would set the wrong field.
  it('maps every flag to its own key, one at a time', () => {
    for (const def of DEV_METHODOLOGIES) {
      expect(parseMethodologyFlags([`--${def.flag}`]), def.flag).toEqual({ [def.key]: true });
    }
  });

  it('accumulates every flag given at once', () => {
    const all = parseMethodologyFlags(DEV_METHODOLOGIES.map((d) => `--${d.flag}`));
    expect(all).toEqual(Object.fromEntries(DEV_METHODOLOGIES.map((d) => [d.key, true])));
  });

  it('ignores a flag no option declares', () => {
    expect(parseMethodologyFlags(['--not-a-methodology'])).toBeUndefined();
  });
});

describe('anyMethodologyOn — the invisible side effect', () => {
  // THE headline case of this file. `anyMethodologyOn` is the ONLY consumer
  // with no error of its own: it decides `ReviewSpec.onBlocked: 'hold'`, so a
  // key it does not recognize costs that option its human escape and nothing
  // anywhere says so. It reads the object precisely because the hand-written
  // `||` chain it replaced was where a new option got forgotten.
  //
  // MUTATION KILLED: replacing the `Object.values(...)` read with any
  // enumerated chain that misses a key — including the newest one.
  it('recognizes EVERY registry key on its own', () => {
    for (const def of DEV_METHODOLOGIES) {
      expect(anyMethodologyOn({ [def.key]: true }), def.key).toBe(true);
    }
  });

  it('is false for nothing at all, for {}, and for an all-false object', () => {
    expect(anyMethodologyOn(undefined)).toBe(false);
    expect(anyMethodologyOn({})).toBe(false);
    expect(
      anyMethodologyOn(Object.fromEntries(DEV_METHODOLOGIES.map((d) => [d.key, false]))),
    ).toBe(false);
  });

  // The side effect made observable end to end: the flag the human typed is
  // what puts the per-task critic in `hold` instead of letting it waive at the
  // round cap. Every option owes the user that sentence in its description.
  //
  // MUTATION KILLED: dropping the `anyMethodologyOn(...)` spread from
  // `buildReviewSpec` — every test above would still pass.
  it('every single option puts the per-task critic in hold', () => {
    for (const def of DEV_METHODOLOGIES) {
      const { pipeline } = compileWith({ [def.key]: true });
      const reviews = pipeline.steps.filter(isWorkStep).filter((s) => s.review);
      expect(reviews.length, def.key).toBeGreaterThan(0);
      for (const step of reviews) expect(step.review!.onBlocked, def.key).toBe('hold');
    }
  });

  // MUTATION KILLED: setting `onBlocked` unconditionally. With no option on,
  // findings must still waive at the round cap exactly as they always did.
  it('leaves onBlocked unset when the human underwrote nothing', () => {
    const { pipeline } = compileWith(undefined);
    for (const step of pipeline.steps.filter(isWorkStep).filter((s) => s.review)) {
      expect(step.review!.onBlocked).toBeUndefined();
    }
  });
});

describe('activeMethodologies', () => {
  it('is empty for no methodology and for an all-false object', () => {
    expect(activeMethodologies(undefined)).toEqual([]);
    expect(activeMethodologies({ tdd: false })).toEqual([]);
  });

  // MUTATION KILLED: filtering the INPUT object's keys instead of the table.
  // Object key order is the caller's (a POST body, a flag order), and the
  // planner's bullet list would then reshuffle between runs — defeating the
  // provider prompt cache for no benefit and making two identical sessions
  // produce different prompt bytes.
  it('reports in REGISTRY order, whatever order the keys arrived in', () => {
    const reversed = Object.fromEntries(
      [...DEV_METHODOLOGIES].reverse().map((d) => [d.key, true]),
    );
    expect(activeMethodologies(reversed).map((d) => d.key)).toEqual(
      DEV_METHODOLOGIES.map((d) => d.key),
    );
  });
});

describe('methodologyUsageBlock', () => {
  // MUTATION KILLED: hard-coding the flag column width. A flag longer than the
  // constant collapses the gap to zero and the usage text reads
  // `--verify-claimsverifica cada afirmação`.
  it('lists every flag exactly once, each followed by whitespace and its usage', () => {
    const block = methodologyUsageBlock();
    for (const def of DEV_METHODOLOGIES) {
      const hits = block.match(new RegExp(`--${def.flag}(?![a-z0-9-])`, 'g')) ?? [];
      expect(hits.length, def.flag).toBe(1);
      expect(block, def.flag).toMatch(
        new RegExp(`--${def.flag}(?![a-z0-9-]) +${def.usage.slice(0, 12).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      );
    }
  });
});

describe('the compiled contract every option must keep', () => {
  // THE prime directive, re-pinned from the registry side: nothing on ⇒ the
  // pipeline huu compiled before any of this existed, byte for byte. Stated
  // here as well as in plan-to-pipeline.test.ts on purpose — this is the file
  // a new registry entry is added in.
  //
  // MUTATION KILLED: any unconditional structure or prompt text added for an
  // option, forgetting the `methodology?.x === true` guard.
  it('compiles the pipeline of today, byte for byte, with nothing selected', () => {
    const plain = compileEpochPipeline({ plan: PLAN, epoch: 1, goal: 'construir a coisa' });
    const withSurfaces = compileWith(undefined);
    const allOff = compileWith(
      Object.fromEntries(DEV_METHODOLOGIES.map((d) => [d.key, false])) as DevMethodology,
    );
    expect(JSON.stringify(withSurfaces.pipeline)).toBe(JSON.stringify(plain.pipeline));
    expect(JSON.stringify(allOff.pipeline)).toBe(JSON.stringify(plain.pipeline));
  });

  // MUTATION KILLED: a new option that emits a check with zero or two
  // `default: true` outcomes, or one whose default LOOPS BACKWARD. The default
  // fires on judge failure, on an unknown label and at the `maxRuns` cap, so a
  // backward default is an epoch that cannot terminate.
  it('keeps exactly one forward default per check, for every option on its own', () => {
    for (const def of DEV_METHODOLOGIES) {
      const { pipeline } = compileWith({ [def.key]: true });
      expect(PipelineSchema.safeParse(pipeline).success, def.key).toBe(true);
      expect(validateTopology(pipeline), def.key).toEqual([]);

      const indexByName = new Map(pipeline.steps.map((s, i) => [s.name, i]));
      const checks = pipeline.steps.filter(isCheckStep);
      expect(checks.length, def.key).toBeGreaterThan(0);
      for (const check of checks) {
        const defaults = check.outcomes.filter((o) => o.default);
        expect(defaults.length, `${def.key} · ${check.name}`).toBe(1);
        expect(
          indexByName.get(defaults[0]!.nextStepName)!,
          `${def.key} · ${check.name} · default must point FORWARD`,
        ).toBeGreaterThan(indexByName.get(check.name)!);
      }
    }
  });

  // The same invariant with EVERYTHING on at once: an option is only additive
  // if it is additive next to the other twelve, not just on its own.
  it('keeps exactly one forward default per check with every option on at once', () => {
    const { pipeline } = compileWith(
      Object.fromEntries(DEV_METHODOLOGIES.map((d) => [d.key, true])) as DevMethodology,
    );
    expect(PipelineSchema.safeParse(pipeline).success).toBe(true);
    expect(validateTopology(pipeline)).toEqual([]);
    const indexByName = new Map(pipeline.steps.map((s, i) => [s.name, i]));
    for (const check of pipeline.steps.filter(isCheckStep)) {
      expect(check.outcomes.filter((o) => o.default).length, check.name).toBe(1);
      const fwd = check.outcomes.find((o) => o.default)!;
      expect(indexByName.get(fwd.nextStepName)!, check.name).toBeGreaterThan(
        indexByName.get(check.name)!,
      );
    }
  });
});

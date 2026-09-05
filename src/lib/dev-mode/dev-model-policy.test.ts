import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEV_MODEL_ROLES,
  EMPTY_MODEL_PROVIDER_INDEX,
  buildModelProviderIndex,
  checkDevModelPolicy,
  collapseDevModelPolicy,
  defaultDevModelPolicy,
  devModelRefusals,
  devModelPresetProviders,
  formatModelRoute,
  modelKnownFor,
  modelRungs,
  normalizeDevModelPolicy,
  parseDevModelPolicy,
  parseModelRoute,
  pickModelRoute,
  pickModelRung,
  providersForModel,
  resolveDevModels,
  unionModelProviderIndexes,
} from './dev-model-policy.js';
import { DEV_MODEL_PRESETS, type DevModelPolicy, type DevModelRole } from '../types.js';
import { PROVIDERS, type LlmProvider } from '../providers.js';
import { RecommendedModelsFileSchema, type ModelEntry } from '../../contracts/models.js';

const FALLBACK = 'deepseek/deepseek-v4-flash';

/** The catalog huu ships, which is also what the model pickers offer. */
function shippedCatalog(): ModelEntry[] {
  const raw = JSON.parse(readFileSync(join(process.cwd(), 'recommended-models.json'), 'utf-8'));
  return RecommendedModelsFileSchema.parse(raw).models;
}

describe('DEV_MODEL_ROLES', () => {
  it('covers every role exactly once', () => {
    expect([...DEV_MODEL_ROLES].sort()).toEqual([
      'critic',
      'integration',
      'judge',
      'planner',
      'recon',
      'reporter',
      'worker',
    ]);
    expect(new Set(DEV_MODEL_ROLES).size).toBe(DEV_MODEL_ROLES.length);
  });
});

describe('resolveDevModels — no hidden defaulting', () => {
  it('sends EVERY role to the fallback when there is no policy', () => {
    for (const policy of [undefined, {}]) {
      const resolved = resolveDevModels(policy, FALLBACK);
      expect(Object.keys(resolved).sort()).toEqual([...DEV_MODEL_ROLES].sort());
      for (const role of DEV_MODEL_ROLES) expect(resolved[role]).toBe(FALLBACK);
    }
  });

  it('merges a partial policy: named roles win, the rest fall back', () => {
    const resolved = resolveDevModels(
      {
        critic: { model: 'moonshotai/kimi-k2.6', provider: 'openrouter' },
        worker: { model: 'deepseek/deepseek-v4-pro' },
      },
      FALLBACK,
    );
    expect(resolved.critic).toBe('moonshotai/kimi-k2.6');
    expect(resolved.worker).toBe('deepseek/deepseek-v4-pro');
    expect(resolved.planner).toBe(FALLBACK);
    expect(resolved.recon).toBe(FALLBACK);
    expect(resolved.reporter).toBe(FALLBACK);
    expect(resolved.judge).toBe(FALLBACK);
    expect(resolved.integration).toBe(FALLBACK);
  });

  it('trims a value, and treats a blank one as unset', () => {
    const resolved = resolveDevModels(
      { worker: { model: '  a/b  ' }, judge: { model: '   ' } },
      FALLBACK,
    );
    expect(resolved.worker).toBe('a/b');
    expect(resolved.judge).toBe(FALLBACK);
  });

  it('resolves the `uniform` preset to today behavior, byte for byte', () => {
    const resolved = resolveDevModels(defaultDevModelPolicy('jcode', 'uniform'), FALLBACK);
    for (const role of DEV_MODEL_ROLES) expect(resolved[role]).toBe(FALLBACK);
  });
});

// ---------------------------------------------------------------------------
// The pair (model, provider) — the shape that makes a mixed roster expressible
// ---------------------------------------------------------------------------

describe('parseModelRoute — a bare string still means what it meant', () => {
  it('reads a plain id with no provider (inherit the run)', () => {
    expect(parseModelRoute('deepseek/deepseek-v4-pro')).toEqual({
      model: 'deepseek/deepseek-v4-pro',
    });
    expect(parseModelRoute('  spaced/id  ')).toEqual({ model: 'spaced/id' });
  });

  it('reads the `<provider>:<id>` form, aliases included', () => {
    expect(parseModelRoute('openrouter:anthropic/claude-opus-5')).toEqual({
      model: 'anthropic/claude-opus-5',
      provider: 'openrouter',
    });
    expect(parseModelRoute('or:z-ai/glm-5.3-flash')).toEqual({
      model: 'z-ai/glm-5.3-flash',
      provider: 'openrouter',
    });
    expect(parseModelRoute('ds:deepseek/deepseek-v4-pro')).toEqual({
      model: 'deepseek/deepseek-v4-pro',
      provider: 'deepseek',
    });
  });

  // MUTATION KILLED: splitting on the first `:` unconditionally. OpenRouter
  // variant suffixes (`:free`, `:nitro`, `:thinking`) would then be shredded
  // into a bogus provider + a truncated id.
  it('never mistakes an OpenRouter variant suffix for a provider prefix', () => {
    expect(parseModelRoute('deepseek/deepseek-r1:free')).toEqual({
      model: 'deepseek/deepseek-r1:free',
    });
    expect(parseModelRoute('z-ai/glm-5.3-flash:thinking')).toEqual({
      model: 'z-ai/glm-5.3-flash:thinking',
    });
    // An unknown head is left alone too — it is part of the id, not a provider.
    expect(parseModelRoute('bogus:a/b')).toEqual({ model: 'bogus:a/b' });
  });

  it('reads the structured form, and lets an explicit provider outrank the prefix', () => {
    expect(parseModelRoute({ model: 'a/b' })).toEqual({ model: 'a/b' });
    expect(parseModelRoute({ model: 'a/b', provider: 'openrouter' })).toEqual({
      model: 'a/b',
      provider: 'openrouter',
    });
    expect(parseModelRoute({ model: 'deepseek:a/b', provider: 'openrouter' })).toEqual({
      model: 'a/b',
      provider: 'openrouter',
    });
    // An unrecognized provider is dropped, never thrown on — untrusted input.
    expect(parseModelRoute({ model: 'a/b', provider: 'azure' })).toEqual({ model: 'a/b' });
  });

  it('returns undefined for anything that does not name a model', () => {
    for (const raw of [undefined, null, '', '   ', 42, true, ['a/b'], {}, { id: 'a/b' }]) {
      expect(parseModelRoute(raw)).toBeUndefined();
    }
  });

  it('round-trips through the string form', () => {
    for (const s of ['a/b', 'openrouter:a/b', 'deepseek:a/b']) {
      expect(formatModelRoute(parseModelRoute(s)!)).toBe(s);
    }
  });
});

describe('buildModelProviderIndex — the catalog IS the registry', () => {
  it('maps an id to EVERY provider that serves it, never to one', () => {
    const index = buildModelProviderIndex([
      { id: 'deepseek/deepseek-v4-pro' },
      { id: 'deepseek/deepseek-v4-pro', provider: 'openrouter' },
      { id: 'anthropic/claude-opus-5', provider: 'openrouter' },
    ]);
    expect([...providersForModel('deepseek/deepseek-v4-pro', index)].sort()).toEqual([
      'deepseek',
      'openrouter',
    ]);
    expect([...providersForModel('anthropic/claude-opus-5', index)]).toEqual(['openrouter']);
  });

  it('treats an entry with no provider as deepseek — the catalog back-compat', () => {
    const index = buildModelProviderIndex([{ id: 'legacy/id' }]);
    expect([...providersForModel('legacy/id', index)]).toEqual(['deepseek']);
  });

  it('answers with an EMPTY set for an id nothing lists — absence, not denial', () => {
    expect(providersForModel('brand/new', EMPTY_MODEL_PROVIDER_INDEX).size).toBe(0);
  });

  it("lets a route's OWN provider outrank the catalog", () => {
    const index = buildModelProviderIndex([{ id: 'a/b', provider: 'openrouter' }]);
    expect([...providersForModel('a/b', index, 'deepseek')]).toEqual(['deepseek']);
  });
});

describe('defaultDevModelPolicy', () => {
  it('is EMPTY for stub — the stub backend calls no provider at all', () => {
    for (const backend of ['stub'] as const) {
      expect(defaultDevModelPolicy(backend)).toEqual({});
      expect(defaultDevModelPolicy(backend, 'hetero')).toEqual({});
      expect(defaultDevModelPolicy(backend, 'roster')).toEqual({});
      const resolved = resolveDevModels(defaultDevModelPolicy(backend), FALLBACK);
      for (const role of DEV_MODEL_ROLES) expect(resolved[role]).toBe(FALLBACK);
    }
  });

  it('defaults to `hetero` on jcode: cross-family critic, glm planner', () => {
    const policy = defaultDevModelPolicy('jcode');
    expect(policy.critic).toEqual({ model: 'moonshotai/kimi-k2.6', provider: 'openrouter' });
    expect(policy.planner).toEqual({ model: 'z-ai/glm-5.2', provider: 'openrouter' });
    expect(policy.worker).toEqual({ model: 'deepseek/deepseek-v4-pro' });
    // The critic must NOT come from the worker's family — that is the point.
    expect(policy.critic!.model).not.toBe(policy.worker!.model);
  });

  it('`monoculture` puts the critic back on the worker model', () => {
    const policy = defaultDevModelPolicy('jcode', 'monoculture');
    expect(policy.critic).toEqual({ model: 'deepseek/deepseek-v4-pro' });
    expect(policy.critic).toEqual(policy.worker);
  });

  it('`thrifty` demotes only the reporter — the judge stays on the strong model', () => {
    const policy = defaultDevModelPolicy('jcode', 'thrifty');
    expect(policy.reporter!.model).toBe('deepseek/deepseek-v4-flash');
    expect(policy.judge!.model).toBe('deepseek/deepseek-v4-pro');
    expect(policy.critic!.model).toBe('moonshotai/kimi-k2.6');
  });

  it('`uniform` on jcode is still empty — every role falls back', () => {
    expect(defaultDevModelPolicy('jcode', 'uniform')).toEqual({});
  });

  // MUTATION KILLED: going back to the shallow `{ ...DEV_MODEL_PRESETS[preset] }`.
  // A policy value is an OBJECT now, so a shallow copy hands the caller the
  // preset's own route and `policy.critic.model = …` rewrites the shipped table
  // for the rest of the process.
  it('returns a DEEP copy — mutating a route cannot corrupt the preset table', () => {
    const policy = defaultDevModelPolicy('jcode');
    policy.critic!.model = 'mutated/id';
    policy.critic!.provider = 'deepseek';
    expect(DEV_MODEL_PRESETS.hetero.critic).toBe('openrouter:moonshotai/kimi-k2.6');
    expect(defaultDevModelPolicy('jcode').critic).toEqual({
      model: 'moonshotai/kimi-k2.6',
      provider: 'openrouter',
    });
  });
});

// ---------------------------------------------------------------------------
// THE PRESET CONTRACT — every id of every preset resolves to a provider that
// can actually serve it. This is the testable form of "the roster must mean
// something": a preset that mixes vendors is only honest if each id names, or
// the catalog knows, the endpoint that answers for it.
// ---------------------------------------------------------------------------

describe('DEV_MODEL_PRESETS — every id is servable by some provider', () => {
  const catalog = shippedCatalog();
  const index = buildModelProviderIndex(catalog);
  const PRESETS = Object.keys(DEV_MODEL_PRESETS) as (keyof typeof DEV_MODEL_PRESETS)[];

  // MUTATION KILLED: putting an id in a preset that no provider in `PROVIDERS`
  // can serve — which is precisely the `hetero` bug this wave fixes
  // (`z-ai/glm-5.2` and `moonshotai/kimi-k2.6` routed on a run whose only
  // endpoint was api.deepseek.com). Drop the `openrouter:` prefix from any
  // preset entry, or add an id absent from the catalog, and this fails.
  it('every preset id resolves to at least one provider that serves it', () => {
    for (const name of PRESETS) {
      const policy = defaultDevModelPolicy('jcode', name);
      for (const role of DEV_MODEL_ROLES) {
        const route = policy[role];
        if (!route) continue;
        for (const rung of modelRungs(route.model)) {
          const serves = providersForModel(rung, index, route.provider);
          expect(
            [...serves],
            `preset ${name} · role ${role} · id ${rung} is served by NOBODY`,
          ).not.toEqual([]);
        }
      }
    }
  });

  // The other half: "served by somebody" is worthless if no single run can be
  // pointed at that somebody. A preset must be RUNNABLE — there has to exist
  // one provider that serves EVERY role at once, because `AppConfig.provider`
  // is one provider for the whole session.
  //
  // MUTATION KILLED: mixing two single-endpoint vendors inside one preset
  // (say a `deepseek:`-pinned worker next to an `openrouter:`-pinned critic).
  // Every id would still be servable, and the preset would still be impossible.
  it('every preset is runnable on at least ONE provider, whole', () => {
    for (const name of PRESETS) {
      const policy = defaultDevModelPolicy('jcode', name);
      const runnable = PROVIDERS.map((p) => p.id).filter(
        (provider) =>
          devModelRefusals(checkDevModelPolicy({ policy, provider, index })).length === 0,
      );
      expect(runnable, `preset ${name} is runnable on NO provider`).not.toEqual([]);
    }
  });

  // The two constraints the design documents and must not lose.
  it('keeps the critic off the worker family, except in the A/B baseline', () => {
    for (const name of PRESETS) {
      const policy = defaultDevModelPolicy('jcode', name);
      if (!policy.critic || !policy.worker) continue;
      const sameFamily = policy.critic.model.split('/')[0] === policy.worker.model.split('/')[0];
      expect(sameFamily, `preset ${name}: critic shares the worker family`).toBe(
        name === 'monoculture',
      );
    }
  });

  // A judge that fails APPROVES SILENTLY — every CheckStep has a forward
  // `default: true` outcome — so no preset may route the judge to something
  // cheaper than the model whose work it is checking.
  //
  // MUTATION KILLED: demoting the judge the way `thrifty` demotes the reporter
  // (`judge: DS_FLASH`), or any future "cheap" preset that saves cents on the
  // one role where being wrong is invisible.
  it('never routes the judge below the worker it is checking', () => {
    const priceOf = new Map<string, number>();
    for (const m of catalog) {
      const price = m.inputPrice;
      if (price === undefined) continue;
      // The cheapest listing wins: an id served by two endpoints is the same
      // model, and the comparison is about CAPABILITY, not about routing cost.
      priceOf.set(m.id, Math.min(priceOf.get(m.id) ?? price, price));
    }
    for (const name of PRESETS) {
      const policy = defaultDevModelPolicy('jcode', name);
      const judge = policy.judge && priceOf.get(policy.judge.model);
      const worker = policy.worker && priceOf.get(policy.worker.model);
      if (judge === undefined || worker === undefined) continue;
      expect(judge, `preset ${name}: the judge is cheaper than the worker`).toBeGreaterThanOrEqual(
        worker,
      );
    }
  });
});

describe('DEV_MODEL_PRESETS.roster — the document roster over huu roles', () => {
  const index = buildModelProviderIndex(shippedCatalog());
  const policy = defaultDevModelPolicy('jcode', 'roster');

  it('maps all five roster models onto the seven roles', () => {
    expect(policy.planner!.model).toBe('deepseek/deepseek-v4-pro');
    expect(policy.recon!.model).toBe('deepseek/deepseek-v4-pro');
    expect(policy.worker!.model).toBe('deepseek/deepseek-v4-flash');
    expect(policy.critic!.model).toBe('openai/gpt-5.6-sol');
    expect(policy.reporter!.model).toBe('z-ai/glm-5.3-flash');
    expect(policy.judge!.model).toBe('anthropic/claude-opus-5');
    expect(policy.integration!.model).toBe('deepseek/deepseek-v4-pro');
  });

  it('runs whole on OpenRouter and is REFUSED on DeepSeek, by name', () => {
    expect(devModelRefusals(checkDevModelPolicy({ policy, provider: 'openrouter', index }))).toEqual(
      [],
    );
    const refused = devModelRefusals(checkDevModelPolicy({ policy, provider: 'deepseek', index }));
    expect(refused.map((r) => r.role).sort()).toEqual(['critic', 'judge', 'reporter']);
  });
});

describe('parseDevModelPolicy — untrusted input never throws', () => {
  it('keeps known roles with a non-empty string, trimmed', () => {
    expect(
      parseDevModelPolicy({ worker: ' deepseek/deepseek-v4-pro ', critic: 'moonshotai/kimi-k2.6' }),
    ).toEqual({
      worker: { model: 'deepseek/deepseek-v4-pro' },
      critic: { model: 'moonshotai/kimi-k2.6' },
    });
  });

  it('reads the provider a role pins, from either surface form', () => {
    expect(
      parseDevModelPolicy({
        worker: 'openrouter:anthropic/claude-opus-5',
        critic: { model: 'openai/gpt-5.6-sol', provider: 'openrouter' },
      }),
    ).toEqual({
      worker: { model: 'anthropic/claude-opus-5', provider: 'openrouter' },
      critic: { model: 'openai/gpt-5.6-sol', provider: 'openrouter' },
    });
  });

  it('drops unknown roles', () => {
    expect(parseDevModelPolicy({ worker: 'a/b', archivist: 'c/d', '': 'e/f' })).toEqual({
      worker: { model: 'a/b' },
    });
  });

  it('drops non-string and blank values without throwing', () => {
    expect(
      parseDevModelPolicy({
        worker: 42,
        critic: null,
        judge: { id: 'x/y' },
        recon: ['a/b'],
        reporter: '',
        integration: '   ',
        planner: true,
      }),
    ).toEqual({});
  });

  it('returns {} for anything that is not a plain object', () => {
    for (const raw of [undefined, null, 'hetero', 42, true, ['worker', 'a/b'], () => 'a/b']) {
      expect(parseDevModelPolicy(raw)).toEqual({});
    }
  });

  it('ignores prototype-pollution keys — only known roles are read', () => {
    const raw = JSON.parse('{"__proto__": {"worker": "evil/model"}, "constructor": "x"}');
    expect(parseDevModelPolicy(raw)).toEqual({});
    expect(({} as Record<string, unknown>).worker).toBeUndefined();
  });

  // THE JSON ROUND-TRIP that keeps `/api/bootstrap` honest: the browser is
  // handed `DEV_MODEL_PRESETS` as plain `role → string` and posts the same
  // strings back. The provider must survive that trip, which is exactly why it
  // is written as a `<provider>:` prefix and not as a nested object.
  it('round-trips a preset through a JSON payload, provider included', () => {
    const overTheWire = JSON.parse(JSON.stringify(DEV_MODEL_PRESETS.roster));
    expect(parseDevModelPolicy(overTheWire)).toEqual(defaultDevModelPolicy('jcode', 'roster'));
  });
});

describe('normalizeDevModelPolicy', () => {
  it('accepts strings and routes side by side, and drops the unnamed', () => {
    expect(
      normalizeDevModelPolicy({
        worker: 'a/b',
        critic: { model: 'c/d', provider: 'openrouter' },
        judge: '  ',
      }),
    ).toEqual({ worker: { model: 'a/b' }, critic: { model: 'c/d', provider: 'openrouter' } });
  });

  it('passes undefined through', () => {
    expect(normalizeDevModelPolicy(undefined)).toBeUndefined();
  });
});

describe('model fallback chains', () => {
  it('treats a single id exactly as before', () => {
    expect(modelRungs('deepseek/v4-pro')).toEqual(['deepseek/v4-pro']);
    expect(pickModelRung('deepseek/v4-pro')).toBe('deepseek/v4-pro');
  });

  it('splits an ordered chain and takes the first rung the registry has', () => {
    const known = (id: string): boolean => id === 'z-ai/glm-5.2';
    expect(pickModelRung('gone/model, z-ai/glm-5.2, other/one', known)).toBe('z-ai/glm-5.2');
  });

  it('falls back to the FIRST rung when nothing is known', () => {
    // Not `undefined`: the preflight is what refuses an all-dead chain, and it
    // must have an id to name. Silently resolving to the run model here would
    // hide the misconfiguration behind a run that works.
    expect(pickModelRung('a/x, b/y', () => false)).toBe('a/x');
  });

  it('keeps an unnamed role UNSET when it collapses a policy', () => {
    // The whole contract of routing: a role the policy never named must keep
    // omitting `modelId`, so AppConfig stays the single authority.
    const collapsed = collapseDevModelPolicy({ critic: { model: 'a/x, b/y' } }, (id) => id === 'b/y');
    expect(collapsed).toEqual({ critic: { model: 'b/y' } });
  });

  it('collapses nothing into undefined', () => {
    expect(collapseDevModelPolicy(undefined)).toBeUndefined();
    expect(collapseDevModelPolicy({})).toBeUndefined();
  });

  it('resolveDevModels still fills every role with the fallback', () => {
    const models = resolveDevModels(
      { worker: { model: 'dead/one, live/two' } },
      'run/model',
      (id) => id === 'live/two',
    );
    expect(models.worker).toBe('live/two');
    expect(models.judge).toBe('run/model');
  });

  it('keeps the route provider when it collapses a chain', () => {
    expect(pickModelRoute({ model: 'a/x, b/y', provider: 'openrouter' })).toEqual({
      model: 'a/x',
      provider: 'openrouter',
    });
  });
});

// ---------------------------------------------------------------------------
// The predicate the four call sites now inject — the thing that was DECLARED
// and never supplied, which is why every chain always collapsed to rung 0.
// ---------------------------------------------------------------------------

describe('modelKnownFor — the injected preflight predicate', () => {
  const index = buildModelProviderIndex([
    { id: 'deepseek/deepseek-v4-pro' },
    { id: 'deepseek/deepseek-v4-pro', provider: 'openrouter' },
    { id: 'anthropic/claude-opus-5', provider: 'openrouter' },
  ]);

  // MUTATION KILLED: dropping the third argument at a call site again (or
  // hard-coding `isKnown` back to `undefined`). The chain would then always
  // resolve to `anthropic/claude-opus-5` on a DeepSeek run.
  it('makes a chain choose the rung the run provider actually serves', () => {
    const known = modelKnownFor(index, 'deepseek');
    expect(pickModelRung('anthropic/claude-opus-5, deepseek/deepseek-v4-pro', known)).toBe(
      'deepseek/deepseek-v4-pro',
    );
    // …and the same chain keeps its first rung on OpenRouter, which serves it.
    expect(
      pickModelRung(
        'anthropic/claude-opus-5, deepseek/deepseek-v4-pro',
        modelKnownFor(index, 'openrouter'),
      ),
    ).toBe('anthropic/claude-opus-5');
  });

  it('never skips a rung it merely has no evidence about', () => {
    const known = modelKnownFor(index, 'deepseek');
    // Released after this catalog shipped: the user's order is respected.
    expect(pickModelRung('brand/new-model, deepseek/deepseek-v4-pro', known)).toBe(
      'brand/new-model',
    );
  });

  it('accepts everything when the run has no provider (stub)', () => {
    const known = modelKnownFor(index, undefined);
    expect(known('anthropic/claude-opus-5')).toBe(true);
    expect(known('anything/at-all')).toBe(true);
  });

  it("judges a rung against the ROUTE's provider when it declares one", () => {
    const known = modelKnownFor(index, 'deepseek');
    expect(known('anthropic/claude-opus-5')).toBe(false);
    expect(known('anthropic/claude-opus-5', 'openrouter')).toBe(true);
  });
});

describe('checkDevModelPolicy — refuse on contradiction, warn on absence', () => {
  const index = buildModelProviderIndex([
    { id: 'deepseek/deepseek-v4-pro' },
    { id: 'deepseek/deepseek-v4-pro', provider: 'openrouter' },
    { id: 'moonshotai/kimi-k2.6', provider: 'openrouter' },
  ]);

  it('says nothing at all when nothing is routed, or nothing is called', () => {
    expect(checkDevModelPolicy({ policy: undefined, provider: 'deepseek', index })).toEqual([]);
    expect(
      checkDevModelPolicy({
        policy: { worker: { model: 'moonshotai/kimi-k2.6', provider: 'openrouter' } },
        provider: undefined,
        index,
      }),
    ).toEqual([]);
  });

  // MUTATION KILLED: making the refusal branch trust only the catalog and
  // ignore a route's declared provider. huu would then have to ship a catalog
  // for every audited repo to catch the mismatch.
  it('REFUSES a route that names another endpoint, with no catalog help', () => {
    const issues = checkDevModelPolicy({
      policy: { planner: { model: 'brand/new', provider: 'openrouter' } },
      provider: 'deepseek',
      index: EMPTY_MODEL_PROVIDER_INDEX,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('refuse');
    expect(issues[0]!.role).toBe('planner');
    expect(issues[0]!.message).toContain('brand/new');
    expect(issues[0]!.message).toContain('openrouter');
    expect(issues[0]!.message).toContain('--provider=openrouter');
  });

  it('REFUSES an id the catalog places on another endpoint only', () => {
    const issues = checkDevModelPolicy({
      policy: { critic: { model: 'moonshotai/kimi-k2.6' } },
      provider: 'deepseek',
      index,
    });
    expect(issues.map((i) => i.severity)).toEqual(['refuse']);
    expect(issues[0]!.servedBy).toEqual(['openrouter']);
  });

  it('WARNS — never refuses — for an id the catalog has never heard of', () => {
    const issues = checkDevModelPolicy({
      policy: { worker: { model: 'released/yesterday' } },
      provider: 'deepseek',
      index,
    });
    expect(issues.map((i) => i.severity)).toEqual(['warn']);
    expect(devModelRefusals(issues)).toEqual([]);
    expect(issues[0]!.servedBy).toEqual([]);
  });

  it('accepts an id both endpoints serve, under either one', () => {
    for (const provider of ['deepseek', 'openrouter'] as LlmProvider[]) {
      expect(
        checkDevModelPolicy({
          policy: { worker: { model: 'deepseek/deepseek-v4-pro' } },
          provider,
          index,
        }),
      ).toEqual([]);
    }
  });

  // The chain is collapsed FIRST, so a refusal names the rung that would have
  // run — not a rung the fallback already stepped past.
  it('does not refuse a chain whose surviving rung is fine', () => {
    const policy: DevModelPolicy = {
      worker: { model: 'moonshotai/kimi-k2.6, deepseek/deepseek-v4-pro' },
    };
    expect(checkDevModelPolicy({ policy, provider: 'deepseek', index })).toEqual([]);
  });

  it('names every offending role, not just the first', () => {
    const policy: DevModelPolicy = {
      planner: { model: 'moonshotai/kimi-k2.6' },
      critic: { model: 'moonshotai/kimi-k2.6' },
      worker: { model: 'deepseek/deepseek-v4-pro' },
    };
    const roles = devModelRefusals(
      checkDevModelPolicy({ policy, provider: 'deepseek', index }),
    ).map((i) => i.role as DevModelRole);
    expect(roles.sort()).toEqual(['critic', 'planner']);
  });
});

// ---------------------------------------------------------------------------
// ACHADO 2 — the `<provider>:` prefix belongs to a RUNG, not to the value.
// ---------------------------------------------------------------------------

describe('a chain reads its prefixes PER RUNG', () => {
  const index = buildModelProviderIndex([
    { id: 'z-ai/glm-5.2', provider: 'openrouter' },
    { id: 'moonshotai/kimi-k2.6', provider: 'openrouter' },
    { id: 'deepseek/deepseek-v4-pro' },
    { id: 'deepseek/deepseek-v4-pro', provider: 'openrouter' },
  ]);

  // MUTATION KILLED: reading the prefix off the head of the WHOLE value again
  // (`parseRouteString` slicing at the first colon before splitting on commas).
  // Rung 2's prefix then becomes unreadable, the rung is picked anyway, and the
  // id stamped onto the step is the literal `openrouter:moonshotai/kimi-k2.6` —
  // which travels VERBATIM to whatever endpoint the run is on.
  it('reads the prefix of a rung past the first, and strips it from the id', () => {
    const route = parseModelRoute('z-ai/glm-5.2, openrouter:moonshotai/kimi-k2.6');
    // The chain keeps both rungs INTACT, prefix included — nothing is hoisted.
    expect(route).toEqual({ model: 'z-ai/glm-5.2, openrouter:moonshotai/kimi-k2.6' });
    // On DeepSeek the first rung is positively contradicted, so the second one
    // runs — as ITS OWN provider's id, with the prefix consumed.
    expect(pickModelRoute(route, modelKnownFor(index, 'deepseek'))).toEqual({
      model: 'moonshotai/kimi-k2.6',
      provider: 'openrouter',
    });
    // …and the stamped id never carries the prefix.
    expect(
      resolveDevModels({ critic: route }, FALLBACK, modelKnownFor(index, 'deepseek')).critic,
    ).toBe('moonshotai/kimi-k2.6');
  });

  // THE MEASURED BUG, as a refusal message. With the prefix read off the head
  // of the whole value, rung 2 was picked as the literal id
  // `openrouter:moonshotai/kimi-k2.6`, no catalog entry matched it, and the
  // preflight downgraded to a WARN — so the invented id travelled verbatim to
  // api.deepseek.com.
  it('names the rung that would ACTUALLY run, with its prefix consumed', () => {
    const policy = { judge: parseModelRoute('z-ai/glm-5.2, openrouter:moonshotai/kimi-k2.6')! };
    const refusals = devModelRefusals(checkDevModelPolicy({ policy, provider: 'deepseek', index }));
    expect(refusals.map((r) => r.modelId)).toEqual(['moonshotai/kimi-k2.6']);
    expect(refusals[0]!.servedBy).toEqual(['openrouter']);
    expect(refusals[0]!.message).not.toContain('openrouter:moonshotai');
  });

  it("carries a later rung's OWN prefix through selection, and consumes it", () => {
    // The run is on DeepSeek. Rung 1 is openrouter-only and declares nothing,
    // so it is positively contradicted and skipped; rung 2 declares `deepseek:`
    // — the prefix is read there, the id is stamped WITHOUT it, and the
    // preflight has no contradiction left to raise.
    const route = parseModelRoute('z-ai/glm-5.2, deepseek:deepseek/deepseek-v4-pro')!;
    expect(pickModelRoute(route, modelKnownFor(index, 'deepseek'))).toEqual({
      model: 'deepseek/deepseek-v4-pro',
      provider: 'deepseek',
    });
    expect(
      devModelRefusals(
        checkDevModelPolicy({ policy: { planner: route }, provider: 'deepseek', index }),
      ),
    ).toEqual([]);
  });

  it("a route-level provider is only the DEFAULT — a rung's own prefix wins", () => {
    const route = { model: 'a/x, openrouter:b/y', provider: 'deepseek' as const };
    expect(pickModelRoute(route, (id) => id === 'b/y')).toEqual({
      model: 'b/y',
      provider: 'openrouter',
    });
    // The rung that declares nothing still inherits the route's provider.
    expect(pickModelRoute(route)).toEqual({ model: 'a/x', provider: 'deepseek' });
  });

  it('round-trips a chain through format/parse with every prefix intact', () => {
    const raw = 'z-ai/glm-5.2, openrouter:moonshotai/kimi-k2.6';
    expect(formatModelRoute(parseModelRoute(raw)!)).toBe(raw);
  });

  // MUTATION KILLED: falling through to `{ model: value }` when the tail after
  // a recognized prefix is empty. `"openrouter:"` then becomes a model ID —
  // `--worker-model=openrouter:` is accepted and the string `"openrouter:"`
  // goes on the wire.
  it('refuses an EMPTY TAIL instead of turning it into a model id', () => {
    for (const raw of ['openrouter:', 'deepseek:', '  openrouter:  ', 'openrouter: ']) {
      expect(parseModelRoute(raw)).toBeUndefined();
    }
    // Inside a chain it poisons the whole value: a chain is an ORDERED promise,
    // so silently dropping a rung would change which model runs.
    expect(parseModelRoute('a/x, openrouter:')).toBeUndefined();
    // The untrusted POST path degrades to "no routing for that role".
    expect(parseDevModelPolicy({ worker: 'openrouter:' })).toEqual({});
    // A colon that is NOT a provider prefix is left completely alone.
    expect(parseModelRoute('deepseek/deepseek-r1:free')).toEqual({
      model: 'deepseek/deepseek-r1:free',
    });
  });
});

// ---------------------------------------------------------------------------
// ACHADO 3 — the union must stay MONOTONIC: more catalogs, never more refusals.
// ---------------------------------------------------------------------------

describe('buildModelProviderIndex — an absent provider is not evidence', () => {
  // MUTATION KILLED: going back to `entry.provider ?? 'deepseek'` for a catalog
  // huu did not write. An id only the audited project lists, with no provider
  // field, then gains a fabricated "served by deepseek" — and an OpenRouter run
  // routed to it flips from `warn` to `refuse`. Reading a second catalog would
  // make the preflight STRICTER, which is the opposite of what makes the union
  // safe to perform at all.
  it('contributes NOTHING for a provider-less entry when told not to guess', () => {
    const project = buildModelProviderIndex([{ id: 'qwen/qwen3-coder' }], {
      defaultProvider: null,
    });
    expect(providersForModel('qwen/qwen3-coder', project).size).toBe(0);
    const issues = checkDevModelPolicy({
      policy: { worker: { model: 'qwen/qwen3-coder' } },
      provider: 'openrouter',
      index: project,
    });
    expect(issues.map((i) => i.severity)).toEqual(['warn']);
    expect(devModelRefusals(issues)).toEqual([]);
  });

  it("keeps `?? 'deepseek'` for huu's OWN catalog, where the field postdates the entries", () => {
    const own = buildModelProviderIndex([{ id: 'legacy/id' }]);
    expect([...providersForModel('legacy/id', own)]).toEqual(['deepseek']);
  });

  // THE MEASURED BUG. With `?? 'deepseek'` applied to the project's entries,
  // adding the audited repo's catalog turned this policy from `warn` into
  // `refuse: worker → "qwen/qwen3-coder" is served by deepseek, and this run is
  // on openrouter` — i.e. reading MORE catalogs made the preflight STRICTER.
  it('never turns a warning into a refusal through an OMITTED provider field', () => {
    const own = buildModelProviderIndex([
      { id: 'deepseek/deepseek-v4-pro' },
      { id: 'deepseek/deepseek-v4-pro', provider: 'openrouter' },
    ]);
    const project = buildModelProviderIndex([{ id: 'qwen/qwen3-coder' }], {
      defaultProvider: null,
    });
    const merged = unionModelProviderIndexes(own, project);
    const policy: DevModelPolicy = {
      worker: { model: 'qwen/qwen3-coder' },
      recon: { model: 'deepseek/deepseek-v4-pro' },
    };
    for (const provider of PROVIDERS.map((p) => p.id)) {
      const before = devModelRefusals(checkDevModelPolicy({ policy, provider, index: own }));
      const after = devModelRefusals(checkDevModelPolicy({ policy, provider, index: merged }));
      expect(after, `reading the project catalog must not refuse more on ${provider}`)
        .toEqual(before);
      expect(after).toEqual([]);
    }
  });

  // The BOUNDARY, stated so nobody widens the rule by accident: a project
  // catalog that DOES name a provider is real evidence, and a refusal drawn
  // from it is exactly the refusal the preflight exists to make. What the
  // union may never do is manufacture that evidence out of a missing field.
  it('still refuses on evidence a catalog actually STATES', () => {
    const merged = unionModelProviderIndexes(
      buildModelProviderIndex([]),
      buildModelProviderIndex([{ id: 'brand/new', provider: 'openrouter' }], {
        defaultProvider: null,
      }),
    );
    const issues = checkDevModelPolicy({
      policy: { critic: { model: 'brand/new' } },
      provider: 'deepseek',
      index: merged,
    });
    expect(devModelRefusals(issues).map((i) => i.modelId)).toEqual(['brand/new']);
  });

  it('unions the provider SETS rather than letting one catalog win', () => {
    const merged = unionModelProviderIndexes(
      buildModelProviderIndex([{ id: 'a/b' }]),
      buildModelProviderIndex([{ id: 'A/B', provider: 'openrouter' }]),
    );
    expect([...providersForModel('a/b', merged)].sort()).toEqual(['deepseek', 'openrouter']);
  });
});

// ---------------------------------------------------------------------------
// ACHADO 4 — every preset value must be a STRING.
// ---------------------------------------------------------------------------

describe('DEV_MODEL_PRESETS — the shape the browser is handed', () => {
  // WHY IT MATTERS. `/api/bootstrap` ships this table verbatim and the client
  // reads it as a flat `role → string` map: `dev-models.js` does
  // `typeof policy[role] === 'string' ? … : ''`. A preset written with the
  // structured `{model, provider}` form would render EVERY field empty,
  // `buildDevModelsPayload` would return `{}` — and the preset would become a
  // silent no-op in the browser while working perfectly in the CLI.
  //
  // MUTATION KILLED: writing one preset value as `{ model: 'x', provider: 'y' }`.
  // The JSON round-trip assertion above does NOT catch it (`parseModelRoute`
  // accepts an object, so both sides agree); only a type check does.
  it('is a flat role→string map, with no nested route objects', () => {
    const offenders: string[] = [];
    for (const [preset, policy] of Object.entries(DEV_MODEL_PRESETS)) {
      for (const [role, value] of Object.entries(policy as Record<string, unknown>)) {
        if (typeof value !== 'string' || value.trim().length === 0) {
          offenders.push(`${preset}.${role} = ${JSON.stringify(value)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('names only roles that exist, so nothing is silently dropped', () => {
    for (const [preset, policy] of Object.entries(DEV_MODEL_PRESETS)) {
      for (const role of Object.keys(policy)) {
        expect(DEV_MODEL_ROLES, `${preset}.${role}`).toContain(role as DevModelRole);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The verdict the SURFACES need up front: which provider can run which preset.
// ---------------------------------------------------------------------------

describe('devModelPresetProviders', () => {
  const index = buildModelProviderIndex(shippedCatalog());

  it('answers exactly what checkDevModelPolicy would answer', () => {
    const table = devModelPresetProviders(index);
    for (const [preset, providers] of Object.entries(table)) {
      for (const p of PROVIDERS.map((x) => x.id)) {
        const policy = normalizeDevModelPolicy(
          DEV_MODEL_PRESETS[preset as keyof typeof DEV_MODEL_PRESETS],
        );
        const routed = policy && Object.keys(policy).length > 0 ? policy : undefined;
        const refused =
          devModelRefusals(checkDevModelPolicy({ policy: routed, provider: p, index })).length > 0;
        expect(providers.includes(p), `${preset} on ${p}`).toBe(!refused);
      }
    }
  });

  // The matrix the web form opens against. `uniform` pins nothing, so it runs
  // anywhere; every other shipped preset names at least one openrouter-only id.
  it('places every shipped preset but `uniform` on OpenRouter only', () => {
    expect(devModelPresetProviders(index)).toEqual({
      hetero: ['openrouter'],
      thrifty: ['openrouter'],
      monoculture: ['openrouter'],
      roster: ['openrouter'],
      uniform: ['deepseek', 'openrouter'],
    });
  });

  it('warnings never disqualify a preset — only refusals do', () => {
    // An empty index knows nothing, so every id is "no evidence" ⇒ warn ⇒ the
    // preset stays offered, EXCEPT where a route names another endpoint itself.
    const blind = devModelPresetProviders(EMPTY_MODEL_PROVIDER_INDEX);
    expect(blind.uniform).toEqual(['deepseek', 'openrouter']);
    expect(blind.hetero).toEqual(['openrouter']);
  });
});

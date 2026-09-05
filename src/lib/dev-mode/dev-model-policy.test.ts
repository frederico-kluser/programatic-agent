import { describe, expect, it } from 'vitest';
import {
  DEV_MODEL_ROLES,
  defaultDevModelPolicy,
  parseDevModelPolicy,
  resolveDevModels,
  collapseDevModelPolicy,
  modelRungs,
  pickModelRung,
} from './dev-model-policy.js';
import { DEV_MODEL_PRESETS, type DevModelRole } from '../types.js';

const FALLBACK = 'deepseek/deepseek-v4-flash';

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
      { critic: 'moonshotai/kimi-k2.6', worker: 'deepseek/deepseek-v4-pro' },
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
    const resolved = resolveDevModels({ worker: '  a/b  ', judge: '   ' }, FALLBACK);
    expect(resolved.worker).toBe('a/b');
    expect(resolved.judge).toBe(FALLBACK);
  });

  it('resolves the `uniform` preset to today behavior, byte for byte', () => {
    const resolved = resolveDevModels(DEV_MODEL_PRESETS.uniform, FALLBACK);
    for (const role of DEV_MODEL_ROLES) expect(resolved[role]).toBe(FALLBACK);
  });
});

describe('defaultDevModelPolicy', () => {
  it('is EMPTY for stub — every preset id is served by jcode', () => {
    for (const backend of ['stub'] as const) {
      expect(defaultDevModelPolicy(backend)).toEqual({});
      // Even when a preset is asked for explicitly.
      expect(defaultDevModelPolicy(backend, 'hetero')).toEqual({});
      expect(defaultDevModelPolicy(backend, 'monoculture')).toEqual({});
      // …and therefore still resolves every role to the run model.
      const resolved = resolveDevModels(defaultDevModelPolicy(backend), FALLBACK);
      for (const role of DEV_MODEL_ROLES) expect(resolved[role]).toBe(FALLBACK);
    }
  });

  it('defaults to `hetero` on jcode: cross-family critic, glm planner', () => {
    const policy = defaultDevModelPolicy('jcode');
    expect(policy.critic).toBe('moonshotai/kimi-k2.6');
    expect(policy.planner).toBe('z-ai/glm-5.2');
    expect(policy.worker).toBe('deepseek/deepseek-v4-pro');
    // The critic must NOT come from the worker's family — that is the point.
    expect(policy.critic).not.toBe(policy.worker);
  });

  it('`monoculture` puts the critic back on the worker model', () => {
    const policy = defaultDevModelPolicy('jcode', 'monoculture');
    expect(policy.critic).toBe('deepseek/deepseek-v4-pro');
    expect(policy.critic).toBe(policy.worker);
  });

  it('`thrifty` demotes only the reporter — the judge stays on the strong model', () => {
    const policy = defaultDevModelPolicy('jcode', 'thrifty');
    expect(policy.reporter).toBe('deepseek/deepseek-v4-flash');
    expect(policy.judge).toBe('deepseek/deepseek-v4-pro');
    expect(policy.critic).toBe('moonshotai/kimi-k2.6');
  });

  it('`uniform` on jcode is still empty — every role falls back', () => {
    expect(defaultDevModelPolicy('jcode', 'uniform')).toEqual({});
  });

  it('returns a fresh copy — mutating it cannot corrupt the preset table', () => {
    const policy = defaultDevModelPolicy('jcode');
    policy.critic = 'mutated/id';
    expect(DEV_MODEL_PRESETS.hetero.critic).toBe('moonshotai/kimi-k2.6');
    expect(defaultDevModelPolicy('jcode').critic).toBe('moonshotai/kimi-k2.6');
  });
});

describe('parseDevModelPolicy — untrusted input never throws', () => {
  it('keeps known roles with a non-empty string, trimmed', () => {
    expect(
      parseDevModelPolicy({ worker: ' deepseek/deepseek-v4-pro ', critic: 'moonshotai/kimi-k2.6' }),
    ).toEqual({ worker: 'deepseek/deepseek-v4-pro', critic: 'moonshotai/kimi-k2.6' });
  });

  it('drops unknown roles', () => {
    expect(parseDevModelPolicy({ worker: 'a/b', archivist: 'c/d', '': 'e/f' })).toEqual({
      worker: 'a/b',
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

  it('round-trips a preset', () => {
    const parsed = parseDevModelPolicy(JSON.parse(JSON.stringify(DEV_MODEL_PRESETS.hetero)));
    expect(parsed).toEqual({ ...DEV_MODEL_PRESETS.hetero });
    const resolved = resolveDevModels(parsed, FALLBACK);
    const expected: Record<DevModelRole, string> = { ...DEV_MODEL_PRESETS.hetero };
    expect(resolved).toEqual(expected);
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
    const collapsed = collapseDevModelPolicy({ critic: 'a/x, b/y' }, (id) => id === 'b/y');
    expect(collapsed).toEqual({ critic: 'b/y' });
  });

  it('collapses nothing into undefined', () => {
    expect(collapseDevModelPolicy(undefined)).toBeUndefined();
    expect(collapseDevModelPolicy({})).toBeUndefined();
  });

  it('resolveDevModels still fills every role with the fallback', () => {
    const models = resolveDevModels({ worker: 'dead/one, live/two' }, 'run/model', (id) => id === 'live/two');
    expect(models.worker).toBe('live/two');
    expect(models.judge).toBe('run/model');
  });
});

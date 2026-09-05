import { describe, expect, it } from 'vitest';
import {
  buildDevModelsPayload,
  defaultPreset,
  describeDevModelsPayload,
  fallbackModelIdFrom,
  matchesPreset,
  presetPolicy,
  presetRunnable,
  presetValues,
} from './dev-models.js';

// The panel's whole contract is "what goes in the POST body". These pin it,
// because the client half and the server half of this feature were written in
// parallel against a written contract and nothing else checks them together.

const ROLES = ['planner', 'recon', 'worker', 'critic', 'reporter', 'judge', 'integration'];

// A stand-in for DEV_MODEL_PRESETS as /api/bootstrap serves it. Values are
// arbitrary on purpose: the client must never assume WHICH ids a preset holds.
const PRESETS = {
  hetero: {
    planner: 'z-ai/glm-5.2',
    recon: 'deepseek/deepseek-v4-pro',
    worker: 'deepseek/deepseek-v4-pro',
    critic: 'moonshotai/kimi-k2.6',
    reporter: 'deepseek/deepseek-v4-pro',
    judge: 'deepseek/deepseek-v4-pro',
    integration: 'deepseek/deepseek-v4-pro',
  },
  monoculture: {
    planner: 'z-ai/glm-5.2',
    recon: 'deepseek/deepseek-v4-pro',
    worker: 'deepseek/deepseek-v4-pro',
    critic: 'deepseek/deepseek-v4-pro',
    reporter: 'deepseek/deepseek-v4-pro',
    judge: 'deepseek/deepseek-v4-pro',
    integration: 'deepseek/deepseek-v4-pro',
  },
  uniform: {},
};

describe('presetPolicy', () => {
  it('returns the named policy', () => {
    expect(presetPolicy(PRESETS, 'hetero').critic).toBe('moonshotai/kimi-k2.6');
  });

  it('degrades to {} for absent tables, unknown names and non-objects', () => {
    expect(presetPolicy(undefined, 'hetero')).toEqual({});
    expect(presetPolicy(PRESETS, 'nope')).toEqual({});
    expect(presetPolicy({ hetero: 'not-an-object' }, 'hetero')).toEqual({});
    expect(presetPolicy({ hetero: ['a'] }, 'hetero')).toEqual({});
  });
});

describe('presetValues', () => {
  it('gives every role an entry, empty where the preset pins nothing', () => {
    const values = presetValues(ROLES, PRESETS, 'uniform');
    expect(Object.keys(values).sort()).toEqual([...ROLES].sort());
    for (const role of ROLES) expect(values[role]).toBe('');
  });

  it('mirrors the preset for a pinned table', () => {
    expect(presetValues(ROLES, PRESETS, 'hetero')).toEqual(PRESETS.hetero);
  });
});

describe('matchesPreset', () => {
  it('ignores surrounding whitespace on both sides', () => {
    const values = { ...PRESETS.hetero, critic: '  moonshotai/kimi-k2.6  ' };
    expect(matchesPreset(ROLES, PRESETS, 'hetero', values)).toBe(true);
  });

  it('sees a single edited role', () => {
    const values = { ...PRESETS.hetero, critic: 'openai/gpt-5' };
    expect(matchesPreset(ROLES, PRESETS, 'hetero', values)).toBe(false);
  });

  it('treats all-empty as `uniform`', () => {
    expect(matchesPreset(ROLES, PRESETS, 'uniform', {})).toBe(true);
  });
});

describe('buildDevModelsPayload', () => {
  it('sends NOTHING when no role is pinned — today\'s body, byte for byte', () => {
    expect(
      buildDevModelsPayload({
        roles: ROLES,
        presets: PRESETS,
        preset: 'uniform',
        values: presetValues(ROLES, PRESETS, 'uniform'),
      }),
    ).toEqual({});
  });

  it('sends the preset NAME while it is untouched, and never both fields', () => {
    const payload = buildDevModelsPayload({
      roles: ROLES,
      presets: PRESETS,
      preset: 'hetero',
      values: presetValues(ROLES, PRESETS, 'hetero'),
    });
    expect(payload).toEqual({ modelsPreset: 'hetero' });
    expect(payload.models).toBeUndefined();
  });

  it('switches to an explicit map as soon as one field is edited', () => {
    const values = { ...presetValues(ROLES, PRESETS, 'hetero'), critic: 'openai/gpt-5' };
    const payload = buildDevModelsPayload({ roles: ROLES, presets: PRESETS, preset: 'hetero', values });
    expect(payload.modelsPreset).toBeUndefined();
    expect(payload.models.critic).toBe('openai/gpt-5');
    expect(payload.models.worker).toBe(PRESETS.hetero.worker);
  });

  it('omits blank roles from the explicit map, so they keep falling back', () => {
    const values = { planner: 'z-ai/glm-5.2', worker: '   ', critic: '' };
    const payload = buildDevModelsPayload({ roles: ROLES, presets: PRESETS, preset: 'hetero', values });
    expect(payload.models).toEqual({ planner: 'z-ai/glm-5.2' });
  });

  it('trims what it does send', () => {
    const payload = buildDevModelsPayload({
      roles: ROLES,
      presets: PRESETS,
      preset: 'uniform',
      values: { worker: '  deepseek/deepseek-v4-pro  ' },
    });
    expect(payload).toEqual({ models: { worker: 'deepseek/deepseek-v4-pro' } });
  });

  it('clearing every field of a pinned preset falls all the way back to {}', () => {
    const payload = buildDevModelsPayload({
      roles: ROLES,
      presets: PRESETS,
      preset: 'hetero',
      values: {},
    });
    expect(payload).toEqual({});
  });

  it('survives an absent table / absent roles without throwing', () => {
    expect(buildDevModelsPayload()).toEqual({});
    expect(buildDevModelsPayload({ roles: ROLES, presets: undefined, preset: 'hetero', values: {} })).toEqual({});
    expect(
      buildDevModelsPayload({ roles: ROLES, presets: undefined, preset: 'x', values: { worker: 'a/b' } }),
    ).toEqual({ models: { worker: 'a/b' } });
  });

  it('never leaks a role the server did not advertise', () => {
    const payload = buildDevModelsPayload({
      roles: ['worker'],
      presets: PRESETS,
      preset: 'uniform',
      values: { worker: 'a/b', __proto__: 'evil', ghost: 'c/d' },
    });
    expect(payload).toEqual({ models: { worker: 'a/b' } });
  });
});

describe('describeDevModelsPayload', () => {
  it('names the preset, counts hand-pinned roles, and says so when nothing is set', () => {
    expect(describeDevModelsPayload({ modelsPreset: 'hetero' })).toContain('hetero');
    expect(describeDevModelsPayload({ models: { worker: 'a/b' } })).toBe('1 role pinned by hand');
    expect(describeDevModelsPayload({ models: { worker: 'a/b', judge: 'c/d' } })).toBe('2 roles pinned by hand');
    expect(describeDevModelsPayload({})).toBe('every role on the same model');
  });
});

/* ── Which presets the ACTIVE PROVIDER can run ─────────────────────────────
   `/dev` opens with a preset ALREADY selected, so the opening preset has to be
   one the selected provider can serve. It was `hetero` unconditionally, and on
   a machine whose only key is DeepSeek that made "open /dev, press Start" a
   400 from the server's model preflight — four of the five presets are refused
   there. The verdict comes from `/api/bootstrap` (`devModelPresetProviders`),
   produced by the same `checkDevModelPolicy` that refuses the POST. */

const PRESET_PROVIDERS = {
  hetero: ['openrouter'],
  monoculture: ['openrouter'],
  uniform: ['deepseek', 'openrouter'],
};

describe('presetRunnable', () => {
  it('reads the server verdict', () => {
    expect(presetRunnable(PRESET_PROVIDERS, 'hetero', 'openrouter')).toBe(true);
    expect(presetRunnable(PRESET_PROVIDERS, 'hetero', 'deepseek')).toBe(false);
    expect(presetRunnable(PRESET_PROVIDERS, 'uniform', 'deepseek')).toBe(true);
  });

  it('answers YES whenever it has nothing to go on', () => {
    // An older server, an unknown preset, or no provider picked yet. The border
    // still refuses an impossible body — degrading toward the server's
    // authority, never around it.
    expect(presetRunnable(null, 'hetero', 'deepseek')).toBe(true);
    expect(presetRunnable(undefined, 'hetero', 'deepseek')).toBe(true);
    expect(presetRunnable(PRESET_PROVIDERS, 'brand-new', 'deepseek')).toBe(true);
    expect(presetRunnable(PRESET_PROVIDERS, 'hetero', undefined)).toBe(true);
  });
});

describe('defaultPreset', () => {
  const NAMES = Object.keys(PRESET_PROVIDERS);

  // MUTATION KILLED: returning `hetero` whenever the list contains it (the
  // provider-blind default). The DeepSeek column goes back to a preset the
  // provider cannot serve, i.e. the default `/dev` path goes back to a 400.
  it('opens on the recommended split ONLY where it can run', () => {
    expect(defaultPreset(PRESET_PROVIDERS, NAMES, 'openrouter')).toBe('hetero');
    expect(defaultPreset(PRESET_PROVIDERS, NAMES, 'deepseek')).toBe('uniform');
  });

  it('keeps the old provider-blind answer when the server advertises nothing', () => {
    expect(defaultPreset(null, NAMES, 'deepseek')).toBe('hetero');
  });

  it('falls back to the raw list rather than offering nothing', () => {
    const nowhere = { hetero: [], monoculture: [], uniform: [] };
    expect(defaultPreset(nowhere, NAMES, 'deepseek')).toBe('hetero');
    expect(defaultPreset(PRESET_PROVIDERS, [], 'deepseek')).toBe('hetero');
    expect(defaultPreset(PRESET_PROVIDERS, ['solo'], 'deepseek')).toBe('solo');
  });
});

describe('fallbackModelIdFrom', () => {
  it('prefers the worker, then the planner, then anything pinned', () => {
    expect(fallbackModelIdFrom(ROLES, presetValues(ROLES, PRESETS, 'hetero')))
      .toBe('deepseek/deepseek-v4-pro');
    expect(fallbackModelIdFrom(ROLES, { planner: ' a/b ' })).toBe('a/b');
    expect(fallbackModelIdFrom(ROLES, { judge: 'c/d' })).toBe('c/d');
  });

  it("returns '' when nothing is pinned, so the caller supplies the default", () => {
    expect(fallbackModelIdFrom(ROLES, presetValues(ROLES, PRESETS, 'uniform'))).toBe('');
    expect(fallbackModelIdFrom(undefined, undefined)).toBe('');
  });
});

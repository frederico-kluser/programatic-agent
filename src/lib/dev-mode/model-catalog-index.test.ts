import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { devModelProviderIndex } from './model-catalog-index.js';
import { checkDevModelPolicy, devModelRefusals, providersForModel } from './dev-model-policy.js';

describe('devModelProviderIndex', () => {
  // THE FALSE-REFUSAL REGRESSION. An audited repository almost never ships a
  // `recommended-models.json`, and `loadRecommendedModels` then falls back to
  // the 3-entry in-code list in `src/models/catalog.ts`, which lists
  // `deepseek/deepseek-v4-flash` under `deepseek` ONLY. Judging a session
  // against that alone made the preflight refuse a perfectly good
  // `--provider=openrouter` run of huu's own default model.
  //
  // MUTATION KILLED: building the index from the project root alone
  // (`buildModelProviderIndex(loadRecommendedModels(cwd))`). The default model
  // stops being servable on OpenRouter and the run is refused for nothing.
  it('carries huu OWN catalog even for a project that ships none', () => {
    const empty = mkdtempSync(join(tmpdir(), 'huu-modelidx-'));
    try {
      const index = devModelProviderIndex(empty);
      expect([...providersForModel('deepseek/deepseek-v4-flash', index)].sort()).toEqual([
        'deepseek',
        'openrouter',
      ]);
      // …and the preflight therefore accepts it under either endpoint.
      for (const provider of ['deepseek', 'openrouter'] as const) {
        expect(
          checkDevModelPolicy({
            policy: { worker: { model: 'deepseek/deepseek-v4-flash' } },
            provider,
            index,
          }),
        ).toEqual([]);
      }
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  // A project catalog UNIONS with huu's — it can add ids, never take them away.
  //
  // MUTATION KILLED: letting the project's file REPLACE huu's (the shape
  // `loadRecommendedModels` itself uses). A repo that ships a one-entry catalog
  // would then have every preset refused against it.
  it('unions the project catalog on top, never in place of, huu own', () => {
    const dir = mkdtempSync(join(tmpdir(), 'huu-modelidx-'));
    try {
      writeFileSync(
        join(dir, 'recommended-models.json'),
        JSON.stringify({
          models: [{ id: 'acme/private-deployment', label: 'Acme', provider: 'openrouter' }],
        }),
      );
      const index = devModelProviderIndex(dir);
      // The project's own id is now known…
      expect([...providersForModel('acme/private-deployment', index)]).toEqual(['openrouter']);
      // …and huu's are still there.
      expect(providersForModel('anthropic/claude-opus-5', index).has('openrouter')).toBe(true);
      // A one-entry project catalog cannot make the shipped roster unrunnable.
      const policy = { judge: { model: 'anthropic/claude-opus-5', provider: 'openrouter' as const } };
      expect(
        devModelRefusals(checkDevModelPolicy({ policy, provider: 'openrouter', index })),
      ).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // THE FALSE-REFUSAL THE UNION ITSELF INTRODUCED, measured: with
  // `entry.provider ?? 'deepseek'` applied to somebody else's catalog, an id
  // only the audited project lists — with no `provider` field — gained a
  // fabricated "served by deepseek", and an `--provider=openrouter` run routed
  // to it flipped from `warn` to
  //   refuse: worker → "qwen/qwen3-coder" is served by deepseek, and this run
  //   is on openrouter
  // i.e. READING the project catalog made the preflight STRICTER — the exact
  // opposite of what makes unioning it safe.
  //
  // MUTATION KILLED: dropping `{ defaultProvider: null }` from the project half
  // of the union.
  it('reads a provider-less PROJECT entry as "unknown", never as deepseek', () => {
    const dir = mkdtempSync(join(tmpdir(), 'huu-modelidx-'));
    try {
      writeFileSync(
        join(dir, 'recommended-models.json'),
        JSON.stringify({ models: [{ id: 'qwen/qwen3-coder', label: 'Qwen3 Coder' }] }),
      );
      const index = devModelProviderIndex(dir);
      // No evidence either way — the entry says the id EXISTS, not where.
      expect(providersForModel('qwen/qwen3-coder', index).size).toBe(0);
      for (const provider of ['deepseek', 'openrouter'] as const) {
        const issues = checkDevModelPolicy({
          policy: { worker: { model: 'qwen/qwen3-coder' } },
          provider,
          index,
        });
        expect(issues.map((i) => i.severity)).toEqual(['warn']);
        expect(devModelRefusals(issues)).toEqual([]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The other half of the rule, so nobody "fixes" it into never refusing: huu's
  // OWN shipped catalog keeps the `?? 'deepseek'` back-compat, because its
  // provider-less entries predate the field and really are DeepSeek's.
  it('keeps the deepseek default for huu OWN provider-less entries', () => {
    const empty = mkdtempSync(join(tmpdir(), 'huu-modelidx-'));
    try {
      const index = devModelProviderIndex(empty);
      // `recommended-models.json` lists `deepseek/deepseek-v4-pro` twice: once
      // with no provider (⇒ deepseek) and once explicitly under openrouter.
      expect([...providersForModel('deepseek/deepseek-v4-pro', index)].sort()).toEqual([
        'deepseek',
        'openrouter',
      ]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('survives a project root that does not exist', () => {
    const index = devModelProviderIndex(join(tmpdir(), 'huu-does-not-exist-ever'));
    expect(providersForModel('deepseek/deepseek-v4-flash', index).size).toBeGreaterThan(0);
  });
});

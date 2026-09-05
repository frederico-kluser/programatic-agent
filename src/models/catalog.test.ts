import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRecommendedModels, DEFAULT_MODEL_ID } from './catalog.js';
import { RecommendedModelsFileSchema } from '../contracts/models.js';

describe('loadRecommendedModels (provider filter)', () => {
  // Single-provider era: `deepseek` is the only `ModelProvider`, so every
  // catalog entry is servable by the only real backend (`jcode`) and the
  // filter can currently only KEEP entries. It still runs — and `stub` still
  // bypasses it — because that is the contract a second provider reactivates.
  // (The `pi`/`azure` backends and the merged Azure built-in catalog were
  // removed in v3.0; there is no second provider left to filter against.)
  let tmpDir: string;

  /** Write a recommended-models.json into the temp project root. */
  const writeCatalog = (models: unknown[]): void => {
    writeFileSync(
      join(tmpDir, 'recommended-models.json'),
      JSON.stringify({ models }),
      'utf-8',
    );
  };

  // One entry states its provider explicitly, the other omits it — the
  // back-compat shape written before the field existed.
  const TWO_ENTRIES = [
    { id: 'deepseek/explicit', label: 'Explicit', provider: 'deepseek' },
    { id: 'deepseek/implicit', label: 'Implicit' },
  ];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'huu-catalog-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('without backend arg: returns the whole catalog unfiltered', () => {
    writeCatalog(TWO_ENTRIES);
    const all = loadRecommendedModels(tmpDir);
    expect(all.map((m) => m.id)).toEqual(['deepseek/explicit', 'deepseek/implicit']);
  });

  it('never surfaces a copilot model (removed)', () => {
    const all = loadRecommendedModels(tmpDir);
    expect(all.some((m) => m.provider === ('copilot' as unknown))).toBe(false);
  });

  it('backend=jcode: keeps every deepseek model, provider-less entries included', () => {
    // The `provider ?? 'deepseek'` default is what keeps a file written before
    // the field existed from being filtered out of the picker entirely.
    writeCatalog(TWO_ENTRIES);
    const onlyJcode = loadRecommendedModels(tmpDir, 'jcode');
    expect(onlyJcode.map((m) => m.id)).toEqual(['deepseek/explicit', 'deepseek/implicit']);
    // Isolate the default: a catalog holding ONLY the provider-less entry must
    // still come back NON-empty. Dropping `?? 'deepseek'` in `providerFor`
    // makes this one fail empty even if the assertion above is ever relaxed
    // into a subset check. (Asserting `(m.provider ?? 'deepseek') === 'deepseek'`
    // on the results would NOT: it re-implements the very default under test
    // and is true for any input.)
    writeCatalog([TWO_ENTRIES[1]]);
    expect(loadRecommendedModels(tmpDir, 'jcode').map((m) => m.id)).toEqual([
      'deepseek/implicit',
    ]);
  });

  it('backend=stub: same list as no backend (cannot yet prove the bypass)', () => {
    // --stub is for smoke-testing the UI. It MUST NOT filter the catalog so
    // users can still pick any model when running `huu --stub`.
    //
    // TRUTH IN LABELING — this is NOT a regression guard yet. It cannot kill
    // the mutation that deletes the stub bypass in catalog.ts
    // (`if (!backend || backend === 'stub')` → `if (!backend)`): with that
    // bypass gone the filter still keeps everything, because
    // `backendToModelProvider()` returns 'deepseek' unconditionally and
    // `ModelProviderSchema` (src/contracts/models.ts) admits ONLY 'deepseek'.
    // So "stub skips the filter" and "the filter discards nothing" produce
    // byte-identical output — nothing here can tell them apart.
    //
    // It gets its teeth back under ONE exact condition: `ModelProviderSchema`
    // gaining a SECOND member. Then rewrite this test to write a catalog entry
    // carrying that other provider and assert backend='stub' still returns it
    // while a real backend drops it — at that point the bypass mutation dies.
    // Do not invent that second provider here just to make the test look sharp.
    writeCatalog(TWO_ENTRIES);
    const all = loadRecommendedModels(tmpDir, 'stub');
    const fullList = loadRecommendedModels(tmpDir);
    expect(all.length).toBe(fullList.length);
    expect(all.map((m) => m.id)).toEqual(fullList.map((m) => m.id));
  });

  it('in-code fallback (no file) leads with the default model', () => {
    // tmpDir has no recommended-models.json, so this exercises
    // DEFAULT_RECOMMENDED_MODELS — the fallback must headline the default.
    const fallback = loadRecommendedModels(tmpDir, 'jcode');
    expect(fallback[0]?.id).toBe(DEFAULT_MODEL_ID);
  });
});

describe('recommended-models.json (shipped catalog)', () => {
  // Regression: the shipped file once carried tier/bestFor values that were
  // NOT in the schema enums, so it failed zod validation and the catalog
  // silently fell back to the 2-entry in-code list — the documented default
  // never loaded. These guards keep the file authoritative.
  const repoFile = join(process.cwd(), 'recommended-models.json');

  it('parses against the schema (no silent fallback)', () => {
    const raw = JSON.parse(readFileSync(repoFile, 'utf-8'));
    const parsed = RecommendedModelsFileSchema.safeParse(raw);
    expect(
      parsed.success ? '' : JSON.stringify(parsed.error.issues[0]),
    ).toBe('');
  });

  it('leads with the default model', () => {
    const models = loadRecommendedModels(process.cwd(), 'jcode');
    expect(models[0]?.id).toBe(DEFAULT_MODEL_ID);
  });
});

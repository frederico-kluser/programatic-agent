import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RECON_CATALOG,
  RECON_MODEL,
  ReconBulletsSchema,
  buildReconContextMarkdown,
  fallbackCoreItems,
  runProjectRecon,
  type ReconAgentResult,
  type ReconRunItem,
  type ReconUpdate,
} from './project-recon.js';

describe('RECON_MODEL', () => {
  it('points at minimax m2.7 (cheap + parallel-friendly)', () => {
    expect(RECON_MODEL).toBe('minimax/minimax-m2.7');
  });
});

describe('ReconBulletsSchema', () => {
  it('accepts a small array of short bullets', () => {
    const r = ReconBulletsSchema.safeParse({ bullets: ['a', 'b'] });
    expect(r.success).toBe(true);
  });

  it('rejects empty arrays', () => {
    const r = ReconBulletsSchema.safeParse({ bullets: [] });
    expect(r.success).toBe(false);
  });

  it('rejects too many bullets', () => {
    const r = ReconBulletsSchema.safeParse({ bullets: Array(20).fill('x') });
    expect(r.success).toBe(false);
  });
});

describe('buildReconContextMarkdown', () => {
  const stack = RECON_CATALOG.find((e) => e.id === 'stack')!;
  const structure = RECON_CATALOG.find((e) => e.id === 'structure')!;
  const libraries = RECON_CATALOG.find((e) => e.id === 'libraries')!;

  const toRunItem = (e: typeof stack): ReconRunItem => ({
    tag: e.id,
    label: e.label,
    mission: e.mission,
    source: 'catalog',
  });

  const sample: ReconAgentResult[] = [
    {
      agent: toRunItem(stack),
      status: 'done',
      bullets: ['fato 1', 'fato 2'],
    },
    {
      agent: toRunItem(structure),
      status: 'error',
      bullets: [],
      error: 'oops',
    },
    {
      agent: toRunItem(libraries),
      status: 'done',
      bullets: ['lib X usa Y'],
    },
  ];

  it('renders sections for items that produced bullets', () => {
    const md = buildReconContextMarkdown(sample);
    expect(md).toMatch(/### /);
    expect(md).toMatch(/- fato 1/);
    expect(md).toMatch(/- lib X usa Y/);
  });

  it('skips errored items (no empty sections)', () => {
    const md = buildReconContextMarkdown(sample);
    expect(md).not.toMatch(new RegExp(`### ${structure.label}`));
  });

  it('returns empty string when nothing succeeded', () => {
    const md = buildReconContextMarkdown([
      { agent: toRunItem(stack), status: 'error', bullets: [] },
    ]);
    expect(md).toBe('');
  });

  it('preserves custom item labels in section headers', () => {
    const customResult: ReconAgentResult = {
      agent: {
        tag: 'custom:0',
        label: 'My custom mission',
        mission: 'do stuff',
        source: 'custom',
      },
      status: 'done',
      bullets: ['custom bullet'],
    };
    const md = buildReconContextMarkdown([customResult]);
    expect(md).toMatch(/### My custom mission/);
    expect(md).toMatch(/- custom bullet/);
  });
});

describe('runProjectRecon — stub mode', () => {
  let root: string;
  let originalStubFlag: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'huu-recon-'));
    originalStubFlag = process.env.HUU_LANGCHAIN_STUB;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (originalStubFlag === undefined) delete process.env.HUU_LANGCHAIN_STUB;
    else process.env.HUU_LANGCHAIN_STUB = originalStubFlag;
  });

  it('falls back to core items when no items list is passed', async () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x' }));
    const updates: ReconUpdate[] = [];
    const results = await runProjectRecon({
      apiKey: 'stub',
      repoRoot: root,
      onUpdate: (u) => updates.push(u),
    });
    expect(results).toHaveLength(fallbackCoreItems().length);
    for (const r of results) {
      expect(r.status).toBe('done');
      expect(r.bullets.length).toBeGreaterThan(0);
    }
  });

  it('runs only the items it was given (selector-driven flow)', async () => {
    const items: ReconRunItem[] = [
      {
        tag: 'stack',
        label: 'Stack',
        mission: 'm',
        source: 'catalog',
      },
      {
        tag: 'custom:0',
        label: 'My custom mission',
        mission: 'do stuff',
        source: 'custom',
      },
    ];
    const updates: ReconUpdate[] = [];
    const results = await runProjectRecon({
      apiKey: 'stub',
      repoRoot: root,
      items,
      onUpdate: (u) => updates.push(u),
    });
    expect(results).toHaveLength(2);
    expect(results[0]!.agent.tag).toBe('stack');
    expect(results[1]!.agent.tag).toBe('custom:0');
    expect(results[1]!.agent.source).toBe('custom');
    for (const r of results) expect(r.bullets.length).toBeGreaterThan(0);
  });

  it('emits at least one running and one done update per item', async () => {
    const items = fallbackCoreItems();
    const updates: ReconUpdate[] = [];
    await runProjectRecon({
      apiKey: 'stub',
      repoRoot: root,
      items,
      onUpdate: (u) => updates.push(u),
    });
    for (const item of items) {
      const mine = updates.filter((u) => u.agentId === item.tag);
      expect(mine.some((u) => u.status === 'running')).toBe(true);
      expect(mine.some((u) => u.status === 'done')).toBe(true);
    }
  });

  it('respects HUU_LANGCHAIN_STUB even when apiKey is real-ish', async () => {
    process.env.HUU_LANGCHAIN_STUB = '1';
    const results = await runProjectRecon({
      apiKey: 'sk-or-real-looking',
      repoRoot: root,
      items: fallbackCoreItems(),
      onUpdate: () => {},
    });
    for (const r of results) expect(r.status).toBe('done');
  });
});

describe('runProjectRecon — real mode guards', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'huu-recon-'));
    delete process.env.HUU_LANGCHAIN_STUB;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('errors out (and notifies every item) when apiKey is empty', async () => {
    const items = fallbackCoreItems();
    const updates: ReconUpdate[] = [];
    await expect(
      runProjectRecon({
        apiKey: '',
        repoRoot: root,
        items,
        onUpdate: (u) => updates.push(u),
      }),
    ).rejects.toThrow(/API key/i);
    const errored = updates.filter((u) => u.status === 'error');
    expect(errored.length).toBe(items.length);
  });
});

/**
 * The SILENT-SKIP trap, pinned.
 *
 * `runProjectRecon` decides "is there a credential?" before doing anything.
 * That check used to read ONLY the legacy `llmContext.deepseekApiKey`, so
 * migrating the contexts to the provider-neutral `apiKey` field would have made
 * every recon conclude "no key" and abort — with a message naming DeepSeek —
 * for a perfectly configured OpenRouter run.
 */
describe('runProjectRecon — the credential check is provider-neutral', () => {
  let root: string;
  let originalStubFlag: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'huu-recon-creds-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x' }));
    originalStubFlag = process.env.HUU_LANGCHAIN_STUB;
    delete process.env.HUU_LANGCHAIN_STUB;
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (originalStubFlag === undefined) delete process.env.HUU_LANGCHAIN_STUB;
    else process.env.HUU_LANGCHAIN_STUB = originalStubFlag;
  });

  it('accepts a key carried in the NEUTRAL apiKey field (no legacy deepseekApiKey)', async () => {
    // MUTATION KILLED: reverting the check to
    // `Boolean(opts.llmContext?.deepseekApiKey)`. With the contexts migrated,
    // that reads undefined here and the whole recon aborts in silence.
    // `items: []` keeps this hermetic — the gate runs, no model is called.
    const results = await runProjectRecon({
      apiKey: '',
      repoRoot: root,
      items: [],
      llmContext: { backend: 'jcode', provider: 'openrouter', apiKey: 'sk-or-v1-real' },
      onUpdate: () => {},
    });
    expect(results).toEqual([]);
  });

  it('still accepts the LEGACY deepseekApiKey field (call sites not yet migrated)', async () => {
    const results = await runProjectRecon({
      apiKey: '',
      repoRoot: root,
      items: [],
      llmContext: { backend: 'jcode', deepseekApiKey: 'sk-legacy' },
      onUpdate: () => {},
    });
    expect(results).toEqual([]);
  });

  it('refuses with the CHOSEN provider named — not always DeepSeek', async () => {
    // MUTATION KILLED: hard-coding the DeepSeek remediation text. An
    // OpenRouter user told to "set DEEPSEEK_API_KEY" is sent to fix the wrong
    // credential — the same misdirection the run gate used to produce.
    await expect(
      runProjectRecon({
        apiKey: '',
        repoRoot: root,
        items: [],
        llmContext: { backend: 'jcode', provider: 'openrouter' },
        onUpdate: () => {},
      }),
    ).rejects.toThrow(/OPENROUTER_API_KEY/);
    await expect(
      runProjectRecon({
        apiKey: '',
        repoRoot: root,
        items: [],
        llmContext: { backend: 'jcode', provider: 'deepseek' },
        onUpdate: () => {},
      }),
    ).rejects.toThrow(/DEEPSEEK_API_KEY/);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunLogger, RUN_LOG_DIR } from './run-logger.js';
import type {
  AgentStatus,
  IntegrationStatus,
  LogEntry,
  RunManifest,
} from './types.js';

function makeManifest(runId: string, startedAt: number): RunManifest {
  return {
    runId,
    baseBranch: 'main',
    baseCommit: 'abc1234',
    integrationBranch: `integration-${runId}`,
    integrationWorktreePath: '/tmp/integration',
    startedAt,
    finishedAt: startedAt + 5_000,
    status: 'done',
    agentEntries: [],
    totalStages: 1,
  };
}

function makeAgent(id: number, overrides: Partial<AgentStatus> = {}): AgentStatus {
  return {
    agentId: id,
    state: 'done',
    phase: 'done',
    currentFile: null,
    logs: [],
    tokensIn: 100,
    tokensOut: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    filesModified: ['src/foo.ts'],
    branchName: `agent-${id}-abc`,
    commitSha: 'deadbeef',
    pushStatus: 'skipped',
    stageIndex: 0,
    stageName: 'stage1',
    ...overrides,
  };
}

const integration: IntegrationStatus = {
  phase: 'done',
  branchesMerged: ['agent-1-abc'],
  branchesPending: [],
  conflicts: [],
  finalCommitSha: 'cafef00d',
};

describe('RunLogger', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pa-runlog-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('writes a log file under .huu/ with the expected name pattern', () => {
    const startedAt = new Date('2026-04-27T10:30:45').getTime();
    const logger = new RunLogger({
      repoRoot: tmp,
      runId: 'abcd1234',
      pipelineName: 'demo-rapida',
      startedAt,
    });
    logger.append({ timestamp: startedAt + 100, agentId: -1, level: 'info', message: 'hello' });

    const path = logger.flush(makeManifest('abcd1234', startedAt), integration, [makeAgent(1)]);
    expect(path).not.toBeNull();

    const dir = join(tmp, RUN_LOG_DIR);
    const files = readdirSync(dir).sort();
    // The chronological `.log` plus a sibling per-agent directory of the same
    // base name. Both are produced by every successful flush.
    expect(files).toEqual([
      '2026-04-27_10-30-45-execution-abcd1234',
      '2026-04-27_10-30-45-execution-abcd1234.log',
    ]);
  });

  it('captures log entries and agent events in chronological order', () => {
    const startedAt = Date.now();
    const logger = new RunLogger({
      repoRoot: tmp,
      runId: 'run123',
      pipelineName: 'p',
      startedAt,
    });
    const entries: LogEntry[] = [
      { timestamp: startedAt + 10, agentId: -1, level: 'info', message: 'first orchestrator log' },
      { timestamp: startedAt + 30, agentId: 1, level: 'info', message: 'agent says hi' },
    ];
    for (const e of entries) logger.append(e);
    logger.appendEvent(1, { type: 'state_change', state: 'streaming' });
    logger.appendEvent(1, { type: 'file_write', file: 'src/x.ts' });

    const path = logger.flush(makeManifest('run123', startedAt), integration, [makeAgent(1)]);
    expect(path).not.toBeNull();
    const content = readFileSync(path!, 'utf8');
    expect(content).toContain('# Run ID:            run123');
    expect(content).toContain('first orchestrator log');
    expect(content).toContain('agent says hi');
    expect(content).toContain('wrote src/x.ts');
    expect(content).toContain('=== Per-Agent Summary ===');
    expect(content).toContain('agent-1');
    expect(content).toContain('=== Integration ===');
    expect(content).toContain('cafef00d');
  });

  it('does not duplicate log/error events when both append and appendEvent are called', () => {
    const logger = new RunLogger({
      repoRoot: tmp,
      runId: 'r',
      pipelineName: 'p',
      startedAt: Date.now(),
    });
    logger.append({ timestamp: Date.now(), agentId: 1, level: 'info', message: 'shared message' });
    // 'log' events are filtered out of appendEvent on purpose — the orchestrator
    // already routes them through log(). Calling appendEvent for a 'log' must be a no-op.
    logger.appendEvent(1, { type: 'log', level: 'info', message: 'shared message' });

    const path = logger.flush(makeManifest('r', Date.now()), integration, [makeAgent(1)]);
    const content = readFileSync(path!, 'utf8');
    const occurrences = content.split('shared message').length - 1;
    expect(occurrences).toBe(1);
  });

  it('writes per-agent files alongside the chronological log', () => {
    const startedAt = new Date('2026-04-27T10:30:45').getTime();
    const logger = new RunLogger({
      repoRoot: tmp,
      runId: 'splitrun',
      pipelineName: 'demo',
      startedAt,
    });
    // Mix of orchestrator (-1), integrator (9999), and two real agents.
    logger.append({ timestamp: startedAt + 5, agentId: -1, level: 'info', message: 'orchestrator boot' });
    logger.append({ timestamp: startedAt + 10, agentId: 1, level: 'info', message: 'agent 1 working' });
    logger.append({ timestamp: startedAt + 12, agentId: 2, level: 'warn', message: 'agent 2 retrying' });
    logger.append({ timestamp: startedAt + 14, agentId: 9999, level: 'info', message: 'integrator merging' });
    logger.appendEvent(1, { type: 'state_change', state: 'streaming' });
    logger.appendEvent(1, { type: 'file_write', file: 'src/x.ts' });
    logger.appendEvent(2, { type: 'file_write', file: 'src/y.ts' });

    const path = logger.flush(
      makeManifest('splitrun', startedAt),
      integration,
      [makeAgent(1), makeAgent(2, { stageName: 'stage2' })],
    );
    expect(path).not.toBeNull();

    const splitDir = join(
      tmp,
      RUN_LOG_DIR,
      '2026-04-27_10-30-45-execution-splitrun',
    );
    expect(statSync(splitDir).isDirectory()).toBe(true);

    const files = readdirSync(splitDir).sort();
    expect(files).toEqual(['agent-1.log', 'agent-2.log', 'integrator.log', 'orchestrator.log']);

    const a1 = readFileSync(join(splitDir, 'agent-1.log'), 'utf8');
    expect(a1).toContain('Per-Agent Log (agent-1)');
    expect(a1).toContain('agent 1 working');
    expect(a1).toContain('wrote src/x.ts');
    // Cross-actor isolation — agent 1's file must not leak agent 2 messages.
    expect(a1).not.toContain('agent 2 retrying');
    expect(a1).not.toContain('orchestrator boot');
    expect(a1).not.toContain('integrator merging');

    const orq = readFileSync(join(splitDir, 'orchestrator.log'), 'utf8');
    expect(orq).toContain('Per-Agent Log (orchestrator)');
    expect(orq).toContain('orchestrator boot');
    expect(orq).not.toContain('agent 1 working');

    const intg = readFileSync(join(splitDir, 'integrator.log'), 'utf8');
    expect(intg).toContain('Per-Agent Log (integrator)');
    expect(intg).toContain('integrator merging');
  });

  it('returns null when the target directory cannot be written', () => {
    const logger = new RunLogger({
      repoRoot: '/nonexistent/path/that/cannot/be/created/\0',
      runId: 'r',
      pipelineName: 'p',
      startedAt: Date.now(),
    });
    const path = logger.flush(makeManifest('r', Date.now()), integration, []);
    expect(path).toBeNull();
  });

  it('manifest flush incremental — manifest exists on disk mid-run after flushManifest', () => {
    const startedAt = Date.now();
    const logger = new RunLogger({
      repoRoot: tmp,
      runId: 'midrun',
      pipelineName: 'p',
      startedAt,
    });

    const manifest = makeManifest('midrun', startedAt);
    manifest.agentEntries = [
      {
        agentId: 1,
        branchName: 'huu/midrun/agent-1',
        worktreePath: '/tmp/wt1',
        files: ['src/a.ts'],
        status: 'done',
        commitSha: 'abc1111',
        pushStatus: 'skipped',
        cleanupDone: true,
        noChanges: false,
        stageIndex: 0,
        stageName: 'stage1',
      },
    ];
    manifest.stageBaseCommits = ['basecommit0', 'basecommit1'];
    manifest.executionTrace = [
      { visitIndex: 1, stepName: 's1', stepType: 'work', runs: 1, startedAt, finishedAt: startedAt + 100 },
    ];

    // Simulate flushing mid-run — only flushManifest (no full flush yet)
    logger.flushManifest(manifest);

    const manifestPath = join(tmp, RUN_LOG_DIR, 'manifest-midrun.json');
    expect(existsSync(manifestPath), 'manifest file should exist on disk mid-run').toBe(true);

    // The full log file should NOT exist yet (flush was not called)
    const logFiles = readdirSync(join(tmp, RUN_LOG_DIR)).filter((f) => f.endsWith('.log'));
    expect(logFiles.length).toBe(0);

    // The manifest should contain the incremental data
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(raw.runId).toBe('midrun');
    expect(raw.status).toBe('done');
    expect(raw.agentEntries).toHaveLength(1);
    expect(raw.agentEntries[0].agentId).toBe(1);
    expect(raw.stageBaseCommits).toEqual(['basecommit0', 'basecommit1']);
    expect(raw.executionTrace).toHaveLength(1);

    // Now flush the full log — the manifest should still be on disk
    logger.append({ timestamp: startedAt + 10, agentId: -1, level: 'info', message: 'done' });
    const logPath = logger.flush(manifest, integration, [makeAgent(1)]);
    expect(logPath).not.toBeNull();
    expect(existsSync(manifestPath), 'manifest should still exist after full flush').toBe(true);
  });
});

describe('RunLogger.flushManifest is atomic', () => {
  // THE GUARD for the tmp+rename write behind `flushManifest`. A plain
  // `writeFileSync` onto `manifest-<runId>.json` truncates it first, and
  // `flushManifest` runs at EVERY stage boundary of every run — not once at
  // the end — so an external tool or a human tailing `.huu/` fast enough to
  // open the file inside the truncate→write window would see a JSON document
  // cut off mid-object. Every assertion below observes the OBSERVABLE
  // CONSEQUENCE of rename rather than the implementation: rename swaps in a
  // new inode, a truncating write reuses the old one.
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pa-runlog-atomic-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function manifestPathFor(runId: string): string {
    return join(tmp, RUN_LOG_DIR, `manifest-${runId}.json`);
  }

  /** A manifest fat enough that a truncating rewrite is visibly not instantaneous. */
  function bigManifest(runId: string, startedAt: number, marker: string): RunManifest {
    const m = makeManifest(runId, startedAt);
    m.agentEntries = Array.from({ length: 300 }, (_, i) => ({
      agentId: i,
      branchName: `huu/${runId}/agent-${i}`,
      worktreePath: `/tmp/wt-${i}`,
      files: [`src/file-${i}.ts`],
      status: 'done',
      commitSha: `${marker}-${i}`.padEnd(40, '0').slice(0, 40),
      pushStatus: 'skipped',
      cleanupDone: true,
      noChanges: false,
      stageIndex: 0,
      stageName: `${marker} — stage ${i}`,
    }));
    return m;
  }

  it('swaps in a new inode instead of truncating the manifest file already there', () => {
    const startedAt = Date.now();
    const logger = new RunLogger({ repoRoot: tmp, runId: 'atomic1', pipelineName: 'p', startedAt });
    logger.flushManifest(makeManifest('atomic1', startedAt));
    const path = manifestPathFor('atomic1');
    const firstInode = statSync(path).ino;

    logger.flushManifest({ ...makeManifest('atomic1', startedAt), status: 'error' });

    expect(statSync(path).ino).not.toBe(firstInode);
    expect(JSON.parse(readFileSync(path, 'utf8')).status).toBe('error');
  });

  it('leaves no staging file behind after a successful flush', () => {
    const startedAt = Date.now();
    const logger = new RunLogger({ repoRoot: tmp, runId: 'atomic2', pipelineName: 'p', startedAt });
    logger.flushManifest(makeManifest('atomic2', startedAt));

    expect(readdirSync(join(tmp, RUN_LOG_DIR))).toEqual(['manifest-atomic2.json']);
  });

  it('does not accumulate staging files across repeated stage-boundary flushes', () => {
    const startedAt = Date.now();
    const logger = new RunLogger({ repoRoot: tmp, runId: 'atomic3', pipelineName: 'p', startedAt });
    for (let i = 0; i < 10; i++) {
      logger.flushManifest({ ...makeManifest('atomic3', startedAt), totalStages: i });
    }

    expect(readdirSync(join(tmp, RUN_LOG_DIR))).toEqual(['manifest-atomic3.json']);
    expect(JSON.parse(readFileSync(manifestPathFor('atomic3'), 'utf8')).totalStages).toBe(9);
  });

  it('removes the staging file when the underlying write fails, without throwing', () => {
    const startedAt = Date.now();
    const logger = new RunLogger({ repoRoot: tmp, runId: 'atomic4', pipelineName: 'p', startedAt });
    const path = manifestPathFor('atomic4');
    // A DIRECTORY sitting where the manifest belongs: rename cannot replace
    // it. Without the cleanup branch this leaves a `*.huu.tmp` nobody lists
    // and nobody deletes, in the user's own repo. flushManifest is best-effort
    // by contract, so the call itself must not throw either.
    mkdirSync(path, { recursive: true });

    expect(() => logger.flushManifest(makeManifest('atomic4', startedAt))).not.toThrow();

    const dirFiles = readdirSync(join(tmp, RUN_LOG_DIR));
    expect(dirFiles.filter((f) => f.includes('.huu.tmp'))).toEqual([]);
  });

  it('a reader with the file already open never observes a half-written manifest', () => {
    // A reader that opened the file BEFORE the flush — an external tool
    // tailing `.huu/`, a second huu instance probing state — keeps reading
    // the COMPLETE previous version through its descriptor: rename unlinks
    // the old inode, it does not rewrite it in place. Under a truncating
    // write the same descriptor would follow the flush into whatever bytes
    // land there next.
    const startedAt = Date.now();
    const logger = new RunLogger({ repoRoot: tmp, runId: 'atomic5', pipelineName: 'p', startedAt });
    logger.flushManifest(makeManifest('atomic5', startedAt));
    const path = manifestPathFor('atomic5');
    const previous = readFileSync(path, 'utf8');
    JSON.parse(previous); // sanity: the "previous" snapshot itself must be valid

    const reader = openSync(path, 'r');
    try {
      logger.flushManifest(bigManifest('atomic5', startedAt, 'depois'));
      const buffer = Buffer.alloc(previous.length * 8);
      const read = readSync(reader, buffer, 0, buffer.length, 0);
      expect(buffer.subarray(0, read).toString('utf8')).toBe(previous);
    } finally {
      closeSync(reader);
    }

    // …and the new manifest landed intact and parseable too.
    const after = JSON.parse(readFileSync(path, 'utf8'));
    expect(after.agentEntries).toHaveLength(300);
  });

  it('any snapshot an external reader takes is either no file yet or a complete, parseable JSON document', () => {
    // Simulates a fast external reader polling the manifest across MANY
    // successive stage-boundary flushes (the real-world scenario the bug
    // report describes) by re-reading the file after every single flush and
    // asserting it is never a truncated fragment.
    const startedAt = Date.now();
    const logger = new RunLogger({ repoRoot: tmp, runId: 'atomic6', pipelineName: 'p', startedAt });
    const path = manifestPathFor('atomic6');

    for (let i = 0; i < 25; i++) {
      logger.flushManifest(bigManifest('atomic6', startedAt, `iter-${i}`));
      if (!existsSync(path)) continue; // absent is an acceptable observation too
      const raw = readFileSync(path, 'utf8');
      expect(() => JSON.parse(raw)).not.toThrow();
    }
  });

  it('keeps the exact JSON.stringify(_, null, 2) formatting — no trailing newline added', () => {
    // THE FORMAT IS NOT PART OF THE CHANGE. Atomicity is about HOW the bytes
    // reach the disk; this pins the bytes themselves so a future rewrite of
    // the helper cannot quietly reformat a file external tools already parse.
    const startedAt = Date.now();
    const logger = new RunLogger({ repoRoot: tmp, runId: 'atomic7', pipelineName: 'p', startedAt });
    const manifest = makeManifest('atomic7', startedAt);
    logger.flushManifest(manifest);

    const raw = readFileSync(manifestPathFor('atomic7'), 'utf8');
    expect(raw.endsWith('\n')).toBe(false);
    expect(raw).toContain('"runId": "atomic7"');
  });
});

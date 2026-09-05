import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentManifestEntry,
  AgentStatus,
  IntegrationStatus,
  LogEntry,
  RunManifest,
} from './types.js';
import type { AgentEvent } from '../orchestrator/types.js';
import { redactSecrets } from './debug-logger.js';

export const RUN_LOG_DIR = '.huu';

export interface RunLoggerOptions {
  repoRoot: string;
  runId: string;
  pipelineName: string;
  startedAt: number;
}

/**
 * Captures every log and agent event of a single run in memory and flushes
 * them to <repoRoot>/.huu/<timestamp>-execution-<runId>.log on completion.
 *
 * Has its own unbounded buffer so the orchestrator's UI-facing 1000-entry cap
 * does not drop entries before they are persisted.
 */
export class RunLogger {
  private readonly entries: LogEntry[] = [];
  private readonly events: { timestamp: number; agentId: number; description: string }[] = [];

  constructor(private readonly options: RunLoggerOptions) {}

  append(entry: LogEntry): void {
    this.entries.push(entry);
  }

  appendEvent(agentId: number, event: AgentEvent): void {
    const description = describeEvent(event);
    if (!description) return;
    this.events.push({ timestamp: Date.now(), agentId, description });
  }

  /**
   * Flushes the current manifest to `.huu/manifest-<runId>.json` so a crash
   * mid-run leaves a recoverable record. Called at every stage boundary,
   * not only at the end of `start()`. Best-effort — failure is swallowed.
   */
  flushManifest(manifest: RunManifest): void {
    try {
      const dir = join(this.options.repoRoot, RUN_LOG_DIR);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const path = join(dir, `manifest-${this.options.runId}.json`);
      const snapshot: SerializableManifest = {
        runId: manifest.runId,
        baseBranch: manifest.baseBranch,
        baseCommit: manifest.baseCommit,
        integrationBranch: manifest.integrationBranch,
        startedAt: manifest.startedAt,
        finishedAt: manifest.finishedAt,
        status: manifest.status,
        errorReason: manifest.errorReason,
        agentEntries: manifest.agentEntries.map(serializeManifestEntry),
        stageBaseCommits: manifest.stageBaseCommits,
        totalStages: manifest.totalStages,
        executionTrace: manifest.executionTrace,
        stageIntegrations: manifest.stageIntegrations,
        checkRuns: manifest.checkRuns,
      };
      writeManifestFileAtomic(path, JSON.stringify(snapshot, null, 2));
    } catch {
      // Non-fatal — the run should still complete.
    }
  }

  /**
   * Writes the captured logs to disk. Returns the absolute path of the
   * chronological file written, or null if writing failed (the failure is
   * non-fatal — the run should still complete).
   *
   * Two artifacts land under `<repoRoot>/.huu/`:
   *   1. `<stamp>-execution-<runId>.log` — full chronological stream
   *      (orchestrator + every agent + integrator + agent events), the same
   *      tail-of-history view the dashboard renders in real time.
   *   2. `<stamp>-execution-<runId>/` — sibling directory with one file per
   *      logical actor: `orchestrator.log`, `integrator.log`, and
   *      `agent-<id>.log`. Each holds only that actor's entries/events plus a
   *      small summary header, so per-agent audit doesn't require grepping
   *      the merged stream.
   *
   * The per-agent split is best-effort: failures inside it are swallowed so
   * the chronological log still lands.
   */
  flush(
    manifest: RunManifest,
    integration: IntegrationStatus,
    agents: AgentStatus[],
  ): string | null {
    try {
      const dir = join(this.options.repoRoot, RUN_LOG_DIR);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const stamp = formatStamp(this.options.startedAt);
      const baseName = `${stamp}-execution-${this.options.runId}`;
      const path = join(dir, `${baseName}.log`);
      const content = renderReport({
        manifest,
        integration,
        agents,
        entries: this.entries,
        events: this.events,
        pipelineName: this.options.pipelineName,
      });
      writeFileSync(path, content, 'utf8');
      this.writePerAgentLogs(join(dir, baseName), agents);
      return path;
    } catch {
      return null;
    }
  }

  private writePerAgentLogs(dir: string, agents: AgentStatus[]): void {
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    } catch {
      return;
    }
    // Bucket by agentId. The orchestrator uses -1 for its own logs and 9999
    // for the integration agent (see run-logger formatAgent). Everything else
    // is a real agent.
    const buckets = new Map<number, { entries: LogEntry[]; events: { timestamp: number; description: string }[] }>();
    const ensureBucket = (id: number) => {
      let b = buckets.get(id);
      if (!b) {
        b = { entries: [], events: [] };
        buckets.set(id, b);
      }
      return b;
    };
    for (const e of this.entries) ensureBucket(e.agentId).entries.push(e);
    for (const ev of this.events) ensureBucket(ev.agentId).events.push({ timestamp: ev.timestamp, description: ev.description });
    // Make sure every agent gets a file even if it never logged anything (so
    // the directory listing reflects the actual agent set, not just chatty ones).
    for (const a of agents) ensureBucket(a.agentId);

    const agentById = new Map(agents.map((a) => [a.agentId, a] as const));
    for (const [agentId, bucket] of buckets) {
      const filename = perAgentFilename(agentId);
      const path = join(dir, filename);
      const content = renderPerAgentReport({
        agentId,
        agent: agentById.get(agentId) ?? null,
        entries: bucket.entries,
        events: bucket.events,
        pipelineName: this.options.pipelineName,
        runId: this.options.runId,
        startedAt: this.options.startedAt,
      });
      try {
        writeFileSync(path, content, 'utf8');
      } catch {
        // Per-agent write is best-effort — keep going so other agents still land.
      }
    }
  }
}

/**
 * Writes `.huu/manifest-<runId>.json` ATOMICALLY: stage a sibling temp file
 * next to the target, then `rename` over it.
 *
 * WHY: `flushManifest` runs at EVERY stage boundary during a run — not once
 * at the end — and the manifest is meant to be read WHILE the run is still
 * going, by external tools and by a human tailing `.huu/`. A plain
 * `writeFileSync` onto the target truncates it first, so a reader fast enough
 * to open the file inside the truncate→write window sees a JSON document cut
 * off mid-object, and a `flushManifest` call is not exotic — it happens on
 * every stage boundary of every run. `rename(2)` is atomic within a
 * filesystem: a reader either sees the complete previous manifest or the
 * complete new one, never a prefix of either.
 *
 * Same recipe as `dev-mode/dev-state.ts`'s `writeFileEnsuringDir` (and
 * `dev-graph/graph-store.ts`, `jcode/hermetic.ts`) — duplicated here rather
 * than shared, matching how each of those sites already duplicates it for its
 * own target file rather than routing through one helper.
 *
 * The temp file lives in the SAME directory as the target — `rename` across
 * filesystems is EXDEV — and carries a pid+random suffix so two concurrent
 * runs flushing their own manifest into the same shared `.huu/` directory
 * cannot collide on one another's staging file.
 *
 * Unlike `writeFileEnsuringDir`, this does not read or reapply the target's
 * previous file mode: `manifest-<runId>.json` is a huu-generated run artifact
 * a user has no reason to have manually chmod'd, unlike a blackboard file or
 * a credential-bearing config.
 *
 * On failure the temp file is removed and the error is rethrown — an orphan
 * `manifest-<runId>.json.<pid>-<rand>.huu.tmp` would sit in the user's `.huu/`
 * forever, listed by nothing and cleaned by nobody. The caller (`flushManifest`)
 * wraps this in a try/catch that swallows the error: a failed manifest flush
 * must never take the run down.
 */
function writeManifestFileAtomic(path: string, content: string): void {
  const tmp = `${path}.${process.pid}-${Math.random().toString(36).slice(2, 10)}.huu.tmp`;
  try {
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* nothing left to do — the real failure is rethrown below */
    }
    throw err;
  }
}

function perAgentFilename(agentId: number): string {
  if (agentId < 0) return 'orchestrator.log';
  if (agentId === 9999) return 'integrator.log';
  return `agent-${agentId}.log`;
}

function describeEvent(event: AgentEvent): string | null {
  switch (event.type) {
    case 'state_change':
      return `state → ${event.state}`;
    case 'file_write':
      return `wrote ${event.file}`;
    case 'done':
      return 'done';
    default:
      // 'log' and 'error' already flow through Orchestrator.log() — avoid
      // duplicating them here.
      return null;
  }
}

function formatStamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  );
}

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const hh = pad(d.getHours());
  const mm = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  const mmm = String(d.getMilliseconds()).padStart(3, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hh}:${mm}:${ss}.${mmm}`;
}

function formatLevel(level: LogEntry['level']): string {
  return level.toUpperCase().padEnd(5);
}

function formatAgent(agentId: number): string {
  if (agentId < 0) return 'orchestrator'.padEnd(13);
  if (agentId === 9999) return 'integrator'.padEnd(13);
  return `agent-${agentId}`.padEnd(13);
}

interface ReportInput {
  manifest: RunManifest;
  integration: IntegrationStatus;
  agents: AgentStatus[];
  entries: LogEntry[];
  events: { timestamp: number; agentId: number; description: string }[];
  pipelineName: string;
}

function renderReport(input: ReportInput): string {
  const { manifest, integration, agents, entries, events, pipelineName } = input;
  const lines: string[] = [];

  const finishedAt = manifest.finishedAt ?? Date.now();
  const durationMs = finishedAt - manifest.startedAt;
  const durationSec = (durationMs / 1000).toFixed(2);

  const filesModified = new Set<string>();
  for (const a of agents) for (const f of a.filesModified) filesModified.add(f);

  const doneCount = agents.filter((a) => a.phase === 'done').length;
  const errorCount = agents.filter((a) => a.phase === 'error').length;
  const noChangesCount = agents.filter((a) => a.phase === 'no_changes').length;

  lines.push('# huu Run Log');
  lines.push(`# Run ID:            ${manifest.runId}`);
  lines.push(`# Pipeline:          ${pipelineName}`);
  lines.push(`# Status:            ${manifest.status}`);
  lines.push(`# Started:           ${formatTimestamp(manifest.startedAt)}`);
  lines.push(`# Finished:          ${formatTimestamp(finishedAt)}`);
  lines.push(`# Duration:          ${durationSec}s`);
  lines.push(`# Base:              ${manifest.baseBranch}@${manifest.baseCommit}`);
  lines.push(`# Integration:       ${manifest.integrationBranch}`);
  lines.push(`# Stages:            ${manifest.totalStages ?? 'n/a'}`);
  lines.push(
    `# Agents:            ${agents.length} total — ${doneCount} done, ${errorCount} errored, ${noChangesCount} no-changes`,
  );
  lines.push(`# Files modified:    ${filesModified.size}`);
  for (const f of [...filesModified].sort()) lines.push(`#   - ${f}`);
  lines.push('');

  lines.push('=== Logs ===');
  // Merge structured log entries with raw agent events into a single
  // chronological stream so the file reflects what actually happened in order.
  type Stream = { timestamp: number; render: () => string };
  const stream: Stream[] = [];
  for (const e of entries) {
    stream.push({
      timestamp: e.timestamp,
      // Redact API keys before they reach disk. Prompts and tool output
      // can contain user-pasted credentials; keys must not survive into
      // run logs that operators (or future support staff) read freely.
      render: () =>
        `[${formatTimestamp(e.timestamp)}] [${formatLevel(e.level)}] [${formatAgent(e.agentId)}] ${redactSecrets(e.message)}`,
    });
  }
  for (const ev of events) {
    stream.push({
      timestamp: ev.timestamp,
      render: () =>
        `[${formatTimestamp(ev.timestamp)}] [EVENT] [${formatAgent(ev.agentId)}] ${redactSecrets(ev.description)}`,
    });
  }
  stream.sort((a, b) => a.timestamp - b.timestamp);
  for (const s of stream) lines.push(s.render());
  if (stream.length === 0) lines.push('(no log entries captured)');
  lines.push('');

  lines.push('=== Per-Agent Summary ===');
  if (agents.length === 0) {
    lines.push('(no agents)');
  } else {
    const sorted = [...agents].sort((a, b) => a.agentId - b.agentId);
    for (const a of sorted) {
      lines.push(`agent-${a.agentId} — stage ${a.stageIndex + 1}: "${a.stageName}"`);
      lines.push(`  state:   ${a.state}`);
      lines.push(`  phase:   ${a.phase}`);
      if (a.branchName) lines.push(`  branch:  ${a.branchName}`);
      if (a.commitSha) lines.push(`  commit:  ${a.commitSha}`);
      if (a.filesModified.length > 0) {
        lines.push(`  files:   ${a.filesModified.join(', ')}`);
      }
      lines.push(
        `  tokens:  in=${a.tokensIn} out=${a.tokensOut} cacheR=${a.cacheReadTokens} cacheW=${a.cacheWriteTokens}`,
      );
      if (a.error) lines.push(`  error:   ${a.error}`);
      lines.push('');
    }
  }

  lines.push('=== Integration ===');
  lines.push(`phase:           ${integration.phase}`);
  lines.push(`branches merged: ${integration.branchesMerged.length}`);
  for (const b of integration.branchesMerged) lines.push(`  + ${b}`);
  if (integration.branchesPending.length > 0) {
    lines.push(`branches pending: ${integration.branchesPending.length}`);
    for (const b of integration.branchesPending) lines.push(`  ~ ${b}`);
  }
  if (integration.conflicts.length > 0) {
    lines.push(`conflicts: ${integration.conflicts.length}`);
    for (const c of integration.conflicts) {
      lines.push(`  ! ${c.file} (resolved=${c.resolved}) — ${c.branches.join(', ')}`);
    }
  }
  if (integration.finalCommitSha) {
    lines.push(`final commit:    ${integration.finalCommitSha}`);
  }
  lines.push('');

  return lines.join('\n');
}

interface PerAgentReportInput {
  agentId: number;
  agent: AgentStatus | null;
  entries: LogEntry[];
  events: { timestamp: number; description: string }[];
  pipelineName: string;
  runId: string;
  startedAt: number;
}

function renderPerAgentReport(input: PerAgentReportInput): string {
  const { agentId, agent, entries, events, pipelineName, runId, startedAt } = input;
  const lines: string[] = [];
  const label = formatAgent(agentId).trim();

  lines.push(`# huu — Per-Agent Log (${label})`);
  lines.push(`# Run ID:            ${runId}`);
  lines.push(`# Pipeline:          ${pipelineName}`);
  lines.push(`# Run started:       ${formatTimestamp(startedAt)}`);
  if (agent) {
    lines.push(`# Stage:             ${agent.stageIndex + 1} (${agent.stageName})`);
    if (agent.branchName) lines.push(`# Branch:            ${agent.branchName}`);
    if (agent.worktreePath) lines.push(`# Worktree:          ${agent.worktreePath}`);
    if (agent.commitSha) lines.push(`# Commit:            ${agent.commitSha}`);
    lines.push(`# Final state:       ${agent.state} (${agent.phase})`);
    if (agent.startedAt) lines.push(`# Started:           ${formatTimestamp(agent.startedAt)}`);
    if (agent.finishedAt) lines.push(`# Finished:          ${formatTimestamp(agent.finishedAt)}`);
    if (agent.startedAt && agent.finishedAt) {
      const sec = ((agent.finishedAt - agent.startedAt) / 1000).toFixed(2);
      lines.push(`# Duration:          ${sec}s`);
    }
    if (agent.filesModified.length > 0) {
      lines.push(`# Files modified:    ${agent.filesModified.length}`);
      for (const f of agent.filesModified) lines.push(`#   - ${f}`);
    }
    lines.push(
      `# Tokens:            in=${agent.tokensIn} out=${agent.tokensOut} cacheR=${agent.cacheReadTokens} cacheW=${agent.cacheWriteTokens}`,
    );
    if (agent.error) lines.push(`# Error:             ${agent.error}`);
  }
  lines.push('');

  lines.push('=== Logs ===');
  type Stream = { timestamp: number; render: () => string };
  const stream: Stream[] = [];
  for (const e of entries) {
    stream.push({
      timestamp: e.timestamp,
      render: () => `[${formatTimestamp(e.timestamp)}] [${formatLevel(e.level)}] ${redactSecrets(e.message)}`,
    });
  }
  for (const ev of events) {
    stream.push({
      timestamp: ev.timestamp,
      render: () => `[${formatTimestamp(ev.timestamp)}] [EVENT] ${redactSecrets(ev.description)}`,
    });
  }
  stream.sort((a, b) => a.timestamp - b.timestamp);
  if (stream.length === 0) {
    lines.push('(no log entries captured)');
  } else {
    for (const s of stream) lines.push(s.render());
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * JSON-safe subset of RunManifest — the fields that survive a crash.
 * Functions (conflictResolverFactory) are excluded; agentEntries are mapped
 * to plain objects with the same shape as AgentManifestEntry.
 */
interface SerializableManifest {
  runId: string;
  baseBranch: string;
  baseCommit: string;
  integrationBranch: string;
  startedAt: number;
  finishedAt?: number;
  status: string;
  errorReason?: string;
  agentEntries: AgentManifestEntry[];
  stageBaseCommits?: string[];
  totalStages?: number;
  executionTrace?: RunManifest['executionTrace'];
  stageIntegrations?: RunManifest['stageIntegrations'];
  checkRuns?: RunManifest['checkRuns'];
}

function serializeManifestEntry(e: AgentManifestEntry): AgentManifestEntry {
  return {
    agentId: e.agentId,
    branchName: e.branchName,
    worktreePath: e.worktreePath,
    files: e.files,
    status: e.status,
    commitSha: e.commitSha,
    pushStatus: e.pushStatus,
    cleanupDone: e.cleanupDone,
    noChanges: e.noChanges,
    error: e.error,
    errorKind: e.errorKind,
    attempt: e.attempt,
    stageIndex: e.stageIndex,
    stageName: e.stageName,
    merged: e.merged,
    mergeFailed: e.mergeFailed,
  };
}

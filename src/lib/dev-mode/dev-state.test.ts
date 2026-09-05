import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitClient } from '../../git/git-client.js';
import {
  DEV_STATE_FORMAT,
  commitBlackboard,
  foreignDirtyPaths,
  readDevState,
  writeDevState,
  writeGoalFile,
} from './dev-state.js';
import { devPaths, devSessionPaths } from './dev-protocol.js';
import type { DevState } from '../types.js';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'huu-test',
      GIT_AUTHOR_EMAIL: 'huu@test.local',
      GIT_COMMITTER_NAME: 'huu-test',
      GIT_COMMITTER_EMAIL: 'huu@test.local',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
}

let repo: string;
let client: GitClient;

const STATE: DevState = {
  _format: 'huu-devstate-v2',
  goal: 'migrar o parser',
  doneWhen: 'os testes passam',
  epochs: [],
  goalComplete: false,
  updatedAt: '2026-07-28T00:00:00.000Z',
  sessionId: 'sess-a',
};

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'huu-dev-state-')));
  git(['init', '-q', '-b', 'main'], repo);
  writeFileSync(join(repo, 'README.md'), '# project\n');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src/auth.ts'), 'export const secret = 1;\n');
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  client = new GitClient(repo);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function committedFiles(ref = 'HEAD'): string[] {
  return git(['show', '--name-only', '--format=', ref], repo)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

describe('commitBlackboard', () => {
  it('commits the goal and state files', async () => {
    writeGoalFile(repo, 'migrar o parser');
    writeDevState(repo, STATE);

    const sha = await commitBlackboard(client, repo, 'chore(huu-dev): abrir sessão');

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(committedFiles().sort()).toEqual([devPaths.goal, devPaths.state]);
  });

  // REGRESSION (dossier finding C1): `git commit` takes the WHOLE index. A
  // session that runs for hours while the user stages their own work in
  // another terminal used to sweep that work into a `chore(huu-dev)` commit —
  // with --no-verify, so past the pre-commit hooks that would have caught it —
  // and then LAND it on their branch attributed to huu.
  it('never sweeps the user staged work into huu commit', async () => {
    writeFileSync(join(repo, 'src/auth.ts'), 'export const secret = 2; // half-done\n');
    writeFileSync(join(repo, '.env.local'), 'TOKEN=shhh\n');
    git(['add', 'src/auth.ts', '.env.local'], repo);

    writeGoalFile(repo, 'migrar o parser');
    writeDevState(repo, STATE);
    await commitBlackboard(client, repo, 'chore(huu-dev): manutenção');

    const files = committedFiles();
    expect(files).not.toContain('src/auth.ts');
    expect(files).not.toContain('.env.local');
    expect(files.sort()).toEqual([devPaths.goal, devPaths.state]);

    // The user's work is untouched — still staged, still theirs to commit.
    const stillStaged = git(['diff', '--cached', '--name-only'], repo).split('\n').filter(Boolean);
    expect(stillStaged.sort()).toEqual(['.env.local', 'src/auth.ts']);
  });

  // Same root cause on the detection side: an unscoped `diff --cached` saw the
  // user's staged file and made huu commit when it had nothing of its own.
  it('does not commit at all when only the user has staged something', async () => {
    writeGoalFile(repo, 'migrar o parser');
    writeDevState(repo, STATE);
    await commitBlackboard(client, repo, 'chore(huu-dev): first');
    const before = git(['rev-parse', 'HEAD'], repo).trim();

    writeFileSync(join(repo, 'src/auth.ts'), 'export const secret = 3;\n');
    git(['add', 'src/auth.ts'], repo);

    const sha = await commitBlackboard(client, repo, 'chore(huu-dev): second');

    expect(sha).toBeNull();
    expect(git(['rev-parse', 'HEAD'], repo).trim()).toBe(before);
  });

  it('returns null when nothing huu owns has changed', async () => {
    writeGoalFile(repo, 'migrar o parser');
    writeDevState(repo, STATE);
    await commitBlackboard(client, repo, 'chore(huu-dev): first');

    expect(await commitBlackboard(client, repo, 'chore(huu-dev): again')).toBeNull();
  });

  // `.huu/` is commonly gitignored, which is why the add is forced.
  it('commits the blackboard even when .huu is gitignored', async () => {
    writeFileSync(join(repo, '.gitignore'), '.huu/\n');
    git(['add', '.gitignore'], repo);
    git(['commit', '-q', '-m', 'ignore huu'], repo);

    writeGoalFile(repo, 'migrar o parser');
    writeDevState(repo, STATE);
    const sha = await commitBlackboard(client, repo, 'chore(huu-dev): abrir sessão');

    expect(sha).not.toBeNull();
    expect(committedFiles()).toContain(devPaths.goal);
  });

  it('picks up the .gitignore the orchestrator writes', async () => {
    writeFileSync(join(repo, '.gitignore'), '.huu-worktrees/\n.env.huu\n');
    writeGoalFile(repo, 'migrar o parser');
    writeDevState(repo, STATE);

    await commitBlackboard(client, repo, 'chore(huu-dev): manutenção');

    expect(committedFiles()).toContain('.gitignore');
    expect(git(['status', '--porcelain'], repo).trim()).toBe('');
  });

  // The knowledge phase's gap specs and its huu-memory-v1 index are written
  // DETERMINISTICALLY by the driver (never by an LLM) and must be COMMITTED
  // before the fan-out branches off HEAD — `resolveMemoryFiles` reads them out
  // of the integration worktree, and a non-empty list that resolves to nothing
  // does not degrade, it kills the run.
  it('commits the extra paths the driver materialized', async () => {
    const s = devSessionPaths('sess-a');
    const index = s.knowledgeIndex(1);
    const gap = s.gapFile(1, 'G-001-stack');
    mkdirSync(join(repo, s.gapsDir(1)), { recursive: true });
    writeFileSync(join(repo, gap), '# G-001 — stack\n');
    writeFileSync(join(repo, index), '{"_format":"huu-memory-v1","files":[]}\n');

    writeGoalFile(repo, 'migrar o parser');
    writeDevState(repo, STATE);
    const sha = await commitBlackboard(client, repo, 'chore(huu-dev): lacunas', [gap, index]);

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(committedFiles().sort()).toEqual([gap, index, devPaths.goal, devPaths.state].sort());
  });

  // Same scoping guarantee as the base case, now with extras in play: widening
  // the path LIST must never widen the path SCOPE.
  it('still never sweeps the user staged work when given extra paths', async () => {
    const s = devSessionPaths('sess-a');
    const index = s.knowledgeIndex(1);
    mkdirSync(join(repo, s.knowledgeDir(1)), { recursive: true });
    writeFileSync(join(repo, index), '{"_format":"huu-memory-v1","files":[]}\n');

    writeFileSync(join(repo, 'src/auth.ts'), 'export const secret = 4; // half-done\n');
    writeFileSync(join(repo, '.env.local'), 'TOKEN=shhh\n');
    git(['add', 'src/auth.ts', '.env.local'], repo);

    writeGoalFile(repo, 'migrar o parser');
    writeDevState(repo, STATE);
    await commitBlackboard(client, repo, 'chore(huu-dev): lacunas', [index]);

    const files = committedFiles();
    expect(files).not.toContain('src/auth.ts');
    expect(files).not.toContain('.env.local');
    expect(files.sort()).toEqual([index, devPaths.goal, devPaths.state].sort());

    const stillStaged = git(['diff', '--cached', '--name-only'], repo).split('\n').filter(Boolean);
    expect(stillStaged.sort()).toEqual(['.env.local', 'src/auth.ts']);
  });

  // `git add -f` fails the WHOLE command on an unknown pathspec, which would
  // abort the session's only commit — so a path that isn't there is dropped.
  it('ignores extra paths that do not exist', async () => {
    writeGoalFile(repo, 'migrar o parser');
    writeDevState(repo, STATE);

    const sha = await commitBlackboard(client, repo, 'chore(huu-dev): abrir sessão', [
      '.huu/dev/sess-a/epoch-1/knowledge/index.json',
    ]);

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(committedFiles().sort()).toEqual([devPaths.goal, devPaths.state]);
  });
});

describe('dev-state / the driver-owned writes are atomic', () => {
  // THE GUARD FOR `writeFileEnsuringDir`'s CENTRAL ARGUMENT. A plain
  // `writeFileSync` onto `state.json` truncates it first, and a crash inside
  // that window does NOT fail loudly: `readDevState` answers `null` for
  // anything unparseable, and `null` means "no resume offered" — so the
  // accident that corrupts the file is the same accident that throws the
  // session's history away, silently. The driver persists several times per
  // epoch, so this is the window, not a corner.
  //
  // Every assertion below observes the OBSERVABLE CONSEQUENCE of rename rather
  // than the implementation: rename SWAPS IN a new inode, a truncating write
  // reuses the old one. No timing, no crash simulation, no seam.

  /** A state fat enough that a truncating rewrite is visibly not instantaneous. */
  function bigState(marker: string): DevState {
    return {
      ...STATE,
      goal: marker,
      epochs: Array.from({ length: 400 }, (_, i) => ({
        epoch: i + 1,
        runId: `run-${i}`,
        epochGoal: `${marker} — época ${i + 1} `.repeat(8),
        frontIds: ['api', 'cli', 'tests'],
        status: 'done' as const,
        landedCommit: 'a'.repeat(40),
        startedAt: '2026-07-28T00:00:00.000Z',
        finishedAt: '2026-07-28T01:00:00.000Z',
      })),
    };
  }

  it('swaps in a new inode instead of truncating the state file already there', () => {
    writeDevState(repo, STATE);
    const path = join(repo, devPaths.state);
    const firstInode = statSync(path).ino;

    writeDevState(repo, { ...STATE, goal: 'segundo objetivo' });

    expect(statSync(path).ino).not.toBe(firstInode);
    expect(readDevState(repo)?.goal).toBe('segundo objetivo');
  });

  it('swaps in a new inode for the goal file too', () => {
    writeGoalFile(repo, 'primeiro objetivo');
    const path = join(repo, devPaths.goal);
    const firstInode = statSync(path).ino;

    writeGoalFile(repo, 'segundo objetivo');

    expect(statSync(path).ino).not.toBe(firstInode);
    expect(readFileSync(path, 'utf8')).toContain('segundo objetivo');
  });

  // THE COST OF THE NEW INODE. `rename` does not just swap the bytes, it swaps
  // the FILE: the inode that lands is the staging file's, created by `open(2)`
  // with `0666 & ~umask`. So the same mechanism that buys atomicity silently
  // RE-PERMISSIONS the target — measured, before the fix: a `state.json` left
  // at 0600 came back 0644 under the default umask 022. The mode is therefore
  // read before the write and re-applied after it.
  it('keeps the mode the state file already had instead of widening it to the umask default', () => {
    writeDevState(repo, STATE);
    const path = join(repo, devPaths.state);
    chmodSync(path, 0o600);

    writeDevState(repo, { ...STATE, goal: 'segundo objetivo' });

    expect((statSync(path).mode & 0o777).toString(8)).toBe('600');
    // …and the write still happened. Preserving the mode of a file nobody
    // updated would be no achievement.
    expect(readDevState(repo)?.goal).toBe('segundo objetivo');
  });

  it('keeps the mode the goal file already had', () => {
    writeGoalFile(repo, 'primeiro objetivo');
    const path = join(repo, devPaths.goal);
    chmodSync(path, 0o640);

    writeGoalFile(repo, 'segundo objetivo');

    expect((statSync(path).mode & 0o777).toString(8)).toBe('640');
    expect(readFileSync(path, 'utf8')).toContain('segundo objetivo');
  });

  it('forces no mode on a file that did not exist yet — a first write takes the umask default', () => {
    // The other half of the claim, and the reason the preservation is
    // conditional: these files are COMMITTED, as ordinary 100644 blobs. A
    // helper that always chmod-ed to the owner-only bits the secret-bearing
    // writers ask for (`graph-store.ts`, `surf-research.ts`) would be wrong
    // here. Compared against a plain `writeFileSync` in the same directory so
    // the assertion holds under any umask, hardened ones included.
    writeDevState(repo, STATE);
    const reference = join(repo, devPaths.root, 'reference.txt');
    writeFileSync(reference, 'x');

    expect(statSync(join(repo, devPaths.state)).mode & 0o777).toBe(
      statSync(reference).mode & 0o777,
    );
  });

  it('never shows a concurrent reader a half-written state', () => {
    // A reader that opened the file BEFORE the persist — the human's `cat`, a
    // backup tool, a second huu probing for a resume — keeps reading the
    // COMPLETE previous version through its descriptor: rename unlinks the old
    // inode, it does not rewrite it. Under a truncating write the same
    // descriptor would follow the persist into whatever bytes are there.
    writeDevState(repo, STATE);
    const path = join(repo, devPaths.state);
    const previous = readFileSync(path, 'utf8');
    const reader = openSync(path, 'r');
    try {
      writeDevState(repo, bigState('depois'));
      const buffer = Buffer.alloc(previous.length * 8);
      const read = readSync(reader, buffer, 0, buffer.length, 0);
      expect(buffer.subarray(0, read).toString('utf8')).toBe(previous);
    } finally {
      closeSync(reader);
    }
    expect(readDevState(repo)?.goal).toBe('depois');
  });

  it('overwrites a valid state with a large one without ever landing on a shape readDevState refuses', () => {
    writeDevState(repo, STATE);
    const big = bigState('objetivo grande');

    writeDevState(repo, big);

    const read = readDevState(repo);
    expect(read).not.toBeNull();
    expect(read).toEqual(big);
  });

  it('leaves no staging file behind', () => {
    writeGoalFile(repo, 'migrar o parser');
    writeDevState(repo, STATE);
    writeDevState(repo, bigState('de novo'));

    expect(readdirSync(join(repo, devPaths.root)).sort()).toEqual(['goal.md', 'state.json']);
  });

  it('removes the staging file when the write fails, and reports the failure', () => {
    // A DIRECTORY sitting where `state.json` belongs: rename cannot replace it.
    // Without the cleanup branch this leaves a `*.huu.tmp` nobody lists and
    // nobody deletes, in the user's own repo.
    mkdirSync(join(repo, devPaths.state), { recursive: true });

    expect(() => writeDevState(repo, STATE)).toThrow();

    expect(readdirSync(join(repo, devPaths.root)).filter((f) => f.includes('.huu.tmp'))).toEqual(
      [],
    );
  });

  it.runIf(process.platform === 'linux')(
    'stages inside the blackboard directory, where rename is atomic',
    async () => {
      // The OTHER half of the claim: the staging file is a SIBLING of the
      // target, because `rename` is only atomic within one filesystem — a tmp
      // in the OS temp dir would be an EXDEV failure on any machine whose repo
      // is on a separate mount. inotify buffers events in the KERNEL, so a
      // watcher started here still sees the names the synchronous write
      // created and removed while the event loop was blocked. Linux only: the
      // macOS/Windows backends do not promise per-name events.
      mkdirSync(join(repo, devPaths.root), { recursive: true });
      const seen: string[] = [];
      const watcher = watch(join(repo, devPaths.root), (_event, name) => {
        if (name) seen.push(name);
      });
      try {
        writeDevState(repo, STATE);
        await new Promise((resolve) => setTimeout(resolve, 200));
      } finally {
        watcher.close();
      }

      expect(seen.some((name) => name.startsWith('state.json.') && name.endsWith('.huu.tmp'))).toBe(
        true,
      );
      expect(seen).toContain('state.json');
      // …and it is gone again by the time the call returns.
      expect(readdirSync(join(repo, devPaths.root))).toEqual(['state.json']);
    },
  );

  // THE FORMAT IS NOT PART OF THE CHANGE. Atomicity is about HOW the bytes
  // reach the disk; these two are the bytes themselves, pinned so a future
  // rewrite of the helper cannot quietly reformat a file the resume parses and
  // a human reads.
  it('writes byte-for-byte the same content as before — 2-space JSON, trailing newline', () => {
    writeDevState(repo, STATE);
    expect(readFileSync(join(repo, devPaths.state), 'utf8')).toBe(
      `${JSON.stringify(STATE, null, 2)}\n`,
    );

    writeGoalFile(repo, '  migrar o parser  ');
    expect(readFileSync(join(repo, devPaths.goal), 'utf8')).toBe(
      '# Objetivo\n\n> Escrito pelo humano. Nenhum agente reescreve este arquivo.\n\nmigrar o parser\n',
    );
  });

  // The staging file is litter, and litter in a git repo is a commit risk:
  // `commitBlackboard` force-adds, and forced adds ignore `.gitignore`. Two
  // independent reasons it cannot be swept in — the pathspecs are EXACT files,
  // and everything huu writes lives under `.huu/`, which huu itself gitignores
  // (`RUN_LOG_DIR`) — so an unforced `add -A` skips it as well.
  it('a leftover staging file is invisible to the blackboard commit', async () => {
    writeFileSync(join(repo, '.gitignore'), '.huu/\n');
    git(['add', '.gitignore'], repo);
    git(['commit', '-q', '-m', 'ignore huu'], repo);

    writeGoalFile(repo, 'migrar o parser');
    writeDevState(repo, STATE);
    // Simulate the only way one can exist: a process killed mid-write.
    writeFileSync(join(repo, `${devPaths.state}.4242-abcd1234.huu.tmp`), '{ half-writ');

    const sha = await commitBlackboard(client, repo, 'chore(huu-dev): abrir sessão');
    expect(sha).not.toBeNull();
    expect(committedFiles().sort()).toEqual([devPaths.goal, devPaths.state]);

    // …and it does not count as the user's dirty work either, so it cannot
    // stall the next landing.
    expect(await foreignDirtyPaths(client, repo)).toEqual([]);
    git(['add', '-A'], repo);
    expect(git(['diff', '--cached', '--name-only'], repo).split('\n').filter(Boolean)).toEqual([]);
  });
});

describe('readDevState', () => {
  it('reads back what huu wrote', () => {
    writeDevState(repo, STATE);

    const read = readDevState(repo);
    expect(read?._format).toBe(DEV_STATE_FORMAT);
    expect(read?.goal).toBe('migrar o parser');
    expect(read?.sessionId).toBe('sess-a');
  });

  // The critic's executable anchor survives the round trip: the baseline gap
  // that produces it is only asked in epoch 1, so epochs ≥ 2 (and resumed
  // sessions) read the commands back from here.
  it('round-trips the persisted verifyCommands', () => {
    writeDevState(repo, {
      ...STATE,
      verifyCommands: {
        all: ['npm run build', 'npm test', 'npm run typecheck'],
        build: ['npm run build'],
        test: ['npm test'],
        lint: ['npm run typecheck'],
      },
    });

    const read = readDevState(repo);
    expect(read?.verifyCommands).toEqual({
      all: ['npm run build', 'npm test', 'npm run typecheck'],
      build: ['npm run build'],
      test: ['npm test'],
      lint: ['npm run typecheck'],
    });
    // A state written before the field existed simply has none.
    writeDevState(repo, STATE);
    expect(readDevState(repo)?.verifyCommands).toBeUndefined();
  });

  // Additive optional fields are TOLERATED, never validated away: a state file
  // carrying something unexpected (hand-edited, or written by a newer huu)
  // still reads. Trusting the value is the driver's job, behind its own guard.
  it('tolerates a state file carrying fields it does not know', () => {
    mkdirSync(join(repo, devPaths.root), { recursive: true });
    writeFileSync(
      join(repo, devPaths.state),
      `${JSON.stringify({ ...STATE, verifyCommands: 'hand-edited junk', futureField: { x: 1 } }, null, 2)}\n`,
    );

    const read = readDevState(repo);
    expect(read?.goal).toBe('migrar o parser');
    expect(read?.verifyCommands as unknown).toBe('hand-edited junk');
  });

  // The whole migration story for v2: a v1 file has no `sessionId`, so nothing
  // under `.huu/dev/epoch-N/` can be attributed to it and resuming from one
  // would aim a new session's fan-out at another session's task specs. Refusing
  // it degrades to "no resume offered" — the right outcome, and zero migration
  // code. (Also documents that the writer is v2 now.)
  it('refuses a v1 state file instead of migrating it', () => {
    mkdirSync(join(repo, devPaths.root), { recursive: true });
    writeFileSync(
      join(repo, devPaths.state),
      `${JSON.stringify({ ...STATE, _format: 'huu-devstate-v1', sessionId: undefined }, null, 2)}\n`,
    );

    expect(DEV_STATE_FORMAT).toBe('huu-devstate-v2');
    expect(readDevState(repo)).toBeNull();
  });

  it('returns null when the file is absent or unreadable', () => {
    expect(readDevState(repo)).toBeNull();

    mkdirSync(join(repo, devPaths.root), { recursive: true });
    writeFileSync(join(repo, devPaths.state), '{ not json');
    expect(readDevState(repo)).toBeNull();

    writeFileSync(join(repo, devPaths.state), JSON.stringify({ _format: DEV_STATE_FORMAT }));
    expect(readDevState(repo)).toBeNull();
  });
});

describe('foreignDirtyPaths', () => {
  it('is empty on a clean tree', async () => {
    expect(await foreignDirtyPaths(client, repo)).toEqual([]);
  });

  it('reports the user modified and untracked files', async () => {
    writeFileSync(join(repo, 'README.md'), 'edited\n');
    writeFileSync(join(repo, 'notes.txt'), 'mine\n');

    expect((await foreignDirtyPaths(client, repo)).sort()).toEqual(['README.md', 'notes.txt']);
  });

  // The first path of a ` M ` porcelain line used to lose a character here.
  it('does not truncate the first modified path', async () => {
    writeFileSync(join(repo, 'README.md'), 'edited\n');
    expect(await foreignDirtyPaths(client, repo)).toEqual(['README.md']);
  });

  it('ignores everything huu owns, including a stale blackboard', async () => {
    writeGoalFile(repo, 'g');
    writeDevState(repo, STATE);
    mkdirSync(join(repo, devPaths.frontDir(1, 'old')), { recursive: true });
    writeFileSync(join(repo, devPaths.epochReport(1)), '# relatório antigo\n');
    writeFileSync(join(repo, '.gitignore'), '.huu-worktrees/\n');

    expect(await foreignDirtyPaths(client, repo)).toEqual([]);
  });

  // Regression: `.gitignore` was always force-added by `commitBlackboard`
  // via `HUU_OWNED_PATHS`, then stage-committed even when it hadn't changed
  // from HEAD. The diff-from-HEAD filter must prevent this.
  it('gitignore nao entra sem diff', async () => {
    // Write .gitignore and commit it FIRST — no huu lines.
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    git(['add', '.gitignore'], repo);
    git(['commit', '-q', '-m', 'base'], repo);

    // Write the huu-owned files (goal + state) so commitBlackboard has
    // something to commit. Do NOT touch .gitignore.
    writeGoalFile(repo, 'migrar o parser');
    writeDevState(repo, STATE);

    // commitBlackboard should commit goal + state but NOT .gitignore,
    // because .gitignore has no diff from HEAD.
    const sha = await commitBlackboard(client, repo, 'chore(huu-dev): abrir sessão');
    expect(sha).not.toBeNull();

    const files = committedFiles();
    expect(files).toContain(devPaths.goal);
    expect(files).toContain(devPaths.state);
    expect(files).not.toContain('.gitignore');
  });
});

/**
 * check-dockerfile.test.ts — proves the gate guard can say NO.
 *
 * A checker that only ever passes is decoration. Every `MUTATION` case below
 * is a real edit someone could make to the Dockerfile that must turn the gate
 * red; the `accepts` cases pin the false positives that would otherwise teach
 * the team to ignore it.
 *
 * Structure: the EXIT CODE contract (what gate.sh consumes) is proven end to
 * end by spawning the script, once per branch — pass, fail, warn. The rule
 * table is then exercised in-process against `checkDockerfile()`, so adding a
 * rule costs no extra process spawn.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { logicalLines, parseInstruction, checkDockerfile } from './check-dockerfile.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'check-dockerfile.ts');
const REPO_ROOT = join(__dirname, '..');

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Run the checker as gate.sh does: against `file`, or the repo Dockerfile. */
function run(file?: string): RunResult {
  const args = ['tsx', SCRIPT, ...(file ? ['--file', file] : [])];
  try {
    const out = execFileSync('npx', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { exitCode: 0, stdout: out, stderr: '' };
  } catch (err: any) {
    return {
      exitCode: err.status ?? 1,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
    };
  }
}

/** Write a throwaway Dockerfile and hand its path to the real script. */
function runOnSource(source: string): RunResult {
  const dir = mkdtempSync(join(tmpdir(), 'huu-check-dockerfile-'));
  try {
    const file = join(dir, 'Dockerfile');
    writeFileSync(file, source, 'utf8');
    return run(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const violationsOf = (src: string) =>
  checkDockerfile(src).violations.map((v) => `${v.line}: ${v.message}`);

// ---------------------------------------------------------------------------
// exit-code contract (spawned)
// ---------------------------------------------------------------------------

describe('check-dockerfile — exit-code contract', () => {
  it("APPROVES the repo's own Dockerfile (exit 0, no warnings)", () => {
    const result = run();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('builds on a factory Docker');
    // The syntax directive was removed deliberately; if it comes back, this
    // fires before anyone wonders why.
    expect(result.stdout).not.toContain('WARN');
  });

  it('REJECTS the exact line that broke `npm start` (exit 1, actionable message)', () => {
    const result = runOnSource(
      'FROM node:20-slim\nRUN --mount=type=cache,target=/root/.npm npm ci --include=dev\n',
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('BUILDKIT-ONLY');
    expect(result.stderr).toContain('--mount');
    // The message has to say what to do, not just that something is wrong.
    expect(result.stderr).toContain('requires BuildKit');
    expect(result.stderr).toContain('PORTABILITY CONTRACT');
  });

  it('REJECTS `RUN \\` + BLANK LINE + `--mount` (exit 1) — the guard used to say exit 0', () => {
    // VERBATIM the file a verifier fed to `docker build` on the classic
    // builder. Docker printed
    //     [WARNING]: Empty continuation line found in: RUN --mount=… echo hi
    // and then FAILED with "the --mount option requires BuildKit" — proof the
    // blank line does NOT end the instruction. This checker disagreed: it
    // closed the instruction as bare `RUN `, could not parse the orphan
    // `--mount=…` fragment, DROPPED IT IN SILENCE and exited 0.
    //
    // A guard that green-lights a Dockerfile Docker refuses to build is worse
    // than no guard, because the gate now vouches for it. Two independent
    // fixes had to land for this to be red, and either one alone turns it red:
    // the joiner now keeps going across the blank line, and an unreadable
    // logical line is a violation instead of a `continue`.
    const result = runOnSource(
      'FROM node:20-slim\n' + 'RUN \\\n' + '\n' + '    --mount=type=cache,target=/root/.npm \\\n' + '    echo hi\n',
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('BUILDKIT-ONLY');
    expect(result.stderr).toContain('--mount');
  });

  it('WARNS on `# syntax=` but still exits 0 — the classic builder ignores it', () => {
    const result = runOnSource(
      '# syntax=docker/dockerfile:1.7\nFROM node:20-slim\nRUN npm ci\n',
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('WARN');
    expect(result.stdout).toContain('syntax=docker/dockerfile:1.7');
  });

  it('exits 1 when the target file does not exist', () => {
    const result = run(join(tmpdir(), 'huu-no-such-dockerfile-xyz'));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('file not found');
  });
});

// ---------------------------------------------------------------------------
// mutations the guard must kill
// ---------------------------------------------------------------------------

describe('check-dockerfile — rejects BuildKit-only syntax', () => {
  it('MUTATION: RUN --mount, inline', () => {
    expect(
      violationsOf('FROM node:20-slim\nRUN --mount=type=cache,target=/root/.npm npm ci\n'),
    ).toEqual([expect.stringContaining('--mount')]);
  });

  it('MUTATION: RUN --mount hidden behind a line continuation', () => {
    // This is the shape the repo actually shipped. A per-line regex sees only
    // `RUN \` on the first line and lets it through — this case is what forces
    // logicalLines() to join continuations before matching, and it is the
    // single mutation most likely to survive a lazier implementation.
    const violations = violationsOf(
      'FROM node:20-slim\n' + 'RUN \\\n' + '    --mount=type=cache,target=/root/.npm \\\n' + '    npm ci --include=dev\n',
    );
    expect(violations).toHaveLength(1);
    // Reported at the line where the INSTRUCTION starts, not where the flag sits.
    expect(violations[0]).toMatch(/^2: RUN --mount/);
  });

  it('MUTATION: a BLANK line inside the continuation does not hide the flag', () => {
    // The formatting variant of the mutation above, and the one that actually
    // escaped: `RUN \` then an empty line then `--mount=…`. Docker joins it
    // (it only warns: "Empty continuation line found in: …") and then refuses
    // to build it without BuildKit; the guard reported "builds on a factory
    // Docker". Reported at line 2, where the instruction STARTS — the same
    // contract as every other continuation case.
    const violations = violationsOf(
      'FROM node:20-slim\n' + 'RUN \\\n' + '\n' + '    --mount=type=cache,target=/root/.npm \\\n' + '    npm ci\n',
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/^2: RUN --mount/);
  });

  it('MUTATION: several blank lines and a comment mixed into one continuation', () => {
    expect(
      violationsOf(
        'FROM node:20-slim\n' +
          'RUN \\\n' +
          '\n' +
          '# keeps the npm cache warm between builds\n' +
          '   \n' +
          '    --mount=type=cache,target=/root/.npm \\\n' +
          '    npm ci\n',
      ),
    ).toEqual([expect.stringContaining('--mount')]);
  });

  it('MUTATION: an unreadable logical line is never dropped in silence', () => {
    // The SECOND half of the fix, tested on its own. It does not matter what
    // mis-joined the line; what mattered was that `if (!inst) continue;` threw
    // the evidence away and let the run finish green. An unparsed line is an
    // unchecked line, so it is red.
    const violations = violationsOf('FROM node:20-slim\n--mount=type=cache,target=/root/.npm\n');
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/^2: unreadable line/);
  });

  it('MUTATION: a comment line inside the continuation does not hide the flag', () => {
    expect(
      violationsOf(
        'FROM node:20-slim\n' +
          'RUN \\\n' +
          '# keeps the npm cache warm between builds\n' +
          '    --mount=type=cache,target=/root/.npm \\\n' +
          '    npm ci\n',
      ),
    ).toHaveLength(1);
  });

  it('MUTATION: RUN --mount=type=secret and =ssh', () => {
    expect(violationsOf('FROM x\nRUN --mount=type=secret,id=npmrc npm ci\n')).toHaveLength(1);
    expect(violationsOf('FROM x\nRUN --mount=type=ssh git fetch\n')).toHaveLength(1);
  });

  it('MUTATION: RUN --network=none', () => {
    expect(violationsOf('FROM x\nRUN --network=none npm ci\n')).toEqual([
      expect.stringContaining('--network'),
    ]);
  });

  it('MUTATION: RUN --security=insecure', () => {
    expect(violationsOf('FROM x\nRUN --security=insecure make\n')).toEqual([
      expect.stringContaining('--security'),
    ]);
  });

  it('MUTATION: COPY --link', () => {
    expect(violationsOf('FROM x\nCOPY --link package.json ./\n')).toEqual([
      expect.stringContaining('--link'),
    ]);
  });

  it('MUTATION: COPY --chmod (--chown is classic, --chmod is not)', () => {
    expect(violationsOf('FROM x\nCOPY --chmod=755 e.sh /usr/local/bin/\n')).toEqual([
      expect.stringContaining('--chmod'),
    ]);
  });

  it('MUTATION: ADD --checksum', () => {
    expect(violationsOf('FROM x\nADD --checksum=sha256:abc https://e/x.tgz /x\n')).toEqual([
      expect.stringContaining('--checksum'),
    ]);
  });

  it('MUTATION: a Dockerfile heredoc', () => {
    expect(violationsOf('FROM x\nRUN <<EOF\nnpm ci\nEOF\n')).toEqual([
      expect.stringContaining('heredoc'),
    ]);
    expect(violationsOf('FROM x\nCOPY <<EOF /etc/motd\nhi\nEOF\n')).toEqual([
      expect.stringContaining('heredoc'),
    ]);
  });

  it('a flag invented after this checker was written still trips it', () => {
    // Deny-by-default: the rule is "RUN takes no flags at all", not a blocklist
    // that has to be updated every time the frontend grows a feature.
    expect(violationsOf('FROM x\nRUN --newfangled=1 npm ci\n')).toEqual([
      expect.stringContaining('--newfangled'),
    ]);
  });

  it('reports EVERY offending instruction, not just the first', () => {
    expect(
      violationsOf(
        'FROM x\nRUN --mount=type=cache,target=/c npm ci\nCOPY --link a b\nRUN --mount=type=cache,target=/c npm prune\n',
      ),
    ).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// what it must NOT flag
// ---------------------------------------------------------------------------

describe('check-dockerfile — approves what a factory Docker builds', () => {
  it('classic instruction flags are not false positives', () => {
    expect(
      violationsOf(
        [
          'FROM --platform=linux/amd64 node:20-slim AS builder',
          'COPY --chown=1000:1000 package.json ./',
          'RUN npm ci --include=dev',
          'FROM node:20-slim AS runtime',
          'COPY --from=builder /build/dist ./dist',
          "HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 CMD sh -c 'exit 0'",
        ].join('\n') + '\n',
      ),
    ).toEqual([]);
  });

  it('a `--flag` in the SHELL COMMAND is an argument, not an instruction flag', () => {
    expect(violationsOf('FROM x\nRUN npm prune --omit=dev --no-audit\n')).toEqual([]);
    expect(violationsOf('FROM x\nRUN apt-get install -y --no-install-recommends git\n')).toEqual([]);
  });

  it('a shell heredoc INSIDE a RUN is classic syntax and stays allowed', () => {
    // `RUN <<EOF` is the Dockerfile heredoc (BuildKit); `RUN sh -c 'cat <<EOF'`
    // is just /bin/sh and has always worked. Conflating them would make the
    // guard unusable in a repo whose entrypoint layers write files.
    expect(violationsOf("FROM x\nRUN sh -c 'cat <<EOF > /tmp/x'\n")).toEqual([]);
  });

  it('the Dockerfile may DISCUSS --mount in a comment without failing', () => {
    // The real Dockerfile documents the ban in prose. A checker that failed on
    // its own documentation would be worthless — and this repo's Dockerfile
    // now contains the literal strings `RUN --mount` and `COPY --link`.
    expect(
      violationsOf(
        [
          '# Never add `RUN --mount=type=cache,target=/root/.npm` here.',
          '# `COPY --link`, `--chmod` and `RUN <<EOF` are banned too.',
          'FROM node:20-slim',
          'RUN npm ci',
        ].join('\n') + '\n',
      ),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parser units
// ---------------------------------------------------------------------------

describe('check-dockerfile — parser units', () => {
  it('logicalLines joins continuations and reports the starting line', () => {
    const lines = logicalLines('FROM x\nRUN a \\\n  b \\\n  c\n');
    expect(lines).toHaveLength(2);
    expect(lines[1].line).toBe(2);
    expect(lines[1].text).toBe('RUN a b c');
  });

  it('logicalLines treats a blank line inside a continuation as Docker does', () => {
    const lines = logicalLines('FROM x\nRUN a \\\n\n  b \\\n   \n  c\n');
    expect(lines).toHaveLength(2);
    expect(lines[1].line).toBe(2);
    expect(lines[1].text).toBe('RUN a b c');
  });

  it('logicalLines keeps the instruction open across a line that is only `\\`', () => {
    // Why `continuing` is tracked separately from `buf`: this strips the
    // buffer back to empty, and `buf === ''` as the state flag would forget
    // an instruction is still open.
    const lines = logicalLines('FROM x\nRUN \\\n\\\n  --mount=type=cache,target=/c \\\n  npm ci\n');
    expect(lines).toHaveLength(2);
    expect(lines[1].text).toBe('RUN --mount=type=cache,target=/c npm ci');
  });

  it('a heredoc body is consumed, so its lines are not reported as unreadable', () => {
    // The unreadable-line rule must stay a signal about mis-parsed
    // instructions. `EOF` and the body lines belong to the heredoc, which is
    // already the one finding worth printing.
    expect(violationsOf('FROM x\nRUN <<EOF\nnpm ci\nEOF\nRUN npm test\n')).toEqual([
      expect.stringContaining('heredoc'),
    ]);
  });

  it('parseInstruction stops collecting flags at the first non-flag token', () => {
    const inst = parseInstruction({ line: 1, text: 'RUN npm install --save-dev tsx' });
    expect(inst?.keyword).toBe('RUN');
    expect(inst?.flags).toEqual([]);
    expect(inst?.body).toBe('npm install --save-dev tsx');
  });

  it('checkDockerfile separates violations from warnings', () => {
    const res = checkDockerfile(
      '# syntax=docker/dockerfile:1.7\nFROM x\nRUN --mount=type=cache,target=/c true\n',
    );
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0].line).toBe(1);
    expect(res.violations).toHaveLength(1);
    expect(res.violations[0].line).toBe(3);
  });
});

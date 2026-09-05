#!/usr/bin/env npx tsx
/**
 * check-dockerfile.ts — refuses BuildKit-only syntax in the Dockerfile.
 *
 * WHY THIS EXISTS
 * ---------------
 * huu is docker-only: the re-exec into the container IS the product (only
 * HUU_DEV_NATIVE=1 escapes it). So the image is not a convenience — if it
 * cannot be built, nothing runs. `RUN --mount=type=cache,target=/root/.npm`
 * shipped on the `npm ci` step from the first commit, and on any Docker
 * without the buildx plugin every `npm start` died at step 4 with
 * "the --mount option requires BuildKit". Nothing in the gate noticed, and
 * README lists only Node ≥ 20, git and Docker as prerequisites — buildx was
 * an undocumented one. This script is the thing that notices.
 *
 * WHAT IT REJECTS (exit 1)
 * ------------------------
 * Anything the CLASSIC (non-BuildKit) builder cannot parse:
 *   - any flag on RUN — the legacy builder supports ZERO of them, so
 *     `--mount=type=cache|secret|ssh|bind`, `--network=`, `--security=` are
 *     all covered by one rule that also catches flags invented later;
 *   - COPY/ADD flags other than `--from` and `--chown` (`--link`, `--chmod`,
 *     `--checksum`, `--parents`, `--exclude` are BuildKit-only);
 *   - FROM flags other than `--platform`;
 *   - Dockerfile heredocs — an instruction whose body STARTS with `<<`
 *     (`RUN <<EOF`, `COPY <<EOF /x`). A heredoc *inside* a shell command
 *     (`RUN sh -c 'cat <<EOF …'`) is classic syntax and is NOT flagged.
 *   - any logical line this parser cannot read as an instruction. Not a
 *     style rule: dropping those in silence is what once let
 *     `RUN \` + BLANK LINE + `--mount=…` exit 0 while `docker build` died
 *     with "the --mount option requires BuildKit". An unparsed line is an
 *     unchecked line, and this file may not call unchecked lines portable.
 *
 * WHAT IT ONLY WARNS ABOUT (exit 0)
 * ---------------------------------
 * A `# syntax=docker/dockerfile:1.x` parser directive. The legacy builder
 * ignores it, so it does not break a factory build — but it advertises a
 * frontend the file does not need, and that advertisement is what invited
 * `RUN --mount` in. The gate says NO only to what actually breaks; the rest
 * is a note. (See the PORTABILITY CONTRACT comment at the top of Dockerfile.)
 *
 * Comments are stripped before analysis — the Dockerfile's own contract
 * comment names `--mount` and `COPY --link` in prose, and a checker that
 * failed on its own documentation would be worthless.
 *
 * Usage:  npx tsx scripts/check-dockerfile.ts [--file <path>]
 * Exit:   0 when the file builds on a factory Docker, 1 otherwise.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(join(__dirname, '..'));

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/**
 * Flags the CLASSIC builder accepts, per instruction. Deny-by-default: an
 * unknown flag is treated as BuildKit-only, so a construct added to the
 * Dockerfile frontend after this file was written still trips the gate.
 */
const CLASSIC_FLAGS: Record<string, string[]> = {
  RUN: [], // the legacy builder supports no RUN flags at all
  COPY: ['--from', '--chown'],
  ADD: ['--from', '--chown'],
  FROM: ['--platform'],
  // HEALTHCHECK's four scheduling flags are CLASSIC syntax — they predate
  // BuildKit and the legacy builder parses them fine. Listing them is not a
  // courtesy: without this row the deny-by-default rule below would flag the
  // Dockerfile's own HEALTHCHECK and the gate would be red on a file that
  // builds. (`--start-interval` is deliberately absent: it needs a newer
  // frontend, so it should trip.)
  HEALTHCHECK: ['--interval', '--timeout', '--start-period', '--retries'],
};

/** Human-readable reason for the flags we expect to actually meet. */
const KNOWN_REASONS: Record<string, string> = {
  '--mount': 'cache/secret/ssh/bind mounts are a BuildKit frontend feature',
  '--network': 'per-RUN network control is BuildKit-only',
  '--security': 'per-RUN security mode is BuildKit-only',
  '--link': 'COPY --link needs the BuildKit frontend',
  '--chmod': 'COPY/ADD --chmod needs the BuildKit frontend (--chown is classic)',
  '--checksum': 'ADD --checksum needs the BuildKit frontend',
  '--parents': 'COPY --parents needs the BuildKit frontend',
  '--exclude': 'COPY --exclude needs the BuildKit frontend',
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

interface LogicalLine {
  /** 1-based line number where the instruction STARTS in the source file. */
  line: number;
  /** Continuations joined, comments dropped. */
  text: string;
}

/**
 * Collapse a Dockerfile into logical instructions.
 *
 * Three things matter here and all three were regressions waiting to happen:
 *   1. Comment lines are dropped, INCLUDING comment lines that sit inside a
 *      continued instruction (the real Dockerfile parser drops those too).
 *   2. A trailing `\` continues the instruction. Without joining, the very
 *      shape this repo shipped —
 *          RUN \
 *              --mount=type=cache,target=/root/.npm \
 *              npm ci
 *      — would slip past a per-line regex, because line 1 carries no flag.
 *   3. An EMPTY line INSIDE a continuation does NOT end the instruction. The
 *      real parser warns ("Empty continuation line found in: RUN --mount=…
 *      echo hi") and keeps joining — proven by building this on the classic
 *      builder, which then died with "the --mount option requires BuildKit":
 *          RUN \
 *                                    ← blank line, still one instruction
 *              --mount=type=cache,target=/root/.npm \
 *              echo hi
 *      Treating the blank as a terminator closed the instruction as bare
 *      `RUN ` and left `--mount=…` as an orphan fragment, which
 *      parseInstruction rejected and checkDockerfile used to DROP IN SILENCE.
 *      Exit 0 on a Dockerfile that cannot build: the exact failure this file
 *      exists to prevent, one blank line away.
 *
 * `continuing` is tracked separately from `buf` on purpose: a line that is
 * nothing but `\` strips down to an empty buffer, and using `buf === ''` as
 * the state flag would silently forget that an instruction is still open.
 */
export function logicalLines(source: string): LogicalLine[] {
  const raw = source.split('\n');
  const out: LogicalLine[] = [];

  let buf = '';
  let startLine = 0;
  let continuing = false;

  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    // A comment line is invisible to the parser, whether or not we are in the
    // middle of a continuation.
    if (/^\s*#/.test(line)) continue;

    if (!continuing) {
      if (line.trim() === '') continue;
      startLine = i + 1;
      buf = line.trim();
    } else {
      // Empty continuation line: Docker warns and joins on. So do we.
      if (line.trim() === '') continue;
      buf = buf === '' ? line.trim() : buf + ' ' + line.trim();
    }

    if (/\\\s*$/.test(buf)) {
      buf = buf.replace(/\\\s*$/, '').trimEnd();
      continuing = true;
      // keep accumulating
      continue;
    }

    out.push({ line: startLine, text: buf });
    buf = '';
    continuing = false;
  }

  if (buf !== '') out.push({ line: startLine, text: buf });
  return out;
}

interface Instruction {
  line: number;
  keyword: string;
  flags: string[];
  /** Everything after the flag prefix. */
  body: string;
}

/** Split a logical line into keyword + leading `--flag` tokens + body. */
export function parseInstruction(l: LogicalLine): Instruction | null {
  const m = l.text.match(/^([A-Za-z][A-Za-z0-9_]*)\s+([\s\S]*)$/);
  if (!m) return null;
  const keyword = m[1].toUpperCase();
  let rest = m[2].trim();
  const flags: string[] = [];

  // Flags are only flags while they form an unbroken prefix. `RUN npm i --foo`
  // is a shell argument, not an instruction flag — stopping at the first
  // non-flag token is what keeps this from screaming about ordinary commands.
  for (;;) {
    const fm = rest.match(/^(--[A-Za-z0-9_-]+)(=\S*)?\s*/);
    if (!fm) break;
    flags.push(fm[1]);
    rest = rest.slice(fm[0].length);
  }

  return { line: l.line, keyword, flags, body: rest };
}

// ---------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------

export interface Violation {
  line: number;
  message: string;
}

export function checkDockerfile(source: string): {
  violations: Violation[];
  warnings: Violation[];
} {
  const violations: Violation[] = [];
  const warnings: Violation[] = [];

  // Parser directive — a warning, never a failure: the classic builder simply
  // ignores it.
  source.split('\n').forEach((line, idx) => {
    const m = line.match(/^\s*#\s*syntax\s*=\s*(\S+)/i);
    if (m) {
      warnings.push({
        line: idx + 1,
        message:
          `parser directive \`# syntax=${m[1]}\` — the classic builder ignores it, so ` +
          `it does not break a factory build, but it advertises a frontend this ` +
          `Dockerfile does not use. Drop it unless something here truly needs it.`,
      });
    }
  });

  // Body lines of a Dockerfile heredoc are not instructions. The heredoc
  // itself is already reported below; re-reporting `npm ci` and `EOF` as
  // garbage would bury that one real finding under noise.
  let heredocEnd: string | null = null;

  for (const l of logicalLines(source)) {
    if (heredocEnd !== null) {
      if (l.text.trim() === heredocEnd) heredocEnd = null;
      continue;
    }

    const inst = parseInstruction(l);
    if (!inst) {
      // NEVER `continue` here. A logical line the parser cannot read is not a
      // line worth ignoring — it means either the file is malformed or THIS
      // joiner mis-split a continuation, and the second case is how
      //     RUN \ / <blank> / --mount=type=cache,… \ / echo hi
      // reported exit 0 while `docker build` reported "the --mount option
      // requires BuildKit". Silence there is what let a proven-broken
      // Dockerfile pass the gate, so unreadable is now RED.
      const preview = l.text.length > 48 ? `${l.text.slice(0, 48)}…` : l.text;
      violations.push({
        line: l.line,
        message:
          `unreadable line \`${preview}\` — not a Dockerfile instruction, so nothing ` +
          `on it could be checked. Either the file is malformed or this checker ` +
          `mis-joined a continuation; a portability claim over a line nobody parsed ` +
          `would be a guess.`,
      });
      continue;
    }

    const allowed = CLASSIC_FLAGS[inst.keyword];
    for (const flag of inst.flags) {
      // An instruction with no entry in CLASSIC_FLAGS takes no flags at all.
      const ok = (allowed ?? []).includes(flag);
      if (ok) continue;
      const reason = KNOWN_REASONS[flag] ?? 'the classic builder rejects this flag';
      violations.push({
        line: inst.line,
        message: `${inst.keyword} ${flag} — ${reason}`,
      });
    }

    // Dockerfile heredoc: the BODY starts with `<<`. A heredoc used inside a
    // shell command (`RUN sh -c 'cat <<EOF'`) never starts the body, so it is
    // correctly left alone.
    if (/^<</.test(inst.body) && ['RUN', 'COPY', 'ADD'].includes(inst.keyword)) {
      violations.push({
        line: inst.line,
        message: `${inst.keyword} heredoc (\`${inst.body.slice(0, 20)}…\`) — heredocs need the BuildKit frontend`,
      });
      // Swallow the body up to its delimiter so the unreadable-line rule above
      // stays a signal about mis-parsed instructions, not about `EOF`.
      const dm = inst.body.match(/^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
      if (dm) heredocEnd = dm[2];
    }
  }

  return { violations, warnings };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const fileArgIdx = process.argv.indexOf('--file');
  const target =
    fileArgIdx >= 0 && process.argv[fileArgIdx + 1]
      ? resolve(process.argv[fileArgIdx + 1])
      : join(ROOT, 'Dockerfile');

  if (!existsSync(target)) {
    console.error(`check-dockerfile: file not found: ${target}`);
    process.exit(1);
  }

  const rel = relative(process.cwd(), target) || target;
  const { violations, warnings } = checkDockerfile(readFileSync(target, 'utf8'));

  for (const w of warnings) {
    console.log(`WARN ${rel}:${w.line}: ${w.message}`);
  }

  if (violations.length === 0) {
    console.log(`check-dockerfile: ${rel} builds on a factory Docker (no BuildKit-only syntax)`);
    process.exit(0);
  }

  for (const v of violations) {
    console.error(`BUILDKIT-ONLY ${rel}:${v.line}: ${v.message}`);
  }
  console.error('');
  console.error(
    `check-dockerfile: ${violations.length} BuildKit-only construct(s) in ${rel}.`,
  );
  console.error(
    'huu is docker-only, so this image must build with plain `docker build` on a',
  );
  console.error(
    'Docker with NO buildx plugin — otherwise the whole tool refuses to start with',
  );
  console.error(
    '"the --mount option requires BuildKit". Rewrite without the flag above; see the',
  );
  console.error('PORTABILITY CONTRACT comment at the top of the Dockerfile.');
  process.exit(1);
}

// Only run when invoked as a script — the test imports the pure functions.
if (process.argv[1] && resolve(process.argv[1]).endsWith('check-dockerfile.ts')) {
  main();
}

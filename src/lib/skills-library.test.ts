import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..', '..');
const script = join(
  root,
  '.agents',
  'skills',
  'meta-skill-consolidate',
  'scripts',
  'validate-skills.sh',
);
const skillsDir = join(root, '.agents', 'skills');
const claudeSkillsDir = join(root, '.claude', 'skills');

function runValidator(): string {
  return execFileSync('bash', [script], { encoding: 'utf-8', timeout: 30_000 });
}

/** Run validator and return its combined output. Throws if exit 0. */
function runValidatorExpectFail(): string {
  try {
    execFileSync('bash', [script], { encoding: 'utf-8', timeout: 30_000 });
    throw new Error('expected validator to fail, but it exited 0');
  } catch (e: any) {
    return `${e.stdout || ''}${e.stderr || ''}`;
  }
}

/** Set up a temp skill dir + catalog entry + symlink. Returns cleanup fn. */
function setupTempSkill(name: string, skillBody: string, learningsBody: string): () => void {
  const testDir = join(skillsDir, name);
  const catalogPath = join(skillsDir, 'catalog.md');
  const catalogOrig = readFileSync(catalogPath, 'utf-8');
  const linkPath = join(claudeSkillsDir, name);
  let linkCreated = false;

  // Ensure clean state
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  if (existsSync(linkPath)) rmSync(linkPath);

  mkdirSync(testDir, { recursive: true });
  if (!existsSync(claudeSkillsDir)) mkdirSync(claudeSkillsDir, { recursive: true });

  writeFileSync(join(testDir, 'SKILL.md'), skillBody);
  writeFileSync(join(testDir, 'LEARNINGS.md'), learningsBody);

  symlinkSync(testDir, linkPath);
  linkCreated = true;

  writeFileSync(catalogPath, catalogOrig + `\n- [${name}](${name}/SKILL.md) \`knowledge\` — test skill.\n`);

  return () => {
    // Remove symlink first
    if (linkCreated && existsSync(linkPath)) unlinkSync(linkPath);
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    // Restore catalog
    writeFileSync(catalogPath, catalogOrig);
  };
}

describe('skills-library', () => {
  it('validate-skills.sh exits 0 for the real skill library', () => {
    const out = runValidator();
    expect(out).toContain('OK');
  });

  it('validate-skills.sh catches token-over-cap skills', () => {
    const name = 'token-cap-test';
    let body = '';
    for (let i = 0; i < 600; i++) {
      body += `Line ${String(i).padStart(4, '0')}: content to exceed the token budget cap limit\n`;
    }

    const skillMd = `---
name: ${name}
description: Temporary skill for token-cap validation testing.
metadata:
  type: knowledge
---

# Token Cap Test

${body}
`;
    const learningsMd = `# Learnings — ${name}
Append-only log.

<!-- entries below this line -->
- [2026-07-01][source:inference][task:test][probation] Test entry.
`;

    const cleanup = setupTempSkill(name, skillMd, learningsMd);
    let out = '';
    try {
      out = runValidatorExpectFail();
    } finally {
      cleanup();
    }
    expect(out).toMatch(/FAIL\[token-cap-test\]/);
  });

  it('validate-skills.sh rejects stale skills (>90d TTL)', () => {
    const name = 'ttl-test-tmp';

    const skillMd = `---
name: ${name}
description: Temporary skill for TTL validation testing.
metadata:
  type: knowledge
---

# TTL Test
`;
    const learningsMd = `# Learnings — ${name}
Append-only log.

<!-- entries below this line -->
- [2025-01-01][source:inference][task:test][probation] Test entry.
`;

    const cleanup = setupTempSkill(name, skillMd, learningsMd);
    let out = '';

    // Backdate files to >300 days ago
    const skillPath = join(skillsDir, name, 'SKILL.md');
    const learningsPath = join(skillsDir, name, 'LEARNINGS.md');
    const oldTime = new Date('2025-03-01T00:00:00Z');
    utimesSync(skillPath, oldTime, oldTime);
    utimesSync(learningsPath, oldTime, oldTime);

    try {
      out = runValidatorExpectFail();
    } finally {
      cleanup();
    }
    expect(out).toContain('TTL expired');
    expect(out).toContain(name);
  });

  it('validate-skills.sh catches closed-vocabulary violations in LEARNINGS', () => {
    const name = 'vocab-test';

    const skillMd = `---
name: ${name}
description: Temporary skill for vocabulary validation testing.
metadata:
  type: knowledge
---

# Vocab Test
`;
    const learningsMd = `# Learnings — ${name}
Append-only log.

<!-- entries below this line -->
- [2026-07-01][source:inference][task:good][probation] Valid entry.
- [2026-07-01][source:chatgpt][task:bad-source][probation] This entry uses an invalid source tag.
`;

    const cleanup = setupTempSkill(name, skillMd, learningsMd);
    let out = '';
    try {
      out = runValidatorExpectFail();
    } finally {
      cleanup();
    }
    expect(out).toMatch(/FAIL\[vocab-test\].*vocabulary/);
  });

  // Regression: the old "backend name consistency check" derived its grep
  // alternation FROM the valid kinds in registry.ts, so its `err` branch was
  // UNREACHABLE — `AgentBackendKind = 'pi' | 'azure' | 'stub'` sat in a real
  // SKILL.md for weeks while the validator printed OK. These two tests pin
  // both halves of the replacement: it must fail on a live assertion, and it
  // must stay quiet on a historical mention.
  it('validate-skills.sh catches a REMOVED backend asserted as live', () => {
    const name = 'removed-backend-live-test';

    const skillMd = `---
name: ${name}
description: Temporary skill for removed-backend liveness testing.
metadata:
  type: knowledge
---

# Removed Backend Test

\`AgentBackendKind = 'pi' | 'azure' | 'stub'\` — three kinds.
Note: azure IS a real backend, and \`backends/pi/\` holds the factory.
Run it with \`--backend=pi\`; the pi agent reads your AGENTS.md.
`;
    const learningsMd = `# Learnings — ${name}
Append-only log.

<!-- entries below this line -->
- [2026-09-05][source:inference][task:test][probation] Test entry.
`;

    const cleanup = setupTempSkill(name, skillMd, learningsMd);
    let out = '';
    try {
      out = runValidatorExpectFail();
    } finally {
      cleanup();
    }
    expect(out).toMatch(/FAIL\[removed-backend-live-test\].*REMOVED backend as live/);
    // Every one of the four shapes must be caught, not just the first.
    expect(out).toMatch(/line 10 asserts a REMOVED backend as live/);
    expect(out).toMatch(/line 11 asserts a REMOVED backend as live/);
    expect(out).toMatch(/line 12 asserts a REMOVED backend as live/);
  });

  it('validate-skills.sh allows HISTORICAL mentions of a removed backend', () => {
    const name = 'removed-backend-history-test';

    const skillMd = `---
name: ${name}
description: Temporary skill for removed-backend historical-mention testing.
metadata:
  type: knowledge
---

# Removed Backend History

\`pi\` and \`azure\` were deleted in v3.0, so \`backends/pi/\` no longer exists.
The pi backend was the default until v3.0; the azure backend is gone.
\`docs/pi-coding-agent.md\` survives only as a REMOVED-backend marker.
`;
    // A LEARNINGS journal is dated by construction — a 2026-06 entry about the
    // pi backend records what was true then and must never fail the gate.
    const learningsMd = `# Learnings — ${name}
Append-only log.

<!-- entries below this line -->
- [2026-06-25][source:inference][task:test][probation] The pi backend used \`AgentBackendKind = 'pi' | 'azure' | 'stub'\` back then.
`;

    const cleanup = setupTempSkill(name, skillMd, learningsMd);
    let out = '';
    try {
      out = runValidator();
    } finally {
      cleanup();
    }
    expect(out).toContain('OK');
    expect(out).not.toContain(name);
  });

  it('validate-skills.sh catches non-existent catalog entries', () => {
    const catalogPath = join(skillsDir, 'catalog.md');
    const catalogOrig = readFileSync(catalogPath, 'utf-8');

    writeFileSync(catalogPath, catalogOrig + '\n- [nonexistent-skill](nonexistent-skill/SKILL.md) `knowledge` — phantom.\n');

    let out = '';
    try {
      out = runValidatorExpectFail();
    } finally {
      writeFileSync(catalogPath, catalogOrig);
    }
    expect(out).toMatch(/FAIL\[catalog\].*nonexistent-skill/);
  });
});

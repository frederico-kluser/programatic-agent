// The single DECLARATION surface for the selectable methodologies.
//
// Before this module, adding one option meant editing four hand-maintained
// lists that fail SILENTLY when you miss one: the CLI flag parse, the CLI
// usage text, the web checkbox catalog, and the planner's content-constraint
// bullets — plus a fifth, `anyMethodologyOn`, whose omission costs the option
// its human escape (`ReviewSpec.onBlocked: 'hold'`) with no error anywhere.
// Each of those is now DERIVED from the table below.
//
// What deliberately does NOT live here is the STRUCTURE each option compiles.
// That stays in `plan-to-pipeline.ts`, next to the graph invariants it has to
// respect (exactly one forward `default` per check, `dependsOn` naming only
// earlier steps, byte-identity when every flag is off). A registry entry that
// also carried a step builder would drag the whole `CompileCtx` into a module
// the web server imports, and would put graph rules two files away from the
// graph.
//
// Pure: no fs, no env, no process state. `keyof DevMethodology` keeps the
// table honest — an entry the type does not declare is a compile error, not a
// silent no-op.

import type { DevMethodology } from '../types.js';

/** One selectable methodology, everything except the structure it compiles. */
export interface MethodologyDefinition {
  /** The `DevMethodology` field this option sets. Compile-checked. */
  key: keyof DevMethodology;
  /** The CLI flag, WITHOUT the leading `--`. */
  flag: string;
  /** The web checkbox label. */
  label: string;
  /** The web checkbox description — one line, user-facing. */
  description: string;
  /** The CLI usage line's right-hand column (pt-BR, like the rest of USAGE). */
  usage: string;
  /**
   * What this option asks of the PLANNER — content, never structure. The
   * compiler enforces the method; this is the bullet that tells the planner
   * how to produce a plan that survives it.
   */
  plannerBullet: string;
}

/**
 * The methodologies, in the order every surface presents them: the web panel,
 * the CLI usage block and the planner's active-methodology list. Appending is
 * the additive case; REORDERING changes served payloads and prompt bytes, so
 * new options go at the end.
 */
export const DEV_METHODOLOGIES: readonly MethodologyDefinition[] = [
  {
    key: 'tdd',
    flag: 'tdd',
    label: 'TDD',
    description: 'Each front writes the tests first (and watches them fail) before implementing.',
    usage: 'testes antes da implementação',
    plannerBullet:
      '- `tdd` — TESTS COME FIRST. Every front will write failing tests before any implementation exists, so slice tasks whose "Done when" criteria are objectively testable; a criterion a test cannot express fails the method.',
  },
  {
    key: 'lintGate',
    flag: 'lint-gate',
    label: 'Lint gate',
    description:
      "The project's lint/typecheck becomes a deterministic merge gate — a failure reverts the merge.",
    usage: 'lint/typecheck como merge gate determinístico',
    plannerBullet:
      "- `lintGate` — the project's lint/typecheck commands run as a deterministic merge gate after EVERY task merge. Plan no task whose diff cannot pass a static check on its own.",
  },
  {
    key: 'standards',
    flag: 'standards',
    label: 'Standards validation',
    description:
      "The epoch atlas and the project's conventions become a mandatory rubric for every critic.",
    usage: 'crítico com a rubrica dos padrões do projeto',
    plannerBullet:
      "- `standards` — every diff is audited against the project's DECLARED conventions (the epoch atlas, AGENTS.md). Name the conventions each front must follow in its prompts instead of leaving them implicit.",
  },
  {
    key: 'planReview',
    flag: 'plan-review',
    label: 'Choice validation',
    description: "An agent audits the plan's decisions before the fan-out, with one loop-back to recon.",
    usage: 'auditoria do plano antes do fan-out',
    plannerBullet:
      '- `planReview` — your plan will be AUDITED before the fan-out: coverage against the epoch goal, declared write-set disjointness across every spec, feasibility against the atlas. Split by file ownership and make the partition explicit — an overlapping write-set sends the epoch back to be re-planned.',
  },
  {
    key: 'writeSet',
    flag: 'write-set',
    label: 'Write-set enforcement',
    description:
      "A task that writes a file its spec does not declare as owned is blocked — by the critic before the merge, and by the front's judge after it.",
    usage: 'arquivo fora do write-set declarado bloqueia',
    plannerBullet:
      '- `writeSet` — declared file ownership is ENFORCED, not measured: a task that writes a file its spec does not list under "Files this task OWNS" is blocked, never warned. Instruct each front\'s recon, in its prompt, to declare ownership COMPLETELY — including the shared files (a barrel, an index, a router) that work quietly needs — and keep the partition disjoint across fronts.',
  },
  {
    key: 'changelogGate',
    flag: 'changelog',
    label: 'Changelog discipline',
    description:
      'Commit subjects must be Conventional Commits, and a user-visible change must carry a changelog entry in the same diff.',
    usage: 'Conventional Commits + entrada de changelog',
    plannerBullet:
      '- `changelogGate` — commit subjects are checked MECHANICALLY against Conventional Commits at merge time, and any USER-VISIBLE change (a flag, an API surface, an output format, a default) must carry a changelog entry in the same diff. Make every task spec state plainly whether its outcome is user-visible, and give the changelog file exactly one owning task when it is — two tasks appending to one changelog is the classic avoidable conflict.',
  },
  {
    key: 'diffBudget',
    flag: 'diff-budget',
    label: 'Small batches',
    description:
      "Each task's diff is capped in lines and files at merge time, so no single change grows past the size where review stops working.",
    usage: 'teto de linhas/arquivos por tarefa',
    plannerBullet:
      "- `diffBudget` — every TASK's diff is capped in lines and files, enforced at merge time. Decompose until each one fits: a front whose work cannot be cut that small needs MORE tasks, not a bigger one. Say so in each front's recon prompt — the recon is what writes the task specs, and it is the only place the split can still happen.",
  },
  {
    key: 'fitnessFunctions',
    flag: 'fitness',
    label: 'Architecture rules',
    description:
      "The project's dependency/layering check runs as a merge gate, and its declared rules become a citable rubric for every critic.",
    usage: 'regras de arquitetura como merge gate',
    plannerBullet:
      "- `fitnessFunctions` — this project's executable architecture check (dependency rules, layering, cycles) runs after EVERY task merge, and the atlas's layering rules are binding on the critic. Draw the front partition ALONG the architecture's existing boundaries rather than across them: a front that spans two layers turns one honest change into a rule violation the gate rejects.",
  },
  {
    key: 'checklistReview',
    flag: 'checklist',
    label: 'Checklist review',
    description:
      'Every critic answers a fixed checklist item by item — PASS/FAIL/N-A with evidence — instead of writing free-form prose.',
    usage: 'crítico responde checklist item a item',
    plannerBullet:
      '- `checklistReview` — every critic must return a fixed verdict per checklist item, and the central item is "every \'Done when\' line is satisfied", answered ONE LINE AT A TIME. A criterion nobody can settle with a command or a file read cannot be answered, so it becomes an abstention rather than a check. Make each front produce criteria that are individually decidable — never one compound sentence joining three things with "and".',
  },
  {
    key: 'traceability',
    flag: 'traceability',
    label: 'Traceability matrix',
    description:
      'After the fan-out, an agent maps every criterion to the test that settles it and back, and a check refuses orphans in either direction.',
    usage: 'matriz requisito ↔ teste, sem órfãos',
    plannerBullet:
      "- `traceability` — after the fronts merge, every \"Done when\" criterion must map to a test or a file that settles it, and every delivered file must map back to a criterion. Both directions are checked. So: no front may carry a criterion nothing could ever demonstrate, and the epoch's fronts together must COVER the epoch goal — work that belongs to no criterion shows up as an orphan and sends the epoch back.",
  },
  {
    key: 'characterization',
    flag: 'characterize',
    label: 'Characterization tests',
    description:
      "Each front records today's observable behavior as committed snapshots BEFORE changing anything; a later divergence must be explicitly approved.",
    usage: 'snapshot do comportamento atual antes de mudar',
    plannerBullet:
      "- `characterization` — every front captures the CURRENT observable behavior as committed snapshots before it changes a line, and those snapshots are then frozen. Slice tasks around behavior that can actually be OBSERVED from outside (a command's output, a function's return, a rendered file) — a task whose only effect is internal has nothing to characterize, and should say so rather than invent a snapshot.",
  },
  {
    key: 'chainOfVerification',
    flag: 'verify-claims',
    label: 'Claim verification',
    description:
      'In the knowledge phase, a second agent re-checks every claim against the repo and demotes what it cannot reproduce — nothing invented reaches the plan.',
    usage: 'verifica cada afirmação do digest contra o repo',
    plannerBullet:
      '- `chainOfVerification` — every claim in the briefing you are reading was RE-CHECKED against the repository by a second agent, and anything unreproducible was demoted into `unknowns`. So read `unknowns` as load-bearing, not as filler: it is now a measured statement of what this run does not know. Plan around those gaps explicitly — send a front to find out — rather than assuming the missing detail.',
  },
  {
    key: 'debate',
    flag: 'debate',
    label: 'Adversarial debate',
    description:
      "Two agents from DIFFERENT model families argue this epoch's design decisions before any front starts — one records them, the other attacks them — and an anonymized judge rules, capped at two rounds. Like every methodology, it also switches every task's critic to HOLD instead of waiving at the round cap.",
    usage: 'debate adversarial das escolhas antes das frentes (e crítico em hold)',
    plannerBullet:
      '- `debate` — your plan\'s design decisions will be ARGUED ADVERSARIALLY before any front starts, by two agents from different model families, and a judge rules on the record. So write each front\'s `rationale` as a DECISION and not as a description: what was chosen, what was rejected, and what would show the choice was wrong. A rationale that only restates the title gives the debate nothing to argue about and the epoch pays for two agents that found nothing.',
  },
];

/**
 * Reads the methodology checkboxes out of argv, carrying ONLY the keys whose
 * flag was given. No flag at all returns `undefined` — NOT an empty object —
 * because "asked for none" must compile the pipeline huu compiles today, byte
 * for byte, and `{}` is a different thing to every downstream `?.` check.
 */
export function parseMethodologyFlags(args: readonly string[]): DevMethodology | undefined {
  const methodology: DevMethodology = {};
  for (const def of DEV_METHODOLOGIES) {
    if (args.includes(`--${def.flag}`)) methodology[def.key] = true;
  }
  return Object.keys(methodology).length > 0 ? methodology : undefined;
}

/**
 * The `metodologias:` section of the CLI usage text. The flag column is sized
 * from the longest flag rather than a constant, so adding a longer flag can
 * never silently collapse the gap to zero.
 */
export function methodologyUsageBlock(): string {
  const width = Math.max(...DEV_METHODOLOGIES.map((d) => d.flag.length + 2)) + 2;
  const lines = DEV_METHODOLOGIES.map((d) => `    ${`--${d.flag}`.padEnd(width)}${d.usage}`);
  return `  metodologias (todas desligadas por padrão):\n${lines.join('\n')}`;
}

/** The definitions the human turned on, in registry order. */
export function activeMethodologies(m: DevMethodology | undefined): MethodologyDefinition[] {
  if (!m) return [];
  return DEV_METHODOLOGIES.filter((d) => m[d.key] === true);
}

/**
 * True when the human underwrote at least one methodology. That is the trigger
 * for `ReviewSpec.onBlocked: 'hold'`: an enforcement option whose failure
 * waives silently would be decorative, so a round-cap with blockers parks the
 * task for a human (the interactive-retry hold) instead of merging over an
 * objection.
 *
 * Reads the OBJECT, not a hand-written `||` chain — the chain was the one
 * place a new methodology could be forgotten and lose its escape in silence.
 */
export function anyMethodologyOn(m: DevMethodology | undefined): boolean {
  return Boolean(m) && Object.values(m as DevMethodology).some(Boolean);
}

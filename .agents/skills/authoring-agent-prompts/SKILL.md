---
name: authoring-agent-prompts
description: Cross-LLM prompt-engineering knowledge for huu step prompts, judge conditions and memory-recon prompts — the 12 techniques (atomic decomposition, structural tags, explicit output contract, role+stakes, few-shot, parsimonious negatives, CoT only in judges, self-check, variable injection, lean system prompt, mechanical fixed-enum judges, empirical iteration) tied to the produces MEMORY CONTRACT, $file/$hint fan-out, scope memory, forward-default CheckStep verdicts and the jcode backend. Use when writing or sharpening a pipeline step prompt, designing a judge verdict, authoring a memory recon prompt, targeting a small model, or keeping a prompt portable across whichever provider the backend is pointed at.
metadata:
  version: 0.1.0
  type: knowledge
---

# Authoring Agent Prompts

## When to use

Writing or sharpening any per-step prompt, CheckStep `condition`, or memory
recon prompt — especially for small models or to stay portable when the
backend's provider changes. Pairs with authoring-pipelines (step/check shapes) and
editing-default-pipelines (the 7 bundled defaults). The full prose +
sources live in `docs/prompting-playbook.md` (pt-BR twin alongside).

## The contract this serves

huu steps are **one cognitive op each**; the human owns the method, the
agent supplies intelligence. That only holds if the prompt is mechanical
enough for a *small* model on *any* provider. These techniques are how you
get there.

## The 12 techniques (each: rule → huu hook)

1. **Atomic directive decomposition** — one cognitive op, numbered
   verb-driven substeps; swap vague verbs (improve/consider/handle) for
   mechanical ones (read/parse/write/assert). → one step = one `produces`
   artifact or one transformation; a per-file step does the SAME op to every
   `$file`, never a checklist.
2. **Structural tags / sectioning** — `=== STEP n ===` banners or
   `<task>/<context>/<output>` zones so the model parses instruction vs
   data. → fence injected `$file` content and the `$hint` note in their own
   tagged block so scanned data is never read as orders.
3. **Explicit output contract** — state field names, types, enums BEFORE the
   task. → the `produces` MEMORY CONTRACT (path + `huu-memory-v1` + consumer
   cap + hint rule) is auto-appended by `src/lib/memory-contract.ts`; audits'
   FAQ-append schema (`<topic>-faq.json`) the same. Declare the link, don't
   paste boilerplate.
4. **Role + stakes opener** — "You are X. Goal: Y." → "You are a security
   auditor. Goal: write `.huu/audits/<topic>.md`, report-only" reasserts the
   report-only contract in the opener.
5. **Few-shot anchoring** — 2-3 short curated examples (one canonical, one
   edge). → show one well-formed `huu-memory-v1` entry and one tricky one
   (no hint / skip-listed file) so recon emits the exact shape the consumer
   fans out over.
6. **Negative constraints, parsimoniously** — a few HARD RULES, each "don't"
   paired with the positive alternative; not a wall of negations (they
   degrade small models). → "Do NOT touch `README.md`/`package.json`; write
   ONLY under `.huu/audits/`".
7. **CoT ONLY in judges/decisions** — reasoning in CheckStep judges and
   routing, never in code steps (the diff is the reasoning). → judge may
   reason before its verdict JSON; a per-file fix step just edits + commits,
   no narration.
8. **Self-verification** — end with "SELF-CHECK before finishing" listing
   the invariants. → "file at the exact `filesFrom` path? every entry has a
   hint? `_format` is `huu-memory-v1`?" pre-empts the corrupt-file run
   failure.
9. **Variable injection** — `$file`, `$hint`, `$runs`; never hardcode a
   path. → `$hint` (substituted BEFORE `$file`) carries the producer's
   per-file lead; `$runs` exposes the visit count to a judge condition for
   loop caps.
10. **Lean system prompt / progressive disclosure** — pi keeps its system
    prompt < ~1k tokens and loads AGENTS.md / on-demand skills as needed; put
    task logic in the step prompt. → don't restate architecture or tool docs
    the agent already loads; say WHAT to produce and HOW it's checked.
11. **Mechanical judges (fixed-enum verdicts)** — judge emits
    `{label, reason}` from a small label set, no multi-hop reasoning, and the
    **default outcome moves FORWARD** (stub-safe). → exactly one
    `default: true` in `outcomes[]`; make it the SAFE path
    (`approved`/`proceed`), never the loop — it fires on judge failure,
    unknown label, or the `maxRuns` cap.
12. **Empirical iteration** — A/B the prompt on a few representative files;
    descriptions/prompts ARE the routing signal, sharpen from observed
    failures. → dry-run with the stub backend (free, no key), watch which
    judge outcome fires on the kanban, tighten the wording the failure came
    from.

## jcode backend grain (`jcode` CLI subprocess, DeepSeek V4 Pro)

- **There is no system-prompt slot.** The role/scope/rules header is huu's own
  and rides inside the FIRST USER MESSAGE
  (`_shared/build-message.ts` → `agents-md-generator.ts`), so a step prompt
  that writes `System:` framing just lands as more user text.
- **The whole message travels as ONE argv string**, capped at
  `JCODE_MAX_PROMPT_BYTES = 32 * 4096` (`backends/jcode/factory.ts:112`;
  131071 bytes accepted / 131072 → E2BIG, measured). Over the 60 steps of the
  7 bundled pipelines the full first-turn message peaks at 12581 bytes
  (p50 4524, fixed header 1514) — so lean prompts have a hard ceiling behind
  them, not only a style preference.
- **Every run is stateless.** `JCODE_MEMORY_ENABLED=false`
  (`backends/jcode/hermetic.ts:261`) — zero embeddings, no memory across
  turns. The prompt plus the worktree ARE the context; nothing carries over
  from a previous agent, so never write "as we discussed".
- **No tool restriction is passed.** `buildJcodeArgs` emits only
  `run --no-update --provider-profile <p> --model <id> -- <prompt>`
  (`factory.ts:77`), so every agent holds jcode's full default toolset. A
  "report, never fix" or "read-only" boundary in a prompt is PROSE, not
  permission — write it as an acceptance condition someone can check.
- **One provider is wired today**, not a menu: `hermetic.ts:116-120`
  materializes a single `deepseek-v4-pro` profile against
  `https://api.deepseek.com/v1`. Keep prompts provider-agnostic anyway
  (schema + delimiters + examples, not a model's quirks) — that is portability
  insurance for the next provider, not a description of the current wiring.
- Reliable shape is *task + acceptance*, not *step-by-step keystrokes*: say
  what must be TRUE when done. Deep dive:
  `.agents/skills/integrating-llm-backends/SKILL.md` — `docs/pi-coding-agent.md`
  is only a REMOVED-backend marker.

## Anti-patterns (and the fix)

- Multi-op step (scan AND fix AND document) → split into atomic steps (1).
- "respond in JSON" with no field/type/enum schema → state the schema (3).
- Vague acceptance ("write good tests") → nothing a judge can gate (1, 11).
- Overstuffed system prompt restating loaded docs → trim (10).
- Negation overload with no positive redirect → a few HARD RULES (6).
- Role without stakes ("You are an expert engineer.") → add the goal (4).
- Discovery + transformation blended in one step → an earlier step WRITES
  the memory file, the memory step CONSUMES it (1, 9).
- Hardcoded paths in a fan-out prompt → inject `$file`/`$hint` (9).
- A judge re-auditing the whole repo → check one objective condition, keep
  the default forward (11).

## References

- `docs/prompting-playbook.md` (+ `docs/prompting-playbook.pt-BR.md`) — full
  technique prose and cited sources (Anthropic, OpenAI GPT-4.1 + structured
  outputs, Gemini, Chain-of-Thought). Its backend section is STALE — it still
  names a backend deleted in v3.0; trust the grain section above instead.
- Related skills: authoring-pipelines (WorkStep/CheckStep schema, `produces`
  link, the memory scope), editing-default-pipelines (how the 7 bundled
  defaults apply all of this), integrating-llm-backends (the jcode backend).
- `src/lib/memory-contract.ts` (auto-appended MEMORY CONTRACT);
  `docs/memory-scope.md` (`$hint`/`filesFrom` semantics).

> Facts verified against source on 2026-06-25.

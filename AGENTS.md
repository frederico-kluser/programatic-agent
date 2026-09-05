# huu

A TypeScript/React (Ink) CLI TUI that runs LLM-agent pipelines in isolated git worktrees. Each stage decomposes into parallel tasks, deterministically merged into a central worktree at the end of every stage.

**Identity:** huu designs pipelines that make *thinking* agents follow a
*deterministic* process. It is NOT a tool for building new features — the
focus is audits, test generation, knowledge extraction, and any
assembly-line process with real, predictable value. No LLM planner invents
scope; the human underwrites the method, the agent supplies the
intelligence. Keep this framing in all docs and default pipelines.

## Build & Run

```bash
# Install dependencies
npm install

# Run in dev (hot reload) NATIVELY — no docker build, no docker run, no
# daemon needed. Sets HUU_DEV_NATIVE=1, the ONE env that still skips the
# re-exec gate; the CLI prints a loud banner because container isolation and
# the container memory ceiling are both OFF. Contributor loop only.
npm run dev

# Same hot reload, but through Docker — the faithful rehearsal of what a user
# gets (refreshes the huu:local image first, see below).
npm run dev:docker

# Run the CLI. ALWAYS refreshes the huu:local Docker image from the current
# source first (scripts/ensure-image.sh; layer-cached, ~2s when nothing
# changed) — huu is docker-only, so without the rebuild the container would
# run whatever the LAST build baked (the stale-image trap). An explicit
# HUU_IMAGE=<other> skips the rebuild (deliberate pin).
npm start

# Compile for production
npm run build

# Run tests
npm test

# Type-check only
npm run typecheck
```

## Agent Skills

Every task in this repo routes through the skill system under
`.agents/skills/` (source of truth, mirrored into `.claude/skills/` via
per-skill symlinks — regenerate with
`.agents/skills/project-router/scripts/sync-skill-links.sh`).

Start at **`project-router`**: it classifies the task, assembles the skill
chain from `.agents/skills/catalog.md` (the canonical routing index), loads
the knowledge BEFORE implementation, and guarantees each task skill runs its
`<evolution>` step at the end — learnings land in per-skill `LEARNINGS.md`
(probation) and are promoted into skill bodies only by
`meta-skill-consolidate`, always as uncommitted diffs for human review.

The catalog is canonical — consult it, not this paragraph, for the current list.

## Document precedence (which source wins)

When two normative sources contradict each other, the source that **owns the
subject domain** wins. Precedence, by domain:

```
identidade / o que o huu é e não é ......... MANIFESTO.md         (vence sempre)
método / como se desenvolve aqui ........... METODO.md
recursos / RAM, PSI, cgroup, admissão ...... ROADMAP.md
fatos correntes do código .................. AGENTS.md → skill do domínio
"como fazer X" ............................. .agents/skills/<dominio>/SKILL.md
tutorial / referência de usuário ........... docs/**
```

**Conflict rule:** the domain owner wins. Any source that disagrees with the
owner must **cite and explicitly override** (e.g. "supero MANIFESTO
§diferencial-2 no que diverge"), with date. A document that contradicts the
owner without declaring override is a documentation bug — `METODO.md §0.4`
defines this as enforceable by machine in a future wave.

## Architecture (summary)

```
[host]   cli.tsx top-level → decideReexec → reexecInDocker
                ↓ (when not in container, not --help, not init-docker/status)
         docker run --cidfile … ghcr.io/…/huu:latest
                ↓
[container]  cli.tsx → web/serve.ts (DEFAULT front-end) | app.tsx (TUI, via --cli)
                ↓
              web/ (node:http + SSE server + vanilla-JS browser client)
              ui/components/ (Ink React views — the --cli TUI)
                ↓ (both front-ends can host N concurrent runs via the
                  GlobalScheduler — see the working-on-orchestrator skill)
              orchestrator/ (worker pool, stage lifecycle, merge;
                global-scheduler.ts multiplexes N runs)
                ↓
              orchestrator/backends/ (HOW an agent is executed — the dispatch
                kind, never the vendor:
                jcode/   — the only user-facing backend; spawns the `jcode`
                           CLI as a subprocess (prompt in argv, provider
                           profile from a hermetic config.toml huu writes,
                           credential injected as an env var)
                stub/    — no-LLM mock for smoke tests
                _shared/ — message building + spawn lifecycle helpers
                registry.ts — single dispatch from kind → factory;
                           AgentBackendKind = 'jcode' | 'stub')
                ↓
              git/ (worktree manager, branch ops, preflight, merge)
                ↓
              lib/ (types, providers (LlmProvider + the provider table),
                    pipeline-io, file-scanner, run-id, status,
                    init-docker, docker-reexec, active-run-sentinel,
                    api-key, api-key-registry, prune, debug-logger,
                    run-logger, repo-lock,
                    run-many (headless multi-run driver),
                    screen-fsm, assistant-check-feasibility,
                    i18n/ — en + pt-BR catalogs behind a `t()` that THROWS on a
                    key missing from any locale; every entrypoint calls
                    `initI18n()`, the browser gets the same catalog over
                    `GET /api/i18n`. See docs/i18n.md)
```

Dependencies flow **downward only** — lower layers never import upper layers.

### Backend × provider — two axes, never one

Confusing these two is what made an OpenRouter run demand `DEEPSEEK_API_KEY`.
They are orthogonal:

- **Backend = *how* an agent is executed.** `AgentBackendKind = 'jcode' | 'stub'`
  (`src/orchestrator/backends/registry.ts`). `jcode` spawns the `jcode` CLI as a
  subprocess; `stub` calls no model at all. There is no `pi` and no `azure`.
- **Provider = *where* the call goes and *which credential it spends*.**
  `LlmProvider = 'deepseek' | 'openrouter'` (`src/lib/providers.ts`). Each entry
  in `PROVIDERS` carries its `defaultBaseUrl`, its `apiKeySpecName` and — for a
  single-vendor endpoint — its `modelNamespace`, which `modelIdForProvider()`
  uses to render huu's OpenRouter-shaped catalog id the way that endpoint names
  models (only the provider's OWN prefix is ever stripped).

**One backend serves N providers**: `jcode` serves both. A backend therefore
cannot name the credential a run will spend — the `apiKeySpecName` of
`selectBackend('jcode')` is `undefined` on purpose, and the authority is
`apiKeySpecNameForProvider(provider)`. In `src/lib/api-key-registry.ts` the
binding axis is `providerBound?: LlmProvider`: a spec bound to the ACTIVE
provider is enforced regardless of its `required` flag, so a run asks for
exactly the one key it is about to spend.

The user's choice travels as `AppConfig.provider` through the TUI, the CLI and
the web server down to the spawn, where it selects three things at once
(`src/orchestrator/backends/jcode/factory.ts`, `buildJcodeArgs`): the
`--provider-profile` block, the `--model` namespace, and the env var the key
lands in — and every OTHER provider's key is stripped from the child env. The
hermetic `config.toml` (`backends/jcode/hermetic.ts`) is GENERATED from the
provider table, one `[providers.<profile>]` block per provider, and never
contains a credential — only the `api_key_env` name.

### Visual conventions

- Color tokens are centralized in `src/ui/theme.ts`.
- `theme.ai` (magenta) is reserved for AI-driven UI: Smart Select on the file picker, Pipeline Assistant, Project Recon, agent logs.
- Non-AI components must not introduce magenta. Use `theme.info` (blue) or `cyanBright` for purple-ish needs.
- See README "Visual conventions" for the user-facing summary.

## Commit Rules

- Run `npm run typecheck && npm test` before every commit. To harden it
  locally, enable the pre-push hook: `git config core.hooksPath .githooks`.
- **CI runs the same gate.** `.github/workflows/gate.yml` executes
  `scripts/gate.sh` on every push and pull request — typecheck · test ·
  validate-skills · check-acceptance · smoke-defaults · validate-graph ·
  check-pins · check-twins · check-metodo · check-dockerfile (the last one
  refuses BuildKit-only Dockerfile syntax — huu is docker-only, so the image
  must build on a Docker with no buildx plugin). Run `bash scripts/gate.sh` to
  reproduce it exactly; `bash scripts/gate.sh --list-from-ci` prints what CI
  runs, so the two lists cannot drift silently. CI is a backstop, not a
  substitute: it reports only after you push.
- Prefer Conventional Commits.
- Never force-push to main.

## Release procedure

See `.agents/skills/releasing-versions/SKILL.md` for the full step-by-step.
Quick reference: bump version + CHANGELOG → validate locally → tag + push.
The GHCR multi-arch publish is optional; `scripts/deploy.ts` is the canonical
interactive flow.

## References (load on demand)

- Skill catalog (canonical): `.agents/skills/catalog.md` — router: `project-router`
- Human overview of the skill system: `agent-skills.md`

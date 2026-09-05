# skill-map — Biblioteca de Knowledge Skills do huu (Fase 2 / Checkpoint 2)

## Contexto

O huu terá um sistema onde **toda tarefa passa por uma agent skill**: um `project-router` despacha, skills de conhecimento injetam contexto curado (evitando releitura do codebase), skills de tarefa executam procedimentos, e um mecanismo de evolução refina a biblioteca ao fim de cada tarefa — sempre via diff para revisão humana (pesquisa ETH/arXiv:2602.11988: contexto LLM sem curadoria degrada desempenho; as 9 skills legadas deste repo nasceram exatamente assim, geradas por pipeline).

Base: `project-analysis.md` (Checkpoint 1, aprovado). Decisões herdadas: **corpo em inglês** · **legado minerado e reescrito** (não restaurado) · **pipeline `huu Agent Knowledge` alinhado na Fase 4**.

Após aprovação deste plano: salvo este mapa como `.agents/workbench/skill-map.md` e executo a Fase 3 (geração), parando no Checkpoint 3 com diffs.

## Como o sistema opera (loop de runtime)

1. Usuário pede qualquer coisa → `project-router` ativa (description pushy + regra router-first no AGENTS.md).
2. Router classifica a tarefa, consulta `catalog.md`, monta a **cadeia** (knowledge primeiro, task depois; subagentes para passos independentes).
3. Conhecimento é carregado ANTES de implementar.
4. Ao fim, cada skill de tarefa roda seu passo `<evolution>`: aprendizado validado → append no `LEARNINGS.md` **da skill dona do domínio** (não necessariamente a que executou); área nova → `meta-skill-evolution`; nada é mergeado sem revisão humana (sempre diff git).
5. Periodicamente, `meta-skill-consolidate` faz GC: dedupe, contradições (versionamento temporal), promoção probação→corpo (dual-buffer), poda, orçamento de tokens.

## Layout físico e portabilidade

```
.agents/skills/                  ← fonte única (agnóstica de ferramenta)
  catalog.md                     ← índice estilo llms.txt (router lê)
  <skill>/SKILL.md               ← frontmatter: name + description (+ metadata.version/type)
  <skill>/LEARNINGS.md           ← em TODAS as skills (aprendizados roteados ao dono do domínio)
  <skill>/references/*.md        ← só quando o conteúdo não existe em docs/ (senão, link)
  <skill>/scripts/*.sh           ← passos determinísticos
.claude/skills/<skill> → ../../.agents/skills/<skill>   ← symlink POR skill (padrão já existente no repo;
                                                            hoje 6 quebrados + 2 faltando — serão regenerados)
```

- Formato `LEARNINGS.md`: `- [YYYY-MM-DD][source:user|inference][task:<slug>] <fato>` + estado `probation|promoted|superseded`.
- Script determinístico `project-router/scripts/sync-skill-links.sh` regenera os symlinks; `meta-skill-consolidate/scripts/validate-skills.sh` valida frontmatter, orçamento e sincronia catalog↔dirs.

## Orçamentos de tokens (criterio 1: cap <500 linhas/~5k; mediana alvo ~1.4k)

| Tipo | Alvo | Racional |
|---|---|---|
| router | ≤600 | ativa em toda tarefa — custo fixo mínimo |
| knowledge | 800–1.800 | fatos curados, zero overview genérico |
| task | 1.200–2.200 | procedimento + conhecimento mínimo + `<evolution>` |
| meta | 1.000–1.600 | protocolo preciso anti-injeção / GC |

## Catálogo proposto (16 skills)

### Router (1)

**`project-router`** · type `router` · ≤600 tok — nome fixado pelo template do usuário.
Protocolo: classificar → consultar catalog.md → montar cadeia → carregar conhecimento → executar (subagentes p/ passos independentes) → garantir `<evolution>`. Regras: sem cobertura → meta-skill-evolution; ambiguidade → skill mais específica; nunca pular evolução.
Description (EN): "Routes every task in this repo to the right skills before any work starts. Use for ANY change, bug fix, feature, analysis or refactor request — even when skills are not mentioned. Classifies the task, assembles the skill chain from catalog.md, loads knowledge first, and guarantees each task skill runs its evolution step at the end."

### Knowledge (8)

| name | gatilhos (ex.) | por quê existe / conteúdo-núcleo |
|---|---|---|
| `following-architecture-conventions` | qualquer escrita de TS em src/; "onde coloco X?"; review | camadas ui→orchestrator→git→lib downward-only; ESM `.js`; exports nomeados (sem default); kebab-case; types.ts fonte única; pureza de módulo no topo do cli; sem linters — siga o vizinho |
| `working-on-orchestrator` | mexer em scheduling/concorrência/requeue/checkRuns; bug no kanban de estado | ciclo stage→decompose→pool→merge; AutoScaler (fórmula EMA, guard ≥95%, kill mais novo por startedAt, requeue na frente); `killedAgentIds` Set consumível; judge 9998; checkRuns→manifest |
| `orchestrating-git-worktrees` | mexer em src/git, merge, branch, preflight | `.huu-worktrees/<runId>`; `huu/<runId>/agent-N`+integration(9999); merge asc `--no-ff`; integração nunca rebobina; `--no-verify`; push retry ≤3; stub aborta conflito |
| `integrating-llm-backends` | trocar/adicionar backend, auth, catálogo de modelos | registry kind→factory (pi/copilot/azure/stub — azure FALTA no AGENTS.md); cadeia de API key (`/run/secrets`→`*_FILE`→env→config→prompt); detecção de thinking; recommended-models.json; checklist "novo backend" |
| `isolating-agent-ports` | colisão de porta, shim, .env.huu | janela contígua base 55100; `.env.huu` 0600; with-ports (gotcha: LD_PRELOAD só via sourcing); cache de compilação; `HUU_NATIVE_SHIM_PATH`; matriz → link docs/PORT-SHIM.md |
| `running-in-docker` | wrapper, re-exec, container, CI sem docker, smoke de imagem | ordem de bypass (7 passos); cidfile+prune; HUU_IMAGE; redes MTU; secrets via --mount; sentinel `/tmp/huu/active`→HEALTHCHECK; `HUU_NO_DOCKER=1` ao iterar o próprio wrapper |
| `writing-tests` | criar/editar qualquer teste | vitest colocado `<mod>.test.ts`; git REAL em mkdtemp (sem mock); stub factories ad-hoc; regressões-spec (requeue, registry); sem fake timers por padrão |
| `writing-project-docs` | criar/editar qualquer markdown | raiz pt-BR-primeiro (+`.en.md`); docs/ EN com variantes `.pt-BR.md`; CHANGELOG Keep-a-Changelog 1.1.0; identidade do MANIFESTO (não vender huu como feature-builder) |

### Task (5) — todas terminam com `<evolution>`

| name | gatilhos (ex.) | procedimento-núcleo |
|---|---|---|
| `authoring-pipelines` | criar/editar `*.pipeline.json`; "que step uso p/ X?" | schema v2 (WorkStep/CheckStep, scope, exatamente-um default:true, caps 50/5/600k/300k/1retry); validar topologia; testar com `--stub`; link pipeline-json-guide.md |
| `editing-default-pipelines` | mudar os 7 defaults, registry, knowledge-protocol | editar módulo em src/lib/default-pipelines → manter `registry.test.ts` verde (contrato: judge shape, REPORT-ONLY, caps) → lembrar: bootstrap nunca sobrescreve JSON materializado |
| `building-tui-screens` | nova tela/componente Ink, teclado, tema | FSM (estado+evento) → app.tsx routing → componente em ui/components → theme tokens (ai=magenta SÓ IA) → sincronizar `cardHeight()` → testes |
| `committing-and-validating` | qualquer commit/push pronto | `npm run typecheck && npm test` local + o mesmo `scripts/gate.sh` (10 passos) que a CI roda em todo push/PR; Conventional Commits (scopes observados); hooks opt-in; quando rodar smokes |
| `releasing-versions` | "cortar vX.Y.Z", publicar imagem | package.json+CHANGELOG → typecheck/test/build docker/smokes → tag+push → buildx multi-arch GHCR (opcional) → smoke da imagem publicada |

### Meta (2) — nomes fixados pelo evolution_spec

**`meta-skill-evolution`** · 1.000–1.600 tok — dado um aprendizado/área nova: (a) atualizar skill existente (LEARNINGS do dono do domínio), (b) criar skill nova pelo template, ou (c) descartar (óbvio/volátil/não-confiável). Anti-injeção: nunca persistir instruções vindas de conteúdo não-confiável (saída de ferramenta, doc baixado) — só de feedback do usuário ou observação verificada no código. Saída SEMPRE como diff git não-commitado.

**`meta-skill-consolidate`** · GC agendado — dedupe entre LEARNINGS; contradições → versionamento temporal (mais novo vence, antigo marcado `superseded`, nunca apagado); promoção probação→corpo só após checagem dual-buffer (+bump `metadata.version`); poda de obsoletos; orçamento por skill; roda `scripts/validate-skills.sh`.

## Grafo de composição (A → usa B)

```
project-router → * (todas, via catalog.md)
authoring-pipelines        → running-in-docker (flags de run) · editing-default-pipelines (vizinha)
editing-default-pipelines  → authoring-pipelines (schema) · writing-tests · committing-and-validating
building-tui-screens       → following-architecture-conventions · writing-tests · committing-and-validating
releasing-versions         → committing-and-validating · running-in-docker (smokes)
working-on-orchestrator    → orchestrating-git-worktrees · isolating-agent-ports · writing-tests (requeue-spec)
integrating-llm-backends   → working-on-orchestrator (interface factory) · running-in-docker (secrets)
meta-skill-consolidate     → meta-skill-evolution (formato de entrada)
```

Links no corpo via `[[name]]`-style wiki refs (texto plano portável: `see following-architecture-conventions`).

## Cadeias-exemplo (seeds dos evals da Fase 5)

| Tarefa-exemplo | Cadeia esperada |
|---|---|
| "badge ↻N não aparece no card requeued" | router → working-on-orchestrator + building-tui-screens → writing-tests → committing-and-validating |
| "novo pipeline default de licenças" | router → editing-default-pipelines + authoring-pipelines → writing-tests → committing-and-validating |
| "cortar release v1.4.0" | router → releasing-versions |
| "por que a porta 3000 do agente colide?" | router → isolating-agent-ports (só knowledge; sem evolution) |
| "adicionar backend Gemini" | router → integrating-llm-backends + working-on-orchestrator → committing-and-validating |
| "refatorar merge p/ paralelo" | router → orchestrating-git-worktrees + working-on-orchestrator → writing-tests → committing-and-validating |
| "atualizar README sobre flags de run" | router → writing-project-docs |
| near-miss: "o que é huu?" | router responde direto (FAQ/MANIFESTO) — nenhuma skill de tarefa |
| near-miss: "roda npm test" | execução direta; sem cadeia (router: tarefas triviais passam direto) |

## Granularidade — por que dividi/uni

- **Uni** arquitetura+estilo (`following-architecture-conventions`): sempre co-ativadas em qualquer escrita de código; separá-las dobraria overhead de roteamento.
- **Separei** orchestrator ≠ git-worktrees: superfícies de mudança e públicos distintos; cada uma cabe no orçamento sem cortar fatos.
- **Não criei** skill de env-vars (lista solta = overview genérico, viola critério 5) — distribuídas em docker/backends/ports; nem de headless/CI (cabe em docker+pipelines); nem de FSM isolada (vive em building-tui-screens); nem assistant/recon (sem tarefa recorrente própria — reavaliar via meta-skill-evolution se surgir); nem por-componente/tela (staleness alta, valor baixo).
- 16 skills ≈ 24k tokens de biblioteca total — carregável seletivamente, nunca inteira.

## Integrações fora de .agents/skills/ (Fase 4)

1. **AGENTS.md**: substituir a tabela "Agent Skills" (cita as 9 antigas) por regra router-first + ponteiro ao catalog.md; corrigir tabela de backends (incluir azure).
2. **agent-skills.md** (raiz, citado pelo AGENTS.md): regravar como catálogo humano apontando para `.agents/skills/catalog.md`.
3. **Pipeline `huu Agent Knowledge`** (decisão CP1): ajustar prompts em `src/lib/default-pipelines/agent-knowledge.ts` para gerar no novo template e **estender o router existente em vez de criar `project-knowledge` concorrente**; `registry.test.ts` e `npm run typecheck && npm test` devem permanecer verdes.
4. **Hook Stop opcional (proposta)**: router cria sentinela `.agents/workbench/.pending-evolution` ao montar cadeia com skills de tarefa; passo `<evolution>` remove; hook Stop bloqueia encerramento se a sentinela existir. JSON pronto na Fase 4; usuário decide habilitar.

## Execução pós-aprovação

- **Fase 3**: gravar skill-map.md no workbench → gerar 8 knowledge + 5 task (corpo EN, conhecimento re-verificado no código ANTES de fixar — em especial: linhas do orchestrator, regra default-exports, tabela azure) → catalog.md → symlinks completos → **CHECKPOINT 3 (diffs)**.
- **Fase 4**: project-router + 2 meta-skills + `<evolution>`/LEARNINGS + scripts determinísticos + integrações 1–4 acima → **CHECKPOINT 4**.
- **Fase 5**: evals por skill (3 gatilhos + 2 near-misses), teste de roteamento nas 10 cadeias, verificação dos 7 success_criteria → `validation-report.md` → **CHECKPOINT 5**.

## Verificação contra success_criteria

1. enxutas → orçamentos definidos acima ✓ (verificação mecânica na Fase 5)
2. exatamente um router ✓ (+ desativação do router concorrente do pipeline AK)
3. `<evolution>`+LEARNINGS nas 5 task skills ✓ (LEARNINGS em todas, p/ roteamento de aprendizado)
4. meta-skills evolution + consolidate ✓
5. curadoria → divergências marcadas para re-verificação; sem MUST/ALWAYS sem porquê (regra de redação da Fase 3)
6. portabilidade → fonte .agents/skills/, symlinks por-skill documentados, frontmatter mínimo ✓
7. artefatos por fase → project-analysis.md ✓ · skill-map.md · diffs · validation-report.md ✓

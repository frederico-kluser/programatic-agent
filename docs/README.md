# Documentação do `huu`

Índice central da documentação. O `huu` é uma CLI/TUI (TypeScript + React/Ink)
que roda pipelines de agentes LLM em git worktrees isolados, com merge
determinístico ao fim de cada estágio.

> Voltar ao [README](../README.md) · [English README](../README.en.md)

## Por onde começar

| Quero… | Leia |
|---|---|
| Instalar e rodar pela primeira vez | [Onboarding](onboarding.pt-BR.md) · [EN](onboarding.md) |
| Operar no dia a dia (Docker, env vars, FAQ, roadmap) | [Operações](operations.pt-BR.md) · [EN](operations.md) |
| Escrever meu próprio pipeline JSON | [Guia do schema](pipeline-json-guide.md) |
| Fazer uma etapa descobrir os arquivos da próxima (scope `memory`) | [Scope memory](memory-scope.pt-BR.md) · [EN](memory-scope.md) |
| Desenvolver com enxame de frentes paralelas a partir de um objetivo | [Modo de desenvolvimento](dev-mode.pt-BR.md) · [EN](dev-mode.md) |
| Desenhar eu mesmo o método (nós, ramos e retrabalho) em vez de deixar o planner decidir | [Método desenhado](dev-graph.pt-BR.md) · [EN](dev-graph.md) |
| Entender por que um run falhou (sintoma → causa → ação) | [Troubleshooting](troubleshooting.pt-BR.md) · [EN](troubleshooting.md) |
| Rodar auditorias na esteira (GitHub Actions / GitLab) | [CI](ci.pt-BR.md) · [EN](ci.md) |
| Trocar o idioma da interface (en / pt-BR) e adicionar traduções | [i18n](i18n.pt-BR.md) · [EN](i18n.md) |

## Referência

| Tópico | Doc |
|---|---|
| Arquitetura em camadas e regras de import | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Schema JSON do pipeline (referência completa) | [pipeline-json-guide.md](pipeline-json-guide.md) |
| Scope `memory` — fan-out dirigido por arquivo de memória (`huu-memory-v1`, `$hint`) | [memory-scope.md](memory-scope.md) · [pt-BR](memory-scope.pt-BR.md) |
| Playbook de prompting cross-LLM aplicado aos prompts de step | [prompting-playbook.md](prompting-playbook.md) · [pt-BR](prompting-playbook.pt-BR.md) |
| Troubleshooting — todos os modos de falha com ação corretiva | [troubleshooting.md](troubleshooting.md) · [pt-BR](troubleshooting.pt-BR.md) |
| CI via Docker (`huu auto`, `HUU_IMAGE`, receitas prontas) | [ci.md](ci.md) · [pt-BR](ci.pt-BR.md) |
| Backend `jcode` — instalar o binário, configurar o provedor, variáveis de ambiente | [jcode-setup-guide.md](jcode-setup-guide.md) |
| Isolamento de portas (shim de `bind()`, internals) | [PORT-SHIM.md](PORT-SHIM.md) |
| Referência de teclado da TUI | [KEYBOARD.md](KEYBOARD.md) |
| Internacionalização — `HUU_LANG`, catálogos e a guarda de tradução faltando | [i18n.md](i18n.md) · [pt-BR](i18n.pt-BR.md) |
| Auditoria do harness do modo DEV — estado da arte × nossos defeitos | [dev-harness-audit.md](dev-harness-audit.md) |

> **Backend ≠ provedor.** O *backend* é **como** um agente roda —
> `AgentBackendKind = 'jcode' | 'stub'`
> (`src/orchestrator/backends/registry.ts`). O *provedor* é **para onde** a
> chamada vai e **qual credencial** ela gasta —
> `LlmProvider = 'deepseek' | 'openrouter'` (`src/lib/providers.ts`). Um
> backend serve N provedores: o `jcode` serve os dois. Os backends `pi` e
> `azure` foram removidos; [`pi-coding-agent.md`](pi-coding-agent.md) e
> [`azure-backend.md`](azure-backend.md) sobrevivem apenas como marcadores
> históricos.

## Outros recursos

- [CHANGELOG](../CHANGELOG.md) — histórico de versões (Keep a Changelog).
- [`.agents/skills/catalog.md`](../.agents/skills/catalog.md) — o sistema de
  skills que roteia toda tarefa neste repo (comece pela `project-router`;
  17 skills: router, conhecimento, tarefa e meta). Visão humana em
  [`agent-skills.md`](../agent-skills.md).
- [`CLAUDE.md`](../CLAUDE.md) / [`AGENTS.md`](../AGENTS.md) — instruções para
  agentes de IA que trabalham neste repositório.

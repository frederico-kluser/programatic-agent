# Backend Azure AI Foundry — REMOVIDO (registro historico)

> **Este backend nao existe mais.** O commit `2ce2bc6` removeu
> `src/orchestrator/backends/azure/` junto com o backend `pi`. Hoje
> `src/orchestrator/backends/registry.ts:18` declara
> `type AgentBackendKind = 'jcode' | 'stub'`, e `src/lib/llm-client-factory.ts`
> roteia **todo** helper LangChain para um unico endpoint
> (`https://api.deepseek.com/v1`). Nao ha mais `--provider=azure`.
>
> O arquivo permanece como **marcador** (documentos vivos ainda apontam para
> ele) e porque a auditoria que ele descrevia deixou uma licao que continua
> valendo. Conteudo original: `git log --follow -p -- docs/azure-backend.md`.

## A licao que sobrevive ao backend: vazamento de cobranca

A auditoria original encontrou **quatro features auxiliares da TUI** que
instanciavam `ChatOpenAI` com `baseURL` fixo em `https://openrouter.ai/api/v1`,
independentemente do backend que o usuario tinha escolhido: Pipeline Assistant,
Smart File Select, Project Recon e Check Feasibility. Com `--backend=azure`
selecionado, cada uso dessas features **cobrava na conta OpenRouter**.

A regra, enunciada de forma independente do backend:

> **Uma chamada LLM auxiliar que usa um provedor diferente do que o usuario
> selecionou e um bug de cobranca** — mesmo que funcione, mesmo que seja barata,
> mesmo que seja "so um helper".

A correcao estrutural foi criar **uma fabrica central**
(`src/lib/llm-client-factory.ts`, `buildChatClient(ctx, opts)`) e plumbar um
`LlmClientContext` por todo caminho que pode disparar um helper, em vez de
deixar cada call site escolher seu proprio endpoint. Esse seam continua sendo o
mecanismo hoje: os seis call sites (`assistant-client.ts`,
`assistant-architect.ts`, `assistant-check-feasibility.ts`,
`llm-suggest-files.ts`, `recon-selector.ts`, `project-recon.ts`) mais o planner
do dev mode (`dev-mode/planner.ts`) passam todos por `buildChatClient`.

Onde a regra volta a morder: **roteamento por papel** (`DevModelPolicy` —
planner/recon/worker/critic/reporter/judge/integration). Um papel roteado para
um id de modelo que o provedor selecionado nao serve nao e apenas um erro de
configuracao — e a mesma classe de bug, com a mesma consequencia. Ao alargar o
roteamento, verifique o par (papel → provedor), nunca so (papel → id).

Ponto de atencao correlato, ainda no codigo: `src/lib/transcribe.ts` fala
direto com `https://openrouter.ai/api/v1/chat/completions` (transcricao de audio
do campo de goal do dev mode). E o unico caminho que ainda sai para outro
provedor; se ele passar a ser cobrado no fluxo padrao, cai exatamente nesta
regra.

## Para onde ir agora

| Se voce procurava…                            | Leia                                           |
|-----------------------------------------------|------------------------------------------------|
| O backend real e como configura-lo            | [`jcode-setup-guide.md`](jcode-setup-guide.md) |
| A cadeia de resolucao de credencial           | `src/lib/api-key.ts` · `src/lib/api-key-registry.ts` |
| Como adicionar/depurar um backend ou provedor | `.agents/skills/integrating-llm-backends/SKILL.md` |

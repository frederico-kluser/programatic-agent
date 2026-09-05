# Onboarding · `huu`

> **English:** [docs/onboarding.md](onboarding.md)

Este é o tutorial longo do `huu`. O [README](../README.md) é o pitch e
um gostinho rápido — aqui é o passo-a-passo.

O huu desenha pipelines que fazem agentes que pensam seguirem um
processo determinístico — feito pra auditorias, geração de testes,
extração de conhecimento e qualquer processo em esteira com
previsibilidade real de valor, não pra desenvolver features novas.

## Sumário

- [Instalação](#instalação)
- [Primeira execução: smoke com `--stub`](#primeira-execução-smoke-com---stub)
- [Primeira execução real: Pi / OpenRouter](#primeira-execução-real-pi--openrouter)
- [Mesma execução com GitHub Copilot](#mesma-execução-com-github-copilot)
- [Quando usar / quando NÃO usar](#quando-usar--quando-não-usar)
- [huu vs alternativas](#huu-vs-alternativas)
- [Exemplo passo-a-passo: huu Test Suite](#exemplo-passo-a-passo)
- [Escrevendo seu próprio pipeline](#escrevendo-seu-próprio-pipeline)
  - [O editor TUI](#o-editor-tui)
  - [Pipeline Assistant (`A` na welcome)](#pipeline-assistant)
  - [Pipelines salvos (`S` na welcome)](#pipelines-salvos)
- [Modo headless (`huu auto`)](#modo-headless)
- [Backends a fundo (Pi · Copilot · Stub)](#backends-a-fundo)
- [Pipelines default empacotados](#pipelines-default-empacotados)
- [Pipelines como artefato compartilhável](#pipelines-como-artefato-compartilhável)
- [Filosofia](#filosofia)

---

## Instalação

`huu` roda em Docker por padrão — suas credenciais de shell, `~/.ssh` e
`~/.aws` nunca ficam visíveis pro agente LLM. Dois caminhos de instalação:

### Docker (recomendado)

```bash
git clone https://github.com/frederico-kluser/huu
cd huu
docker build -t huu:local .
HUU_IMAGE=huu:local huu run pipeline.json
```

Imagens pré-buildadas são publicadas manualmente pelo maintainer em
`ghcr.io/frederico-kluser/huu:<version>` — a CI roda o gate de testes, mas
não publica nada. Se uma tag está disponível, o wrapper puxa
automaticamente:

```bash
export OPENROUTER_API_KEY=sk-or-...
huu run pipelines/huu-test-suite.pipeline.json     # usa ghcr.io/frederico-kluser/huu:latest
```

> O huu materializa os pipelines default empacotados em `./pipelines/` no
> primeiro launch — escolha um na tela de boas-vindas ou passe o caminho.

**Pré-requisitos:**

| SO | Instalar |
|---|---|
| Linux | `sudo apt install docker.io docker-compose-v2` (ou equivalente da sua distro — veja [docker.com/engine/install](https://docs.docker.com/engine/install/)) |
| macOS | [OrbStack](https://orbstack.dev/) (recomendado, ~2× mais rápido em bind mounts que o Docker Desktop) ou [Docker Desktop](https://www.docker.com/products/docker-desktop/) |
| Windows | [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install) + [Docker Desktop](https://www.docker.com/products/docker-desktop/) com integração WSL ativada |

> **Usuários Windows:** clone seu repo dentro do filesystem WSL
> (`/home/...`) — não em `/mnt/c/...` — pra ter performance nativa. Bind
> mounts que cruzam a fronteira Windows/WSL são 10–20× mais lentos pro
> I/O de muitos arquivos pequenos que o `git worktree add` faz.

### Docker por padrão, nativo como opt-in

```bash
npm install -g huu-pipe        # Node 20+, um `git` funcional e Docker
huu                            # re-executa sozinho no container
```

O huu roda no container **por padrão**, que carrega o teto de memória
do kernel e isola as credenciais do seu shell do agente. `--yolo` /
`--no-docker` / `HUU_NO_DOCKER=1` pulam o container de propósito — pra
alvos que já rodam seu próprio Docker, onde aninhar containers é o
problema — e custam exatamente essas duas garantias; o huu avisa em uma
linha em toda execução assim. `--docker` é o espelho: força o container
nessa execução mesmo com um runtime `native` salvo. No primeiro `npm
start`, `huu setup` pergunta qual runtime (e qual interface) você quer
e salva em `~/.config/huu/config.json` — reabra a pergunta a qualquer
hora com `huu setup`. Precedência: **flag > env > config salva >
default**. Só `--help` e os utilitários de host (`init-docker`,
`status`, `prune`) rodam fora do container independente do runtime. O
CI precisa de um runner docker-enabled pra usar o padrão — veja
[`docs/ci.pt-BR.md`](ci.pt-BR.md) pras receitas de GitHub Actions /
GitLab.

Mais sobre modos de execução Docker (compose, isolated-volume, secrets,
VPN/MTU): [`docs/operations.pt-BR.md#docker`](operations.pt-BR.md#docker).

---

## Primeira execução: smoke com `--stub`

O agente stub roda o fluxo todo sem invocar nenhum LLM. Use pra checar
que sua instalação funciona, que os worktrees montam e que seu repo está
num estado em que o `huu` consegue rodar.

```bash
huu --stub
```

Você vai ver a tela de boas-vindas. Pressione `N` pra criar um pipeline
novo, preencha steps triviais, e rode. Cada "agente" escreve um arquivo
`STUB_*.md` no seu worktree e o orchestrator mescla todos. Zero tokens
gastos.

---

## Primeira execução real: Pi / OpenRouter

```bash
export OPENROUTER_API_KEY=sk-or-...
huu run pipelines/huu-test-suite.pipeline.json
```

O huu traz **sete pipelines empacotados** e os materializa em
`./pipelines/` no primeiro launch. O default — destacado na tela de
boas-vindas — é o **huu Test Suite**: ele seleciona sozinho os arquivos
mais dignos de teste e escreve uma suíte de testes unitários pra eles.
Escolha qualquer pipeline na tela de boas-vindas (ou passe o caminho, como
acima). Um pipeline mínimo seu é só uma lista de steps com um token
`$file`, por exemplo:

```json
{
  "_format": "huu-pipeline-v2",
  "pipeline": {
    "name": "padronizar-headers",
    "steps": [
      {
        "name": "Padronizar headers",
        "prompt": "Adicione um cabeçalho JSDoc no topo de $file com @author huu.",
        "files": ["src/cli.tsx", "src/app.tsx"],
        "scope": "per-file"
      }
    ]
  }
}
```

O que você vai ver numa execução real:

1. O **seletor de backend** (Pi / Copilot — pulado quando você passa
   `--backend=`, `--copilot` ou `--stub` no CLI).
2. O picker de modelos (catálogo do OpenRouter ou Copilot, com seus
   recentes fixados no topo e métricas ao vivo do Artificial Analysis
   quando `ARTIFICIAL_ANALYSIS_API_KEY` está setado).
3. Um kanban ao vivo com um cartão por agente — fase, tokens, custo,
   arquivo atual. O auto-scaling memória-aware é o padrão; `+`/`-`
   pinam concorrência manual e `A` religa o auto-scale a qualquer
   momento.
4. Depois que todos os estágios terminam: uma tela de resumo, mais
   transcrições por agente em `.huu/<runId>-execution-...log`.
5. No disco: um novo branch `huu/<runId>/integration` com o trabalho
   mergeado, mais os branches por agente preservados pra auditoria via
   `git log`.

Se ainda não tem um pipeline, pressione `A` na welcome em vez de `N` —
o [Pipeline Assistant](#pipeline-assistant) roda um reconhecimento
adaptativo do projeto e te guia por ≤8 perguntas pra rascunhar um pra
você.

Os defaults empacotados que caem em `./pipelines/` no primeiro launch:

- **huu Test Suite** — suíte de testes unitários autônoma (o default,
  destacado na tela de boas-vindas).
- **huu Knowledge System** — constrói um sistema de skills/conhecimento a
  partir do repo.
- Cinco auditorias apenas-relatório: **huu Docs Audit**, **huu Quality
  Audit**, **huu Performance Audit**, **huu Refactor Plan**, **huu Security
  Audit**.

Veja [Pipelines default empacotados](#pipelines-default-empacotados) pra a
tabela completa.

---

## Mesma execução com GitHub Copilot

```bash
export COPILOT_GITHUB_TOKEN=ghp_...      # PAT fine-grained, escopo "Copilot Requests"
huu --copilot run pipelines/huu-test-suite.pipeline.json
```

Mesmo pipeline, mesmo orchestrator, mesma lógica de merge — a única
diferença é a factory do agente e o modelo de custo (assinatura em vez
de por-token). O SDK do Copilot é declarado como `optionalDependency`;
se ele estiver ausente em runtime, escolher o backend Copilot produz um
erro claro e o resto do `huu` continua funcionando.

O suporte ao Copilot está atualmente **estabilizando**. Pi / OpenRouter
é o default recomendado.

---

## Quando usar / quando NÃO usar

O problema concreto que o `huu` resolve é mais específico que "tarefas
gerais de código": **aplicar a mesma classe de transformação em N
arquivos independentes, com auditabilidade por arquivo.** Casos
canônicos:

- Escrever testes unitários pra 30 módulos.
- Auditoria de segurança por arquivo (OWASP), relatórios parciais,
  consolidação num estágio final.
- Refatorações de alta repetição: tipar 80 arquivos JS, migrar 40 testes
  Mocha pra Vitest, adicionar JSDoc em 50 funções.
- Plano + execução paralela: estágio 1 escreve um `PLAN.md`, estágio 2
  aplica em N arquivos.

`huu` **não** é a ferramenta certa pra:

- Bugs cuja causa raiz é desconhecida — você precisa de exploração
  interativa primeiro.
- Refatorações arquiteturais que mexem em estado compartilhado
  cross-cutting.
- Trabalho de feature cujo escopo emerge da exploração do código.
- Monorepos com dependências cross-package complexas.
- Trabalho em que você quer que o sistema te surpreenda com soluções.

Pra esses casos, use Claude Code, Cursor, Aider, ou Plandex. `huu` é
deliberadamente o oposto: você sabe o que quer, sabe quais arquivos
tocar, e quer paralelismo + auditabilidade. **Se você ainda não sabe o
que quer fazer, ainda é cedo demais pra usar isso.**

---

## huu vs alternativas

| Família | Abordagem | Use quando |
|---|---|---|
| Claude Code, Cursor, Aider | Conduzido por chat, exploratório | Você ainda não sabe o que fazer. |
| Claude Code `/batch` | Decomposição por LLM com gate de aprovação humana | Você quer tarefas em batch mas confia num LLM pra fatiar. |
| Plandex, Devin, OpenHands | Decomposição por LLM, execução autônoma | Você confia no sistema pra decidir escopo. |
| Conductor, Claude Squad | Workspaces paralelos, merge humano por branch | Você quer paralelismo com revisão humana via PR de cada tarefa. |
| **huu** | **Plano escrito por humano, execução paralela, auditoria git nativa** | **Você sabe o escopo exato e quer um pipeline versionado e reutilizável.** |

A diferença honesta vs `/batch`: o `huu` não vai decidir que o step 3
também deve tocar um arquivo que você não listou. O pipeline é o
contrato — o humano subscreveu.

---

## Exemplo passo-a-passo

### huu Test Suite — passo a passo

`huu Test Suite` é o pipeline default que é materializado na primeira
execução. É a demonstração canônica do porquê misturar scope `project`
e `per-file` importa. Fonte: `src/lib/default-pipelines/huu-test-suite.ts`.

**Step 1 — `Analyze stack and write huu-tests.md`** · scope `project`

Um agente roda no repo inteiro. Detecta a linguagem (Node / Python /
Go / Rust / Java / .NET), verifica que o test runner existe, e escreve
`huu-tests.md` com as convenções de teste a serem seguidas + inicializa
`huu-tests-faq.json`. Esse é o **plano** que todos os passos seguintes
obedecem.

**Step 2 — `Test 3 representative files`** · scope `project`

Um agente escolhe 3 arquivos diversos de lógica de negócio, escreve
testes pra cada um, corrige falhas, e adiciona aprendizados ao
`huu-tests-faq.json`. Output: 3 arquivos de teste funcionando + FAQ
mais rica.

**Step 3 — `Test $file (user-selected)`** · scope `per-file`

Aqui é onde o paralelismo entra em ação. Você seleciona N arquivos
durante a execução; o orchestrator sobe N agentes, cada um recebendo
exatamente **um** arquivo como sua missão via o placeholder `$file`.
Cada agente lê o worktree inteiro pra contexto, segue o `huu-tests.md`,
escreve um teste pro seu arquivo único, recupera de falhas, e adiciona
seus aprendizados ao FAQ compartilhado. Rodam em paralelo e mergeiam
limpo porque possuem arquivos disjuntos.

**Step 4 — `Final cleanup + coverage badge`** · scope `project`

Um agente roda a suíte completa, deleta apenas os **blocos** de teste
com falha (nunca arquivos inteiros), mede cobertura, e atualiza o badge
no README.md.

**Por que é o showcase**

- Step 1 cria um contrato (`huu-tests.md`) que o step 3 obedece, agente
  por agente. A inteligência mora no *plano* — não em cada agente
  re-derivando convenções.
- Step 3 é `per-file`: cada agente tem **uma missão** (um arquivo). O
  prompt é idêntico entre os N agentes — só `$file` é substituído.
  Sem degradação de contexto, sem drift de escopo entre agentes.
- Worktrees mergeiam entre steps. Step 2 não vê os testes do step 3 —
  step 4 vê os dois, mais um FAQ que acumulou aprendizados de todos.

Esse é o template pra tudo o mais: **planeje em `project`, execute em
`per-file`, valide em `project`.**

---

## Escrevendo seu próprio pipeline

Você escreve o pipeline na mão, ou via assistant. De qualquer jeito,
termina com um artefato `huu-pipeline-v1.json` que é portátil e
auditável.

### O editor TUI

Depois que o `huu` abre, pressione `N` na tela de boas-vindas. Teclas:

- `N` — novo work step
- `C` — novo check step (roteamento julgado por LLM)
- `T` — timeouts
- `M` — picker de modelo (override por step)
- `S` — Smart Select pro file picker (magenta — guiado por LLM)
- `↑↓` / `Enter` / `ESC` — nav padrão

Referência completa: [`docs/KEYBOARD.md`](KEYBOARD.md).

O editor salva na memória global automaticamente (veja [Pipelines
salvos](#pipelines-salvos)) e você pode exportar pra um arquivo
`huu-pipeline-v1.json` a qualquer momento.

### Pipeline Assistant

Se preferir descrever o que quer em linguagem natural, pressione `A`
na welcome.

O que acontece, em ordem:

1. **Reconhecimento de projeto adaptativo.** Um LLM seletor leve recebe
   seu intent, um digest compacto do projeto, e um catálogo de missões
   de reconhecimento disponíveis (análise de stack, mapeamento de
   estrutura, auditoria de bibliotecas, varredura de convenções, …).
   Ele escolhe o subconjunto que de fato é relevante (até 10) e pode
   sintetizar missões totalmente customizadas quando o catálogo não
   cobre algum ângulo. As missões selecionadas se ramificam em paralelo
   — cada uma produz até cinco bullets curtos. Os achados são
   agregados e injetados no system prompt do assistant pra que a
   entrevista seja específica do projeto em vez de genérica.
2. **Entrevista.** Você descreve seu intent (`"adicionar JSDoc em todo
   helper sob src/utils"`); o assistant faz no máximo **8 perguntas de
   follow-up**, uma de cada vez, cada uma de múltipla escolha com
   escape pra texto livre.
3. **Draft → editor.** O assistant emite um `PipelineDraft` (validado
   por Zod) convertido num pipeline `huu-pipeline-v1` normal e
   entregue ao editor padrão. Daí em diante é o mesmo fluxo de um
   pipeline escrito à mão.

O assistant usa um modelo barato por padrão (recon usa
`minimax/minimax-m2.7`) pra que o custo de autoria seja limitado — os
modelos pesados ficam reservados pra execução em si.

### Pipelines salvos

Pipelines editados na TUI são persistidos automaticamente num **store
de memória global** em `~/.huu/pipeline-memory.json`. Feche o `huu`,
reabra depois, e continue de onde parou sem reimportar um arquivo JSON.

Da welcome, pressione `S` pra abrir o **Saved Pipelines Manager**:

- **↑↓** pra navegar, **Enter** pra carregar um pipeline no editor.
- **D** pra deletar um pipeline salvo (com confirmação).
- **ESC** pra voltar.

Pipelines são salvos por nome — editar um carregado da memória salva
automaticamente as mudanças. O arquivo de memória é global (não
por-repo).

**Dentro do Docker, saves ainda caem no host.** O wrapper bind-monta o
`~/.huu` do host no container no mesmo path absoluto e seta
`HUU_HOST_HOME=$HOME`, então `~/.huu/pipeline-memory.json` e
`~/.huu/pipelines/` são os mesmos arquivos seja rodando `huu`
nativamente, via o auto-reexec, ou através de
`docker compose -f compose.huu.yaml run --rm huu`. Um pipeline salvo
dentro do container vai estar lá quando você reabrir o `huu` fora dele.

---

## Modo headless

Pra CI, cron, demos, ou qualquer invocação não-interativa:

```bash
huu auto <pipeline.json> --config <config.json>
```

O JSON de config entrega tudo que a TUI interativa normalmente coletaria
— modelo, backend, overrides de arquivo por step, timeouts:

```json
{
  "modelId": "minimax/minimax-m2.7",
  "backend": "pi",
  "files": {
    "3. Test $file (user-selected)": ["src/index.ts"]
  },
  "singleFileCardTimeoutMs": 300000,
  "maxRetries": 1,
  "concurrency": 4
}
```

`files` é um mapa indexado por **`step.name`** (match exato — typos
viram warnings no stderr, não falhas silenciosas). O array mapeado
sobrescreve os `files` daquele step. Steps não mencionados mantêm os
files definidos no pipeline.

Setar `"concurrency": N` **pina o modo manual** em N agentes. Omita pra
ter o auto-scale memória-aware padrão, que adapta a concorrência ao
headroom real de memória (cgroup-aware — respeita o limite do
container); `"autoScale": true` força o auto explicitamente. A guarda
de memória fica sempre ativa em todos os modos. Pra dimensionar em runners
de CI, veja [`docs/ci.pt-BR.md`](ci.pt-BR.md).

A API key resolve pela mesma cadeia da TUI:
`/run/secrets/openrouter_api_key` → store global persistido →
`OPENROUTER_API_KEY_FILE` → `OPENROUTER_API_KEY`. No CI não há key salva,
então `OPENROUTER_API_KEY=sk-or-... huu auto …` simplesmente funciona (a
env var é o fallback); uma key salva pela TUI tem precedência.

### Output

- **stderr** — eventos de progresso em JSON delimitado por linha
  (NDJSON), um por mudança de estado, throttled pra ~250 ms. Pipe
  via `jq -c` pra deixar legível.
- **stdout** — UM objeto JSON final no término:
  `{ ok, runId, integrationBranch, status, totalCost, durationMs, filesModified, agents[] }`.
  Construa pipes em cima: `huu auto … | jq .runId`, ou
  `git show "huu/$(jq -r .runId)/integration:huu-tests.md"` pra
  verificar se o branch de integração entregou o que você esperava.
- **Exit code** — `0` se `manifest.status === 'done'`, `1` caso
  contrário.

Igual ao `huu run …`, `huu auto …` re-exec na imagem do Docker por
padrão — auto-MTU de rede vale, shim de isolamento de portas vale,
mount de secrets vale. (`--yolo` / `--no-docker` ainda pulam o
container quando é isso que você quer, ao custo desse isolamento e do
teto de memória.)

---

## Backends a fundo

`huu` traz três backends de agente plugáveis. A escolha é feita uma
vez por execução — via flag de CLI ou na tela **BackendSelector** da
TUI (mostrada quando nenhuma flag é passada):

| Backend | Flag | SDK | Modelo de custo |
|---|---|---|---|
| **Pi** (padrão) | `--backend=pi` | `@mariozechner/pi-coding-agent` sobre OpenRouter | Pague-por-token (`OPENROUTER_API_KEY`). |
| **GitHub Copilot** | `--backend=copilot` ou `--copilot` | `@github/copilot-sdk` (dep opcional, lazy-loaded) | Assinatura com cota de premium-requests (`COPILOT_GITHUB_TOKEN`). |
| **Stub** | `--backend=stub` ou `--stub` | Mock embutido sem LLM | Grátis — escreve arquivos `STUB_*.md` e emite eventos fake. Pra smoke tests e demos. |

Todos os três compartilham o mesmo orchestrator, ciclo de vida de
worktree e lógica de merge — só o passo "chamar o LLM" muda. Adicionar
um backend futuro (ACP, Claude Code, …) é uma mudança de uma pasta + um
case no registry sob `src/orchestrator/backends/`.

Aliases `--copilot` e `--stub` são atalhos pra `--backend=copilot` e
`--backend=stub`. A forma longa `--backend=<kind>` também aceita aliases
legados: `real` / `openrouter` → `pi`, `gh-copilot` / `github-copilot`
→ `copilot`, `fake` / `mock` → `stub`.

O SDK do Copilot é declarado como `optionalDependency` no
`package.json`. Se estiver ausente em runtime, selecionar o backend
Copilot produz um erro claro — o resto do `huu` continua funcionando.

### Por que o Pi é o padrão

A factory do Pi do `huu` habilita **thinking mode em `medium`** por
padrão pra todo modelo que suporta (veja
`src/orchestrator/backends/pi/factory.ts`). Thinking mode troca
latência por qualidade: o modelo pode rascunhar, criticar e revisar
internamente antes de emitir uma resposta final. Pra trabalho per-file
— o sweet spot do `huu` — esse é o trade-off certo, porque cada agente
tem exatamente uma missão e o custo marginal de "pensar mais" é
pequeno.

O Pi SDK também tem auto-retry embutido (até 5 tentativas em erros
transientes), exposto transparentemente no log da execução. Nenhum
override específico do huu é necessário.

---

## Pipelines default empacotados

Na primeira execução, o huu materializa sete pipelines iniciais
agnósticos de framework dentro de `pipelines/`. Eles são
**idempotentes** — nunca sobrescrevem um arquivo existente, então
editar um preserva suas mudanças entre launches.

| Pipeline | O que faz | Metodologia |
|---|---|---|
| **huu Test Suite** *(destacado)* | Detecta a stack, configura test runner, escreve testes unitários pra 3 arquivos representativos + os arquivos selecionados pelo usuário, depois poda os blocos com falha e adiciona um badge de cobertura no README. | Fundamentos de teste unitário |
| **huu Knowledge System** | Constrói o sistema completo de knowledge skills, totalmente autônomo via scope `memory`: o recon escolhe sozinho os arquivos de estudo (um hint por arquivo), o estudo profundo por arquivo acumula findings em `.huu/knowledge/`, dossiês por tópico viram Agent Skills sob `.agents/skills/` (um agente paralelo por skill) mais meta-skills de evolução e uma superfície de roteamento router-aware (estende um router/`catalog.md` existente, senão cria `project-knowledge`). Um juiz valida as skills e um eval cego de roteamento fecha o run, afiando descriptions no retrabalho. | [Spec Agent Skills](https://agentskills.io/specification) + fan-out [memory-scope](memory-scope.pt-BR.md) |
| **huu Docs Audit** | Classifica cada doc pelo quadrante [Diátaxis](https://diataxis.fr/), pontua o README contra o Awesome-README, sinaliza referências stale, mede cobertura de doc inline de API. | Diátaxis + Awesome-README |
| **huu Quality Audit** | Estilo Sonar: complexidade ciclomática / cognitiva, tamanho de função/arquivo, contagem de parâmetros, profundidade de aninhamento, duplicação, código morto. | [SonarSource](https://www.sonarsource.com/resources/library/cyclomatic-complexity/) + smells do Fowler |
| **huu Performance Audit** | Varredura estática de hotspots (N+1, big-O, I/O sync, sinais de memory leak), Core Web Vitals pra frontends, checklist USE pra backends/CLIs. | [Método USE](https://www.brendangregg.com/usemethod.html) + [Core Web Vitals](https://web.dev/articles/vitals) |
| **huu Refactor Plan** | Baseline de testes de caracterização, catálogo de smells do Fowler por arquivo, ranking top-5 de targets, grafo de dependências estilo Mikado estático, recomendações finais. Só plano — sem reescrita de código. | [Catálogo Fowler](https://refactoring.com/catalog/) + [Método Mikado](https://www.manning.com/books/the-mikado-method) |
| **huu Security Audit** | Varredura de secrets com gitleaks, scan OWASP Top 10:2025 por arquivo, scan de CVE de dependências, checagem de supply chain & postura de CI, roadmap de remediação alinhado com CWE Top 25:2025. | [OWASP Top 10](https://owasp.org/Top10/2025/) + [CWE Top 25](https://cwe.mitre.org/top25/archive/2025/2025_cwe_top25.html) |

As cinco auditorias agora **terminam com um step juiz que valida o
relatório** — um node `check` que verifica se o relatório está completo
e internamente consistente, voltando uma vez pra retrabalho quando não
está — e a auditoria de segurança segue o OWASP Top 10:2025. A tabela
no [`AGENTS.md`](../AGENTS.md) é a fonte detalhada por pipeline.

**Contrato de apenas-relatório pras cinco auditorias.** Elas escrevem
APENAS em `.huu/audits/<topico>.md` e `.huu/audits/<topico>-faq.json`,
mais no máximo um ajuste de `.gitignore` (uma linha `.huu/` commitada
vira `.huu/*` + `!.huu/audits/` — sem isso, os relatórios são
silenciosamente descartados no merge da etapa). Nunca modificam seu
README, `package.json`, lockfiles, ou qualquer source de produção.
Tools que precisam ser invocadas (semgrep, jscpd, gitleaks,
lighthouse-ci, …) rodam efêmeras via `npx --yes`, `pipx run`, ou
binários vendorizados sob `$HOME/.huu/bin/` — nunca adicionadas aos
manifests do seu projeto. Dois pipelines tocam arquivos de produção por
design: `huu Test Suite` (escreve `huu-tests.md` e um badge de testes
no README) e `huu Knowledge System` (escreve `.agents/skills/**` e
`.huu/knowledge/**`) — ambos são pipelines de setup, não auditorias.

`Pipeline.maxNodeExecutions = 50` limita as visitas do cursor aos
steps — um fan-out per-file (ou memory) de N arquivos conta como UMA visita.
Em repos grandes, restrinja sua seleção de arquivos com Smart Select;
regras de auto-skip ignoram `node_modules/`, `dist/`, `build/`,
`vendor/`, arquivos generated, `*.d.ts` e arquivos de lock.

---

## Pipelines como artefato compartilhável

Um pipeline é um artefato reusável. Um `huu-security-audit.pipeline.json`
que funciona num repo Node funciona em outro. O know-how de "como
decompor essa classe de tarefa" fica capturado em JSON — não na cabeça
de quem rodou um agente interativo numa tarde.

Essa assimetria é a graça toda:

- **Escrever um pipeline é o trabalho.** Dá pensamento pra fatiar
  uma tarefa em unidades independentes, escolher modelos por estágio,
  e definir o que `pronto` significa.
- **Rodar o pipeline bom de outra pessoa é barato.** Clone o JSON,
  aponte pro seu repo, rode.

A intenção é um cookbook comunitário de pipelines: publicado como
JSON puro num repo público, tipicamente sob MIT ou CC0. O runner é
open-source (Apache 2.0); pipelines que você escreve são *seus*.
Jogue num gist, no seu repo, num PR pro `huu/cookbook` — o humano
subscreveu, o formato faz eles serem portáteis.

> 🚧 O registro `huu/cookbook` está no roadmap — até lá, compartilhe
> pipelines via gists ou seus próprios repos; o formato é estável o
> bastante pra eles continuarem funcionando.

---

## Filosofia

**O nome é o produto.** `huu` significa **Humans Underwrite
Undertakings** — humanos subscrevem empreitadas:

- **Humans (humanos)** — o pipeline é escrito por uma pessoa, não
  gerado por um planner LLM.
- **Underwrite (subscrever)** — no sentido financeiro: o humano assina
  embaixo, assume responsabilidade e garante o escopo. O sistema não
  tem direito a negociar.
- **Undertakings (empreitadas)** — pedaços discretos e bem escopados
  de trabalho, cada um com um resultado claro.

`huu` *não é um agente autônomo*. É um executor que roda um plano que
você escreveu. A inteligência mora no pipeline — não no sistema. Se o
pipeline foi mal projetado, o resultado vai ser previsivelmente e
auditavelmente ruim. Isso é uma feature.

Três premissas:

1. O autor do pipeline é dono do escopo de cada step.
2. Steps bem projetados isolam edições por arquivo, eliminando
   conflitos por design.
3. Previsibilidade e auditabilidade ganham de sofisticação.

Se você quer um agente que *decide* o que fazer, use Devin, Plandex ou
Claude Code. Se você quer um sistema que executa *exatamente* o que
você subscreveu, em paralelo, com trilha de auditoria nativa do git,
este é o produto.

### Por que a gente não usa MCP

MCP virou padrão de fato em 2026 e é uma tentação óbvia. A gente recusa
a integração por uma razão econômica concreta: cada definição de tool
é re-enviada a cada turno de cada agente.

Concretamente: um único servidor MCP (ex.: GitHub MCP) injeta ~55k
tokens de definições de tool por turno. Com 10 agentes em paralelo,
isso são **~550k tokens de overhead por turno**, antes da primeira
edição. Pra um produto cuja proposta é *paralelismo barato e
auditável*, MCP inverte o trade-off.

Os casos de uso suportados (testes, auditorias, refatorações) precisam
ler arquivos, rodar comandos shell e editar arquivos. As tools padrão
do Pi SDK (read/bash/edit/write) cobrem tudo isso sem overhead.
Integrações com Jira, Linear ou Slack ficam deliberadamente fora de
escopo — `huu` é um produto de transformação de código, não um agente
de produtividade de propósito geral.

### Resolução de conflito como fallback

Quando a decomposição do operador acidentalmente coloca trabalho
sobreposto no mesmo estágio, um agente de integração ancorado em um
LLM real sobe num worktree lateral pra resolver e comitar. Pipelines
que seguem a regra "uma tarefa, um arquivo" nunca caem nesse caminho.
Encare como rede de segurança, não como feature pra contar com ela. A
resolução de conflito fica desabilitada no modo `--stub`.

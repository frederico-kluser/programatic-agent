<p align="center">
  <strong>MÉTODO</strong> · <a href="MANIFESTO.md">Manifesto</a> (identidade) · <a href="ROADMAP.md">Roadmap</a> (recursos) · <a href="AGENTS.md">AGENTS.md</a> (roteamento)
</p>

# Playbook de ondas — endurecer o modo de desenvolvimento do huu

> **O que este documento é:** um plano de **ações em ondas** para fechar as lacunas
> do método com que o `huu` é desenvolvido — e do método que o `huu` impõe aos
> agentes que ele orquestra. São os dois lados da mesma moeda: o `huu` roda
> pipelines de agentes em worktrees paralelas, e o `huu` **é construído** por
> agentes em worktrees paralelas. O que falha num lado falha no outro.
>
> **O que este documento não é:** não é o manifesto (identidade — `MANIFESTO.md`)
> nem o plano de recursos (RAM/PSI/cgroup — `ROADMAP.md`). Onde este documento
> tocar recursos, ele **cede** ao `ROADMAP.md`. Onde tocar identidade, cede ao
> `MANIFESTO.md`. Ver §0.4 (regra de precedência).

**Convenções de marcação, herdadas do playbook de origem:**

- 📏 **medido** — afirmação verificada neste repositório, com o comando ao lado.
  Se você rodar o comando e o número for outro, o documento está errado, não você.
- ✍️ **prescrito** — prescrição de engenharia, não extração. Pode estar errada.
- ⚠️ **específico** — vale para *este* repo/máquina/data, não transfere.

Data de escrita: **2026-09-05**. Todo número 📏 abaixo foi medido nesta data, no
commit `8561e63`, e é reverificado a cada push por `scripts/check-metodo.ts`
dentro do gate. (O cabeçalho aponta para o commit em que a medição foi feita, não
para o commit que a introduz — um arquivo não pode conter o próprio hash, e por
isso o verificador trata a divergência como **aviso**, nunca como erro.)

⚠ **Duas colunas deixaram de ser re-deriváveis em 2026-08-04.** O histórico do
repositório foi reiniciado no commit `26d093b` (`v1.0.0 — clean start`), então
`git log` já não alcança os números de **idade, autoria e churn** medidos antes
dessa data. Eles ficam abaixo como **registro histórico**, marcados onde
aparecem; tudo o que o `scripts/check-metodo.ts` recalcula continua sendo medido
a cada gate.

---

## Sumário

- [§0 — Calibre as ferramentas antes de contar qualquer coisa](#0--calibre-as-ferramentas-antes-de-contar-qualquer-coisa)
- [§1 — O programa, em números medidos](#1--o-programa-em-números-medidos)
- [§2 — O que já está resolvido (e por que isso importa)](#2--o-que-já-está-resolvido-e-por-que-isso-importa)
- [§3 — O teto de paralelismo: os singletons medidos](#3--o-teto-de-paralelismo-os-singletons-medidos)
- [§4 — Diagnóstico: onde a garantia é prosa](#4--diagnóstico-onde-a-garantia-é-prosa)
- [§5 — A árvore de ondas](#5--a-árvore-de-ondas)
- [§6 — Os cards](#6--os-cards)
- [§7 — Verificação em camadas](#7--verificação-em-camadas)
- [§8 — Memória e incerteza](#8--memória-e-incerteza)
- [§9 — O que a indústria confirma, refuta e não sabe](#9--o-que-a-indústria-confirma-o-que-ela-refuta-e-o-que-ela-não-sabe)
- [§10 — Custo, ritmo e o que esperar](#10--custo-ritmo-e-o-que-esperar)
- [Apêndices A–K](#apêndice-a--template-de-card-prompt-xml)

---

# §0 — Calibre as ferramentas antes de contar qualquer coisa

**Passo zero, e não é figura de linguagem.** Antes de qualquer inventário,
descubra como as suas ferramentas mentem *neste* corpus. Cada item abaixo foi
executado; nenhum é hipótese.

## 0.1 As cinco mentiras confirmadas

| # | A ferramenta | O que ela faz | Por que engana aqui |
|---|---|---|---|
| 1 | `rg` / `grep` respeitando `.gitignore` | Uma sonda plantada em `.huu/probe/sonda.txt` devolve **0 resultados e exit 1**; com `--no-ignore`, devolve 1. 📏 | `.huu/` é onde **toda auditoria escreve o entregável** (`.huu/audits/**`) e onde o dev mode escreve `goal.md`/`state.json`. Buscar ali sem `--no-ignore` produz "não existe" com exit code de sucesso. |
| 2 | `git diff --exit-code` | Com um arquivo novo não-rastreado presente, sai **exit 0**. 📏 | É o critério de aceitação mais tentador ("nada mudou / é determinístico"). Ele não vê arquivo novo. Um card que só **cria** arquivos passa esse critério sem escrever nada. |
| 3 | `git ls-files` | Não lista untracked: um `src/lib/zz-probe.ts` recém-criado aparece em `find` (1) e não em `git ls-files` (0). 📏 | Todo validador que **conta arquivos** via `git ls-files` fica cego para o arquivo que o card acabou de criar — exatamente o arquivo que ele deveria validar. |
| 4 | `tsc --noEmit` | `tsconfig.json` tem `include: ["src/**/*"]`, `exclude: ["node_modules","dist","scripts"]` e **`allowJs`/`checkJs` ausentes**. 📏 | O cliente web inteiro (`src/web/client/*.js` — 12 módulos, `app.js` com 3.723 linhas) e **todo o `scripts/`** ficam FORA do typecheck. `npm run typecheck` verde não diz nada sobre eles. |
| 5 | `git worktree add` | Materializa apenas o que está **commitado**. Documentado em `AGENTS.md` e explorado pelo dev mode (specs de task são arquivos reais commitados antes da run). | Preparação deixada no checkout principal simplesmente **não chega** no agente. A divergência aparece no merge como trabalho a refazer. |

> **Regra.** Escreva as regras de leitura do corpus num arquivo normativo *antes*
> de contar qualquer coisa, e trate cada uma como **modo de falha**, não como
> dica. "Zero resultados não é prova de ausência" ensina mais do que
> "use `--no-ignore`".

## 0.2 A armadilha que é só desta stack ⚠️

`vitest.config.ts` documenta, em comentário, um incidente já pago:

> *"Vitest 4 no longer excludes build output by default. Without this,
> `npm run build && npm test` runs every compiled `dist/**/*.test.js` IN PARALLEL
> with its `src/` twin — doubling the suite and making the native-shim port-bind
> tests race each other on 127.0.0.1:3000."*

Isso é o padrão certo: a exclusão está no config **com o motivo escrito ao lado**.
Falta a metade que fecha o ciclo — um teste que **falhe** se alguém remover a
exclusão. Hoje, remover as três linhas de `exclude` deixa a suíte verde (mais
lenta e às vezes flaky), e o comentário não impede nada.

## 0.3 O gate é 100% voluntário 📏

```
$ git config core.hooksPath
(não configurado)
```

`.githooks/pre-push` existe. `core.hooksPath` **não está configurado nesta
máquina**, então o hook **não roda**. Somado a: não existe `.github/` neste
repositório — logo **não existe CI**. A convenção
`npm run typecheck && npm test` antes de cada commit é honrada por disciplina
humana, sem nenhuma máquina atrás.

Consequência direta, e é a frase que organiza a Parte §7 inteira:

> **Ausência não falha sozinha.** Se a cobertura pode encolher sem nada ficar
> vermelho, ela vai encolher — e o verde continua com a mesma cara.

## 0.4 Regra de precedência (o documento que vence) ✍️

Antes da primeira onda paralela, é preciso nomear quem vence — senão dois agentes
escolhem fontes diferentes e **os dois "acertam"**. O `huu` tem hoje seis
superfícies normativas (`MANIFESTO.md`, `ROADMAP.md`, `AGENTS.md`,
`.agents/skills/catalog.md`, as 20 `SKILL.md`, `docs/**`) e **nenhuma regra
escrita de precedência**. E já existe uma contradição real entre elas:

| Onde | O que afirma |
|---|---|
| `MANIFESTO.md:139` | *"**Zero planner LLM em runtime.** […] No `huu`, o grafo é o JSON que você escreveu."* — listado como diferencial nº 2 |
| `AGENTS.md` (seção Development mode) | *"A ÚNICA flow do huu cujo step graph é escrito em **run time**"* — um planner LLM decompõe a meta em fronts |

Não é bug, é uma **exceção legítima e deliberada** (o dev mode reconcilia:
o humano subscreve a META e o MÉTODO; o planner só DECOMPÕE). Mas ela está
reconciliada em `AGENTS.md` e na skill `running-dev-mode`, **não** no manifesto —
o documento mais citado e o único que um recém-chegado lê primeiro. Um agente que
carregue só o `MANIFESTO.md` e encontre `dev-mode/planner.ts` conclui que o código
viola a identidade do projeto.

**Precedência proposta, por domínio (não linear):**

```
identidade / o que o huu é e não é ......... MANIFESTO.md         (vence sempre)
método / como se desenvolve aqui ........... METODO.md  (este)
recursos / RAM, PSI, cgroup, admissão ...... ROADMAP.md
fatos correntes do código .................. AGENTS.md → skill do domínio
"como fazer X" ............................. .agents/skills/<dominio>/SKILL.md
tutorial / referência de usuário ........... docs/**
```

Regra de conflito: **o dono do domínio vence**; quem discorda do dono **cita e
supera explicitamente** ("supero MANIFESTO §diferencial-2 no que diverge"), com
data. Um documento que contradiz o dono sem declarar superação é bug de
documentação — e o §7 propõe o verificador que o transforma em vermelho.

---

# §1 — O programa, em números medidos

Todos 📏, no commit `f9a0d81` (2026-08-04). Verificados por
`npx tsx scripts/check-metodo.ts`, que roda no gate (`scripts/gate.sh`) e
recalcula cada linha desta tabela a partir do repositório. A tolerância é de
**10%**: o objetivo é pegar prosa materialmente errada (uma tabela 23% fora, como
esta ficou entre 2026-07-30 e 2026-08-01), não transformar cada commit em
falha de gate — número exato aqui envelhece em uma tarde.

As quatro linhas de VOLUME (total versionado, `src/`, TS+TSX não-teste, testes)
e a de Skills foram re-medidas em **2026-09-05**: a razão teste:código é a
única entrada com tolerância ABSOLUTA (±0,02), então ela atravessa o limiar
antes de qualquer outra e obriga a re-medição junto com as três de que deriva.

| | |
|---|---|
| Idade ⚠ histórico | **363 commits**, de 2026-05-20 a 2026-08-02 (~74 dias) — medido antes do `v1.0.0 — clean start`; `git log` já não o alcança |
| Autores ⚠ histórico | 284 `fredericokluser` · 22 `Claude` · 19+2 nome completo · 15 `t` · 1 externo — idem |
| Total versionado | **223.961 linhas** (`git ls-files \| xargs wc -l`) |
| `src/` | **450 arquivos, 156.180 linhas** (inclui client JS/CSS/HTML) |
| `src/` TS+TSX **não-teste** | **76.182 linhas** |
| Testes | **155 arquivos, 56.038 linhas** → razão teste:código **0,74 : 1** |
| `docs/` | 37 arquivos, **14.858 linhas** (9 pares en/pt-BR) |
| Skills | **22** `SKILL.md` + **22** `LEARNINGS.md` + `catalog.md` |
| `AGENTS.md` | **190 linhas, 9.335 chars ≈ 2,4k tokens** — carregados em **toda** sessão |
| Pipelines default | 7 pipelines, 14 módulos, **4.321 linhas** |
| Verificação automática | gate local (`typecheck` + `test`) **e CI**: `.github/workflows/gate.yml` roda os **11 passos** de `scripts/gate.sh` em todo push/PR; `core.hooksPath` segue opt-in |
| Dogfooding ⚠ histórico | **17 merges de onda** do próprio huu (`merge(w4…w6-…): wave N front`), todos em **2026-07-28** (45 commits nesse dia) — anterior ao `clean start` |
| Higiene de branch | **0** branches `huu/**` órfãos |
| Marcadores | `TODO`/`FIXME`/`XXX` concentrados em `requeue.test.ts` (8), `dev-graph/node-catalog.ts` (6), `orchestrator/index.ts` (5), `card-focus.test.ts` (5), `types/orchestrator.ts` (4) |

**A razão teste:código de 0,74 : 1 é o número mais informativo da tabela**, e
precisa de contexto para não ser lida como elogio nem como acusação. O playbook de
origem chegou a 1,3 : 1 porque o oráculo dele era um sistema que ninguém podia
executar — quase tudo que se escrevia era instrumento de medida. Aqui o oráculo é
o próprio código, executável, e 0,74 : 1 com 155 arquivos de teste colocados ao
lado do módulo é uma cobertura respeitável **em quantidade**. A pergunta que o §7
faz não é "tem teste suficiente?" e sim **"se isto desaparecer, o que fica
vermelho?"** — e é aí que aparecem os buracos.

## 1.1 O que está provado e o que não está

Honestidade primeiro, como no playbook de origem:

- **Provado (e é muito):** o `huu` já rodou a si mesmo em ondas paralelas — 17
  merges rotulados `merge(wN-…): wave N front` num único dia, com **zero branches
  órfãos** sobrando. A barreira de merge, a criação/limpeza de worktree e a
  numeração de onda funcionaram sob carga real de dogfooding.
- **Provado:** o controle de recursos (`ROADMAP.md` Fases 1 e 2.1–2.3 + 2.6) nasceu
  de um incidente real de OOM com 9 auditorias simultâneas e foi verificado em
  runtime (sweep de PSI 0→3→0→0,7→5). Não é desenho no papel.
- **NÃO provado:** que a cadeia de verificação pega uma **regressão de
  comportamento** introduzida por um merge paralelo. Não há gate entre merges
  (§4), e o pre-push é opt-in (`git config core.hooksPath .githooks`).
  *Atualizado em 2026-08-01:* a CI passou a existir — `.github/workflows/gate.yml`
  roda `scripts/gate.sh` inteiro em todo push e PR — o que fecha o buraco do
  "ninguém roda o gate", mas **não** este item: ela verifica o resultado
  *depois* do merge, nunca entre os merges de uma mesma onda.
- **NÃO provado:** que dois agentes da mesma onda não podem escrever no mesmo
  arquivo. O isolamento é de *filesystem* (worktree), o que impede pisar em tempo
  real — **não** impede o merge limpo que integra código contraditório (§4.2).
- **NÃO provado:** que uma afirmação factual escrita numa skill continua verdadeira.
  Não existe pin conteúdo-endereçado nem verificação de deriva (§8).

---

# §2 — O que já está resolvido (e por que isso importa)

Um plano de melhoria que não credita o que já existe produz retrabalho. E o `huu`
já resolveu, **em código**, cinco coisas que o playbook de origem teve de resolver
à mão — e resolveu melhor:

| Lição do playbook de origem | Como o playbook resolveu | Como o `huu` resolve |
|---|---|---|
| "A onda declarada tem de ser o nível topológico do grafo; se você não deriva por script, o grafo ou a onda está errado" | Numeração à mão, validada à mão, **e um card ficou órfão sem ninguém ver** | `dependsOn` → **ondas derivadas pelo motor**. A lei é código, não convenção. O erro nº 2 do playbook de origem é estruturalmente impossível aqui |
| "Merge um a um, nunca octopus; ordem importa" | Decisão manual, escrita em dois commits | Merge determinístico ascendente `--no-ff` na integração, **nunca rebobina** — `src/git/integration-merge.ts` |
| "A barreira tem de ser artefato durável e contável, nunca leitura de tela" (custou um timeout de 15 min com o dever feito) | Hook de fim-de-resposta anexando linha a um arquivo | A barreira é o **fim da etapa**: o merge de integração. Não há tela para ler, não há falso positivo possível |
| "Estado derivado, não escrito à mão" (a seção "Estado do programa" era a afirmação menos exata do repo) | Verificador que deriva da árvore e falha se a prosa discordar | **Contrato de verdade do kanban** já implementado: `DONE` verde só depois do branch **mesclar** (`AgentStatus.merged`), `READY` azul enquanto aguarda, `UNMERGED` âmbar quando não entrou. `src/lib/card-state.ts` |
| "Sob pressão, matar o agente perde o trabalho" | — (não coberto) | **Checkpoint + pause** com backoff anti-churn e jitter determinístico; worktree, branch e transcript preservados (`ROADMAP.md` §2.3) |

Some-se a isso o que o `MANIFESTO.md` chama corretamente de BSP sobre git: o
isolamento é **por construção** (um worktree por agente), não por instrução no
prompt. Nenhum plano abaixo mexe nisso.

> **Consequência para este plano.** As lacunas que restam **não** são de
> orquestração — são de **verificação, propriedade de arquivo e proveniência**.
> É exatamente a fronteira que o playbook de origem também não fechou. As ondas de
> §5 atacam essas três, nessa ordem de risco.

---

# §3 — O teto de paralelismo: os singletons medidos

O teto de paralelismo não é o modelo nem a CPU. É o **número de recursos singleton
que as tarefas tocam**. Medido por churn × tamanho (`git log --name-only` cruzado
com `wc -l`) 📏:

| Arquivo | Linhas | Toques | churn×linhas | Papel de singleton |
|---|---:|---:|---:|---|
| `CHANGELOG.md` | 1.766 | 84 | 148.344 | **O mais tocado do repositório** — mas o conflito garantido **foi resolvido**: escreve-se um fragmento por card em `.changes/`, consolidado por `scripts/changelog.ts` |
| `src/orchestrator/index.ts` | 2.751 | 48 | 132.048 | **O pior hoje.** Loop de etapa + guard + requeue + retry num arquivo. Todo card de orquestração colide |
| `README.md` + `README.en.md` | 1.232 + 1.224 | 56 + 48 | 68.992 + 58.752 | Gêmeos que precisam ficar em sincronia — agora com paridade **verificada** por `scripts/check-twins.ts` no gate |
| `src/web/client/styles.css` | 1.852 | 27 | 50.004 | CSS único do cliente |
| `src/web/server.ts` | 1.330 | 27 | 35.910 | Servidor HTTP+SSE único |
| `src/web/client/index.html` | 740 | 30 | 22.200 | Markup único do cliente — herdou parte do churn que era do `app.js` |
| `src/web/run-manager.ts` | 967 | 20 | 19.340 | Dono do estado multi-run no servidor |

⚠ **A coluna *Linhas* é medida a cada gate; as colunas *Toques* e *churn×linhas*
não são.** Os toques vêm da medição de 2026-08-02, feita sobre o histórico
anterior ao `v1.0.0 — clean start` (`26d093b`), que `git log` já não alcança —
`churn×linhas` é o produto recalculado sobre as linhas de hoje. Trate a ORDEM
como o sinal (ela não mudou), não a magnitude.

**Como ler esta tabela.** Cada linha é uma onda que **não pode ter dois cards**, ou
um refactor a fazer antes de alargar a onda. Três leituras não óbvias:

1. **Os dois piores singletons da medição anterior sumiram da tabela — porque
   foram quebrados.** `src/web/client/app.js` era o nº 1 (3.723 linhas, churn×linhas
   171.258) e hoje tem **113 linhas**: o cliente web virou ~15 módulos ESM, e o
   churn que era dele migrou em parte para o `index.html`. `src/lib/types.ts` era
   1.235 linhas e hoje tem **84**: os tipos viraram o diretório `src/lib/types/`.
   É a evidência de que esta tabela é instrumento, não inventário — ela existe pra
   ser esvaziada.
2. **`CHANGELOG.md` continua no topo por toques, mas já não é conflito garantido.**
   O padrão "insere no topo da seção `[Unreleased]`" conflitava **sempre** que duas
   worktrees paralelas escreviam. A solução prevista foi implementada: **um
   fragmento por card** em `.changes/<card>.md`, consolidado por
   `scripts/changelog.ts` depois do merge. O arquivo segue grande e tocado; o que
   sumiu foi a serialização obrigatória da onda.
3. **`src/orchestrator/index.ts` é o pior de hoje** — 2.751 linhas (caiu de 3.815,
   mas subiu de 39 para 48 toques). Loop de etapa, guard, requeue, retry e review
   loop no mesmo arquivo: todo card de orquestração ainda colide nele. É o próximo
   candidato natural ao tratamento que `app.js` e `types.ts` receberam.

> **Regra.** Enumere os singletons **antes** de dimensionar a onda; cada um vira
> **ou um dono exclusivo, ou uma sequência dentro da onda**. E prefira gastar
> refactor barato (fragmentos, módulos por tela) a gastar uma onda inteira
> sequenciada.

---

# §4 — Diagnóstico: onde a garantia é prosa

Esta seção é o produto da auditoria. Cada item foi verificado no código, com
`arquivo:linha`. Eles se agrupam em **quatro famílias**, e a ordem abaixo é a
ordem de risco.

## 4.1 Família A — Falso verde: o verde que não pode ficar vermelho

O achado mais grave do repositório inteiro, e é de uma linha:

> **A cláusula 4 do juiz compartilhado das 5 auditorias usa
> `git status --porcelain` — e ela NUNCA pode falhar.**
> `src/lib/default-pipelines/knowledge-protocol.ts:128`

O motivo está escrito, em inglês, no próprio código do huu, 100 arquivos ao lado:
*"the stage merges are already committed by the time the judge runs, so a bare
`git status` is clean"* (`src/orchestrator/check-evaluator.ts:19-22`). O juiz roda
na worktree de integração **depois** do merge; os agentes fazem `git add -A` +
commit e o merge é um commit `--no-ff`. Logo a árvore está sempre limpa e a
cláusula sempre passa.

**Consequência exata:** o **contrato report-only de 5 dos 7 pipelines default**
— a promessa de que uma auditoria não toca o seu código de produção — é
verificado por um comando que não consegue reprovar. A forma correta existe um
arquivo ao lado (`huu-test-suite.ts:343` usa `git diff --name-only
$baseCommit..HEAD`) e `$baseCommit` **já é substituído** em condições desde
`check-evaluator.ts:95-98`. É uma linha.

E ela não está sozinha. A família A completa, medida:

| # | O que parece verde | Por quê | Onde |
|---|---|---|---|
| A1 | O contrato report-only de 5 pipelines | `git status` sempre limpo no momento do juiz | `knowledge-protocol.ts:128` |
| A2 | **Todo** juiz do catálogo | **Nenhum teste no repositório prova que um juiz consegue devolver `rework`.** Os 5 testes que "testam rework" **injetam a string do veredito** (`check-evaluator.test.ts:96`, `dag-execution.test.ts:170`, `key-rotation.test.ts:273`) ou assertam a *tabela de outcomes*, nunca a condição. Todo juiz poderia sempre aprovar e nada acusaria | catálogo inteiro |
| A3 | Um step onde **todos** os agentes falharam | `runStageIntegration` acha 0 entradas elegíveis, loga um `warn`, marca o card `skipped` e **`return true`** ⇒ o step é marcado `done` e os dependentes rodam contra uma árvore que nunca recebeu o trabalho | `index.ts:2945-2956`, `3597-3598` |
| A4 | Um pipeline que pulou metade dos steps | `ready.length === 0` com `pending` não-vazio ⇒ `warn` + `break`; `start()` então define **`status = 'done'`** | `index.ts:3489-3495`, `1577-1578` |
| A5 | Uma época do dev mode que **não produziu nada** | `landEpoch` devolve `alreadyUpToDate: true` e **nada no repositório lê esse campo**; o CLI sai **0** | `epoch-landing.ts:99`, `dev-cli.ts:518-519` |
| A6 | `goalComplete: true` | Encerra a sessão com exit 0 e **zero corroboração contra o repo** — e o mesmo `plan` que declara a vitória acabou de **sobrescrever** o `doneWhen` que a define (`state.doneWhen = plan.doneWhen`, incondicional) | `dev-driver.ts:820-827` |
| A7 | Um juiz que tomou 429 / crashou / alucinou o label | O `default: true` aponta pra frente ⇒ **aprova em silêncio**. Documentado e deliberado, e o próprio código chama de *"the worst failure mode in the system"* | `check-evaluator.ts:76-79` |
| A8 | `CheckStep` sem `maxRuns` | **Não existe default.** `index.ts:3303` só compara quando `maxRuns !== undefined` ⇒ omissão = **loop pago ilimitado**. Três documentos afirmam "default 5" | `index.ts:3303-3304` vs `AGENTS.md:502`, `working-on-orchestrator/SKILL.md:33`, `authoring-pipelines/SKILL.md:28` |
| A9 | Um merge que falhou sem conflito | No caminho do resolver, `conflicts.length === 0` é tratado como sucesso — mas `GitClient.merge` devolve `{success:false, conflicts:[]}` para **qualquer** falha não-conflito (árvore suja, `index.lock`, hook, timeout). Card fica **verde DONE** e a etapa seguinte parte de um HEAD sem o trabalho. A guarda correta existe 100 linhas antes e não foi repetida | `integration-agent.ts:187-191` vs `:86-93` |
| A10 | `git diff --exit-code` como critério | Cego a arquivo novo (§0.1 nº 2) — e é o critério mais tentador para "é determinístico" | universal |
| A11 | `validate-skills.sh` | O único gate mecânico da biblioteca de conhecimento **não está ligado a nada** (nenhum script npm, nenhum hook, nenhum teste) e **está vermelho agora**: 2 skills fora do teto de tokens/linhas. Vermelho e invisível há semanas | `meta-skill-consolidate/scripts/validate-skills.sh` |
| A12 | `smoke-defaults.sh` | O array `EXPECTED` lista **6** dos 7 pipelines default — `huu-knowledge-system.pipeline.json` não está lá | `scripts/smoke-defaults.sh:45-52` |

> **A pergunta que gera esta lista, e que vira item de checklist no §7:**
> ***"o que este comando imprime se a tarefa não fizer nada?"*** Se a resposta é
> "verde", o critério é decorativo.

## 4.2 Família B — Propriedade de arquivo: a garantia que a documentação afirma ter

`docs/dev-mode.md:250-253` traz um cabeçalho literal:

> **"Rules huu enforces (that the planner cannot break)"** — *Partition by file
> ownership*

**Nada enforça isso.** A busca foi exaustiva e negativa: `prepareStageTasks`
(`index.ts:3233-3285`) e `decomposeTasks` (`task-decomposer.ts:8-34`) não fazem
nenhuma comparação de caminho entre tasks; não há lock de arquivo, não há teste
de disjunção, não há checagem pré-merge em `src/orchestrator/`, `src/git/` ou
`src/lib/dev-mode/`. O isolamento é **de worktree** — impede pisar em tempo real,
**não** impede o merge limpo que integra código contraditório.

O que existe é **instrumentação pura**, e o código diz isso na cara:

> *"PURE INSTRUMENTATION — nothing is blocked, reverted or warned about to the
> agent."* — `src/orchestrator/index.ts:2727-2733`

`recordWriteSetViolations` (`index.ts:2735-2767`) roda **por agente**, **depois do
commit**, só dispara quando `task.files[0]` é um spec markdown com um cabeçalho
`## Owns files`, e o resultado é um `warn` + um número que aparece uma época
depois numa tabela de evidência. Nenhum agente é comparado com outro:
`runStageIntegration` tem `filesModified` de **todos** os agentes elegíveis na mão
(`index.ts:2917`) e **não olha**.

O modo de falha que ninguém pega **não é** o conflito. É o **não-conflito**: dois
agentes editam hunks disjuntos do mesmo arquivo (um barrel, um roteador, uma
union de tipos, um array de config), o git mergeia limpo, e o resultado é código
que nenhum dos dois pretendeu. Foi exatamente esse caso que custou uma onda
inteira no playbook de origem.

E há um agravante estrutural: **`schema` não tem onde declarar write-set.**
`WorkStepSchema` (`pipeline-io.ts:52-70`) tem `files`, `scope`, `filesFrom`,
`maxFiles`, `produces`, `dependsOn`, `next`, `review` — e nada que diga "eu
escrevo aqui". A única regra de exclusão em nível de arquivo no sistema inteiro é
`produces` único por caminho (`pipeline-io.ts:166-180`), e o comentário dela é a
melhor formulação do problema que existe no repo:

> *"Two steps promising to write the SAME memory file would race in the
> integration worktree — the later merge silently wins. Reject upfront."*

A regra está certa. Só falta aplicá-la a **todos** os arquivos, não só aos de
memória.

## 4.3 Família C — Nada entre os merges, e nada depois do crash

**Nada é verificado entre dois merges da mesma etapa.** O corpo do loop é, na
íntegra, `src/git/integration-merge.ts:40-71`: filtra pending, loga, chama
`git.merge`, empurra pra `branchesMerged`, dispara `onBranchMerged`. Sem
typecheck, sem teste, sem build, sem lint, sem hook (`--no-verify` é usado nos
commits do próprio huu), sem nem um `git status` de sanidade. **O único critério
de sucesso é o git ter saído 0.**

Consequência: N branches individualmente verdes compõem uma árvore que não
compila, e o primeiro a notar é o agente da etapa seguinte — ou um juiz opcional.
Com um merge dentro do gate, um vermelho **nomeia o card**; com quatro, não nomeia
nada. É a lição central do playbook de origem, e é a única que o huu ainda não
tem em código.

E a durabilidade:

| Afirmação | Realidade |
|---|---|
| `working-on-orchestrator/SKILL.md:70`: *"`RunManifest` is written incrementally during the run"* | **Falso.** `RunLogger.flush` é chamado **uma vez**, no `finally` de `start()` (`index.ts:1718-1733`); `appendEvent` só bufferiza em memória (`run-logger.ts:38`). Um SIGKILL no meio de uma etapa deixa **zero** artefato em `.huu/` |
| Um run é retomável após o `huu` morrer no meio? | **Não.** `start()` lança se `status !== 'idle'` (`index.ts:1217`) e sempre começa de um `runPreflight` + `generateRunId()` novos. A busca por `resumeRun|loadManifest|crash recover` em `src/` devolve **exatamente um** hit: o comentário em `index.ts:407` dizendo que é ROADMAP §2.4, diferido |

O trabalho **está** nos branches commitados — recuperável **à mão**. A cura mais
barata não é resume: é **flush periódico do manifesto**, que transforma
"irrecuperável" em "recuperável por um humano", e é ~10 linhas.

## 4.4 Família D — Proveniência: a citação que ninguém confere

Números medidos na biblioteca inteira (não amostra):

| | |
|---|---|
| Instâncias de ponteiro `arquivo:linha` em **toda** a biblioteca (2.074 linhas de `SKILL.md` + 195 entradas de LEARNINGS) | **15** (1 é placeholder de template) |
| Entradas de LEARNINGS com ponteiro | **2 de 195 (1,0%)** |
| Ponteiros em `AGENTS.md` (520 linhas) | **0** |
| **Das 14 citações reais, quantas resolvem para uma linha que sustenta a afirmação** | **4 — taxa de acerto 29%** |
| Das 10 que erram, quantas afirmam **comportamento que não existe mais** | **5** |

Os cinco piores casos são de uma categoria única e perigosa: **a skill ensina o
oposto do código, e a skill é o que o agente carrega.**

- `running-in-docker/SKILL.md:17-29` ainda ensina uma ordem de bypass de 7 passos
  em que `--yolo` / `--no-docker` / `HUU_NO_DOCKER` levam à execução nativa, e
  fecha com conselho operacional: *"When iterating on the wrapper itself, run with
  `HUU_NO_DOCKER=1`"*. O `decideReexec` real tem **três** ramos
  (`docker-reexec.ts:253-273`); as flags removidas sobrevivem só como
  `REMOVED_NATIVE_FLAGS` para avisar-e-descartar. O conselho é um no-op silencioso.
  Pior: **a própria LEARNINGS dessa skill registrou a ordem de serviço em
  2026-07-02** — *"THE SKILL BODY'S decideReexec bypass-order description IS NOW
  STALE — consolidator must rewrite it"* — e ela segue stale 28 dias depois.
  `AGENTS.md:121-126` está **correto**; a skill contradiz o doc raiz.
- **`copilot` ainda está na `description` do frontmatter** de
  `integrating-llm-backends` e em `catalog.md:16`. A `description` é o **sinal de
  roteamento** carregado no contexto de todo agente — e três testes
  (`registry.test.ts:16,20,45`) assertam explicitamente que o backend foi
  removido. O sistema testa a remoção e ensina a presença.
- `admitPsiThreshold` (`working-on-orchestrator/SKILL.md:40`) tem **0 ocorrências
  em `src/`**. O símbolo é `targetPsi`, e o freeze binário fica em `targetPsi × 2`
  = **1,0%**, não nos 0,5% que a skill afirma.

E a governança que devia consertar isso não roda:

| Mecanismo | Estado medido |
|---|---|
| Hooks (`.claude/settings.json`) | **Zero.** Nenhum arquivo de settings no projeto; nenhum hook em nenhum evento |
| `check-pending-evolution.sh` (gate de encerramento) | Existe, **não ligado** — o próprio header diz "OPT-IN — not wired by default"; o JSON pra ligar está em `.agents/workbench/stop-hook-proposal.md:32`, não aplicado |
| `validate-skills.sh` | Existe, **não ligado**, e **vermelho** |
| Regra "só a consolidação edita corpo de SKILL.md" | **Revogada pelo próprio template**: `skill-template.md:43` manda *"distill it into this SKILL.md body and bump `metadata.version`"* — e essa linha foi copiada em **8 de 8** skills de tarefa. A deriva de versão (0.8.0 em duas skills, enquanto `meta-skill-consolidate` está em 0.1.0 com LEARNINGS vazio) prova que a auto-promoção aconteceu |
| `[superseded]` | **0 entradas**, contra **15** que escrevem "SUPERSEDES/CORRECTS/REFINES" em prosa. A máquina de estados não tem arestas |
| Volume | LEARNINGS = **195 entradas / 216 KB / ~54k tokens** = **6,5× o `AGENTS.md`**; 46% delas em 2 arquivos, ambos no ou perto do teto |
| Filtro estrito ("não-óbvio + não-inferível + não-volátil + muda como se trabalha") | **~42% passariam.** 4 entradas fixam "N testes verdes" (a classe volátil que a própria regra manda descartar); 3 carregam TODO estacionado |
| Frescor | 12 de 16 skills ainda dizem *"Facts verified against source on 2026-06-12"* — 48 dias e **90 commits em `.agents/`** depois |

> **Regra.** "Citação que ninguém checa" é indistinguível de "citação verde".
> Um ponteiro para linha, sem hash do conteúdo, é um endereço — não uma
> asserção. E uma `description` de skill errada é pior que um corpo errado:
> ela é o roteamento.

## 4.5 O padrão que une as quatro famílias

Lido de cima, o diagnóstico tem uma forma única, e ela é elegante de tão
consistente:

> **O huu é excelente em tornar o MÉTODO determinístico e quase não investiu em
> tornar a VERIFICAÇÃO falsificável.**

Cada família é a mesma frase em outro domínio: o grafo é derivado por motor (ótimo)
mas nunca validado no construtor (`Orchestrator` **nunca chama**
`validateTopology` — ele só roda dentro do `superRefine` do schema, ou seja, só em
pipeline importado de disco; os 6 sítios que constroem `Pipeline` em código,
**incluindo o dev mode**, passam direto — `pipeline-io.ts:117-119`). O merge é
determinístico (ótimo) mas nada roda entre dois merges. Os prompts aplicam 7 das
12 técnicas do playbook em 7/7 pipelines (ótimo) mas as duas técnicas que
*verificam* — few-shot com exemplo real e SELF-CHECK — estão em **0/7** e **2/7**,
e a documentação afirma que estão em todos (`prompting-playbook.md:17`
*"Every bundled default pipeline already applies it"* — mensurávelmente falso para
as técnicas 5 e 8). A biblioteca de conhecimento tem curadoria humana e conteúdo
causal de alta qualidade (ótimo) e **nenhum** mecanismo que detecte a própria
decadência.

Duas ironias medidas, que valem como argumento:

1. **O huu constrói para o cliente o que não usa em si.** O pipeline
   `huu Knowledge System` termina com *"blind routing eval gated by a
   description-sharpening rework loop"* — um eval de roteamento para as skills que
   ele **gera**. A biblioteca de 20 skills curada à mão que **governa o próprio
   repo** não tem eval nenhum. E `docs/ci.md` (245 linhas) ensina, com receita de
   GitHub Actions pronta, como rodar as auditorias do huu em CI — num repositório
   **sem `.github/`**.
2. **O `$hint` é um canal de injeção.** `prompting-playbook.md:38-39` manda
   *"fence the injected `$file` content and the `$hint` note inside their own
   tagged block so the model never treats scanned data as orders"*. Em **7 de 7**
   pipelines o `$hint` é interpolado como **prosa de instrução**
   (`index.ts:3616`, sem escape), e ele é texto **escrito por um LLM** (o step de
   recon), limitado apenas por um truncamento de 600 chars.

## 4.6 A prova por mutação — 📏 o achado mais duro do diagnóstico

Tudo acima é leitura de código. Esta seção é **experimento**: quatro mutações
aplicadas ao código-fonte, suíte inteira rodada, código restaurado. A suíte tem
**1.786 testes passando em 13,3 s** (126 arquivos, 537 suites) — velocidade nunca
foi desculpa para não rodar.

| # | Mutação aplicada | Resultado da suíte |
|---|---|---|
| 1 | `index.ts:1460` **e** `:3496` — **os dois** guardas de `maxNodeExecutions` → `if (false && …)` | **1.786 passam, exit 0** · `tsc` exit 0 ⇒ **SOBREVIVEU** |
| 2 | `integration-merge.ts:33` — ordem ascendente → descendente | exit 1 — **morta, mas por acidente** (ver abaixo) |
| 3 | `pipeline-io.ts:185` — `defaults.length !== 1` → `=== 0` (aceita 2+ defaults) | **1.786 passam, exit 0** ⇒ **SOBREVIVEU** |
| 4 | `integration-merge.ts:33` — **o sort inteiro deletado** | **1.786 passam, exit 0** ⇒ **SOBREVIVEU** |

**Leia a mutação 1 devagar.** Os dois guardas de `maxNodeExecutions` são a **única**
coisa entre um outcome de `CheckStep` apontando para trás e um **loop de gasto de
LLM ilimitado**. Apagar os dois deixa o gate inteiro verde. Nada no repositório
referencia `DEFAULT_MAX_NODE_EXECUTIONS` nem as mensagens de erro de
`index.ts:1462`/`:3498`; `registry.test.ts:100` só verifica que os pipelines
*declaram* ≤50, e `check-runs.test.ts:117` dá falsa confiança — ele é parado por
`CheckStep.maxRuns`, um cap diferente.

**A mutação 2 é pior do que "morta".** O único teste que a pegou é
`orchestrator.test.ts:297` — *"fails the run when a merge fails for a non-conflict
reason"* —, cujo propósito é tratamento de **falha** de merge: ele stuba
`GitClient.prototype.merge` para falhar quando `callCount === 1` e asserta que o
agente 1 é o perdedor. A ordem ascendente é pega como **efeito colateral de uma
fixture**. Reescreva aquele stub para chavear por nome de branch — a refatoração
mais natural do mundo — e o invariante fica **indetectável**. A mutação 4 já prova
isso para o sort em si.

### O que mais a auditoria empírica mediu

| # | Achado | Prova |
|---|---|---|
| A13 | **`npx vitest run -t "FiltroQueNaoExiste"` sai 0** com `1787 skipped`. `passWithNoTests` não está configurado. Filtro de **arquivo** inexistente é corretamente vermelho; filtro de **nome** sem casar é **verde e silencioso** | executado |
| A14 | **O typecheck é cego onde mais dói.** Dois erros de tipo plantados — um em `scripts/deploy.ts`, um em `src/web/client/card-state.js` — e `npm run typecheck` saiu **0**. São 4.669 linhas de cliente web (3.723 só em `app.js`) + todo o `scripts/` invisíveis. `CHANGELOG.md:1255` registra que `smoke-dashboard.tsx` ficou quebrado em silêncio "since the backend registry refactor" — exatamente este buraco | executado |
| A15 | **O gêmeo `card-state` não é gêmeo.** `card-state.ts:47` chaveia por `s.state`; `card-state.js:25` chaveia por `a.phase`. Um teste cruzado sobre 70 combinações `(state, phase)` achou **18 discordâncias de coluna**, com as duas suítes verdes. Ex.: `state=streaming phase=done` → TS diz `doing/RUNNING`, web diz `done/done`. `AGENTS.md:201` afirma que os testes "pin the same table so the mirrors can't drift silently" — **não pinam**: cada um importa só o seu módulo e hard-coda a própria tabela, em vocabulários diferentes | executado |
| A16 | **Três padrões de nome de teste são ignorados em silêncio**: `src/__tests__/probe.ts`, `src/probe.tests.ts` (plural — o typo comum) e `src/probe-e-test.ts`. Testes falhando plantados nesses caminhos **não foram coletados** | executado |
| A17 | **Cobertura não é medida.** Nenhuma dependência `@vitest/coverage-*`, nenhuma chave `coverage`, nenhum threshold. Logo ela **não pode regredir** — não existe | inspeção |
| A18 | **43,5% dos arquivos de `src/` não têm teste irmão** (81 de 186), = **48,3% das linhas**. `src/ui/` — a TUI Ink inteira — tem **zero** arquivos de teste; 5 dos 10 maiores sem teste são dela. `app.js` é buraco duplo: sem teste **e** sem typecheck | medido |
| A19 | **535 asserções são `toContain('…')` de substring em prosa — 12,4% do total.** Inclui a garantia CODE-FROZEN do `huu Test Suite`, o único pipeline default que escreve no seu repo: ela é verificada **grepando inglês num prompt**. Trocar a `condition` do juiz por uma que sempre aprova, mantendo as strings, deixa tudo verde | medido |
| A20 | **`dist/` está 26 dias velho e o smoke o abençoa.** `smoke-image.sh:27` e `smoke-pipeline.sh:58` só fazem `docker image inspect`, nunca rebuild; `smoke-defaults.sh` carrega `dist/`. Rodado: `smoke-defaults: OK` contra build de 2026-07-04 | executado |
| A21 | **`.huu-worktrees/` não está no `exclude` do vitest.** Uma worktree viva com `src/**/*.test.ts` seria coletada junto com a árvore principal — exatamente a corrida de porta que o comentário do `dist/**` existe para prevenir | inspeção |
| A22 | **Nenhuma plataforma roda a suíte inteira.** No Linux, o teste de métricas do macOS é pulado; no macOS, `native-shim.test.ts` (`describe.skip`) derruba a suíte de bind-shim inteira. E os smokes carregam lógica Darwin-only substancial que nunca executa na máquina do mantenedor | inspeção |
| A23 | **O caminho de release não roda smoke nenhum.** `scripts/deploy.ts:99-105` faz typecheck → test → build → commit/tag/push/publish. `AGENTS.md:437-441` torna os smokes etapa obrigatória de release; `releasing-versions/SKILL.md:50` os rebaixa a "Optional"; o script que a skill chama de canônico os **omite** | inspeção |

> **A conclusão que só o experimento autoriza:** dos nove invariantes críticos
> testados um a um, **os dois mais difíceis de recuperar são os dois sem nenhuma
> asserção** — o *never-rewind* da worktree de integração (zero cobertura;
> `stageBaseCommits`, `stageBaseRef` e `commitAfter` são referenciados por **zero**
> arquivos de teste) e o backstop de loop ilimitado (mutação 1).

---

# §5 — A árvore de ondas

## 5.1 A lei, e como ela se aplica aqui

O playbook de origem descobriu que a onda declarada era exatamente o nível
topológico do grafo, 40 de 40. Aqui isso não é descoberta: **é como o motor
funciona** — `computeWave` recomputa o conjunto pronto a cada superstep
(`wave-scheduler.ts:59-80`) e o `dependsOn` é obrigado a apontar para trás
(`pipeline-io.ts:247-252`), o que torna ciclo estruturalmente impossível.

Então este plano usa a lei do playbook **como formato de escrita**, com a
distinção que o playbook fez questão de marcar:

> **O nível é uma restrição; a onda é uma decisão de escalonamento.**
> A onda nunca é *menor* que o nível, mas pode ser maior. Folga é legítima —
> **e tem de ser vista, não descoberta.** A coluna "folga" abaixo existe por isso.

## 5.2 As 11 ondas

| Onda | Cards | Nível derivado | Folga | Tipo |
|---|---:|---:|---:|---|
| **W0** | 1 | 0 | 0 | **raiz** — entrega vocabulário e precedência, não funcionalidade |
| **W1** | 6 | 1 | 0 | **o fan-out da raiz** — todo o ferramental de verificação, write-sets disjuntos |
| **W1.5** | *(infra)* | — | — | **sem worktree**, no branch principal: exige a máquina do humano |
| **W2** | 7 | 2 | 0 | **composição** sobre o gate — protocolo próprio (§5.5). **A mais larga** |
| **W3** | 4 | 2–3 | 0–1 | grafo + propriedade de arquivo — o coração do plano |
| **W4** | 4 | 2–3 | 1 | memória, incerteza e ADR |
| **W5** | 1 | 5 | 0 | **neck**: `AGENTS.md`, o doc mais compartilhado — sozinha de propósito |
| **W6** | 4 | 4 | 2 | dev mode — herda write-set, `accept` e ledger |
| **W7** | 4 | 6 | 0–1 | quebrar os singletons medidos no §3 |
| **W8** | 2 | 3 | 5 | **dogfooding** — preenchedor de paralelismo, folga grande |
| **W9** | 1 | 7 | 0 | **join** — estado derivado + catálogo de falso-verde vivo |

**Total: 34 cards + 1 de infra, em 11 ondas.** Largura máxima 7 (W2), profundidade
7. Duas leituras da tabela:

- **W1 é larga de propósito e W5 é estreita de propósito.** W1 é o nível de *hubs*:
  seis ferramentas independentes que, uma vez no lugar, abrem tudo o que vem
  depois — e é por isso que W2 nasce com 7 cards: **largura é fan-out do nível
  anterior.** Um nível de hubs produz um nível largo, um nível depois. W5, ao
  contrário, é um arquivo único que 34 commits já tocaram — dois cards ali
  garantiriam conflito.
- **W8 tem folga 5 e está lá por escolha.** Os dois cards de dogfooding
  topologicamente cabem no nível 3; foram empurrados para engrossar o fim do
  programa e porque o valor deles depende de o gate já estar honesto. Se você
  quiser encurtar o caminho crítico, **antecipe W8 para W3** — é o único lugar do
  plano onde isso é gratuito.

## 5.3 Tabela `arquivo → dono` (o contrato executável)

Grupos por domínio são atalho de comunicação. O contrato é esta tabela — e o
card `M3-02` a transforma em verificação de máquina.

### W1 — a onda mais larga, e por isso a que mais precisa da tabela

| Arquivo / diretório | Dono | Os outros |
|---|---|---|
| `scripts/gate.sh` | **M1-01** | não editam |
| `scripts/check-acceptance.ts` (+ teste) | **M1-02** | não editam |
| `src/lib/types.ts`, `src/lib/pipeline-io.ts`, `src/lib/assistant-schema.ts` | **M1-03** | não editam — **singleton, dono exclusivo na onda** |
| `src/lib/default-pipelines/knowledge-protocol.ts` + os 5 `pipelines/*audit*.json` | **M1-04** | não editam |
| `.changes/**`, `scripts/changelog.ts`, `CHANGELOG.md` | **M1-05** | não editam |
| `tsconfig.json`, `tsconfig.client.json`, `package.json` | **M1-06** | não editam — **singleton** |

### Compartilhados na W1 — **só acrescente**

`METODO.md` (só a seção de estado), `.agents/ledger/inbox/<card>.json`.

Regras: nunca reordene, nunca renomeie, nunca reindente, nunca mexa em membro que
não é seu. Acrescente no fim do bloco correspondente. Diffs por acréscimo mergeiam
mecanicamente.

### Faixas de ID do ledger (para não conflitar no fecho do array)

```
M0-01: HU-001..009   M1-01: HU-010..019   M1-02: HU-020..029
M1-03: HU-030..049   M1-04: HU-050..059   M1-05: HU-060..069
M1-06: HU-070..079   M2-01..05: HU-080..129 (10 cada)
M3-01..04: HU-130..189 (15 cada)          M4-01..04: HU-190..229
M5-01: HU-230..239   M6-01..04: HU-240..279   M7-01..04: HU-280..319
M8-01..02: HU-320..339                     M9-01: HU-340..349
```

IDs **nunca** são reciclados — o número é citado no código (`// ABERTO HU-nnn`).

## 5.4 Ordem de merge declarada

Não é só o conjunto; é a ordem. Regra prática do playbook, adaptada:
**quem muda o gate mergeia por último**, porque o gate ganha uma etapa nova e
todos os merges anteriores precisam ter passado pelo gate antigo.

```
W1:  M1-06 (typecheck)  →  M1-03 (schema)  →  M1-04 (juiz)  →  M1-05 (changelog)
     →  M1-02 (sonda)   →  M1-01 (gate)                        ← muda o gate: último
W2:  M2-05 → M2-04 → M2-03 → M2-02 → M2-01                     ← CI por último
W3:  M3-01 (validador) → M3-02 (write-set) → M3-04 (propagação) → M3-03 (gate/merge)
W4:  M4-03 (ADR) → M4-01 (pins) → M4-02 (ledger) → M4-04 (governança)
W7:  M7-03 (types) → M7-04 (gêmeos) → M7-01 (app.js) → M7-02 (index.ts)
```

## 5.5 W2 é uma onda de composição — protocolo próprio

**Definição operacional:** onda em que N cards trabalham sobre **o mesmo artefato
entregue por um card anterior**, em vez de N fatias independentes. Detecção
mecânica: um card com out-degree alto cujos consumidores estão *todos* na onda
seguinte. `M1-01` (o gate) tem out-degree 4 → **W2 é composição, por definição.**

Os quatro dispositivos que ela exige e uma onda normal não:

1. **Mapa de propriedade por arquivo** com coluna "os outros: não editam" — acima.
2. **Contratos congelados por escrito, antes:** a interface de `scripts/gate.sh`
   (nomes das etapas, códigos de saída, formato do resumo) é congelada no commit
   PREP da onda. Nenhum dos quatro consumidores a negocia em tempo real.
3. **Faixas de ID disjuntas** — §5.3.
4. **Onda em dois tempos** onde a propriedade colide: `M2-01` (CI) e `M2-02`
   (autoteste) ambos precisam listar as etapas do gate. Rode `M2-02` primeiro,
   mergeie, **só então** `M2-01` — que passa a **ler** a lista do autoteste em vez
   de redigitá-la.

> **Regra.** Onda de composição é um **tipo**, não um acidente. Quem orquestra
> congela o contrato **antes**; dois agentes nunca negociam em tempo real.
> E o commit PREP vai **antes das worktrees**, porque uma worktree materializa
> apenas o que está commitado (§0.1 nº 5) — preparação deixada no checkout
> principal simplesmente não chega no agente.

---

# §6 — Os cards

**Como ler um card.** Cada um traz **Objetivo**, **Dono** (write-set literal),
**Deps** e **Aceitação**. A aceitação obedece a uma regra dura:

> **Todo critério tem de falhar HOJE.** Se ele já passa antes de a tarefa escrever
> a primeira linha, é decorativo. A anotação *"hoje: X"* em cada card é a prova
> disso, e é o que torna o critério falsificável.

E ao menos um critério por onda tem de **falhar por ausência** (o tipo que o resto
não cobre): um arquivo novo sem o cabeçalho derruba, uma etapa nova sem gate
derruba.

## W0 — a raiz

### `M0-01` — Vocabulário, precedência e a tabela de donos 🔴 crítico
- **Objetivo.** Publicar este documento; inserir em `MANIFESTO.md` a nota de
  exceção do planner em runtime (§0.4) e em `AGENTS.md` a regra de precedência por
  domínio. Nenhuma funcionalidade — só vocabulário, para os 31 cards seguintes
  terem o que citar.
- **Dono.** `METODO.md`, `MANIFESTO.md` (uma seção), `MANIFESTO.en.md` (gêmeo),
  `AGENTS.md` (uma seção).
- **Deps.** — (raiz)
- **Aceitação.**
  ```bash
  test -f METODO.md                                              # existe
  rg -q 'Zero planner LLM em runtime' MANIFESTO.md               # o diferencial segue lá
  rg -q 'exceção|exceçao|dev mode' MANIFESTO.md                  # …com a exceção nomeada
  rg -q 'Precedência|precedencia' AGENTS.md                      # regra publicada
  diff <(rg -c '^## ' MANIFESTO.md) <(rg -c '^## ' MANIFESTO.en.md)  # gêmeos em paridade
  ```
  *hoje: as duas primeiras passam, as três últimas falham.*

## W1 — o ferramental de verificação (6 cards, todos independentes)

### `M1-01` — O gate local executável 🔴 crítico
- **Objetivo.** `scripts/gate.sh` com **uma etapa por job**, **três estados**
  (`PASS` / `FAIL` / `NÃO-EXERCITADO`) e a regra **"ferramenta ausente é VERMELHO,
  não pulado"**. Etapas: `typecheck` · `test` · `validate-skills` ·
  `check-acceptance` · `smoke-defaults` · `validate-graph` (anunciada `PENDENTE`
  até W3 existir — gate que ainda não existe é **anunciado**, nunca omitido).
- **Dono.** `scripts/gate.sh`.
- **Deps.** M0-01. **Merge: por último na onda** (muda o gate).
- **Aceitação.**
  ```bash
  bash scripts/gate.sh --list | wc -l          # == 6
  bash scripts/gate.sh                          # exit 0, resumo com estado por etapa
  PATH=/nonexistent bash scripts/gate.sh; test $? -ne 0   # ferramenta ausente = VERMELHO
  rg -q 'PENDENTE' <(bash scripts/gate.sh --list)         # gate futuro é anunciado
  ```
  *hoje: `scripts/gate.sh` não existe. **O terceiro critério é o que importa** —
  é ele que distingue este gate de um script que imprime "skipped".*

### `M1-02` — Sonda negativa da suíte
- **Objetivo.** `scripts/check-acceptance.ts`: dado um seletor de teste, exige que
  ele case **≥1** teste (por descoberta, sem executar); **sonda negativa** — um
  seletor impossível *tem de* casar 0; **zero arquivos parseados = falha**, nunca
  verde ("o formato mudou e este verificador ficou cego").
- **Dono.** `scripts/check-acceptance.ts` + `scripts/check-acceptance.test.ts`.
- **Deps.** M0-01.
- **Aceitação.**
  ```bash
  npx tsx scripts/check-acceptance.ts --selector 'requeue'      # exit 0, imprime N>=1
  npx tsx scripts/check-acceptance.ts --selector 'ZzNaoExiste'  # exit != 0
  npx tsx scripts/check-acceptance.ts --root /tmp/vazio         # exit != 0 (cego = vermelho)
  ```
  *hoje: nenhum dos três roda. A sonda negativa existe porque, se uma regressão do
  runner fizer a descoberta ignorar o seletor, **todo** card passaria.*

### `M1-03` — `WorkStep.accept`: o lugar onde mora a aceitação executável 🔴 crítico
- **Objetivo.** Introduzir `accept?: { command: string; expectExit?: number; cwd?:
  'worktree' | 'integration' }` no tipo **e** no schema **e** no
  `assistant-schema` (senão o Architect não emite e o parse **descarta o campo em
  silêncio** — modo de falha já registrado em
  `editing-default-pipelines/LEARNINGS.md:12`). **Sem enforcement** — ele é o
  `M2-03`. Este card entrega a costura.
- **Dono.** `src/lib/types.ts`, `src/lib/pipeline-io.ts`,
  `src/lib/assistant-schema.ts`. **Singleton: dono exclusivo na onda.**
- **Deps.** M0-01.
- **Aceitação.**
  ```bash
  npm run typecheck
  npx vitest run -t 'accept'      # >=1 teste; round-trip: parse preserva o campo
  npx tsx -e "import{parsePipelineFromJson}from'./src/lib/pipeline-io.js';\
    const p=parsePipelineFromJson(JSON.stringify({name:'x',steps:[{name:'a',prompt:'p',\
    accept:{command:'true',expectExit:0}}]}));\
    if(!p.steps[0].accept)throw new Error('campo descartado no parse')"
  ```
  *hoje: o terceiro comando lança — o campo não existe e o Zod **strip** o
  descarta sem erro. É esse silêncio que o teste de round-trip mata.*

### `M1-04` — A linha que devolve o contrato report-only 🔴 crítico
- **Objetivo.** Em `reportJudgeCondition()`, trocar
  `git status --porcelain` por `git diff --name-only $baseCommit..HEAD` e anexar a
  cláusula fail-closed copiada de `huu-test-suite.ts:343`. Regenerar os 5 JSONs.
- **Dono.** `src/lib/default-pipelines/knowledge-protocol.ts`,
  `pipelines/huu-{security,quality,docs,performance,refactor}-audit.pipeline.json`.
- **Deps.** M0-01.
- **Aceitação.**
  ```bash
  rg -q 'baseCommit\.\.HEAD' src/lib/default-pipelines/knowledge-protocol.ts
  rg -L 'baseCommit\.\.HEAD' pipelines/*audit*.pipeline.json    # saída VAZIA
  rg -c 'git status --porcelain' src/lib/default-pipelines/knowledge-protocol.ts  # == 0
  npx vitest run -t 'registry'                                   # segue verde
  ```
  *hoje: o 1º e o 3º falham. **O 2º é o critério que falha por ausência** — um
  pipeline de auditoria novo sem a cláusula derruba a linha, o que nenhum teste de
  presença faria.*

### `M1-05` — Fragmentos de CHANGELOG: matar o conflito garantido
- **Objetivo.** `.changes/<card>.md` (um fragmento por card) + `scripts/changelog.ts`
  que consolida na seção `[Unreleased]` **depois** do merge, pelo orquestrador.
  `CHANGELOG.md` deixa de ser tocado por worktree nenhuma. É o arquivo mais
  tocado do repositório (82 commits, §3) e o conflito é estrutural, não azar.
- **Dono.** `.changes/**`, `scripts/changelog.ts`, `CHANGELOG.md` (só o contrato).
- **Deps.** M0-01.
- **Aceitação.**
  ```bash
  npx tsx scripts/changelog.ts --check     # exit 0; falha se um .changes/*.md estiver malformado
  test -f .changes/README.md               # o contrato do formato está escrito
  npx tsx scripts/changelog.ts --dry-run | rg -q 'Unreleased'
  ```
  *hoje: nada disso existe. Custo total ≈ 40 linhas de script + um diretório —
  contra uma onda de retrabalho por conflito. **Prepare demais.***

### `M1-06` — Typecheck honesto
- **Objetivo.** Fechar o buraco do §0.1 nº 4: o cliente web (12 módulos,
  `app.js` com 3.723 linhas) e todo o `scripts/` estão **fora** do `tsc`.
  Adicionar `tsconfig.client.json` com `allowJs` + `checkJs` (JSDoc onde
  necessário) e remover `scripts` do `exclude`. `npm run typecheck` passa a rodar
  os dois projetos.
- **Dono.** `tsconfig.json`, `tsconfig.client.json`, `package.json`.
  **Singleton.**
- **Deps.** M0-01.
- **Aceitação.**
  ```bash
  npm run typecheck                                   # cobre src/** E scripts/**
  npx tsc -p tsconfig.client.json --noEmit            # exit 0
  node -e "const t=require('./tsconfig.json');\
    if((t.exclude||[]).includes('scripts'))throw new Error('scripts ainda excluido')"
  rg -q 'checkJs' tsconfig.client.json
  ```
  *hoje: o 2º, 3º e 4º falham. Nota honesta: o `card-state.js` (espelho web do
  `card-state.ts`, que o `AGENTS.md:200` manda manter "in lockstep") só tem os
  testes gêmeos como guarda; com `checkJs` ele ganha a segunda rede.*

### `W1.5` — infra, **sem worktree**, no branch principal
- **Objetivo.** `git config core.hooksPath .githooks` e o `pre-push` passando a
  chamar `scripts/gate.sh`. **Exige a máquina do humano** (é configuração local de
  clone, não conteúdo versionável) — por isso é onda fracionária: encaixa entre
  W1 e W2 sem renumerar nada.
- **Aceitação.**
  ```bash
  test "$(git config core.hooksPath)" = ".githooks"
  rg -q 'scripts/gate.sh' .githooks/pre-push
  ```
  *hoje: o 1º falha (não configurado — §0.3) e o 2º falha.*

## W2 — composição sobre o gate (5 cards, protocolo do §5.5)

### `M2-01` — CI mínima, e o gate lê a definição dela
- **Objetivo.** `.github/workflows/gate.yml` rodando `scripts/gate.sh`. E a
  **fonte única**: o gate local **lê** a lista de jobs do YAML em vez de duplicá-la
  — duas listas mantidas à mão recriam o mesmo buraco do outro lado. Espelhamento
  bidirecional é ele próprio um invariante (`M2-02` o testa).
- **Dono.** `.github/**`, `scripts/gate.sh` (só a função de leitura do CI).
- **Deps.** M1-01, M2-02. **Merge: por último.**
- **Aceitação.**
  ```bash
  bash scripts/gate.sh --list > /tmp/local.txt
  npx tsx scripts/ci-jobs.ts  > /tmp/ci.txt      # extrai os jobs do YAML
  diff /tmp/local.txt /tmp/ci.txt                 # idênticos
  ```
  *hoje: não existe `.github/`. Este é o card que muda a natureza do §7: com CI
  vivo, o gate local deixa de **ser** o pipeline e passa a **espelhá-lo**.*

### `M2-02` — Autoteste adversarial de cada verificador
- **Objetivo.** Um verificador que só sabe dizer OK é um comentário com exit 0.
  Para cada validador (`gate.sh`, `check-acceptance`, `validate-skills`,
  `validate-graph`, `check-pins`), N mutações **calculadas do documento corrente,
  nunca literais** (literal vira no-op no próximo merge, e o autoteste passa a
  ensinar que pode ser ignorado), e **cada caso asserta a MENSAGEM, não o código de
  saída** — porque exit≠0 não distingue "acusou" de "quebrou".
- **Dono.** `scripts/selfcheck/**`.
- **Deps.** M1-01, M1-02.
- **Aceitação.**
  ```bash
  bash scripts/selfcheck/run.sh                    # exit 0 e imprime "N mutações, N acusadas"
  bash scripts/selfcheck/run.sh --list | wc -l     # >= 12
  rg -c "'" scripts/selfcheck/mutations.ts         # nenhuma mutação literal hardcoded
  ```
  *hoje: nada existe. Sem este card, os cinco validadores do plano podem estar
  quebrados e verdes.*

### `M2-03` — Enforcement do `accept`, fora de qualquer agente 🔴 crítico
- **Objetivo.** Executar `WorkStep.accept.command` **pós-merge**, em código, e
  comparar o exit com `expectExit`. É a primeira aceitação do sistema que não é
  auto-reportada por um LLM. É literalmente o gate que
  `huu-test-suite.ts:39-43` diz que falta: *"A future orchestrator-level
  deterministic gate … run post-merge, outside any agent."*
- **Dono.** `src/orchestrator/accept-gate.ts` (+ o ponto de chamada em
  `index.ts`, ~10 linhas).
- **Deps.** M1-03, M1-01.
- **Aceitação.**
  ```bash
  npx vitest run -t 'accept-gate'          # >=1 teste
  # negativo: accept com expectExit 0 e comando `false` DEVE reprovar o step
  npx vitest run -t 'accept-gate reprova'  # o caso vermelho existe e passa
  ```
  *hoje: `accept` não existe (M1-03) e nada o executa. **O segundo critério é o
  que impede este card de virar decoração**: um gate que nunca reprovou em teste
  não é gate.*

### `M2-04` — Sonda negativa dos juízes 🔴 crítico
- **Objetivo.** Provar que cada condição de `CheckStep` **consegue** dizer
  `rework`. Duas camadas: (a) `judge-conditions.test.ts` assertando que toda
  condição de auditoria contém uma cláusula `$baseCommit..HEAD`, uma frase
  fail-closed e **nenhuma** cláusula `git status` inválida; (b) extrair as
  cláusulas mecânicas para uma função pura `evaluateReportContract(dir)` e
  testá-la contra **fixtures deliberadamente quebradas** (seção faltando,
  contagem do FAQ divergente, uma edição de fonte contrabandeada).
- **Dono.** `src/lib/default-pipelines/judge-conditions.test.ts`,
  `src/lib/default-pipelines/report-contract.ts` + fixtures.
- **Deps.** M1-04.
- **Aceitação.**
  ```bash
  npx vitest run -t 'judge-conditions'          # >=1 teste
  npx vitest run -t 'report-contract rejeita'   # a fixture quebrada REPROVA
  rg -L 'baseCommit' src/lib/default-pipelines/*audit*.ts   # saída vazia (por ausência)
  ```
  *hoje: **nenhum teste no repositório prova que um juiz pode dizer não** (§4.1
  A2). Este card é a resposta direta a isso.*

### `M2-05` — Ligar o `validate-skills.sh` e fechar o vocabulário
- **Objetivo.** Pôr o único gate mecânico da biblioteca dentro do `npm test`
  (via um `skills-library.test.ts` que faz shell-out), corrigir as **2 falhas
  vivas**, e acrescentar: regex de vocabulário fechado da entrada de LEARNINGS,
  TTL de frescor (`warn >30d`, `fail >90d` no rodapé "Facts verified"), e um grep
  dos nomes de backend contra `registry.ts`.
- **Dono.** `src/lib/skills-library.test.ts`,
  `.agents/skills/meta-skill-consolidate/scripts/validate-skills.sh`.
- **Deps.** M1-01.
- **Aceitação.**
  ```bash
  npx vitest run -t 'skills-library'                              # >=1 teste, VERDE
  bash .agents/skills/meta-skill-consolidate/scripts/validate-skills.sh   # exit 0
  # negativo: uma skill com [source:agent] no lugar do vocabulário DEVE reprovar
  npx vitest run -t 'skills-library vocabulario'
  ```
  *hoje: o validador **existe, não está ligado a nada e está vermelho** (A11).
  Um gate novo que ninguém conecta não fica vermelho — fica invisível.*

### `M2-06` — Pinar os quatro invariantes que sobreviveram à mutação 🔴 crítico
- **Objetivo.** O §4.6 mediu quatro invariantes deletáveis em silêncio. Este card
  escreve os testes que os matam, **e o teste de mutação que prova que os testes
  matam**:
  (a) **`maxNodeExecutions`** — pipeline stub com outcome apontando para trás e
  `maxNodeExecutions: 3`, assertando `status === 'error'` **e a mensagem**, nos
  **dois** caminhos (cursor linear `index.ts:1460` e ondas `:3496`);
  (b) **ordem de merge** — `integration-merge.test.ts` (arquivo que **não existe**)
  chamando `mergeAgentBranches` com o array **embaralhado** e assertando a ordem
  ascendente de `onBranchMerged`, sem depender de fixture de falha;
  (c) **`default: true` exatamente um** — fixture com **dois** defaults reprova
  (hoje só o caso de zero é coberto);
  (d) **never-rewind** — capturar o SHA do branch de integração antes e depois de
  uma re-visita de loop e assertar que o commit anterior segue ancestral.
- **Dono.** `src/orchestrator/max-node-executions.test.ts`,
  `src/git/integration-merge.test.ts`, `src/lib/pipeline-io.test.ts` (só o caso
  novo), `src/orchestrator/check-runs.test.ts` (só o caso novo).
- **Deps.** M1-02 (a sonda garante que os seletores casam), M2-02.
- **Aceitação.**
  ```bash
  npx tsx scripts/check-acceptance.ts --selector 'maxNodeExecutions'  # >=1 teste
  npx vitest run src/git/integration-merge.test.ts                    # arquivo novo, verde
  npx vitest run -t 'never rewinds'
  bash scripts/selfcheck/run.sh --mutations invariantes  # as 4 mutações do §4.6 morrem
  ```
  *hoje: os quatro invariantes são deletáveis com a suíte verde — medido.*

### `M2-07` — Higiene de suíte: o que pode encolher sem nada ficar vermelho
- **Objetivo.** Quatro correções pequenas, todas da família "ausência não falha":
  (a) **cobertura passa a existir** — `@vitest/coverage-v8` + threshold **que
  começa no valor medido hoje** (não num número aspiracional) e só sobe; sem isso
  a cobertura não pode regredir porque não existe;
  (b) **piso de contagem de testes** — um `posttest` que lê o reporter JSON e
  reprova abaixo do piso, matando o `-t` sem casar (A13) na raiz;
  (c) `.huu-worktrees/` e `webui/` entram no `exclude` do vitest (A21), com o
  motivo escrito ao lado, como já está feito para `dist/**`;
  (d) `scripts/deploy.ts` passa a rodar a suíte de smoke antes do push (A23), e a
  contradição entre `AGENTS.md:437` e `releasing-versions/SKILL.md:50` é resolvida
  num sentido só.
- **Dono.** `vitest.config.ts`, `package.json` (coordenar com M1-06 — **mesmo
  arquivo, sequenciar dentro da onda**), `scripts/deploy.ts`,
  `.agents/skills/releasing-versions/SKILL.md`.
- **Deps.** M1-01, M1-06.
- **Aceitação.**
  ```bash
  npx vitest run --coverage                       # produz relatório e respeita o threshold
  npm test -- -t 'ZzNaoExiste'                    # exit != 0  (HOJE SAI 0 — A13)
  rg -q 'huu-worktrees' vitest.config.ts
  rg -q 'smoke' scripts/deploy.ts
  ```
  *hoje: o 1º e o 4º não existem; **o 2º sai 0** — é a linha mais barata do plano
  inteiro com o maior efeito sobre falso-verde.*

## W3 — grafo e propriedade de arquivo (4 cards) 🔴 o coração do plano

### `M3-01` — O `Orchestrator` valida o próprio grafo 🔴 crítico
- **Objetivo.** Duas coisas. (a) `Orchestrator.start()` chama
  `validateTopology(this.pipeline)` antes do switch de modo — hoje ele **nunca**
  chama, e os 6 sítios que constroem `Pipeline` em código (**incluindo o dev
  mode**, que declaradamente "quebra ciclos dropando arestas, warn, never fail")
  passam sem validação. **~4 linhas, fecha uma classe inteira.**
  (b) `scripts/validate-graph.ts` com o que o `validateTopology` **não** checa:
  alcançabilidade a partir do step 0, órfãos, monotonia de onda vs ordem do array,
  step inalcançável depois do roteamento de outcome, caminho crítico publicado ==
  recalculado, e largura da onda vs capacidade do pool.
- **Dono.** `src/orchestrator/index.ts` (só a chamada), `scripts/validate-graph.ts`
  + teste.
- **Deps.** M1-01.
- **Aceitação.**
  ```bash
  npx vitest run -t 'validateTopology no start'    # >=1 teste
  # negativo: um pipeline com dependsOn desconhecido construído EM CÓDIGO deve lançar
  npx vitest run -t 'start recusa grafo invalido'
  npx tsx scripts/validate-graph.ts pipelines/*.pipeline.json   # exit 0
  ```
  *hoje: os três falham.*

### `M3-02` — `WorkStep.writes` + disjunção intra-onda 🔴 crítico
- **Objetivo.** Declarar o write-set (`writes?: string[]`, globs) e verificá-lo em
  **dois** momentos: (a) estático — dois steps da mesma onda com write-sets que se
  interceptam **reprovam** na validação; (b) runtime — antes do merge da etapa,
  construir `Map<path, agentId[]>` a partir dos `filesModified` que
  `runStageIntegration` **já tem na mão** (`index.ts:2917`) e acusar todo caminho
  com ≥2 escritores. Estende a regra que já existe para `produces`
  (`pipeline-io.ts:166-180`) a **todos** os arquivos.
- **Dono.** `src/lib/pipeline-io.ts` (campo + refine), `src/orchestrator/write-sets.ts`
  + o ponto de chamada.
- **Deps.** M1-03, M3-01.
- **Aceitação.**
  ```bash
  npx vitest run -t 'write-set'                        # >=1 teste
  npx vitest run -t 'write-set sobreposto reprova'     # o caso vermelho existe
  npx vitest run -t 'dois agentes mesmo arquivo'       # detecção cruzada pré-merge
  ```
  *hoje: **não existe onde declarar**, e nada compara agente com agente (§4.2).
  Este card converte em máquina a frase que `docs/dev-mode.md:250` já publica como
  garantia.*

### `M3-03` — Gate depois de CADA merge
- **Objetivo.** `mergeAgentBranches` ganha um hook opcional
  `verify?: (worktreePath, branch) => Promise<{ok, output}>`, plumbado de um
  `Pipeline.mergeGate` (string de comando). Vermelho ⇒ `git reset --hard HEAD~1`
  na worktree de integração (o **único** rewind defensável do sistema: desfaz
  apenas o commit de merge que o próprio huu acabou de criar) e o branch é marcado
  `mergeFailed` — estado que o kanban **já sabe renderizar** em âmbar
  (`card-state.ts`). A bissecção é o produto: com um merge dentro, o vermelho
  **nomeia o card**.
- **Dono.** `src/git/integration-merge.ts`, `src/lib/pipeline-io.ts` (só o campo
  `mergeGate`).
- **Deps.** M1-01, M2-03.
- **Aceitação.**
  ```bash
  npx vitest run -t 'integration-merge'            # >=1 teste — HOJE NAO EXISTE ARQUIVO DE TESTE
  npx vitest run -t 'mergeGate vermelho reverte'   # o caso vermelho existe
  npx vitest run -t 'mergeGate nomeia o branch'
  ```
  *hoje: **`integration-merge.ts` não tem arquivo de teste nenhum** — o módulo que
  implementa a barreira central do MANIFESTO é o menos testado do caminho crítico.*

### `M3-04` — Propagação de falha (o `done` que mente)
- **Objetivo.** `runStageIntegration` devolve resultado discriminado com
  `producedCount`/`failedCount`; step com zero trabalho produzido entra num
  conjunto `failed` que o `computeWave` trata como **não satisfeito** (com opt-out
  explícito para steps genuinamente opcionais); e `ready.length === 0` com
  `pending` não-vazio vira `recordRunError` listando os steps pulados, **não**
  `warn` + `status: 'done'`.
- **Dono.** `src/orchestrator/index.ts` (`runStageIntegration` + `runDagWaves`),
  `src/orchestrator/wave-scheduler.ts`.
- **Deps.** M3-01.
- **Aceitação.**
  ```bash
  npx vitest run -t 'dependencia falhou'      # dependente NAO roda
  npx vitest run -t 'steps pulados = erro'    # run termina em 'error', nao 'done'
  npx vitest run -t 'wave-scheduler check preempta'  # o check nao passa na frente de work
  ```
  *hoje: nenhum teste cobre "uma etapa onde uma task falhou" (a busca nos 37
  arquivos de teste do orquestrador é negativa). Inclui o bônus do
  `wave-scheduler.ts:73-77`: um `CheckStep` pronto **em qualquer posição**
  preempta a onda inteira, inclusive work steps que vêm ANTES dele no array — e a
  própria docstring promete o contrário.*

## W4 — memória, incerteza e decisão (4 cards)

### `M4-01` — Pin conteúdo-endereçado
- **Objetivo.** `arquivo:linha@sha1` gerado **por script, jamais à mão**
  (`scripts/pin.ts`, que imprime a citação **e o conteúdo da linha** para você
  confirmar antes de afirmar) + `scripts/check-pins.ts` que recomputa o sha1 e
  **rejeita a forma degenerada** (pin sem caminho, pin sem hash). Reimplementar o
  hash conta como escrever à mão: um helper que gera e confere com ele mesmo
  reporta 100% correto e só quebra quando alguém roda o script real.
- **Dono.** `scripts/pin.ts`, `scripts/check-pins.ts` + teste.
- **Deps.** M1-01.
- **Aceitação.**
  ```bash
  npx tsx scripts/check-pins.ts                  # exit 0; imprime "N pins, 0 derivas"
  npx tsx scripts/check-pins.ts --fixture degenerado   # exit != 0 (rejeita pin sem caminho)
  npx tsx scripts/pin.ts src/lib/types.ts:1     # imprime pin + a linha citada
  ```
  *hoje: 4 de 14 citações da biblioteca resolvem (29%), 5 afirmam comportamento
  deletado, e **nada** detecta isso. O hash prova que a linha não mudou — nunca
  que ela sustenta a afirmação; por isso o §8 pede o eval também.*

### `M4-02` — Ledger de incerteza, verde desde o dia 1
- **Objetivo.** `.agents/ledger/` com os cinco campos que valem (a pergunta · por
  que o código não responde · o que se assumiu · **o teste executável que fecha** ·
  **o que quebra se a resposta for outra**), inbox por card, faixas de ID (§5.3),
  âncora `// ABERTO HU-nnn` no ponto exato da suposição, e um validador **no gate
  desde já, verde com tudo aberto** — *ferramenta que estreia no dia do fechamento
  é ferramenta que falha no dia do fechamento*. Sem os dois últimos campos, é um
  TODO. Fechar é mais regulado que abrir: evidência tem forma verificável por
  regex + **lista negra** que rejeita `"ok"`, `"conferido"`, `"conforme
  combinado"`.
- **Dono.** `.agents/ledger/**`, `scripts/validate-ledger.ts` + teste.
- **Deps.** M1-01.
- **Aceitação.**
  ```bash
  npx tsx scripts/validate-ledger.ts             # exit 0 com tudo ABERTO
  npx tsx scripts/validate-ledger.ts --fixture fechado-sem-evidencia   # exit != 0
  rg -o 'ABERTO HU-[0-9]+' -g '!.agents/ledger' src | sort -u | \
    npx tsx scripts/validate-ledger.ts --anchors-from -   # toda âncora tem item
  ```
  *hoje: não existe. O item que importa mais: **"CONFIRMADO sem evidência anexada
  é pior que ABERTO"** — ele para de ser reperguntado e vira premissa invisível.*

### `M4-03` — ADRs com guarda executável
- **Objetivo.** `docs/adr/` no formato do Apêndice C (com os campos
  `Guarda executável`, `Supera`, `Reafirma explicitamente`, `O que o sign-off NÃO
  autoriza`) e os **três primeiros ADRs**, que são as três decisões que este
  documento levanta e não pode tomar sozinho: (1) o planner em runtime do dev mode
  vs. o diferencial nº 2 do MANIFESTO; (2) `types.ts` como fonte única de tipos vs.
  o custo medido de singleton (§3); (3) o `default: true` forward dos juízes —
  mantido, com o risco escrito e a mitigação nomeada (`M2-04`).
- **Dono.** `docs/adr/**`.
- **Deps.** M0-01.
- **Aceitação.**
  ```bash
  ls docs/adr/*.md | wc -l                       # >= 3
  rg -L 'Guarda executável' docs/adr/*.md        # saída VAZIA (por ausência)
  bash -c "$(rg -o 'Guarda executável: \`(.+)\`' -r '$1' docs/adr/0003-*.md)"  # a guarda roda
  ```
  *hoje: não existe `docs/adr/`. **Se você não consegue escrever a guarda, a
  decisão é uma intenção.***

### `M4-04` — Governança da biblioteca de conhecimento
- **Objetivo.** Cinco edições cirúrgicas, cada uma respondendo a um achado medido:
  (a) **deletar** de `skill-template.md:43` a permissão de escrever no corpo da
  SKILL.md — e a mesma linha copiada nas 8 skills de tarefa — restaurando "um
  escritor por superfície"; (b) purgar `copilot` do corpo, da **`description` do
  frontmatter** e do `catalog.md`; (c) reescrever a seção `decideReexec` de
  `running-in-docker` (3 ramos, não 7) copiando o texto correto de
  `AGENTS.md:121-126`; (d) rodar `meta-skill-consolidate` **de verdade** uma vez:
  resolver as 15 cadeias `SUPERSEDES` em `[superseded]`, promover os 5-8
  candidatos, cortar as 4 caudas "N testes verdes"; (e) separar
  `JOURNAL.md` (descartável, episódico) de `LEARNINGS.md` (permanente, uma regra
  destilada por entrada) — o split que o huu **já usa no próprio produto**
  (`AGENTS.md:326`: huu owns `goal.md` + `state.json`; agents own `journal.md`).
- **Dono.** `.agents/skills/**`.
- **Deps.** M2-05, M4-01.
- **Aceitação.**
  ```bash
  rg -c 'distill it into this SKILL.md body' .agents/skills   # == 0
  rg -c 'copilot' .agents/skills                              # == 0
  rg -c 'HUU_NO_DOCKER=1' .agents/skills/running-in-docker/SKILL.md  # == 0
  npx vitest run -t 'skills-library'                          # segue verde
  test "$(rg -c 'superseded' .agents/skills | wc -l)" -gt 0   # a maquina de estados tem arestas
  ```
  *hoje: os cinco falham.*

## W5 — o neck (1 card, sozinho de propósito)

### `M5-01` — `AGENTS.md` volta a ser roteador
- **Objetivo.** 520 → ~120 linhas. **72% do conteúdo (≈375 linhas) é duplicata
  de skills que carregam sob demanda** — e é por isso que ele deriva numa direção
  *diferente* da skill (medido: `:134` reserva do SO, `:158` gatilho do guard,
  `:279` `MAX_CONCURRENT_RUNS` que tem **0 ocorrências em `src/`**, `:502`
  `maxRuns` default 5 que **não existe**). Mover cada bloco para a skill dona
  (tabela pronta na auditoria), corrigir as 5 afirmações stale, e **apagar a
  contagem de skills** — a defesa certa já está escrita no próprio arquivo
  (`:55`: *"The catalog is canonical — consult it, not this paragraph"*).
  Economia medida: **~7k tokens em toda sessão**.
- **Dono.** `AGENTS.md`. **Onda sozinha: 34 commits já tocaram este arquivo.**
- **Deps.** M4-04 (as skills têm de receber a prosa antes).
- **Aceitação.**
  ```bash
  test "$(wc -l < AGENTS.md)" -le 140
  rg -c 'MAX_CONCURRENT_RUNS' AGENTS.md          # == 0
  rg -c 'maxRuns.*default 5|default 5.*maxRuns' AGENTS.md   # == 0
  rg -q 'catalog.md' AGENTS.md                    # o roteamento sobrevive
  npx vitest run -t 'skills-library'              # a prosa migrada não quebrou nada
  ```
  *hoje: 520 linhas; os dois greps do meio acusam.*

## W6 — dev mode (4 cards)

### `M6-01` — Partição de write-set no dev mode 🔴 crítico
- **Objetivo.** A garantia que `docs/dev-mode.md:250-253` **publica como
  enforçada** e que ninguém enforça. O parser já existe
  (`parseOwnedPaths`, `review-agent.ts:484-502`): rodá-lo sobre **todos** os specs
  de uma etapa e recusar (ou avisar duro) quando a união não é disjunta — entre
  tasks de um front **e** entre fronts da mesma onda. É função pura sobre dados que
  já estão em disco.
- **Dono.** `src/lib/dev-mode/write-partition.ts` + chamada no `dev-driver.ts`.
- **Deps.** M3-02.
- **Aceitação.**
  ```bash
  npx vitest run -t 'write-partition'                  # >=1 teste
  npx vitest run -t 'dois specs mesmo arquivo recusa'  # o caso vermelho existe
  ```
  *hoje: nada compara caminho entre tasks (§4.2).*

### `M6-02` — `verifyCommands` deixa de ser código morto
- **Objetivo.** `ReviewSpec.verifyCommands` — que o próprio tipo descreve como
  *"the project's real gate … Running first and opining second is what keeps the
  loop anchored to something executable"* (`types.ts:212-219`) — **nunca é
  populado por nenhum caller de produção**. Ligar a resposta do gap
  `build-test-commands` (que a Fase A **já pergunta**) em
  `CompileEpochOptions.verifyCommands`. Sem isso, todo crítico do dev mode roda o
  *fallback*: comandos nomeados por um atlas escrito por LLM, num arquivo que pode
  ele mesmo ter falhado no merge.
- **Dono.** `src/lib/dev-mode/plan-to-pipeline.ts`, `dev-driver.ts`.
- **Deps.** M1-03, M2-03.
- **Aceitação.**
  ```bash
  npx vitest run -t 'verifyCommands populado'
  rg -c 'verifyCommands' src/lib/dev-mode/dev-driver.ts   # > 0
  ```
  *hoje: o grep devolve 0 — o campo só aparece na declaração, no pass-through e em
  testes.*

### `M6-03` — Honestidade do fim de época
- **Objetivo.** Três correções pequenas com o mesmo alvo (A5/A6): (a) **consumir**
  `alreadyUpToDate` — uma época que aterrissou nada não é uma época aterrissada;
  (b) `goalComplete` exige corroboração (no mínimo: recusar na época 1) e o
  **diff de `doneWhen`** é impresso no portão de aprovação, porque hoje
  `state.doneWhen = plan.doneWhen` é sobrescrita incondicional e a trave é julgada
  contra o valor que a mesma chamada acabou de escrever; (c) `restatedGoal` — o
  "detector de deriva" documentado — passa a ser **exibido** no gate ou é
  removido; hoje é coletado e nunca lido.
- **Dono.** `src/lib/dev-mode/dev-driver.ts`, `dev-cli.ts`, `epoch-landing.ts`.
- **Deps.** M0-01.
- **Aceitação.**
  ```bash
  npx vitest run -t 'alreadyUpToDate'              # epoca no-op NAO conta como landed
  npx vitest run -t 'goalComplete epoca 1 recusa'
  npx vitest run -t 'doneWhen diff no gate'
  ```
  *hoje: os três falham; `alreadyUpToDate` é lido por **nada** no repositório.*

### `M6-04` — Observabilidade: o que não pode se perder
- **Objetivo.** (a) Flush periódico do `RunManifest` (a cada merge) — transforma
  "irrecuperável" em "recuperável à mão", que é os 80% baratos; (b) corrigir
  `working-on-orchestrator/SKILL.md:70`, que afirma o oposto do código;
  (c) `journal.md` entra em `HUU_OWNED_PATHS` (hoje o huu nunca o commita nem o
  diffa, e ele é o arquivo que a mensagem de `max-epochs` manda o operador ler);
  (d) o `.gitignore` para de ser varrido pro commit `chore(huu-dev)` com
  `--no-verify` sem ser diffado contra o HEAD.
- **Dono.** `src/lib/run-logger.ts`, `src/orchestrator/index.ts` (só a chamada de
  flush), `src/lib/dev-mode/dev-state.ts`,
  `.agents/skills/working-on-orchestrator/SKILL.md`.
- **Deps.** M1-01.
- **Aceitação.**
  ```bash
  npx vitest run -t 'manifest flush incremental'   # manifesto existe em disco MEIO run
  rg -c 'written incrementally' .agents/skills/working-on-orchestrator/SKILL.md  # == 0
  npx vitest run -t 'gitignore nao entra sem diff'
  ```
  *hoje: um SIGKILL no meio de uma etapa deixa **zero** artefato em `.huu/`.*

## W7 — quebrar os singletons (4 cards)

Cada card aqui **compra paralelismo futuro**. O critério de aceitação é o mesmo
padrão: nenhum arquivo do domínio acima de um teto, e o comportamento intacto.

### `M7-01` — `src/web/client/app.js` (3.723 linhas, 46 toques) → módulos por tela
- **Aceitação.** `test "$(wc -l < src/web/client/app.js)" -le 400` · nenhum módulo
  novo > 400 linhas · `npx tsc -p tsconfig.client.json --noEmit` verde (depende de
  M1-06 — hoje **nada** typecheca este arquivo) · `npx vitest run -t 'client'`.
- **Deps.** M1-06, M3-02.

### `M7-02` — `src/orchestrator/index.ts` (3.815 linhas, ~20 responsabilidades)
- **Objetivo.** Extrair, em módulos com dono: guard/pause/requeue, o review loop,
  o wave driver, o finalize. É 34% de todo o código não-teste do orquestrador.
- **Aceitação.** `test "$(wc -l < src/orchestrator/index.ts)" -le 900` ·
  `npx vitest run` (414 casos do orquestrador seguem verdes) · nenhum novo módulo
  sem teste irmão.
- **Deps.** M3-04, M3-03.

### `M7-03` — `src/lib/types.ts` → barrel por domínio
- **Objetivo.** Singleton **por decreto** (§3): a convenção manda tipo novo aqui,
  logo todo card serializa. Quebrar em `types/` por domínio, re-exportado por
  `types.ts`. **Exige o ADR de M4-03** — a convenção é normativa.
- **Aceitação.** `test "$(wc -l < src/lib/types.ts)" -le 120` (só re-exports) ·
  `npm run typecheck` · `rg -q '0002' docs/adr/` (o ADR existe) · guarda executável
  do ADR roda.
- **Deps.** M4-03.

### `M7-04` — Paridade dos gêmeos, por script
- **Objetivo.** Três pares de gêmeos hoje mantidos à mão: `README.md`/`README.en.md`
  (53+45 toques), `docs/*.md`/`docs/*.pt-BR.md` (12 pares), e
  `card-state.ts`/`card-state.js` (o espelho web que o `AGENTS.md` manda manter
  "in lockstep"). Um script de paridade **estrutural** (contagem e ordem de
  cabeçalhos; para o par de código, os nomes exportados).
- **Aceitação.** `npx tsx scripts/check-twins.ts` exit 0 · com um cabeçalho a mais
  num gêmeo, exit ≠ 0 · o script entra no `gate.sh --list`.
- **Deps.** M1-01.

## W8 — dogfooding (2 cards, folga 5 — antecipe se quiser encurtar)

### `M8-01` — O huu roda o huu no CI do huu
- **Objetivo.** `docs/ci.md` (245 linhas) ensina, com receita pronta de GitHub
  Actions, a rodar as auditorias do huu em CI — num repositório **sem `.github/`**.
  Ligar `huu Docs Audit` + `huu Quality Audit` num agendamento semanal, com os
  relatórios como artifact.
- **Aceitação.** `ls .github/workflows/huu-*.yml` · o job existe e o `jq -e '.ok ==
  true'` do próprio `docs/ci.md` está lá · o relatório aparece em `.huu/audits/`.
- **Deps.** M2-01, M1-04 (auditar com o juiz consertado, senão o relatório é
  aprovado por um comando que não pode falhar).

### `M8-02` — `huu Test Suite` contra os maiores arquivos sem teste
- **Objetivo.** Usar o pipeline default no próprio repo, mirando os 10 maiores
  módulos de `src/` sem teste irmão. Mede duas coisas de uma vez: cobertura real e
  a qualidade do próprio pipeline.
- **Aceitação.** `npx tsx scripts/untested.ts --top 10` (o script lista) · depois
  da run, a lista encurta · `npm test` verde · **e** o `check-acceptance` prova que
  cada teste novo casa ≥1 seletor (senão o pipeline entregou arquivo, não teste).
- **Deps.** M1-02, M2-01.

## W9 — o join

### `M9-01` — Estado derivado + catálogo de falso-verde vivo
- **Objetivo.** (a) Um script que **deriva** os números do §1 e do §3 deste
  documento do repositório e **falha se a prosa discordar**, imprimindo o texto que
  ela deveria carregar — todo número que aparece em prosa e existe numa fonte
  estruturada é gerado ou conferido, nunca redigitado. Um cabeçalho velho é pior
  que nenhum: é lido com a autoridade de documentação e está errado.
  (b) O Apêndice I (catálogo de falso-verde) vira arquivo vivo, e a pergunta
  *"se isto desaparecer, o que fica vermelho?"* entra no checklist de PR.
- **Dono.** `scripts/check-metodo.ts`, `METODO.md` (só a seção de estado),
  `.github/PULL_REQUEST_TEMPLATE.md`.
- **Deps.** todos (in-degree alto — é o ponto de integração de verdade).
- **Aceitação.**
  ```bash
  npx tsx scripts/check-metodo.ts                 # exit 0
  # negativo: mude um numero do §1 a mao -> exit != 0 e imprime o valor correto
  npx vitest run -t 'check-metodo'
  ```

---

# §7 — Verificação em camadas

As nove camadas do playbook de origem, na ordem em que se constroem, mapeadas
para os cards deste plano. A ordem importa: cada uma pressupõe a anterior.

| # | Camada | Card | Estado hoje |
|---|---|---|---|
| 1 | **Gate local executável antes de qualquer CI** — uma etapa por job, ferramenta ausente = vermelho, resumo com estado por etapa | `M1-01` | ausente (`typecheck && test` à mão, voluntário) |
| 2 | **Fonte única de definição** — o gate local *lê* o CI | `M2-01` | não existe CI |
| 3 | **Invariantes estruturais** sobre o grafo, verificáveis sem executor | `M3-01` | `validateTopology` existe e **o orquestrador não a chama** |
| 4 | **Autoteste adversarial de cada verificador**, rodando *antes* dele, assertando a **mensagem** | `M2-02` | ausente |
| 5 | **Espelhamento bidirecional CI ⇄ gate local**, ele próprio um invariante | `M2-01` | ausente |
| 6 | **Aceitação amarrada a teste real**, com sonda negativa e tripwire | `M1-02` + `M1-03` + `M2-03` + `M2-04` | **não existe campo de aceitação executável no schema** |
| 7 | **Documento de estado derivado**, não escrito à mão | `M9-01` | ausente (e o §1 deste doc é, hoje, prosa redigitada) |
| 8 | **Hooks de máquina** só onde o erro é irreversível ou se auto-amplifica | `M4-04` + `W1.5` | **zero hooks** |
| 9 | **Setup de worktree com preflight** que prova acesso ao insumo | ✅ já existe | `src/git/preflight.ts` — mas sujeira é só **warning**, nunca erro |

## 7.1 A regra dos hooks: separe *nudge* de *gate*

> **Prosa numa skill é conselho; um hook é garantia.**

O huu tem **zero** hooks e duas peças de hook prontas e desligadas
(`check-pending-evolution.sh`, `.githooks/pre-push`). A tentação é ligar tudo. A
regra que evita o desastre:

**Gate mecânico só onde o erro é irreversível ou auto-amplificante** — memória
persistida (uma afirmação falsa numa skill é recuperada como verdade para
sempre), segredo, história do git. **Nudge de contexto para o resto.** E diga, no
próprio arquivo, qual é qual.

Três decisões de projeto que valem copiar literalmente:

1. **Todo hook falha ABERTO.** Um hook quebrado reporta em vez de inutilizar a
   sessão.
2. **Escopo estreito o bastante para não ser desligado.** Uma proteção que dispara
   em trabalho comum acaba desligada, o que é pior que não tê-la. E o corolário:
   ***um gate que só pode ser satisfeito contornando-o ensina a contornar.***
3. **O nudge é honesto sobre si mesmo** — escreve no próprio texto que é lembrete,
   não garantia, e aponta onde vive o enforcement.

Para este repo, os quatro hooks certos são: **gate de escrita da memória** (bloqueia
edição de `SKILL.md` sem token verde de `check-pins` + `validate-skills`, TTL de 30
min — um verde de 30 minutos atrás não autoriza mais uma escrita); **gate de
segurança** (segredo, `git add -A` num repo com dump, comandos destrutivos de
história); **gate de encerramento** (o `check-pending-evolution.sh` que já existe);
e **nudge de roteamento** (~130 tokens repetindo a regra do router, porque
`AGENTS.md` é lido **uma vez** e sai de atenção numa sessão longa).

## 7.2 Como é um critério bom

| | Critério | Por quê |
|---|---|---|
| **Bom** | `rg -L 'baseCommit\.\.HEAD' pipelines/*audit*.json` → saída vazia | falha por **ausência**: um pipeline novo sem a cláusula derruba |
| **Bom** | rodar a captura + `git diff --exit-code <dir>` **+ `git status --porcelain` vazio** | dois oráculos, e o segundo cobre o furo do §0.1 nº 2 |
| **Bom** | `npx vitest run -t 'X reprova'` | prova que o verificador **consegue** dizer não |
| **Fraco** | `npx vitest run -t 'X'` sozinho | passa com zero testes casados (a menos que `M1-02` esteja no gate) |
| **Fraco irredutível** | "pipeline verde (registrar a URL do run)" | não roda localmente; a evidência é uma URL colada à mão |

---

# §8 — Memória e incerteza

## 8.1 As três camadas, e o limite honesto de cada uma

O sistema atual tem **uma** camada (forma: `validate-skills.sh`, desligada). O
plano acrescenta as outras duas, e é importante dizer o que cada uma **não**
prova:

| Camada | Pergunta | Card | O que ela NÃO prova |
|---|---|---|---|
| **forma** | frontmatter, nomenclatura, tamanho, vocabulário fechado, citação presente | `M2-05` | nada sobre o conteúdo |
| **deriva** | a linha citada **ainda é a mesma**? (sha1 recomputado) | `M4-01` | **que a linha sustenta a afirmação** — proveniência detecta deriva, não correção |
| **regressão** | as asserções de fato e de roteamento ainda passam? | `M2-05` (eval de roteamento) | que a afirmação é útil |

> **Regra.** Escreva o eval **antes** da prosa: uma afirmação que não pode ser
> assertada não tem como detectar a própria decadência. E a frase que justifica o
> gate inteiro: ***o agente não é um juiz confiável de se o próprio aprendizado
> está correto. Confiança não é evidência.***

Limpeza e correção são **eixos ortogonais**. Um aprendizado curto, bem formatado,
com citação da forma certa e um valor de domínio **falso** passa no lint e falha na
proveniência — e é exatamente essa a diferença que só um sinal externo separa.

## 8.2 Entra ou é descartado — default: descartar

Cinco passos, e o primeiro elimina a maioria:

1. **É importante?** Quatro condições **simultâneas**: não-óbvio · **não
   inferível do código por um modelo capaz** · não-volátil · *muda como tarefas
   futuras nessa área devem ser feitas*. Medido aqui: **~42% das 195 entradas
   passariam**. *A maioria falhar neste passo é o desfecho saudável, não uma
   falha.*
2. **É verificado externamente?** A linha citada tem de **implicar** a afirmação,
   não apenas existir.
3. **Conflita?** **Substituir** a passagem antiga — nunca anexar a regra
   concorrente ao lado. Medido: `building-web-ui/LEARNINGS.md:12` afirma que o
   custo dos agentes reservados entra no total; `:31` corrige explicitamente
   (*"it does NOT"*); **as duas seguem `[probation]`** e quem ler a primeira
   primeiro leva a resposta errada.
4. **Gate:** escreva a asserção **antes** da prosa, depois rode a verificação.
   **Promover ou descartar, sem merge parcial.**
5. **Commit próprio.**

E a exigência mais sutil, ao editar: **manter a condição de escopo.** Nunca remova
o escopo para economizar palavras — uma regra que perde sua condição de validade
vira uma regra que está **errada** em todo o resto.

## 8.3 O ledger é uma fila de trabalho, não um registro de riscos

A decisão de nível de programa vem primeiro, e é uma frase — sem ela, cada agente
resolve por plausibilidade e ninguém sabe onde:

> **Avançar o máximo possível com o que o repositório responde, e deixar EM ABERTO
> — nunca resolver por palpite — tudo o que só o ambiente real, o dono do produto
> ou uma medição futura pode responder.**

Classifique por **quem responde**, não só por risco: o interlocutor mais barato
que ainda responde (o próprio código · uma medição · o dono do produto · um
provider externo). É isso que transforma o catálogo numa **agenda**.

E o estado terminal que quase todo ledger esquece: **`INVIÁVEL`, com ADR.** Sem
ele, o inverificável ou fica aberto para sempre (ruído) ou é fechado por dedução
(mentira).

---

# §9 — O que a indústria confirma, o que ela refuta e o que ela não sabe

Esta seção vem de uma pesquisa com **108 agentes e verificação adversarial** (cada
afirmação submetida a refutadores independentes; sobrevive quem tem ≥2 de 3 votos).
Ela é dividida em três blocos — e o terceiro é o mais importante, porque é onde a
pesquisa **não achou nada** e a tentação de preencher com plausibilidade é maior.

**Nota de método sobre o "código vazado".** O que é utilizável e citável são: a
documentação oficial da Anthropic, os write-ups públicos de engenharia reversa do
bundle npm, e o **comportamento observável do binário instalado** (verificado na
2.1.220 durante a pesquisa). É isso que está abaixo. Não há reprodução de fonte
proprietária aqui, e não precisa haver: o que transfere é **desenho**, e desenho se
lê do comportamento.

## 9.1 Confirmado — e o que muda neste plano

### C1. Worktree-por-agente deixou de ser truque e virou primitiva de produto

`3-0`. Cursor 3.5 (`/worktree` + `.cursor/worktrees.json`), Claude Code
(`isolation: worktree`) e OpenAI Codex (worktrees) todos entregam isolamento por
worktree como recurso de primeira classe. **A aposta arquitetural do `huu` é
mainstream** — o que é uma boa notícia e remove qualquer necessidade de defendê-la.

### C2. …e no Claude Code o isolamento é enforçado na **camada de ferramenta**, não no prompt 🔴

`3-0`, verificado nas versões 2.1.203 / 2.1.210 / 2.1.216: **um comando Bash que
resolve de volta para o checkout principal FALHA.** Não é uma instrução no prompt
pedindo para o agente se comportar — é a ferramenta recusando.

> **Esta é a corroboração mais direta do §4.2 deste documento.** O `huu` hoje faz o
> oposto: a partição por propriedade de arquivo é **prosa em prompt** repetida em
> cinco lugares (`dev-protocol.ts:216-226`, `planner-prompts.ts:93-97`, …), e
> `docs/dev-mode.md:250` a anuncia como *"Rules huu enforces"*. A referência da
> indústria diz que o lugar da garantia é o mecanismo, não o texto.
>
> **Efeito no plano:** sobe a prioridade de `M3-02` (write-set validado) e
> `M6-01` (disjunção no dev mode), e sugere um card futuro que os leve à camada de
> ferramenta do backend — não só à validação pré-merge. Registrar no ledger.

### C3. O fan-in é onde os fornecedores param — e é aí que o `huu` é sozinho 🔴

`3-0`, e é o achado mais consequente para a identidade do produto. **Todo produto
enviado transforma o merge-back num funil explícito e acionado por humano:**
`/apply-worktree`, Apply-or-discard, e o `/best-of-n` que declara literalmente que
*"does not merge changes back … for you"*.

Ou seja: **o merge determinístico de N branches ao fim de cada etapa — a barreira
BSP que o `MANIFESTO.md` chama de diferencial nº 1 — é genuinamente distintivo, e
é exatamente o passo que nenhuma fonte externa valida.**

Isso corta nas duas direções, e as duas importam:

- **A favor:** o `MANIFESTO.md` está certo ao chamar isso de síntese própria. Não é
  retórica.
- **Contra:** é o passo com **zero corroboração externa** e — medido no §4.3 —
  **zero verificação entre merges** e **zero arquivo de teste** em
  `integration-merge.ts`. O componente mais original do produto é o menos
  verificado. `M3-03` e `M2-06` deixam de ser melhoria e passam a ser dívida sobre
  o diferencial.

### C4. A academia já nomeou exatamente o defeito do §4.2/§4.3

`arXiv:2606.15376` (CoAgent, SJTU, junho/2026), sobre orquestração fork-and-merge
de agentes:

> *"weak isolation akin to read committed"* … um merge em nível de linha
> *"catches textual conflicts but nothing beyond — the merged code can fail to
> even compile."*

É a formulação acadêmica da frase que este documento derivou do código: **o merge
do git prova ausência de conflito de texto, e nada mais.** O `huu` tem hoje o
"read committed" e não tem o resto. `M3-03` (gate entre merges) e `M3-02`
(write-set) são a resposta; agora com nome e citação.

### C5. Admissão: fail-fast numérico, não fila — o contraste que vale copiar em parte

`3-0`. O Claude Code implementa controle de admissão como **portões numéricos
duros com erros do tipo "não-retentar"**: **20 spawns concorrentes**, **200 por
sessão**. Não há fila, não há pacing.

O `huu` faz o oposto por decisão consciente e bem-fundamentada: `AdmissionController`
enfileira e ritma, porque o incidente de origem foi um OOM real com 9 auditorias
(`ROADMAP.md`). **Não copie o fail-fast no lugar do pacing** — mas copie o que ele
tem e o `huu` não: **um teto absoluto, numérico, por sessão**, que não depende de
nenhum sinal dinâmico funcionar. Hoje o `huu` tem `HARD_PER_RUN_CEILING = 512` e
`DEFAULT_MAX_AGENTS = 200`; o que falta é o teto **por processo, por vida da
sessão**, como último backstop quando PSI é `null` (não-Linux) e o clamp de host
está desligado. Item de ledger + card futuro.

### C6. O número de 90,2% NÃO pode ser citado como projeção de ganho 🔴

`3-0`, com ressalva obrigatória. A Anthropic reporta que Opus 4 líder + Sonnet 4
subagentes superou Opus 4 sozinho em **90,2%** no eval interno de *research*, e que
paralelizar cortou o tempo *"by up to 90%"*. Mas:

- é **auto-relato de fornecedor sobre eval privado** — sem contagem de queries, sem
  intervalo de confiança, avaliado por LLM-as-judge contra rubrica. Cite como *"a
  Anthropic reporta"*, nunca como benchmark;
- **o mesmo post desqualifica o domínio**: *"most coding tasks involve fewer truly
  parallelizable tasks than research, and LLM agents are not yet great at
  coordinating and delegating to other agents in real time"*;
- o post **volunteia o custo contra si**: ~4× tokens vs chat, **~15× para
  multi-agente**;
- e é de 2025-06-13, com os modelos citados já superados.

> **Regra que sai daqui, e vale para todo o `METODO`:** um claim sem nível de
> confiança é indistinguível de opinião três meses depois. Quando um número desce
> até o executor, ele desce **com o placar** (`3-0`) e **com a ressalva**.

## 9.2 Refutado — dois pressupostos que este repositório precisa corrigir

Estes vieram como correção à própria pergunta da pesquisa, o que os torna
especialmente úteis:

| Pressuposto comum | Realidade verificada |
|---|---|
| *"Sub-agentes não podem gerar sub-agentes"* — regra citada em toda parte como justificativa de desenho | **Falso desde a v2.1.219.** Sub-agentes **aninham**, com profundidade default **3**, controlada por `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`. Verificado no binário 2.1.220 |
| *"Controle de admissão de fleet é feito por fila"* | No Claude Code é **fail-fast numérico** (C5) |

Por que isso importa aqui: qualquer decisão do `huu` que tenha sido tomada
*"porque sub-agente não pode gerar sub-agente"* está apoiada numa premissa morta.
Vale um item de ledger com verificação executável — e é exatamente o tipo de
afirmação que o `M4-01` (pin) e o `M4-02` (ledger) existem para não deixar
apodrecer em silêncio numa skill.

## 9.3 O que a pesquisa NÃO conseguiu confirmar — e por que isso não é o mesmo que "falso"

**Dos cinco ângulos pesquisados, três não produziram nenhuma afirmação sobrevivente
à verificação adversarial:** (3) verificação de código gerado por agente —
falso-verde, mutação, LLM-as-judge, viés de posição/verbosidade, benchmarks;
(4) quase toda a economia de contexto e memória; (5) praticamente tudo de PSI/AIMD,
caching, roteamento por papel e OpenTelemetry para agentes.

Três leituras, e a ordem é deliberada:

1. **Ausência de literatura secundária ≠ refutação.** O `ROADMAP.md` do `huu` já
   cita **fontes primárias** para o ângulo 5 — docs do kernel sobre cgroup v2 e
   PSI, o paper TMO (ASPLOS'22), o `senpai`/`oomd` da Meta, o
   `concurrency-limits` da Netflix. A pesquisa não achou ninguém *escrevendo sobre
   aplicar isso a fleets de agentes de código*. A conclusão honesta é: **o `huu`
   está fazendo algo que a indústria ainda não documentou**, e a validação vai ter
   de ser própria (medição em runtime, que a Fase 2.2 já fez com o sweep de PSI).
   Isso é uma posição boa — mas é uma posição sem rede.
2. **Para o ângulo 3, a ausência é ainda mais interessante:** este documento
   **produziu** a evidência que a pesquisa não achou. As quatro mutações do §4.6,
   os dois erros de tipo plantados, o teste cruzado dos gêmeos e as 14 citações
   conferidas são medição de primeira mão sobre falso-verde neste corpus. O
   Apêndice G é, na prática, um artefato original.
3. **Nada aqui deve ser preenchido com plausibilidade.** A tentação, num documento
   deste tamanho, é citar Stryker, escrever três parágrafos sobre viés de
   self-preference em LLM-as-judge e seguir. Se a verificação não sustentou, entra
   no ledger como **`ABERTO`, com o teste que fecha** — não no corpo do método.
   É a mesma regra do §8.2 aplicada a este próprio documento.

### O que fica no ledger a partir deste ângulo

| Item | Pergunta | Como fechar |
|---|---|---|
| `HU-345` | Aninhamento de sub-agente: alguma decisão do `huu` depende da premissa morta? | `rg -i 'subagent.*cannot spawn\|não pode gerar' .agents docs src` e reescrever o que achar |
| `HU-346` | Teto absoluto por sessão (C5) existe? | medir: rodar N runs até PSI `null` com `HUU_NO_HOST_CLAMP=1` e ver se algo segura |
| `HU-347` | Enforcement de propriedade na camada de ferramenta (C2) é viável nos backends do `huu`? | spike: o pi expõe hook de pré-escrita? |
| `HU-348` | O merge de N branches (C3) tem contrapartida externa hoje? | re-pesquisar em 6 meses; se ninguém fizer, é diferencial confirmado por ausência |

---

# §10 — Custo, ritmo e o que esperar

## 10.1 O ritmo real deste repositório 📏

O `huu` já se auto-hospedou. Lido dos merges:

```
2026-05-20  commit inicial
06-25/26    59 commits em 2 dias        ← a rajada de construção
07-01..04   52 commits em 4 dias
07-28       45 commits num dia, com 17 merges de onda:
              merge(w4-0728-215323-{1,2})          2 fronts
              merge(w5-0728-221935-{1,2,3})        3 fronts
              merge(w6-0728-223928-{1,2,3})        3 fronts
07-29       merge branch 'feat/dev-mode-v2'
```

Três leituras:

1. **Ondas de 1 a 3 fronts, não de 9.** O `DEV_MAX_FRONTS = 4` é o teto, e o uso
   real ficou em 2-3. Isso é saudável: largura vem de fan-out de hub, e o dev mode
   ainda não tem hub largo. Não force.
2. **Zero branches `huu/**` órfãos** ao fim. A limpeza de worktree funcionou sob
   carga real — é o tipo de coisa que só se prova em dogfooding, e está provado.
3. **A rajada é o modo natural.** 45 commits num dia depois de 23 dias de 1-3
   commits/dia. Um plano em 11 ondas cabe em rajadas; não cabe em cadência
   uniforme.

## 10.2 O que satura antes do modelo

O `ROADMAP.md` é dono de RAM/PSI/cgroup e este documento **cede** a ele. Mas há
três recursos que o `ROADMAP` **não** modela e que aparecem primeiro quando as
ondas ficam largas:

| Recurso | Estado | O que acontece |
|---|---|---|
| **Disco** | ⚠️ **completamente não-modelado.** `runPreflight` (`src/git/preflight.ts:6-119`) checa repo, sujeira, branch, HEAD e remote — **nunca espaço livre nem inode**. Não há termo de disco em `clampedHeadroomBytes()` | Cada agente é um `git worktree add`, ou seja, uma cópia. 200 agentes num repo de 2 GB são 400 GB. Disco cheio aparece como N falhas simultâneas de `worktree add` roteadas pelo retry genérico |
| **Portas TCP** | cap suave: janela de 10 portas a partir de 55100, varredura de `maxAgents × 4` | Falha de alocação é **engolida como warning** e o agente roda **sem isolamento** (`index.ts:2076-2087`) — dois agentes então disputam a mesma porta fixa da aplicação |
| **Banco / serviço externo** | não modelado | `HUU_DATABASE_URL` é entregue aos agentes sem contabilidade de conexão; nada segura N agentes que cada um sobe um dev server ou um `npm install` |

E dois efeitos de custo que valem orçar antes:

- **Revisão automatizada dobra o custo por slot.** O `WorkStep.review` roda um
  agente crítico separado na worktree do worker, com `maxRounds = 2`. Três workers
  com revisor são até seis agentes. Ligue por card, não por default.
- **Retomar um agente pausado re-paga tokens de *input*.** O checkpoint preserva o
  raciocínio (não re-executa tool calls), mas re-hidrata contexto — mitigável por
  prompt caching, não gratuito.

E a lição de observabilidade que o playbook de origem pagou com quatro relatórios
perdidos ao fechar um terminal, e que aqui vale para o `M6-04`:

> **Se o conteúdo importa, o lugar dele é um arquivo no repositório, escrito
> *pelo* agente** — e commitado. Contador em memória morre com o processo. Hoje,
> um SIGKILL no meio de uma etapa deixa **zero** artefato em `.huu/`.

## 10.3 Cinco erros que o playbook de origem cometeu e que o `huu` já não pode cometer

Crédito onde é devido — estes estão fechados **por construção**:

1. **Onda ≠ nível topológico.** No `huu` a onda é derivada pelo motor a cada
   superstep; `dependsOn` é obrigado a apontar para trás. Card órfão por aresta
   cortada é impossível de existir sem alguém ver.
2. **Barreira por leitura de tela.** A barreira é o merge de integração. Não há
   tela para ler, logo não há o falso positivo "1/1 terminaram" um minuto depois do
   lançamento.
3. **Merge octopus.** Nunca acontece: um a um, ascendente, `--no-ff`.
4. **Agente removendo a própria worktree.** O `huu` remove do repo principal, sob
   lock por repositório.
5. **Estado escrito à mão no kanban.** O contrato de verdade dos cards já é
   derivado do merge (`DONE` verde só depois do branch entrar).

## 10.4 …e cinco que ele ainda pode cometer — que é o que este plano ataca

1. **Merge limpo que integra errado.** Nada compara write-set entre agentes
   (§4.2) → `M3-02`, `M6-01`.
2. **Verde que não pode ficar vermelho.** 5 de 7 pipelines default gatilhados por
   um comando que sempre passa; três invariantes deletáveis com a suíte verde
   (§4.6) → `M1-04`, `M2-04`, `M2-06`.
3. **Aceitação decorativa.** Não existe campo de aceitação executável no schema, e
   `-t` sem casar sai 0 → `M1-02`, `M1-03`, `M2-03`, `M2-07`.
4. **Skill que ensina o que o código não faz mais.** 29% de acerto de citação, 5
   afirmações sobre comportamento deletado, `copilot` no sinal de roteamento
   (§4.4) → `M4-01`, `M4-04`, `M5-01`.
5. **Trabalho perdido no crash.** Manifesto serializado uma vez, no `finally`
   (§4.3) → `M6-04`.

## 10.5 Ordem de execução recomendada, e o que NÃO fazer

**Faça W0 → W1 → W1.5 → W2 antes de qualquer coisa.** Não porque são as mais
valiosas isoladamente, mas porque **tudo depois delas é verificável e nada antes
delas é.**

⚠️ **Não comece pela W7.** Quebrar `app.js` (3.723 linhas) ou
`orchestrator/index.ts` (3.815 linhas) é a mudança mais tentadora e a mais
perigosa deste plano: hoje **nada typecheca o primeiro** e **três invariantes do
segundo são deletáveis com a suíte verde**. A única coisa que diria que o refactor
quebrou algo é justamente o gate que a W1/W2/W3 constroem. Fazer W7 antes é
refatorar no escuro com a luz na mão.

---

# Apêndices

## Apêndice A — Template de card (prompt XML)

As 12 tags, na ordem, adaptadas a este repositório. Este é o `M1-04` escrito por
extenso — o menor card completo do plano, para servir de molde.

```xml
<task id="M1-04" nome="A linha que devolve o contrato report-only"
      onda="W1" grupo="G-pipelines">

  <ultrathink>O erro a evitar não é sintático: é trocar um comando que não pode
    falhar por outro que também não pode. Gaste o raciocínio em provar que a nova
    cláusula REPROVA uma fixture suja — se você não vir vermelho, não terminou.</ultrathink>

  <contexto>As 5 auditorias report-only prometem não tocar o código do usuário.
    O juiz roda na worktree de integração DEPOIS do merge, então `git status`
    está sempre limpo — a promessa é verificada por um comando vazio.</contexto>

  <ler_consideracoes_dos_anteriores>
    ANTES de planejar: leia a linha "Considerações" de TODAS as tarefas das quais
    esta depende — direta E transitivamente — subindo o grafo até a raiz.
    Dependências diretas desta tarefa: M0-01.
    Uma consideração de um ancestral distante pode invalidar uma premissa deste
    card — se isso ocorrer, ajuste o plano e diga por quê; NÃO siga no automático.
  </ler_consideracoes_dos_anteriores>

  <questoes_abertas>Faixa HU-050..059 (.agents/ledger/inbox/M1-04.json).
    Esperado: 1 item — "o juiz de modelo pequeno expande `$baseCommit`
    corretamente em todos os providers?" com verificação executável.</questoes_abertas>

  <skills_obrigatorias>
    - .agents/skills/editing-default-pipelines/SKILL.md
    - .agents/skills/authoring-agent-prompts/SKILL.md
  </skills_obrigatorias>

  <entradas>src/lib/default-pipelines/knowledge-protocol.ts (a função
    reportJudgeCondition) · src/lib/default-pipelines/huu-test-suite.ts:343 (a
    forma CORRETA, para copiar) · src/orchestrator/check-evaluator.ts:19-22 (a
    explicação de por que `git status` está sempre limpo).
    MÉTODO DE LEITURA: use `rg --no-ignore` — `.huu/` é gitignored e uma busca
    sem a flag devolve zero com exit 0.</entradas>

  <o_que_fazer>1. Em reportJudgeCondition(), trocar a cláusula 4 para
    `git diff --name-only $baseCommit..HEAD` + a frase fail-closed de
    huu-test-suite.ts:343.
    2. `npx tsx scripts/regen-default-pipelines.ts` (os 5 JSONs).
    3. Escrever o caso vermelho: fixture com um arquivo de fonte tocado ⇒ rework.</o_que_fazer>

  <restricoes>PROIBIDO: tocar huu-test-suite.ts (dono M2-04); tocar
    check-evaluator.ts; "melhorar" as outras cláusulas do juiz no mesmo card;
    editar CHANGELOG.md (dono M1-05 — escreva .changes/M1-04.md);
    `git add -A`. Os 5 JSONs de pipelines/ são REGENERADOS, nunca editados à mão.</restricoes>

  <swarm>
    <subagents>Agente único. Fan-out não paga: é uma função e cinco JSONs
      gerados.</subagents>
    <worktree>bash tools/new-task-worktree.sh create M1-04</worktree>
    <revisao_adversarial>Subagente de CONTEXTO FRESCO recebe só o diff e este
      card e tenta refutar: (a) a cláusula nova passa numa árvore em que um
      arquivo de src/ foi tocado? (b) `$baseCommit` chega expandido ao juiz, ou
      vira `..HEAD` (= HEAD..HEAD, vazio, exit 0)? (c) algum dos 5 JSONs ficou
      fora da regeneração?</revisao_adversarial>
  </swarm>

  <criterios_aceitacao>
    rg -q 'baseCommit\.\.HEAD' src/lib/default-pipelines/knowledge-protocol.ts
    rg -L 'baseCommit\.\.HEAD' pipelines/*audit*.pipeline.json    # saída VAZIA
    rg -c 'git status --porcelain' src/lib/default-pipelines/knowledge-protocol.ts  # 0
    npx vitest run -t 'report-contract rejeita'                   # o caso VERMELHO existe
    # GUARD: `vitest -t "X"` sai 0 com ZERO testes casados (medido, §4.6 A13).
    # A garantia é scripts/check-acceptance.ts rodando dentro do gate (M1-02);
    # este comentário só explica por quê.
    bash scripts/gate.sh                                          # VERDE
  </criterios_aceitacao>

  <ao_concluir_marque_feito_e_publique>Marcar M1-04 no registro (só as linhas do
    seu card); escrever Considerações com o que você descobriu sobre a expansão
    de `$baseCommit`, com destinatário NOMEADO (M2-04, M8-01).</ao_concluir_marque_feito_e_publique>

  <evolucao>meta-skill-evolution (default: DESCARTAR). Se algo entrar, é
    APPEND em LEARNINGS — nunca no corpo da SKILL.md (ver M4-04).</evolucao>
</task>
```

**Nota de custo:** o card raiz precisa de ~5 KB; um card da W7 cabe em 2 KB, porque
o `contexto` virou *"o card anterior publicou o vocabulário"*. **O custo do card cai
conforme o programa acumula contratos publicados.**

## Apêndice B — O plano é um pipeline `huu` ✍️

O playbook de origem precisou de um registro HTML com `<details>` porque não tinha
motor. Aqui existe um, e o mapeamento é direto:

| Eixo do card | Onde vive no `huu` |
|---|---|
| **grafo** (de onde saem as ondas) | `WorkStep.dependsOn` — já validado como backward-only |
| **identidade e estado** (de onde sai o progresso) | `AgentStatus` + o contrato de verdade do kanban (`merged`) |
| **escalonamento** | `computeWave` — derivado, não declarado |
| **write-set** (quem escreve onde) | `WorkStep.writes` — **`M3-02` cria** |
| **aceitação falsificável** | `WorkStep.accept` — **`M1-03` cria, `M2-03` executa** |
| **revisão adversarial** | `WorkStep.review` — **já existe**, com `blockOn` e `maxRounds` |
| **handoff com destinatário** | o findings shard do dev mode + `.changes/<card>.md` |
| **portão de onda** | `CheckStep` com `default: true` forward + `Pipeline.mergeGate` (**`M3-03` cria**) |

**Consequência operacional:** depois de W1–W3, este documento pode ser compilado
num `huu-pipeline-v2` e **executado pelo próprio `huu`** — 34 cards, 11 ondas,
write-sets declarados, aceitação executável por card. Antes de W1–W3, não pode:
faltam exatamente os dois campos (`writes`, `accept`) que tornam o plano
verificável. **O plano se auto-hospeda no fim da W3, e não antes.**

## Apêndice C — Template de ADR

```markdown
# ADR NNNN — <título que é a DECISÃO, não o tema>

- **Status:** Aceito | PROPOSTO — esqueleto vazio | ENCERRADO SEM DECISÃO
              | ENCERRADO COMO CONSTRUÍDO E NÃO DISPARADO
              [+ "(sign-off de <nome>)" e POR QUE o sign-off era exigido]
- **Data:** AAAA-MM-DD [· encerrado em AAAA-MM-DD]
- **Card:** <id> (onda Wn). Depende de <cards>. Consumido por <cards>.
- **Supera, no que diverge:** <doc + seção exata>
- **Reafirma explicitamente:** <ADR §n>          ← o que NÃO mudou
- **Guarda executável:** <comando que FALHA se a decisão for violada>
- **Itens de ledger ligados:** <HU-nnn>

## Contexto            ← inclui "premissas de ancestrais que me vinculam"
## Decisão             ← numerada: D1, D2… cada uma citável isoladamente
## Alternativas descartadas   ← com o motivo da rejeição
## Consequências       ← Positivas | Custos e desvios registrados
## Revisão adversarial ← o que a crítica derrubou
## O que este ADR NÃO decide
## Limites do que é verificável aqui
## Adendo do sign-off (data)  ← o que o aceite autoriza e o que NÃO autoriza
```

Três campos separam isto de um ADR comum, e cada um responde a uma falha real:

- **`Guarda executável`** — se você não consegue escrever a guarda, a decisão é
  uma intenção. O critério de aceitação do `M4-03` **roda a guarda**.
- **`Reafirma explicitamente`** — sem ele, "supera" vira revogação silenciosa do
  documento inteiro. É o antídoto exato para o conflito do §0.4.
- **`O que o sign-off NÃO autoriza`** — um aceite sem fronteira é um cheque em
  branco.

## Apêndice D — Esquema de um item de ledger

```json
{
  "id": "HU-051",
  "titulo": "Expansão de $baseCommit em juízes de modelo pequeno",
  "pergunta": "Todo provider expande $baseCommit antes do juiz ler a condição?",
  "por_que_aberto": "Registrado como falha real em editing-default-pipelines/LEARNINGS.md — um juiz de modelo pequeno recebeu a var não-expandida e a cláusula passou vazia.",
  "decisao_provisoria": "Assumir que a substituição do check-evaluator cobre todos; a cláusula fail-closed cobre o resto.",
  "origem": ["src/orchestrator/check-evaluator.ts:95-98"],
  "verificacao": "Rodar huu Docs Audit com --model de um modelo pequeno e conferir no run log a condição JÁ substituída; salvar a saída.",
  "impacto_se_divergir": "As 5 auditorias voltam a ter cláusula vazia. Recapturar: judge-conditions.test.ts, os 5 JSONs, e o card M8-01.",
  "risco": "alto",
  "interlocutor": "medição própria",
  "grupo": "<um de um vocabulário FECHADO>",
  "status": "ABERTO",
  "evidencia": "",
  "data_resolucao": ""
}
```

**Validado por script, não por revisão:**

| estado | exige |
|---|---|
| `ABERTO` | `por_que_aberto` + `decisao_provisoria` + `verificacao` + `impacto_se_divergir` **não-vazios**, e `evidencia` **vazia** |
| fechado (`CONFIRMADO`/`REFUTADO`/`PARCIAL`/`INVIÁVEL`) | `evidencia` **citável** (regex: `arquivo:linha`, saída salva, relatório de diff, ADR, ou resposta atribuída com data) + `data_resolucao` ISO |

**Lista negra de não-evidências** — sem ela a regra vira decorativa:
`"ok"`, `"conferido"`, `"conforme combinado"`, `"funcionou aqui"`.

**Âncora no código**, no ponto exato da suposição:
```ts
// ABERTO HU-051: assume $baseCommit expandido em todo provider; ver ledger.
```

**Inbox por card**, para sobreviver a N worktrees paralelas — o arquivo
compartilhado do ledger é um array único, e vários agentes acrescentando ao fim
dele **conflitam no fecho do array, sempre**:
```json
{ "card": "M1-04", "itens": [ { … } ] }
```

## Apêndice E — Prompt de revisão adversarial

**Forma reutilizável:**

```
Antes de concluir, lance um subagente de CONTEXTO FRESCO que recebe APENAS
o diff e este card, e tenta REFUTAR:

  <pergunta falsificável 1, específica do domínio>
  <pergunta falsificável 2>
  <pergunta falsificável 3>

Corrija o que ele derrubar antes de encerrar.
```

**Por que contexto fresco:** o revisor não vê o histórico da conversa do
implementador, então não herda nem a pressa nem as premissas.

**Perguntas calibradas para este repositório** — cada uma nomeia um resultado
observável que, se acontecer, **derruba o trabalho**:

| Domínio | Pergunta |
|---|---|
| qualquer critério de aceitação | *o que este comando imprime se a tarefa não fizer nada? Rode com o diff revertido* |
| teste novo | *`vitest -t "<seletor>"` casa ≥1 teste, ou sai 0 com tudo skipped?* |
| validador novo | *plante uma mutação CALCULADA no alvo: ele acusa, e a mensagem nomeia o quê?* |
| condição de juiz | *a cláusula reprova uma fixture deliberadamente suja? `$baseCommit` chega expandido ou vira `HEAD..HEAD`?* |
| write-set | *dois cards da mesma onda escrevem no mesmo arquivo? rode a disjunção sobre os specs* |
| cliente web | *isto passa pelo `tsc`? (até M1-06, a resposta honesta é "nada passa")* |
| gêmeos | *diffe os dois: só o que devia mudar mudou? as duas tabelas concordam em todas as combinações, não só nas testadas?* |
| skill / LEARNINGS | *a linha citada ainda existe E sustenta a afirmação? rode `check-pins`* |
| busca no repo | *você usou `--no-ignore`? zero resultado em `.huu/` é o default, não uma prova* |
| refactor de arquivo quente | *qual invariante deste arquivo tem teste? se nenhum, você está refatorando no escuro* |

⚠️ **Os limites, para não vender mais do que é.** Quem escolhe as perguntas é o
implementador; quem decide o que "foi derrubado" também. E não há registro de
quantas revisões não acharam nada — casos de sucesso são anedota, não taxa. A
revisão adversarial reduz o erro que o autor não *veria*; não corrige o que ele não
*quer* ver. Para fechar essa brecha: **as perguntas vêm do card**, escritas por
quem orquestra, antes.

E o dado que o próprio `huu` mediu e escreveu no código
(`plan-to-pipeline.ts:369-371`), que deve calibrar a expectativa:

> *"the measured dominant failure mode of an LLM critic … is SPURIOUS BLOCKING of
> correct code (false rejection measured at 22.5%–91.9%, ~87% of it semantic
> hallucination …), not missed bugs."*

Por isso `blockOn` exige severidade **e** o card deve exigir contraexemplo
concreto — sem um, é `minor`.

## Apêndice F — Padrão de escrita de um gate

```markdown
### GATE <ID> — <a asserção em uma frase, no afirmativo>

<Por que existe: o dano CONCRETO se for pulado. Não "boas práticas".>

Antes de <ação>, numa sessão com <quem, por papel>:
1. <comando executável, literal, copiável>
2. <como confrontar o resultado com o artefato do repositório>
3. **Registrar o resultado em <caminho de ADR nominal>** — item a item, com o
   veredito (igual / divergente / NÃO_COLETADO) e o que muda se divergir.

- [ ] <artefato de saída> existe e cobre todos os itens
- [ ] Toda divergência corrigida **e** as fixtures recapturadas
```

**Os quatro elementos obrigatórios:** condição de entrada · evidência exigida
(saída de comando salva, nunca afirmação) · artefato nominal onde a evidência mora ·
**quem assina, por papel nomeado** (nunca "o time").

**Um veredito que não pode existir:** `CONFERE` sem evidência anexada. É pior que
`ABERTO` — ele para de ser reperguntado e vira premissa invisível. Use
`NÃO_COLETADO`, que **nunca** vira `CONFERE` sozinho.

## Apêndice G — Catálogo de falso-verde do `huu` (vivo — `M9-01` o mantém)

Cada linha é um caso **real e medido neste repositório**. A pergunta que gera a
lista: ***se isto desaparecer, o que fica vermelho?***

| O que parece verde | Por quê | Ref |
|---|---|---|
| `vitest run -t "X"` com zero testes casados | sai **0** com tudo skipped; `passWithNoTests` não configurado | A13 |
| `npm run typecheck` | cego a `scripts/**` e aos 4.669 linhas de `src/web/client/*.js` — dois erros plantados, exit 0 | A14 |
| A cláusula report-only das 5 auditorias | `git status` está sempre limpo no momento do juiz | A1 |
| Qualquer veredito de juiz | nenhum teste prova que um juiz consegue dizer `rework` | A2 |
| Uma etapa onde todos os agentes falharam | `runStageIntegration` devolve `true`; dependentes rodam | A3 |
| Um pipeline que pulou metade dos steps | `warn` + `break` ⇒ `status: 'done'` | A4 |
| Uma época do dev mode que não produziu nada | `alreadyUpToDate` é lido por nada; exit 0 | A5 |
| `goalComplete: true` | zero corroboração, e o `doneWhen` que a define foi sobrescrito na mesma resposta | A6 |
| Um juiz que tomou 429 | `default: true` aponta pra frente ⇒ aprova em silêncio | A7 |
| `CheckStep` sem `maxRuns` | não há default ⇒ loop pago ilimitado; 3 docs afirmam "default 5" | A8 |
| Um merge que falhou sem conflito (caminho do resolver) | tratado como sucesso; card fica verde DONE | A9 |
| `git diff --exit-code` | cego a arquivo novo não-rastreado | §0.1 |
| `git ls-files` num validador | omite untracked — cego para o arquivo que o card acabou de criar | §0.1 |
| `rg` em `.huu/` | 0 resultados, exit 1, por `.gitignore` | §0.1 |
| Apagar **os dois** guardas de `maxNodeExecutions` | suíte verde, `tsc` verde | mutação 1 |
| Aceitar 2+ `default: true` num check | suíte verde; roteamento passa a depender de ordem | mutação 3 |
| Deletar o sort da ordem de merge | suíte verde | mutação 4 |
| Os testes "gêmeos" do `card-state` | tabelas independentes, chaves diferentes, **18 discordâncias**, duas suítes verdes | A15 |
| `src/__tests__/x.ts`, `x.tests.ts`, `x-test.ts` | não coletados, em silêncio | A16 |
| Cobertura | não medida ⇒ não pode regredir | A17 |
| `smoke-defaults.sh` | valida **6** de 7 defaults, e contra um `dist/` de 26 dias | A12, A20 |
| Ferramenta ausente num smoke | imprime "ausente (esperado)" e segue | §1 do relatório de gate |
| Sonda de imagem ociosa | `if [ -f /tmp/huu/active ]; … else exit 0` — passa por construção | idem |
| `.agents/` inteiro | zero hooks, zero testes; o único validador está desligado **e vermelho** | A11 |
| Citação numa skill | 29% de acerto; 5 afirmam comportamento deletado | §4.4 |
| Teste que asserta prosa (`toContain('CODE IS FROZEN')`) | 535 asserções (12,4%) são substring em prompt; trocar a `condition` por "sempre aprova" mantendo as strings deixa verde | A19 |

## Apêndice H — Checklist de arranque, em uma página

**Antes de existir card**
- [ ] Regras de leitura do corpus escritas e commitadas (`--no-ignore`; `git diff`
      não vê untracked; `git ls-files` omite untracked; `tsc` não cobre `.js`)
- [ ] Inventário de singletons por churn × tamanho, com tratamento declarado
- [ ] Regra de precedência publicada e o conflito conhecido nomeado (§0.4)
- [ ] Números do §1 medidos, com o comando ao lado

**A árvore**
- [ ] Cards cortados por **propriedade de arquivo**, não por assunto
- [ ] Tabela `arquivo → dono` com a coluna "os outros: não editam"
- [ ] Faixas de ID do ledger reservadas antes da onda
- [ ] Ordem de merge declarada (quem muda o gate, por último)
- [ ] Nível derivado **e** onda agendada, com a folga visível

**Antes da primeira onda paralela**
- [ ] Gate local executável, uma etapa por job, **ferramenta ausente = vermelho**
- [ ] Três estados: PASS · FAIL · NÃO-EXERCITADO; gate futuro anunciado `PENDENTE`
- [ ] Autoteste de cada verificador, rodando **antes** dele, assertando a MENSAGEM
- [ ] Verificador de aceitação com **sonda negativa**
- [ ] Ledger com validador no gate desde o dia 1, verde com tudo aberto
- [ ] `core.hooksPath` configurado; gate onde o erro é irreversível, nudge no resto

**Por onda**
- [ ] Commit PREP **antes das worktrees** (stubs + contrato + faixas de ID)
- [ ] Singletons enumerados: dono exclusivo **ou** sequência dentro da onda
- [ ] Se ≥2 cards consomem o mesmo artefato anterior ⇒ **onda de composição**
- [ ] **Gate depois de CADA merge**, nunca só no fim
- [ ] Handoff escrito na worktree, antes do merge, **com destinatário nomeado**
- [ ] Evolução da memória rodada (default: descartar)

## Apêndice I — O que este documento NÃO cobre

O escopo negativo é parte do entregável.

- **Controle de recursos** — RAM, PSI, cgroup, admissão, zram, subprocessos. É
  `ROADMAP.md`, Fases 1–3. Este documento cede.
- **Identidade do produto** — o que o `huu` é e não é. É `MANIFESTO.md`. Este
  documento só aponta **um conflito** (§0.4) e propõe o ADR que o resolve
  (`M4-03`), sem decidir por conta própria.
- **Conteúdo dos 7 pipelines default** além do que a verificação exige. As
  metodologias (Diátaxis, OWASP, Fowler, SonarSource) não estão em discussão aqui.
- **Escolha de modelo e economia de tokens por papel.** O `dev-model-policy` já
  existe; otimizá-lo é outro documento.
- **Multi-host.** `ROADMAP.md` §3.5.
- **Nenhuma estimativa de prazo.** O plano tem 34 cards e 11 ondas; a duração
  depende de concorrência, modelo e de quanto da W7 você decide fazer. O §10 dá o
  ritmo medido do repositório, não uma promessa.
- **A validação de que este plano funciona.** Ele é desenho revisado contra o
  código de 2026-07-30, com diagnóstico medido — **e nenhum dos 34 cards foi
  executado**. Trate as ondas W4–W9 como o playbook de origem pede que se tratem
  as Partes VI–VII dele: desenho testado no papel.

---

## Nota final

O que este documento tem de mais forte não é a lista de melhorias — é que **o
diagnóstico foi medido, não inferido**. Quatro mutações no código provaram que três
invariantes são deletáveis com 1.786 testes verdes; dois erros de tipo plantados
provaram que 4.669 linhas estão fora do typecheck; um teste cruzado provou 18
discordâncias entre dois "gêmeos"; e 14 citações conferidas uma a uma deram 29% de
acerto. Nada disso é opinião sobre estilo.

E o que ele tem de mais frágil é o inverso: **nenhum dos 34 cards rodou.** A
diferença entre este plano e um que dá errado não vai ser a ausência de surpresa —
vai ser o gate entre cada merge, que nomeia a surpresa enquanto ela ainda cabe num
card.

A frase do playbook de origem que vale levar junto, traduzida para cá:

> **Verde quer dizer "a suíte não reclamou", nunca "o comportamento está certo".
> Não se valida uma verificação contra ela mesma — é um limite de lógica, não de
> ferramenta.**

Sem ela, o método produz confiança na velocidade errada.

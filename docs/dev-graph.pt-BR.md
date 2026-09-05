# O método desenhado (`huu-devgraph-v1`)

> EN: [dev-graph.md](dev-graph.md) · Volta para o [índice](README.md)

Um **devgraph** é um método que um humano *desenhou*: quais blocos rodam, em que
ordem, onde uma decisão ramifica, onde os ramos voltam a se juntar. O huu compila
esse desenho num pipeline [`huu-pipeline-v2`](pipeline-json-guide.md) comum e o
roda no escalonador de ondas que já existe — as mesmas worktrees, o mesmo merge
determinístico de etapa, os mesmos juízes.

Nada no formato permite que um modelo acrescente um nó, uma aresta ou uma rota.

## Por que um método desenhado existe

O diferencial #2 do MANIFESTO é *"Zero planner LLM em runtime"* — no huu o grafo
é o JSON que você escreveu. Ele já carrega uma **exceção** explícita para o
[modo de desenvolvimento](dev-mode.pt-BR.md), onde um planejador LLM decompõe um
objetivo humano em frentes paralelas e portanto escreve a topologia de toda
época. Um devgraph é o que torna essa exceção desnecessária:

| | Planner LLM (`huu dev "<objetivo>"`) | Método desenhado (`huu dev "<objetivo>" --graph=<id>`) |
|---|---|---|
| Quem decide a topologia | um modelo, em tempo de execução | **você**, antes do run |
| Quem escreve os prompts | o template fixo de época do huu + o conteúdo do modelo | o catálogo de blocos, ou você |
| Quem fornece a inteligência | os agentes dentro de cada passo | os agentes dentro de cada nó |
| Épocas | replaneja até o objetivo ser cumprido (ou até o teto) | **exatamente uma** — o desenho *é* o método completo |

O humano subscreve o **método**; o modelo fornece a inteligência **dentro** de
cada nó. É o diferencial #2 valendo sem exceção — e é por isso que o driver
recusa, em voz alta, todo caminho que pudesse devolver em silêncio uma sessão
desenhada ao planejador (veja [Limites conhecidos](#limites-conhecidos)).

O resto não muda: o `compileGraphPipeline` emite um pipeline que o próprio
`PipelineSchema` + `validateTopology` do huu aceitam, então o escalonador, o
leque de memória, o roteamento por juiz e o merge de etapa o rodam **sem
nenhuma modificação**.

## Os quatro tipos de nó

Um canvas comporta quatro coisas (`src/lib/dev-graph/graph-types.ts`):

- **`prompt`** — a entrada. O seu objetivo, nas suas palavras. **Exatamente um
  por grafo**, é a raiz de que todo o método pende, e ele pode não ter aresta de
  entrada. Todo template de bloco pode injetá-lo com o token `$goal`, então uma
  frase escrita uma vez chega a doze nós sem ser redigitada. Ele compila para
  **nada**: é o objetivo, não um passo. Os nós pendurados nele viram as RAÍZES do
  pipeline (`dependsOn: []`).
- **`action`** — uma unidade de trabalho, vinda do catálogo de blocos abaixo.
  Compila para um `WorkStep`.
- **`research`** — uma pergunta respondida *antes* de o trabalho continuar,
  opcionalmente roteando o grafo. Veja
  [Nós de pesquisa e a web](#nós-de-pesquisa-e-a-web).
- **`gate`** — uma verificação escrita por você: um juiz LLM avalia a sua
  `condition` no worktree de integração, depois do merge, e escolhe uma das
  saídas que você declarou. Compila para um `CheckStep`.

Todo nó exceto o `prompt` carrega um **join** (veja abaixo). Todo nó carrega um
`label` (a plaquinha no canvas) e um campo opcional `notes` — a margem do humano,
que **nunca chega a um agente**.

Os tetos são duros, são declarados uma única vez em `graph-types.ts`, e quem os
impõe é o **validador** — não o schema, que carrega tetos anti-DoS próprios e
bem mais altos (veja [Como um grafo compila](#como-um-grafo-compila)):

| Teto | Valor | Constante |
|---|---:|---|
| nós | 40 | `DEVGRAPH_MAX_NODES` |
| arestas | 80 | `DEVGRAPH_MAX_EDGES` |
| caminho raiz→folha mais longo (aviso) | 12 | `DEVGRAPH_MAX_DEPTH` |
| braços por nó que ramifica | 12 | `DEVGRAPH_MAX_BRANCHES` |
| arquivos escolhidos à mão por nó | 400 | `DEVGRAPH_MAX_FILES` |
| label do nó | 80 chars | `DEVGRAPH_MAX_LABEL` |
| `prompt.goal` / `action.prompt` | 4000 chars cada | `DEVGRAPH_MAX_GOAL` / `DEVGRAPH_MAX_PROMPT` |

Um id de nó é um slug (`^[a-z0-9][a-z0-9-]{0,39}$`) — ele vira parte do nome do
passo compilado, então precisa ser seguro como caminho e como nome de passo.

## O catálogo de blocos

Um nó `action` não carrega um prompt que você tem que inventar; ele carrega um
**bloco** — um método que alguém já subscreveu. Largar `tdd` no canvas é uma
decisão sobre processo, não um exercício de escrever prompt. São quinze blocos,
na ordem da paleta (`src/lib/dev-graph/node-catalog.ts`):

| Bloco | Escopo padrão | Escreve lista? | Só leitura? | Crítico? |
|---|---|:--:|:--:|:--:|
| `recon` — mapeia o repositório e escreve a lista de alvos | `project` | ✅ | | |
| `implement` — faz a mudança, sem ampliar o escopo | `project` | | | ✅ |
| `tdd` — o teste que falha primeiro, depois o código | `project` | | | ✅ |
| `tests` — cobre código existente sem nunca editá-lo | `per-file` | | | ✅ |
| `security-review` — audita e RELATA | `per-file` | | ✅ | |
| `performance-review` — audita e RELATA | `project` | | ✅ | |
| `refactor` — só estrutura, comportamento idêntico | `per-file` | | | ✅ |
| `docs` — verificado contra o código, não contra a intenção | `project` | | | |
| `characterize` — congela o comportamento de hoje em snapshots | `per-file` | | | ✅ |
| `lint-fix` — traz os checks estáticos do projeto ao verde | `project` | | | |
| `consolidate` — um relatório único a partir dos nós anteriores | `project` | | | |
| `custom` — bloco em branco: o método é seu | `project` | | | |
| `security-findings` — audita e ESCREVE uma tarefa por achado | `project` | ✅ | | |
| `performance-findings` — idem, para custos mensuráveis | `project` | ✅ | | |
| `review-findings` — idem, para defeitos de revisão de código | `project` | ✅ | | |

A ordem é contrato: o array é servido ao navegador e renderizado como a paleta
nessa ordem, então blocos novos são acrescentados no fim, nunca inseridos.

### `-review` e `-findings` não são duplicatas

`security-review` e `security-findings` diferem na única dimensão que importa
para um grafo: **se o nó consegue entregar DADOS ao nó seguinte.**

```
security-review     readOnly: true,  produces: false  → RELATA.
security-findings   readOnly: false, produces: true   → ESCREVE ORDENS DE SERVIÇO.
```

No huu o único canal passo→passo é o **sistema de arquivos commitado** do
worktree de integração — o `reason` de um juiz nunca chega ao prompt seguinte.
Então um nó que não escreve nada é um beco sem saída de dados: ele consegue
rotear controle (por um gate), mas não consegue dizer ao nó seguinte *o que
achou*. E o `WorkStep.readOnly` é imposto na camada do harness (o backend entrega
à sessão uma allowlist de ferramentas sem `edit` e sem `write`), então `readOnly`
e `produces` são mutuamente exclusivos — pinado por um teste em
`node-catalog.test.ts`.

Os blocos `-findings` escrevem **um arquivo markdown de tarefa por achado** em
`.huu/findings/<eixo>/`, cada um declarando os arquivos que possui, mais uma
lista `huu-memory-v1` cujas entradas apontam para os *arquivos de tarefa*. O nó
seguinte abre um leque de um agente por entrada, então ali `$file` é o briefing e
`$hint` é a linha única "o que está quebrado". É isso que torna **"auditar → um
agente por problema"** expressável; antes desta família, `recon` era o único
produtor do catálogo e todo leque tinha que começar numa lista de arquivos.

Cada bloco carrega também uma `judgeClause` — uma frase de aceitação
mecanicamente verificável. Ela **não** vira um passo próprio. Ela é usada duas
vezes, sempre como texto: anexada ao prompt do agente como a aceitação contra a
qual ele será medido, e entregue ao crítico por tarefa como o padrão declarado.
Se você quer que essa cláusula *roteie* alguma coisa, desenhe um nó de gate — que
é exatamente a decisão que este formato devolve para você.

## Joins: `all`, `subset` e a barreira de merge

Cada nó que não é a raiz declara como trata as arestas que entram nele:

- **`all`** (o padrão) — todo predecessor direto é uma dependência. Isto é
  `dependsOn` puro, em termos de pipeline.
- **`subset`** — só os predecessores listados são dependências. Os outros
  continuam no canvas como puro desenho: eles ainda mostram de onde o trabalho
  veio, mas o nó não espera por eles. É a forma "abre três revisões em paralelo,
  segue a partir da de performance".

**Leia isto antes de projetar em cima de `subset`.** O huu executa em ondas BSP
sobre git: ao fim de toda etapa, **todos** os ramos são mesclados no worktree de
integração antes de a etapa seguinte começar. Relaxar um join tira a
**dependência** — de dado e de sucesso — entre os ramos: o nó deixa de esperar os
predecessores dispensados e deixa de falhar quando eles falham. Isso **não** tira
a barreira de merge da onda, e não faz o nó começar antes em tempo de relógio se
os ramos dispensados já estão na mesma onda. Não existe semântica de "pular a
barreira" no huu, e este formato não inventa uma.

O validador diz a mesma coisa na sua cara: um join `subset` que de fato dispensa
alguma coisa emite o aviso `join-subset-drops-barrier`, redigido exatamente
assim. Um `subset` num nó com uma (ou nenhuma) aresta de entrada emite
`join-subset-single-inbound` — ali ele não muda nada.

Duas consequências que vale conhecer:

- "A montante", para o contexto de pesquisa, significa o fecho transitivo das
  dependências **efetivas**, não das arestas desenhadas. Um nó que dispensou uma
  aresta de entrada nunca é mandado ler o `research.md` daquele ramo, porque nada
  garante que o arquivo já exista — e dispensar a aresta foi você dizendo "não
  quero esta entrada".
- Uma aresta de retrabalho nunca é dependência (próxima seção), então ela nunca
  participa de um join.

## Nós de pesquisa e a web

Um nó de pesquisa faz **uma** pergunta e transforma a resposta em algo sobre o
que o resto do grafo consegue agir. Três tipos de saída:

- **`boolean`** — decide uma afirmação; os braços são os ids fixos `yes` e `no`;
- **`choice`** — decide entre opções fechadas que você cadastrou (≥ 2 ids);
- **`info`** — **não** roteia nada. O resultado dele entra nos nós seguintes como
  **contexto**. Como ele não ramifica, as arestas que saem dele não podem nomear
  braço (`edge-outcome-forbidden`); ele ainda pode alimentar vários sucessores, e
  cada um deles é instruído a ler o artefato.

`useContext` diz se a resposta tem que ser fundamentada *neste* repositório (o
agente lê o código) ou respondida só a partir do modelo e da web.

Todo nó de pesquisa escreve **dois arquivos commitados** no seu próprio diretório
dentro do quadro-negro do grafo — `research.json` (estruturado, `_format:
"huu-research-v1"`) e `research.md` (para um humano e para o próximo agente). Até
o `info`, que não roteia nada, escreve os dois: o arquivo commitado é o *único*
canal que um nó tem para o nó seguinte.

### A escada de degradação

Um agente de pesquisa tem sete ferramentas — `bash edit find grep ls read
write` — e nenhuma delas é ferramenta de web. A internet só existe através do
`bash`, então o prompt de pesquisa descreve **comandos de shell** e nomeia os
binários exatos que a imagem entrega. Ele desce uma escada de **dois degraus** e
para no primeiro que **funcionar**:

| Degrau | Comando | `method` registrado |
|---|---|---|
| **A** — busca com chave (Brave, o único backend) | `surf-research-skill gate` e então `surf-search-normal "…" --task … --goal …`; links crus via `surf-research-skill search "Q1" "Q2" "Q3"` | `surf-research` |
| **B** — `curl` de uma URL que o agente já conhecia | `curl` + `jq` (sempre presentes) | `direct-fetch`, ou `none` |

**Não existe degrau sem chave.** A surf v8 (`surf-agent-skill`, o que o
Dockerfile instala) busca no Brave e em mais nada, e o `surf-free-skill` — o
antigo degrau Wikipedia→DuckDuckGo — não existe nela. Sem chave do Brave o
`gate` sai **78 antes de rodar qualquer coisa**, o que é um veredito de
CONFIGURAÇÃO, não uma falha transitória: repetir queima um card de agente e não
muda nada. O prompt diz isso explicitamente, pra que o agente não saia caçando
um binário que não vai voltar. O `method: "surf-free"` sobrevive só como valor
APOSENTADO — nenhum nó novo escreve esse valor, e um artefato que o carrega é
antigo o bastante pra que a evidência dele não possa mais ser re-executada.

**A escada degrada por FALHA, não apenas por ausência** — e essa distinção é o
ponto inteiro. `command -v` prova que um binário está *instalado*; não prova que
ele tem chave, cota ou rede. A imagem instala o CLI de busca em tempo de build
independentemente de qualquer chave, e a materialização de chaves do huu é
explicitamente não-fatal, então "instalado e sem chave" é um estado comum. Por
isso o prompt conta como **falha da camada** (e desce): exit code diferente de
zero, saída vazia, qualquer menção a credencial ausente ou inválida (`no … key`,
`unauthorized`, `401`, `403`), qualquer menção a cota ou limite (`quota`, `429`),
e qualquer erro de rede (`timeout`, `ENOTFOUND`, `connection refused`).

`direct-fetch` existe para que um nó que buscou a página oficial, achou a
resposta e citou a URL não seja obrigado a escrever `none`. `none` significa que
literalmente nada externo foi obtido — e o bloco entregue aos consumidores a
jusante diz isso: *"trate o nó como não respondido"*.

### `defaultOutcome` é decisão sua, não do modelo

Um nó de pesquisa que ramifica (e todo gate) precisa nomear um `defaultOutcome`.
É a saída que o `CheckStep` compilado marca como `default: true`, e a regra de
default-para-a-frente do huu a dispara em **toda** falha: juiz que quebra,
timeout, arquivo ausente, JSON corrompido, um rótulo fora do enum.

O huu não consegue derivar qual rota é segura. Para *"existe CVE conhecida nesta
biblioteca?"*, `no` significa "adote a biblioteca" — então uma falha de juiz
respondendo `no` em silêncio se leria como "a biblioteca é segura", a resposta
mais destrutiva disponível. Qual lado é o cauteloso depende inteiramente de qual
ramo é caro de tomar por engano, e só você sabe isso.

O juiz que roteia um nó de pesquisa é deliberadamente **mecânico**: ele não
re-pesquisa e não julga o mérito da pesquisa. Ele lê um campo de um arquivo e o
transcreve para dentro do enum.

## Retrabalho — o braço que volta

*"Portão de qualidade: se falhou, volta e conserta"* é a razão mais comum para um
gate existir. Marque a aresta desse braço com `rework: true` e ela vira uma rota
**de volta** a um nó que já rodou.

Não é um ciclo, porque um devgraph tem **duas camadas sobre um desenho**:

```
camada de DEPENDÊNCIA   toda aresta SEM `rework`. É o que vira `dependsOn`, o que
                        a ordem topológica ordena, o que "ancestral" significa —
                        e a ÚNICA camada em que se procura um ciclo.
camada de ATIVAÇÃO      toda aresta, retrabalho incluído. É o que roteia
                        (`outcomes[].nextStepName`) e o que a alcançabilidade segue.
```

Uma aresta de retrabalho nunca vira dependência: se virasse, o alvo passaria a
esperar o gate que vem *depois* dele, e o desenho seria um ciclo de dependência
de verdade. O próprio `validateTopology` do huu enuncia a regra: laços pertencem
a `next`/`outcomes` (arestas de ativação), nunca a `dependsOn`.

Ela não é inferida de **nada**. Um braço para trás sem a flag continua sendo erro
`cycle`, porque um laço que o humano não subscreveu é um laço que ninguém
assinou. Quatro códigos de erro estáveis o policiam:

- `rework-edge-not-from-branch` — a origem só tem uma saída;
- `rework-edge-needs-outcome` — uma rota de retrabalho continua sendo um *braço*,
  então precisa de um `sourceOutcome`;
- `rework-edge-not-backward` — o alvo não é ancestral na camada de dependência,
  isto é, uma aresta para a frente vestida de laço;
- `default-outcome-is-rework` — **o default nunca pode ser o laço.**

Esse último é a regra a memorizar. O default dispara quando o juiz *falha*, então
ele tem que ser a rota segura para a frente; um default que volta transforma um
juiz quebrado num run que gira até o orçamento de execução matá-lo.

O que limita um laço legítimo é o `maxRuns` do próprio gate. Um gate que de fato
tem um braço de retrabalho e não nomeou `maxRuns` recebe **3**
(`DEVGRAPH_REWORK_CHECK_MAX_RUNS` — o primeiro veredito mais duas chances de
consertar); todo outro check recebe **2** (`DEVGRAPH_CHECK_MAX_RUNS`), que é o
que faz todo grafo desenhado antes de laços existirem compilar byte a byte igual.
O `Pipeline.maxNodeExecutions` é o backstop de run inteiro por baixo, e o
compilador *orça as repetições* para que o backstop nunca corte um laço que você
desenhou de propósito.

## Leque (fan-out)

Um nó de ação pode rodar **um agente por entrada de uma lista que um nó anterior
escreveu**. Aponte `fanOutFrom` para o id de um nó de ação **ancestral** cujo
bloco `produces` uma lista `huu-memory-v1`; o compilador emite
`scope: 'memory'` + `filesFrom` apontando para a lista daquele nó.

O validador impõe as três metades dessa frase, cada uma com seu código:

- `fanout-source-unknown` — o nó nomeado não existe;
- `fanout-source-not-ancestor` — ele não roda antes deste nó;
- `fanout-source-not-producer` — o bloco dele não `produces` lista nenhuma.

E os dois descompassos de escopo: `fanout-needs-memory-scope` (um `fanOutFrom`
com escopo explícito diferente de `memory`) e `scope-memory-needs-fanout` (um
escopo `memory` sem nada para ler).

`maxFiles` é a **largura que você está subscrevendo**, não uma sugestão — uma
entrada é um agente, uma worktree, um merge. Sem valor, o passo compilado recebe
**40** (`DEVGRAPH_DEFAULT_FAN_OUT`, o mesmo default que o orquestrador aplica); o
compilador o limita a **100** (`DEVGRAPH_MAX_FAN_OUT`) e reporta o corte como
aviso. Repare que este é um número diferente de `DEVGRAPH_MAX_FILES` (400): um é
quantos arquivos um humano pode escolher à mão, o outro é quão largo um leque de
runtime pode ficar.

**Onde a lista mora, e por que não é o lugar arrumado.** As listas dos produtores
são escritas em `.huu/findings/<namespace>/<id-do-nó-produtor>.json` — *fora* do
quadro-negro do grafo. Os prompts dos blocos produtores dizem ao agente que, num
repositório cujo `.gitignore` carrega `.huu/`, ele pode reescrever aquela linha
para `.huu/*` e acrescentar `!.huu/findings/` — "a única edição permitida". Esse
remédio reinclui `.huu/findings/**` e mais nada, então uma lista escrita em
qualquer lugar mais arrumado continuaria ignorada, não commitada e invisível para
o leque, que então despacharia zero agentes em silêncio. O namespace carrega a
**sessão e a época**, então uma re-execução cujo produtor não escreveu nada não
acha lista, resolve para zero tarefas e a etapa completa vazia — o resultado
honesto — em vez de despachar agentes sobre os alvos de ontem.

## Como um grafo compila

O `compileGraphPipeline` (`src/lib/dev-graph/graph-to-pipeline.ts`) é mecânico e
puro. Ele emite, por tipo de nó:

| Nó | Emite |
|---|---|
| `prompt` | nada |
| `action` | um `WorkStep` |
| `research` (`info`) | um `WorkStep` |
| `research` (`boolean` / `choice`) | um `WorkStep` **e** um `CheckStep` que transcreve o veredito do artefato numa rota |
| `gate` | um `CheckStep` |

**Os nomes de passo** carregam três trabalhos numa string só:

```
nó de um passo   3. Revisão de segurança [seguranca]
par de pesquisa  3a. Existe CVE conhecida? [cve]
                 3b. Existe CVE conhecida? — decisão [cve]
```

O prefixo de posição é o lugar 1-based do nó na ordem topológica (então um kanban
e um log leem na ordem de execução); o label é o que você escreveu na plaquinha;
o sufixo `[id-do-nó]` é a identidade durável que mapeia um card de volta à caixa
que você desenhou. A unicidade é estrutural — um nó, uma posição — então a regra
de nomes duplicados do `validateTopology` nunca pode disparar nesta saída. O
`CompiledGraph.stepsByNode` é a forma legível por máquina do mesmo mapeamento.

**`dependsOn`** são as dependências *efetivas* do nó mapeadas para nomes de
passo, com o nó de prompt descartado (ele não emite passo, então um nó pendurado
no objetivo vira raiz com `dependsOn: []`). Um nó que depende de um par de
pesquisa depende do **CheckStep**, nunca do passo de trabalho sozinho: o par só
está pronto quando o juiz dele roteou.

**As saídas** são lidas da camada de ativação, então um braço de retrabalho ganha
seu `nextStepName` como qualquer outro — apontando para o **primeiro** passo de
um nó que já rodou. Exatamente uma saída é forçada a `default: true`, e entre as
candidatas o compilador prefere o último braço que vai **para a frente**.

**Exatamente uma aresta por braço** — zero é `branch-outcome-missing-edge`, duas
é `branch-outcome-multiple-edges` — porque um `CheckStep` roteia para um
`nextStepName` por saída. Para paralelizar *depois* de uma decisão, aponte o
braço para um único nó de ação e deixe **esse** nó abrir o leque.

**As regras são 46 códigos bloqueantes e 4 avisos** (`GraphErrorCode` /
`GraphWarningCode` em `graph-types.ts`). O *código* é a identidade estável de um
problema — a UI o mapeia para uma frase traduzida — então renomear um é mudança
quebrante, enquanto reescrever a `message` de um problema não é. Um defeito
recebe exatamente um código: deliberadamente não existe `orphan-node` (um nó sem
aresta de entrada que não é a raiz já é `unreachable-node`), um nó preso num
ciclo é reportado só como `cycle` (a causa, não a consequência dela), e uma
aresta que falha numa regra `rework-*` não é também reportada sob a família
genérica `edge-outcome-*`.

**O schema e o validador não são a mesma camada**, e a divisão é deliberada. O
schema zod (`parseDevGraph`) é dono da **forma** e de um conjunto de tetos
anti-DoS bem acima dos tetos de produto — 500 nós, 1000 arestas, 20 000
caracteres de texto — enquanto o validador é dono dos tetos em si e de toda regra
que um humano deve *ver*. Um erro de parse é um
canvas em branco e um desenho perdido; um problema é um a-fazer que você conserta
na tela. A mesma regra separa os ids: uma **declaração** (id de grafo, de opção,
de saída) é estrita no zod, enquanto uma **referência** (id de nó, origem/destino
de aresta, `fanOutFrom`, entrada de subset de join) é permissiva ali e checada
pelo validador, onde o problema pode ser mostrado sobre a caixa que o carrega.

**Dois portões, e eles são assimétricos de propósito.** O `validateGraph` nunca
lança — o editor valida a cada tecla de um grafo pela metade, e um throw ali é um
canvas em branco. Já o *compilador* lança no primeiro grafo inválido que recebe,
porque um compilador que "conserta" em silêncio um método quebrado roda um método
que ninguém subscreveu. Ele lança uma segunda vez se a própria saída dele falhar
no `PipelineSchema` — isso é bug do huu, não desenho ruim, e a mensagem diz isso.
Tudo o que ele consegue reparar (números limitados, listas de arquivo
descartadas, um escopo rebaixado) volta em `warnings`, que toda superfície deve
**mostrar**.

**Texto do autor que viaja é neutralizado.** O objetivo e a `condition` de um
gate são colados em prompts cujos marcadores `=== SEÇÃO ===`, enums fechados e
blocos JSON de veredito são a *maquinaria* do huu, então os dois passam pelo
`neutralizePromptText`: crases viram `'`, aspas viram `”`, sequências de `===`
colapsam, e as tags `<query>`/`<allowed-labels>` são reescritas com guilhemetes.
O `prompt` próprio de um nó **não** é neutralizado — ele *é* a instrução daquele
nó, as cercas dele são você escrevendo um prompt, e não há fronteira a cruzar. As
`notes` nunca chegam a agente nenhum. Isto é uma regra de coerência, não uma
fronteira de segurança: quem escreve um devgraph subscreve o run. O que ela
compra é que colar uma spec com `=== HARD RULES ===` dentro do seu objetivo
produz um prompt que continua querendo dizer o que diz.

## As três superfícies

**O navegador** é onde você *desenha* — `/graph`, uma rota de verdade
(favoritável), e a única superfície que cria um nó com o mouse. O canvas é
renderizado pelo **React Flow** (`@xyflow/react` 12.11.2), pré-empacotado com
React 18.3.1 num único arquivo ESM commitado que o navegador carrega direto: o
cliente do huu é uma app sem build e sem CDN, então o bundle vendorizado *é* a
dependência e não existe dependência npm de React. O React Flow só **desenha**; a
verdade é o devgraph.

Você acrescenta um nó pela **linha do braço** na borda direita do card de um nó —
a linha que carrega o nome do braço, um `+` e a bolinha do conector. Clicar em
qualquer ponto dessa linha (a bolinha inclusa) abre um menu-paleta com todos os
blocos do catálogo, agrupados pelo que o bloco *faz* — "achados e listas",
"auditar sem alterar código", "escrever código" — mais os outros dois tipos de nó
desenháveis, `research` e `gate`. (O `prompt` nunca é oferecido: a raiz não aceita
aresta de entrada.) Escolher uma entrada cria o nó **e** a aresta num movimento
só; se a conexão for recusada, o nó não fica largado ali. As entradas que as
regras proíbem continuam visíveis e clicáveis, cinzas e com o motivo junto, para
que um clique traga a recusa em voz alta em vez de nada. Teclado:
`Enter`/`Espaço` sobre a linha do braço abre a paleta, `↑`/`↓` a percorrem,
`Enter` escolhe, `Escape` fecha.

O **inspector** ao lado edita o nó selecionado: o label, o campo de texto próprio
dele (`goal` / `prompt` / `query` / `condition`), a política de join, as `notes`,
o `modelId` por nó e tudo o que é específico do tipo — o `outputKind` e as opções
de um nó de pesquisa, as saídas e o `maxRuns` de um gate, o `fanOutFrom`, o
`scope`, os `files`, o `maxFiles` e o botão de `review` de um nó de ação. O
`promptTemplate` do bloco é mostrado só para leitura, para você ver o método que
largou sem poder corrompê-lo ali; limpar o `prompt` de override de uma ação
restaura o template. Trocar o `outputKind` de um nó de pesquisa de um jeito que
orfanaria arestas pergunta antes, listando cada ligação que cairia. Braços para
trás (retrabalho) ganham um construtor próprio, porque arrastar um é recusado
como `cycle` — correto e inútil.

A validação roda **ao vivo**, com debounce de 400 ms, a cada mudança: os
problemas são agrupados por âncora, nós e arestas ganham estilo de erro/aviso com
um contador, e o que não tem âncora (um payload que nem é um devgraph) cai numa
lista global — um canvas que só soubesse destacar nós o descartaria e pareceria
verde para um grafo que a store vai recusar salvar. Um **aviso não é defeito**:
`join-subset-drops-barrier` é a resposta esperada exatamente para o grafo que
esta tela existe para desenhar, então ele é contado à parte e nunca deixa o
status vermelho. Erros de compilação também pintam nós, e qualquer edição aposenta
a resposta da compilação.

A superfície HTTP é o `src/web/graph-api.ts`, sob `/api/graphs`:

| Rota | Verbo | O que faz |
|---|---|---|
| `/api/graphs` | GET | lista os grafos salvos (`?dir=` escolhe o repositório) |
| `/api/graphs/catalog` | GET | a paleta: blocos, tipos de nó, metodologias |
| `/api/graphs/validate` | POST | roda as regras num grafo enviado |
| `/api/graphs/compile` | POST | compila um grafo enviado para um pipeline |
| `/api/graphs/from-sample` | POST | salva uma das amostras como grafo seu |
| `/api/graphs/<id>` | GET · PUT · DELETE | lê · salva · apaga um grafo |

`catalog`, `validate`, `compile` e `from-sample` são **ids reservados**: eles
também são slugs legais, então os caminhos de escrita os recusam com 400 em vez
de deixar você salvar um grafo que nunca poderia ser lido de volta. Dois detalhes
de contrato que vale saber: o corpo é sempre o envelope `{ graph }`, nunca o
devgraph cru; e o `dir` viaja como **query** em GET/DELETE mas como **campo do
corpo** em PUT/POST — um `dir` na query de um PUT é ignorado em silêncio e o
grafo cai no diretório de trabalho do próprio huu em vez do seu. O
`POST /validate` sempre responde 200 — um grafo cheio de erros é uma resposta,
não uma falha de transporte. O `POST /compile` recusa com 400 e, quando a recusa
vem do **validador**, ela carrega o `errors[]` completo junto da mensagem,
justamente para o canvas pintar os culpados sem um segundo round-trip; uma recusa
na camada de **forma** (sem `graph` no corpo, ou um que o schema rejeita) carrega
só a mensagem, porque não há âncora por nó para pintar.

**Salvar é explícito** — o botão de salvar, não um autosave — e não existe undo
nem redo. O seletor de amostras também não é preview: escolher uma **grava em
disco na hora** como um grafo novo seu, com sufixo numérico se o id já estiver
tomado.

**A CLI** é o `huu graph`, para quem vive no terminal:

```bash
huu graph list                        # os desenhos salvos
huu graph show <id>                   # a topologia em texto, na ordem de execução
huu graph validate <id>               # as regras; sai != 0 se houver erro
huu graph compile <id> --out p.json   # um huu-pipeline-v2 PORTÁTIL
huu graph new <id> [--from <amostra>] [--name <n>] [--force]
huu graph rm <id>
```

Disciplina de saída: o **stdout** carrega o payload (a listagem, a topologia, o
relatório, o pipeline quando não há `--out`), o **stderr** carrega progresso e
recusas. Então `huu graph compile <id> > pipeline.json` grava um pipeline e mais
nada. Um arquivo compilado é um artefato genuinamente portátil — rode-o com
`huu auto pipeline.json --config <config.json>`, em qualquer repositório, sem
modo dev nenhum envolvido.

**A TUI** é um seletor, não um canvas — `[G]` na tela de boas-vindas. Ela lista os
desenhos, lê um em voz alta como diagrama ASCII, mostra todo problema que o
validador achou e entrega o **pipeline compilado** à cadeia de execução que a TUI
já tem. As teclas estão no [KEYBOARD.md](KEYBOARD.md).

**Rodar um** é o `huu dev`:

```bash
huu dev "<o objetivo>" --graph=<id>              # um grafo salvo em .huu/dev/graphs/
huu dev "<o objetivo>" --graph=./drafts/a.json   # um arquivo
```

…pelo terminal, ou `R` na tela de grafos da TUI. **Pelo navegador** é o painel
*Método* do formulário `/dev` — `Planner LLM | Método que você desenhou`, mais um
seletor dos métodos salvos — ou o **Rodar este método** do canvas, que entrega o
id a esse mesmo formulário em vez de iniciar a sessão por conta própria. Os dois
caminhos enviam `graphId`, então o desenho precisa estar **salvo** antes (veja
[Limites conhecidos](#limites-conhecidos)).

Um slug puro é um **id**; qualquer coisa com `/` ou `.` é um **caminho**, então os
dois nunca podem ser confundidos. Com um grafo em mãos, **as Fases A e B da época
não acontecem** — não "são puladas para economizar": a Fase B escreve um plano e o
plano já existe, e a Fase A existe para instruir quem escreve o plano. O planner
LLM nunca é chamado. O que sobrevive intocado é tudo o que vem *depois* do run: o
merge de aterrissagem, a evidência da época, o commit do quadro-negro.

O portão de aprovação continua sendo portão. O `--approve-each` mostra o desenho
projetado no painel de plano — uma frente por nó, com a largura de leque
**compilada** como o raio de explosão que você está assinando — e, sem ninguém
ligado para responder, ele significa *não*.

## Exemplos prontos

Seis amostras acompanham o huu (`huu graph new <id> --from <amostra>`, ou a tecla
`S` na TUI, ou *from-sample* no navegador). Cada uma é salva como grafo **seu** —
nada é carregado pelas suas costas:

| Amostra | Nós / arestas | O que demonstra |
|---|:--:|---|
| `tdd-seguranca-performance` | 5 / 6 | três frentes em paralelo e um join `subset` — incluindo a nota honesta sobre o que relaxar um join faz e não faz |
| `pesquisa-booleana` | 4 / 3 | uma pergunta sim/não roteando o trabalho, com os dois braços cadastrados e `no` como default seguro |
| `pesquisa-multipla-escolha` | 5 / 4 | uma escolha de três caminhos, uma aresta por braço, com default no único ramo que não toca código de produção |
| `pesquisa-informativa` | 4 / 3 | um nó `info`: uma saída, nenhum braço nomeado, `useContext` ligado |
| `recon-fanout` | 4 / 3 | o recon escreve a lista de alvos e o nó seguinte abre um agente por entrada |
| `portao-de-qualidade` | 5 / 4 | um gate com condição mecanicamente verificável e `approved` como default para a frente |

## Limites conhecidos

Lista honesta. Cada item foi verificado no código.

- **Uma sessão de grafo é EXATAMENTE UMA época.** `--epochs` maior que 1
  combinado com `--graph` é **recusado** (`graph-conflict`), não rebaixado em
  silêncio: um devgraph é o método completo, e rodar o mesmo desenho de novo não
  é uma segunda época. Rodar o mesmo objetivo de novo é oferecido como *resume*,
  que continua a numeração de épocas dentro da mesma sessão.
- **A Fase 0 continua rodando.** Só A e B sumiram. Num repositório sem
  agent-skills e sem `--skip-knowledge`, uma sessão de grafo faz o bootstrap do
  sistema de skills primeiro — um agente pi de verdade escrevendo arquivos de
  verdade, commitados antes de uma única caixa compilar — e uma falha ali para a
  sessão com `bootstrap-failed` antes de o grafo ser tocado. Isso é deliberado: os
  prompts dos nós só ganham o prefixo do project-router quando a sonda de
  knowledge diz que ele está lá.
- **`reportExcerpt` fica vazio numa época desenhada.** O huu lê o relatório de
  consolidação de um caminho que *ele* compilou no caminho do planner; o bloco
  `consolidate` de um devgraph não nomeia arquivo de saída nenhum, então não há
  caminho para ler. O resultado vazio é o huu se recusando a adivinhar, não o huu
  procurando no lugar errado. Nada a jusante é prejudicado — o trecho só
  alimentava o prompt do planner da *próxima* época, e uma sessão desenhada nunca
  chega a um planner.
- **O scan de reconciliação de partição declarada não acha nada numa época
  desenhada.** Ele varre o diretório da época, e os arquivos de tarefa de um
  desenho moram em `.huu/findings/<eixo>/` por construção. Apontá-lo para o
  quadro-negro do grafo não acharia nada (ou casaria com um heading em formato de
  posse dentro de um relatório de pesquisa); apontá-lo para `.huu/findings/` seria
  pior, porque essa árvore é namespaceada por EIXO e suas specs são commitadas,
  então um desenho retomado releria os arquivos de tarefa da época anterior.
  **Nada fica realmente sem medição**: o check autoritativo é o próprio run, que
  colide posse declarada antes de todo leque `memory` e ao longo de todos os
  passos até ali — e esse check está vivo no caminho desenhado também.
- **As 12 flags de metodologia NÃO são compiladas por um desenho.** Elas são
  validadas, carregadas como metadado e **avisadas**, no compilador e de novo no
  início da sessão. Cada flag compila uma *estrutura* dentro de um grafo que o
  planner escreveu; um devgraph expressa método DESENHANDO (largue o bloco `tdd`,
  desenhe um nó de gate), e acrescentar passos que ninguém desenhou é exatamente
  a decisão que este formato tira da máquina. O roteamento de modelo por papel
  (`--worker-model` e companhia) é ignorado pelo mesmo motivo — um desenho tem
  caixas, não papéis. Roteie pelo `meta.modelId` do grafo ou por um `modelId` de
  nó.
- **O navegador lança um desenho só por *id*, e só um que já esteja salvo.** O
  `POST /api/dev` aceita um método desenhado como `graphId` (um id salvo) ou como
  um `graph` inline, e recusa com 400 (`graph-not-found`, `graph-invalid`,
  `graph-conflict`) um que esteja presente mas inutilizável, em vez de cair no
  planner. O cliente envia **`graphId` e nunca o `graph` inline**, então o canvas
  *como está na tela* não é executável: o **Rodar este método** fica desabilitado,
  com a razão escrita embaixo, até o validador ficar verde **e** o documento ainda
  ser o que o servidor viu por último. ("Salvo" é igualdade por REFERÊNCIA contra
  o último documento que veio do fio — toda mutação devolve objeto novo — então
  erra para o lado de *não salvo*, o lado inofensivo: `huu dev --graph` lê o
  ARQUIVO, e rodar um canvas editado-mas-não-salvo rodaria o método antigo com o
  desenho novo na tela.) Dois controles chegam ao fio, e nenhum é um segundo
  lançador: o painel **Método** do formulário `/dev` (`Planner LLM | Método que
  você desenhou`, mais um seletor dos métodos salvos), e o botão do canvas — que
  não faz POST nenhum. Ele só *nomeia* o método, disparando o evento de documento
  `huu:run-graph` (um evento de DOM e não uma chamada: o `launch.js` já importa o
  canvas, então importar o `dev.js` de volta fecharia um ciclo de ESM); o `/dev`
  adota o id e o submit comum é que inicia a sessão, então existe exatamente um
  caminho de submit e um corpo a testar. O `maxEpochs` nunca é enviado em nenhum
  dos dois caminhos — uma sessão desenhada é exatamente uma época, e um
  `maxEpochs >= 2` explícito é `graph-conflict` antes de a sessão existir. A
  biblioteca também é **por projeto**: o `GET /api/graphs?dir=` lê a store dentro
  do diretório escolhido, então trocar de projeto limpa a seleção e re-lista, e a
  passagem vinda do canvas re-lista também — senão um id do projeto anterior, ou
  um salvo segundos atrás, chega ao servidor como `graph-not-found`. O botão de
  **compilar** continua o mesmo, e continua sendo uma prévia só de leitura: cada
  passo, seu `dependsOn` e o `label → nextStepName` de cada saída, com o default
  marcado.
- **Não existe primitiva de rename.** A store indexa um grafo pelo id e deriva o
  nome do arquivo dele, e a superfície HTTP não tem rota de rename. O rename do
  navegador é portanto um **dois-passos destrutivo** — apaga o id antigo, salva
  no novo — atrás de um aviso explícito e uma confirmação; se o apagar falhar, o
  salvar prossegue mesmo assim e você é avisado de que os dois agora existem. Pela
  CLI é `huu graph new <novo-id> …` mais `huu graph rm <id-antigo>`.
- **O `meta` do grafo não tem editor no navegador.** `meta.methodology`,
  `meta.maxNodeExecutions` e `meta.modelId` são lidos e honrados pelo compilador
  (e mostrados pelo `huu graph show`), mas nada no canvas ou no inspector os
  escreve — só o `modelId` **por nó** é editável. Ajuste-os editando o JSON.
- **`.huu/dev/graphs/*.json` fica gitignorado na maioria dos repositórios** —
  inclusive neste, cujo `.gitignore` carrega `.huu/`. Um desenho salvo *não* é
  versionado a menos que você o designore, e "meu método sumiu quando clonei em
  outro lugar" é um resultado real. A store não toca em git nenhum; ela lê e
  escreve a árvore de trabalho direto.
- **Retomar uma sessão desenhada exige re-fornecer o desenho.** Um resume
  reabre uma sessão, não os argumentos com que ela começou. Sem o grafo, o huu
  **recusa** (`graph-missing-on-resume`) em vez de cair no planner LLM — trocar o
  seu desenho pelo plano de um modelo, em silêncio, dentro de uma sessão que você
  abriu como desenho, é exatamente a falha que este recurso existe para deletar.
  Um resume carregando um grafo *diferente* também é recusado (`graph-conflict`).
- **A geometria do canvas não é coberta por teste automatizado, e as próprias
  suítes dizem isso.** `canvas.test.js` e `inspector.test.js` montam a árvore
  React Flow de verdade no jsdom — que não tem layout, então todo elemento mede
  0×0, o React Flow nunca mede os nós e nenhum path de aresta é calculado. O que
  fica provado é o *grafo*: quais nós existem, a que braço uma bolinha pertence,
  que classe CSS uma aresta carrega, o que o modelo faz com um evento de arrasto.
  O que **não** fica provado é coordenada de bolinha, roteamento de aresta, a
  transformação de pan/zoom, o `fitView`, nem se a paleta aparece ao lado da
  bolinha a que pertence (o helper que limita a posição do popover não tem teste
  nenhum). A aritmética de posição do modelo *é* testada. Qualquer mudança na
  superfície de desenho em si precisa de olho humano num navegador de verdade.

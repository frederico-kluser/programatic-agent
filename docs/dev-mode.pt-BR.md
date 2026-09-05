# Modo de desenvolvimento (`huu dev`)

> EN: [dev-mode.md](dev-mode.md) · Voltar ao [índice](README.md)

O modo de desenvolvimento é o **único** fluxo do huu cujo grafo de passos é
escrito em tempo de execução. Você escreve o objetivo; um planejador o
decompõe em **frentes** paralelas; cada frente vira um enxame de agentes em
worktrees; tudo é compilado num pipeline `huu-pipeline-v2` comum e roda no
mesmo escalonador de ondas de sempre.

## Como isso conversa com o MANIFESTO

Mal, em dois pontos, e vale dizer isso logo. O MANIFESTO vende **"zero planner
LLM em runtime"** como diferencial #2 e afirma que o huu **"não é uma
ferramenta para desenvolver features novas"**. O modo de desenvolvimento
contraria os dois: um planejador escreve o grafo de passos em tempo de
execução, e o alvo do trabalho costuma ser uma feature. A pergunta útil não é
se a tensão existe — existe — mas quais propriedades sobrevivem a ela, quais
ficam mais fortes e qual piora.

**Inegociável, e continua valendo:**

- **O humano assina o objetivo.** Ele entra verbatim, é gravado em
  `.huu/dev/goal.md`, e nenhum agente pode reescrevê-lo. O planejador
  *decompõe* — nunca amplia, reduz ou reinterpreta.
- **A forma da época é do huu, não do modelo.** O compilador emite um template
  fixo — recon global → frentes em paralelo (recon → enxame → juiz) →
  consolidação → portão → selo — e o revalida com o `PipelineSchema` de
  produção + `validateTopology`. Nem o schema da requisição de conhecimento nem
  o `DevPlanSchema` carregam `steps`, `dependsOn` ou caminhos de arquivo: o
  modelo escreve **conteúdo**, nunca **estrutura**. Ele é estruturalmente
  incapaz de emitir um grafo.
- **Todo caminho termina num juiz**, com condição mecanicamente verificável e
  exatamente um outcome `default: true` apontando para a frente.

**O que o desenho atual torna mais forte:**

- **O plano é um artefato que um humano pode assinar.** Com o portão ligado
  (`--approve-each`, ou *Approve each epoch* na web), o humano subscreve o
  próprio plano, não só o objetivo e o template da época. Com o portão
  desligado — que é o padrão, veja abaixo — ninguém o assina.
- **O pipeline compilado volta a ser artefato portátil** (diferencial #3):
  cada época persiste seu `pipeline.json` ao lado do quadro-negro, então o
  grafo pode ser relido, re-executado, editado e auditado em vez de ser jogado
  fora.
- **O planejador é cego.** Ele não lê arquivo nenhum. Declara as lacunas de
  conhecimento de que precisa, agentes as respondem contra o código real, e
  ele planeja a partir de um digest limitado — chega menos conteúdo
  inauditável do repo até ele do que na forma antiga, que lhe entregava um
  digest de arquivos truncado mecanicamente.

**O que piora, sem enfeite:** o merge passa a ser gated por um *crítico por
tarefa* cujo critério é prosa que outro LLM escreveu. Um achado bloqueante
devolve o diff ao mesmo agente antes de o branch ficar elegível ao merge do
estágio (`WorkStep.review`), e o padrão contra o qual o crítico julga — o
atlas da época, a spec da tarefa — também foi escrito por um modelo. A
barreira determinística de merge era o ponto; isso põe a opinião de um LLM na
frente dela. As defesas (crítico cross-family, rodar o gate antes de opinar,
regra de contraexemplo, cap duro de achados, forward-default em toda falha)
reduzem o estrago. Nenhuma delas torna o portão determinístico — para um que
seja, veja o lint gate opt-in em
[Opções de metodologia](#opções-de-metodologia).

### O que a pesquisa sustenta — e o que não sustenta

Três coisas para saber antes de confiar na forma deste modo.

**O líder DELEGA retrieval; ele não pula retrieval.** O orquestrador cego não
lê arquivo, mas isto não é "planejar sem olhar o repositório": a fase de
conhecimento **é** o retrieval, executada por agentes obrigados a citar
caminhos reais. A única comparação medida sobre entender repositório favorece
retrieval (busca semântica bate grep-only em ~12,5% de acurácia offline e
+2,6% de retenção de código em repos com 1000+ arquivos). Um líder que
recupera *nada* não tem apoio empírico em sistema nenhum que tenhamos achado —
então a leitura defensável deste desenho é delegação, e qualquer doc que
sugira o contrário está errado.

**A divisão de modelos NÃO é economia, e não é vendida como tal em lugar
nenhum.** Um fan-out de agentes custa **3-10× os tokens** de um agente único,
enquanto a diferença de preço entre o líder e os workers é de cerca de **2×**.
Rotear trabalho para o modelo barato não paga esse multiplicador. A
justificativa é isolamento de contexto e paralelismo — e, no caso do crítico,
uma segunda opinião de outro fornecedor.

**O orquestrador cego é hipótese instrumentada, não boa prática comprovada.**
A verificação adversarial das fontes deste próprio desenho derrubou a base
primária dos **dois** lados: caíram as citações a favor (o número de ganho
orchestrator-worker, "context pollution", o contrato de sumário de 1-2k
tokens) e as contra (escritas têm de ser single-threaded; o argumento do
"telefone sem fio" contra recon → enxame → juiz). Leia isso como *não citável
naquela passada*, não como *refutado* — mas significa que o líder cego entra
rotulado como hipótese, com contadores acoplados, e não como boa prática. O
crítico roda cross-family (`moonshotai/kimi-k2.6` contra workers DeepSeek)
pela mesma razão: a evidência aponta *o mesmo modelo barato como autor E
revisor* como a suposição mais frágil do desenho, então o preset padrão a
quebra e o preset `monoculture` existe para permitir o A/B contra ela.

## O método desenhado — quando NÃO usar o planner

A contradição acima tem uma saída, e ela é de primeira classe: **desenhe o método
você mesmo.** Um [devgraph](dev-graph.pt-BR.md) (`huu-devgraph-v1`) é um grafo que
um humano desenha — quais blocos rodam, em que ordem, onde uma decisão ramifica,
onde os ramos voltam a se juntar — e que o huu compila no mesmo `huu-pipeline-v2`
que este modo já emite. Com um em mãos o planner LLM **nunca é chamado**, e o modo
de desenvolvimento deixa de contrariar o diferencial #2: o humano subscreve o
método, o modelo fornece a inteligência dentro de cada nó.

```bash
huu dev "<o objetivo>" --graph=<id>              # salvo em .huu/dev/graphs/
huu dev "<o objetivo>" --graph=./drafts/a.json   # um arquivo
```

Qual dos dois pegar:

| | Planner LLM (sem `--graph`) | Método desenhado (`--graph=…`) |
|---|---|---|
| **Use quando** | você sabe o objetivo mas não a forma do trabalho; o repositório é desconhecido; você espera aprender entre épocas | você já conhece o método — uma auditoria, uma geração de testes, uma migração que você já fez antes |
| Topologia decidida por | um modelo, em tempo de execução | você, antes do run |
| Épocas | replaneja até o objetivo ser cumprido, ou até o teto | **exatamente uma**; `--epochs > 1` com `--graph` é recusado |
| Fase de conhecimento (A) + planejamento (B) | as duas rodam | **nenhuma roda** — não há plano a escrever nem quem instruir |
| Fase 0 (bootstrap de skills) | roda | **roda também** |
| Flags de metodologia · roteamento de modelo por papel | compilados na época | **ignorados, com aviso** — um desenho tem caixas, não papéis |
| Portão de aprovação | assina o plano do modelo | assina o seu desenho, uma frente por nó |

Tudo o que vem *depois* do run é idêntico nos dois caminhos: o merge de
aterrissagem, a evidência da época, o commit do quadro-negro. Desenhe e
inspecione com `huu graph list|show|validate|compile|new|rm`, a tela `[G]` da
TUI, ou o canvas `/graph` no navegador.

Documentação completa: [`docs/dev-graph.pt-BR.md`](dev-graph.pt-BR.md) ·
[EN](dev-graph.md).

## Uso

```bash
# Autônomo — O PADRÃO: planeja e roda até o teto de épocas, sem perguntar nada
huu dev "migrar o parser para streaming sem quebrar a API pública" \
    --model=anthropic/claude-sonnet-4

# Optando POR um portão humano a cada época
huu dev "extrair o cliente HTTP para um pacote próprio" \
    --model=anthropic/claude-sonnet-4 --approve-each --epochs=2

# Ensaio sem LLM (compila o grafo, roda as ondas, faz os merges)
huu dev "qualquer coisa" --stub --epochs=1
```

**Autonomia é o padrão.** Um `huu dev "<objetivo>"` puro planeja e roda todas
as épocas até o teto sem lhe perguntar nada: o CLI mapeia *nenhuma flag* para
`approval: 'autonomous'`. O portão humano é **opt-in** — `--approve-each`
(CLI) ou *Approve each epoch* (web) é a única forma de ver um plano antes de
ele rodar. `--autonomous` existe só para declarar esse padrão em voz alta; não
muda nada, e passá-la junto com `--approve-each` é recusado.

### O quadro ao vivo (`--cli`)

`huu dev --cli` (ou `--tui`, ou `HUU_CLI=1`) desenha a sessão como um kanban ao
vivo no lugar do log corrido: o mesmo `RunKanban` do dashboard de pipelines,
com os cards da época, o progresso deles e a narração da sessão num quadro só.

**Ele pinta em stderr, nunca em stdout.** O único objeto JSON que o `huu dev`
escreve em stdout é contrato de máquina, então ele fica byte a byte idêntico
com o quadro ligado ou desligado — nenhum script quebra. Sem TTY no stderr
(um pipe, um arquivo de log, CI), o huu avisa uma vez e mantém o log corrido,
em vez de desenhar um quadro que ninguém consegue ler.

O Ink segura o stdin em raw mode, então os portões `y/N` — `--approve-each`, a
oferta de retomar, a oferta de branches órfãos — são respondidos **dentro do
frame**, com a semântica de sempre: `y`/`s` é sim, qualquer outra tecla
(inclusive ENTER) é não. `Ctrl+C` desmonta e sai 130. Mapa completo de teclas
em [`KEYBOARD.md`](KEYBOARD.md#dev-dashboard-huu-dev---cli) (em inglês).

Um `huu dev` puro não muda em nada: log headless mais o veredito em JSON.

### Pela interface web

Um **switch** no topo, com as duas formas de começar trabalho lado a lado:

```
┌──────────────────────────┬──────────────────────────┐
│ ≡ Pipelines              │ </> Development          │
│   You already have       │     You have a goal      │
│   the method             │     instead              │
└──────────────────────────┴──────────────────────────┘
```

Cada metade é uma rota de verdade (`/` e `/dev`), então dá para favoritar,
copiar e abrir em nova aba. Mas um clique simples **não recarrega a página**:
o cliente troca a view no lugar e faz `pushState` — recarregar dropparia o
stream SSE, o quadro de runs e a fila meio montada. `Voltar` funciona.

O switch some quando você está no quadro de um run (seria uma forma silenciosa
de sair de uma execução ao vivo). Enquanto uma sessão de dev roda, a metade
**Development** ganha um ponto pulsante verde — âmbar quando um plano está
**travado esperando a sua aprovação** — para quem está do lado dos pipelines
perceber.

> Com `HUU_WEB_TOKEN` configurado, os dois links são reescritos no boot para
> carregar o `?token=` — um `href` cru levaria você a uma tela cujas chamadas
> de API dariam 401.

### O formulário

- **Goal** — o único input que o run subscreve. O botão de microfone dita: o
  navegador grava, re-codifica em WAV mono 16 kHz (a OpenRouter rejeita o webm
  que o `MediaRecorder` produz), e o `POST /api/dev/transcribe` manda para o
  `google/gemini-3.1-flash-lite` — a variante do 3.1-flash que aceita áudio.
  Troque com `HUU_TRANSCRIBE_MODEL`. A transcrição é ANEXADA ao que já estiver
  escrito. Custa cerca de US$0,00007 por clipe de quatro segundos.
- **Project** — o mesmo navegador de arquivos do fluxo de pipelines, mas de
  seleção ÚNICA: uma sessão de dev termina num merge no branch de UM repo.
- **Approval** — autônomo (**pré-selecionado**) ou aprovar cada época. Mesmo
  padrão do CLI: nada espera por você a menos que você peça.
- **Parallel fronts** — Auto (o planejador escolhe, até 4) ou Manual (fixa o
  teto; o compilador impõe, não só o prompt).
- **Metodologia** — doze checkboxes opt-in, cada uma compilando um enforcement
  de verdade na época. Todas OFF por padrão; a seleção persiste no navegador.
  Veja [Opções de metodologia](#opções-de-metodologia).
- **Sem teto de épocas.** Uma sessão web roda até o planejador reportar o
  objetivo concluído ou você abortar, limitada só por um backstop interno de
  segurança. O CLI mantém o `--epochs` padrão 3, porque um run headless pode
  estar desacompanhado e não tem botão de Abort.

### Flags

| Flag | Efeito |
|---|---|
| `--model <id>` | Modelo do planejador e do enxame. Obrigatório fora do `--stub`. |
| `--epochs <n>` | Teto de épocas (padrão 3; a superfície web não tem). |
| `--fronts <n>` | Teto de frentes paralelas por época (padrão 4, máximo 4). |
| `--max-cost <usd>` | Encerra a sessão antes da época que passaria disso. Verificado ENTRE épocas (nunca no meio do swarm), somando as duas runs de cada época. Sai 0 — o teto que você pediu funcionou. |
| `--approve-each` | **Portão opt-in:** mostra o plano de cada época e espera confirmação. Exige terminal interativo. |
| `--autonomous` | No-op que declara **o padrão** (planeja e roda tudo sem perguntar). Recusada junto com `--approve-each`. |
| `--skip-knowledge` | Não faz bootstrap de skills mesmo quando o projeto não tem. |
| `--run-dir <path>` | Repositório alvo (padrão: diretório atual). |
| `--cli` / `--tui` | Desenha a sessão como kanban ao vivo em **stderr** (veja [O quadro ao vivo](#o-quadro-ao-vivo---cli)). `HUU_CLI=1` faz o mesmo. |
| `--tdd` | Divide o trabalho de cada frente em passo de testes + passo de implementação. Veja [Opções de metodologia](#opções-de-metodologia). |
| `--lint-gate` | Roda o lint/typecheck do projeto como portão de merge determinístico. Veja [Opções de metodologia](#opções-de-metodologia). |
| `--standards` | Dá a cada crítico por tarefa uma rubrica vinda do atlas e das convenções declaradas do projeto. Veja [Opções de metodologia](#opções-de-metodologia). |
| `--plan-review` | Valida as escolhas da época num passo compilado antes do fan-out. Veja [Opções de metodologia](#opções-de-metodologia). |
| `--write-set` | Bloqueia qualquer arquivo escrito fora da propriedade declarada no spec da tarefa. Veja [Opções de metodologia](#opções-de-metodologia). |
| `--changelog` | Verifica os assuntos de commit contra Conventional Commits e exige entrada de changelog para mudança visível ao usuário. Veja [Opções de metodologia](#opções-de-metodologia). |
| `--diff-budget` | Limita o diff de cada tarefa em linhas e arquivos. Veja [Opções de metodologia](#opções-de-metodologia). |
| `--fitness` | Roda a checagem de arquitetura/dependências do projeto como portão de merge. Veja [Opções de metodologia](#opções-de-metodologia). |
| `--checklist` | Faz cada crítico responder um checklist fixo, item a item, com evidência. Veja [Opções de metodologia](#opções-de-metodologia). |
| `--traceability` | Monta a matriz bidirecional requisito ↔ evidência depois do fan-out e barra órfão não declarado. Veja [Opções de metodologia](#opções-de-metodologia). |
| `--characterize` | Fotografa o comportamento observável de hoje antes de mudar qualquer coisa, e depois o congela. Veja [Opções de metodologia](#opções-de-metodologia). |
| `--verify-claims` | Re-verifica cada afirmação do conhecimento contra o repositório e rebaixa o que não se reproduz. Veja [Opções de metodologia](#opções-de-metodologia). |
| `--debate` | Põe dois agentes de famílias de modelo diferentes para discutir as decisões de design da época antes das frentes, julgados por uma rubrica anonimizada. Veja [Opções de metodologia](#opções-de-metodologia). |
| `--advocate-model <id>` / `--prosecutor-model <id>` | Roteia os dois lados do `--debate`. Ponha-os em **famílias diferentes** — veja [Debate adversarial](#debate-adversarial---debate). |

## As duas fases

### Fase 0 — portão de knowledge

Antes de qualquer desenvolvimento, o huu sonda o repositório
(`src/lib/knowledge-detect.ts`):

1. `.agents/skills/catalog.md` existe → presente
2. senão, um `.agents/skills/*/SKILL.md` que seja roteador (frontmatter
   `type: router`, ou o nome `project-router` / `project-knowledge`)
3. senão, o mesmo sob `.claude/skills/`

**Skills sem superfície de roteamento não contam como "presente"** — o
planejador não teria por onde entrar nelas.

Se estiver ausente, o huu roda o pipeline embutido **`huu Knowledge System`**
em modo **MAX** (`greedy`: um agente por tarefa enfileirada até o teto duro,
com o guarda de memória como único freio) — é o "máximo de swarm possível". O
branch de integração desse run é aterrissado antes de a fase 1 começar.

### Fase 1..N — as épocas

Cada época é: **planejar → (aprovar) → rodar → aterrissar → replanejar**.

O planejador recebe o objetivo, a superfície de conhecimento do projeto, o
histórico das épocas anteriores, a evidência estruturada do que a última
realmente entregou e o **pacote de briefings** que os agentes escreveram
respondendo às lacunas que ele mesmo declarou. Ele **não** recebe digest do
repositório e não consegue ler arquivo — veja
[a nota sobre retrieval acima](#o-que-a-pesquisa-sustenta--e-o-que-não-sustenta).
Devolve, com schema forçado, uma lista de frentes.

`compileEpochPipeline` transforma isso num pipeline:

```
0. Recon do objetivo                         (project, raiz)
├─ 1a. <frente> — recon      (project, produces <frente>/tasks.json)
│  └─ 1b. <frente> — implementar   (memory, filesFrom o mesmo caminho)
│     └─ 1c. <frente> — verificar  (check: approved ↦ frente, rework ↦ 1b)
├─ 2a/2b/2c …                                 (frentes rodam em ondas PARALELAS)
├─ N+1. Consolidar época      (project, dependsOn todos os juízes)
├─ N+2. Portão de qualidade   (check: approved ↦ selo, rework ↦ consolidação)
└─ N+3. Selar época           (project)
```

Frentes independentes ficam **prontas na mesma onda** e compartilham um único
pool de workers. Uma frente que declara `dependsOnFronts` espera o juiz da
outra — o compilador ordena as frentes topologicamente e quebra ciclos
soltando arestas (com aviso) em vez de perder a época.

## O pesquisador sob demanda (lacunas `external`)

Uma lacuna de conhecimento declara uma **pista** — `repo`, `convention` ou
`external` — e a pista é escrita no arquivo de spec daquela lacuna, não no
prompt compartilhado da etapa. É isso que permite mandar um agente da onda
pesquisar na web enquanto o vizinho é proibido de fazê-lo. `external` é o
pesquisador sob demanda: quando uma dúvida material não pode ser respondida a
partir deste código, um agente barato vai olhar e volta com **evidência
citada**.

### O que ele roda

A pista nomeia o CLI instalado com exatidão, porque uma spec que descreve outra
ferramenta custa ao agente o card inteiro só para descobrir a verdade:

```bash
surf-research-skill gate            # exit 0 = há chave utilizável · exit 78 = não há
surf-search-normal "<uma pergunta>" \
  --task "…" --goal "…" --insights "…" --deliverable "…"
surf-research-skill search "Q1" "Q2" "Q3"   # links crus, sem síntese
```

`gate` é a sonda porque é o único verbo que responde **sem** chave. Os quatro
flags de briefing são o que separa uma resposta utilizável de um resumo de
resumos. `--sub-agents` controla o leque: padrão 10, **máximo 20**.

Existe **um** backend de busca e **nenhum degrau sem chave**. Chave ausente não
é um caminho lento: é o fim da estrada.

> **O container fixa a própria versão do surf** (`ARG SURF_VERSION` no
> `Dockerfile`), então o CLI dentro de uma imagem pode ser mais antigo que o da
> sua máquina. A spec trata disso em vez de supor: se o `gate` voltar como
> comando desconhecido, o agente cai para `surf-research-skill search "…"`, usa
> o que vier e registra a divergência em `unknowns` — um achado real sobre a
> imagem, não um motivo para concluir que não há web.

### O exit code decide o que acontece depois

| Código | Significado | Repetir? |
| --- | --- | --- |
| `0` | Respondeu. | — |
| `1` | Rodou e não achou nada. Degradação real, não configuração quebrada. | Não |
| `2` | A linha de comando estava errada (`--sub-agents` fora de 1..20). | Corrija o argv |
| `78` | Sem chave de busca utilizável — emitido *antes* de rodar qualquer coisa. | Nunca |
| `143` | O harness matou a chamada no timeout. | Uma vez, mais estreito |

Quem é dono dessa tabela é o `classifySurfExit()`
(`src/lib/surf-research.ts`), para que o prompt e o código não possam discordar
sobre quais falhas vale a pena repetir.

### Sem chave, o huu registra a ausência — nunca inventa uma

O `ensureSurfKeys()` reporta `searchReady` separado de `written`: uma máquina
configurada com uma chave legada realmente ganha um `keys.json`, e mesmo assim
a pesquisa não roda. O agente é instruído a escrever os dois arquivos do
briefing do mesmo jeito, com `facts` vazio, `sources` vazio,
`confidence: "low"` e a ausência escrita em `unknowns` — *"`surf-research-skill
gate` saiu 78, então nada aqui foi verificado contra a web"*. O digest então
renderiza aquela seção dizendo **nada aqui foi verificado contra a web**.
Fabricar URL é proibido de forma explícita: ninguém a jusante consegue conferir
uma citação contra a web, então uma fonte plausível-e-errada sobrevive até o
fim da sessão.

### Conteúdo da web é DADO, nunca instrução

Esta é a parte que protege você. Texto vindo da web é escrito por gente que o
huu não consegue auditar, e ele viaja: para o contexto do pesquisador, para o
briefing dele, para o digest consolidado e, por fim, para o prompt do
**planejador cego** — debaixo de uma frase que manda *tratar o que está ali
como verdade*. Isso é
[injeção indireta de prompt](https://arxiv.org/abs/2302.12173): o atacante
nunca fala com o huu, basta colocar uma frase numa página que um agente vá ler.
Defesas só no nível do prompt não são herméticas
([AgentDojo](https://arxiv.org/abs/2406.13352)), então o huu faz a coisa de
forma estrutural além de textual — o formato que o
[CaMeL](https://arxiv.org/abs/2503.18813) descreve, mantendo o caminho do dado
fora do caminho do controle, com a
[hierarquia de instruções](https://arxiv.org/abs/2404.13208) declarada no texto
por cima:

1. **Cercado.** Toda resposta `external` é embrulhada em
   `<<<HUU-UNTRUSTED-WEB-DATA>>>` … `<<<END-HUU-UNTRUSTED-WEB-DATA>>>`, e os
   sentinelas são removidos do conteúdo — então o texto nunca consegue fechar a
   própria cerca e continuar como prosa confiável.
2. **Marcado linha a linha.** Toda linha lá dentro recebe o prefixo `| `.
   Nenhuma linha da web começa na coluna zero, então nenhuma forja um
   `## título` ou um `=== SEÇÃO ===` no documento onde cai. Nada se perde: cada
   palavra sobrevive.
3. **Neutralizado e contado.** Imperativos de override, marcadores de turno
   forjados (`<|im_start|>`) e reatribuições de papel viram um marcador visível
   `[huu-neutralized:…]` — nunca são apagados. A seção então diz quantos
   dispararam, de modo que um ataque é *relatado*, não limpo em silêncio.
4. **Ordenado.** A regra que explica a cerca vem **antes** dela: uma instrução
   colocada depois de texto não confiável é justamente a que esse texto tem
   mais facilidade de contornar.

Seções `repo` e `convention` deliberadamente **não** são cercadas. A cerca é o
sinal, e um marcador em toda seção deixaria de significar qualquer coisa.

O agente roda a busca sozinho, então o huu nunca vê o stdout do CLI e não
consegue cercá-lo. Essa fronteira é coberta por uma ordem permanente na spec:
um resultado que manda o agente mudar de tarefa, pular a spec ou reportar
sucesso é um **ataque**, e a resposta é terminar o trabalho combinado e nomear
a fonte em `unknowns`. Relatar vale mais do que a resposta que aquilo tomaria o
lugar.

## Opções de metodologia

Treze checkboxes no formulário de dev (o fieldset **Methodology**, logo
acima de *How it runs*) e treze flags equivalentes no CLI. Cada uma é o humano
subscrevendo um pedaço do *método*, além do objetivo: a opção muda a
**estrutura** que o compilador da época emite (split de passo, portão de merge
determinístico, rubrica no crítico, passo de validação antes do fan-out),
nunca os campos que um modelo pode produzir — os schemas do planejador
continuam sem `steps`, `dependsOn` ou caminhos de arquivo.

São seis mecanismos e toda opção é montada a partir deles: um passo novo
(`--tdd`, `--characterize`), um check novo com loop-back (`--plan-review`,
`--traceability`), uma rubrica acrescentada ao crítico (`--standards`,
`--write-set`, `--diff-budget`, `--fitness`, `--changelog`, `--checklist`), um
comando acrescentado ao portão de merge determinístico (`--lint-gate`,
`--fitness`, `--diff-budget`, `--changelog`), uma cláusula acrescentada ao
juiz da frente (`--tdd`, `--write-set`, `--characterize`) e — só no `--debate`
— um BLOCO de passos antes do fan-out mais o bloco de prompt que entrega a
saída dele às frentes. O portão de merge e as cláusulas do juiz ACUMULAM —
várias opções contribuem para cada um, encadeadas na ordem em que são
declaradas, de modo que nenhuma opção apaga a outra em silêncio.

`--verify-claims` é a única que mexe na fase de CONHECIMENTO em vez da fase de
execução: insere um passo de verificação entre responder e consolidar, e
rebaixa para `unknowns` o que não se reproduz em vez de falhar — todo caminho
de saída da Fase A continua para a frente.

**As treze ficam OFF por padrão.** Uma sessão sem nenhuma delas compila
exatamente o pipeline de hoje, byte a byte — o mesmo contrato aditivo da
política de modelos por papel. O que cada uma impõe, mecanicamente:

### TDD (`--tdd`)

O passo único de implementação de cada frente vira dois passos encadeados
sobre a mesma lista de tarefas — um passo de **testes**, depois um de
**implementação** — com o juiz da frente depois deles, como antes:

```
1a. <frente> — recon
└─ 1b. <frente> — testes        (escreve os testes que FALHAM primeiro)
   └─ 1c. <frente> — implementar (arquivos de teste congelados)
      └─ 1d. <frente> — verificar
```

- O passo de testes é instruído a rodar os testes novos e **capturar a
  falha** — a fase vermelha é evidência, não erro.
- O prompt do passo de implementação proíbe editar os arquivos de teste, e o
  juiz da frente ganha duas cláusulas: os testes estão inalterados desde o
  commit do passo de testes, e todo arquivo do diff tem teste. Violação é
  achado bloqueante — segura o merge e, com a semântica de escape abaixo,
  pode segurá-lo para um humano.

O congelamento é imposto pelo juiz, não pelo filesystem — ele é exatamente tão
forte quanto o crítico que o audita (veja [Limites conhecidos](#limites-conhecidos)).

### Lint gate (`--lint-gate`)

Liga o `mergeGate` do pipeline compilado aos comandos de lint e typecheck do
projeto: um portão determinístico, sem LLM, que roda no worktree de integração
depois de cada merge de branch de agente. Exit não-zero **reverte o commit de
merge** e marca o branch como `mergeFailed` (o branch em si é preservado para
inspeção). Só os checks estáticos rápidos alimentam o portão — ele tem timeout
de 60 segundos por merge, então comandos de build e teste ficam com o crítico.
Um projeto cujo brief de conhecimento não tem comando de lint transforma a
opção em no-op com aviso, nunca em run quebrado.

### Padrões (`--standards`)

O briefing de cada crítico por tarefa ganha uma rubrica montada a partir do
atlas da época e das convenções declaradas do projeto (`AGENTS.md` e cia.),
com escopo anti-nitpick: reporte **violação de corretude** ou **violação de
padrão declarado** — nunca gosto. A ideia é impedir o crítico de inventar uma
régua que o projeto nunca definiu e de carimbar trabalho fraco que quebra a
régua definida.

### Revisão do plano (`--plan-review`)

Insere uma validação **depois do recon de todas as frentes e antes de qualquer
implementação**: um agente lê o atlas, as specs de tarefa (`T-*.md`), o plano
e o objetivo, e audita as *escolhas* da época — cobertura do objetivo,
fronteiras das frentes e a partição declarada de write-sets (é aqui que a
checagem de propriedade vira bloqueante em vez de consultiva). Um juiz então
roteia o veredito:

```
0. Recon do objetivo
├─ 1a/2a/… <frente> — recon       (todas as frentes reconhecem primeiro)
├─ R1. Revisar as escolhas        (atlas + specs + plano + goal → plan-review.md)
│  └─ R2. Plano validado?         (check: approved ↦ fan-out, rework ↦ passo 0)
├─ 1b/1c/…                        (implementação só começa depois do veredito)
```

- `approved` → o fan-out prossegue.
- `rework` → de volta ao recon global, uma vez: o check limita em 2 rodadas
  e, no limite, o outcome padrão segue **para a frente**, com os achados
  registrados na consolidação e na evidência da época.

O bloqueio real é estrutural — nenhum passo de implementação começa antes do
veredito — e o loop-back não consegue girar para sempre.

### Write-set (`--write-set`)

Todo spec de tarefa declara uma lista `Files this task OWNS`. O huu já *media*
as violações (`writeSetViolations` na evidência da época); esta flag é o
interruptor que as faz bloquear. O crítico faz uma diferença de conjuntos —
arquivos que o diff tocou, menos a lista declarada, menos a árvore de scratch
do próprio huu — e todo caminho que sobra é `blocker`, um achado por arquivo. O
juiz da frente reconfere depois do merge, contra `git log --name-only`.

A assimetria é deliberada: escrever um arquivo **não declarado** bloqueia,
porque é isso que colide com uma frente paralela no merge; deixar um arquivo
**declarado** intocado não é nada. "A mudança realmente precisou daquele
arquivo" não é defesa — se precisou, o spec estava errado, e dizer isso É o
achado.

### Changelog (`--changelog`)

Duas metades com fundamentos diferentes. A metade do assunto de commit é
universal — Conventional Commits é um *formato*, então um regex sobre
`git log` não precisa de ferramenta do projeto — e roda como portão de merge. A
metade da entrada de changelog precisa de uma superfície real, então o huu a
**detecta** (`.changes/`, `changelog.d/`, `.changeset/`, `CHANGELOG.md`,
diretórios de fragmento primeiro) e só então manda o crítico exigir entrada
para mudança visível ao usuário. Sem superfície ⇒ a rubrica cai com um aviso e
o portão de formato continua valendo. Mudança só interna não deve nada, e
exigir entrada para uma delas é explicitamente marcado como ruído.

### Lotes pequenos (`--diff-budget`)

O diff de cada tarefa fica limitado a **400 linhas alteradas em 12 arquivos**,
ignorando a árvore de scratch do huu, imposto com `git diff --numstat` no
merge. 400 é o topo da faixa em que a eficácia da revisão é repetidamente
relatada como despencando; o teto existe porque revisar um diff grande *com
mais afinco* não é conserto.

Age em duas fases: o planejador é instruído a decompor até toda tarefa caber
(conteúdo, não estrutura), e o portão conta. Do crítico se pede a única coisa
que o portão não produz — **onde fica o corte** — e ele é explicitamente
avisado de que um achado que só repete o número é inútil.

### Regras de arquitetura (`--fitness`)

A única opção que acrescenta uma pergunta à **fase de conhecimento**: uma
lacuna `architecture-rules` pede a um agente a checagem executável de
dependências/camadas deste projeto (dependency-cruiser, madge, ArchUnit,
import-linter, um script próprio) e a linha de comando exata. Esse comando
passa a rodar como portão de merge, e as regras de camada do atlas viram
rubrica citável para o crítico.

A lacuna é perguntada em toda época, não só na primeira — a resposta alimenta
um portão que roda em toda época, e uma época que *cria* um arquivo de regras
deveria ser barrada por ele na seguinte. A maioria dos repositórios não tem
esse comando; isso é reportado como ausente e nenhum portão é inventado. A
classificação é só por rótulo `fitness:` explícito, nunca por heurística, para
que ligar esta opção não mova em silêncio um comando para fora do bucket
`lint` que `--lint-gate` sempre rodou.

### Revisão por checklist (`--checklist`)

O crítico para de escrever prosa e responde uma lista fixa item a item —
`C1 VERIFY-RAN`, `C2 DONE-WHEN`, `C3 SPEC-ONLY`, `C4 CONVENTIONS`,
`C5 NO-PLACEHOLDER` — com um token de veredito (`PASS`, `FAIL`, `N-A`) e uma
linha de evidência em cada: um comando com seu exit code, ou um `file:line`.

Duas propriedades fazem o trabalho. Um **enum fixo** é comparável entre épocas
de um jeito que uma nota 1–5 não calibrada não é. A **evidência obrigatória**
faz fabricar custar mais do que se abster — por isso `N-A` é resposta de
primeira classe: sem um jeito legítimo de dizer "não consegui resolver isto", o
modelo fabrica um PASS. Achados têm que casar com itens marcados `FAIL`, nas
duas direções.

### Matriz de rastreabilidade (`--traceability`)

Um par passo-de-trabalho + check inserido entre a consolidação e o portão da
época. Um agente escreve `epoch-N/traceability.md` com duas tabelas: direta
(todo critério "Done when" → o `file:line` ou comando que o resolve) e inversa
(todo arquivo entregue → o critério que ele serve), fechando com uma seção
`## Órfãos`.

As duas direções pegam falhas diferentes. A direta pega o critério que ninguém
entregou; a inversa pega **escopo que ninguém pediu**, que num enxame de
agentes é o defeito mais comum e o único que nenhuma outra checagem aqui vê. Um
`rework` volta para o passo da matriz, não para o relatório — matriz rejeitada
precisa de matriz melhor. Uma época com órfãos *declarados* passa: torná-los
visíveis para o próximo planejador é o serviço. O que reprova é matriz
incompleta, sem fonte, ou inconsistente consigo mesma.

### Testes de caracterização (`--characterize`)

O `--tdd` do trabalho que não tem spec — auditoria, extração de conhecimento,
refatoração de legado, que é a maior parte do que o huu existe para rodar. O
trabalho da frente se divide do mesmo jeito que o TDD divide: um passo
`caracterizar` roda o código **atual** numa fronteira observável, commita a
saída capturada como snapshots e confirma que eles passam contra o código
inalterado. Verde aqui é a prova de que a baseline é real — o inverso do
vermelho do TDD.

O comportamento gravado **não** é presumido correto. Mudar qualquer coisa nesse
passo é blocker, inclusive um conserto obviamente certo; um defeito real vira
achado e o comportamento bugado é fotografado assim mesmo, porque o serviço do
snapshot é tornar a próxima mudança *visível*. Depois disso os snapshots ficam
congelados: reescrever um sem aprovação no mesmo commit é blocker para o
crítico e reprovação para o juiz — mudança de comportamento que apagou a
própria evidência. Com `--tdd` também ligado, a frente roda `caracterizar` →
`testes` → `implementar`, e as duas cláusulas de congelamento chegam ao crítico
da implementação.

### Verificação de afirmações (`--verify-claims`)

A única metodologia que age na **fase de conhecimento**. Insere
`K1.5. Verificar as afirmações` entre responder e consolidar: um agente por
briefing, distribuído sobre o mesmo índice commitado, derivando uma pergunta
falsificadora para cada entrada de `facts` e respondendo-a *a partir do
repositório* — nunca a partir do briefing, que é justamente o que está sob
teste.

Existe porque o orquestrador é cego. O `digest.md` é literalmente a única coisa
que ele aprende sobre este repositório, então uma afirmação errada e confiante
não apenas passa despercebida: ela vira plano, e depois ordem para um agente
real.

Ele **rebaixa, nunca falha e nunca apaga**. Afirmações não verificadas saem de
`facts` para `unknowns` — o campo que o schema do briefing já exige exatamente
para que o agente sempre tenha onde ser honesto — e `confidence` só pode
descer. É isso que mantém todo caminho de saída da Fase A para a frente: não
existe CheckStep nesta fase de propósito, e este passo não é um.

### Debate adversarial (`--debate`)

A única opção cujos passos são **agentes discutindo**. Entre o recon global e
as frentes, o compilador insere três nós:

```
0. Recon do objetivo
├─ Sustentar as escolhas    escreve .huu/dev/<sessão>/epoch-N/debate/A.md
├─ Contestar as escolhas    lê A.md, escreve B.md
└─ Debate resolvido?        convergiu ↦ o recon da primeira frente (DEFAULT)
                            contestado ↦ Sustentar as escolhas (mais uma rodada)
```

**A** é o registro de decisões: no máximo seis decisões, cada uma com a
alternativa que rejeita, o porquê (apontando para um caminho real, o atlas ou o
objetivo) e a observação que provaria que a escolha está errada, mais os riscos
que a época aceita de propósito. **B** ataca: um veredito por id de decisão —
`SUSTENTADA` ou `CONTESTADA` — e, atrás de cada contestada, uma falha prevista
e evidência que dá para apontar. Nenhum dos lados pode editar o arquivo do
outro.

**Como o resultado chega nas frentes.** O único canal passo→passo que o huu
tem é o sistema de arquivos da worktree de integração, e só depois de
*commitado* — o texto do veredito de um juiz nunca chega ao prompt do passo
seguinte. Nada no huu injeta a `reason` de um check em prompt nenhum, então
todo portão deste arquivo agora diz isso com as próprias palavras: um veredito
`rework` ou `contestado` é o **registro** de por que o passo voltou, lido por
um humano no card do check e no log da run, não uma mensagem entregue ao agente
que re-roda. (Três portões afirmavam o contrário — "esse texto é a única coisa
que os agentes de retry recebem" — e essa afirmação era herdada, não trazida
por esta opção.) Então o recon de cada frente (a) **espera o portão do debate**, que é
o que coloca os dois briefs na árvore de onde a worktree dele sai, e (b) é
instruído a ler os dois pelo caminho. Decisão marcada `SUSTENTADA` está
resolvida e o recon a implementa; decisão marcada `CONTESTADA` é *risco
aceito*, que tem de ser nomeado no "Context" do spec afetado — nunca licença
para redesenhar. É no recon que isso aterrissa porque é o recon que escreve os
specs; quando um worker lê o spec dele, a decisão já está dentro.

**A rubrica do juiz é anonimizada por MODELO — e só por modelo.** Ele nunca é
informado de qual agente nem de qual **modelo** escreveu cada brief, e o prompt
do portão não contém nenhuma string de fornecedor, família ou modelo. Ele *é*
informado de qual arquivo é o registro e qual é o ataque, porque o **papel é
estruturalmente impossível de esconder**: os dois arquivos respondem perguntas
diferentes, e as próprias cláusulas do portão precisam ler um como registro e o
outro como ataque para poder compará-los. Anonimato de papel nunca esteve em
oferta aqui; o de modelo está, e é a propriedade que combate o viés de família.
Os arquivos se chamam `A.md` e
`B.md` e nada mais, porque um nome de arquivo não é algo que se possa pedir a
um modelo para desver; os dois escritores recebem o *mesmo* esqueleto de saída
e a *mesma* proibição de nomear o modelo por trás deles (sem modelo, sem
fornecedor, sem assinatura — mais, por asseio e não como propriedade alegada,
sem nome de papel), então também não dá para distingui-los pela forma; e
a rubrica nega tamanho, ordem e confiança como evidência, nominalmente. O
veredito é sobre o **estado do registro**, não sobre um vencedor: não existe
resultado "o advogado ganhou" para rotear, porque um debate que escolhe
vencedor seria uma IA decidindo o design. As cláusulas do portão são
comparações de conjunto — toda decisão tem veredito, toda contestada tem
evidência e resolução — mais uma cláusula de anonimato que ele consegue
resolver sem saber a resposta.

**Heterogeneidade é o mecanismo, não um detalhe.** Os dois lados são papéis
separados (`advocate`, `prosecutor`) justamente para poderem ir a famílias
diferentes: o resultado publicado sobre debate multiagente ingênuo é que ele
com frequência não supera um chain-of-thought simples, e cross-family é a
alavanca que muda isso. Todo preset menos o `monoculture` — que é a linha de
base deliberada do A/B — os separa; o `roster` usa o par que o documento do
roster nomeia (Claude Opus 5 e GPT-5.6 Sol, ambos já naquele roster, então a
opção não lhe custa fornecedor novo). Deixe-os sem rota e os dois caem no
modelo da run: o huu compila o debate assim mesmo e **avisa** que é um modelo
falando sozinho. Dito, não escondido: no `roster` o juiz e o advogado são o
mesmo modelo, que é exatamente por que a rubrica é anonimizada — roteie
`--judge-model` para uma terceira família se quiser independência total.

**`writes` aqui DECLARA uma superfície; não a impõe.** Os dois passos do debate
levam `writes: ['<epoch>/debate/**']`, e vale ser exato sobre o que isso compra.
O huu usa `writes` num lugar só: o `validateTopology` rejeita dois passos
*concorrentes* cujos globs se cruzam. O promotor `dependsOn` o advogado, então
eles nunca são concorrentes e essa checagem não tem par para comparar; a
checagem de partição em runtime também retorna cedo, porque cada passo declara
`files: []` e portanto abre exatamente uma tarefa. Nenhum dos dois agentes tem
o toolset restrito, nenhum dos passos declara crítico, e os diffs deles
mergeiam sem portão — a mesma forma que o `0. Recon do objetivo` tem desde que
o dev mode existe, então não é buraco novo, mas a declaração é documentação de
intenção, não sandbox. O que de fato mantém cada agente fora do arquivo do
outro é o prompt ("nunca edite `A.md`") mais o fato de rodarem em ondas
diferentes.

**O teto é de 2 rodadas**, e o teto segue para a frente. `contestado`
re-pendura todo o cone a jusante do advogado, então cada rodada extra custa uma
época inteira de execuções de nó; bater no teto toma o default para a frente
com o registro como está, igual a todos os outros portões daqui.

**Com `--plan-review`, um rework de plano NÃO re-discute o debate.** As duas
opções se sobrepõem num loop, e sozinha a sobreposição era fatal, não lenta. O
`Plano validado?` manda o `rework` de volta para um passo cujo *cone a jusante
inteiro* é re-pendurado; com o debate pendurado no recon global, esse cone
continha os dois debatedores, então todo rework de plano pagava a discussão
inteira de novo — e o `runDagWaves` responde a um teto estourado com erro de
run, o que significa que a época é **perdida** depois de todo agente até ali já
ter sido pago. Então, com `--debate` ligado, o `rework` mira um nó abaixo: no
**portão** do debate. A cobertura é idêntica (todo recon de frente da primeira
onda já espera esse portão, então os specs, a auditoria e o próprio check
continuam sendo re-pendurados) e os briefs discutidos sobrevivem. Isso é tanto
uma declaração de escopo quanto de orçamento: o portão do plano julga os
*specs*, o debate julga o *design*, e dois specs colidindo num arquivo não é
motivo para reabrir em que design a época se apoia. Medido replayando o loop de
ondas real com quatro frentes, isso levou o pior caso de
`tdd+planReview+traceability+characterization+debate` de 85 execuções de nó
para 79.

**O próprio teto foi re-medido.** O `maxNodeExecutions` de uma época compilada
agora é **96**, não 50. O número antigo carregava uma estimativa de cabeça ("4
frentes + cauda + loops de rework ≈ 26") que tinha desviado feio: replayando o
`runDagWaves` sobre todas as 2¹³ combinações de metodologia no máximo de quatro
frentes, com todo portão tomando o braço para trás até o próprio `maxRuns`
forçar o default para a frente, o pior caso é **70 sem `--debate` nenhum** e
**79 com ele**. Ou seja, 50 já estava ~20 curto para combinações que existiam
antes do debate. Um teste (`the node-execution budget`, em
`plan-to-pipeline.test.ts`) agora replaya esse loop para toda combinação e
falha se alguma deixar de caber, então uma metodologia nova não consegue
reintroduzir o estouro em silêncio.

**E ele também põe o crítico em HOLD** — veja a próxima seção. O `--debate` não
acrescenta rubrica de crítico nem portão de merge próprio, então esse é o único
comportamento que você ganha dele sem pedir: com `--debate` ligado, a tarefa
cujo crítico chega ao teto de rodadas com achados bloqueantes abertos é
estacionada para um humano em vez de sofrer waive. Isso está dito na descrição
da flag, no checkbox da web e aqui.

**Assistindo acontecer (web).** Com `--debate` ligado, a `/dev` ganha um botão
**Debate** que abre os dois lados como conversa. Enquanto a rodada roda, o
painel é alimentado pelo firehose `agent-stream`, que não é throttled — é
literalmente a saída do advogado e do promotor conforme eles escrevem. E é a
*única* forma de assistir ao vivo: os dois briefs são escritos dentro do
worktree isolado de cada debatedor e só chegam ao caminho do quadro-negro
depois que a onda faz merge, então uma UI que observasse o arquivo o veria
aparecer já pronto. Depois que a onda aterrissa, o `GET /api/dev/debate`
serve a versão assentada: os `A.md`/`B.md` mergeados, parseados **no
servidor** (o cliente do navegador é ESM cru, sem bundler, e não importa o
parser em TypeScript) em decisões, vereditos e objeções, com as decisões que
ninguém julgou e os vereditos que ninguém declarou nomeados à parte. O parser
é leniente por contrato — um brief que não bate com o esqueleto degrada para o
markdown cru em vez de sumir. Sem `--debate`, o botão nunca aparece e nenhuma
requisição é feita. **Não existe painel de debate no TUI**: o quadro do
`--cli` mostra o kanban, o chat é só web.

### O escape: bloqueio segura para um humano, nunca waive silencioso

Com qualquer opção de enforcement ligada, o compilador marca o contrato de
revisão com `onBlocked: 'hold'`. Quando o limite de rodadas do crítico é
atingido com achados bloqueantes ainda abertos, a tarefa é **estacionada para
um humano** pelo mesmo portão de retry interativo que um estágio falho usa:
retentar re-executa a tarefa (revisada de novo); abandonar aplica o waive
clássico ao branch preservado. Runs sem canal interativo (headless,
`run-many`, smoke tests) sempre degradam para o waive clássico — uma opção de
enforcement nunca consegue deadlocar um run desacompanhado. Com todas as
opções desligadas, nada muda: os achados continuam waived no limite de
rodadas, como sempre foi.

## O quadro-negro (`.huu/dev/`)

```
.huu/dev/
  goal.md              ← huu escreve, ninguém reescreve
  state.json           ← huu escreve (huu-devstate-v2)
  journal.md           ← agentes acrescentam (append-only)
  <sessionId>/         ← as épocas de uma sessão, namespaced: sem isso o
                         fan-out de memória de uma segunda sessão poderia
                         resolver a tasks.json commitada da sessão ANTERIOR
    epoch-<N>/
      atlas.md         ← mapa do código produzido pelo recon global
      pipeline.json    ← o grafo compilado da época, artefato portátil
      findings/        ← um shard JSON POR ESCRITOR — nunca um arquivo só:
                           uma wave de fan-out tem N agentes anexando e o merge
                           do estágio é sequencial, então um arquivo único
                           conflita em toda branch depois da primeira
      report.md        ← relatório da consolidação
      <frente>/
        tasks.json     ← lista huu-memory-v1 (produces/filesFrom)
        T-001.md …     ← uma spec por tarefa
```

**Por que specs em arquivo:** o `resolveMemoryFiles` derruba qualquer caminho
que não exista no worktree de integração. Uma tarefa de desenvolvimento não é
um arquivo-alvo, então o recon da frente materializa uma spec markdown por
tarefa e lista *essas*. Efeito colateral bom: o plano fica versionado e
auditável.

**Divisão de propriedade** (repetida em todo prompt): o huu é dono de
`goal.md` e `state.json`; os agentes são donos de `<sessionId>/epoch-<N>/**`
e `journal.md`.

**Comandos de verificação, persistidos.** O brief de conhecimento da época 1
pede os comandos de build, teste e lint do projeto em listas rotuladas
separadamente. O huu extrai e classifica nos baldes `build` / `test` / `lint`
(typechecks contam como lint — exatamente os checks estáticos rápidos que um
portão de merge pode rodar) e grava no `state.json` (`verifyCommands`). Daí
em diante toda época compila com a mesma âncora executável para os críticos —
antes disso só a época 1 a tinha, porque a lacuna de baseline que produz os
comandos nunca é perguntada de novo. Uma linha que não dá para interpretar é
pulada com aviso; um brief ausente significa nenhum comando, como antes.

## Regras que o huu impõe (e o planejador não pode quebrar)

- **Particionamento por propriedade de arquivo.** Agentes paralelos são
  mergeados; duas tarefas que escrevem o mesmo arquivo conflitam. Cada spec
  declara os arquivos que a tarefa **possui**, e o prompt diz que ler é
  livre, escrever não. As propriedades declaradas são checadas contra as specs
  aterrissadas **depois de cada aterrissagem** — o único momento em que os
  `T-*.md` existem no seu checkout (checar antes varria um diretório vazio).
  Violação vira evidência da época e aviso no log — consultivo, nunca
  bloqueante. A versão bloqueante existe com `--plan-review` ligado: a
  auditoria pré-fan-out carrega a cláusula de disjunção, onde ela ainda pode
  impedir o conflito em vez de só reportá-lo.
- **`dependsOn` só aponta para trás.** É o que o `validateTopology` exige e o
  que o `descendantsOf` assume.
- **Exatamente um `default: true` por check, apontando para a frente.** O
  default dispara quando o juiz falha, devolve rótulo desconhecido ou estoura
  `maxRuns` — então tem de ser o caminho seguro, nunca o laço.
- **O pipeline compilado passa por `PipelineSchema` + `validateTopology`**
  antes de rodar. Falha ali é bug do huu, não plano ruim.

## Aterrissagem entre épocas

Um run do huu deixa o trabalho no branch `huu/<runId>/integration` e **remove**
o worktree de integração no fim. Certo para um pipeline avulso, errado para
uma cadeia de épocas: a época N+1 parte do HEAD do seu checkout e não veria
nada.

Então, entre épocas, o huu faz `merge --no-ff` do branch de integração no seu
branch de trabalho. Conflito ali é parada real da sessão (`git merge --abort`
roda antes, então a árvore volta limpa).

Duas consequências práticas:

- **Sua árvore precisa estar limpa ao iniciar.** A sessão recusa na hora, com
  a lista de arquivos, em vez de morrer na primeira aterrissagem.
- **O huu commita o que o próprio huu escreve** (`goal.md`, `state.json` e o
  `.gitignore` que o `Orchestrator.start()` ajusta) antes de cada
  aterrissagem, em commits `chore(huu-dev): …`.

## Como uma sessão termina

| `stoppedBecause` | Significado | Sai 0? |
|---|---|---|
| `goal-complete` | O planejador provou que o objetivo já está satisfeito | ✅ |
| `max-epochs` | Bateu o teto de épocas com tudo aterrissado | ✅ |
| `plan-rejected` | Você recusou um plano no portão | ✅ |
| `dirty-tree` | Havia trabalho não commitado que não é do huu | ❌ |
| `empty-plan` | O planejador não deu frentes nem declarou conclusão | ❌ |
| `planner-failed` | O modelo não produziu plano válido | ❌ |
| `run-failed` | A época terminou com erro | ❌ |
| `landing-failed` | O merge da época conflitou | ❌ |
| `consecutive-failures` | 3 épocas seguidas falharam — o circuit breaker encerrou a sessão | ❌ |
| `cost-ceiling` | O `--max-cost` foi atingido, com tudo aterrissado | ✅ |
| `graceful-stop` | Uma parada foi pedida e a época em voo terminou e aterrissou | ✅ |
| `bootstrap-failed` | O bootstrap de knowledge não completou | ❌ |

O CLI imprime um único JSON no stdout com esse campo, as épocas e os commits.

## Limites conhecidos

- **Frentes são paralelas dentro de uma época, não entre épocas.** Uma época é
  uma barreira: todas as frentes mergeiam antes do replanejamento. Frentes em
  profundidades independentes exigiriam abandonar o merge determinístico por
  estágio, que é a espinha do `src/git/`.
- **Máximo de 4 frentes por época** — é o que cabe no teto de 20 passos do
  pipeline compilado.
- **Um juiz verde é uma válvula anti-laço, não prova de correção.** Vale aqui
  a mesma ressalva do [guia de pipelines](pipeline-json-guide.md): dê um
  modelo capaz ao juiz e leia o diff você mesmo.
- **A revisão por tarefa bloqueia por SEVERIDADE, e essa é uma escolha
  deliberada com custo conhecido.** Um achado `blocker`/`major` segura o merge
  tendo ou não o crítico o respaldado com um comando que de fato falhou. O
  modo de falha medido de um crítico LLM é *bloqueio espúrio de código
  correto* — 22,5% a 91,9% de rejeição falsa em 5 modelos × 3 benchmarks,
  87,2% disso alucinação semântica e não implicância de estilo — e o único
  remédio que alguém mediu é exigir que o achado seja **executável** antes de
  poder bloquear. O huu não exige isso. O que ele faz é **contar**: todo
  achado bloqueante que disparou uma rodada de correção é gravado no card como
  provado ou não-provado (`AgentStatus.reviewStats`), e todo achado ainda
  aberto quando uma tarefa é waived no cap de rodadas viaja na evidência da
  época até o próximo planejador — ou, com uma opção de metodologia ligada,
  estaciona a tarefa para uma decisão humana em vez de waivar (veja
  [Opções de metodologia](#opções-de-metodologia)). Isso existe justamente
  para essa escolha
  poder ser revisada com número deste projeto, em vez de literatura medida em
  funções isoladas. Trocar para bloqueio proof-gated é então uma linha em
  `blockOn`.
- **Um card revisado pode levar `cardTimeout × (1 + maxRounds)` de
  wall-clock**, e cada revisão em voo segura um slot do pool (o worker fica
  não-preemptível enquanto o crítico lê a worktree). As rodadas de revisão são
  intra-step, então não consomem `maxNodeExecutions`.
- **O lint gate é um martelo com braço de 60 segundos.** O `mergeGate` reverte
  um commit de merge num exit não-zero e marca o branch como `mergeFailed` —
  o trabalho sobrevive no branch do próprio agente. É por isso que só comandos
  de lint/typecheck o alimentam: qualquer coisa mais lenta pertence ao
  `verifyCommands` do crítico, não a um portão que dispara a cada merge.
- **Uma tarefa em hold estaciona o estágio.** Com uma opção de metodologia
  ligada, uma revisão que bate no limite de rodadas com blockers abertos vira
  o portão de retry interativo — o run espera um humano naquele ponto. É o
  desenho (um waive silencioso tornaria o enforcement decorativo), mas
  significa que uma sessão acompanhada pode parar no meio do estágio; runs
  desacompanhados degradam para o waive clássico e nunca esperam.
- **O congelamento do TDD é imposto pelo juiz, não pelo filesystem.** O passo
  de implementação é *instruído* a não tocar nos arquivos de teste e o juiz da
  frente é *instruído* a checar — um agente determinado ainda consegue
  editá-los, e quem pega isso é o achado bloqueante do crítico, não um bit de
  permissão.
- **O loop-back da revisão de plano re-executa o recon global.** Rework é
  trabalho de verdade: no máximo uma passada extra de recon por época (o check
  limita em 2 rodadas e o padrão segue para a frente), orçada como o preço de
  não abrir fan-out em cima de um plano ruim.
- **Os papéis somente-leitura são uma REDUÇÃO, não um sandbox.** O crítico e os
  juízes (de frente e de época) rodam com uma allowlist de ferramentas sem
  `edit` e sem `write` — o pi remove as duas do registro, então o modelo nem
  sabe que existem. `bash` fica, porque os dois papéis são obrigados a rodar os
  comandos de build/teste do projeto antes de concluir qualquer coisa, e
  `cat > arquivo` continua escrevendo. Tira a ferramenta que um relator alcança
  por reflexo; não torna o papel incapaz.
- **Só o crítico e os juízes são restritos.** O auditor de plano, o relator da
  consolidação e o passo de selagem ESCREVEM seus relatórios — tirar `write`
  deles não endureceria a época, quebraria. `WorkStep.readOnly` existe para
  pipelines que de fato reportam na resposta e não em arquivo; nenhum pipeline
  embutido usa ainda.
- **Um card que compacta o contexto três vezes é interrompido.** Na primeira
  compactação o huu re-declara o caminho do spec e o escopo de escrita na mesma
  sessão (`session.steer()`); na terceira, falha o card com uma mensagem
  acionável em vez de deixá-lo girar até o relógio. Mesmo limiar e mesma razão
  do circuit breaker de época.
- **Escrever o findings shard cedo sobrevive à compactação e à pausa, não ao
  timeout.** O prompt agora pede que os agentes escrevam enquanto trabalham,
  mas o caminho de falha apaga o worktree e o branch do agente — então um card
  que estoura o tempo ainda leva o shard junto. Salvar isso exige um mecanismo
  que ainda não existe.
- **A checagem de colisão de write-set declarado reporta; nunca bloqueia.** Ela
  roda antes do fan-out e ACUMULADA por run (então enxerga duas frentes
  paralelas reivindicando o mesmo arquivo, que a varredura pós-landing só via
  tarde demais), e entra na evidência da época para o próximo planner. Dois
  agentes ainda podem ser despachados sobre o mesmo arquivo — o huu apenas diz
  isso antes.
- **A retomada de época recupera o PLANO, não os agentes.** Uma sessão que
  morreu na Fase C volta e re-executa o grafo persistido em vez de recomprar a
  run de conhecimento e replanejar. Os agentes, seus worktrees e seu trabalho
  parcial se foram; só a metade cara é recuperada.

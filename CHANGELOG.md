# Changelog

All notable changes to `huu` are documented here.

The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/): breaking
changes bump the MAJOR version (in the pre-1.0 phase they rode MINOR bumps).

> **New changelog workflow** — to avoid merge conflicts on the most-touched
> file in the repo, write each change as a `.md` fragment under `.changes/`
> (one per card) instead of editing `## [Unreleased]` directly. Before a
> release, run `npx tsx scripts/changelog.ts` to consolidate. See
> `.changes/README.md` for the format and `scripts/changelog.ts` for the
> CLI (`--check`, `--dry-run`).

## [Unreleased]

## [6.0.0] - 2026-09-05

> **Vindo da 5.2.0? Você recebe tudo de uma vez.** A `5.2.0` é a última versão
> que chegou ao npm. A `[5.3.0]` logo abaixo foi escrita mas **nunca
> publicada** — não existe tag `v5.3.0`, e o pacote `huu-pipe` nunca recebeu
> esse número (é por isso que ela não tem link de compare no rodapé) — e o
> bloco de trabalho do modo dev que vem depois dela também nunca saiu.
> A 6.0.0 publica os três de uma vez.
>
> **MUDANÇAS QUE QUEBRAM** — é um major, e são estas três. Cada uma está
> detalhada nos bullets desta mesma entrada:
>
> 1. **Os presets de roteamento com id de outro endpoint são RECUSADOS no
>    provedor errado.** `--models=hetero`, `thrifty`, `monoculture` e `roster`
>    fixam ao menos um id que só a OpenRouter serve, então sob
>    `--provider=deepseek` o `huu dev` agora **para na borda com exit 1**, antes
>    de tocar no repositório (`checkDevModelPolicy`, `src/lib/dev-mode/dev-model-policy.ts`).
>    Antes a mesma combinação abria a sessão e só morria dentro do primeiro
>    agente, com worktree e branch já criados. `--models=uniform` continua
>    rodando nos dois provedores. **Se você usava `hetero` no DeepSeek:** troque
>    para `--provider=openrouter` (a mensagem da recusa nomeia o provedor que
>    serve cada id) ou para `--models=uniform`.
> 2. **O eixo da credencial passou de `backendBound` para `providerBound`**
>    (`src/lib/api-key-registry.ts`). Um spec ligado ao provedor ATIVO é
>    exigido independentemente do campo `required`, e
>    `selectBackend('jcode').apiKeySpecName` passou a ser `undefined` **de
>    propósito** — a autoridade agora é `apiKeySpecNameForProvider(provider)`.
>    Efeito visível: um run pede exatamente a chave que vai gastar, nunca as
>    duas; uma máquina que só tem `OPENROUTER_API_KEY` deixa de ficar bloqueada
>    pedindo `DEEPSEEK_API_KEY`. **Se você integrava pelo campo antigo:** leia o
>    provedor, não o backend.
> 3. **`EPOCH_MAX_NODE_EXECUTIONS` foi de 50 para 96**
>    (`src/lib/dev-mode/plan-to-pipeline.ts`). O teto por época era estourado
>    por 2304 das 4096 combinações de metodologia que já existiam — `--plan-review`
>    sozinho dá 52 — e uma época estourada morria depois de já ter pago por cada
>    agente. Um pipeline gerado pelo modo dev passa a declarar
>    `maxNodeExecutions: 96`; quem fixou o número antigo em teste ou snapshot
>    precisa atualizá-lo.

### Added

- **Método desenhado (`huu-devgraph-v1`) — o humano desenha a topologia, o huu compila.** Um formato de grafo em que o HUMANO desenha o método (quais blocos rodam, em que ordem, onde ramifica, onde os ramos se juntam) e um compilador o transforma num `huu-pipeline-v2` comum, rodado pelo escalonador de ondas, pelo leque de memória e pelo merge determinístico já existentes. Isto reforça o MANIFESTO §diferencial-2: no modo dev de hoje um planner LLM escreve a topologia em runtime; com um desenho, o planner **não é chamado** — o humano subscreve o método e o modelo só fornece a inteligência DENTRO de cada nó. Nada no formato deixa um modelo acrescentar um nó, uma aresta ou uma rota.
  - **Formato** (`src/lib/dev-graph/`): 4 tipos de nó (`prompt` · `action` · `research` · `gate`), catálogo de **15 blocos** com o par `-review` (só relata) / `-findings` (escreve uma tarefa por achado, para o nó seguinte abrir um leque), **46 códigos de erro estáveis + 4 avisos**, e **6 amostras** prontas. O zod é dono da FORMA, o `validateGraph` é dono das regras de produto e **nunca lança** — o editor valida a cada tecla e um throw ali é um canvas em branco.
  - **Retrabalho**: uma aresta marcada `rework: true` é uma rota de VOLTA sem ser um ciclo — o desenho tem duas camadas (dependência = arestas sem `rework`, ativação = todas), e `default-outcome-is-rework` impede que o default seja o laço, porque o default dispara quando o juiz FALHA.
  - **Join `subset`**: relaxar um join tira a DEPENDÊNCIA (de dado e de sucesso), **não** a barreira de merge BSP da onda — dito no tipo, no compilador, no aviso `join-subset-drops-barrier` e na doc.
  - **Pesquisa na web** (`huu-research-v1`): escada de degradação A (busca com chave) → B (busca keyless) → C (`curl` de URL conhecida), que desce por **FALHA**, não só por ausência — binário instalado não é binário utilizável.
  - **Driver** (`dev-driver.ts`): com um desenho, as Fases A e B não acontecem, a sessão é **exatamente uma época** (`--epochs > 1` é recusado) e um resume sem o desenho é **recusado** em vez de cair no planner.
  - **Superfícies**: canvas React Flow em `/graph` + `GET|POST|PUT|DELETE /api/graphs/*`; `huu graph list|show|validate|compile|new|rm` no terminal; tela `[G]` na TUI (lista, diagrama ASCII, validação, lançamento); `huu dev --graph=<id|arquivo.json>`.
  - **Docs**: `docs/dev-graph.md` + gêmeo pt-BR (incluindo uma seção "Limites conhecidos" honesta), seção nova em `docs/dev-mode*.md`, `docs/KEYBOARD.md` e as duas READMEs.
- **`huu dev --debate` — debate adversarial como a 13ª metodologia selecionável, desligada por padrão.** Entre o recon global e as frentes, o compilador insere uma topologia FIXA de três nós: *Sustentar as escolhas* (escreve `.huu/dev/<sessão>/epoch-N/debate/A.md`, o registro de até seis decisões, cada uma com a alternativa rejeitada, o porquê apontando para um caminho real e a observação que provaria a escolha errada), *Contestar as escolhas* (lê `A.md`, escreve `B.md`, um veredito `SUSTENTADA`/`CONTESTADA` por decisão, com falha prevista e evidência atrás de cada contestação) e *Debate resolvido?*, um check com desfechos ENUMERADOS, teto de duas rodadas e exatamente um `default: true` para a frente. Nenhum dos lados pode editar o arquivo do outro. Como toda metodologia, ela também troca o crítico de cada tarefa para HOLD em vez de waive no teto de rodadas.
- **O resultado chega às frentes por ARQUIVO COMMITADO**, o único canal passo→passo que o huu tem — o recon de cada frente espera o portão do debate e lê os dois briefs pelo caminho, com contrato explícito: decisão `SUSTENTADA` está resolvida e é implementada, decisão `CONTESTADA` vira risco aceito e nomeado no "Context" do spec afetado (nunca licença para redesenhar), e brief ausente vira finding — nunca um veredito inventado.
- **A rubrica do juiz é anonimizada por MODELO — e só por modelo.** Ele nunca sabe qual agente nem qual modelo escreveu cada brief, e o prompt do portão não contém nenhuma string de fornecedor, família ou modelo; os arquivos se chamam `A.md` e `B.md` justamente porque um nome de arquivo não é algo que se possa pedir a um modelo para desver. Anonimato de PAPEL nunca esteve em oferta (as cláusulas do portão precisam ler um arquivo como registro e o outro como ataque para poder compará-los) e o documento agora diz isso em vez de prometer mais. Não existe desfecho "o advogado ganhou" para rotear: um debate que escolhe vencedor seria uma IA decidindo o design.
- **`advocate` e `prosecutor` são papéis de roteamento novos**, com as flags `--advocate-model` / `--prosecutor-model`, e todo preset menos o `monoculture` — que é o braço A/B de propósito — os separa em famílias diferentes. Sem rota, os dois caem no modelo do run: o huu compila assim mesmo e AVISA que é um modelo falando sozinho, porque heterogeneidade é o mecanismo aqui, não um detalhe.
- **`src/lib/dev-mode/methodology-registry.test.ts`**, que nunca existiu — sem ele, a invariante "exatamente um default para a frente" ficaria desapinada justamente na opção que a introduz. Com a flag desligada, o pipeline compilado é byte-idêntico ao de antes, verificado comparando a estrutura nas 4096 combinações das 12 metodologias pré-existentes.
- **Restrição de ferramenta por papel.** `AgentTask.readOnly` e `WorkStep.readOnly` fazem o backend entregar à sessão uma allowlist sem `edit`/`write` (filtro duro do pi: o system prompt é reconstruído sem as ferramentas ausentes). Aplicado ao crítico e ao juiz. `bash` permanece — os dois são obrigados a rodar os comandos do projeto antes de concluir —, então é redução, não sandbox.
- **Disjunção de write-set determinística ANTES do fan-out.** `collideDeclaredOwnership` roda em `prepareStageTasks` sobre as declarações dos specs, acumulada por run, portanto pega a colisão cara: duas frentes paralelas reivindicando o mesmo arquivo. Reporta e registra em `DevEpochEvidence`; nunca bloqueia. `checkWritePartition` passou a delegar ao mesmo núcleo — uma implementação, dois chamadores.
- **Montagem determinística do digest.** `assembleKnowledgeDigest` constrói o digest em TypeScript a partir dos shards já validados por `KnowledgeBriefSchema`, com corte por orçamento que nunca descarta uma seção nem um "Em aberto". A passada do LLM virou refinamento: usada quando cobre toda lacuna, substituída quando não.
- **O crítico agora lê o que o worker disse** (`<worker-report>`, delimitado e explicitamente tratado como dado, não instrução) **e o que a rodada anterior achou** (`<previous-round-findings>`) — antes cada rodada gerava um crítico novo, sem memória, livre para mover a trave e gastar o único turno de conserto.
- **Gestão de contexto por card.** Nova variante `AgentEvent.compaction` e contador `AgentStatus.compactions`: na primeira compactação o huu re-declara spec e escopo na MESMA sessão via `session.steer()`; na terceira para o card com erro acionável em vez de deixá-lo girar até o relógio.
- **Conhecimento acumulado entre épocas.** `readAccumulatedBriefs` varre os shards de todas as épocas anteriores (cada shard carrega seu `gapId`), dedupe por lacuna com a mais nova vencendo e a substituída nomeada, e entrega ao planner como bloco próprio com orçamento separado. As lacunas baseline eram perguntadas só na época 1 e simplesmente se perdiam.
- **`--max-cost=<usd>`** e `DevStopReason 'cost-ceiling'` — o custo já era coletado por época e não barrava nada. Verificado ENTRE épocas: matar um swarm vivo perde o trabalho e paga os tokens assim mesmo.
- **Parada graciosa** (`gracefulSignal`): pare depois que a época corrente aterrissar, em vez de perder o merge de frentes que já passaram pelo juiz.
- **Retomada da execução de uma época.** `DevState.pendingEpoch` — o grafo compilado já era persistido e nunca reusado; um crash na Fase C agora retoma a EXECUÇÃO em vez de recomprar conhecimento e replanejar.
- **Cadeias de fallback de modelo por papel** — valores aceitam lista por vírgula; vence o primeiro degrau que o registro do pi conhece, o preflight só recusa quando todos são desconhecidos, e degraus mortos viram aviso nomeado.
- **`DevModeConfig.knowledgeDigestMaxChars`** — o teto do digest (6000) era uma constante que ninguém podia mover, logo ninguém podia medir se estava certa.
- **`--max-cost` no texto de ajuda, nos dois catálogos** (`cli.help` en + pt-BR).
- **`docs/dev-harness-audit.md`** — auditoria do harness do modo DEV contra o estado da arte (Claude Code, opencode, OMO), com 18 achados referenciados em `arquivo:linha`, o que já estava certo, e o registro do que foi implementado.
- `huu dev`: oito metodologias selecionáveis novas, todas desligadas por padrão — `--write-set` (arquivo fora do write-set declarado bloqueia), `--changelog` (Conventional Commits como merge gate + entrada de changelog exigida do crítico), `--diff-budget` (teto de 400 linhas / 12 arquivos por tarefa), `--fitness` (regra de arquitetura do projeto como merge gate, descoberta na fase de conhecimento), `--checklist` (crítico responde checklist item a item com veredito PASS/FAIL/N-A e evidência), `--traceability` (matriz bidirecional requisito ↔ teste, com portão que recusa órfão não declarado), `--characterize` (snapshot do comportamento atual antes de qualquer mudança — o TDD do código sem spec) e `--verify-claims` (segundo agente re-verifica cada afirmação do digest contra o repositório e rebaixa o que não reproduz).
- `.huu/dev/<sessão>/epoch-N/traceability.md`: matriz de rastreabilidade gerada por `--traceability`.
- **O roteamento por papel do `huu dev` passa a carregar o PROVEDOR junto com o modelo.** `DevModelPolicy` mapeia papel → (modelo, provedor), e é o provedor de cada degrau que decide o perfil do jcode, a `base_url`, o namespace do id e a variável da credencial — um roster heterogêneo só significa alguma coisa se essas quatro coisas viajarem com o modelo. Uma string simples continua válida em todas as superfícies (flag, corpo de POST, tabela de preset) e agora aceita um prefixo opcional `<provedor>:`, como em `openrouter:anthropic/claude-opus-5` — a única forma que sobrevive ao round-trip por um `Record<string, string>` JSON, que é o que `/api/bootstrap` entrega ao navegador e o que o navegador posta de volta. O prefixo é inequívoco contra os sufixos `:free`/`:nitro` da própria OpenRouter.
- **Preset novo `--models=roster`**: um endpoint (OpenRouter), cinco fornecedores, cada papel no modelo cujo modo de falha ele menos pode pagar — planner, recon e integração no V4 Pro, worker no V4 Flash, crítico no GPT-5.6 Sol (cross-family em relação aos workers DeepSeek por construção), reporter no GLM-5.3 Flash e juiz no Claude Opus 5, que é o papel cuja falha é SILENCIOSA porque todo check tem `default: true` para a frente.
- **`npm run dev` agora roda NATIVO, sem Docker** — a nova env `HUU_DEV_NATIVE=1` (só env, nunca flag) pula o re-exec no container para o loop de quem desenvolve o huu: editar `src/` e rodar de novo deixa de custar um `docker build` + `docker run` a cada iteração, e nem precisa do daemon ligado. O CLI imprime um banner ruidoso em todo start (en + pt-BR) porque o isolamento do container e o teto de memória do container ficam ambos ausentes; no Linux o self-wrap do systemd volta a ser alcançável e fornece o teto de kernel.
- **`npm run dev:docker`** — o comportamento anterior do `npm run dev`: mesmo hot reload, mas atravessando o Docker (refresh do `huu:local` via `scripts/ensure-image.sh` antes), que é o ensaio fiel do que o usuário recebe.
- **`scripts/check-dockerfile.ts` — 10º passo do `scripts/gate.sh`**, que reprova qualquer sintaxe que um Docker de fábrica não constrói: **qualquer** flag em `RUN` (o builder clássico não aceita nenhuma, então `--mount=type=cache|secret|ssh|bind`, `--network=` e `--security=` caem na mesma regra, junto com flags que ainda nem existem), `COPY`/`ADD` fora de `--from`/`--chown` (`--link`, `--chmod`, `--checksum`, `--parents`, `--exclude`), e heredoc de Dockerfile (`RUN <<EOF`). O verificador junta continuações de linha antes de casar — a forma `RUN \` + `--mount=…` na linha seguinte escapa de qualquer regex por linha, e foi exatamente essa a forma usada no repositório. Ele junta também através de **linha em branco** dentro da continuação, que é como o Docker de fato lê o arquivo (ele só avisa `Empty continuation line found in: …` e segue); e uma linha lógica que o parser NÃO consegue ler virou violação em vez de ser descartada em silêncio — era esse descarte que fazia `RUN \` + linha em branco + `--mount=…` sair com exit 0 enquanto o `docker build` morria com `the --mount option requires BuildKit`. Um `# syntax=docker/dockerfile:1.x` vira AVISO, não erro: o builder legado o ignora, e o gate só diz não ao que de fato quebra. `scripts/check-dockerfile.test.ts` prova as duas direções — aprova o `Dockerfile` atual e reprova, uma a uma, as mutações que o reintroduziriam, checando o exit code e a mensagem que o `gate.sh` consome.
- **A raiz do `Dockerfile` ganhou um bloco `PORTABILITY CONTRACT`** explicando por que não há cache mount, quanto eles valiam e que a imagem precisa construir num Docker de fábrica. Sem isso a próxima pessoa "otimiza" e quebra o build de novo.
- **Os dois READMEs agora dizem explicitamente que o `buildx` NÃO é necessário**, na seção de pré-requisitos — a armadilha que custou o debug era justamente um pré-requisito não documentado.
- **Internacionalização (i18n) de ponta a ponta — inglês e português do Brasil.** Toda a interface passa por um catálogo único em `src/lib/i18n/`: a TUI Ink, a UI web (`index.html` + módulos), o `--help`, os banners e os erros do CLI. O idioma vem de `HUU_LANG` (ou de `HUU_LOCALE`/`LC_ALL`/`LC_MESSAGES`/`LANG`), com `en` como padrão; a UI web tem um seletor próprio em ⚙ Configurações, persistido por navegador em `localStorage`.
- **Guarda de tradução faltando em três camadas.** (1) `tsc` falha quando uma chave existe em `en` mas não em `pt-BR` — o catálogo `pt-BR` é tipado como `Record<MessageKey, string>`. (2) `initI18n()` roda `assertCatalogsComplete()` em todo entrypoint e ABORTA o processo com `CatalogIntegrityError`, nomeando chave e locale. (3) `t()`/`translate()` lançam `MissingTranslationError` na hora se a chave faltar em QUALQUER locale — inclusive num que o usuário não está usando. `HUU_I18N_STRICT=0` degrada (2) e (3) para aviso em stderr.
- **`GET /api/i18n`** — serve o catálogo do locale pedido ao navegador (sem token: o cliente precisa pintar a própria interface antes de autenticar), de modo que web e terminal compartilham uma única fonte de verdade.
- **`src/web/client/i18n.js`** — runtime de tradução do navegador: `t()` que lança em chave desconhecida, `applyI18n()` que preenche os atributos `data-i18n`, `data-i18n-html`, `data-i18n-placeholder`, `data-i18n-title` e `data-i18n-aria-label`, e troca de idioma sem recarregar a página.
- **`src/lib/i18n/coverage.test.ts`** — varre `src/` atrás de toda chave referenciada (chamadas `t()`/`translate()`, atributos `data-i18n*`, literais em tabelas de lookup) e falha quando alguma não está traduzida em todos os locales, ou quando o catálogo tem chave órfã que ninguém usa.
- **`docs/i18n.md`** (+ gêmeo `docs/i18n.pt-BR.md`) — como escolher o idioma, como adicionar uma chave e por que a guarda é ruidosa de propósito.
- **Skill de agente `translating-the-ui`** — registrada no `catalog.md` (com uma dica de cadeia: toda string nova entra no chain junto com a skill da superfície), instruindo a conversão inteira: onde mora cada módulo do catálogo, as formas de chamada por superfície, as três camadas de imposição e as armadilhas que já custaram bug (`t()` em corpo de módulo, colisão do nome `t`, rótulos com padding manual, classificadores que precisam continuar cegos ao idioma).
- **`check-metodo` é o 9º passo do gate**, então a prosa medida do METODO passa a ser verificada em todo push/PR junto com o resto. Duas mudanças foram necessárias para que isso fosse honesto em vez de vermelho-por-construção:
- **Tolerância de 10%** (`HUU_METODO_TOLERANCE`) nos números derivados. Igualdade exata ficaria vermelha no commit seguinte a cada atualização — foi exatamente assim que o `PENDENTE` do `gate.sh` ensinou o repositório a ignorar o vermelho. 10% pega prosa materialmente errada (esta tabela ficou 23% fora em dois dias) e sobrevive ao trabalho normal. A mensagem de erro passa a dizer o quanto está fora e qual a tolerância.
- **O cheque de cabeçalho virou aviso.** Exigir que o commit anotado no METODO seja igual ao `HEAD` é insatisfazível: um arquivo não pode conter o hash do commit que o introduz. Como gate, ficaria vermelho para sempre. Quem guarda a verdade são os números, que são verificáveis contra a árvore de trabalho.
- **A contagem de `src/` passou a medir o que o documento declara.** O verificador contava só TS+TSX enquanto a linha do METODO diz "inclui client JS/CSS/HTML", e por isso emitia um WARN permanente — aviso que nunca sai é ruído que se aprende a ignorar.
- **OpenRouter volta como PROVEDOR de primeira classe — e a distinção backend × provedor passa a existir no código.** `LlmProvider` (`src/lib/providers.ts`) tem de novo dois membros, `deepseek` e `openrouter`, ambos servidos pelo MESMO backend de despacho (`jcode`). O backend decide COMO o agente roda; o provedor decide PARA ONDE a chamada vai, QUE credencial ela gasta e QUE modelos o catálogo pode oferecer. A escolha entra num campo novo, `AppConfig.provider`, e atravessa a TUI, o CLI (`--provider=deepseek|openrouter`, com os apelidos `ds` e `or`) e a web até o spawn, onde decide de uma vez o `--provider-profile` do jcode, a `base_url` do perfil, o namespace do id de modelo e a variável de ambiente da credencial.
- **Cinco modelos novos no catálogo** (`recommended-models.json`), todos verificados ao vivo na OpenRouter: `anthropic/claude-opus-5`, `openai/gpt-5.6-sol`, `z-ai/glm-5.3-flash` e as entradas OpenRouter de `deepseek/deepseek-v4-pro` e `deepseek/deepseek-v4-flash` — as duas últimas existem para que um id DeepSeek seja portátil entre os dois endpoints.

### Changed

- **Documentação alinhada com a realidade da CI.** `AGENTS.md`/`CLAUDE.md`, os dois READMEs, `docs/operations{,.pt-BR}.md`, `docs/onboarding{,.pt-BR}.md`, `METODO.md §1` e as skills `committing-and-validating`, `writing-tests`, `running-in-docker`, `releasing-versions` e o `catalog.md` afirmavam "não há CI automatizada". Agora descrevem o que de fato existe: a CI roda os 9 passos do `scripts/gate.sh` em todo push e PR, `bash scripts/gate.sh` reproduz isso localmente, e a CI **não** builda imagem, **não** roda smokes de Docker e **não** publica nada — release segue manual.
- **Prompts compilados do modo DEV são fixo-primeiro**, separados por `DEV_STEP_BOUNDARY`, com teste fixando que nada específico de época, frente ou agente aparece acima da fronteira. Invariante estrutural, não economia de token — o cabeçalho por agente já limita o prefixo compartilhável a poucas centenas de tokens do primeiro turno.
- **O protocolo do findings shard passou de "escreva DEPOIS do trabalho" para "escreva ENQUANTO trabalha"** — um card que estoura o tempo, é preemptado ou tem o contexto compactado levava junto tudo o que aprendeu.
- As metodologias passam a ser declaradas num registry único (`src/lib/dev-mode/methodology-registry.ts`). O parse das flags, o texto de uso do CLI, o catálogo da web e os bullets do planner são derivados dele — antes eram quatro listas mantidas à mão que falhavam em silêncio quando uma era esquecida.
- `Pipeline.mergeGate` passa a ser composto por acumulação: várias metodologias contribuem comandos, encadeados com `&&`. Antes cada opção atribuía o campo, então a segunda a compilar apagava a primeira sem erro nenhum.
- As cláusulas do juiz de cada frente passam a ser numeradas a partir da lista, não à mão — duas metodologias que acrescentam cláusula não colidem mais no mesmo número.
- `DevVerifyCommands` ganha o bucket opcional `fitness`, preenchido só a partir de um rótulo `fitness:`/`arch:` explícito, para que ligar `--fitness` não mova um comando para fora do bucket `lint` que `--lint-gate` sempre rodou.
- O painel de metodologia da web passa a renderizar o texto do catálogo i18n (`web.dev.method.<chave>.label`/`.desc`, en + pt-BR) em vez do inglês cru que o servidor serve. O registry continua declarando QUAIS opções existem; o catálogo declara como elas se leem, então trocar o idioma no ⚙ traduz o painel sem recarregar. As flags de metodologia também entram no `cli.help` dos dois idiomas.
- **O preflight de modelo voltou — e agora recusa na BORDA.** Ele estava morto desde que `model-registry-check.ts` foi deletado, e foi reconstruído sobre o catálogo (`checkDevModelPolicy`, em `src/lib/dev-mode/dev-model-policy.ts`), com uma epistemologia explícita: RECUSA só diante de contradição positiva (um id que só provedores fora deste run servem), AVISA na ausência de evidência (um id que nenhuma entrada do catálogo menciona). O huu não consegue enumerar o que um endpoint serve — a DeepSeek não publica `/models` e o catálogo ao vivo da OpenRouter saiu na v3.0 — então "não está no JSON" nunca vira recusa, sob pena de o huu ficar inutilizável com qualquer modelo lançado depois dele. A recusa acontece antes de existir worktree, branch ou commit, ressuscitando o stop reason `model-preflight-failed`; antes, `z-ai/glm-5.2` apontado para `api.deepseek.com` só falhava dentro do primeiro agente, com a worktree e o branch já criados.
- **Os presets existentes passam a declarar o endpoint dos ids que só a OpenRouter serve.** `hetero`, `thrifty` e `monoculture` são presets OpenRouter e não tinham como ser outra coisa (um crítico cross-family precisa de um endpoint que sirva mais de uma família), mas nada dizia isso: rodá-los no DeepSeek nunca pôde funcionar, só falhava mais tarde e pior. Os ids `deepseek/…` continuam SEM prefixo de propósito — os dois endpoints os servem, então uma rota não qualificada é portátil e herda o provedor do run.
- **A tela `/dev` do navegador deixou de montar um pedido impossível.** Ela pré-preenchia `hetero` enquanto o provedor padrão é `deepseek`, ou seja, o caminho default virava HTTP 400. O servidor continua recusando um corpo impossível; o que mudou é que o cliente não monta mais um: `/api/bootstrap` publica quais presets rodam em cada provedor, o seletor desabilita os demais com tooltip, e a MESMA função que recusa o POST é a que decide isso — sem uma segunda cópia da regra para divergir.
- `decideReexec` ganhou um ramo `HUU_DEV_NATIVE` logo depois do `HUU_IN_CONTAINER`. As grafias de usuário removidas (`--yolo`, `--no-docker`, `HUU_NO_DOCKER`) continuam mortas e sem qualquer relação com a nova env — o huu segue docker-only como produto.
- **A documentação passa a distinguir backend de provedor, que era a confusão de CAMADA por trás de tudo.** `AGENTS.md` é o dono declarado dos "fatos correntes do código" (`METODO.md §0.4`) e descrevia backends que não existem mais — e `CLAUDE.md` é symlink para ele, então os dois estavam errados juntos. A regra agora está escrita como regra: backend = COMO o agente é executado (`jcode` por subprocesso, `stub`); provedor = PARA ONDE a chamada vai e QUE credencial ela gasta (`deepseek`, `openrouter`). Um backend serve N provedores — e é daí que decorrem o `apiKeySpecName` do bundle ser `undefined` de propósito e o `providerBound` ser exigido independentemente de `required`. Os dois READMEs, `docs/README.md` e `docs/jcode-setup-guide.md` foram alinhados junto.
- **O seletor de modelos deixou de ser descrito como "o catálogo ao vivo da OpenRouter (339 hoje)"** — hoje é o catálogo estático do repositório, filtrado pelo provedor ativo.
- **As skills que o `project-router` obriga todo agente a carregar antes de implementar deixaram de ensinar a união errada.** `integrating-llm-backends` afirmava um `AgentBackendKind` com membros deletados e que um deles era "um backend real"; `running-dev-mode` documentava um preflight cujo arquivo tinha sido apagado. Como o router carrega a skill ANTES da implementação, uma skill errada propaga o erro para todo trabalho futuro. Os docs dos backends removidos viraram stub histórico (oito arquivos fora do escopo ainda os referenciam), preservando a lição transferível: uma chamada LLM auxiliar num provedor diferente do selecionado é um bug de COBRANÇA.
- **O eixo da credencial passou de `backendBound` para `providerBound`** (`src/lib/api-key-registry.ts`). Um spec ligado ao provedor ATIVO é exigido independentemente do campo `required`, então um run pede exatamente a chave que vai gastar — nunca as duas, nunca nenhuma. Com dois provedores atrás do mesmo backend, a amarração por backend teria feito um único run exigir as DUAS chaves. Consequência direta: `selectBackend('jcode').apiKeySpecName` é `undefined` de propósito — um backend que serve dois provedores não pode nomear credencial, e a autoridade passou a ser `apiKeySpecNameForProvider(provider)`. Antes disso, com só `OPENROUTER_API_KEY` na máquina, o huu não rodava: o único spec `required` era o `deepseek`, e a TUI marcava "key set" numa tela para pedir `DEEPSEEK_API_KEY` na seguinte.
- **O `config.toml` hermético do jcode passa a ser gerado a partir da tabela de provedores** (`src/orchestrator/backends/jcode/hermetic.ts`): um bloco `[providers.<nome>]` por provedor, com `base_url` vindo do `ProviderInfo` e `api_key_env` vindo do registry de chaves — o mesmo host que os clientes LangChain discam, em vez de duas tabelas mantidas à mão que podiam divergir. Nenhum segredo mora no arquivo: cada perfil só NOMEIA a sua variável.
- **As chaves dos OUTROS provedores são removidas do ambiente do subprocesso do agente** (`stripForeignProviderKeys`, em `src/orchestrator/backends/jcode/factory.ts`). O agente executa shell arbitrário dentro da worktree; ele passa a ver só a credencial do provedor do run.
- **O seletor de modelos passa a filtrar pelo provedor escolhido**, e não mais pelo backend. Cinco entradas de vendor alheio que já existiam no catálogo (`z-ai/glm-5.2`, `openai/gpt-5.4`, `anthropic/claude-opus-4.6`, `minimax/minimax-m2.7`, `moonshotai/kimi-k2.6`) passam a declarar `provider: openrouter` — antes o seletor DeepSeek oferecia sete modelos dos quais cinco não tinham como funcionar. Para o backend `stub`, que não chama provedor nenhum, o filtro não se aplica: um smoke test continua vendo tudo.

### Fixed

- **`AutoScaler.shouldSpawn()` — floor of one: degrade to sequential, never to zero.** Em máquina carregada por processos de FORA do huu (navegador/IDE segurando RAM acima do dial), todos os portões de estado de máquina — `stopThreshold` (RAM/CPU ≥ 90%), o freio PSI e o `budgetAdditional() <= 0` do modo MAX — ficavam verdadeiros indefinidamente com zero agentes vivos. Isso não era "mais devagar": era zero agentes PARA SEMPRE (pool girando, custo $0, run que nunca termina). Agora, quando nada está vivo, um agente é sempre admitido nos três modos (auto, MAX e manual), fechando o portão de novo assim que esse agente existe. Espelha o piso que `AdmissionController.shouldAdmit`, `GlobalScheduler.shouldSpawn` e `budgetCeiling()` já tinham. O COOLDOWN deliberadamente NÃO recebe o piso — é uma espera nossa, limitada no tempo e que se libera sozinha, logo nunca trava. Era a causa raiz de 14 testes de integração com git real que só quebravam em máquina carregada.
- **`minimatch` era importado sem estar declarado — o `npm run typecheck` do repositório reprovava.** `src/lib/pipeline-io.ts:4` faz `import { minimatch } from 'minimatch'` desde a checagem de write-sets disjuntos, mas o pacote não estava no `package.json` nem no `package-lock.json` — nem sequer como dependência transitiva hoisted. Além do typecheck, todo arquivo de teste cuja cadeia de imports passa por `pipeline-io.ts` falhava na carga, antes de rodar um único caso. O HEAD do projeto estava vermelho.
- **A suíte de testes voltou a descrever o código que existe, e não o que foi removido.** A remoção dos backends antigos passou um find-and-replace pela metade: `src/lib/api-key.test.ts`, `src/lib/api-key-pool.test.ts`, `src/models/catalog.test.ts`, `src/web/api-data.test.ts`, `src/web/server.test.ts`, `src/web/dev-manager.test.ts`, `src/lib/screen-fsm.test.ts` e os três testes do `src/lib/dev-mode/` afirmavam backends deletados, um spec de credencial renomeado pela metade (o POST mandava `deepseek`, as asserções liam `?name=openrouter`) e features que não existem mais. Os casos vivos foram reescritos contra o mundo atual em vez de apagados; os que descreviam proteções REMOVIDAS (o preflight de modelo, o bootstrap de conhecimento) viraram testes de caracterização, para que a proteção perdida ficasse gravada onde o próximo dev tropeça nela em vez de sumir do registro.
- **Três testes de precedência de credencial estavam VERDES E VAZIOS.** Em `src/lib/api-key.test.ts`, o nome do spec tinha sido trocado mas o corpo continuava definindo a variável de ambiente do spec ANTIGO — então a asserção passava sem exercitar precedência nenhuma. Um teste verde que não prova nada é pior que um vermelho, porque ninguém volta nele.
- **A CI passou a ser verde de verdade — nunca tinha passado uma vez.** `.github/workflows/gate.yml` existia desde a 5.3.0 e falhava em 100% das execuções, por quatro causas independentes, nenhuma delas quebra real de código: (1) o runner do GitHub não tem identidade git, e a suíte cria repositórios git de verdade e commita neles — 64 testes morriam em `fatal: unable to auto-detect email address`, invisível localmente porque a máquina do dev tem identidade global; (2) `tool_exists` do `scripts/gate.sh` classificava qualquer comando com `/` como caminho de arquivo, então todo passo `npx tsx scripts/<x>.ts` era reportado como "ferramenta nao encontrada" com o script ali no disco; (3) `check-acceptance` e `validate-graph` seguiam marcados `PENDENTE` desde a W1, quando ainda não existiam — e qualquer `PENDENTE` força `exit 1` no gate inteiro por design (METODO M1-01), então a CI era vermelha por construção mesmo com tudo passando; (4) no resumo, `[[ "$fail" -gt 0 ]] && parts+=(…)` retorna 1 quando o contador é zero e, com `set -e` herdado do laço, matava o script antes de imprimir — bug que só dispara numa execução totalmente verde, ou seja, exatamente a que nunca acontecia.
- **`gate.sh --list-from-ci` agora entende block scalar YAML** (`run: |`), em vez de imprimir um `|` solto e esconder os comandos. Esse modo é o detector de drift entre o registro de passos do `gate.sh` e o workflow — cego, ele não detectava nada.
- **O teto de execuções por época já estava estourado ANTES desta feature.** `EPOCH_MAX_NODE_EXECUTIONS` valia 50 contra um comentário que estimava "≈ 26". Reproduzindo o loop REAL do escalonador sobre as 8192 combinações de metodologia, com cada portão tomando o braço para trás até o próprio `maxRuns` forçar o default (a estratégia pessimal, verificada como dominante sobre 20 000 aleatórias), o pior caso é 70 sem `--debate` nenhum — e **2304 das 4096 combinações pré-existentes já estouravam 50** (`--plan-review` sozinho dá 52). Uma época que estourava morria em `recordRunError` depois de já ter pago por cada agente até ali, com o passo de selagem nunca rodando. O teto foi re-medido para 96, e um teste novo (`the node-execution budget`) replaya a medição a cada execução e falha se alguma combinação deixar de caber ou se o pior caso sair do valor pinado.
- **Com `--plan-review`, um rework de plano não re-discute o debate.** Um rework re-pendura o cone a jusante inteiro; com o debate pendurado no recon global, esse cone continha os dois debatedores, então todo rework de plano pagava a discussão de novo (85 execuções de nó na combinação `tdd+planReview+traceability+characterization+debate`). O `rework` do portão do plano passa a mirar um nó abaixo, no PORTÃO do debate, quando ele está ligado — a cobertura é idêntica e a separação é honesta: o portão do plano julga *specs*, o debate julga *design*.
- **Três portões diziam que o texto do juiz chega aos agentes de retry.** Nada no huu injeta a `reason` de um check em prompt nenhum: um veredito `rework` ou `contestado` é o REGISTRO de por que o passo voltou, lido por um humano no card do check e no log do run. A frase era herdada, não trazida pelo `--debate`, e os três portões passam a dizer isso com as próprias palavras.
- **O cabeçalho de agente contradizia todo prompt do modo DEV.** `generateAgentSystemPrompt` era herdado de uma ferramenta linear de refactoring e chegava ANTES do prompt do passo: para todo agente de swarm ele renderizava o próprio spec como "o único arquivo que você pode editar" (em `scope: 'memory'`, `task.files` é o BRIEFING, não o alvo), proibia criar arquivos "unless absolutely necessary for the refactoring", proibia comandos git contra o passo TDD que manda commitar, e mandava manter cobertura de teste contra o passo que CONGELA os testes. Para todo papel somente-leitura — crítico, juiz, auditor de plano, reporter — ele dizia "you may read and modify any file… Apply changes using the edit tool" logo acima de "You report. You do NOT write code." Substituído por um cabeçalho neutro cujo escopo de escrita vem do `## Files this task OWNS` do próprio spec (`AgentTask.ownedPaths`). O arquivo não tinha teste nenhum; agora tem nove.
- **`/skill:project-router` era um comando morto no topo de todo prompt do modo DEV**, por duas razões independentes: o loader hermético passava `noSkills: true` (desligando a descoberta de `.agents/skills`) e o `_expandSkillCommand` do pi só expande quando o texto COMEÇA com `/skill:` — e o cabeçalho do agente sempre vinha antes. Agora as skills do worktree são carregadas via `additionalSkillPaths` (que `noSkills` não suprime), então o pi as lista em `<available_skills>` com descrição e caminho, e o prefixo virou um ponteiro curto e determinístico.
- **`event-mapper` escutava `auto_compaction_start`, evento que o pi 0.73.x não emite** (o nome real é `compaction_start`). O `case` era código morto: um card com o contexto em thrashing não produzia sinal algum — nem o aviso que o próprio comentário prometia.
- **O digest de conhecimento podia perder uma lacuna inteira sem deixar rastro.** `readKnowledgeDigest` só caía para os shards quando o digest estava AUSENTE, nunca quando estava ERRADO, e o planner cego não distingue seção faltante de "nada a saber aqui".
- **`WorkStep.writes` nunca chegava ao agente.** O campo era declarável, validado estaticamente entre passos concorrentes e conferido depois do fato — mas o agente jamais era informado dele, que é o único uso capaz de PREVENIR a violação em vez de registrá-la.
- **Uma sessão do modo dev podia sumir EM SILÊNCIO se o huu morresse no meio de uma escrita.** `src/lib/dev-mode/dev-state.ts` gravava `state.json` e `goal.md` com `writeFileSync` cru; um arquivo truncado não dá erro na leitura — `readDevState` devolve `null`, e `null` significa "não oferecer resume". A sessão desaparecia sem uma mensagem e a época 1 replanejava do zero. As duas escritas passam a ser atômicas (arquivo temporário irmão + `rename`), o padrão que `graph-store.ts`, `surf-research.ts` e `jcode/hermetic.ts` já usavam. O `rename` instala um inode NOVO criado com `0666 & ~umask`, então um `state.json` que o usuário tivesse deixado em `0600` voltava `0644`: o mode é lido antes e reaplicado depois. O escopo é morte de PROCESSO, não queda de energia — sem `fsync`, e o docstring diz isso em vez de prometer mais.
- **`npm start` nunca conseguiu construir a imagem num Docker sem o plugin `buildx` — e como o huu é docker-only, isso não degradava uma feature, impedia o produto inteiro de subir.** O build morria no `Step 4/40` com `the --mount option requires BuildKit`: `Dockerfile:25` e `:55` usavam `RUN --mount=type=cache,target=/root/.npm`, sintaxe que só o frontend BuildKit entende, presente desde o commit `26d093b` (v1.0.0). `DOCKER_BUILDKIT=1` não resolvia (sem o plugin ele falha com `BuildKit is enabled but the buildx component is missing or broken`), e o `buildx` é um pacote separado que o README nunca listou como pré-requisito — ele prometia apenas Node.js ≥ 20, `git` e Docker. Os dois mounts foram removidos e os 40 steps passam a construir no builder clássico. O custo é quase nulo, medido antes de cortar: o mount da linha 55 embrulhava `npm prune --omit=dev`, que não baixa nada, e o da linha 25 só paga quando o `package-lock.json` muda — com o lockfile intacto o cache de CAMADA já pula o step inteiro.
- **`scripts/ensure-image.sh` mostrava o erro cru do Docker e deixava o usuário sem próximo passo.** Agora ele captura a saída do build e traduz as falhas conhecidas na linha de comando que conserta cada uma: sintaxe BuildKit-only no Dockerfile (aponta para `scripts/check-dockerfile.ts`, que nomeia a linha), `DOCKER_BUILDKIT=1` forçado sem o plugin, daemon fora do ar, `permission denied` no `docker.sock`, disco cheio e falha de DNS dentro do build. Em qualquer caso ele imprime o comando exato para reproduzir e o caminho do log completo, e aborta — rodar uma `huu:local` velha em silêncio é exatamente o que esse script existe para impedir.
- **A config headless publicada no README estava QUEBRADA.** Ela trazia `"backend": "pi"`, que reprova no `AgentBackendKindSchema` (`z.enum(['jcode', 'stub'])`) — quem copiasse o exemplo recebia erro de validação. O escape hatch documentado também era `HUU_PI_HERMETIC`, variável que nada mais lê; a real é `HUU_JCODE_HERMETIC`.
- **A checagem de nome de backend do gate de skills era TAUTOLÓGICA — não tinha como reprovar nada.** Ela montava a alternação do grep A PARTIR dos kinds válidos extraídos do próprio `registry.ts`, então só procurava nomes que já eram válidos: o ramo de erro era inalcançável, e uma união com dois backends deletados ficou semanas dentro de um `SKILL.md` enquanto o script imprimia OK. O vocabulário agora é FIXO e HISTÓRICO (`pi`, `azure`, `azure-openai`, `azure-foundry`, `copilot`), nunca derivado do conjunto atual — o `registry.ts` é consultado só para DES-marcar um nome que tenha sido readicionado. Só formas inequívocas de "isto é um backend vivo" reprovam, qualquer linha que enquadre o nome como passado/removido passa, e `LEARNINGS.md` fica fora do escopo de propósito (é um diário datado: um registro de 2026-06 sobre um backend de então está correto). Ao ser corrigida, a checagem acusou linhas reais em skills que o router carrega, e dois testes permanentes em `src/lib/skills-library.test.ts` pinam que ela CONSEGUE reprovar.
- **Primeiro pino `arquivo:linha@sha1` da biblioteca de skills**, ancorado na declaração de `AgentBackendKind` em `src/orchestrator/backends/registry.ts`, para que a próxima remoção de backend quebre o gate em vez de envenenar agentes. Ele disparou na primeira oportunidade e acertou: a declaração andou uma linha quando o trabalho do provedor acrescentou uma linha ao doc-comment, com sha1 IDÊNTICO — assinatura de drift puro de número de linha, e não de fato. Reancorado com `scripts/pin.ts`.
- **`GIT_DIR` herdado do ambiente sobrescrevia o `cwd` de todo git que o huu dispara.** `nonInteractiveGitEnv()` montava o ambiente do filho como `{ ...process.env, …as quatro variáveis anti-prompt }`, e as variáveis que dizem ao git QUAL repositório usar (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_NAMESPACE`, `GIT_PREFIX`) vencem o `cwd` explícito. Um huu invocado de um hook do git, de um `git rebase --exec` ou de um passo de CI que as define apontaria cada commit de agente, cada merge e cada exclusão de branch para o repositório do CHAMADOR. Agora são removidas: o `cwd` decide o repositório, e o valor correto para elas é ausente.
- **O hook opt-in de pre-push falhava 248 testes quando rodado de uma git worktree.** `git push` de uma worktree vinculada exporta `GIT_DIR=<principal>/.git/worktrees/<nome>` para os hooks (de um clone normal, não exporta), então os helpers de teste que disparam `execFileSync('git', args, { cwd: tmpdir })` operavam neste repositório em vez do temporário — falhando como erros de asserção comuns, sem nada que nomeasse o ambiente. O hook agora limpa essas variáveis antes do gate.
- **Os sete subsistemas LangChain do huu discavam a string literal `undefined/` como `baseURL`.** Em `src/lib/llm-client-factory.ts`, `ctx.deepseekEndpoint?.trim().replace(/\/+$/, '') + '/' || DEEPSEEK_BASE_URL` avalia como `(undefined + '/') || DEFAULT`, porque `+` liga mais forte que `||` — e `"undefined/"` é truthy, então o default era inalcançável. Como nenhum call site define `deepseekEndpoint`, era esse o valor que TODOS recebiam: o planner do modo dev, o `assistant-architect`, o `assistant-client`, o `project-recon`, o `recon-selector`, o `llm-suggest-files` e o `assistant-check-feasibility`. O override passa a ser resolvido ANTES da normalização, e o default e o override compartilham a mesma forma canônica (sem barra no fim). Um override que normaliza para vazio agora é RECUSADO em vez de degradar em silêncio — um `baseURL` vazio faz o SDK da OpenAI cair em `api.openai.com` e mandar a chave do provedor para o host errado.
- **Os números medidos do `METODO.md §1` e `§3` estavam até 97% fora e nada reprovava.** `scripts/check-metodo.ts` existia e detectava a deriva corretamente, mas não estava em nenhum gate — ninguém o executava. Todos os valores foram remedidos: total versionado 135.866 → **167.212** linhas, testes 116 → **142** arquivos, skills 20 → **22**, `AGENTS.md` 520 → **145** linhas. A linha "Verificação automática" ainda dizia **zero CI**.
- **A tabela de singletons do §3 descrevia arquivos que já não existem assim.** `src/web/client/app.js` era o pior ofensor com 3.723 linhas e hoje tem **113** (o cliente virou ~15 módulos ESM); `src/lib/types.ts` era 1.235 e hoje tem **84** (virou o diretório `src/lib/types/`). A tabela foi recalculada por churn×linhas e a prosa passou a registrar que o diagnóstico **foi executado** — hoje o pior singleton é `src/orchestrator/index.ts`.
- **Nenhum modelo do catálogo rodava pelo caminho DeepSeek nativo.** O catálogo do huu tem a forma da OpenRouter (`vendor/modelo`) e o backend jcode passa `--model` VERBATIM, mas `api.deepseek.com` só conhece os próprios modelos pelo nome NU: o `config.toml` declarava `deepseek-v4-pro` enquanto o huu mandava `deepseek/deepseek-v4-flash`, e o endpoint respondia "model not found". Cada provedor passa a declarar o seu `modelNamespace`, e `modelIdForProvider` remove APENAS o prefixo do PRÓPRIO provedor — um id de vendor alheio sai intacto, de propósito, para o endpoint dizer "unknown model" em vez de o huu mastigá-lo num id que só parece plausível. É uma regra, não uma tabela de tradução.
- **Uma chave colada no prompt do provedor errado passa a ser RECUSADA.** O aviso por prefixo não conseguia pegar isso sozinho: chaves DeepSeek começam com `sk-`, as da OpenRouter com `sk-or-`, e `sk-or-…` satisfaz `startsWith('sk-')`. O usuário colava, não via aviso nenhum, e o huu persistia a chave sob o nome `deepseek` e a mandava para `api.deepseek.com`. A discriminação passa a ser CRUZADA (`detectForeignKeySpec`): um valor é estrangeiro quando o prefixo de OUTRO spec é estritamente mais específico e também casa, ou quando ele não satisfaz o prefixo do alvo mas casa com o de algum outro. Um valor que não casa com nada continua só avisando — formatos de chave mudam, e uma forma desconhecida não pode trancar o usuário do lado de fora. A mesma recusa existe no servidor web, como defesa em profundidade.
- **A chave salva no ⚙ Settings da web nunca chegava ao run.** O painel lia e escrevia o spec `'openrouter'` literalmente enquanto o run resolvia a credencial do provedor selecionado — então a chave salva ali só servia por coincidência. O painel inteiro (rótulo, placeholder de dica, status, pool e o POST de validação) passa a seguir o spec do provedor ATIVO, vindo da mesma projeção `/api/providers` em que o formulário de lançamento se baseia.

### Removed

- **A diretiva `# syntax=docker/dockerfile:1.7` da primeira linha do `Dockerfile`.** O builder legado a ignora (não é erro), mas ela anuncia um frontend que o arquivo não usa mais — e esse anúncio é o convite que trouxe o `RUN --mount` em primeiro lugar. O arquivo sem a diretiva foi construído de ponta a ponta pelo caminho real (`./scripts/ensure-image.sh`) num Docker 29.7.2 **sem** o plugin buildx: 40 steps, `Successfully tagged huu:local`, `docker run --rm huu:local huu --help` com RC 0. O caminho **com** BuildKit não foi reexecutado depois da remoção — sem `# syntax=` o BuildKit usa o frontend embutido, que lê tudo o que há aqui, e deixa de puxar a imagem `docker/dockerfile:1.7` do registry; isso é raciocínio, não transcrição. Vale o alerta de método: uma verificação de equivalência que remove comentários antes de comparar é CEGA para esta mudança — `# syntax=` é um comentário, então o strip apaga justamente a linha em teste.

## [5.3.0] — 2026-07-30

### Added

- **METODO.md — Playbook de ondas.** Diagnóstico medido (4 mutações, 2 erros de tipo, teste cruzado de gêmeos) + plano de 34 ações em 11 ondas para fechar as lacunas de verificação, propriedade de arquivo e proveniência do `huu`.
- **`scripts/gate.sh`** — gate local com 8 etapas, 3 estados (PASS/FAIL/PENDENTE), ferramenta ausente = vermelho.
- **`WorkStep.accept`** — campo de aceitação executável no schema, executado pós-merge pelo `accept-gate.ts`.
- **`WorkStep.writes`** — write-set declarativo com disjunção intra-onda validada estaticamente e em runtime.
- **`Pipeline.mergeGate`** — comando de verificação pós-merge com reset `HEAD~1` no único rewind defensável do sistema.
- **`.changes/` + `scripts/changelog.ts`** — fragmentos por card, consolidados pós-merge, matando o conflito garantido do CHANGELOG.
- **`tsconfig.client.json`** — cliente web (`src/web/client/*.js`, 12 módulos) agora entra no typecheck com `checkJs`.
- **`.github/workflows/gate.yml`** — CI mínima rodando `scripts/gate.sh` no push/PR.
- **`.github/workflows/huu-dogfood.yml`** — auditorias `huu Docs` + `huu Quality` em schedule semanal.
- **`scripts/selfcheck/`** — autoteste adversarial com 16 mutações calculadas, uma por verificador.
- **4 invariantes pinados** — `maxNodeExecutions`, ordem de merge, `default: true` único, never-rewind — todos deletáveis em silêncio antes.
- **`docs/adr/`** — 3 ADRs com guarda executável.
- **`.agents/ledger/`** — 4 itens de incerteza, validador verde desde o dia 1.
- **`scripts/check-metodo.ts`** — estado derivado do repositório, falha se prosa discorda.
- **`scripts/check-twins.ts`** — paridade estrutural de READMEs, docs e `card-state` gêmeos.
- **`scripts/check-test-count.ts`** — piso de contagem de testes, mata o `-t ZzNaoExiste` saindo 0.
- **`scripts/validate-ledger.ts`** — validador de ledger com lista negra de evidências vazias.
- **`scripts/pin.ts` + `scripts/check-pins.ts`** — citações conteúdo-endereçadas `arquivo:linha@sha1`.
- **`scripts/untested.ts`** — lista maiores arquivos `src/` sem teste irmão.
- **`.github/PULL_REQUEST_TEMPLATE.md`** — checklist com "se isto desaparecer, o que fica vermelho?".

### Changed

- **Contrato report-only das 5 auditorias** — `git status --porcelain` → `git diff --name-only $baseCommit..HEAD` com cláusula fail-closed.
- **`Orchestrator.start()` agora valida o próprio grafo** — `validateTopology` chamada antes do switch de modo.
- **Propagação de falha** — step com zero trabalho produzido não mente `done`; `ready.length === 0` com pending não-vazio é erro.
- **Wave scheduler** — CheckStep não preempta work steps que vêm antes no array.
- **Dev mode** — write-set partition enforçada, `verifyCommands` ligado, `alreadyUpToDate` não conta como landed, `goalComplete` recusado na época 1.
- **Manifesto com flush incremental** — manifesto escrito em disco a cada merge de etapa, não só no `finally`.
- **`AGENTS.md`** — 540 → 135 linhas (roteador, não duplicata de skills).
- **`src/web/client/app.js`** — 3723 → 97 linhas, extraído em 7 módulos por tela.
- **`src/orchestrator/index.ts`** — extraídos 5 módulos: `guard-pause.ts`, `review-loop.ts`, `wave-driver.ts`, `finalize.ts`, `context.ts`.
- **`src/lib/types.ts`** — 1235 → 83 linhas, quebrado em 4 barrels por domínio.
- **`vitest.config.ts`** — `.huu-worktrees/` e `webui/` no exclude, JSON reporter para piso de contagem.
- **`scripts/deploy.ts`** — smoke suite antes do push.

### Fixed

- **Governança da biblioteca de skills** — `copilot` purgado de 5 arquivos, auto-promoção removida do template, `running-in-docker` reescrito (3 ramos, não 7), `[superseded]` no lugar de prosa.
- **`validate-skills.sh`** ligado ao `npm test` com checks de vocabulário, TTL de frescor e nomes de backend.
- **Sonda negativa dos juízes** — 6 testes provam que condições de juiz conseguem dizer `rework`.
- **Importações cruzadas do cliente web** — corrigidas após split do `app.js`.
- **`pre-push` hook** — agora chama `scripts/gate.sh`.

## Trabalho não lançado entre a 5.2.0 e a 5.3.0 — modo de desenvolvimento

> *Este bloco era um SEGUNDO `## [Unreleased]`, abaixo de `[5.3.0]` — um
> changelog malformado, com dois "não lançados" ao mesmo tempo. Ele nunca
> recebeu número de versão nem tag: é o trabalho que introduziu o modo de
> desenvolvimento e ficou parado entre a 5.2.0 (última no npm) e a `[5.3.0]`
> (escrita, nunca publicada). Nada foi apagado nem reordenado — só o título
> mudou, para dizer o que este bloco de fato é. Todo o conteúdo daqui sai para
> o público na 6.0.0.*

### Added

- **Modo de desenvolvimento (`huu dev "<objetivo>"` e a rota web `/dev`).** O
  primeiro fluxo do huu cujo **grafo de passos é escrito em tempo de
  execução**: você escreve o objetivo, um planejador o decompõe em **frentes**
  paralelas, e cada frente vira `recon → enxame de worktrees (scope memory) →
  juiz`. O plano é compilado num pipeline `huu-pipeline-v2` comum com arestas
  `dependsOn`, então o escalonador de ondas, o fan-out de memória, o
  roteamento de juízes e o merge determinístico por estágio rodam **sem
  nenhuma mudança**. Frentes independentes ficam prontas na mesma onda e
  dividem um único pool de workers.
  - **Fase 0 — portão de knowledge.** Antes de qualquer desenvolvimento o huu
    sonda o repositório (`src/lib/knowledge-detect.ts`: `catalog.md`, skill
    roteadora por frontmatter `type: router` ou pelos nomes convencionais,
    com fallback para `.claude/skills/`). Ausente ⇒ roda o pipeline embutido
    `huu Knowledge System` em modo **MAX** (`greedy`) — o máximo de swarm que
    a máquina admite — e aterrissa o resultado antes da primeira época.
  - **Autonomia é escolha sua:** `--autonomous` (padrão) ou `--approve-each`,
    que mostra o plano de cada época e espera confirmação (na web, um portão
    de aprovação que sobrevive a um refresh).
  - **Quadro-negro versionado** em `.huu/dev/`: `goal.md` (verbatim, nenhum
    agente reescreve), `state.json` (`huu-devstate-v1`), `journal.md` e um
    `epoch-<N>/` por época com atlas, findings, relatório e **uma spec
    markdown por tarefa** — specs são arquivos reais porque
    `resolveMemoryFiles` derruba caminhos inexistentes, e de quebra o plano
    fica auditável no git.
  - **Aterrissagem entre épocas.** Um run deixa o trabalho em
    `huu/<runId>/integration` e remove o worktree de integração — então a
    época N+1 não veria nada. O huu passou a fazer `merge --no-ff` desse
    branch no seu branch de trabalho entre épocas, recusando na largada se
    houver trabalho não commitado que não seja dele, e commitando o que ele
    mesmo escreve (incluindo o `.gitignore` que `Orchestrator.start()`
    ajusta) antes de cada merge.
  - **Switch de modo na web.** Um controle no topo com as duas formas de
    começar trabalho lado a lado: **Pipelines** (você já tem o método) e
    **Development** (você tem um objetivo). Cada metade é uma rota de verdade
    (`/` e `/dev`) — favoritável, copiável, abre em nova aba — mas um clique
    simples troca a view NO LUGAR com `pushState` em vez de recarregar, o que
    dropparia o stream SSE, o quadro de runs e a fila meio montada. O switch
    some no quadro de um run (seria uma forma silenciosa de sair de uma
    execução ao vivo), e a metade Development ganha um ponto pulsante enquanto
    uma sessão roda — âmbar quando um plano está travado esperando aprovação.
    Os links carregam o `?token=` quando `HUU_WEB_TOKEN` está configurado (um
    `href` cru levaria a uma tela cujas chamadas de API dariam 401), e o banner
    do `huu` passou a imprimir a URL `/dev` no boot.
  - Junto veio uma correção de layout: `.stage` virou coluna flex com
    `min-height: 0` nas views — sem isso, uma barra acima de views com
    `height: 100%` empurrava o rodapé para fora do `overflow: hidden` do
    `.stage`, cortando conteúdo inalcançável.
  - **Formulário redesenhado.** O objetivo virou o campo central, com **ditado
    por microfone**: o navegador grava, re-codifica em WAV mono 16 kHz (a
    OpenRouter aceita wav/mp3/ogg/… e **rejeita** o webm que o `MediaRecorder`
    produz por default) e `POST /api/dev/transcribe` transcreve com
    `google/gemini-3.1-flash-lite` — a variante do 3.1-flash que aceita áudio;
    `google/gemini-3.1-flash` não existe com modalidade de áudio. Override por
    `HUU_TRANSCRIBE_MODEL`; a transcrição é ANEXADA ao que já estiver escrito.
    A pasta do projeto deixou de ser um input de texto e virou **o mesmo
    navegador de arquivos do fluxo de pipelines**, de seleção única (uma sessão
    aterrissa num repo só), com badge de git repo e pré-seleção. As frentes
    paralelas viraram um segmented **Auto | Manual** espelhando o controle de
    concorrência dos pipelines. Layout centralizado.
  - **Sem teto de épocas na web.** Uma sessão roda até o planejador reportar o
    objetivo concluído ou você abortar — `DevModeConfig.maxEpochs` indefinido
    agora significa ILIMITADO, com um backstop interno de segurança
    (`DEV_UNBOUNDED_EPOCH_BACKSTOP`) que não é um limite de produto, é o que
    separa uma sessão desacompanhada de um loop infinito. O CLI mantém o
    `--epochs` padrão 3: um run headless pode estar desacompanhado e não tem
    botão de Abort.
  - Docs: [`docs/dev-mode.pt-BR.md`](docs/dev-mode.pt-BR.md) ·
    [EN](docs/dev-mode.md).

- **The TUI runs N PROJECTS, not N pipelines in one repo.** `P` on the Welcome
  screen opens the folder browser in **multi-mark** mode (`SPACE` marks,
  `A` marks every sub-folder of the current listing, `H` jumps to the workspace
  root, `C` clears, `G` goes) — marks persist while you navigate, so a whole
  workspace is collected in one pass. Pick one or more pipelines, and every
  `(pipeline, project)` pair becomes its own run **with its own repo root**. A new
  **run-queue review** screen shows the fan-out grouped by pipeline before
  anything starts: `SPACE` skips/includes a row (a toggle — nothing is deleted),
  `A` skip-all/include-all, `ENTER` runs. Folders without a `.git` are flagged up
  front instead of failing preflight later. The picker opens at `HUU_WORKSPACE`
  (default the host `$HOME`, which the Docker wrapper bind-mounts) and warns when
  you browse outside it, because nothing out there is visible to a run.
- **A machine-global budget chip on the multi-run dashboard**, fed by
  `GlobalScheduler.budgetTelemetry()`: `dial N%` · `agents live/B` (reserved
  judge/merge agents included) · `RAM %` · host free · `N queued` ·
  `host-limited` · the pressure reason. Cross-run agent-exit announcements
  (`onAnnounce`) now reach the TUI log instead of being dropped, so backfill is
  visible. Tabs are labelled `<pipeline> → <folder>`.
- **Interactive retry on the multi-run dashboard.** Per-card focus
  (`↑↓←→`), the detail modal (`ENTER`) and the `R`/`D` retry/finish pair now work
  per run there, not only on the single-run board — a failed task in the 6th of 8
  projects is exactly the case worth recovering by hand.
- **A batch summary when a multi-run finishes.** Previously a run of 8 projects
  ended by dropping straight back to the editor with no aggregate at all. Now:
  per-run status, commits, files, conflicts and cost, plus the batch total. `B`
  returns to the live boards, `S` brings the summary back.
- **The RAM budget dial is editable from the TUI** — row 0 of Options
  (`O`), persisted to `~/.config/huu/web-settings.json`, the same store the web's
  ⚙ Settings panel writes, because one machine has one RAM.
- **Live run cost in the TUI header.** `OrchestratorState.totalCost` was already
  summed on every emission and simply never rendered outside the web.

- **Modo de desenvolvimento v2 — orquestrador cego e enxame revisado.** O dev
  mode foi reescrito. Uma época deixou de ser **um** run e passou a ser
  **dois**, porque o plano só pode existir depois que o conhecimento chega:
  - **Fase A — conhecimento** (run #1, um pipeline FIXO que nenhum modelo toca):
    o orquestrador declara `KnowledgeRequest {restatedGoal, gaps[],
    planningNotes}`; o huu materializa **uma spec markdown real por lacuna** +
    um índice `huu-memory-v1` e os **commita antes do run**; um fan-out
    responde uma lacuna por agente (`repo` / `convention` / `external`) e uma
    consolidação escreve `knowledge/digest.md` (≤ 6000 chars). Lacunas
    ZERO ⇒ a Fase A é pulada e a época volta a ser um run só.
  - **Fase B — plano** (sem run) e **Fase C — execução** (run #2), com o grafo
    compilado persistido como `epoch-N/pipeline.json`: artefato portátil,
    reeditável e auditável, em vez de descartado.
  - **O orquestrador é cego.** Ele não lê arquivo, não tem ferramenta e
    **não recebe mais o digest truncado do repositório**: a única coisa que
    aprende sobre o repo é o `digest.md`, que AGENTES escreveram com citação de
    path. Nos docs isso é enquadrado como o líder **delegando** retrieval, não
    pulando retrieval — e como **hipótese instrumentada**, não boa prática
    comprovada. A divisão de modelos nunca é vendida como economia: um fan-out
    custa 3–10× os tokens de um agente único e a diferença de preço é ~2×; a
    justificativa é isolamento de contexto e paralelismo.
  - **`WorkStep.review` — loop gerador→crítico por tarefa**, e é **schema
    público**, não um detalhe do dev mode: qualquer pipeline pode declarar. Cada
    tarefa é auditada por um revisor separado **na worktree do próprio worker**,
    antes de o branch entrar no merge do estágio; achados bloqueantes voltam ao
    MESMO agente, na mesma sessão. A convergência é **mecânica e por
    severidade** (`blockOn`, default `blocker`+`major`) — o `verdict` que o
    crítico escreve é logado e **não decide**. E **toda falha é forward-default:
    o trabalho mergeia** (crítico que estoura, não responde ou não produz JSON
    parseável ⇒ `unavailable` ⇒ zero bloqueio; cap de rodadas com bloqueio
    aberto ⇒ *waive* com os achados registrados). Errar o card faria
    `runStageIntegration` excluí-lo e transformar "90% certo com um achado
    major" em nada. Ver
    [`docs/pipeline-json-guide.md`](docs/pipeline-json-guide.md#per-task-review-review).
  - **Roteamento de modelo por papel** (`planner` · `recon` · `worker` ·
    `critic` · `reporter` · `judge` · `integration`) com presets `hetero`
    (default do preset, crítico **cross-family**), `thrifty`, `monoculture` e
    `uniform`. Papel não setado **omite** `modelId` no step, então uma sessão
    sem roteamento compila o pipeline de sempre. Um **preflight de registry**
    roda nas bordas e recusa um id desconhecido nomeando papel, id e ids
    próximos — antes era um throw dentro do primeiro agente, com worktree e
    branch já criados. O papel `planner` é deliberadamente **não** checado: ele
    roda pelo cliente de saída estruturada (LangChain → OpenRouter), não pelo
    registry do pi, que é justamente por que `z-ai/glm-5.2` funciona ali e em
    lugar nenhum mais.
  - **Resume e branches órfãos.** `readDevState` volta a ser usado: uma sessão
    com o MESMO objetivo e não concluída pode ser retomada (mesmo `sessionId`,
    numeração de época continuada, histórico e evidência já alimentando o
    replano); `--resume`/`--no-resume` no CLI, um portão na web. Branches
    `huu/*/integration` que o HEAD nunca absorveu são detectados e oferecidos
    para aterrissar (`--land-orphans`) — trabalho realmente perdido que o
    `git status` não mostra. Sem callback: avisa e segue; nunca bloqueia.
  - **Replanejamento com evidência estruturada** (`DevEpochEvidence`:
    `diffStat` capado, veredictos, achados *waived*, contagem de tarefas,
    aterrissagem) e `costUsd` por época somando **os dois runs**. Nas épocas ≥ 2
    o huu injeta uma lacuna `DELIVERED_VS_PLANNED` — quem compara prometido ×
    entregue é um agente que lê o diff, não o planejador cego.
  - **Instrumentação** para medir o que ninguém publicou: violação de write-set
    (arquivos commitados fora do que a spec da tarefa declara possuir — puro
    registro, nada é bloqueado), bloqueio provado × não-provado
    (`reviewStats`), rodadas até convergir e taxa de *waive*.
  - **Pool de chaves com rotação** (`_pools` no config store, aditivo e
    espelhado em `keys[0]` para um huu antigo continuar achando chave),
    rotação **por tentativa** com classificação de erro de provider, burn de
    auth *duplo-gated* por sonda, e cinco endpoints `⚙` na web que devolvem só
    valor mascarado + estado.
  - Docs: [`docs/dev-mode.pt-BR.md`](docs/dev-mode.pt-BR.md) ·
    [EN](docs/dev-mode.md) — incluindo a seção que diz, sem enfeite, o que
    **piora**: o merge passa a ser guardado por um crítico por tarefa cujo
    critério é texto que outro LLM escreveu.

### Fixed

- **Conflito programado por design no `findings.json` do dev mode.** Todo
  agente do enxame era obrigado a anexar ao MESMO arquivo. Uma wave de fan-out
  tem N agentes fazendo isso, todos commitam, e o merge do estágio é
  sequencial — então toda branch depois da primeira conflitava e a wave inteira
  caía no resolvedor LLM. Agora a memória compartilhada é um arquivo POR
  ESCRITOR (`.huu/dev/epoch-N/findings/<escritor>.json`): leitura é comum
  (varre o diretório), escrita é exclusiva. Nomes distintos mergeiam sem
  conflito; a consolidação e o portão passaram a ler todos os shards.
- **O resolvedor de conflito não tinha timeout.** Era a única chamada de agente
  do run sem teto de wall-clock: um resolvedor travado parava o estágio — e
  portanto o run inteiro — para sempre, sem card para retentar e sem erro para
  reportar. `withTimeout`/`TimeoutError` saíram de dentro do `orchestrator` para
  `src/lib/with-timeout.ts` e agora envolvem também o resolvedor
  (`DEFAULT_RESOLVER_TIMEOUT_MS` = 15 min, `HUU_RESOLVER_TIMEOUT_MS` para
  ajustar). No estouro o resolvedor é abortado e a verificação determinística
  que já existia decide o estágio, em vez de o run pendurar.
- **`commitBlackboard` levava o índice INTEIRO do usuário junto.** Uma sessão
  de dev que roda por horas enquanto o usuário stageia o próprio trabalho em
  outro terminal varria esse trabalho para dentro de um commit
  `chore(huu-dev)` — com `--no-verify`, ou seja, passando por cima dos
  pre-commit hooks — e depois o aterrissava no branch dele atribuído ao huu.
  `GitClient.commitNoVerify` ganhou pathspec opcional e tanto a detecção
  (`diff --cached`) quanto o commit passaram a ser path-scoped aos arquivos que
  o huu de fato possui.
- **Abort do modo de desenvolvimento não abortava.** Um run abortado resolve
  como `done` (o orchestrator força o status terminal), então o driver
  **aterrissava a época pela metade e começava a próxima** enquanto a UI dizia
  "abortada"; na web era pior, porque o flag de abort só era lido dentro do
  portão de aprovação — caminho que o modo autônomo nunca percorre —, de modo
  que abortar uma sessão autônoma não fazia nada. Agora um `AbortSignal`
  atravessa o driver e é checado em todo limite (bootstrap, topo do loop,
  pós-planejamento, portão, pré-aterrissagem), corta o run vivo, e a
  interrupção é rastreada localmente porque o manifest nunca poderia contá-la.
  **Época abortada NÃO aterrissa** — o trabalho é parcial e nenhum juiz o viu;
  ele fica no branch de integração e a mensagem de erro nomeia o branch com o
  comando de merge manual. O stop reason `aborted`, declarado e nunca
  produzido, passou a existir.
- **O cap de frentes era decorativo.** `--fronts` / `maxFronts` só chegava ao
  PROMPT do planejador: um modelo que devolvesse mais frentes do que o pedido
  ficava com todas. `compileEpochPipeline` passou a receber e impor o cap — é
  o que faz o novo controle Manual significar alguma coisa.
- **`GitClient.getChangedFiles` truncava o primeiro arquivo da lista.** O
  código dava `stdout.trim()` antes do split, o que come o espaço à esquerda
  **só da primeira linha** de um status porcelain — e o `slice(3)` fixo então
  comia o primeiro caractere do caminho (`alpha.txt` → `lpha.txt`). Como o
  status de uma modificação NÃO STAGED é justamente `" M "`, o caso comum
  batia sempre: o `AgentStatus.filesModified` de todo card (kanban + manifest)
  reportava o primeiro arquivo com uma letra a menos. Agora o split é feito no
  stdout cru, com trim por linha (`src/git/git-client.test.ts` fixa a
  regressão).

- **The TUI no longer starts every selected run at once.** `MultiRunDashboard`
  called `orch.start()` for all N runs in one loop with no `AdmissionController`
  — the exact blind admission that caused the OOM incident in `ROADMAP.md`, and
  the last front-end still doing it after the web and `run-many` were fixed in
  Fase 1. All three now share one implementation, the new
  `src/orchestrator/multi-run-driver.ts`: the top-priority run starts
  immediately, later runs sit in a **`queued`** phase (owning no Orchestrator and
  costing no budget) until the machine shows sustained headroom **and** room for
  the next run's fixed baseline. The admission rule itself is one shared function
  (`computeAdmissionContext`), so the web and the TUI cannot drift — before this,
  `run-many` admitted on a weaker rule than the web's.
- **A RAM dial saved from ⚙ Settings was silently ignored outside the browser.**
  `GlobalScheduler` and `Orchestrator` resolved their budget with bare
  `resolveRamPercent()`, which reads only the env var and the default; the web
  re-applied the persisted value with `setBudgetPercent` right after constructing
  its scheduler, and nothing else did. The dial is now layered by
  `effectiveRamPercent()` (explicit → persisted store → `HUU_RAM_PERCENT` →
  default) and resolved at the front-end edge, which also covers the single-run
  TUI path — the most-used one, and the one that never creates a scheduler at all.
- **A CLI-locked backend is no longer overwritten in a batch.** `--stub` /
  `--backend=` / `--provider=` set the backend, but the saved-pipelines batch
  flows walked into the provider picker anyway, whose own selection then replaced
  it — so `huu --cli --stub` with 2+ pipelines silently became a real provider
  run. They now skip that screen exactly as the editor path always has.
- `--ram-percent`'s help text still advertised the pre-5.0 default of 85 (it is
  70) and did not mention the range or the saved dial.

### Changed

- Arrow keys on the multi-run dashboard now move **card focus** (Tab and `1`-`9`
  switch runs). They previously switched runs, which a board with focusable cards
  cannot afford.
- Kanban focus navigation moved out of `RunDashboard` into the shared pure
  `src/lib/card-focus.ts`, so both dashboards group columns through
  `agentCardState` and cannot drift from the board.
- **QUEBRA — o quadro-negro do dev mode passou a ser namespaced por sessão.**
  O que era `.huu/dev/epoch-N/…` agora é `.huu/dev/<sessionId>/epoch-N/…`; só
  `goal.md`, `state.json` e `journal.md` continuam na raiz `.huu/dev/`. Árvores
  `.huu/dev/epoch-N/` de sessões antigas **ficam inertes** — nada as lê, nada as
  apaga, e o `journal.md` preserva o histórico. Não é arrumação: o fan-out
  resolve `filesFrom` a partir da worktree de INTEGRAÇÃO, que ramifica do seu
  checkout, e depois de uma sessão anterior ter aterrissado esse checkout
  contém um `epoch-1/<frontId>/tasks.json` **commitado**. `resolveMemoryFiles`
  não faz checagem de validade nenhuma, só `existsSync`, e ids de frente são
  semânticos (`api`, `cli`, `tests`) — então uma sessão nova cujo recon
  falhasse dispararia o **enxame da sessão anterior**, em silêncio. Um segmento
  de path torna a colisão impossível em vez de improvável.
- **QUEBRA — `DEV_STATE_FORMAT` foi para `huu-devstate-v2`.** `readDevState` já
  devolvia `null` para um `_format` diferente, então um `state.json` v1
  **degrada para "sem resume"** e a sessão começa do zero: não há código de
  migração e não haverá. O arquivo não é apagado nem reescrito enquanto a nova
  sessão não persistir por cima; o único efeito é que a oferta de retomada não
  aparece para estado escrito por uma versão anterior.

## [5.2.0] - 2026-07-04

### Changed

- **The kanban stops lying: green DONE now means MERGED.** A task card only
  turns green after its branch actually lands in the integration worktree
  (per-branch, ascending — a visible ripple during the stage merge). Until
  then a finished task shows as a teal/blue **READY** card in DOING; if the
  integration fails (or the run ends) with its branch never landing, it shows
  as an amber **UNMERGED** card instead of a false green — the committed work
  is still on the agent branch (`branchesPending`), it just never merged.
  **PAUSED cards moved from the DONE column to TODO**: a memory-guard pause
  literally re-queues the task (like the kill-requeue `↻N` path), so during
  memory pressure the DONE column no longer fills with cards that aren't
  done. The mapping is one shared pure module (`src/lib/card-state.ts` + web
  mirror `src/web/client/card-state.js`, pinned by twin table tests; TUI
  arrow-key navigation now uses the same mapping and can't drift from the
  board). Backward compatible: manifests/archives that predate the
  `merged`/`mergeFailed` flags render exactly as before. Note the DONE-column
  count semantics changed — finished-awaiting-merge cards sit in DOING until
  the merge lands them.

### Fixed

- **`npm start` / `npm run dev` can no longer run stale code.** huu is
  docker-only: the wrapper always ran the fresh source, but the actual run
  executed whatever the last manual `docker build` baked into `huu:local` —
  fixes kept "not working" until someone remembered to rebuild. Both scripts
  now refresh the image first (`scripts/ensure-image.sh`: layer-cached, ~2 s
  when nothing changed; `--network=host` on Linux for systemd-resolved DNS;
  an explicit `HUU_IMAGE=<other>` skips the rebuild as a deliberate pin;
  missing Docker warns and continues so native-only subcommands keep
  working; a FAILED build aborts the start).
- **Guard preemptions now say WHY (the 8-project storm post-mortem).** A
  pause at "RAM 9%" read as insanity because the message only showed the
  CONTAINER's RAM% while the trigger was a host-side ladder verdict (PSI
  full, sustained swap-in, availability floors). Pause/kill log lines now
  carry the exact pressure-ladder reason — `paused by memory guard — avail
  0.4% + swap free 0.0% below emergency floor (container RAM 98%)` — through
  both the single-run pool guard and the cross-run scheduler guard, and the
  line is published to the UI immediately instead of lagging one snapshot.
- **The pause↔resume thundering herd is damped.** In the incident, the
  instant pressure dipped every paused run resumed AT ONCE, pressure
  re-spiked within ~15 s and the guard drained the pool again — each cycle
  re-paying the in-flight LLM turn and killing npm installs mid-write. Two
  changes: (1) a **post-storm calm hold** — after any L2/L3 verdict, spawn
  admission (and new-run admission) stays frozen for
  `HUU_GUARD_REOPEN_CALM_MS` (default 10 s, `0` disables) past the last
  high-pressure reading, in both the pool and the GlobalScheduler; (2) the
  resume backoff gained **deterministic up-only jitter** (window ×[1, 1.5),
  keyed by `runId#agentId#pauses`) so tasks paused in the same second stop
  expiring in the same second — applied after the cap, else long-backing-off
  tasks would re-synchronize at the cap.
- **`MaxListenersExceededWarning` storm silenced.** The pi SDK adds one
  abort listener per tool call to its session `AbortSignal`; any session
  with >32 tool calls tripped the warning repeatedly, and the process-log
  bridge fanned every emission to EVERY attached run log (×8 with 8
  projects). The bridge now dedupes repeated emissions by signature (60 s
  window, `repeated N×` suffix on the next pass), and the bootstrap raises
  the EventTarget/EventEmitter default listener cap via
  `events.setMaxListeners` (`HUU_MAX_EVENT_LISTENERS`, default 256, `0`
  keeps Node's defaults) — the old `EventEmitter.defaultMaxListeners = 32`
  never governed `AbortSignal`, which is an EventTarget.

### Added

- **Pause/resume semantics are now pinned by regression tests, plus an
  anti-churn resume backoff.** The Fase 2.3 guarantees that matter for never
  losing work — "pre-pause uncommitted work survives into the merged HEAD"
  and "the resume continues instead of redoing the fresh path" — were only
  validated by a manual spike; a resume-aware stub factory now proves them
  end-to-end against real git (plus repeated pause→resume→pause with
  latest-checkpoint-wins, and the pi session-plan decision extracted as the
  pure `resolvePiSessionPlan` with its sibling-dir/degrade-to-fresh
  invariants). New: a paused task backs off exponentially before resuming
  (`min(10s × 2^(pauses−1), 120s)`, `HUU_PAUSE_BACKOFF_MS`, `0` disables) so
  sustained pressure can't thrash-cycle pause↔resume re-paying the in-flight
  LLM turn each time; tasks queued behind a backing-off resume run meanwhile,
  and kill-requeues/user retries are never delayed. Deliberately NO cap on
  pauses — a kill-after-N would discard preserved work a full machine
  couldn't progress anyway. (Crash persistence of paused state remains
  ROADMAP §2.4.)
- **Host-aware RAM accounting — huu now yields to the rest of your machine.**
  The container cgroup cannot see other host processes (browser, IDE), so a
  run could push the HOST into swap/global-OOM while huu's own numbers looked
  healthy. The sampler now also reads the host `/proc/meminfo` pair
  (`hostMemTotalBytes`/`hostMemAvailableBytes` — /proc is not namespaced) and
  every admission decision plans with
  `min(budget headroom, host available − OS reserve)` (asymmetric smoothing:
  a host-avail drop binds instantly, recovery is damped). The pressure
  ladder's earlyoom conditions use the tighter of container/host availability,
  and a new L2 trigger fires when the container spills into its own
  `--memory-swap` allowance (cgroup v2 `memory.swap.current/max` — the
  container-scoped swap plateau the host pair cannot see;
  `HUU_GUARD_CONTAINER_SWAP_PCT`, default 50). Escape hatch:
  `HUU_NO_HOST_CLAMP=1` for dedicated hosts. The dial remains the upper
  bound; host availability is the live bound — throttling while the host is
  busy is the intended behavior.
- **Honest RAM numbers in every surface — machine-wide, in the HEADLINE.**
  The displayed used/total pair was huu's own consumption vs huu's container
  ceiling (cgroup scope, blind to every other app), so the app always read
  "emptier" than the computer actually was. The web budget chip now shows
  BOTH pairs with equal prominence (`huu 1.2/14.0G · host 10.2/16.0G`), the
  TUI metrics bar shows a second color-coded `host N% (used/total GB)`
  segment, the run dashboards append `host free N MB`, and everything flags
  `host-limited` while the host-availability clamp is the binding factor. A
  one-time toast (plus serve-terminal + run-log warnings) fires when the
  container has NO kernel ceiling (rootless Docker without memcg /
  `HUU_NO_MEM_LIMIT=1` — the exact config of the multi-run OOM incident), and
  `huu status` gains a `host:` line (what huu may claim right now) plus a
  `docker:` preview of the `--memory` ceiling and the in-container budget it
  yields.
- **The web stays live without a manual refresh — SSE liveness watchdog + a
  refresh-proof queue.** The browser now runs a real `event: ping` heartbeat
  and a 60 s staleness detector that force-reconnects a zombie SSE stream and
  resyncs the board on its own — a run that looked frozen self-heals instead
  of needing an F5. Server-side, the SSE endpoint got a real ping event and
  SSE-safe HTTP timeouts, and zombie-connection handling was hardened. And the
  project queue persists each run's status + `runId` (`huu-queue-v2`), so a
  mid-queue browser reload RE-LINKS to the still-live runs in the huu process
  instead of resetting them to pending. The run-log rebuild is also coalesced
  to one trailing render per 100 ms so a high-frequency agent firehose no
  longer thrashes the activity console.
- **Machine-wide agent accounting you can actually read.** In true multi-run,
  every agent exit (completion, final-fail, guard kill/pause, reserved
  judge/merge) now prints one operator line through the serve terminal —
  `agent 3 (run X) completed — global live 7 (1 judge/merge), B 12,
  remaining 2` — and the web budget chip shows the same machine-wide
  `agents live/B` counter summing every project. Slot release is event-pushed
  on top of the 500 ms tick: each exit debounces into one pure re-grant
  (`notifyAgentLifecycle`), and a grant that RISES nudges the beneficiary
  run's sleeping pool awake (`wakeup`) instead of waiting for the next tick.
- **Reserved judge / integration agents now count in the global RAM budget.**
  The reserved judge (`9998`) and integration (`9999`) agents were invisible
  to the budget while they ran; they are now folded into demand/busy so the
  machine read is honest — but they are NEVER preemption victims and their
  spawn path keeps zero gates, so a frozen budget can't deadlock a stage.
- **One-click “☑ Mark all” in the project folder picker.** Marks every
  sub-folder of the current directory at once instead of clicking each, so
  fanning one pipeline across a whole workspace of repos is a single action;
  marks still persist as you navigate.

### Fixed

- **Double OS reserve at high RAM dials (≥86%).** The host wrapper already
  subtracts the adaptive OS reserve when sizing the container's `--memory`;
  `ramBudgetBytes` then re-subtracted it inside the container, silently
  capping high dials below what the user asked for. When the total IS a
  cgroup limit the budget now uses the full ceiling (the host stays protected
  by the new live host-availability clamp).

- **OpenRouter key managed from the web ⚙ Settings — validated, persisted,
  effective immediately.** A new "OpenRouter API key" panel in the ⚙ Settings
  modal shows which key is active and where it came from (Options · env · host
  secret — always masked), validates a pasted key against OpenRouter **before**
  accepting it (a rejected key is never saved), persists it to the host config
  store AND arms a live in-session override so **every new run uses it at
  once** (inside Docker the startup secret-mount snapshot would otherwise keep
  winning until restart), and offers **clear saved key** to fall back to
  `OPENROUTER_API_KEY`. New endpoints: `GET /api/keys/status`,
  `DELETE /api/keys`; `POST /api/keys` now also arms the live override. The
  401 preflight hint names the source that actually supplied the rejected key
  (`AppConfig.apiKeySource`) instead of re-running the resolver and blaming
  the wrong one.
- **The serve terminal narrates runs.** The terminal that launched huu now
  logs every meaningful event (`src/web/terminal-log.ts`): run
  queued/started/finished/failed with duration + cost, the per-agent/merge/
  judge activity log per project (`OrchestratorOptions.onLog` tee), which
  masked key each run uses (and when an env var is being ignored), key
  validation/save/clear outcomes, settings changes and refused runs — before,
  the terminal got a startup banner and then silence. `HUU_WEB_LOG_STREAM=1`
  additionally mirrors the raw agent-output firehose.

### Fixed

- **Keys/settings saved inside Docker now survive the container.** The host
  wrapper bind-mounts the host `~/.config/huu` (RW) and exports
  `HUU_CONFIG_DIR`; `configFilePath()`/`webSettingsPath()` prefer it, so
  `config.json`/`web-settings.json` written in-container land on the host.
  Previously they went to the container's ephemeral `/tmp/.config` and were
  wiped on exit — updating or clearing a stale saved key from Options was
  impossible under docker-only huu, the exact trap behind "valid env key set,
  every run still 401s".
- **Run-start failures are no longer silent in the browser.** A refused
  `POST /api/run` and a run that dies early (e.g. key rejected in preflight)
  both raise a toast; before, only a queue chip changed color and a run could
  fail with no visible feedback anywhere.

## [5.1.0] - 2026-07-02

### Added

- **Folder picker reaches the whole workspace.** Now that huu is docker-only,
  the web folder picker could only browse what was mounted into the container
  (`~/.huu`, `~/Downloads`). The wrapper now bind-mounts a **workspace root**
  (RW, at the same absolute path) — `HUU_WORKSPACE`, default `$HOME` — so the
  picker opens there and can mark/run any project under it. A **⌂ Home**
  button jumps to the root; `/api/bootstrap` exposes it and a bare
  `/api/folders` opens there. Tighten the blast radius with
  `HUU_WORKSPACE=~/Projects`, or widen it to `/` for the entire filesystem.
  Security note: the workspace is mounted read-write, so an agent's shell can
  reach anything under it (including `~/.ssh` when it's `$HOME`) — keep it as
  small as your projects allow.

## [5.0.0] - 2026-07-02

### Added

- **The RAM dial is now a contract, enforced at every layer** (born from the
  33-concurrent-runs incident that froze a 32 GiB host at both 85% and 50%):
  - **Pressure ladder** (`src/orchestrator/pressure-ladder.ts`): the memory
    guard's single RAM/CPU ≥ 95% trigger — which a swapping host never crosses
    (it thrash-freezes first) — is replaced by graded levels: **L1** usage
    sustained over the budget dial → spawn freeze + shed newest agents until
    back under (never below one live agent: degrade to sequential, not zero);
    **L2** host pressure (earlyoom-style available-RAM + free-swap floors, PSI
    `full avg10` ≥ 5%, sustained swap-in, or the legacy 95% line) → shed every
    tick with the guard tick accelerated 500 ms → 150 ms, queued-run admission
    frozen; **L3** emergency floors / PSI full ≥ 20%. All thresholds have
    `HUU_GUARD_*` env knobs.
  - **Reservation accounting**: admission charges in-flight spawns (full
    footprint) and young agents (half) against the budget, closing the 1–2 s
    stale-metrics window in which N runs could over-admit in a burst. The
    footprint EMA samples only MATURE cohorts (young agents looked cheap and
    dragged the estimate down — the over-admission spiral) with asymmetric
    smoothing (tracks up fast, down slowly); its clamp rose 2048 → 4096 MiB.
  - **Swap/PSI-full awareness**: the sampler now reads SwapTotal/SwapFree, PSI
    `full avg10` (the canonical thrash signal) and the `/proc/vmstat` swap-in
    rate, and polls at 250 ms (instead of 1 s) near the budget edge.
- **Kernel memory ceilings** (ROADMAP Fase 2.1 delivered): on native Linux huu
  re-execs itself into a transient **systemd user scope** with `MemoryHigh` =
  total − OS reserve (the kernel throttles huu's whole tree before the host
  thrashes; the desktop stays alive), `MemoryMax` = total − reserve/2 (worst
  case: huu dies inside its scope, never the host), `MemorySwapMax`
  (`HUU_SWAP_MAX_MB`, default 4 GiB) and `TasksMax`. Degrades to unwrapped with
  a one-line note when systemd isn't usable; `HUU_NO_CGROUP=1` opts out. The
  Docker wrapper applies the same ceiling to the container (`--memory`,
  `--memory-swap`, `--pids-limit`; `HUU_DOCKER_MEMORY_MB` / `HUU_NO_MEM_LIMIT`
  overrides) — an unlimited container could consume 100% of host RAM.
- **OOM victim shaping for tool subprocesses**: a 2 s `/proc` sweep raises
  agent tool children (vitest workers, npm installs, builds) to
  `oom_score_adj +500` (`HUU_CHILD_OOM_SCORE_ADJ`), so a kernel OOM kills a
  test runner — surfacing as a task retry — instead of the orchestrator or the
  user's session. They previously inherited huu's protective −100.
- **Web settings are now server-owned and live**: the ⚙ RAM-budget dial POSTs
  to the new `POST /api/settings`, which applies it to the shared scheduler
  IMMEDIATELY (current + queued runs), persists it in
  `~/.config/huu/web-settings.json` and echoes the effective value;
  `/api/bootstrap` reads it back. Previously the dial only traveled
  piggybacked on each run POST — changing it mid-run silently did nothing and
  a blank field silently meant 85%.
- **Budget telemetry**: a 1 Hz `{type:'budget'}` SSE frame + topbar chip show
  the dial in force, used/total RAM, PSI and the guard's pressure level; a
  running run whose agents were all withheld by the guard shows an amber
  pulsing **paused (RAM)** pill and resumes in place when RAM frees up.
  `huu status` gains a **ram containment** doctor section: dial + source,
  budget bytes, detected kernel ceiling (or "NONE — software guard only"),
  live PSI/swap and every active `HUU_*` safety knob.
- **Queue as many projects as you want**: the web accept cap is now
  `HUU_MAX_QUEUED_RUNS` (default 256, was a hardcoded 64); queued runs cost no
  budget. Admission charges each run's fixed baseline
  (`HUU_RUN_BASELINE_MB`, 384 MiB) against byte headroom, adapts the live-run
  cap to the machine (budget ÷ (baseline + agent footprint), ceiling
  `HUU_MAX_LIVE_RUNS` = 8), and a merging run no longer bypasses a
  zero-capacity signal (the hole that pulled runs in while the machine was
  shedding).
- **Hermetic pi runtime (default ON).** Every pi session huu composes —
  openrouter AND azure backends, task agents and conflict resolvers alike — is
  now hermetic: in-memory auth/settings/model-registry fed by the run's key,
  ZERO reads of the host's `~/.jcode`, ZERO global npm `pi-*` extension discovery
  (`npm root -g` is never consulted), no skill/prompt/theme auto-discovery, and
  a huu-owned agent dir (`~/.huu/pi-agent`, with `PI_CODING_AGENT_DIR` exported
  only-when-unset as defense in depth). This closes the door a host-global
  `pi-animations` extension once walked through to crash an entire multi-run
  fleet from a detached timer. Debug escape hatch: `HUU_PI_HERMETIC=0` restores
  the legacy host-global behavior byte-for-byte.
- **`huu status` pi-runtime doctor.** The status report (text and `--json`) now
  shows the installed pi version, whether hermetic mode is on, the effective
  agent dir (and where it came from: env override / huu-owned / host), and the
  host-global `pi-*` packages found-and-ignored. Never runs on `--liveness`
  (the Docker HEALTHCHECK path stays cheap).
- **RAM-tuning env knobs + footprint observability.** New
  `HUU_AGENT_MEM_SEED_MB` (per-agent memory seed, clamped 128–2048 MiB) and
  `HUU_AGENT_MEM_EMA_ALPHA` (EMA factor, 0.01–1) let a user who has MEASURED
  their real per-agent footprint tune the AutoScaler's admission model —
  defaults are unchanged (the pessimistic 1536 MiB seed remains the OOM guard).
  The scaler now logs its effective memory model on start (`scaler`/`config`)
  and significant observed-footprint moves (`scaler`/`ema_move`) to the debug
  NDJSON for evidence-based calibration.

### Changed

- **BREAKING — huu is now DOCKER-ONLY.** The native pipeline-execution mode
  was removed: `--yolo`, `--no-docker` and `HUU_NO_DOCKER` no longer bypass
  the container (the CLI prints a notice and re-execs anyway; the flags are
  stripped before reaching the in-container CLI). Both machine freezes
  happened on native runs, and the container's kernel memory ceiling
  (`--memory`) is the one guarantee software can't undermine. What still runs
  on the host is not pipeline execution: `--help` and the host utilities
  (`init-docker`, `status`, `prune`). `scripts/huu-try` now always builds +
  runs `huu:local` via Docker. The native systemd-scope wrap remains in the
  tree as dormant defense-in-depth.
- **BREAKING — default RAM dial lowered 85% → 70%** (`DEFAULT_RAM_PERCENT`).
  On a desktop the OS + browser + IDE routinely hold 20–30% of RAM, so 85%
  started every run already at the edge. Explicit `HUU_RAM_PERCENT`, the
  `--ram-percent` flag and the web Setting override as before.
- **MAX (greedy) removed from the web UI**: every web run is subordinate to
  the shared scheduler, where the per-run greedy flag never drove anything —
  the button was lying (the 33-run incident was launched with it "on"). Legacy
  `greedy` POSTs coerce to `auto`; the topbar toggle cycles Auto ⇄ Manual. The
  single-run TUI MAX became **budget-greedy**: it floods one agent per queued
  task only while the RAM dial has headroom, instead of up to the 95% destroy
  line — the dial holds in every mode.
- **OS reserve**: the budget's untouchable floor grew from a flat 512 MiB to
  an adaptive `max(min(2 GiB, 25%), 8%, 512 MiB)` of total RAM
  (`HUU_OS_RESERVE_MB` overrides) — 512 MiB was far too thin for a desktop
  running a browser next to 33 runs.
- The RAM-safety env knobs (`HUU_RAM_PERCENT`, `HUU_GUARD_*`,
  `HUU_OS_RESERVE_MB`, run caps) now pass through the Docker wrapper into the
  container; a host `HUU_RAM_PERCENT` was previously ignored inside.
- `HUU_AGENT_MEM_SEED_MB` clamp widened to 128–4096 MiB (was 2048), matching
  the raised footprint-estimate ceiling.
- Terminal web runs no longer retain their full untrimmed state for the
  server's lifetime (slim snapshot + retention cap of 100 terminal runs).
- **pi dependency pinned exactly** (`@mariozechner/pi-coding-agent` and
  `@mariozechner/pi-ai` at `0.73.1`, no caret): the hermetic composition relies
  on SDK option names, so version drift is now an explicit, reviewed choice
  (the hermetic canary tests fail loudly on a regressing bump).
- **Agent context files are now SCOPED.** pi sessions no longer auto-inject
  AGENTS.md/CLAUDE.md from every ancestor directory (which reached `$HOME` and
  `~/.jcode`); huu injects only the target repo root's AGENTS.md/CLAUDE.md
  (deduped by realpath). Pipelines that relied on `$HOME`-level context files
  must move that guidance into the repo or the pipeline prompt.
- **`huu Test Suite` fan-out widened (12 → 24 files).** The per-file test-writing
  step is this pipeline's only parallel stage, so its width is what actually
  exercises the machine-wide RAM budget; at 12 the aggregate demand rarely
  reached the admission ceiling (the RAM dial went unused). Existing users keep
  their materialized `pipelines/huu-test-suite.pipeline.json` (bootstrap never
  overwrites) — delete it to pick up the new width.

- **Guided web launch — pipeline → projects → queue (a "cart" flow).** The web
  launch view is now a 4-step wizard: **pick a pipeline**, **mark one or more
  project folders** (the folder picker gained a **checkbox** — navigate the
  filesystem and tick every target; marks persist across navigation), **configure
  that pipeline once** (provider/model/concurrency/time, shared by all its marked
  projects), then **add another pipeline** or **run the queue**. Each pipeline
  **fans out into one run per marked project**, and the queue renders **grouped by
  pipeline**. Replaces the old one-folder-per-item form where targeting N folders
  meant re-filling the whole config N times. The scheduler/admission path is
  unchanged — running the same pipeline over many projects, or many projects on
  one repo, is safe (runs isolate worktrees/branches by `runId`). Web UI only; the
  Ink TUI launch flow is unchanged.

### Fixed

- **The memory guard now fires on a swapping host.** It previously keyed only
  on RAM/CPU ≥ 95%, which swap keeps below the line while the machine
  livelocks — the "guard never fired" signature of both the 9-run and the
  33-run freezes. The pressure ladder's earlyoom-style (avail + free-swap) and
  PSI-full triggers catch exactly that state.
- **Web folder picker no longer lists symlinked files as folders.** `listDirs`
  now follows directory symlinks but excludes symlinks that resolve to a file
  (e.g. `CLAUDE.md -> AGENTS.md`), so only real navigable/markable directories
  appear in the project picker.

## [4.0.0] - 2026-06-30

### Added

- **RAM budget dial — "fill the machine, never crash" (resource-control Fase 1).**
  Concurrency is now governed by a configurable share of TOTAL RAM instead of an
  opaque safety margin: set it with `HUU_RAM_PERCENT`, the `--ram-percent=<n>`
  flag, or the new **RAM budget %** field in the web Settings panel (machine-global
  — one machine, one RAM, no per-project override). Default 85%, clamped 10–95.
- **Pressure-aware admission (Linux PSI).** The scaler now reads memory
  Pressure Stall Information (`/proc/pressure/memory`, or the per-cgroup
  `memory.pressure` in a container) and freezes new agents the moment real
  pressure appears — *before* RAM saturates. Where PSI is unavailable (macOS,
  kernels without it) it falls back to the previous RAM-percent gate.
- **Lazy admission in the web UI.** Launching a queue of projects no longer
  starts them all at once: the server admits the first immediately and holds the
  rest in a new **queued** state, pulling each in as the shared budget frees up
  (the headless `run-many` already did this; the browser now does too). This is
  the direct fix for the multi-project out-of-memory crash.
- **Configurable OOM protection.** `huu` nudges its own `oom_score_adj` so the
  kernel prefers other processes under pressure; tune via `HUU_OOM_SCORE_ADJ`
  (conservative default, best-effort — takes effect where the process is
  privileged, e.g. the container).
- **Pause instead of kill under memory pressure (resource-control Fase 2.3).**
  When the machine runs low on RAM, `huu` now **pauses** an agent — freezing its
  work in place (its git worktree *and* the agent's conversation transcript are
  preserved) and freeing the memory — instead of killing it and restarting from
  scratch. The agent **resumes exactly where it left off** as soon as headroom
  returns, so a pressure spike costs at most the current step, not the whole
  task. Paused cards show a distinct **PAUSED** state with a `⏸` counter (vs the
  `↻` requeue counter of a kill). On by default, single- and multi-run; set
  `HUU_NO_PAUSE=1` to keep the previous kill-and-requeue behaviour. If a
  checkpoint can't be taken for any reason it falls back to that behaviour
  automatically, so it is never worse than before.

### Changed

- **Adaptive concurrency control (resource-control Fase 2.2).** The pressure
  brake is now a **closed-loop controller** instead of a single freeze threshold:
  it continuously ramps concurrency up while the machine is comfortable and eases
  it down as memory pressure rises, settling at the highest level the machine
  sustains without thrashing. `huu` therefore uses more of the machine than the
  earlier conservative freeze, while still backing off *before* RAM saturates.

- The per-agent memory estimate now starts **pessimistic** and corrects downward
  from real measurements, so a cold start admits cautiously and opens up once it
  confirms agents fit — the inverse of the old optimistic seed that over-admitted.
- New agents **ramp up** over a few cycles (geometric, ~+50% per tick) instead of
  the whole pool spawning in one burst. Manual (`--concurrency`) still fills
  immediately.

## [3.1.0] - 2026-06-29

### Added

- **Set a per-agent time limit from the web — globally and per project.** A new
  **Settings** panel (⚙ in the topbar) holds a global **Max time per agent**
  (minutes) that caps every agent's run time across the **whole pipeline** for
  **every run started from this browser**; each project's launch field can
  **override** it (blank inherits the global). It's sent as `timeoutMinutes`,
  which the server applies to both the multi-file and single-file card timeouts;
  blank everywhere keeps the pipeline's built-in default (10 min · 5 min for
  single-file tasks). The global setting and the per-project value persist in the
  browser and are recorded in History. **Web UI only — the CLI keeps its own
  rules.** Previously the web could only raise the limit when *retrying* an
  already-timed-out card; setting it up front was TUI-only.

- **Add projects to a live queue from the home view.** While a queue is running
  you can return to the launch view (**← Home**), add more projects, and they
  dispatch **immediately** under the shared scheduler — no restart, no prompt.
  A *running* banner on home (`N running · X/Y done`) stays visible while you
  pick, with a **“View board →”** jump back to the kanban. Pure client-side: the
  multi-run server already admitted concurrent runs, so the change is a sticky
  `homePinned` flag that opts the home view out of the per-frame board
  auto-switch, plus immediate dispatch on add and the home banner.

- **Failed task cards can now be retried interactively — and timeouts are
  signalled distinctly.** A timed-out card is shown in **amber** (`TIMEOUT`),
  separate from the **red** of any other failure (`FAILED`), in both the Ink TUI
  and the web kanban. When a single run (TUI) or any web run ends with failed
  cards, it no longer jumps straight to the summary: it pauses in a new
  **`awaiting_retry`** state (integration worktree kept alive) so you can recover
  individual failures. Retrying a card re-runs that one task against the current
  integration HEAD and, on success, merges its branch in — no need to re-run the
  whole pipeline. A **timed-out** card can be retried with a **new, longer time
  limit**; any other error just re-runs. User retries show a `⟳N` badge.
  - **TUI**: on the run dashboard, `R` retries the focused error card (timeouts
    prompt for a new limit first), `D` finishes the run, `Q` aborts.
  - **Web**: red/amber cards open a drawer with a **Retry** button (timeouts also
    get a minutes field); a **Finish** button leaves the review hold. New
    endpoints `POST /api/run/retry` and `POST /api/run/finish`.
  - Headless drivers (`run-many`, smoke, `/simulation`) are unaffected —
    `Orchestrator` only holds open when the new `interactiveRetry` option is set,
    so `start()` resolves immediately on every non-interactive path.

- **`huu-tests-findings.md`** — a new Test Suite deliverable: the finalize step
  rolls every `suspected-bug` FAQ finding into a human-readable table of bugs the
  run surfaced but (by the freeze) did not fix, deduped by a stable `sb-<id>`
  join key and cross-checked against the tests that pin them.
- **`$baseCommit` work-step prompt token** and a **base-commit Git Context line
  for judges** (`src/orchestrator/index.ts`, `src/orchestrator/check-evaluator.ts`).
  Since stage merges are already committed by the time a step or judge runs, a
  bare `git status` is clean; exposing the run's base commit lets a step diff
  what the run actually changed (`git diff --name-only $baseCommit..HEAD`) or
  restore a frozen file (`git checkout $baseCommit -- <path>`). The Test Suite
  cleanup step uses it to actively restore any source an agent drifted.

### Changed

- **Web project selector is now a custom, animated dropdown — no native
  `<select>`.** When more than one run is live, the header selector is a simulated
  listbox: a pill trigger plus a glass `role="listbox"` panel that opens and
  closes with a [Motion](https://motion.dev) spring (chevron rotate + per-row
  stagger), showing **`project · pipeline`** per run (a leading dot reflects each
  run's phase; finished/failed runs carry a ✓/✕ marker). It replaces the OS
  `<select>`, whose look couldn't be themed and — being rebuilt on every snapshot —
  closed the instant it opened during a run (see *Fixed*). The run snapshot carries
  its `runDirectory` so each run is labelled by the project it operates on, not just
  the pipeline name. Keyboard-navigable (arrows/Enter/Esc), dismiss-on-outside-click,
  and degrades gracefully (no animation) under `prefers-reduced-motion`. Motion is
  **vendored** under `src/web/client/vendor/` so the no-build, offline browser client
  keeps working with no CDN.
- **Run log redesigned into a live, cross-project activity console.** The log
  drawer's header is now a **live activity bar** that sums the agents running
  **right now across every concurrent run** (`⚡ N running · M projects ·
  Q queued`), refreshed on every frame — the count reflects all projects in
  real time, not just the viewed one. Each agent gets a stable hue chip so
  parallel work is visually separable, level glyphs + a colored rail flag
  warnings/errors, and when more than one run is live the body becomes a single
  timestamp-ordered stream merging every run's lines (each tagged with its
  project). A level filter (All · ⚠ · ✕), a "↓ Latest" jump pill and
  auto-expand-on-first-run round it out. Entirely client-side: the cross-run
  count is derived from the run snapshots already on the wire — no
  orchestrator/server/SimulationEngine change.
- **`huu Test Suite` is now code-frozen — it writes tests and NEVER edits your
  source.** The flagship pipeline's step prompts and judge were rewritten so the
  production tree is read-only. The old escape hatch ("if a real bug is exposed,
  fix `$file`") is gone: when a generated test reveals apparently-buggy behavior
  the agent now **characterizes** it (pins the *actual* current behavior so the
  suite stays green and truthful — Feathers, *Working Effectively with Legacy
  Code*), records a fixed-shape `suspected-bug` finding, and — on runners with a
  real expected-failure idiom (vitest `test.fails`, pytest strict `xfail`, RSpec
  `pending`) — leaves a strict marker that flips red the day the bug is fixed.
  Stacks without a native xfail (Go, Rust, JUnit 5) use characterization only —
  `t.Skip`/`#[ignore]`/`@Disabled` are explicitly banned as bug trackers because
  they assert nothing. Cleanup now prefers converting a bug-catching test to a
  marker over deleting it (deletion is the last resort for structurally-broken
  tests). Prompts also gained banned-token determinism rules and a per-test
  mutation-strength self-check. Grounded in a fresh research pass over
  characterization/golden-master testing, the documented LLM test-gen
  "cheat-to-green" failure mode, mutation testing, and the cross-language
  expected-failure mechanics.
- The Test Suite judge (`5. Suite green and code untouched?`) now enforces the
  freeze mechanically: it diffs the whole run against its base commit
  (`git diff --name-only $baseCommit..HEAD`) and reworks if any non-test,
  non-artifact source path changed, plus anti-cheat clauses that reject
  assertion-free / weak-only / self-mocked "green by emptiness" tests and orphan
  suspected-bug findings. These clauses are hard — never waved by the
  `$runs >= 2` lean-approve shortcut.

### Fixed

- **The web project selector no longer "opens and immediately closes" mid-run.**
  The header run-switcher was a native `<select>` that `renderRunSelector()`
  rebuilt via `innerHTML` on every SSE snapshot (~8×/s during a live run), so the
  OS dropdown was destroyed the instant it opened and you could never switch runs
  while a pipeline was active. The selector is now a custom listbox whose
  open/closed state lives in JS over persistent DOM (listeners wired once); live
  re-renders only refresh the trigger label and option rows, so it stays open while
  the board updates underneath it (see *Changed*).
- **Run-board card titles now show the real file name instead of `$file`.** A
  per-file/memory step named like `"Write tests for $file"` rendered the raw
  `$file` token on its kanban card in both front-ends. The token is now resolved
  for display to the worked file's basename (`"Write tests for Button.tsx"`) on
  agent cards (live board, drawer, run history) in the web UI and the Ink TUI
  (`RunKanban` + the agent detail modal); stage-level merge cards that span every
  per-file branch collapse the token to the plural `"files"`. Display-only — the
  agent PROMPT still receives the exact relative path. New shared helper
  `substituteFileInTitle` (`src/lib/title-format.ts`, mirrored verbatim in
  `src/web/client/title-util.js` for the no-build browser client).

> Note (materialization trap): `pipeline-bootstrap.ts` never overwrites an
> existing `pipelines/huu-test-suite.pipeline.json`. Users who already ran huu
> keep their old copy — delete that file to re-materialize the code-frozen
> version (the committed copy in this repo has been regenerated).
## [3.0.0] - 2026-06-26

### Added

- **Run multiple projects in parallel (web + TUI).** Queue several projects and
  they now run **concurrently** under one shared RAM/concurrency budget instead
  of one-at-a-time. A new `GlobalScheduler` (`src/orchestrator/global-scheduler.ts`)
  gives earlier projects priority, lets later ones **backfill** the idle slots of
  earlier ones (e.g. while a higher-priority project's merge agent runs for
  minutes), **drains** a lower-priority project when capacity is reclaimed
  (without wasting work), and under memory pressure (≥95%) kills the
  **lowest-priority project's newest agent first**. In the **browser**, a
  **project selector** appears in the header when more than one project is
  running so you can switch between live boards; each project streams its own
  state + agent output, and the `/simulation` demo can run several at once. In
  the **Ink TUI** (`huu --cli`), multi-select 2+ saved pipelines with `SPACE` to
  run them concurrently with a `Tab`/`1-9` project switcher
  (`MultiRunDashboard`). Single-run behavior is unchanged (the scheduler is
  opt-in via `OrchestratorOptions.scheduler`). Also usable headlessly via
  `src/lib/run-many.ts`; the priority invariant is pinned by
  `multi-run-priority.test.ts`.
- **Scrollable run-board columns + animated card moves (web UI).** Kanban
  columns now **scroll** when they fill up instead of squashing the cards
  flat (the cards are flex children that were shrinking to fit before the
  scrollbar could appear; they now hold their natural height). When a card
  changes column it **animates to the first slot of the destination** — a
  `transform`-only FLIP flight rendered by a ghost on a body-level overlay,
  so it glides across the gap GPU-composited and jank-free; reads/writes are
  batched into a single reflow + one `requestAnimationFrame`, and the whole
  effect honours `prefers-reduced-motion`. The pure lane-ordering (a moved
  card floats to the top, newest first; new cards keep insertion order) is
  extracted to a DOM-free, unit-tested `src/web/client/board-order.js`.
- **Simulation mode (`/simulation`) — a synthetic, no-cost demo run.** A new
  browser route renders a FULL huu run — kanban cards flowing TODO → DOING →
  DONE, live per-agent logs, the agent-output firehose, token/cost counters —
  with **no git branches, no API key and no LLM call**. A new `SimulationEngine`
  (`src/orchestrator/simulation/`) fabricates byte-identical `OrchestratorState`
  snapshots + `agent-stream` frames and is driven through the SAME
  `WebRunManager` channel as a real run (new `startSimulation()` + `setPaused()`;
  the subscribe/start/cleanup wiring is now shared via a `RunDriver` seam, so the
  real-run path is unchanged). The setup screen picks **models, number of files
  and simultaneous agents**; each run randomly draws the full scenario mix —
  streaming, memory-guard requeues (`↻`), retries, permanent errors, stage
  merges and the judge **rework → approved** loop. Controls: **play/pause**
  mid-run and **Run again** on completion. New endpoints: `GET /simulation`
  (SPA shell), `POST /api/run {simulate:true}`, `POST /api/run/pause`. Intended
  for demos / advertising.
- **Web model picker lists the FULL OpenRouter catalog and accepts any model
  id.** The web UI's Model field is a searchable combobox — type to filter,
  instead of a two-item dropdown. `GET /api/models` downloads the **entire**
  live catalog (every model — 339 today, up from the ~170 that passed the old
  tool+reasoning filter) the moment you open the Model picker: OpenRouter's
  `/models` endpoint is **public**, so this happens **with or without a key** —
  no more staring at the two-item recommended shortlist until you paste one. A
  validated key, when held, is forwarded via the browser-only `x-huu-key`
  header for the per-account view; the static recommended list is now only a
  **fallback** for when OpenRouter is unreachable. Models are no longer hidden
  by capability: each row is
  **badged** (`reasoning`, and `no tools` as a soft warning) so the choice is
  informed without dropping models like `deepseek/deepseek-chat` or one
  OpenRouter shipped yesterday. You can also **type any model id** that isn't in
  the list — the combobox offers a `Use "<id>"` row sent to OpenRouter verbatim,
  so brand-new or unlisted models (e.g. `deepseek/deepseek-v4-pro`,
  `deepseek/deepseek-v4-flash`) just work. New `projectAllModels` /
  `listAllModels` in `src/lib/openrouter.ts` (`OpenRouterModelOption` gains
  `supportsTools`/`supportsReasoning`) and `listModelsForBackend` in
  `src/web/api-data.ts` (`ModelInfo` gains `tools` + `contextLength`).
  `filterToolReasoningModels` / `listToolReasoningModels` remain as a tested
  predicate for callers that want only the dual-capable subset.
- **Sequential project queue + run history (web).** The web launch screen now
  builds a **queue of projects**, each with its OWN config (pipeline,
  directory, provider, model, concurrency), and runs them **sequentially** —
  when one settles the next starts; a failure marks that project failed and
  the queue keeps going. Every execution is archived to the browser's
  **IndexedDB** history with all kanban cards, per-card costs and the
  per-project total, and the whole history is **exportable as JSON**. Entirely
  client-side (new `src/web/client/db.js` for the store + pure record builders,
  plus the queue runner in `app.js`); the single-run server is unchanged. New
  `building-web-ui` agent skill documents the browser layer.
- **Live pi agent output mirrored to the browser console.** The web UI now
  streams everything the pi coding agent emits — its reply text *and* its
  thinking trace — to the browser DevTools console in real time over a
  dedicated `agent-stream` SSE channel (the orchestrator exposes it via
  `subscribeAgentOutput`, separate from the throttled state snapshot). Each
  line is tagged with its agent id; silence it with
  `window.HUU_LOG_STREAM = false`.

- **Provider selection inside pi — OpenRouter or Azure AI Foundry.** huu now
  exposes a single backend (pi) and lets you choose the LLM *provider*
  underneath it. New `LlmProvider` type + `src/lib/providers.ts` mapping
  (`openrouter` → `pi`, `azure` → `azure`); the TUI provider selector and the
  web segmented control both show the two providers with live "key set / key
  needed" status. Lock it from the CLI with `--provider=openrouter|azure`
  (`huu auto` configs gain an optional `provider` field).
- **Per-pipeline descriptions at launch.** `Pipeline.description` is now part
  of the schema and surfaced under each pipeline's name in the TUI Welcome
  list and on the web launch cards. All seven bundled defaults carry a
  one-line summary of what they do.
- **Filesystem folder navigation — choose where to run.** Default is the
  current directory, but you can now browse the filesystem and pick a
  different run directory: a `[D]` DirectoryPicker screen in the TUI, a
  "Browse…" folder modal in the web UI (`GET /api/folders`), and a `--dir=`
  CLI flag honored across native, Docker and headless runs. `RunConfig` gains
  `workingDirectory`.
- **Animated gooey-blob mark, loader and favicon.** huu's logo is now a
  morphing "liquid" blob driven by an SVG goo filter (web) / graded-Unicode
  metaball (`MorphLoader` in the TUI). It animates as the brand mark, as the
  run loader while the orchestrator spins up, and as the favicon — in the
  indigo→purple (AI-magenta) identity, honoring `prefers-reduced-motion`.
- **Editable API key for the selected provider.** The launch screen loads the
  current key status per provider and lets you set OR change each credential
  in place (Azure shows both key + endpoint); saving persists to the same
  global store pi reads from, so the change takes effect on the next run.
- **Options screen for AI provider API keys (`[O]` on the Welcome screen).**
  A new TUI screen lists every credential in the API-key registry with its
  resolved (masked) value and source, and lets you overwrite any one in place
  — persisted to the global config (`~/.config/huu/config.json`, mode 0600).
  It also **opens automatically when a run aborts on an invalid key**: the
  pre-run reachability probe (pi) and the Azure factory now throw a typed
  `AuthError`, which the run dashboard routes to the Options screen
  pre-focused on the rejected provider, so an invalid key is fixable without
  editing env vars or files by hand.
- **Reusable full-width `ActionBar` footer.** Keyboard hints now span the
  whole width with per-key semantic colors — `G run` (green) and `ESC back`
  (red, bold) stand out as the primary actions; the rest are muted blue.
- **Web UI — now the default front-end.** Running `huu` opens an
  Apple-inspired browser interface (Liquid Glass, light/dark, real-time)
  instead of the Ink TUI; the new **`--cli`** flag (or `HUU_CLI=1`) keeps the
  terminal UI. The web front-end is orthogonal to the Docker/native runtime, so
  every combination works — notably `huu --yolo` is the web UI running natively
  without Docker. New presentation layer under `src/web/` (a sibling to
  `ui/`): a dependency-free `node:http` + Server-Sent-Events server drives the
  same `Orchestrator` as the TUI and the headless runner. A live kanban of
  agent/merge/judge cards (TODO → DOING → DONE) is clickable for per-card
  tokens, cost, branch, files and streaming logs, with a global log console and
  Auto · Manual · MAX concurrency control. In Docker the wrapper publishes the
  web port to the host (`docker run -p`) and the in-container server binds
  `0.0.0.0:$HUU_WEB_PORT`; natively it binds `0.0.0.0` so the LAN can reach it.
  Knobs: `--port=<n>` / `HUU_WEB_PORT` (default 4888), `HUU_WEB_HOST`
  (localhost-only via `127.0.0.1`), and an optional `HUU_WEB_TOKEN` shared
  secret gating the data/action routes. Client assets ship in `dist/web/client`
  (build copies them; no CDN, works offline and inside the image).
- **Web UI keeps your API key in the browser, validated, never on disk.**
  Pasting a key in the launch form now validates it against the provider
  first (`POST /api/keys/validate` → OpenRouter / Azure reachability) and
  refuses one the provider rejects (401/403). A valid key is held only in
  the browser tab's `sessionStorage` and sent with each run (`apiKey` in
  `POST /api/run`), so the server uses it in memory and never writes
  `~/.config/huu/config.json`. `BackendInfo.apiKeySpecName` is now exposed
  so the browser can look up its per-backend session key; the legacy
  disk-saving `POST /api/keys` stays for CLI reuse but the browser no
  longer calls it.
- **Per-action counters and a last-action marker on the kanban cards.** Each
  agent card now carries a compact label tallying every action it has taken —
  e.g. `stream:8 tool:7 file:2 log:34 usage:9 done:1` — counted from the live
  `AgentEvent` stream (`state_change` splits into `stream`/`tool`; `file`,
  `log`, `usage`, `done` and `error` map one-to-one). The most recent action
  leads the card's telemetry line as a colored `→ <action>`, merged with the
  existing `log:` text. `AgentStatus` gains `actionCounts` + `lastAction`,
  bumped once per event in `handleAgentEvent` and accumulated like tokens/logs
  (they survive a memory-guard requeue). Rendered on the Ink TUI (`huu --cli`)
  kanban (`src/ui/components/RunKanban.tsx`); `action-counter.test.ts` pins the
  tallying.

### Changed

- **Default model is now `deepseek/deepseek-v4-flash`.** It headlines the
  recommended catalog (`recommended-models.json` + the in-code fallback) and is
  preselected by both front-ends when you haven't picked a model — fast, cheap
  ($0.09/$0.18 per M tokens), 1M context, tools + reasoning. The web picker
  previously seeded from the alphabetically-first live OpenRouter model; it now
  prefers this canonical default (`DEFAULT_MODEL_ID`) when the catalog offers
  it. DeepSeek V4 Pro stays available as a `planning`-tier model.
- **The default pipeline (huu Test Suite) is pinned as "pipeline zero".** It
  always appears first on the Welcome screen, labelled `[0]` (the `0` key
  loads it) and colored distinctly with a `(default)` tag, so the
  most-recommended entry is unmistakable. Remaining pipelines are labelled
  `[1]`, `[2]`, … and the digit keys map directly to those indices.
- **Steps that need fixing before a run are now colored in the editor.** An
  invalid step's whole row turns yellow (in addition to the existing `⚠`
  marker and the actionable problem hint), so the blocker is visible at a
  glance.
- **Per-agent card logs now include the reasoning ("thinking") trace,
  tagged `🧠`.** Previously the thinking stream was mirrored only to the
  browser-console firehose; the card drawer now shows it alongside the
  reply text, so a card's log matches what the console streams (the
  verbose trace still stays out of the global run log). The per-agent log
  buffer was raised 100 → 200 lines to match the server's per-frame cap.
- **The web UI opens on home unless a pipeline is running.** Reopening huu (or
  refreshing the tab) lands on the launch screen by default and jumps straight
  to the live **kanban** only while a pipeline is actively running — a finished
  or failed run no longer hijacks the landing view. Closing the browser
  **never** interrupts a run: the run lives in the huu process, so you can close
  the tab and reopen to re-sync, and only the **Stop** button or quitting huu
  (Ctrl+C) ends it. A new `server.test.ts` regression drops the SSE connection
  mid-run and asserts the run stays alive.

### Fixed

- **Finished queue projects move to History instead of lingering in the queue
  (web).** When a project queue finished, each settled run was archived to
  History (IndexedDB) but its item stayed in the queue — and the persisted
  queue drops run status, so returning home (or reloading) restored the
  finished projects as *pending* and the next "Run queue" re-ran the same
  pipelines indefinitely. Settled projects (done/error) are now pruned from the
  queue when it completes (`finishQueue`) or is stopped (`stopFinalize`), so a
  clean finish empties the queue and a stop keeps only what never ran; the
  topbar History panel remains the record of finished runs. The prune decision
  is a pure, unit-tested `src/web/client/queue-util.js`.
- **`recommended-models.json` is loaded again instead of being silently
  dropped.** The shipped catalog declared a `planning` tier and `bestFor`
  values that were missing from the zod enums, so the whole file failed
  validation and the catalog fell back to a 2-entry in-code list — the
  documented planning models (DeepSeek V4 Pro, GPT-5.4, Claude Opus 4.6) never
  loaded. The `planning` enum value was added to `ModelTier`/`ModelUseCase`,
  and a `catalog.test.ts` regression now fails if the shipped file ever stops
  parsing.
- **Editing a queued project no longer crashes (web).** `editQueueItem` read a
  `#modelSelect` `<select>` that the combobox migration had removed, throwing on
  `null.value`; it now restores the saved model id (catalog **or** custom)
  through the combobox.
- **The run log now advances in real time instead of only when the run
  stops.** The pi event translator was dropping every `message_update`
  streaming event, so between tool calls — i.e. for most of a generation — the
  orchestrator emitted no state and the log appeared frozen until the run
  settled. huu now maps pi's streamed `text_delta`/`thinking_delta` events into
  a new `stream` agent event, coalesces them into whole lines, and surfaces the
  assistant's text live in the run log (web log panel, per-agent drawer, TUI
  and headless logs all benefit, since they read the same buffer).

- **"Valid API key still returns 401" — fixed at the root: a saved key now
  takes precedence over the `OPENROUTER_API_KEY` environment variable.**
  Previously a stale `OPENROUTER_API_KEY` exported from a shell profile
  (resolver step 3) silently shadowed the key you saved in the Options screen
  (step 4), so the pre-run probe sent the wrong key and aborted. The resolver
  now ranks the explicitly saved store ABOVE the env var
  (`secret-mount → stored → env-file → env`), so the key you saved is the key
  huu uses; the env var is only the fallback when nothing is saved (CI/headless
  behavior is unchanged — no saved key means the env var still wins). The
  Options screen flags when an env var is set but ignored, the 401 message
  names the winning source (`resolveApiKeyWithSource` + `keyRemedyHint` in
  `lib/api-key.ts`, with `shadowsStored` reworked to `storedOverridesEnv`), and
  the Docker wrapper notes on the host when it forwards the saved key over a
  present env var.
- **Run dashboard header no longer breaks on narrow terminals.** The status
  row now wraps (`flexWrap`) instead of overflowing, every value carries an
  explicit space after its label (so "stage" and "5/5" never read stuck
  together), and the active provider + model are shown up front.
- **Web UI background, header and mobile layout.** The ambient aurora is a
  richer multi-blob drift; the topbar wraps and spaces its metrics so they
  no longer jam; new phone/tablet breakpoints stack the layout, switch the
  card drawer + folder modal to full-height sheets, and enforce 44px touch
  targets on coarse pointers.
- **Run cost now sums live in the header — it was stuck at `$0.00`.**
  `Orchestrator.getState()` (and the headless `auto` result) hardcoded
  `totalCost: 0`, so the dashboard header never moved even though every
  agent card metered its own spend. `totalCost` is now the live sum of
  each per-agent `cost` (the authoritative `usage.cost` OpenRouter returns
  per turn); the header reads it in real time and renders 4 decimals for
  sub-cent totals so a running meter is visible. (Merge/judge LLM cost is
  still not metered — only worker agents count toward the total.)
- **The per-agent log drawer no longer jumps to the bottom on every
  update.** It rewrote its text and force-scrolled to the end on each
  ~120 ms snapshot, yanking you back the moment you scrolled up to read.
  It now follows the tail only when you're already pinned to the bottom
  (or on first open) and preserves your scroll position otherwise.

### Removed

- **GitHub Copilot backend.** huu is pi-only now (OpenRouter or Azure AI
  Foundry via the provider toggle). Removed `src/orchestrator/backends/copilot/`,
  the `@github/copilot-sdk` optional dependency, the `copilot` backend kind /
  api-key spec / model catalog, and the `--copilot` flag. Existing `huu auto`
  configs that set `"backend": "copilot"` no longer validate — switch to
  `"provider": "azure"` or the default OpenRouter.

> Note: the bundled `pipelines/*.pipeline.json` were re-rendered to include
> the new `description` field. Existing users keep their materialized copies
> (bootstrap never overwrites) — delete a file to pick up the new version, or
> run `npx tsx scripts/regen-default-pipelines.ts`.


## [2.1.0] - 2026-06-25

### Changed

- **Bundled pipelines are now fully autonomous — manual file-picking removed.**
  The six defaults that used to require `scope: "per-file"` (huu Test Suite +
  the five report-only audits) now discover their own targets: a recon step
  `produces` a `huu-memory-v1` list (with per-file `hint`s) and the work step
  fans out via `scope: "memory"` + `filesFrom` — the pattern huu Knowledge
  System already used. A shared `targetsRecon()` helper in
  `knowledge-protocol.ts` keeps the selection prompt identical across them, and
  `registry.test.ts` now enforces that NO default ever reintroduces
  `scope: "per-file"`. huu Test Suite additionally ends with a CheckStep cleanup
  loop (reworks until the suite is green); huu Security Audit fans its four
  independent scan dimensions (recon · secrets · CVE · supply-chain) into
  parallel `dependsOn` waves joined by consolidation. Step prompts were sharpened
  against the new prompting playbook. NOTE: `pipeline-bootstrap` never overwrites
  — existing users keep their materialized JSONs; delete
  `pipelines/<name>.pipeline.json` to re-materialize the autonomous version.

### Added

- **`docs/prompting-playbook.md` (+ pt-BR twin) and the `authoring-agent-prompts`
  knowledge skill.** A research-grounded, cross-LLM playbook of 12 prompt
  techniques (atomic decomposition, explicit output contracts, `$file`/`$hint`
  injection, mechanical forward-default judges, lean pi-backend prompts, …) that
  the bundled pipelines now follow; indexed from `docs/README.md` and the skill
  catalog.

### Removed

- **Dropped the four loose sample pipelines.** `example.pipeline.json` and
  `example.conditional.pipeline.json` (repo root) plus `demo-quick` /
  `security-tests` (`pipelines/`) are gone; the README / onboarding / operations
  quickstart and the pipeline-JSON guide now point at the bundled defaults
  (`pipelines/huu-test-suite.pipeline.json`, materialized on first launch) and
  use huu Security Audit / Knowledge System as the live check-step + `dependsOn`
  wave examples.

## [2.0.0] - 2026-06-25

### Added

- **MAX (greedy) auto-scaling mode.** Press `M` on the run dashboard to
  flood the worker pool with one agent per queued task (up to the hard
  ceiling) and let the always-on memory guard be the sole backstop;
  concurrency settles at the memory limit, cooldown-damped to avoid
  thrashing. Surfaced as a blue `MAX` status chip. `+`/`-` still pin
  manual from any mode, `A` returns to auto.

### Removed

- **Web UI mode (`huu --web`) removed entirely.** huu is now terminal-only
  (Ink TUI + headless `huu auto`). Deleted the `src/web/` HTTP+WebSocket
  back-end, the `webui/` front-end workspace, the `cli-web.ts` entry point,
  the `--web` / `--web-port` / `--no-open` flags (and the `HUU_WEB_NO_OPEN`
  env var), the `smoke-web.sh` smoke test, the `extending-web-mode` skill,
  and the `docs/WEB-UI.md` guide. The `ws` dependency and the `webui`
  npm workspace were dropped; the Docker build no longer pre-builds the
  front-end. The orchestrator, FSM (`src/lib/screen-fsm.ts`), and all
  back-end layers are unchanged.

### Fixed

- Source-run scripts (`npm run dev` / `npm start`) now bypass the Docker
  re-exec gate, so contributors run the TUI natively from source instead of
  the wrapper trying to containerize the dev process.

## [1.4.0] - 2026-06-12

### Added

- **Pipeline Assistant v2 — the Architect flow.** Creation is no longer one giant turn: after the interview, THREE structural blueprints are sketched **in parallel** under deliberately different lenses (maximize-parallelism · minimize-cost · maximize-verifiability), a **generative selector** compares them — plus the interviewer's draft as candidate 0 — against a mechanical rubric (no collapsed fan-out, memory pairs for discovery, dependsOn diamonds for independence, safe forward check defaults, sane step counts) and fuses the winner with at most small grafts; final prompts are then written **one step per call, in parallel**; and the result runs through the REAL zod + topology validation with at most one error-guided fix. Research-grounded: best-of-N with generative selection beats single-shot (GenSelect, arXiv:2507.17797; multi-agent verification, arXiv:2502.20379), while self-critique loops degrade good baselines (Self-Refine analyses) — so there is deliberately NO critique loop, only external mechanical feedback. Latency ≈ 3 sequential calls (two phases are parallel). Phases stream live in the TUI; the web one-shot path uses the same flow. New `planning` tier in `recommended-models.json` (deepseek-v4-pro, gpt-5.4, claude-opus-4.6) surfaced in the assistant's model picker — planning is maximum leverage.
- **Actionable run errors end to end.** Every fatal failure now records `RunManifest.errorReason` — what broke AND what to do next (first root cause wins; cascades don't overwrite it) — and the messages point at the new `docs/troubleshooting.md` anchors (runaway loops, merge conflicts, git state, memory files, keys, ports, Docker, the fixed macOS spawn bug). The summary screen finally tells the truth: red "Run failed" with the ⚠ reason, yellow "finished — N agents failed" with the first failure + where the logs live, green only when clean. Headless final JSON carries `errorReason`. Full symptom→cause→fix guide: `docs/troubleshooting.md` (+ pt-BR), indexed from `docs/README.md`.
- **`dependsOn` — parallel/switch/join via deterministic waves.** Steps declare a dependency graph (GitHub-Actions `needs` style; only earlier steps, so cycles are impossible). Any `dependsOn` switches the run to BSP supersteps: each wave runs every ready step with all their tasks in ONE shared pool (real cross-branch parallelism), then merges sequentially in array order — wave composition and merge order derive from the graph + array, never timing (same pipeline ⇒ same commit sequence). Ready checks run as singleton waves (judges never overlap); check outcomes and `next` become activation edges that re-pend the target plus its downstream cone ("rework redoes whatever depended on it"); a memory step implicitly depends on the step that `produces` its `filesFrom`. Pipelines without `dependsOn` keep the legacy linear cursor byte-for-byte (incl. `next`-as-skip). Surfaces: TUI Deps field (SPACE multi-pick of earlier steps), `⇠ needs` badges, `◇ wave N` chip on the run header, "Fan-out → Join (diamond)" scaffold in the pattern picker, Pipeline Assistant emits diamonds for independent-analyses intents, full guide section in `docs/pipeline-json-guide.md`.
- **`produces` + auto-appended MEMORY CONTRACT — memory links without boilerplate.** The producer side of a memory pair is now declarative: set `"produces": "<path>"` on the earlier step and huu appends the exact contract (path, huu-memory-v1 format, the consumer's real `maxFiles` cap, the hint rule) to that step's prompt at run time — pipeline authors never paste format boilerplate and saved JSONs stay clean. Topology rejects two steps producing the same path. TUI: the memory step's Files field becomes a **link picker** (choose a declared producer, pick an earlier step to produce it — huu wires both sides with an auto-named path — or type a custom path); producer steps show a `→ produces` badge. Web editor gains a Produces input + a filesFrom select of declared producers. Pipeline Assistant emits producer/consumer pairs and is forbidden from writing format boilerplate. `huu Knowledge System` dogfoods it (steps 1 and 4 declare produces; their prompts shrank).
- **Pipeline-builder UX redesign (research-grounded).** `N` (new pipeline) now opens a **pattern picker** — Discover → Act (memory pair pre-wired), Per-file transform, Audit with judge, Blank — scaffolding linked steps with placeholder prompts instead of an empty screen; the Scope field opens a visible list with a one-line consequence per option (no more blind cycling); `E` on the Prompt field opens `$EDITOR` for multiline editing (git-commit pattern, `VISUAL`/`EDITOR`); the step editor gains a single lazygit-style footer that always shows the focused field's keys; the pipeline list shows an actionable problem line for the selected step ("memory not linked — ENTER, then the Files field links a producer") instead of just a red badge.
- **`scope: "memory"` — file fan-out decided by an EARLIER step.** Third file-selection mode beyond whole-project and user-picked: a producer step writes a `huu-memory-v1` JSON (`{"_format":"huu-memory-v1","files":[{"path","hint?","priority?"}]}`) and the consuming step declares `filesFrom`; at stage start huu reads it from the integration worktree (check-loop rewrites are picked up) and spawns one agent per listed path, injecting each entry's `hint` via the new `$hint` prompt token. Deterministic failure split: missing memory file → zero tasks, stage completes empty with a loud warning (stub-safe); corrupt file → run fails. `maxFiles` (default 40) caps width; entries run priority-desc then list order; `config.files` overrides win in headless runs. Surfaces: schema + topology validation (filesFrom required, never the first step), TUI StepEditor (`M` shortcut, filesFrom input replaces the picker), Web UI step editor (new Scope select + filesFrom input — scope wasn't editable on the web at all before), Pipeline Assistant can emit the mode, dedicated guide `docs/memory-scope.md` (+ pt-BR) and a `docs/pipeline-json-guide.md` section. Note: `maxNodeExecutions` counts cursor VISITS — a fan-out of N files is ONE visit (docs corrected).
- **Memory-aware dynamic concurrency is now the DEFAULT.** The orchestrator always runs the `AutoScaler`: in `auto` mode (default) the worker-pool target is computed from real memory headroom — `ramAvailableBytes` (new in `SystemMetrics`: cgroup `limit − current`, `/proc/meminfo MemAvailable` on Linux hosts, `os.freemem()` fallback) minus a 10%/512 MiB safety margin, divided by an EMA-observed per-agent footprint (seeded 250 MiB, clamped 128 MiB–2 GiB) — replacing the old fixed total-RAM/250 MB estimate. New flags: `--concurrency=N` (pins manual mode at N) and `--no-auto-scale`; headless configs gain `autoScale?: boolean` with back-compat derivation (a config that sets `concurrency` keeps exact manual behavior). New web message `run.setAutoScale`; `run.setConcurrency` now pins manual (parity with the TUI `+`/`-` keys). Headless NDJSON state events now include `concurrency` and `autoScale` mode.
- **Always-on memory guard with kill→TODO requeue.** In BOTH modes, at ≥95% RAM/CPU the orchestrator kills the NEWEST agent (least work done — picked by `startedAt`), resets its kanban card to `pending` with a `requeues` counter (TODO column, `↻N` badge in the TUI, `requeued ×N` badge in the web UI) and requeues the task at the front of the queue — older agents' finished work is never lost. TUI header shows `~MB/agent` + free MB in auto mode and a `GUARD` chip (+ kill count) in manual mode.
- **CheckStep judges are now kanban cards** (TUI + web). New `CheckRun` slice (`OrchestratorState.checkRuns`, persisted to `manifest.checkRuns`): one entry per check visit with phase `judging → done/error`, the chosen outcome label, `fromJudge` flag (yellow `DEFAULT:` badge when the fallback fired), judge model, resolved condition, reason and live last-log. The maxRuns-exceeded forced default is its own DONE card instead of an invisible skip. TUI: `judge:` cards in `RunKanban` (`theme.ai` while judging); web: new `CheckRunPill` molecule.
- **`--no-docker`** — neutral CI spelling of `--yolo` (accepted everywhere `--yolo` is: re-exec gate, `--web` gate, credentials warning).
- **`docs/ci.md` + `docs/ci.pt-BR.md`** — running huu in CI without Docker: GitHub Actions and GitLab CI recipes for `huu auto` (npm install, secrets, `fetch-depth: 0` for history-scanning audits, `.huu/audits/**` artifacts, exit-code gating, dynamic per-file config via `git ls-files`, concurrency guidance for small runners). Linked from the READMEs and `docs/README.md`.
- **Judge gate on the five report-only audits.** Docs/Quality/Performance/Refactor/Security now END with a `N. Validate report` CheckStep (shared `reportJudgeCondition()` helper in `knowledge-protocol.ts`: sections complete, summary counts match the FAQ, ordering correct, report-only contract held) looping `rework` back to consolidation (maxRuns 2, `approved` is the default outcome) plus a terminal `Finalize report` stamp step. New `registry.test.ts` guards the contract (schema round-trip incl. topology, judge shape, REPORT-ONLY marker, caps).

### Changed

- **`huu Agent Knowledge` replaced by `huu Knowledge System`** — the knowledge pipeline became the most ambitious bundled default: it builds the FULL knowledge-skills system on a shared `.huu/knowledge/` blackboard (atlas → parallel per-file findings → ONE synthesis step that also writes the routing ground truth BEFORE any skill exists → per-topic dossiers → skills materialized by template transformation in judge-bounded batches of ≤3 → meta-skills + LEARNINGS + router-aware routing surface → blind routing eval with a description-sharpening rework loop). Engineered for quality on SMALL models: one cognitive operation per step, mechanical judge conditions, stub-safe forward defaults, verbatim-copy scaffolding. Bootstrap never overwrites: an existing `pipelines/huu-agent-knowledge.pipeline.json` keeps working on the old design — delete it if unwanted; the new `huu-knowledge-system.pipeline.json` materializes on next start.
- **All 7 default pipelines redesigned on cited, current methodology** (delete `pipelines/<name>.pipeline.json` to re-materialize — bootstrap never overwrites):
  - *Security Audit*: OWASP Top 10 **2021 → 2025** (new A03 Software Supply Chain Failures and A10 Mishandling of Exceptional Conditions; SSRF folded into A01), CWE Top 25 **2025**, NEW step "Supply chain & CI posture" (SLSA v1.2 / OpenSSF Scorecard informed: lockfile + SHA pinning, `pull_request_target` pwn-request detection, workflow `permissions:`, `curl | bash`, binary artifacts), gitleaks v8.19+ `git`/`dir` subcommands, `semgrep scan`, osv-scanner v2 `scan source`, path-traversal patterns.
  - *Quality Audit*: NEW step "Hotspot analysis (churn × complexity)" (Tornhill/CodeScene git-log mining), cognitive-complexity scoring rules + thresholds (Sonar S3776 = 15) alongside cyclomatic, hotspot-weighted refactor-first ranking.
  - *Performance Audit*: explicit INP lab caveat (Lighthouse can't measure INP — TBT is the lab proxy; field/CrUX required), p75 framing, unbounded-concurrency and missing-caching/extraneous-fetching patterns.
  - *Docs Audit*: classification via the Diátaxis compass; README rubric grounded in standard-readme required sections + assessment-badge evidence (ICSE 2018).
  - *Refactor Plan*: top-5 target ranking is now smell-weight × churn; characterization-test rationale (Feathers) spelled out.
  - *Test Suite*: assertion-quality rules that survive mutation testing (behavior not implementation, no change-detector/snapshot-only tests), determinism ruleset (no sleeps/network, frozen clocks, fixed seeds, hermetic tests), optional Stryker/mutmut/PIT follow-up documented in `huu-tests.md`.
  - *Agent Knowledge*: agentskills.io spec details (optional frontmatter fields, 3-level progressive disclosure, scripts-over-prose guidance).
- TUI `+`/`-` keys and web `run.setConcurrency` now PIN manual mode (auto-scale re-enabled with `A` / the web toggle). `--auto-scale` is deprecated (now the default; still accepted — with `--concurrency` it forces auto mode with that seed).
- `AutoScaleStatus` gains `mode`, `observedAgentMemoryMb`, `ramAvailableMb`, `guardKillCount`; `OrchestratorState.autoScale` is now always present.
- Positioning across READMEs, MANIFESTO, docs and package description: huu designs pipelines that make thinking agents follow a deterministic process — audits, test generation, knowledge extraction and predictable-value processes; NOT a tool for building new features.

### Deprecated

- `--auto-scale` flag (auto-scale is now the default), `AgentStatus.killedByAutoScaler`, lifecycle phase `killed_by_autoscaler` (kept so old manifests still parse; no longer produced).

### Fixed

- **macOS: the orchestrator could never spawn agents on a warmed-up host.** The resource monitor's host fallback used `os.freemem()`, which on macOS counts only truly-free pages (file cache excluded) — on any Mac in normal use that saturates `ramPercent` ≥95%, permanently gating `AutoScaler.shouldSpawn()` (runs sat forever with every card pending and $0 spent) and spuriously arming the memory guard. The darwin path now derives available memory from `vm_stat` reclaimable pages (free + inactive + purgeable + speculative — the macOS analogue of Linux's `MemAvailable`), cached 500ms, with `os.freemem()` as last resort. Also un-hung the orchestrator integration suite on macOS (16 chronic test timeouts → green, 42s → 6s).
- Guard-killed agents no longer park as `killed_by_autoscaler` errors in the DONE column — the card visibly returns to TODO with its requeue counter.
- Stale `killedByAutoScaler` status flag could swallow a requeued task's later genuine failure (silent drop — never retried, never counted, never marked error). Replaced by a consumable kill-marker set; regression-tested in `requeue.test.ts`.
- Auto-scaler active-agent accounting no longer inflates on retry/final-fail (it skewed the observed per-agent memory estimate).
- `npm run build && npm test` no longer runs the compiled `dist/**/*.test.js` twins in parallel with `src/` (vitest 4 dropped the dist exclude; the duplicated native-shim tests raced each other on port 3000). New `vitest.config.ts`.

## [1.3.0] - 2026-06-10

### Added

- **`Pipeline.integrationModelId`** — pipeline-level model override for the merge/integration agent (the conflict resolver that runs between stages). Falls back to the run's global model. Editable in the TUI pipeline editor (`T` → "Integration agent model", backed by the model selector) and in the web pipeline editor; documented in `docs/pipeline-json-guide.md`.
- **Merge cards on the kanban** — every stage visit now creates a `StageIntegration` entry (`OrchestratorState.stageIntegrations`, persisted to `manifest.stageIntegrations`) that both dashboards render as a display-only card flowing TODO → DOING → DONE (`pending → merging → conflict_resolving → done/error/skipped`), with live last-log, branches/conflicts counts, elapsed time and the effective integration model. The UI no longer looks frozen during `status: integrating`. TUI: `RunKanban`; web: new `IntegrationPill` molecule in `KanbanBoard`. The `conflict_resolving` state uses the AI color token (`theme.ai`); the deterministic merge stays cyan.
- **`huu Agent Knowledge` default pipeline** — studies the project progressively (recon → per-file deep study → topic synthesis, accumulating into `.huu/knowledge/atlas.md` + `findings.json`) and compiles the knowledge into Agent Skills under `.agents/skills/` following the [agentskills.io](https://agentskills.io/specification) spec: one skill per topic plus a `project-knowledge` router skill that any future agent loads first. A check step validates frontmatter/naming/router coverage and loops back to the materialize step on `rework` (max 3 runs; `approved` is the default outcome). Setup pipeline — mutates the repo by design.
- **`MANIFESTO.md` + `MANIFESTO.en.md`** — the project thesis ("deterministic in method, not in result", BSP over git), including an honest prior-art counterpoint section. Linked from both READMEs.

### Changed

- **Progressive knowledge protocol across the six bundled defaults** (new shared `src/lib/default-pipelines/knowledge-protocol.ts`): project-scope steps that previously acted blind now read the run's findings JSON before acting and append after (re-read + dedupe, append-only); findings gain optional `priority`/`fixability` fields that the final consolidation steps use to order recommendations; audit bootstraps gain a `.gitignore` persistence check (a committed `.huu/` line is rewritten to `.huu/*` + `!.huu/audits/` so reports survive the stage merge — previously they were silently dropped). Test Suite: step 2 records its 3 picks as a `category:"selection"` entry, step 3 builds on it instead of re-testing, step 4 closes the loop with a `category:"run-summary"` entry. Note: pipeline bootstrap is skip-if-exists, so already-materialized `pipelines/*.json` keep their old prompts — delete the file to re-materialize.
- `ensureGitignored()` now treats an existing `dir/*` line as satisfying `dir/`, so it no longer re-appends `.huu/` after a user adopts the negation pattern.

### Fixed

- `scripts/smoke-image.sh` / `scripts/smoke-pipeline.sh` now work on macOS with Docker Desktop/colima: the scratch repo moves from `mktemp -d` (which lands in `/var/folders/…`, outside the Docker VM's file sharing, so the bind mount arrived empty) to a `.smoke-tmp/` dir inside the huu repo itself (override with `HUU_SMOKE_TMPDIR`), and the path is normalized before being used as a `-v`/`-w` target (an unresolved `..` made git try to create the leading directories inside the container and fail with `Permission denied`).
- `scripts/smoke-pipeline.sh` drove `huu --stub run pipeline.json` expecting it to finish without keyboard input — but `huu run` is interactive by contract (it opens the pipeline editor and waits for `G`), so the smoke hung forever at the editor screen. It now drives the headless `huu auto pipeline.json --config config.json` path (stub backend) and asserts the final stdout JSON has `"ok": true` instead of the TUI-only `wait_until_exit_resolved` log event.
- **Guaranteed add/add merge conflict on `.env.huu` in fresh repos** — agent worktrees check out the *committed* `.gitignore`, so in any repo that hadn't committed the huu entries, every parallel agent committed its own `.env.huu`/`.huu-bin` (different ports → different content) and every stage merge conflicted (failing the run without a resolver, or burning an LLM call on a junk file with one). The orchestrator now writes these runtime-only paths to `.git/info/exclude` (shared by all worktrees, never touches tracked files). Found by exercising the new merge cards in a scratch repo.
- `scripts/smoke-dashboard.tsx` was broken since the backend registry refactor (imported the long-gone `orchestrator/stub-agent.js` and didn't pass `backend: 'stub'`, so the OpenRouter key probe 401-ed the run).
- `portAllocation` was silently stripped from pipelines on import/export round-trips (missing from the Zod schema).
- `huu Security Audit` step 5 told the agent to add a README badge while its own HARD RULES forbid it; `huu Quality Audit` step 1 allowed `package.json` devDeps additions against its own report-only rule; quality/performance step-5 names still said "+ badge". All report-only contracts are now consistent.
- Stray `console.*` output and Node deprecation warnings raised mid-run are now routed into the `LogArea` instead of printing above the kanban and corrupting the Ink layout.

## [1.2.0] - 2026-05-21

### Added

- **`huu auto <pipeline.json> --config <config.json>`** — ONE-COMMAND headless pipeline run. Drives the same `Orchestrator` the TUI uses but without Ink: parses the pipeline + a small config JSON (`modelId`, `backend`, per-step `files` override, optional timeouts/retries/concurrency), resolves the API key via the existing `resolveApiKey` chain, runs `await orch.start()` and exits 0 / 1 based on `manifest.status`. NDJSON progress events stream to stderr (throttled ~250 ms); ONE final JSON object lands on stdout (`{ ok, runId, integrationBranch, status, totalCost, durationMs, filesModified, agents[] }`) so `huu auto … | jq .runId` works. Inherits the auto-MTU docker network from 1.1.0 — works in VPN out of the box. Unblocks CI/cron use cases, demos, and unattended overnight runs.
- `src/lib/run-config.ts` — zod-validated `RunConfig` schema + `loadRunConfig(path)` + `applyRunConfig(pipeline, config) → { pipeline, warnings }`. The `files` map matches step names; mismatched keys emit warnings instead of failing so typos are surfaced without blocking.
- `src/lib/headless-run.ts` — `runHeadless({ pipeline, config, cwd, agentFactory, conflictResolverFactory, concurrency, emitIntervalMs })`. Reusable from scripts and the new CLI subcommand.

### Verification

End-to-end smoke against `/home/ondokai/Projects/integracao-vael` with `huu Test Suite` pipeline + config injecting one file into step 3: real `minimax/minimax-m2.7` agent ran inside the auto-MTU docker network, committed `huu-tests.md` to the integration branch — deterministic success marker (per step 1's prompt: "always writes huu-tests.md at repo root").

## [1.1.0] - 2026-05-21

### Added

- **Auto MTU-aware docker network** — the headline fix of this release. At wrapper start, `detectDefaultRouteMtu()` reads the MTU of the host's default-route interface (Linux only, parsing `ip route get 1.1.1.1` + `/sys/class/net/<iface>/mtu`); when it's below 1500 — typical of VPN tunnels (WireGuard 1420, Tailscale 1280, OpenVPN ~1500-overhead) — `ensureHuuDockerNetwork(mtu)` idempotently creates a docker bridge `huu-net-mtu<N>` with the matching MTU and pins the container to it via `--network=<name>`. No env var, no `/etc/docker/daemon.json` edit, no `--network=host` (which would break the port-isolation netns). Works whether the user is on a VPN or not — falls back cleanly to the default bridge when the route MTU is 1500 or detection isn't possible (macOS / Windows / Docker-Desktop VMs). The pre-1.1.0 behavior reproduced exactly the symptom in run `dtv2feyz`: 43 agents, all `tokens +0in +0out`, "Request timed out" on every retry — because the docker0 bridge (1500) was larger than a 1280-MTU VPN tunnel and silently dropped every TLS ClientHello. Post-fix on the same machine: pi agent against `minimax/minimax-m2.7` returns `+1786in +17out tokens` in 2.6 s.
- `HUU_DOCKER_NETWORK` env var, forwarded verbatim as `docker run --network=<value>`. Use case: explicit override of the auto-detection — force `host`, use a pre-existing user-managed network, or pin a name during testing. Auto-detection still runs when this is unset.
- Run-start network reachability probe (`checkOpenRouterReachable` in `src/lib/openrouter.ts`) that hits `/auth/key` with an 8 s `AbortController` before any agent spawns. Defense-in-depth backstop for exotic setups (outbound firewall, proxy misconfig) where MTU detection can't help. On `unreachable` inside a container, the error message includes copy-paste-friendly hints mentioning `HUU_DOCKER_NETWORK=host` and the `/etc/docker/daemon.json` MTU edit. Wired into `Orchestrator.start()`, gated on `config.backend === 'pi'` so stub / copilot runs aren't affected.

### Fixed

- Last pocket of Portuguese strings in error paths — `OpenRouter API key ausente. Defina OPENROUTER_API_KEY.` → `… missing. Set …`, `Model ID ausente.` → `Model ID missing.` (in both `pi/factory.ts` and `copilot/factory.ts`), and the project-recon "API key missing" log. The v1.1.0 release is now fully English in user-visible surfaces.
- Earlier in this cycle (folded in here): the v1.0.1 "English everywhere" pass had missed the welcome menu entries (`Assistente de pipeline`, `FAQ — perguntas frequentes`), every Pipeline Assistant stage (`pensando…`, `cancelar`, `enviar`, status line, free-text prompt, error screen), Project Recon (`Análise do projeto`, `Selecionando o que investigar`, `Falha no seletor`, `processos em paralelo`, `concluídos`), the Pipeline Editor per-card-timeout copy, Model Selector subtitle and legend, model catalog descriptions, and the `agent-env.ts` port-allocation prompt fed into agents.
- `example.pipeline.json` and `example.conditional.pipeline.json` translated to English so the on-disk samples match the README quick-start.
- README: Node badge bumped 18 → 20 (matches `engines.node`); `HUU_IMAGE` pin example refreshed; embedded `example.pipeline.json` snippet retranslated to English; new "On a VPN?" section in **Run with Docker** documenting the auto MTU network and override env var.
- `Dockerfile` builder stage copies the `webui/` workspace (`webui/package.json` before `npm ci`, full `webui/` tree before `npm run build`). Without this, `docker build` errored with `npm error No workspaces found: --workspace=webui` after the workspace was added at repo root in v1.0.1.
- webui workspace's strict-mode TypeScript build now passes: `domain-types.PromptStep` narrowed via `Extract<…, { prompt: string }>` so editor components keep accessing `prompt` / `files` type-safely; `PipelineCard` narrows `'files' in step`; `PipelineEditorPage` splits / recomposes work-vs-check steps at the boundary; new `webui/src/pages/FaqPage.tsx` + Router case satisfy the screen-FSM exhaustiveness check; unused `CheckOutcome` import removed from `pipeline-io.ts`.

## [1.0.2] - 2026-05-21

### Fixed

- Unblock `npm run build` by fixing the webui workspace's strict TypeScript pass: `domain-types.PromptStep` is now narrowed to the work-step shape (via `Extract<…, { prompt: string }>`) so `StepRow` / `StepEditor` keep accessing `prompt` and `files` type-safely. `PipelineCard` narrows `'files' in step` before summing, and `PipelineEditorPage` splits/recomposes work-vs-check steps at the boundary (check steps round-trip untouched on save). Drops the unused `CheckOutcome` import in `src/lib/pipeline-io.ts`.
- `Dockerfile` builder stage now copies the `webui/` workspace (`webui/package.json` before `npm ci`, full `webui/` tree before `npm run build`). Previously the workspace was added at the repo root but the Dockerfile only copied `src/`, so `docker build` errored with `npm error No workspaces found: --workspace=webui` once the build script started invoking `npm run build -w webui`.

### Added

- `webui/src/pages/FaqPage.tsx` + Router case for `screen.kind === 'faq'` — the FSM exposed an FAQ kind with no web-side counterpart, breaking the exhaustiveness check. The new page mirrors the TUI FAQ content and dispatches `faq.back` to return to the welcome screen.

## [1.0.1] - 2026-05-21

### Added

- **Five new bundled default pipelines** materialized by `pipeline-bootstrap` on first run, all framework-agnostic and report-only:
  - `huu Docs Audit` — Diátaxis classification + README quality scorecard + staleness scan + API-doc coverage.
  - `huu Quality Audit` — SonarSource-style cyclomatic / cognitive complexity, function/file size, parameter count, nesting depth, duplication (jscpd) and dead-code (depcheck / vulture / staticcheck).
  - `huu Performance Audit` — static N+1 / big-O / sync-I/O / memory hotspot scan plus Core Web Vitals (Lighthouse-CI) for frontends and Brendan Gregg's USE checklist for backends/CLIs.
  - `huu Refactor Plan` — Fowler smell catalog + Mikado-graph plan per target + Strangler-Fig hint, no code changes.
  - `huu Security Audit` — OWASP Top 10:2021 per-file scan (semgrep when available), gitleaks secret sweep, dependency CVE scan (npm audit / pip-audit / cargo audit / govulncheck / osv-scanner), CWE Top 25:2024-aligned remediation roadmap.
- `src/lib/default-pipelines/registry.ts` — single source of truth for the bundled catalog, consumed by `ensureAllDefaultPipelines()` in `pipeline-bootstrap`.
- `src/app.tsx` mount-time `useEffect` calls `ensureAllDefaultPipelines(repoRoot)` so the catalog actually materializes for end users (the bootstrap was previously dead code: callable from tests only).
- `scripts/smoke-defaults.sh` — verifies all 6 bundled defaults materialize, parse cleanly, and are idempotent on re-run. Run after `npx tsc` (or full `npm run build`).
- Registry-iterating test guards in `src/lib/pipeline-bootstrap.test.ts`: JSON-vs-TS drift (modulo `exportedAt`), exactly-one-default per CheckStep, no `$file` token in project-scope step prompts.
- Bundled-pipelines section in `README.md` and `docs/pipeline-json-guide.md` describing the strict report-only contract and the fan-out cap.
- Per-file step prompts in all 5 audit pipelines now carry an explicit SCOPE NOTE + SKIP RULE (skip `node_modules/`, `dist/`, `build/`, `vendor/`, `*.generated.*`, `*.d.ts`, lock/snapshot files, etc.) so users don't blow through `Pipeline.maxNodeExecutions` on generated trees.
- `PARALLEL_RULE_SHORT` exported from `src/lib/assistant-prompts.ts` and reused by the test, replacing a brittle inline regex.
- **Welcome-screen UI** — the `huu` wordmark now renders as 3D ASCII art, and the FAQ screen is reachable from the welcome menu via `?`.

### Changed

- **English everywhere.** The entire app now communicates in English: bundled pipeline prompts, the Pipeline Assistant interview prompt, the project-recon catalog and selector, file-suggestion prompt, FAQ screen, error messages, project-digest banners, assistant stubs (`assistant-client.ts`, `assistant-check-feasibility.ts`, `assistant-schema.ts`), and the root `AGENTS.md` (a.k.a. `CLAUDE.md` symlink). Old example pipelines `demo-rapida.pipeline.json` and `testes-seguranca.pipeline.json` renamed to `demo-quick.pipeline.json` and `security-tests.pipeline.json` with translated bodies.
- **Audit pipelines are now strict report-only.** They write exclusively to `.huu/audits/<topic>.md` and `.huu/audits/<topic>-faq.json` (working files under `.huu/audits/.tmp/`). They no longer mutate `README.md` (badges removed), `package.json`, lockfiles, or any production source. Tool installs are ephemeral only — `npx --yes`, `pipx run`, or vendored binaries under `$HOME/.huu/bin/`. Only `huu Test Suite` still touches production state (writes `huu-tests.md` + a tests badge — by design, it is a setup pipeline).
- `huu Refactor Plan` step 4 renamed and re-framed: it produces a STATIC Mikado-style dependency graph (we can't try-and-revert in report-only mode), and the report now states this honestly instead of implying empirical Mikado.
- `ensureDefaultPipeline` retained as a back-compat thin wrapper; new entry point is `ensureAllDefaultPipelines` which iterates the catalog and is idempotent per default.

### Removed

- `huu Test Suite` CheckStep "3.5 All tests green?" — the gate looped `failing → step 2` ("Test 3 representative files"), but failures actually surface from step 3 (per-file). The gate added LLM-judge cost without addressing the root cause; step 4's existing 3-iteration delete-failing-blocks logic is the correct circuit-breaker.
- `huu Security Audit` CheckStep "4.5 Critical findings present?" — both outcomes pointed to step 5, making it a no-op LLM call.

## [1.0.0] - 2026-05-20

### Added

- `huu --web` — alternate browser UI that mirrors the TUI 1:1 with a click-driven layout (Atomic Design + Tailwind). Real-time updates via WebSocket. Bind: 127.0.0.1 + UUID token. Companion flags: `--web-port=<n>`, `--no-open`, env `HUU_WEB_NO_OPEN=1`. Phase 1 requires `--yolo` (Docker port-publishing pending).
- `src/lib/screen-fsm.ts` — pure FSM extracted from `src/app.tsx`; consumed by both the Ink TUI and the new web session.
- `webui/` workspace — Vite + React + TypeScript + Tailwind front-end (Atomic Design: 11 atoms, 10 molecules, 9 organisms, 3 templates, 15 pages).
- `scripts/smoke-web.sh` — fast-port smoke test for the web mode.
- **Conditional pipeline steps with LLM-judged routing.** Pipelines
  can now include `CheckStep` nodes — decision points whose verdict is
  produced by an LLM judge agent with full shell access running in the
  integration worktree. Checks evaluate a natural-language `condition`
  (with `$runs` token substitution for iteration counting) and route to
  one of their declared `outcomes`, enabling forward jumps, loops back
  to earlier steps, and branching. **The integration worktree is never
  rewound** — loops re-execute the target step on top of the current
  HEAD, accumulating commits. Schema bumped to `huu-pipeline-v2`
  (v1 still accepted; the `type` field is optional on work steps for
  back-compat). New safety nets: `Pipeline.maxNodeExecutions` (default
  50) caps total node visits per run; `CheckStep.maxRuns` (default 5)
  caps per-check revisits; the `default: true` outcome (exactly one
  required) fires on judge failure / unknown label / cap overflow.
  New files: `src/orchestrator/check-evaluator.ts` (judge spawner,
  reserved agentId 9998), `src/lib/assistant-check-feasibility.ts`
  (setup-time LangChain feasibility analysis producing an
  `instructionDraft`), `src/ui/components/CheckStepEditor.tsx` (TUI
  subform with embedded `OutcomesEditor`, `theme.ai` magenta).
  PipelineEditor gains the `C` shortcut for new check steps.
  Schema (`pipeline-io.ts`) gains topology validation: unique names,
  reference validity, default-outcome presence. Orchestrator's linear
  stage loop replaced with a graph cursor state machine; `RunManifest`
  gains `executionTrace`. Full reference in
  [`docs/pipeline-json-guide.md`](docs/pipeline-json-guide.md#conditional-steps-check-nodes);
  example: [`example.conditional.pipeline.json`](example.conditional.pipeline.json).

### Internal

- Extracted `StateCoalescer` (`src/web/orchestrator-bridge.ts`) — reusable 8 Hz state coalescer for the WS broadcast path.
- `Screen['model-selector']` now carries `backendKind`, replacing the front-end's hardcoded `'pi'` assumption in `ModelSelectorPage`.

### Added (Docker / persistence)

- **Saved pipelines now survive `docker run --rm`.** The wrapper
  (`src/lib/docker-reexec.ts`) bind-mounts the host's `~/.huu` (and
  `~/Downloads` when present) into the container at the same absolute
  path, and forwards `HUU_HOST_HOME` so the in-container code resolves
  pipeline memory, global pipelines, model recents, and the default
  export Downloads target to the host filesystem. Before this, every
  "Save pipeline" inside Docker wrote to the container's ephemeral
  `$HOME` and was lost on exit; the saved-pipelines list reopened empty.
  A new helper `src/lib/huu-home.ts::getHuuHome()` reads `HUU_HOST_HOME`
  and falls back to `homedir()` for native runs (`--yolo`,
  `HUU_NO_DOCKER`, native-only subcommands) — no behavior change there.
  `compose.yaml` and the `huu init-docker` scaffold templates
  (`compose.huu.yaml`, `scripts/huu-docker`) mirror the new mount + env
  so all entry points are consistent.

### Fixed

- **Agent execution and observability hardening.** Surgical fixes across the
  orchestrator, backends, git layer, and logging stack to close gaps that
  silently corrupted state or hid failures from operators:
  - `Orchestrator.abort()` now tracks each `agent.dispose()` promise and
    `start()`'s `finally` block awaits all in-flight `dispose`/`finalize`
    work with a 5s grace period before resolving — previously the
    `void agent.dispose()` fire-and-forget let the run "complete" while
    subprocess teardown raced with the next run's worktree creation.
  - `finalizeAgent` is now wrapped in a tracked promise with a `.catch`
    that surfaces unhandled errors instead of yielding a silent process-1
    exit. `dlog` calls now bracket `git.hasChanges`, `commit`, and
    worktree removal so post-mortem can tell where finalize broke.
  - Integration worktree teardown moved into `start()`'s `finally` block,
    eliminating the orphan worktree+branch that previously leaked when
    a stage threw mid-run.
  - `WorktreeManager.createIntegrationWorktree` / `createAgentWorktree`
    now roll back the orphan branch when `git worktree add` fails. Without
    this, a retried run hit "branch already exists" forever.
  - `GitClient.merge()` returns an explicit `error` field carrying the
    underlying git stderr — previously a failed conflict-probe was
    smuggled into `conflicts[]`, where callers treated the error string
    as a file path and tried to spawn an LLM resolver against it.
  - `mergeAgentBranches` emits per-branch `dlog` entries (`merge.attempt`,
    `merge.ok`, `merge.conflict`, `merge.stage_end`) so "which branch
    introduced the conflict?" is answerable post-run.
  - `lib/openrouter.ts` capability cache is now keyed by API key. The
    previous global cache silently served keyA's view of the model
    catalog to keyB on multi-tenant / BYOK swaps.
  - `lib/active-run-sentinel.ts` records the writer PID alongside the
    cwd; new `probeActiveRunLiveness()` answers "is that PID still
    alive?" so stale sentinels (process killed before exit handler ran)
    can be detected. Format is forward-compatible with the legacy
    single-line cwd reader the HEALTHCHECK shell uses.
  - `lib/debug-logger.ts` now redacts API-key-shaped substrings
    (`sk-or-`, `sk-ant-`, `ghp_`, Bearer headers) before any structured
    field reaches disk. `lib/run-logger.ts` applies the same redaction
    when rendering the chronological + per-agent log files.
  - `LogEntry` gained `runId`, `stageIndex`, `stageName`, `kind`
    (`'orchestrator' | 'integrator' | 'worker' | 'system'`). Every
    orchestrator-emitted log line is enriched with current run/stage
    context — log aggregation can finally pivot across runs.
  - New `usage` AgentEvent variant carries structured token / cost
    telemetry. Both pi and copilot mappers emit it alongside the
    human-readable log line; the orchestrator accumulates it into
    `AgentStatus.tokensIn/Out/cacheRead/cacheWrite/cost`. Per-agent
    token reporting in the run log is no longer always zero.
  - `safe-terminal.ts` now emits a structured `signal.safe_exit` /
    `error.safe_uncaught` debug event with a process snapshot
    (active handles, RSS, uptime) before exit. Diagnosing "what was
    huu doing when SIGINT hit?" no longer requires guessing.

- **Running `huu` from inside a git worktree (or a subdirectory of a repo) no
  longer fails with "not a git repository" after the Docker pull.** The wrapper
  now runs a host-side git preflight (`lib/git-preflight.ts`) BEFORE re-execing
  into the container, so a missing repo fails fast without a wasted image pull.
  When the preflight detects that `--git-common-dir` (worktree case) or
  `--show-toplevel` (subdirectory case) live outside cwd, those paths are added
  as additional same-path bind mounts so the worktree's `.git` file resolves
  identically inside the container. The in-container `ensureGitRepoOrExit`
  remains as a defensive backup for `--yolo`/native runs.

### Added

- **Recommended model catalog refreshed + Artificial Analysis enrichment in the picker.**
  - Removed `deepseek/deepseek-v3.2`. Added `deepseek/deepseek-v4-pro`,
    `deepseek/deepseek-v4-flash`, and `xiaomi/mimo-v2.5-pro`. Existing
    entries (`minimax/minimax-m2.7`, `moonshotai/kimi-k2.6`, `z-ai/glm-5.1`,
    `google/gemini-3.1-pro-preview`, `openai/gpt-5.4-mini`, `openai/gpt-5.4`)
    were retained.
  - Each catalog entry now carries `description`, `bestFor` (use-case tags:
    `coding` / `reasoning` / `agentic` / `fast` / `cheap` / `general`), and
    `tier` (`flagship` / `workhorse` / `fast`). The fields are optional on
    the schema for retrocompatibility but populated for every recommended
    entry.
  - The quick model picker renders a fixed-width table — `Model · tok/s ·
    Agnt · Code · Razn · $in/$out · BestFor` — with metrics pulled from
    Artificial Analysis when `ARTIFICIAL_ANALYSIS_API_KEY` is set. Without a
    key the columns degrade to `—` placeholders without blocking selection.
    "More models..." also forwards the AA key so both views share the data
    source.
  - The pipeline-assistant prompt now lists each model's description and
    bestFor tags inline, plus a "modelo recomendado por cenário" matrix so
    the assistant picks `modelId` per step against the scenario rather than
    a flat preference list.
- **Project recon stage in the pipeline assistant.** Before the assistant
  starts asking questions, it now fires four MiniMax M2.7 agents in
  parallel — `stack`, `structure`, `libraries`, and `conventions` — each
  with its own loader and its own focused mission. Their findings are
  aggregated into a "Contexto do projeto" section injected into the
  assistant's system prompt, so the interview can ask project-specific
  questions instead of generic ones.
  - Errors are isolated per agent: if one times out or fails to parse,
    the other three still complete and the assistant proceeds with
    whatever context survived.
  - Stub mode (`apiKey === "stub"` / `HUU_LANGCHAIN_STUB=1`) returns
    canned bullets so smoke tests never touch the network.
  - `ESC` during recon goes back to the intent prompt (no
    confirm dialog — there's no user work to lose).

## [0.3.1] - 2026-04-29

### Added

- **Step `scope` field.** Each pipeline step now declares whether it runs
  on the **whole project** (`scope: "project"`), **once per file**
  (`scope: "per-file"`), or is left **flexible** (`scope: "flexible"`,
  also the default when `scope` is omitted). The Step Editor shows a
  Scope row above Files; cycle with `ENTER` or jump with `P`/`F`/`X`.
  - `project` locks the Files row to "whole project" — `F`/`W` are
    disabled and pressing `ENTER` is a no-op.
  - `per-file` makes file selection mandatory, and pressing `ENTER` on
    the Files row opens the picker (in addition to `F`).
  - `flexible` keeps the previous behavior (`F` to pick, `W` for whole
    project).
  - Loading older `huu-pipeline-v1` JSON without the `scope` field is
    fully back-compatible — those steps behave as `flexible`.

## [0.3.0] - 2026-04-29

Initial public release. Available on npm as `huu-pipe`
(`npm install -g huu-pipe`) and as a container image at
`ghcr.io/frederico-kluser/huu:latest`.

### Features

- **Auto-Docker re-exec.** Typing `huu` in any folder transparently
  mounts that folder into the official container and runs there — the
  LLM agent never sees host-side `~/.ssh`, `~/.aws`, or `~/.npmrc`
  tokens. Set `HUU_NO_DOCKER=1` for native execution (development).
- **Subcommands:** `huu run`, `huu init-docker`, `huu status`,
  `huu prune`.
- **Bundled reference pipelines** at `$HUU_COOKBOOK_DIR`
  (`/opt/huu/cookbook/`) — usable without cloning the repo.
- **Configurable via** `HUU_IMAGE`, `HUU_NO_DOCKER`,
  `HUU_DOCKER_PASS_ENV`, `HUU_WORKTREE_BASE`,
  `OPENROUTER_API_KEY_FILE`.

### Security

- `OPENROUTER_API_KEY` delivered via bind-mounted file at
  `/run/secrets/openrouter_api_key` (mode `0600`); never appears in
  `docker inspect` or `ps auxf`.
- Container UID/GID matched to host user via
  `--user "$(id -u):$(id -g)"`.
- `safe.directory '*'` set system-wide in the image.


[Unreleased]: https://github.com/frederico-kluser/huu/compare/v6.0.0...HEAD
[6.0.0]: https://github.com/frederico-kluser/huu/compare/v5.2.0...v6.0.0
[5.2.0]: https://github.com/frederico-kluser/huu/compare/v5.1.0...v5.2.0
[5.1.0]: https://github.com/frederico-kluser/huu/compare/v5.0.0...v5.1.0
[5.0.0]: https://github.com/frederico-kluser/huu/compare/v4.0.0...v5.0.0
[4.0.0]: https://github.com/frederico-kluser/huu/compare/v3.1.0...v4.0.0
[3.1.0]: https://github.com/frederico-kluser/huu/compare/v3.0.0...v3.1.0
[3.0.0]: https://github.com/frederico-kluser/huu/compare/v2.1.0...v3.0.0
[2.1.0]: https://github.com/frederico-kluser/huu/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/frederico-kluser/huu/compare/v1.4.0...v2.0.0
[1.4.0]: https://github.com/frederico-kluser/huu/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/frederico-kluser/huu/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/frederico-kluser/huu/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/frederico-kluser/huu/compare/v1.0.2...v1.1.0
[1.0.2]: https://github.com/frederico-kluser/huu/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/frederico-kluser/huu/releases/tag/v1.0.1
[0.3.1]: https://github.com/frederico-kluser/huu/releases/tag/v0.3.1
[0.3.0]: https://github.com/frederico-kluser/huu/releases/tag/v0.3.0

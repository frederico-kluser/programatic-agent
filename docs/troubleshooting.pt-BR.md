# Resolvendo problemas (Troubleshooting)

> Todo erro fatal de run no huu carrega um **motivo acionável** — aparece na
> tela de summary vermelha, no JSON final do headless (`errorReason`) e no
> log do run. Esta página expande cada modo de falha: sintoma → causa → ação.
>
> English: [troubleshooting.md](troubleshooting.md)

## Onde olhar primeiro

| Superfície | O que ela diz |
|---|---|
| **Tela de summary** | Vermelha = o run falhou (a linha ⚠ é a causa raiz + próximo passo). Amarela = run terminou mas agentes falharam (primeira falha exibida). Verde = limpo. |
| **Dashboard do run** | `ENTER` num card abre o log completo dele. `F` filtra a coluna de logs por agente. |
| `.huu/debug-*.log` | Log NDJSON do processo inteiro (secrets redigidos). |
| `.huu/<stamp>-execution-<runId>.log` | Log completo do run + splits por agente. |
| JSON final do headless | `ok`, `status`, `errorReason`, `state`/`error` por agente. Exit code ≠ 0 em falha. |

## Falhas de preflight (o run nem começa)

| Sintoma | Causa → ação |
|---|---|
| `not a git repository` | O huu roda SOBRE um repo. `git init` primeiro (o huu oferece). |
| erro de permissão de push no início | O preflight testa push quando `HUU_CHECK_PUSH` exige. Ajuste remote/credenciais, ou desligue o probe em repos offline. |

## API keys & modelos

| Sintoma | Causa → ação |
|---|---|
| prompt de key em loop / `401` nos logs | A cadeia é `/run/secrets/<nome>` → `~/.config/huu/config.json` (key salva) → `<VAR>_FILE` → env → prompt da TUI (vence a primeira não-vazia). Salve uma no Options, ou exporte `OPENROUTER_API_KEY` (ou a var do backend), e tente de novo. |
| **key *válida* ainda dá `401`** | A key salva no Options tem precedência sobre a env var, então um `401` normalmente quer dizer que a key *salva* foi rejeitada. Conserto mais fácil: abra o **⚙ Settings → OpenRouter API key** da web, cole uma key que funciona e **Validate & save** — ela é checada contra o OpenRouter antes (key rejeitada nunca é salva), passa a valer pra todo run novo na hora (Docker incluso) e persiste; o **clear saved key** ali volta pra env var. A mensagem de 401 nomeia a fonte que REALMENTE forneceu a key rejeitada (aba do navegador / Options da web / store salvo / env var), e cada evento de key + run é logado no terminal que iniciou o huu. Confirme qual key está morta com `curl -H "Authorization: Bearer <key>" https://openrouter.ai/api/v1/auth/key` (um `401` aí = essa key está ruim). Key colada no *formulário de launch* (diferente do ⚙ Settings) fica só naquela aba. |
| `402` / `429` nos logs | Créditos/rate-limit do provedor — não é falha do huu. Modelo mais barato ou aguarde. |
| model id rejeitado | Use um id do seletor/catálogo (`recommended-models.json`); ids da OpenRouter têm a forma `vendor/model-name`. |

## Agentes: timeouts, retries, falhas

- Cada card tem `maxRetries` (default 1) tentativas em worktree novo; timeout
  aborta a requisição em voo antes do retry.
- **Sintoma: cards morrem em exatamente N minutos** → suba os timeouts por
  card nas settings da pipeline (`T` no editor): whole-project e single-file
  são separados.
- **Sintoma: agente em erro após retries** → o ⚠ amarelo da summary mostra a
  primeira falha; abra o card (`ENTER`) para o log completo. O run ainda
  mergeia todo agente que COMMITOU.
- **Re-tente um card que falhou** → quando um run termina com cards em erro ele
  pausa em **`awaiting_retry`** (pill de status **review**, âmbar) em vez de
  pular pra summary, mantendo o worktree de integração vivo. Um **timeout**
  aparece em âmbar (`TIMEOUT`/`timeout`), qualquer outra falha em vermelho
  (`FAILED`/`failed`).
  - **TUI**: foque o card, **`R`** re-tenta (um timeout pede um novo tempo
    limite antes), **`D`** finaliza, **`Q`** aborta.
  - **Web**: clique no card vermelho/âmbar → botão **Retry** no drawer (timeout
    ganha um campo de minutos); **Finish** sai do modo review.
  - O card roda de novo sobre o HEAD atual da integração e, se passar, é
    mesclado — sem re-rodar o pipeline inteiro. Retries do usuário mostram um
    badge `⟳N`. (Só TUI de execução única e qualquer run web; o dashboard
    multi-run não tem retry por card.)
- **Sintoma: cards voltam pro TODO com `↻N`** → não é erro: o memory guard
  matou o agente mais novo sob pressão de RAM e re-enfileirou.

## Web UI: um run parece travado / o board ao vivo parou de atualizar

O navegador roda um **watchdog de liveness SSE** — um heartbeat `event: ping`
de verdade mais detecção de staleness de 60 segundos que FORÇA A RECONEXÃO de
um stream SSE zumbi e ressincroniza o board SEM um refresh manual da página,
então um board momentaneamente travado deve se auto-curar em ~60s.

Se você DER refresh na página no meio da fila, a fila de projetos SOBREVIVE ao
reload: ela persiste o status + `runId` de cada run (localStorage
`huu-queue-v2`) e RE-LINKA aos runs ainda vivos no processo huu em vez de
resetá-los pra "pending". O run em si vive no processo huu, não no navegador —
fechar ou recarregar a aba nunca o para; só **Stop** ou sair do `huu`
(Ctrl+C) para.

## Conflitos de merge {#merge-conflicts}

`stage integration failed: unresolved merge conflicts` — agentes paralelos
editaram as mesmas linhas numa stage.

1. Estreite a superfície de escrita de cada task: prompts per-file devem
   escrever SÓ no `$file`; steps project que dividem arquivos com um ramo
   paralelo pertencem a ondas diferentes (`dependsOn`).
2. Configure `pipeline.integrationModelId` com um modelo mais forte — o
   resolvedor de conflito é um agente LLM.
3. O **backend stub nunca resolve conflito** por design (um run sem LLM não
   pode shipar um merge ruim em silêncio): dry-runs estruturais precisam de
   pipelines sem sobreposição.

## Arquivos de memória (`scope: "memory"`)

| Sintoma | Causa → ação |
|---|---|
| stage completou com **0 tasks** + warning | O arquivo não estava no `filesFrom` do worktree de integração. Legítimo quando o produtor não achou nada; senão, confira o path (typo?) e se a stage do produtor commitou o arquivo. |
| run falha com `is not valid JSON` / `does not match huu-memory-v1` | O produtor escreveu arquivo malformado. Declare `produces` nele para o huu appendar o contrato exato de formato — ou cole o formato no prompt. Veja [memory-scope.pt-BR.md](memory-scope.pt-BR.md). |
| menos agentes que entradas | Leia os warnings: paths inexistentes / duplicados / na skip-list / escapando são descartados um a um; o corte do `maxFiles` é logado. |

## Loops desgovernados {#runaway-loop}

`pipeline exceeded maxNodeExecutions=N`:

- **Pipelines lineares (legado)**: um check cujo outcome escolhido aponta
  PARA TRÁS re-executa o trecho para sempre. Faça o outcome SEGURO ser o
  `default: true` (para frente) e limite o check com `maxRuns`.
- **Pipelines DAG (ondas)**: um outcome/`next` re-pendura o alvo e todo o
  cone abaixo a cada disparo. Mesma correção — defaults para frente,
  `maxRuns` limitado — ou suba `pipeline.maxNodeExecutions` se o orçamento
  de rework for genuinamente maior.

## Judges (check steps)

- Badge amarelo **DEFAULT** num card de judge = o fallback disparou (judge
  falhou, label desconhecida ou `maxRuns`) — o run tomou o outcome
  `default: true`. Escreva condições objetivamente checáveis ("arquivo X
  existe e seção Y não-vazia"), não vibes.
- Judges rodam no worktree de integração com shell; o último bloco JSON
  (`{ "label": ..., "reason": ... }`) é o veredito.

## Portas (`EADDRINUSE`, shim)

- Agentes paralelos ganham janelas de porta disjuntas (base 55100) via
  `.env.huu` + shim `with-ports` — mas só para processos lançados ATRAVÉS de
  `.huu-bin/with-ports`. Servidor que ainda binda a porta original não foi.
- `HUU_PORT_DEBUG=1` loga cada remap. Limites de cobertura (Go estático,
  Rust musl, binários sob SIP): [PORT-SHIM.md](PORT-SHIM.md).

## Estado do git {#git-state}

- `cannot read integration HEAD` → sobras de um run anterior no caminho.
  `huu prune` mata containers órfãos e limpa estado velho; deletar
  `.huu-worktrees/<runId>/` na mão é seguro (branches sobrevivem como
  artefatos).
- Branches de run (`huu/<runId>/...`) são artefatos de propósito — delete
  com git normal quando terminar a revisão.

## Docker

| Sintoma | Causa → ação |
|---|---|
| mudanças no próprio huu não fazem efeito | Um `huu` global re-executa na imagem PUBLICADA. Itere com `scripts/huu-try` (sempre builda + roda `huu:local` via Docker; `--no-build` pula o build), ou `docker build -t huu:local . && HUU_IMAGE=huu:local huu …`. Desenvolvendo NO repo, `npm start` / `npm run dev:docker` RE-BUILDAM `huu:local` antes (`scripts/ensure-image.sh`, cache de layers ~2s) pra você nunca rodar código velho já embutido na imagem; defina `HUU_IMAGE=<other>` pra pular o rebuild como pin deliberado. Pro loop rápido, `npm run dev` (`HUU_DEV_NATIVE=1`) roda no host sem Docker nenhum — não tem imagem pra envelhecer, mas também não tem isolamento de container. (`HUU_NO_DOCKER=1` é uma porta DIFERENTE — o bypass nativo de usuário — e ela funciona; veja [operations.pt-BR.md](operations.pt-BR.md#docker-por-padrão-nativo-como-opt-in).) |
| containers órfãos após crash | `huu prune` (usa os cidfiles gravados). |
| rede trava na VPN | O huu auto-cria bridge com MTU casado; override com `HUU_DOCKER_NETWORK`. |
| runner de CI sem Docker | O huu é docker POR PADRÃO, não docker-only: rode com `--no-docker` / `HUU_NO_DOCKER=1` pra ir nativo em vez disso (perde o teto de memória do container), ou use um runner/job docker-enabled pra manter o teto; receitas em [ci.pt-BR.md](ci.pt-BR.md). |

## macOS: runs parados para sempre a $0 (corrigido)

Versões anteriores ao fix do `vm_stat` nunca spawnavam agentes em Mac
aquecido: `os.freemem()` conta só páginas realmente livres, o RAM% saturava
≥95% e o auto-scaler travava o pool para sempre (status `running`,
activeAgents 0, custo $0). Atualize o huu; o monitor agora deriva memória
disponível das páginas recuperáveis do vm_stat.

## Abortando

`Q` no dashboard aborta o run (duas vezes força a saída da tela). Trabalho
mergeado permanece; agentes em voo são descartados; cards pending/merging
são varridos para `error: aborted` para nada ficar no TODO eternamente.

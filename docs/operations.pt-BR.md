# Operações · `huu`

> **English:** [docs/operations.md](operations.md)

Como rodar o `huu` em ambientes tipo-produção — modos Docker,
configuração, auto-scaling, controle de custo, isolamento de portas,
FAQ, roadmap.

## Sumário

- [Docker](#docker)
  - [Lifetime e sinais](#lifetime-e-sinais)
  - [Tratamento de VPN / MTU](#tratamento-de-vpn--mtu)
  - [Modo isolated-volume](#modo-isolated-volume)
  - [Compose](#compose)
  - [Docker secrets](#docker-secrets)
  - [Variantes de imagem](#variantes-de-imagem)
  - [Cookbook na imagem](#cookbook-na-imagem)
  - [Docker por padrão, nativo como opt-in](#docker-por-padrão-nativo-como-opt-in)
- [Configuração](#configuração)
  - [Registry de API keys](#registry-de-api-keys)
  - [Variáveis de ambiente](#variáveis-de-ambiente)
  - [Arquivos escritos pela ferramenta](#arquivos-escritos-pela-ferramenta)
  - [Modelos recomendados](#modelos-recomendados)
- [Concorrência com auto-scaling](#concorrência-com-auto-scaling)
  - [Guarda de memória: a escada de pressão](#guarda-de-memória-a-escada-de-pressão)
  - [Tetos de memória no kernel](#tetos-de-memória-no-kernel)
- [Previsibilidade de custo](#previsibilidade-de-custo)
- [Isolamento de portas (visão geral)](#isolamento-de-portas-visão-geral)
- [Convenções visuais](#convenções-visuais)
- [FAQ](#faq)
- [Roadmap](#roadmap)
- [Contribuindo](#contribuindo)

---

## Docker

`huu` roda em Docker por padrão — suas credenciais de shell, `~/.ssh`
e `~/.aws` nunca ficam visíveis pro agente LLM. O caminho recomendado é
**buildar a imagem do source** (zero dependência de registry,
reprodutibilidade total):

```bash
git clone https://github.com/frederico-kluser/huu
cd huu
docker build -t huu:local .
HUU_IMAGE=huu:local huu run pipeline.json
# ou: docker run --rm -it --user "$(id -u):$(id -g)" \
#       -v "$PWD:$PWD" -w "$PWD" -e OPENROUTER_API_KEY \
#       huu:local run pipeline.json
```

Imagens pré-buildadas são publicadas manualmente pelo maintainer em
`ghcr.io/frederico-kluser/huu:<version>`. Se uma tag está disponível, o
wrapper puxa automaticamente:

```bash
export OPENROUTER_API_KEY=sk-or-...
huu run pipelines/huu-test-suite.pipeline.json     # usa ghcr.io/frederico-kluser/huu:latest
```

> O huu materializa os pipelines default empacotados em `./pipelines/` no
> primeiro launch — escolha um na tela de boas-vindas ou passe o caminho.

Por baixo dos panos, o wrapper monta o equivalente a:

```bash
docker run --rm -it \
  --cidfile /tmp/huu-cids/cid-<pid>-<rand>.id \
  --user "$(id -u):$(id -g)" \
  -v "$PWD:$PWD" -w "$PWD" \
  -e OPENROUTER_API_KEY \
  ghcr.io/frederico-kluser/huu:latest run pipelines/huu-test-suite.pipeline.json
```

> **Por que montar `$PWD:$PWD` (mesmo path nos dois lados)?** git
> armazena paths absolutos dentro de `.git/worktrees/<name>/gitdir`.
> Montar sob um prefixo diferente deixaria ponteiros de worktree
> visíveis no host que apontam pra lugar nenhum quando o container
> termina.

### Lifetime e sinais

Lifetime é vinculado ao seu terminal. Ctrl+C, fechar o terminal
(SIGHUP) e `kill` (SIGTERM) param o container de forma confiável. O
wrapper captura cada sinal no processo host e emite
`docker kill --signal …` contra o cidfile capturado, contornando o
bug antigo [moby#28872](https://github.com/moby/moby/issues/28872)
onde `docker run -it` às vezes perde sinais a caminho do container.
Dentro do container, [tini](https://github.com/krallin/tini) (PID 1)
forwarda o sinal pro processo Node do huu, os exit handlers da TUI
rodam, e `--rm` remove o container.

Se o wrapper for morto hard (`kill -9`, OOM), a próxima invocação do
`huu` poda containers órfãos cujo parent PID registrado não está mais
vivo. Use `huu prune --list` pra inspecionar containers huu
remanescentes, `huu prune --dry-run` pra ver o que seria limpo, e
`huu prune` pra forçar kill.

### Tratamento de VPN / MTU

**Em VPN (WireGuard / OpenVPN / Tailscale exit-node)? Simplesmente
funciona.** Na inicialização do wrapper, o huu inspeciona o MTU da
rota default do host (no Linux). Quando está abaixo de 1500 — típico
de túneis VPN — o huu auto-cria uma bridge docker chamada
`huu-net-mtu<N>` com o MTU correspondente e roda o container nela. Sem
env var, sem editar daemon.json, sem `--network=host`. A rede é
idempotente e reusada entre execuções; se seu MTU de VPN mudar, uma
nova rede por-MTU é criada da próxima vez.

Pra override (ex.: forçar networking `host` ou usar uma rede customizada
pré-existente), set `HUU_DOCKER_NETWORK=<value>` — passado verbatim pro
`docker run --network`. Pra inspecionar o que o huu criou:
`docker network ls | grep huu-net-`.

Por que isso importa: sem o clamping de MTU, a discrepância entre
docker bridge (1500) > túnel (~1420) silenciosamente derruba pacotes
TLS ClientHello, e todo handshake HTTPS trava. Como defense-in-depth,
o orchestrator também roda uma sonda de alcance OpenRouter de 8s no
início e aborta com clareza se upstream estiver inalcançável, então
você nunca queima 30 minutos em loops de retry.

### Modo isolated-volume

Pra performance máxima em macOS / Windows com isolamento completo de
filesystem: diga ao huu pra colocar os worktrees num volume nomeado em
vez de dentro do repo bind-montado. Operações de branch ficam no repo
(então o branch de integração ainda cai no seu `git log` local); só o
scratch space por-agente vai pro volume rápido.

```bash
docker volume create huu-worktrees
docker run --rm -it \
  --user "$(id -u):$(id -g)" \
  -v "$PWD:$PWD" -w "$PWD" \
  -v huu-worktrees:/var/huu-worktrees \
  -e HUU_WORKTREE_BASE=/var/huu-worktrees \
  -e OPENROUTER_API_KEY \
  ghcr.io/frederico-kluser/huu:latest run pipeline.json
```

`HUU_WORKTREE_BASE` aceita path absoluto (usado verbatim) ou path
relativo ao repo (resolvido contra a raiz). Quando setado,
`git worktree list` no host não vai mostrar os worktrees por-agente
ativos durante a execução — esse é o trade-off pelo speedup.

### Compose

```bash
# usa o compose.yaml do repo (compila a imagem na primeira execução)
export OPENROUTER_API_KEY=sk-or-...
docker compose run --rm huu run pipelines/huu-test-suite.pipeline.json
```

**Wrapper de conveniência:** jogue [`scripts/huu-docker`](../scripts/huu-docker)
no seu `PATH` pra abreviar pra `huu-docker run pipeline.json`.

### Docker secrets

O wrapper auto-Docker cuida do `OPENROUTER_API_KEY` de forma segura:
escreve a key num arquivo modo `0600` sob `/dev/shm` (tmpfs do Linux —
nunca chega no disco; cai pra `os.tmpdir()` em outros lugares) e
bind-monta read-only em `/run/secrets/openrouter_api_key` dentro do
container. O valor da key nunca aparece em `docker inspect`, nunca
aparece em `ps auxf`, e é unlink do host assim que o wrapper termina.

Pra setups Compose, o pattern canônico funciona:

```yaml
# trecho do compose.yaml
services:
  huu:
    secrets:
      - openrouter_api_key
secrets:
  openrouter_api_key:
    file: ./openrouter.key  # ou external: true com `docker secret create`
```

A imagem checa `/run/secrets/openrouter_api_key` antes de cair pra
`OPENROUTER_API_KEY_FILE` e por fim a env var simples — mesma
precedência que a imagem do postgres usa.

### Variantes de imagem

- `huu:latest` (~613MB) — traz `openssh-client` pra remotes git via SSH.
- `huu:slim` (~604MB; build-arg `INCLUDE_SSH=false`) — sem isso, pra
  setups só-HTTPS.

### Cookbook na imagem

A imagem oficial traz os pipelines de referência do repo em
`$HUU_COOKBOOK_DIR` (`/opt/huu/cookbook/`). Puxe um pipeline curado pro
seu repo sem clonar nada:

```bash
docker run --rm ghcr.io/frederico-kluser/huu:latest \
  cookbook pull huu-test-suite > my-test-pipeline.json
```

### Docker por padrão, nativo como opt-in

Toda execução de pipeline roda dentro do container **por padrão**, que
carrega o teto de memória do kernel (`--memory`) e isola o alcance do
agente das suas credenciais de shell. Os bypasses nativos (`--yolo`,
`--no-docker`, `HUU_NO_DOCKER=1`) são honrados, não removidos: o CLI os
detecta e roda o processo inteiro no host em vez de re-executar no
Docker — perdendo as duas garantias em troca, por isso imprime um
aviso de uma linha em toda execução assim. `--docker` é a flag espelho:
força o container nessa execução mesmo com um runtime `native` salvo.
Essa escolha salva é a outra fonte de uma execução nativa — o `huu
setup` (rodado automaticamente no primeiro `npm start`, ou sob demanda)
pergunta qual runtime você quer e persiste em
`~/.config/huu/config.json`; a ordem completa é **flag > env > config
salva > default**, então uma flag ou env desta execução sempre vence o
que foi salvo. O que ainda roda no host independente do runtime não é
execução de pipeline: `huu --help` e os utilitários de host (`huu
init-docker`, `huu status`, `huu prune`). Dentro do container,
`HUU_IN_CONTAINER=1` (setada pela imagem) segue sendo o curto-circuito
interno que impede o mesmo binário de se embrulhar de novo.

A única exceção é pra quem desenvolve O huu: `HUU_DEV_NATIVE=1` (o que o
`npm run dev` seta) roda o CLI no host, sem daemon nenhum, pro loop
edição→execução não pagar um `docker build` + `docker run` a cada poucos
segundos. É só env, nunca flag, e o CLI imprime um banner ruidoso em todo
start porque o isolamento do container e o teto de memória do container estão
ambos ausentes — no Linux o self-wrap do systemd fornece um teto de kernel,
no resto sobra só a guarda de software. O `npm run dev:docker` é o mesmo hot
reload via Docker, e é o que você deve usar pra ensaiar o que o usuário
realmente recebe.

### Solução de problemas: erro `denied: denied` no pull

`docker: ... error from registry: denied` significa que o Docker não
conseguiu puxar a imagem do GHCR — em geral porque a tag não está
publicada/é privada, ou porque há credenciais cacheadas inválidas em
`~/.docker/config.json` (o GHCR não cai pra acesso anônimo nesse caso).
Três saídas, da mais simples à mais completa:

| Caminho | Comando | Quando usar |
|---|---|---|
| Limpar credencial | `docker logout ghcr.io` | Resolve rápido um one-off |
| **Build local** | `docker build -t huu:local .` então `HUU_IMAGE=huu:local huu run …` | **Recomendado** — reprodutível, sem registry |
| Re-autenticar | `echo "$PAT" \| docker login ghcr.io -u <user> --password-stdin` | Precisa de imagens privadas (PAT com escopo `read:packages`) |

(`--yolo`/`--no-docker` são uma saída real de um pull que falhou, ao
custo do isolamento do container e do teto de memória — veja acima.)

---

## Configuração

### Registry de API keys

`huu` resolve API keys através de um registry declarativo
(`src/lib/api-key-registry.ts`). Adicionar uma key futuramente é um
append de uma entrada; tudo o mais (prompt da TUI, mount de secret
Docker, passthrough de env, limpeza de órfãos) itera pela mesma lista.

Registry atual:

| Key | Obrigatória | Backend | Usada por |
|---|---|---|---|
| `OPENROUTER_API_KEY` (`openrouter`) | sim (sem `--stub`) | Pi | O agente do Pi SDK + o pipeline assistant + project recon. |
| `ARTIFICIAL_ANALYSIS_API_KEY` (`artificialAnalysis`) | sim | todos | Recomendações de modelo / lookups de capabilities ao vivo no picker. |
| `COPILOT_GITHUB_TOKEN` (`copilot`) | sim (quando `--copilot`) | Copilot | O agente do Copilot SDK. PAT fine-grained com escopo "Copilot Requests", ou `GH_TOKEN`. |

Ordem de resolução por spec (primeira não-vazia vence) — a escolha
EXPLÍCITA ganha da AMBIENTE:

1. Mount de secret de container em `/run/secrets/<snake_case_name>` —
   mesma convenção das imagens Docker postgres / mysql. (Num run Docker o
   host resolve a key com esta mesma ordem e re-monta aqui.)
2. Store global persistido em `$XDG_CONFIG_HOME/huu/config.json`
   (fallback `~/.config/huu/config.json`, modo `0600` num diretório
   `0700`; `HUU_CONFIG_DIR` sobrescreve o local — o wrapper Docker aponta
   pro config dir do HOST e monta ele RW, então key salva de dentro do
   container cai no host e sobrevive ao `docker run --rm`). A TUI oferece
   "salvar globalmente" na primeira vez que você cola uma key, e o painel
   web **⚙ Settings → OpenRouter API key** ("Validate & save") escreve
   aqui também. Uma key salva explicitamente GANHA da env var abaixo.
3. Env var `<NAME>_FILE` apontando pra um arquivo com o valor.
4. Env var `<NAME>` (plain) — o fallback quando nada foi salvo (o caminho
   padrão de CI / headless).

Qualquer key que resolve pra vazio E é `required: true` faz a TUI
mostrar o prompt no caminho da primeira execução. Stub mode (`--stub`)
curto-circuita o check de requisito.

Como o store salvo (passo 2) ganha da env var (passo 4), a key que você
salvou explicitamente no Options tem precedência — um `OPENROUTER_API_KEY`
stale num perfil de shell não sombreia mais o que você salvou. Se você
*quer* que a env var valha, limpe a key salva. `resolveApiKeyWithSource`
reporta qual camada venceu, então a mensagem de abort nomeia a fonte real.

A **interface web** tem duas superfícies de key. Uma key colada no
*formulário de launch* fica só no `sessionStorage` daquela aba — validada
contra o provider primeiro, enviada a cada run, nunca escrita em disco. Já o
painel **⚙ Settings → OpenRouter API key** *persiste*: "Validate & save"
checa a key contra o OpenRouter (key rejeitada nunca é salva), grava no
store acima e arma um override em memória na sessão, então **todo run novo
já usa a key na hora** — inclusive dentro do Docker, onde o snapshot do
secret-mount de startup continuaria vencendo até o restart. O painel mostra
qual key está ativa e de onde veio (sempre mascarada), avisa quando uma env
var está sendo ignorada, e "clear saved key" volta pra env var. Um run com
key recusada (401) reporta a fonte que realmente a forneceu — aba do
navegador, Options da web, store salvo ou env var. E cada evento de key
(validada / rejeitada / salva / limpa) e de ciclo de vida dos runs também é
logado no terminal que iniciou o huu.

### Variáveis de ambiente

| Variável | Obrigatória | Pra que serve |
|---|---|---|
| `OPENROUTER_API_KEY` | sim (sem `--stub`) | Enviada pro OpenRouter via Pi SDK. Se faltar, o TUI pede na primeira execução real e "save globally" persiste em `~/.config/huu/config.json`. |
| `OPENROUTER_API_KEY_FILE` | não | Caminho de um arquivo contendo a key. Tem precedência sobre `OPENROUTER_API_KEY` quando ambos estão setados; o mount canônico de Docker secret em `/run/secrets/openrouter_api_key` tem precedência sobre ambos. Uma key salva via Options (`~/.config/huu/config.json`) ganha dos três — limpe-a se quiser que uma env var valha. |
| `ARTIFICIAL_ANALYSIS_API_KEY` | sim | Usada pra lookups de capabilities de modelo ao vivo (`supportsThinking`, pricing). Mesma cadeia de precedência via `ARTIFICIAL_ANALYSIS_API_KEY_FILE` e `/run/secrets/artificial_analysis_api_key`. |
| `COPILOT_GITHUB_TOKEN` | sim (quando `--copilot`) | PAT fine-grained do GitHub com escopo "Copilot Requests" (ou `GH_TOKEN`). Obrigatória só quando `--backend=copilot` está ativo. Mesma cadeia de precedência via `COPILOT_GITHUB_TOKEN_FILE` e `/run/secrets/copilot_token`. |
| `HUU_WORKTREE_BASE` | não | Override do diretório base dos worktrees por execução. Paths absolutos são usados verbatim; paths relativos resolvidos contra a raiz do repo. Padrão: `<repo>/.huu-worktrees`. Usado pelo modo isolated-volume do container. |
| `HUU_WORKSPACE` | não | Diretório do host que o **seletor de pastas** da web pode navegar (bind-mount RW no container, no mesmo path absoluto). Padrão `$HOME`, então o picker vê todos os projetos embaixo do seu home. Aperte (`HUU_WORKSPACE=~/Projects`) ou amplie (`HUU_WORKSPACE=/` para o filesystem inteiro). **Segurança:** o workspace é montado read-write, então o shell de um agente pode ler/gravar qualquer coisa embaixo dele (inclusive `~/.ssh` quando for `$HOME`) — mantenha o menor que seus projetos permitirem. O picker abre aqui (botão ⌂ Home) e os `runDirectory` escolhidos são resolvidos contra ele. |
| `HUU_CHECK_PUSH` | não | Quando setada, preflight verifica que o remote configurado está alcançável antes de a execução começar. |
| `HUU_RAM_PERCENT` | não | Orçamento de RAM como percentual da memória TOTAL da máquina — o dial de admissão que governa a concorrência. Padrão `70` (num desktop o SO + navegador + IDE seguram 20–30% da RAM, então o antigo `85` já começava toda execução no limite), clampado em `10`–`95`; o orçamento tem piso na reserva adaptativa do SO (veja `HUU_OS_RESERVE_MB`). Machine-global (uma máquina, uma RAM): em multi-run configura o único budget scaler compartilhado, sem override por-projeto. Também exposto como a flag CLI `--ram-percent=<n>` e o campo "RAM budget" das Settings web — o campo web agora aplica AO VIVO (`POST /api/settings` reconfigura na hora as execuções atuais + as da fila) e persiste no servidor em `~/.config/huu/web-settings.json`. Veja [Concorrência com auto-scaling](#concorrência-com-auto-scaling). |
| `HUU_OS_RESERVE_MB` | não | Override da reserva do SO — a fatia da RAM total que o orçamento (e os tetos de kernel) nunca tocam. O padrão agora é ADAPTATIVO: `max(min(2 GiB, 25% do total), 8% do total, 512 MiB)` — os 512 MiB fixos de antes eram finos demais pra um desktop. Valor em MiB, com teto em 90% do total. |
| `HUU_NO_HOST_CLAMP` | não | Sete `1` pra desligar o clamp de disponível do host — o huu passa a planejar admissão só pelo dial de orçamento de RAM / cgroup do container, ignorando o `/proc/meminfo` do host. Pra hosts dedicados. Padrão: o clamp está ligado, então toda admissão planeja por `min(headroom do orçamento, disponível no host − reserva do SO)`. |
| `HUU_GUARD_*` | não | Família de thresholds da **escada de pressão** graduada que substituiu o gatilho único de ≥ 95% da guarda de memória — pisos de RAM disponível + swap livre, linhas de PSI `full`, taxa/sustain de swap-in, sustain acima do orçamento, teto de swap do container, espaçamento de re-preempção, calm hold pós-tempestade. Todos têm defaults seguros; a tabela completa está em [Guarda de memória: a escada de pressão](#guarda-de-memória-a-escada-de-pressão). |
| `HUU_PAUSE_BACKOFF_MS` | não | Uma tarefa pausada faz backoff antes de retomar: `min(10s × 2^(pauses−1), 120s)` × um jitter determinístico só-pra-cima em `[1, 1.5)` chaveado por `runId#agentId#pauses` — de-sincroniza o rebanho multi-run. `0` desliga o backoff. Deliberadamente NÃO há teto no número de pausas. |
| `HUU_OOM_SCORE_ADJ` | não | Ajusta o `/proc/self/oom_score_adj` do processo huu pra que o OOM-killer do kernel evite matar o huu. Padrão conservador (`-100`, um empurrão leve que NÃO imuniza); best-effort — um valor NEGATIVO só pega com `CAP_SYS_RESOURCE`, que nem um processo comum nem o container (que roda `--user <uid>:<gid>`, não-root) têm, então o empurrão em geral vira no-op. A alavanca que funciona é o `HUU_CHILD_OOM_SCORE_ADJ` abaixo — SUBIR um score não exige privilégio. Só-Linux. |
| `HUU_CHILD_OOM_SCORE_ADJ` | não | Viés de OOM pros processos DESCENDENTES do huu: um watcher varre o `/proc` a cada 2 s e sobe os filhos-ferramenta dos agentes (workers do vitest, npm installs, builds…) pra `oom_score_adj` `+500` (o padrão), então um OOM do kernel mata um test runner — que vira um simples retry de task — em vez do orchestrator ou da sua sessão de desktop. Sete `0` pra desligar o watcher. Só-Linux. |
| `HUU_NO_CGROUP` | não | Sete `1` pra pular o escopo systemd de usuário transiente do wrap nativo — o teto de kernel de qualquer execução que acaba nativa (`--yolo`/`--no-docker`/`HUU_NO_DOCKER`, um runtime `native` salvo, ou `HUU_DEV_NATIVE`; veja [Tetos de memória no kernel](#tetos-de-memória-no-kernel)). Sem a flag o wrap já degrada pra rodar sem wrapper, com uma nota de uma linha no stderr, quando o systemd não está utilizável. |
| `HUU_SWAP_MAX_MB` | não | Teto de swap pra árvore de processos do huu, em MiB (padrão `4096`; `0` = nada de swap). Aplicado como o delta do `--memory-swap` no container Docker (e como `MemorySwapMax` no escopo systemd nativo, quando a execução é nativa). |
| `HUU_DOCKER_MEMORY_MB` | não | Override do teto de memória do container, em MiB. Padrão: total do host − reserva do SO, passado pelo wrapper como `docker run --memory`. |
| `HUU_NO_MEM_LIMIT` | não | Sete `1` pra subir o container SEM teto de memória (o comportamento legado — um container ilimitado pode consumir 100% da RAM do host). |
| `HUU_MAX_LIVE_RUNS` | não | Teto de execuções multi-run vivas ao mesmo tempo (padrão `8`). O cap efetivo se ADAPTA PRA BAIXO ao que o orçamento realmente comporta: `orçamento ÷ (HUU_RUN_BASELINE_MB + footprint por-agente)`. |
| `HUU_MAX_QUEUED_RUNS` | não | Total de execuções que o servidor web aceita (padrão `256`; era um 64 hardcoded). Execução na fila não custa orçamento — enfileire quantos projetos quiser. |
| `HUU_RUN_BASELINE_MB` | não | Baseline fixo por execução (MiB, padrão `384`) cobrado do headroom em bytes na admissão de uma execução da fila, além do footprint por-agente. |
| `HUU_JCODE_HERMETIC` | não | Escape de debug do **runtime jcode hermético** — a grafia viva; o nome antigo `HUU_PI_HERMETIC` acabou e ninguém mais o lê. Hermético é o PADRÃO: todo subprocesso `jcode` que o huu sobe recebe `JCODE_MEMORY_ENABLED=false` (zero embeddings), `JCODE_NO_TELEMETRY=1`, um `JCODE_AGENT_DIR` isolado e um `JCODE_HOME` em `~/.huu/jcode-home` com um `config.toml` que o próprio huu escreve — o `~/.jcode/config.toml` do host é **ignorado**. Com `0`/`false` o `process.env` vai intacto e o jcode volta a resolver a config pelo host (não escreve arquivo nenhum, não força var nenhuma). O wrapper forwarda essa variável pro container automaticamente — não precisa de `HUU_DOCKER_PASS_ENV`. |
| `HUU_AGENT_MEM_SEED_MB` | não | Seed de partida da estimativa de memória por-agente do AutoScaler, em MiB (clamp `128`–`4096`). O padrão pessimista `1536` é guarda anti-OOM deliberada — sub-admite até a EMA observar o footprint real. Baixe SÓ com evidência: acompanhe `scaler`/`config` e `scaler`/`ema_move` no NDJSON de debug (ou `AutoScaleStatus.observedAgentMemoryMb` nas UIs) por algumas execuções e semeie perto do p95 observado. |
| `HUU_AGENT_MEM_EMA_ALPHA` | não | Fator de suavização da EMA do footprint observado por-agente (clamp `0.01`–`1`; padrão `0.2` ≈ constante de tempo de 5 s no poll de 1 Hz). Suba pra convergir mais rápido do seed pro footprint medido (mais reativo, mais ruidoso); desça pra estabilidade. |
| `HUU_IN_CONTAINER` | não | Setada pra `1` automaticamente pela imagem Docker oficial. Usada pelo wrapper pra curto-circuitar o auto-Docker re-exec. |
| `HUU_IMAGE` | não | Override da imagem de container usada pelo wrapper auto-Docker. Padrão: `ghcr.io/frederico-kluser/huu:latest`. Útil pra pinar uma release ou apontar pra um mirror privado. |
| `HUU_NO_DOCKER` | não | **Bypass nativo de usuário**, a mesma afirmação de `--no-docker`/`--yolo` mas com escopo de env: `1`/`true` pula o re-exec no Docker e roda o CLI inteiro no host, imprimindo um aviso de uma linha sem isolamento. Custa o isolamento de credenciais do container e o teto de memória dele. O `huu setup` pode salvar `native` como preferência permanente em vez disso — veja [`docs/operations.pt-BR.md#docker-por-padrão-nativo-como-opt-in`](#docker-por-padrão-nativo-como-opt-in) pra precedência completa. O CI também roda via Docker por padrão — veja [`docs/ci.pt-BR.md`](ci.pt-BR.md). |
| `HUU_DEV_NATIVE` | não | **Escape de quem desenvolve o huu — não é feature de produto.** `1`/`true` pula o re-exec no Docker por completo, então o CLI roda no host sem daemon nenhum; o `npm run dev` seta isso. O isolamento do container e o teto de memória do container ficam ambos DESLIGADOS (os agentes alcançam `~/.ssh`, `~/.aws`, …), então o huu imprime um banner em todo start. Só env, por decisão — as grafias de usuário `--no-docker`/`--docker`/`HUU_NO_DOCKER` são uma porta separada e deliberada (veja acima), não esta. Use `npm run dev:docker` pra iterar do jeito que o usuário roda de verdade. |
| `HUU_DOCKER_NETWORK` | não | Valor pass-through pra `docker run --network=<value>`. Por padrão, huu auto-cria `huu-net-mtu<N>` quando em VPN (MTU da rota default < 1500); set isso pra override (ex.: `host`, ou o nome de uma rede gerenciada pelo usuário pré-existente). |
| `HUU_DOCKER_PASS_ENV` | não | Lista separada por whitespace de nomes de env var adicionais pra forwardar pro container. O wrapper sempre forwarda `OPENROUTER_API_KEY`, `OPENROUTER_API_KEY_FILE`, `HUU_CHECK_PUSH`, `HUU_WORKTREE_BASE`, `HUU_HOST_HOME`, `TERM` todos os knobs de segurança de RAM (`HUU_RAM_PERCENT`, a família `HUU_GUARD_*`, `HUU_OS_RESERVE_MB`, `HUU_MAX_LIVE_RUNS`, `HUU_MAX_QUEUED_RUNS`, `HUU_RUN_BASELINE_MB`, `HUU_OOM_SCORE_ADJ`, `HUU_NO_PAUSE`), o escape hermético do jcode (`HUU_JCODE_HERMETIC`) e os knobs `SURF_*` de pesquisa — um `HUU_RAM_PERCENT` do host antes era ignorado dentro do container. Use isso pra adicionar nomes customizados. |
| `HUU_HOST_HOME` | não | Setada automaticamente pelo wrapper pro home directory do host. Dentro do container, `getHuuHome()` lê isso pra escritas em `~/.huu/` e o target default de export `~/Downloads/` caírem no filesystem bind-montado do host. Sem set fora do Docker. |
| `HUU_CONFIG_DIR` | não | Setada automaticamente pelo wrapper pro config dir do HOST (`$XDG_CONFIG_HOME/huu`, padrão `~/.config/huu`), que é bind-montado read-write no container. `configFilePath()` (o store de keys salvas) e `webSettingsPath()` preferem ela, então keys/settings salvos de dentro do container persistem no host. Sem set fora do Docker (resolução XDG local vale). |
| `HUU_WEB_LOG_STREAM` | não | Sete `1` pra TAMBÉM espelhar o firehose bruto de saída dos agentes (texto de resposta/raciocínio, linha a linha) no terminal que iniciou o huu. O log de ciclo de vida (runs na fila/iniciados/concluídos/falhados, atividade por agente, eventos de key, launches recusados) é sempre ativo — esta flag só adiciona o stream verboso. |
| `HUU_MAX_EVENT_LISTENERS` | não | Sobe o teto padrão de listeners de EventTarget / EventEmitter do Node (padrão `256`; `0` mantém os defaults do próprio Node) pra silenciar uma tempestade de `MaxListenersExceededWarning` — o pi adiciona um listener de abort por tool call no `AbortSignal` da sessão. |
| `HUU_UID` | não | UID do container pra execuções `docker compose`. Padrão: `1000`. Override com `HUU_UID=$(id -u)` se seu UID de host não é 1000, ou use o wrapper `scripts/huu-compose` que seta automaticamente. |
| `HUU_GID` | não | GID do container pra execuções `docker compose`. Mesmas regras de default que `HUU_UID`. |

### Arquivos escritos pela ferramenta

| Path | Escopo | Propósito |
|---|---|---|
| `~/.config/huu/config.json` | global | API keys persistidas via o prompt "save globally" do TUI ou o painel web **⚙ Settings → OpenRouter API key** (modo `0600` num diretório `0700`). No Docker o diretório é bind-montado e apontado por `HUU_CONFIG_DIR`, então salvar de dentro do container cai aqui no host. |
| `~/.huu/recents.json` | global | Modelos recentemente usados pelo picker. |
| `~/.huu/pipeline-memory.json` | global | Pipelines salvos do editor TUI. |
| `<repo>/.huu-worktrees/<runId>/` | repo | Um subdiretório por agente durante uma execução; removido no fim (manifest preservado). |
| `<repo>/.huu/<stamp>-execution-<runId>.log` | repo | Transcrição cronológica completa de uma execução. |
| `<repo>/.huu/<stamp>-execution-<runId>/agent-<id>.log` | repo | Transcrição por agente. |
| `<repo>/.huu/debug-<ISO>.log` | repo | Trace de debug em NDJSON, uma linha por evento de lifecycle. |
| `<repo>/.huu-cache/native-shim/<os>-<arch>/` | repo | Interceptor `bind()` compilado. Buildado uma vez, reusado entre execuções. |
| `<worktree>/.env.huu` | por-agente | Atribuições de porta por agente; auto-carregado por tools dotenv-aware. |
| `<worktree>/.huu-bin/with-ports` | por-agente | Wrapper shell que faz source do `.env.huu` e `exec` num comando — necessário pra binários que ignoram dotenv. |

No modo host-bind (o padrão), todos esses paths ficam visíveis no
filesystem do host depois que o container termina — o bind mount faz as
escritas do container caírem direto no host. `huu` adiciona `.huu-worktrees/`, `.huu/`,
`.huu-cache/`, `.env.huu` e `.huu-bin/` ao `.gitignore` do repo na
primeira execução.

### Modelos recomendados

`recommended-models.json` traz uma lista curta curada mostrada no topo
do picker de modelo; a primeira entrada é o **modelo default**,
`deepseek/deepseek-v4-flash` (rápido, barato, 1M de contexto, tools +
reasoning) — ele encabeça a lista recomendada e a UI web o pré-seleciona.
Cada entrada pode carregar metadados opcionais: `description`, `bestFor`
(tags de caso de uso), `tier` (`planning` / `flagship` / `workhorse` /
`fast`), e `provider` (`openrouter` ou `azure`).

Na **UI web**, o campo Model carrega o **catálogo ao vivo completo do
OpenRouter** — todo modelo, com anotação de capacidade (`GET /api/models`
→ `listAllModels` em `src/lib/openrouter.ts`). O endpoint `/models` do
OpenRouter é **público**, então o catálogo carrega **com ou sem key do
OpenRouter**, assim que você abre o picker; modelos sem tool calling
recebem **selo** (`no tools`) em vez de serem escondidos, e você pode
digitar qualquer id de modelo pra usar verbatim. A lista curta curada
acima é só o fallback offline / falha de fetch.

Quando `ARTIFICIAL_ANALYSIS_API_KEY` está setada, o quick picker
renderiza uma tabela de largura fixa com métricas ao vivo do
Artificial Analysis — `Model · tok/s · Agnt · Code · Razn · $in/$out
· BestFor`. Sem a key, colunas degradam pra placeholders `—` sem
bloquear a seleção.

---

## Concorrência com auto-scaling

**O auto-scaling memória-aware é o padrão.** A concorrência é governada
por um **dial de orçamento de RAM**: um percentual configurável da
memória TOTAL da máquina (padrão `70`, clampado em `10`–`95` — num
desktop o SO + navegador + IDE seguram 20–30% da RAM, então o antigo
padrão de `85` já começava toda execução no limite), com piso
numa **reserva adaptativa pro SO** — `max(min(2 GiB, 25% do total), 8%
do total, 512 MiB)`, sobrescrevível com `HUU_OS_RESERVE_MB` (os 512 MiB
fixos de antes eram finos demais pra um desktop com um navegador aberto
do lado de uma execução grande). O auto-scaler admite um novo agente só
enquanto ele couber nesse orçamento —
`ramBudgetBytes(total, percent) − ramUsedBytes` dividido pelo footprint
observado do agente — e a leitura é cgroup-aware, então dentro de um
container ele respeita o limite do container, não o do host. Ajuste o
dial com `--ram-percent=<n>`, a env var `HUU_RAM_PERCENT` ou o campo
"RAM budget" das Settings web — o dial da web aplica AO VIVO nas
execuções atuais e nas da fila e persiste no servidor
(`~/.config/huu/web-settings.json`); é machine-global (uma máquina, uma
RAM — sem override por-projeto). Passe `--concurrency=N` ou
`--no-auto-scale` pra pinar o **modo manual** (ajustável ao vivo com
`+`/`-` no dashboard; `A` religa o auto). Em configs headless, setar
`"concurrency"` pina manual; omita pro auto.

Cinco refinamentos evitam que o orçamento estoure em cold starts e
bursts:

- **Freio dianteiro PSI (Linux).** O scaler lê a Pressure Stall
  Information de memória — o `memory.pressure` por-cgroup quando
  containerizado, senão o `/proc/pressure/memory` do sistema — e congela
  a admissão no instante em que o valor `some avg10` cruza ~0.5%. A
  pressão sobe *antes* de a RAM saturar, então isso pega um burst que o
  gate de RAM atrasado perderia. Onde PSI não está disponível (macOS,
  kernels sem `CONFIG_PSI`) ele cai pro gate de orçamento de RAM acima.
- **Seed pessimista, EMA de coorte madura.** A estimativa por-agente
  começa em 1536 MiB (clampada em 128–4096) e uma média móvel a corrige
  a partir de medições reais — mas só amostra agentes MADUROS (≈ 45 s de
  vida): agentes jovens ainda não paginaram o working set inteiro, e
  deixá-los entrar na média já arrastou a estimativa pra baixo numa
  espiral de sobre-admissão. A EMA também é assimétrica — sobe rápido e
  desce devagar — então um cold start deliberadamente sub-admite e um
  susto fica lembrado.
- **Contabilidade de reservas.** A admissão cobra spawns em voo pelo
  footprint CHEIO e agentes jovens (< 45 s) pela METADE, então um burst
  de admissões não estoura dentro da janela de 1–2 s em que as métricas
  estão velhas. Perto da borda do orçamento o poll de métricas acelera
  de 1 s pra 250 ms, e o sampler também lê SwapTotal/SwapFree, PSI
  `full avg10` e a taxa de swap-in do `/proc/vmstat` — os sinais que a
  escada de pressão abaixo consome.
- **Contabilidade de RAM host-aware.** O sampler de métricas também lê
  o par do `/proc/meminfo` do host (`hostMemTotalBytes` /
  `hostMemAvailableBytes`) — o `/proc` não é namespaced, então um
  container lê a memória real do host — e toda decisão de admissão
  planeja pelo mais apertado dos dois orçamentos: `min(headroom do
  orçamento, disponível no host − reserva do SO)`. A suavização é
  assimétrica: uma QUEDA de disponível no host vale na hora enquanto a
  recuperação é amortecida, então um host que enche por fora do container
  estrangula o huu na hora. Os pisos earlyoom da escada de pressão também
  usam o mais apertado entre disponível do container e do host. Num host
  dedicado, `HUU_NO_HOST_CLAMP=1` desliga o clamp — o huu passa a planejar
  só pelo dial de orçamento de RAM / cgroup do container.
- **Fast-ramp.** O worker pool limita novos spawns a
  `max(1, ceil(busy × 0.5))` por tick (~+50%/tick), então o modo auto
  nunca inunda o pool inteiro num único tick. O modo manual ainda enche
  imediatamente.

O auto-scaler observa CPU e RAM via `lib/resource-monitor.ts` e
transita entre cinco estados, mostrados no header como
`AUTO <ESTADO> · CPU/RAM · ~<N>MB/agente · free <N>MB`:

- **NORMAL** — abaixo de ambos os thresholds, disposto a subir mais
  agentes até a profundidade da fila.
- **SCALING_UP** — ativamente concedendo slots de spawn.
- **BACKING_OFF** — uso acima do threshold de parada (default 90%);
  recusa novos spawns mas deixa agentes em execução em paz.
- **DESTROYING** — a escada de pressão (abaixo) exige derrubar carga; o
  agente **mais novo** é preemptado pra recuperar espaço. Por padrão ele
  é **pausado** — worktree, branch e sessão preservados, card âmbar
  `PAUSED` com badge `⏸N`, retomado no lugar assim que houver folga; só
  é morto e re-enfileirado (`↻N`, tarefa recomeça do zero) quando não dá
  pra fazer checkpoint ou sob `HUU_NO_PAUSE=1`. O trabalho dos agentes
  mais antigos nunca é perdido.
- **COOLDOWN** — pausa de 30s depois de um evento de destroy ou
  backoff pra que o sistema não oscile.

`+`/`-` manuais no dashboard desabilitam o auto-scale automaticamente
— pressione `A` pra reativar. A **guarda de memória continua ativa no
modo manual** (o header troca o chip `AUTO` por um chip `GUARD` com o
contador de preempções). O bloco de status também mostra `CPU%` e `RAM%`
ao vivo, espelhando o `SystemMetricsBar` pra você não ter que
correlacionar dois readouts.

**Modo MAX (`M`, só no TUI de execução única)** é um terceiro modo,
**budget-greedy**: inunda o pool com um agente por tarefa na fila — mas
só enquanto o dial de orçamento de RAM ainda tiver folga (o freio PSI e
a linha legada de 95% também valem), em vez de inundar até a linha de
destruição de 95% como antes. O dial vale em todos os modos. O header
mostra um chip azul `MAX <ESTADO>` com a contagem de preempções; o
amortecimento por cooldown evita thrashing. Pressione `M` de novo (ou
`A`) pra voltar ao auto, `+`/`-` pra cair pro manual. A **UI web não
oferece mais MAX**: toda execução web é subordinada ao scheduler
multi-run compartilhado, onde a flag greedy por-execução nunca
controlou nada — o toggle do topo alterna Auto ⇄ Manual, e POSTs
`greedy` legados viram `auto`.

Sobrescreva defaults setando `agentMemoryEstimateMb`, `budgetPercent`,
`admitPsiThreshold`, `stopThresholdPercent`, `destroyThresholdPercent`,
`cooldownMs` e `maxAgents` no código se você embarca o orchestrator; o
CLI expõe `--ram-percent=<n>`, `--concurrency=N` e `--no-auto-scale`.

### Guarda de memória: a escada de pressão

A guarda de memória tinha um único gatilho — RAM ou CPU ≥ 95% — que um
host em swap nunca cruza: ele congela em thrashing antes. Ele foi
substituído por uma **escada de pressão** graduada, avaliada a cada tick
da guarda em todos os modos de concorrência (auto, manual e MAX):

- **L1 — acima do orçamento.** Uso sustentado acima do dial de RAM por
  ~3 s (`HUU_GUARD_OVER_BUDGET_MS`) → spawns congelam e a guarda pausa
  os agentes mais novos (um por tick, espaçados por
  `HUU_GUARD_L1_REPREEMPT_MS`) até o uso voltar pra baixo do dial. O L1
  nunca drena abaixo de UM agente vivo — a execução degrada pra
  sequencial, nunca pra zero.
- **L2 — pressão do host** (estilo earlyoom). RAM disponível < 10% E
  swap livre < 10% (host sem swap conta como swap esgotado), OU PSI
  `full avg10` ≥ 5%, OU swap-in sustentado (≥ 1000 páginas/s por 2 s),
  OU o container transbordando pra sua própria allowance de
  `--memory-swap` (cgroup v2 `memory.swap.current` ≥
  `HUU_GUARD_CONTAINER_SWAP_PCT`% de `memory.swap.max`, padrão 50%), OU
  a linha legada de RAM/CPU ≥ 95% → derruba uma vítima A CADA tick, com o
  tick da guarda acelerado de 500 ms pra 150 ms e a admissão de execuções
  da fila congelada.
- **L3 — emergência.** Disponível < 5% E swap livre < 5%, OU PSI `full`
  ≥ 20% — o mesmo shedding, na urgência máxima.

A vítima é sempre o agente **mais novo** (menos trabalho feito,
escolhido por `startedAt`; em multi-run, primeiro o agente mais novo da
execução de menor prioridade). Pausar é a preempção padrão — checkpoint
da sessão, agente descartado pra liberar RAM, worktree + branch +
transcript preservados, retomada no lugar quando houver folga;
`HUU_NO_PAUSE=1`, ou um backend que não sabe fazer checkpoint, cai pra
matar + re-enfileirar (`↻N`).

As linhas de log de pausa/kill da guarda carregam o MOTIVO exato da
escada de pressão que disparou — ex.: `paused by memory guard — avail
0.4% + swap free 0.0% below emergency floor (container RAM 98%)`, em vez
de um enganoso "RAM 9%" pelado — e a linha é publicada na UI na hora.

Agentes reservados de judge / integração (ids `9998` / `9999`) CONTAM no
orçamento global de RAM enquanto vivem, dobrados na demanda e no lado
busy do pool. Eles NUNCA são vítimas de preempção e seu caminho de spawn
não tem NENHUM gate, então um orçamento congelado pode estrangular
trabalho novo sem nunca travar um estágio no próprio judge ou merge.

Todo threshold tem um knob de env:

| Knob | Default | Nível | Significado |
|---|---|---|---|
| `HUU_GUARD_OVER_BUDGET_MS` | `3000` | L1 | Por quanto tempo o uso precisa ficar acima do dial de RAM antes de congelar spawns e começar a pausar. |
| `HUU_GUARD_L1_REPREEMPT_MS` | `2500` | L1 | Espaçamento mínimo entre vítimas de pausa sucessivas no L1. |
| `HUU_GUARD_AVAIL_PCT` | `10` | L2 | Piso de RAM disponível (% do total), combinado com o piso de swap. |
| `HUU_GUARD_SWAP_FREE_PCT` | `10` | L2 | Piso de swap livre (%). Sem swap configurado conta como swap esgotado. |
| `HUU_GUARD_PSI_FULL_HIGH` | `5` | L2 | PSI `full avg10` (%) — o sinal canônico de thrashing. |
| `HUU_GUARD_SWAPIN_PAGES_SEC` | `1000` | L2 | Taxa de swap-in (páginas/s) que conta como thrashing… |
| `HUU_GUARD_SWAPIN_SUSTAIN_MS` | `2000` | L2 | …quando sustentada por esse tempo. |
| `HUU_GUARD_DESTROY_PCT` | `95` | L2 | A linha legada de RAM/CPU, mantida como gatilho de fallback. |
| `HUU_GUARD_CONTAINER_SWAP_PCT` | `50` | L2 | % da allowance de `--memory-swap` do container (cgroup v2 `memory.swap.current` / `memory.swap.max`) que dispara um veredito L2 — o container transbordando pro próprio swap. |
| `HUU_GUARD_AVAIL_PCT_EMERGENCY` | `5` | L3 | Piso de emergência de RAM disponível (%). |
| `HUU_GUARD_SWAP_FREE_PCT_EMERGENCY` | `5` | L3 | Piso de emergência de swap livre (%). |
| `HUU_GUARD_PSI_FULL_EMERGENCY` | `20` | L3 | PSI `full avg10` de emergência (%). |
| `HUU_GUARD_REOPEN_CALM_MS` | `10000` | L2/L3 | CALM HOLD pós-tempestade (ms; `0` desliga): depois de qualquer veredito L2/L3, a admissão de spawns E de novas execuções fica congelada por esse tempo além da última leitura de alta pressão — tanto o pool de execução única quanto o GlobalScheduler. Evita o efeito manada de pausa↔retomada. |

### Tetos de memória no kernel

A escada é software; a última linha de defesa é o kernel:

- **Docker (o teto do runtime padrão):** toda execução ganha este, a
  menos que um bypass ou um runtime `native` salvo tenha optado por
  sair. O wrapper passa `--memory` = total do host − reserva do SO,
  `--memory-swap` = memória + `HUU_SWAP_MAX_MB` e `--pids-limit 8192`
  pro container. Sobrescreva o teto com `HUU_DOCKER_MEMORY_MB` (MiB) ou
  restaure o container ilimitado legado com `HUU_NO_MEM_LIMIT=1`.
- **Escopo systemd nativo (o teto de uma execução nativa):** no Linux,
  QUALQUER execução que acaba nativa — `--yolo`/`--no-docker`/
  `HUU_NO_DOCKER`, um runtime `native` salvo pelo `huu setup`, ou o
  loop de quem desenvolve o huu (`HUU_DEV_NATIVE`) — re-executa a si
  mesma dentro de um **escopo systemd de usuário** transiente
  (`systemd-run --user --scope`) com `MemoryHigh` = total − reserva do
  SO (o kernel estrangula a árvore inteira do huu antes de o host
  entrar em thrashing), `MemoryMax` = total − reserva/2 (pior caso: o
  huu morre dentro do próprio escopo, nunca o host), `MemorySwapMax` =
  `HUU_SWAP_MAX_MB` (padrão 4096 MiB; `0` = sem swap) e `TasksMax=8192`.
  É o que ainda separa uma execução nativa do freeze por OOM que o
  `--memory` do Docker teria evitado. Quando o systemd não está
  utilizável, degrada pra rodar sem wrapper com uma nota de uma linha
  no stderr; `HUU_NO_CGROUP=1` desativa. Fora do Linux, uma execução
  nativa não tem teto de kernel nenhum — só a guarda de software do
  AutoScaler.

`huu status` imprime uma seção doctor de **ram containment**: o dial e
de onde ele veio (web-settings / env / default), o orçamento em bytes, a
reserva do SO, o teto de kernel detectado no cgroup atual (ou "NONE —
software guard only"), PSI some/full + swap ao vivo, e todo knob de
segurança `HUU_*` setado no momento. Também imprime uma linha `host:` —
o que o huu pode reivindicar nesta máquina agora (disponível no host −
reserva do SO) — e um preview `docker:` do teto `--memory` que o wrapper
vai passar e do orçamento in-container que ele rende.

---

## Previsibilidade de custo

O custo de uma execução do `huu` é limitado pelo número de cartões e
pelo modelo escolhido por estágio. Não existe um loop de agente que
pode decidir "também fazer X" — você recebe a execução que pagou.

**Ferramentas de hoje pra manter o custo no controle:**

- `--stub` roda o fluxo todo sem nenhum LLM. Use pra validar a
  estrutura e a decomposição do pipeline antes de gastar um dólar.
- `--copilot` usa créditos do Copilot baseados em assinatura em vez de
  cobrança por token — o custo fica dentro da cota de premium-requests
  do seu plano GitHub existente.
- O `modelId` por step permite rotear estágios mecânicos pra
  Haiku/Gemini Flash e reservar Sonnet/Opus pros estágios que de fato
  precisam.
- Tokens e custo são registrados por agente e aparecem no resumo da
  execução; detalhamento completo em
  `.huu/<runId>-execution-...log`.

**Roadmap:** `huu estimate <pipeline.json>` vai fazer dry-run da
decomposição e produzir uma previsão tipo:

```
5 estágios × 12 tarefas × Sonnet 4.5: estimado em $3.40, ~14 min de tempo de relógio.
```

Até isso chegar, a convenção é: validar com stub primeiro, depois
rodar com olho no kanban durante o primeiro estágio pra pegar
surpresas cedo.

---

## Isolamento de portas (visão geral)

`git worktree` isola o **filesystem**. Não isola a **rede do host**:
quando dez agentes sobem `npm run dev` ao mesmo tempo, todos chamam
`bind(3000)` no mesmo kernel. Nove falham com `EADDRINUSE` — e os
agentes, acreditando corretamente que o código do cliente está certo,
gastam tokens "consertando" um não-bug.

`huu` defende em quatro camadas (nenhuma exige Docker):

1. **`PortAllocator`** — cada agente recebe uma janela contígua de
   portas TCP (default `55100 + (agentId − 1) × 10`).
2. **`.env.huu` por worktree** — um env file dedicado exportando
   `PORT`, `HUU_PORT_HTTP`, `HUU_PORT_DB`, `HUU_PORT_WS`,
   `DATABASE_URL` e sete extras. Frameworks que respeitam dotenv
   (Next, Vite, Nest, Astro, dotenv-flow, …) carregam automaticamente.
3. **Interceptor `bind()` nativo.** Uma biblioteca C compartilhada de
   ~170 linhas em `native/port-shim/port-shim.c`. O orchestrator
   compila com `cc` e faz preload via `LD_PRELOAD` (Linux) ou
   `DYLD_INSERT_LIBRARIES` (macOS). **O código do cliente nunca é
   modificado** — `app.listen(3000)` literal no source roda
   exatamente como escrito; o kernel só vê uma porta por-agente em
   vez disso.
4. **System prompt** — o agente recebe suas portas alocadas e é
   lembrado de prefixar comandos não-dotenv-aware com o wrapper shell
   `./.huu-bin/with-ports <command>`.

**Matriz de cobertura, exclusões, como desabilitar e o design
completo:** [`PORT-SHIM.md`](PORT-SHIM.md).

Pra optar por desabilitar em refatorações puras / análise estática /
geração de doc, adicione `"portAllocation": { "enabled": false }` no
pipeline.

---

## Convenções visuais

**Magenta = ações de IA.** Sempre que você vir um painel ou marcador
roxo (`✦`) — o modo **Smart Select** (`S` no file picker), o
**Pipeline Assistant**, **Project Recon**, **logs de agente** — tem
um LLM sendo invocado em seu nome. Ciano é navegação/seleção neutra;
verde é confirmação/sucesso; amarelo é estado intermediário ou
warning; vermelho é erro; azul é informação auxiliar não-IA (modais
helper, escopos não-IA).

Tokens estão definidos em [`src/ui/theme.ts`](../src/ui/theme.ts).
Componentes que introduzirem nova utilização de magenta fora de
contextos de IA devem escolher outra cor.

---

## FAQ

**Posso rodar isso sem supervisão, de madrugada?**
Sim — é o uso primário. Cada agente tem timeouts e retries; a
execução termina sozinha com um resumo persistido. Leia
`.huu/<runId>-execution-*.log` de manhã. Pra ser notificado no
término, conecte o exit code do CLI num notifier (ntfy, webhook,
Slack incoming-webhook, seu hábito de escolha).

**A execução vai tocar no meu branch atual?**
Não. Todo agente trabalha no seu próprio worktree ramificado do seu
HEAD atual. Seu working tree nunca é modificado durante uma execução.

**Preciso commitar antes de rodar?**
Sim. Preflight se recusa a iniciar num working tree dirty. Faça
stash ou commit primeiro.

**O que acontece se um agente crashar no meio da execução?**
O orchestrator marca o cartão como falho, dropa seu worktree, e
(dependendo do `maxRetries`) re-sobe a tarefa num worktree fresh em
cima do mesmo HEAD de integração. Se retries esgotam, a execução
continua sem aquele cartão e a falha fica preservada no resumo.

**Por que o cartão de um agente voltou pra TODO com um badge `↻` (ou
apareceu em âmbar com `⏸` PAUSED)?**
A guarda de memória sempre-ativa disparou. Ela roda uma **escada de
pressão** graduada — uso sustentado acima do dial de RAM (L1), pisos de
pressão do host no estilo earlyoom, PSI `full` ou swap-in sustentado
(L2/L3), com a antiga linha de ~95% de RAM/CPU mantida só como fallback
— e preempta o agente **mais novo**, uma vítima por tick (o tick
acelera de 500 ms pra 150 ms sob pressão do host), pra que o trabalho
dos agentes mais antigos sobreviva. Por padrão a vítima é **pausada**
(worktree + sessão preservadas, `⏸N` âmbar, retomada no lugar quando
houver folga); só é morta e re-enfileirada (`↻N`, recomeço do zero)
quando não dá pra fazer checkpoint ou com `HUU_NO_PAUSE=1`. No L1 a
guarda nunca drena abaixo de UM agente vivo — a execução degrada pra
sequencial, nunca pra zero. A guarda fica ativa em todos os modos de
concorrência (auto, manual e MAX). O auto-scale memória-aware é o
padrão; pine um número fixo de agentes com `--concurrency=N` ou
`--no-auto-scale` (ou `"concurrency": N` num config headless).
Thresholds: veja
[Guarda de memória: a escada de pressão](#guarda-de-memória-a-escada-de-pressão).

**Posso rodar o huu no CI (GitHub Actions / GitLab)?**
Sim — com o runtime padrão o job precisa de um runner com **Docker
disponível** (os runners hospedados do GitHub já trazem; no GitLab use
um job docker-enabled). Conduza a execução com `huu auto` — o wrapper
re-executa na imagem do huu como sempre; fixe com `HUU_IMAGE`.
`--no-docker` / `HUU_NO_DOCKER=1` também funcionam num runner sem
Docker, ao custo do teto de memória do container. Receitas completas,
incluindo upload de `.huu/audits/` como artefato:
[`docs/ci.pt-BR.md`](ci.pt-BR.md).

**E se dois agentes tocam no mesmo arquivo?**
É sinal de que o pipeline foi mal projetado: em um pipeline
saudável, cada tarefa num estágio é dona de um arquivo disjunto. Se
sobreposição acontece mesmo assim e o git não consegue auto-merge,
um agente de integração ancorado em um LLM real resolve o conflito
num worktree lateral e continua. Resolução de conflito é
desabilitada no modo `--stub`. Encare como rede de segurança, não
feature.

**Posso abortar uma execução com segurança?**
Sim. `Q` aciona um abort cooperativo: agentes em voo terminam seu
step atual, branches com commits são mantidas como artefatos, o
worktree de integração é limpo. Pressione `Q` de novo pra forçar a
saída do dashboard.

**Quanto vou gastar?**
Depende do formato do pipeline e do modelo. Um pipeline de 30
arquivos em Sonnet 4.5 tipicamente fica entre $1 e $10. Use
`--stub` pra validar a estrutura primeiro; roteie estágios
mecânicos pra modelos mais baratos via `modelId` por step. O resumo
da execução detalha o custo por agente.

**Por que dois valores de timeout?**
Cartões de arquivo único geralmente terminam mais rápido que
cartões de projeto inteiro por uma ordem de magnitude. Separar o
timeout significa feedback apertado em trabalho per-file sem matar
prematuramente um cartão mais amplo que ainda está progredindo.

**Onde coloco minha API key?**
Pra **Pi** (backend padrão): exporte `OPENROUTER_API_KEY` antes de
lançar, ou cole no prompt na primeira vez que iniciar uma execução
real sem ela. Pra **Copilot**: exporte `COPILOT_GITHUB_TOKEN` (PAT
do GitHub com escopo "Copilot Requests"). A ferramenta em si nunca
persiste a key a não ser que você escolha "save globally" no prompt
do TUI.

**Por que o container Docker é mais lento no macOS?**
Filesystems bind-mounted no macOS atravessam um boundary de VM,
adicionando ~3× de latência pra operações de muitos arquivos
pequenos como `git worktree add`. Use [OrbStack](https://orbstack.dev/)
em vez do Docker Desktop pra ~2× mais I/O de arquivo no mesmo
workload.

**Posso rodar huu no Windows sem WSL2?**
Não na prática. Docker Desktop no Windows exige ou WSL2 ou Hyper-V,
e paths bind-mounted do Windows (`/mnt/c/...`) são 10–20× mais
lentos que ext4 dentro de WSL — suficiente pra fazer `git worktree
add` pra um pipeline real levar minutos por tarefa. Instale WSL2,
clone seu repo em `/home/<user>/` dentro do WSL, e use Docker
Desktop com integração WSL ativada.

**Por que o Ctrl+C no container às vezes deixa meu terminal travado?**
Não deveria — a imagem roda `tini` como PID 1 pra forwardar sinais,
e o CLI do `huu` instala um restorer de raw-mode belt-and-suspenders
pra `SIGINT`/`SIGTERM`/`SIGHUP`/`uncaughtException`. Se você vir um
terminal travado, rode `stty sane` pra recuperar e por favor abra
uma issue com o conteúdo de `.huu/debug-<ISO>.log` daquela execução.

**Arquivos em `.huu-worktrees/` são donos de root e não consigo deletar.**
Você está num host onde seu usuário primário não é UID 1000. Ou:
1. Use `scripts/huu-compose run pipeline.json` — auto-detecta seu
   UID via `id(1)` e exporta `HUU_UID`/`HUU_GID`.
2. Exporte uma vez por shell: `export HUU_UID=$(id -u) HUU_GID=$(id -g)`
   e use `docker compose run` normalmente.

---

## Roadmap

- `huu estimate <pipeline.json>` — dry-run de custo e previsão de
  tempo de relógio.
- `huu lint <pipeline.json>` — detectar `files` sobrepostos entre
  estágios, placeholders `$file` faltando, model IDs indefinidos.
- `huu/cookbook` — registry comunitário de pipelines, com cada
  entrada taggeada por domínio (testing, audits, refactors, docs).
- Wrapper de GitHub Action — rodar um pipeline `huu` como parte do
  CI em um PR labeled.
- JSON Schema + LSP pra `huu-pipeline-v1.json` — autocomplete e
  validação em editores.

---

## Contribuindo

`huu` é open-source sob [Apache 2.0](../LICENSE). Issues e pull
requests são bem-vindos.

Regras básicas:

- Leia a skill relevante sob `.agents/skills/` antes de mudar uma
  camada com a qual você não tem familiaridade.
- Prefira **Conventional Commits** (`feat:`, `fix:`, `refactor:`,
  `docs:`, …).
- Nunca force-push em `main`.
- A CI roda o gate (`.github/workflows/gate.yml` → `scripts/gate.sh`) em
  todo push e pull request. Ainda assim rode `npm run typecheck && npm test`
  localmente antes de abrir um PR — a CI só avisa depois que você empurrou.
  Ative o hook pre-push com `git config core.hooksPath .githooks` pra impor
  isso. `bash scripts/gate.sh` reproduz a CI exatamente.

```bash
npm run dev          # hot-reload em src/cli.tsx, NATIVO (sem Docker nenhum)
npm run dev:docker   # o mesmo hot reload, via Docker (ensaia o que o usuário recebe)
npm run build        # tsc → dist/
npm run typecheck    # tsc --noEmit
npm test             # vitest (orchestrator, run logger, file scanner, pipeline e2e)
```

Smoke tests pra releases:

```bash
docker build -t huu:local .
./scripts/smoke-image.sh        # ~10s — sanidade da imagem
./scripts/smoke-pipeline.sh     # ~60s — pipeline end-to-end com --stub
```

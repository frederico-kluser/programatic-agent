/** CLI: `--help`, banners de inicialização, erros fatais. Gêmeo de `en/cli.ts`. */

export const cliPtBR = {
  'cli.err_dir_not_directory': 'huu: --dir={path}: não é um diretório',
  'cli.err_not_a_repo':
    'huu: não é um repositório git: {cwd}\nO huu roda cada agente numa worktree isolada do git, então precisa de um repositório.\nRode \'git init\' aqui, ou entre num repositório existente, e tente de novo.',
  'cli.err_unknown_provider':
    'huu: --provider={value}: provedor desconhecido. Válidos: {valid}',
  'cli.err_unknown_backend': 'huu: --backend={value}: backend desconhecido. Válidos: {valid}',
  'cli.err_import_pipeline': 'Falha ao importar o pipeline: {message}',
  'cli.err_per_file_no_files':
    'O passo "{name}" tem escopo "per-file" mas nenhum arquivo — adicione-os em config.files["{name}"], ou mude o passo para o escopo "memory" com filesFrom.',
  'cli.err_auto_no_key':
    'huu auto: o provedor {provider} exige uma chave de API, mas {envVar} não está definida. Exporte a variável de ambiente, monte um secret em {secretPath}, ou salve a chave pela TUI antes.',
  'cli.err_port_in_use':
    'huu: a porta {port} já está em uso. Escolha outra com --port=<n> ou HUU_WEB_PORT=<n>.',
  'cli.err_web_start': 'huu: o servidor web falhou ao subir: {message}',
  'cli.usage_auto': 'Uso: huu auto <pipeline.json> --config <config.json>',
  'cli.usage_run': 'Uso: huu run <pipeline.json>',
  'cli.warn_tag': 'aviso',
  'cli.fatal': 'fatal',
  'cli.warn_native_removed':
    'huu: o modo nativo (sem docker) foi REMOVIDO — o huu agora é docker-only.\n     --yolo/--no-docker/HUU_NO_DOCKER são ignorados; rodando dentro do container com o teto de memória do kernel.',
  'cli.warn_dev_native':
    'huu: HUU_DEV_NATIVE=1 — rodando no HOST, fora do container (loop de quem desenvolve o huu).\n     O isolamento do Docker está DESLIGADO: os agentes alcançam as credenciais do seu shell (~/.ssh, ~/.aws, …) e não há teto de memória de container.\n     Use `npm run dev:docker` para ensaiar o que o usuário realmente recebe.',
  'cli.warn_no_cgroup':
    'huu: escopo de usuário do systemd indisponível — rodando sem teto de memória no kernel (a guarda de software continua valendo).',
  'cli.warn_yolo':
    'huu: --yolo: pulando o Docker. O agente tem acesso às credenciais do seu shell (~/.ssh, ~/.aws, etc.).',
  'cli.warn_config_corrupt_saved':
    'huu: {path} não pôde ser lido como JSON e foi SUBSTITUÍDO.\n     Suas chaves de API estavam nesse arquivo — os bytes originais foram guardados em {backup} (modo 0600).\n     Abra o arquivo num editor para copiar a chave de volta para o huu; apague-o depois.',
  'cli.warn_config_corrupt_lost':
    'huu: {path} não pôde ser lido como JSON e foi SUBSTITUÍDO.\n     O huu não conseguiu guardar uma cópia do arquivo antigo (disco cheio, ou o diretório não é gravável), então qualquer chave de API que ele tivesse se perdeu. Cadastre a chave de novo na tela de Opções.',
  'cli.web_launching':
    'huu: subindo a UI web dentro do Docker — abra {url} assim que o container estiver de pé (alguns segundos na primeira vez, mais enquanto a imagem baixa).',
  'cli.web_prefer_tui': 'Prefere a UI de terminal? Rode {command}.',

  'cli.banner_web_ui': 'UI web',
  'cli.banner_in_container': 'escutando dentro do container na :{port} (publicada para o host)',
  'cli.banner_local': 'Local',
  'cli.banner_network': 'Rede',
  'cli.banner_dev_mode': 'Modo dev',
  'cli.banner_dev_hint': 'acrescente /dev à URL acima',
  'cli.banner_token_required': '(token obrigatório — a URL com ?token= acima já o carrega)',
  'cli.banner_lan_warning':
    '(acessível na sua rede local — defina HUU_WEB_TOKEN para exigir um segredo, ou HUU_WEB_HOST=127.0.0.1 para só localhost)',
  'cli.banner_stop': 'Aperte Ctrl+C para parar.',
  'cli.banner_termlog':
    'atividade das execuções, eventos-chave e erros são registrados NESTE terminal (HUU_WEB_LOG_STREAM=1 também espelha a saída bruta dos agentes)',

  'cli.help_env_key': 'chave do {label}. Pedida na TUI quando faltar.',
  'cli.help': `huu — Humans Underwrite Undertakings · execução guiada de pipelines com kanban

Uso:
  huu                       Abre a UI web (padrão) — painel no seu navegador
  huu --cli                 Abre a UI de terminal (TUI Ink) em vez da web
  huu run <pipeline.json>   Pré-carrega um pipeline (UI web, ou seletor de modelo da TUI com --cli)
  huu auto <p.json> --config <c.json>
                            Execução headless — sem TUI. O JSON de config informa
                            modelo, backend e a seleção de arquivos por passo.
  huu dev "<objetivo>"      Modo desenvolvimento — cria as skills de agente do
                            projeto quando faltam, depois planeja e roda épocas de
                            FRENTES paralelas como um enxame de worktrees. Ver flags dev.
  huu graph <sub> [...]     O método DESENHADO, pelo terminal: lista, desenha, valida,
                            compila, cria e apaga os devgraphs salvos em
                            .huu/dev/graphs/. Ver subcomandos do graph.
  huu init-docker [...]     Gera o compose.huu.yaml no repositório atual
  huu status [...]          Inspeciona a última execução via .huu/debug-*.log
  huu prune [...]           Lista/mata containers huu órfãos + cidfiles obsoletos
  huu --dir=<caminho>       Roda neste diretório em vez do atual (padrão: cwd)
  huu --provider=<nome>     Provedor de LLM — o endpoint chamado e a chave gasta:
                            deepseek (padrão, apelido ds), openrouter (apelido or)
  huu --backend=<tipo>      Avançado: o processo de agente que roda cada tarefa:
                            jcode (padrão), stub
  huu --stub                Atalho para --backend=stub (sem LLM de verdade)
  huu --yolo                Pula o Docker, roda nativo no host (o agente vê as credenciais do seu shell)
  huu --no-docker           Atalho para --yolo / HUU_NO_DOCKER=1 — grafia neutra para runners de CI
  huu --cli                 Usa a UI de terminal em vez da UI web padrão
  huu --web                 Força a UI web (sobrepõe HUU_CLI=1)
  huu --port=<n>            Porta da UI web (padrão 4888; ou HUU_WEB_PORT)
  huu --concurrency=<n>     Fixa a concorrência manual em n (desliga a auto-escala por memória)
  huu --ram-percent=<n>     Orçamento de RAM em % da memória total (10-95, padrão 70; ou
                            HUU_RAM_PERCENT, ou o dial salvo na TUI [O] / Configurações web)
  huu --no-auto-scale       Desliga a auto-escala por memória (ligada por padrão; a guarda continua)
  huu --auto-scale          Obsoleto: a auto-escala já é o padrão
  huu --help                Mostra esta ajuda

flags do dev:
  --model <id>              Modelo do planejador e do enxame (obrigatório, exceto com --stub)
  --graph <id|arquivo.json> Roda um MÉTODO QUE VOCÊ DESENHOU em vez do planner LLM. Um slug
                            puro (a-z, 0-9, hífens) é um grafo salvo em .huu/dev/graphs/;
                            qualquer outra coisa é um caminho para um .json. Um desenho é o
                            método COMPLETO, então a sessão é exatamente UMA época e
                            --epochs > 1 é recusado. As 13 flags de metodologia e as flags
                            de modelo por papel NÃO são compiladas num desenho (aviso).
  --epochs <n>              Teto de épocas (padrão 3). Cada época planeja, roda e aterrissa.
  --fronts <n>              Teto de frentes paralelas por época (padrão 4, máx 4)
  --max-cost <usd>          Para antes da época que passaria deste gasto (as duas runs contam)
  --approve-each            Mostra o plano de cada época e espera confirmação antes de rodar
  --autonomous              Planeja e roda todas as épocas sem perguntar (o padrão)
  --skip-knowledge          Não cria as skills de agente mesmo quando o projeto não tem nenhuma
  --run-dir <caminho>       Repositório onde desenvolver (padrão: o diretório atual)
  metodologias (todas desligadas por padrão; rode 'huu dev' sem objetivo para a lista completa):
  --tdd --characterize --lint-gate --fitness --diff-budget --changelog
  --standards --checklist --write-set --plan-review --traceability --verify-claims
  --debate                  dois agentes de FAMÍLIAS diferentes discutem o design da
                            época antes das frentes; um juiz anonimizado decide, no
                            máximo 2 rodadas. Como toda opção daqui, também faz a tarefa
                            bloqueada ESPERAR por um humano em vez de waive no teto de
                            rodadas do crítico. Roteie o par com --advocate-model /
                            --prosecutor-model

subcomandos do graph (o método desenhado — sem navegador):
  list                      Lista os desenhos salvos (id, nós/arestas, válido?)
  show <id>                 Desenha a topologia em TEXTO: por nó o tipo, o bloco, o join
                            (todos vs apenas X), os braços com o destino de cada um e as
                            arestas de retrabalho que voltam
  validate <id>             Reporta cada erro e aviso com seu código estável e sua âncora;
                            sai com código != 0 quando houver qualquer erro
  compile <id> [--out <a>]  Compila o desenho num huu-pipeline-v2. Sai no stdout, ou vai
                            para --out. UM PIPELINE GRAVADO É UM ARTEFATO PORTÁTIL: rode-o
                            com 'huu auto <a> --config <c.json>', em qualquer repositório,
                            sem modo dev nenhum.
  new <id> [--from <amostra>] [--name <n>] [--force]
                            Cria um desenho vazio, ou a partir de uma amostra que vem junto
  rm <id>                   Apaga o desenho salvo
  (todo subcomando respeita o --dir=<repo> global)

flags do init-docker:
  --force                   Sobrescreve arquivos que já existem
  --with-wrapper            Também escreve scripts/huu-docker (launcher em bash)
  --with-devcontainer       Também escreve .devcontainer/devcontainer.json
  --image <ref>             Sobrescreve a referência da imagem (padrão: ghcr.io/frederico-kluser/huu:latest)

flags do status:
  --json                    Saída legível por máquina
  --liveness                Suprime a saída; sai com 0 se estiver rodando, 1 caso contrário (para HEALTHCHECK)
  --stalled-after <seg>     Limiar de travamento (padrão: 30)

flags do prune:
  --list                    Mostra containers + cidfiles obsoletos, sai com 0 (sem alterar nada)
  --dry-run                 Mostra o que 'huu prune' MATARIA, sai com 0 (sem alterar nada)
  --json                    Saída legível por máquina (combina com --list / --dry-run)

Ambiente:
{envLines}
  HUU_WEB_PORT                       Porta da UI web (padrão 4888). Igual a --port=<n>.
  HUU_WEB_HOST                       Endereço de bind da UI web (padrão 0.0.0.0; use 127.0.0.1 para só localhost).
  HUU_WEB_TOKEN                      Exige este segredo compartilhado (?token=…) para os dados + ações da UI web.
  HUU_CLI                            Defina como 1 para usar a UI de terminal por padrão (igual a --cli).
  HUU_LANG                           Idioma da interface: en (padrão) ou pt-BR. Cai para LC_ALL/LANG.
  HUU_I18N_STRICT                    Defina como 0 para avisar em vez de abortar quando faltar tradução.

Salvo globalmente em: {configPath}
(escrito quando você aceita "Salvar globalmente" no prompt da TUI; modo 0600).
`,
} as const;

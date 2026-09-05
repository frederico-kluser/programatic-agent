/** UI do navegador. Gêmeo de `en/web.ts` — servido por `GET /api/i18n`. */

export const webPtBR = {
  'web.common.add': 'Adicionar',
  'web.common.auto': 'Auto',
  'web.common.back': '← Voltar',
  'web.common.clear_all': 'Limpar tudo',
  'web.common.close': 'Fechar',
  'web.common.default': 'padrão',
  'web.common.delete': 'Excluir',
  'web.common.loading': 'Carregando…',
  'web.common.manual': 'Manual',
  'web.common.min': 'min',
  'web.common.na': 'n/d',
  'web.common.no': 'não',
  'web.common.remove': 'Remover',
  'web.common.yes': 'sim',

  'web.boot.failed': 'Falha ao carregar o huu: {message}',

  'web.top.stage': 'Estágio',
  'web.top.stage_title': 'Estágio / onda do pipeline',
  'web.top.tasks': 'Tarefas',
  'web.top.tasks_title': 'Tarefas concluídas / total',
  'web.top.elapsed': 'Decorrido',
  'web.top.elapsed_title': 'Tempo decorrido',
  'web.top.cost': 'Custo',
  'web.top.cost_title': 'Custo estimado (USD)',
  'web.top.fewer_agents': 'Menos agentes',
  'web.top.more_agents': 'Mais agentes',
  'web.top.conc_mode':
    'Modo de concorrência — clique para alternar Auto · Manual (a vazão da máquina fica no ⚙ orçamento de RAM)',
  'web.top.auto': 'auto',
  'web.top.pause': 'Pausar',
  'web.top.pause_title': 'Pausar / retomar a simulação',
  'web.top.resume': 'Retomar',
  'web.top.finish': 'Encerrar',
  'web.top.finish_title': 'Encerrar a execução — para de esperar retentativas',
  'web.top.stop': 'Parar',
  'web.top.stop_queue': 'Parar a fila',
  'web.top.stop_queue_title': 'Parar a fila inteira',
  'web.top.theme': 'Alternar tema',

  'web.mode.aria': 'Modo de trabalho',
  'web.mode.pipelines': 'Pipelines',
  'web.mode.pipelines_sub': 'Você já tem o método',
  'web.mode.development': 'Desenvolvimento',
  'web.mode.development_sub': 'Você tem um objetivo',
  'web.mode.graph': 'Desenho do método',
  'web.mode.graph_sub': 'Você desenha o método',

  'web.launch.title': 'Rodar um pipeline',
  'web.launch.subtitle':
    'Processos determinísticos sobre agentes que pensam — escolha um, escolha um modelo, vai.',
  'web.launch.queue_running': 'Fila rodando',
  'web.launch.view_board': 'Ver o quadro →',
  'web.launch.steps_aria': 'Passos do lançamento',
  'web.launch.pick_pipeline': 'Escolha um pipeline',
  'web.launch.mark_folders': 'Marque as pastas de projeto',
  'web.launch.mark_hint':
    'Navegue pelo sistema de arquivos e marque todo projeto onde este pipeline deve rodar — cada pasta marcada vira uma execução própria. As marcas persistem enquanto você navega.',
  'web.launch.no_pipelines': 'Nenhum pipeline encontrado em',

  'web.step.pipeline': 'Pipeline',
  'web.step.projects': 'Projetos',
  'web.step.config': 'Config',
  'web.step.queue': 'Fila',

  'web.folder.home': '⌂ Início',
  'web.folder.home_title':
    'Ir para a raiz do workspace (HUU_WORKSPACE, por padrão sua pasta pessoal)',
  'web.folder.home_title_short': 'Ir para a raiz do workspace',
  'web.folder.parent': '↑ Acima',
  'web.folder.mark_all': '☑ Marcar todas',
  'web.folder.mark_all_n': '☑ Marcar todas ({count})',
  'web.folder.unmark_all_n': '☐ Desmarcar todas ({count})',
  'web.folder.mark_all_title':
    'Marca toda subpasta listada aqui como projeto (quando todas estão marcadas, desmarca)',
  'web.folder.mark_all_title_n': 'Marcar as {count} subpastas listadas aqui como projetos',
  'web.folder.unmark_all_title':
    'Todas as subpastas aqui estão marcadas — clique para desmarcar todas',
  'web.folder.use_prefix': 'Usar',
  'web.folder.use_suffix': 'selecionadas →',
  'web.folder.no_subdirs': 'Sem subdiretórios',
  'web.folder.mark': 'Marcar como projeto',
  'web.folder.unmark': 'Desmarcar projeto',
  'web.folder.is_git': '✓ git',
  'web.folder.not_git': '⚠ sem git',
  'web.folder.this_folder': 'esta pasta',

  'web.config.title': 'Configure este pipeline',
  'web.config.pipeline': 'Pipeline',
  'web.config.projects': 'Projetos',
  'web.config.provider': 'Provedor',
  'web.config.model': 'Modelo',
  'web.config.model_placeholder': 'Carregando modelos…',
  'web.config.resolver_model': 'Modelo resolvedor de conflitos',
  'web.config.resolver_placeholder': 'Igual ao modelo da execução',
  'web.config.resolver_placeholder_value': 'Igual ao modelo da execução',
  'web.config.resolver_hint':
    'Usado só para resolver conflitos de merge durante a integração · roda no máximo de raciocínio · vazio = igual ao modelo da execução',
  'web.config.concurrency': 'Concorrência',
  'web.config.timeout': 'Tempo máximo por agente',
  'web.config.timeout_hint':
    'Limite de tempo de cada agente, aplicado ao pipeline inteiro. Vazio = o padrão global das Configurações (⚙), ou o padrão do pipeline se aquele também estiver vazio.',
  'web.config.add_to_queue': 'Adicionar à fila',
  'web.config.add_hint':
    'Este pipeline roda em todos os projetos que você marcou — adicione mais pipelines em seguida, ou rode a fila.',

  'web.queue.title': 'Fila',
  'web.queue.empty': 'A fila está vazia — adicione um pipeline para começar.',
  'web.queue.add_another': 'Adicionar outro pipeline',
  'web.queue.add_start': 'Adicionar e iniciar',
  'web.queue.run': 'Rodar a fila',
  'web.queue.run_n': 'Rodar a fila ({count})',
  'web.queue.running_label': 'Rodando…',
  'web.queue.default_model': 'modelo padrão',
  'web.queue.err_pick_first': 'Escolha um pipeline e marque pelo menos um projeto',
  'web.queue.added_starting': '{count} adicionados — começando agora',
  'web.queue.added_one': '{count} projeto adicionado à fila',
  'web.queue.added_other': '{count} projetos adicionados à fila',
  'web.queue.project_count_one': '{count} projeto',
  'web.queue.project_count_other': '{count} projetos',
  'web.queue.remove_pipeline': 'Remover pipeline',
  'web.queue.key_needed': 'falta a chave',
  'web.queue.run_word': 'execução',
  'web.queue.run_failed': '{name} falhou: {reason}',
  'web.queue.see_board': 'veja o quadro ou o log do terminal do huu',
  'web.queue.finished_ok': 'Fila concluída ✓ · salva no Histórico',
  'web.queue.finished_errors': 'Fila concluída — {count} falharam · salva no Histórico',
  'web.queue.stopped': 'Fila parada',
  'web.queue.stopping': 'Parando a fila…',

  'web.qstatus.queued': 'na fila',
  'web.qstatus.running': 'rodando',
  'web.qstatus.done': 'concluído',
  'web.qstatus.failed': 'falhou',

  'web.status.idle': 'ocioso',
  'web.status.queued': 'na fila',
  'web.status.running': 'rodando',
  'web.status.done': 'concluído',
  'web.status.error': 'erro',
  'web.status.review': 'revisão',
  'web.status.paused_ram': 'pausado (RAM)',

  'web.lane.todo': 'A fazer',
  'web.lane.doing': 'Em andamento',
  'web.lane.done': 'Concluído',

  'web.run.spinning_up': 'Subindo os agentes…',
  'web.run.preparing': 'Preparando as worktrees…',
  'web.run.wave': 'onda {n}',
  'web.run.failed_label': 'Falhou:',
  'web.run.done_label': 'Pronto.',
  'web.run.pipeline_finished': 'O pipeline “{name}” terminou.',
  'web.run.switch_projects': 'Alternar entre os projetos em execução',
  'web.run.new_run': '← Nova execução',
  'web.run.run_again': '↻ Rodar de novo',
  'web.run.stopping': 'Parando a execução…',

  'web.log.title': 'Log da execução',
  'web.log.running': 'rodando',
  'web.log.projects': '{count} projetos',
  'web.log.queued': '{count} na fila',
  'web.log.lines': '{count} linhas',
  'web.log.filter_aria': 'Filtrar o log por nível',
  'web.log.all': 'Tudo',
  'web.log.warn_only': 'Só avisos',
  'web.log.error_only': 'Só erros',
  'web.log.jump': '↓ Mais recente',
  'web.log.waiting_first': 'Aguardando a primeira linha de log…',
  'web.log.empty': 'Nenhuma entrada de log ainda.',

  'web.card.task': 'Tarefa {id}',
  'web.card.merge': 'Merge',
  'web.card.judge': 'Juiz',
  'web.card.merged_n': '{count} mesclados',
  'web.card.conflicts_n': '{count} conflito',
  'web.card.resolver': 'resolvedor',
  'web.card.default': 'padrão',
  'web.card.next': 'próximo: {name}',
  'web.card.retry_n': 'retentativa {count}',
  'web.card.review_waived_title':
    'revisão dispensada no teto de rodadas — sobraram achados bloqueantes',

  'web.phase.agent': 'agente',
  'web.phase.merge': 'merge',
  'web.phase.judge': 'juiz',
  'web.phase.timeout': 'timeout',
  'web.phase.failed': 'falhou',
  'web.phase.paused': 'pausado',
  'web.phase.no_changes': 'sem mudanças',
  'web.phase.unmerged': 'não mesclado',
  'web.phase.ready': 'pronto',
  'web.phase.requeued': 'reenfileirado',
  'web.phase.queued': 'na fila',
  'web.phase.review': 'revisão',
  'web.phase.fixing': 'corrigindo',

  'web.kv.phase': 'Fase',
  'web.kv.stage': 'Estágio',
  'web.kv.tokens_in': 'Tokens de entrada',
  'web.kv.tokens_out': 'Tokens de saída',
  'web.kv.cost': 'Custo',
  'web.kv.requeues': 'Reenfileiramentos',
  'web.kv.review_rounds': 'Rodadas de revisão',
  'web.kv.review': 'Revisão',
  'web.kv.review_waived': 'dispensada no teto de rodadas',
  'web.kv.branch': 'Branch',
  'web.kv.files': 'Arquivos',
  'web.kv.commit': 'Commit',
  'web.kv.error': 'Erro',
  'web.kv.runs': 'Execuções',
  'web.kv.run': 'Execução',
  'web.kv.merged': 'Mesclados',
  'web.kv.pending': 'Pendentes',
  'web.kv.resolver': 'Resolvedor',
  'web.kv.used': 'usado',
  'web.kv.conflicts': 'Conflitos',
  'web.kv.model': 'Modelo',
  'web.kv.outcome': 'Resultado',
  'web.kv.next': 'Próximo',
  'web.kv.from_judge': 'Veio do juiz',

  'web.drawer.logs': 'Logs',
  'web.drawer.condition': 'Condição:',

  'web.retry.timed_out': 'Deu timeout — rode de novo com um novo limite, ou como está.',
  'web.retry.failed': 'Falhou — rode esta tarefa de novo.',
  'web.retry.new_timeout': 'Novo timeout (min)',
  'web.retry.go': 'Repetir a tarefa',
  'web.retry.go_timeout': 'Repetir com o novo timeout',
  'web.retry.toast': 'Repetindo a tarefa #{id}…',
  'web.retry.finishing': 'Encerrando a execução…',

  'web.budget.tip_head':
    'O huu pode usar até {percent}% da RAM ({gib} GiB) somando todas as execuções.',
  'web.budget.tip_used': 'Usados {used} de {total} GiB · PSI some {psi}',
  'web.budget.container_scope': 'escopo do container {scope}G de host {host}G',
  'web.budget.host_avail': '{avail}G livres',
  'web.budget.guard': 'guarda: {reason}',
  'web.budget.agents_live': 'agentes vivos {live} do orçamento B {budget}',
  'web.budget.reserved': '{count} juiz/merge',
  'web.budget.footprint': 'pegada/agente ≈ {mib} MiB',
  'web.budget.chip_host': 'host {used}/{total}G',
  'web.budget.chip_agents': 'agentes {live}/{budget}',
  'web.budget.chip_ram': 'RAM {percent}%',
  'web.budget.chip_huu': 'huu {used}/{total}G',
  'web.budget.host_limited': 'limitado pelo host',
  'web.pressure.over_budget': 'acima do orçamento',
  'web.pressure.pressure': 'pressão',
  'web.pressure.thrash': 'thrashing',

  'web.combo.inherit_hint': 'herdar o modelo da execução para resolver conflitos',
  'web.combo.use_custom': 'Usar “{id}”',
  'web.combo.custom_id': 'id personalizado',
  'web.combo.custom_model_id': 'id de modelo personalizado',
  'web.combo.as_is': 'enviado ao OpenRouter como está',
  'web.combo.reasoning': 'raciocínio',
  'web.combo.thinking': 'pensa',
  'web.combo.no_tools': 'sem ferramentas',
  'web.combo.search_placeholder': 'Busque ou digite qualquer id de modelo…',
  'web.combo.type_placeholder': 'Digite um id de modelo…',
  'web.combo.available_one': '{count} modelo disponível',
  'web.combo.available_other': '{count} modelos disponíveis',
  'web.combo.models_count': '{count} modelos',
  'web.combo.full_catalog': 'catálogo completo do OpenRouter · ou digite qualquer id de modelo',
  'web.combo.catalog_offline':
    'Não deu para falar com o OpenRouter — mostrando os modelos recomendados; digite qualquer id para usá-lo mesmo assim',

  'web.key.paste_value': 'cole o valor…',
  'web.key.validate_use': 'Validar e usar',
  'web.key.expected_prefix': 'Esperado começar com “{prefix}”.',
  'web.key.set': '✓ {label} definida',
  'web.key.needed': 'falta {label}',
  'web.key.change': 'trocar',
  'web.key.session_only':
    'Validada contra o provedor e mantida só nesta aba do navegador — nunca gravada em disco.',
  'web.key.validated_session': 'Chave validada ✓ — mantida só neste navegador',
  'web.key.rejected': 'Chave rejeitada (HTTP {status}). Confira e cole de novo.',
  'web.key.wrong_provider':
    'Isso é uma chave do {label} — nada foi salvo. Escolha {label} como provedor, ou cole a chave certa.',
  'web.key.unverified':
    'Não deu para verificar o valor ({reason}) — usando nesta sessão mesmo assim.',

  'web.history.title': 'Histórico de execuções',
  'web.history.export': 'Exportar JSON',
  'web.history.none': 'Nenhuma execução ainda',
  'web.history.empty': 'Nenhuma execução ainda. Rode uma fila para construir o histórico.',
  'web.history.unavailable': 'Histórico indisponível: {message}',
  'web.history.meta_one': '{count} execução · ${total} no total',
  'web.history.meta_other': '{count} execuções · ${total} no total',
  'web.history.cards': '{count} cards',
  'web.history.unmerged': 'não mesclado',
  'web.history.col_kind': 'Tipo',
  'web.history.col_card': 'Card',
  'web.history.col_phase': 'Fase',
  'web.history.col_tokens': 'Tokens',
  'web.history.col_cost': 'Custo',
  'web.history.no_cards': 'Nenhum card registrado nesta execução.',
  'web.history.total_prefix': 'Total do projeto',
  'web.history.card_sum': 'soma dos custos dos cards ${sum}',
  'web.history.nothing_export': 'Nada para exportar',
  'web.history.exported_one': '{count} execução exportada',
  'web.history.exported_other': '{count} execuções exportadas',
  'web.history.confirm_clear': 'Limpar todo o histórico? Isso não tem volta.',

  'web.settings.title': 'Configurações',
  'web.settings.aria': 'Configurações da UI web',
  'web.settings.language': 'Idioma',
  'web.settings.language_hint':
    'Vale só para este navegador. A UI de terminal segue a HUU_LANG.',
  'web.settings.language_changed': 'Idioma alterado',
  'web.settings.timeout_hint':
    'Padrão para toda execução iniciada por este navegador, aplicado ao pipeline inteiro. Vazio = o padrão do pipeline (10 min · 5 min para tarefas de arquivo único). Um valor por projeto sobrepõe este. Só na UI web — o CLI mantém as próprias regras.',
  'web.settings.timeout_global': '{minutes} (global)',
  'web.settings.ram': 'Orçamento de RAM',
  'web.settings.ram_hint':
    'Fatia da RAM total que o huu pode usar somando TODAS as execuções simultâneas desta máquina (10–95). Aplicada IMEDIATAMENTE às execuções em andamento e na fila, persistida no servidor e imposta pela guarda de pressão (o chip da barra mostra o valor vivo). Maior = mais paralelismo, margem de segurança menor; o resto fica reservado ao sistema. Vazio = 70%.',
  'web.settings.ram_applied': 'Orçamento de RAM: {percent}% — aplicado a todas as execuções agora',
  'web.settings.keys': 'Chaves de API do provedor',
  'web.settings.checking': 'Verificando…',
  'web.settings.validate_add': 'Validar e adicionar',
  'web.settings.validating': 'Validando…',
  'web.settings.keys_hint':
    'Verificada primeiro contra o provedor selecionado — uma chave rejeitada, ou que pertence a outro provedor, nunca é salva. Uma chave válida entra no pool e é usada por toda execução nova (nesta sessão e nos próximos huu); esta aba passa a usá-la imediatamente. Com mais de uma chave o huu alterna por tentativa, pulando as queimadas e as em espera. Os resultados da validação e qualquer problema de execução também vão para o terminal onde o huu roda.',
  'web.settings.in_use': 'em uso',
  'web.settings.remove_key': 'Remover esta chave do pool',
  'web.settings.pool_count_one':
    '{count} chave no pool · o huu alterna por tentativa, pulando as queimadas e as em espera.',
  'web.settings.pool_count_other':
    '{count} chaves no pool · o huu alterna por tentativa, pulando as queimadas e as em espera.',
  'web.settings.pool_reset': 'zerar queimadas / esperas',
  'web.settings.pool_reset_done': 'Chaves queimadas e esperas zeradas',
  'web.settings.no_key': 'Ainda não há chave do {label} — cole uma abaixo.',
  'web.settings.active_key': '✓ Ativa: {masked} — {source}',
  'web.settings.clear_saved': 'apagar a chave salva',
  'web.settings.env_ignored':
    '⚠ {envVar} está definida no ambiente mas é IGNORADA — a chave acima ganha. Apague a chave salva para voltar a ela.',
  'web.settings.session_key':
    'Esta aba tem uma chave de sessão validada e a envia com as execuções lançadas aqui.',
  'web.settings.status_unavailable': 'Status da chave indisponível: {message}',
  'web.settings.paste_first': 'Cole uma chave do {label} primeiro.',
  'web.settings.key_wrong_provider':
    'Isso é uma chave do {label}, não do {expected} — nada foi salvo.',
  'web.settings.key_rejected':
    'O {label} rejeitou esta chave (HTTP {status}) — nada foi salvo. Confira e cole de novo.',
  'web.settings.key_saved': 'Chave validada ✓ e salva — toda execução nova vai usá-la',
  'web.settings.key_unverified':
    'Não deu para falar com o {label} para verificar ({reason}) — a chave foi salva mesmo assim; as execuções vão tentar.',
  'web.settings.key_removed': 'Chave removida do pool',
  'web.settings.key_cleared': 'Chave salva apagada',
  'web.settings.key_cleared_note': 'Chave salva apagada — {note}',

  'web.keysrc.options': 'salva por esta tela de Opções (ativa agora)',
  'web.keysrc.stored': 'chave salva (config store)',
  'web.keysrc.secret_mount': 'repassada pelo host quando o huu subiu',
  'web.keysrc.env_file': 'arquivo indicado pela variável _FILE',
  'web.keysrc.env': 'variável de ambiente',

  'web.sim.title': 'Simulação',
  'web.sim.subtitle':
    'Veja o kanban, os agentes e os logs ao vivo do começo ao fim — totalmente sintético: sem branches, sem chave de API, sem custo. Escolha seus modelos, quantos arquivos e quantos agentes rodam ao mesmo tempo.',
  'web.sim.configure': 'Configure a simulação',
  'web.sim.models': 'Modelos',
  'web.sim.model_placeholder': 'ex.: deepseek/deepseek-chat — digite e Adicione',
  'web.sim.files': 'Número de arquivos',
  'web.sim.agents': 'Agentes simultâneos',
  'web.sim.start': 'Iniciar a simulação',
  'web.sim.hint':
    'Cada execução sorteia a mistura completa de cenários — streaming, reenfileiramentos da guarda de memória (↻), retentativas, merges de estágio e o laço de retrabalho do juiz.',
  'web.sim.back': '← Voltar ao huu',

  'web.dev.title': 'Modo desenvolvimento',
  'web.dev.subtitle':
    'Escreva o objetivo — o huu cria as skills de agente do projeto quando ele não tem nenhuma, depois planeja e roda épocas de <strong>frentes</strong> paralelas, cada uma abrindo um enxame de agentes em worktrees e fechando num juiz. Você subscreve o objetivo; o planejador só o decompõe.',
  'web.dev.goal': 'Objetivo',
  'web.dev.goal_placeholder':
    'ex.: migrar o parser para streaming sem quebrar a API pública',
  'web.dev.chars': '{count} caracteres',
  'web.dev.mic_title': 'Ditar o objetivo (segure ou clique para gravar)',
  'web.dev.mic_stop': 'Parar e transcrever',
  'web.dev.mic_hint':
    'Clique no microfone para ditar — transcrito pelo Gemini via sua chave do OpenRouter.',
  'web.dev.mic_unsupported': 'Este navegador não consegue gravar áudio',
  'web.dev.mic_denied': 'Permissão de microfone negada',
  'web.dev.mic_absent': 'Nenhum microfone disponível',
  'web.dev.mic_recording': 'Gravando — clique de novo para parar e transcrever.',
  'web.dev.mic_nothing': 'Nada foi gravado.',
  'web.dev.mic_transcribing': 'Transcrevendo…',
  'web.dev.mic_no_speech': 'Nenhuma fala detectada nesse trecho.',
  'web.dev.mic_done': 'Transcrito com {model}.',
  'web.dev.mic_failed': 'A ditadura falhou.',
  'web.dev.project': 'Projeto',
  'web.dev.project_selected': 'Projeto selecionado',
  'web.dev.project_use': 'Usar esta pasta como o projeto',
  'web.dev.model_fallback': 'Modelo para todos os papéis (o servidor não tem tabela de papéis)',
  'web.dev.model_placeholder': 'ex.: anthropic/claude-sonnet-4',
  'web.dev.route_roles': 'Roteie cada papel para o seu próprio modelo',
  'web.dev.preset': 'Preset',
  'web.dev.roles_hint':
    'Dividir papéis entre modelos <strong>não</strong> é otimização de custo — um fan-out custa várias vezes um agente único, enquanto a diferença de preço entre esses modelos é de cerca de 2×. O ponto é isolamento de contexto, paralelismo e, para o crítico, uma segunda opinião de outro fornecedor.',
  'web.dev.methodology': 'Metodologia',
  'web.dev.methodology_hint':
    'Tudo DESLIGADO por padrão — sem nada marcado, a sessão compila exatamente o pipeline que compila hoje. Cada opção muda a ESTRUTURA compilada (passos, portões, rubricas); nenhuma dá campos novos ao modelo.',
  // Os checkboxes de metodologia. Chaveados pelo campo de `DevMethodology`
  // para o navegador renderizar o texto do CATÁLOGO, não o inglês cru que o
  // servidor serve a partir de `methodology-registry.ts` — aquele registry
  // declara QUAIS opções existem; estas chaves declaram como elas se LEEM.
  'web.dev.method.tdd.label': 'TDD',
  'web.dev.method.tdd.desc':
    'Cada frente escreve os testes primeiro (e os vê falhar) antes de implementar.',
  'web.dev.method.lintGate.label': 'Portão de lint',
  'web.dev.method.lintGate.desc':
    'O lint/typecheck do projeto vira um portão de merge determinístico — falhou, o merge é desfeito.',
  'web.dev.method.standards.label': 'Validação de padrões',
  'web.dev.method.standards.desc':
    'O atlas da época e as convenções do projeto viram rubrica obrigatória para todo crítico.',
  'web.dev.method.planReview.label': 'Validação das escolhas',
  'web.dev.method.planReview.desc':
    'Um agente audita as decisões do plano antes do fan-out, com um retorno para o recon.',
  'web.dev.method.writeSet.label': 'Write-set declarado',
  'web.dev.method.writeSet.desc':
    'Tarefa que escreve arquivo fora do que seu spec declara é bloqueada — pelo crítico antes do merge e pelo juiz da frente depois dele.',
  'web.dev.method.changelogGate.label': 'Disciplina de changelog',
  'web.dev.method.changelogGate.desc':
    'Assuntos de commit têm que ser Conventional Commits, e mudança visível ao usuário tem que levar entrada de changelog no mesmo diff.',
  'web.dev.method.diffBudget.label': 'Lotes pequenos',
  'web.dev.method.diffBudget.desc':
    'O diff de cada tarefa tem teto de linhas e arquivos no merge, para nenhuma mudança passar do tamanho em que a revisão deixa de funcionar.',
  'web.dev.method.fitnessFunctions.label': 'Regras de arquitetura',
  'web.dev.method.fitnessFunctions.desc':
    'A checagem de dependências/camadas do projeto roda como portão de merge, e suas regras declaradas viram rubrica citável para todo crítico.',
  'web.dev.method.checklistReview.label': 'Revisão por checklist',
  'web.dev.method.checklistReview.desc':
    'Todo crítico responde um checklist fixo item a item — PASS/FAIL/N-A com evidência — em vez de escrever prosa livre.',
  'web.dev.method.traceability.label': 'Matriz de rastreabilidade',
  'web.dev.method.traceability.desc':
    'Depois do fan-out, um agente mapeia cada critério para o teste que o resolve e de volta, e um check recusa órfão nas duas direções.',
  'web.dev.method.characterization.label': 'Testes de caracterização',
  'web.dev.method.characterization.desc':
    'Cada frente registra o comportamento observável de hoje como snapshots commitados ANTES de mudar qualquer coisa; divergência depois disso tem que ser aprovada explicitamente.',
  'web.dev.method.chainOfVerification.label': 'Verificação de afirmações',
  'web.dev.method.chainOfVerification.desc':
    'Na fase de conhecimento, um segundo agente re-checa cada afirmação contra o repositório e rebaixa o que não consegue reproduzir — nada inventado chega ao plano.',
  /* QUEM ESCREVE A TOPOLOGIA. Ou o planner LLM decompõe o objetivo (o que o
     modo dev sempre fez), ou o huu compila um método que o humano DESENHOU no
     canvas. Os dois são exclusivos, e o desenho vence sempre que estiver posto. */
  'web.dev.method_source': 'Método',
  'web.dev.method_source_planner': 'Planner LLM',
  'web.dev.method_source_graph': 'Método que você desenhou',
  'web.dev.method_source_hint_planner':
    'O planner decompõe seu objetivo em frentes paralelas, época após época. Ele escreve a topologia; você assembla o objetivo.',
  'web.dev.method_source_hint_graph':
    'O huu compila o desenho exatamente como você desenhou: uma época, sem planner, sem passo inventado.',
  'web.dev.graph_pick': 'Método salvo',
  'web.dev.graph_pick_placeholder': 'Escolha um método…',
  'web.dev.graph_pick_empty':
    'Este projeto ainda não tem método salvo — desenhe um no canvas e salve.',
  'web.dev.graph_pick_failed': 'Não deu para listar os métodos salvos: {message}',
  'web.dev.graph_invalid_tag': 'com problemas',
  'web.dev.graph_meta': '{nodes} nó(s) · {edges} ligação(ões)',
  'web.dev.graph_open_canvas': 'Abrir o canvas',
  'web.dev.err_no_graph': 'Escolha o método desenhado, ou volte para o planner LLM',
  'web.dev.err_graph_invalid':
    'Esse método ainda tem problemas — conserte no canvas antes de rodar',
  /* NÃO escondido, AVISADO. O driver carrega os dois como metadado da sessão e
     nenhum dos dois é compilado num desenho, então a interface honesta é o
     painel continuar ali com uma frase dizendo o que ele faz e o que não faz. */
  'web.dev.graph_meta_only': 'não é compilado no desenho',
  'web.dev.graph_meta_warning':
    'Um método desenhado é compilado a partir do <strong>desenho</strong>. O huu registra estas escolhas na sessão e devolve elas para você, mas não as transforma em passos nem em portões — o que roda é o que você desenhou.',
  'web.dev.how_it_runs': 'Como roda',
  'web.dev.approval': 'Aprovação',
  'web.dev.autonomous': 'Autônomo',
  'web.dev.approve_each': 'Aprovar cada época',
  'web.dev.approval_hint_auto':
    'Roda até o objetivo ser reportado como concluído, ou até você parar. Não há limite de épocas.',
  'web.dev.approval_hint_each':
    'O plano de cada época espera sua aprovação antes de qualquer agente rodar.',
  'web.dev.fronts': 'Frentes paralelas',
  'web.dev.fronts_hint':
    'Auto deixa o planejador escolher (até 4). Manual fixa o teto — o compilador o impõe, não só o prompt.',
  'web.dev.start': 'Iniciar o desenvolvimento',
  'web.dev.merge_warning':
    'Toda época termina num merge na sua branch atual, então commite ou guarde seu trabalho antes.',
  'web.dev.session': 'Sessão',
  'web.dev.gate_plan': 'Este plano está esperando por você',
  'web.dev.run_epoch': 'Rodar esta época',
  'web.dev.stop_session': 'Parar a sessão',
  'web.dev.gate_resume': 'Continuar a sessão anterior?',
  'web.dev.resume_accept': 'Continuar',
  'web.dev.resume_reject': 'Começar do zero',
  'web.dev.gate_orphan': 'Branches do huu de uma execução anterior sem merge',
  'web.dev.orphan_land': 'Aterrissar',
  'web.dev.orphan_ignore': 'Ignorar e continuar',
  'web.dev.abort': 'Abortar a sessão',
  'web.dev.err_no_goal': 'Escreva o objetivo primeiro',
  'web.dev.err_no_model': 'Escolha um modelo para cada papel',
  'web.dev.err_no_dir': 'Escolha a pasta do projeto',
  'web.dev.err_preset_provider':
    'O preset “{preset}” só roda em {providers} — troque de provedor, ou escolha um preset que este atenda.',
  'web.dev.session_started': 'Sessão iniciada ({id})',
  'web.dev.row_goal': 'Objetivo',
  'web.dev.row_project': 'Projeto',
  'web.dev.row_session': 'Sessão',
  'web.dev.row_models': 'Modelos',
  'web.dev.row_knowledge': 'Knowledge',
  'web.dev.row_stopped': 'Encerrou',
  'web.dev.row_progress': 'Progresso',
  'web.dev.resumed': 'retomada',
  'web.dev.no_epoch_cap': 'sem teto — roda até concluir',
  'web.dev.done_when': 'Pronto quando: {text}',
  'web.dev.front_max': 'até {count} agente(s)',
  'web.dev.front_after': 'depois de {list}',
  'web.dev.front_parallel': 'paralelo',
  'web.dev.epoch_n': 'Época {n}',
  'web.dev.progress': '{done} época(s) concluída(s) · continua na {next}',
  'web.dev.resume_generic':
    'Uma sessão anterior com este mesmo objetivo pode continuar de onde parou.',
  'web.dev.commits_ahead': '{count} commit(s) à frente',
  'web.dev.no_branches': 'Nenhum branch listado.',

  /* O painel de sessão, quando a sessão é um DESENHO. `drawnMethod` chega no
     primeiro frame; `graph` só depois que o desenho compila. */
  'web.dev.row_method': 'Método desenhado',
  'web.dev.method_head': '{name} — seu desenho, compilado como você desenhou',
  'web.dev.method_nodes': 'Nós, na ordem em que rodam',
  'web.dev.method_root': 'Os artefatos caem em {path}',
  'web.dev.method_steps': '{count} passo(s)',
  'web.dev.method_compiling': 'Compilando o desenho…',
  'web.dev.plan_warnings': 'Leia isto antes de aprovar',

  /* O portão de retomada, quando a sessão em disco era um DESENHO. */
  'web.dev.resume_method': 'Método desenhado',
  'web.dev.resume_method_ready':
    'É o método selecionado aqui, então continuar reenvia ele.',
  'web.dev.resume_method_missing':
    'Continuar exige exatamente este método. O huu vai reenviar “{id}” para você — sem ele a retomada é recusada (uma sessão aberta como desenho nunca é entregue ao planner).',
  'web.dev.resume_accept_with_graph': 'Continuar com “{name}”',
  'web.dev.resume_restarting': 'Reenviando o método desenhado “{id}”…',
  'web.dev.resume_restart_failed':
    'Não deu para reiniciar a sessão com “{id}”: {message}',

  'web.role.inherits': 'herda o modelo do worker',
  'web.role.planner': 'Planejador',
  'web.role.planner_hint':
    'O orquestrador cego — sem ferramentas, sem leitura de arquivos, sem digest do repositório. Uma chamada estruturada, não um agente pi, então um id que o registro do pi nunca ouviu falar é aceitável aqui e fatal em qualquer outro lugar.',
  'web.role.recon': 'Recon',
  'web.role.recon_hint':
    'Reconhecimento global e por frente — a recuperação que o planejador delega em vez de pular.',
  'web.role.worker': 'Worker',
  'web.role.worker_hint': 'O fan-out de memória: os agentes que realmente escrevem o código.',
  'web.role.critic': 'Crítico',
  'web.role.critic_hint':
    'Revisa o diff de cada tarefa na worktree do worker ANTES do merge. De outra família que o worker de propósito — um modelo auditando a própria família é a suposição mais frágil deste desenho.',
  'web.role.reporter': 'Relator',
  'web.role.reporter_hint': 'Consolidar e selar — prosa mecânica sobre um diff.',
  'web.role.judge': 'Juiz',
  'web.role.judge_hint':
    'Verificação da frente e o portão da época. Toda verificação tem um resultado padrão para a frente, então um juiz que falha APROVA EM SILÊNCIO — o único lugar onde manter o modelo forte.',
  'web.role.integration': 'Integração',
  'web.role.integration_hint': 'O resolvedor de conflitos de merge.',

  'web.preset.hetero': 'Hetero ★',
  'web.preset.hetero_hint':
    'Líder cego forte, enxame barato e um crítico de outra família.',
  'web.preset.thrifty': 'Econômico',
  'web.preset.thrifty_hint':
    'Hetero com o relator rebaixado — ele só escreve prosa sobre um diff.',
  'web.preset.monoculture': 'Monocultura',
  'web.preset.monoculture_hint':
    'LINHA DE BASE A/B, não uma recomendação: todo papel — inclusive o crítico — no próprio modelo do worker. É exatamente a configuração que a evidência aponta como a mais frágil; existe para o crítico de outra família poder ser medido contra ela.',
  'web.preset.roster': 'Elenco',
  'web.preset.roster_hint':
    'Um endpoint, cinco fabricantes: o modelo mais forte no juiz (cuja falha é silenciosa), o promotor de outra família que os workers e o flash barato no fan-out.',
  'web.preset.uniform': 'Uniforme',
  'web.preset.uniform_hint':
    'Todo papel no mesmo modelo — o que estiver no campo do worker. O comportamento anterior ao roteamento.',
  'web.preset.needs_provider':
    'Indisponível neste provedor: estes ids são servidos por {providers}.',

  /* ── O desenho do método (/graph) ──────────────────────────────────────────
     Só chrome. Toda REGRA que a tela enuncia — por que uma ligação foi
     recusada, o que um problema do validador significa — chega como FRASE
     pronta de `graph-model.js` ou do servidor e é mostrada literalmente, então
     essas mensagens não são chaves daqui. Uma tabela, uma voz: uma segunda
     cópia dos 45 códigos seria uma segunda autoridade no instante em que um
     dos lados fosse editado. */
  'web.graph.untitled': 'Método sem nome',
  'web.graph.name_label': 'Nome do método',
  'web.graph.id_title': 'O id que nomeia este método no disco',
  'web.graph.save': 'Salvar',
  'web.graph.saving': 'Salvando…',
  'web.graph.saved': '“{name}” salvo',
  'web.graph.save_failed': 'Salvamento recusado: {message}',
  'web.graph.validate': 'Conferir',
  'web.graph.validate_failed': 'Não dá para conferir agora: {message}',
  'web.graph.sample_label': 'Abrir um exemplo pronto',
  'web.graph.sample_placeholder': 'Abrir um exemplo…',
  'web.graph.sample_failed': 'Não foi possível abrir o exemplo: {message}',
  'web.graph.catalog_failed': 'O catálogo de blocos não carregou: {message}',
  'web.graph.node_count': '{nodes} nós · {edges} ligações',
  'web.graph.status_checking': 'Conferindo…',
  'web.graph.status_ok': 'Nada a corrigir',
  'web.graph.status_errors': '{count} problema(s)',
  'web.graph.status_warnings': '{count} observação(ões) — nada quebrado',

  'web.graph.node.next': 'Próximo passo',
  'web.graph.node.next_open': 'Abrir a paleta: o que vem depois deste passo',
  'web.graph.node.arm_open': 'Abrir a paleta do braço “{arm}”',
  'web.graph.node.in': 'Ligações que chegam',
  'web.graph.node.issues': '{count} problema(s) neste nó',
  'web.graph.node.warnings': '{count} observação(ões) neste nó',

  'web.graph.palette.title': 'O que vem agora?',
  'web.graph.palette.from': 'A partir de “{label}”',
  'web.graph.palette.from_arm': 'A partir de “{label}” · braço “{arm}”',
  'web.graph.palette.empty':
    'O catálogo não serviu bloco nenhum, então não há o que oferecer. Reabra esta tela para buscá-lo de novo.',
  'web.graph.palette.hint': '↑↓ para mover · Enter para adicionar · Esc para fechar',
  'web.graph.palette.blocked': 'Nada pode ser adicionado neste ponto.',

  'web.graph.inspector.title': 'Nó',
  'web.graph.inspector.empty': 'Escolha um nó no desenho para editá-lo.',
  'web.graph.inspector.label': 'Rótulo',
  'web.graph.inspector.block': 'Bloco',
  'web.graph.inspector.issues': 'Relatado aqui',
  'web.graph.inspector.delete': 'Excluir nó',
  'web.graph.inspector.text_goal': 'Objetivo deste método',
  'web.graph.inspector.text_prompt': 'Prompt (substitui o modelo do próprio bloco)',
  'web.graph.inspector.text_query': 'Pergunta que esta pesquisa responde',
  'web.graph.inspector.text_condition': 'Condição que o juiz verifica',
  'web.graph.inspector.join': 'Espera por',
  'web.graph.inspector.join_all': 'Esperar todos',
  'web.graph.inspector.join_subset': 'Esperar apenas os que eu marcar',
  'web.graph.inspector.join_none': 'Ainda não chega nada neste nó.',
  'web.graph.inspector.join_root': 'A entrada do prompt é a raiz do método: ela não espera ninguém.',
  'web.graph.inspector.join_honest':
    'Relaxar o join tira a DEPENDÊNCIA — este passo deixa de esperar os braços que você desmarcou, e deixa de falhar quando eles falham. NÃO tira a barreira de merge da onda: o huu continua mesclando todos os braços do estágio antes de o próximo começar.',

  /* A vida do método: a biblioteca, o id no disco, a compilação. */
  'web.graph.library': 'Métodos',
  'web.graph.library_empty': 'Nenhum método salvo neste projeto ainda.',
  'web.graph.library_failed': 'Não foi possível listar os métodos: {message}',
  'web.graph.open_failed': 'Não foi possível abrir “{id}”: {message}',
  'web.graph.id_label': 'Id no disco',
  'web.graph.rename': 'Trocar o id',
  'web.graph.rename_warn':
    'Renomear não existe: o huu vai APAGAR “{from}” e salvar “{to}”. Quem apontava para o arquivo antigo deixa de encontrá-lo.',
  'web.graph.rename_apply': 'Apagar e salvar',
  'web.graph.renamed': '“{from}” agora é “{to}”',
  'web.graph.rename_orphan':
    '“{to}” foi salvo, mas “{from}” não pôde ser apagado ({message}) — os dois existem agora.',
  'web.graph.rename_failed': 'Não deu para trocar o id: {message}',
  'web.graph.compile': 'Compilar',
  'web.graph.compiling': 'Compilando…',
  'web.graph.compile_ok': '{count} passo(s) — é isto que vai rodar',
  'web.graph.compile_failed': 'Não compila: {message}',
  'web.graph.compile_close': 'Fechar',
  'web.graph.compile_depends': 'espera por',
  'web.graph.compile_default': 'padrão',
  'web.graph.compile_check': 'verificação',
  'web.graph.compile_work': 'trabalho',

  /* Rodar o desenho. O canvas não inicia a sessão sozinho: ele entrega o método
     para o modo de desenvolvimento, que é dono do objetivo, do projeto e do
     roteamento de modelos. A outra ponta está em `web.dev.method_source_*`. */
  'web.graph.run': 'Rodar este método',
  'web.graph.run_title': 'Abrir o modo de desenvolvimento com este método já selecionado',
  'web.graph.run_ready': 'Roda como UMA época — o planner nunca é chamado.',
  'web.graph.run_blocked_checking': 'Conferindo o desenho…',
  'web.graph.run_blocked_check_failed':
    'A conferência não rodou ({message}) — confira de novo antes de rodar.',
  'web.graph.run_blocked_invalid': '{count} problema(s) para resolver antes de rodar.',
  'web.graph.run_blocked_unsaved':
    'Salve primeiro — o huu roda o método que está no disco, não o que está na tela.',
  'web.graph.run_handoff': '“{name}” selecionado — escreva o objetivo e comece.',

  /* A pesquisa: o que ela devolve e o que cada resposta aciona. */
  'web.graph.inspector.use_context': 'Ler o que este repositório já sabe',
  'web.graph.inspector.use_context_hint':
    'Ligado: o agente lê os artefatos que as etapas anteriores produziram — e o próprio repositório — ANTES de formular a busca, então a pergunta nasce ancorada. Desligado: ele responde só com o modelo e a web.',
  'web.graph.inspector.output_kind': 'O que esta pesquisa devolve',
  'web.graph.inspector.output_boolean': 'Sim / não',
  'web.graph.inspector.output_choice': 'Múltipla escolha',
  'web.graph.inspector.output_info': 'Informativa',
  'web.graph.inspector.output_boolean_hint':
    'Uma afirmação a definir. O juiz responde por um dos dois braços, e cada braço pode acionar um trabalho diferente.',
  'web.graph.inspector.output_choice_hint':
    'Uma resposta entre as opções que você cadastrar. Cada opção é um braço, e cada braço pode acionar um trabalho diferente.',
  'web.graph.inspector.output_info_hint':
    'Não há nada a configurar: uma pesquisa informativa não tem saída para rotear. O que ela descobrir entra como CONTEXTO na etapa seguinte.',

  /* Os braços e o comportamento cadastrado em cada um. */
  'web.graph.inspector.arms': 'Saídas, e o que cada uma aciona',
  'web.graph.inspector.choices': 'Opções, e o que cada uma aciona',
  'web.graph.inspector.outcomes': 'Vereditos, e o que cada um aciona',
  'web.graph.inspector.arm_goes_to': 'Aciona “{label}”',
  'web.graph.inspector.arm_goes_back_to': 'VOLTA para “{label}” — retrabalho',
  'web.graph.inspector.arm_empty': 'Sem comportamento cadastrado',
  'web.graph.inspector.arm_configure': 'Escolher o que ela aciona',
  'web.graph.inspector.arm_add': 'Adicionar',
  'web.graph.inspector.arm_add_label': 'Nome da nova opção',
  'web.graph.inspector.arm_remove': 'Remover',
  'web.graph.inspector.arm_min_two':
    'Uma ramificação precisa de pelo menos duas saídas — com uma só não há o que decidir.',
  'web.graph.inspector.arm_id_taken':
    '“{id}” já é uma saída deste nó. Dê outro nome a esta.',
  'web.graph.inspector.arm_id_invalid':
    'Dê um nome com letras ou números: o id derivado dele é o que roteia a execução.',
  'web.graph.inspector.arm_id_frozen':
    'O id roteia a execução e toda ligação que o cita, então ele é definido uma vez. Renomeie o texto, não o id.',
  'web.graph.inspector.default_outcome': 'Saída padrão',
  'web.graph.inspector.default_hint':
    'Ela dispara quando o juiz falha, estoura o tempo ou responde algo desconhecido — ninguém a escolhe. Por isso tem que ser a rota SEGURA para a frente, nunca o laço de volta.',
  'web.graph.inspector.rework_tag': 'retrabalho',
  'web.graph.inspector.rework_title': 'Mandar o trabalho de volta',
  'web.graph.inspector.rework_hint':
    'Escolha o veredito que volta e o passo para onde ele volta. Só um passo que já rodou pode receber, e a saída padrão nunca pode ser a que dá o laço.',
  'web.graph.inspector.rework_arm': 'Do braço…',
  'web.graph.inspector.rework_target': 'De volta para…',
  'web.graph.inspector.rework_create': 'Desenhar o braço que volta',
  'web.graph.inspector.rework_none': 'Nada roda antes deste nó, então não há para onde voltar.',
  'web.graph.inspector.switch_warn':
    '{count} ligação(ões) saem de braços que esta troca elimina. Elas vão junto.',
  'web.graph.inspector.switch_apply': 'Trocar e remover as ligações',
  'web.graph.inspector.switch_cancel': 'Cancelar',

  /* A ação: o que ela roda, sobre o quê, e em que largura. */
  'web.graph.inspector.template': 'O que este bloco roda',
  'web.graph.inspector.template_missing': 'O catálogo não traz modelo para este bloco.',
  'web.graph.inspector.fanout': 'Abrir em frentes sobre o que uma etapa anterior achou',
  'web.graph.inspector.fanout_off': 'Não abrir em frentes',
  'web.graph.inspector.fanout_none':
    'Nenhum passo antes deste escreve uma lista para abrir em frentes. Um bloco que produz lista — o Reconhecimento, por exemplo — precisa rodar antes.',
  'web.graph.inspector.fanout_implies':
    'Escolher um define o escopo como “um agente por item achado”: é isso que abrir em frentes É, então o escopo deixa de ser uma escolha à parte.',
  'web.graph.inspector.scope': 'Escopo',
  'web.graph.inspector.scope_default': 'O do próprio bloco ({scope})',
  'web.graph.inspector.scope_project': 'Uma tarefa sobre o projeto inteiro',
  'web.graph.inspector.scope_per_file': 'Um agente por arquivo que você escolher',
  'web.graph.inspector.scope_memory': 'Um agente por item achado',
  'web.graph.inspector.scope_flexible': 'Livre',
  'web.graph.inspector.files': 'Arquivos (um por linha)',
  'web.graph.inspector.max_files': 'Teto das frentes',
  'web.graph.inspector.max_files_hint': 'Cada item é um agente, então este é um limite que você subscreve.',
  'web.graph.inspector.max_runs': 'Teto de visitas',
  'web.graph.inspector.max_runs_hint':
    'Quantas vezes esta verificação pode ser alcançada numa execução. É o que limita um braço que volta.',
  'web.graph.inspector.review': 'Rodar o crítico em cada tarefa',
  'web.graph.inspector.review_hint':
    'Um segundo agente revisa o que o primeiro escreveu e devolve até os achados deixarem de ser graves.',
  'web.graph.inspector.model': 'Modelo deste nó',
  'web.graph.inspector.model_hint': 'Vazio: o modelo da própria execução.',
  'web.graph.inspector.notes': 'Suas anotações (nunca vão para um agente)',
} as const;

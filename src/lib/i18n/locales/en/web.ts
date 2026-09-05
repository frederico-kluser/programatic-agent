/** Browser UI. Served to the client by `GET /api/i18n` — see src/web/client/i18n.js. */

export const webEn = {
  'web.common.add': 'Add',
  'web.common.auto': 'Auto',
  'web.common.back': '← Back',
  'web.common.clear_all': 'Clear all',
  'web.common.close': 'Close',
  'web.common.default': 'default',
  'web.common.delete': 'Delete',
  'web.common.loading': 'Loading…',
  'web.common.manual': 'Manual',
  'web.common.min': 'min',
  'web.common.na': 'n/a',
  'web.common.no': 'no',
  'web.common.remove': 'Remove',
  'web.common.yes': 'yes',

  'web.boot.failed': 'Failed to load huu: {message}',

  'web.top.stage': 'Stage',
  'web.top.stage_title': 'Pipeline stage / wave',
  'web.top.tasks': 'Tasks',
  'web.top.tasks_title': 'Tasks completed / total',
  'web.top.elapsed': 'Elapsed',
  'web.top.elapsed_title': 'Elapsed time',
  'web.top.cost': 'Cost',
  'web.top.cost_title': 'Estimated cost (USD)',
  'web.top.fewer_agents': 'Fewer agents',
  'web.top.more_agents': 'More agents',
  'web.top.conc_mode':
    'Concurrency mode — click to toggle Auto · Manual (machine throughput lives in ⚙ RAM budget)',
  'web.top.auto': 'auto',
  'web.top.pause': 'Pause',
  'web.top.pause_title': 'Pause / resume the simulation',
  'web.top.resume': 'Resume',
  'web.top.finish': 'Finish',
  'web.top.finish_title': 'Finish the run — stop waiting for retries',
  'web.top.stop': 'Stop',
  'web.top.stop_queue': 'Stop queue',
  'web.top.stop_queue_title': 'Stop the whole queue',
  'web.top.theme': 'Toggle theme',

  'web.mode.aria': 'Work mode',
  'web.mode.pipelines': 'Pipelines',
  'web.mode.pipelines_sub': 'You already have the method',
  'web.mode.development': 'Development',
  'web.mode.development_sub': 'You have a goal instead',
  'web.mode.graph': 'Method canvas',
  'web.mode.graph_sub': 'You draw the method yourself',

  'web.launch.title': 'Run a pipeline',
  'web.launch.subtitle':
    'Deterministic processes over thinking agents — pick one, choose a model, go.',
  'web.launch.queue_running': 'Queue running',
  'web.launch.view_board': 'View board →',
  'web.launch.steps_aria': 'Launch steps',
  'web.launch.pick_pipeline': 'Pick a pipeline',
  'web.launch.mark_folders': 'Mark project folders',
  'web.launch.mark_hint':
    'Navigate the filesystem and tick every project this pipeline should run on — each marked folder becomes its own run. Marks persist as you browse.',
  'web.launch.no_pipelines': 'No pipelines found in',

  'web.step.pipeline': 'Pipeline',
  'web.step.projects': 'Projects',
  'web.step.config': 'Config',
  'web.step.queue': 'Queue',

  'web.folder.home': '⌂ Home',
  'web.folder.home_title': 'Jump to the workspace root (HUU_WORKSPACE, default your home folder)',
  'web.folder.home_title_short': 'Jump to the workspace root',
  'web.folder.parent': '↑ Parent',
  'web.folder.mark_all': '☑ Mark all',
  'web.folder.mark_all_n': '☑ Mark all ({count})',
  'web.folder.unmark_all_n': '☐ Unmark all ({count})',
  'web.folder.mark_all_title':
    'Mark every sub-folder listed here as a project (when all are marked, unmarks them)',
  'web.folder.mark_all_title_n': 'Mark all {count} sub-folders listed here as projects',
  'web.folder.unmark_all_title': 'Every sub-folder here is marked — click to unmark them all',
  'web.folder.use_prefix': 'Use',
  'web.folder.use_suffix': 'selected →',
  'web.folder.no_subdirs': 'No sub-directories',
  'web.folder.mark': 'Mark as project',
  'web.folder.unmark': 'Unmark project',
  'web.folder.is_git': '✓ git',
  'web.folder.not_git': '⚠ not git',
  'web.folder.this_folder': 'this folder',

  'web.config.title': 'Configure this pipeline',
  'web.config.pipeline': 'Pipeline',
  'web.config.projects': 'Projects',
  'web.config.provider': 'Provider',
  'web.config.model': 'Model',
  'web.config.model_placeholder': 'Loading models…',
  'web.config.resolver_model': 'Conflict resolver model',
  'web.config.resolver_placeholder': 'Same as run model',
  'web.config.resolver_placeholder_value': 'Same as run model',
  'web.config.resolver_hint':
    'Used only to resolve merge conflicts during integration · runs at max thinking · empty = same as run model',
  'web.config.concurrency': 'Concurrency',
  'web.config.timeout': 'Max time per agent',
  'web.config.timeout_hint':
    "Time limit for each agent, applied to the whole pipeline. Empty = the global default from Settings (⚙), or the pipeline default if that's unset too.",
  'web.config.add_to_queue': 'Add to queue',
  'web.config.add_hint':
    'This pipeline runs on every project you marked — add more pipelines next, or run the queue.',

  'web.queue.title': 'Queue',
  'web.queue.empty': 'Queue is empty — add a pipeline to get started.',
  'web.queue.add_another': 'Add another pipeline',
  'web.queue.add_start': 'Add & start',
  'web.queue.run': 'Run queue',
  'web.queue.run_n': 'Run queue ({count})',
  'web.queue.running_label': 'Running…',
  'web.queue.default_model': 'default model',
  'web.queue.err_pick_first': 'Pick a pipeline and mark at least one project',
  'web.queue.added_starting': 'Added {count} — starting now',
  'web.queue.added_one': 'Added {count} project to the queue',
  'web.queue.added_other': 'Added {count} projects to the queue',
  'web.queue.project_count_one': '{count} project',
  'web.queue.project_count_other': '{count} projects',
  'web.queue.remove_pipeline': 'Remove pipeline',
  'web.queue.key_needed': 'key needed',
  'web.queue.run_word': 'run',
  'web.queue.run_failed': '{name} failed: {reason}',
  'web.queue.see_board': 'see the board or the huu terminal log',
  'web.queue.finished_ok': 'Queue finished ✓ · saved to History',
  'web.queue.finished_errors': 'Queue finished — {count} failed · saved to History',
  'web.queue.stopped': 'Queue stopped',
  'web.queue.stopping': 'Stopping queue…',

  'web.qstatus.queued': 'queued',
  'web.qstatus.running': 'running',
  'web.qstatus.done': 'done',
  'web.qstatus.failed': 'failed',

  'web.status.idle': 'idle',
  'web.status.queued': 'queued',
  'web.status.running': 'running',
  'web.status.done': 'done',
  'web.status.error': 'error',
  'web.status.review': 'review',
  'web.status.paused_ram': 'paused (RAM)',

  'web.lane.todo': 'To do',
  'web.lane.doing': 'In progress',
  'web.lane.done': 'Done',

  'web.run.spinning_up': 'Spinning up agents…',
  'web.run.preparing': 'Preparing worktrees…',
  'web.run.wave': 'wave {n}',
  'web.run.failed_label': 'Failed:',
  'web.run.done_label': 'Done.',
  'web.run.pipeline_finished': 'Pipeline “{name}” finished.',
  'web.run.switch_projects': 'Switch between running projects',
  'web.run.new_run': '← New run',
  'web.run.run_again': '↻ Run again',
  'web.run.stopping': 'Stopping run…',

  'web.log.title': 'Run log',
  'web.log.running': 'running',
  'web.log.projects': '{count} projects',
  'web.log.queued': '{count} queued',
  'web.log.lines': '{count} lines',
  'web.log.filter_aria': 'Filter log by level',
  'web.log.all': 'All',
  'web.log.warn_only': 'Warnings only',
  'web.log.error_only': 'Errors only',
  'web.log.jump': '↓ Latest',
  'web.log.waiting_first': 'Waiting for the first log line…',
  'web.log.empty': 'No log entries yet.',

  'web.card.task': 'Task {id}',
  'web.card.merge': 'Merge',
  'web.card.judge': 'Judge',
  'web.card.merged_n': '{count} merged',
  'web.card.conflicts_n': '{count} conflict',
  'web.card.resolver': 'resolver',
  'web.card.default': 'default',
  'web.card.next': 'next: {name}',
  'web.card.retry_n': 'retry {count}',
  'web.card.review_waived_title':
    'review waived at the round cap — blocking findings remained',

  'web.phase.agent': 'agent',
  'web.phase.merge': 'merge',
  'web.phase.judge': 'judge',
  'web.phase.timeout': 'timeout',
  'web.phase.failed': 'failed',
  'web.phase.paused': 'paused',
  'web.phase.no_changes': 'no changes',
  'web.phase.unmerged': 'unmerged',
  'web.phase.ready': 'ready',
  'web.phase.requeued': 'requeued',
  'web.phase.queued': 'queued',
  'web.phase.review': 'review',
  'web.phase.fixing': 'fixing',

  'web.kv.phase': 'Phase',
  'web.kv.stage': 'Stage',
  'web.kv.tokens_in': 'Tokens in',
  'web.kv.tokens_out': 'Tokens out',
  'web.kv.cost': 'Cost',
  'web.kv.requeues': 'Requeues',
  'web.kv.review_rounds': 'Review rounds',
  'web.kv.review': 'Review',
  'web.kv.review_waived': 'waived at the round cap',
  'web.kv.branch': 'Branch',
  'web.kv.files': 'Files',
  'web.kv.commit': 'Commit',
  'web.kv.error': 'Error',
  'web.kv.runs': 'Runs',
  'web.kv.run': 'Run',
  'web.kv.merged': 'Merged',
  'web.kv.pending': 'Pending',
  'web.kv.resolver': 'Resolver',
  'web.kv.used': 'used',
  'web.kv.conflicts': 'Conflicts',
  'web.kv.model': 'Model',
  'web.kv.outcome': 'Outcome',
  'web.kv.next': 'Next',
  'web.kv.from_judge': 'From judge',

  'web.drawer.logs': 'Logs',
  'web.drawer.condition': 'Condition:',

  'web.retry.timed_out': 'Timed out — re-run with a new time limit, or as-is.',
  'web.retry.failed': 'Failed — re-run this task.',
  'web.retry.new_timeout': 'New timeout (min)',
  'web.retry.go': 'Retry task',
  'web.retry.go_timeout': 'Retry with new timeout',
  'web.retry.toast': 'Retrying task #{id}…',
  'web.retry.finishing': 'Finishing run…',

  'web.budget.tip_head': 'huu may use up to {percent}% of RAM ({gib} GiB) across all runs.',
  'web.budget.tip_used': 'Used {used} of {total} GiB · PSI some {psi}',
  'web.budget.container_scope': 'container scope {scope}G of host {host}G',
  'web.budget.host_avail': '{avail}G avail',
  'web.budget.guard': 'guard: {reason}',
  'web.budget.agents_live': 'agents live {live} of budget B {budget}',
  'web.budget.reserved': '{count} judge/merge',
  'web.budget.footprint': 'footprint/agent ≈ {mib} MiB',
  'web.budget.chip_host': 'host {used}/{total}G',
  'web.budget.chip_agents': 'agents {live}/{budget}',
  'web.budget.chip_ram': 'RAM {percent}%',
  'web.budget.chip_huu': 'huu {used}/{total}G',
  'web.budget.host_limited': 'host-limited',
  'web.pressure.over_budget': 'over budget',
  'web.pressure.pressure': 'pressure',
  'web.pressure.thrash': 'thrash',

  'web.combo.inherit_hint': 'inherit the run model for conflict resolution',
  'web.combo.use_custom': 'Use “{id}”',
  'web.combo.custom_id': 'custom id',
  'web.combo.custom_model_id': 'custom model id',
  'web.combo.as_is': 'sent to OpenRouter as-is',
  'web.combo.reasoning': 'reasoning',
  'web.combo.thinking': 'thinking',
  'web.combo.no_tools': 'no tools',
  'web.combo.search_placeholder': 'Search or type any model id…',
  'web.combo.type_placeholder': 'Type a model id…',
  'web.combo.available_one': '{count} model available',
  'web.combo.available_other': '{count} models available',
  'web.combo.models_count': '{count} models',
  'web.combo.full_catalog': 'full OpenRouter catalog · or type any model id',
  'web.combo.catalog_offline':
    "Couldn't reach OpenRouter — showing recommended models; type any model id to use it anyway",

  'web.key.paste_value': 'paste value…',
  'web.key.validate_use': 'Validate & use',
  'web.key.expected_prefix': 'Expected to start with “{prefix}”.',
  'web.key.set': '✓ {label} set',
  'web.key.needed': '{label} needed',
  'web.key.change': 'change',
  'web.key.session_only':
    'Validated against the provider, then kept only in this browser tab — never written to disk.',
  'web.key.validated_session': 'Key validated ✓ — kept in this browser only',
  'web.key.rejected': 'Key rejected (HTTP {status}). Check it and paste again.',
  'web.key.wrong_provider':
    'That is a {label} key — not saved. Pick {label} as your provider, or paste the right key.',
  'web.key.unverified': "Couldn't verify the value ({reason}) — using it for this session anyway.",

  'web.history.title': 'Run history',
  'web.history.export': 'Export JSON',
  'web.history.none': 'No runs yet',
  'web.history.empty': 'No runs yet. Run a queue to build history.',
  'web.history.unavailable': 'History unavailable: {message}',
  'web.history.meta_one': '{count} run · ${total} total',
  'web.history.meta_other': '{count} runs · ${total} total',
  'web.history.cards': '{count} cards',
  'web.history.unmerged': 'unmerged',
  'web.history.col_kind': 'Kind',
  'web.history.col_card': 'Card',
  'web.history.col_phase': 'Phase',
  'web.history.col_tokens': 'Tokens',
  'web.history.col_cost': 'Cost',
  'web.history.no_cards': 'No cards recorded for this run.',
  'web.history.total_prefix': 'Project total',
  'web.history.card_sum': 'card costs sum ${sum}',
  'web.history.nothing_export': 'Nothing to export',
  'web.history.exported_one': 'Exported {count} run',
  'web.history.exported_other': 'Exported {count} runs',
  'web.history.confirm_clear': 'Clear all run history? This cannot be undone.',

  'web.settings.title': 'Settings',
  'web.settings.aria': 'Web UI settings',
  'web.settings.language': 'Language',
  'web.settings.language_hint':
    'Applies to this browser only. The terminal UI follows HUU_LANG.',
  'web.settings.language_changed': 'Language changed',
  'web.settings.timeout_hint':
    "Default for every run started from this browser, applied to the whole pipeline. Empty = the pipeline's default (10 min · 5 min for single-file tasks). A per-project value overrides this. Web UI only — the CLI keeps its own rules.",
  'web.settings.timeout_global': '{minutes} (global)',
  'web.settings.ram': 'RAM budget',
  'web.settings.ram_hint':
    'Share of total RAM huu may use across ALL concurrent runs on this machine (10–95). Applied IMMEDIATELY to running and queued runs, persisted on the server, and enforced by the pressure guard (the topbar chip shows the live value). Higher = more parallelism, thinner safety margin; the rest is reserved for the OS. Empty = 70%.',
  'web.settings.ram_applied': 'RAM budget: {percent}% — applied to all runs now',
  'web.settings.keys': 'Provider API keys',
  'web.settings.checking': 'Checking…',
  'web.settings.validate_add': 'Validate & add',
  'web.settings.validating': 'Validating…',
  'web.settings.keys_hint':
    'Checked against the selected provider first — a rejected key, or one that belongs to a different provider, is never saved. A valid key joins the pool and is used by every new run (this session and future huu starts); this tab starts using it immediately. With more than one key huu rotates per attempt, skipping burned and cooling ones. Validation results and any run problem are also logged in the terminal running huu.',
  'web.settings.in_use': 'in use',
  'web.settings.remove_key': 'Remove this key from the pool',
  'web.settings.pool_count_one': '{count} key in the pool · huu rotates per attempt, skipping burned and cooling ones.',
  'web.settings.pool_count_other': '{count} keys in the pool · huu rotates per attempt, skipping burned and cooling ones.',
  'web.settings.pool_reset': 'reset burned / cooldowns',
  'web.settings.pool_reset_done': 'Burned keys and cooldowns cleared',
  'web.settings.no_key': 'No {label} key yet — paste one below.',
  'web.settings.active_key': '✓ Active: {masked} — {source}',
  'web.settings.clear_saved': 'clear saved key',
  'web.settings.env_ignored':
    '⚠ {envVar} is set in the environment but IGNORED — the key above wins. Clear the saved key to fall back to it.',
  'web.settings.session_key':
    'This tab holds a validated session key and sends it with runs launched here.',
  'web.settings.status_unavailable': 'Key status unavailable: {message}',
  'web.settings.paste_first': 'Paste a {label} key first.',
  'web.settings.key_wrong_provider':
    'That is a {label} key, not a {expected} key — nothing was saved.',
  'web.settings.key_rejected':
    '{label} rejected this key (HTTP {status}) — nothing saved. Check it and paste again.',
  'web.settings.key_saved': 'Key validated ✓ and saved — every new run will use it',
  'web.settings.key_unverified':
    "Couldn't reach {label} to verify ({reason}) — key saved anyway; runs will try it.",
  'web.settings.key_removed': 'Key removed from the pool',
  'web.settings.key_cleared': 'Saved key cleared',
  'web.settings.key_cleared_note': 'Saved key cleared — {note}',

  'web.keysrc.options': 'saved via this Options screen (active now)',
  'web.keysrc.stored': 'saved key (config store)',
  'web.keysrc.secret_mount': 'forwarded from the host when huu started',
  'web.keysrc.env_file': 'file named by the _FILE env var',
  'web.keysrc.env': 'environment variable',

  'web.sim.title': 'Simulation',
  'web.sim.subtitle':
    'Watch the kanban, agents and live logs run end-to-end — fully synthetic: no branches, no API key, no cost. Pick your models, how many files, and how many agents run at once.',
  'web.sim.configure': 'Configure the simulation',
  'web.sim.models': 'Models',
  'web.sim.model_placeholder': 'e.g. deepseek/deepseek-chat — type and Add',
  'web.sim.files': 'Number of files',
  'web.sim.agents': 'Simultaneous agents',
  'web.sim.start': 'Start simulation',
  'web.sim.hint':
    'Each run randomly draws the full mix of scenarios — streaming, memory-guard requeues (↻), retries, stage merges and the judge’s rework loop.',
  'web.sim.back': '← Back to huu',

  'web.dev.title': 'Development mode',
  'web.dev.subtitle':
    "Write the goal — huu bootstraps the project's agent skills when it has none, then plans and runs epochs of parallel <strong>fronts</strong>, each fanning out into a swarm of worktree agents and closing on a judge. You underwrite the goal; the planner only decomposes it.",
  'web.dev.goal': 'Goal',
  'web.dev.goal_placeholder':
    'e.g. migrate the parser to streaming without breaking the public API',
  'web.dev.chars': '{count} chars',
  'web.dev.mic_title': 'Dictate the goal (hold or click to record)',
  'web.dev.mic_stop': 'Stop and transcribe',
  'web.dev.mic_hint': 'Click the mic to dictate — transcribed by Gemini via your OpenRouter key.',
  'web.dev.mic_unsupported': 'This browser cannot record audio',
  'web.dev.mic_denied': 'Microphone permission denied',
  'web.dev.mic_absent': 'No microphone available',
  'web.dev.mic_recording': 'Recording — click again to stop and transcribe.',
  'web.dev.mic_nothing': 'Nothing was recorded.',
  'web.dev.mic_transcribing': 'Transcribing…',
  'web.dev.mic_no_speech': 'No speech detected in that clip.',
  'web.dev.mic_done': 'Transcribed with {model}.',
  'web.dev.mic_failed': 'Dictation failed.',
  'web.dev.project': 'Project',
  'web.dev.project_selected': 'Selected project',
  'web.dev.project_use': 'Use this folder as the project',
  'web.dev.model_fallback': 'Model for every role (server has no role table)',
  'web.dev.model_placeholder': 'e.g. anthropic/claude-sonnet-4',
  'web.dev.route_roles': 'Route each role to its own model',
  'web.dev.preset': 'Preset',
  'web.dev.roles_hint':
    'Splitting roles across models is <strong>not</strong> a cost optimization — a fan-out costs several times a single agent while the price gap between these models is about 2×. The point is context isolation, parallelism, and for the critic a second opinion from another vendor.',
  'web.dev.methodology': 'Methodology',
  'web.dev.methodology_hint':
    'All OFF by default — with nothing checked, the session compiles exactly the pipeline it compiles today. Each option changes the compiled STRUCTURE (steps, gates, rubrics); none gives the model new fields.',
  // The methodology checkboxes. Keyed by `DevMethodology` field so the browser
  // renders the CATALOG's wording, not the raw English the server serves from
  // `methodology-registry.ts` — that registry declares WHICH options exist;
  // these keys declare how they READ. Built at run time from `opt.key`, so the
  // family is registered in coverage.test.ts's DYNAMIC_PREFIXES.
  'web.dev.method.tdd.label': 'TDD',
  'web.dev.method.tdd.desc':
    'Each front writes the tests first (and watches them fail) before implementing.',
  'web.dev.method.lintGate.label': 'Lint gate',
  'web.dev.method.lintGate.desc':
    "The project's lint/typecheck becomes a deterministic merge gate — a failure reverts the merge.",
  'web.dev.method.standards.label': 'Standards validation',
  'web.dev.method.standards.desc':
    "The epoch atlas and the project's conventions become a mandatory rubric for every critic.",
  'web.dev.method.planReview.label': 'Choice validation',
  'web.dev.method.planReview.desc':
    "An agent audits the plan's decisions before the fan-out, with one loop-back to recon.",
  'web.dev.method.writeSet.label': 'Write-set enforcement',
  'web.dev.method.writeSet.desc':
    "A task that writes a file its spec does not declare as owned is blocked — by the critic before the merge, and by the front's judge after it.",
  'web.dev.method.changelogGate.label': 'Changelog discipline',
  'web.dev.method.changelogGate.desc':
    'Commit subjects must be Conventional Commits, and a user-visible change must carry a changelog entry in the same diff.',
  'web.dev.method.diffBudget.label': 'Small batches',
  'web.dev.method.diffBudget.desc':
    "Each task's diff is capped in lines and files at merge time, so no single change grows past the size where review stops working.",
  'web.dev.method.fitnessFunctions.label': 'Architecture rules',
  'web.dev.method.fitnessFunctions.desc':
    "The project's dependency/layering check runs as a merge gate, and its declared rules become a citable rubric for every critic.",
  'web.dev.method.checklistReview.label': 'Checklist review',
  'web.dev.method.checklistReview.desc':
    'Every critic answers a fixed checklist item by item — PASS/FAIL/N-A with evidence — instead of writing free-form prose.',
  'web.dev.method.traceability.label': 'Traceability matrix',
  'web.dev.method.traceability.desc':
    'After the fan-out, an agent maps every criterion to the test that settles it and back, and a check refuses orphans in either direction.',
  'web.dev.method.characterization.label': 'Characterization tests',
  'web.dev.method.characterization.desc':
    "Each front records today's observable behavior as committed snapshots BEFORE changing anything; a later divergence must be explicitly approved.",
  'web.dev.method.chainOfVerification.label': 'Claim verification',
  'web.dev.method.chainOfVerification.desc':
    'In the knowledge phase, a second agent re-checks every claim against the repo and demotes what it cannot reproduce — nothing invented reaches the plan.',
  // The side effect is IN the description on purpose. `--debate` is the only
  // option that adds no rubric and no gate of its own, so the critic switching
  // to HOLD is a behaviour the user gets without asking unless it is said here.
  'web.dev.method.debate.label': 'Adversarial debate',
  'web.dev.method.debate.desc':
    "Two agents from different model families argue this epoch's design decisions before any front starts, and an anonymized judge rules — capped at two rounds. Like every option here, it also makes a blocked task wait for a human instead of waiving at the round cap.",
  /* WHO WRITES THE TOPOLOGY. Either the LLM planner decomposes the goal (what
     dev mode has always done), or huu compiles a method the human DREW on the
     canvas. The two are exclusive, and the drawing wins whenever it is set. */
  'web.dev.method_source': 'Method',
  'web.dev.method_source_planner': 'LLM planner',
  'web.dev.method_source_graph': 'Method you drew',
  'web.dev.method_source_hint_planner':
    'The planner decomposes your goal into parallel fronts, epoch after epoch. It writes the topology; you underwrite the goal.',
  'web.dev.method_source_hint_graph':
    'huu compiles the drawing exactly as you drew it: one epoch, no planner, no invented step.',
  'web.dev.graph_pick': 'Saved method',
  'web.dev.graph_pick_placeholder': 'Choose a method…',
  'web.dev.graph_pick_empty':
    'This project has no saved method yet — draw one on the canvas and save it.',
  'web.dev.graph_pick_failed': 'The saved methods could not be listed: {message}',
  'web.dev.graph_invalid_tag': 'has problems',
  'web.dev.graph_meta': '{nodes} node(s) · {edges} link(s)',
  'web.dev.graph_open_canvas': 'Open the canvas',
  'web.dev.err_no_graph': 'Choose the drawn method, or switch back to the LLM planner',
  'web.dev.err_graph_invalid':
    'That method still has problems — fix it on the canvas before running it',
  /* NOT hidden, ANNOUNCED. The driver loads both as session metadata and neither
     is compiled into a drawing, so the honest UI is the panel still standing
     there with a sentence saying what it will and will not do. */
  'web.dev.graph_meta_only': 'not compiled into the drawing',
  'web.dev.graph_meta_warning':
    'A drawn method is compiled from the <strong>drawing</strong>. huu records these choices on the session and shows them back to you, but it does not turn them into steps or gates — what runs is what you drew.',
  'web.dev.how_it_runs': 'How it runs',
  'web.dev.approval': 'Approval',
  'web.dev.autonomous': 'Autonomous',
  'web.dev.approve_each': 'Approve each epoch',
  'web.dev.approval_hint_auto':
    'Runs until the goal is reported complete, or you stop it. There is no epoch limit.',
  'web.dev.approval_hint_each': 'Every epoch plan waits for your approval before any agent runs.',
  'web.dev.fronts': 'Parallel fronts',
  'web.dev.fronts_hint':
    'Auto lets the planner choose (up to 4). Manual pins the ceiling — the compiler enforces it, not just the prompt.',
  'web.dev.start': 'Start development',
  'web.dev.merge_warning':
    'Every epoch ends in a merge into your current branch, so commit or stash your work first.',
  'web.dev.session': 'Session',
  'web.dev.gate_plan': 'This plan is waiting for you',
  'web.dev.run_epoch': 'Run this epoch',
  'web.dev.stop_session': 'Stop the session',
  'web.dev.gate_resume': 'Continue the previous session?',
  'web.dev.resume_accept': 'Continue it',
  'web.dev.resume_reject': 'Start from scratch',
  'web.dev.gate_orphan': 'Unmerged huu branches from an earlier run',
  'web.dev.orphan_land': 'Land them',
  'web.dev.orphan_ignore': 'Ignore and continue',
  'web.dev.abort': 'Abort session',
  'web.dev.back_to_dev': '← Development mode',
  'web.dev.err_no_goal': 'Write the goal first',
  'web.dev.err_no_model': 'Pick a model for every role',
  'web.dev.err_no_dir': 'Pick the project folder',
  'web.dev.err_preset_provider':
    'The “{preset}” preset only runs on {providers} — switch the provider, or pick a preset this one serves.',
  'web.dev.session_started': 'Session started ({id})',
  'web.dev.row_goal': 'Goal',
  'web.dev.row_project': 'Project',
  'web.dev.row_session': 'Session',
  'web.dev.row_models': 'Models',
  'web.dev.row_knowledge': 'Knowledge',
  'web.dev.row_stopped': 'Stopped',
  'web.dev.row_progress': 'Progress',
  'web.dev.resumed': 'resumed',
  'web.dev.no_epoch_cap': 'no cap — runs until it is done',
  'web.dev.done_when': 'Done when: {text}',
  'web.dev.front_max': 'up to {count} agent(s)',
  'web.dev.front_after': 'after {list}',
  'web.dev.front_parallel': 'parallel',
  'web.dev.epoch_n': 'Epoch {n}',
  'web.dev.progress': '{done} epoch(s) done · continuing at {next}',
  'web.dev.resume_generic':
    'An earlier session with this same goal can pick up where it stopped.',
  'web.dev.commits_ahead': '{count} commit(s) ahead',
  'web.dev.no_branches': 'No branches listed.',

  /* The session panel, when the session is a DRAWING. `drawnMethod` arrives on
     the first frame; `graph` only once the drawing compiled. */
  'web.dev.row_method': 'Drawn method',
  'web.dev.method_head': '{name} — your drawing, compiled as drawn',
  'web.dev.method_nodes': 'Nodes, in the order they run',
  'web.dev.method_root': 'Artifacts land under {path}',
  'web.dev.method_steps': '{count} step(s)',
  'web.dev.method_compiling': 'Compiling the drawing…',
  'web.dev.plan_warnings': 'Read this before approving',

  /* The resume gate, when the session on disk was a DRAWING. */
  'web.dev.resume_method': 'Drawn method',
  'web.dev.resume_method_ready':
    'It is the method selected here, so continuing re-sends it.',
  'web.dev.resume_method_missing':
    'Continuing needs this exact method. huu will re-send “{id}” for you — otherwise the resume is refused (a session opened as a drawing is never handed to the planner).',
  'web.dev.resume_accept_with_graph': 'Continue with “{name}”',
  'web.dev.resume_restarting': 'Re-sending the drawn method “{id}”…',
  'web.dev.resume_restart_failed':
    'The session could not be re-started with “{id}”: {message}',

  'web.role.inherits': 'inherits the worker model',
  'web.role.planner': 'Planner',
  'web.role.planner_hint':
    'The blind orchestrator — no tools, no file reads, no repo digest. A structured call, not a pi agent, so an id the pi registry has never heard of is fine here and fatal anywhere else.',
  'web.role.recon': 'Recon',
  'web.role.recon_hint':
    'Global and per-front recon — the retrieval the planner delegates rather than skips.',
  'web.role.worker': 'Worker',
  'web.role.worker_hint': 'The memory fan-out: the agents that actually write the code.',
  'web.role.critic': 'Critic',
  'web.role.critic_hint':
    "Reviews each task's diff in the worker's worktree BEFORE the merge. Cross-family from the worker on purpose — a model auditing its own family is the weakest assumption in this design.",
  'web.role.reporter': 'Reporter',
  'web.role.reporter_hint': 'Consolidating and sealing — mechanical prose over a diff.',
  'web.role.judge': 'Judge',
  'web.role.judge_hint':
    'Front verification and the epoch gate. Every check has a forward default outcome, so a judge that fails APPROVES SILENTLY — the one place to keep the strong model.',
  'web.role.integration': 'Integration',
  'web.role.integration_hint': 'The merge-conflict resolver.',
  /* ---- The adversarial debate chat (`--debate` only) ---- */
  'web.debate.open': 'Debate',
  'web.debate.open_title': 'Watch the two sides argue this epoch’s design',
  'web.debate.title': 'The debate on this epoch’s design',
  'web.debate.subtitle':
    'Two agents argue the design: one defends the record, the other attacks it. You watch them write, and read the briefs once they merge.',
  'web.debate.refresh': 'Reload the briefs',
  'web.debate.epoch_round': 'Epoch {epoch} · {rounds} round(s)',
  'web.debate.round': 'Round {n}',
  'web.debate.gate': 'Gate',
  'web.debate.gate_pending': 'The gate has not ruled on this round yet.',
  'web.debate.live': 'writing now',
  'web.debate.waiting': 'has not started writing',
  'web.debate.settled': 'merged brief',
  // THREE DIFFERENT FACTS, three different sentences. They used to collide:
  // `silent` was printed for a side that crashed AND for a round whose live
  // narration had simply scrolled out of memory, and both read as a deliberate
  // choice not to write. Only `silent` is a claim about the DEBATE (the server
  // read the file and there was none); the other two are claims about the agent
  // and about the UI.
  'web.debate.silent': 'This side wrote nothing — the gate may still forward.',
  'web.debate.failed': 'the agent failed',
  'web.debate.failed_note':
    'This side’s agent failed before it finished, so nothing of its brief was merged.',
  'web.debate.unrecoverable':
    'The narration of this round is no longer available — huu keeps it only while it streams. Whether this side wrote anything is not known here.',
  'web.debate.unparsed':
    'huu could not read this brief’s skeleton, so it is shown exactly as written.',
  'web.debate.missing_sections': 'Missing: {list}',
  'web.debate.decisions': 'Decisions',
  'web.debate.risks': 'Accepted risks',
  'web.debate.verdicts': 'Verdict per decision',
  'web.debate.objections': 'Objections',
  'web.debate.chosen': 'Chosen',
  'web.debate.rejected': 'Rejected',
  'web.debate.why': 'Why',
  'web.debate.falsify': 'What would falsify it',
  'web.debate.failure': 'Predicted failure',
  'web.debate.evidence': 'Evidence',
  'web.debate.cheaper': 'Cheaper alternative',
  'web.debate.contested': 'Contested: {list}',
  'web.debate.unjudged': 'Declared but never judged: {list}',
  'web.debate.orphans': 'Judged but never declared: {list}',
  'web.debate.empty': 'Nothing has been said yet.',
  'web.debate.load_failed': 'Could not read the merged briefs: {message}',
  'web.debate.matched_structure':
    'The debate steps were renamed — huu found them by their shape instead.',

  'web.role.advocate': 'Advocate',
  'web.role.advocate_hint':
    "Writes the epoch's decision record when the adversarial debate is on. Used only with the Adversarial debate option — and it must NOT share a family with the prosecutor, or the debate is one model talking to itself.",
  'web.role.prosecutor': 'Prosecutor',
  'web.role.prosecutor_hint':
    'Attacks that record, one verdict per decision. The other half of the debate pair — route it to a different family from the advocate.',

  'web.preset.hetero': 'Hetero ★',
  'web.preset.hetero_hint':
    'Strong blind leader, cheap swarm, and a critic from another family.',
  'web.preset.thrifty': 'Thrifty',
  'web.preset.thrifty_hint':
    'Hetero with the reporter demoted — it only writes prose about a diff.',
  'web.preset.monoculture': 'Monoculture',
  'web.preset.monoculture_hint':
    "A/B BASELINE, not a recommendation: every role — including the critic — on the worker's own model. This is precisely the configuration the evidence flags as the most fragile; it exists so the cross-family critic can be measured against it.",
  'web.preset.roster': 'Roster',
  'web.preset.roster_hint':
    'One endpoint, five vendors: the strongest model on the judge (whose failure is silent), the prosecutor cross-family from the workers, and the cheap flash model on the fan-out.',
  'web.preset.uniform': 'Uniform',
  'web.preset.uniform_hint':
    'Every role on the same model — whatever the worker field holds. The pre-routing behavior.',
  'web.preset.needs_provider':
    'Not available on this provider: these ids are served by {providers}.',

  /* ── The method canvas (/graph) ────────────────────────────────────────────
     Chrome only. Every RULE the canvas states — why a connection was refused,
     what a validator issue means — arrives as a SENTENCE from `graph-model.js`
     or from the server and is shown verbatim, so those messages are not keys
     here. One table, one voice: a second copy of the 45 issue codes would be a
     second authority the moment either side is edited. */
  'web.graph.untitled': 'Untitled method',
  'web.graph.name_label': 'Method name',
  'web.graph.id_title': 'The id that names this method on disk',
  'web.graph.save': 'Save',
  'web.graph.saving': 'Saving…',
  'web.graph.saved': 'Saved “{name}”',
  'web.graph.save_failed': 'Save refused: {message}',
  'web.graph.validate': 'Check',
  'web.graph.validate_failed': 'Cannot check right now: {message}',
  'web.graph.sample_label': 'Open a worked example',
  'web.graph.sample_placeholder': 'Open an example…',
  'web.graph.sample_failed': 'Could not open the example: {message}',
  'web.graph.catalog_failed': 'The block catalog did not load: {message}',
  'web.graph.node_count': '{nodes} nodes · {edges} links',
  'web.graph.status_checking': 'Checking…',
  'web.graph.status_ok': 'Nothing to fix',
  'web.graph.status_errors': '{count} problem(s)',
  'web.graph.status_warnings': '{count} note(s) — nothing broken',

  'web.graph.node.next': 'Next step',
  'web.graph.node.next_open': 'Open the palette: what comes after this step',
  'web.graph.node.arm_open': 'Open the palette for the “{arm}” branch',
  'web.graph.node.in': 'Incoming connections',
  'web.graph.node.issues': '{count} problem(s) on this node',
  'web.graph.node.warnings': '{count} note(s) on this node',

  'web.graph.palette.title': 'What comes next?',
  'web.graph.palette.from': 'From “{label}”',
  'web.graph.palette.from_arm': 'From “{label}” · branch “{arm}”',
  'web.graph.palette.empty':
    'The catalog served no blocks, so there is nothing to offer. Reopen this view to fetch it again.',
  'web.graph.palette.hint': '↑↓ to move · Enter to add · Esc to close',
  'web.graph.palette.blocked': 'Nothing can be added at this point.',

  'web.graph.inspector.title': 'Node',
  'web.graph.inspector.empty': 'Pick a node on the canvas to edit it.',
  'web.graph.inspector.label': 'Label',
  'web.graph.inspector.block': 'Block',
  'web.graph.inspector.issues': 'Reported here',
  'web.graph.inspector.delete': 'Delete node',
  'web.graph.inspector.text_goal': 'Goal of this method',
  'web.graph.inspector.text_prompt': 'Prompt (overrides the block’s own template)',
  'web.graph.inspector.text_query': 'Question this research answers',
  'web.graph.inspector.text_condition': 'Condition the judge checks',
  'web.graph.inspector.join': 'Waits for',
  'web.graph.inspector.join_all': 'Wait for all of them',
  'web.graph.inspector.join_subset': 'Wait only for the ones I tick',
  'web.graph.inspector.join_none': 'Nothing flows into this node yet.',
  'web.graph.inspector.join_root': 'The prompt entry is the root of the method: it waits for nobody.',
  'web.graph.inspector.join_honest':
    'Relaxing the join drops the DEPENDENCY — this step stops waiting for the branches you unticked, and stops failing when they fail. It does NOT drop the wave’s merge barrier: huu still merges every branch of the stage before the next one starts.',

  /* The method’s life cycle: the library, the id on disk, the compile. */
  'web.graph.library': 'Methods',
  'web.graph.library_empty': 'No method saved in this project yet.',
  'web.graph.library_failed': 'Could not list the methods: {message}',
  'web.graph.open_failed': 'Could not open “{id}”: {message}',
  'web.graph.id_label': 'Id on disk',
  'web.graph.rename': 'Change the id',
  'web.graph.rename_warn':
    'There is no rename: huu will DELETE “{from}” and save “{to}”. Anything pointing at the old file stops finding it.',
  'web.graph.rename_apply': 'Delete and save',
  'web.graph.renamed': '“{from}” is now “{to}”',
  'web.graph.rename_orphan':
    '“{to}” was saved, but “{from}” could not be deleted ({message}) — both exist now.',
  'web.graph.rename_failed': 'The id could not be changed: {message}',
  'web.graph.compile': 'Compile',
  'web.graph.compiling': 'Compiling…',
  'web.graph.compile_ok': '{count} step(s) — this is what will run',
  'web.graph.compile_failed': 'It does not compile: {message}',
  'web.graph.compile_close': 'Close',
  'web.graph.compile_depends': 'waits for',
  'web.graph.compile_default': 'default',
  'web.graph.compile_check': 'check',
  'web.graph.compile_work': 'work',

  /* Running the drawing. The canvas does not start the session itself: it hands
     the method to development mode, which owns the goal, the project and the
     model routing. See `web.dev.method_source_*` for the other end. */
  'web.graph.run': 'Run this method',
  'web.graph.run_title': 'Open development mode with this method already selected',
  'web.graph.run_ready': 'Runs as ONE epoch — the planner is never called.',
  'web.graph.run_blocked_checking': 'Checking the drawing…',
  'web.graph.run_blocked_check_failed':
    'The check did not run ({message}) — check it again before running it.',
  'web.graph.run_blocked_invalid': '{count} problem(s) to fix before this can run.',
  'web.graph.run_blocked_unsaved':
    'Save it first — huu runs the method that is on disk, not the one on screen.',
  'web.graph.run_handoff': '“{name}” is selected — write the goal and start.',

  /* The research node: what it answers, and what each answer triggers. */
  'web.graph.inspector.use_context': 'Read what this repository already knows',
  'web.graph.inspector.use_context_hint':
    'On: the agent reads the artefacts the earlier steps produced — and the repository itself — BEFORE writing its query, so the question is grounded. Off: it answers from the model and the web alone.',
  'web.graph.inspector.output_kind': 'What this research hands back',
  'web.graph.inspector.output_boolean': 'Yes / no',
  'web.graph.inspector.output_choice': 'Multiple choice',
  'web.graph.inspector.output_info': 'Informative',
  'web.graph.inspector.output_boolean_hint':
    'A statement to settle. The judge answers with one of the two arms, and each arm can trigger different work.',
  'web.graph.inspector.output_choice_hint':
    'One answer among the options you register. Each option is an arm, and each arm can trigger different work.',
  'web.graph.inspector.output_info_hint':
    'Nothing to configure: an informative research has no output to route on. What it finds enters the NEXT step as context.',

  /* The arms, and the behaviour registered for each one. */
  'web.graph.inspector.arms': 'Outputs, and what each one triggers',
  'web.graph.inspector.choices': 'Options, and what each one triggers',
  'web.graph.inspector.outcomes': 'Outcomes, and what each one triggers',
  'web.graph.inspector.arm_goes_to': 'Triggers “{label}”',
  'web.graph.inspector.arm_goes_back_to': 'Goes BACK to “{label}” — rework',
  'web.graph.inspector.arm_empty': 'No behaviour registered',
  'web.graph.inspector.arm_configure': 'Choose what it triggers',
  'web.graph.inspector.arm_add': 'Add',
  'web.graph.inspector.arm_add_label': 'Name of the new option',
  'web.graph.inspector.arm_remove': 'Remove',
  'web.graph.inspector.arm_min_two':
    'A branch needs at least two outputs — with one, there is nothing to decide.',
  'web.graph.inspector.arm_id_taken':
    '“{id}” is already an output of this node. Give this one another name.',
  'web.graph.inspector.arm_id_invalid':
    'Name it with letters or digits: the id derived from the name is what routes the run.',
  'web.graph.inspector.arm_id_frozen':
    'The id routes the run and every link that names it, so it is set once. Rename the text, not the id.',
  'web.graph.inspector.default_outcome': 'Default output',
  'web.graph.inspector.default_hint':
    'It fires when the judge fails, times out or answers something unknown — nobody chooses it. So it has to be the SAFE route forward, never the loop back.',
  'web.graph.inspector.rework_tag': 'rework',
  'web.graph.inspector.rework_title': 'Send the work back',
  'web.graph.inspector.rework_hint':
    'Pick the verdict that goes back and the step it returns to. Only a step that already ran can receive it, and the default output can never be the one that loops.',
  'web.graph.inspector.rework_arm': 'From the output…',
  'web.graph.inspector.rework_target': 'Back to…',
  'web.graph.inspector.rework_create': 'Draw the arm that goes back',
  'web.graph.inspector.rework_none': 'Nothing runs before this node, so there is nowhere to go back to.',
  'web.graph.inspector.switch_warn':
    '{count} link(s) leave outputs this change removes. They go with it.',
  'web.graph.inspector.switch_apply': 'Change and remove the links',
  'web.graph.inspector.switch_cancel': 'Cancel',

  /* The action node: what it runs, over what, and how wide. */
  'web.graph.inspector.template': 'What this block runs',
  'web.graph.inspector.template_missing': 'The catalog carries no template for this block.',
  'web.graph.inspector.fanout': 'Fan out over what an earlier step found',
  'web.graph.inspector.fanout_off': 'Do not fan out',
  'web.graph.inspector.fanout_none':
    'No step before this one writes a list to fan out over. A block that produces one — Recon, say — has to run first.',
  'web.graph.inspector.fanout_implies':
    'Picking one sets the scope to “one agent per entry found”: that is what a fan-out IS, so the scope stops being a separate choice.',
  'web.graph.inspector.scope': 'Scope',
  'web.graph.inspector.scope_default': 'The block’s own ({scope})',
  'web.graph.inspector.scope_project': 'One task over the whole project',
  'web.graph.inspector.scope_per_file': 'One agent per file you pick',
  'web.graph.inspector.scope_memory': 'One agent per entry found',
  'web.graph.inspector.scope_flexible': 'Free-form',
  'web.graph.inspector.files': 'Files (one per line)',
  'web.graph.inspector.max_files': 'Cap on the fan-out',
  'web.graph.inspector.max_files_hint': 'One entry is one agent, so this is a width you underwrite.',
  'web.graph.inspector.max_runs': 'Visit cap',
  'web.graph.inspector.max_runs_hint':
    'How many times this check may be reached in one run. It is what bounds an arm that goes back.',
  'web.graph.inspector.review': 'Run the critic loop on every task',
  'web.graph.inspector.review_hint':
    'A second agent reviews what the first wrote and sends it back until the findings stop being severe.',
  'web.graph.inspector.model': 'Model for this node',
  'web.graph.inspector.model_hint': 'Empty: the run’s own model.',
  'web.graph.inspector.notes': 'Your notes (never sent to an agent)',
} as const;

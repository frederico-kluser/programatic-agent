/** CLI entrypoint: `--help`, startup banners, fatal errors. */

export const cliEn = {
  'cli.err_dir_not_directory': 'huu: --dir={path}: not a directory',
  'cli.err_not_a_repo':
    'huu: not a git repository: {cwd}\nhuu runs each agent in an isolated git worktree, so it requires a repo.\nRun \'git init\' here, or cd into an existing repo, then try again.',
  'cli.err_unknown_provider':
    'huu: --provider={value}: unknown provider. Valid: {valid}',
  'cli.err_unknown_backend': 'huu: --backend={value}: unknown backend. Valid: {valid}',
  'cli.err_import_pipeline': 'Failed to import pipeline: {message}',
  'cli.err_per_file_no_files':
    'Step "{name}" has scope "per-file" but no files — add them under config.files["{name}"], or switch the step to scope "memory" with filesFrom.',
  'cli.err_auto_no_key':
    'huu auto: the {provider} provider requires an API key but {envVar} is not set. Either export the env var, mount a secret at {secretPath}, or persist it via the TUI first.',
  'cli.err_port_in_use':
    'huu: port {port} is already in use. Pick another with --port=<n> or HUU_WEB_PORT=<n>.',
  'cli.err_web_start': 'huu: web server failed to start: {message}',
  'cli.usage_auto': 'Usage: huu auto <pipeline.json> --config <config.json>',
  'cli.usage_run': 'Usage: huu run <pipeline.json>',
  'cli.warn_tag': 'warn',
  'cli.fatal': 'fatal',
  'cli.warn_native_removed':
    'huu: the native (no-docker) mode was REMOVED — huu is docker-only now.\n     --yolo/--no-docker/HUU_NO_DOCKER are ignored; running inside the container with its kernel memory ceiling.',
  'cli.warn_dev_native':
    'huu: HUU_DEV_NATIVE=1 — running on the HOST, outside the container (contributor loop).\n     Docker isolation is OFF: agents reach your shell credentials (~/.ssh, ~/.aws, …) and there is no container memory ceiling.\n     Use `npm run dev:docker` to rehearse what users actually get.',
  'cli.warn_no_cgroup':
    'huu: systemd user scope unavailable — running without a kernel memory ceiling (the software guard still applies).',
  'cli.warn_yolo':
    'huu: --yolo: skipping Docker. The agent has access to your shell credentials (~/.ssh, ~/.aws, etc.).',
  'cli.warn_config_corrupt_saved':
    'huu: {path} could not be read as JSON and has been REPLACED.\n     Your API keys were in that file — the original bytes were kept at {backup} (mode 0600).\n     Open it in an editor to copy any key back into huu; delete it once you are done.',
  'cli.warn_config_corrupt_lost':
    'huu: {path} could not be read as JSON and has been REPLACED.\n     huu could not save a copy of the old file (disk full, or the directory is not writable), so any API key it held is gone. Add your key again in the Options screen.',
  'cli.web_launching':
    'huu: launching the web UI inside Docker — open {url} once the container is up (a few seconds on first run, longer while the image pulls).',
  'cli.web_prefer_tui': 'Prefer the terminal UI? Run {command}.',

  'cli.banner_web_ui': 'web UI',
  'cli.banner_in_container': 'listening inside container on :{port} (published to the host)',
  'cli.banner_local': 'Local',
  'cli.banner_network': 'Network',
  'cli.banner_dev_mode': 'Dev mode',
  'cli.banner_dev_hint': 'add /dev to the URL above',
  'cli.banner_token_required': '(token required — the ?token= URL above carries it)',
  'cli.banner_lan_warning':
    '(reachable on your LAN — set HUU_WEB_TOKEN to require a secret, or HUU_WEB_HOST=127.0.0.1 for localhost-only)',
  'cli.banner_stop': 'Press Ctrl+C to stop.',
  'cli.banner_termlog':
    'run activity, key events and errors are logged in THIS terminal (HUU_WEB_LOG_STREAM=1 also mirrors raw agent output)',

  'cli.help_env_key': '{label} key. Asked in the TUI when missing.',
  'cli.help': `huu — Humans Underwrite Undertakings · guided pipeline execution TUI with kanban

Usage:
  huu                       Open the web UI (default) — dashboard in your browser
  huu --cli                 Open the terminal UI (Ink TUI) instead of the web UI
  huu run <pipeline.json>   Preload a pipeline (web UI, or TUI model picker with --cli)
  huu auto <p.json> --config <c.json>
                            Headless run — no TUI. Config JSON supplies
                            model, backend, per-step file selection.
  huu dev "<goal>"          Development mode — bootstraps the project's agent
                            skills when missing, then plans and runs epochs of
                            parallel FRONTS as a worktree swarm. See dev flags.
  huu graph <sub> [...]     The DRAWN method, from a terminal: list, show, validate,
                            compile, create and delete the devgraphs saved under
                            .huu/dev/graphs/. See graph subcommands.
  huu init-docker [...]     Scaffold compose.huu.yaml into the current repo
  huu status [...]          Inspect the latest run via .huu/debug-*.log
  huu prune [...]           List/kill orphan huu containers + stale cidfiles
  huu --dir=<path>          Run in this directory instead of the current one (default: cwd)
  huu --provider=<name>     LLM provider — the endpoint called and the key spent:
                            deepseek (default, alias ds), openrouter (alias or)
  huu --backend=<kind>      Advanced: the agent process that runs each task:
                            jcode (default), stub
  huu --stub                Alias for --backend=stub (no real LLM)
  huu --yolo                Skip Docker, run native on the host (agent sees your shell creds)
  huu --no-docker           Alias for --yolo / HUU_NO_DOCKER=1 — neutral spelling for CI runners
  huu --cli                 Use the terminal UI instead of the default web UI
  huu --web                 Force the web UI (overrides HUU_CLI=1)
  huu --port=<n>            Web UI port (default 4888; or HUU_WEB_PORT)
  huu --concurrency=<n>     Pin manual concurrency at n (disables memory-based auto-scale)
  huu --ram-percent=<n>     RAM budget as % of total memory (10-95, default 70; or
                            HUU_RAM_PERCENT, or the saved dial in TUI [O] / web Settings)
  huu --no-auto-scale       Disable memory-based auto-scale (on by default; guard stays on)
  huu --auto-scale          Deprecated: auto-scale is now the default
  huu --help                Show this help

dev flags:
  --model <id>              Model for the planner and the swarm (required unless --stub)
  --graph <id|file.json>    Run a METHOD YOU DREW instead of the LLM planner. A bare slug
                            (a-z, 0-9, dashes) is a graph saved under .huu/dev/graphs/;
                            anything else is a path to a .json file. A drawing is the
                            COMPLETE method, so the session is exactly ONE epoch and
                            --epochs > 1 is refused. The 13 methodology flags and the
                            per-role model flags are NOT compiled into a drawing (warned).
  --epochs <n>              Ceiling on epochs (default 3). Each epoch plans, runs and lands.
  --fronts <n>              Ceiling on parallel fronts per epoch (default 4, max 4)
  --max-cost <usd>          Stop before the epoch that would exceed this spend (both runs counted)
  --approve-each            Show every epoch plan and wait for confirmation before running it
  --autonomous              Plan and run every epoch without asking (the default)
  --skip-knowledge          Do not bootstrap agent skills even when the project has none
  --run-dir <path>          Repo to develop in (default: the current directory)
  methodologies (all OFF by default; run 'huu dev' with no goal for the full list):
  --tdd --characterize --lint-gate --fitness --diff-budget --changelog
  --standards --checklist --write-set --plan-review --traceability --verify-claims
  --debate                  two agents of DIFFERENT families argue the epoch's design
                            before the fronts; an anonymized judge rules, 2 rounds max.
                            Like every option here, it also makes a blocked task WAIT
                            for a human instead of waiving at the critic's round cap.
                            Route the pair: --advocate-model / --prosecutor-model

graph subcommands (the drawn method — no browser needed):
  list                      List the saved drawings (id, nodes/edges, valid?)
  show <id>                 Draw the topology as TEXT: per node its kind, block, join
                            (all vs only X), branch arms with their target, and the
                            rework edges that go back
  validate <id>             Report every error and warning with its stable code and
                            anchor; exits non-zero when there is any error
  compile <id> [--out <f>]  Compile the drawing into a huu-pipeline-v2. Written to
                            stdout, or to --out. A WRITTEN PIPELINE IS A PORTABLE
                            ARTEFACT: run it with 'huu auto <f> --config <c.json>',
                            in any repo, with no dev mode involved.
  new <id> [--from <sample>] [--name <n>] [--force]
                            Create an empty drawing, or one from a shipped sample
  rm <id>                   Delete the saved drawing
  (every subcommand honors the global --dir=<repo>)

init-docker flags:
  --force                   Overwrite files that already exist
  --with-wrapper            Also write scripts/huu-docker (bash launcher)
  --with-devcontainer       Also write .devcontainer/devcontainer.json
  --image <ref>             Override the image reference (default: ghcr.io/frederico-kluser/huu:latest)

status flags:
  --json                    Machine-readable output
  --liveness                Suppress output; exit 0 if running, 1 otherwise (HEALTHCHECK use)
  --stalled-after <sec>     Stall threshold (default: 30)

prune flags:
  --list                    Show containers + stale cidfiles, exit 0 (no mutation)
  --dry-run                 Show what 'huu prune' WOULD kill, exit 0 (no mutation)
  --json                    Machine-readable output (combines with --list / --dry-run)

Environment:
{envLines}
  HUU_WEB_PORT                       Web UI port (default 4888). Same as --port=<n>.
  HUU_WEB_HOST                       Web UI bind address (default 0.0.0.0; set 127.0.0.1 for localhost-only).
  HUU_WEB_TOKEN                      Require this shared secret (?token=…) for the web UI's data + actions.
  HUU_CLI                            Set to 1 to default to the terminal UI (same as --cli).
  HUU_LANG                           UI language: en (default) or pt-BR. Falls back to LC_ALL/LANG.
  HUU_I18N_STRICT                    Set to 0 to warn instead of aborting on a missing translation.

Persisted globally at: {configPath}
(written when you accept "Save globally" in the TUI prompt; mode 0600).
`,
} as const;

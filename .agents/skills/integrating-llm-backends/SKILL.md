---
name: integrating-llm-backends
description: Maps huu's agent-backend system — the registry kind→factory dispatch (jcode, stub), the provider layer above it (src/lib/providers.ts), the jcode CLI-subprocess contract (argv + hermetic config.toml + credential by env var), the BackendBundle contract, the API-key resolution chain and the static model catalog. Use when changing LLM clients, adding or debugging a backend or provider, fixing auth/key resolution, or touching model selection.
metadata:
  version: 0.6.0
  type: knowledge
---

# Integrating LLM Backends

## When to use

Work on `src/orchestrator/backends/**`, `src/lib/providers.ts`,
`src/lib/api-key*.ts`, `src/lib/llm-client-factory.ts`, `src/lib/jcode-bundle.ts`,
model catalogs (`src/models/`, `recommended-models.json`), or any
"agent won't authenticate / wrong model / wrong provider billed" bug.

## Injected knowledge

### TWO layers, and they are not the same list

- **Backend kind** = *how* an agent is executed. `src/orchestrator/backends/registry.ts:18@9b571a9754c4b109391c62d654fecd720ae7439d` —
  `AgentBackendKind = 'jcode' | 'stub'`. Two kinds, no more.
  `ALL_BACKENDS` (registry.ts:20) drives the selector.
- **LLM provider** = *whose* API is billed. `src/lib/providers.ts` — the
  `PROVIDERS` array is the authority, `providerToBackend()` maps a provider to
  the kind that serves it, and `parseProvider` backs `--provider=<name>`.

`pi` (OpenRouter, in-process pi-coding-agent SDK) and `azure` (Azure AI
Foundry) were **deleted in v3.0** — `backends/pi/` and `backends/azure/` do not
exist, and neither does `src/lib/model-registry-check.ts`. The real dirs are
`backends/{jcode,stub,_shared}`.

**The provider set — what IS, and what is NOT YET.** Read as a dated snapshot
(measured 2026-09-05), never as a promise:

- **IS — the union has exactly ONE member.** `src/lib/providers.ts:14`:
  `export type LlmProvider = 'deepseek';`. `PROVIDERS` (providers.ts:31-39)
  holds a single entry (`deepseek` → kind `jcode`, spec name `deepseek`), and
  `parseProvider` (providers.ts:61-65) accepts only `deepseek` and `ds`.
- **IS — the credential axis is still BACKEND-keyed, not provider-keyed.**
  `ApiKeySpec.backendBound?: 'jcode'` (`src/lib/api-key-registry.ts:67`).
  `findMissingKeysForBackend` (`src/lib/api-key.ts:193-210`) enforces a bound
  spec whenever ITS backend is the active one — INDEPENDENT of `required` —
  skips specs bound to another backend, and enforces an unbound spec only when
  `required: true`. There is no `providerBound` field today.
- **IS NOT YET — there is no second `--provider-profile`.**
  `src/orchestrator/backends/jcode/hermetic.ts:107-129` materializes exactly
  ONE profile: `deepseek-v4-pro`, `base_url = "https://api.deepseek.com/v1"`,
  `api_key_env = "DEEPSEEK_API_KEY"`. The jcode subprocess therefore speaks to
  a single endpoint, and OpenRouter is not reachable from huu as a provider.
- **WHEN a second provider lands, it lands at the PROVIDER layer, never as a
  backend kind** — a `PROVIDERS` entry + an `API_KEY_REGISTRY` spec + a second
  profile in `hermetic.ts`; `AgentBackendKind` stays at two.

**Read `providers.ts` before asserting the current provider set** — it is the
file that moves, and the bullets above are a snapshot of it, not a contract.

Kind names double as CLI flag values (`--backend=<kind>`) and `AppConfig.backend`;
`--backend=` wins over `--provider=` (`cli.tsx:460`). `parseBackendKind` also
accepts the aliases `deepseek`→`jcode` and `fake`/`mock`→`stub`.

### jcode is a SUBPROCESS, not an SDK — the whole contract

`backends/jcode/factory.ts` spawns the `jcode` CLI. Everything below is measured
behavior, not inference:

- **argv, never stdin.** `buildJcodeArgs(modelId, promptText)` emits
  `run --no-update --provider-profile <profile> --model <id> -- <prompt>`.
  `<MESSAGE>` is a REQUIRED POSITIONAL and must come last; the `--` is
  load-bearing (a prompt starting with `-` is otherwise parsed as a flag).
  jcode has no stdin channel at all.
- **One argv string caps at `MAX_ARG_STRLEN` (32 pages = 131071 bytes measured).**
  `jcodeOversizedPromptMessage` refuses BEFORE `spawn()`, because `spawn()`
  throws E2BIG *synchronously* — it never reaches `proc.on('error')`.
- **Hermetic config is huu's, by default.** `backends/jcode/hermetic.ts`
  materializes `~/.huu/jcode-home/config.toml` and exports `JCODE_HOME` at it.
  `JCODE_HOME` isolates the CONFIG (jcode reads `<dir>/config.toml` directly, no
  `.jcode` segment); `JCODE_AGENT_DIR` isolates only the RUNTIME dir and does
  NOT move the config lookup. Also set: `JCODE_MEMORY_ENABLED=false` (zero
  embeddings — every run is stateless) and `JCODE_NO_TELEMETRY=1`. Escape hatch:
  `HUU_JCODE_HERMETIC=0` writes nothing and passes `process.env` through.
- **The TOML never holds a secret.** The profile only names the variable
  (`api_key_env = "DEEPSEEK_API_KEY"`); the value enters the spawn env via
  `withJcodeApiKey(env, config.apiKey)`. A subprocess has no other channel, and
  huu's default path (container secret MOUNT) means `process.env` alone is
  empty. Never assign the var an empty string — that shadows a good inherited value.
- Write policy is self-heal (compare bytes, rewrite only on mismatch) with
  tmp+rename for the parallel-spawn race; a write failure DEGRADES (drops
  `JCODE_HOME`), it never throws.
- The host bundle is discovered by `src/lib/jcode-bundle.ts` and bind-mounted
  READ-ONLY into the container at `/opt/jcode`, opportunistically — the re-exec
  gate runs before the backend is chosen, so it cannot know whether jcode will
  be used.

### BackendBundle contract (`registry.ts:22-57`)

- `agentFactory` — per-task agents.
- `conflictResolverFactory` — `undefined` for backends that can't reasonably
  resolve merge conflicts (stub): the orchestrator then fails loud on conflict
  instead of shipping a silent bad merge. `jcode` reuses its own factory.
- `requiresApiKey` — stub returns `false`, which is what lets `--stub` smoke
  runs work without `DEEPSEEK_API_KEY`. This flag is the only thing the
  api-key prompt screen checks.
- `apiKeySpecName` — name in `API_KEY_REGISTRY` the App validates (`'deepseek'`
  for jcode, absent for stub). The browser uses it to look up its session key.
- `userSelectable` — `false` hides the kind from the TUI BackendSelector
  (stub is the only one: reachable via `huu --stub` / `--backend=stub` only).
- `label` / `description` — feed the selector directly.

### API-key resolution chain (`src/lib/api-key.ts:84`, `resolveApiKeyWithSource`)

1. Secret mount: `/run/secrets/<name>` (Docker `--mount`, readonly) — a VALUE
   SNAPSHOT frozen at container start; it does NOT track the store live
2. Persisted store: `$XDG_CONFIG_HOME/huu/config.json` (fallback
   `~/.config/huu/config.json`; `HUU_CONFIG_DIR` overrides the dir — the Docker
   wrapper points it at the HOST config dir and bind-mounts it RW, so
   in-container saves persist across containers) — an explicitly saved key,
   ABOVE the env var. Helpers: `saveApiKey` / `loadStoredApiKey` /
   `clearStoredApiKey` (clearing needs its own function — `saveApiKey`
   early-returns on empty) / `maskKey` (log/UI-safe, 6-char prefix + last 4)
3. `<NAME>_FILE` env var pointing at a file (postgres-style `_FILE` convention)
4. Plain env var — the fallback when nothing is saved (CI / headless)
5. TUI prompt (which can persist to step 2)

Per-backend specs live in `src/lib/api-key-registry.ts` (envVar / envFileVar /
secretMountPath / hostSecretScope per key). The Docker wrapper forwards every
registry envVar/envFileVar into the container and mounts secret files — add a
key spec there and the wrapper picks it up without edits. `backendBound: 'jcode'`
makes a `required` spec enforced only when that backend is active; a spec with
no `backendBound` and `required: false` (the legacy `openrouter` entry, the
`artificialAnalysis` entry, the three surf web-research keys) never gates a run.

**Source-aware resolution.** `resolveApiKeyWithSource(spec) → { value, source,
storedOverridesEnv }`. `source` is which tier won
(`secret-mount`/`stored`/`env-file`/`env`/`none`); the saved store OUTRANKS the
env var, so an explicitly saved key beats a stale exported one.
`storedOverridesEnv` is true when the saved key won AND a *different* non-empty
ambient value exists. Build user-facing remediation with
`keyRemedyHint(spec, res)` — never re-hardcode a blanket message. When the
CALLER already knows the key's provenance it must DECLARE it instead of letting
the probe re-run the resolver: `AppConfig.apiKeySource` (`'request'` =
browser-sent with the run, `'options'` = web-Options live override, else a
resolver tier) makes the 401 preflight blame the key ACTUALLY used.

**There is no cheap DeepSeek key probe.** `validateKeyValue` (`web/api-data.ts`)
returns `unverifiable` for every spec today; the old
`checkOpenRouterReachable` / `checkAzureReachable` gates are gone (the
orchestrator files still *import* `checkOpenRouterReachable` but never call it).
So a key is proven only by a real call failing — do not reintroduce a
"validated ⇒ good" assumption in the UI.

### Web UI key flow: per-tab session key + ⚙ Options persistence

- **Launch form (per-tab):** validate (`POST /api/keys/validate`), keep the
  value only in `sessionStorage('huu.key.<spec>')`, send it as `apiKey` with
  each `POST /api/run`. Because validation is `unverifiable`, it warns and
  accepts rather than blocking.
- **⚙ Settings (persists):** `POST /api/keys` writes the disk store via
  `saveApiKey` AND arms `WebRunManager.setWebKey` (live in-session override).
  The override exists because the Docker secret mount is a startup SNAPSHOT: a
  disk save alone stays outranked by the stale mount until restart.
  `GET /api/keys/status?name=` reports the effective source + `maskKey`'d value
  (never the raw key — pinned by a `server.test.ts` regression);
  `DELETE /api/keys?name=` clears store + override. There is also a key POOL
  (`/api/keys/pool*`, `src/lib/api-key-pool.ts`) for multiple keys.

Run-key precedence is the exported+tested `pickRunKey(requestKey,
webOptionsKey, spec)` in `run-manager.ts`: request > options > resolver. The
winner travels as `AppConfig.apiKeySource`. Every validate/save/clear and each
run's (masked) key source is mirrored to the serve terminal (`web/terminal-log.ts`).

### Helper LLM calls: one factory, or you ship a billing bug

`src/lib/llm-client-factory.ts` (`buildChatClient(ctx, opts)`) is the ONLY place
a LangChain `ChatOpenAI` may be constructed. Today it binds every helper to
`https://api.deepseek.com/v1` and throws when the key is missing. Seven call
sites go through it: `assistant-client.ts`, `assistant-architect.ts`,
`assistant-check-feasibility.ts`, `llm-suggest-files.ts`, `recon-selector.ts`,
`project-recon.ts`, `dev-mode/planner.ts`.

**The rule this seam exists to enforce:** an auxiliary LLM call that uses a
provider other than the one the user selected is a BILLING BUG, not a detail.
A real audit (`docs/azure-backend.md`) found four TUI helpers hard-coded to
OpenRouter while the user had picked another provider. The same trap is open
today at the ROLE level — a `DevModelPolicy` role routed to a model id the
selected provider does not serve is the same bug with a new shape. Verify the
pair (role → provider), never just (role → id). One direct-fetch exception
survives on purpose: `src/lib/transcribe.ts` posts to OpenRouter for audio
transcription, because it needs a multimodal content part the chat wrapper does
not expose.

### Models

- The catalog is STATIC. `listModelsForBackend` (`web/api-data.ts`) returns
  `{ models, source: 'recommended' }` from `loadRecommendedModels` — the live
  OpenRouter `/models` catalog is gone (DeepSeek exposes no public equivalent).
- `DEFAULT_MODEL_ID` (`src/models/catalog.ts:18`, currently
  `deepseek/deepseek-v4-flash`) is the single default, kept in sync with the
  FIRST entry of BOTH `recommended-models.json` (repo root, read from the
  AUDITED project's cwd) and the in-code `DEFAULT_RECOMMENDED_MODELS` fallback;
  `src/web/client/app.js` mirrors the id as a `const` (vanilla JS, no TS import).
- GOTCHA: `loadRecommendedModels` SWALLOWS any zod parse error and silently
  returns the in-code fallback, so ONE out-of-enum `tier`/`bestFor` value drops
  the WHOLE file. Those two fields are cosmetic — adding a value REQUIRES
  extending `ModelTierSchema`/`ModelUseCaseSchema` first. `catalog.test.ts`
  fails if the shipped file stops parsing.
- Thinking-capable detection is a modelId heuristic in
  `src/lib/model-factory.ts` (`supportsThinking`): the `:thinking`/`-thinking`
  markers plus a prefix list. Extend the list when a reasoning family appears;
  don't special-case call sites. False negatives are cheap, false positives
  waste the run.
- The stage-integration/conflict agent uses the SAME model as the run.
- The web picker is vanilla JS (`web/client/app.js`), NOT the Ink
  `ModelSelectorOverlay` — confirm web vs TUI before changing "the model selector".

### Adding a backend — checklist

1. `backends/<kind>/factory.ts` implementing `AgentFactory` (+ conflict resolver
   or explicit `undefined`).
2. One-line append in `registry.ts` (kind union + `ALL_BACKENDS` + bundle) and
   an alias in `parseBackendKind` if wanted.
3. Key spec in `api-key-registry.ts` if it needs auth (`backendBound` to scope it).
4. Provider entry in `src/lib/providers.ts` if users pick it by provider name.
5. Selector, api-key screen and Docker env passthrough follow from 2–4.

**Adding a PROVIDER to the existing jcode backend is a different, smaller job:**
a `PROVIDERS` entry, an `API_KEY_REGISTRY` spec, and a provider profile in the
materialized `config.toml` (`hermetic.ts` — `base_url` + `api_key_env`) that
`buildJcodeArgs` can pass to `--provider-profile`. No new `AgentBackendKind`.

## References

- `src/orchestrator/backends/registry.ts`, `src/orchestrator/backends/jcode/{factory,hermetic}.ts`,
  `src/lib/providers.ts`, `src/lib/api-key.ts`, `src/lib/api-key-registry.ts`,
  `src/lib/llm-client-factory.ts`, `src/lib/jcode-bundle.ts`
- `docs/jcode-setup-guide.md` (pt-BR — install + configure the real backend).
  `docs/pi-coding-agent.md` and `docs/azure-backend.md` are REMOVED-backend
  markers, kept only as historical record.
- Related skills: working-on-orchestrator, running-in-docker (secret mounts),
  running-dev-mode (per-role model routing)

> Facts verified against source on 2026-09-05: the v3.0 backend removal
> (`AgentBackendKind = 'jcode' | 'stub'`; no `pi/`, no `azure/`, no
> `model-registry-check.ts`), the jcode subprocess contract (argv, hermetic
> `config.toml`, `withJcodeApiKey`), the static recommended catalog replacing
> the live OpenRouter one, and `validateKeyValue` returning `unverifiable` for
> every spec. The provider layer (`src/lib/providers.ts`) is the surface that
> changes when a provider such as OpenRouter is added — re-read it rather than
> trusting a union quoted here.

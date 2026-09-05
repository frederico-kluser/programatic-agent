---
name: integrating-llm-backends
description: Maps huu's agent-backend system — the registry kind→factory dispatch (jcode, stub), the provider layer above it (src/lib/providers.ts), the jcode CLI-subprocess contract (argv + hermetic config.toml + credential by env var), the BackendBundle contract, the API-key resolution chain and the static model catalog. Use when changing LLM clients, adding or debugging a backend or provider, fixing auth/key resolution, or touching model selection.
metadata:
  version: 0.7.0
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

- **Backend kind** = *how* an agent is executed. `src/orchestrator/backends/registry.ts:19@9b571a9754c4b109391c62d654fecd720ae7439d` —
  `AgentBackendKind = 'jcode' | 'stub'`. Two kinds, no more.
  `ALL_BACKENDS` (registry.ts:21) drives the selector.
- **LLM provider** = *whose* API is billed. `src/lib/providers.ts` — the
  `PROVIDERS` array is the authority, `providerToBackend()` maps a provider to
  the kind that serves it, and `parseProvider` backs `--provider=<name>`.

`pi` (OpenRouter, in-process pi-coding-agent SDK) and `azure` (Azure AI
Foundry) were **deleted in v3.0** — `backends/pi/` and `backends/azure/` do not
exist, and neither does `src/lib/model-registry-check.ts`. The real dirs are
`backends/{jcode,stub,_shared}`.

**The provider set — what IS, and what is NOT YET.** Read as a dated snapshot
(measured 2026-09-05), never as a promise:

- **IS — the union has TWO members.** `src/lib/providers.ts:30`:
  `LlmProviderSchema = z.enum(['deepseek', 'openrouter'])`, with
  `LlmProvider = z.infer<…>` (providers.ts:33) — one zod enum every schema
  IMPORTS instead of redeclaring, so a provider cannot be half-added.
  `PROVIDERS` (providers.ts:78-102) holds BOTH entries, each `backend: 'jcode'`;
  `parseProvider` (providers.ts:163-168) accepts `deepseek|ds` and
  `openrouter|or`; `DEFAULT_PROVIDER` is `deepseek` (providers.ts:109).
- **IS — the credential axis is PROVIDER-keyed, not backend-keyed.**
  `ApiKeySpec.providerBound?: LlmProvider` (`src/lib/api-key-registry.ts:74`)
  REPLACED `backendBound`: both providers dispatch to `jcode`, so a
  backend-keyed binding made one run demand BOTH keys.
  `findMissingKeysForProvider` (`src/lib/api-key.ts:207-221`) is the PRIMARY
  gate — a spec bound to the ACTIVE provider is enforced REGARDLESS of
  `required` (that is what lets `openrouter`, `required: false`, still block its
  own runs: api-key-registry.ts:98-111), a spec bound to another provider is
  skipped, and an unbound spec is enforced only when `required: true`.
  `findMissingKeysForBackend` (api-key.ts:239-243) survives only as a wrapper
  answering for the backend's DEFAULT provider.
- **IS — `selectBackend('jcode').apiKeySpecName` is now `undefined` on purpose**
  (`registry.ts:44-57` marks the field `@deprecated`, `registry.ts:88-90` omits
  it): a backend serving two providers structurally cannot name the credential.
  The authorities are `apiKeySpecNameForProvider(p)` (providers.ts:207-209) and
  `specForProvider(p)` (api-key.ts:253-256).
- **IS — there IS a second `--provider-profile`.** `jcode/hermetic.ts` no longer
  hard-codes one: `JCODE_PROFILES` is a `Record<LlmProvider, JcodeProfile>`
  (hermetic.ts:123-141 — exhaustive BY TYPE, so a new provider is a COMPILE
  error), `jcodeProfileBlock` (hermetic.ts:193-210) renders one
  `[providers.<name>]` block per provider with `base_url` from
  `ProviderInfo.defaultBaseUrl` and `api_key_env` from the registry
  (`jcodeApiKeyEnvVar`, hermetic.ts:154-165), and `JCODE_CONFIG_TOML`
  (hermetic.ts:230-240) maps over ALL of `PROVIDERS` — a static CATALOG on
  purpose, since content that varied per run would make parallel agents of
  different providers fight over the self-heal rewrite.
  `buildJcodeArgs(modelId, promptText, provider)` (`jcode/factory.ts:118-133`)
  selects the profile from the ACTIVE provider.
- **IS — the model id is rendered in the ENDPOINT's namespace.** The catalog is
  OpenRouter-shaped (`vendor/model`); `modelIdForProvider(p, id)`
  (providers.ts:232-242) strips ONLY the provider's own
  `ProviderInfo.modelNamespace` (deepseek declares `deepseek`, providers.ts:88;
  the aggregator declares none, so ids travel verbatim). A FOREIGN id is left
  exactly as written, so the endpoint says "unknown model" instead of huu
  mangling it. Called by both `buildJcodeArgs` and `buildChatClient`.
- **IS — the OTHER provider's key is REMOVED from the child env.**
  `stripForeignProviderKeys` (`jcode/factory.ts:229-239`) deletes every
  `envVar`/`envFileVar` whose spec is `providerBound` elsewhere, before
  `withJcodeApiKey(env, apiKey, provider)` (factory.ts:277-291) injects the
  active one. Pinning the profile while injecting the resolved key is what
  once shipped an `sk-or-…` secret to api.deepseek.com as a Bearer token.
- **IS NOT YET — no THIRD provider, and none served by a second backend.**
  Every `PROVIDERS` entry maps to `backend: 'jcode'`;
  `providersForBackend('stub')` is `[]`, which is what lets `resolveRunProvider`
  (providers.ts:188-196) return `undefined` for stub and keep `--stub` keyless.
- **WHEN a third provider lands, it lands at the PROVIDER layer, never as a
  backend kind** — a `PROVIDERS` entry + an `API_KEY_REGISTRY` spec
  (`providerBound`) + a `JCODE_PROFILES` member; `AgentBackendKind` stays at two.

**Read `providers.ts` before asserting the current provider set** — it is the
file that moves, and the bullets above are a snapshot of it, not a contract.

Kind names double as CLI flag values (`--backend=<kind>`) and `AppConfig.backend`;
`--backend=` wins over `--provider=` (`cli.tsx:473`). `parseBackendKind` also
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
- **The TOML never holds a secret.** Each profile only names its variable
  (`api_key_env`, derived per provider from the registry); the value enters the
  spawn env via `withJcodeApiKey(env, config.apiKey, config.provider)`, which
  first strips the OTHER providers' key vars. A subprocess has no other channel, and
  huu's default path (container secret MOUNT) means `process.env` alone is
  empty. Never assign the var an empty string — that shadows a good inherited value.
- Write policy is self-heal (compare bytes, rewrite only on mismatch) with
  tmp+rename for the parallel-spawn race; a write failure DEGRADES (drops
  `JCODE_HOME`), it never throws.
- The host bundle is discovered by `src/lib/jcode-bundle.ts` and bind-mounted
  READ-ONLY into the container at `/opt/jcode`, opportunistically — the re-exec
  gate runs before the backend is chosen, so it cannot know whether jcode will
  be used.

### BackendBundle contract (`registry.ts:23-67`)

- `agentFactory` — per-task agents.
- `conflictResolverFactory` — `undefined` for backends that can't reasonably
  resolve merge conflicts (stub): the orchestrator then fails loud on conflict
  instead of shipping a silent bad merge. `jcode` reuses its own factory.
- `requiresApiKey` — stub returns `false`, which is what lets `--stub` smoke
  runs work without `DEEPSEEK_API_KEY`. This flag is the only thing the
  api-key prompt screen checks.
- `apiKeySpecName` — `@deprecated` as a credential authority and `undefined` for
  BOTH kinds today (`registry.ts:44-57`). Ask the PROVIDER instead
  (`specForProvider` / `apiKeySpecNameForProvider`); reading it here is the bug
  that made an OpenRouter run demand `DEEPSEEK_API_KEY`.
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
key spec there and the wrapper picks it up without edits. `providerBound:
<provider>` makes a spec enforced only when that provider is active — and then
regardless of `required`; a spec with no `providerBound` and `required: false`
(the `artificialAnalysis` entry, the three surf web-research keys) never gates
a run.

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
a LangChain `ChatOpenAI` may be constructed. It binds each helper to the
RESOLVED provider's `ProviderInfo.defaultBaseUrl` (`llm-client-factory.ts:76-115`
— an override that normalizes to EMPTY is refused, because the openai SDK reads
an empty `baseURL` as absent and falls back to api.openai.com carrying this
provider's key), renders `--model` through `modelIdForProvider`
(llm-client-factory.ts:124), and throws when the key is missing. The legacy
`deepseekApiKey`/`deepseekEndpoint` context fields are GATED on
`provider === 'deepseek'` (lines 83, 98) so a DeepSeek key can never ride an
OpenRouter context. Seven call
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
- `DEFAULT_MODEL_ID` (`src/models/catalog.ts:37`, currently
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
3. Key spec in `api-key-registry.ts` if it needs auth (`providerBound` scopes it
   to ONE provider — the backend is no longer a credential axis).
4. Provider entry in `src/lib/providers.ts` if users pick it by provider name.
5. Selector, api-key screen and Docker env passthrough follow from 2–4.

**Adding a PROVIDER to the existing jcode backend is a different, smaller job**
(exercised end to end when OpenRouter rejoined): a `PROVIDERS` entry — with
`modelNamespace` only if the endpoint names its models BARE — an
`API_KEY_REGISTRY` spec carrying `providerBound`, and a `JCODE_PROFILES` member
(`hermetic.ts`; `base_url`/`api_key_env` are DERIVED, never retyped). The
`Record<LlmProvider, …>` makes tsc point at the one place left to fill. No new
`AgentBackendKind`.

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
> every spec. Re-measured the SAME day after OpenRouter rejoined as a PROVIDER:
> the two-member `LlmProviderSchema`, `providerBound` replacing `backendBound`,
> the per-provider `JCODE_PROFILES`, `modelIdForProvider`, and
> `stripForeignProviderKeys`. The provider layer (`src/lib/providers.ts`) is the
> surface that moves — re-read it rather than trusting a union quoted here.

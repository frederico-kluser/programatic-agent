/**
 * Pure data assembly for the web UI's REST surface. Every function here is
 * a thin, side-effect-light projection over the same libraries the TUI uses
 * (backend registry, model catalog, api-key registry, pipeline I/O) so the
 * browser sees exactly the choices the Ink screens offer. Kept separate from
 * the HTTP plumbing in `server.ts` so it can be unit-tested without a socket.
 */

import { basename, dirname, join, parse } from 'node:path';
import { readdirSync, existsSync, statSync } from 'node:fs';
import {
  ALL_BACKENDS,
  selectBackend,
  type AgentBackendKind,
} from '../orchestrator/backends/registry.js';
import {
  findSpec,
  maskKey,
  resolveApiKey,
  resolveApiKeyWithSource,
  findMissingKeysForProvider,
  type ApiKeySpec,
} from '../lib/api-key.js';
import {
  validateKeyForSpec,
  type KeyVerdict,
} from '../lib/key-validation.js';
import {
  cooldownActive,
  loadKeyPool,
  type KeyPoolState,
} from '../lib/api-key-pool.js';
import {
  PROVIDERS,
  providersForBackend,
  resolveRunProvider,
  type ProviderInfo,
} from '../lib/providers.js';
import { loadRecommendedModels } from '../models/catalog.js';
import { supportsThinking } from '../lib/model-factory.js';
import {
  listAllPipelines,
  listPipelinesInMemory,
  type PipelineEntry,
} from '../lib/pipeline-io.js';
import { ensureAllDefaultPipelines } from '../lib/pipeline-bootstrap.js';
import {
  isCheckStep,
  type LlmProvider,
  type Pipeline,
  type PipelineStep,
} from '../lib/types.js';

export interface BackendInfo {
  id: AgentBackendKind;
  label: string;
  description: string;
  requiresApiKey: boolean;
  /** True when a usable key is already resolvable (env, mount, or saved). */
  hasKey: boolean;
  /**
   * Registry name of this backend's credential — present ONLY for a backend
   * that serves exactly one provider, and therefore `undefined` for `jcode`.
   * The browser must look the spec up on the PROVIDER it selected
   * (`/api/providers` → `keySpecs`), which is the only object that knows
   * whether this run spends the DeepSeek key or the OpenRouter one.
   */
  apiKeySpecName?: string;
  /** False for stub — surfaced as a no-cost "demo" backend in the UI. */
  userSelectable: boolean;
}

export interface ModelInfo {
  id: string;
  label: string;
  inputPrice?: number;
  outputPrice?: number;
  description?: string;
  bestFor?: string[];
  tier?: string;
  thinking: boolean;
  /**
   * Whether the model advertises tool calling.
   * huu's agents require it; surfaced so the picker can warn when it's absent
   * rather than silently hiding the model. Undefined for the static catalog.
   */
  tools?: boolean;
  /** Context window in tokens, when known. */
  contextLength?: number;
}

export interface KeySpecInfo {
  name: string;
  label: string;
  hint?: string;
  validatePrefix?: string;
  present: boolean;
}

export interface KeyStatus {
  /** True when nothing is missing for this backend — the run can launch. */
  ok: boolean;
  missing: KeySpecInfo[];
}

export interface StepInfo {
  name: string;
  type: 'work' | 'check';
  scope?: string;
  /** Short, human description of what the node does (prompt/condition head). */
  summary: string;
}

export interface PipelineInfo {
  name: string;
  /** One-line summary shown on the launch cards. */
  description?: string;
  source: 'local' | 'global' | 'memory';
  fileName?: string;
  stepCount: number;
  workSteps: number;
  checkSteps: number;
  isDefault: boolean;
  steps: StepInfo[];
}

/**
 * "Could a run on this backend launch at all?" — true when AT LEAST ONE of the
 * providers it serves has its credential resolvable. It is deliberately NOT
 * "the first provider has a key": with only `OPENROUTER_API_KEY` exported, that
 * reading reported jcode as key-less while a perfectly runnable OpenRouter run
 * was one click away. The per-provider truth lives in `listProvidersInfo()`,
 * which is what the launch form actually gates on.
 */
function backendHasKey(kind: AgentBackendKind): boolean {
  const bundle = selectBackend(kind);
  if (!bundle.requiresApiKey) return true;
  const provs = providersForBackend(kind);
  if (provs.length === 0) return true;
  return provs.some((p) => findMissingKeysForProvider(p).length === 0);
}

/** Every backend the browser may offer, annotated with live key presence. */
export function listBackendsInfo(): BackendInfo[] {
  return ALL_BACKENDS.map((id) => {
    const b = selectBackend(id);
    return {
      id,
      label: b.label,
      description: b.description,
      requiresApiKey: b.requiresApiKey,
      hasKey: backendHasKey(id),
      apiKeySpecName: b.apiKeySpecName,
      userSelectable: b.userSelectable,
    };
  });
}

/**
 * Result of validating a pasted key BEFORE it is used. The browser-only
 * key flow blocks on this: a key that comes back `invalid` (the provider
 * actively rejected it with 401/403 — the exact failure that motivated
 * this) is never accepted; `unverifiable` (offline/VPN, 429, or a spec with
 * no cheap probe) is accepted with a warning so users aren't hard-blocked.
 *
 * The union itself lives in `lib/key-validation.ts` — the web layer consumes
 * it, it does not own it. This alias keeps the wire-facing name the browser
 * clients are written against.
 *
 * WHO ACTUALLY CONSUMES IT, since a wrong answer here invites the next reader
 * to "keep the other caller working" that does not exist: `validateKeyValue`
 * below is called from `server.ts` and NOWHERE ELSE, by exactly three
 * endpoints — `POST /api/keys/validate`, `POST /api/keys/pool` (validate
 * before a key joins the pool) and `POST /api/keys/pool/validate` (re-check a
 * pooled key, which burns or un-burns it).
 *
 * The TUI is NOT among them. `ApiKeyPrompt` still does only the two free
 * checks (`detectForeignKeySpec` + the soft prefix warning) and never probes,
 * so no first-run flow reaches this module. The union nonetheless lives in
 * `lib/key-validation.ts` rather than here because the WEB layer must not own
 * a credential contract the TUI would have to import upward to reuse.
 */
export type KeyValidation = KeyVerdict;

/**
 * Validate a key value against its provider without persisting anything.
 *
 * A thin HTTP-layer wrapper over {@link validateKeyForSpec}: the semantics,
 * the probes and the 401-vs-network distinction all belong to the lib module.
 *
 * `opts.endpoint` is accepted and ignored. It is an Azure-era leftover — that
 * backend's key could only be checked together with its endpoint URL — and the
 * browser still sends the field; keeping the parameter means the clients and
 * `server.ts` need no change.
 */
export async function validateKeyValue(
  spec: ApiKeySpec,
  value: string,
  opts?: { endpoint?: string; timeoutMs?: number },
): Promise<KeyValidation> {
  return validateKeyForSpec(spec, value, { timeoutMs: opts?.timeoutMs });
}

/**
 * Selectable models, with thinking-capability annotation.
 *
 * `provider` is the sharp filter and the one the browser always sends: `jcode`
 * serves both DeepSeek and OpenRouter, so filtering by backend alone offers a
 * Claude entry to a DeepSeek run.
 */
export function listModelsInfo(
  cwd: string,
  backend: AgentBackendKind,
  provider?: LlmProvider,
): ModelInfo[] {
  const models = loadRecommendedModels(cwd, backend, provider);
  return models.map((m) => ({
    id: m.id,
    label: m.label,
    inputPrice: m.inputPrice,
    outputPrice: m.outputPrice,
    description: m.description,
    bestFor: m.bestFor ? [...m.bestFor] : undefined,
    tier: m.tier,
    thinking: supportsThinking(m.id),
  }));
}

/**
 * Models offered for a backend in the web UI.
 *
 * Uses the static recommended catalog loaded from `recommended-models.json`
 * (or the in-code fallback). The live catalog from OpenRouter is no longer
 * available — DeepSeek does not expose a public /models endpoint.
 */
export async function listModelsForBackend(
  cwd: string,
  backend: AgentBackendKind,
  _key: string,
  provider?: LlmProvider,
): Promise<{ models: ModelInfo[]; source: 'recommended' }> {
  return {
    models: listModelsInfo(cwd, backend, resolveRunProvider(backend, provider)),
    source: 'recommended',
  };
}

function specToInfo(spec: ApiKeySpec): KeySpecInfo {
  return {
    name: spec.name,
    label: spec.label,
    hint: spec.hint,
    validatePrefix: spec.validatePrefix,
    present: Boolean(resolveApiKey(spec)),
  };
}

/**
 * Which credentials (if any) a run still needs, keyed on the PROVIDER.
 *
 * Backend-keyed, this function answered for jcode's FIRST provider, so an
 * OpenRouter launch form reported `deepseek` missing and the run button stayed
 * disabled while `OPENROUTER_API_KEY` was right there. `provider` undefined
 * means "no provider will be called" (stub) → nothing is required.
 */
export function keyStatus(
  backend: AgentBackendKind,
  provider?: LlmProvider,
): KeyStatus {
  const bundle = selectBackend(backend);
  const runProvider = resolveRunProvider(backend, provider);
  if (!bundle.requiresApiKey || runProvider === undefined) {
    return { ok: true, missing: [] };
  }
  const missing = findMissingKeysForProvider(runProvider).map(specToInfo);
  return { ok: missing.length === 0, missing };
}

/** Look up a single key spec by registry name (for persistence endpoints). */
export function findKeySpec(name: string): ApiKeySpec | undefined {
  return findSpec(name);
}

// ── Key POOL projection (⚙ Settings → multiple keys) ─────────────────────

/** One pooled key as the browser is allowed to see it — never the value. */
export interface PoolKeyInfo {
  /** Index into the persisted pool; the handle every mutating endpoint takes. */
  index: number;
  /** `maskKey` of the value. The ONLY representation that leaves the server. */
  masked: string;
  state: 'active' | 'cooling' | 'burned';
  /** ISO instant the cooldown lifts (state `cooling` only). */
  until?: string;
  /** Why the key was burned (state `burned` only). */
  reason?: string;
}

export interface KeyPoolInfo {
  name: string;
  label: string;
  /** Round-robin position the next rotation starts from. */
  current: number;
  /**
   * Which tier would supply the key for a NEW run started without a browser
   * session key — the SAME vocabulary `/api/keys/status` uses (`options`,
   * `secret-mount`, `stored`, `env-file`, `env`, `none`). Deliberately not a
   * description of where the POOL lives: the user's question is "which key
   * will actually run", and a pool whose keys the secret mount outranks is
   * exactly the case where the two answers differ.
   */
  source: string;
  keys: PoolKeyInfo[];
}

/**
 * Project a pool into the browser-safe shape.
 *
 * The masking is the whole point: a pool endpoint that echoed values would
 * hand every saved key to anyone who can reach the (optionally token-gated)
 * HTTP surface, and the browser has no use for them — every action it can take
 * is by INDEX.
 *
 * `webKey` is the live `POST /api/keys` override, passed in rather than read
 * here so this module stays free of run-manager state.
 */
export function keyPoolInfo(
  spec: ApiKeySpec,
  webKey?: string,
  state: KeyPoolState = loadKeyPool(spec),
  now: number = Date.now(),
): KeyPoolInfo {
  const burnedByIndex = new Map(state.burned.map((b) => [b.index, b]));
  const cooldownByIndex = new Map(state.cooldowns.map((c) => [c.index, c]));
  const resolved = resolveApiKeyWithSource(spec);
  return {
    name: spec.name,
    label: spec.label,
    current: state.current,
    source: webKey?.trim() ? 'options' : resolved.source,
    keys: state.keys.map((value, index) => {
      const burn = burnedByIndex.get(index);
      if (burn) {
        return { index, masked: maskKey(value), state: 'burned' as const, reason: burn.reason };
      }
      if (cooldownActive(state, index, now)) {
        return {
          index,
          masked: maskKey(value),
          state: 'cooling' as const,
          until: cooldownByIndex.get(index)!.until,
        };
      }
      return { index, masked: maskKey(value), state: 'active' as const };
    }),
  };
}

function stepSummary(step: PipelineStep): string {
  if (isCheckStep(step)) {
    return step.condition.slice(0, 160);
  }
  return step.prompt.split('\n')[0]?.slice(0, 160) ?? '';
}

function toStepInfo(step: PipelineStep): StepInfo {
  if (isCheckStep(step)) {
    return { name: step.name, type: 'check', summary: stepSummary(step) };
  }
  return {
    name: step.name,
    type: 'work',
    scope: step.scope,
    summary: stepSummary(step),
  };
}

function toPipelineInfo(
  pipeline: Pipeline,
  source: PipelineInfo['source'],
  fileName?: string,
): PipelineInfo {
  const work = pipeline.steps.filter((s) => !isCheckStep(s)).length;
  const check = pipeline.steps.length - work;
  return {
    name: pipeline.name,
    description: pipeline.description,
    source,
    fileName,
    stepCount: pipeline.steps.length,
    workSteps: work,
    checkSteps: check,
    isDefault: Boolean(pipeline._default),
    steps: pipeline.steps.map(toStepInfo),
  };
}

/**
 * List every pipeline the browser can launch: bundled defaults (materialized
 * on demand, idempotently), local `pipelines/`, the global store, and saved
 * memory entries. Defaults sort first, with the `_default` one at the top.
 */
export function listPipelinesInfo(cwd: string): PipelineInfo[] {
  // Materialize the bundled catalog so a fresh repo shows the defaults too.
  // Best-effort: a read-only repo just yields whatever already exists.
  try {
    ensureAllDefaultPipelines(cwd);
  } catch {
    /* read-only fs — fall through to whatever is listable */
  }

  const seen = new Set<string>();
  const out: PipelineInfo[] = [];

  const fileEntries: PipelineEntry[] = listAllPipelines(join(cwd, 'pipelines'));
  for (const entry of fileEntries) {
    if (seen.has(entry.pipeline.name)) continue;
    seen.add(entry.pipeline.name);
    out.push(toPipelineInfo(entry.pipeline, entry.source, entry.fileName));
  }

  for (const mem of listPipelinesInMemory()) {
    if (seen.has(mem.pipeline.name)) continue;
    seen.add(mem.pipeline.name);
    out.push(toPipelineInfo(mem.pipeline, 'memory'));
  }

  return out.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** Resolve a pipeline by name across all sources. Null when not found. */
export function getPipelineByName(cwd: string, name: string): Pipeline | null {
  const fileEntries = listAllPipelines(join(cwd, 'pipelines'));
  const match = fileEntries.find((e) => e.pipeline.name === name);
  if (match) return match.pipeline;
  const mem = listPipelinesInMemory().find((m) => m.pipeline.name === name);
  return mem ? mem.pipeline : null;
}

/** Friendly repo label for the header (basename of the working dir). */
export function repoName(cwd: string): string {
  return basename(cwd) || cwd;
}

// ── Providers ────────────────────────────────────────────────────────────

export interface ProviderUiInfo {
  id: LlmProvider;
  /** Concrete dispatch backend for model/key lookups (`pi` or `azure`). */
  backend: AgentBackendKind;
  label: string;
  description: string;
  /** Credential specs this provider needs, with live presence. */
  keySpecs: KeySpecInfo[];
  /** True when every required credential resolves — the run can launch. */
  hasKey: boolean;
}

/**
 * The user-facing provider choices for the jcode backend (DeepSeek),
 * each annotated with the credential specs it needs and whether
 * they're already resolvable. Drives the web provider selector.
 */
export function listProvidersInfo(): ProviderUiInfo[] {
  return PROVIDERS.map((p: ProviderInfo) => {
    const specs: ApiKeySpec[] = [];
    const keySpec = findSpec(p.apiKeySpecName);
    if (keySpec) specs.push(keySpec);
    if (p.endpointSpecName) {
      const ep = findSpec(p.endpointSpecName);
      if (ep) specs.push(ep);
    }
    return {
      id: p.id,
      backend: p.backend,
      label: p.label,
      description: p.description,
      keySpecs: specs.map(specToInfo),
      hasKey: findMissingKeysForProvider(p.id).length === 0,
    };
  });
}

// ── Filesystem folder navigation (run-directory picker) ──────────────────

export interface DirEntryInfo {
  name: string;
  path: string;
}

export interface DirListing {
  path: string;
  /** Parent directory, or null at the filesystem root. */
  parent: string | null;
  /** True when the directory is a git repo (a valid run target). */
  isGitRepo: boolean;
  entries: DirEntryInfo[];
}

/**
 * List the sub-directories of `target` for the web folder picker. Dotfolders
 * are hidden to keep the list readable. Unreadable directories yield an empty
 * entry list rather than throwing, so the browser can still navigate away.
 * Falls back to the process cwd when the path doesn't exist.
 */
export function listDirs(target: string): DirListing {
  const path = target && existsSync(target) ? target : process.cwd();
  let entries: DirEntryInfo[] = [];
  try {
    entries = readdirSync(path, { withFileTypes: true })
      .filter((e) => {
        if (e.name.startsWith('.')) return false;
        if (e.isDirectory()) return true;
        // Follow symlinks: include only those resolving to a DIRECTORY, so a
        // symlinked file (e.g. CLAUDE.md -> AGENTS.md) never shows as a folder
        // the picker could navigate into or mark as a project. Broken links skip.
        if (!e.isSymbolicLink()) return false;
        try { return statSync(join(path, e.name)).isDirectory(); } catch { return false; }
      })
      .map((e) => ({ name: e.name, path: join(path, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    entries = [];
  }
  const root = parse(path).root;
  return {
    path,
    parent: path === root ? null : dirname(path),
    isGitRepo: existsSync(join(path, '.git')),
    entries,
  };
}

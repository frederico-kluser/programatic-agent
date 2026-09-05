/**
 * Dependency-free HTTP + Server-Sent-Events server for huu's browser UI.
 *
 * Why built-ins only: the runtime image prunes devDependencies and we add no
 * production web framework — `node:http` + SSE is enough for a real-time,
 * auto-reconnecting control surface, and it ships inside Docker with zero
 * extra weight. Server→browser updates flow over one SSE stream
 * (`/api/events`); browser→server actions are plain `fetch` POSTs.
 *
 * Layering: this is a presentation/entry layer (sibling to `ui/`), so it may
 * import from orchestrator/lib/models — never the other way around.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extname, join, normalize } from 'node:path';
import type { AgentBackendKind } from '../orchestrator/backends/registry.js';
import { parseBackendKind } from '../orchestrator/backends/registry.js';
import type { AgentOutputChunk } from '../orchestrator/types.js';
import type {
  DevMethodology,
  DevModelPreset,
  LlmProvider,
  OrchestratorState,
  Pipeline,
} from '../lib/types.js';
import { DEV_MODEL_PRESETS } from '../lib/types.js';
import { backendToProvider, parseProvider, providerToBackend } from '../lib/providers.js';
import {
  listBackendsInfo,
  listProvidersInfo,
  listModelsForBackend,
  keyStatus,
  keyPoolInfo,
  findKeySpec,
  validateKeyValue,
  listPipelinesInfo,
  getPipelineByName,
  listDirs,
  repoName,
} from './api-data.js';
import {
  clearStoredApiKey,
  detectForeignKeySpec,
  findSpec,
  maskKey,
  resolveApiKeyWithSource,
  saveApiKey,
} from '../lib/api-key.js';
import {
  addPoolKey,
  loadKeyPool,
  markBurned,
  removePoolKey,
  saveKeyPool,
} from '../lib/api-key-pool.js';
import {
  DEV_MODEL_ROLES,
  devModelPresetProviders,
  parseDevModelPolicy,
} from '../lib/dev-mode/dev-model-policy.js';
import { devModelProviderIndex } from '../lib/dev-mode/model-catalog-index.js';
import { DEV_METHODOLOGIES } from '../lib/dev-mode/methodology-registry.js';
import { WebRunManager, pickRunKey, type RunSnapshot, type StartRunParams } from './run-manager.js';
import { DevStartRefusal, WebDevManager, type DevSessionSnapshot } from './dev-manager.js';
import { parseDevGraph } from '../lib/dev-graph/graph-schema.js';
import type { DevGraph } from '../lib/dev-graph/graph-types.js';
import {
  graphBlockOptions,
  graphNodeKindOptions,
  graphSampleOptions,
  handleGraphRequest,
  isGraphApiPath,
} from './graph-api.js';
import { TranscribeError, isTranscribeFormat, transcribeAudio } from '../lib/transcribe.js';
import { termLog } from './terminal-log.js';
import {
  DEFAULT_LOCALE,
  availableLocales,
  getLocale,
  messagesFor,
  normalizeLocale,
} from '../lib/i18n/index.js';

export interface WebServerOptions {
  cwd: string;
  /** Pre-selected backend from CLI flags (`--backend`, `--provider`, `--stub`). */
  lockedBackend?: AgentBackendKind;
  /**
   * Provider locked from `--provider=`. Carried separately from
   * `lockedBackend` because both providers map to the SAME `jcode` kind —
   * re-deriving it from the backend silently rewrote `--provider=openrouter`
   * into `deepseek` in the browser's provider segment.
   */
  lockedProvider?: LlmProvider;
  /** Pipeline preloaded via `huu run <file>` — offered as the first choice. */
  initialPipeline?: Pipeline;
  /** Default concurrency strategy (false when `--no-auto-scale`). */
  defaultAutoScale: boolean;
  /** Manual concurrency seed from `--concurrency=N`. */
  defaultConcurrency?: number;
  /** Optional shared secret (HUU_WEB_TOKEN). When set, /api + /events require it. */
  token?: string;
  /**
   * SSE heartbeat interval (ms, default 25 000). Emitted as a REAL
   * `event: ping` frame — not an SSE comment — so the browser's liveness
   * watchdog can observe it. Injectable so tests don't wait 25 s.
   */
  heartbeatMs?: number;
}

/** Per-agent log lines kept in each broadcast frame (full set via /api/agent-logs). */
const MAX_AGENT_LOG_LINES = 200;
/** Coalesce orchestrator emits to at most one SSE frame per this interval. */
const BROADCAST_INTERVAL_MS = 120;

/**
 * The selectable dev-mode methodologies, served on `/api/bootstrap` so the
 * /dev form renders its toggles FROM this table — the same pattern as
 * `devModelPresets`/`devModelRoles`, and for the same reason: a client that
 * hardcoded the list would drift the day an option is added.
 *
 * Projected from {@link DEV_METHODOLOGIES}, the single declaration surface, so
 * the web catalog cannot drift from the CLI flags or the planner's bullets
 * either. Only the browser-facing columns cross the wire — the flag and the
 * planner bullet are nobody's business here. The keys stay compile-checked
 * against {@link DevMethodology}, so an option the type does not declare fails
 * the build instead of silently doing nothing. All OFF by default — a session
 * that checks none compiles the pipeline it compiles today, byte for byte.
 */
const DEV_METHODOLOGY_OPTIONS: readonly {
  key: keyof DevMethodology;
  label: string;
  description: string;
}[] = DEV_METHODOLOGIES.map(({ key, label, description }) => ({ key, label, description }));

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/** Resolve the static client directory next to this module (dev: src, prod: dist). */
function clientDir(): string {
  return fileURLToPath(new URL('./client/', import.meta.url));
}

interface SseClient {
  res: ServerResponse;
}

/**
 * Construct (but do not bind) the web server. Returns the server + run
 * manager so the caller (serve.ts / tests) controls `.listen()` and can
 * close it deterministically.
 */
export function createWebServer(opts: WebServerOptions): {
  server: Server;
  manager: WebRunManager;
} {
  const root = clientDir();
  const sseClients = new Set<SseClient>();

  // Throttled PER-RUN broadcast — coalesce a busy run's emits to ≤1 frame per
  // run per interval. Concurrent runs each get their own frame keyed by runId;
  // one flush drains every run that changed since the last tick.
  let pending = new Map<string, RunSnapshot>();
  let lastBroadcast = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let simSeq = 0;

  const buildFrame = (snap: RunSnapshot): string =>
    JSON.stringify({ type: 'run', run: serializeSnapshot(snap) });

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending.size === 0) return;
    lastBroadcast = Date.now();
    const drained = pending;
    pending = new Map();
    for (const snap of drained.values()) {
      const frame = buildFrame(snap);
      for (const client of sseClients) writeSse(client.res, 'message', frame);
    }
  };

  const scheduleBroadcast = (snap: RunSnapshot): void => {
    pending.set(snap.runId, snap);
    const since = Date.now() - lastBroadcast;
    if (since >= BROADCAST_INTERVAL_MS) flush();
    else if (!timer) timer = setTimeout(flush, BROADCAST_INTERVAL_MS - since);
  };

  // Raw agent-output firehose: relay each coalesced line straight to every
  // connected browser as its own SSE frame, TAGGED with the originating runId
  // so the client routes it to the right board. NOT throttled (append-only, one
  // frame per line, not per token); the browser also mirrors it to the console.
  // Opt-in: also mirror the raw firehose to the serve terminal. Default OFF —
  // it is per-token-batch agent prose and would drown the lifecycle log.
  const streamToTerminal = process.env.HUU_WEB_LOG_STREAM === '1';
  const broadcastAgentStream = (runId: string, chunk: AgentOutputChunk): void => {
    if (streamToTerminal && chunk.text?.trim()) {
      termLog('info', `agent ${chunk.agentId}`, chunk.text.trim());
    }
    if (sseClients.size === 0) return;
    const frame = JSON.stringify({ type: 'agent-stream', runId, ...chunk });
    for (const client of sseClients) writeSse(client.res, 'message', frame);
  };

  const manager = new WebRunManager(opts.cwd, scheduleBroadcast, broadcastAgentStream);

  // Development-mode sessions ride TWO channels: each epoch is an ordinary run
  // and goes through `scheduleBroadcast` so the existing kanban renders it
  // unchanged; only the session layer (goal, knowledge probe, epoch chain,
  // approval gate) needs its own frame type. Session frames are NOT throttled —
  // they fire on lifecycle transitions, not on agent activity.
  let lastDevSnapshot: DevSessionSnapshot | null = null;
  const broadcastDev = (session: DevSessionSnapshot): void => {
    lastDevSnapshot = session;
    if (sseClients.size === 0) return;
    const frame = JSON.stringify({ type: 'dev', session });
    for (const client of sseClients) writeSse(client.res, 'message', frame);
  };
  const devManager = new WebDevManager(
    opts.cwd,
    manager,
    broadcastDev,
    scheduleBroadcast,
    broadcastAgentStream,
  );

  // Machine-global budget telemetry: one `{type:'budget'}` frame per second to
  // every client while runs are tracked. Low-frequency by design — it rides its
  // own frame type (never inflates the throttled `run` snapshot) and carries
  // the dial, used/total RAM, PSI and the pressure level so the user can SEE
  // that the gear took effect and when the guard engages.
  const budgetTimer = setInterval(() => {
    if (sseClients.size === 0) return;
    const budget = manager.budgetTelemetry();
    if (!budget) return;
    const frame = JSON.stringify({ type: 'budget', budget });
    for (const client of sseClients) writeSse(client.res, 'message', frame);
  }, 1_000);
  budgetTimer.unref?.();

  const requireToken = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (!opts.token) return true;
    const url = new URL(req.url ?? '/', 'http://localhost');
    const provided =
      url.searchParams.get('token') ??
      (req.headers['x-huu-token'] as string | undefined) ??
      '';
    if (provided === opts.token) return true;
    sendJson(res, 401, { error: 'invalid or missing token' });
    return false;
  };

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      termLog('error', 'web', `${req.method ?? 'GET'} ${req.url ?? '/'} failed: ${message}`);
      if (!res.headersSent) sendJson(res, 500, { error: message });
      else res.end();
    });
  });
  // SSE longevity: keep Node's request-receipt timer (default 5 min) away
  // from the long-lived `/events` stream — cheap insurance, the client
  // watchdog is the primary defense. headersTimeout keeps slowloris
  // protection for everything else.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;

  async function handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // --- Static + health (no token required) ---
    if (method === 'GET' && (path === '/' || path === '/index.html')) {
      return serveStatic(res, root, 'index.html');
    }
    if (method === 'GET' && (path === '/simulation' || path === '/simulation/')) {
      // SPA shell for the synthetic /simulation demo. The client routes on
      // location.pathname and shows the simulation setup instead of launch.
      return serveStatic(res, root, 'index.html');
    }
    if (method === 'GET' && (path === '/dev' || path === '/dev/')) {
      // Same SPA shell for development mode — the client routes on
      // location.pathname, exactly like /simulation.
      return serveStatic(res, root, 'index.html');
    }
    if (method === 'GET' && (path === '/graph' || path === '/graph/')) {
      // Same SPA shell for the method editor (`huu-devgraph-v1`). Without this
      // route a deep link to /graph would fall through to the static handler
      // below and 404 as a missing asset.
      return serveStatic(res, root, 'index.html');
    }
    if (method === 'GET' && path === '/api/health') {
      return sendJson(res, 200, { ok: true, name: 'huu', repo: repoName(opts.cwd) });
    }
    // Translation catalog for the browser. Deliberately NOT token-gated: the
    // client must be able to paint its own login/error chrome in the user's
    // language before it has a token. Catalogs carry no secrets.
    if (method === 'GET' && path === '/api/i18n') {
      const requested = normalizeLocale(url.searchParams.get('locale'));
      const locale = requested ?? getLocale();
      return sendJson(res, 200, {
        locale,
        defaultLocale: DEFAULT_LOCALE,
        locales: availableLocales(),
        messages: messagesFor(locale),
      });
    }
    if (method === 'GET' && !path.startsWith('/api/') && path !== '/events') {
      // Any other GET → static asset (app.js, styles.css, favicon.svg, …).
      return serveStatic(res, root, path.replace(/^\/+/, ''));
    }

    // --- Everything below is data/actions: token-gated when configured ---
    if (!requireToken(req, res)) return;

    if (method === 'GET' && path === '/api/bootstrap') {
      return sendJson(res, 200, bootstrapPayload());
    }
    if (method === 'GET' && path === '/api/pipelines') {
      return sendJson(res, 200, { pipelines: listPipelinesInfo(opts.cwd) });
    }
    if (method === 'GET' && path === '/api/pipeline') {
      const name = url.searchParams.get('name') ?? '';
      const pipeline =
        opts.initialPipeline && opts.initialPipeline.name === name
          ? opts.initialPipeline
          : getPipelineByName(opts.cwd, name);
      if (!pipeline) return sendJson(res, 404, { error: 'pipeline not found' });
      return sendJson(res, 200, { pipeline });
    }
    if (method === 'GET' && path === '/api/providers') {
      return sendJson(res, 200, { providers: listProvidersInfo() });
    }
    if (method === 'GET' && path === '/api/folders') {
      // Folder navigation for the run-directory picker. A bare call opens at
      // the workspace root (HUU_WORKSPACE, default $HOME) so the picker lands
      // where the user's projects live, not deep in one repo.
      const target = url.searchParams.get('path') ?? workspaceRoot();
      return sendJson(res, 200, listDirs(target));
    }
    if (method === 'GET' && path === '/api/models') {
      // Accept either a provider or a raw backend kind.
      const provider = parseProvider(url.searchParams.get('provider') ?? '');
      const backend = provider
        ? providerToBackend(provider)
        : parseBackendKind(url.searchParams.get('backend') ?? 'jcode');
      if (!backend) return sendJson(res, 400, { error: 'unknown backend' });
      const hk = req.headers['x-huu-key'];
      const backendKey = (Array.isArray(hk) ? hk[0] : hk ?? '').toString();
      const { models, source } = await listModelsForBackend(
        opts.cwd,
        backend,
        backendKey,
        provider ?? undefined,
      );
      return sendJson(res, 200, { models, source });
    }
    if (method === 'GET' && path === '/api/keys') {
      const provider = parseProvider(url.searchParams.get('provider') ?? '');
      const backend = provider
        ? providerToBackend(provider)
        : parseBackendKind(url.searchParams.get('backend') ?? 'jcode');
      if (!backend) return sendJson(res, 400, { error: 'unknown backend' });
      // The PROVIDER decides which credential is missing. Passing only the
      // backend made this endpoint answer for jcode's first provider, so the
      // browser's OpenRouter launch form was told `deepseek` was missing.
      return sendJson(res, 200, keyStatus(backend, provider ?? undefined));
    }
    if (method === 'GET' && path === '/api/keys/status') {
      // Per-spec key status for the ⚙ Options panel: which tier would supply
      // the key for a NEW run started WITHOUT a browser session key, masked.
      // Never returns the value itself.
      const name = url.searchParams.get('name') ?? 'deepseek';
      const spec = findKeySpec(name);
      if (!spec) return sendJson(res, 400, { error: `unknown key: ${name}` });
      const webKey = manager.getWebKey(name);
      const resolved = resolveApiKeyWithSource(spec);
      const effective = webKey || resolved.value;
      const source = webKey ? 'options' : resolved.source;
      return sendJson(res, 200, {
        name,
        label: spec.label,
        envVar: spec.envVar,
        source,
        masked: effective ? maskKey(effective) : null,
        envPresent: Boolean((process.env[spec.envVar] ?? '').trim()),
        storedOverridesEnv: resolved.storedOverridesEnv,
      });
    }
    if (method === 'POST' && path === '/api/keys/validate') {
      // Browser-only key flow: validate a pasted key against its provider
      // WITHOUT persisting it. The browser keeps the value in session
      // memory and sends it back with each run; nothing is written to disk.
      const body = await readJsonBody(req);
      const name = String(body.name ?? '');
      const value = String(body.value ?? '');
      const endpoint = body.endpoint ? String(body.endpoint) : undefined;
      const spec = findKeySpec(name);
      if (!spec) return sendJson(res, 400, { error: `unknown key: ${name}` });
      if (!value.trim()) return sendJson(res, 400, { error: 'empty value' });
      const result = await validateKeyValue(spec, value, { endpoint });
      // Mirror the outcome to the serve terminal — "did my key take?" must be
      // answerable without opening DevTools.
      const masked = maskKey(value);
      if (result.status === 'valid') {
        termLog('ok', 'keys', `${spec.label} ${masked} validated by the provider`);
      } else if (result.status === 'invalid') {
        termLog(
          'error',
          'keys',
          `${spec.label} ${masked} REJECTED by the provider (HTTP ${result.httpStatus}) — not usable`,
        );
      } else if (result.status === 'wrong-key') {
        termLog(
          'error',
          'keys',
          `${masked} is a ${result.label} key, not a ${spec.label} key — refused before saving ` +
            `(it would have been stored as "${spec.name}" and sent to the wrong vendor)`,
        );
      } else {
        termLog('warn', 'keys', `${spec.label} ${masked} could not be verified (${result.reason})`);
      }
      return sendJson(res, 200, result);
    }
    if (method === 'POST' && path === '/api/keys') {
      // Persist a key: written to the global config store (host-mounted via
      // HUU_CONFIG_DIR under Docker, so it survives the container) AND
      // registered as the live in-session override — inside Docker the
      // resolver's secret mount is a startup snapshot, so without the
      // override a just-saved key would not take effect until restart. The
      // web ⚙ Options calls this AFTER a successful /api/keys/validate.
      const body = await readJsonBody(req);
      const name = String(body.name ?? '');
      const value = String(body.value ?? '');
      const spec = findKeySpec(name);
      if (!spec) return sendJson(res, 400, { error: `unknown key: ${name}` });
      if (!value.trim()) return sendJson(res, 400, { error: 'empty value' });
      // Defense in depth: the ⚙ Options flow calls /api/keys/validate first,
      // but this endpoint PERSISTS, so it refuses another provider's key on
      // its own rather than trusting the caller to have asked.
      const foreign = detectForeignKeySpec(spec, value);
      if (foreign) {
        termLog(
          'error',
          'keys',
          `${maskKey(value)} is a ${foreign.label} key, not a ${spec.label} key — not saved`,
        );
        return sendJson(res, 400, {
          error: `that looks like a ${foreign.label} key, not a ${spec.label} key`,
          validation: { status: 'wrong-key', belongsTo: foreign.name, label: foreign.label },
        });
      }
      saveApiKey(spec, value);
      manager.setWebKey(name, value);
      termLog(
        'ok',
        'keys',
        `${spec.label} ${maskKey(value)} saved — every new run uses it (persisted for future huu sessions too)`,
      );
      return sendJson(res, 200, { ok: true, masked: maskKey(value) });
    }
    if (method === 'DELETE' && path === '/api/keys') {
      // Clear a saved key: removes the config-store entry + the live web
      // override. Runs then fall back to the ambient tiers. Inside Docker the
      // startup secret-mount snapshot cannot be unmounted — the response says
      // so instead of pretending the clear fully applied.
      const name = url.searchParams.get('name') ?? '';
      const spec = findKeySpec(name);
      if (!spec) return sendJson(res, 400, { error: `unknown key: ${name}` });
      const cleared = clearStoredApiKey(spec);
      manager.clearWebKey(name);
      const still = resolveApiKeyWithSource(spec);
      const note =
        still.source === 'secret-mount'
          ? `this session still holds the key forwarded when huu started — restart huu to fully clear it`
          : still.source === 'env' || still.source === 'env-file'
            ? `runs now fall back to ${spec.envVar}`
            : 'no key remains — new runs will need one';
      termLog('warn', 'keys', `${spec.label} saved key cleared — ${note}`);
      return sendJson(res, 200, { ok: true, cleared, fallback: still.source, note });
    }
    // --- Key POOL (⚙ Settings → several keys, with rotation) --------------
    //
    // Everything here is INDEX-addressed and MASK-returned: the browser never
    // receives a key value, only `maskKey(value)` plus the key's rotation
    // state. Writes are always validate-then-persist, the same rule the
    // single-key panel follows.
    if (method === 'GET' && path === '/api/keys/pool') {
      const spec = findKeySpec(url.searchParams.get('name') ?? 'deepseek');
      if (!spec) return sendJson(res, 400, { error: `unknown key: ${url.searchParams.get('name')}` });
      return sendJson(res, 200, keyPoolInfo(spec, manager.getWebKey(spec.name)));
    }
    if (method === 'POST' && path === '/api/keys/pool') {
      // VALIDATE BEFORE PERSIST. A key the provider actively rejects (401/403)
      // is never written: a burned key sitting in the pool costs a wasted
      // rotation on every failure it later takes part in. `unverifiable`
      // (offline, or a spec with no cheap probe) is accepted with the reason
      // echoed back — the same policy /api/keys/validate uses, because hard-
      // blocking an offline user is worse than a key that might not work.
      const body = await readJsonBody(req);
      const name = String(body.name ?? '');
      const value = String(body.value ?? '');
      const endpoint = body.endpoint ? String(body.endpoint) : undefined;
      const spec = findKeySpec(name);
      if (!spec) return sendJson(res, 400, { error: `unknown key: ${name}` });
      if (!value.trim()) return sendJson(res, 400, { error: 'empty value' });
      const validation = await validateKeyValue(spec, value, { endpoint });
      const masked = maskKey(value);
      if (validation.status === 'wrong-key') {
        termLog(
          'error',
          'keys',
          `${masked} is a ${validation.label} key, not a ${spec.label} key — not added to the pool`,
        );
        return sendJson(res, 400, {
          error: `that looks like a ${validation.label} key, not a ${spec.label} key`,
          validation,
        });
      }
      if (validation.status === 'invalid') {
        termLog(
          'error',
          'keys',
          `${spec.label} ${masked} REJECTED by the provider (HTTP ${validation.httpStatus}) — not added to the pool`,
        );
        return sendJson(res, 400, {
          error: `the provider rejected this key (HTTP ${validation.httpStatus})`,
          httpStatus: validation.httpStatus,
          validation,
        });
      }
      const pool = addPoolKey(spec, value);
      termLog(
        'ok',
        'keys',
        `${spec.label} ${masked} added to the pool (${pool.keys.length} key(s))` +
          (validation.status === 'unverifiable' ? ` — unverified: ${validation.reason}` : ''),
      );
      return sendJson(res, 200, {
        ok: true,
        validation,
        ...keyPoolInfo(spec, manager.getWebKey(spec.name), pool),
      });
    }
    if (method === 'DELETE' && path === '/api/keys/pool') {
      const name = url.searchParams.get('name') ?? '';
      const spec = findKeySpec(name);
      if (!spec) return sendJson(res, 400, { error: `unknown key: ${name}` });
      // `searchParams.get` yields null when the param is absent, and
      // `Number(null)` is 0 — so an index-less DELETE would silently drop key
      // #0. Require the parameter to be PRESENT before coercing it.
      const rawIndex = url.searchParams.get('index');
      const index = rawIndex === null ? NaN : Number(rawIndex);
      if (!Number.isInteger(index) || index < 0) {
        return sendJson(res, 400, { error: 'a non-negative integer index is required' });
      }
      const pool = removePoolKey(spec, index);
      termLog('warn', 'keys', `${spec.label} key #${index} removed — ${pool.keys.length} left in the pool`);
      return sendJson(res, 200, {
        ok: true,
        ...keyPoolInfo(spec, manager.getWebKey(spec.name), pool),
      });
    }
    if (method === 'POST' && path === '/api/keys/pool/reset') {
      // Clear the LEARNED sidelining (burns + cooldowns) — the escape hatch for
      // a key burned by a provider blip or one whose quota was topped up. With
      // no `index`, the whole pool is cleared.
      const body = await readJsonBody(req);
      const name = String(body.name ?? '');
      const spec = findKeySpec(name);
      if (!spec) return sendJson(res, 400, { error: `unknown key: ${name}` });
      const only = typeof body.index === 'number' ? Math.floor(body.index) : undefined;
      const state = loadKeyPool(spec);
      const pool = saveKeyPool(spec, {
        ...state,
        burned: only === undefined ? [] : state.burned.filter((b) => b.index !== only),
        cooldowns: only === undefined ? [] : state.cooldowns.filter((c) => c.index !== only),
      });
      termLog(
        'info',
        'keys',
        `${spec.label} rotation state reset${only === undefined ? '' : ` for key #${only}`}`,
      );
      return sendJson(res, 200, {
        ok: true,
        ...keyPoolInfo(spec, manager.getWebKey(spec.name), pool),
      });
    }
    if (method === 'POST' && path === '/api/keys/pool/validate') {
      // Re-probe a STORED key and record what the provider said: a key that now
      // answers 200 comes back into rotation, one that answers 401/403 is
      // burned. Probing without recording would leave the user reading a stale
      // badge, which is the thing this endpoint exists to fix.
      const body = await readJsonBody(req);
      const name = String(body.name ?? '');
      const spec = findKeySpec(name);
      if (!spec) return sendJson(res, 400, { error: `unknown key: ${name}` });
      const index = typeof body.index === 'number' ? Math.floor(body.index) : NaN;
      const state = loadKeyPool(spec);
      const value = Number.isInteger(index) ? state.keys[index] : undefined;
      if (value === undefined) {
        return sendJson(res, 400, { error: `no key at index ${String(body.index)}` });
      }
      const validation = await validateKeyValue(spec, value, {
        endpoint: body.endpoint ? String(body.endpoint) : undefined,
      });
      if (validation.status === 'invalid') {
        markBurned(state, index, String(validation.httpStatus));
      } else if (validation.status === 'valid') {
        state.burned = state.burned.filter((b) => b.index !== index);
        state.cooldowns = state.cooldowns.filter((c) => c.index !== index);
      }
      const pool = saveKeyPool(spec, state);
      termLog(
        validation.status === 'valid' ? 'ok' : validation.status === 'invalid' ? 'error' : 'warn',
        'keys',
        `${spec.label} key #${index} (${maskKey(value)}) re-probed: ${validation.status}`,
      );
      return sendJson(res, 200, {
        ok: true,
        index,
        validation,
        ...keyPoolInfo(spec, manager.getWebKey(spec.name), pool),
      });
    }
    if (method === 'GET' && path === '/api/agent-logs') {
      const id = Number(url.searchParams.get('id'));
      const runId = url.searchParams.get('runId') ?? undefined;
      const snap = manager.getSnapshot(runId);
      const agent = snap.state?.agents.find((a) => a.agentId === id);
      return sendJson(res, 200, { logs: agent?.logs ?? [] });
    }
    if (method === 'POST' && path === '/api/settings') {
      // Machine-global settings. `ramPercent` applies to the shared scheduler
      // IMMEDIATELY (all current + future runs) and persists server-side; a
      // null/absent value clears the web override (back to env/default). The
      // response echoes the EFFECTIVE value so the client can display what
      // actually took — the old dial had no feedback loop at all.
      const body = await readJsonBody(req);
      const raw = body.ramPercent;
      const pct =
        typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
      const effective = manager.setRamPercent(pct);
      termLog(
        'info',
        'settings',
        pct === undefined
          ? `RAM budget override cleared — effective ${effective}%`
          : `RAM budget set to ${effective}% (applied to all runs now)`,
      );
      return sendJson(res, 200, { ok: true, ramPercent: effective });
    }
    if (method === 'POST' && path === '/api/run') {
      return startRun(req, res);
    }
    if (method === 'POST' && path === '/api/run/abort') {
      const body = await readJsonBody(req);
      // A `runId` aborts that one run; absent aborts ALL (+ scheduler teardown).
      manager.abort(body.runId ? String(body.runId) : undefined);
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'POST' && path === '/api/run/pause') {
      // Pause/resume a /simulation run (no-op for real runs).
      const body = await readJsonBody(req);
      const paused = body.paused === true || body.paused === 'true';
      manager.setPaused(String(body.runId ?? ''), paused);
      return sendJson(res, 200, { ok: true, paused });
    }
    if (method === 'POST' && path === '/api/run/concurrency') {
      const body = await readJsonBody(req);
      const runId = String(body.runId ?? '');
      if (typeof body.mode === 'string') {
        manager.setMode(runId, body.mode as 'auto' | 'manual' | 'greedy');
      } else if (typeof body.value === 'number') {
        manager.setConcurrency(runId, body.value);
      } else if (typeof body.delta === 'number') {
        manager.adjust(runId, body.delta);
      }
      return sendJson(res, 200, {
        concurrency: manager.getSnapshot(runId).state?.concurrency ?? null,
      });
    }
    if (method === 'POST' && path === '/api/run/retry') {
      // Retry one failed task card while the run is held open in
      // `awaiting_retry`. Optional `timeoutMinutes` re-runs a timed-out card
      // with a longer per-task limit. Fire-and-forget; progress streams over SSE.
      const body = await readJsonBody(req);
      const runId = String(body.runId ?? '');
      const agentId = Number(body.agentId);
      if (!runId || !Number.isFinite(agentId)) {
        return sendJson(res, 400, { error: 'runId and numeric agentId required' });
      }
      const timeoutMinutes =
        typeof body.timeoutMinutes === 'number' && body.timeoutMinutes > 0
          ? body.timeoutMinutes
          : undefined;
      manager.retryTask(runId, agentId, timeoutMinutes);
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'POST' && path === '/api/run/finish') {
      // Leave the `awaiting_retry` hold so the run finalizes and tears down.
      const body = await readJsonBody(req);
      manager.finish(String(body.runId ?? ''));
      return sendJson(res, 200, { ok: true });
    }
    // --- Development mode -------------------------------------------------
    // One session at a time: every epoch ends in a merge into the user's
    // working branch, so two concurrent sessions would race that merge.
    if (method === 'GET' && path === '/api/dev') {
      return sendJson(res, 200, { session: devManager.snapshot() });
    }
    if (method === 'POST' && path === '/api/dev') {
      // A body huu cannot even parse is a 400, exactly like `/api/graphs` —
      // starting a session is the most expensive thing this server does, and
      // "your JSON is broken" must never read as "huu failed" (see
      // `readJsonBodyOr400`).
      const body = await readJsonBodyOr400(req, res);
      if (!body) return;
      const provider = typeof body.provider === 'string' ? (body.provider as LlmProvider) : undefined;
      const backend: AgentBackendKind = provider
        ? providerToBackend(provider)
        : ((body.backend as AgentBackendKind) ?? 'jcode');
      // Per-role routing is ADDITIVE and defensively parsed: an unknown role,
      // a non-string value or an unknown preset name is dropped rather than
      // refused, and a body carrying NEITHER field leaves `models`/
      // `modelsPreset` undefined — which is what makes such a request compile
      // the exact pipeline it compiles today. `modelId` stays required and
      // stays the fallback for every role nothing named.
      const models = parseDevModelPolicy(body.models);
      const preset = parseModelsPreset(body.modelsPreset);
      // Methodology checkboxes follow the SAME additive contract as the
      // routing fields above: only `true` under a KNOWN key survives, and a
      // body that enables nothing carries no `methodology` at all — so it
      // compiles exactly the pipeline it compiles today.
      const methodology = parseDevMethodology(body.methodology);
      const resume =
        body.resume === 'auto' || body.resume === 'never' ? body.resume : undefined;
      // THE DRAWN METHOD. Two ways in, and they are coerced with the OPPOSITE
      // discipline to the fields above: routing, presets and methodology are
      // dropped when malformed, because dropping them lands the caller on the
      // default they would have got anyway. A drawing has no such default — the
      // fallback for "your method could not be read" is the LLM PLANNER, i.e.
      // silently swapping the human's topology for a model's, which is the one
      // thing `dev-driver.ts` refuses to do at every other layer. So a `graph`
      // or `graphId` that is present and unusable is a 400, never a shrug.
      //
      // `null` and a blank/whitespace `graphId` are the exception: they read as
      // "no drawing", which is what a client clearing its picker sends.
      let graph: DevGraph | undefined;
      if (body.graph !== undefined && body.graph !== null) {
        // The SAME parser `/api/graphs/compile` and the store use — the shape
        // gate has one implementation, and it is not this file's.
        const parsed =
          typeof body.graph === 'object' && !Array.isArray(body.graph)
            ? parseDevGraph(body.graph)
            : ({ ok: false, errors: ['the "graph" field is not a devgraph object'] } as const);
        if (!parsed.ok) {
          return sendJson(res, 400, {
            error: `invalid-schema: ${parsed.errors.join('; ')}`,
            reason: 'invalid-schema',
          });
        }
        graph = parsed.graph;
      }
      let graphId: string | undefined;
      if (body.graphId !== undefined && body.graphId !== null) {
        if (typeof body.graphId !== 'string') {
          return sendJson(res, 400, {
            error: `invalid-id: "graphId" must be the string id of a saved graph, got ${typeof body.graphId}`,
            reason: 'invalid-id',
          });
        }
        graphId = body.graphId.trim() || undefined;
      }
      try {
        const started = devManager.start({
          goal: String(body.goal ?? ''),
          backend,
          provider,
          modelId: String(body.modelId ?? ''),
          apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
          endpoint: typeof body.endpoint === 'string' ? body.endpoint : undefined,
          runDirectory: typeof body.runDirectory === 'string' ? body.runDirectory : undefined,
          approval: body.approval === 'each-epoch' ? 'each-epoch' : 'autonomous',
          maxEpochs: typeof body.maxEpochs === 'number' ? body.maxEpochs : undefined,
          maxFronts: typeof body.maxFronts === 'number' ? body.maxFronts : undefined,
          skipKnowledgeBootstrap: body.skipKnowledgeBootstrap === true,
          concurrency: typeof body.concurrency === 'number' ? body.concurrency : undefined,
          mode: typeof body.mode === 'string' ? (body.mode as 'auto' | 'manual' | 'greedy') : undefined,
          timeoutMinutes: typeof body.timeoutMinutes === 'number' ? body.timeoutMinutes : undefined,
          ...(Object.keys(models).length > 0 ? { models } : {}),
          ...(preset ? { modelsPreset: preset } : {}),
          ...(methodology ? { methodology } : {}),
          ...(resume ? { resume } : {}),
          // Additive on BOTH halves: a body naming no drawing leaves these
          // fields off the params object entirely, so the session it starts is
          // the planner session it was before this feature existed.
          ...(graph ? { graph } : {}),
          ...(graphId ? { graphId } : {}),
        });
        return sendJson(res, 200, started);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // A refused DRAWING carries its own reason code — the browser gets to
        // branch on `graph-not-found` vs `graph-invalid` vs `graph-conflict`
        // without parsing English. Everything else keeps the old grading.
        if (err instanceof DevStartRefusal) {
          return sendJson(res, 400, { error: msg, reason: err.reason });
        }
        return sendJson(res, /already running/i.test(msg) ? 409 : 400, { error: msg });
      }
    }
    if (method === 'GET' && path === '/api/dev/debate') {
      // THE SETTLED HALF of the debate chat. Both briefs are written inside the
      // debater's own worktree, so a UI watching the canonical path would see
      // each file appear ALREADY FINISHED — the live half therefore rides the
      // un-throttled `agent-stream` firehose the browser already receives, and
      // this route answers only what a merge has landed. Parsing happens here
      // because the client is bundler-free vanilla ESM and cannot import the
      // TypeScript parser; a hand-written JS twin would be a second set of
      // prose rules to keep in sync.
      // No path ever crosses the wire: `epoch` indexes a map huu itself filled
      // from the compiled pipeline.
      const raw = url.searchParams.get('epoch');
      const epoch = raw === null || raw.trim() === '' ? undefined : Number(raw);
      if (epoch !== undefined && !Number.isFinite(epoch)) {
        return sendJson(res, 400, { error: 'epoch must be a number' });
      }
      const read = devManager.debateTranscript(epoch);
      // `present: false` is the DEFAULT answer — `--debate` is off unless the
      // human turned it on — and it is a 200, not a 404: "this session has no
      // debate" is an answer, not a missing resource.
      return sendJson(res, 200, read ? { present: true, ...read } : { present: false });
    }
    if (method === 'POST' && path === '/api/dev/approve') {
      const body = await readJsonBodyOr400(req, res);
      if (!body) return;
      const approved = body.approved !== false;
      if (!devManager.approve(approved)) {
        return sendJson(res, 409, { error: 'no plan is awaiting approval' });
      }
      return sendJson(res, 200, { ok: true, approved });
    }
    if (method === 'POST' && path === '/api/dev/resume') {
      // Answer the resume gate: continue the previous session (same blackboard
      // namespace, epoch numbering continued) or start fresh. 409 when nothing
      // is waiting, so a stale click can never be mistaken for an answer.
      const body = await readJsonBodyOr400(req, res);
      if (!body) return;
      const accept = body.accept === true;
      if (!devManager.resumeSession(accept)) {
        return sendJson(res, 409, { error: 'no previous session is awaiting a resume decision' });
      }
      return sendJson(res, 200, { ok: true, accept });
    }
    if (method === 'POST' && path === '/api/dev/orphans') {
      // Answer the orphan-branch gate. `land` merges them oldest epoch first;
      // `ignore` just names them. Anything else is `ignore` — the safe side.
      const body = await readJsonBodyOr400(req, res);
      if (!body) return;
      const action = body.action === 'land' ? 'land' : 'ignore';
      if (!devManager.resolveOrphans(action)) {
        return sendJson(res, 409, { error: 'no orphan branches are awaiting a decision' });
      }
      return sendJson(res, 200, { ok: true, action });
    }
    if (method === 'POST' && path === '/api/dev/abort') {
      return sendJson(res, 200, { ok: devManager.abort() });
    }

    if (method === 'POST' && path === '/api/dev/transcribe') {
      // Dictation for the goal field. The browser captures audio, re-encodes it
      // as 16 kHz mono WAV (the transcriber requires this format)
      // and posts the base64 here; the key follows the same precedence a run's
      // does, so a browser-session key works without ever touching disk.
      const body = await readJsonBodyOr400(req, res);
      if (!body) return;
      const format = body.format ?? 'wav';
      if (!isTranscribeFormat(format)) {
        return sendJson(res, 400, { error: `unsupported audio format "${String(format)}"` });
      }
      const picked = pickRunKey(
        typeof body.apiKey === 'string' ? body.apiKey : undefined,
        manager.getWebKey('deepseek'),
        findSpec('deepseek'),
      );
      try {
        const result = await transcribeAudio({
          audioBase64: String(body.audio ?? ''),
          format,
          apiKey: picked.value,
          modelId: typeof body.modelId === 'string' ? body.modelId : process.env.HUU_TRANSCRIBE_MODEL,
        });
        return sendJson(res, 200, result);
      } catch (err) {
        const status = err instanceof TranscribeError ? (err.status ?? 502) : 500;
        return sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // --- Hand-drawn methods (`huu-devgraph-v1`) ---------------------------
    // ONE branch for the whole `/api/graphs` namespace: the grammar and every
    // status live in `graph-api.ts` as pure functions, so this layer only
    // recognizes the prefix and parses the body. See that module's header.
    if (isGraphApiPath(path)) {
      let body: Record<string, unknown> = {};
      if (method === 'POST' || method === 'PUT') {
        // A malformed body is the caller's mistake — a 400 with the reason,
        // never the catch-all 500 an uncaught throw would produce here.
        const parsed = await readJsonBodyOr400(req, res);
        if (!parsed) return;
        body = parsed;
      }
      const result = handleGraphRequest({
        cwd: opts.cwd,
        method,
        path,
        query: url.searchParams,
        body,
      });
      return sendJson(res, result.status, result.body);
    }

    if (method === 'GET' && path === '/events') {
      return openSse(req, res);
    }

    sendJson(res, 404, { error: 'not found' });
  }

  async function startRun(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = await readJsonBody(req);
    // `/simulation` runs: synthetic, no backend/key/pipeline resolution.
    if (body.simulate === true || body.simulate === 'true') {
      try {
        const modelIds = Array.isArray(body.modelIds)
          ? (body.modelIds as unknown[]).map((m) => String(m)).filter((m) => m.trim())
          : body.modelId
            ? [String(body.modelId)]
            : [];
        const snap = manager.startSimulation({
          runId: `sim-${Date.now().toString(36)}-${simSeq++}`,
          modelIds,
          fileCount: clampInt(body.fileCount, 12, 1, 200),
          concurrency: clampInt(body.concurrency, 6, 1, 64),
          pipelineName: body.pipelineName ? String(body.pipelineName) : undefined,
          presetName: body.presetName ? String(body.presetName) : undefined,
        });
        return sendJson(res, 200, { ok: true, run: serializeSnapshot(snap) });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return sendJson(res, /too many/i.test(message) ? 429 : 400, { error: message });
      }
    }
    // Provider (openrouter|azure) is the user-facing choice; it maps to the
    // dispatch backend. Falls back to a raw `backend` for older clients.
    const provider = parseProvider(String(body.provider ?? ''));
    const backend = provider
      ? providerToBackend(provider)
      : parseBackendKind(String(body.backend ?? 'jcode'));
    if (!backend) return sendJson(res, 400, { error: 'unknown backend' });
    const params: StartRunParams = {
      pipelineName: body.pipelineName ? String(body.pipelineName) : undefined,
      pipeline:
        opts.initialPipeline &&
        body.pipelineName === opts.initialPipeline.name
          ? opts.initialPipeline
          : undefined,
      backend,
      provider: provider ?? backendToProvider(backend),
      modelId: String(body.modelId ?? ''),
      // Optional override for the merge/integration conflict-resolver agent.
      // Empty → the resolver inherits the run model (Pipeline.integrationModelId).
      conflictResolverModelId: body.conflictResolverModelId
        ? String(body.conflictResolverModelId)
        : undefined,
      // Browser-only key: the client sends the in-memory key it validated
      // earlier. Used for this run only; never persisted. Absent → the
      // run manager falls back to the env/mount/disk resolver (CLI path).
      apiKey: body.apiKey ? String(body.apiKey) : undefined,
      concurrency:
        typeof body.concurrency === 'number' ? body.concurrency : undefined,
      mode: ['auto', 'manual', 'greedy'].includes(String(body.mode))
        ? (body.mode as StartRunParams['mode'])
        : undefined,
      endpoint: body.endpoint ? String(body.endpoint) : undefined,
      runDirectory: body.runDirectory ? String(body.runDirectory) : undefined,
      timeoutMinutes:
        typeof body.timeoutMinutes === 'number'
          ? body.timeoutMinutes
          : undefined,
      // NOTE: the RAM dial no longer piggybacks on run POSTs — it is a server
      // setting (`POST /api/settings`) applied to the shared scheduler LIVE.
      // Authoritative priority = the project's index in the client's queue list,
      // so the first project is served first regardless of POST arrival order.
      priority: typeof body.priority === 'number' ? body.priority : undefined,
    };
    try {
      const snap = manager.start(params);
      sendJson(res, 200, { ok: true, run: serializeSnapshot(snap) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 429 when too many concurrent runs; 400 for bad config. (No 409 — the
      // multi-run manager accepts concurrent runs.) Refusals also go to the
      // terminal: a run that never starts must not be silent anywhere.
      termLog('error', 'run', `refused: ${message}`);
      sendJson(res, /too many/i.test(message) ? 429 : 400, { error: message });
    }
  }

  function openSse(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 2000\n\n`);
    const client: SseClient = { res };
    sseClients.add(client);

    // Replay every tracked run's latest snapshot so a refresh / new tab
    // re-syncs all boards (the client keys by runId).
    const snaps = manager.getSnapshots();
    if (snaps.length === 0) writeSse(res, 'message', buildFrame(manager.getSnapshot()));
    else for (const snap of snaps) writeSse(res, 'message', buildFrame(snap));

    // Same replay contract for a live dev session, so a refresh mid-session
    // (including one parked at the approval gate) re-links instead of resetting.
    if (lastDevSnapshot) {
      writeSse(res, 'message', JSON.stringify({ type: 'dev', session: lastDevSnapshot }));
    }

    // Keep-alive ping as a REAL named event, not an SSE comment: comments are
    // invisible to the browser's EventSource API, so a comment-only heartbeat
    // gave the client no way to tell a quiet stream from a dead (zombie) one.
    // `event: ping` still keeps proxies from dropping the idle connection AND
    // feeds the client's staleness watchdog; old clients ignore unknown named
    // events, so this is backward compatible.
    const ping = setInterval(() => {
      writeSse(res, 'ping', '{}');
    }, opts.heartbeatMs ?? 25_000);

    req.on('close', () => {
      clearInterval(ping);
      sseClients.delete(client);
    });
  }

  // Folder-picker root: HUU_WORKSPACE (set by the wrapper to the host $HOME /
  // configured path, mounted into the container at the same absolute path).
  // Falls back to the server cwd when unset (dev/tests run without the
  // wrapper) — the pre-workspace default.
  function workspaceRoot(): string {
    const w = process.env.HUU_WORKSPACE?.trim();
    return w && existsSync(w) ? w : opts.cwd;
  }

  /**
   * `preset → providers that can run it`, computed ONCE (the catalogs are files
   * on disk and `/api/bootstrap` is hit on every page load and every SSE
   * resync). Lazy rather than eager so constructing a server still touches no
   * filesystem.
   */
  let presetProviders: Record<string, string[]> | undefined;
  function devPresetProviders(): Record<string, string[]> {
    if (!presetProviders) presetProviders = devModelPresetProviders(devModelProviderIndex(opts.cwd));
    return presetProviders;
  }

  function bootstrapPayload(): Record<string, unknown> {
    return {
      name: 'huu',
      repo: repoName(opts.cwd),
      cwd: opts.cwd,
      lockedBackend: opts.lockedBackend ?? null,
      // The user-facing provider locked from the CLI (--provider/--backend),
      // derived from the locked backend. null = user chooses in the UI.
      lockedProvider: opts.lockedProvider
        ? opts.lockedProvider
        : opts.lockedBackend
        ? backendToProvider(opts.lockedBackend)
        : null,
      defaults: {
        autoScale: opts.defaultAutoScale,
        concurrency: opts.defaultConcurrency ?? null,
      },
      backends: listBackendsInfo(),
      providers: listProvidersInfo(),
      pipelines: listPipelinesInfo(opts.cwd),
      initialPipeline: opts.initialPipeline?.name ?? null,
      // Folder-picker root: HUU_WORKSPACE (default $HOME on the host, mounted
      // into the container by the wrapper). The client opens the picker here
      // and offers a "Home" shortcut back to it.
      workspace: workspaceRoot(),
      runs: manager.getSnapshots().map(serializeSnapshot),
      // Dev-mode per-role routing, served from the SAME constants the driver
      // and the compilers read, so the browser can render the presets and the
      // role slots without hardcoding a list that would drift the day a role
      // is added.
      devModelPresets: DEV_MODEL_PRESETS,
      devModelRoles: DEV_MODEL_ROLES,
      // …and WHICH PROVIDER can actually run each preset, from the very
      // `checkDevModelPolicy` that refuses the POST. /dev makes routing a
      // required decision — the form opens with a preset already selected — so
      // without this the client cheerfully assembles a body the border then
      // rejects with a 400 nobody could have seen coming. Served rather than
      // reimplemented in the browser: two copies of the rule is two answers.
      devModelPresetProviders: devPresetProviders(),
      // The methodology checkboxes, from the SAME table the POST parser reads
      // — the /dev form renders the toggles from data, never a hardcoded copy.
      devMethodologyOptions: DEV_METHODOLOGY_OPTIONS,
      // The /graph palette, PROJECTED from the single declaration surfaces
      // (`ACTION_BLOCKS`, `NODE_KINDS`, `GRAPH_SAMPLES`) exactly the way
      // `DEV_METHODOLOGY_OPTIONS` is projected from `DEV_METHODOLOGIES`, and
      // for the same reason: a client that kept its own copy would drift the
      // day a block ships. Only the browser-facing columns cross the wire —
      // the agent-facing `promptTemplate`/`judgeClause` and each sample's
      // `build()` stay server-side, one call away at GET /api/graphs/catalog,
      // so this payload (fetched on every page load AND every SSE resync)
      // does not carry kilobytes of prompt nobody has opened yet.
      graphBlocks: graphBlockOptions(),
      graphNodeKinds: graphNodeKindOptions(),
      graphSamples: graphSampleOptions(),
      // Server-persisted machine-global settings (source of truth for the ⚙
      // modal — localStorage is only a cache) + the budget the scheduler is
      // actually enforcing right now.
      settings: { ramPercent: manager.effectiveRamPercent() },
      budget: manager.budgetTelemetry(),
    };
  }

  // Abort any in-flight run when the server is torn down.
  server.on('close', () => {
    if (timer) clearTimeout(timer);
    clearInterval(budgetTimer);
    manager.abort();
    for (const client of sseClients) client.res.end();
    sseClients.clear();
  });

  return { server, manager };
}

// --- helpers ---------------------------------------------------------------

function serializeSnapshot(snap: RunSnapshot): Record<string, unknown> {
  return {
    phase: snap.phase,
    runId: snap.runId,
    pipelineName: snap.pipelineName,
    runDirectory: snap.runDirectory,
    backend: snap.backend,
    modelId: snap.modelId,
    startedAt: snap.startedAt,
    finishedAt: snap.finishedAt ?? null,
    errorReason: snap.errorReason ?? null,
    state: snap.state ? trimState(snap.state) : null,
  };
}

/** Bound per-agent log size in the broadcast frame; full set via /api/agent-logs. */
function trimState(state: OrchestratorState): OrchestratorState {
  return {
    ...state,
    agents: state.agents.map((a) =>
      a.logs.length > MAX_AGENT_LOG_LINES
        ? { ...a, logs: a.logs.slice(-MAX_AGENT_LOG_LINES) }
        : a,
    ),
  };
}

/**
 * Coerce an untrusted `modelsPreset` field to a known preset name.
 *
 * Reads the key set off {@link DEV_MODEL_PRESETS} rather than repeating the
 * literals, so adding a preset never leaves this parser behind. An unknown
 * name yields undefined — the request keeps working, it just routes nothing.
 */
function parseModelsPreset(raw: unknown): DevModelPreset | undefined {
  if (typeof raw !== 'string') return undefined;
  const name = raw.trim();
  return Object.prototype.hasOwnProperty.call(DEV_MODEL_PRESETS, name)
    ? (name as DevModelPreset)
    : undefined;
}

/**
 * Coerce an untrusted `methodology` field to a clean {@link DevMethodology}.
 *
 * Reads the key set off {@link DEV_METHODOLOGY_OPTIONS} rather than repeating
 * the literals — the same single-source trick as `parseModelsPreset`. A key
 * survives only when its value is literally `true`; anything else (truthy
 * strings, unknown keys, non-objects) is dropped rather than refused, and a
 * body that enables nothing yields UNDEFINED, never `{}` — that is what keeps
 * such a request compiling the exact pipeline it compiles today.
 */
function parseDevMethodology(raw: unknown): DevMethodology | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const out: DevMethodology = {};
  for (const { key } of DEV_METHODOLOGY_OPTIONS) {
    if (record[key] === true) out[key] = true;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Coerce an unknown body field to an integer within [lo, hi], else `dflt`. */
function clampInt(v: unknown, dflt: number, lo: number, hi: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function writeSse(res: ServerResponse, event: string, data: string): void {
  // `event:` line omitted for the default 'message' type the client listens on.
  if (event && event !== 'message') res.write(`event: ${event}\n`);
  res.write(`data: ${data}\n\n`);
}

/**
 * `readJsonBody`, but a body that cannot be read is answered as the CALLER's
 * mistake instead of the server's.
 *
 * `readJsonBody` throws on a malformed (or oversized) body, and an uncaught
 * throw inside `handleRequest` lands in the top-level `.catch` — which reports
 * 500. A 500 says "huu broke"; `{ not json` says the client sent garbage, and
 * the two must not be indistinguishable to anything reading the status: a
 * browser cannot retry-vs-fix on a 500, and neither can a log.
 *
 * `/api/graphs` already did this inline; this is the same rule, hoisted so the
 * routes that share it also share ONE implementation. Returns `null` AFTER
 * writing the 400 — the caller's contract is `if (!body) return;`, which is
 * unreachable for any body that parses, so no valid request changes shape.
 */
async function readJsonBodyOr400(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Record<string, unknown> | null> {
  try {
    return await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    // 1 MiB guard — pipeline payloads are tiny; anything bigger is abuse.
    if (size > 1_048_576) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    throw new Error('invalid JSON body');
  }
}

async function serveStatic(
  res: ServerResponse,
  root: string,
  relPath: string,
): Promise<void> {
  // Defend against path traversal: normalize and confine to root.
  const safeRel = normalize(relPath).replace(/^(\.\.[/\\])+/, '');
  const full = join(root, safeRel);
  if (!full.startsWith(root)) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  try {
    const info = await stat(full);
    if (!info.isFile()) throw new Error('not a file');
    const data = await readFile(full);
    res.writeHead(200, {
      'Content-Type': contentTypeFor(full),
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: `not found: ${relPath}` });
  }
}

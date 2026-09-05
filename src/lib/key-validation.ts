/**
 * Credential validation — "is this pasted key actually usable?", answered
 * BEFORE anything is persisted or spent.
 *
 * THE PRODUCT DECISION THIS FILE IMPLEMENTS, and the reason the verdict is a
 * four-way union instead of a boolean:
 *
 *   · HTTP 401/403 (and Brave's 422 `SUBSCRIPTION_TOKEN_INVALID`, which is the
 *     same statement in a different spelling) means the PROVIDER ITSELF
 *     rejected the credential. That is proof about the key → `invalid`, and
 *     the caller blocks and asks again.
 *   · Anything else — DNS failure, a dead VPN, a timeout, 429, 402, 5xx, an
 *     unparseable body — is NOT proof about the key. It is proof that we could
 *     not find out. That is `unverifiable`, and the caller WARNS and lets the
 *     user through. Locking someone out of their own project because their
 *     network flickered is a worse failure than admitting a key we could not
 *     check.
 *
 * The line between those two is the whole point. 429 in particular is the one
 * most often mis-filed: a rate limit is a budget that refills, and the key was
 * accepted well enough to be COUNTED — it is evidence the key works, if
 * anything, and never evidence that it does not.
 *
 * THREE HARD RULES, each enforced by a test:
 *
 *   1. Nothing here throws. Every failure — network, DNS, JSON, an aborted
 *      request, a probe that blew up — comes back as a verdict.
 *   2. The raw key never appears in a returned object. Reasons are scrubbed
 *      through {@link maskKey} on the way out, because a provider's own error
 *      text is not guaranteed to be free of the token it is complaining about.
 *   3. Every probe has a timeout. A slow provider must not be able to hang the
 *      first-run setup, so no probe can outlive {@link KEY_PROBE_TIMEOUT_MS}.
 *
 * COST: probes hit METADATA endpoints only, never inference. Validating a key
 * can never bill a model call. The Brave probe is deliberately malformed (it
 * omits the required `q`) precisely so it is rejected as a bad REQUEST after
 * the token has already been checked — that answer is free, where a real
 * search would spend a credit.
 */
import { checkOpenRouterReachable } from './openrouter.js';
import { detectForeignKeySpec, type ApiKeySpec } from './api-key-registry.js';
import { maskKey } from './api-key.js';
import { PROVIDERS, providerInfo, type LlmProvider } from './providers.js';
import { SURF_SEARCH_PROVIDER } from './surf-research.js';

/**
 * What we learned about a pasted key.
 *
 * `invalid` is the ONLY blocking verdict, and it carries the status so the UI
 * can say which rejection it was. `unverifiable` carries a short, already
 * scrubbed reason meant to be shown to the user verbatim.
 */
export type KeyVerdict =
  | { status: 'valid' }
  | { status: 'invalid'; httpStatus: number }
  /**
   * The value is ANOTHER provider's credential (its prefix belongs to a
   * different, more specific registry spec). Caught with zero network calls,
   * before anything is persisted: saving it here would file an `sk-or-…`
   * OpenRouter key under the name `deepseek` and ship it to api.deepseek.com.
   */
  | { status: 'wrong-key'; belongsTo: string; label: string }
  | { status: 'unverifiable'; reason: string };

/**
 * Ceiling for a single probe. Matches `checkOpenRouterReachable`'s own default
 * so every provider answers on the same clock. Long enough for a cold TLS
 * handshake over a VPN, short enough that a wedged endpoint cannot turn the
 * first-run prompt into a hang.
 */
export const KEY_PROBE_TIMEOUT_MS = 8_000;

export interface KeyProbeOptions {
  /** Override the per-probe timeout. Non-finite or <= 0 falls back to the default. */
  timeoutMs?: number;
}

/** A provider-specific probe. Takes a NON-EMPTY, trimmed key. Never throws. */
type ProviderProbe = (key: string, timeoutMs: number) => Promise<KeyVerdict>;

// ───────────────────────────── scrubbing ─────────────────────────────

/**
 * Replace every occurrence of the raw key with its masked form.
 *
 * Applied to any free text that leaves this module. Provider error bodies
 * quote the request back often enough that this is not theoretical, and a
 * validation error is exactly the message a user pastes into a bug report.
 */
function scrub(text: string, key: string): string {
  const secret = key.trim();
  if (!secret) return text;
  return text.split(secret).join(maskKey(secret));
}

/** Scrub the only arm that carries free text. The others hold huu's own words. */
function scrubVerdict(verdict: KeyVerdict, key: string): KeyVerdict {
  if (verdict.status !== 'unverifiable') return verdict;
  return { status: 'unverifiable', reason: scrub(verdict.reason, key) };
}

function normalizeTimeout(ms: number | undefined): number {
  return Number.isFinite(ms) && (ms as number) > 0 ? (ms as number) : KEY_PROBE_TIMEOUT_MS;
}

// ─────────────────────────── the HTTP probe ───────────────────────────

interface ProbeRequest {
  url: string;
  headers: Record<string, string>;
  /** The key being probed — used ONLY to scrub it back out of failure text. */
  key: string;
  timeoutMs: number;
  /** Parse the JSON body and hand it to `classify` (Brave discriminates on it). */
  readBody?: boolean;
  classify: (status: number, body: unknown) => KeyVerdict;
}

/**
 * One `fetch` with an `AbortController` timeout, classified by the caller.
 * Total: every throw — DNS, TLS, abort, a classifier that blew up — becomes an
 * `unverifiable` verdict.
 */
async function httpProbe(req: ProbeRequest): Promise<KeyVerdict> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);
  try {
    const response = await fetch(req.url, {
      headers: req.headers,
      signal: controller.signal,
    });
    let body: unknown;
    if (req.readBody) {
      // A body we cannot parse is not evidence about the key: fall through to
      // the status-only branch of the classifier rather than failing.
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }
    }
    return req.classify(response.status, body);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    // `AbortError` is our OWN timeout firing, not the provider's answer. Name
    // it as a timeout so the warning tells the user something actionable.
    const timedOut = controller.signal.aborted || /abort/i.test(raw);
    return {
      status: 'unverifiable',
      reason: timedOut ? `timed out after ${req.timeoutMs}ms` : raw,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ───────────────────────────── OpenRouter ─────────────────────────────

/**
 * OpenRouter: reuse {@link checkOpenRouterReachable}.
 *
 * It already returns EXACTLY the three-way split this module is built around
 * (`ok` / `unauthorized` + status / `unreachable` + reason), does `GET
 * /auth/key` — a metadata endpoint, no tokens billed — and carries its own
 * `AbortController`. It had been imported by four orchestrator modules and
 * called by none; this is its first real call site.
 *
 * Note what its `unreachable` arm already covers for us: any non-2xx that is
 * not 401/403 comes back as `HTTP <status>`, so 429 and 5xx land on
 * `unverifiable` without a special case here.
 *
 * WHERE IT POINTS: `openrouter.ts` now builds its base URL from
 * `providerInfo('openrouter').defaultBaseUrl`, so this probe follows the same
 * endpoint the run will spend the key against — the same rule
 * {@link probeDeepSeek} follows. It used to hold a second literal copy of the
 * host, which is a probe that keeps answering about the OLD endpoint after the
 * provider table moves.
 */
async function probeOpenRouter(key: string, timeoutMs: number): Promise<KeyVerdict> {
  const result = await checkOpenRouterReachable(key, timeoutMs);
  if (result.kind === 'ok') return { status: 'valid' };
  if (result.kind === 'unauthorized') {
    return { status: 'invalid', httpStatus: result.status };
  }
  return { status: 'unverifiable', reason: result.reason };
}

// ────────────────────────────── DeepSeek ──────────────────────────────

/**
 * DeepSeek: authenticated `GET <baseUrl>/models`.
 *
 * This is the endpoint the repo's own troubleshooting guide uses as THE
 * connectivity/credential check (`docs/jcode-setup-guide.md` §5.3 and §7.5,
 * `curl -H "Authorization: Bearer $DEEPSEEK_API_KEY" …/v1/models`) — it is a
 * catalog listing, so it costs nothing and cannot trigger inference.
 *
 * Do not confuse it with the PUBLIC catalog OpenRouter serves: DeepSeek
 * publishes no unauthenticated model list, which is why huu's picker is static.
 * That is a fact about the CATALOG, not about this probe, which is
 * authenticated by construction.
 *
 * The base URL comes from the provider table so the probe follows the endpoint
 * the run will actually spend the key against, instead of a second hard-coded
 * copy that can drift. Conservative by construction: only 401/403 blocks, so
 * if this path ever moves, a 404 degrades to `unverifiable` — a warning — and
 * never to a false accusation against a good key.
 */
async function probeDeepSeek(key: string, timeoutMs: number): Promise<KeyVerdict> {
  const base = providerInfo('deepseek').defaultBaseUrl.replace(/\/+$/, '');
  return httpProbe({
    url: `${base}/models`,
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    key,
    timeoutMs,
    classify: (status) => {
      if (status >= 200 && status < 300) return { status: 'valid' };
      if (status === 401 || status === 403) {
        return { status: 'invalid', httpStatus: status };
      }
      return { status: 'unverifiable', reason: `HTTP ${status}` };
    },
  });
}

// ─────────────────────────────── Brave ───────────────────────────────

/**
 * Brave's search endpoint. Auth is `X-Subscription-Token`, NOT `Bearer`.
 *
 * Taken from the installed surf CLI's own Brave adapter
 * (`surf-agent-skill/src/lib/providers/brave.mjs`), which documents these
 * facts as verified against the live API — not from guesswork and not from the
 * web.
 */
const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';

/**
 * Brave error codes whose meaning is documented and exact. Anything matched
 * here wins before pattern-matching, because a code can contain a misleading
 * word: `SUBSCRIPTION_QUOTA_EXCEEDED` carries "SUBSCRIPTION" but is a refilling
 * budget, not a dead key.
 */
const BRAVE_EXACT: ReadonlyMap<string, 'transient' | 'plan' | 'config' | 'auth'> = new Map([
  ['SUBSCRIPTION_TOKEN_INVALID', 'auth'],
  ['VALIDATION', 'config'],
  ['OPTION_NOT_IN_PLAN', 'plan'],
  ['RATE_LIMITED', 'transient'],
  ['SUBSCRIPTION_QUOTA_EXCEEDED', 'transient'],
  ['QUOTA_EXCEEDED', 'transient'],
]);

/**
 * The only statuses on which Brave rejecting a token is plausible. Brave
 * answers an invalid token with **422** — the same status as a bad parameter —
 * so status alone can never decide; 401/403 are proxy spellings of the same
 * thing.
 */
const BRAVE_AUTH_STATUSES: ReadonlySet<number> = new Set([401, 403, 422]);

/**
 * The mirror of {@link BRAVE_AUTH_STATUSES}, for the OTHER direction.
 *
 * A plan gate or a parameter complaint proves the token was ACCEPTED — but
 * only when Brave's own application layer is what answered. A 5xx carrying
 * `VALIDATION` is a server having a bad day, a proxy, or an error page whose
 * body we happened to parse; it proves nothing about the credential, and
 * `valid` is a claim, not a shrug.
 *
 * Without this, `classifyBraveResponse(500, { error: { code: 'VALIDATION' } })`
 * answered `valid` — the failure was FALSE-VALID only (never false-invalid), so
 * it could not lock anyone out, but it let the setup flow report "checked and
 * fine" about a check that never happened. Degrading to `unverifiable` costs a
 * warning and keeps the verdict honest; it can never turn into a block.
 */
function braveAnswerProvesAcceptance(status: number): boolean {
  return status >= 200 && status < 500;
}

const BRAVE_TRANSIENT_CODE =
  /QUOTA|RATE_?LIMIT|LIMIT_?EXCEED|EXCEEDED|THROTTL|TOO_?MANY|OVER_?CAPACITY|BUSY|UNAVAILABLE/i;
const BRAVE_PLAN_CODE = /PLAN|UPGRADE|NOT_INCLUDED|ENTITLE/i;
const BRAVE_CONFIG_CODE =
  /VALIDATION|INVALID_(PARAM|QUERY|ARG|VALUE|REQUEST)|MISSING|BAD_?REQUEST|UNSUPPORTED|MALFORMED/i;
const BRAVE_AUTH_CODE = /TOKEN|SUBSCRIPTION|API_?KEY|UNAUTHOR|FORBIDDEN|CREDENTIAL/i;

/** Pull `error.code` out of a Brave body without trusting its shape. */
function braveErrorCode(body: unknown): string {
  if (typeof body !== 'object' || body === null) return '';
  const err = (body as { error?: unknown }).error;
  if (typeof err !== 'object' || err === null) return '';
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code.trim().toUpperCase() : '';
}

/**
 * Turn a Brave response into a verdict. Pure, exported for its own tests.
 *
 * THE KEY INSIGHT, and why the probe is deliberately malformed: Brave checks
 * the subscription token BEFORE it validates parameters. A request with no `q`
 * therefore answers `422 VALIDATION` — "your request is bad" — which can only
 * be reached by a token Brave already accepted. That is a free proof of
 * validity: no search runs, no credit is spent. A bad token short-circuits to
 * `SUBSCRIPTION_TOKEN_INVALID` first and never reaches parameter checking.
 * (Same mechanism the installed surf CLI's `validate()` reports as
 * `free: true`.)
 *
 * The ORDER below is load-bearing, and mirrors that adapter's, which learned it
 * the hard way — status-first classification burned every good key in a ring
 * the first time someone passed a bad parameter:
 *
 *   1. exact codes            — no guessing on the documented four
 *   2. HTTP 429               — transient by definition, whatever the body says
 *   3. transient patterns     — QUOTA / LIMIT / EXCEEDED …
 *   4. plan patterns          — the PLAN lacks a feature; the key is fine
 *   5. config patterns        — the REQUEST was bad; the key got past auth
 *   6. auth patterns, and ONLY on a status where auth is plausible
 *   7. status-only fallbacks
 *
 * Auth comes last on purpose: `invalid` is the verdict that blocks a user, so
 * it may only be reached once every recoverable explanation is excluded.
 *
 * BOTH directions are status-guarded, and they are guarded SEPARATELY:
 * {@link BRAVE_AUTH_STATUSES} bounds where a rejection is believable, and
 * {@link braveAnswerProvesAcceptance} bounds where an ACCEPTANCE is believable.
 * Steps 4 and 5 go through the latter, so a 5xx quoting a `VALIDATION` code
 * comes back `unverifiable` instead of claiming a check that did not happen.
 */
export function classifyBraveResponse(status: number, body: unknown): KeyVerdict {
  const code = braveErrorCode(body);
  const rateLimited = (): KeyVerdict => ({
    status: 'unverifiable',
    reason: code
      ? `Brave is rate-limiting or out of quota (HTTP ${status}, ${code}) — not proof of a bad key`
      : `Brave is rate-limiting or out of quota (HTTP ${status}) — not proof of a bad key`,
  });
  /**
   * "Brave answered from behind the auth check" — `valid`, but only where such
   * an answer is plausible. Off a plausible status it degrades to a warning,
   * never to an accusation.
   */
  const accepted = (): KeyVerdict =>
    braveAnswerProvesAcceptance(status)
      ? { status: 'valid' }
      : {
          status: 'unverifiable',
          reason: code ? `HTTP ${status} (${code})` : `HTTP ${status}`,
        };

  // 1. The documented codes, matched exactly.
  switch (BRAVE_EXACT.get(code)) {
    case 'transient':
      return rateLimited();
    // A plan gate and a parameter complaint BOTH prove the token was accepted:
    // neither answer is reachable before authentication.
    case 'plan':
    case 'config':
      return accepted();
    case 'auth':
      if (BRAVE_AUTH_STATUSES.has(status)) return { status: 'invalid', httpStatus: status };
      break;
    default:
      break;
  }

  // 2. A 429 is a budget that refills. It is NEVER proof of a dead key.
  if (status === 429) return rateLimited();

  // 3-5. Transient, then plan, then caller — all before anything can be auth.
  if (code && BRAVE_TRANSIENT_CODE.test(code)) return rateLimited();
  if (code && BRAVE_PLAN_CODE.test(code)) return accepted();
  if (code && BRAVE_CONFIG_CODE.test(code)) return accepted();

  // 6. Auth last, and only where a rejected token is actually plausible.
  if (code && BRAVE_AUTH_CODE.test(code) && BRAVE_AUTH_STATUSES.has(status)) {
    return { status: 'invalid', httpStatus: status };
  }

  // 7. Status-only fallbacks.
  if (status === 401 || status === 403) return { status: 'invalid', httpStatus: status };
  // Should not happen for a `q`-less probe, but a 2xx would mean Brave answered
  // us, which can only happen to an accepted token.
  if (status >= 200 && status < 300) return { status: 'valid' };
  // 402 (billing), 5xx, and any 4xx we could not attribute: the account or the
  // service is the problem, or we simply do not know. Never the key.
  return {
    status: 'unverifiable',
    reason: code ? `HTTP ${status} (${code})` : `HTTP ${status}`,
  };
}

/**
 * Brave: a deliberately incomplete search request (no `q`), so the token is
 * checked and the request is then refused for free.
 *
 * WHY NOT `surf-research-skill gate`, which is free and answers exit 0/78: the
 * gate reads `~/.config/surf/keys.json` and reports on whatever key is ALREADY
 * there. It cannot see a value the user is still typing, so using it here would
 * validate a different key than the one on screen — a validation that lies,
 * which is worse than none. It also requires the surf binary to exist, which on
 * the host it need not.
 */
async function probeBrave(key: string, timeoutMs: number): Promise<KeyVerdict> {
  return httpProbe({
    url: `${BRAVE_SEARCH_URL}?count=1`,
    headers: { 'X-Subscription-Token': key, Accept: 'application/json' },
    key,
    timeoutMs,
    readBody: true,
    classify: classifyBraveResponse,
  });
}

// ─────────────────────────────── dispatch ───────────────────────────────

/**
 * Probe per LLM provider. `Record<LlmProvider, …>` on purpose: adding a
 * provider is then a COMPILE error here, exactly like `JCODE_PROFILES`, so a
 * new credential cannot silently inherit "no validator".
 *
 * `null` is a legitimate, explicit answer — "this provider exposes no cheap
 * probe" — and produces `unverifiable`. It is not the same thing as forgetting.
 */
const PROVIDER_PROBES: Record<LlmProvider, ProviderProbe | null> = {
  deepseek: probeDeepSeek,
  openrouter: probeOpenRouter,
};

/**
 * Non-LLM specs that still have a probe, keyed by registry spec name.
 * `brave` is the search credential surf spends; the others
 * (`artificialAnalysis`, `tavily`, `parallel`) have no probe and stay
 * `unverifiable`.
 */
const SPEC_PROBES: Readonly<Record<string, ProviderProbe>> = {
  [SURF_SEARCH_PROVIDER]: probeBrave,
};

/**
 * Which probe answers for a spec.
 *
 * The LLM half is looked up through the PROVIDER table rather than by spec
 * name, because the provider is the axis that owns the credential — the same
 * reason `apiKeySpecNameForProvider` exists. A provider added to `PROVIDERS`
 * therefore arrives here already wired.
 */
export function probeForSpec(spec: ApiKeySpec): ProviderProbe | null {
  const provider = PROVIDERS.find((p) => p.apiKeySpecName === spec.name);
  if (provider) return PROVIDER_PROBES[provider.id];
  return SPEC_PROBES[spec.name] ?? null;
}

/** True when this spec can be actively checked against its provider. */
export function hasKeyProbe(spec: ApiKeySpec): boolean {
  return probeForSpec(spec) !== null;
}

/**
 * Validate a pasted key. Persists nothing, spends nothing, never throws.
 *
 * Order is deliberate and each step is cheaper than the next:
 *   1. empty → `unverifiable`, no network.
 *   2. {@link detectForeignKeySpec} → `wrong-key`, no network. This stays FIRST
 *      among the real checks: it is the only one that catches the DeepSeek /
 *      OpenRouter mix-up (`sk-or-…` also satisfies `sk-`), it is free, and
 *      probing a key against the wrong provider would send the credential to a
 *      host that must never see it.
 *   3. the provider's own probe → `valid` / `invalid` / `unverifiable`.
 *
 * HOW FAR STEP 2 ACTUALLY REACHES — stated precisely, because "it stops us
 * probing a key against the wrong provider" is only true where the guard can
 * fire at all. `detectForeignKeySpec` judges a target only when that target
 * DECLARES a `validatePrefix` (its rule 1: a spec with no known format has no
 * basis to accuse anyone, and `wrong-key` blocks with no override). So the
 * protection is exactly as wide as the set of prefix-declaring specs.
 *
 * That is enough here, but only because of an invariant this module pins with
 * a test: EVERY spec that owns a probe declares a prefix — `deepseek` (`sk-`),
 * `openrouter` (`sk-or-`) and `brave` (`BSA`). Prefix-less specs
 * (`artificialAnalysis`, `parallel`) reach step 3, find no probe, and return
 * `unverifiable` without opening a socket. No spec can therefore put a
 * credential on the wire while being unable to notice it belongs elsewhere —
 * and the day someone gives a prefix-less spec a probe, that test fails.
 */
export async function validateKeyForSpec(
  spec: ApiKeySpec,
  value: string,
  opts: KeyProbeOptions = {},
): Promise<KeyVerdict> {
  const key = value.trim();
  if (!key) return { status: 'unverifiable', reason: 'empty value' };

  const foreign = detectForeignKeySpec(spec, key);
  if (foreign) {
    return { status: 'wrong-key', belongsTo: foreign.name, label: foreign.label };
  }

  const probe = probeForSpec(spec);
  if (!probe) return { status: 'unverifiable', reason: 'no validator for this key' };

  try {
    return scrubVerdict(await probe(key, normalizeTimeout(opts.timeoutMs)), key);
  } catch (err) {
    // Defence in depth. The probes above already convert their own failures,
    // so reaching this is a bug — but a bug must still not be able to take the
    // setup flow down, and must still not leak the key.
    const raw = err instanceof Error ? err.message : String(err);
    return { status: 'unverifiable', reason: scrub(raw, key) };
  }
}

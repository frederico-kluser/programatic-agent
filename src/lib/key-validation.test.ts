import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_KEY_REGISTRY, findSpec } from './api-key-registry.js';
import {
  classifyBraveResponse,
  hasKeyProbe,
  validateKeyForSpec,
  KEY_PROBE_TIMEOUT_MS,
} from './key-validation.js';
import { resetCapabilitiesCache } from './openrouter.js';
import { providerInfo, type LlmProvider } from './providers.js';

// Every test in this file stubs `fetch`. NOTHING here may touch the network:
// the suite runs on a bare CI runner with no keys and, on a developer laptop,
// a real probe would spend the developer's own quota.
afterEach(() => {
  vi.unstubAllGlobals();
  resetCapabilitiesCache();
});

const deepseek = () => findSpec('deepseek')!;
const openrouter = () => findSpec('openrouter')!;
const brave = () => findSpec('brave')!;

/** A minimal Response stand-in: the probes read `ok`, `status` and `json()`. */
function response(status: number, body: unknown = {}): unknown {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

/** Stub `fetch` with a fixed response and hand back the spy. */
function stubFetch(status: number, body: unknown = {}): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => response(status, body));
  vi.stubGlobal('fetch', mock);
  return mock;
}

/** Stub `fetch` with a rejection (DNS, TLS, socket…). */
function stubFetchRejecting(err: unknown): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => {
    throw err;
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

/** What a real `fetch` rejects with when its signal fires. */
function abortError(): Error {
  return Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
}

/**
 * Stub `fetch` with a request that only ever settles when its `AbortSignal`
 * fires — i.e. exactly how a hung endpoint behaves. The probe's own
 * `AbortController` is what ends it, so the test finishes as fast as the
 * timeout we pass in (single-digit ms) and NEVER waits the real 8 s.
 */
function stubFetchHanging(): ReturnType<typeof vi.fn> {
  const mock = vi.fn(
    (_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return; // never settles — the test would time out, loudly
        if (signal.aborted) {
          reject(abortError());
          return;
        }
        signal.addEventListener('abort', () => {
          reject(abortError());
        });
      }),
  );
  vi.stubGlobal('fetch', mock);
  return mock;
}

// ── the cheap checks, before any socket is opened ──────────────────────

describe('validateKeyForSpec — the checks that cost nothing', () => {
  it('answers an empty value without touching the network', async () => {
    const fetchMock = stubFetch(200);
    expect(await validateKeyForSpec(deepseek(), '   ')).toEqual({
      status: 'unverifiable',
      reason: 'empty value',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a foreign key BEFORE probing — an sk-or- value in the DeepSeek slot', async () => {
    // MUTATION KILLED: probing first and cross-checking after. Probing an
    // `sk-or-…` value against api.deepseek.com would ship the OpenRouter
    // secret to a host that must never see it — the exact incident
    // `detectForeignKeySpec` exists to prevent — and it would come back 401,
    // reporting a perfectly good key as invalid.
    const fetchMock = stubFetch(200);
    expect(await validateKeyForSpec(deepseek(), 'sk-or-v1-abcdef')).toEqual({
      status: 'wrong-key',
      belongsTo: 'openrouter',
      label: 'OpenRouter',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a plain sk- value in the OpenRouter slot, also without a probe', async () => {
    const fetchMock = stubFetch(200);
    expect(await validateKeyForSpec(openrouter(), 'sk-abcdef')).toMatchObject({
      status: 'wrong-key',
      belongsTo: 'deepseek',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says so, without a probe, for a spec that has no validator', async () => {
    const fetchMock = stubFetch(200);
    for (const name of ['artificialAnalysis', 'tavily', 'parallel']) {
      const spec = findSpec(name)!;
      expect(hasKeyProbe(spec), name).toBe(false);
      expect(await validateKeyForSpec(spec, `${spec.validatePrefix ?? ''}whatever`), name).toEqual({
        status: 'unverifiable',
        reason: 'no validator for this key',
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does have a probe for the three keys the first-run setup asks for', () => {
    // Guards against a dispatch table that silently stops covering a spec:
    // `unverifiable` is the ACCEPT-WITH-WARNING branch, so losing a probe here
    // is invisible at runtime — every key would simply start "passing".
    expect(hasKeyProbe(deepseek())).toBe(true);
    expect(hasKeyProbe(openrouter())).toBe(true);
    expect(hasKeyProbe(brave())).toBe(true);
  });

  it('refuses an OpenRouter key offered as the BRAVE key, before it can be sent', async () => {
    // THE LEAK THIS CLOSES. `brave` is the one non-LLM spec that owns a probe,
    // so a value pasted here does not merely get stored — it is put on the
    // wire to api.search.brave.com in an `X-Subscription-Token` header.
    //
    // `detectForeignKeySpec` only judges a target that DECLARES a format, and
    // `brave` used to declare none: the cross-spec guard was structurally a
    // no-op here, and an `sk-or-…` OpenRouter secret walked straight through
    // it into the request. The spec now declares `BSA`, which is what gives
    // the guard something to judge against.
    const fetchMock = stubFetch(200);
    expect(await validateKeyForSpec(brave(), 'sk-or-v1-abcdef')).toEqual({
      status: 'wrong-key',
      belongsTo: 'openrouter',
      label: 'OpenRouter',
    });
    // The point is not the verdict, it is that nothing left the machine.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('every spec that can put a key on the wire declares a prefix', async () => {
    // THE INVARIANT that makes the cross-spec guard's limitation harmless.
    //
    // `detectForeignKeySpec` is a no-op for a spec with no `validatePrefix`
    // (deliberately: with no known format, accusing an `sk-…` value would
    // hard-block a real key, and `wrong-key` has no in-product override). That
    // limitation is only acceptable while such specs cannot TRANSMIT anything.
    //
    // So: probe ⟹ prefix. Give `artificialAnalysis` or `parallel` a probe
    // without giving it a format and this test fails — which is the moment the
    // comment on `validateKeyForSpec` would otherwise start lying again.
    for (const spec of API_KEY_REGISTRY) {
      if (!hasKeyProbe(spec)) continue;
      expect(spec.validatePrefix, `${spec.name} has a probe but declares no prefix`).toBeTruthy();
    }
    // Not vacuous: the probe-carrying set is non-empty and is these three.
    expect(API_KEY_REGISTRY.filter(hasKeyProbe).map((s) => s.name)).toEqual([
      'deepseek',
      'openrouter',
      'brave',
    ]);
    // The other half of the invariant, checked rather than asserted in prose:
    // the prefix-less specs open no socket, they answer "no validator".
    const fetchMock = stubFetch(200);
    for (const spec of API_KEY_REGISTRY.filter((s) => !s.validatePrefix)) {
      expect(hasKeyProbe(spec), spec.name).toBe(false);
      expect(await validateKeyForSpec(spec, 'sk-or-v1-foreign'), spec.name).toEqual({
        status: 'unverifiable',
        reason: 'no validator for this key',
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── the distinction the whole feature exists for ───────────────────────

describe.each([
  { name: 'DeepSeek', spec: deepseek, key: 'sk-deepseek-value' },
  { name: 'OpenRouter', spec: openrouter, key: 'sk-or-v1-value' },
])('$name — 401/403 is proof about the key, everything else is not', ({ spec, key }) => {
  it('200 → valid', async () => {
    stubFetch(200, { data: [] });
    expect(await validateKeyForSpec(spec(), key)).toEqual({ status: 'valid' });
  });

  it('429 → unverifiable, NEVER invalid — a rate limit is a budget that refills', async () => {
    // THE case most implementations get wrong. 429 means the provider counted
    // the request, which is the opposite of rejecting the credential. Filing
    // it as `invalid` would lock a user out of their own project during a
    // traffic spike.
    stubFetch(429, { error: { code: 'RATE_LIMITED' } });
    const r = await validateKeyForSpec(spec(), key);
    expect(r.status).toBe('unverifiable');
    expect(r.status === 'invalid').toBe(false);
  });

  it('500 → unverifiable — the provider is broken, not the key', async () => {
    stubFetch(500);
    expect(await validateKeyForSpec(spec(), key)).toMatchObject({ status: 'unverifiable' });
  });

  it('a DNS/network failure → unverifiable', async () => {
    stubFetchRejecting(
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }),
    );
    const r = await validateKeyForSpec(spec(), key);
    expect(r).toMatchObject({ status: 'unverifiable' });
    expect(r.status === 'unverifiable' && r.reason).toBeTruthy();
  });

  it('a timeout → unverifiable, and returns on OUR clock, not the endpoint\'s', async () => {
    // The endpoint never answers; only the probe's own AbortController ends
    // this. `timeoutMs: 20` proves the deadline is honored AND keeps the test
    // instant — an assertion that waited the real 8 s default would be a
    // 8-second test, which is how "the timeout works" stops being checked.
    stubFetchHanging();
    const started = Date.now();
    const r = await validateKeyForSpec(spec(), key, { timeoutMs: 20 });
    const elapsed = Date.now() - started;
    expect(r).toMatchObject({ status: 'unverifiable' });
    expect(r.status === 'invalid').toBe(false);
    expect(elapsed).toBeLessThan(KEY_PROBE_TIMEOUT_MS);
  }, 5_000);
});

// The 401/403 cases above need a per-status stub; `it.each` cannot stub before
// the parameter is known, so the stub is installed inside the test body.
describe.each([
  { name: 'DeepSeek', spec: deepseek, key: 'sk-deepseek-value' },
  { name: 'OpenRouter', spec: openrouter, key: 'sk-or-v1-value' },
])('$name — the rejection statuses, explicitly', ({ spec, key }) => {
  it.each([401, 403])('HTTP %i comes back invalid with its status', async (status) => {
    stubFetch(status, { error: { message: 'no' } });
    expect(await validateKeyForSpec(spec(), key)).toEqual({
      status: 'invalid',
      httpStatus: status,
    });
  });
});

describe('DeepSeek probe — where it points and what it sends', () => {
  it('probes api.deepseek.com/v1/models with a Bearer header, and no body', async () => {
    // WHAT THIS PINS, exactly: the LITERAL endpoint in use today. Since the
    // probe derives its URL from `providerInfo('deepseek').defaultBaseUrl`,
    // moving that value in `providers.ts` moves this URL and this assertion
    // dies — so the pair is a DRIFT alarm on the provider table.
    //
    // WHAT IT DOES NOT PIN, and the reason the separate suite below exists:
    // hard-coding a second copy of this host inside `key-validation.ts` leaves
    // this test green, because the literal is what it compares against. Only
    // MOVING the table (see 'the probe endpoints follow the provider table')
    // can tell a derived URL from a copied one.
    const fetchMock = stubFetch(200, { data: [] });
    await validateKeyForSpec(deepseek(), 'sk-deepseek-value');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.com/v1/models');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer sk-deepseek-value',
    );
    // A metadata GET: no method override, no request body — validating a key
    // may never trigger (or be billed as) an inference call.
    expect(init.method).toBeUndefined();
    expect((init as { body?: unknown }).body).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('a 404 degrades to unverifiable — a moved endpoint must not accuse a good key', async () => {
    stubFetch(404);
    expect(await validateKeyForSpec(deepseek(), 'sk-deepseek-value')).toEqual({
      status: 'unverifiable',
      reason: 'HTTP 404',
    });
  });
});

describe('OpenRouter probe — reuses the existing reachability check', () => {
  it('hits GET /auth/key on the table\'s host, with the Bearer header', async () => {
    // The point of reuse: `checkOpenRouterReachable` already splits
    // unauthorized from unreachable and already carries a timeout. A second,
    // parallel probe would be a second thing to keep correct.
    //
    // The literal is the same DRIFT alarm the DeepSeek probe carries: since
    // `openrouter.ts` builds its base from
    // `providerInfo('openrouter').defaultBaseUrl`, moving that value in
    // `providers.ts` moves this URL and this assertion dies. Before that
    // change the file held its own copy of the host, so the table could move
    // and every OpenRouter test stayed green while the probe kept talking to
    // the old endpoint.
    const fetchMock = stubFetch(200, {});
    await validateKeyForSpec(openrouter(), 'sk-or-v1-value');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/auth/key');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer sk-or-v1-value',
    );
  });
});

/**
 * The BINDING, not the literal.
 *
 * A test that compares the probe URL against a hard-coded string cannot tell a
 * DERIVED endpoint from a second copy of it: both spell the same host today.
 * These tests move the provider table underneath the module and re-import it,
 * so only a URL genuinely read from `ProviderInfo.defaultBaseUrl` follows.
 * Replace either derivation with a literal and both die.
 */
describe('the probe endpoints follow the provider table', () => {
  /** Re-import `key-validation` with ONE provider's base URL moved. */
  async function withMovedBaseUrl(
    provider: LlmProvider,
    baseUrl: string,
    run: (mod: typeof import('./key-validation.js')) => Promise<void>,
  ): Promise<void> {
    vi.resetModules();
    vi.doMock('./providers.js', async () => {
      const actual = await vi.importActual<typeof import('./providers.js')>('./providers.js');
      return {
        ...actual,
        providerInfo: (p: LlmProvider) =>
          p === provider
            ? { ...actual.providerInfo(p), defaultBaseUrl: baseUrl }
            : actual.providerInfo(p),
      };
    });
    try {
      await run(await import('./key-validation.js'));
    } finally {
      vi.doUnmock('./providers.js');
      vi.resetModules();
    }
  }

  it('DeepSeek probes wherever the table says DeepSeek lives', async () => {
    await withMovedBaseUrl('deepseek', 'https://ds.moved.invalid/v9', async (mod) => {
      const fetchMock = stubFetch(200, { data: [] });
      await mod.validateKeyForSpec(deepseek(), 'sk-deepseek-value');
      expect(fetchMock.mock.calls[0]?.[0]).toBe('https://ds.moved.invalid/v9/models');
    });
  });

  it('OpenRouter probes wherever the table says OpenRouter lives', async () => {
    // The one that was NOT true before this fix: `openrouter.ts` held its own
    // `OPENROUTER_API_BASE` literal, so the probe stayed on openrouter.ai no
    // matter what the provider table said — a silent second source of truth
    // for the host huu spends this credential against.
    await withMovedBaseUrl('openrouter', 'https://or.moved.invalid/api/v9', async (mod) => {
      const fetchMock = stubFetch(200, {});
      await mod.validateKeyForSpec(openrouter(), 'sk-or-v1-value');
      expect(fetchMock.mock.calls[0]?.[0]).toBe('https://or.moved.invalid/api/v9/auth/key');
    });
  });

  it('and a trailing slash in the table cannot produce a double slash', async () => {
    await withMovedBaseUrl('deepseek', 'https://ds.moved.invalid/v9///', async (mod) => {
      const fetchMock = stubFetch(200, { data: [] });
      await mod.validateKeyForSpec(deepseek(), 'sk-deepseek-value');
      expect(fetchMock.mock.calls[0]?.[0]).toBe('https://ds.moved.invalid/v9/models');
    });
  });
});

// ── Brave ─────────────────────────────────────────────────────────────

describe('Brave probe — the free, credit-free proof', () => {
  it('asks api.search.brave.com with X-Subscription-Token and NO q', async () => {
    // The missing `q` is the whole design: Brave checks the token first, so a
    // parameter complaint can only be reached by an accepted token. Sending a
    // real query instead would spend a search credit on every validation.
    const fetchMock = stubFetch(422, { error: { code: 'VALIDATION' } });
    await validateKeyForSpec(brave(), 'BSA-brave-value');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('https://api.search.brave.com/res/v1/web/search');
    expect(url).not.toContain('q=');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Subscription-Token']).toBe('BSA-brave-value');
    // NOT a Bearer token — Brave rejects that spelling.
    expect(headers.Authorization).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('422 VALIDATION → valid: the request was refused, the token was not', async () => {
    stubFetch(422, { error: { code: 'VALIDATION', detail: 'q is required' } });
    expect(await validateKeyForSpec(brave(), 'BSA-brave-value')).toEqual({ status: 'valid' });
  });

  it('422 SUBSCRIPTION_TOKEN_INVALID → invalid', async () => {
    // Brave answers a bad token with 422 — the SAME status as a bad
    // parameter — so `error.code` is the only real discriminator. Classifying
    // on status alone would make the two indistinguishable.
    stubFetch(422, { error: { code: 'SUBSCRIPTION_TOKEN_INVALID' } });
    expect(await validateKeyForSpec(brave(), 'BSA-brave-value')).toEqual({
      status: 'invalid',
      httpStatus: 422,
    });
  });

  it.each([401, 403])('%i → invalid', async (status) => {
    stubFetch(status, {});
    expect(await validateKeyForSpec(brave(), 'BSA-brave-value')).toEqual({
      status: 'invalid',
      httpStatus: status,
    });
  });

  it('429 RATE_LIMITED → unverifiable', async () => {
    // NOTE: this one is decided at step 1 (the exact-code table), NOT by the
    // bare-429 rule. It short-circuits before `status === 429` is ever read,
    // which is why the naked-429 cases live in their own block below — with
    // only this test, the 429 rule could be deleted outright and nothing here
    // would notice.
    stubFetch(429, { error: { code: 'RATE_LIMITED' } });
    expect(await validateKeyForSpec(brave(), 'BSA-brave-value')).toMatchObject({
      status: 'unverifiable',
    });
  });

  it('a 429 whose body is an HTML error page still only warns', async () => {
    // Brave behind a CDN answers a burst with an HTML page, not JSON. The
    // body is unparseable, so the classifier gets `undefined` and has ONLY
    // the status to go on — the naked-429 path, end to end through the probe.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 429,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON at position 0');
        },
      })),
    );
    const verdict = await validateKeyForSpec(brave(), 'BSA-brave-value');
    expect(verdict).toMatchObject({ status: 'unverifiable' });
    expect(verdict.status === 'unverifiable' && verdict.reason).toMatch(/rate-limit/i);
  });

  it('a hung endpoint → unverifiable on our own timeout', async () => {
    stubFetchHanging();
    expect(await validateKeyForSpec(brave(), 'BSA-brave-value', { timeoutMs: 20 })).toMatchObject({
      status: 'unverifiable',
    });
  }, 5_000);

  it('an unparseable body falls back to the status, it does not blow up', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 503,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON at position 0');
        },
      })),
    );
    expect(await validateKeyForSpec(brave(), 'BSA-brave-value')).toEqual({
      status: 'unverifiable',
      reason: 'HTTP 503',
    });
  });
});

describe('classifyBraveResponse — the ordering that keeps good keys alive', () => {
  it('files SUBSCRIPTION_QUOTA_EXCEEDED as transient, not as a bad token', () => {
    // The trap the exact-code table exists for: the code CONTAINS the word
    // SUBSCRIPTION, so any substring match on it (`BRAVE_AUTH_CODE` would fire)
    // would condemn a key whose only problem is a monthly quota that resets.
    expect(classifyBraveResponse(429, { error: { code: 'SUBSCRIPTION_QUOTA_EXCEEDED' } })).toMatchObject(
      { status: 'unverifiable' },
    );
    expect(classifyBraveResponse(422, { error: { code: 'SUBSCRIPTION_QUOTA_EXCEEDED' } })).toMatchObject(
      { status: 'unverifiable' },
    );
  });

  it('treats a plan gate as proof the key is fine', () => {
    // OPTION_NOT_IN_PLAN also carries meta.component === "authentication";
    // reading THAT field instead of the code would refuse a working key.
    expect(classifyBraveResponse(400, { error: { code: 'OPTION_NOT_IN_PLAN' } })).toEqual({
      status: 'valid',
    });
  });

  it('never calls a token invalid on a status where auth is implausible', () => {
    // 500 with an auth-shaped code is a server having a bad day, not a verdict.
    expect(classifyBraveResponse(500, { error: { code: 'SUBSCRIPTION_TOKEN_INVALID' } })).toMatchObject(
      { status: 'unverifiable' },
    );
  });

  it('402 (billing) is unverifiable — recoverable by the account owner', () => {
    expect(classifyBraveResponse(402, {})).toMatchObject({ status: 'unverifiable' });
  });

  it('an unattributed 400/422 stays unverifiable rather than guessing', () => {
    expect(classifyBraveResponse(422, { error: { code: 'WHO_KNOWS' } })).toMatchObject({
      status: 'unverifiable',
    });
    expect(classifyBraveResponse(400, {})).toMatchObject({ status: 'unverifiable' });
  });

  it('a 2xx is valid', () => {
    expect(classifyBraveResponse(200, { web: { results: [] } })).toEqual({ status: 'valid' });
  });

  it('survives a body of any shape', () => {
    for (const body of [undefined, null, 'text', 42, [], { error: null }, { error: { code: 7 } }]) {
      expect(() => classifyBraveResponse(422, body)).not.toThrow();
    }
  });
});

/**
 * The NAKED 429 — the rule that fires when the body tells us nothing.
 *
 * Why this needs its own block: the only 429 assertion the suite used to make
 * sent `{error:{code:'RATE_LIMITED'}}`, which is decided by the exact-code
 * table at step 1 and returns before `status === 429` is ever evaluated. The
 * two paths therefore masked each other — the 429 rule could be turned into
 * `invalid`, or deleted, with the whole suite still green.
 *
 * Every case here reaches the rule with a body that CANNOT decide for it, and
 * every one asserts the rate-limit REASON as well as the status: the reason is
 * what separates "the 429 rule answered" from "the status-only fallback at the
 * bottom answered", so deleting the rule fails these too, not only mutating it.
 */
describe('classifyBraveResponse — a 429 the body cannot explain', () => {
  const naked: Array<[string, unknown]> = [
    ['an empty body', {}],
    ['no body at all', undefined],
    ['a null body', null],
    ['an unparseable body (HTML error page → undefined)', undefined],
    ['a code nothing in the table or the patterns claims', { error: { code: 'WHO_KNOWS' } }],
    // The trap: an auth-SHAPED code arriving on a throttling status. `THROTTL`
    // is in the transient pattern and `SUBSCRIPTION` is in the auth one, and
    // 429 is not even an auth-plausible status — three separate reasons this
    // must warn, none of which were exercised.
    ['an auth-shaped code', { error: { code: 'SUBSCRIPTION_TOKEN_THROTTLED' } }],
    // A "your request was bad" code on a throttling status: transient wins.
    // Without the 429 rule this lands on the config pattern and reports
    // `valid` — a key declared good by a response that never checked it.
    ['a config-shaped code', { error: { code: 'INVALID_REQUEST' } }],
  ];

  it.each(naked)('429 with %s → unverifiable, and says so as a rate limit', (_label, body) => {
    const verdict = classifyBraveResponse(429, body);
    expect(verdict.status).toBe('unverifiable');
    expect(verdict.status === 'unverifiable' && verdict.reason).toMatch(/rate-limit/i);
  });

  it('never answers invalid on a 429, whatever the body says', () => {
    // 429 is not in BRAVE_AUTH_STATUSES either, so this holds twice over.
    for (const [, body] of naked) {
      expect(classifyBraveResponse(429, body).status).not.toBe('invalid');
    }
  });
});

/**
 * The OTHER direction's status guard.
 *
 * `BRAVE_AUTH_STATUSES` bounds where a REJECTION is believable. This block is
 * about where an ACCEPTANCE is: a plan gate or a parameter complaint proves the
 * token got past auth only when Brave's own application layer answered. A 5xx
 * carrying `VALIDATION` is a server having a bad day (or a proxy's error page
 * that happened to parse) and proves nothing.
 *
 * Direction matters: the guard can only ever turn `valid` into `unverifiable`
 * — a warning the user clicks through — never into `invalid`. That is the
 * acceptable direction for this module, and the last test pins it.
 */
describe('classifyBraveResponse — an acceptance is only believable where Brave could have answered', () => {
  it('does not read a 5xx as proof the token was accepted', () => {
    expect(classifyBraveResponse(500, { error: { code: 'VALIDATION' } })).toEqual({
      status: 'unverifiable',
      reason: 'HTTP 500 (VALIDATION)',
    });
    expect(classifyBraveResponse(503, { error: { code: 'OPTION_NOT_IN_PLAN' } })).toMatchObject({
      status: 'unverifiable',
    });
    // The pattern path (step 5), not just the exact-code table (step 1).
    expect(classifyBraveResponse(502, { error: { code: 'INVALID_REQUEST' } })).toMatchObject({
      status: 'unverifiable',
    });
  });

  it('still accepts them on the statuses Brave really answers them with', () => {
    // 422 VALIDATION is THE free proof the whole probe is built around, and
    // OPTION_NOT_IN_PLAN arrives as a 400. Neither may be collateral damage.
    expect(classifyBraveResponse(422, { error: { code: 'VALIDATION' } })).toEqual({
      status: 'valid',
    });
    expect(classifyBraveResponse(400, { error: { code: 'OPTION_NOT_IN_PLAN' } })).toEqual({
      status: 'valid',
    });
    expect(classifyBraveResponse(400, { error: { code: 'INVALID_QUERY' } })).toEqual({
      status: 'valid',
    });
  });

  it('degrades to a warning, never to an accusation', () => {
    for (const code of ['VALIDATION', 'OPTION_NOT_IN_PLAN', 'INVALID_REQUEST', 'UPGRADE_PLAN']) {
      for (const status of [500, 502, 503, 504]) {
        expect(classifyBraveResponse(status, { error: { code } }).status, `${status} ${code}`).toBe(
          'unverifiable',
        );
      }
    }
  });
});

// ── the secret must never come back out ────────────────────────────────

describe('the raw key never leaves this module', () => {
  const SECRET = 'sk-super-secret-key-value-1234';

  it('is absent from every verdict, whatever the provider said', async () => {
    // Provider error text is not guaranteed to be free of the token it is
    // complaining about, and a validation failure is exactly the message a
    // user pastes into a bug report.
    const cases: Array<() => void> = [
      () => stubFetch(500, { error: { message: `bad token ${SECRET}` } }),
      () => stubFetch(429, { error: { code: 'RATE_LIMITED', detail: SECRET } }),
      () => stubFetchRejecting(new Error(`connect ECONNREFUSED while sending ${SECRET}`)),
      () => stubFetchRejecting(SECRET),
    ];
    for (const install of cases) {
      install();
      const verdict = await validateKeyForSpec(deepseek(), SECRET, { timeoutMs: 500 });
      expect(JSON.stringify(verdict)).not.toContain(SECRET);
      vi.unstubAllGlobals();
    }
  });

  it('masks it when a rejection message quotes it back', async () => {
    stubFetchRejecting(new Error(`socket hang up [${SECRET}]`));
    const verdict = await validateKeyForSpec(deepseek(), SECRET, { timeoutMs: 500 });
    expect(verdict.status).toBe('unverifiable');
    const reason = verdict.status === 'unverifiable' ? verdict.reason : '';
    expect(reason).not.toContain(SECRET);
    // Masked, not merely deleted: the user still gets to recognise WHICH key.
    expect(reason).toContain('sk-sup');
    expect(reason).toContain('1234');
  });

  it('holds for the Brave probe too', async () => {
    // Brave-SHAPED on purpose. The DeepSeek-shaped `SECRET` above would now be
    // stopped by the cross-spec guard (`sk-…` in the Brave slot is another
    // provider's key), so the probe would never run and this test would pass
    // while asserting nothing about Brave's scrubbing.
    const braveSecret = 'BSAsuper-secret-brave-value-1234';
    stubFetch(422, { error: { code: 'SUBSCRIPTION_TOKEN_INVALID', detail: braveSecret } });
    const verdict = await validateKeyForSpec(brave(), braveSecret);
    expect(verdict).toEqual({ status: 'invalid', httpStatus: 422 });
    expect(JSON.stringify(verdict)).not.toContain(braveSecret);
  });
});

describe('nothing throws', () => {
  it('survives a fetch that is not even a function', async () => {
    vi.stubGlobal('fetch', undefined);
    await expect(validateKeyForSpec(deepseek(), 'sk-value')).resolves.toMatchObject({
      status: 'unverifiable',
    });
  });

  it('survives a response object missing everything', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({})));
    await expect(validateKeyForSpec(deepseek(), 'sk-value')).resolves.toMatchObject({
      status: 'unverifiable',
    });
  });

  it('survives a fetch that throws synchronously', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('boom');
      }),
    );
    await expect(validateKeyForSpec(brave(), 'BSA-value')).resolves.toMatchObject({
      status: 'unverifiable',
    });
  });
});

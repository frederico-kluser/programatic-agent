/**
 * Declarative registry of API keys huu knows how to resolve, prompt for,
 * persist globally, and forward into the container.
 *
 * Adding a new key in the future is a one-entry append:
 *
 *   {
 *     name: 'fooApi',
 *     envVar: 'FOO_API_KEY',
 *     envFileVar: 'FOO_API_KEY_FILE',
 *     secretMountPath: '/run/secrets/foo_api_key',
 *     hostSecretScope: 'huu-foo-key',
 *     label: 'Foo',
 *     hint: 'starts with foo-',
 *     required: false,
 *   }
 *
 * Everything downstream (resolver, TUI prompt, docker re-exec mounts,
 * env passthrough, orphan cleanup) iterates this list — no other files
 * need to learn about the new key.
 */
import type { LlmProvider } from './providers.js';

export interface ApiKeySpec {
  /**
   * Internal identifier. Used as the JSON property name in the persisted
   * global store (`~/.config/huu/config.json`). camelCase by convention.
   */
  name: string;
  /** Primary env var. Resolution order step 3. */
  envVar: string;
  /** `_FILE` companion: path to a file containing the value. Step 2. */
  envFileVar: string;
  /**
   * Path the value is bind-mounted to inside the container. Mirrors the
   * postgres / mysql Docker images' `_FILE` convention. Step 1 of the
   * resolver. Convention: `/run/secrets/<snake_case_name>`.
   */
  secretMountPath: string;
  /**
   * Filename prefix used when the host-side wrapper writes the value
   * to /dev/shm (or os.tmpdir()) before bind-mounting into the container.
   * Lower-case kebab. Used by the orphan sweeper to clean up stale files.
   */
  hostSecretScope: string;
  /** Human-friendly title shown in the TUI prompt. */
  label: string;
  /** Short hint shown above the input ("starts with sk-"). */
  hint?: string;
  /**
   * Optional prefix used for cheap client-side validation (warns the
   * user if they paste something that doesn't start with this). The
   * resolver/saver does not enforce — purely a UX guardrail.
   */
  validatePrefix?: string;
  /**
   * Whether the run path should block when this key is missing. `false`
   * means "nice to have, plumb it but don't pop the prompt".
   */
  required: boolean;
  /**
   * When set, this spec is the credential of ONE specific LLM provider. The
   * run gate enforces it only when that provider is the one about to be
   * used — and then REGARDLESS of `required`, because choosing a provider
   * makes its key mandatory. Specs without `providerBound` are universal:
   * enforced for every run when `required: true`, invisible when `false`.
   *
   * The axis is the PROVIDER, not the backend — this field replaced
   * `backendBound` when OpenRouter rejoined. `deepseek` and `openrouter`
   * BOTH dispatch to the `jcode` backend, so a backend-keyed binding would
   * have made one run demand BOTH keys. Provider-keyed, a run asks for
   * exactly the credential it is going to spend, no more and no less.
   */
  providerBound?: LlmProvider;
}

export const API_KEY_REGISTRY: readonly ApiKeySpec[] = [
  {
    name: 'deepseek',
    envVar: 'DEEPSEEK_API_KEY',
    envFileVar: 'DEEPSEEK_API_KEY_FILE',
    secretMountPath: '/run/secrets/deepseek_api_key',
    hostSecretScope: 'huu-deepseek-key',
    label: 'DeepSeek',
    hint: 'starts with sk-',
    validatePrefix: 'sk-',
    required: true,
    providerBound: 'deepseek',
  },
  {
    // First-class again: OpenRouter is the provider that fronts the
    // heterogeneous roster (Claude, GPT, GLM) the DeepSeek endpoint cannot
    // serve. `name` is INTENTIONALLY unchanged from its legacy-era value —
    // it is the JSON property of every already-persisted config store (and
    // the spec `api-key-pool.test.ts` exercises), so renaming it would
    // orphan saved keys.
    //
    // `required: false` + `providerBound: 'openrouter'` is the deliberate
    // shape: the binding is what gates an OpenRouter run (bound specs are
    // enforced regardless of `required`), while `required: false` keeps it
    // OUT of the universal gate so a DeepSeek run never asks for it.
    name: 'openrouter',
    envVar: 'OPENROUTER_API_KEY',
    envFileVar: 'OPENROUTER_API_KEY_FILE',
    secretMountPath: '/run/secrets/openrouter_api_key',
    hostSecretScope: 'huu-openrouter-key',
    label: 'OpenRouter',
    hint: 'starts with sk-or-',
    validatePrefix: 'sk-or-',
    required: false,
    providerBound: 'openrouter',
  },
  {
    // AA is purely informational — it enriches the model selector with
    // benchmark metrics. ModelSelectorOverlay degrades gracefully when
    // it's missing ("métricas indisponíveis"). Marked `required: false`
    // so it never gates the run flow: prompting for it AFTER the user
    // configured pipeline, backend, and model was a foot-gun. To set it,
    // export ARTIFICIAL_ANALYSIS_API_KEY in your shell before running huu.
    name: 'artificialAnalysis',
    envVar: 'ARTIFICIAL_ANALYSIS_API_KEY',
    envFileVar: 'ARTIFICIAL_ANALYSIS_API_KEY_FILE',
    secretMountPath: '/run/secrets/artificial_analysis_api_key',
    hostSecretScope: 'huu-artificial-analysis-key',
    label: 'Artificial Analysis',
    hint: 'API key from artificialanalysis.ai',
    required: false,
  },
  // ── Web-research providers (surf CLI) ────────────────────────────────
  // Consumed by `ensureSurfKeys()` (src/lib/surf-research.ts), which
  // materializes ~/.config/surf/keys.json — the surf CLI reads ONLY that
  // file, so env vars and secret mounts alone would never reach it.
  //
  // All three are `required: false` AND deliberately carry NO
  // `providerBound`: the run gate only enforces an unbound spec when
  // `required: true`, so these stay invisible to it. Web research is an
  // OPTIONAL capability — a missing key degrades the research step (see
  // docs/dev-mode.md), it must never block a run.
  //
  // WHICH OF THEM STILL SEARCHES: only `brave`. The installed surf is v8 and
  // it dispatches over Brave alone — no Tavily, no Parallel, no keyless tier,
  // and exit 78 before anything runs when the Brave key is missing.
  //
  // `tavily` and `parallel` are therefore KEPT, not deleted, and the choice is
  // deliberate. Deleting them costs three things and buys nothing: the run
  // would lose the `tvly-` prefix that is the registry's ONLY non-`sk-`
  // discriminant, which is what makes `detectForeignKeySpec` provably able to
  // tell one provider's key from another's; the resolver would stop
  // recognising keys users already persisted under those names; and a surf
  // downgrade would stop working. What they may never do is imply that
  // research is possible — `EnsureSurfKeysResult.searchReady` looks at `brave`
  // and only `brave`, so a Tavily-only machine is told the truth instead of
  // discovering it at the first exit 78.
  {
    name: 'tavily',
    envVar: 'TAVILY_API_KEY',
    envFileVar: 'TAVILY_API_KEY_FILE',
    secretMountPath: '/run/secrets/tavily_api_key',
    hostSecretScope: 'huu-tavily-key',
    label: 'Tavily (web research)',
    hint: 'starts with tvly-',
    validatePrefix: 'tvly-',
    required: false,
  },
  {
    name: 'parallel',
    envVar: 'PARALLEL_API_KEY',
    envFileVar: 'PARALLEL_API_KEY_FILE',
    secretMountPath: '/run/secrets/parallel_api_key',
    hostSecretScope: 'huu-parallel-key',
    label: 'Parallel AI (web research)',
    hint: 'API key from parallel.ai',
    required: false,
  },
  {
    name: 'brave',
    envVar: 'BRAVE_API_KEY',
    envFileVar: 'BRAVE_API_KEY_FILE',
    secretMountPath: '/run/secrets/brave_api_key',
    hostSecretScope: 'huu-brave-key',
    label: 'Brave Search (web research)',
    hint: 'API key from brave.com/search/api — the ONLY search backend; without it the `external` lane cannot be answered',
    required: false,
  },
];

export function findSpec(name: string): ApiKeySpec | undefined {
  return API_KEY_REGISTRY.find((s) => s.name === name);
}

/**
 * Detect a value pasted into the WRONG spec's prompt.
 *
 * The foot-gun this closes: DeepSeek keys start with `sk-`, OpenRouter keys
 * with `sk-or-`. A prefix check alone can never separate them — `sk-or-…`
 * satisfies `startsWith('sk-')` — so an OpenRouter user pushed to the DeepSeek
 * prompt pasted their key, saw NO warning, and huu persisted it under the name
 * `deepseek` and shipped it to api.deepseek.com. Making the deepseek prefix
 * "discriminant enough" is impossible (a prefix cannot express "sk- but not
 * sk-or-"), so the discrimination has to be CROSS-SPEC.
 *
 * The rule, in three parts:
 *   1. Only specs that DECLARE a `validatePrefix` are judged. A spec with no
 *      declared format (Artificial Analysis, Brave, Parallel) has no basis to
 *      call anything foreign — claiming every `sk-…` value for DeepSeek would
 *      be a false positive that blocks perfectly good keys.
 *   2. A value that satisfies the target's own prefix is foreign only when
 *      another spec's prefix is STRICTLY MORE SPECIFIC (longer) and also
 *      matches: `sk-or-` (6) refines `sk-` (3), so an OpenRouter key is
 *      refused by the DeepSeek prompt.
 *   3. A value that does NOT satisfy the target's prefix is foreign as soon as
 *      it matches any other spec's prefix — a plain `sk-…` DeepSeek key in the
 *      OpenRouter prompt, a `tvly-…` in either.
 *
 * Anything else (a value matching nothing at all) is left to the SOFT prefix
 * warning, deliberately: keys do change format, and a shape we simply do not
 * recognise must not lock the user out.
 *
 * Returns the spec the value really belongs to, or `undefined`.
 */
export function detectForeignKeySpec(
  target: ApiKeySpec,
  value: string,
): ApiKeySpec | undefined {
  const v = value.trim();
  if (!v) return undefined;
  const own = target.validatePrefix;
  if (!own) return undefined;
  const matchesOwn = v.startsWith(own);
  let best: ApiKeySpec | undefined;
  for (const spec of API_KEY_REGISTRY) {
    if (spec.name === target.name) continue;
    const prefix = spec.validatePrefix;
    if (!prefix || !v.startsWith(prefix)) continue;
    // Satisfies the target's own format: only a strictly longer (more
    // specific) prefix can overrule it.
    if (matchesOwn && prefix.length <= own.length) continue;
    if (!best || prefix.length > (best.validatePrefix?.length ?? 0)) best = spec;
  }
  return best;
}

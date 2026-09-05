/**
 * "Which providers serve this model id", assembled for one dev session.
 *
 * This is the impure half of the model preflight: `dev-model-policy.ts` stays a
 * pure function of an index, and THIS module is the one place that reads a
 * catalog off disk to build one. Factored out rather than repeated at the three
 * surfaces (`dev-driver`, `dev-cli`, `web/dev-manager`) because the interesting
 * decision — WHICH catalogs count — must have exactly one answer.
 *
 * TWO catalogs, unioned, and the order of the argument matters less than the
 * fact that both are read:
 *
 *   · **huu's own**, shipped at the package root (`package.json` `files`
 *     includes `recommended-models.json`). This is the floor. Without it the
 *     index in a normal session would be the 3-entry in-code fallback in
 *     `src/models/catalog.ts`, which lists `deepseek/deepseek-v4-flash` under
 *     `deepseek` only — and the preflight would then REFUSE a perfectly good
 *     `--provider=openrouter` run of that same model. A false refusal is worse
 *     than the failure the preflight prevents.
 *   · **the audited project's**, read the same way the model pickers read it.
 *     A project may ship its own catalog; it can therefore ADD ids huu does not
 *     know. It can never subtract, because this is a union.
 *
 * Union, never override: every entry from either file contributes its provider
 * to the id's set, so an id both files know ends up servable by BOTH endpoints
 * and the preflight — which refuses only on positive evidence of a
 * contradiction — has less to refuse, not more.
 *
 * Said precisely, because the loose version of this sentence was wrong: reading
 * a second catalog may only add a provider some file ACTUALLY NAMED. A refusal
 * that follows from an entry stating `"provider": "openrouter"` is a real
 * refusal and stays. What must never happen is a refusal manufactured out of a
 * field that is not there.
 *
 * THAT PROMISE IS ONLY TRUE IF NEITHER FILE INVENTS EVIDENCE, and it briefly
 * was not. `buildModelProviderIndex` defaults a provider-less entry to
 * `deepseek` — correct for huu's own shipped file, where the field postdates
 * the entries and the default is pinned by tests, and WRONG for anyone else's:
 * an id that only the audited project lists, with no `provider`, would gain a
 * positive (and fabricated) "served by deepseek", turning a `warn` on an
 * OpenRouter run into a `refuse`. Reading a project catalog would then make the
 * preflight STRICTER — the exact opposite of the paragraph above. So the
 * project's entries are read with `defaultProvider: null`: an absent field
 * there means "I do not know", and an id nobody places anywhere stays a
 * warning, which is what the whole refuse-on-contradiction rule requires.
 *
 * Layering: `src/models/` sits above `lib/` (it imports from it), so this is the
 * same run-driver exception `dev-driver.ts` documents at its own import of
 * `orchestrator/`. Keeping it in ONE small module is what stops that exception
 * from spreading through the pure compiler layer.
 */

import { fileURLToPath } from 'node:url';
import { loadRecommendedModels } from '../../models/catalog.js';
import {
  buildModelProviderIndex,
  unionModelProviderIndexes,
  type ModelProviderIndex,
} from './dev-model-policy.js';

/**
 * huu's own package root. `src/lib/dev-mode/` → three up is the repo root, and
 * `dist/lib/dev-mode/` → three up is the installed package root, so the same
 * expression works from source and from a published install.
 */
const HUU_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * The provider index a session should judge its routing against.
 *
 * `projectRoot` is the AUDITED repository (`--run-dir`, or the cwd). Passing
 * huu's own root twice is harmless — the union deduplicates by construction.
 */
export function devModelProviderIndex(projectRoot: string): ModelProviderIndex {
  // huu's own file keeps the `?? 'deepseek'` back-compat: its provider-less
  // entries predate the field and ARE DeepSeek's.
  const own = buildModelProviderIndex(loadRecommendedModels(HUU_ROOT));
  let project: ReturnType<typeof loadRecommendedModels> = [];
  try {
    if (projectRoot && projectRoot !== HUU_ROOT) project = loadRecommendedModels(projectRoot);
  } catch {
    // An unreadable project catalog must not stop a session: the floor above is
    // already loaded, and `loadRecommendedModels` swallows parse errors anyway.
    // This only guards a projectRoot that cannot be stat'd at all.
  }
  // The project's file is somebody else's: an entry with no `provider` is a
  // claim that the id exists, never a claim about which endpoint serves it.
  return unionModelProviderIndexes(
    own,
    buildModelProviderIndex(project, { defaultProvider: null }),
  );
}

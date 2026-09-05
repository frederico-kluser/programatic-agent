/* The DEFAULT `/dev` path, end to end: the body the BROWSER assembles on its
   own, posted at a REAL server.
   ========================================================================

   WHY THIS FILE EXISTS. The model preflight moved a doomed session's failure
   from "inside the first agent, after its worktree and branch exist" to a 400
   at the border — an unambiguous improvement, and it broke the default path.
   `/dev` makes routing a REQUIRED decision: the form OPENS with a preset
   selected. That preset used to be `hetero` unconditionally, `hetero` routes
   the planner and the critic to ids only openrouter.ai serves, and a machine
   with a DeepSeek key selects `deepseek` — so opening `/dev` and pressing Start,
   choosing NOTHING, produced `HTTP 400 — 2 role(s) refused: planner, critic`.
   Four of the five presets were refused on that provider.

   So the assertion is not "the server refuses an impossible body" (it does, and
   `dev-manager.test.ts` pins that). It is the complement, and it is the one a
   unit test of either half cannot make: THE CLIENT DOES NOT ASSEMBLE ONE.

   HOW IT PROVES IT. The body is not retyped here — it is built by the very
   functions `dev.js` calls, in the order `dev.js` calls them, from the tables
   `/api/bootstrap` actually served, with the user choosing nothing:

     defaultPreset(boot.devModelPresetProviders, …, provider)   ← the opening preset
     presetValues(boot.devModelRoles, boot.devModelPresets, …)  ← the role fields
     fallbackModelIdFrom(roles, values)                         ← the required modelId
     buildDevModelsPayload({roles, presets, preset, values})    ← the wire fields

   Then it POSTs that at a real `createWebServer`, for EVERY provider the
   server advertises. A green run means "open /dev, press Start" works on any
   machine, whichever single key it has.

   MUTATION KILLED: making the opening preset provider-blind again (`hetero`
   whenever the table lists it). The DeepSeek row goes back to 400.

   WHY IT IS A `.js` FILE, AND WHY IT SITS HERE. It has to import BOTH halves:
   `client/dev-models.js` (the browser's no-build ESM, outside the TS project —
   a `.ts` file cannot import it under `allowJs: false`) and `server.ts`. It
   cannot live under `client/` either: `tsconfig.client.json` compiles that
   directory with `strict: false`, and importing the server from there drags the
   whole server graph into that project, where zod's inference produces dozens
   of unrelated errors. `.js` in `src/web/` is the one place both imports are
   legal — vitest discovers it, and neither tsconfig claims it. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWebServer } from './server.js';
import {
  buildDevModelsPayload,
  defaultPreset,
  fallbackModelIdFrom,
  presetValues,
} from './client/dev-models.js';

/* `state.js` reads `location` at import, so it cannot be loaded in a node
   environment; this mirrors its `DEFAULT_MODEL_ID` — the last resort the form
   falls back to when a preset pins no role at all (`uniform`). */
const DEFAULT_MODEL_ID = 'deepseek/deepseek-v4-flash';

function setupRepo(dir) {
  execSync('git init --initial-branch=main', { cwd: dir, encoding: 'utf8' });
  execSync('git config user.email "t@t.com" && git config user.name "t"', { cwd: dir, shell: '/bin/bash' });
  writeFileSync(join(dir, 'README.md'), '# init\n', 'utf8');
  writeFileSync(join(dir, '.gitignore'), '.huu-worktrees/\n.huu/\n', 'utf8');
  execSync('git add -A && git commit -m init', { cwd: dir, encoding: 'utf8' });
}

/**
 * EXACTLY what the untouched form puts on the wire for `provider` — the same
 * calls `initDevModelPanel` + `devStartBody` make, in the same order.
 */
export function untouchedDevBody(boot, provider, runDirectory) {
  const roles = boot.devModelRoles;
  const preset = defaultPreset(boot.devModelPresetProviders, Object.keys(boot.devModelPresets), provider);
  const values = presetValues(roles, boot.devModelPresets, preset);
  const routing = buildDevModelsPayload({ roles, presets: boot.devModelPresets, preset, values });
  return {
    preset,
    body: {
      goal: 'o caminho default do /dev',
      provider,
      modelId: fallbackModelIdFrom(roles, values) || DEFAULT_MODEL_ID,
      // The browser sends whatever key the ⚙ panel holds for the active
      // provider; the shape is what matters here, not the value.
      apiKey: `sk-${provider}-test-key-0000`,
      runDirectory,
      approval: 'each-epoch',
      skipKnowledgeBootstrap: true,
      ...routing,
    },
  };
}

describe('/dev — the untouched form starts on every provider', () => {
  let repo;
  let server;
  let base;
  let boot;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'huu-dev-default-'));
    setupRepo(repo);
    ({ server } = createWebServer({ cwd: repo, defaultAutoScale: true }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    boot = await (await fetch(base + '/api/bootstrap')).json();
  });

  afterEach(async () => {
    await fetch(base + '/api/dev/abort', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    await new Promise((resolve) => server.close(resolve));
    rmSync(repo, { recursive: true, force: true });
  });

  it('advertises which providers can run each preset', () => {
    // Without this table the client would have to reimplement
    // `checkDevModelPolicy` — two copies of the rule is two answers.
    expect(boot.devModelPresetProviders).toBeTruthy();
    expect(Object.keys(boot.devModelPresetProviders).sort())
      .toEqual(Object.keys(boot.devModelPresets).sort());
    // `uniform` pins nothing, so it runs anywhere; every other preset names at
    // least one openrouter-only id, so none of them runs on DeepSeek.
    expect(boot.devModelPresetProviders.uniform).toEqual(['deepseek', 'openrouter']);
    expect(boot.devModelPresetProviders.hetero).toEqual(['openrouter']);
    expect(boot.devModelPresetProviders.roster).toEqual(['openrouter']);
  });

  it('opens on a preset the active provider can actually serve', () => {
    const names = Object.keys(boot.devModelPresets);
    expect(defaultPreset(boot.devModelPresetProviders, names, 'openrouter')).toBe('hetero');
    // THE BUG: this used to be `hetero` here too, and `hetero` cannot run here.
    expect(defaultPreset(boot.devModelPresetProviders, names, 'deepseek')).toBe('uniform');
  });

  it('POSTs a body the border accepts — on EVERY advertised provider', async () => {
    const providers = boot.providers.map((p) => p.id);
    expect(providers.length).toBeGreaterThan(1);
    for (const provider of providers) {
      const { preset, body } = untouchedDevBody(boot, provider, repo);
      const res = await fetch(base + '/api/dev', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      expect(
        { provider, preset, status: res.status, error: json.error },
        `the untouched /dev form must start on ${provider}`,
      ).toEqual({ provider, preset, status: 200, error: undefined });
      await fetch(base + '/api/dev/abort', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
    }
  });
});

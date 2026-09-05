#!/usr/bin/env tsx
/**
 * `npm start` — the host orchestrator.
 *
 * Deliberately thin: `tsconfig.json` only includes `src/**`, so anything
 * written here is NOT type-checked by `npm run typecheck` and NOT reachable
 * from the test suite. All of the actual decisions therefore live in
 * `src/lib/start-runner.ts`, which is both. This file only resolves the repo
 * root, builds the real side effects and exits with what the runner returns.
 *
 * What it replaced, and why it is not a shell one-liner any more:
 * `./scripts/ensure-image.sh && tsx src/cli.tsx` put a `docker build` in front
 * of the CLI, so a stopped daemon killed the command before huu could ask the
 * user anything — including "shall I run without Docker, then?".
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initI18n } from '../src/lib/i18n/index.js';
import { createStartDeps, runStart } from '../src/lib/start-runner.js';

// Same first move as `cli.tsx`: resolve the locale and audit the catalogs
// before a single line is printed.
initI18n(process.env);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

process.exit(await runStart(createStartDeps(repoRoot, args, process.env)));

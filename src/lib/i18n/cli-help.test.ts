/**
 * `huu --help` must describe the CLI huu actually ships — in EVERY locale.
 *
 * This exists because the help text aged in silence: long after the `pi` and
 * `azure` backends were deleted, both catalogs still read
 * "Pick the LLM provider for pi: openrouter (default), azure" — three lies in
 * one line (a dead backend, a dead provider, and the wrong default, since
 * `DEFAULT_PROVIDER` is `deepseek`).
 *
 * A test that pinned the corrected sentence as a LITERAL would rot the same
 * way. So the assertions below bind the help text to the RUNNING code:
 * `PROVIDERS` / `DEFAULT_PROVIDER` (lib/providers.ts) and `ALL_BACKENDS`
 * (orchestrator/backends/registry.ts) are the reference sets, and the value
 * lists in the help must match them exactly, in order, with the default marked
 * on the right entry. Adding or removing a provider or a backend without
 * touching the help now FAILS here instead of shipping a lying `--help`.
 *
 * The import of the backend registry deliberately reaches "up" a layer: this
 * is a test of a CROSS-LAYER contract (what the CLI advertises vs what the
 * dispatch table offers), so it has to see both sides. No production module in
 * `lib/` gains an edge from it.
 */

import { describe, expect, it } from 'vitest';
import { ALL_BACKENDS } from '../../orchestrator/backends/registry.js';
import {
  DEFAULT_PROVIDER,
  PROVIDERS,
  parseProvider,
  providerToBackend,
} from '../providers.js';
import { CATALOGS } from './catalog.js';
import { LOCALES } from './types.js';

/** Words a locale may use to mark "this is what you get by default". */
const DEFAULT_MARKERS = ['default', 'padrão'];

/** Words a locale may use to introduce an accepted short spelling. */
const ALIAS_MARKERS = ['alias', 'apelido'];

interface HelpValue {
  /** The literal the user types, e.g. `deepseek`. */
  id: string;
  /** The parenthetical after it, e.g. `default, alias ds` (empty when absent). */
  note: string;
}

/**
 * The block of `cli.help` that documents one flag: everything from
 * `huu --flag=` up to the next `  huu ` entry (so wrapped continuation lines
 * come along).
 */
function flagBlock(help: string, flag: string): string {
  const start = help.indexOf(`huu --${flag}=`);
  expect(start, `--${flag} is not documented in the help`).toBeGreaterThanOrEqual(0);
  const rest = help.slice(start);
  const end = rest.indexOf('\n  huu ');
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * The accepted values a flag block advertises: the LAST non-empty line of the
 * block, parsed as `id (note), id (note), …`.
 *
 * Parsing the last line (rather than the whole block) is what lets the prose
 * above it be written freely in each locale while the machine-checkable part
 * stays a plain, comma-separated list.
 */
function advertisedValues(help: string, flag: string): HelpValue[] {
  const lines = flagBlock(help, flag)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const valueLine = lines[lines.length - 1];
  const out: HelpValue[] = [];
  const entry = /([a-z][a-z0-9-]*)(?:\s*\(([^)]*)\))?/g;
  for (const m of valueLine.matchAll(entry)) {
    out.push({ id: m[1], note: m[2] ?? '' });
  }
  return out;
}

function marksDefault(note: string): boolean {
  return DEFAULT_MARKERS.some((w) => note.toLowerCase().includes(w));
}

describe('cli.help documents the providers that actually exist', () => {
  for (const locale of LOCALES) {
    const help = CATALOGS[locale]['cli.help'];

    it(`[${locale}] lists exactly the PROVIDERS table, in order`, () => {
      const values = advertisedValues(help, 'provider');
      expect(values.map((v) => v.id)).toEqual(PROVIDERS.map((p) => p.id));
    });

    it(`[${locale}] marks DEFAULT_PROVIDER as the default, and nothing else`, () => {
      const values = advertisedValues(help, 'provider');
      const defaulted = values.filter((v) => marksDefault(v.note)).map((v) => v.id);
      expect(defaulted).toEqual([DEFAULT_PROVIDER]);
    });

    it(`[${locale}] only advertises aliases parseProvider actually accepts`, () => {
      const values = advertisedValues(help, 'provider');
      const aliasOf = new RegExp(`(?:${ALIAS_MARKERS.join('|')})\\s+([a-z0-9-]+)`, 'g');
      let seen = 0;
      for (const v of values) {
        for (const m of v.note.matchAll(aliasOf)) {
          seen += 1;
          expect(parseProvider(m[1]), `alias "${m[1]}"`).toBe(v.id);
        }
      }
      // Guard the guard: a rewrite that drops every alias must not make this
      // test vacuously pass.
      expect(seen, 'the help advertises no provider alias at all').toBeGreaterThan(0);
    });
  }
});

describe('cli.help documents the backends that actually exist', () => {
  for (const locale of LOCALES) {
    const help = CATALOGS[locale]['cli.help'];

    it(`[${locale}] lists exactly ALL_BACKENDS, in order`, () => {
      const values = advertisedValues(help, 'backend');
      expect(values.map((v) => v.id)).toEqual([...ALL_BACKENDS]);
    });

    it(`[${locale}] marks the backend a default-provider run dispatches to`, () => {
      const values = advertisedValues(help, 'backend');
      const defaulted = values.filter((v) => marksDefault(v.note)).map((v) => v.id);
      expect(defaulted).toEqual([providerToBackend(DEFAULT_PROVIDER)]);
    });
  }
});

describe('cli.help names no backend or provider huu removed', () => {
  /**
   * `pi` and `azure` are not free-floating strings: they are precisely the
   * names the help used to advertise which no longer parse. Anything the help
   * offers as a `--provider` / `--backend` value must be resolvable TODAY —
   * the checks above enforce that for the value lists; this one sweeps the
   * whole help for the dead names as standalone words, catching a stray
   * mention in prose (e.g. "the pi backend") that the list checks cannot see.
   */
  const REMOVED = ['pi', 'azure'];

  for (const locale of LOCALES) {
    it(`[${locale}] mentions no removed backend name`, () => {
      const help = CATALOGS[locale]['cli.help'];
      for (const dead of REMOVED) {
        expect(parseProvider(dead), `${dead} is unexpectedly a live provider`).toBeNull();
        expect(
          new RegExp(`(^|[^A-Za-z0-9_-])${dead}([^A-Za-z0-9_-]|$)`, 'i').test(help),
          `cli.help still mentions the removed "${dead}"`,
        ).toBe(false);
      }
    });
  }
});

/**
 * check-metodo.test.ts — pins the ±0.02 ABSOLUTE-tolerance boundary of the
 * test:código ratio check.
 *
 * §1's "razão teste:código" is the ONE row in METODO.md with an ABSOLUTE
 * tolerance instead of the relative one every other row uses (see the
 * comment on TOLERANCE in check-metodo.ts). A diff sitting exactly AT that
 * boundary must PASS — that is the entire point of declaring a tolerance —
 * but `claimed` (parsed from the doc's "0,72") and `actual` (a JS float
 * division rounded via `.toFixed(2)`) are both binary floats, and IEEE-754
 * subtraction of two exactly-representable decimals is not itself exactly
 * representable: `0.74 - 0.72 === 0.020000000000000018`, a few ULPs OVER
 * 0.02. A bare `Math.abs(diff) > 0.02` therefore rejects the very value the
 * tolerance exists to admit. This is the real bug that turned a same-drift
 * (METODO.md said 0,72; the repo measured 0.74 — nominally exactly the
 * declared tolerance) into a red gate.
 */

import { describe, it, expect } from 'vitest';
import { ratioWithinTolerance, RATIO_ABS_TOLERANCE } from './check-metodo.js';

describe('ratioWithinTolerance — the ±0.02 ABSOLUTE boundary', () => {
  it('the underlying float subtraction is NOT exact — this is why the bug existed', () => {
    // Documents the actual IEEE-754 behaviour the fix has to survive.
    expect(Math.abs(0.74 - 0.72)).toBeGreaterThan(RATIO_ABS_TOLERANCE);
    expect(Math.abs(0.74 - 0.72)).not.toBe(RATIO_ABS_TOLERANCE);
  });

  it('ACCEPTS the exact real-world case that broke the gate: doc 0,72 vs real 0.74', () => {
    expect(ratioWithinTolerance(0.72, 0.74)).toBe(true);
  });

  it('ACCEPTS a diff exactly AT the tolerance boundary, symmetrically', () => {
    expect(ratioWithinTolerance(0.5, 0.5 + RATIO_ABS_TOLERANCE)).toBe(true);
    expect(ratioWithinTolerance(0.5 + RATIO_ABS_TOLERANCE, 0.5)).toBe(true);
  });

  it('REJECTS a diff clearly past the tolerance — the epsilon does not mask real drift', () => {
    expect(ratioWithinTolerance(0.72, 0.8)).toBe(false); // 0.08 off
    expect(ratioWithinTolerance(0.5, 0.6)).toBe(false); // 0.10 off
  });

  it('REJECTS a diff just past the boundary (0.03) — the epsilon is float noise, not a loosened tolerance', () => {
    expect(ratioWithinTolerance(0.7, 0.73)).toBe(false); // 0.03 off, well beyond a few ULPs
  });

  it('dies if the fix is reverted: the bare `> RATIO_ABS_TOLERANCE` comparison it replaced rejects this case', () => {
    // This IS the regression pin. It re-runs, inline, the exact comparison
    // that check-metodo.ts used before the fix, over the real-world values
    // — proving the epsilon in ratioWithinTolerance is load-bearing, not
    // decorative. If someone "simplifies" ratioWithinTolerance back to
    // `Math.abs(claimed - actual) <= RATIO_ABS_TOLERANCE` (no epsilon), the
    // next assertion starts failing.
    const claimed = 0.72;
    const actual = 0.74;
    const preFixBareComparisonWouldReject = Math.abs(claimed - actual) > RATIO_ABS_TOLERANCE;
    expect(preFixBareComparisonWouldReject).toBe(true); // the bug, preserved as evidence
    expect(ratioWithinTolerance(claimed, actual)).toBe(true); // the fix
  });
});

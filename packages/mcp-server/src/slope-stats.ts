/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

/**
 * A least-squares slope with its 95% interval, and the three-way verdict a fix
 * check reads off two of them.
 *
 * Every rung of a ladder is a repeated measurement of the same per-cycle rate,
 * so the residuals around the fitted line say how far the slope can be trusted
 * without driving a single extra rung. A two-point slope has no residuals and
 * therefore no interval: it is reported, but never decides a verdict.
 */

export type SlopeFit = {
  slope: number;
  intercept: number;
  r2: number;
  /** Number of points fitted. */
  n: number;
  /** Degrees of freedom of the residuals, n - 2. */
  df: number;
  /** Standard error of the slope; null when there are fewer than 3 points. */
  se: number | null;
  /** 95% interval of the slope; null when `se` is null. */
  lo: number | null;
  hi: number | null;
};

// Two-sided 95% quantiles of Student's t, indexed by degrees of freedom.
// Past 30 the normal 1.96 is within 2% of the exact value.
const T95 = [
  Infinity,
  12.706,
  4.303,
  3.182,
  2.776,
  2.571,
  2.447,
  2.365,
  2.306,
  2.262,
  2.228,
  2.201,
  2.179,
  2.16,
  2.145,
  2.131,
  2.12,
  2.11,
  2.101,
  2.093,
  2.086,
  2.08,
  2.074,
  2.069,
  2.064,
  2.06,
  2.056,
  2.052,
  2.048,
  2.045,
  2.042,
];

export function t95(df: number): number {
  if (!(df >= 1)) return Infinity;
  return df < T95.length ? T95[Math.floor(df)] : 1.96;
}

export function fitSlope(xs: number[], ys: number[]): SlopeFit {
  const n = Math.min(xs.length, ys.length);
  if (n === 0) {
    return {
      slope: 0,
      intercept: 0,
      r2: 1,
      n,
      df: -2,
      se: null,
      lo: null,
      hi: null,
    };
  }
  let meanX = 0;
  let meanY = 0;
  for (let i = 0; i < n; i++) {
    meanX += xs[i] / n;
    meanY += ys[i] / n;
  }
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = meanY - slope * meanX;
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  const df = n - 2;
  if (df < 1 || sxx === 0) {
    return {slope, intercept, r2, n, df, se: null, lo: null, hi: null};
  }
  // syy - slope * sxy is the residual sum of squares; clamp the rounding error
  // of a perfect fit, which can come out a hair below zero.
  const sse = Math.max(0, syy - slope * sxy);
  const se = Math.sqrt(sse / df / sxx);
  const half = t95(df) * se;
  return {slope, intercept, r2, n, df, se, lo: slope - half, hi: slope + half};
}

export type RateVerdict = 'FIX_CONFIRMED' | 'FIX_FALLS_SHORT' | 'INCONCLUSIVE';

export type RateVerdictReason =
  | 'too_few_rungs'
  | 'before_not_growing'
  | 'run_to_run_noise'
  | 'interval_crosses_threshold'
  | null;

export type RateVerdictResult = {
  verdict: RateVerdict;
  /** Why the run is INCONCLUSIVE; null for the other two verdicts. */
  reason: RateVerdictReason;
  /** The largest after-arm rate the expected reduction allows. */
  threshold: number;
  /**
   * For INCONCLUSIVE with an interval: the largest reduction this run can
   * confirm, from the upper end of the after-arm interval, measured against
   * the before arm's fitted rate (the same rate the threshold comes from, so
   * the verdict and this number agree). Null otherwise.
   */
  confirmableReduction: number | null;
};

/**
 * FIX_CONFIRMED: the after arm's whole interval is at or under the allowed residual rate.
 * FIX_FALLS_SHORT: its whole interval is above it, so the fix is measurably short.
 * INCONCLUSIVE: anything else, with the reason.
 *
 * The before arm must itself be shown growing (its interval above zero); a fix
 * cannot be credited with removing growth the run never demonstrated.
 *
 * `repeatSpread` is how far apart two independently driven ladders of the SAME
 * build came out (|slope A - slope A'|). Within-ladder residuals cannot see
 * run-to-run drift, so the after arm's interval is widened by it on both sides,
 * and a spread as large as the reduction under test decides nothing at all.
 */
export function rateVerdict(
  before: SlopeFit,
  after: SlopeFit,
  expectedReduction: number,
  repeatSpread = 0,
): RateVerdictResult {
  const threshold = (1 - expectedReduction) * before.slope;
  if (before.lo == null || after.lo == null || after.hi == null) {
    return {
      verdict: 'INCONCLUSIVE',
      reason: 'too_few_rungs',
      threshold,
      confirmableReduction: null,
    };
  }
  if (before.lo <= 0) {
    return {
      verdict: 'INCONCLUSIVE',
      reason: 'before_not_growing',
      threshold,
      confirmableReduction: null,
    };
  }
  if (repeatSpread > 0 && repeatSpread >= expectedReduction * before.slope) {
    return {
      verdict: 'INCONCLUSIVE',
      reason: 'run_to_run_noise',
      threshold,
      confirmableReduction: null,
    };
  }
  const hi = after.hi + repeatSpread;
  const lo = after.lo - repeatSpread;
  if (hi <= threshold) {
    return {
      verdict: 'FIX_CONFIRMED',
      reason: null,
      threshold,
      confirmableReduction: null,
    };
  }
  if (lo > threshold) {
    return {
      verdict: 'FIX_FALLS_SHORT',
      reason: null,
      threshold,
      confirmableReduction: null,
    };
  }
  return {
    verdict: 'INCONCLUSIVE',
    reason: 'interval_crosses_threshold',
    threshold,
    confirmableReduction: Math.max(0, 1 - hi / before.slope),
  };
}

/**
 * The mean of two independent slopes of the same quantity (one per pair of
 * ladders), with the interval of that mean from both standard errors. Null
 * interval when either fit has none. The intercept is the plain mean of the
 * two, which is not the intercept of any regression; nothing should read it.
 */
export function poolFits(a: SlopeFit, b: SlopeFit): SlopeFit {
  const slope = (a.slope + b.slope) / 2;
  const intercept = (a.intercept + b.intercept) / 2;
  const n = a.n + b.n;
  const df = Math.max(a.df, 0) + Math.max(b.df, 0);
  if (a.se == null || b.se == null) {
    return {
      slope,
      intercept,
      r2: Math.min(a.r2, b.r2),
      n,
      df,
      se: null,
      lo: null,
      hi: null,
    };
  }
  const se = Math.sqrt(a.se * a.se + b.se * b.se) / 2;
  const half = t95(df) * se;
  return {
    slope,
    intercept,
    r2: Math.min(a.r2, b.r2),
    n,
    df,
    se,
    lo: slope - half,
    hi: slope + half,
  };
}

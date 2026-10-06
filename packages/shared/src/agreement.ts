/**
 * Inter-annotator agreement (IAA) statistics.
 *
 * All functions are pure, operate on plain numeric tables and return `null`
 * when a statistic is mathematically undefined (rather than `NaN` or `0`) so
 * callers are forced to handle the degenerate cases explicitly.
 */

/** Contingency table for two raters over `categories`. */
export interface PairwiseTable {
  categories: readonly string[];
  /** `counts[i][j]` = items rater A put in category i, rater B in category j. */
  counts: readonly (readonly number[])[];
}

/** Ratings matrix: `ratings[unit][rater]`. Missing values use `null`. */
export type RatingsMatrix = readonly (readonly (string | null)[])[];

function safeRatio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return numerator / denominator;
}

/**
 * Cohen's kappa for exactly two raters over categorical labels.
 *
 * kappa = (Po - Pe) / (1 - Pe) where Pe is chance agreement.
 * Returns `null` when both raters used a single identical category for every
 * unit, because Pe === 1 there and the ratio is undefined.
 */
export function cohensKappa(table: PairwiseTable): number | null {
  const { categories, counts } = table;
  const k = categories.length;
  if (k === 0) return null;

  const total = counts.reduce(
    (sum, row) => sum + row.reduce((rowSum, cell) => rowSum + cell, 0),
    0,
  );
  if (total === 0) return null;

  const observed = safeRatio(
    counts.reduce((sum, row, i) => sum + (row[i] ?? 0), 0),
    total,
  );
  if (observed === null) return null;

  const rowMarginals = counts.map((row) => row.reduce((a, b) => a + b, 0));
  const colMarginals = new Array<number>(k).fill(0);
  for (const row of counts) {
    for (let j = 0; j < k; j += 1) colMarginals[j] = colMarginals[j]! + (row[j] ?? 0);
  }

  let expected = 0;
  for (let i = 0; i < k; i += 1) {
    expected += ((rowMarginals[i] ?? 0) / total) * ((colMarginals[i] ?? 0) / total);
  }

  if (Math.abs(1 - expected) < 1e-12) return null;
  return (observed - expected) / (1 - expected);
}

/**
 * Fleiss' kappa for any number of raters.
 *
 * `ratings` is one row per unit, each row holding one category per rater.
 * Units must have a constant number of ratings; ragged rows are rejected.
 */
export function fleissKappa(
  ratings: readonly (readonly string[])[],
  categories: readonly string[],
): number | null {
  const usable = ratings.filter((row) => row.length > 0);
  if (usable.length === 0) return null;

  const ratersPerUnit = usable[0]!.length;
  if (usable.some((row) => row.length !== ratersPerUnit)) {
    throw new Error('Fleiss kappa requires a constant number of ratings per unit');
  }
  if (ratersPerUnit < 2) {
    throw new Error('Fleiss kappa requires at least 2 ratings per unit');
  }

  const index = new Map(categories.map((c, i) => [c, i]));
  const k = categories.length;
  if (k === 0) return null;

  const categoryCounts: number[][] = [];
  let totalItems = 0;

  for (const row of usable) {
    const counts = new Array<number>(k).fill(0);
    for (const value of row) {
      const position = index.get(value);
      // An unknown category means the caller and the data disagree; fail loudly.
      if (position === undefined) {
        throw new Error(`Unknown category "${value}" passed to Fleiss kappa`);
      }
      counts[position] = counts[position]! + 1;
    }
    categoryCounts.push(counts);
    totalItems += 1;
  }

  const pBarNumerator = categoryCounts.reduce((sum, counts) => {
    const squares = counts.reduce((acc, c) => acc + c * (c - 1), 0);
    return sum + squares / (ratersPerUnit * (ratersPerUnit - 1));
  }, 0);
  const pBar = safeRatio(pBarNumerator, totalItems);
  if (pBar === null) return null;

  // Fleiss' expected agreement uses the *overall* marginal frequencies:
  //   P_e = (1 / (N*n)^2) * sum_j (sum_i n_ij)^2
  // Averaging squared per-unit proportions (Cohen's style) understates P_e and
  // can drive kappa below -1, so it must not be used here.
  const categoryTotals = new Array<number>(k).fill(0);
  for (const counts of categoryCounts) {
    for (let j = 0; j < k; j += 1) {
      categoryTotals[j] = categoryTotals[j]! + counts[j]!;
    }
  }
  const ratingsTotal = totalItems * ratersPerUnit;
  if (ratingsTotal === 0) return null;

  let pE = 0;
  for (const total of categoryTotals) {
    pE += (total / ratingsTotal) ** 2;
  }

  if (Math.abs(1 - pE) < 1e-12) return null;
  return (pBar - pE) / (1 - pE);
}
/**
 * Krippendorff's alpha with interval difference.
 *
 * Unlike kappa this tolerates missing ratings, so it is the right default for
 * real annotation runs where raters skip items. `ratings` is a matrix with
 * `null` for absent judgements; `categories` provides the value ordering.
 */
export function krippendorffAlpha(
  ratings: RatingsMatrix,
  categories: readonly string[],
): number | null {
  const index = new Map(categories.map((c, i) => [c, i]));
  const matrix = ratings
    .filter((row) => row.some((value) => value !== null))
    .map((row) => row.map((value) => (value === null ? null : (index.get(value) ?? Number.NaN))));

  if (matrix.length === 0) return null;
  if (matrix.some((row) => row.some((value) => value !== null && Number.isNaN(value)))) {
    throw new Error('Unknown category passed to Krippendorff alpha');
  }

  // Coincidence matrix o[c][k] over all (unit, rater) value pairs, weighted by
  // 1/(m-1) per Krippendorff (2004) so units rated by m>2 raters are not
  // over-counted.
  const k = categories.length;
  // Array.from (not `new Array(...)`, which would wrap the rows in a
  // length-1 array) so `coincidence[i][j]` is addressable for every i.
  const coincidence: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));

  for (const row of matrix) {
    const present = row.filter((value): value is number => value !== null);
    const m = present.length;
    if (m < 2) continue;
    // Ordered pairs of *distinct* codings only. A rating never pairs with
    // itself; including p === q would double-count the coincidence diagonal.
    for (let p = 0; p < m; p += 1) {
      for (let q = 0; q < m; q += 1) {
        if (p === q) continue;
        const value = present[p]!;
        const other = present[q]!;
        coincidence[value]![other] = coincidence[value]![other]! + 1 / (m - 1);
      }
    }
  }

  let total = 0;
  for (let i = 0; i < k; i += 1) {
    for (let j = 0; j < k; j += 1) total += coincidence[i]![j]!;
  }
  // Fewer than two pairings means no observed disagreement can be defined.
  if (total < 2) return null;

  let observedDisagreement = 0;
  for (let i = 0; i < k; i += 1) {
    for (let j = 0; j < k; j += 1) {
      observedDisagreement += (i - j) ** 2 * coincidence[i]![j]!;
    }
  }
  observedDisagreement /= total;

  const marginals = new Array<number>(k).fill(0);
  for (let i = 0; i < k; i += 1) {
    for (let j = 0; j < k; j += 1) marginals[i] = marginals[i]! + coincidence[i]![j]!;
  }

  let expectedDisagreement = 0;
  for (let i = 0; i < k; i += 1) {
    for (let j = 0; j < k; j += 1) {
      expectedDisagreement += (i - j) ** 2 * marginals[i]! * marginals[j]!;
    }
  }
  // Expected disagreement draws two codings *without* replacement, so the
  // normaliser is n(n-1) rather than n. `total >= 2` is already guaranteed.
  expectedDisagreement /= total * (total - 1);

  if (expectedDisagreement === 0) return null;
  return 1 - observedDisagreement / expectedDisagreement;
}

/**
 * Landis & Koch interpretation bands for kappa.
 * Included so the API and UI never hard-code their own thresholds.
 */
export type AgreementBand = 'poor' | 'fair' | 'moderate' | 'substantial' | 'almost_perfect';

export function interpretKappa(kappa: number): AgreementBand {
  if (kappa < 0.2) return 'poor';
  if (kappa < 0.4) return 'fair';
  if (kappa < 0.6) return 'moderate';
  if (kappa < 0.8) return 'substantial';
  return 'almost_perfect';
}

/**
 * Percentage agreement: fraction of items where both raters gave identical labels.
 *
 * This is the simplest IAA metric and does not correct for chance agreement,
 * so it should be paired with kappa for a complete picture. Returns `null` when
 * the table is empty.
 */
export function percentageAgreement(table: PairwiseTable): number | null {
  const { counts } = table;
  const total = counts.reduce(
    (sum, row) => sum + row.reduce((rowSum, cell) => rowSum + cell, 0),
    0,
  );
  if (total === 0) return null;

  const agreed = counts.reduce((sum, row, i) => sum + (row[i] ?? 0), 0);
  return safeRatio(agreed, total);
}

/** Jaccard similarity of token sets, used for active-learning diversity. */
export function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const value of a) {
    if (b.has(value)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

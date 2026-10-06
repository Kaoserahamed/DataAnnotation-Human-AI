/**
 * Active-learning item prioritisation.
 *
 * Three independent signals are combined into a single acquisition score used
 * to order the review queue. Keeping them separate (rather than collapsing to
 * one number immediately) is what makes the ranking explainable in the UI.
 */

import { clamp01 } from './comparison.js';
import { jaccardSimilarity } from './agreement.js';

/** Relative weights of the three acquisition signals. Sum to 1. */
export const ACTIVE_LEARNING_WEIGHTS = {
  uncertainty: 0.4,
  disagreement: 0.4,
  diversity: 0.2,
} as const;

export interface AcquisitionSignals {
  /** 1 - max predicted probability. High means the model is unsure. */
  uncertainty: number;
  /** 1 - mean pairwise agreement between independent predictions. */
  disagreement: number;
  /** 1 - mean Jaccard similarity to the labelled centroid. */
  redundancy: number;
}

export interface AcquisitionScores extends AcquisitionSignals {
  /** Weighted composite in [0,1]; higher means "annotate this next". */
  acquisitionScore: number;
  /** 1 - redundancy, so a high value means "representative of the pool". */
  diversity: number;
}

/**
 * Convert raw signals into the composite score.
 *
 * `diversity` is the inverse of redundancy so that all three inputs point in
 * the same direction (more valuable = higher) before weighting.
 */
export function scoreAcquisition(signals: AcquisitionSignals): AcquisitionScores {
  const uncertainty = clamp01(signals.uncertainty);
  const disagreement = clamp01(signals.disagreement);
  const diversity = clamp01(1 - signals.redundancy);
  const acquisitionScore =
    ACTIVE_LEARNING_WEIGHTS.uncertainty * uncertainty +
    ACTIVE_LEARNING_WEIGHTS.disagreement * disagreement +
    ACTIVE_LEARNING_WEIGHTS.diversity * diversity;

  return {
    uncertainty,
    disagreement,
    diversity,
    redundancy: clamp01(signals.redundancy),
    acquisitionScore: clamp01(acquisitionScore),
  };
}

/** Uncertainty from a probability distribution: `1 - max(p)`. */
export function uncertaintyFromDistribution(probabilities: readonly number[]): number {
  if (probabilities.length === 0) return 1;
  const max = probabilities.reduce((a, b) => Math.max(a, b), 0);
  return clamp01(1 - max);
}

/**
 * Mean disagreement across all independent prediction pairs.
 *
 * Accepts pairwise similarities (already in [0,1]) and returns `1 - mean`.
 * Returns `0` when fewer than two predictions exist: with nothing to compare,
 * there is no observed disagreement, and reporting `1` would flood the queue.
 */
export function disagreementFromSimilarities(similarities: readonly number[]): number {
  if (similarities.length === 0) return 0;
  const mean = similarities.reduce((a, b) => a + b, 0) / similarities.length;
  return clamp01(1 - mean);
}

/** Enumerate all unique index pairs from `count` predictions. */
export function allPairs(count: number): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < count; i += 1) {
    for (let j = i + 1; j < count; j += 1) {
      pairs.push([i, j]);
    }
  }
  return pairs;
}

/**
 * Redundancy of `tokens` against a set of already-labelled token sets.
 * Returns `0` (maximally diverse) when the labelled set is empty.
 */
export function redundancyAgainstLabelledPool(
  tokens: ReadonlySet<string>,
  labelledPools: readonly ReadonlySet<string>[],
): number {
  if (labelledPools.length === 0) return 0;
  const similarities = labelledPools.map((pool) => jaccardSimilarity(tokens, pool));
  return similarities.reduce((a, b) => a + b, 0) / similarities.length;
}

/** Stable comparator for queue ordering: highest score first. */
export function compareByAcquisitionScore(
  a: { acquisitionScore: number },
  b: { acquisitionScore: number },
): number {
  return b.acquisitionScore - a.acquisitionScore;
}

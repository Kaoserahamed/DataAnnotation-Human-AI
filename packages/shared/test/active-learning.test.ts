import { describe, expect, it } from 'vitest';
import {
  ACTIVE_LEARNING_WEIGHTS,
  allPairs,
  compareByAcquisitionScore,
  disagreementFromSimilarities,
  redundancyAgainstLabelledPool,
  scoreAcquisition,
  uncertaintyFromDistribution,
} from '../src/active-learning.js';

describe('ACTIVE_LEARNING_WEIGHTS', () => {
  it('sums to 1 so composite scores stay in [0,1]', () => {
    const total =
      ACTIVE_LEARNING_WEIGHTS.uncertainty +
      ACTIVE_LEARNING_WEIGHTS.disagreement +
      ACTIVE_LEARNING_WEIGHTS.diversity;
    expect(total).toBeCloseTo(1, 10);
  });
});

describe('scoreAcquisition', () => {
  it('is 1 when every signal is maximally valuable', () => {
    const scores = scoreAcquisition({
      uncertainty: 1,
      disagreement: 1,
      redundancy: 0,
    });
    expect(scores.acquisitionScore).toBeCloseTo(1, 10);
    expect(scores.diversity).toBe(1);
    expect(scores.redundancy).toBe(0);
  });

  it('is 0 when the model is certain, agrees, and is redundant', () => {
    const scores = scoreAcquisition({
      uncertainty: 0,
      disagreement: 0,
      redundancy: 1,
    });
    expect(scores.acquisitionScore).toBeCloseTo(0, 10);
    expect(scores.diversity).toBe(0);
  });

  it('weights the three signals as configured', () => {
    const scores = scoreAcquisition({ uncertainty: 1, disagreement: 0, redundancy: 1 });
    // diversity = 1 - 1 = 0, so only the uncertainty term contributes.
    expect(scores.acquisitionScore).toBeCloseTo(ACTIVE_LEARNING_WEIGHTS.uncertainty, 10);
  });

  it('clamps out-of-range inputs rather than trusting them', () => {
    const scores = scoreAcquisition({
      uncertainty: 5,
      disagreement: -3,
      redundancy: 2,
    });
    expect(scores.uncertainty).toBe(1);
    expect(scores.disagreement).toBe(0);
    expect(scores.redundancy).toBe(1);
    expect(scores.diversity).toBe(0);
    expect(scores.acquisitionScore).toBeGreaterThanOrEqual(0);
    expect(scores.acquisitionScore).toBeLessThanOrEqual(1);
  });

  it('emits a score bounded in [0,1] for arbitrary valid inputs', () => {
    for (const uncertainty of [0, 0.3, 0.7, 1]) {
      for (const disagreement of [0, 0.5, 1]) {
        for (const redundancy of [0, 0.5, 1]) {
          const { acquisitionScore } = scoreAcquisition({
            uncertainty,
            disagreement,
            redundancy,
          });
          expect(acquisitionScore).toBeGreaterThanOrEqual(0);
          expect(acquisitionScore).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe('uncertaintyFromDistribution', () => {
  it('is 0 for a certain distribution', () => {
    expect(uncertaintyFromDistribution([1, 0, 0])).toBe(0);
  });

  it('is 0.5 for a two-way coin flip', () => {
    expect(uncertaintyFromDistribution([0.5, 0.5])).toBeCloseTo(0.5, 10);
  });

  it('is highest for a uniform distribution', () => {
    const uniform = uncertaintyFromDistribution([0.25, 0.25, 0.25, 0.25]);
    expect(uniform).toBeCloseTo(0.75, 10);
  });

  it('treats an empty distribution as fully uncertain', () => {
    expect(uncertaintyFromDistribution([])).toBe(1);
  });

  it('ignores lower-ranked probabilities when a clear winner exists', () => {
    expect(uncertaintyFromDistribution([0.9, 0.05, 0.05])).toBeCloseTo(0.1, 10);
  });
});

describe('disagreementFromSimilarities', () => {
  it('is 0 only when there are no pairs to compare', () => {
    expect(disagreementFromSimilarities([])).toBe(0);
  });

  it('handles a single pair as one ordinary similarity', () => {
    // One pair with similarity 0.2 -> disagreement 0.8.
    expect(disagreementFromSimilarities([0.2])).toBeCloseTo(0.8, 10);
  });

  it('is 0 when all predictions agree', () => {
    expect(disagreementFromSimilarities([1, 1, 1])).toBe(0);
  });

  it('is 1 when all predictions are maximally different', () => {
    expect(disagreementFromSimilarities([0, 0])).toBe(1);
  });

  it('uses the mean of the pairwise similarities', () => {
    // mean similarity = 0.75 -> disagreement = 0.25
    expect(disagreementFromSimilarities([1, 1, 0.5, 0.5])).toBeCloseTo(0.25, 10);
  });
});

describe('allPairs', () => {
  it('enumerates each unordered pair exactly once', () => {
    expect(allPairs(3)).toEqual([
      [0, 1],
      [0, 2],
      [1, 2],
    ]);
  });

  it('returns nothing for fewer than two predictions', () => {
    expect(allPairs(0)).toEqual([]);
    expect(allPairs(1)).toEqual([]);
  });

  it('produces n(n-1)/2 pairs', () => {
    expect(allPairs(5)).toHaveLength((5 * 4) / 2);
  });
});

describe('redundancyAgainstLabelledPool', () => {
  const tokens = (words: string[]) => new Set(words);

  it('is 0 when the labelled pool is empty', () => {
    expect(redundancyAgainstLabelledPool(tokens(['a']), [])).toBe(0);
  });

  it('is 1 when the item duplicates a labelled example', () => {
    expect(redundancyAgainstLabelledPool(tokens(['a', 'b']), [tokens(['a', 'b'])])).toBe(1);
  });

  it('is 0 when the item shares nothing with the pool', () => {
    expect(redundancyAgainstLabelledPool(tokens(['a']), [tokens(['b'])])).toBe(0);
  });

  it('averages across several labelled examples', () => {
    // Jaccard with {a,b} = 1/3 ; with {b,c} = 1/3 -> mean 1/3
    const result = redundancyAgainstLabelledPool(tokens(['a', 'b']), [
      tokens(['a', 'c']),
      tokens(['b', 'c']),
    ]);
    expect(result).toBeCloseTo(1 / 3, 10);
  });
});

describe('compareByAcquisitionScore', () => {
  it('orders highest score first', () => {
    const items = [{ acquisitionScore: 0.2 }, { acquisitionScore: 0.9 }, { acquisitionScore: 0.5 }];
    expect([...items].sort(compareByAcquisitionScore).map((i) => i.acquisitionScore)).toEqual([
      0.9, 0.5, 0.2,
    ]);
  });
});

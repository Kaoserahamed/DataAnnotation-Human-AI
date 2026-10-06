import { describe, expect, it } from 'vitest';
import {
  cohensKappa,
  fleissKappa,
  interpretKappa,
  jaccardSimilarity,
  krippendorffAlpha,
} from '../src/agreement.js';

describe("Cohen's kappa", () => {
  // 2x2 table:
  //            B:yes  B:no
  //   A:yes       20      5
  //   A:no        10     15
  // Po = 35/50 = 0.7 ; Pe = 0.5*0.6 + 0.5*0.4 = 0.5 ; kappa = 0.4
  const table = {
    categories: ['yes', 'no'],
    counts: [
      [20, 5],
      [10, 15],
    ],
  } as const;

  it('matches the textbook value for a canonical 2x2 table', () => {
    expect(cohensKappa(table)).toBeCloseTo(0.4, 10);
  });

  it('is 1 for perfect agreement with balanced marginals', () => {
    const perfect = {
      categories: ['a', 'b'],
      counts: [
        [10, 0],
        [0, 10],
      ],
    } as const;
    // Po = 1, Pe = 0.5 -> (1-0.5)/(1-0.5) = 1
    expect(cohensKappa(perfect)).toBeCloseTo(1, 10);
  });

  it('is 0 when observed agreement equals chance agreement', () => {
    const chance = {
      categories: ['a', 'b'],
      counts: [
        [5, 5],
        [5, 5],
      ],
    } as const;
    expect(cohensKappa(chance)).toBeCloseTo(0, 10);
  });

  it('goes negative when agreement is worse than chance', () => {
    const worse = {
      categories: ['a', 'b'],
      counts: [
        [5, 15],
        [15, 5],
      ],
    } as const;
    const kappa = cohensKappa(worse);
    expect(kappa).not.toBeNull();
    expect(kappa!).toBeLessThan(0);
  });

  it('returns null when Pe is 1 (both raters used one identical category)', () => {
    const degenerate = {
      categories: ['a'],
      counts: [[4]],
    } as const;
    expect(cohensKappa(degenerate)).toBeNull();
  });

  it('returns null when there are no observations or categories', () => {
    expect(cohensKappa({ categories: [], counts: [] })).toBeNull();
    expect(cohensKappa({ categories: ['a', 'b'], counts: [[0, 0]] })).toBeNull();
  });
});

describe("Fleiss' kappa", () => {
  const categories = ['yes', 'no', 'maybe'];

  it('is 1 when every rater assigns every unit the same category', () => {
    const ratings = [
      ['yes', 'yes', 'yes'],
      ['no', 'no', 'no'],
      ['maybe', 'maybe', 'maybe'],
    ];
    expect(fleissKappa(ratings, categories)).toBeCloseTo(1, 10);
  });

  it('reproduces a hand-computed value', () => {
    // 4 units, 3 raters, 2 categories:
    //  unit1 yes/yes/yes -> P1 = (3*2)/(3*2) = 1
    //  unit2 yes/yes/no  -> P2 = (2*1 + 1*0)/6 = 1/3
    //  unit3 yes/no/no   -> P3 = (1*0 + 2*1)/6 = 1/3
    //  unit4 no/no/no    -> P4 = 1
    // P_bar = (1 + 1/3 + 1/3 + 1)/4 = 2/3
    // Marginal totals: yes = 6, no = 6, ratings = 12
    // P_e = (6/12)^2 + (6/12)^2 = 1/2
    // kappa = (2/3 - 1/2) / (1 - 1/2) = 1/3
    const ratings = [
      ['yes', 'yes', 'yes'],
      ['yes', 'yes', 'no'],
      ['yes', 'no', 'no'],
      ['no', 'no', 'no'],
    ];
    expect(fleissKappa(ratings, ['yes', 'no'])).toBeCloseTo(1 / 3, 10);
  });

  it('is 0 when observed agreement equals chance agreement', () => {
    // P_bar = (1 + 0 + 0 + 1)/4 = 1/2
    // Marginals a = 4, b = 4, ratings = 8 -> P_e = (4/8)^2 + (4/8)^2 = 1/2
    const ratings = [
      ['a', 'a'],
      ['a', 'b'],
      ['a', 'b'],
      ['b', 'b'],
    ];
    expect(fleissKappa(ratings, ['a', 'b'])).toBeCloseTo(0, 10);
  });

  it('reaches -1 when raters never agree', () => {
    // P_bar = 0 while marginals stay balanced at P_e = 1/2.
    const ratings = [
      ['a', 'b'],
      ['b', 'a'],
    ];
    expect(fleissKappa(ratings, ['a', 'b'])).toBeCloseTo(-1, 10);
  });

  it('returns null when P_e equals 1', () => {
    expect(fleissKappa([['a', 'a', 'a']], ['a', 'b'])).toBeNull();
  });

  it('rejects ragged matrices', () => {
    expect(() => fleissKappa([['a', 'b'], ['a']], ['a', 'b'])).toThrow(
      /constant number of ratings/i,
    );
  });

  it('rejects fewer than two raters', () => {
    expect(() => fleissKappa([['a']], ['a', 'b'])).toThrow(/at least 2 ratings/i);
  });

  it('rejects categories absent from the supplied list', () => {
    expect(() => fleissKappa([['a', 'z']], ['a', 'b'])).toThrow(/Unknown category/i);
  });

  it('returns null for an empty matrix', () => {
    expect(fleissKappa([], categories)).toBeNull();
  });
});
describe("Krippendorff's alpha", () => {
  const ordinal = ['low', 'mid', 'high'];

  it('is 1 when all raters assign identical values everywhere', () => {
    const ratings = [
      ['low', 'low', 'low'],
      ['high', 'high', 'high'],
    ];
    expect(krippendorffAlpha(ratings, ordinal)).toBeCloseTo(1, 10);
  });

  it('reproduces a hand-computed interval-difference value', () => {
    // 3 units x 2 raters over {a=0, b=1, c=2}: [a,a], [b,b], [a,b].
    // Coincidence matrix:  o = [[2,1,0],[1,2,0],[0,0,0]]  -> n = 6
    // Observed disagreement Do = (1^2*1 + 1^2*1) / 6 = 1/3
    // Marginals: n_a = 3, n_b = 3, n_c = 0
    // De numerator = (0-1)^2*3*3 + (1-0)^2*3*3 = 18 ; De = 18 / (6*5) = 3/5
    // alpha = 1 - (1/3)/(3/5) = 1 - 5/9 = 4/9
    const ratings = [
      ['a', 'a'],
      ['b', 'b'],
      ['a', 'b'],
    ];
    expect(krippendorffAlpha(ratings, ['a', 'b', 'c'])).toBeCloseTo(4 / 9, 10);
  });

  it('is exactly 0 when observed disagreement equals expected disagreement', () => {
    // 2 units x 2 raters over {a=0, c=2}: [a,a], [a,c].
    // o = [[2,0,1],[0,0,0],[1,0,0]] -> n = 4 ; Do = (4+4)/4 = 2
    // marginals n_a = 3, n_c = 1 ; De = (4*3*1 + 4*1*3) / (4*3) = 24/12 = 2
    // alpha = 1 - 2/2 = 0
    const ratings = [
      ['a', 'a'],
      ['a', 'c'],
    ];
    expect(krippendorffAlpha(ratings, ['a', 'b', 'c'])).toBeCloseTo(0, 10);
  });

  it('tolerates missing ratings rather than throwing', () => {
    const withGaps = [
      ['low', 'low', 'low'],
      ['low', null, 'high'],
      ['high', null, 'high'],
    ];
    const alpha = krippendorffAlpha(withGaps, ordinal);
    expect(alpha).not.toBeNull();
    expect(Number.isFinite(alpha!)).toBe(true);
  });

  it('returns null when there are not enough co-rated values', () => {
    expect(krippendorffAlpha([['low', null]], ordinal)).toBeNull();
    expect(krippendorffAlpha([], ordinal)).toBeNull();
  });

  it('returns null when expected disagreement is zero', () => {
    // Every unit has exactly one rating, so nothing can disagree.
    expect(krippendorffAlpha([['low'], ['high']], ordinal)).toBeNull();
  });

  it('rejects categories absent from the supplied list', () => {
    expect(() => krippendorffAlpha([['low', 'unheard-of']], ordinal)).toThrow(/Unknown category/i);
  });
});

describe('interpretKappa', () => {
  it('maps values onto the Landis & Koch bands', () => {
    expect(interpretKappa(0.1)).toBe('poor');
    expect(interpretKappa(0.3)).toBe('fair');
    expect(interpretKappa(0.5)).toBe('moderate');
    expect(interpretKappa(0.7)).toBe('substantial');
    expect(interpretKappa(0.95)).toBe('almost_perfect');
  });

  it('classifies negative kappa as poor', () => {
    expect(interpretKappa(-0.3)).toBe('poor');
  });
});

describe('jaccardSimilarity', () => {
  it('is 1 for two empty sets', () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(1);
  });

  it('is 0 when exactly one set is empty', () => {
    expect(jaccardSimilarity(new Set(['a']), new Set())).toBe(0);
    expect(jaccardSimilarity(new Set(), new Set(['a']))).toBe(0);
  });

  it('computes intersection over union', () => {
    expect(jaccardSimilarity(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3, 10);
  });

  it('is 1 for identical sets', () => {
    expect(jaccardSimilarity(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
  });
});

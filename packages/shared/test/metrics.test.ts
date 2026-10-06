import { describe, expect, it } from 'vitest';
import {
  calculateAnnotatorMetrics,
  calculatePairwiseAgreement,
  detectOutliers,
  QUALITY_SCORE_WEIGHTS,
  rankAnnotatorsByQuality,
  type AnnotationRecord,
} from '../src/metrics.js';

describe('calculateAnnotatorMetrics', () => {
  const baseRecord = (overrides: Partial<AnnotationRecord> = {}): AnnotationRecord => ({
    annotatorId: 'ann1',
    label: 'class_a',
    timeSpentMs: 1000,
    completedAt: new Date().toISOString(),
    ...overrides,
  });

  it('throws when given an empty array', () => {
    expect(() => calculateAnnotatorMetrics([])).toThrow(
      'calculateAnnotatorMetrics requires at least one record',
    );
  });

  it('throws when records belong to different annotators', () => {
    const records = [baseRecord({ annotatorId: 'ann1' }), baseRecord({ annotatorId: 'ann2' })];
    expect(() => calculateAnnotatorMetrics(records)).toThrow(
      'All records must belong to the same annotator',
    );
  });

  it('calculates basic metrics for a single annotation', () => {
    const metrics = calculateAnnotatorMetrics([baseRecord({ timeSpentMs: 2000 })]);
    expect(metrics.annotatorId).toBe('ann1');
    expect(metrics.totalAnnotations).toBe(1);
    expect(metrics.meanTimeMs).toBe(2000);
    expect(metrics.medianTimeMs).toBe(2000);
    expect(metrics.accuracy).toBeNull();
    expect(metrics.goldCheckCount).toBe(0);
  });

  it('calculates mean and median time correctly', () => {
    const records = [
      baseRecord({ timeSpentMs: 1000 }),
      baseRecord({ timeSpentMs: 2000 }),
      baseRecord({ timeSpentMs: 3000 }),
    ];
    const metrics = calculateAnnotatorMetrics(records);
    expect(metrics.meanTimeMs).toBe(2000);
    expect(metrics.medianTimeMs).toBe(2000);
  });

  it('handles even-length arrays for median', () => {
    const records = [
      baseRecord({ timeSpentMs: 1000 }),
      baseRecord({ timeSpentMs: 2000 }),
      baseRecord({ timeSpentMs: 3000 }),
      baseRecord({ timeSpentMs: 4000 }),
    ];
    const metrics = calculateAnnotatorMetrics(records);
    expect(metrics.medianTimeMs).toBe(2500); // (2000 + 3000) / 2
  });

  it('filters out zero or negative times from calculations', () => {
    const records = [
      baseRecord({ timeSpentMs: 0 }),
      baseRecord({ timeSpentMs: -100 }),
      baseRecord({ timeSpentMs: 2000 }),
    ];
    const metrics = calculateAnnotatorMetrics(records);
    expect(metrics.meanTimeMs).toBe(2000);
    expect(metrics.medianTimeMs).toBe(2000);
  });

  it('calculates velocity as annotations per hour', () => {
    const now = Date.now();
    const records = [
      baseRecord({ completedAt: new Date(now).toISOString() }),
      baseRecord({ completedAt: new Date(now + 60 * 60 * 1000).toISOString() }), // 1 hour later
    ];
    const metrics = calculateAnnotatorMetrics(records);
    expect(metrics.annotationsPerHour).toBe(2);
  });

  it('returns zero velocity when all annotations are at the same time', () => {
    const now = new Date().toISOString();
    const records = [baseRecord({ completedAt: now }), baseRecord({ completedAt: now })];
    const metrics = calculateAnnotatorMetrics(records);
    expect(metrics.annotationsPerHour).toBe(0);
  });

  it('calculates accuracy from gold checks', () => {
    const records = [
      baseRecord({ correct: true }),
      baseRecord({ correct: true }),
      baseRecord({ correct: false }),
      baseRecord({ correct: true }),
    ];
    const metrics = calculateAnnotatorMetrics(records);
    expect(metrics.accuracy).toBe(0.75);
    expect(metrics.goldCheckCount).toBe(4);
  });

  it('returns null accuracy when no gold checks are available', () => {
    const records = [baseRecord(), baseRecord()];
    const metrics = calculateAnnotatorMetrics(records);
    expect(metrics.accuracy).toBeNull();
    expect(metrics.goldCheckCount).toBe(0);
  });

  it('excludes annotations without correct field from gold checks', () => {
    const records = [
      baseRecord({ correct: true }),
      baseRecord(), // No correct field
      baseRecord({ correct: false }),
    ];
    const metrics = calculateAnnotatorMetrics(records);
    expect(metrics.accuracy).toBe(0.5);
    expect(metrics.goldCheckCount).toBe(2);
  });
});

describe('rankAnnotatorsByQuality', () => {
  it('returns empty array for empty input', () => {
    expect(rankAnnotatorsByQuality([])).toEqual([]);
  });

  it('ranks annotators by composite quality score', () => {
    const metrics = [
      {
        annotatorId: 'slow_accurate',
        totalAnnotations: 10,
        annotationsPerHour: 5,
        meanTimeMs: 1000,
        medianTimeMs: 1000,
        accuracy: 0.95,
        goldCheckCount: 10,
      },
      {
        annotatorId: 'fast_inaccurate',
        totalAnnotations: 100,
        annotationsPerHour: 50,
        meanTimeMs: 500,
        medianTimeMs: 500,
        accuracy: 0.6,
        goldCheckCount: 50,
      },
      {
        annotatorId: 'balanced',
        totalAnnotations: 50,
        annotationsPerHour: 25,
        meanTimeMs: 750,
        medianTimeMs: 750,
        accuracy: 0.85,
        goldCheckCount: 30,
      },
    ];

    const ranked = rankAnnotatorsByQuality(metrics);
    expect(ranked).toHaveLength(3);
    // Quality score weights accuracy (0.7) more than velocity (0.3)
    // slow_accurate: 0.7 * 0.95 + 0.3 * (5/50) = 0.665 + 0.03 = 0.695
    // balanced: 0.7 * 0.85 + 0.3 * (25/50) = 0.595 + 0.15 = 0.745
    // fast_inaccurate: 0.7 * 0.6 + 0.3 * 1.0 = 0.42 + 0.3 = 0.72
    
    // So balanced should rank first, fast_inaccurate second, slow_accurate third
    expect(ranked[0]!.annotatorId).toBe('balanced');
    expect(ranked[1]!.annotatorId).toBe('fast_inaccurate');
    expect(ranked[2]!.annotatorId).toBe('slow_accurate');
  });

  it('weights accuracy and velocity according to configured weights', () => {
    const metrics = [
      {
        annotatorId: 'perfect_slow',
        totalAnnotations: 10,
        annotationsPerHour: 10, // Will be normalized to 0.5
        meanTimeMs: 1000,
        medianTimeMs: 1000,
        accuracy: 1.0,
        goldCheckCount: 10,
      },
    ];

    const ranked = rankAnnotatorsByQuality(metrics);
    // Quality = 0.7 * 1.0 + 0.3 * 1.0 = 1.0 (since it's the fastest, normalized velocity = 1)
    expect(ranked[0]!.qualityScore).toBeCloseTo(1.0, 5);
  });

  it('defaults accuracy to 0.5 when no gold checks are available', () => {
    const metrics = [
      {
        annotatorId: 'no_gold',
        totalAnnotations: 10,
        annotationsPerHour: 10,
        meanTimeMs: 1000,
        medianTimeMs: 1000,
        accuracy: null,
        goldCheckCount: 0,
      },
    ];

    const ranked = rankAnnotatorsByQuality(metrics);
    // Quality = 0.7 * 0.5 + 0.3 * 1.0 = 0.65
    expect(ranked[0]!.qualityScore).toBeCloseTo(0.65, 5);
  });

  it('normalizes velocity by the maximum velocity', () => {
    const metrics = [
      {
        annotatorId: 'fastest',
        totalAnnotations: 100,
        annotationsPerHour: 100,
        meanTimeMs: 100,
        medianTimeMs: 100,
        accuracy: 0.8,
        goldCheckCount: 50,
      },
      {
        annotatorId: 'slowest',
        totalAnnotations: 10,
        annotationsPerHour: 10,
        meanTimeMs: 1000,
        medianTimeMs: 1000,
        accuracy: 0.8,
        goldCheckCount: 10,
      },
    ];

    const ranked = rankAnnotatorsByQuality(metrics);
    // Fastest: 0.7 * 0.8 + 0.3 * 1.0 = 0.86
    // Slowest: 0.7 * 0.8 + 0.3 * 0.1 = 0.59
    expect(ranked[0]!.qualityScore).toBeGreaterThan(ranked[1]!.qualityScore);
  });
});

describe('detectOutliers', () => {
  it('returns empty arrays when there are fewer than 4 annotators', () => {
    const metrics = [
      {
        annotatorId: 'ann1',
        totalAnnotations: 10,
        annotationsPerHour: 10,
        meanTimeMs: 1000,
        medianTimeMs: 1000,
        accuracy: 0.8,
        goldCheckCount: 10,
      },
    ];

    const outliers = detectOutliers(metrics);
    expect(outliers.lowAccuracy).toEqual([]);
    expect(outliers.lowVelocity).toEqual([]);
  });

  it('detects low accuracy outliers using IQR method', () => {
    const metrics = [
      { ...baseMetrics('ann1'), accuracy: 0.95 },
      { ...baseMetrics('ann2'), accuracy: 0.90 },
      { ...baseMetrics('ann3'), accuracy: 0.85 },
      { ...baseMetrics('ann4'), accuracy: 0.88 },
      { ...baseMetrics('ann5'), accuracy: 0.50 }, // Outlier
    ];

    const outliers = detectOutliers(metrics);
    expect(outliers.lowAccuracy).toContain('ann5');
  });

  it('detects low velocity outliers using IQR method', () => {
    const metrics = [
      { ...baseMetrics('ann1'), annotationsPerHour: 50 },
      { ...baseMetrics('ann2'), annotationsPerHour: 48 },
      { ...baseMetrics('ann3'), annotationsPerHour: 45 },
      { ...baseMetrics('ann4'), annotationsPerHour: 47 },
      { ...baseMetrics('ann5'), annotationsPerHour: 10 }, // Outlier
    ];

    const outliers = detectOutliers(metrics);
    expect(outliers.lowVelocity).toContain('ann5');
  });

  it('handles annotators without gold checks when detecting accuracy outliers', () => {
    const metrics = [
      { ...baseMetrics('ann1'), accuracy: 0.9, goldCheckCount: 10 },
      { ...baseMetrics('ann2'), accuracy: 0.85, goldCheckCount: 10 },
      { ...baseMetrics('ann3'), accuracy: null, goldCheckCount: 0 }, // No gold checks
      { ...baseMetrics('ann4'), accuracy: 0.88, goldCheckCount: 10 },
      { ...baseMetrics('ann5'), accuracy: 0.87, goldCheckCount: 10 },
    ];

    const outliers = detectOutliers(metrics);
    // ann3 should not appear in low accuracy because it has no gold checks
    expect(outliers.lowAccuracy).not.toContain('ann3');
  });

  function baseMetrics(id: string) {
    return {
      annotatorId: id,
      totalAnnotations: 100,
      annotationsPerHour: 50,
      meanTimeMs: 1000,
      medianTimeMs: 1000,
      accuracy: 0.8,
      goldCheckCount: 50,
    };
  }
});

describe('calculatePairwiseAgreement', () => {
  const record = (
    annotatorId: string,
    itemId: string,
    label: unknown,
  ): AnnotationRecord & { itemId: string } => ({
    annotatorId,
    itemId,
    label,
    timeSpentMs: 1000,
    completedAt: new Date().toISOString(),
  });

  const exactEquals = (a: unknown, b: unknown) => a === b;

  it('returns empty array when there are no pairs', () => {
    const records = [record('ann1', 'item1', 'a')];
    const pairs = calculatePairwiseAgreement(records, exactEquals);
    expect(pairs).toEqual([]);
  });

  it('calculates agreement for two annotators on overlapping items', () => {
    const records = [
      record('ann1', 'item1', 'a'),
      record('ann2', 'item1', 'a'),
      record('ann1', 'item2', 'b'),
      record('ann2', 'item2', 'c'),
    ];

    const pairs = calculatePairwiseAgreement(records, exactEquals);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({
      annotator1: 'ann1',
      annotator2: 'ann2',
      overlap: 2,
      agreementRate: 0.5,
    });
  });

  it('only counts items both annotators labeled', () => {
    const records = [
      record('ann1', 'item1', 'a'),
      record('ann2', 'item1', 'a'),
      record('ann1', 'item2', 'b'), // Only ann1
      record('ann2', 'item3', 'c'), // Only ann2
    ];

    const pairs = calculatePairwiseAgreement(records, exactEquals);
    expect(pairs[0]!.overlap).toBe(1);
  });

  it('sorts pairs by agreement rate ascending', () => {
    const records = [
      record('ann1', 'item1', 'a'),
      record('ann2', 'item1', 'a'),
      record('ann3', 'item1', 'b'),
      record('ann1', 'item2', 'b'),
      record('ann2', 'item2', 'b'),
      record('ann3', 'item2', 'b'),
    ];

    const pairs = calculatePairwiseAgreement(records, exactEquals);
    // ann1-ann2: 2/2 = 1.0
    // ann1-ann3: 1/2 = 0.5
    // ann2-ann3: 1/2 = 0.5
    expect(pairs[0]!.agreementRate).toBeLessThanOrEqual(pairs[1]!.agreementRate);
    expect(pairs[1]!.agreementRate).toBeLessThanOrEqual(pairs[2]!.agreementRate);
  });

  it('handles three or more annotators', () => {
    const records = [
      record('ann1', 'item1', 'a'),
      record('ann2', 'item1', 'a'),
      record('ann3', 'item1', 'a'),
    ];

    const pairs = calculatePairwiseAgreement(records, exactEquals);
    expect(pairs).toHaveLength(3); // C(3,2) = 3 pairs
    expect(pairs.every((p) => p.agreementRate === 1)).toBe(true);
  });

  it('uses the provided equality function', () => {
    const fuzzyEquals = (a: unknown, b: unknown) => {
      if (typeof a === 'string' && typeof b === 'string') {
        return a.toLowerCase() === b.toLowerCase();
      }
      return a === b;
    };

    const records = [
      record('ann1', 'item1', 'Cat'),
      record('ann2', 'item1', 'cat'),
    ];

    const pairs = calculatePairwiseAgreement(records, fuzzyEquals);
    expect(pairs[0]!.agreementRate).toBe(1);
  });
});

describe('QUALITY_SCORE_WEIGHTS', () => {
  it('sums to 1 for proper normalization', () => {
    const sum = QUALITY_SCORE_WEIGHTS.accuracy + QUALITY_SCORE_WEIGHTS.velocity;
    expect(sum).toBeCloseTo(1, 10);
  });
});

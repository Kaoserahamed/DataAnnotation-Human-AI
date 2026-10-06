/**
 * Annotator performance metrics.
 *
 * Provides pure functions to calculate accuracy, velocity, and quality scores
 * for individual annotators. All metrics are computed over plain data structures
 * so they can be unit-tested without database access.
 */

export interface AnnotationRecord {
  annotatorId: string;
  label: unknown;
  /** Time spent on this annotation in milliseconds. */
  timeSpentMs: number;
  /** Whether this was later verified to be correct (gold standard comparison). */
  correct?: boolean;
  /** ISO timestamp. */
  completedAt: string;
}

export interface AnnotatorMetrics {
  annotatorId: string;
  /** Total number of annotations completed. */
  totalAnnotations: number;
  /** Annotations per hour (velocity). */
  annotationsPerHour: number;
  /** Mean time per annotation in milliseconds. */
  meanTimeMs: number;
  /** Median time per annotation in milliseconds. */
  medianTimeMs: number;
  /** Accuracy against gold standard (0..1), or null if no gold checks available. */
  accuracy: number | null;
  /** Number of gold standard checks available for this annotator. */
  goldCheckCount: number;
}

/**
 * Calculate comprehensive metrics for one annotator.
 *
 * `records` must be filtered to the target annotator before calling; this
 * function does not group by annotatorId internally.
 */
export function calculateAnnotatorMetrics(records: readonly AnnotationRecord[]): AnnotatorMetrics {
  if (records.length === 0) {
    throw new Error('calculateAnnotatorMetrics requires at least one record');
  }

  const annotatorId = records[0]!.annotatorId;
  if (!records.every((r) => r.annotatorId === annotatorId)) {
    throw new Error('All records must belong to the same annotator');
  }

  const totalAnnotations = records.length;
  const times = records.map((r) => r.timeSpentMs).filter((t) => t > 0);
  const meanTimeMs = times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length : 0;
  const medianTimeMs = times.length > 0 ? median(times) : 0;

  // Velocity calculation: annotations per hour over the time span covered
  const timestamps = records.map((r) => new Date(r.completedAt).getTime());
  const earliest = Math.min(...timestamps);
  const latest = Math.max(...timestamps);
  const spanHours = (latest - earliest) / (1000 * 60 * 60);
  const annotationsPerHour = spanHours > 0 ? totalAnnotations / spanHours : 0;

  // Accuracy: fraction of gold checks that matched
  const goldChecks = records.filter((r) => r.correct !== undefined);
  const accuracy =
    goldChecks.length > 0
      ? goldChecks.filter((r) => r.correct === true).length / goldChecks.length
      : null;

  return {
    annotatorId,
    totalAnnotations,
    annotationsPerHour,
    meanTimeMs,
    medianTimeMs,
    accuracy,
    goldCheckCount: goldChecks.length,
  };
}

/** Median of a numeric array (mutates the input for efficiency). */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  if (values.length % 2 === 0) {
    return (values[mid - 1]! + values[mid]!) / 2;
  }
  return values[mid]!;
}

/**
 * Rank annotators by composite quality score.
 *
 * Higher score = better performer. Weights accuracy heavily but also considers
 * velocity so that a perfect but slow annotator doesn't dominate a fast,
 * nearly-perfect one.
 */
export interface RankedAnnotator {
  annotatorId: string;
  qualityScore: number;
  metrics: AnnotatorMetrics;
}

export const QUALITY_SCORE_WEIGHTS = {
  /** Accuracy contribution (0..1 scale). */
  accuracy: 0.7,
  /** Velocity contribution (normalized by max). */
  velocity: 0.3,
} as const;

export function rankAnnotatorsByQuality(
  allMetrics: readonly AnnotatorMetrics[],
): RankedAnnotator[] {
  if (allMetrics.length === 0) return [];

  const maxVelocity = Math.max(...allMetrics.map((m) => m.annotationsPerHour));

  const ranked = allMetrics.map((metrics) => {
    const accuracyScore = metrics.accuracy ?? 0.5; // Default to neutral if no gold checks
    const velocityScore = maxVelocity > 0 ? metrics.annotationsPerHour / maxVelocity : 0;
    const qualityScore =
      QUALITY_SCORE_WEIGHTS.accuracy * accuracyScore +
      QUALITY_SCORE_WEIGHTS.velocity * velocityScore;

    return {
      annotatorId: metrics.annotatorId,
      qualityScore,
      metrics,
    };
  });

  ranked.sort((a, b) => b.qualityScore - a.qualityScore);
  return ranked;
}

/**
 * Detect outlier annotators (unusually slow or inaccurate).
 *
 * Uses interquartile range (IQR) method: values below Q1 - 1.5*IQR are flagged.
 * Returns annotator IDs that fall into the low-accuracy or low-velocity outlier
 * regions.
 */
export interface OutlierDetection {
  lowAccuracy: string[];
  lowVelocity: string[];
}

export function detectOutliers(allMetrics: readonly AnnotatorMetrics[]): OutlierDetection {
  if (allMetrics.length < 4) {
    // Too few annotators to meaningfully detect outliers
    return { lowAccuracy: [], lowVelocity: [] };
  }

  const withGoldChecks = allMetrics.filter((m) => m.accuracy !== null);
  const accuracies = withGoldChecks.map((m) => m.accuracy!);
  const velocities = allMetrics.map((m) => m.annotationsPerHour);

  const lowAccuracy =
    accuracies.length >= 4
      ? withGoldChecks
          .filter((m) => m.accuracy! < lowerOutlierThreshold(accuracies))
          .map((m) => m.annotatorId)
      : [];

  const lowVelocity =
    velocities.length >= 4
      ? allMetrics
          .filter((m) => m.annotationsPerHour < lowerOutlierThreshold(velocities))
          .map((m) => m.annotatorId)
      : [];

  return { lowAccuracy, lowVelocity };
}

function lowerOutlierThreshold(values: number[]): number {
  if (values.length < 4) return Number.NEGATIVE_INFINITY;
  const sorted = [...values].sort((a, b) => a - b);
  const q1Index = Math.floor(sorted.length / 4);
  const q3Index = Math.floor((3 * sorted.length) / 4);
  const q1 = sorted[q1Index]!;
  const q3 = sorted[q3Index]!;
  const iqr = q3 - q1;
  return q1 - 1.5 * iqr;
}

/**
 * Agreement rate between a pair of annotators over items they both labeled.
 *
 * Useful for identifying consistently disagreeing pairs who may need
 * calibration or additional training.
 */
export interface PairwiseAgreementRate {
  annotator1: string;
  annotator2: string;
  /** Number of items both labeled. */
  overlap: number;
  /** Fraction of overlapping items where they agreed. */
  agreementRate: number;
}

export function calculatePairwiseAgreement(
  records: readonly AnnotationRecord[],
  labelEquals: (a: unknown, b: unknown) => boolean,
): PairwiseAgreementRate[] {
  const byItem = new Map<string, Map<string, unknown>>();

  // Group records by item (assuming records have an implicit item association)
  for (const record of records) {
    const itemId = (record as AnnotationRecord & { itemId?: string }).itemId ?? 'unknown';
    if (!byItem.has(itemId)) {
      byItem.set(itemId, new Map());
    }
    byItem.get(itemId)!.set(record.annotatorId, record.label);
  }

  const annotators = [...new Set(records.map((r) => r.annotatorId))];
  const pairs: PairwiseAgreementRate[] = [];

  for (let i = 0; i < annotators.length; i += 1) {
    for (let j = i + 1; j < annotators.length; j += 1) {
      const a1 = annotators[i]!;
      const a2 = annotators[j]!;

      let overlap = 0;
      let agreed = 0;

      for (const labels of byItem.values()) {
        if (labels.has(a1) && labels.has(a2)) {
          overlap += 1;
          if (labelEquals(labels.get(a1), labels.get(a2))) {
            agreed += 1;
          }
        }
      }

      if (overlap > 0) {
        pairs.push({
          annotator1: a1,
          annotator2: a2,
          overlap,
          agreementRate: agreed / overlap,
        });
      }
    }
  }

  return pairs.sort((a, b) => a.agreementRate - b.agreementRate);
}

/**
 * Quality-control sampling and gold-question injection.
 *
 * Sampling is deterministic given a seed so that a QC batch is reproducible and
 * auditable: the same seed and candidate set always yield the same sample.
 */

import { PIPELINE_THRESHOLDS } from './workflow.js';

/** xorshift32 — small, fast, and deterministic across platforms. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

export interface QcCandidate {
  itemId: string;
  /** 0..1; higher means more likely to be wrong. */
  riskScore: number;
  /** Already has an open QC sample. */
  sampled?: boolean;
}

export interface QcSampleSelection {
  selected: string[];
  randomCount: number;
  riskCount: number;
  /** Candidates skipped because they already had an open sample. */
  skippedExisting: string[];
}

/**
 * Select a QC sample of `size` items from `candidates`.
 *
 * A fixed fraction (`qcRandomFraction`) is drawn uniformly so that QC still
 * covers easy, low-risk items and the metric cannot be gamed by making every
 * item look risky. The remainder is taken from the highest-risk candidates.
 */
export function selectQcSample(
  candidates: readonly QcCandidate[],
  size: number,
  seed: number,
  randomFraction: number = PIPELINE_THRESHOLDS.qcRandomFraction,
): QcSampleSelection {
  if (size <= 0 || candidates.length === 0) {
    return { selected: [], randomCount: 0, riskCount: 0, skippedExisting: [] };
  }

  const available = candidates.filter((c) => !c.sampled);
  const skippedExisting = candidates.filter((c) => c.sampled).map((c) => c.itemId);

  if (available.length === 0) {
    return { selected: [], randomCount: 0, riskCount: 0, skippedExisting };
  }

  const target = Math.min(size, available.length);
  const randomTarget = Math.min(Math.round(target * randomFraction), available.length);

  const random = shuffleDeterministic(available, seed).slice(0, randomTarget);
  const randomIds = new Set(random.map((c) => c.itemId));

  // Highest risk first; ties broken by itemId so ordering is fully stable.
  const byRisk = [...available]
    .filter((c) => !randomIds.has(c.itemId))
    .sort((a, b) => b.riskScore - a.riskScore || a.itemId.localeCompare(b.itemId));

  const risk = byRisk.slice(0, target - random.length);

  return {
    selected: [...random.map((c) => c.itemId), ...risk.map((c) => c.itemId)],
    randomCount: random.length,
    riskCount: risk.length,
    skippedExisting,
  };
}

function shuffleDeterministic<T>(items: readonly T[], seed: number): T[] {
  const copy = [...items];
  const random = seededRandom(seed);
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const a = copy[i]!;
    const b = copy[j]!;
    copy[i] = b;
    copy[j] = a;
  }
  return copy;
}

export interface GoldInjectionPlan {
  goldItemIds: string[];
  /** Position in the presented batch at which each gold item appears. */
  insertionPoints: number[];
}

/**
 * Plan where gold-standard questions are injected into a batch.
 *
 * Spacing them evenly means an annotator cannot simply answer every 5th item
 * from memory of the pattern, and the count is capped by the configured rate.
 */
export function planGoldInjection(
  availableGoldItemIds: readonly string[],
  batchSize: number,
  seed: number,
  rate: number = PIPELINE_THRESHOLDS.goldCheckInjectionRate,
): GoldInjectionPlan {
  if (availableGoldItemIds.length === 0 || batchSize <= 0) {
    return { goldItemIds: [], insertionPoints: [] };
  }

  const desired = Math.max(1, Math.round(batchSize * rate));
  const count = Math.min(desired, availableGoldItemIds.length, batchSize);

  const pool = shuffleDeterministic(availableGoldItemIds, seed).slice(0, count);
  const step = batchSize / count;

  const insertionPoints = Array.from({ length: count }, (_, i) =>
    Math.min(batchSize - 1, Math.floor(i * step + step / 2)),
  );

  return { goldItemIds: pool, insertionPoints };
}

export interface GoldCheckResult {
  itemId: string;
  expected: string;
  actual: string;
  correct: boolean;
}

/** Accuracy of an annotator against injected gold questions, in [0,1]. */
export function scoreGoldChecks(results: readonly GoldCheckResult[]): number | null {
  if (results.length === 0) return null;
  const correct = results.filter((r) => r.correct).length;
  return correct / results.length;
}

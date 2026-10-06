/**
 * Label comparison primitives.
 *
 * These define what "the same label" means per modality. Everything upstream
 * (disagreement detection, inter-annotator agreement, AI acceptance) is built
 * on these functions, so the thresholds live here as named constants rather
 * than as magic numbers sprinkled through services.
 */

import type { BoundingBox, LabelPayload, NamedEntity, Polygon } from './labels.js';
import type { TaskType } from './task-types.js';

/** Bounding boxes at or above this IoU are considered the same object. */
export const IOU_MATCH_THRESHOLD = 0.5;
/** Segmentation polygons overlap at or above this ratio to be "the same region". */
export const POLYGON_MATCH_THRESHOLD = 0.5;
/** Character span match ratio at or above which two entities are considered equal. */
export const SPAN_MATCH_THRESHOLD = 0.5;

export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Intersection over union of two normalized axis-aligned boxes. */
export function boundingBoxIou(a: BoundingBox, b: BoundingBox): number {
  const ax2 = a.x + a.width;
  const ay2 = a.y + a.height;
  const bx2 = b.x + b.width;
  const by2 = b.y + b.height;

  const interWidth = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x));
  const interHeight = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y));
  const intersection = interWidth * interHeight;

  const union = a.width * a.height + b.width * b.height - intersection;
  if (union <= 0) return 0;
  return clamp01(intersection / union);
}

/**
 * Greedy one-to-one matching between two geometry sets.
 *
 * Candidates are considered highest-overlap first and each prediction may be
 * matched at most once, so `m = 0, n = 0` scores 1.0 rather than NaN.
 */
function greedyMatchScore(
  left: readonly { label: string }[],
  right: readonly { label: string }[],
  score: (a: never, b: never) => number,
  threshold: number,
): number {
  if (left.length === 0 && right.length === 0) return 1;
  if (left.length === 0 || right.length === 0) return 0;

  const pairs: Array<{ i: number; j: number; score: number }> = [];
  for (const [i, a] of left.entries()) {
    for (const [j, b] of right.entries()) {
      if (a.label !== b.label) continue;
      pairs.push({ i, j, score: score(a as never, b as never) });
    }
  }
  pairs.sort((p, q) => q.score - p.score);

  const usedLeft = new Set<number>();
  const usedRight = new Set<number>();
  let matched = 0;
  for (const pair of pairs) {
    if (pair.score < threshold) break;
    if (usedLeft.has(pair.i) || usedRight.has(pair.j)) continue;
    usedLeft.add(pair.i);
    usedRight.add(pair.j);
    matched += 1;
  }

  // Symmetric F1-style score against both sets, guarding the 0/0 case.
  const denominator = left.length + right.length;
  return denominator === 0 ? 1 : clamp01((2 * matched) / denominator);
}

export function matchBoundingBoxes(
  a: readonly BoundingBox[],
  b: readonly BoundingBox[],
  threshold: number = IOU_MATCH_THRESHOLD,
): number {
  return greedyMatchScore(a, b, boundingBoxIou, threshold);
}

/** Absolute difference between unit-area polygon centroids, scaled to [0,1]. */
function centroidDistance(a: Polygon, b: Polygon): number {
  const centroid = (p: Polygon): [number, number] => {
    let sx = 0;
    let sy = 0;
    for (const [x, y] of p.points) {
      sx += x;
      sy += y;
    }
    const n = p.points.length || 1;
    return [sx / n, sy / n];
  };
  const [ax, ay] = centroid(a);
  const [bx, by] = centroid(b);
  // Max possible separation in normalized space is sqrt(2).
  return Math.min(1, Math.hypot(ax - bx, ay - by) / Math.SQRT2);
}

/** Approximate region overlap: 1 - normalized centroid distance. */
export function polygonOverlap(a: Polygon, b: Polygon): number {
  return clamp01(1 - centroidDistance(a, b));
}

export function matchPolygons(
  a: readonly Polygon[],
  b: readonly Polygon[],
  threshold: number = POLYGON_MATCH_THRESHOLD,
): number {
  return greedyMatchScore(a, b, polygonOverlap, threshold);
}

/** Normalised Levenshtein similarity in [0,1] between two entity spans. */
export function spanSimilarity(a: NamedEntity, b: NamedEntity): number {
  if (a.label !== b.label) return 0;
  const distance = levenshteinString(a.text.toLowerCase(), b.text.toLowerCase());
  const longest = Math.max(a.text.length, b.text.length);
  if (longest === 0) return 1;
  return clamp01(1 - distance / longest);
}

export function matchEntities(
  a: readonly NamedEntity[],
  b: readonly NamedEntity[],
  threshold: number = SPAN_MATCH_THRESHOLD,
): number {
  return greedyMatchScore(a, b, spanSimilarity, threshold);
}
/** Word error rate for transcript comparison (0 = perfect, may exceed 1). */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const ref = tokenizeWords(reference);
  const hyp = tokenizeWords(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  return levenshtein(ref, hyp) / ref.length;
}

export function tokenizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/** Generic Levenshtein edit distance over strings or token arrays. */
export function levenshtein<T>(a: readonly T[], b: readonly T[]): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array<number>(b.length + 1);
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      const insertion = current[j - 1]! + 1;
      const deletion = previous[j]! + 1;
      current[j] = Math.min(substitution, insertion, deletion);
    }
    previous = current;
  }
  return previous[b.length]!;
}

export function levenshteinString(a: string, b: string): number {
  return levenshtein([...a], [...b]);
}
/**
 * Similarity in [0,1] between two label payloads of the same modality.
 * `1` means "the same answer", `0` means "unrelated".
 */
export function labelSimilarity(taskType: TaskType, a: LabelPayload, b: LabelPayload): number {
  switch (taskType) {
    case 'text_classification':
    case 'sentiment':
    case 'audio_translation':
    case 'document_annotation': {
      const left = (a as { label: { label: string } }).label.label;
      const right = (b as { label: { label: string } }).label.label;
      return left === right ? 1 : 0;
    }
    case 'image_bbox':
      return matchBoundingBoxes(
        (a as { label: BoundingBox[] }).label,
        (b as { label: BoundingBox[] }).label,
      );
    case 'image_segmentation':
      return matchPolygons((a as { label: Polygon[] }).label, (b as { label: Polygon[] }).label);
    case 'ner':
      return matchEntities(
        (a as { label: NamedEntity[] }).label,
        (b as { label: NamedEntity[] }).label,
      );
    case 'audio_transcription': {
      const left = (a as { label: Array<{ text: string }> }).label.map((s) => s.text).join(' ');
      const right = (b as { label: Array<{ text: string }> }).label.map((s) => s.text).join(' ');
      return clamp01(1 - wordErrorRate(left, right));
    }
    default: {
      // Compile-time exhaustiveness: adding a task type forces a case here.
      const exhaustive: never = taskType;
      return exhaustive;
    }
  }
}

/**
 * Whether two independent labels constitute *disagreement*.
 * Exact match for categorical tasks; tolerance-based for structured modalities
 * so that a small box nudge does not raise a false alarm.
 */
export function labelsDisagree(taskType: TaskType, a: LabelPayload, b: LabelPayload): boolean {
  return labelSimilarity(taskType, a, b) < 1;
}

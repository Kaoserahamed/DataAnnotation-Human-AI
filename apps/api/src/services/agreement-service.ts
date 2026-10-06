
export interface AgreementReport {
  datasetId: string;
  unitsConsidered: number;
  ratingsConsidered: number;
  categoryCount: number;
  exactAgreementRate: number | null;
  meanPairwiseSimilarity: number | null;
  disagreementRate: number | null;
  cohensKappa: number | null;
  fleissKappa: number | null;
  krippendorffAlpha: number | null;
  band: AgreementBand | null;
}

function pairIndices(count: number): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < count; i += 1) {
    for (let j = i + 1; j < count; j += 1) pairs.push([i, j]);
  }
  return pairs;
}
/**
 * Inter-annotator agreement and disagreement detection.
 *
 * Annotations are grouped per task into "units" rated by ≥2 distinct users.
 * Categorical answers collapse to their canonical JSON; structured payloads
 * additionally produce continuous pairwise similarity via the shared
 * comparison primitives. Statistics come from `@haap/shared`:
 * Cohen's kappa (2 raters), Fleiss' kappa (constant panel size), and
 * Krippendorff's alpha (handles ragged panels), each returning `null` when
 * mathematically undefined rather than a misleading zero.
 */

import {
  canonicalJson,
  cohensKappa,
  fleissKappa,
  interpretKappa,
  krippendorffAlpha,
  labelSimilarity,
  labelsDisagree,
  parseLabelForTaskType,
  type AgreementBand,
  type LabelPayload,
  type RatingsMatrix,
  type TaskType,
} from '@haap/shared';
import { getDataset } from './catalog-service.js';
import type { ServiceContext } from './context.js';

interface UnitRating {
  taskId: string;
  itemId: string;
  taskType: TaskType;
  /** userId -> latest rating for that user. */
  byUser: Map<string, { category: string; label: LabelPayload; verdict: string; at: string }>;
}

function parseSafe(taskType: TaskType, value: unknown): LabelPayload | null {
  if (value === null || value === undefined) return null;
  try {
    // Labels are stored as raw label values (e.g. { label: 'positive' } for
    // categorical, or an array for spatial), NOT as full { taskType, label }
    // envelopes. parseLabelForTaskType handles all three shapes via toEnvelope.
    return parseLabelForTaskType(taskType, value);
  } catch {
    return null;
  }
}

async function loadUnits(
  ctx: ServiceContext,
  datasetId: string,
  limit: number,
): Promise<UnitRating[]> {
  const rows = await ctx.db.query<{
    task_id: string;
    item_id: string;
    user_id: string;
    label: unknown;
    verdict: string;
    created_at: string | Date;
    task_type: TaskType;
  }>(
    `SELECT a.task_id, a.item_id, a.user_id, a.label, a.verdict, a.created_at,
            d.task_type
     FROM annotations a
     JOIN tasks t ON t.id = a.task_id
     JOIN datasets d ON d.id = t.dataset_id
     WHERE t.dataset_id = $1
     ORDER BY a.task_id, a.created_at ASC
     LIMIT $2`,
    [datasetId, limit],
  );

  const units = new Map<string, UnitRating>();
  for (const row of rows) {
    const label = parseSafe(row.task_type, row.label);
    if (!label) continue;
    let unit = units.get(row.task_id);
    if (!unit) {
      unit = {
        taskId: row.task_id,
        itemId: row.item_id,
        taskType: row.task_type,
        byUser: new Map(),
      };
      units.set(row.task_id, unit);
    }
    // Latest rating per user wins (re-annotation is allowed).
    unit.byUser.set(row.user_id, {
      category: canonicalJson(label),
      label,
      verdict: row.verdict,
      at: new Date(row.created_at).toISOString(),
    });
  }
  return [...units.values()].filter((unit) => unit.byUser.size >= 2);
}

/**
 * Cohen's kappa over the two most active raters, restricted to units both
 * rated. Returns `null` when they co-rated fewer than two units.
 */
function computeCohens(units: UnitRating[], categories: string[]): number | null {
  const perUser = new Map<string, number>();
  for (const unit of units) {
    for (const userId of unit.byUser.keys()) {
      perUser.set(userId, (perUser.get(userId) ?? 0) + 1);
    }
  }
  const [first, second] = [...perUser.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([userId]) => userId);
  if (!first || !second) return null;

  const index = new Map(categories.map((c, i) => [c, i]));
  const k = categories.length;
  const counts: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  let coRated = 0;
  for (const unit of units) {
    const a = unit.byUser.get(first);
    const b = unit.byUser.get(second);
    if (!a || !b) continue;
    const i = index.get(a.category);
    const j = index.get(b.category);
    if (i === undefined || j === undefined) continue;
    counts[i]![j] = (counts[i]![j] ?? 0) + 1;
    coRated += 1;
  }
  if (coRated < 2) return null;
  return cohensKappa({ categories, counts });
}

export async function computeAgreement(
  ctx: ServiceContext,
  datasetId: string,
  limit: number,
): Promise<AgreementReport> {
  try {
    await getDataset(ctx, datasetId);
    const units = await loadUnits(ctx, datasetId, limit);

    if (units.length === 0) {
      return {
        datasetId,
        unitsConsidered: 0,
        ratingsConsidered: 0,
        categoryCount: 0,
        exactAgreementRate: null,
        meanPairwiseSimilarity: null,
        disagreementRate: null,
        cohensKappa: null,
        fleissKappa: null,
        krippendorffAlpha: null,
        band: null,
      };
    }

    const categories = new Set<string>();
    let exactMatches = 0;
    let similaritySum = 0;
    let similarityPairs = 0;
    let disagreeingUnits = 0;
    let ratings = 0;

    const unitCategories: string[][] = [];
    for (const unit of units) {
      const entries = [...unit.byUser.values()];
      const cats = entries.map((e) => e.category);
      unitCategories.push(cats);
      ratings += cats.length;
      for (const c of cats) categories.add(c);
      if (new Set(cats).size === 1) exactMatches += 1;
      else disagreeingUnits += 1;

      const pairs = pairIndices(entries.length);
      if (pairs.length > 0) {
        let unitSimilarity = 0;
        for (const [i, j] of pairs) {
          unitSimilarity += labelSimilarity(unit.taskType, entries[i]!.label, entries[j]!.label);
        }
        similaritySum += unitSimilarity / pairs.length;
        similarityPairs += 1;
      }
    }

    // Fleiss requires a constant panel size: keep the modal number of raters.
    const counts = new Map<number, number>();
    for (const cats of unitCategories) counts.set(cats.length, (counts.get(cats.length) ?? 0) + 1);
    const modal = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
    const fleissRows = modal >= 2 ? unitCategories.filter((c) => c.length === modal) : [];
    const categoryList = [...categories];

    const cohens = computeCohens(units, categoryList);
    const fleiss =
      fleissRows.length >= 2
        ? fleissKappa(
            fleissRows.map((row) => [...row]),
            categoryList,
          )
        : null;
    const alpha = krippendorffAlpha(unitCategories as unknown as RatingsMatrix, categoryList);

    return {
      datasetId,
      unitsConsidered: units.length,
      ratingsConsidered: ratings,
      categoryCount: categoryList.length,
      exactAgreementRate: exactMatches / units.length,
      meanPairwiseSimilarity: similarityPairs > 0 ? similaritySum / similarityPairs : null,
      disagreementRate: disagreeingUnits / units.length,
      cohensKappa: cohens,
      fleissKappa: fleiss,
      krippendorffAlpha: alpha,
      band: cohens !== null ? interpretKappa(cohens) : null,
    };
  } catch (error) {
    throw error;
  }
}

export interface DisagreementPair {
  userA: string;
  userB: string;
  similarity: number;
}

export interface DisagreementEntry {
  taskId: string;
  itemId: string;
  taskType: TaskType;
  annotationCount: number;
  pairs: DisagreementPair[];
  ratings: Array<{ userId: string; verdict: string; at: string; label: LabelPayload }>;
}

/**
 * Tasks where at least one pair of independent humans disagrees.
 * This is the work queue for adjudication: every pair carries its measured
 * similarity so reviewers can see how far apart the annotators were.
 */
export async function listDisagreements(
  ctx: ServiceContext,
  datasetId: string,
  limit: number,
): Promise<DisagreementEntry[]> {
  await getDataset(ctx, datasetId);
  const units = await loadUnits(ctx, datasetId, limit * 4);

  const results: DisagreementEntry[] = [];
  for (const unit of units) {
    const ratings = [...unit.byUser.entries()].map(([userId, value]) => ({
      userId,
      verdict: value.verdict,
      at: value.at,
      label: value.label,
    }));
    const pairs: DisagreementPair[] = [];
    for (const [i, j] of pairIndices(ratings.length)) {
      const a = ratings[i]!;
      const b = ratings[j]!;
      const similarity = labelSimilarity(unit.taskType, a.label, b.label);
      if (labelsDisagree(unit.taskType, a.label, b.label)) {
        pairs.push({ userA: a.userId, userB: b.userId, similarity });
      }
    }
    if (pairs.length > 0) {
      results.push({
        taskId: unit.taskId,
        itemId: unit.itemId,
        taskType: unit.taskType,
        annotationCount: ratings.length,
        pairs,
        ratings,
      });
      if (results.length >= limit) break;
    }
  }
  return results;
}

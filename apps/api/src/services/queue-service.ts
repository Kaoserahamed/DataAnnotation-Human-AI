/**
 * Active-learning review queue.
 *
 * Candidate tasks are ranked by the shared acquisition score — the weighted
 * combination of model uncertainty, human/AI disagreement, and pool
 * diversity — and each entry carries its signals so the UI can explain *why*
 * an item is next. Optional gold-question injection plans are computed with
 * the shared deterministic planner.
 */

import {
  compareByAcquisitionScore,
  disagreementFromSimilarities,
  labelSimilarity,
  parseLabelForTaskType,
  planGoldInjection,
  redundancyAgainstLabelledPool,
  scoreAcquisition,
  tokenizeWords,
  type GoldInjectionPlan,
  type LabelPayload,
  type Paginated,
  type TaskState,
  type TaskType,
} from '../shared.js';
import { TASK_WITH_CONTEXT_SELECT, type TaskWithContextRow } from '../db/rows.js';
import { contentText } from '../providers/types.js';
import { errors } from '../lib/errors.js';
import { toTaskView, type TaskView } from './catalog-service.js';
import { getDataset } from './catalog-service.js';
import type { ServiceContext } from './context.js';

/** States a human can meaningfully work on right now. */
export const DEFAULT_QUEUE_STATES: readonly TaskState[] = [
  'pending_review',
  'pending_human',
  'in_review',
  'needs_correct',
  'escalated',
];

/** Safety cap on how many candidates are scored in one request. */
const MAX_CANDIDATES = 2_000;
const DIVERSITY_POOL_SIZE = 40;

export interface QueueQueryInput {
  limit: number;
  offset: number;
  states?: TaskState[] | undefined;
  orderBy: 'acquisition' | 'created' | 'confidence';
}

export interface QueueSignals {
  uncertainty: number;
  disagreement: number;
  diversity: number;
  acquisitionScore: number;
}

export interface QueueEntry {
  task: TaskView;
  annotationCount: number;
  signals: QueueSignals;
}

export interface QueueResult extends Paginated<QueueEntry> {
  goldInjection?: GoldInjectionPlan;
}

function asLabel(value: unknown): LabelPayload | null {
  return (value ?? null) as LabelPayload | null;
}

function parseSafe(taskType: TaskType, value: unknown): LabelPayload | null {
  if (value === null || value === undefined) return null;
  try {
    return parseLabelForTaskType(taskType, value);
  } catch {
    return null;
  }
}

/** Mean pairwise disagreement across all predictions of one task. */
function disagreementSignal(
  taskType: TaskType,
  aiLabel: LabelPayload | null,
  humanLabels: LabelPayload[],
): number {
  const predictions: LabelPayload[] = [...humanLabels];
  if (aiLabel) predictions.push(aiLabel);
  if (predictions.length < 2) return 0;
  const similarities: number[] = [];
  for (let i = 0; i < predictions.length; i += 1) {
    for (let j = i + 1; j < predictions.length; j += 1) {
      similarities.push(labelSimilarity(taskType, predictions[i]!, predictions[j]!));
    }
  }
  return disagreementFromSimilarities(similarities);
}

async function diversityPool(
  ctx: ServiceContext,
  datasetId: string,
): Promise<Array<ReadonlySet<string>>> {
  const rows = await ctx.db.query<{ content: unknown }>(
    `SELECT i.content FROM items i
     JOIN tasks t ON t.item_id = i.id
     WHERE i.dataset_id = $1 AND (i.split = 'gold' OR t.state = 'accepted')
     LIMIT $2`,
    [datasetId, DIVERSITY_POOL_SIZE],
  );
  return rows.map((row) => new Set(tokenizeWords(contentText(row.content))));
}

export async function getQueue(
  ctx: ServiceContext,
  datasetId: string,
  query: QueueQueryInput,
  options: { injectGold?: boolean | undefined; seed?: number | undefined } = {},
): Promise<QueueResult> {
  await getDataset(ctx, datasetId);
  const states = query.states && query.states.length > 0 ? query.states : DEFAULT_QUEUE_STATES;

  const tasks = await ctx.db.query<TaskWithContextRow>(
    `SELECT ${TASK_WITH_CONTEXT_SELECT}
     FROM tasks t
     JOIN datasets d ON d.id = t.dataset_id
     JOIN items i ON i.id = t.item_id
     WHERE t.dataset_id = $1 AND t.state = ANY($2)
     ORDER BY t.created_at ASC
     LIMIT $3`,
    [datasetId, states, MAX_CANDIDATES],
  );
  if (tasks.length === 0) {
    const empty: QueueResult = { data: [], total: 0, limit: query.limit, offset: query.offset };
    return options.injectGold ? { ...empty, goldInjection: emptyPlan() } : empty;
  }

  const annotations = await ctx.db.query<{
    task_id: string;
    user_id: string;
    label: unknown;
  }>('SELECT task_id, user_id, label FROM annotations WHERE task_id = ANY($1)', [
    tasks.map((t) => t.id),
  ]);
  const annotationsByTask = new Map<string, typeof annotations>();
  for (const row of annotations) {
    const list = annotationsByTask.get(row.task_id) ?? [];
    list.push(row);
    annotationsByTask.set(row.task_id, list);
  }

  const pool = query.orderBy === 'acquisition' ? await diversityPool(ctx, datasetId) : [];

  const scored = tasks.map((task) => {
    const view = toTaskView(task);
    const rows = annotationsByTask.get(task.id) ?? [];
    const humanLabels: LabelPayload[] = [];
    const seen = new Set<string>();
    let annotationCount = 0;
    for (const row of rows) {
      const parsed = parseSafe(task.task_type, row.label);
      if (!parsed) continue;
      annotationCount += 1;
      if (seen.has(row.user_id)) continue;
      seen.add(row.user_id);
      humanLabels.push(parsed);
    }

    const aiLabel = asLabel(task.ai_label);
    const uncertainty = task.ai_confidence === null ? 1 : 1 - task.ai_confidence;
    const disagreement = disagreementSignal(task.task_type, aiLabel, humanLabels);
    const tokens = new Set(tokenizeWords(contentText(task.content)));
    const acquisition = scoreAcquisition({
      uncertainty,
      disagreement,
      redundancy: redundancyAgainstLabelledPool(tokens, pool),
    });

    const entry: QueueEntry = {
      task: view,
      annotationCount,
      signals: {
        uncertainty: acquisition.uncertainty,
        disagreement: acquisition.disagreement,
        diversity: acquisition.diversity,
        acquisitionScore: acquisition.acquisitionScore,
      },
    };
    return { entry, createdAt: new Date(task.created_at).getTime(), confidence: task.ai_confidence };
  });

  const ordered = [...scored];
  if (query.orderBy === 'acquisition') {
    ordered.sort(
      (a, b) =>
        compareByAcquisitionScore(a.entry.signals, b.entry.signals) ||
        a.createdAt - b.createdAt,
    );
  } else if (query.orderBy === 'confidence') {
    ordered.sort(
      (a, b) => (a.confidence ?? -1) - (b.confidence ?? -1) || a.createdAt - b.createdAt,
    );
  } else {
    ordered.sort((a, b) => a.createdAt - b.createdAt);
  }

  const total = ordered.length;
  const page = ordered.slice(query.offset, query.offset + query.limit);
  const result: QueueResult = {
    data: page.map((row) => row.entry),
    total,
    limit: query.limit,
    offset: query.offset,
  };

  if (options.injectGold) {
    const goldTasks = await ctx.db.query<{ id: string }>(
      `SELECT t.id FROM tasks t JOIN items i ON i.id = t.item_id
       WHERE i.dataset_id = $1 AND i.split = 'gold' LIMIT 200`,
      [datasetId],
    );
    result.goldInjection = planGoldInjection(
      goldTasks.map((row) => row.id),
      Math.min(query.limit, 50),
      options.seed ?? 1,
    );
  }

  return result;
}

function emptyPlan(): GoldInjectionPlan {
  return planGoldInjection([], 0, 1);
}

/** States exposed to the queue route for query validation. */
export function assertKnownStates(states: readonly string[]): TaskState[] {
  const allowed = new Set(DEFAULT_QUEUE_STATES.concat('pending_prelabel'));
  const invalid = states.filter((state) => !allowed.has(state as TaskState));
  if (invalid.length > 0) {
    throw errors.validation(`unsupported queue states: ${invalid.join(', ')}`);
  }
  return states as TaskState[];
}

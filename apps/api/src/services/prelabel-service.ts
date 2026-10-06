/**
 * AI pre-labeling service.
 *
 * Runs the configured provider over tasks in `pending_prelabel`, stores each
 * prediction, and routes the task with the shared workflow decision:
 * confidence ≥ 0.9 → fast-acceptable `pending_review`,
 * confidence < 0.5 → `escalated`, otherwise `pending_review`.
 *
 * Provider failures are isolated per task: the failing task stays
 * `pending_prelabel` (retryable) and the run reports the failure count.
 */

import { decideAfterPrelabel, parseLabelForTaskType } from '@haap/shared';
import { json } from '../db/database.js';
import type { DatasetRow, ItemRow, TaskRow } from '../db/rows.js';
import { newId } from '../lib/ids.js';
import { ProviderError } from '../providers/registry.js';
import { recordEvent } from './event-service.js';
import { findTasksByState, getDataset } from './catalog-service.js';
import type { ServiceContext } from './context.js';
import type { PrelabelInput } from '../providers/registry.js';

export interface PrelabelRunInput {
  datasetId: string;
  itemIds?: string[] | undefined;
  limit?: number | undefined;
}

export interface PrelabelSummary {
  provider: string;
  datasetId: string;
  processed: number;
  failures: number;
  byState: Record<string, number>;
}

export async function runPrelabeling(
  ctx: ServiceContext,
  input: PrelabelRunInput,
): Promise<PrelabelSummary> {
  const dataset = await getDataset(ctx, input.datasetId);
  const tasks = await findTasksByState(ctx, input.datasetId, ['pending_prelabel'], {
    ...(input.itemIds ? { itemIds: input.itemIds } : {}),
    limit: input.limit ?? 500,
  });

  const summary: PrelabelSummary = {
    provider: ctx.provider.name,
    datasetId: input.datasetId,
    processed: 0,
    failures: 0,
    byState: {},
  };
  if (tasks.length === 0) return summary;

  const items = await loadItems(ctx, tasks.map((t) => t.item_id));
  const labelSchema = parseLabelSchema(dataset);

  for (const task of tasks) {
    const item = items.get(task.item_id);
    if (!item) continue;
    try {
      const prediction = await ctx.provider.predict({
        itemId: task.item_id,
        taskType: dataset.task_type,
        content: item.content,
        labelSchema,
      });
      // `prediction.label` is the modality *value*; the shared parser expects
      // a value wrapped as a bare envelope (`{ label: value }`).
      const envelope = parseLabelForTaskType(dataset.task_type, {
        label: prediction.label,
      });
      const decision = decideAfterPrelabel(prediction.confidence);

      await ctx.db.transaction(async (tx) => {
        await tx.execute(
          `INSERT INTO predictions (id, task_id, item_id, dataset_id, source, provider, label, confidence)
           VALUES ($1, $2, $3, $4, 'ai', $5, $6, $7)`,
          [
            newId(),
            task.id,
            task.item_id,
            task.dataset_id,
            ctx.provider.name,
            json(envelope),
            prediction.confidence,
          ],
        );
        await tx.execute(
          `UPDATE tasks SET ai_label = $1, ai_confidence = $2, ai_provider = $3,
             state = $4, updated_at = now() WHERE id = $5`,
          [json(envelope), prediction.confidence, ctx.provider.name, decision.nextState, task.id],
        );
        await recordEvent(tx, {
          type: 'ai_prelabel_created',
          taskId: task.id,
          itemId: task.item_id,
          datasetId: task.dataset_id,
          fromState: task.state,
          toState: decision.nextState,
          payload: {
            source: 'ai',
            provider: ctx.provider.name,
            confidence: prediction.confidence,
            canFastAccept: decision.canFastAccept,
            requiresEscalation: decision.requiresEscalation,
          },
        });
      });

      ctx.metrics.recordAiPrediction(false);
      summary.processed += 1;
      summary.byState[decision.nextState] = (summary.byState[decision.nextState] ?? 0) + 1;
    } catch (error) {
      ctx.metrics.recordAiPrediction(true);
      summary.failures += 1;
      if (!(error instanceof ProviderError)) throw error;
    }
  }

  return summary;
}

async function loadItems(
  ctx: ServiceContext,
  itemIds: string[],
): Promise<Map<string, ItemRow>> {
  if (itemIds.length === 0) return new Map();
  const rows = await ctx.db.query<ItemRow>('SELECT * FROM items WHERE id = ANY($1)', [itemIds]);
  return new Map(rows.map((row) => [row.id, row]));
}

function parseLabelSchema(dataset: DatasetRow): PrelabelInput['labelSchema'] {
  const raw = dataset.label_schema;
  const record =
    raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const stringList = (value: unknown): string[] | undefined =>
    Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : undefined;
  return {
    categories: stringList(record['categories']),
    entityTypes: stringList(record['entityTypes']),
    regionLabels: stringList(record['regionLabels']),
    ...(typeof record['targetLanguage'] === 'string'
      ? { targetLanguage: record['targetLanguage'] }
      : {}),
  };
}

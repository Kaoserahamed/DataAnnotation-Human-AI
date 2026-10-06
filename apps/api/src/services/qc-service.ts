/**
 * Quality control: seeded sampling, QC resolution, and gold promotion.
 *
 * Sampling is reproducible (same seed + candidates => same batch) and splits
 * candidates between a uniform random draw and a risk-ranked draw so the QC
 * metric cannot be gamed by only ever looking at easy items.
 * Gold promotion requires independent agreeing annotations unless an admin
 * explicitly forces it — both paths are recorded in the event history.
 */

import {
  PIPELINE_THRESHOLDS,
  canonicalJson,
  labelSimilarity,
  parseLabelForTaskType,
  qualifiesForGold,
  selectQcSample,
  type LabelPayload,
  type Paginated,
  type PromoteGoldInput,
  type QcCandidate,
} from '@haap/shared';
import { json, parseJson } from '../db/database.js';
import type { QcSampleRow } from '../db/rows.js';
import { errors } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { getDataset } from './catalog-service.js';
import { recordEvent } from './event-service.js';
import type { AuthUser, ServiceContext } from './context.js';

/** States considered for a QC batch. */
const QC_TASK_STATES = ['accepted', 'needs_correct', 'in_review', 'pending_review'] as const;

export interface SampleQcRequest {
  reason: 'random' | 'risk' | 'gold_check';
  size: number;
  seed?: number | undefined;
}

export interface SampleQcResult {
  datasetId: string;
  seed: number;
  randomCount: number;
  riskCount: number;
  skippedExisting: string[];
  sampled: Array<{ itemId: string; taskId: string }>;
}

function riskScoreFor(state: string, confidence: number | null): number {
  const base = confidence === null ? 0.8 : 1 - confidence;
  const correctedPenalty = state === 'needs_correct' ? 0.15 : 0;
  return Math.min(1, Math.max(0, base + correctedPenalty));
}

export async function sampleQc(
  ctx: ServiceContext,
  actor: AuthUser,
  datasetId: string,
  input: SampleQcRequest,
): Promise<SampleQcResult> {
  await getDataset(ctx, datasetId);
  if (input.reason === 'gold_check') {
    throw errors.validation(
      'gold_check samples are injected automatically by the queue; use reason "random" or "risk"',
    );
  }

  const rows = await ctx.db.query<{
    task_id: string;
    item_id: string;
    state: string;
    ai_confidence: number | null;
    sampled: boolean;
  }>(
    `SELECT t.id AS task_id, t.item_id, t.state, t.ai_confidence,
       EXISTS (
         SELECT 1 FROM qc_samples q
         WHERE q.item_id = t.item_id AND q.status = 'open'
       ) AS sampled
     FROM tasks t
     WHERE t.dataset_id = $1 AND t.state = ANY($2)`,
    [datasetId, [...QC_TASK_STATES]],
  );

  const seed = input.seed ?? Math.floor(Date.now() % 2_147_483_647);
  const candidates: QcCandidate[] = rows.map((row) => ({
    itemId: row.item_id,
    riskScore: riskScoreFor(row.state, row.ai_confidence),
    sampled: row.sampled,
  }));

  const randomFraction = input.reason === 'random' ? 1 : 0;
  const selection = selectQcSample(candidates, input.size, seed, randomFraction);

  const taskByItem = new Map(rows.map((row) => [row.item_id, row.task_id]));
  await ctx.db.transaction(async (tx) => {
    for (const itemId of selection.selected) {
      await tx.execute(
        `INSERT INTO qc_samples (id, dataset_id, item_id, reason, sampled_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [newId(), datasetId, itemId, input.reason, actor.id],
      );
    }
    await recordEvent(tx, {
      type: 'qc_sampled',
      datasetId,
      actorId: actor.id,
      payload: {
        reason: input.reason,
        seed,
        randomCount: selection.randomCount,
        riskCount: selection.riskCount,
        size: selection.selected.length,
      },
    });
  });

  return {
    datasetId,
    seed,
    randomCount: selection.randomCount,
    riskCount: selection.riskCount,
    skippedExisting: selection.skippedExisting,
    sampled: selection.selected.map((itemId) => ({
      itemId,
      taskId: taskByItem.get(itemId) ?? '',
    })),
  };
}

export async function listQcSamples(
  ctx: ServiceContext,
  datasetId: string,
  status: 'open' | 'resolved' | undefined,
  page: { limit: number; offset: number },
): Promise<Paginated<QcSampleRow>> {
  await getDataset(ctx, datasetId);
  const where = status
    ? 'WHERE dataset_id = $1 AND status = $2'
    : 'WHERE dataset_id = $1';
  const params = status ? [datasetId, status] : [datasetId];
  const countRows = await ctx.db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM qc_samples ${where}`,
    params,
  );
  const rows = await ctx.db.query<QcSampleRow>(
    `SELECT * FROM qc_samples ${where}
     ORDER BY created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, page.limit, page.offset],
  );
  return {
    data: rows,
    total: Number(countRows[0]?.count ?? 0),
    limit: page.limit,
    offset: page.offset,
  };
}

export async function resolveQc(
  ctx: ServiceContext,
  actor: AuthUser,
  sampleId: string,
  passed: boolean,
): Promise<QcSampleRow> {
  const rows = await ctx.db.query<QcSampleRow>('SELECT * FROM qc_samples WHERE id = $1', [
    sampleId,
  ]);
  const sample = rows[0];
  if (!sample) throw errors.notFound('qc_sample', sampleId);
  if (sample.status === 'resolved') {
    throw errors.conflict('qc sample is already resolved');
  }

  await ctx.db.transaction(async (tx) => {
    await tx.execute(
      `UPDATE qc_samples SET status = 'resolved', result = $1, resolved_at = now() WHERE id = $2`,
      [passed, sampleId],
    );
    await recordEvent(tx, {
      type: 'qc_resolved',
      datasetId: sample.dataset_id,
      itemId: sample.item_id,
      actorId: actor.id,
      payload: { sampleId, passed, reason: sample.reason },
    });
  });

  const updated = await ctx.db.query<QcSampleRow>('SELECT * FROM qc_samples WHERE id = $1', [
    sampleId,
  ]);
  return updated[0]!;
}

export interface PromoteGoldResult {
  promoted: string[];
  rejected: Array<{ itemId: string; reason: string; confirmations: number }>;
}

/** Distinct-user confirmation count of the most popular exact answer. */
async function bestConfirmationCount(ctx: ServiceContext, itemId: string): Promise<number> {
  const rows = await ctx.db.query<{ user_id: string; label: unknown }>(
    'SELECT user_id, label FROM annotations WHERE item_id = $1',
    [itemId],
  );
  const byCategory = new Map<string, Set<string>>();
  for (const row of rows) {
    const category = canonicalJson(parseJson(row.label, null));
    const users = byCategory.get(category) ?? new Set<string>();
    users.add(row.user_id);
    byCategory.set(category, users);
  }
  let best = 0;
  for (const users of byCategory.values()) best = Math.max(best, users.size);
  return best;
}

export async function promoteGold(
  ctx: ServiceContext,
  actor: AuthUser,
  input: PromoteGoldInput,
): Promise<PromoteGoldResult> {
  if (input.force && actor.role !== 'admin') {
    throw errors.forbidden('only admins may force gold promotion');
  }

  const result: PromoteGoldResult = { promoted: [], rejected: [] };

  for (const itemId of input.itemIds) {
    const items = await ctx.db.query<{ id: string; split: string; dataset_id: string }>(
      'SELECT id, split, dataset_id FROM items WHERE id = $1',
      [itemId],
    );
    const item = items[0];
    if (!item) {
      result.rejected.push({ itemId, reason: 'item not found', confirmations: 0 });
      continue;
    }

    const confirmations = await bestConfirmationCount(ctx, itemId);
    const eligible = input.force || qualifiesForGold(confirmations);
    if (!eligible) {
      result.rejected.push({
        itemId,
        reason: `requires ${PIPELINE_THRESHOLDS.goldAgreementRequired} independent confirmations`,
        confirmations,
      });
      continue;
    }

    if (item.split !== 'gold') {
      await ctx.db.transaction(async (tx) => {
        await tx.execute(`UPDATE items SET split = 'gold' WHERE id = $1`, [itemId]);
        await recordEvent(tx, {
          type: 'gold_promoted',
          datasetId: item.dataset_id,
          itemId,
          actorId: actor.id,
          payload: { source: 'gold', confirmations, force: input.force, via: 'manual' },
        });
      });
    }
    result.promoted.push(itemId);
  }

  return result;
}

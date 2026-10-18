/**
 * Analytics: annotator performance, dataset overview, and annotation history.
 *
 * Gold-check accuracy is computed with the shared `scoreGoldChecks` helper so
 * the API and any future report use one definition of "correct against gold".
 */

import {
  canonicalJson,
  scoreGoldChecks,
  type GoldCheckResult,
  type HistoryQuery,
  type Paginated,
  type TaskState,
} from '../shared.js';
import { parseJson } from '../db/database.js';
import type { AnnotationRow, EventRow } from '../db/rows.js';
import { getDataset } from './catalog-service.js';
import type { ServiceContext } from './context.js';

export interface AnnotatorStats {
  userId: string;
  name: string;
  email: string;
  role: string;
  annotations: number;
  correct: number;
  corrected: number;
  rejected: number;
  acceptanceRate: number | null;
  goldChecks: number;
  goldAccuracy: number | null;
  avgTimeSpentMs: number | null;
  distinctItems: number;
  lastAnnotationAt: string | null;
}

interface AnnotatorRow extends AnnotationRow {
  name: string;
  email: string;
  role: string;
}

export async function annotatorPerformance(
  ctx: ServiceContext,
  datasetId?: string | undefined,
): Promise<AnnotatorStats[]> {
  const rows = await ctx.db.query<AnnotatorRow>(
    `SELECT a.*, u.name, u.email, u.role
     FROM annotations a
     JOIN users u ON u.id = a.user_id
     WHERE ($1::text IS NULL OR a.dataset_id = $1)
     ORDER BY a.created_at ASC`,
    [datasetId ?? null],
  );
  if (rows.length === 0) return [];

  // Gold-check annotations need the gold answer of their task.
  const goldTaskIds = [...new Set(rows.filter((r) => r.is_gold_check).map((r) => r.task_id))];
  const goldTasks = new Map<string, { finalLabel: unknown; itemId: string }>();
  if (goldTaskIds.length > 0) {
    const tasks = await ctx.db.query<{ id: string; final_label: unknown; item_id: string }>(
      'SELECT id, final_label, item_id FROM tasks WHERE id = ANY($1)',
      [goldTaskIds],
    );
    for (const task of tasks) {
      goldTasks.set(task.id, {
        finalLabel: parseJson(task.final_label, null),
        itemId: task.item_id,
      });
    }
  }

  const byUser = new Map<string, AnnotatorStats>();
  const checksByUser = new Map<string, GoldCheckResult[]>();

  for (const row of rows) {
    let stats = byUser.get(row.user_id);
    if (!stats) {
      stats = {
        userId: row.user_id,
        name: row.name,
        email: row.email,
        role: row.role,
        annotations: 0,
        correct: 0,
        corrected: 0,
        rejected: 0,
        acceptanceRate: null,
        goldChecks: 0,
        goldAccuracy: null,
        avgTimeSpentMs: null,
        distinctItems: 0,
        lastAnnotationAt: null,
      };
      byUser.set(row.user_id, stats);
    }
    stats.annotations += 1;
    if (row.verdict === 'correct') stats.correct += 1;
    else if (row.verdict === 'corrected') stats.corrected += 1;
    else stats.rejected += 1;
    const at = new Date(row.created_at).toISOString();
    if (stats.lastAnnotationAt === null || at > stats.lastAnnotationAt) {
      stats.lastAnnotationAt = at;
    }

    if (row.is_gold_check) {
      stats.goldChecks += 1;
      const gold = goldTasks.get(row.task_id);
      if (gold) {
        const list = checksByUser.get(row.user_id) ?? [];
        list.push({
          itemId: row.item_id,
          expected: canonicalJson(gold.finalLabel),
          actual: canonicalJson(parseJson(row.label, null)),
          correct: row.gold_correct === true,
        });
        checksByUser.set(row.user_id, list);
      }
    }
  }

  for (const [userId, stats] of byUser) {
    stats.acceptanceRate =
      stats.annotations === 0 ? null : Math.round((stats.correct / stats.annotations) * 1e4) / 1e4;
    const times = rows
      .filter((r) => r.user_id === userId && r.time_spent_ms !== null)
      .map((r) => r.time_spent_ms ?? 0);
    stats.avgTimeSpentMs =
      times.length === 0
        ? null
        : Math.round(times.reduce((a, b) => a + b, 0) / times.length);
    stats.distinctItems = new Set(rows.filter((r) => r.user_id === userId).map((r) => r.item_id))
      .size;
    stats.goldAccuracy = scoreGoldChecks(checksByUser.get(userId) ?? []);
  }

  return [...byUser.values()].sort((a, b) => b.annotations - a.annotations);
}

export interface DatasetOverview {
  datasetId: string;
  taskType: string;
  states: Record<string, number>;
  items: { total: number; gold: number; pool: number; dev: number; test: number };
  ai: { prelabeled: number; avgConfidence: number | null; provider: string | null };
  annotations: {
    total: number;
    correct: number;
    corrected: number;
    rejected: number;
    aiAcceptanceRate: number | null;
  };
  qc: { open: number; resolved: number; passRate: number | null };
  goldItems: number;
}

export async function overview(
  ctx: ServiceContext,
  datasetId: string,
): Promise<DatasetOverview> {
  const dataset = await getDataset(ctx, datasetId);

  const stateRows = await ctx.db.query<{ state: TaskState; count: string }>(
    'SELECT state, count(*)::text AS count FROM tasks WHERE dataset_id = $1 GROUP BY state',
    [datasetId],
  );
  const states: Record<string, number> = {};
  for (const row of stateRows) states[row.state] = Number(row.count);

  const itemRows = await ctx.db.query<{ split: string; count: string }>(
    'SELECT split, count(*)::text AS count FROM items WHERE dataset_id = $1 GROUP BY split',
    [datasetId],
  );
  const splitCounts: Record<string, number> = {};
  for (const row of itemRows) splitCounts[row.split] = Number(row.count);

  const aiRow = (
    await ctx.db.query<{ prelabeled: string; avg_confidence: number | null; provider: string | null }>(
      `SELECT count(ai_label)::text AS prelabeled,
         avg(ai_confidence)::float AS avg_confidence,
         min(ai_provider) AS provider
       FROM tasks WHERE dataset_id = $1`,
      [datasetId],
    )
  )[0];

  const annRow = (
    await ctx.db.query<{ total: string; correct: string; corrected: string; rejected: string }>(
      `SELECT count(*)::text AS total,
         count(*) FILTER (WHERE verdict = 'correct')::text AS correct,
         count(*) FILTER (WHERE verdict = 'corrected')::text AS corrected,
         count(*) FILTER (WHERE verdict = 'rejected')::text AS rejected
       FROM annotations WHERE dataset_id = $1`,
      [datasetId],
    )
  )[0];

  const qcRows = await ctx.db.query<{ status: string; count: string; passed: string | null }>(
    `SELECT status, count(*)::text AS count,
       count(*) FILTER (WHERE result)::text AS passed
     FROM qc_samples WHERE dataset_id = $1 GROUP BY status`,
    [datasetId],
  );
  let qcOpen = 0;
  let qcResolved = 0;
  let qcPassed = 0;
  for (const row of qcRows) {
    if (row.status === 'open') qcOpen = Number(row.count);
    else {
      qcResolved = Number(row.count);
      qcPassed = Number(row.passed ?? 0);
    }
  }

  const total = Number(annRow?.total ?? 0);
  const correct = Number(annRow?.correct ?? 0);

  return {
    datasetId,
    taskType: dataset.task_type,
    states,
    items: {
      total: Object.values(splitCounts).reduce((a, b) => a + b, 0),
      gold: splitCounts['gold'] ?? 0,
      pool: splitCounts['pool'] ?? 0,
      dev: splitCounts['dev'] ?? 0,
      test: splitCounts['test'] ?? 0,
    },
    ai: {
      prelabeled: Number(aiRow?.prelabeled ?? 0),
      avgConfidence:
        aiRow?.avg_confidence === null || aiRow?.avg_confidence === undefined
          ? null
          : Math.round(aiRow.avg_confidence * 1e4) / 1e4,
      provider: aiRow?.provider ?? null,
    },
    annotations: {
      total,
      correct,
      corrected: Number(annRow?.corrected ?? 0),
      rejected: Number(annRow?.rejected ?? 0),
      aiAcceptanceRate: total === 0 ? null : Math.round((correct / total) * 1e4) / 1e4,
    },
    qc: {
      open: qcOpen,
      resolved: qcResolved,
      passRate: qcResolved === 0 ? null : Math.round((qcPassed / qcResolved) * 1e4) / 1e4,
    },
    goldItems: splitCounts['gold'] ?? 0,
  };
}

export interface HistoryEntry {
  id: string;
  type: string;
  taskId: string | null;
  itemId: string | null;
  datasetId: string | null;
  actorId: string | null;
  actorEmail: string | null;
  fromState: string | null;
  toState: string | null;
  payload: unknown;
  createdAt: string;
}

export async function history(
  ctx: ServiceContext,
  query: HistoryQuery,
): Promise<Paginated<HistoryEntry>> {
  const countRows = await ctx.db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM events e
     WHERE ($1::text IS NULL OR e.task_id = $1)
       AND ($2::text IS NULL OR e.item_id = $2)
       AND ($3::text IS NULL OR e.payload->>'source' = $3)`,
    [query.taskId ?? null, query.itemId ?? null, query.predictionSource ?? null],
  );
  const rows = await ctx.db.query<
    EventRow & { actor_email: string | null }
  >(
    `SELECT e.*, u.email AS actor_email
     FROM events e
     LEFT JOIN users u ON u.id = e.actor_id
     WHERE ($1::text IS NULL OR e.task_id = $1)
       AND ($2::text IS NULL OR e.item_id = $2)
       AND ($3::text IS NULL OR e.payload->>'source' = $3)
     ORDER BY e.created_at DESC
     LIMIT $4 OFFSET $5`,
    [
      query.taskId ?? null,
      query.itemId ?? null,
      query.predictionSource ?? null,
      query.limit,
      query.offset,
    ],
  );

  return {
    data: rows.map((row) => ({
      id: row.id,
      type: row.type,
      taskId: row.task_id,
      itemId: row.item_id,
      datasetId: row.dataset_id,
      actorId: row.actor_id,
      actorEmail: row.actor_email,
      fromState: row.from_state,
      toState: row.to_state,
      payload: parseJson<Record<string, unknown>>(row.payload, {}),
      createdAt: new Date(row.created_at).toISOString(),
    })),
    total: Number(countRows[0]?.count ?? 0),
    limit: query.limit,
    offset: query.offset,
  };
}

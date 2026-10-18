/** Task routes: detail, human annotation, review, and state override. */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  HistoryQuerySchema,
  ReviewAnnotationSchema,
  SubmitAnnotationSchema,
  UpdateTaskStateSchema,
} from '../shared.js';
import { errors } from '../lib/errors.js';
import { normalizeQuery, parseWith, requireAuth, requireRole } from '../lib/http.js';
import { getTaskView } from '../services/catalog-service.js';
import {
  overrideTaskState,
  reviewAnnotation,
  submitAnnotation,
} from '../services/annotation-service.js';
import type { AnnotationRow } from '../db/rows.js';

const TaskParamSchema = z.object({ id: z.string().min(1).max(64) });

export function registerTaskRoutes(app: FastifyInstance): void {
  app.get('/tasks/:id', async (request) => {
    await requireAuth(request);
    const { id } = parseWith(TaskParamSchema, request.params);
    const task = await getTaskView(app.ctx, id);
    return { task };
  });

  app.get('/tasks/:id/annotations', async (request) => {
    await requireAuth(request);
    const { id } = parseWith(TaskParamSchema, request.params);
    const rows = await app.db.query<AnnotationRow & { name: string; email: string }>(
      `SELECT a.*, u.name, u.email FROM annotations a
       JOIN users u ON u.id = a.user_id
       WHERE a.task_id = $1 ORDER BY a.created_at ASC`,
      [id],
    );
    return {
      data: rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        name: row.name,
        email: row.email,
        verdict: row.verdict,
        similarity: row.similarity,
        note: row.note,
        timeSpentMs: row.time_spent_ms,
        isGoldCheck: row.is_gold_check,
        goldCorrect: row.gold_correct,
        label: row.label,
        createdAt: new Date(row.created_at).toISOString(),
      })),
    };
  });

  app.post('/tasks/:id/annotate', async (request) => {
    const actor = await requireAuth(request);
    requireRole(actor, 'annotator', 'reviewer', 'admin');
    const { id } = parseWith(TaskParamSchema, request.params);
    const body = parseWith(SubmitAnnotationSchema, request.body);
    return submitAnnotation(app.ctx, actor, id, body);
  });

  app.post('/tasks/:id/review', async (request) => {
    const actor = await requireAuth(request);
    requireRole(actor, 'reviewer', 'admin');
    const { id } = parseWith(TaskParamSchema, request.params);
    const body = parseWith(ReviewAnnotationSchema, request.body);
    return reviewAnnotation(app.ctx, actor, id, body);
  });

  app.patch('/tasks/:id/state', async (request) => {
    const actor = await requireAuth(request);
    requireRole(actor, 'admin');
    const { id } = parseWith(TaskParamSchema, request.params);
    const body = parseWith(UpdateTaskStateSchema, request.body);
    return { task: await overrideTaskState(app.ctx, actor, id, body) };
  });

  // Lightweight event stream for one task (used by the history panel).
  app.get('/tasks/:id/events', async (request) => {
    await requireAuth(request);
    const { id } = parseWith(TaskParamSchema, request.params);
    const query = parseWith(
      HistoryQuerySchema.omit({ itemId: true, taskId: true, predictionSource: true }),
      normalizeQuery(request.query),
    );
    const countRow = await app.db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM events WHERE task_id = $1',
      [id],
    );
    const rows = await app.db.query(
      `SELECT * FROM events WHERE task_id = $1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [id, query.limit, query.offset],
    );
    return {
      data: rows,
      total: Number(countRow[0]?.count ?? 0),
      limit: query.limit,
      offset: query.offset,
    };
  });
}

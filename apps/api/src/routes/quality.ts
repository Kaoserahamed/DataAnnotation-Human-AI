/**
 * Quality routes: active-learning queue, agreement, disagreements,
 * QC sampling/resolution, gold promotion, and dataset overview.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AgreementQuerySchema,
  PaginationQuerySchema,
  PromoteGoldSchema,
  QueueQuerySchema,
  SampleQcSchema,
} from '@haap/shared';
import { normalizeQuery, parseWith, requireAuth, requireRole } from '../lib/http.js';
import { computeAgreement, listDisagreements } from '../services/agreement-service.js';
import { getQueue } from '../services/queue-service.js';
import { listQcSamples, promoteGold, resolveQc, sampleQc } from '../services/qc-service.js';
import { overview } from '../services/analytics-service.js';
import type { QcSampleRow } from '../db/rows.js';

const DatasetParamSchema = z.object({ id: z.string().min(1).max(64) });

const QueueRequestSchema = QueueQuerySchema.extend({
  injectGold: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  seed: z.coerce.number().int().min(0).max(2_147_483_647).optional(),
});

export function registerQualityRoutes(app: FastifyInstance): void {
  app.get('/datasets/:id/queue', async (request) => {
    await requireAuth(request);
    const { id } = parseWith(DatasetParamSchema, request.params);
    const query = parseWith(QueueRequestSchema, normalizeQuery(request.query));
    return getQueue(
      app.ctx,
      id,
      {
        limit: query.limit,
        offset: query.offset,
        states: query.states,
        orderBy: query.orderBy,
      },
      { injectGold: query.injectGold, seed: query.seed },
    );
  });

  app.get('/datasets/:id/overview', async (request) => {
    await requireAuth(request);
    const { id } = parseWith(DatasetParamSchema, request.params);
    return overview(app.ctx, id);
  });

  app.get('/datasets/:id/agreement', async (request) => {
    await requireAuth(request);
    const { id } = parseWith(DatasetParamSchema, request.params);
    // The path parameter is authoritative; the shared schema still validates limit.
    const query = parseWith(AgreementQuerySchema, {
      ...normalizeQuery(request.query),
      datasetId: id,
    });
    return computeAgreement(app.ctx, query.datasetId, query.limit);
  });

  app.get('/datasets/:id/disagreements', async (request) => {
    await requireAuth(request);
    const { id } = parseWith(DatasetParamSchema, request.params);
    const query = parseWith(
      PaginationQuerySchema.extend({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
      normalizeQuery(request.query),
    );
    return { data: await listDisagreements(app.ctx, id, query.limit) };
  });

  app.post('/datasets/:id/qc/sample', async (request, reply) => {
    const actor = await requireAuth(request);
    requireRole(actor, 'admin', 'reviewer');
    const { id } = parseWith(DatasetParamSchema, request.params);
    const body = parseWith(SampleQcSchema, request.body ?? {});
    void reply.status(201);
    return sampleQc(app.ctx, actor, id, body);
  });

  app.get('/datasets/:id/qc/samples', async (request) => {
    await requireAuth(request);
    const { id } = parseWith(DatasetParamSchema, request.params);
    const query = parseWith(
      PaginationQuerySchema.extend({
        status: z.enum(['open', 'resolved']).optional(),
      }),
      normalizeQuery(request.query),
    );
    const page = await listQcSamples(app.ctx, id, query.status, {
      limit: query.limit,
      offset: query.offset,
    });
    return {
      ...page,
      data: page.data.map((row: QcSampleRow) => ({
        id: row.id,
        datasetId: row.dataset_id,
        itemId: row.item_id,
        reason: row.reason,
        status: row.status,
        result: row.result,
        createdAt: new Date(row.created_at).toISOString(),
        resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
      })),
    };
  });

  app.post('/qc/samples/:sampleId/resolve', async (request) => {
    const actor = await requireAuth(request);
    requireRole(actor, 'admin', 'reviewer');
    const { sampleId } = z
      .object({ sampleId: z.string().min(1).max(64) })
      .parse(request.params);
    const body = z.object({ passed: z.boolean() }).strict().parse(request.body);
    const row = await resolveQc(app.ctx, actor, sampleId, body.passed);
    return {
      sample: {
        id: row.id,
        datasetId: row.dataset_id,
        itemId: row.item_id,
        reason: row.reason,
        status: row.status,
        result: row.result,
      },
    };
  });

  app.post('/datasets/:id/gold', async (request) => {
    const actor = await requireAuth(request);
    requireRole(actor, 'admin', 'reviewer');
    const { id } = parseWith(DatasetParamSchema, request.params);
    const body = parseWith(PromoteGoldSchema, request.body);
    const result = await promoteGold(app.ctx, actor, body);
    return { ...result, datasetId: id };
  });
}

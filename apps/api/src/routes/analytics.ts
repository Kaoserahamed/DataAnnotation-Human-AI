/** Analytics routes: annotator performance and annotation history. */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HistoryQuerySchema } from '../shared.js';
import { normalizeQuery, parseWith, requireAuth } from '../lib/http.js';
import { annotatorPerformance, history } from '../services/analytics-service.js';

export function registerAnalyticsRoutes(app: FastifyInstance): void {
  app.get('/analytics/annotators', async (request) => {
    await requireAuth(request);
    const query = parseWith(
      z.object({ datasetId: z.string().min(1).max(64).optional() }),
      normalizeQuery(request.query),
    );
    return { data: await annotatorPerformance(app.ctx, query.datasetId) };
  });

  app.get('/analytics/history', async (request) => {
    await requireAuth(request);
    const query = parseWith(HistoryQuerySchema, normalizeQuery(request.query));
    return history(app.ctx, query);
  });
}

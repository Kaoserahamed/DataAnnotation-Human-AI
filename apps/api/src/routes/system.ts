/**
 * Operational endpoints: liveness, readiness, and metrics.
 * These are the observability signals required by the acceptance guideline.
 */

import type { FastifyInstance } from 'fastify';
import type { HealthResponse, MetricsResponse } from '../shared.js';
import { errors } from '../lib/errors.js';
import { requireAuth } from '../lib/http.js';
import { VERSION } from '../version.js';

export function registerSystemRoutes(app: FastifyInstance): void {
  app.get('/', async () => ({
    name: 'human-ai-annotation-platform',
    version: VERSION,
    endpoints: { health: '/health', ready: '/ready', api: '/api' },
  }));

  // Liveness + database reachability (authenticated-free for probes).
  app.get('/health', async (): Promise<HealthResponse> => {
    const latencyMs = await app.db.ping();
    return {
      status: latencyMs === null ? 'degraded' : 'ok',
      uptimeSeconds: app.ctx.metrics.uptimeSeconds,
      version: VERSION,
      database: { reachable: latencyMs !== null, latencyMs },
    };
  });

  // Readiness: 503 when the database is unreachable so orchestrators stop
  // routing traffic instead of queueing doomed requests.
  app.get('/ready', async (request, reply): Promise<HealthResponse> => {
    const latencyMs = await app.db.ping();
    const body: HealthResponse = {
      status: latencyMs === null ? 'degraded' : 'ok',
      uptimeSeconds: app.ctx.metrics.uptimeSeconds,
      version: VERSION,
      database: { reachable: latencyMs !== null, latencyMs },
    };
    if (latencyMs === null) void reply.status(503);
    return body;
  });

  app.get('/metrics', async (request): Promise<MetricsResponse> => {
    const user = await requireAuth(request);
    if (user.role !== 'admin') throw errors.forbidden('admin role required');
    const snapshot = app.ctx.metrics.snapshot();
    const stateRows = await app.db.query<{ state: string; count: string }>(
      'SELECT state, count(*)::text AS count FROM tasks GROUP BY state',
    );
    const tasks: Record<string, number> = {};
    for (const row of stateRows) tasks[row.state] = Number(row.count);
    return { ...snapshot, tasks };
  });
}

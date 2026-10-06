/**
 * Fastify application factory.
 *
 * `buildApp` wires configuration, database, AI provider, metrics, security
 * middleware, the single error handler, and all route modules. Tests call it
 * directly with injected config/db/provider so no network or environment is
 * required; `src/index.ts` is the only place that binds a port.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { MAX_JSON_BODY_BYTES } from '@haap/shared';
import { loadConfig, type AppConfig } from './config.js';
import { createDatabase, type Database } from './db/database.js';
import { runMigrations } from './db/migrate.js';
import { registerErrorHandler } from './lib/errors.js';
import { newId } from './lib/ids.js';
import { Metrics } from './lib/metrics.js';
import { createProvider, type PrelabelProvider } from './providers/registry.js';
import { registerAnalyticsRoutes } from './routes/analytics.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerCatalogRoutes } from './routes/catalog.js';
import { registerQualityRoutes } from './routes/quality.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerTaskRoutes } from './routes/tasks.js';
import type { ServiceContext } from './services/context.js';

export interface BuildAppOptions {
  config?: AppConfig;
  db?: Database;
  provider?: PrelabelProvider;
  /** Apply pending migrations on boot (default true). */
  migrate?: boolean;
}

export interface BuiltServer {
  app: FastifyInstance;
  config: AppConfig;
  db: Database;
  ctx: ServiceContext;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<BuiltServer> {
  const config = options.config ?? loadConfig();
  const db = options.db ?? (await createDatabase(config));
  if (options.migrate !== false) await runMigrations(db);
  const provider = options.provider ?? createProvider(config);
  const metrics = new Metrics(provider.name);
  const ctx: ServiceContext = { db, provider, metrics };

  const app = Fastify({
    logger: config.NODE_ENV === 'test' ? false : { level: 'info' },
    genReqId: () => newId(),
    bodyLimit: MAX_JSON_BODY_BYTES,
  });

  app.decorate('config', config);
  app.decorate('db', db);
  app.decorate('ctx', ctx);

  await app.register(helmet);
  await app.register(cors, {
    origin: config.CORS_ORIGIN.split(',').map((origin) => origin.trim()),
  });

  app.addHook('onRequest', async (request) => {
    metrics.requestStarted();
    (request as { startTime?: number }).startTime = performance.now();
  });
  app.addHook('onResponse', async (request, reply) => {
    const start = (request as { startTime?: number }).startTime ?? performance.now();
    metrics.requestFinished(performance.now() - start, reply.statusCode >= 500);
  });

  registerErrorHandler(app);
  registerSystemRoutes(app);

  await app.register(
    async (api) => {
      registerAuthRoutes(api);
      registerCatalogRoutes(api);
      registerTaskRoutes(api);
      registerQualityRoutes(api);
      registerAnalyticsRoutes(api);
    },
    { prefix: '/api' },
  );

  app.addHook('onClose', async () => {
    await db.close();
  });

  return { app, config, db, ctx };
}

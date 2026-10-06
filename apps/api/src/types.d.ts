import type { AppConfig } from './config.js';
import type { Database } from './db/database.js';
import type { ServiceContext } from './services/context.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig;
    db: Database;
    ctx: ServiceContext;
  }
}

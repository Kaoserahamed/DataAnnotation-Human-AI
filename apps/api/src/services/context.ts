/**
 * Service layer wiring: every service receives the same context so its
 * dependencies (database, AI provider, metrics) are explicit and testable.
 */

import type { UserRole } from '@haap/shared';
import type { Database } from '../db/database.js';
import type { PrelabelProvider } from '../providers/registry.js';
import type { Metrics } from '../lib/metrics.js';

/** The authenticated principal attached to a request. */
export interface AuthUser {
  id: string;
  email: string;
  role: UserRole;
}

export interface ServiceContext {
  db: Database;
  provider: PrelabelProvider;
  metrics: Metrics;
}

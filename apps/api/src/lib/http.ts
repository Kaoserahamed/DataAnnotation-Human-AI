/**
 * Route helpers: authentication, authorization, and body/query parsing.
 *
 * Authorization decisions live here (not scattered through handlers):
 * every route either calls `requireAuth` or is explicitly public, and
 * `requireRole` centrally maps role sets to 403 responses.
 */

import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { UserRole } from '../shared.js';
import { verifyToken } from './auth.js';
import { errors } from './errors.js';
import type { AuthUser } from '../services/context.js';

/** Extract and verify the bearer token; throws 401 when missing/invalid. */
export async function requireAuth(request: FastifyRequest): Promise<AuthUser> {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw errors.unauthorized('missing bearer token');
  }
  const claims = await verifyToken(header.slice(7), request.server.config.jwtSecret);
  if (!claims) throw errors.unauthorized('invalid or expired token');
  return { id: claims.sub, email: claims.email, role: claims.role };
}

/** Like `requireAuth` but returns null instead of throwing (public routes). */
export async function optionalAuth(request: FastifyRequest): Promise<AuthUser | null> {
  try {
    return await requireAuth(request);
  } catch {
    return null;
  }
}

export function requireRole(user: AuthUser, ...roles: readonly UserRole[]): void {
  if (!roles.includes(user.role)) {
    throw errors.forbidden(`requires role: ${roles.join(' or ')}`);
  }
}

/**
 * Parse with a Zod schema and return its **output** type (defaults applied).
 * `ZodError` surfaces to the global handler as a 400.
 */
export function parseWith<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  return schema.parse(value) as z.output<S>;
}

/**
 * Fastify's default query parser yields strings; shared array schemas need
 * real arrays. `states` is always list-valued (`?states=a` or `?states=a,b`)
 * and other string params are split on commas.
 */
const ARRAY_QUERY_KEYS = new Set(['states']);

export function normalizeQuery(query: unknown): Record<string, unknown> {
  if (query === null || typeof query !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (typeof value === 'string' && (ARRAY_QUERY_KEYS.has(key) || value.includes(','))) {
      out[key] = value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
    } else {
      out[key] = value;
    }
  }
  return out;
}

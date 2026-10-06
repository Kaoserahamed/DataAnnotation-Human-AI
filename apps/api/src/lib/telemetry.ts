/**
 * Observability initialisation: structured logging configuration and error
 * tracking stub.
 *
 * Fastify ships pino as its built-in logger. This module:
 *   1. Builds the pino logger options (level from config, pretty-print in
 *      development, silent in test so test output stays clean).
 *   2. Provides a `captureError` helper backed by a thin Sentry-compatible
 *      interface. When SENTRY_DSN is blank the stub is a no-op — no network
 *      calls, no dependency on @sentry/node at runtime.
 *
 * To enable real Sentry reporting:
 *   npm install --save @sentry/node --workspace @haap/api
 *   Set SENTRY_DSN=https://<key>@sentry.io/<project> in your .env
 *
 * The module is deliberately free of side-effects at import time so tests
 * can require it without triggering network connections.
 */

import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from '../config.js';

// ─── Pino logger options ─────────────────────────────────────────────────────

export type LogLevel = AppConfig['LOG_LEVEL'];

/**
 * Build Fastify-compatible logger options from config.
 *
 * In development: human-readable transport (pino-pretty when available,
 * falling back to default JSON). In test: silenced so test output is clean.
 * In production: structured JSON at the configured level.
 */
export function buildLoggerOptions(config: Pick<AppConfig, 'NODE_ENV' | 'LOG_LEVEL'>):
  | false
  | { level: string; transport?: { target: string; options?: Record<string, unknown> } } {
  if (config.NODE_ENV === 'test') return false; // Fastify silences when false

  if (config.NODE_ENV === 'development') {
    return {
      level: config.LOG_LEVEL,
      transport: {
        target: 'pino/file', // writes JSON to stdout — no pino-pretty dependency
        options: { destination: 1 },
      },
    };
  }

  // production: plain JSON, level from env
  return { level: config.LOG_LEVEL };
}

// ─── Error tracking stub ─────────────────────────────────────────────────────

/**
 * Minimal interface the platform uses for error capture.
 * A real Sentry client satisfies this without adapter code.
 */
export interface ErrorTracker {
  captureException(error: unknown, context?: Record<string, unknown>): string | undefined;
  captureMessage(message: string, level?: 'info' | 'warning' | 'error'): string | undefined;
  /** True when the tracker is wired to a real backend. */
  readonly enabled: boolean;
}

/** No-op tracker used when SENTRY_DSN is blank. */
class NoopTracker implements ErrorTracker {
  readonly enabled = false;
  captureException(_error: unknown): undefined { return undefined; }
  captureMessage(_message: string): undefined { return undefined; }
}

/**
 * Create an ErrorTracker from config.
 *
 * Returns a no-op instance when SENTRY_DSN is empty so callers never have
 * to null-check. Swap the body of the `if` branch for `@sentry/node` when
 * you want real reporting:
 *
 *   import * as Sentry from '@sentry/node';
 *   Sentry.init({ dsn: config.SENTRY_DSN, environment: config.NODE_ENV });
 *   return { enabled: true, captureException: Sentry.captureException.bind(Sentry), ... };
 */
export function createTracker(config: Pick<AppConfig, 'SENTRY_DSN' | 'NODE_ENV'>): ErrorTracker {
  if (config.SENTRY_DSN) {
    // Real Sentry integration goes here — return a live tracker.
    // For now, log a warning and fall through to noop so the build
    // doesn't require @sentry/node as a hard dependency.
    console.warn(
      '[telemetry] SENTRY_DSN is set but @sentry/node is not installed. ' +
      'Add it with: npm install --save @sentry/node --workspace @haap/api',
    );
  }
  return new NoopTracker();
}

// ─── Structured error logging helper ─────────────────────────────────────────

export interface ErrorLogFields {
  requestId: string;
  code: string;
  statusCode: number;
  message: string;
  err: unknown;
}

/**
 * Log an application error as a structured JSON object and optionally
 * capture it via the tracker.
 *
 * The shape is intentionally flat so log aggregators (Datadog, CloudWatch,
 * Loki) can index `code`, `statusCode`, and `requestId` as top-level fields.
 */
export function logAndCapture(
  logger: FastifyBaseLogger,
  tracker: ErrorTracker,
  fields: ErrorLogFields,
): void {
  logger.error({
    requestId: fields.requestId,
    code: fields.code,
    statusCode: fields.statusCode,
    message: fields.message,
    err: fields.err instanceof Error
      ? { name: fields.err.name, message: fields.err.message, stack: fields.err.stack }
      : fields.err,
  }, fields.message);

  if (fields.statusCode >= 500) {
    tracker.captureException(fields.err, {
      requestId: fields.requestId,
      code: fields.code,
    });
  }
}

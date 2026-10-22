/**
 * Tests for the telemetry module:
 *   - buildLoggerOptions produces correct Fastify logger config per NODE_ENV
 *   - createTracker returns a no-op when SENTRY_DSN is blank
 *   - logAndCapture emits a structured JSON log shape and calls captureException
 *     only for 5xx errors
 */

import { describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import {
  buildLoggerOptions,
  createTracker,
  logAndCapture,
  type ErrorLogFields,
  type ErrorTracker,
} from '../src/lib/telemetry.js';

// ─── buildLoggerOptions ───────────────────────────────────────────────────────

describe('buildLoggerOptions', () => {
  it('returns false in test mode so Fastify stays silent', () => {
    const result = buildLoggerOptions({ NODE_ENV: 'test', LOG_LEVEL: 'info' });
    expect(result).toBe(false);
  });

  it('returns a config object in development with the given level', () => {
    const result = buildLoggerOptions({ NODE_ENV: 'development', LOG_LEVEL: 'debug' });
    expect(result).not.toBe(false);
    if (result !== false) {
      expect(result.level).toBe('debug');
    }
  });

  it('returns a config object in production with the given level', () => {
    const result = buildLoggerOptions({ NODE_ENV: 'production', LOG_LEVEL: 'warn' });
    expect(result).not.toBe(false);
    if (result !== false) {
      expect(result.level).toBe('warn');
    }
  });

  it('production config has no transport (plain JSON)', () => {
    const result = buildLoggerOptions({ NODE_ENV: 'production', LOG_LEVEL: 'info' });
    if (result !== false) {
      // production should not have a custom transport — plain pino JSON
      expect((result as { transport?: unknown }).transport).toBeUndefined();
    }
  });

  it('uses LOG_LEVEL from config for all non-test environments', () => {
    const levels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
    for (const level of levels) {
      const result = buildLoggerOptions({ NODE_ENV: 'production', LOG_LEVEL: level });
      if (result !== false) {
        expect(result.level).toBe(level);
      }
    }
  });
});

// ─── createTracker ────────────────────────────────────────────────────────────

describe('createTracker', () => {
  it('returns a disabled no-op when SENTRY_DSN is empty', () => {
    const tracker = createTracker({ SENTRY_DSN: '', NODE_ENV: 'development' });
    expect(tracker.enabled).toBe(false);
    expect(tracker.captureException(new Error('test'))).toBeUndefined();
    expect(tracker.captureMessage('msg')).toBeUndefined();
  });

  it('no-op tracker does not throw on any input', () => {
    const tracker = createTracker({ SENTRY_DSN: '', NODE_ENV: 'production' });
    expect(() => tracker.captureException(null)).not.toThrow();
    expect(() => tracker.captureException(undefined)).not.toThrow();
    expect(() => tracker.captureException('string error')).not.toThrow();
    expect(() => tracker.captureMessage('hello', 'info')).not.toThrow();
  });

  it('returns a tracker object regardless of DSN', () => {
    // Non-empty DSN: still returns a tracker (noop until @sentry/node installed)
    const tracker = createTracker({ SENTRY_DSN: 'https://key@sentry.io/123', NODE_ENV: 'test' });
    expect(tracker).toBeDefined();
    expect(typeof tracker.captureException).toBe('function');
    expect(typeof tracker.captureMessage).toBe('function');
  });
});

// ─── logAndCapture ────────────────────────────────────────────────────────────

function makeLogger() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
    level: 'info',
    silent: vi.fn(),
  } as unknown as FastifyBaseLogger;
}

function makeTracker(): ErrorTracker & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    enabled: true,
    captureException(err, ctx) { calls.push({ err, ctx }); return 'evt-1'; },
    captureMessage(msg, level) { calls.push({ msg, level }); return 'evt-2'; },
    calls,
  };
}

describe('logAndCapture', () => {
  const baseFields: ErrorLogFields = {
    requestId: 'req-abc',
    code: 'INTERNAL_ERROR',
    statusCode: 500,
    message: 'something went wrong',
    err: new Error('boom'),
  };

  it('calls logger.error with a structured flat shape', () => {
    const logger = makeLogger();
    const tracker = makeTracker();

    logAndCapture(logger, tracker, baseFields);

    expect(logger.error).toHaveBeenCalledOnce();
    const [loggedObject, loggedMsg] = (logger.error as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(loggedObject.requestId).toBe('req-abc');
    expect(loggedObject.code).toBe('INTERNAL_ERROR');
    expect(loggedObject.statusCode).toBe(500);
    expect(loggedObject.err.name).toBe('Error');
    expect(loggedObject.err.message).toBe('boom');
    expect(typeof loggedObject.err.stack).toBe('string');
    expect(loggedMsg).toBe('something went wrong');
  });

  it('calls captureException for 5xx errors', () => {
    const logger = makeLogger();
    const tracker = makeTracker();

    logAndCapture(logger, tracker, { ...baseFields, statusCode: 500 });

    expect(tracker.calls).toHaveLength(1);
    const call = tracker.calls[0] as { ctx: { code: string } };
    expect(call.ctx.code).toBe('INTERNAL_ERROR');
  });

  it('does NOT call captureException for 4xx errors', () => {
    const logger = makeLogger();
    const tracker = makeTracker();

    logAndCapture(logger, tracker, { ...baseFields, statusCode: 404, code: 'NOT_FOUND' });

    // logger.error should still be called
    expect(logger.error).toHaveBeenCalledOnce();
    // but tracker should not capture 4xx
    expect(tracker.calls).toHaveLength(0);
  });

  it('handles non-Error objects in the err field', () => {
    const logger = makeLogger();
    const tracker = makeTracker();

    logAndCapture(logger, tracker, { ...baseFields, err: { raw: 'db-timeout' } });

    const [loggedObject] = (logger.error as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(loggedObject.err).toEqual({ raw: 'db-timeout' });
  });

  it('calls captureException for 503 as well as 500', () => {
    const logger = makeLogger();
    const tracker = makeTracker();

    logAndCapture(logger, tracker, { ...baseFields, statusCode: 503 });
    expect(tracker.calls).toHaveLength(1);
  });

  it('always emits the requestId so log aggregators can correlate', () => {
    const logger = makeLogger();
    const tracker = makeTracker();

    logAndCapture(logger, tracker, { ...baseFields, requestId: 'corr-xyz' });

    const [loggedObject] = (logger.error as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(loggedObject.requestId).toBe('corr-xyz');
  });
});

/**
 * Unit tests for API library utilities:
 *   - AppError / errors factory (errors.ts) including HTTP handler branches
 *   - Metrics ring-buffer and snapshot (metrics.ts)
 *   - newId uniqueness and format (ids.ts)
 *   - normalizeQuery comma-splitting (http.ts)
 */

import { describe, expect, it } from 'vitest';
import { AppError, errors, registerErrorHandler } from '../src/lib/errors.js';
import { Metrics } from '../src/lib/metrics.js';
import { newId } from '../src/lib/ids.js';
import { normalizeQuery } from '../src/lib/http.js';
import { createTestServer } from './helpers.js';

// ─── AppError ────────────────────────────────────────────────────────────────

describe('AppError', () => {
  it('stores the error code, message, and derived status', () => {
    const err = new AppError('NOT_FOUND', 'widget 42 not found');
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toBe('widget 42 not found');
    expect(err.statusCode).toBe(404);
    expect(err.name).toBe('AppError');
    expect(err).toBeInstanceOf(Error);
  });

  it('maps every code to the expected HTTP status', () => {
    const cases: [ConstructorParameters<typeof AppError>[0], number][] = [
      ['VALIDATION_ERROR', 400],
      ['UNAUTHORIZED', 401],
      ['FORBIDDEN', 403],
      ['NOT_FOUND', 404],
      ['CONFLICT', 409],
      ['PRECONDITION_FAILED', 412],
      ['INTERNAL_ERROR', 500],
    ];
    for (const [code, status] of cases) {
      expect(new AppError(code, 'msg').statusCode).toBe(status);
    }
  });

  it('stores optional details without modification', () => {
    const details = { field: 'email', reason: 'already taken' };
    const err = new AppError('CONFLICT', 'conflict', details);
    expect(err.details).toEqual(details);
  });

  it('leaves details undefined when not provided', () => {
    expect(new AppError('NOT_FOUND', 'x').details).toBeUndefined();
  });
});

// ─── errors factory ──────────────────────────────────────────────────────────

describe('errors factory', () => {
  it('unauthorized defaults to "authentication required"', () => {
    const err = errors.unauthorized();
    expect(err.code).toBe('UNAUTHORIZED');
    expect(err.message).toBe('authentication required');
  });

  it('unauthorized accepts a custom message', () => {
    expect(errors.unauthorized('missing bearer token').message).toBe('missing bearer token');
  });

  it('forbidden defaults to "insufficient permissions"', () => {
    expect(errors.forbidden().code).toBe('FORBIDDEN');
    expect(errors.forbidden().message).toBe('insufficient permissions');
  });

  it('notFound includes the resource name and optional id', () => {
    expect(errors.notFound('dataset').message).toBe('dataset not found');
    expect(errors.notFound('dataset', 'ds_42').message).toBe('dataset ds_42 not found');
  });

  it('conflict carries details through', () => {
    const err = errors.conflict('email taken', { email: 'x@y.z' });
    expect(err.code).toBe('CONFLICT');
    expect(err.details).toEqual({ email: 'x@y.z' });
  });

  it('precondition carries details through', () => {
    const err = errors.precondition('state mismatch', { current: 'accepted' });
    expect(err.code).toBe('PRECONDITION_FAILED');
    expect(err.details).toEqual({ current: 'accepted' });
  });

  it('validation returns a 400-equivalent error', () => {
    const err = errors.validation('bad payload', [{ path: 'email', msg: 'required' }]);
    expect(err.statusCode).toBe(400);
    expect(Array.isArray(err.details)).toBe(true);
  });
});

// ─── Metrics ─────────────────────────────────────────────────────────────────

describe('Metrics', () => {
  it('starts with zero counters', () => {
    const m = new Metrics('heuristic');
    const s = m.snapshot();
    expect(s.requests.total).toBe(0);
    expect(s.requests.inFlight).toBe(0);
    expect(s.requests.errorRate).toBe(0);
    expect(s.latency.p50).toBe(0);
    expect(s.ai.provider).toBe('heuristic');
    expect(s.ai.predictions).toBe(0);
  });

  it('increments total and inFlight on requestStarted', () => {
    const m = new Metrics('openai');
    m.requestStarted();
    m.requestStarted();
    expect(m.snapshot().requests.total).toBe(2);
    expect(m.snapshot().requests.inFlight).toBe(2);
  });

  it('decrements inFlight on requestFinished', () => {
    const m = new Metrics('heuristic');
    m.requestStarted();
    m.requestFinished(50, false);
    expect(m.snapshot().requests.inFlight).toBe(0);
  });

  it('clamps inFlight at zero on spurious finish', () => {
    const m = new Metrics('heuristic');
    m.requestFinished(10, false); // no matching start
    expect(m.snapshot().requests.inFlight).toBe(0);
  });

  it('tracks error rate correctly', () => {
    const m = new Metrics('heuristic');
    m.requestStarted(); m.requestFinished(10, false);
    m.requestStarted(); m.requestFinished(10, true);
    m.requestStarted(); m.requestFinished(10, true);
    // 2 errors / 3 total = 0.6667
    expect(m.snapshot().requests.errorRate).toBeCloseTo(2 / 3, 3);
  });

  it('computes percentiles from latency samples', () => {
    const m = new Metrics('heuristic');
    for (let i = 1; i <= 100; i++) {
      m.requestStarted();
      m.requestFinished(i, false); // 1..100 ms
    }
    const { p50, p95, p99 } = m.snapshot().latency;
    expect(p50).toBeGreaterThanOrEqual(49);
    expect(p50).toBeLessThanOrEqual(51);
    expect(p95).toBeGreaterThanOrEqual(94);
    expect(p99).toBeGreaterThanOrEqual(98);
  });

  it('rolls over the ring buffer after 1000 samples', () => {
    const m = new Metrics('heuristic');
    for (let i = 0; i < 1100; i++) {
      m.requestStarted();
      m.requestFinished(10, false);
    }
    // Buffer is capped at 1000; all samples are 10ms so p50=10
    expect(m.snapshot().latency.p50).toBe(10);
    expect(m.snapshot().requests.total).toBe(1100); // total is unbounded
  });

  it('counts AI predictions and failures separately', () => {
    const m = new Metrics('openai');
    m.recordAiPrediction(false);
    m.recordAiPrediction(false);
    m.recordAiPrediction(true);
    const s = m.snapshot();
    expect(s.ai.predictions).toBe(2);
    expect(s.ai.failures).toBe(1);
  });

  it('tracks uptime in seconds', async () => {
    const m = new Metrics('heuristic');
    await new Promise((r) => setTimeout(r, 10));
    expect(m.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});

// ─── newId ───────────────────────────────────────────────────────────────────

describe('newId', () => {
  it('returns a non-empty string', () => {
    expect(typeof newId()).toBe('string');
    expect(newId().length).toBeGreaterThan(0);
  });

  it('returns a UUID v4 pattern', () => {
    const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(newId()).toMatch(uuidV4);
  });

  it('produces unique values on successive calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, newId));
    expect(ids.size).toBe(1000);
  });

  it('fits within the IdSchema 64-character limit', () => {
    expect(newId().length).toBeLessThanOrEqual(64);
  });
});

// ─── normalizeQuery ───────────────────────────────────────────────────────────

describe('normalizeQuery', () => {
  it('splits comma-separated values into arrays', () => {
    expect(normalizeQuery({ states: 'pending_review,accepted' })).toEqual({
      states: ['pending_review', 'accepted'],
    });
  });

  it('wraps a single known array key in an array', () => {
    expect(normalizeQuery({ states: 'accepted' })).toEqual({ states: ['accepted'] });
  });

  it('leaves non-array string values unchanged', () => {
    expect(normalizeQuery({ limit: '25', offset: '0' })).toEqual({ limit: '25', offset: '0' });
  });

  it('splits any value containing a comma regardless of key', () => {
    expect(normalizeQuery({ tags: 'a,b,c' })).toEqual({ tags: ['a', 'b', 'c'] });
  });

  it('trims whitespace around commas', () => {
    expect(normalizeQuery({ states: 'accepted , needs_correct' })).toEqual({
      states: ['accepted', 'needs_correct'],
    });
  });

  it('drops empty segments from split', () => {
    expect(normalizeQuery({ states: 'accepted,,needs_correct,' })).toEqual({
      states: ['accepted', 'needs_correct'],
    });
  });

  it('returns an empty object for null or non-object input', () => {
    expect(normalizeQuery(null)).toEqual({});
    expect(normalizeQuery('string')).toEqual({});
    expect(normalizeQuery(42)).toEqual({});
  });

  it('passes non-string values through unchanged', () => {
    expect(normalizeQuery({ limit: 25 })).toEqual({ limit: 25 });
  });
});

// ─── Error handler integration (covers lines 94-101, 119-122 of errors.ts) ──

describe('registerErrorHandler — HTTP integration', () => {
  it('wraps a NOT_FOUND AppError in the standard envelope', async () => {
    const app = await createTestServer();
    try {
      const response = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.error.code).toBe('NOT_FOUND');
      expect(body.error.requestId).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  it('wraps a ZodError in a 400 VALIDATION_ERROR envelope', async () => {
    const app = await createTestServer();
    try {
      // POST /api/auth/login with a body that fails Zod validation.
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'not-an-email', password: 'x' },
      });
      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(Array.isArray(body.error.details)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('covers the INTERNAL_ERROR unhandled-error path and the 5xx AppError tracker path', async () => {
    // Build a custom server with extra test routes registered BEFORE ready().
    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const { HeuristicProvider } = await import('../src/providers/heuristic.js');

    const config = loadConfig({ NODE_ENV: 'test', DB_CLIENT: 'pglite', AI_PROVIDER: 'heuristic' });
    const { app } = await buildApp({
      config,
      provider: new HeuristicProvider(),
      migrate: false,
    });

    // Register test routes before ready().
    app.get('/test-unhandled', async () => { throw new Error('intentional unhandled'); });
    app.get('/test-5xx-app', async () => { throw new AppError('INTERNAL_ERROR', 'synthetic 500'); });
    // Simulate a Postgres unique-violation to cover the isUniqueViolation branch.
    app.get('/test-unique-violation', async () => {
      const err = new Error('duplicate key') as NodeJS.ErrnoException & { code: string };
      err.code = '23505';
      throw err;
    });

    await app.ready();
    try {
      const unhandled = await app.inject({ method: 'GET', url: '/test-unhandled' });
      expect(unhandled.statusCode).toBe(500);
      expect(unhandled.json().error.code).toBe('INTERNAL_ERROR');
      expect(unhandled.json().error.requestId).toBeTruthy();

      const appErr = await app.inject({ method: 'GET', url: '/test-5xx-app' });
      expect(appErr.statusCode).toBe(500);
      expect(appErr.json().error.code).toBe('INTERNAL_ERROR');
      expect(appErr.json().error.message).toBe('synthetic 500');

      const conflict = await app.inject({ method: 'GET', url: '/test-unique-violation' });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().error.code).toBe('CONFLICT');
      expect(conflict.json().error.message).toBe('resource already exists');
    } finally {
      await app.close();
    }
  });
});

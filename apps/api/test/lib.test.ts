/**
 * Unit tests for API library utilities:
 *   - AppError / errors factory (errors.ts)
 *   - Metrics ring-buffer and snapshot (metrics.ts)
 *   - newId uniqueness and format (ids.ts)
 *   - normalizeQuery comma-splitting (http.ts)
 */

import { describe, expect, it } from 'vitest';
import { AppError, errors } from '../src/lib/errors.js';
import { Metrics } from '../src/lib/metrics.js';
import { newId } from '../src/lib/ids.js';
import { normalizeQuery } from '../src/lib/http.js';

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

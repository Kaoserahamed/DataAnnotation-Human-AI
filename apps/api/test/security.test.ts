/**
 * Security-focused tests: configuration guard rails, password/token
 * handling, authentication envelopes, and role enforcement.
 */

import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig, ConfigError } from '../src/config.js';
import { hashPassword, signToken, verifyPassword, verifyToken } from '../src/lib/auth.js';
import { bearer, createTestServer, inject, register } from './helpers.js';

/** Produce a random password that satisfies the 12-char minimum. */
const pw = () => randomBytes(16).toString('hex');

describe('configuration guard rails', () => {
  it('runs development with defaults', () => {
    const config = loadConfig({ NODE_ENV: 'development' });
    expect(config.PORT).toBe(4000);
    expect(config.AI_PROVIDER).toBe('heuristic');
    expect(config.isProduction).toBe(false);
  });

  it('refuses to boot production without JWT_SECRET', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', DB_CLIENT: 'postgres' })).toThrow(
      ConfigError,
    );
  });

  it('refuses the development secret in production', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'production', DB_CLIENT: 'postgres', JWT_SECRET: 'x'.repeat(40) }),
    ).not.toThrow();
    expect(
      () =>
        loadConfig({
          NODE_ENV: 'production',
          DB_CLIENT: 'postgres',
          JWT_SECRET: 'development-only-insecure-secret-do-not-use-in-production',
        }),
    ).toThrow(/development JWT_SECRET/);
  });

  it('requires a persisted directory for embedded Postgres in production', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        DB_CLIENT: 'pglite',
        JWT_SECRET: 'a'.repeat(40),
      }),
    ).toThrow(/PGLITE_DIR/);
  });

  it('rejects contradictory database settings', () => {
    expect(() => loadConfig({ DB_CLIENT: 'postgres', PGLITE_DIR: './data' })).toThrow(
      /PGLITE_DIR must not be set/,
    );
  });

  it('requires an API key when the OpenAI provider is selected', () => {
    expect(() => loadConfig({ AI_PROVIDER: 'openai' })).toThrow(/OPENAI_API_KEY/);
    expect(() => loadConfig({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test' })).not.toThrow();
  });
});

describe('password and token primitives', () => {
  it('hashes and verifies passwords with salted scrypt', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(hash).not.toContain('correct horse');
    await expect(verifyPassword('correct horse battery staple', hash)).resolves.toBe(true);
    await expect(verifyPassword('wrong password', hash)).resolves.toBe(false);
  });

  it('rejects malformed stored hashes instead of throwing', async () => {
    await expect(verifyPassword('anything', 'not-a-hash')).resolves.toBe(false);
    await expect(verifyPassword('anything', 'scrypt$x$y$z$a$b')).resolves.toBe(false);
  });

  it('signs and verifies JWT claims and rejects tampering', async () => {
    const secret = 'unit-test-secret-unit-test-secret-32';
    const token = await signToken(
      { sub: 'user-1', email: 'a@b.c', role: 'annotator' },
      secret,
      '1h',
    );
    const claims = await verifyToken(token, secret);
    expect(claims).toEqual({ sub: 'user-1', email: 'a@b.c', role: 'annotator' });

    const tampered = `${token.slice(0, -3)}aaa`;
    expect(await verifyToken(tampered, secret)).toBeNull();
    expect(await verifyToken(token, 'another-secret-another-secret-32')).toBeNull();
    expect(await verifyToken('garbage', secret)).toBeNull();
  });
});

describe('HTTP security behavior', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createTestServer();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves health and readiness without authentication', async () => {
    const health = await inject(app, { method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.body.database.reachable).toBe(true);

    const ready = await inject(app, { method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.body.status).toBe('ok');
  });

  it('returns the standard error envelope for unknown routes', async () => {
    const response = await inject(app, { method: 'GET', url: '/api/does-not-exist' });
    expect(response.statusCode).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(response.body.error.requestId).toBeTruthy();
  });

  it('validates credentials without leaking which field failed', async () => {
    const wrongPassword = await inject(app, {
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'ghost@test.local', password: 'irrelevant-password' },
    });
    expect(wrongPassword.statusCode).toBe(401);
    expect(wrongPassword.body.error.message).toBe('invalid email or password');

    const invalidBody = await inject(app, {
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'not-an-email', password: 'short' },
    });
    expect(invalidBody.statusCode).toBe(400);
    expect(invalidBody.body.error.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(invalidBody.body.error.details)).toBe(true);
  });

  it('rejects protected routes without a token', async () => {
    const response = await inject(app, { method: 'GET', url: '/api/projects' });
    expect(response.statusCode).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
  });

  it('enforces role boundaries after bootstrap', async () => {
    const adminPw = pw();
    const workerPw = pw();

    await register(app, {
      email: 'first-admin@sec.local',
      name: 'First Admin',
      password: adminPw,
    });
    const adminLogin = await inject(app, {
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'first-admin@sec.local', password: adminPw },
    });
    const adminToken = adminLogin.body.token as string;

    await register(
      app,
      { email: 'worker@sec.local', name: 'Worker', password: workerPw },
      adminToken,
    );

    const userLogin = await inject(app, {
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'worker@sec.local', password: workerPw },
    });
    const userToken = userLogin.body.token as string;

    // Annotators cannot create projects or register users.
    const forbiddenProject = await inject(app, {
      method: 'POST',
      url: '/api/projects',
      headers: bearer(userToken),
      payload: { name: 'sneaky' },
    });
    expect(forbiddenProject.statusCode).toBe(403);

    const forbiddenRegister = await inject(app, {
      method: 'POST',
      url: '/api/auth/register',
      headers: bearer(userToken),
      payload: { email: 'x@example.com', name: 'X', password: pw() },
    });
    expect(forbiddenRegister.statusCode).toBe(403);

    // Self-registration without a token after bootstrap is also forbidden.
    const orphan = await register(app, {
      email: 'orphan@sec.local',
      name: 'Orphan',
      password: pw(),
    });
    expect(orphan.statusCode).toBe(403);

    // Duplicate emails conflict rather than crash.
    const duplicate = await register(
      app,
      { email: 'worker@sec.local', name: 'Copy', password: pw() },
      adminToken,
    );
    expect(duplicate.statusCode).toBe(409);
  });

  it('blocks annotation with a garbage token', async () => {
    const response = await inject(app, {
      method: 'POST',
      url: '/api/tasks/whatever/annotate',
      headers: bearer('not.a.token'),
      payload: { label: { label: 'x' } },
    });
    expect(response.statusCode).toBe(401);
  });
});

/**
 * Test harness: an in-memory server per suite plus auth/CRUD helpers.
 *
 * Every server gets its own in-memory PGlite database (a real Postgres
 * engine), the deterministic heuristic provider, and NODE_ENV=test so no
 * environment variables are required to run the suite.
 */

import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { HeuristicProvider } from '../src/providers/heuristic.js';

export async function createTestServer(): Promise<FastifyInstance> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DB_CLIENT: 'pglite',
    AI_PROVIDER: 'heuristic',
  });
  const { app } = await buildApp({ config, provider: new HeuristicProvider() });
  await app.ready();
  return app;
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export async function register(
  app: FastifyInstance,
  user: { email: string; name: string; password: string; role?: string },
  token?: string,
): Promise<{ statusCode: number; body: any }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    ...(token ? { headers: bearer(token) } : {}),
    payload: user as never,
  });
  return { statusCode: response.statusCode, body: response.json() };
}

export async function login(
  app: FastifyInstance,
  email: string,
  password: string,
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password },
  });
  if (response.statusCode !== 200) {
    throw new Error(`login failed (${response.statusCode}): ${response.body}`);
  }
  return response.json().token as string;
}

export interface TestWorld {
  adminToken: string;
  annotatorToken: string;
  annotator2Token: string;
  reviewerToken: string;
  projectId: string;
  datasetId: string;
}

/** Register the four demo roles and a project + sentiment dataset. */
export async function bootstrapWorld(
  app: FastifyInstance,
  options: { taskType?: string; labelSchema?: Record<string, unknown>; itemCount?: number } = {},
): Promise<TestWorld> {
  const admin = await register(app, {
    email: 'admin@test.local',
    name: 'Admin',
    password: 'admin-password-1',
    role: 'admin',
  });
  if (admin.statusCode !== 201) throw new Error(`admin bootstrap failed: ${JSON.stringify(admin.body)}`);
  const adminToken = await login(app, 'admin@test.local', 'admin-password-1');

  await register(
    app,
    { email: 'ann1@test.local', name: 'Ann One', password: 'annotator-password' },
    adminToken,
  );
  await register(
    app,
    { email: 'ann2@test.local', name: 'Ann Two', password: 'annotator-password' },
    adminToken,
  );
  await register(
    app,
    { email: 'rev@test.local', name: 'Rev Er', password: 'reviewer-password-1', role: 'reviewer' },
    adminToken,
  );

  const annotatorToken = await login(app, 'ann1@test.local', 'annotator-password');
  const annotator2Token = await login(app, 'ann2@test.local', 'annotator-password');
  const reviewerToken = await login(app, 'rev@test.local', 'reviewer-password-1');

  const project = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: bearer(adminToken),
    payload: { name: 'Test project', description: 'for tests' },
  });
  const projectId = project.json().project.id as string;

  const dataset = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/datasets`,
    headers: bearer(adminToken),
    payload: {
      name: 'Test dataset',
      taskType: options.taskType ?? 'sentiment',
      labelSchema: options.labelSchema ?? { categories: ['positive', 'negative', 'neutral'] },
    },
  });
  const datasetId = dataset.json().dataset.id as string;

  return {
    adminToken,
    annotatorToken,
    annotator2Token,
    reviewerToken,
    projectId,
    datasetId,
  };
}

export async function createItems(
  app: FastifyInstance,
  adminToken: string,
  datasetId: string,
  items: Array<{ content: unknown }>,
): Promise<string[]> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/datasets/${datasetId}/items`,
    headers: bearer(adminToken),
    payload: { items },
  });
  if (response.statusCode !== 201) {
    throw new Error(`createItems failed (${response.statusCode}): ${response.body}`);
  }
  return response.json().items.map((item: { id: string }) => item.id);
}

export async function inject(
  app: FastifyInstance,
  options: InjectOptions,
): Promise<{ statusCode: number; body: any }> {
  const response = await app.inject(options);
  return { statusCode: response.statusCode, body: response.json() };
}

/**
 * Quality-control and queue behavior: seeded QC sampling, gold-injection
 * planning, active-learning ordering, and admin state overrides.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  bearer,
  bootstrapWorld,
  createItems,
  createTestServer,
  inject,
  type TestWorld,
} from './helpers.js';

describe('quality control and queue', () => {
  let app: FastifyInstance;
  let world: TestWorld;

  beforeAll(async () => {
    app = await createTestServer();
    world = await bootstrapWorld(app);
    await createItems(app, world.adminToken, world.datasetId, [
      {
        content: {
          text: 'Good stuff.',
          importedPrediction: { taskType: 'sentiment', label: { label: 'positive' } },
          importedConfidence: 0.95,
        },
      },
      {
        content: {
          text: 'Bad stuff.',
          importedPrediction: { taskType: 'sentiment', label: { label: 'negative' } },
          importedConfidence: 0.4,
        },
      },
      { content: { text: 'Neutral wording, no signal.' } },
    ]);
    await inject(app, {
      method: 'POST',
      url: `/api/datasets/${world.datasetId}/prelabel`,
      headers: bearer(world.adminToken),
      payload: {},
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('orders the queue by acquisition score with explainable signals', async () => {
    const response = await inject(app, {
      method: 'GET',
      url: `/api/datasets/${world.datasetId}/queue?limit=10`,
      headers: bearer(world.annotatorToken),
    });
    expect(response.statusCode).toBe(200);
    expect(response.body.data.length).toBe(3);
    const scores = response.body.data.map((entry: any) => entry.signals.acquisitionScore);
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
    }
    // The lowest-confidence AI proposal is queued first.
    const first = response.body.data[0];
    expect(first.task.aiConfidence).toBeLessThan(0.5);
    expect(first.signals.uncertainty).toBeGreaterThan(0.5);
  });

  it('filters the queue by state', async () => {
    const response = await inject(app, {
      method: 'GET',
      url: `/api/datasets/${world.datasetId}/queue?states=escalated`,
      headers: bearer(world.annotatorToken),
    });
    expect(response.statusCode).toBe(200);
    expect(response.body.data.length).toBeGreaterThan(0);
    for (const entry of response.body.data) {
      expect(entry.task.state).toBe('escalated');
    }
  });

  it('plans deterministic gold-question injection', async () => {
    const url = `/api/datasets/${world.datasetId}/queue?injectGold=true&seed=7&limit=10`;
    const first = await inject(app, {
      method: 'GET',
      url,
      headers: bearer(world.annotatorToken),
    });
    const second = await inject(app, {
      method: 'GET',
      url,
      headers: bearer(world.annotatorToken),
    });
    expect(first.body.goldInjection).toBeDefined();
    expect(first.body.goldInjection).toEqual(second.body.goldInjection);
    expect(first.body.goldInjection.goldItemIds).toEqual([]); // nothing promoted yet
  });

  it('samples QC reproducibly per seed and skips open samples', async () => {
    const first = await inject(app, {
      method: 'POST',
      url: `/api/datasets/${world.datasetId}/qc/sample`,
      headers: bearer(world.reviewerToken),
      payload: { reason: 'risk', size: 2, seed: 42 },
    });
    expect(first.statusCode).toBe(201);
    expect(first.body.sampled.length).toBeGreaterThan(0);
    const firstIds = first.body.sampled.map((s: any) => s.itemId);

    // Everything selected now has an open sample: a rerun selects nothing new.
    const rerun = await inject(app, {
      method: 'POST',
      url: `/api/datasets/${world.datasetId}/qc/sample`,
      headers: bearer(world.reviewerToken),
      payload: { reason: 'risk', size: 2, seed: 42 },
    });
    expect(rerun.body.sampled).toEqual([]);
    expect([...rerun.body.skippedExisting].sort()).toEqual([...firstIds].sort());

    // Resolve one sample, and the same seed picks it up again.
    const list = await inject(app, {
      method: 'GET',
      url: `/api/datasets/${world.datasetId}/qc/samples?status=open`,
      headers: bearer(world.reviewerToken),
    });
    const sampleId = list.body.data[0].id as string;
    const resolved = await inject(app, {
      method: 'POST',
      url: `/api/qc/samples/${sampleId}/resolve`,
      headers: bearer(world.reviewerToken),
      payload: { passed: true },
    });
    expect(resolved.body.sample.status).toBe('resolved');

    const again = await inject(app, {
      method: 'POST',
      url: `/api/datasets/${world.datasetId}/qc/sample`,
      headers: bearer(world.reviewerToken),
      payload: { reason: 'risk', size: 2, seed: 42 },
    });
    expect(again.body.sampled.length).toBeGreaterThan(0);
    expect(again.body.sampled.map((s: any) => s.itemId)).toContain(list.body.data[0].itemId);

    // Resolving twice conflicts.
    const twice = await inject(app, {
      method: 'POST',
      url: `/api/qc/samples/${sampleId}/resolve`,
      headers: bearer(world.reviewerToken),
      payload: { passed: false },
    });
    expect(twice.statusCode).toBe(409);
  });

  it('rejects invalid QC requests with the validation envelope', async () => {
    const bad = await inject(app, {
      method: 'POST',
      url: `/api/datasets/${world.datasetId}/qc/sample`,
      headers: bearer(world.reviewerToken),
      payload: { reason: 'gold_check', size: 1 },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');

    const annotator = await inject(app, {
      method: 'POST',
      url: `/api/datasets/${world.datasetId}/qc/sample`,
      headers: bearer(world.annotatorToken),
      payload: { reason: 'random', size: 1 },
    });
    expect(annotator.statusCode).toBe(403);
  });

  it('enforces the state-transition table on admin overrides', async () => {
    const queue = await inject(app, {
      method: 'GET',
      url: `/api/datasets/${world.datasetId}/queue?limit=10&orderBy=created`,
      headers: bearer(world.adminToken),
    });
    const taskId = queue.body.data[0].task.id as string;

    // pending_review -> accepted is allowed.
    const allowed = await inject(app, {
      method: 'PATCH',
      url: `/api/tasks/${taskId}/state`,
      headers: bearer(world.adminToken),
      payload: { state: 'accepted', reason: 'adjudicated' },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.body.task.state).toBe('accepted');

    // accepted -> pending_review is forbidden by the shared table.
    const forbidden = await inject(app, {
      method: 'PATCH',
      url: `/api/tasks/${taskId}/state`,
      headers: bearer(world.adminToken),
      payload: { state: 'pending_review' },
    });
    expect(forbidden.statusCode).toBe(412);

    // Only admins may override.
    const notAdmin = await inject(app, {
      method: 'PATCH',
      url: `/api/tasks/${taskId}/state`,
      headers: bearer(world.reviewerToken),
      payload: { state: 'escalated' },
    });
    expect(notAdmin.statusCode).toBe(403);
  });

  it('records per-task event history for reviewers', async () => {
    const queue = await inject(app, {
      method: 'GET',
      url: `/api/datasets/${world.datasetId}/queue?limit=10&orderBy=created`,
      headers: bearer(world.adminToken),
    });
    const taskId = queue.body.data[0].task.id as string;

    const events = await inject(app, {
      method: 'GET',
      url: `/api/tasks/${taskId}/events`,
      headers: bearer(world.reviewerToken),
    });
    expect(events.statusCode).toBe(200);
    expect(events.body.total).toBeGreaterThan(0);

    const annotations = await inject(app, {
      method: 'GET',
      url: `/api/tasks/${taskId}/annotations`,
      headers: bearer(world.reviewerToken),
    });
    expect(annotations.statusCode).toBe(200);
    expect(Array.isArray(annotations.body.data)).toBe(true);
  });
});

/**
 * End-to-end coverage of the pipeline:
 * dataset -> AI pre-labeling -> human verification -> correct/incorrect
 * branches -> gold dataset, plus review, agreement, history and analytics.
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

describe('annotation workflow (e2e)', () => {
  let app: FastifyInstance;
  let world: TestWorld;

  beforeAll(async () => {
    app = await createTestServer();
    world = await bootstrapWorld(app);
  });

  afterAll(async () => {
    await app.close();
  });

  async function addItems(items: Array<{ content: unknown }>): Promise<string[]> {
    return createItems(app, world.adminToken, world.datasetId, items);
  }

  async function queueEntry(itemId: string): Promise<any> {
    const { body } = await inject(app, {
      method: 'GET',
      url: `/api/datasets/${world.datasetId}/queue?limit=100&orderBy=created`,
      headers: bearer(world.annotatorToken),
    });
    return body.data.find((entry: any) => entry.task.itemId === itemId);
  }

  it('registers the first user as admin and issues tokens', async () => {
    const { statusCode, body } = await inject(app, {
      method: 'GET',
      url: '/api/auth/me',
      headers: bearer(world.adminToken),
    });
    expect(statusCode).toBe(200);
    expect(body.user.role).toBe('admin');
    expect(body.user.email).toBe('admin@test.local');
  });

  it('pre-labels items and routes them by AI confidence', async () => {
    const [highId = '', lowId = '', lexiconId = ''] = await addItems([
      {
        content: {
          text: 'Absolutely wonderful product.',
          importedPrediction: { taskType: 'sentiment', label: { label: 'positive' } },
          importedConfidence: 0.97,
        },
      },
      {
        content: {
          text: 'Mediocre at best.',
          importedPrediction: { taskType: 'sentiment', label: { label: 'neutral' } },
          importedConfidence: 0.31,
        },
      },
      { content: { text: 'I love this amazing product, great!' } },
    ]);

    const run = await inject(app, {
      method: 'POST',
      url: `/api/datasets/${world.datasetId}/prelabel`,
      headers: bearer(world.adminToken),
      payload: {},
    });
    expect(run.statusCode).toBe(200);
    expect(run.body.processed).toBe(3);
    expect(run.body.failures).toBe(0);
    expect(run.body.provider).toBe('heuristic');

    const high = await queueEntry(highId);
    expect(high.task.state).toBe('pending_review');
    expect(high.task.aiConfidence).toBeCloseTo(0.97, 5);
    expect(high.signals.uncertainty).toBeCloseTo(0.03, 5);

    const low = await queueEntry(lowId);
    expect(low.task.state).toBe('escalated');
    expect(low.signals.uncertainty).toBeGreaterThan(0.6);

    const lexicon = await queueEntry(lexiconId);
    expect(lexicon.task.state).toBe('pending_review');
    expect(lexicon.task.aiLabel.label.label).toBe('positive');
    expect(lexicon.task.aiConfidence).toBeGreaterThan(0.5);
  });

  it('accepts an agreeing human label and promotes to gold after two confirmations', async () => {
    const [itemId = ''] = await addItems([
      {
        content: {
          text: 'Great value, highly recommend.',
          importedPrediction: { taskType: 'sentiment', label: { label: 'positive' } },
          importedConfidence: 0.95,
        },
      },
    ]);
    await inject(app, {
      method: 'POST',
      url: `/api/datasets/${world.datasetId}/prelabel`,
      headers: bearer(world.adminToken),
      payload: { itemIds: [itemId] },
    });
    const entry = await queueEntry(itemId);
    const taskId = entry.task.id as string;

    const first = await inject(app, {
      method: 'POST',
      url: `/api/tasks/${taskId}/annotate`,
      headers: bearer(world.annotatorToken),
      payload: { label: { label: 'positive' }, timeSpentMs: 4200 },
    });
    expect(first.statusCode).toBe(200);
    expect(first.body.kind).toBe('accepted');
    expect(first.body.verdict).toBe('correct');
    expect(first.body.promotedToGold).toBe(false);
    expect(first.body.task.state).toBe('accepted');

    const second = await inject(app, {
      method: 'POST',
      url: `/api/tasks/${taskId}/annotate`,
      headers: bearer(world.annotator2Token),
      payload: { label: { label: 'positive' }, timeSpentMs: 3100 },
    });
    expect(second.body.priorHumanConfirmations).toBe(1);
    expect(second.body.promotedToGold).toBe(true);

    const item = await inject(app, {
      method: 'GET',
      url: `/api/datasets/${world.datasetId}/items/${itemId}`,
      headers: bearer(world.adminToken),
    });
    expect(item.body.item.split).toBe('gold');
  });

  it('routes disagreement with the AI to needs_correct and lets a reviewer resolve it', async () => {
    const [itemId = ''] = await addItems([
      {
        content: {
          text: 'Wonderful, perfect, loved it.',
          importedPrediction: { taskType: 'sentiment', label: { label: 'positive' } },
          importedConfidence: 0.93,
        },
      },
    ]);
    await inject(app, {
      method: 'POST',
      url: `/api/datasets/${world.datasetId}/prelabel`,
      headers: bearer(world.adminToken),
      payload: { itemIds: [itemId] },
    });
    const entry = await queueEntry(itemId);
    const taskId = entry.task.id as string;

    const corrected = await inject(app, {
      method: 'POST',
      url: `/api/tasks/${taskId}/annotate`,
      headers: bearer(world.annotatorToken),
      payload: { label: { label: 'negative' } },
    });
    expect(corrected.body.kind).toBe('corrected');
    expect(corrected.body.task.state).toBe('needs_correct');
    expect(corrected.body.task.finalLabel.label.label).toBe('negative');

    const review = await inject(app, {
      method: 'POST',
      url: `/api/tasks/${taskId}/review`,
      headers: bearer(world.reviewerToken),
      payload: {
        verdict: 'corrected',
        correctedLabel: { label: 'neutral' },
        note: 'mixed signals in text',
      },
    });
    expect(review.statusCode).toBe(200);
    expect(review.body.task.state).toBe('accepted');
    expect(review.body.task.finalLabel.label.label).toBe('neutral');
  });

  it('keeps escalated items workable and escalates rejected reviews', async () => {
    const [escalatedId = ''] = await addItems([
      {
        content: {
          text: 'Bland and unremarkable.',
          importedPrediction: { taskType: 'sentiment', label: { label: 'neutral' } },
          importedConfidence: 0.22,
        },
      },
      {
        content: {
          text: 'Fantastic, best purchase this year.',
          importedPrediction: { taskType: 'sentiment', label: { label: 'positive' } },
          importedConfidence: 0.96,
        },
      },
    ]);
    await inject(app, {
      method: 'POST',
      url: `/api/datasets/${world.datasetId}/prelabel`,
      headers: bearer(world.adminToken),
      payload: {},
    });

    const escalated = await queueEntry(escalatedId);
    expect(escalated.task.state).toBe('escalated');

    // A correction on an escalated task lands in senior `in_review`.
    const fix = await inject(app, {
      method: 'POST',
      url: `/api/tasks/${escalated.task.id}/annotate`,
      headers: bearer(world.annotatorToken),
      payload: { label: { label: 'negative' } },
    });
    expect(fix.statusCode).toBe(200);
    expect(fix.body.task.state).toBe('in_review');

    // A reviewer rejection escalates instead of dropping work.
    const other = await inject(app, {
      method: 'GET',
      url: `/api/datasets/${world.datasetId}/queue?limit=100&orderBy=created`,
      headers: bearer(world.reviewerToken),
    });
    const rejectable = other.body.data.find(
      (entry: any) => entry.task.state === 'pending_review' && entry.task.itemId !== escalatedId,
    );
    expect(rejectable).toBeTruthy();
    const rejected = await inject(app, {
      method: 'POST',
      url: `/api/tasks/${rejectable.task.id}/review`,
      headers: bearer(world.reviewerToken),
      payload: { verdict: 'rejected', note: 'ambiguous' },
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.body.task.state).toBe('escalated');
  });

  it('computes inter-annotator agreement and lists disagreements', async () => {
    const [agreeId = '', disagreeId = ''] = await addItems([
      {
        content: {
          text: 'Pretty good overall.',
          importedPrediction: { taskType: 'sentiment', label: { label: 'positive' } },
          importedConfidence: 0.9,
        },
      },
      {
        content: {
          text: 'Not what I expected.',
          importedPrediction: { taskType: 'sentiment', label: { label: 'neutral' } },
          importedConfidence: 0.9,
        },
      },
    ]);
    await inject(app, {
      method: 'POST',
      url: `/api/datasets/${world.datasetId}/prelabel`,
      headers: bearer(world.adminToken),
      payload: { itemIds: [agreeId, disagreeId] },
    });

    for (const [itemId, labelA, labelB] of [
      [agreeId, 'positive', 'positive'],
      [disagreeId, 'positive', 'negative'],
    ] as const) {
      const entry = await queueEntry(itemId);
      for (const [token, label] of [
        [world.annotatorToken, labelA],
        [world.annotator2Token, labelB],
      ] as const) {
        await inject(app, {
          method: 'POST',
          url: `/api/tasks/${entry.task.id}/annotate`,
          headers: bearer(token),
          payload: { label: { label } },
        });
      }
    }

    const agreement = await inject(app, {
      method: 'GET',
      url: `/api/datasets/${world.datasetId}/agreement?limit=1000`,
      headers: bearer(world.reviewerToken),
    });
    expect(agreement.statusCode).toBe(200);
    expect(agreement.body.unitsConsidered).toBeGreaterThanOrEqual(2);
    expect(agreement.body.exactAgreementRate).toBeGreaterThan(0);
    expect(agreement.body.exactAgreementRate).toBeLessThan(1);
    expect(agreement.body.meanPairwiseSimilarity).toBeGreaterThan(0);
    expect(agreement.body.krippendorffAlpha).not.toBeNull();

    const disagreements = await inject(app, {
      method: 'GET',
      url: `/api/datasets/${world.datasetId}/disagreements`,
      headers: bearer(world.reviewerToken),
    });
    expect(disagreements.statusCode).toBe(200);
    const found = disagreements.body.data.find((d: any) => d.itemId === disagreeId);
    expect(found).toBeTruthy();
    expect(found.pairs[0].similarity).toBe(0);
  });

  it('exposes overview, history, analytics and metrics', async () => {
    const overviewRes = await inject(app, {
      method: 'GET',
      url: `/api/datasets/${world.datasetId}/overview`,
      headers: bearer(world.annotatorToken),
    });
    expect(overviewRes.statusCode).toBe(200);
    expect(overviewRes.body.annotations.total).toBeGreaterThan(0);
    expect(overviewRes.body.ai.prelabeled).toBeGreaterThan(0);
    expect(overviewRes.body.items.gold).toBeGreaterThanOrEqual(1);

    const historyRes = await inject(app, {
      method: 'GET',
      url: '/api/analytics/history?limit=50&predictionSource=gold',
      headers: bearer(world.annotatorToken),
    });
    expect(historyRes.statusCode).toBe(200);
    expect(historyRes.body.data.length).toBeGreaterThan(0);
    expect(historyRes.body.data[0].type).toBe('gold_promoted');

    const annotatorsRes = await inject(app, {
      method: 'GET',
      url: `/api/analytics/annotators?datasetId=${world.datasetId}`,
      headers: bearer(world.reviewerToken),
    });
    expect(annotatorsRes.statusCode).toBe(200);
    expect(annotatorsRes.body.data.length).toBeGreaterThanOrEqual(2);
    const ann1 = annotatorsRes.body.data.find((a: any) => a.email === 'ann1@test.local');
    expect(ann1.annotations).toBeGreaterThan(0);
    expect(ann1.acceptanceRate).not.toBeNull();

    const metricsRes = await inject(app, {
      method: 'GET',
      url: '/metrics',
      headers: bearer(world.adminToken),
    });
    expect(metricsRes.statusCode).toBe(200);
    expect(metricsRes.body.requests.total).toBeGreaterThan(0);
    expect(metricsRes.body.ai.provider).toBe('heuristic');
    expect(Object.keys(metricsRes.body.tasks).length).toBeGreaterThan(0);

    const denied = await inject(app, {
      method: 'GET',
      url: '/metrics',
      headers: bearer(world.annotatorToken),
    });
    expect(denied.statusCode).toBe(403);
  });

  it('promotes gold manually for admins and rejects under-confirmed items', async () => {
    const [goldId = '', weakId = ''] = await addItems([
      {
        content: {
          text: 'Excellent all around.',
          importedPrediction: { taskType: 'sentiment', label: { label: 'positive' } },
          importedConfidence: 0.92,
        },
      },
      {
        content: {
          text: 'Quite disappointing.',
          importedPrediction: { taskType: 'sentiment', label: { label: 'negative' } },
          importedConfidence: 0.92,
        },
      },
    ]);

    const forced = await inject(app, {
      method: 'POST',
      url: `/api/datasets/${world.datasetId}/gold`,
      headers: bearer(world.adminToken),
      payload: { itemIds: [goldId], force: true },
    });
    expect(forced.statusCode).toBe(200);
    expect(forced.body.promoted).toEqual([goldId]);

    const denied = await inject(app, {
      method: 'POST',
      url: `/api/datasets/${world.datasetId}/gold`,
      headers: bearer(world.adminToken),
      payload: { itemIds: [weakId], force: false },
    });
    expect(denied.body.promoted).toEqual([]);
    expect(denied.body.rejected[0].itemId).toBe(weakId);

    const notAdmin = await inject(app, {
      method: 'POST',
      url: `/api/datasets/${world.datasetId}/gold`,
      headers: bearer(world.reviewerToken),
      payload: { itemIds: [weakId], force: true },
    });
    expect(notAdmin.statusCode).toBe(403);
  });
});

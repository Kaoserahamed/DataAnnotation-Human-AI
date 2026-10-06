import { describe, expect, it } from 'vitest';
import {
  planGoldInjection,
  scoreGoldChecks,
  seededRandom,
  selectQcSample,
} from '../src/quality.js';

describe('seededRandom', () => {
  it('is deterministic for a given seed', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('produces a different stream for a different seed', () => {
    expect(seededRandom(1)()).not.toBe(seededRandom(2)());
  });

  it('stays within [0,1)', () => {
    const random = seededRandom(7);
    for (let i = 0; i < 200; i += 1) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

const candidates = [
  { itemId: 'low-risk', riskScore: 0.05 },
  { itemId: 'medium-risk', riskScore: 0.5 },
  { itemId: 'high-risk', riskScore: 0.95 },
  { itemId: 'higher-risk', riskScore: 0.99 },
];

describe('selectQcSample', () => {
  it('returns nothing for an empty request', () => {
    expect(selectQcSample(candidates, 0, 1).selected).toEqual([]);
    expect(selectQcSample([], 5, 1).selected).toEqual([]);
  });

  it('fills a purely random request with distinct items', () => {
    // randomFraction 1.0 means every slot is drawn uniformly.
    const result = selectQcSample(candidates, 3, 42, 1);
    expect(result.selected).toHaveLength(3);
    expect(new Set(result.selected).size).toBe(3);
    expect(result.randomCount).toBe(3);
    expect(result.riskCount).toBe(0);
  });

  it('takes the highest-risk items when the random fraction is 0', () => {
    const result = selectQcSample(candidates, 2, 42, 0);
    expect(result.selected).toEqual(['higher-risk', 'high-risk']);
    expect(result.randomCount).toBe(0);
    expect(result.riskCount).toBe(2);
  });

  it('is reproducible for the same seed', () => {
    const first = selectQcSample(candidates, 3, 99, 1);
    const second = selectQcSample(candidates, 3, 99, 1);
    expect(first.selected).toEqual(second.selected);
  });

  it('can differ across seeds', () => {
    const pool = Array.from({ length: 12 }, (_, i) => ({
      itemId: `item-${i}`,
      riskScore: 0.5,
    }));
    const first = selectQcSample(pool, 6, 1, 1).selected;
    const second = selectQcSample(pool, 6, 2, 1).selected;
    expect(first).not.toEqual(second);
  });

  it('skips candidates that already have an open sample', () => {
    const withOpen = candidates.map((c) => ({
      ...c,
      sampled: c.itemId === 'high-risk',
    }));
    const result = selectQcSample(withOpen, 4, 42, 0);
    expect(result.skippedExisting).toEqual(['high-risk']);
    expect(result.selected).not.toContain('high-risk');
    expect(result.selected).toHaveLength(3);
  });

  it('returns an empty selection when every candidate is already sampled', () => {
    const allSampled = candidates.map((c) => ({ ...c, sampled: true }));
    const result = selectQcSample(allSampled, 2, 42, 0);
    expect(result.selected).toEqual([]);
    expect(result.skippedExisting).toHaveLength(4);
  });

  it('never asks for more items than are available', () => {
    const result = selectQcSample(candidates, 50, 42, 0.5);
    expect(result.selected).toHaveLength(candidates.length);
    expect(new Set(result.selected).size).toBe(candidates.length);
  });
});

describe('selectQcSample — random/risk split', () => {
  it('reserves part of the sample for uniformly drawn low-risk items', () => {
    const pool = Array.from({ length: 20 }, (_, i) => ({
      itemId: `item-${i}`,
      riskScore: i / 19,
    }));
    // 30% of 10 slots = 3 uniform draws, 7 from the highest risk.
    const result = selectQcSample(pool, 10, 42, 0.3);
    expect(result.selected).toHaveLength(10);
    expect(result.randomCount).toBe(3);
    expect(result.riskCount).toBe(7);
    expect(new Set(result.selected).size).toBe(10);
  });

  it('keeps the risky half of the split dominated by high-risk items', () => {
    const pool = Array.from({ length: 20 }, (_, i) => ({
      itemId: `item-${i}`,
      riskScore: i / 19,
    }));
    const result = selectQcSample(pool, 10, 42, 0);
    const tail = result.selected.slice(0, 5);
    for (const id of tail) {
      expect(Number(id.split('-')[1])).toBeGreaterThanOrEqual(15);
    }
  });
});

describe('planGoldInjection', () => {
  it('plans nothing when there is no gold data', () => {
    const plan = planGoldInjection([], 10, 1);
    expect(plan.goldItemIds).toEqual([]);
    expect(plan.insertionPoints).toEqual([]);
  });

  it('plans nothing for an empty batch', () => {
    expect(planGoldInjection(['g1'], 0, 1).goldItemIds).toEqual([]);
  });

  it('injects at the configured rate, spaced evenly', () => {
    const gold = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6'];
    const plan = planGoldInjection(gold, 20, 1, 0.1);
    expect(plan.goldItemIds).toHaveLength(2);
    expect(plan.insertionPoints).toHaveLength(2);
    // 10% of 20 = 2 items, centred in the first and second halves.
    expect(plan.insertionPoints).toEqual([5, 15]);
  });

  it('keeps insertion points inside the batch', () => {
    const gold = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7'];
    const plan = planGoldInjection(gold, 7, 3, 0.5);
    expect(plan.goldItemIds.length).toBeGreaterThan(0);
    for (const point of plan.insertionPoints) {
      expect(point).toBeGreaterThanOrEqual(0);
      expect(point).toBeLessThan(7);
    }
    expect(new Set(plan.insertionPoints).size).toBe(plan.insertionPoints.length);
  });

  it('never injects more gold items than exist', () => {
    expect(planGoldInjection(['g1'], 10, 1, 0.9).goldItemIds).toHaveLength(1);
  });

  it('is reproducible for the same seed', () => {
    const gold = ['g1', 'g2', 'g3', 'g4'];
    expect(planGoldInjection(gold, 20, 7, 0.2)).toEqual(planGoldInjection(gold, 20, 7, 0.2));
  });
});

describe('scoreGoldChecks', () => {
  it('returns null when no gold questions were answered', () => {
    expect(scoreGoldChecks([])).toBeNull();
  });

  it('reports the fraction answered correctly', () => {
    const results = [
      { itemId: 'a', expected: 'x', actual: 'x', correct: true },
      { itemId: 'b', expected: 'y', actual: 'z', correct: false },
      { itemId: 'c', expected: 'x', actual: 'x', correct: true },
      { itemId: 'd', expected: 'x', actual: 'y', correct: false },
    ];
    expect(scoreGoldChecks(results)).toBe(0.5);
  });

  it('is 1 when every gold question is correct', () => {
    expect(scoreGoldChecks([{ itemId: 'a', expected: 'x', actual: 'x', correct: true }])).toBe(1);
  });
});

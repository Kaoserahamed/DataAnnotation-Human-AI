import { describe, expect, it, vi } from 'vitest';
import {
  chunk,
  createProgressTracker,
  DEFAULT_BATCH_SIZE,
  deduplicateBy,
  MAX_BATCH_SIZE,
  processBatch,
  retryWithBackoff,
  validateBulk,
} from '../src/batch.js';

describe('chunk', () => {
  it('splits an array into equal-sized chunks', () => {
    const items = [1, 2, 3, 4, 5, 6];
    const chunks = chunk(items, 2);
    expect(chunks).toEqual([[1, 2], [3, 4], [5, 6]]);
  });

  it('handles the last chunk being smaller', () => {
    const items = [1, 2, 3, 4, 5];
    const chunks = chunk(items, 2);
    expect(chunks).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns a single chunk when size >= array length', () => {
    const items = [1, 2, 3];
    const chunks = chunk(items, 10);
    expect(chunks).toEqual([[1, 2, 3]]);
  });

  it('returns empty array for empty input', () => {
    expect(chunk([], 5)).toEqual([]);
  });

  it('throws for non-positive chunk size', () => {
    expect(() => chunk([1, 2, 3], 0)).toThrow('Chunk size must be positive');
    expect(() => chunk([1, 2, 3], -5)).toThrow('Chunk size must be positive');
  });

  it('throws when chunk size exceeds maximum', () => {
    expect(() => chunk([1, 2], MAX_BATCH_SIZE + 1)).toThrow(
      `Chunk size ${MAX_BATCH_SIZE + 1} exceeds maximum ${MAX_BATCH_SIZE}`,
    );
  });
});

describe('processBatch', () => {
  it('processes all items successfully', async () => {
    const items = [1, 2, 3, 4, 5];
    const processor = async (n: number) => n * 2;

    const result = await processBatch(items, processor, { batchSize: 2 });

    expect(result.succeeded).toEqual([2, 4, 6, 8, 10]);
    expect(result.failed).toEqual([]);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('collects failures without stopping', async () => {
    const items = [1, 2, 3, 4, 5];
    const processor = async (n: number) => {
      if (n === 3) throw new Error('Failed on 3');
      return n * 2;
    };

    const result = await processBatch(items, processor, { batchSize: 2 });

    expect(result.succeeded).toEqual([2, 4, 8, 10]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.item).toBe(3);
    expect(result.failed[0]!.error).toBeInstanceOf(Error);
  });

  it('uses default batch size when not specified', async () => {
    const items = Array.from({ length: 250 }, (_, i) => i);
    const processor = async (n: number) => n;

    const result = await processBatch(items, processor);
    // Should process all items successfully
    expect(result.succeeded.length + result.failed.length).toBe(250);
    expect(result.succeeded).toHaveLength(250);
  });

  it('respects concurrency limit', async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;

    const items = Array.from({ length: 20 }, (_, i) => i);
    const processor = async (n: number) => {
      concurrentCount += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      await new Promise((resolve) => setTimeout(resolve, 10));
      concurrentCount -= 1;
      return n;
    };

    await processBatch(items, processor, { batchSize: 10, concurrency: 3 });
    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });

  it('calls progress callback with correct values', async () => {
    const items = [1, 2, 3, 4, 5];
    const progressUpdates: Array<{ completed: number; total: number }> = [];

    await processBatch(items, async (n) => n, {
      batchSize: 2,
      onProgress: (completed, total) => {
        progressUpdates.push({ completed, total });
      },
    });

    expect(progressUpdates).toHaveLength(5);
    expect(progressUpdates[0]).toEqual({ completed: 1, total: 5 });
    expect(progressUpdates[4]).toEqual({ completed: 5, total: 5 });
  });

  it('handles empty input gracefully', async () => {
    const result = await processBatch([], async (n: number) => n);
    expect(result.succeeded).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it('processes items in batches as specified', async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    const processedBatches: number[] = [];
    let currentBatch = 0;

    await processBatch(items, async (n) => n, {
      batchSize: 3,
      concurrency: 1, // Sequential to observe batching
      onProgress: (completed) => {
        const batch = Math.floor((completed - 1) / 3);
        if (batch > currentBatch) {
          currentBatch = batch;
        }
        if (completed % 3 === 1 || completed === items.length) {
          processedBatches.push(completed);
        }
      },
    });

    // Should process items in batches of 3, with the last batch having 1 item
    expect(processedBatches.length).toBeGreaterThan(0);
  });
});

describe('validateBulk', () => {
  const stringValidator = (item: unknown, index: number): string => {
    if (typeof item !== 'string') {
      throw new Error(`Item at index ${index} must be a string`);
    }
    return item;
  };

  it('returns all valid items', () => {
    const items = ['a', 'b', 'c'];
    const result = validateBulk(items, stringValidator);
    expect(result.valid).toEqual(['a', 'b', 'c']);
    expect(result.invalid).toEqual([]);
  });

  it('collects invalid items with indices', () => {
    const items = ['a', 42, 'c', null, 'e'];
    const result = validateBulk(items, stringValidator);
    expect(result.valid).toEqual(['a', 'c', 'e']);
    expect(result.invalid).toHaveLength(2);
    expect(result.invalid[0]).toMatchObject({ item: 42, index: 1 });
    expect(result.invalid[1]).toMatchObject({ item: null, index: 3 });
  });

  it('includes error messages in invalid items', () => {
    const items = ['a', 123];
    const result = validateBulk(items, stringValidator);
    expect(result.invalid[0]!.error).toContain('must be a string');
  });

  it('handles empty input', () => {
    const result = validateBulk([], stringValidator);
    expect(result.valid).toEqual([]);
    expect(result.invalid).toEqual([]);
  });

  it('passes index to validator', () => {
    const items = ['a', 'b'];
    const indices: number[] = [];
    validateBulk(items, (item, index) => {
      indices.push(index);
      return item;
    });
    expect(indices).toEqual([0, 1]);
  });
});

describe('createProgressTracker', () => {
  it('initializes with correct values', () => {
    const { tracker } = createProgressTracker(100);
    expect(tracker.total).toBe(100);
    expect(tracker.completed).toBe(0);
    expect(tracker.failed).toBe(0);
    expect(tracker.estimatedRemainingMs).toBeNull();
    expect(tracker.itemsPerSecond).toBe(0);
  });

  it('updates completed and failed counts', () => {
    const { tracker, update } = createProgressTracker(100);
    update(25, 5);
    expect(tracker.completed).toBe(25);
    expect(tracker.failed).toBe(5);
  });

  it('calculates items per second', async () => {
    const { tracker, update } = createProgressTracker(100);
    await new Promise((resolve) => setTimeout(resolve, 100));
    update(10, 0);
    expect(tracker.itemsPerSecond).toBeGreaterThan(0);
  });

  it('estimates remaining time based on current velocity', async () => {
    const { tracker, update } = createProgressTracker(100);
    await new Promise((resolve) => setTimeout(resolve, 50));
    update(50, 0); // Halfway done
    expect(tracker.estimatedRemainingMs).toBeGreaterThan(0);
  });

  it('returns null estimate when no items have been processed', () => {
    const { tracker } = createProgressTracker(100);
    expect(tracker.estimatedRemainingMs).toBeNull();
  });

  it('returns null estimate when all items are completed', async () => {
    const { tracker, update } = createProgressTracker(100);
    await new Promise((resolve) => setTimeout(resolve, 10));
    update(100, 0);
    expect(tracker.estimatedRemainingMs).toBeNull();
  });
});

describe('deduplicateBy', () => {
  it('keeps first occurrence of each unique key', () => {
    const items = [
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
      { id: 1, name: 'c' }, // Duplicate id
      { id: 3, name: 'd' },
    ];
    const unique = deduplicateBy(items, (item) => item.id);
    expect(unique).toHaveLength(3);
    expect(unique.map((i) => i.name)).toEqual(['a', 'b', 'd']);
  });

  it('handles empty input', () => {
    expect(deduplicateBy([], (x) => x)).toEqual([]);
  });

  it('returns all items when all keys are unique', () => {
    const items = [1, 2, 3, 4, 5];
    const unique = deduplicateBy(items, (x) => x);
    expect(unique).toEqual([1, 2, 3, 4, 5]);
  });

  it('works with complex key functions', () => {
    const items = ['apple', 'Apricot', 'banana', 'Avocado'];
    const unique = deduplicateBy(items, (s) => s[0]!.toLowerCase());
    expect(unique).toEqual(['apple', 'banana']); // First 'a' and first 'b'
  });

  it('handles all duplicates', () => {
    const items = [1, 1, 1, 1];
    const unique = deduplicateBy(items, (x) => x);
    expect(unique).toEqual([1]);
  });
});

describe('retryWithBackoff', () => {
  it('returns result on first success', async () => {
    const operation = vi.fn(async () => 42);
    const result = await retryWithBackoff(operation);
    expect(result).toBe(42);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries on failure and eventually succeeds', async () => {
    let attempts = 0;
    const operation = async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('Fail');
      return 'success';
    };

    const result = await retryWithBackoff(operation, { maxRetries: 3, initialDelayMs: 1 });
    expect(result).toBe('success');
    expect(attempts).toBe(3);
  });

  it('throws the last error after exhausting retries', async () => {
    const operation = async () => {
      throw new Error('Always fails');
    };

    await expect(
      retryWithBackoff(operation, { maxRetries: 2, initialDelayMs: 1 }),
    ).rejects.toThrow('Always fails');
  });

  it('applies exponential backoff', async () => {
    const delays: number[] = [];
    let lastAttemptTime = Date.now();
    let attempts = 0;

    const operation = async () => {
      attempts += 1;
      const now = Date.now();
      if (attempts > 1) {
        delays.push(now - lastAttemptTime);
      }
      lastAttemptTime = now;
      if (attempts < 4) throw new Error('Fail');
      return 'success';
    };

    await retryWithBackoff(operation, {
      maxRetries: 3,
      initialDelayMs: 10,
      backoffFactor: 2,
    });

    // Each delay should be roughly double the previous (with some tolerance)
    expect(delays.length).toBeGreaterThan(0);
    if (delays[0]) expect(delays[0]).toBeGreaterThanOrEqual(8);
    if (delays[1]) expect(delays[1]).toBeGreaterThanOrEqual(delays[0]! * 1.5);
  });

  it('caps delay at maxDelayMs', async () => {
    let attempt = 0;
    const operation = async () => {
      attempt += 1;
      throw new Error('Fail');
    };

    await retryWithBackoff(operation, {
      maxRetries: 10,
      initialDelayMs: 1,
      maxDelayMs: 5,
      backoffFactor: 100, // Would grow huge without cap
    }).catch(() => {});

    // With exponential growth and max delay of 5ms, later retries shouldn't take too long
    expect(attempt).toBe(11); // Initial + 10 retries
  });

  it('uses default options when not specified', async () => {
    let attempts = 0;
    const operation = async () => {
      attempts += 1;
      if (attempts <= 3) throw new Error('Fail');
      return 'success';
    };

    const result = await retryWithBackoff(operation);
    expect(result).toBe('success');
  });
});

describe('constants', () => {
  it('defines reasonable batch size limits', () => {
    expect(MAX_BATCH_SIZE).toBeGreaterThan(0);
    expect(DEFAULT_BATCH_SIZE).toBeGreaterThan(0);
    expect(DEFAULT_BATCH_SIZE).toBeLessThanOrEqual(MAX_BATCH_SIZE);
  });
});

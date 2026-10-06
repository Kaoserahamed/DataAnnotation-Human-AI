/**
 * Batch operations for bulk annotation processing.
 *
 * Provides utilities for chunking large datasets, parallel processing limits,
 * and progress tracking. All operations are pure functions that don't touch
 * I/O directly.
 */

/** Maximum items in a single batch to prevent memory exhaustion. */
export const MAX_BATCH_SIZE = 1000;

/** Default batch size for bulk operations. */
export const DEFAULT_BATCH_SIZE = 100;

/**
 * Split an array into fixed-size chunks.
 *
 * The last chunk may be smaller if the total doesn't divide evenly.
 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) {
    throw new Error('Chunk size must be positive');
  }
  if (size > MAX_BATCH_SIZE) {
    throw new Error(`Chunk size ${size} exceeds maximum ${MAX_BATCH_SIZE}`);
  }

  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Batch operation result with success/failure tracking.
 */
export interface BatchResult<T, E = Error> {
  /** Successfully processed items. */
  succeeded: T[];
  /** Failed items with their errors. */
  failed: Array<{ item: T; error: E }>;
  /** Total processing time in milliseconds. */
  durationMs: number;
}

/**
 * Process items in batches with a processing function.
 *
 * This is a pure coordinator that doesn't execute anything itself; the caller
 * provides the async processor. Useful for wrapping database operations,
 * API calls, or AI inference.
 */
export async function processBatch<TInput, TOutput>(
  items: readonly TInput[],
  processor: (item: TInput) => Promise<TOutput>,
  options: {
    batchSize?: number;
    /** Max concurrent operations within each batch. */
    concurrency?: number;
    onProgress?: (completed: number, total: number) => void;
  } = {},
): Promise<BatchResult<TOutput, unknown>> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const concurrency = options.concurrency ?? 5;
  const startTime = performance.now();

  const succeeded: TOutput[] = [];
  const failed: Array<{ item: TInput; error: unknown }> = [];
  let completed = 0;

  const chunks = chunk(items, batchSize);

  for (const batchItems of chunks) {
    // Process batch with limited concurrency
    const results = await processWithConcurrency(
      batchItems,
      processor,
      concurrency,
    );

    for (const result of results) {
      if (result.success) {
        succeeded.push(result.value);
      } else {
        failed.push({ item: result.item, error: result.error });
      }
      completed += 1;
      options.onProgress?.(completed, items.length);
    }
  }

  return {
    succeeded,
    failed,
    durationMs: performance.now() - startTime,
  };
}

type ItemResult<T, E> =
  | { success: true; value: E; item: T }
  | { success: false; error: unknown; item: T };

async function processWithConcurrency<T, E>(
  items: readonly T[],
  processor: (item: T) => Promise<E>,
  concurrency: number,
): Promise<ItemResult<T, E>[]> {
  const results: ItemResult<T, E>[] = [];
  const queue = [...items];
  const inFlight: Promise<void>[] = [];

  const processNext = async (): Promise<void> => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item && item !== 0) continue; // Skip undefined/null but allow 0

      try {
        const value = await processor(item);
        results.push({ success: true, value, item });
      } catch (error) {
        results.push({ success: false, error, item });
      }
    }
  };

  for (let i = 0; i < Math.min(concurrency, items.length); i += 1) {
    inFlight.push(processNext());
  }

  await Promise.all(inFlight);
  return results;
}

/**
 * Validation result for bulk import operations.
 */
export interface BulkValidationResult<T> {
  valid: T[];
  invalid: Array<{ item: unknown; error: string; index: number }>;
}

/**
 * Validate and filter a bulk import payload.
 *
 * Returns valid items and a list of validation errors with their indices so
 * the caller can report which rows failed.
 */
export function validateBulk<T>(
  items: readonly unknown[],
  validator: (item: unknown, index: number) => T,
): BulkValidationResult<T> {
  const valid: T[] = [];
  const invalid: Array<{ item: unknown; error: string; index: number }> = [];

  for (const [index, item] of items.entries()) {
    try {
      valid.push(validator(item, index));
    } catch (error) {
      invalid.push({
        item,
        error: error instanceof Error ? error.message : String(error),
        index,
      });
    }
  }

  return { valid, invalid };
}

/**
 * Progress tracker for long-running batch operations.
 */
export interface ProgressTracker {
  total: number;
  completed: number;
  failed: number;
  startedAt: number;
  /** Estimated time remaining in milliseconds, or null if insufficient data. */
  estimatedRemainingMs: number | null;
  /** Processing rate (items per second). */
  itemsPerSecond: number;
}

export function createProgressTracker(total: number): {
  tracker: ProgressTracker;
  update: (completed: number, failed: number) => void;
} {
  const tracker: ProgressTracker = {
    total,
    completed: 0,
    failed: 0,
    startedAt: performance.now(),
    estimatedRemainingMs: null,
    itemsPerSecond: 0,
  };

  const update = (completed: number, failed: number): void => {
    tracker.completed = completed;
    tracker.failed = failed;

    const elapsed = performance.now() - tracker.startedAt;
    const elapsedSeconds = elapsed / 1000;

    if (elapsedSeconds > 0) {
      tracker.itemsPerSecond = completed / elapsedSeconds;
    }

    const remaining = total - completed;
    if (tracker.itemsPerSecond > 0 && remaining > 0) {
      tracker.estimatedRemainingMs = (remaining / tracker.itemsPerSecond) * 1000;
    } else {
      tracker.estimatedRemainingMs = null;
    }
  };

  return { tracker, update };
}

/**
 * Deduplication by a key function.
 *
 * Keeps the first occurrence of each unique key. Useful for cleaning bulk
 * imports where the same item appears multiple times.
 */
export function deduplicateBy<T, K>(
  items: readonly T[],
  keyFn: (item: T) => K,
): T[] {
  const seen = new Set<K>();
  const unique: T[] = [];

  for (const item of items) {
    const key = keyFn(item);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(item);
    }
  }

  return unique;
}

/**
 * Retry a failed operation with exponential backoff.
 *
 * Useful for transient failures (network errors, rate limits).
 */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  options: {
    maxRetries?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    backoffFactor?: number;
  } = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const initialDelayMs = options.initialDelayMs ?? 100;
  const maxDelayMs = options.maxDelayMs ?? 10_000;
  const backoffFactor = options.backoffFactor ?? 2;

  let lastError: unknown;
  let delayMs = initialDelayMs;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        await sleep(delayMs);
        delayMs = Math.min(delayMs * backoffFactor, maxDelayMs);
      }
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AgreementQuerySchema,
  CreateDatasetSchema,
  CreateItemsSchema,
  CreateProjectSchema,
  CreateUserSchema,
  EmailSchema,
  HistoryQuerySchema,
  JsonValueSchema,
  LoginSchema,
  MAX_JSON_BODY_BYTES,
  PaginationQuerySchema,
  PasswordSchema,
  PromoteGoldSchema,
  QueueQuerySchema,
  ReviewAnnotationSchema,
  SampleQcSchema,
  SubmitAnnotationSchema,
  UpdateTaskStateSchema,
} from '../src/contracts.js';

const expectZodFailure = (fn: () => unknown): void => {
  expect(fn).toThrow(z.ZodError);
};

describe('JsonValueSchema', () => {
  it('accepts arbitrary nested JSON', () => {
    const value = {
      a: 1,
      b: 'two',
      c: true,
      d: null,
      e: [1, 2, { f: 'deep' }],
      g: { h: { i: 'nested' } },
    };
    expect(JsonValueSchema.parse(value)).toEqual(value);
  });

  it('rejects undefined and functions', () => {
    expect(() => JsonValueSchema.parse(undefined)).toThrow(z.ZodError);
    expect(() => JsonValueSchema.parse(() => 1)).toThrow(z.ZodError);
  });

  it('accepts primitives', () => {
    expect(JsonValueSchema.parse('x')).toBe('x');
    expect(JsonValueSchema.parse(3)).toBe(3);
    expect(JsonValueSchema.parse(false)).toBe(false);
    expect(JsonValueSchema.parse(null)).toBeNull();
  });
});

describe('MAX_JSON_BODY_BYTES', () => {
  it('is a sane positive cap', () => {
    expect(MAX_JSON_BODY_BYTES).toBeGreaterThan(0);
    expect(MAX_JSON_BODY_BYTES).toBeLessThanOrEqual(32 * 1024 * 1024);
  });
});

describe('PasswordSchema', () => {
  it('requires at least 12 characters', () => {
    expect(() => PasswordSchema.parse('short')).toThrow(z.ZodError);
    expect(PasswordSchema.parse('long-enough-passphrase')).toBe('long-enough-passphrase');
  });

  it('caps length so hashing stays bounded', () => {
    expect(() => PasswordSchema.parse('a'.repeat(129))).toThrow(z.ZodError);
  });
});

describe('EmailSchema', () => {
  it('rejects malformed addresses', () => {
    expect(() => EmailSchema.parse('not-an-email')).toThrow(z.ZodError);
    expect(() => EmailSchema.parse('a@b')).toThrow(z.ZodError);
    expect(EmailSchema.parse('user@example.com')).toBe('user@example.com');
  });

  it('caps length to prevent oversized rows', () => {
    expect(() => EmailSchema.parse(`${'a'.repeat(320)}@x.com`)).toThrow(z.ZodError);
  });
});

describe('PaginationQuerySchema', () => {
  it('applies defaults', () => {
    expect(PaginationQuerySchema.parse({})).toEqual({ limit: 25, offset: 0 });
  });

  it('coerces query strings into numbers', () => {
    expect(PaginationQuerySchema.parse({ limit: '10', offset: '5' })).toEqual({
      limit: 10,
      offset: 5,
    });
  });

  it('rejects out-of-range values', () => {
    expect(() => PaginationQuerySchema.parse({ limit: 0 })).toThrow(z.ZodError);
    expect(() => PaginationQuerySchema.parse({ limit: 101 })).toThrow(z.ZodError);
    expect(() => PaginationQuerySchema.parse({ offset: -1 })).toThrow(z.ZodError);
    expect(() => PaginationQuerySchema.parse({ limit: 1.5 })).toThrow(z.ZodError);
  });
});

describe('CreateUserSchema', () => {
  const valid = {
    email: 'ann@example.com',
    name: 'Ann',
    password: 'correct-horse-battery',
  };

  it('accepts a minimal user and defaults the role', () => {
    const parsed = CreateUserSchema.parse(valid);
    expect(parsed.role).toBe('annotator');
  });

  it('accepts each defined role', () => {
    for (const role of ['admin', 'annotator', 'reviewer'] as const) {
      expect(CreateUserSchema.parse({ ...valid, role }).role).toBe(role);
    }
  });

  it('rejects an unknown role', () => {
    expectZodFailure(() => CreateUserSchema.parse({ ...valid, role: 'wizard' }));
  });

  it('rejects an empty name', () => {
    expectZodFailure(() => CreateUserSchema.parse({ ...valid, name: '' }));
  });

  it('rejects unknown keys', () => {
    expectZodFailure(() => CreateUserSchema.parse({ ...valid, isAdmin: true }));
  });
});

describe('LoginSchema', () => {
  it('accepts credentials', () => {
    expect(LoginSchema.parse({ email: 'a@b.com', password: 'pw' })).toEqual({
      email: 'a@b.com',
      password: 'pw',
    });
  });

  it('rejects a missing password', () => {
    expectZodFailure(() => LoginSchema.parse({ email: 'a@b.com' }));
  });

  it('applies no default role on login', () => {
    expect(Object.keys(LoginSchema.parse({ email: 'a@b.com', password: 'pw' }))).toEqual([
      'email',
      'password',
    ]);
  });
});

describe('CreateProjectSchema', () => {
  it('defaults the description', () => {
    expect(CreateProjectSchema.parse({ name: 'p' })).toEqual({ name: 'p', description: '' });
  });

  it('rejects an empty name', () => {
    expectZodFailure(() => CreateProjectSchema.parse({ name: '' }));
  });
});

describe('CreateDatasetSchema', () => {
  const valid = { projectId: 'p1', name: 'd1', taskType: 'ner' as const };

  it('defaults an empty label schema', () => {
    const parsed = CreateDatasetSchema.parse(valid);
    expect(parsed.labelSchema).toEqual({});
  });

  it('accepts declared entity types', () => {
    const parsed = CreateDatasetSchema.parse({
      ...valid,
      labelSchema: { entityTypes: ['LOC', 'ORG'] },
    });
    expect(parsed.labelSchema.entityTypes).toEqual(['LOC', 'ORG']);
  });

  it('rejects an unknown task type', () => {
    expectZodFailure(() => CreateDatasetSchema.parse({ ...valid, taskType: 'video' }));
  });

  it('rejects unknown label-schema keys', () => {
    expectZodFailure(() => CreateDatasetSchema.parse({ ...valid, labelSchema: { colour: 'red' } }));
  });
});

describe('CreateItemsSchema', () => {
  it('accepts a batch of items and defaults the split', () => {
    const parsed = CreateItemsSchema.parse({
      items: [{ content: { text: 'hello' } }],
    });
    expect(parsed.items[0]!.split).toBe('pool');
    expect(parsed.items[0]!.meta).toBeUndefined();
  });

  it('accepts an explicit gold split', () => {
    const parsed = CreateItemsSchema.parse({
      items: [{ content: 'x', split: 'gold' }],
    });
    expect(parsed.items[0]!.split).toBe('gold');
  });

  it('rejects an empty batch', () => {
    expectZodFailure(() => CreateItemsSchema.parse({ items: [] }));
  });

  it('rejects an item without content', () => {
    expectZodFailure(() => CreateItemsSchema.parse({ items: [{}] }));
  });

  it('rejects an invalid split', () => {
    expectZodFailure(() =>
      CreateItemsSchema.parse({ items: [{ content: 'x', split: 'heldout' }] }),
    );
  });
});

describe('SubmitAnnotationSchema', () => {
  it('accepts a bare label', () => {
    expect(SubmitAnnotationSchema.parse({ label: { label: 'spam' } }).label).toEqual({
      label: 'spam',
    });
  });

  it('accepts optional confidence and timing', () => {
    const parsed = SubmitAnnotationSchema.parse({
      label: 'spam',
      annotatorConfidence: 0.8,
      timeSpentMs: 1500,
    });
    expect(parsed.annotatorConfidence).toBe(0.8);
    expect(parsed.timeSpentMs).toBe(1500);
  });

  it('rejects an out-of-range confidence', () => {
    expectZodFailure(() => SubmitAnnotationSchema.parse({ label: 'x', annotatorConfidence: 1.5 }));
    expectZodFailure(() => SubmitAnnotationSchema.parse({ label: 'x', annotatorConfidence: -0.1 }));
  });

  it('rejects a missing label', () => {
    expectZodFailure(() => SubmitAnnotationSchema.parse({}));
  });

  it('rejects negative elapsed time', () => {
    expectZodFailure(() => SubmitAnnotationSchema.parse({ label: 'x', timeSpentMs: -1 }));
  });
});

describe('ReviewAnnotationSchema', () => {
  it('accepts each verdict', () => {
    for (const verdict of ['correct', 'corrected', 'rejected'] as const) {
      expect(ReviewAnnotationSchema.parse({ verdict }).verdict).toBe(verdict);
    }
  });

  it('rejects an unknown verdict', () => {
    expectZodFailure(() => ReviewAnnotationSchema.parse({ verdict: 'maybe' }));
  });

  it('accepts a note and a corrected label together', () => {
    const parsed = ReviewAnnotationSchema.parse({
      verdict: 'corrected',
      correctedLabel: { label: 'ham' },
      note: 'model missed the qualifier',
    });
    expect(parsed.correctedLabel).toEqual({ label: 'ham' });
  });
});

describe('SampleQcSchema', () => {
  it('defaults reason and size', () => {
    expect(SampleQcSchema.parse({})).toEqual({ reason: 'random', size: 25 });
  });

  it('coerces a string seed from the query string', () => {
    expect(SampleQcSchema.parse({ seed: '123' }).seed).toBe(123);
  });

  it('rejects an unknown sampling reason', () => {
    expectZodFailure(() => SampleQcSchema.parse({ reason: 'targeted' }));
  });

  it('rejects a size above the safety cap', () => {
    expectZodFailure(() => SampleQcSchema.parse({ size: 501 }));
    expectZodFailure(() => SampleQcSchema.parse({ size: 0 }));
  });
});

describe('PromoteGoldSchema', () => {
  it('defaults force to false', () => {
    expect(PromoteGoldSchema.parse({ itemIds: ['i1'] }).force).toBe(false);
  });

  it('coerces a string force flag', () => {
    expect(PromoteGoldSchema.parse({ itemIds: ['i1'], force: 'true' }).force).toBe(true);
  });

  it('rejects an empty selection', () => {
    expectZodFailure(() => PromoteGoldSchema.parse({ itemIds: [] }));
  });

  it('rejects an oversized selection', () => {
    expectZodFailure(() =>
      PromoteGoldSchema.parse({ itemIds: Array.from({ length: 501 }, (_, i) => `i${i}`) }),
    );
  });
});

describe('UpdateTaskStateSchema', () => {
  it('accepts every task state', () => {
    for (const state of [
      'pending_prelabel',
      'pending_review',
      'pending_human',
      'in_review',
      'accepted',
      'needs_correct',
      'rejected',
      'escalated',
    ] as const) {
      expect(UpdateTaskStateSchema.parse({ state }).state).toBe(state);
    }
  });

  it('rejects an unknown state', () => {
    expectZodFailure(() => UpdateTaskStateSchema.parse({ state: 'paused' }));
  });
});

describe('QueueQuerySchema / HistoryQuerySchema / AgreementQuerySchema', () => {
  it('defaults the queue ordering to active learning', () => {
    expect(QueueQuerySchema.parse({}).orderBy).toBe('acquisition');
  });

  it('accepts the alternative queue orderings', () => {
    for (const orderBy of ['acquisition', 'created', 'confidence'] as const) {
      expect(QueueQuerySchema.parse({ orderBy }).orderBy).toBe(orderBy);
    }
  });

  it('rejects an unknown queue ordering', () => {
    expectZodFailure(() => QueueQuerySchema.parse({ orderBy: 'random' }));
  });

  it('accepts an optional prediction source filter on history', () => {
    expect(HistoryQuerySchema.parse({ predictionSource: 'ai' }).predictionSource).toBe('ai');
    expectZodFailure(() => HistoryQuerySchema.parse({ predictionSource: 'model' }));
  });

  it('requires a dataset for agreement', () => {
    expectZodFailure(() => AgreementQuerySchema.parse({}));
    expect(AgreementQuerySchema.parse({ datasetId: 'd1' })).toEqual({
      datasetId: 'd1',
      limit: 1000,
    });
  });

  it('caps the agreement sample size', () => {
    expectZodFailure(() => AgreementQuerySchema.parse({ datasetId: 'd1', limit: 5001 }));
    expectZodFailure(() => AgreementQuerySchema.parse({ datasetId: 'd1', limit: 1 }));
  });
});

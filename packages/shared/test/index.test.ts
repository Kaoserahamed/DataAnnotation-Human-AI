import { describe, expect, it } from 'vitest';
import * as shared from '../src/index.js';

/**
 * Re-export surface smoke test. A duplicate `export *` name is silently
 * dropped by ES modules, which would quietly break downstream imports — this
 * asserts the public API is actually reachable.
 */
const EXPECTED_EXPORTS = [
  'TASK_TYPES',
  'TASK_STATES',
  'USER_ROLES',
  'PREDICTION_SOURCES',
  'REVIEW_VERDICTS',
  'ITEM_SPLITS',
  'LabelPayloadSchema',
  'labelSchemaForTaskType',
  'parseLabelForTaskType',
  'labelSimilarity',
  'labelsDisagree',
  'matchBoundingBoxes',
  'cohensKappa',
  'fleissKappa',
  'krippendorffAlpha',
  'interpretKappa',
  'scoreAcquisition',
  'decideVerification',
  'decideAfterPrelabel',
  'canTransition',
  'qualifiesForGold',
  'selectQcSample',
  'planGoldInjection',
  'CreateUserSchema',
  'SubmitAnnotationSchema',
] as const;

describe('@haap/shared public surface', () => {
  it('exports every documented symbol', () => {
    for (const name of EXPECTED_EXPORTS) {
      expect(shared, `missing export: ${name}`).toHaveProperty(name);
    }
  });

  it('exports working utilities, not just names', () => {
    expect(shared.isTaskType('ner')).toBe(true);
    expect(shared.isTaskType('nope')).toBe(false);
    expect(shared.levenshteinString('ab', 'ac')).toBe(1);
    expect(shared.canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(shared.interpretKappa(0.9)).toBe('almost_perfect');
  });

  it('has no undefined bindings', () => {
    for (const name of EXPECTED_EXPORTS) {
      expect((shared as Record<string, unknown>)[name]).toBeDefined();
    }
  });
});

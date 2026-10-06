import { describe, expect, it } from 'vitest';
import {
  boundingBoxIou,
  clamp01,
  labelSimilarity,
  labelsDisagree,
  levenshteinString,
  matchBoundingBoxes,
  matchEntities,
  matchPolygons,
  polygonOverlap,
  tokenizeWords,
  wordErrorRate,
} from '../src/comparison.js';
import type { BoundingBox, LabelPayload, NamedEntity, Polygon } from '../src/labels.js';

const box = (x: number, y: number, w: number, h: number, label = 'cat'): BoundingBox => ({
  x,
  y,
  width: w,
  height: h,
  label,
});

const entity = (text: string, label: string, start = 0): NamedEntity => ({
  text,
  label,
  start,
  end: start + text.length,
});

describe('clamp01', () => {
  it('bounds values into [0,1]', () => {
    expect(clamp01(-3)).toBe(0);
    expect(clamp01(0.42)).toBe(0.42);
    expect(clamp01(9)).toBe(1);
  });

  it('maps NaN to 0 rather than propagating it', () => {
    expect(clamp01(Number.NaN)).toBe(0);
  });
});

describe('boundingBoxIou', () => {
  it('is 1 for identical boxes', () => {
    expect(boundingBoxIou(box(0.1, 0.1, 0.2, 0.2), box(0.1, 0.1, 0.2, 0.2))).toBeCloseTo(1, 10);
  });

  it('is 0 for disjoint boxes', () => {
    expect(boundingBoxIou(box(0, 0, 0.2, 0.2), box(0.6, 0.6, 0.2, 0.2))).toBe(0);
  });

  it('computes the analytic value for a half-overlapping pair', () => {
    // intersection 0.1x0.2 = 0.02; union = 0.04 + 0.04 - 0.02 = 0.06 -> 1/3
    expect(boundingBoxIou(box(0, 0, 0.2, 0.2), box(0.1, 0, 0.2, 0.2))).toBeCloseTo(1 / 3, 10);
  });

  it('returns 0 instead of NaN for a zero-area box', () => {
    const degenerate = { x: 0, y: 0, width: 0, height: 0, label: 'cat' };
    expect(boundingBoxIou(degenerate, box(0, 0, 0.5, 0.5))).toBe(0);
  });
});

describe('matchBoundingBoxes', () => {
  it('scores two empty sets as perfect agreement', () => {
    expect(matchBoundingBoxes([], [])).toBe(1);
  });

  it('scores 0 when exactly one side is empty', () => {
    expect(matchBoundingBoxes([box(0, 0, 0.2, 0.2)], [])).toBe(0);
    expect(matchBoundingBoxes([], [box(0, 0, 0.2, 0.2)])).toBe(0);
  });

  it('matches each box at most once (no double counting)', () => {
    // Three candidates all overlapping one prediction: exactly one may match.
    const prediction = [box(0.5, 0.5, 0.1, 0.1, 'cat')];
    const gold = [
      box(0.5, 0.5, 0.1, 0.1, 'cat'),
      box(0.52, 0.5, 0.1, 0.1, 'cat'),
      box(0.54, 0.5, 0.1, 0.1, 'cat'),
    ];
    // matched = 1 -> 2*1 / (1+3) = 0.5
    expect(matchBoundingBoxes(prediction, gold)).toBeCloseTo(0.5, 10);
  });

  it('ignores boxes of a different class', () => {
    const prediction = [box(0, 0, 0.5, 0.5, 'dog')];
    const gold = [box(0, 0, 0.5, 0.5, 'cat')];
    expect(matchBoundingBoxes(prediction, gold)).toBe(0);
  });

  describe('matchPolygons', () => {
    const square = (dx: number, dy: number, label = 'road'): Polygon => ({
      points: [
        [0.1 + dx, 0.1 + dy],
        [0.5 + dx, 0.1 + dy],
        [0.5 + dx, 0.5 + dy],
        [0.1 + dx, 0.5 + dy],
      ],
      label,
    });

    it('scores identical regions as 1', () => {
      expect(matchPolygons([square(0, 0)], [square(0, 0)])).toBe(1);
    });

    it('is 1 for two empty region sets', () => {
      expect(matchPolygons([], [])).toBe(1);
    });

    it('is 0 for regions whose centroids are at opposite corners', () => {
      const a = square(0, 0);
      const b: Polygon = {
        points: [
          [0.9, 0.9],
          [1, 0.9],
          [1, 1],
          [0.9, 1],
        ],
        label: 'road',
      };
      expect(matchPolygons([a], [b])).toBe(0);
    });

    it('exposes centroid-based overlap directly', () => {
      const a = square(0, 0);
      expect(polygonOverlap(a, a)).toBeCloseTo(1, 10);
      expect(polygonOverlap(a, square(0.4, 0))).toBeLessThan(1);
    });

    it('requires matching labels', () => {
      expect(matchPolygons([square(0, 0, 'road')], [square(0, 0, 'water')])).toBe(0);
    });
  });

  describe('matchEntities', () => {
    it('matches identical spans', () => {
      expect(matchEntities([entity('Berlin', 'LOC')], [entity('Berlin', 'LOC')])).toBe(1);
    });

    it('requires the entity type to agree', () => {
      expect(matchEntities([entity('Berlin', 'LOC')], [entity('Berlin', 'ORG')])).toBe(0);
    });

    it('tolerates minor spelling differences above the similarity threshold', () => {
      // "Adidas" vs "Adiddas" -> distance 1, similarity 1 - 1/7 = 0.857
      expect(matchEntities([entity('Adidas', 'ORG')], [entity('Adiddas', 'ORG')])).toBe(1);
    });

    it('rejects completely different spans', () => {
      expect(matchEntities([entity('Berlin', 'LOC')], [entity('Lisbon', 'LOC')])).toBe(0);
    });

    it('matches each span at most once', () => {
      const prediction = [entity('Berlin', 'LOC')];
      const gold = [entity('Berlin', 'LOC'), entity('Berlin', 'LOC'), entity('Paris', 'LOC')];
      // Only one of the two identical "Berlin" spans can match: 2*1/(1+3) = 0.5
      expect(matchEntities(prediction, gold)).toBeCloseTo(0.5, 10);
    });
  });

  describe('levenshtein / WER', () => {
    it('counts single-character edits', () => {
      expect(levenshteinString('kitten', 'sitting')).toBe(3);
      expect(levenshteinString('', 'abc')).toBe(3);
      expect(levenshteinString('abc', '')).toBe(3);
      expect(levenshteinString('same', 'same')).toBe(0);
    });

    it('tokenizes punctuation away', () => {
      expect(tokenizeWords('Hello, world! 123')).toEqual(['hello', 'world', '123']);
    });

    it('is 0 WER for identical transcripts', () => {
      expect(wordErrorRate('the cat sat', 'the cat sat')).toBe(0);
    });

    describe('labelSimilarity', () => {
      const categorical = (label: string): LabelPayload =>
        ({ taskType: 'text_classification', label: { label } }) as LabelPayload;

      it('is exact-match for categorical labels', () => {
        expect(labelSimilarity('text_classification', categorical('yes'), categorical('yes'))).toBe(
          1,
        );
        expect(labelSimilarity('text_classification', categorical('yes'), categorical('no'))).toBe(
          0,
        );
      });

      it('treats sentiment as categorical', () => {
        const positive = { taskType: 'sentiment', label: { label: 'positive' } } as LabelPayload;
        const negative = { taskType: 'sentiment', label: { label: 'negative' } } as LabelPayload;
        expect(labelSimilarity('sentiment', positive, positive)).toBe(1);
        expect(labelSimilarity('sentiment', positive, negative)).toBe(0);
      });

      it('uses geometry for bounding boxes', () => {
        const a = { taskType: 'image_bbox', label: [box(0.1, 0.1, 0.2, 0.2)] } as LabelPayload;
        const b = { taskType: 'image_bbox', label: [box(0.1, 0.1, 0.2, 0.2)] } as LabelPayload;
        expect(labelSimilarity('image_bbox', a, b)).toBe(1);
      });

      it('uses WER for transcripts', () => {
        const a = {
          taskType: 'audio_transcription',
          label: [{ startMs: 0, endMs: 100, text: 'the cat sat' }],
        } as LabelPayload;
        const b = {
          taskType: 'audio_transcription',
          label: [{ startMs: 0, endMs: 100, text: 'the cat sat' }],
        } as LabelPayload;
        expect(labelSimilarity('audio_transcription', a, b)).toBeCloseTo(1, 10);
      });
    });

    describe('labelsDisagree', () => {
      const categorical = (label: string): LabelPayload =>
        ({ taskType: 'text_classification', label: { label } }) as LabelPayload;

      it('flags differing categories', () => {
        expect(labelsDisagree('text_classification', categorical('a'), categorical('b'))).toBe(
          true,
        );
        expect(labelsDisagree('text_classification', categorical('a'), categorical('a'))).toBe(
          false,
        );
      });

      it('does not flag a negligible box nudge', () => {
        const a = { taskType: 'image_bbox', label: [box(0.5, 0.5, 0.2, 0.2)] } as LabelPayload;
        const b = { taskType: 'image_bbox', label: [box(0.505, 0.5, 0.2, 0.2)] } as LabelPayload;
        expect(labelsDisagree('image_bbox', a, b)).toBe(false);
      });
    });
    it('is 1/3 WER for one substitution in three words', () => {
      expect(wordErrorRate('the cat sat', 'the dog sat')).toBeCloseTo(1 / 3, 10);
    });

    it('handles an empty reference', () => {
      expect(wordErrorRate('', '')).toBe(0);
      expect(wordErrorRate('', 'anything')).toBe(1);
    });
  });
  it('rejects overlap below the IoU threshold', () => {
    // inter 0.1*0.3 = 0.03 ; union = 0.09 + 0.09 - 0.03 = 0.15 -> IoU 0.2
    const prediction = [box(0, 0, 0.3, 0.3)];
    const gold = [box(0.2, 0, 0.3, 0.3)];
    expect(boundingBoxIou(prediction[0]!, gold[0]!)).toBeCloseTo(0.2, 10);
    expect(matchBoundingBoxes(prediction, gold)).toBe(0);
  });

  it('matches a shifted box whose IoU clears the threshold', () => {
    // x:[0,0.3] vs x:[0.05,0.35] -> inter 0.25*0.3 = 0.075
    // union = 0.09 + 0.09 - 0.075 = 0.105 -> IoU ~ 0.714
    const prediction = [box(0, 0, 0.3, 0.3)];
    const gold = [box(0.05, 0, 0.3, 0.3)];
    expect(boundingBoxIou(prediction[0]!, gold[0]!)).toBeGreaterThan(0.7);
    expect(matchBoundingBoxes(prediction, gold)).toBe(1);
  });
});

// ─── spanSimilarity (direct, not via matchEntities) ────────────────────────

import { spanSimilarity } from '../src/comparison.js';

describe('spanSimilarity', () => {
  it('is 1 for identical span text and label', () => {
    expect(spanSimilarity(entity('Berlin', 'LOC'), entity('Berlin', 'LOC'))).toBeCloseTo(1, 10);
  });

  it('is 0 when entity types differ regardless of text', () => {
    expect(spanSimilarity(entity('Berlin', 'LOC'), entity('Berlin', 'ORG'))).toBe(0);
  });

  it('is 0 for completely dissimilar texts with the same label', () => {
    // "abc" vs "xyz" — Levenshtein distance 3, length 3 → similarity 0
    expect(spanSimilarity(entity('abc', 'X'), entity('xyz', 'X'))).toBe(0);
  });

  it('scores partial similarity for near-miss text', () => {
    // "Paris" vs "Pariss" — distance 1, longest 6 → 1 - 1/6 ≈ 0.833
    const sim = spanSimilarity(entity('Paris', 'LOC'), entity('Pariss', 'LOC'));
    expect(sim).toBeGreaterThan(0.8);
    expect(sim).toBeLessThan(1);
  });

  it('is case-insensitive', () => {
    expect(spanSimilarity(entity('BERLIN', 'LOC'), entity('berlin', 'LOC'))).toBeCloseTo(1, 10);
  });

  it('is 1 for two empty-text spans of the same type', () => {
    const a = { text: '', start: 0, end: 0, label: 'X' };
    const b = { text: '', start: 0, end: 0, label: 'X' };
    expect(spanSimilarity(a, b)).toBe(1);
  });
});

// ─── labelsDisagree for remaining modalities ────────────────────────────────

describe('labelsDisagree — audio and segmentation', () => {
  it('does not flag matching audio translations', () => {
    const a = { taskType: 'audio_translation', label: { label: 'hello' } } as LabelPayload;
    expect(labelsDisagree('audio_translation', a, a)).toBe(false);
  });

  it('flags differing audio translations', () => {
    const a = { taskType: 'audio_translation', label: { label: 'hello' } } as LabelPayload;
    const b = { taskType: 'audio_translation', label: { label: 'goodbye' } } as LabelPayload;
    expect(labelsDisagree('audio_translation', a, b)).toBe(true);
  });

  it('does not flag matching document annotations', () => {
    const a = { taskType: 'document_annotation', label: { label: 'invoice' } } as LabelPayload;
    expect(labelsDisagree('document_annotation', a, a)).toBe(false);
  });

  it('scores two identical polygon sets as no disagreement', () => {
    const poly = {
      taskType: 'image_segmentation',
      label: [
        {
          points: [[0.1, 0.1], [0.5, 0.1], [0.5, 0.5], [0.1, 0.5]],
          label: 'road',
        },
      ],
    } as LabelPayload;
    expect(labelsDisagree('image_segmentation', poly, poly)).toBe(false);
  });

  it('flags different polygon labels as disagreement', () => {
    const road = {
      taskType: 'image_segmentation',
      label: [{ points: [[0.1, 0.1], [0.5, 0.1], [0.5, 0.5], [0.1, 0.5]], label: 'road' }],
    } as LabelPayload;
    const building = {
      taskType: 'image_segmentation',
      label: [{ points: [[0.1, 0.1], [0.5, 0.1], [0.5, 0.5], [0.1, 0.5]], label: 'building' }],
    } as LabelPayload;
    expect(labelsDisagree('image_segmentation', road, building)).toBe(true);
  });

  it('gives perfect WER similarity for identical transcripts (zero disagreement)', () => {
    const a = {
      taskType: 'audio_transcription',
      label: [{ startMs: 0, endMs: 1000, text: 'the quick brown fox' }],
    } as LabelPayload;
    expect(labelsDisagree('audio_transcription', a, a)).toBe(false);
  });
});

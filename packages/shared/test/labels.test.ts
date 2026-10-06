import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  LabelPayloadSchema,
  categoricalLabel,
  isCategoricalTaskType,
  isSpatialTaskType,
  labelSchemaForTaskType,
  parseLabelForTaskType,
} from '../src/labels.js';
import { TASK_TYPES, isTaskType } from '../src/task-types.js';

describe('task type helpers', () => {
  it('accepts every registered task type', () => {
    for (const type of TASK_TYPES) {
      expect(isTaskType(type)).toBe(true);
    }
  });

  it('rejects non-members', () => {
    expect(isTaskType('video_labeling')).toBe(false);
    expect(isTaskType(42)).toBe(false);
    expect(isTaskType(null)).toBe(false);
  });

  it('classifies categorical modalities', () => {
    expect(isCategoricalTaskType('text_classification')).toBe(true);
    expect(isCategoricalTaskType('sentiment')).toBe(true);
    expect(isCategoricalTaskType('audio_translation')).toBe(true);
    expect(isCategoricalTaskType('document_annotation')).toBe(true);
    expect(isCategoricalTaskType('ner')).toBe(false);
    expect(isCategoricalTaskType('image_bbox')).toBe(false);
  });

  it('classifies spatial modalities', () => {
    expect(isSpatialTaskType('image_bbox')).toBe(true);
    expect(isSpatialTaskType('image_segmentation')).toBe(true);
    expect(isSpatialTaskType('image_bbox')).toBe(true);
    expect(isSpatialTaskType('text_classification')).toBe(false);
    expect(isSpatialTaskType('audio_transcription')).toBe(false);
  });
});

describe('labelSchemaForTaskType', () => {
  it('returns a schema for every registered task type', () => {
    for (const type of TASK_TYPES) {
      expect(labelSchemaForTaskType(type)).toBeDefined();
    }
  });

  it('throws for an unregistered type', () => {
    expect(() => labelSchemaForTaskType('video_labeling' as never)).toThrow(
      /No label schema registered/,
    );
  });

  it('accepts a categorical payload for a categorical type', () => {
    expect(() =>
      parseLabelForTaskType('text_classification', { label: { label: 'spam' } }),
    ).not.toThrow();
    expect(() =>
      parseLabelForTaskType('sentiment', { label: { label: 'positive' } }),
    ).not.toThrow();
  });

  it('rejects a categorical payload for a structured type', () => {
    expect(() => parseLabelForTaskType('image_bbox', { label: { label: 'spam' } })).toThrow(
      z.ZodError,
    );
  });

  it('accepts a box array for image_bbox', () => {
    const payload = parseLabelForTaskType('image_bbox', [
      { x: 0.1, y: 0.1, width: 0.2, height: 0.2, label: 'cat' },
    ]);
    expect(payload.taskType).toBe('image_bbox');
  });

  it('accepts an entity array for ner', () => {
    const payload = parseLabelForTaskType('ner', [
      { text: 'Berlin', start: 0, end: 6, label: 'LOC' },
    ]);
    expect(payload.taskType).toBe('ner');
  });

  it('accepts transcript segments for audio_transcription', () => {
    const payload = parseLabelForTaskType('audio_transcription', [
      { startMs: 0, endMs: 1000, text: 'hello' },
    ]);
    expect(payload.taskType).toBe('audio_transcription');
  });

  it('normalises the taskType on the returned payload', () => {
    const payload = parseLabelForTaskType('sentiment', { label: { label: 'pos' } });
    expect(payload.taskType).toBe('sentiment');
  });

  it('rejects a polygon set for image_bbox', () => {
    expect(() =>
      parseLabelForTaskType('image_bbox', [
        {
          points: [
            [0, 0],
            [1, 0],
            [1, 1],
          ],
          label: 'road',
        },
      ]),
    ).toThrow(z.ZodError);
  });
});

describe('LabelPayloadSchema', () => {
  it('rejects an unknown discriminator', () => {
    expect(() => LabelPayloadSchema.parse({ taskType: 'audio', label: {} })).toThrow(z.ZodError);
  });

  it('rejects an empty categorical label', () => {
    expect(() => LabelPayloadSchema.parse({ taskType: 'sentiment', label: { label: '' } })).toThrow(
      z.ZodError,
    );
  });

  it('rejects extraneous keys on a categorical label', () => {
    expect(() =>
      LabelPayloadSchema.parse({
        taskType: 'sentiment',
        label: { label: 'pos', junk: 1 },
      }),
    ).toThrow(z.ZodError);
  });
});

describe('categoricalLabel', () => {
  it('builds a text_classification payload', () => {
    expect(categoricalLabel('spam')).toEqual({
      taskType: 'text_classification',
      label: { label: 'spam' },
    });
  });

  it('attaches optional metadata when supplied', () => {
    expect(categoricalLabel('ham', { source: 'seed' })).toEqual({
      taskType: 'text_classification',
      label: { label: 'ham', metadata: { source: 'seed' } },
    });
  });

  it('omits the metadata key entirely when not supplied', () => {
    expect('metadata' in categoricalLabel('ham').label).toBe(false);
  });

  it('produces a payload that validates against the union schema', () => {
    expect(() => LabelPayloadSchema.parse(categoricalLabel('spam'))).not.toThrow();
  });
});

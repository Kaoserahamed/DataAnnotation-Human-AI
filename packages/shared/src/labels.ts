import { z } from 'zod';
import {
  CATEGORICAL_TASK_TYPES,
  ITEM_SPLITS,
  PREDICTION_SOURCES,
  PROJECT_STATUSES,
  QC_SAMPLING_REASONS,
  REVIEW_VERDICTS,
  SPATIAL_TASK_TYPES,
  TASK_STATES,
  TASK_TYPES,
  USER_ROLES,
  isCategoricalTaskType,
  isSpatialTaskType,
} from './task-types.js';
import type { TaskType } from './task-types.js';

export { TASK_TYPES, TASK_STATES, USER_ROLES, PREDICTION_SOURCES, REVIEW_VERDICTS, ITEM_SPLITS };
export type { TaskType };

/** Confidence is always a probability in [0, 1]. */
export const ConfidenceSchema = z.number().min(0).max(1);

const NonEmptyString = z.string().min(1, 'must not be empty').max(10_000);

/** Axis-aligned bounding box in normalized [0,1] image coordinates. */
export const BoundingBoxSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().gt(0).max(1),
    height: z.number().gt(0).max(1),
    label: NonEmptyString,
    confidence: ConfidenceSchema.optional(),
  })
  .strict()
  .refine((b) => b.x + b.width <= 1.000_001 && b.y + b.height <= 1.000_001, {
    message: 'bounding box must not exceed image bounds',
  });

/** Polygon ring for segmentation masks; at least three vertices. */
export const PolygonSchema = z
  .object({
    points: z
      .array(z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]))
      .min(3)
      .max(2048),
    label: NonEmptyString,
    confidence: ConfidenceSchema.optional(),
  })
  .strict();

export const NamedEntitySchema = z
  .object({
    text: NonEmptyString,
    start: z.number().int().min(0),
    end: z.number().int().min(0),
    label: NonEmptyString,
    confidence: ConfidenceSchema.optional(),
  })
  .strict()
  .refine((e) => e.end > e.start, { message: 'entity end must be greater than start' });

/** Timed transcript segment; `endMs` must follow `startMs`. */
export const TranscriptSegmentSchema = z
  .object({
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(0),
    text: NonEmptyString.max(20_000),
    speaker: z.string().min(1).max(120).optional(),
    confidence: ConfidenceSchema.optional(),
  })
  .strict()
  .refine((s) => s.endMs > s.startMs, { message: 'segment endMs must exceed startMs' });

/** Single categorical choice plus optional free-text rationale. */
export const CategoricalLabelSchema = z
  .object({
    label: NonEmptyString.max(200),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

export const BoundingBoxSetSchema = z.array(BoundingBoxSchema).max(5_000);
export const PolygonSetSchema = z.array(PolygonSchema).max(2_000);
export const EntitySetSchema = z.array(NamedEntitySchema).max(10_000);
export const TranscriptSetSchema = z.array(TranscriptSegmentSchema).max(100_000);

/**
 * Discriminated label payload union keyed by modality.
 *
 * A `text_classification` label must be a `{ label }` object; an `image_bbox`
 * label must be an array of boxes. This makes an `ImageTask` submitted with a
 * classification payload a validation error rather than a runtime surprise.
 */
export const LabelPayloadSchema = z.discriminatedUnion('taskType', [
  z.object({
    taskType: z.enum(CATEGORICAL_TASK_TYPES),
    label: CategoricalLabelSchema,
  }),
  z.object({ taskType: z.literal('image_bbox'), label: BoundingBoxSetSchema }),
  z.object({ taskType: z.literal('image_segmentation'), label: PolygonSetSchema }),
  z.object({ taskType: z.literal('ner'), label: EntitySetSchema }),
  z.object({ taskType: z.literal('audio_transcription'), label: TranscriptSetSchema }),
]);

export type LabelPayload = z.infer<typeof LabelPayloadSchema>;
export type BoundingBox = z.infer<typeof BoundingBoxSchema>;
export type Polygon = z.infer<typeof PolygonSchema>;
export type NamedEntity = z.infer<typeof NamedEntitySchema>;
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;
export type CategoricalLabel = z.infer<typeof CategoricalLabelSchema>;

export const TASK_TYPE_LIST_SCHEMA = z.enum(TASK_TYPES);
export const TASK_STATE_SCHEMA = z.enum(TASK_STATES);
export const USER_ROLE_SCHEMA = z.enum(USER_ROLES);
export const REVIEW_VERDICT_SCHEMA = z.enum(REVIEW_VERDICTS);
export const ITEM_SPLIT_SCHEMA = z.enum(ITEM_SPLITS);
export const PREDICTION_SOURCE_SCHEMA = z.enum(PREDICTION_SOURCES);
export const QC_REASON_SCHEMA = z.enum(QC_SAMPLING_REASONS);
export const PROJECT_STATUS_SCHEMA = z.enum(PROJECT_STATUSES);
export const SPATIAL_TASK_LIST_SCHEMA = z.enum(SPATIAL_TASK_TYPES);

/**
 * The label *value* schema for each modality (the payload minus its
 * discriminator). This is the single place that maps a task type to the shape
 * its annotation must have.
 */
export const LABEL_VALUE_SCHEMAS: Record<TaskType, z.ZodTypeAny> = {
  text_classification: CategoricalLabelSchema,
  sentiment: CategoricalLabelSchema,
  audio_translation: CategoricalLabelSchema,
  document_annotation: CategoricalLabelSchema,
  image_bbox: BoundingBoxSetSchema,
  image_segmentation: PolygonSetSchema,
  ner: EntitySetSchema,
  audio_transcription: TranscriptSetSchema,
};

/**
 * Full payload schema for one specific modality.
 *
 * The discriminator is pinned to a single literal (rather than the multi-value
 * enum used by `LabelPayloadSchema`) so a payload can never validate under one
 * task type while claiming to be another.
 */
export function labelSchemaForTaskType(taskType: TaskType): z.ZodTypeAny {
  const value = LABEL_VALUE_SCHEMAS[taskType];
  if (!value) {
    throw new Error(`No label schema registered for task type "${taskType}"`);
  }
  return z.object({ taskType: z.literal(taskType), label: value }).strict();
}

/**
 * Normalise the accepted input shapes into `{ taskType, label }`.
 *
 * Callers hold the data in one of three forms, and requiring them to
 * hand-build the envelope every time just invites mistakes:
 *   1. a full envelope   `{ taskType, label }`
 *   2. a bare envelope   `{ label }`
 *   3. a raw value       an array for structured modalities
 *
 * `taskType` always comes from the argument, never from the payload, so the two
 * can never disagree.
 */
function toEnvelope(taskType: TaskType, payload: unknown): unknown {
  if (Array.isArray(payload)) return { taskType, label: payload };
  if (payload !== null && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if ('taskType' in record || 'label' in record) {
      return { ...record, taskType };
    }
  }
  return { taskType, label: payload };
}

/** Parse `payload` as a label of `taskType`, throwing a `ZodError` on mismatch. */
export function parseLabelForTaskType(taskType: TaskType, payload: unknown): LabelPayload {
  return labelSchemaForTaskType(taskType).parse(toEnvelope(taskType, payload)) as LabelPayload;
}

/** Convenience constructor for categorical datasets. */
export function categoricalLabel(label: string, metadata?: Record<string, unknown>): LabelPayload {
  return { taskType: 'text_classification', label: { label, ...(metadata ? { metadata } : {}) } };
}

export { isCategoricalTaskType, isSpatialTaskType };

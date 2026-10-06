/**
 * Canonical task taxonomy.
 *
 * Every supported annotation modality is registered here exactly once so that
 * database constraints, Zod validation, the AI engine registry and the UI all
 * derive from a single source of truth.
 */

export const TASK_TYPES = [
  'text_classification',
  'sentiment',
  'ner',
  'image_bbox',
  'image_segmentation',
  'audio_transcription',
  'audio_translation',
  'document_annotation',
] as const;

export type TaskType = (typeof TASK_TYPES)[number];

/** Modalities whose payload is a single categorical choice. */
export const CATEGORICAL_TASK_TYPES = [
  'text_classification',
  'sentiment',
  'audio_translation',
  'document_annotation',
] as const satisfies readonly TaskType[];

/** Modalities whose payload is a list of geometry primitives. */
export const SPATIAL_TASK_TYPES = [
  'image_bbox',
  'image_segmentation',
] as const satisfies readonly TaskType[];

export function isTaskType(value: unknown): value is TaskType {
  return typeof value === 'string' && (TASK_TYPES as readonly string[]).includes(value);
}

export function isCategoricalTaskType(taskType: TaskType): boolean {
  return (CATEGORICAL_TASK_TYPES as readonly string[]).includes(taskType);
}

export function isSpatialTaskType(taskType: TaskType): boolean {
  return (SPATIAL_TASK_TYPES as readonly string[]).includes(taskType);
}

/** Task lifecycle. Transitions are governed by `domain/annotation-workflow.ts`. */
export const TASK_STATES = [
  'pending_prelabel',
  'pending_review',
  'pending_human',
  'in_review',
  'accepted',
  'needs_correct',
  'rejected',
  'escalated',
] as const;

export type TaskState = (typeof TASK_STATES)[number];

export const PREDICTION_SOURCES = ['ai', 'human', 'gold'] as const;
export type PredictionSource = (typeof PREDICTION_SOURCES)[number];

export const REVIEW_VERDICTS = ['correct', 'corrected', 'rejected'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export const ITEM_SPLITS = ['pool', 'dev', 'test', 'gold'] as const;
export type ItemSplit = (typeof ITEM_SPLITS)[number];

export const USER_ROLES = ['admin', 'annotator', 'reviewer'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const QC_SAMPLING_REASONS = ['random', 'risk', 'gold_check'] as const;
export type QcSamplingReason = (typeof QC_SAMPLING_REASONS)[number];

export const PROJECT_STATUSES = ['active', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

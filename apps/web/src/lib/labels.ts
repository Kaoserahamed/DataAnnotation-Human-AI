export type TaskType =
  | 'text_classification'
  | 'sentiment'
  | 'ner'
  | 'image_bbox'
  | 'image_segmentation'
  | 'audio_transcription'
  | 'audio_translation'
  | 'document_annotation';

export const TASK_TYPES: TaskType[] = [
  'text_classification',
  'sentiment',
  'ner',
  'image_bbox',
  'image_segmentation',
  'audio_transcription',
];

export const CATEGORICAL_TASK_TYPES: TaskType[] = [
  'text_classification',
  'sentiment',
  'audio_translation',
  'document_annotation',
];

export const REVIEW_VERDICTS = ['correct', 'corrected', 'rejected'] as const;

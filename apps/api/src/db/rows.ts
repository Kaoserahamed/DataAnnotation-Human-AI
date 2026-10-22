/** Row shapes returned by the data layer (snake_case, as stored). */

import type { ItemSplit, ReviewVerdict, TaskState, TaskType, UserRole } from '@haap/shared';

export type Timestamp = string | Date;

export interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  role: UserRole;
  refresh_token: string | null;
  mfa_enabled: boolean;
  mfa_secret: string | null;
  oauth_provider: string | null;
  oauth_subject: string | null;
  created_at: Timestamp;
}

export interface ProjectRow {
  id: string;
  name: string;
  description: string;
  status: 'active' | 'archived';
  created_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface DatasetRow {
  id: string;
  project_id: string;
  name: string;
  task_type: TaskType;
  label_schema: unknown;
  created_at: Timestamp;
}

export interface ItemRow {
  id: string;
  dataset_id: string;
  content: unknown;
  meta: unknown;
  split: ItemSplit;
  created_at: Timestamp;
}

export interface TaskRow {
  id: string;
  item_id: string;
  dataset_id: string;
  state: TaskState;
  ai_label: unknown;
  ai_confidence: number | null;
  ai_provider: string | null;
  final_label: unknown;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** Task joined with its dataset and item — what most handlers need. */
export interface TaskWithContextRow extends TaskRow {
  task_type: TaskType;
  label_schema: unknown;
  content: unknown;
  meta: unknown;
  split: ItemSplit;
}

export interface AnnotationRow {
  id: string;
  task_id: string;
  item_id: string;
  dataset_id: string;
  user_id: string;
  label: unknown;
  verdict: ReviewVerdict;
  similarity: number | null;
  note: string | null;
  time_spent_ms: number | null;
  is_gold_check: boolean;
  gold_correct: boolean | null;
  created_at: Timestamp;
}

export interface PredictionRow {
  id: string;
  task_id: string;
  item_id: string;
  dataset_id: string;
  source: 'ai' | 'human' | 'gold';
  provider: string;
  label: unknown;
  confidence: number | null;
  created_by: string | null;
  created_at: Timestamp;
}

export interface EventRow {
  id: string;
  task_id: string | null;
  item_id: string | null;
  dataset_id: string | null;
  actor_id: string | null;
  type: string;
  from_state: string | null;
  to_state: string | null;
  payload: unknown;
  created_at: Timestamp;
}

export interface QcSampleRow {
  id: string;
  dataset_id: string;
  item_id: string;
  reason: 'random' | 'risk' | 'gold_check';
  status: 'open' | 'resolved';
  result: boolean | null;
  sampled_by: string | null;
  created_at: Timestamp;
  resolved_at: Timestamp | null;
}

export const TASK_WITH_CONTEXT_SELECT = `
  t.id, t.item_id, t.dataset_id, t.state, t.ai_label, t.ai_confidence,
  t.ai_provider, t.final_label, t.created_at, t.updated_at,
  d.task_type, d.label_schema,
  i.content, i.meta, i.split
`;

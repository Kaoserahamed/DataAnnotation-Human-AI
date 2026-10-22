-- Initial schema for the Human + AI Data Annotation Platform.
-- Applied by src/db/migrate.ts inside a transaction and recorded in
-- schema_migrations. All identifiers are application-generated UUIDs so no
-- sequence/trigger ordering differences can arise between engines.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'annotator', 'reviewer', 'client')),
  refresh_token TEXT,
  mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  mfa_secret TEXT,
  oauth_provider TEXT,
  oauth_subject TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE datasets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  task_type TEXT NOT NULL CHECK (task_type IN (
    'text_classification', 'sentiment', 'ner', 'image_bbox',
    'image_segmentation', 'audio_transcription', 'audio_translation',
    'document_annotation'
  )),
  label_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE items (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  content JSONB NOT NULL,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  split TEXT NOT NULL DEFAULT 'pool' CHECK (split IN ('pool', 'dev', 'test', 'gold')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL UNIQUE REFERENCES items(id) ON DELETE CASCADE,
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'pending_prelabel' CHECK (state IN (
    'pending_prelabel', 'pending_review', 'pending_human', 'in_review',
    'accepted', 'needs_correct', 'rejected', 'escalated'
  )),
  ai_label JSONB,
  ai_confidence DOUBLE PRECISION,
  ai_provider TEXT,
  final_label JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE predictions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('ai', 'human', 'gold')),
  provider TEXT NOT NULL,
  label JSONB NOT NULL,
  confidence DOUBLE PRECISION,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE annotations (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label JSONB,
  verdict TEXT NOT NULL CHECK (verdict IN ('correct', 'corrected', 'rejected')),
  similarity DOUBLE PRECISION,
  note TEXT,
  time_spent_ms INTEGER CHECK (time_spent_ms IS NULL OR time_spent_ms >= 0),
  is_gold_check BOOLEAN NOT NULL DEFAULT FALSE,
  gold_correct BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only annotation/audit history.
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  item_id TEXT,
  dataset_id TEXT,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE qc_samples (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('random', 'risk', 'gold_check')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  result BOOLEAN,
  sampled_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX idx_items_dataset ON items(dataset_id);
CREATE INDEX idx_items_split ON items(dataset_id, split);
CREATE INDEX idx_tasks_dataset_state ON tasks(dataset_id, state);
CREATE INDEX idx_tasks_dataset_acq ON tasks(dataset_id, ai_confidence);
CREATE INDEX idx_predictions_task ON predictions(task_id);
CREATE INDEX idx_annotations_task ON annotations(task_id);
CREATE INDEX idx_annotations_item ON annotations(item_id);
CREATE INDEX idx_annotations_user ON annotations(user_id);
CREATE INDEX idx_annotations_dataset ON annotations(dataset_id);
CREATE INDEX idx_events_task ON events(task_id);
CREATE INDEX idx_events_dataset ON events(dataset_id);
CREATE INDEX idx_qc_dataset_status ON qc_samples(dataset_id, status);

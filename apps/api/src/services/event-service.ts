/** Append-only audit events backing the annotation history view. */

import type { TaskState } from '../shared.js';
import { json, type Database } from '../db/database.js';
import { newId } from '../lib/ids.js';

export interface RecordEventInput {
  type: string;
  taskId?: string | null;
  itemId?: string | null;
  datasetId?: string | null;
  actorId?: string | null;
  fromState?: TaskState | null;
  toState?: TaskState | null;
  payload?: Record<string, unknown>;
}

export async function recordEvent(db: Database, input: RecordEventInput): Promise<void> {
  await db.execute(
    `INSERT INTO events (id, task_id, item_id, dataset_id, actor_id, type, from_state, to_state, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      newId(),
      input.taskId ?? null,
      input.itemId ?? null,
      input.datasetId ?? null,
      input.actorId ?? null,
      input.type,
      input.fromState ?? null,
      input.toState ?? null,
      json(input.payload ?? {}),
    ],
  );
}

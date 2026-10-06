/**
 * Catalog service: projects, datasets, and item ingestion.
 *
 * Items are inserted together with their pipeline task in one transaction so
 * every item is guaranteed to have exactly one task row from creation,
 * starting in `pending_prelabel`.
 */

import type {
  CreateDatasetInput,
  CreateItemsInput,
  CreateProjectInput,
  Paginated,
  UpdateProjectInput,
} from '@haap/shared';
import { json, parseJson } from '../db/database.js';
import type {
  DatasetRow,
  ItemRow,
  ProjectRow,
  TaskRow,
} from '../db/rows.js';
import { TASK_WITH_CONTEXT_SELECT, type TaskWithContextRow } from '../db/rows.js';
import { errors } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { recordEvent } from './event-service.js';
import type { AuthUser, ServiceContext } from './context.js';

export interface PublicProject {
  id: string;
  name: string;
  description: string;
  status: 'active' | 'archived';
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PublicDataset {
  id: string;
  projectId: string;
  name: string;
  taskType: DatasetRow['task_type'];
  labelSchema: unknown;
  createdAt: string;
}

function toPublicProject(row: ProjectRow): PublicProject {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function toPublicDataset(row: DatasetRow): PublicDataset {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    taskType: row.task_type,
    labelSchema: parseJson<Record<string, unknown>>(row.label_schema, {}),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export async function createProject(
  ctx: ServiceContext,
  actor: AuthUser,
  input: CreateProjectInput,
): Promise<PublicProject> {
  const row: ProjectRow = {
    id: newId(),
    name: input.name,
    description: input.description,
    status: 'active',
    created_by: actor.id,
    created_at: new Date(),
    updated_at: new Date(),
  };
  await ctx.db.execute(
    `INSERT INTO projects (id, name, description, status, created_by) VALUES ($1, $2, $3, $4, $5)`,
    [row.id, row.name, row.description, row.status, row.created_by],
  );
  await recordEvent(ctx.db, {
    type: 'project_created',
    actorId: actor.id,
    payload: { projectId: row.id, name: row.name },
  });
  return toPublicProject(row);
}

export async function listProjects(ctx: ServiceContext): Promise<PublicProject[]> {
  const rows = await ctx.db.query<ProjectRow>('SELECT * FROM projects ORDER BY created_at DESC');
  return rows.map(toPublicProject);
}

export async function getProject(ctx: ServiceContext, projectId: string): Promise<PublicProject> {
  const rows = await ctx.db.query<ProjectRow>('SELECT * FROM projects WHERE id = $1', [projectId]);
  const row = rows[0];
  if (!row) throw errors.notFound('project', projectId);
  return toPublicProject(row);
}

export async function updateProject(
  ctx: ServiceContext,
  actor: AuthUser,
  projectId: string,
  input: UpdateProjectInput,
): Promise<PublicProject> {
  const current = await getProject(ctx, projectId);
  await ctx.db.execute(
    `UPDATE projects SET status = COALESCE($1, status), description = COALESCE($2, description),
       updated_at = now() WHERE id = $3`,
    [input.status ?? null, input.description ?? null, projectId],
  );
  await recordEvent(ctx.db, {
    type: 'project_updated',
    actorId: actor.id,
    payload: { projectId, patch: input },
  });
  return getProject(ctx, current.id);
}

// ---------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------

export async function createDataset(
  ctx: ServiceContext,
  actor: AuthUser,
  input: CreateDatasetInput,
): Promise<PublicDataset> {
  await getProject(ctx, input.projectId); // 404 before inserting
  const row: DatasetRow = {
    id: newId(),
    project_id: input.projectId,
    name: input.name,
    task_type: input.taskType,
    label_schema: input.labelSchema,
    created_at: new Date(),
  };
  await ctx.db.execute(
    `INSERT INTO datasets (id, project_id, name, task_type, label_schema)
     VALUES ($1, $2, $3, $4, $5)`,
    [row.id, row.project_id, row.name, row.task_type, json(row.label_schema)],
  );
  await recordEvent(ctx.db, {
    type: 'dataset_created',
    datasetId: row.id,
    actorId: actor.id,
    payload: { projectId: row.project_id, taskType: row.task_type },
  });
  return toPublicDataset(row);
}

export async function listDatasets(
  ctx: ServiceContext,
  projectId: string,
): Promise<PublicDataset[]> {
  const rows = await ctx.db.query<DatasetRow>(
    'SELECT * FROM datasets WHERE project_id = $1 ORDER BY created_at ASC',
    [projectId],
  );
  return rows.map(toPublicDataset);
}

export async function getDataset(ctx: ServiceContext, datasetId: string): Promise<DatasetRow> {
  const rows = await ctx.db.query<DatasetRow>('SELECT * FROM datasets WHERE id = $1', [datasetId]);
  const row = rows[0];
  if (!row) throw errors.notFound('dataset', datasetId);
  return row;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export type ItemSplitLike = 'pool' | 'dev' | 'test' | 'gold';

export interface PublicItem {
  id: string;
  datasetId: string;
  content: unknown;
  meta: unknown;
  split: ItemSplitLike;
  createdAt: string;
}

function toPublicItem(row: ItemRow): PublicItem {
  return {
    id: row.id,
    datasetId: row.dataset_id,
    content: row.content,
    meta: row.meta,
    split: row.split,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** Bulk-create items plus their `pending_prelabel` tasks atomically. */
export async function createItems(
  ctx: ServiceContext,
  actor: AuthUser,
  datasetId: string,
  input: CreateItemsInput,
): Promise<{ items: PublicItem[]; tasksCreated: number }> {
  const dataset = await getDataset(ctx, datasetId);
  const created: PublicItem[] = [];

  await ctx.db.transaction(async (tx) => {
    for (const item of input.items) {
      const itemId = newId();
      await tx.execute(
        `INSERT INTO items (id, dataset_id, content, meta, split) VALUES ($1, $2, $3, $4, $5)`,
        [itemId, datasetId, json(item.content), json(item.meta ?? {}), item.split],
      );
      await tx.execute(
        `INSERT INTO tasks (id, item_id, dataset_id, state) VALUES ($1, $2, $3, 'pending_prelabel')`,
        [newId(), itemId, datasetId],
      );
      created.push({
        id: itemId,
        datasetId,
        content: item.content,
        meta: item.meta ?? {},
        split: item.split,
        createdAt: new Date().toISOString(),
      });
    }
    await recordEvent(tx, {
      type: 'items_created',
      datasetId,
      actorId: actor.id,
      payload: { count: created.length, taskType: dataset.task_type },
    });
  });

  return { items: created, tasksCreated: created.length };
}

export async function listItems(
  ctx: ServiceContext,
  datasetId: string,
  page: { limit: number; offset: number },
  split?: ItemSplitLike,
): Promise<Paginated<PublicItem>> {
  await getDataset(ctx, datasetId);
  const where = split ? 'WHERE dataset_id = $1 AND split = $2' : 'WHERE dataset_id = $1';
  const params = split ? [datasetId, split] : [datasetId];
  const countRows = await ctx.db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM items ${where}`,
    params,
  );
  const rows = await ctx.db.query<ItemRow>(
    `SELECT * FROM items ${where} ORDER BY created_at ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, page.limit, page.offset],
  );
  return {
    data: rows.map(toPublicItem),
    total: Number(countRows[0]?.count ?? 0),
    limit: page.limit,
    offset: page.offset,
  };
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export interface TaskView {
  id: string;
  itemId: string;
  datasetId: string;
  state: TaskWithContextRow['state'];
  aiLabel: unknown;
  aiConfidence: number | null;
  aiProvider: string | null;
  finalLabel: unknown;
  taskType: TaskWithContextRow['task_type'];
  labelSchema: unknown;
  content: unknown;
  meta: unknown;
  split: TaskWithContextRow['split'];
  updatedAt: string;
}

export function toTaskView(row: TaskWithContextRow): TaskView {
  return {
    id: row.id,
    itemId: row.item_id,
    datasetId: row.dataset_id,
    state: row.state,
    aiLabel: row.ai_label,
    aiConfidence: row.ai_confidence,
    aiProvider: row.ai_provider,
    finalLabel: row.final_label,
    taskType: row.task_type,
    labelSchema: parseJson<Record<string, unknown>>(row.label_schema, {}),
    content: row.content,
    meta: row.meta,
    split: row.split,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/** Load one task with its dataset + item context, or throw 404. */
export async function getTaskWithContext(
  ctx: ServiceContext,
  taskId: string,
): Promise<TaskWithContextRow> {
  const rows = await ctx.db.query<TaskWithContextRow>(
    `SELECT ${TASK_WITH_CONTEXT_SELECT}
     FROM tasks t
     JOIN datasets d ON d.id = t.dataset_id
     JOIN items i ON i.id = t.item_id
     WHERE t.id = $1`,
    [taskId],
  );
  const row = rows[0];
  if (!row) throw errors.notFound('task', taskId);
  return row;
}

export async function getTaskView(ctx: ServiceContext, taskId: string): Promise<TaskView> {
  return toTaskView(await getTaskWithContext(ctx, taskId));
}

/** Task rows in the given states; used by prelabel and the review queue. */
export async function findTasksByState(
  ctx: ServiceContext,
  datasetId: string,
  states: readonly string[],
  options: { itemIds?: string[]; limit?: number } = {},
): Promise<TaskRow[]> {
  const clauses = ['dataset_id = $1', 'state = ANY($2)'];
  const params: unknown[] = [datasetId, states];
  if (options.itemIds && options.itemIds.length > 0) {
    params.push(options.itemIds);
    clauses.push(`item_id = ANY($${params.length})`);
  }
  params.push(options.limit ?? 1000);
  return ctx.db.query<TaskRow>(
    `SELECT * FROM tasks WHERE ${clauses.join(' AND ')}
     ORDER BY created_at ASC LIMIT $${params.length}`,
    params,
  );
}

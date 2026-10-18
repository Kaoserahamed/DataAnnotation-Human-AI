/** Project and dataset catalog routes. */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CreateDatasetSchema,
  CreateItemsSchema,
  CreateProjectSchema,
  PaginationQuerySchema,
  PrelabelTasksSchema,
  UpdateProjectSchema,
} from '../shared.js';
import { errors } from '../lib/errors.js';
import { parseWith, requireAuth, requireRole } from '../lib/http.js';
import {
  createDataset,
  createItems,
  createProject,
  getDataset,
  getProject,
  listDatasets,
  listItems,
  listProjects,
  updateProject,
} from '../services/catalog-service.js';
import { runPrelabeling } from '../services/prelabel-service.js';
import type { ItemRow } from '../db/rows.js';

export function registerCatalogRoutes(app: FastifyInstance): void {
  app.post('/projects', async (request, reply) => {
    const actor = await requireAuth(request);
    requireRole(actor, 'admin');
    const input = parseWith(CreateProjectSchema, request.body);
    void reply.status(201);
    return { project: await createProject(app.ctx, actor, input) };
  });

  app.get('/projects', async (request) => {
    await requireAuth(request);
    return { data: await listProjects(app.ctx) };
  });

  app.get('/projects/:id', async (request) => {
    await requireAuth(request);
    const { id } = request.params as { id: string };
    return { project: await getProject(app.ctx, id) };
  });

  app.patch('/projects/:id', async (request) => {
    const actor = await requireAuth(request);
    requireRole(actor, 'admin');
    const { id } = request.params as { id: string };
    const input = parseWith(UpdateProjectSchema, request.body);
    return { project: await updateProject(app.ctx, actor, id, input) };
  });

  app.get('/projects/:id/datasets', async (request) => {
    await requireAuth(request);
    const { id } = request.params as { id: string };
    await getProject(app.ctx, id);
    return { data: await listDatasets(app.ctx, id) };
  });

  app.post('/projects/:id/datasets', async (request, reply) => {
    const actor = await requireAuth(request);
    requireRole(actor, 'admin');
    const { id } = request.params as { id: string };
    const input = parseWith(CreateDatasetSchema, {
      ...((request.body ?? {}) as Record<string, unknown>),
      projectId: id,
    });
    void reply.status(201);
    return { dataset: await createDataset(app.ctx, actor, input) };
  });

  app.get('/datasets/:id', async (request) => {
    await requireAuth(request);
    const { id } = request.params as { id: string };
    return { dataset: await getDataset(app.ctx, id) };
  });

  app.get('/datasets/:id/items', async (request) => {
    await requireAuth(request);
    const { id } = request.params as { id: string };
    const query = parseWith(
      PaginationQuerySchema.extend({
        split: z.enum(['pool', 'dev', 'test', 'gold']).optional(),
      }),
      request.query,
    );
    const page = await listItems(
      app.ctx,
      id,
      { limit: query.limit, offset: query.offset },
      query.split,
    );
    return page;
  });

  app.post('/datasets/:id/items', async (request, reply) => {
    const actor = await requireAuth(request);
    requireRole(actor, 'admin');
    const { id } = request.params as { id: string };
    const input = parseWith(CreateItemsSchema, request.body);
    void reply.status(201);
    return createItems(app.ctx, actor, id, input);
  });

  app.post('/datasets/:id/prelabel', async (request) => {
    const actor = await requireAuth(request);
    requireRole(actor, 'admin');
    const { id } = request.params as { id: string };
    const input = parseWith(PrelabelTasksSchema, request.body ?? {});
    return runPrelabeling(app.ctx, {
      datasetId: id,
      itemIds: input.itemIds,
      limit: input.limit,
    });
  });

  app.get('/datasets/:id/items/:itemId', async (request) => {
    await requireAuth(request);
    const { id, itemId } = request.params as { id: string; itemId: string };
    const rows = await app.db.query<ItemRow>(
      'SELECT * FROM items WHERE dataset_id = $1 AND id = $2',
      [id, itemId],
    );
    const row = rows[0];
    if (!row) throw errors.notFound('item', itemId);
    return {
      item: {
        id: row.id,
        datasetId: row.dataset_id,
        content: row.content,
        meta: row.meta,
        split: row.split,
        createdAt: new Date(row.created_at).toISOString(),
      },
    };
  });
}

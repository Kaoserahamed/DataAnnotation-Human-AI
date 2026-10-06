import { z } from 'zod';
import {
  ITEM_SPLIT_SCHEMA,
  PREDICTION_SOURCE_SCHEMA,
  PROJECT_STATUS_SCHEMA,
  QC_REASON_SCHEMA,
  REVIEW_VERDICT_SCHEMA,
  TASK_STATE_SCHEMA,
  TASK_TYPE_LIST_SCHEMA,
  USER_ROLE_SCHEMA,
} from './labels.js';

/** A JSON value accepted anywhere this API stores free-form structure. */
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ]),
);

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Every request/response body has a size cap so payloads cannot exhaust memory. */
export const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;

export const IdSchema = z.string().min(1).max(64);
export const EmailSchema = z.string().email().max(320);
export const PasswordSchema = z
  .string()
  .min(12, 'password must be at least 12 characters')
  .max(128);

/** Shared pagination envelope, used by every list endpoint. */
export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export interface Paginated<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

/** Categorical dataset definition supplied at creation time. */
export const LabelSchemaDefinitionSchema = z
  .object({
    /** Allowed label values for categorical modalities. */
    categories: z.array(z.string().min(1).max(200)).max(500).optional(),
    /** Entity types for NER. */
    entityTypes: z.array(z.string().min(1).max(200)).max(500).optional(),
    /** Region/object names for image modalities. */
    regionLabels: z.array(z.string().min(1).max(200)).max(500).optional(),
    /** Target language for `audio_translation`. */
    targetLanguage: z.string().min(2).max(10).optional(),
  })
  .strict();

export const CreateUserSchema = z
  .object({
    email: EmailSchema,
    name: z.string().min(1).max(200),
    password: PasswordSchema,
    role: USER_ROLE_SCHEMA.default('annotator'),
  })
  .strict();

export const LoginSchema = z
  .object({
    email: EmailSchema,
    password: z.string().min(1).max(128),
  })
  .strict();

export const CreateProjectSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(4000).default(''),
  })
  .strict();

export const CreateDatasetSchema = z
  .object({
    projectId: IdSchema,
    name: z.string().min(1).max(200),
    taskType: TASK_TYPE_LIST_SCHEMA,
    labelSchema: LabelSchemaDefinitionSchema.default({}),
  })
  .strict();

export const CreateItemsSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            content: JsonValueSchema,
            meta: JsonValueSchema.optional(),
            split: ITEM_SPLIT_SCHEMA.default('pool'),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
  })
  .strict();

export const PrelabelTasksSchema = z.object({
  /** Restrict pre-labeling to a subset of the dataset's items. */
  itemIds: z.array(IdSchema).max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});
export const SubmitAnnotationSchema = z
  .object({
    label: JsonValueSchema,
    /** Human's own confidence in the answer, distinct from the AI's. */
    annotatorConfidence: z.number().min(0).max(1).optional(),
    timeSpentMs: z.number().int().min(0).max(86_400_000).optional(),
  })
  .strict();

export const ReviewAnnotationSchema = z
  .object({
    verdict: REVIEW_VERDICT_SCHEMA,
    correctedLabel: JsonValueSchema.optional(),
    note: z.string().max(2000).optional(),
  })
  .strict();

export const SampleQcSchema = z
  .object({
    reason: QC_REASON_SCHEMA.default('random'),
    size: z.coerce.number().int().min(1).max(500).default(25),
    seed: z.coerce.number().int().min(0).max(2_147_483_647).optional(),
  })
  .strict();

export const PromoteGoldSchema = z
  .object({
    itemIds: z.array(IdSchema).min(1).max(500),
    /** Reviewers may force promotion regardless of confirmation count. */
    force: z.coerce.boolean().default(false),
  })
  .strict();

export const UpdateTaskStateSchema = z
  .object({
    state: TASK_STATE_SCHEMA,
    reason: z.string().max(2000).optional(),
  })
  .strict();

export const UpdateProjectSchema = z
  .object({
    status: PROJECT_STATUS_SCHEMA.optional(),
    description: z.string().max(4000).optional(),
  })
  .strict();

export const QueueQuerySchema = PaginationQuerySchema.extend({
  /** Only tasks in these states. */
  states: z.array(TASK_STATE_SCHEMA).max(8).optional(),
  /** Override the default active-learning ordering. */
  orderBy: z.enum(['acquisition', 'created', 'confidence']).default('acquisition'),
}).strict();

export const HistoryQuerySchema = PaginationQuerySchema.extend({
  itemId: IdSchema.optional(),
  taskId: IdSchema.optional(),
  predictionSource: PREDICTION_SOURCE_SCHEMA.optional(),
}).strict();

export const AgreementQuerySchema = z
  .object({
    /** Restrict the computation to one dataset; required. */
    datasetId: IdSchema,
    /** Optional cap on the number of items considered. */
    limit: z.coerce.number().int().min(2).max(5000).default(1000),
  })
  .strict();

export type CreateUserInput = z.infer<typeof CreateUserSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;
export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;
export type CreateDatasetInput = z.infer<typeof CreateDatasetSchema>;
export type CreateItemsInput = z.infer<typeof CreateItemsSchema>;
export type PrelabelTasksInput = z.infer<typeof PrelabelTasksSchema>;
export type SubmitAnnotationInput = z.infer<typeof SubmitAnnotationSchema>;
export type ReviewAnnotationInput = z.infer<typeof ReviewAnnotationSchema>;
export type SampleQcInput = z.infer<typeof SampleQcSchema>;
export type PromoteGoldInput = z.infer<typeof PromoteGoldSchema>;
export type QueueQuery = z.infer<typeof QueueQuerySchema>;
export type HistoryQuery = z.infer<typeof HistoryQuerySchema>;
export type AgreementQuery = z.infer<typeof AgreementQuerySchema>;

/** Uniform error envelope produced by the single global error handler. */
export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId: string;
  };
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  uptimeSeconds: number;
  version: string;
  database: { reachable: boolean; latencyMs: number | null };
}

export interface MetricsResponse {
  requests: { total: number; inFlight: number; errorRate: number };
  latency: { p50: number; p95: number; p99: number };
  tasks: Record<string, number>;
  ai: { provider: string; predictions: number; failures: number };
}

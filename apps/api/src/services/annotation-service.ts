/**
 * Human verification and review: the center of the pipeline.
 *
 *   submitAnnotation  — the annotator's judgement. Compares the human label
 *     with the AI label using modality-aware similarity, records the
 *     annotation, and applies the shared `decideVerification` outcome:
 *     agreement  -> `accepted` (AI label kept as final),
 *     difference -> `needs_correct` (human label supersedes),
 *     two independent agreeing humans -> the item joins the gold dataset.
 *
 *   reviewAnnotation  — a reviewer resolves a task: confirm, correct, or
 *     reject (which escalates rather than silently dropping work).
 *
 *   overrideTaskState — admin-only, still constrained by the shared
 *     `canTransition` table so history stays meaningful.
 */

import {
  decideVerification,
  labelSimilarity,
  parseLabelForTaskType,
  type LabelPayload,
  type ReviewVerdict,
  type TaskState,
  type VerificationOutcome,
  canTransition,
} from '@haap/shared';
import { json } from '../db/database.js';
import { errors } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import {
  getTaskWithContext,
  getTaskView,
  toTaskView,
  type TaskView,
} from './catalog-service.js';
import { recordEvent } from './event-service.js';
import type { AuthUser, ServiceContext } from './context.js';
import type { ReviewAnnotationInput, SubmitAnnotationInput } from '@haap/shared';

/**
 * Map a desired state onto one the state machine actually permits.
 *
 * The shared transition table is the source of truth; this adds the only
 * three domain-sensible fallbacks (documented in docs/architecture.md):
 *   - a corrected escalated item goes to senior `in_review`,
 *   - a correction of an already-accepted item re-opens it as `escalated`,
 *   - identical from/to is a no-op (re-affirming the current state).
 */
export function resolveTransition(from: TaskState, to: TaskState): TaskState {
  if (from === to) return to;
  if (canTransition(from, to)) return to;
  if (from === 'escalated' && to === 'needs_correct') return 'in_review';
  if (from === 'accepted' && to === 'needs_correct') return 'escalated';
  throw errors.precondition(`state transition ${from} -> ${to} is not allowed`, {
    from,
    to,
    allowed: to,
  });
}

function asLabel(value: unknown): LabelPayload | null {
  return (value ?? null) as LabelPayload | null;
}

/** Parse a stored label envelope; null when absent or malformed. */
function parseStored(taskType: TaskView['taskType'], value: unknown): LabelPayload | null {
  if (value === null || value === undefined) return null;
  try {
    return parseLabelForTaskType(taskType, value);
  } catch {
    return null;
  }
}

/** Distinct users (excluding `excludeUserId`) whose labels equal `candidate`. */
async function agreeingUserCount(
  ctx: ServiceContext,
  taskId: string,
  taskType: TaskView['taskType'],
  candidate: LabelPayload,
  excludeUserId: string,
): Promise<Set<string>> {
  const rows = await ctx.db.query<{ user_id: string; label: unknown }>(
    'SELECT user_id, label FROM annotations WHERE task_id = $1 AND user_id <> $2',
    [taskId, excludeUserId],
  );
  const agreeing = new Set<string>();
  for (const row of rows) {
    const other = parseStored(taskType, row.label);
    if (other && labelSimilarity(taskType, other, candidate) >= 1) {
      agreeing.add(row.user_id);
    }
  }
  return agreeing;
}

export interface SubmitAnnotationResult {
  annotationId: string;
  verdict: ReviewVerdict;
  kind: VerificationOutcome['kind'];
  similarity: number | null;
  priorHumanConfirmations: number;
  promotedToGold: boolean;
  task: TaskView;
}

export async function submitAnnotation(
  ctx: ServiceContext,
  actor: AuthUser,
  taskId: string,
  body: SubmitAnnotationInput,
): Promise<SubmitAnnotationResult> {
  const task = await getTaskWithContext(ctx, taskId);
  if (task.state === 'rejected') {
    throw errors.precondition('task is rejected; an admin must reopen it first');
  }

  // The request carries the label *value*; wrap it as a bare envelope so the
  // shared parser never confuses a categorical value with an envelope.
  const label = parseLabelForTaskType(task.task_type, { label: body.label }) as LabelPayload;
  const isGold = task.split === 'gold';
  const aiLabel = asLabel(task.ai_label);
  const finalLabel = asLabel(task.final_label);
  // Gold checks are judged against the gold answer, not the original AI guess.
  const base = isGold ? (finalLabel ?? aiLabel) : aiLabel;

  const agreeing = await agreeingUserCount(ctx, taskId, task.task_type, label, actor.id);
  const outcome = decideVerification({
    taskType: task.task_type,
    aiLabel: base,
    humanLabel: label,
    priorHumanConfirmations: agreeing.size,
  });

  const similarity = base ? labelSimilarity(task.task_type, base, label) : null;
  const nextState = resolveTransition(task.state, outcome.nextState);
  const finalNext = outcome.kind === 'corrected' ? label : (base ?? label);
  const goldCorrect = isGold ? similarity !== null && similarity >= 1 : null;
  const annotationId = newId();

  await ctx.db.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO annotations
         (id, task_id, item_id, dataset_id, user_id, label, verdict, similarity,
          note, time_spent_ms, is_gold_check, gold_correct)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        annotationId,
        taskId,
        task.item_id,
        task.dataset_id,
        actor.id,
        json(label),
        outcome.verdict,
        similarity,
        null,
        body.timeSpentMs ?? null,
        isGold,
        goldCorrect,
      ],
    );
    await tx.execute(
      `INSERT INTO predictions
         (id, task_id, item_id, dataset_id, source, provider, label, confidence, created_by)
       VALUES ($1, $2, $3, $4, 'human', 'human', $5, NULL, $6)`,
      [newId(), taskId, task.item_id, task.dataset_id, json(label), actor.id],
    );
    await tx.execute(
      `UPDATE tasks SET state = $1, final_label = $2, updated_at = now() WHERE id = $3`,
      [nextState, json(finalNext), taskId],
    );
    if (outcome.promoteToGold) {
      await tx.execute(
        `UPDATE items SET split = 'gold' WHERE id = $1 AND split <> 'gold'`,
        [task.item_id],
      );
    }
    await recordEvent(tx, {
      type: 'annotation_submitted',
      taskId,
      itemId: task.item_id,
      datasetId: task.dataset_id,
      actorId: actor.id,
      fromState: task.state,
      toState: nextState,
      payload: {
        source: isGold ? 'gold' : 'human',
        verdict: outcome.verdict,
        similarity,
        isGoldCheck: isGold,
        goldCorrect,
        promotedToGold: outcome.promoteToGold,
        confirmations: agreeing.size + 1,
        ...(body.timeSpentMs === undefined ? {} : { timeSpentMs: body.timeSpentMs }),
      },
    });
    if (outcome.promoteToGold) {
      await recordEvent(tx, {
        type: 'gold_promoted',
        taskId,
        itemId: task.item_id,
        datasetId: task.dataset_id,
        actorId: actor.id,
        payload: { source: 'gold', confirmations: agreeing.size + 1, via: 'verification' },
      });
    }
  });

  return {
    annotationId,
    verdict: outcome.verdict,
    kind: outcome.kind,
    similarity,
    priorHumanConfirmations: agreeing.size,
    promotedToGold: outcome.promoteToGold,
    task: toTaskView({ ...task, state: nextState, final_label: finalNext }),
  };
}

export interface ReviewResult {
  annotationId: string | null;
  verdict: ReviewVerdict;
  similarity: number | null;
  task: TaskView;
}

export async function reviewAnnotation(
  ctx: ServiceContext,
  actor: AuthUser,
  taskId: string,
  body: ReviewAnnotationInput,
): Promise<ReviewResult> {
  if (actor.role !== 'reviewer' && actor.role !== 'admin') {
    throw errors.forbidden('only reviewers or admins may review tasks');
  }
  const task = await getTaskWithContext(ctx, taskId);
  if (task.state === 'rejected') {
    throw errors.precondition('task is rejected; an admin must reopen it first');
  }

  const isGold = task.split === 'gold';
  const base = asLabel(task.final_label) ?? asLabel(task.ai_label);
  const corrected =
    body.correctedLabel === undefined
      ? null
      : (parseLabelForTaskType(task.task_type, {
          label: body.correctedLabel,
        }) as LabelPayload);

  let annotationLabel: LabelPayload | null;
  let finalNext: unknown;
  let targetState: TaskState;

  switch (body.verdict) {
    case 'correct':
      if (!base) {
        throw errors.precondition('nothing to accept: task has no AI or final label to confirm');
      }
      annotationLabel = base;
      finalNext = base;
      targetState = 'accepted';
      break;
    case 'corrected':
      if (!corrected) {
        throw errors.validation('correctedLabel is required when verdict is "corrected"');
      }
      annotationLabel = corrected;
      finalNext = corrected;
      targetState = 'accepted';
      break;
    case 'rejected':
      annotationLabel = corrected;
      finalNext = task.final_label;
      targetState = canTransition(task.state, 'escalated') ? 'escalated' : task.state;
      break;
    default: {
      const exhaustive: never = body.verdict;
      return exhaustive;
    }
  }

  const similarity =
    base && annotationLabel ? labelSimilarity(task.task_type, base, annotationLabel) : null;
  const goldCorrect = isGold ? similarity !== null && similarity >= 1 : null;
  const nextState = resolveTransition(task.state, targetState);
  const annotationId = newId();

  await ctx.db.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO annotations
         (id, task_id, item_id, dataset_id, user_id, label, verdict, similarity,
          note, time_spent_ms, is_gold_check, gold_correct)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10, $11)`,
      [
        annotationId,
        taskId,
        task.item_id,
        task.dataset_id,
        actor.id,
        annotationLabel === null ? null : json(annotationLabel),
        body.verdict,
        similarity,
        body.note ?? null,
        isGold,
        goldCorrect,
      ],
    );
    if (annotationLabel !== null) {
      await tx.execute(
        `INSERT INTO predictions
           (id, task_id, item_id, dataset_id, source, provider, label, confidence, created_by)
         VALUES ($1, $2, $3, $4, 'human', 'reviewer', $5, NULL, $6)`,
        [newId(), taskId, task.item_id, task.dataset_id, json(annotationLabel), actor.id],
      );
    }
    await tx.execute(
      `UPDATE tasks SET state = $1, final_label = $2, updated_at = now() WHERE id = $3`,
      [nextState, finalNext === null || finalNext === undefined ? null : json(finalNext), taskId],
    );
    await recordEvent(tx, {
      type: 'review_completed',
      taskId,
      itemId: task.item_id,
      datasetId: task.dataset_id,
      actorId: actor.id,
      fromState: task.state,
      toState: nextState,
      payload: {
        source: isGold ? 'gold' : 'human',
        verdict: body.verdict,
        similarity,
        isGoldCheck: isGold,
        ...(body.note ? { note: body.note } : {}),
      },
    });
  });

  return {
    annotationId,
    verdict: body.verdict,
    similarity,
    task: toTaskView({ ...task, state: nextState, final_label: finalNext as never }),
  };
}

export async function overrideTaskState(
  ctx: ServiceContext,
  actor: AuthUser,
  taskId: string,
  body: { state: TaskState; reason?: string | undefined },
): Promise<TaskView> {
  if (actor.role !== 'admin') throw errors.forbidden('only admins may override task state');
  const task = await getTaskWithContext(ctx, taskId);
  if (body.state === task.state) return toTaskView(task);
  if (!canTransition(task.state, body.state)) {
    throw errors.precondition(`state transition ${task.state} -> ${body.state} is not allowed`, {
      from: task.state,
      to: body.state,
    });
  }
  await ctx.db.transaction(async (tx) => {
    await tx.execute('UPDATE tasks SET state = $1, updated_at = now() WHERE id = $2', [
      body.state,
      taskId,
    ]);
    await recordEvent(tx, {
      type: 'state_override',
      taskId,
      itemId: task.item_id,
      datasetId: task.dataset_id,
      actorId: actor.id,
      fromState: task.state,
      toState: body.state,
      payload: { reason: body.reason ?? null, source: 'admin' },
    });
  });
  return getTaskView(ctx, taskId);
}

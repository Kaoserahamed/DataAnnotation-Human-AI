/**
 * The annotation pipeline state machine.
 *
 * This file encodes the platform's core flow as *pure functions over data*:
 *
 *   dataset -> AI pre-label -> human verification
 *                                    |          |
 *                                 correct     incorrect
 *                                    |          |
 *                                 accepted   correct label
 *                                     \        /
 *                                        v
 *                                   gold dataset
 *
 * Because no database or HTTP context is involved, the entire workflow — every
 * branch, threshold and escalation rule — is unit-testable in isolation. The
 * services layer is then only responsible for loading state, calling these
 * functions, and persisting the results.
 */

import type { ReviewVerdict, TaskState, TaskType } from './task-types.js';
import type { LabelPayload } from './labels.js';
import { labelSimilarity } from './comparison.js';

/** Transitions the workflow permits. Anything absent here is rejected. */
export const ALLOWED_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  pending_prelabel: ['pending_review', 'pending_human'],
  pending_review: ['accepted', 'needs_correct', 'escalated', 'pending_human'],
  pending_human: ['pending_review', 'accepted', 'escalated'],
  in_review: ['accepted', 'needs_correct', 'escalated'],
  needs_correct: ['pending_review', 'accepted', 'escalated'],
  escalated: ['pending_review', 'in_review', 'accepted'],
  accepted: ['escalated'],
  rejected: [],
} as const;

/** Thresholds governing the AI -> Human -> Gold pipeline. */
export const PIPELINE_THRESHOLDS = {
  /** At or above this AI confidence, a human can accept in one click. */
  highConfidenceAutoAccept: 0.9,
  /** Below this confidence the AI label is treated as unreliable. */
  lowConfidenceEscalation: 0.5,
  /** Independent human agreements required before promoting an item to gold. */
  goldAgreementRequired: 2,
  /** Fraction of QC sample drawn at random, remainder chosen by risk. */
  qcRandomFraction: 0.3,
  /** Fraction of a batch injected as gold-standard check questions. */
  goldCheckInjectionRate: 0.1,
} as const;

export function canTransition(from: TaskState, to: TaskState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export interface PrelabelDecision {
  nextState: TaskState;
  confidence: number;
  /** Human may accept immediately because the model is confident. */
  canFastAccept: boolean;
  /** Item should skip straight to a senior reviewer. */
  requiresEscalation: boolean;
}

/** Decide where a freshly generated AI prediction sends the task. */
export function decideAfterPrelabel(confidence: number): PrelabelDecision {
  const bounded = Math.min(1, Math.max(0, confidence));
  if (bounded < PIPELINE_THRESHOLDS.lowConfidenceEscalation) {
    return {
      nextState: 'escalated',
      confidence: bounded,
      canFastAccept: false,
      requiresEscalation: true,
    };
  }
  return {
    nextState: 'pending_review',
    confidence: bounded,
    canFastAccept: bounded >= PIPELINE_THRESHOLDS.highConfidenceAutoAccept,
    requiresEscalation: false,
  };
}

export type VerificationOutcome =
  | { kind: 'accepted'; verdict: ReviewVerdict; nextState: TaskState; promoteToGold: boolean }
  | { kind: 'corrected'; verdict: ReviewVerdict; nextState: TaskState; promoteToGold: boolean }
  | { kind: 'rejected'; verdict: ReviewVerdict; nextState: TaskState; promoteToGold: false };

export interface VerifyInput {
  taskType: TaskType;
  /** The AI (or prior) label the human was shown. */
  aiLabel: LabelPayload | null;
  /** What the human actually submitted. */
  humanLabel: LabelPayload;
  /** Independent human confirmations already recorded for this item. */
  priorHumanConfirmations: number;
  /** A reviewer override forces the "corrected" branch. */
  forcedCorrection?: boolean;
}

/** Label equality via canonical JSON, so key order never affects the result. */
export function sameAnswer(a: LabelPayload, b: LabelPayload): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** Deterministic JSON with sorted object keys. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * The central branch of the pipeline.
 *
 * `correct`   -> accepted, AI label kept as the final answer
 * `incorrect` -> needs_correct, human label supersedes the AI label
 *
 * Comparison uses modality-aware similarity rather than string equality so
 * that a small bounding-box nudge counts as agreement while a changed class
 * counts as disagreement.
 *
 * Gold promotion requires *independent* human confirmations (by default 2) so
 * that a single enthusiastic annotator cannot mint gold data.
 */
export function decideVerification(input: VerifyInput): VerificationOutcome {
  const {
    taskType,
    aiLabel,
    humanLabel,
    priorHumanConfirmations,
    forcedCorrection = false,
  } = input;

  if (aiLabel === null) {
    // No AI label to compare against: this is the first human judgement.
    return {
      kind: 'corrected',
      verdict: 'corrected',
      nextState: 'pending_review',
      promoteToGold: qualifiesForGold(priorHumanConfirmations + 1),
    };
  }

  const agrees = !forcedCorrection && labelSimilarity(taskType, aiLabel, humanLabel) >= 1;

  if (agrees) {
    const confirmations = priorHumanConfirmations + 1;
    return {
      kind: 'accepted',
      verdict: 'correct',
      nextState: 'accepted',
      promoteToGold: qualifiesForGold(confirmations),
    };
  }

  return {
    kind: 'corrected',
    verdict: 'corrected',
    nextState: 'needs_correct',
    promoteToGold: false,
  };
}

/**
 * Whether an item qualifies for the gold dataset.
 * Separated from `decideVerification` so promotion can also be driven by a
 * reviewer action or a QC pass rather than only by the normal flow.
 */
export function qualifiesForGold(independentConfirmations: number): boolean {
  return independentConfirmations >= PIPELINE_THRESHOLDS.goldAgreementRequired;
}

/** Terminal states: no further automated transition is expected. */
export function isTerminalState(state: TaskState): boolean {
  return ALLOWED_TRANSITIONS[state].length === 0;
}

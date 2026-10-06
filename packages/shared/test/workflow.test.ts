import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TRANSITIONS,
  PIPELINE_THRESHOLDS,
  canTransition,
  canonicalJson,
  decideAfterPrelabel,
  decideVerification,
  isTerminalState,
  qualifiesForGold,
  sameAnswer,
} from '../src/workflow.js';
import type { LabelPayload } from '../src/labels.js';
import { TASK_STATES } from '../src/task-types.js';

const cat = (label: string): LabelPayload =>
  ({ taskType: 'text_classification', label: { label } }) as LabelPayload;

const box = (label: string): LabelPayload =>
  ({
    taskType: 'image_bbox',
    label: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.2, label }],
  }) as LabelPayload;

describe('ALLOWED_TRANSITIONS / canTransition', () => {
  it('declares an entry for every task state', () => {
    for (const state of TASK_STATES) {
      expect(ALLOWED_TRANSITIONS[state]).toBeDefined();
    }
  });

  it('only lists valid destinations', () => {
    for (const from of TASK_STATES) {
      for (const to of ALLOWED_TRANSITIONS[from]) {
        expect(TASK_STATES).toContain(to);
      }
    }
  });

  it('accepts the normal forward path', () => {
    expect(canTransition('pending_prelabel', 'pending_review')).toBe(true);
    expect(canTransition('pending_review', 'accepted')).toBe(true);
    expect(canTransition('pending_review', 'needs_correct')).toBe(true);
  });

  it('rejects backward or unrelated jumps', () => {
    expect(canTransition('accepted', 'pending_prelabel')).toBe(false);
    expect(canTransition('pending_prelabel', 'accepted')).toBe(false);
    expect(canTransition('rejected', 'accepted')).toBe(false);
  });

  it('treats rejected as terminal', () => {
    expect(isTerminalState('rejected')).toBe(true);
    expect(canTransition('rejected', 'rejected')).toBe(false);
  });

  it('treats accepted as non-terminal so a quality failure can escalate it', () => {
    expect(isTerminalState('accepted')).toBe(false);
    expect(canTransition('accepted', 'escalated')).toBe(true);
  });

  it('routes pending_human to pending_review, accepted, or escalated', () => {
    expect(canTransition('pending_human', 'pending_review')).toBe(true);
    expect(canTransition('pending_human', 'accepted')).toBe(true);
    expect(canTransition('pending_human', 'escalated')).toBe(true);
    // but not back to prelabel or forward to needs_correct
    expect(canTransition('pending_human', 'pending_prelabel')).toBe(false);
    expect(canTransition('pending_human', 'needs_correct')).toBe(false);
  });

  it('pending_prelabel can route directly to pending_human for skipped pre-label', () => {
    expect(canTransition('pending_prelabel', 'pending_human')).toBe(true);
  });

  it('escalated items can be resolved to accepted or sent back to review', () => {
    expect(canTransition('escalated', 'accepted')).toBe(true);
    expect(canTransition('escalated', 'pending_review')).toBe(true);
    expect(canTransition('escalated', 'in_review')).toBe(true);
  });

  it('needs_correct can be re-submitted for review or accepted directly', () => {
    expect(canTransition('needs_correct', 'pending_review')).toBe(true);
    expect(canTransition('needs_correct', 'accepted')).toBe(true);
    expect(canTransition('needs_correct', 'escalated')).toBe(true);
    // cannot jump back to prelabel
    expect(canTransition('needs_correct', 'pending_prelabel')).toBe(false);
  });
});

describe('decideAfterPrelabel', () => {
  it('fast-tracks a confident prediction', () => {
    const decision = decideAfterPrelabel(0.97);
    expect(decision.nextState).toBe('pending_review');
    expect(decision.canFastAccept).toBe(true);
    expect(decision.requiresEscalation).toBe(false);
  });

  it('sends a low-confidence prediction to a reviewer', () => {
    const decision = decideAfterPrelabel(PIPELINE_THRESHOLDS.lowConfidenceEscalation - 0.01);
    expect(decision.nextState).toBe('escalated');
    expect(decision.requiresEscalation).toBe(true);
    expect(decision.canFastAccept).toBe(false);
  });

  it('does not fast-accept a middling prediction', () => {
    const decision = decideAfterPrelabel(0.7);
    expect(decision.nextState).toBe('pending_review');
    expect(decision.canFastAccept).toBe(false);
    expect(decision.requiresEscalation).toBe(false);
  });

  it('clamps out-of-range confidences instead of trusting them', () => {
    expect(decideAfterPrelabel(1.7).confidence).toBe(1);
    expect(decideAfterPrelabel(-0.4).confidence).toBe(0);
    expect(decideAfterPrelabel(-0.4).nextState).toBe('escalated');
  });
});

describe('decideVerification', () => {
  it('accepts when the human agrees with the AI', () => {
    const outcome = decideVerification({
      taskType: 'text_classification',
      aiLabel: cat('spam'),
      humanLabel: cat('spam'),
      priorHumanConfirmations: 0,
    });
    expect(outcome.kind).toBe('accepted');
    expect(outcome.verdict).toBe('correct');
    expect(outcome.nextState).toBe('accepted');
    expect(outcome.promoteToGold).toBe(false);
  });

  it('corrects when the human disagrees with the AI', () => {
    const outcome = decideVerification({
      taskType: 'text_classification',
      aiLabel: cat('spam'),
      humanLabel: cat('ham'),
      priorHumanConfirmations: 0,
    });
    expect(outcome.kind).toBe('corrected');
    expect(outcome.verdict).toBe('corrected');
    expect(outcome.nextState).toBe('needs_correct');
    expect(outcome.promoteToGold).toBe(false);
  });

  it('promotes to gold once enough independent confirmations exist', () => {
    const outcome = decideVerification({
      taskType: 'text_classification',
      aiLabel: cat('spam'),
      humanLabel: cat('spam'),
      priorHumanConfirmations: PIPELINE_THRESHOLDS.goldAgreementRequired - 1,
    });
    expect(outcome.promoteToGold).toBe(true);
    expect(qualifiesForGold(PIPELINE_THRESHOLDS.goldAgreementRequired)).toBe(true);
    expect(qualifiesForGold(PIPELINE_THRESHOLDS.goldAgreementRequired - 1)).toBe(false);
  });

  it('lets a forced correction override an agreeing AI label', () => {
    const outcome = decideVerification({
      taskType: 'text_classification',
      aiLabel: cat('spam'),
      humanLabel: cat('spam'),
      priorHumanConfirmations: 0,
      forcedCorrection: true,
    });
    expect(outcome.kind).toBe('corrected');
    expect(outcome.nextState).toBe('needs_correct');
  });

  it('routes the first human judgement to review rather than acceptance', () => {
    const outcome = decideVerification({
      taskType: 'text_classification',
      aiLabel: null,
      humanLabel: cat('spam'),
      priorHumanConfirmations: 0,
    });
    expect(outcome.kind).toBe('corrected');
    expect(outcome.nextState).toBe('pending_review');
    expect(outcome.promoteToGold).toBe(false);
  });

  it('ignores object key order when comparing labels', () => {
    expect(sameAnswer(cat('x'), cat('x'))).toBe(true);
    expect(sameAnswer(cat('x'), cat('y'))).toBe(false);
    expect(sameAnswer(cat('x'), { ...cat('x') } as LabelPayload)).toBe(true);
  });

  it('is insensitive to nested key order', () => {
    const a = { taskType: 'ner', label: [{ text: 'a', start: 0, end: 1, label: 'X' }] };
    const b = { taskType: 'ner', label: [{ label: 'X', text: 'a', end: 1, start: 0 }] };
    expect(sameAnswer(a as LabelPayload, b as LabelPayload)).toBe(true);
  });

  it('cannot promote to gold from a correction alone', () => {
    const outcome = decideVerification({
      taskType: 'text_classification',
      aiLabel: cat('a'),
      humanLabel: cat('b'),
      priorHumanConfirmations: 99,
    });
    expect(outcome.promoteToGold).toBe(false);
  });
});

describe('decideVerification with structured labels', () => {
  it('ignores bounding-box coordinate jitter as disagreement', () => {
    const aiLabel = box('car');
    const humanLabel = {
      taskType: 'image_bbox',
      label: [{ x: 0.105, y: 0.1, width: 0.2, height: 0.2, label: 'car' }],
    } as LabelPayload;

    const outcome = decideVerification({
      taskType: 'image_bbox',
      aiLabel,
      humanLabel,
      priorHumanConfirmations: 0,
    });
    expect(outcome.kind).toBe('accepted');
  });

  it('treats a changed box class as a correction', () => {
    const outcome = decideVerification({
      taskType: 'image_bbox',
      aiLabel: box('car'),
      humanLabel: box('truck'),
      priorHumanConfirmations: 0,
    });
    expect(outcome.kind).toBe('corrected');
  });

  it('treats an added or removed box as a correction', () => {
    const single = box('car');
    const extra = {
      taskType: 'image_bbox',
      label: [
        { x: 0.1, y: 0.1, width: 0.2, height: 0.2, label: 'car' },
        { x: 0.6, y: 0.6, width: 0.2, height: 0.2, label: 'car' },
      ],
    } as LabelPayload;

    expect(
      decideVerification({
        taskType: 'image_bbox',
        aiLabel: single,
        humanLabel: extra,
        priorHumanConfirmations: 0,
      }).kind,
    ).toBe('corrected');
  });

  it('ignores NER character-offset shifts that keep the same surface text', () => {
    const aiLabel = {
      taskType: 'ner',
      label: [{ text: 'Berlin', start: 0, end: 6, label: 'LOC' }],
    } as LabelPayload;
    const humanLabel = {
      taskType: 'ner',
      label: [{ text: 'Berlin', start: 4, end: 10, label: 'LOC' }],
    } as LabelPayload;

    expect(
      decideVerification({
        taskType: 'ner',
        aiLabel,
        humanLabel,
        priorHumanConfirmations: 0,
      }).kind,
    ).toBe('accepted');
  });

  it('flags a different entity type as a correction', () => {
    const aiLabel = {
      taskType: 'ner',
      label: [{ text: 'Berlin', start: 0, end: 6, label: 'LOC' }],
    } as LabelPayload;
    const humanLabel = {
      taskType: 'ner',
      label: [{ text: 'Berlin', start: 0, end: 6, label: 'ORG' }],
    } as LabelPayload;

    expect(
      decideVerification({
        taskType: 'ner',
        aiLabel,
        humanLabel,
        priorHumanConfirmations: 0,
      }).kind,
    ).toBe('corrected');
  });

  it('flags a transcript wording change as a correction', () => {
    const aiLabel = {
      taskType: 'audio_transcription',
      label: [{ startMs: 0, endMs: 1000, text: 'the cat sat' }],
    } as LabelPayload;
    const humanLabel = {
      taskType: 'audio_transcription',
      label: [{ startMs: 0, endMs: 1000, text: 'a dog ran home' }],
    } as LabelPayload;

    expect(
      decideVerification({
        taskType: 'audio_transcription',
        aiLabel,
        humanLabel,
        priorHumanConfirmations: 0,
      }).kind,
    ).toBe('corrected');
  });
});

describe('canonicalJson', () => {
  it('sorts object keys deterministically', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
  });

  it('preserves array order', () => {
    expect(canonicalJson([1, 2, 3])).toBe('[1,2,3]');
    expect(canonicalJson([3, 2, 1])).not.toBe(canonicalJson([1, 2, 3]));
  });

  it('drops undefined object entries', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('handles primitives and null', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson('s')).toBe('"s"');
    expect(canonicalJson(5)).toBe('5');
    expect(canonicalJson(true)).toBe('true');
  });

  it('recurses into nested structures', () => {
    expect(canonicalJson({ a: { d: 1, c: [2, { f: 1, e: 2 }] } })).toBe(
      '{"a":{"c":[2,{"e":2,"f":1}],"d":1}}',
    );
  });
});

describe('PIPELINE_THRESHOLDS boundary conditions', () => {
  it('treats exactly lowConfidenceEscalation as escalation (strictly less than required)', () => {
    // The threshold check is `< lowConfidenceEscalation`, so exactly at the
    // boundary should NOT escalate — it's the inclusive lower edge of the normal path.
    const at = decideAfterPrelabel(PIPELINE_THRESHOLDS.lowConfidenceEscalation);
    expect(at.nextState).toBe('pending_review');
    expect(at.requiresEscalation).toBe(false);
  });

  it('treats exactly highConfidenceAutoAccept as fast-accept eligible', () => {
    const at = decideAfterPrelabel(PIPELINE_THRESHOLDS.highConfidenceAutoAccept);
    expect(at.canFastAccept).toBe(true);
  });

  it('goldAgreementRequired is a positive integer', () => {
    expect(Number.isInteger(PIPELINE_THRESHOLDS.goldAgreementRequired)).toBe(true);
    expect(PIPELINE_THRESHOLDS.goldAgreementRequired).toBeGreaterThan(0);
  });

  it('qcRandomFraction is in (0, 1)', () => {
    expect(PIPELINE_THRESHOLDS.qcRandomFraction).toBeGreaterThan(0);
    expect(PIPELINE_THRESHOLDS.qcRandomFraction).toBeLessThan(1);
  });

  it('goldCheckInjectionRate is in (0, 1)', () => {
    expect(PIPELINE_THRESHOLDS.goldCheckInjectionRate).toBeGreaterThan(0);
    expect(PIPELINE_THRESHOLDS.goldCheckInjectionRate).toBeLessThan(1);
  });
});

describe('qualifiesForGold edge cases', () => {
  it('never promotes with zero confirmations', () => {
    expect(qualifiesForGold(0)).toBe(false);
  });

  it('promotes at exactly the required count', () => {
    expect(qualifiesForGold(PIPELINE_THRESHOLDS.goldAgreementRequired)).toBe(true);
  });

  it('also promotes above the required count', () => {
    expect(qualifiesForGold(PIPELINE_THRESHOLDS.goldAgreementRequired + 10)).toBe(true);
  });
});

describe('null AI label path in decideVerification', () => {
  it('can promote to gold via null-label path when prior confirmations are sufficient', () => {
    const outcome = decideVerification({
      taskType: 'text_classification',
      aiLabel: null,
      humanLabel: { taskType: 'text_classification', label: { label: 'positive' } },
      priorHumanConfirmations: PIPELINE_THRESHOLDS.goldAgreementRequired - 1,
    });
    // null-label branch adds 1 confirmation, so it should qualify
    expect(outcome.promoteToGold).toBe(true);
    expect(outcome.nextState).toBe('pending_review');
  });
});

/**
 * Deterministic heuristic pre-labeling.
 *
 * This provider exists so the whole pipeline (pre-label → human verification
 * → gold promotion) runs offline, reproducibly, and in tests. It is
 * deliberately honest about its limits:
 *
 *   1. An `importedPrediction` shipped with the item (e.g. exported from an
 *      offline model batch) is used verbatim — this is the common "score a
 *      labelled file" path and carries its own confidence.
 *   2. Otherwise simple rules apply: sentiment lexicon, category-keyword
 *      matching, and NER regexes. Their confidence reflects rule strength.
 *   3. When no rule fires (or for vision/audio where no model is available)
 *      the provider returns a low-confidence/empty proposal so the workflow
 *      escalates to a human instead of pretending to be sure.
 */

import { parseLabelForTaskType } from '@haap/shared';
import type { PrelabelInput, PrelabelProvider, PrelabelResult } from './types.js';
import { ProviderError, contentText, stableHash } from './types.js';

const POSITIVE_WORDS = [
  'good', 'great', 'excellent', 'amazing', 'love', 'loved', 'perfect', 'best',
  'wonderful', 'fantastic', 'happy', 'pleased', 'recommend', 'awesome', 'superb',
  'delighted', 'impressive', 'outstanding', 'brilliant', 'enjoyed', 'smooth',
];

const NEGATIVE_WORDS = [
  'bad', 'terrible', 'awful', 'hate', 'hated', 'worst', 'poor', 'broken',
  'disappointing', 'disappointed', 'slow', 'useless', 'horrible', 'waste',
  'failed', 'failure', 'buggy', 'noisy', 'rude', 'never', 'unusable',
];

const ORG_SUFFIX =
  /\b([A-Z][\w&]*(?:\s+[A-Z][\w&]*)*\s+(?:Inc|LLC|Ltd|Corp|GmbH|PLC|SA|AG|Co))\b/g;
const PERSON_NAME = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g;
const DATE =
  /\b(?:\d{4}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})\b/g;
const MONEY = /\$\s?\d[\d,]*(?:\.\d{2})?|\b\d+\s?(?:USD|EUR|GBP)\b/g;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function pickFromCategories(
  categories: string[] | undefined,
  text: string,
): { label: string; confidence: number } | null {
  if (!categories || categories.length === 0) return null;
  const lower = text.toLowerCase();
  let best: { category: string; score: number } | null = null;
  for (const category of categories) {
    const tokens = category.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
    if (tokens.length === 0) continue;
    let score = 0;
    for (const token of tokens) {
      const pattern = new RegExp(`\\b${token}\\b`, 'g');
      score += (lower.match(pattern) ?? []).length;
    }
    if (score > 0 && (best === null || score > best.score)) {
      best = { category, score };
    }
  }
  if (best === null) return null;
  return {
    label: best.category,
    confidence: clamp01(0.6 + 0.3 * (best.score / (best.score + 3))),
  };
}

function hashPick(categories: string[], seed: string): { label: string; confidence: number } {
  const index = stableHash(seed) % categories.length;
  // A blind pick is barely better than chance: keep confidence below the
  // escalation threshold so a human always reviews it.
  return { label: categories[index] ?? categories[0] ?? '', confidence: 0.45 };
}

function predictCategorical(
  input: PrelabelInput,
  text: string,
  categories: string[] | undefined,
): PrelabelResult | null {
  if (input.taskType === 'sentiment') {
    const lower = ` ${text.toLowerCase()} `;
    const positives = POSITIVE_WORDS.filter((w) => lower.includes(` ${w} `)).length;
    const negatives = NEGATIVE_WORDS.filter((w) => lower.includes(` ${w} `)).length;
    const total = positives + negatives;
    if (total === 0) {
      return categories && categories.length > 0
        ? hashPick(categories, text)
        : { label: { label: 'neutral' }, confidence: 0.45 };
    }
    const direction =
      positives === negatives ? 'neutral' : positives > negatives ? 'positive' : 'negative';
    const wanted =
      direction === 'positive' ? /^pos/i : direction === 'negative' ? /^neg/i : /^(neu|mixed|amb)/i;
    const chosen =
      categories?.find((c) => wanted.test(c)) ?? (direction === 'neutral' ? 'neutral' : direction);
    const confidence = clamp01(0.55 + 0.4 * (Math.abs(positives - negatives) / (total + 1)));
    return { label: { label: chosen }, confidence };
  }

  const matched = pickFromCategories(categories, text);
  if (matched) return { label: { label: matched.label }, confidence: matched.confidence };
  if (categories && categories.length > 0) {
    const picked = hashPick(categories, text);
    return { label: { label: picked.label }, confidence: picked.confidence };
  }
  return null;
}

interface RawEntity {
  text: string;
  start: number;
  end: number;
  label: string;
}

function predictEntities(input: PrelabelInput): PrelabelResult {
  const text = contentText(input.content);
  const allowed = input.labelSchema.entityTypes;
  const found: Array<RawEntity & { confidence: number }> = [];

  const collect = (pattern: RegExp, label: string, confidence: number): void => {
    for (const match of text.matchAll(pattern)) {
      const raw = match[1] ?? match[0];
      const start = match.index ?? 0;
      const candidate = { text: raw, start, end: start + raw.length, label, confidence };
      const overlapping = found.find((e) => e.start < candidate.end && candidate.start < e.end);
      if (overlapping) {
        if (candidate.end - candidate.start <= overlapping.end - overlapping.start) continue;
        found.splice(found.indexOf(overlapping), 1);
      }
      found.push(candidate);
    }
  };

  collect(ORG_SUFFIX, 'ORG', 0.72);
  collect(PERSON_NAME, 'PERSON', 0.68);
  collect(DATE, 'DATE', 0.8);
  collect(MONEY, 'MONEY', 0.85);

  const entities = found
    .filter((e) => !allowed || allowed.length === 0 || allowed.includes(e.label))
    .sort((a, b) => a.start - b.start)
    .map(({ confidence: _confidence, ...entity }) => entity);

  return { label: entities, confidence: entities.length > 0 ? 0.7 : 0.45 };
}

export class HeuristicProvider implements PrelabelProvider {
  readonly name = 'heuristic';

  async predict(input: PrelabelInput): Promise<PrelabelResult> {
    // 1. A prediction imported with the item always wins.
    const record = (input.content ?? null) as Record<string, unknown> | null;
    const imported =
      record !== null && typeof record === 'object' ? record['importedPrediction'] : undefined;
    if (imported !== undefined) {
      try {
        const envelope = parseLabelForTaskType(input.taskType, imported);
        const rawConfidence = record?.['importedConfidence'];
        const confidence =
          typeof rawConfidence === 'number' ? clamp01(rawConfidence) : 0.85;
        return { label: (envelope as { label: unknown }).label, confidence };
      } catch {
        // Fall through to rules when the imported payload does not fit.
      }
    }

    const text = contentText(input.content);
    const { categories, entityTypes: _entityTypes } = input.labelSchema;

    switch (input.taskType) {
      case 'text_classification':
      case 'sentiment':
      case 'audio_translation':
      case 'document_annotation': {
        const result = predictCategorical(input, text, categories);
        if (result) return result;
        throw new ProviderError(
          `no heuristic available for ${input.taskType} without categories`,
        );
      }
      case 'ner':
        return predictEntities(input);
      case 'image_bbox':
      case 'image_segmentation':
      case 'audio_transcription':
        // No vision/audio model runs here by design: propose nothing with low
        // confidence so the workflow routes the item to a human immediately.
        return { label: [], confidence: 0.45 };
      default: {
        const exhaustive: never = input.taskType;
        return exhaustive;
      }
    }
  }
}

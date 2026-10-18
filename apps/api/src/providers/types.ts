/**
 * AI pre-labeling provider contract.
 *
 * Providers turn raw item content into a proposed label plus a confidence in
 * [0,1]. The pipeline (not the provider) decides what happens next: high
 * confidence enables one-click acceptance, low confidence escalates.
 */

import type { TaskType } from '../shared.js';

export interface LabelSchemaDefinition {
  categories?: string[] | undefined;
  entityTypes?: string[] | undefined;
  regionLabels?: string[] | undefined;
  targetLanguage?: string | undefined;
}

export interface PrelabelInput {
  itemId: string;
  taskType: TaskType;
  /** Raw `items.content` JSON. */
  content: unknown;
  labelSchema: LabelSchemaDefinition;
}

export interface PrelabelResult {
  /** Label *value* for the modality; wrapped as `{ taskType, label }` by the caller. */
  label: unknown;
  /** Model confidence in [0,1]. */
  confidence: number;
  /** Optional per-class probabilities used by the active-learning uncertainty signal. */
  distribution?: Record<string, number>;
}

export interface PrelabelProvider {
  readonly name: string;
  predict(input: PrelabelInput): Promise<PrelabelResult>;
}

export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** Extract the text a heuristic can reason about from any content shape. */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content !== null && typeof content === 'object') {
    const record = content as Record<string, unknown>;
    for (const key of ['text', 'documentText', 'transcript', 'translation', 'caption']) {
      const value = record[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
    return JSON.stringify(content);
  }
  return String(content ?? '');
}

/** Deterministic 32-bit string hash (djb2) used for stable fallback picks. */
export function stableHash(value: string): number {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

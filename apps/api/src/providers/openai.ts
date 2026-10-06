/**
 * OpenAI-compatible chat-completions provider.
 *
 * Used when `AI_PROVIDER=openai`. The model is asked for a strict JSON
 * envelope `{ "label": <modality label value>, "confidence": number }` which
 * is validated with the same `parseLabelForTaskType` contract the human path
 * uses — a malformed model answer becomes a `ProviderError`, never a stored
 * label. `fetch` is injectable so tests never touch the network.
 */

import { parseLabelForTaskType } from '@haap/shared';
import type { PrelabelInput, PrelabelProvider, PrelabelResult } from './types.js';
import { ProviderError } from './types.js';

export interface OpenAiProviderOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  fetchImpl?: typeof fetch;
}

function buildPrompt(input: PrelabelInput): string {
  const content = JSON.stringify(input.content ?? null);
  const schema: string[] = [];
  if (input.labelSchema.categories?.length) {
    schema.push(`Allowed categories: ${input.labelSchema.categories.join(', ')}`);
  }
  if (input.labelSchema.entityTypes?.length) {
    schema.push(
      `Allowed entity types: ${input.labelSchema.entityTypes.join(', ')}`,
    );
  }
  if (input.labelSchema.regionLabels?.length) {
    schema.push(`Allowed region labels: ${input.labelSchema.regionLabels.join(', ')}`);
  }
  if (input.labelSchema.targetLanguage) {
    schema.push(`Target language: ${input.labelSchema.targetLanguage}`);
  }

  return [
    `Task type: ${input.taskType}`,
    ...schema,
    `Item content: ${content}`,
    '',
    'Respond with JSON only:',
    '{"label": <label value for this task type>, "confidence": <number between 0 and 1>}',
    'Label value shapes: categorical => {"label": "..."}; bbox => [{"x":0,"y":0,"width":0,"height":0,"label":"..."}];',
    'segmentation => [{"points":[[x,y],...],"label":"..."}]; ner => [{"text":"...","start":0,"end":3,"label":"..."}];',
    'transcription => [{"startMs":0,"endMs":1000,"text":"..."}].',
  ].join('\n');
}

export class OpenAiProvider implements PrelabelProvider {
  readonly name = 'openai';
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAiProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async predict(input: PrelabelInput): Promise<PrelabelResult> {
    const response = await this.fetchImpl(`${this.options.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.options.apiKey}`,
      },
      body: JSON.stringify({
        model: this.options.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You are a data-annotation pre-labeling engine. Reply with strict JSON only.',
          },
          { role: 'user', content: buildPrompt(input) },
        ],
      }),
    });

    if (!response.ok) {
      throw new ProviderError(
        `openai provider returned HTTP ${response.status}: ${await response.text()}`,
      );
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new ProviderError('openai provider returned no content');

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new ProviderError('openai provider returned non-JSON content');
    }

    const record = parsed as Record<string, unknown>;
    const confidence = typeof record['confidence'] === 'number' ? record['confidence'] : 0.7;
    // Wrap the model's `label` value as a bare envelope for the shared parser.
    const envelope = parseLabelForTaskType(input.taskType, { label: record['label'] });

    return {
      label: (envelope as { label: unknown }).label,
      confidence: Math.min(1, Math.max(0, confidence)),
    };
  }
}

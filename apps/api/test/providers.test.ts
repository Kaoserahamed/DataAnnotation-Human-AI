/** Provider behavior: deterministic heuristics and the OpenAI adapter. */

import { describe, expect, it } from 'vitest';
import { HeuristicProvider } from '../src/providers/heuristic.js';
import { OpenAiProvider } from '../src/providers/openai.js';
import { ProviderError, contentText, stableHash } from '../src/providers/types.js';
import { createProvider } from '../src/providers/registry.js';
import { loadConfig } from '../src/config.js';

const provider = new HeuristicProvider();

function input(taskType: string, content: unknown, labelSchema: Record<string, unknown> = {}) {
  return { itemId: 'item-1', taskType, content, labelSchema } as any;
}

describe('heuristic provider', () => {
  it('prefers an imported prediction with its confidence', async () => {
    const result = await provider.predict(
      input('sentiment', {
        text: 'whatever',
        importedPrediction: { taskType: 'sentiment', label: { label: 'negative' } },
        importedConfidence: 0.77,
      }),
    );
    expect(result.label).toEqual({ label: 'negative' });
    expect(result.confidence).toBeCloseTo(0.77, 5);
  });

  it('falls through when an imported prediction does not match the modality', async () => {
    const result = await provider.predict(
      input(
        'sentiment',
        {
          text: 'I love this product',
          importedPrediction: { taskType: 'sentiment', label: [{ nonsense: true }] },
        },
        { categories: ['positive', 'negative'] },
      ),
    );
    expect((result.label as { label: string }).label).toBe('positive');
  });

  it('scores sentiment from the lexicon', async () => {
    const positive = await provider.predict(
      input('sentiment', { text: 'great amazing wonderful love best' }),
    );
    expect((positive.label as { label: string }).label).toBe('positive');
    expect(positive.confidence).toBeGreaterThan(0.55);

    const negative = await provider.predict(
      input('sentiment', { text: 'terrible awful worst hate broken' }),
    );
    expect((negative.label as { label: string }).label).toBe('negative');

    const neutral = await provider.predict(
      input('sentiment', { text: 'it exists' }, { categories: ['positive', 'neutral'] }),
    );
    expect(neutral.confidence).toBeLessThan(0.55);
  });

  it('matches categories by keyword for classification', async () => {
    const result = await provider.predict(
      input(
        'text_classification',
        { text: 'the kitchen tap is leaking water' },
        { categories: ['kitchen', 'electronics'] },
      ),
    );
    expect((result.label as { label: string }).label).toBe('kitchen');
    expect(result.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it('extracts entities with deterministic regex rules', async () => {
    const result = await provider.predict(
      input('ner', {
        text: 'Jane Smith met Acme Corp on 2024-01-05 and paid $1,200 to Jane Smith.',
      }),
    );
    const labels = (result.label as Array<{ label: string }>).map((e) => e.label);
    expect(labels).toContain('PERSON');
    expect(labels).toContain('ORG');
    expect(labels).toContain('DATE');
    expect(labels).toContain('MONEY');
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('proposes nothing for vision/audio with low confidence', async () => {
    const bbox = await provider.predict(input('image_bbox', { imageUrl: 'x' }));
    expect(bbox.label).toEqual([]);
    expect(bbox.confidence).toBeLessThan(0.5);

    const audio = await provider.predict(input('audio_transcription', { audioUrl: 'y' }));
    expect(audio.label).toEqual([]);
    expect(audio.confidence).toBeLessThan(0.5);
  });

  it('reports an honest failure for categorical tasks without categories', async () => {
    await expect(provider.predict(input('text_classification', { text: 'hello' }))).rejects.toThrow(
      ProviderError,
    );
  });

  it('exposes deterministic helpers', () => {
    expect(stableHash('abc')).toBe(stableHash('abc'));
    expect(stableHash('abc')).not.toBe(stableHash('abd'));
    expect(contentText({ text: 'hi' })).toBe('hi');
    expect(contentText('raw')).toBe('raw');
    expect(contentText(null)).toBe('');
  });
});

describe('openai provider', () => {
  it('parses a valid model response', async () => {
    const fetchImpl = (async (_url: unknown, init?: { body?: string }) => {
      expect(String(init?.body)).toContain('sentiment');
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"label":{"label":"positive"},"confidence":0.9}' } }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const openai = new OpenAiProvider({
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com/v1',
      model: 'test-model',
      fetchImpl,
    });
    const result = await openai.predict(input('sentiment', { text: 'great' }));
    expect(result.label).toEqual({ label: 'positive' });
    expect(result.confidence).toBeCloseTo(0.9, 5);
  });

  it('rejects malformed model output', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'not json' } }] }), {
        status: 200,
      })) as unknown as typeof fetch;

    const openai = new OpenAiProvider({
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com/v1',
      model: 'test-model',
      fetchImpl,
    });
    await expect(openai.predict(input('sentiment', { text: 'x' }))).rejects.toThrow(ProviderError);
  });

  it('surfaces HTTP failures as provider errors', async () => {
    const fetchImpl = (async () =>
      new Response('quota exceeded', { status: 429 })) as unknown as typeof fetch;
    const openai = new OpenAiProvider({
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com/v1',
      model: 'test-model',
      fetchImpl,
    });
    await expect(openai.predict(input('sentiment', { text: 'x' }))).rejects.toThrow(/HTTP 429/);
  });

  it('validates label payloads from the model', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"label":42}' } }] }), {
        status: 200,
      })) as unknown as typeof fetch;
    const openai = new OpenAiProvider({
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com/v1',
      model: 'test-model',
      fetchImpl,
    });
    await expect(openai.predict(input('sentiment', { text: 'x' }))).rejects.toThrow();
  });
});

describe('provider registry', () => {
  it('selects providers from configuration', () => {
    expect(createProvider(loadConfig({})).name).toBe('heuristic');
    expect(
      createProvider(loadConfig({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test' })).name,
    ).toBe('openai');
    expect(() =>
      createProvider(loadConfig({ AI_PROVIDER: 'openai' } as never)),
    ).toThrow();
  });
});

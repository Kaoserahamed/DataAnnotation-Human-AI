/** Provider registry: exactly one AI provider is active per process. */

import type { AppConfig } from '../config.js';
import { HeuristicProvider } from './heuristic.js';
import { OpenAiProvider } from './openai.js';
import type { PrelabelProvider } from './types.js';

export function createProvider(config: AppConfig): PrelabelProvider {
  if (config.AI_PROVIDER === 'openai') {
    if (!config.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is required when AI_PROVIDER=openai');
    }
    return new OpenAiProvider({
      apiKey: config.OPENAI_API_KEY,
      baseUrl: config.OPENAI_BASE_URL,
      model: config.OPENAI_MODEL,
    });
  }
  return new HeuristicProvider();
}

export type { PrelabelProvider, PrelabelInput, PrelabelResult } from './types.js';
export { ProviderError } from './types.js';

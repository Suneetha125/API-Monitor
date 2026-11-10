import OpenAI from 'openai';
import { LlmRequestError, MissingApiKeyError } from './openai-provider.js';

export const GEMINI_OPENAI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';
const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

export function createGeminiProvider({
  apiKey = process.env.GEMINI_API_KEY,
  model = process.env.GEMINI_MODEL,
  OpenAIClient = OpenAI
} = {}) {
  let client;
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  const configured = key.length > 0;
  const selectedModel = typeof model === 'string' && model.trim()
    ? model.trim()
    : DEFAULT_GEMINI_MODEL;

  return {
    get isConfigured() {
      return configured;
    },
    async complete({ messages, tools }) {
      if (!configured) throw new MissingApiKeyError();

      try {
        client ??= new OpenAIClient({
          apiKey: key,
          baseURL: GEMINI_OPENAI_BASE_URL
        });
        const response = await client.chat.completions.create({
          model: selectedModel,
          messages,
          tools,
          tool_choice: 'auto'
        });
        const message = response?.choices?.[0]?.message;
        if (!message || typeof message !== 'object') throw new Error('Malformed completion.');
        return message;
      } catch {
        throw new LlmRequestError();
      }
    }
  };
}

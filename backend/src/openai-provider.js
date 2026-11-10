import OpenAI from 'openai';

export class MissingApiKeyError extends Error {
  constructor() {
    super('The investigation service is not configured.');
    this.name = 'MissingApiKeyError';
  }
}

export class LlmRequestError extends Error {
  constructor() {
    super('The language model request failed.');
    this.name = 'LlmRequestError';
  }
}

export function createOpenAIProvider({
  apiKey = process.env.OPENAI_API_KEY,
  model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
  OpenAIClient = OpenAI
} = {}) {
  let client;
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  const configured = key.length > 0;

  return {
    get isConfigured() {
      return configured;
    },
    async complete({ messages, tools }) {
      if (!configured) throw new MissingApiKeyError();
      if (typeof model !== 'string' || !model.trim()) {
        throw new TypeError('OPENAI_MODEL must be a non-empty string.');
      }

      try {
        client ??= new OpenAIClient({ apiKey: key });
        const response = await client.chat.completions.create({
          model,
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

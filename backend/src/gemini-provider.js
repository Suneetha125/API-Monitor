import OpenAI from 'openai';
import { LlmRequestError, MissingApiKeyError } from './openai-provider.js';

export const GEMINI_OPENAI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';
const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

function collectMessageText(value, text = []) {
  if (typeof value === 'string') {
    text.push(value);
  } else if (Array.isArray(value)) {
    value.forEach((item) => collectMessageText(item, text));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => collectMessageText(item, text));
  }
  return text;
}

function collectSensitiveValues(apiKey, messages) {
  const messageValues = Array.isArray(messages)
    ? messages.filter((message) => message?.role !== 'system')
      .flatMap((message) => collectMessageText(message))
    : [];
  const values = [apiKey, ...messageValues]
    .filter((text) => typeof text === 'string' && text.length > 0);
  for (const text of messageValues) {
    values.push(...(text.match(/[\p{L}\p{N}_@.+-]{4,}/gu) ?? []));
  }
  return [...new Set(values)].sort((left, right) => right.length - left.length);
}

function safeDiagnosticIdentifier(value, sensitiveValues) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(value) ||
      sensitiveValues.some((sensitiveValue) => value.includes(sensitiveValue))) {
    return undefined;
  }
  return value;
}

function sanitizeErrorMessage(value, sensitiveValues) {
  if (typeof value !== 'string') return 'Upstream request failed.';

  let message = value;
  for (const sensitiveValue of sensitiveValues) {
    message = message.split(sensitiveValue).join('[REDACTED]');
  }

  return message
    .replace(/\b(authorization|x-goog-api-key|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret)\b\s*[:=]\s*(?:(?:bearer|basic)\s+)?(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[REDACTED]')
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/-]+=*/gi, '[REDACTED_AUTH]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[REDACTED_URL]')
    .replace(/(?:\{[\s\S]*\}|\[[\s\S]*\])/g, '[UPSTREAM_RESPONSE_OMITTED]')
    .slice(0, 500);
}

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
      } catch (error) {
        const status = Number(error?.status ?? error?.statusCode);
        const sensitiveValues = collectSensitiveValues(key, messages);
        const diagnostic = {
          status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined,
          code: safeDiagnosticIdentifier(error?.code, sensitiveValues),
          type: safeDiagnosticIdentifier(error?.type ?? error?.name, sensitiveValues),
          message: sanitizeErrorMessage(error?.message, sensitiveValues)
        };
        console.error('Gemini upstream request failed.', diagnostic);
        throw new LlmRequestError();
      }
    }
  };
}

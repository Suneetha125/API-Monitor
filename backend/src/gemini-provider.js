import OpenAI from 'openai';
import { LlmRequestError, MissingApiKeyError } from './openai-provider.js';

export const GEMINI_OPENAI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';
const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

const SAFE_ERROR_CODES = new Set([
  'ABORTED',
  'ALREADY_EXISTS',
  'CANCELLED',
  'DATA_LOSS',
  'DEADLINE_EXCEEDED',
  'FAILED_PRECONDITION',
  'INTERNAL',
  'INVALID_ARGUMENT',
  'NOT_FOUND',
  'OUT_OF_RANGE',
  'PERMISSION_DENIED',
  'RESOURCE_EXHAUSTED',
  'UNAUTHENTICATED',
  'UNAVAILABLE',
  'UNKNOWN',
  'insufficient_quota',
  'invalid_api_key',
  'model_not_found',
  'rate_limit_exceeded'
]);

const SAFE_FIELD_PATH_PATTERN = /^tools\[\d{1,3}\]\.function\.(?:name|description|parameters(?:\.(?:type|properties|required|additionalProperties)(?:\.(?:endpointId|from|to|limit|key)(?:\.(?:type|minimum|maximum|pattern|enum))?)?)?)(?![\s\S])/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseErrorPayload(value) {
  if (isRecord(value)) return value;
  if (typeof value !== 'string') return undefined;

  const jsonStart = value.indexOf('{');
  const jsonEnd = value.lastIndexOf('}');
  if (jsonStart < 0 || jsonEnd <= jsonStart) return undefined;

  try {
    const parsed = JSON.parse(value.slice(jsonStart, jsonEnd + 1));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function getErrorDetails(error) {
  const parsedMessage = parseErrorPayload(error?.message);
  const responseBody = parseErrorPayload(error?.error) ?? parsedMessage;
  const body = isRecord(responseBody?.error) ? responseBody.error : responseBody;
  return body;
}

function extractFieldPaths(body) {
  const details = Array.isArray(body?.details) ? body.details : [];
  const violations = [
    ...(Array.isArray(body?.fieldViolations) ? body.fieldViolations : []),
    ...(Array.isArray(body?.field_violations) ? body.field_violations : []),
    ...details.flatMap((detail) => (
      isRecord(detail)
        ? [
          ...(Array.isArray(detail.fieldViolations) ? detail.fieldViolations : []),
          ...(Array.isArray(detail.field_violations) ? detail.field_violations : [])
        ]
        : []
    ))
  ];

  return violations
    .filter((violation) => isRecord(violation))
    .slice(0, 10)
    .map((violation) => violation.field)
    .filter((field) => typeof field === 'string' && SAFE_FIELD_PATH_PATTERN.test(field));
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
        const body = getErrorDetails(error);
        const code = [error?.code, body?.status]
          .find((candidate) => typeof candidate === 'string' && SAFE_ERROR_CODES.has(candidate));
        const fieldPaths = extractFieldPaths(body);
        const diagnostic = {
          status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined,
          ...(code ? { code } : {}),
          type: 'upstream_error',
          ...(fieldPaths.length ? { fieldPaths: [...new Set(fieldPaths)] } : {})
        };
        console.error('Gemini upstream request failed.', diagnostic);
        throw new LlmRequestError();
      }
    }
  };
}

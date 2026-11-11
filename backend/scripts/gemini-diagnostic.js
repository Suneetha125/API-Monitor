import OpenAI from 'openai';
import { fileURLToPath } from 'node:url';
import { createAgentTools } from '../src/agent-tools.js';
import { GEMINI_OPENAI_BASE_URL } from '../src/gemini-provider.js';

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
const GENERIC_TEST_MESSAGES = {
  textOnly: [{ role: 'user', content: 'Reply with a short generic readiness confirmation.' }],
  withOneTool: [{ role: 'user', content: 'Use the available read-only function to check generic service health.' }],
  withProductionTools: [{ role: 'user', content: 'Use an available read-only function to summarize generic service health.' }]
};

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function responseErrorBody(payload) {
  if (!isRecord(payload)) return undefined;
  return isRecord(payload.error) ? payload.error : payload;
}

function extractSafeErrorMetadata(payload) {
  const body = responseErrorBody(payload);
  if (!body) return { code: undefined, fieldPaths: [] };

  const code = [body.code, body.status]
    .find((candidate) => typeof candidate === 'string' && SAFE_ERROR_CODES.has(candidate));
  const details = Array.isArray(body.details) ? body.details.slice(0, 10) : [];
  const violations = [
    ...(Array.isArray(body.fieldViolations) ? body.fieldViolations.slice(0, 10) : []),
    ...(Array.isArray(body.field_violations) ? body.field_violations.slice(0, 10) : []),
    ...details.flatMap((detail) => (
      isRecord(detail)
        ? [
          ...(Array.isArray(detail.fieldViolations) ? detail.fieldViolations.slice(0, 10) : []),
          ...(Array.isArray(detail.field_violations) ? detail.field_violations.slice(0, 10) : [])
        ]
        : []
    ))
  ].slice(0, 20);
  const fieldPaths = [...new Set(violations
    .filter(isRecord)
    .map((violation) => violation.field)
    .filter((field) => typeof field === 'string' && SAFE_FIELD_PATH_PATTERN.test(field)))];

  return { code, fieldPaths };
}

function validateConfiguration(env) {
  if (env.LLM_PROVIDER?.trim().toLowerCase() !== 'gemini' ||
      typeof env.GEMINI_API_KEY !== 'string' ||
      !env.GEMINI_API_KEY.trim()) {
    throw new Error('Set LLM_PROVIDER=gemini and GEMINI_API_KEY; GEMINI_MODEL is optional.');
  }
}

function createProductionReadOnlyTools() {
  const toolRegistry = createAgentTools({
    db: { get() {}, all() {} },
    serverPort: 3001
  });
  return toolRegistry.definitions
    .filter((definition) => definition.readOnly)
    .map((definition) => ({
      type: 'function',
      function: {
        name: definition.name,
        description: definition.description,
        parameters: definition.inputSchema
      }
    }));
}

function buildTests() {
  const minimalTool = [{
    type: 'function',
    function: {
      name: 'get_service_health',
      description: 'Read service liveness.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    }
  }];
  return [
    { name: 'text-only', messages: GENERIC_TEST_MESSAGES.textOnly },
    { name: 'one-read-only-tool', messages: GENERIC_TEST_MESSAGES.withOneTool, tools: minimalTool },
    {
      name: 'all-production-read-only-tools',
      messages: GENERIC_TEST_MESSAGES.withProductionTools,
      tools: createProductionReadOnlyTools()
    }
  ];
}

async function runOneTest({ test, apiKey, model, OpenAIClient, fetchImpl }) {
  let responseStatus = null;
  let safeErrorMetadata = { code: undefined, fieldPaths: [] };
  const observeResponse = async (...args) => {
    const response = await fetchImpl(...args);
    responseStatus = response.status;
    if (!response.ok) {
      try {
        safeErrorMetadata = extractSafeErrorMetadata(await response.clone().json());
      } catch {
        safeErrorMetadata = { code: undefined, fieldPaths: [] };
      }
    }
    return response;
  };

  let httpSuccess = false;
  try {
    const client = new OpenAIClient({
      apiKey,
      baseURL: GEMINI_OPENAI_BASE_URL,
      fetch: observeResponse
    });
    const request = {
      model,
      messages: test.messages,
      ...(test.tools ? { tools: test.tools, tool_choice: 'auto' } : {})
    };
    await client.chat.completions.create(request);
    httpSuccess = responseStatus !== null && responseStatus >= 200 && responseStatus < 300;
  } catch {
    httpSuccess = false;
  }

  return {
    test: test.name,
    result: httpSuccess ? 'success' : 'failure',
    httpStatus: responseStatus,
    ...(safeErrorMetadata.code ? { errorCode: safeErrorMetadata.code } : {}),
    ...(safeErrorMetadata.fieldPaths.length ? { fieldPaths: safeErrorMetadata.fieldPaths } : {})
  };
}

export async function runGeminiDiagnostics({
  env = process.env,
  OpenAIClient = OpenAI,
  fetchImpl = globalThis.fetch
} = {}) {
  validateConfiguration(env);
  const apiKey = env.GEMINI_API_KEY.trim();
  const model = typeof env.GEMINI_MODEL === 'string' && env.GEMINI_MODEL.trim()
    ? env.GEMINI_MODEL.trim()
    : DEFAULT_GEMINI_MODEL;
  const tests = buildTests();
  const results = [];

  for (const test of tests) {
    results.push(await runOneTest({ test, apiKey, model, OpenAIClient, fetchImpl }));
  }

  return results;
}

async function main() {
  try {
    const results = await runGeminiDiagnostics();
    for (const result of results) console.log(JSON.stringify(result));
    if (results.some(({ result }) => result !== 'success')) process.exitCode = 1;
  } catch {
    console.error('Gemini diagnostic not run. Set LLM_PROVIDER=gemini and GEMINI_API_KEY; GEMINI_MODEL is optional.');
    process.exitCode = 1;
  }
}

function isDirectExecution() {
  if (!process.argv[1]) return false;

  const currentFile = resolve(fileURLToPath(import.meta.url));
  const executedFile = resolve(process.argv[1]);

  return process.platform === 'win32'
    ? currentFile.toLowerCase() === executedFile.toLowerCase()
    : currentFile === executedFile;
}

if (isDirectExecution()) {
  await main();
}

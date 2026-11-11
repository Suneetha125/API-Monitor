import { describe, expect, it } from 'vitest';
import OpenAI from 'openai';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadDiagnosticEnvironment,
  runGeminiDiagnostics,
  runGeminiToolCallRoundTrip
} from '../scripts/gemini-diagnostic.js';
import { GEMINI_OPENAI_BASE_URL } from '../src/gemini-provider.js';

const SECRET = 'diagnostic-test-secret-key';
const PRIVATE_CONTENT = 'private upstream response body and user prompt';

function response(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function createOpenAIWithFetch() {
  return class OpenAIWithFetch extends OpenAI {
    constructor(options) {
      super({ ...options, maxRetries: 0 });
    }
  };
}

const validEnvironment = {
  LLM_PROVIDER: 'gemini',
  GEMINI_API_KEY: SECRET,
  GEMINI_MODEL: 'gemini-diagnostic-model'
};

describe('Gemini integration diagnostic', () => {
  it('loads environment variables from an existing env file without printing values', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pulsecheck-env-test-'));
    const envFile = join(directory, '.env');
    const variableName = 'PULSECHECK_DIAGNOSTIC_ENV_TEST';
    const previousValue = process.env[variableName];
    writeFileSync(envFile, `${variableName}=loaded-from-file\n`);

    try {
      delete process.env[variableName];
      loadDiagnosticEnvironment(envFile);
      expect(process.env[variableName]).toBe('loaded-from-file');
    } finally {
      if (previousValue === undefined) delete process.env[variableName];
      else process.env[variableName] = previousValue;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('runs its CLI entry point and reports missing configuration without making requests', () => {
    const scriptPath = fileURLToPath(new URL('../scripts/gemini-diagnostic.js', import.meta.url));
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        LLM_PROVIDER: '',
        GEMINI_API_KEY: ''
      }
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Gemini diagnostic not run. Set LLM_PROVIDER=gemini and GEMINI_API_KEY; GEMINI_MODEL is optional.'
    );
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain(SECRET);
  });

  it('sends three independent requests with production-compatible request shapes', async () => {
    const requests = [];
    const fetchImpl = async (url, init) => {
      requests.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
      return response(200, {
        id: 'diagnostic-mock',
        object: 'chat.completion',
        created: 0,
        model: 'gemini-diagnostic-model',
        choices: [{ index: 0, message: { role: 'assistant', content: PRIVATE_CONTENT } }]
      });
    };

    const results = await runGeminiDiagnostics({
      env: validEnvironment,
      OpenAIClient: createOpenAIWithFetch(),
      fetchImpl
    });

    expect(results.map(({ test, result, httpStatus }) => [test, result, httpStatus])).toEqual([
      ['text-only', 'success', 200],
      ['one-read-only-tool', 'success', 200],
      ['all-production-read-only-tools', 'success', 200]
    ]);
    expect(requests).toHaveLength(3);
    expect(requests.every(({ url }) => url === `${GEMINI_OPENAI_BASE_URL}chat/completions`)).toBe(true);
    expect(requests.every(({ headers }) => new Headers(headers).get('authorization') === `Bearer ${SECRET}`)).toBe(true);
    expect(requests[0].body).toMatchObject({
      model: 'gemini-diagnostic-model',
      messages: [{ role: 'user' }]
    });
    expect(requests[0].body).not.toHaveProperty('tools');
    expect(requests[0].body).not.toHaveProperty('tool_choice');
    expect(requests[1].body.tools).toHaveLength(1);
    expect(requests[1].body.tool_choice).toBe('auto');
    expect(requests[2].body.tools.map(({ function: tool }) => tool.name)).toEqual([
      'get_service_health',
      'list_monitors',
      'get_check_history',
      'get_monitoring_summary',
      'get_recent_failures',
      'list_simulations'
    ]);
    expect(requests[2].body.tool_choice).toBe('auto');
    expect(JSON.stringify(results)).not.toContain(SECRET);
    expect(JSON.stringify(results)).not.toContain(PRIVATE_CONTENT);
  });

  it('runs an opt-in tool-call round trip with matched tool result IDs', async () => {
    const requests = [];
    let responseIndex = 0;
    const fetchImpl = async (_url, init) => {
      requests.push(JSON.parse(init.body));
      responseIndex += 1;
      if (responseIndex === 1) {
        return response(200, {
          id: 'diagnostic-tool-call',
          object: 'chat.completion',
          created: 0,
          model: 'gemini-diagnostic-model',
          choices: [{
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'call-one', type: 'function', function: { name: 'get_service_health', arguments: '{}' } },
                { id: 'call-two', type: 'function', function: { name: 'get_service_health', arguments: '{}' } }
              ]
            }
          }]
        });
      }
      return response(200, {
        id: 'diagnostic-final',
        object: 'chat.completion',
        created: 0,
        model: 'gemini-diagnostic-model',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: PRIVATE_CONTENT }
        }]
      });
    };

    const results = await runGeminiToolCallRoundTrip({
      env: validEnvironment,
      OpenAIClient: createOpenAIWithFetch(),
      fetchImpl
    });

    expect(results).toEqual([
      { test: 'tool-call-initial', result: 'success', httpStatus: 200 },
      { test: 'tool-call-follow-up', result: 'success', httpStatus: 200 }
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[0].tool_choice).toBe('auto');
    expect(requests[0].messages[0].role).toBe('system');
    expect(requests[0].tools).toHaveLength(6);
    expect(requests[1].tools).toEqual(requests[0].tools);
    expect(requests[1].tool_choice).toBe('auto');
    expect(requests[1].messages.slice(-3)).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call-one', type: 'function', function: { name: 'get_service_health', arguments: '{}' } },
          { id: 'call-two', type: 'function', function: { name: 'get_service_health', arguments: '{}' } }
        ]
      },
      { role: 'tool', tool_call_id: 'call-one', content: '{"ok":true,"data":{"status":"diagnostic"}}' },
      { role: 'tool', tool_call_id: 'call-two', content: '{"ok":true,"data":{"status":"diagnostic"}}' }
    ]);
    expect(JSON.stringify(results)).not.toContain(PRIVATE_CONTENT);
    expect(JSON.stringify(results)).not.toContain(SECRET);
  });

  it('reports safe metadata when the real round-trip follow-up is rejected', async () => {
    let requestNumber = 0;
    const fetchImpl = async () => {
      requestNumber += 1;
      if (requestNumber === 1) {
        return response(200, {
          id: 'diagnostic-tool-call',
          object: 'chat.completion',
          created: 0,
          model: 'gemini-diagnostic-model',
          choices: [{
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call-one',
                type: 'function',
                function: { name: 'get_service_health', arguments: '{}' }
              }]
            }
          }]
        });
      }
      return response(400, {
        error: {
          status: 'INVALID_ARGUMENT',
          message: `${PRIVATE_CONTENT} Invalid JSON payload at tools[0].function.parameters.additionalProperties ${SECRET}`
        }
      });
    };

    const results = await runGeminiToolCallRoundTrip({
      env: validEnvironment,
      OpenAIClient: createOpenAIWithFetch(),
      fetchImpl
    });

    expect(results).toEqual([
      { test: 'tool-call-initial', result: 'success', httpStatus: 200 },
      {
        test: 'tool-call-follow-up',
        result: 'failure',
        httpStatus: 400,
        errorCode: 'INVALID_ARGUMENT',
        fieldPaths: ['tools[0].function.parameters.additionalProperties']
      }
    ]);
    expect(JSON.stringify(results)).not.toContain(PRIVATE_CONTENT);
    expect(JSON.stringify(results)).not.toContain(SECRET);
  });

  it('reports only allowlisted error metadata from an upstream 400', async () => {
    const fetchImpl = async () => response(400, {
      error: {
        code: 400,
        status: 'INVALID_ARGUMENT',
        message: PRIVATE_CONTENT,
        details: [{
          fieldViolations: [
            {
              field: 'tools[1].function.parameters.properties.endpointId.minimum',
              description: 'private sensitive field description'
            },
            {
              field: 'tools[1].function.parameters.properties.api_key',
              description: 'another secret'
            }
          ]
        }]
      }
    });

    const results = await runGeminiDiagnostics({
      env: validEnvironment,
      OpenAIClient: createOpenAIWithFetch(),
      fetchImpl
    });

    expect(results[0]).toEqual({
      test: 'text-only',
      result: 'failure',
      httpStatus: 400,
      errorCode: 'INVALID_ARGUMENT',
      fieldPaths: ['tools[1].function.parameters.properties.endpointId.minimum']
    });
    expect(JSON.stringify(results)).not.toContain(PRIVATE_CONTENT);
    expect(JSON.stringify(results)).not.toContain('private sensitive field description');
    expect(JSON.stringify(results)).not.toContain('another secret');
    expect(results).toHaveLength(3);
  });

  it('filters malicious metadata and tolerates malformed upstream error bodies', async () => {
    let requestNumber = 0;
    const fetchImpl = async () => {
      requestNumber += 1;
      if (requestNumber === 1) {
        return response(400, {
          error: {
            code: `invalid_api_key ${SECRET}`,
            details: [{
              fieldViolations: [{
                field: `tools[0].function.parameters.${PRIVATE_CONTENT}`,
                description: PRIVATE_CONTENT
              }]
            }]
          }
        });
      }
      return new Response(PRIVATE_CONTENT, { status: 400 });
    };

    const results = await runGeminiDiagnostics({
      env: validEnvironment,
      OpenAIClient: createOpenAIWithFetch(),
      fetchImpl
    });

    expect(results).toHaveLength(3);
    expect(results.every(({ result, httpStatus }) => result === 'failure' && httpStatus === 400)).toBe(true);
    expect(results.every(({ errorCode, fieldPaths }) => errorCode === undefined && fieldPaths === undefined)).toBe(true);
    expect(JSON.stringify(results)).not.toContain(SECRET);
    expect(JSON.stringify(results)).not.toContain(PRIVATE_CONTENT);
  });

  it('reports transport failures without exposing the thrown error', async () => {
    const fetchImpl = async () => {
      throw new Error(`Network failure with ${SECRET} and ${PRIVATE_CONTENT}`);
    };

    const results = await runGeminiDiagnostics({
      env: validEnvironment,
      OpenAIClient: createOpenAIWithFetch(),
      fetchImpl
    });

    expect(results).toHaveLength(3);
    expect(results.every(({ result, httpStatus }) => result === 'failure' && httpStatus === null)).toBe(true);
    expect(JSON.stringify(results)).not.toContain(SECRET);
    expect(JSON.stringify(results)).not.toContain(PRIVATE_CONTENT);
  });

  it('requires Gemini selection and a non-empty API key without exposing configuration values', async () => {
    await expect(runGeminiDiagnostics({
      env: { ...validEnvironment, LLM_PROVIDER: 'openai' }
    })).rejects.toThrow('Set LLM_PROVIDER=gemini and GEMINI_API_KEY; GEMINI_MODEL is optional.');
    await expect(runGeminiDiagnostics({
      env: { ...validEnvironment, GEMINI_API_KEY: '  ' }
    })).rejects.toThrow('Set LLM_PROVIDER=gemini and GEMINI_API_KEY; GEMINI_MODEL is optional.');
  });
});

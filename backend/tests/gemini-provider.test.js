import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createConfiguredProvider } from '../src/app.js';
import { createInvestigationAgent } from '../src/agent.js';
import { createDatabase } from '../src/database.js';
import { createGeminiProvider, GEMINI_OPENAI_BASE_URL } from '../src/gemini-provider.js';
import { LlmRequestError, MissingApiKeyError } from '../src/openai-provider.js';
import { createTestApp } from './test-app.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Gemini OpenAI-compatible provider', () => {
  it('selects OpenAI by default and supports explicit OpenAI and Gemini selection', () => {
    vi.stubEnv('LLM_PROVIDER', 'openai');
    vi.stubEnv('OPENAI_API_KEY', 'openai-test-key');
    expect(createConfiguredProvider().isConfigured).toBe(true);

    vi.stubEnv('GEMINI_API_KEY', 'gemini-test-key');
    expect(createConfiguredProvider('gemini').isConfigured).toBe(true);
    expect(() => createConfiguredProvider('unknown')).toThrow(
      'LLM_PROVIDER must be either "openai" or "gemini".'
    );
    expect(() => createConfiguredProvider('')).toThrow(
      'LLM_PROVIDER must be either "openai" or "gemini".'
    );
  });

  it('initializes the OpenAI SDK with Gemini credentials and the documented endpoint', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const create = vi.fn(async () => ({
      choices: [{ message: { role: 'assistant', content: 'Gemini is ready.' } }]
    }));
    class MockOpenAI {
      constructor(options) {
        expect(options).toEqual({
          apiKey: 'gemini-test-key',
          baseURL: GEMINI_OPENAI_BASE_URL
        });
        this.chat = { completions: { create } };
      }
    }

    const provider = createGeminiProvider({
      apiKey: 'gemini-test-key',
      model: 'gemini-test-model',
      OpenAIClient: MockOpenAI
    });
    await expect(provider.complete({ messages: [], tools: [] })).resolves.toEqual({
      role: 'assistant',
      content: 'Gemini is ready.'
    });
    expect(create).toHaveBeenCalledWith({
      model: 'gemini-test-model',
      messages: [],
      tools: [],
      tool_choice: 'auto'
    });
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('preserves Gemini function calls in the agent response format', async () => {
    const toolCall = {
      id: 'gemini-call-1',
      type: 'function',
      function: {
        name: 'get_service_health',
        arguments: '{}'
      }
    };
    class MockOpenAI {
      constructor() {
        this.chat = {
          completions: {
            create: async () => ({
              choices: [{ message: { role: 'assistant', content: null, tool_calls: [toolCall] } }]
            })
          }
        };
      }
    }
    const provider = createGeminiProvider({
      apiKey: 'gemini-test-key',
      OpenAIClient: MockOpenAI
    });

    await expect(provider.complete({ messages: [], tools: [] })).resolves.toMatchObject({
      role: 'assistant',
      content: null,
      tool_calls: [toolCall]
    });
  });

  it('supports a multi-turn tool call and sends tool results back to Gemini', async () => {
    const requests = [];
    class MockOpenAI {
      constructor(options) {
        expect(options.baseURL).toBe(GEMINI_OPENAI_BASE_URL);
        this.chat = {
          completions: {
            create: async (requestBody) => {
              requests.push(requestBody);
              if (requests.length === 1) {
                return {
                  choices: [{
                    message: {
                      role: 'assistant',
                      content: null,
                      tool_calls: [{
                        id: 'gemini-health-call',
                        type: 'function',
                        function: { name: 'get_service_health', arguments: '{}' }
                      }]
                    }
                  }]
                };
              }
              return {
                choices: [{
                  message: { role: 'assistant', content: 'The service health check succeeded.' }
                }]
              };
            }
          }
        };
      }
    }
    const provider = createGeminiProvider({
      apiKey: 'gemini-test-key',
      model: 'gemini-test-model',
      OpenAIClient: MockOpenAI
    });
    const agent = createInvestigationAgent({
      provider,
      tools: {
        definitions: [{
          name: 'get_service_health',
          description: 'Read service liveness.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          readOnly: true
        }],
        get_service_health: vi.fn(async () => ({ ok: true, data: { status: 'ok' } }))
      }
    });

    await expect(agent.investigate('Check service health.')).resolves.toMatchObject({
      answer: 'The service health check succeeded.',
      complete: true,
      toolCalls: [{ name: 'get_service_health', success: true }]
    });
    expect(requests).toHaveLength(2);
    expect(requests[1].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        tool_calls: [expect.objectContaining({ id: 'gemini-health-call' })]
      }),
      expect.objectContaining({
        role: 'tool',
        tool_call_id: 'gemini-health-call',
        content: JSON.stringify({ ok: true, data: { status: 'ok' } })
      })
    ]));
  });

  it('uses the existing safe configuration error when the Gemini key is missing', async () => {
    const provider = createGeminiProvider({ apiKey: '' });
    await expect(provider.complete({ messages: [], tools: [] }))
      .rejects.toBeInstanceOf(MissingApiKeyError);

    const db = createDatabase(':memory:');
    try {
      await request(createTestApp({ db, provider }))
        .post('/api/agent/investigate')
        .send({ question: 'Investigate the latest check.' })
        .expect(503)
        .expect(({ body }) => {
          expect(body).toEqual({
            success: false,
            error: 'The investigation service is not configured.'
          });
        });
    } finally {
      db.close();
    }
  });

  it('wraps upstream failures without exposing provider details', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const apiKey = 'gemini-test-key-do-not-log';
    const privateUserData = 'customer@example.com';
    const authorizationCredential = ['auth', 'secret'].join('-');
    class FailingOpenAI {
      constructor() {
        this.chat = {
          completions: {
            create: async () => {
              const error = new Error(
                `Request failed with key=${apiKey}; Authorization: Bearer ${authorizationCredential}; contact ${privateUserData}; {"error":"private response body"} ${'x'.repeat(700)}`
              );
              error.status = 429;
              error.code = 'insufficient_quota';
              error.type = 'api_error';
              throw error;
            }
          }
        };
      }
    }
    const provider = createGeminiProvider({
      apiKey,
      OpenAIClient: FailingOpenAI
    });

    const messages = [{ role: 'user', content: `contact ${privateUserData}` }];
    await expect(provider.complete({ messages, tools: [] }))
      .rejects.toBeInstanceOf(LlmRequestError);
    await expect(provider.complete({ messages, tools: [] }))
      .rejects.toThrow('The language model request failed.');
    expect(errorLog).toHaveBeenCalledTimes(2);
    const [logMessage, diagnostics] = errorLog.mock.calls[0];
    expect(logMessage).toBe('Gemini upstream request failed.');
    expect(diagnostics).toMatchObject({
      status: 429,
      code: 'insufficient_quota',
      type: 'api_error'
    });
    expect(diagnostics.message).toHaveLength(500);
    const serializedLog = JSON.stringify(errorLog.mock.calls);
    expect(serializedLog).not.toContain(apiKey);
    expect(serializedLog).not.toContain(authorizationCredential);
    expect(serializedLog).not.toContain(privateUserData);
    expect(serializedLog).not.toContain('Authorization: Bearer');
    expect(serializedLog).not.toContain('private response body');
  });

  it('keeps the investigation response generic for Gemini upstream failures', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    class FailingOpenAI {
      constructor() {
        this.chat = {
          completions: {
            create: async () => {
              const error = new Error('401 {"error":{"message":"Gemini private response body"}}');
              error.status = 401;
              error.code = 'invalid_api_key';
              throw error;
            }
          }
        };
      }
    }
    const provider = createGeminiProvider({
      apiKey: 'gemini-test-key',
      OpenAIClient: FailingOpenAI
    });
    const db = createDatabase(':memory:');

    try {
      const response = await request(createTestApp({ db, provider }))
        .post('/api/agent/investigate')
        .send({ question: 'Investigate the latest check.' })
        .expect(502);
      expect(response.body).toEqual({
        success: false,
        error: 'The investigation could not be completed. Please try again later.'
      });
      expect(JSON.stringify(response.body)).not.toContain('Gemini private response body');
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain('Gemini private response body');
      expect(errorLog).toHaveBeenCalledWith(
        'Gemini upstream request failed.',
        expect.objectContaining({ status: 401, code: 'invalid_api_key' })
      );
    } finally {
      db.close();
    }
  });
});

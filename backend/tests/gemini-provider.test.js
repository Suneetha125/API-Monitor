import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import OpenAI from 'openai';
import { createConfiguredProvider } from '../src/app.js';
import { createInvestigationAgent } from '../src/agent.js';
import { createAgentTools } from '../src/agent-tools.js';
import { createDatabase } from '../src/database.js';
import { createGeminiProvider, GEMINI_OPENAI_BASE_URL } from '../src/gemini-provider.js';
import { LlmRequestError, MissingApiKeyError } from '../src/openai-provider.js';
import { createTestApp } from './test-app.js';

function mockCompletionResponse(message) {
  return new Response(JSON.stringify({
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: 0,
    model: 'gemini-3.8-flash',
    choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }]
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

function createHttpMockGeminiProvider(fetchImplementation) {
  class OpenAIWithMockFetch extends OpenAI {
    constructor(options) {
      super({ ...options, fetch: fetchImplementation, maxRetries: 0 });
    }
  }

  return createGeminiProvider({
    apiKey: 'mock-gemini-api-key',
    model: 'gemini-3.8-flash',
    OpenAIClient: OpenAIWithMockFetch
  });
}

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

  it('sends a text-only request through the OpenAI SDK HTTP serializer', async () => {
    const requests = [];
    const fetchMock = vi.fn(async (url, init) => {
      requests.push({
        url: String(url),
        method: init.method,
        body: JSON.parse(init.body)
      });
      return mockCompletionResponse({ role: 'assistant', content: 'Mock text response.' });
    });
    const provider = createHttpMockGeminiProvider(fetchMock);
    const messages = [
      { role: 'system', content: 'Generic system instruction.' },
      { role: 'user', content: 'Give a short generic response.' }
    ];

    await expect(provider.complete({ messages, tools: [] })).resolves.toMatchObject({
      role: 'assistant',
      content: 'Mock text response.'
    });

    expect(requests).toEqual([{
      url: `${GEMINI_OPENAI_BASE_URL}chat/completions`,
      method: 'POST',
      body: {
        model: 'gemini-3.8-flash',
        messages,
        tools: [],
        tool_choice: 'auto'
      }
    }]);
  });

  it('sends one minimal read-only tool using the OpenAI-compatible function shape', async () => {
    const requests = [];
    const fetchMock = vi.fn(async (url, init) => {
      requests.push(JSON.parse(init.body));
      return mockCompletionResponse({ role: 'assistant', content: 'Mock tool-enabled response.' });
    });
    const provider = createHttpMockGeminiProvider(fetchMock);
    const messages = [{ role: 'user', content: 'Check the generic service status.' }];
    const tools = [{
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

    await expect(provider.complete({ messages, tools })).resolves.toMatchObject({
      role: 'assistant',
      content: 'Mock tool-enabled response.'
    });

    expect(requests).toEqual([{
      model: 'gemini-3.8-flash',
      messages,
      tools,
      tool_choice: 'auto'
    }]);
  });

  it('serializes the complete default read-only agent tool set', async () => {
    const db = createDatabase(':memory:');
    const requests = [];
    const fetchMock = vi.fn(async (url, init) => {
      requests.push(JSON.parse(init.body));
      return mockCompletionResponse({ role: 'assistant', content: 'Mock investigation result.' });
    });

    try {
      const tools = createAgentTools({ db, serverPort: 3001 });
      const provider = createHttpMockGeminiProvider(fetchMock);
      const agent = createInvestigationAgent({ tools, provider });
      await expect(agent.investigate('Summarize service health.')).resolves.toMatchObject({
        answer: 'Mock investigation result.',
        complete: true
      });

      expect(requests).toHaveLength(1);
      expect(requests[0].model).toBe('gemini-3.8-flash');
      expect(requests[0].tool_choice).toBe('auto');
      expect(requests[0]).not.toHaveProperty('stream');
      expect(requests[0].tools).toEqual(tools.definitions
        .filter((definition) => definition.readOnly)
        .map((definition) => ({
          type: 'function',
          function: {
            name: definition.name,
            description: definition.description,
            parameters: definition.inputSchema
          }
        })));
      expect(requests[0].tools).toHaveLength(6);
      expect(requests[0].tools.map(({ function: functionDefinition }) => functionDefinition.name))
        .not.toContain('run_endpoint_check');
      expect(requests[0].tools.map(({ function: functionDefinition }) => functionDefinition.name))
        .not.toContain('run_simulation');
    } finally {
      db.close();
    }
  });

  it('serializes a tool-call response and tool result into a valid follow-up request', async () => {
    const requests = [];
    const responses = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'mock-health-call',
          type: 'function',
          function: { name: 'get_service_health', arguments: '{}' }
        }]
      },
      { role: 'assistant', content: 'The service is healthy.' }
    ];
    const fetchMock = vi.fn(async (url, init) => {
      requests.push(JSON.parse(init.body));
      return mockCompletionResponse(responses[requests.length - 1]);
    });
    const provider = createHttpMockGeminiProvider(fetchMock);
    const tools = {
      definitions: [{
        name: 'get_service_health',
        description: 'Read service liveness.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        readOnly: true
      }],
      get_service_health: vi.fn(async () => ({ ok: true, data: { status: 'ok' } }))
    };
    const agent = createInvestigationAgent({ tools, provider });

    await expect(agent.investigate('Check generic service health.')).resolves.toMatchObject({
      answer: 'The service is healthy.',
      complete: true
    });

    expect(requests).toHaveLength(2);
    expect(requests[1].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        tool_calls: [{
          id: 'mock-health-call',
          type: 'function',
          function: { name: 'get_service_health', arguments: '{}' }
        }]
      }),
      expect.objectContaining({
        role: 'tool',
        tool_call_id: 'mock-health-call',
        content: JSON.stringify({ ok: true, data: { status: 'ok' } })
      })
    ]));
    expect(requests[1].tool_choice).toBe('auto');
    expect(requests[1].tools).toEqual(requests[0].tools);
  });

  it('serializes multiple function calls and matching results in the Gemini follow-up request', async () => {
    const requests = [];
    let responseIndex = 0;
    const fetchMock = vi.fn(async (_url, init) => {
      requests.push(JSON.parse(init.body));
      responseIndex += 1;
      return responseIndex === 1
        ? mockCompletionResponse({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'gemini-health-one',
              type: 'function',
              function: { name: 'get_service_health', arguments: '{}' }
            },
            {
              id: 'gemini-health-two',
              type: 'function',
              function: { name: 'get_service_health', arguments: '{}' }
            }
          ]
        })
        : mockCompletionResponse({ role: 'assistant', content: 'Both health checks succeeded.' });
    });
    const provider = createHttpMockGeminiProvider(fetchMock);
    const tools = {
      definitions: [{
        name: 'get_service_health',
        description: 'Read service liveness.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        readOnly: true
      }],
      get_service_health: vi.fn(async () => ({ ok: true, data: { status: 'ok' } }))
    };

    await expect(createInvestigationAgent({ tools, provider }).investigate('Check health twice.'))
      .resolves.toMatchObject({
        answer: 'Both health checks succeeded.',
        toolCalls: [
          { name: 'get_service_health', success: true },
          { name: 'get_service_health', success: true }
        ]
      });

    expect(tools.get_service_health).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(2);
    expect(requests[1].messages.slice(-3)).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'gemini-health-one',
            type: 'function',
            function: { name: 'get_service_health', arguments: '{}' }
          },
          {
            id: 'gemini-health-two',
            type: 'function',
            function: { name: 'get_service_health', arguments: '{}' }
          }
        ]
      },
      {
        role: 'tool',
        tool_call_id: 'gemini-health-one',
        content: '{"ok":true,"data":{"status":"ok"}}'
      },
      {
        role: 'tool',
        tool_call_id: 'gemini-health-two',
        content: '{"ok":true,"data":{"status":"ok"}}'
      }
    ]);
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

    const messages = [
      { role: 'system', content: 'private system prompt content' },
      { role: 'user', content: `contact ${privateUserData}` },
      { role: 'assistant', tool_calls: [{ function: { arguments: 'private-tool-argument' } }] }
    ];
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
      type: 'upstream_error'
    });
    expect(diagnostics).not.toHaveProperty('message');
    expect(diagnostics).not.toHaveProperty('upstreamMessage');
    const serializedLog = JSON.stringify(errorLog.mock.calls);
    expect(serializedLog).not.toContain(apiKey);
    expect(serializedLog).not.toContain(authorizationCredential);
    expect(serializedLog).not.toContain(privateUserData);
    expect(serializedLog).not.toContain('private system prompt content');
    expect(serializedLog).not.toContain('private-tool-argument');
    expect(serializedLog).not.toContain('Authorization: Bearer');
    expect(serializedLog).not.toContain('private response body');
  });

  it('keeps only safe metadata from Gemini 400 diagnostics', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const apiKey = 'gemini-test-key-do-not-log';
    const systemPrompt = 'PRIVATE-SYSTEM-PROMPT-71';
    const userMessage = 'PRIVATE-USER-MESSAGE-82';
    const toolArgument = 'PRIVATE-TOOL-ARGUMENT-93';
    const authorizationValue = 'PRIVATE-AUTHORIZATION-04';
    class FailingOpenAI {
      constructor() {
        this.chat = {
          completions: {
            create: async () => {
              const error = new Error(
                `400 response leaked ${systemPrompt} ${userMessage} ${toolArgument} ${apiKey} ${authorizationValue}`
              );
              error.status = 400;
              error.code = `PRIVATE-${userMessage}`;
              error.name = `PRIVATE-${systemPrompt}`;
              error.type = `PRIVATE-${toolArgument}`;
              error.error = {
                error: {
                  status: 'INVALID_ARGUMENT',
                  message: `Invalid JSON payload received at 'tools[0].function.parameters.additionalProperties'; sensitive response ${systemPrompt} ${userMessage} ${toolArgument} ${apiKey} ${authorizationValue}`,
                  details: [{
                    fieldViolations: [{
                      field: 'tools[0].function.parameters.additionalProperties',
                      description: `Sensitive description ${systemPrompt} ${userMessage} ${toolArgument} ${apiKey} Bearer ${authorizationValue}`
                    }, {
                      field: `tools[0].function.parameters.properties.${userMessage}.type`,
                      description: 'Untrusted field path.'
                    }, {
                      field: 'tools[0].function.name\n',
                      description: 'Trailing line feed.'
                    }, {
                      field: 'tools[0].function.name\r',
                      description: 'Trailing carriage return.'
                    }, {
                      field: 'tools[0].function.name\u2028',
                      description: 'Trailing Unicode line separator.'
                    }]
                  }]
                }
              };
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
    await expect(provider.complete({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
        { role: 'assistant', tool_calls: [{ function: { arguments: toolArgument } }] }
      ],
      tools: [{ type: 'function', function: { parameters: { description: toolArgument } } }]
    })).rejects.toBeInstanceOf(LlmRequestError);

    const [logMessage, diagnostics] = errorLog.mock.calls[0];
    expect(logMessage).toBe('Gemini upstream request failed.');
    expect(diagnostics).toMatchObject({
      status: 400,
      code: 'INVALID_ARGUMENT',
      type: 'upstream_error',
      message: 'The upstream rejected request validation.',
      fieldPaths: ['tools[0].function.parameters.additionalProperties']
    });
    const serializedDiagnostics = JSON.stringify(diagnostics);
    expect(diagnostics).not.toHaveProperty('upstreamMessage');
    expect(serializedDiagnostics).not.toContain(apiKey);
    expect(serializedDiagnostics).not.toContain(systemPrompt);
    expect(serializedDiagnostics).not.toContain(userMessage);
    expect(serializedDiagnostics).not.toContain(toolArgument);
    expect(serializedDiagnostics).not.toContain(authorizationValue);
    expect(serializedDiagnostics).not.toContain('Bearer');
    expect(serializedDiagnostics).not.toContain('Sensitive description');
    expect(serializedDiagnostics).not.toContain('Sensitive response');
    expect(serializedDiagnostics).not.toContain('Untrusted field path.');
    expect(diagnostics.type).toBe('upstream_error');
  });

  it('extracts a validated field path from an upstream message without logging the message', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const privateText = 'PRIVATE-UPSTREAM-DATA-202';
    class FailingOpenAI {
      constructor() {
        this.chat = {
          completions: {
            create: async () => {
              const error = new Error('Gemini request rejected.');
              error.status = 400;
              error.error = {
                error: {
                  status: 'INVALID_ARGUMENT',
                  message: `Invalid JSON payload at 'tools[0].function.parameters.additionalProperties': ${privateText}`
                }
              };
              throw error;
            }
          }
        };
      }
    }

    await expect(createGeminiProvider({
      apiKey: 'private-test-api-key',
      OpenAIClient: FailingOpenAI
    }).complete({ messages: [], tools: [] })).rejects.toBeInstanceOf(LlmRequestError);

    expect(errorLog).toHaveBeenCalledWith(
      'Gemini upstream request failed.',
      expect.objectContaining({
        status: 400,
        code: 'INVALID_ARGUMENT',
        type: 'upstream_error',
        message: 'The upstream rejected request validation.',
        fieldPaths: ['tools[0].function.parameters.additionalProperties']
      })
    );
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(privateText);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('Invalid JSON payload');
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
        expect.objectContaining({
          status: 401,
          code: 'invalid_api_key',
          type: 'upstream_error'
        })
      );
      expect(errorLog.mock.calls[0][1].message).toBe('The upstream request failed.');
      expect(errorLog.mock.calls[0][1]).not.toHaveProperty('upstreamMessage');
    } finally {
      db.close();
    }
  });
});

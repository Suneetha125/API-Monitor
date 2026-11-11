import { describe, expect, it, vi } from 'vitest';
import { AgentProtocolError, createInvestigationAgent } from '../src/agent.js';
import { createDatabase } from '../src/database.js';
import { createOpenAIProvider, LlmRequestError } from '../src/openai-provider.js';
import request from 'supertest';
import { createTestApp } from './test-app.js';

const definitions = [
  {
    name: 'get_service_health',
    description: 'Read service liveness.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true
  },
  {
    name: 'get_recent_failures',
    description: 'Read recent failures.',
    inputSchema: {
      type: 'object',
      properties: {
        endpointId: { type: 'integer', minimum: 1 },
        from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }
      },
      additionalProperties: false
    },
    readOnly: true
  },
  {
    name: 'run_endpoint_check',
    description: 'Execute a monitoring check.',
    inputSchema: {
      type: 'object',
      properties: { endpointId: { type: 'integer', minimum: 1 } },
      required: ['endpointId'],
      additionalProperties: false
    },
    readOnly: false,
    effect: 'check_execution'
  },
  {
    name: 'run_simulation',
    description: 'Execute a simulation.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string', enum: ['normal', 'slow', 'timeout', 'error'] } },
      required: ['key'],
      additionalProperties: false
    },
    readOnly: false,
    effect: 'simulation_execution'
  }
];

function createTools() {
  return {
    definitions,
    get_service_health: vi.fn(async () => ({ ok: true, data: { status: 'ok' } })),
    get_recent_failures: vi.fn(async () => ({
      ok: true,
      data: [{ endpoint_id: 1, error: 'HTTP 503', url: 'https://private.example/health' }]
    })),
    run_endpoint_check: vi.fn(async () => ({ ok: true, data: { success: true } })),
    run_simulation: vi.fn(async () => ({ ok: true, data: { success: true } }))
  };
}

function toolCall(id, name, args = '{}') {
  return {
    id,
    type: 'function',
    function: { name, arguments: args }
  };
}

function createProvider(...responses) {
  return {
    isConfigured: true,
    complete: vi.fn(async () => {
      if (responses.length === 0) throw new Error('No mocked LLM response remains.');
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    })
  };
}

describe('investigation agent loop', () => {
  it('returns a final LLM response without tool calls', async () => {
    const tools = createTools();
    const provider = createProvider({ content: 'The service is healthy.' });
    const agent = createInvestigationAgent({ tools, provider });

    await expect(agent.investigate('Why is my API failing?')).resolves.toEqual({
      answer: 'The service is healthy.',
      toolCalls: [],
      complete: true
    });
    expect(provider.complete).toHaveBeenCalledOnce();
    expect(tools.get_service_health).not.toHaveBeenCalled();
  });

  it('executes a valid read-only tool and returns its result to the LLM', async () => {
    const tools = createTools();
    const provider = createProvider(
      { content: null, tool_calls: [toolCall('call-1', 'get_service_health')] },
      { content: 'The monitoring service is healthy.' }
    );
    const agent = createInvestigationAgent({ tools, provider });

    await expect(agent.investigate('Check monitoring health')).resolves.toMatchObject({
      answer: 'The monitoring service is healthy.',
      toolCalls: [{ name: 'get_service_health', success: true }],
      complete: true
    });
    expect(tools.get_service_health).toHaveBeenCalledWith({});
    expect(provider.complete.mock.calls[1][0].messages.at(-1)).toMatchObject({
      role: 'tool',
      tool_call_id: 'call-1',
      content: '{"ok":true,"data":{"status":"ok"}}'
    });
  });

  it('supports multiple sequential tool calls across LLM rounds', async () => {
    const tools = createTools();
    const provider = createProvider(
      { content: null, tool_calls: [toolCall('call-1', 'get_service_health')] },
      { content: null, tool_calls: [toolCall('call-2', 'get_recent_failures', '{"endpointId":1}')] },
      { content: 'One recent check failed with HTTP 503.' }
    );
    const agent = createInvestigationAgent({ tools, provider });

    const result = await agent.investigate('Investigate recent failures');
    expect(result).toMatchObject({
      answer: 'One recent check failed with HTTP 503.',
      toolCalls: [
        { name: 'get_service_health', success: true },
        { name: 'get_recent_failures', success: true }
      ],
      complete: true
    });
    expect(tools.get_service_health).toHaveBeenCalledOnce();
    expect(tools.get_recent_failures).toHaveBeenCalledWith({ endpointId: 1 });
    expect(provider.complete.mock.calls[2][0].messages.at(-1).content).not.toContain('private.example');
  });

  it('rejects missing or empty tool-call IDs before executing any tools', async () => {
    for (const invalidCall of [
      { type: 'function', function: { name: 'get_service_health', arguments: '{}' } },
      { id: '', type: 'function', function: { name: 'get_service_health', arguments: '{}' } }
    ]) {
      const tools = createTools();
      const provider = createProvider({ content: null, tool_calls: [invalidCall] });
      await expect(createInvestigationAgent({ tools, provider }).investigate('Check health'))
        .rejects.toBeInstanceOf(AgentProtocolError);
      expect(tools.get_service_health).not.toHaveBeenCalled();
    }
  });

  it('rejects non-string tool-call arguments before executing any tools', async () => {
    const tools = createTools();
    const provider = createProvider({
      content: null,
      tool_calls: [{
        id: 'call-object-arguments',
        type: 'function',
        function: { name: 'get_service_health', arguments: {} }
      }]
    });

    await expect(createInvestigationAgent({ tools, provider }).investigate('Check health'))
      .rejects.toBeInstanceOf(AgentProtocolError);
    expect(tools.get_service_health).not.toHaveBeenCalled();
  });

  it('removes URL credentials and sensitive query parameters before calling the provider', async () => {
    const provider = createProvider({ content: 'Investigate the affected endpoint.' });
    const question = 'Authorization: Bearer bearer-secret; API   key = "api-secret"; password : "password-secret"; Check https://user:pass@example.com/health?keep=value&sig=abc&key=def&X-Amz-Signature=ghi#fragment';
    await createInvestigationAgent({ tools: createTools(), provider }).investigate(question);

    const prompt = provider.complete.mock.calls[0][0].messages[1].content;
    for (const secret of ['bearer-secret', 'api-secret', 'password-secret', 'user:pass', 'keep=value', 'sig=abc', 'key=def', 'X-Amz-Signature=ghi', '#fragment']) {
      expect(prompt).not.toContain(secret);
    }
    expect(prompt).toContain('example.com/health');
  });

  it('removes all URL query parameters and fragments from final answers', async () => {
    const provider = createProvider({
      content: 'Failure at https://user:pass@example.com/health?ordinary=value&sig=abc&key=def&X-Amz-Signature=ghi#fragment.'
    });
    const result = await createInvestigationAgent({ tools: createTools(), provider })
      .investigate('Investigate the endpoint');

    expect(result.answer).toContain('https://example.com/health');
    for (const secret of ['user:pass', 'ordinary=value', 'sig=abc', 'key=def', 'X-Amz-Signature=ghi', '#fragment']) {
      expect(result.answer).not.toContain(secret);
    }
  });

  it('bounds intermediate assistant content before the next provider request', async () => {
    const tools = createTools();
    const provider = createProvider(
      {
        content: `Useful lead: HTTP 503. ${'context '.repeat(1000)}`,
        tool_calls: [toolCall('call-1', 'get_service_health')]
      },
      { content: 'The service is healthy.' }
    );

    await createInvestigationAgent({ tools, provider }).investigate('Investigate the outage');

    const assistantMessage = provider.complete.mock.calls[1][0].messages.find((message) => message.role === 'assistant');
    expect(assistantMessage.content.length).toBeLessThanOrEqual(4000);
    expect(assistantMessage.content.startsWith('Useful lead: HTTP 503.')).toBe(true);
    expect(assistantMessage.content).toContain('[Assistant content truncated.]');
  });

  it('sanitizes echoed tool arguments without changing the values executed', async () => {
    const originalArguments = {
      endpointId: 7,
      password: 'execution-secret',
      note: 'https://user:pass@example.com/health?sig=secret&key=secret&X-Amz-Signature=secret#fragment',
      sig: 'signature-secret',
      key: 'key-secret',
      'X-Amz-Signature': 'aws-signature-secret'
    };
    const tools = {
      definitions: [{
        name: 'inspect_endpoint',
        description: 'Inspect one endpoint.',
        inputSchema: {
          type: 'object',
          properties: {
            endpointId: { type: 'integer' },
            password: { type: 'string' },
            note: { type: 'string' },
            sig: { type: 'string' },
            key: { type: 'string' },
            'X-Amz-Signature': { type: 'string' }
          },
          required: ['endpointId', 'password', 'note'],
          additionalProperties: false
        },
        readOnly: true
      }],
      inspect_endpoint: vi.fn(async () => ({ ok: true, data: { status: 'ok' } }))
    };
    const provider = createProvider(
      { content: null, tool_calls: [toolCall('call-1', 'inspect_endpoint', JSON.stringify(originalArguments))] },
      { content: 'Endpoint inspected.' }
    );

    await createInvestigationAgent({ tools, provider }).investigate('Inspect endpoint');

    expect(tools.inspect_endpoint).toHaveBeenCalledWith(originalArguments);
    const echoedCall = provider.complete.mock.calls[1][0].messages.find((message) => message.role === 'assistant').tool_calls[0];
    const echoedArguments = JSON.parse(echoedCall.function.arguments);
    expect(echoedArguments.password).toBe('[REDACTED]');
    expect(echoedArguments.note).toBe('https://example.com/health');
    expect(echoedArguments.sig).toBe('[REDACTED]');
    expect(echoedArguments.key).toBe('[REDACTED]');
    expect(echoedArguments['X-Amz-Signature']).toBe('[REDACTED]');
    expect(JSON.stringify(echoedArguments)).not.toContain('execution-secret');
  });

  it('replaces malformed raw arguments instead of echoing them to the provider', async () => {
    const tools = createTools();
    const provider = createProvider(
      { content: null, tool_calls: [toolCall('call-1', 'get_recent_failures', '{"password":"argument-secret", malformed')] },
      { content: 'The arguments were invalid.' }
    );

    await createInvestigationAgent({ tools, provider }).investigate('Show recent failures');

    const echoedCall = provider.complete.mock.calls[1][0].messages.find((message) => message.role === 'assistant').tool_calls[0];
    expect(echoedCall.function.arguments).toBe('{}');
    expect(echoedCall.function.arguments).not.toContain('argument-secret');
    expect(tools.get_recent_failures).not.toHaveBeenCalled();
  });

  it('serializes undefined and otherwise unserializable tool results safely', async () => {
    const circularResult = { ok: true };
    circularResult.self = circularResult;
    for (const result of [undefined, 1n, circularResult]) {
      const tools = createTools();
      tools.get_service_health.mockResolvedValue(result);
      const provider = createProvider(
        { content: null, tool_calls: [toolCall('call-1', 'get_service_health')] },
        { content: 'The tool result was unavailable.' }
      );

      await expect(createInvestigationAgent({ tools, provider }).investigate('Check health')).resolves.toMatchObject({
        complete: true,
        answer: 'The tool result was unavailable.'
      });
      const toolMessage = provider.complete.mock.calls[1][0].messages.at(-1);
      expect(JSON.parse(toolMessage.content)).toMatchObject({
        ok: false,
        error: { code: 'RESULT_SERIALIZATION_FAILED' }
      });
    }
  });

  it('rejects oversized tool-call batches before any tool executes', async () => {
    const tools = createTools();
    const provider = createProvider({
      content: null,
      tool_calls: [
        toolCall('call-1', 'get_service_health'),
        toolCall('call-2', 'get_service_health'),
        toolCall('call-3', 'get_service_health')
      ]
    });
    const agent = createInvestigationAgent({ tools, provider, maxToolCallsPerResponse: 2 });

    await expect(agent.investigate('Check health')).rejects.toBeInstanceOf(AgentProtocolError);
    expect(tools.get_service_health).not.toHaveBeenCalled();
  });

  it('rejects a batch that exceeds the total execution limit without partial execution', async () => {
    const tools = createTools();
    const provider = createProvider(
      { content: null, tool_calls: [toolCall('call-1', 'get_service_health'), toolCall('call-2', 'get_service_health')] },
      { content: null, tool_calls: [toolCall('call-3', 'get_service_health'), toolCall('call-4', 'get_service_health')] }
    );
    const agent = createInvestigationAgent({
      tools,
      provider,
      maxToolCallsPerResponse: 2,
      maxToolExecutions: 3
    });

    await expect(agent.investigate('Check health')).rejects.toBeInstanceOf(AgentProtocolError);
    expect(tools.get_service_health).toHaveBeenCalledTimes(2);
    expect(provider.complete).toHaveBeenCalledTimes(2);
  });

  it('bounds final answers while preserving the useful beginning', async () => {
    const provider = createProvider({ content: `Evidence: HTTP 503 observed. ${'detail '.repeat(1000)}` });
    const result = await createInvestigationAgent({ tools: createTools(), provider })
      .investigate('Investigate the outage');

    expect(result.answer.length).toBeLessThanOrEqual(4000);
    expect(result.answer.startsWith('Evidence: HTTP 503 observed.')).toBe(true);
    expect(result.answer).toContain('[Response truncated.]');
  });

  it('does not send sensitive database result fields or credential strings to the model', async () => {
    const tools = createTools();
    tools.get_recent_failures.mockResolvedValue({
      ok: true,
      data: [{
        endpoint_id: 1,
        error: 'HTTP 503',
        url: 'https://user:pass@example.com?api_key=secret',
        password: 'db-password',
        access_token: 'db-token',
        cookie: 'session-cookie',
        authorization: 'Bearer header-token'
      }]
    });
    const provider = createProvider(
      { content: null, tool_calls: [toolCall('call-1', 'get_recent_failures', '{"endpointId":1}')] },
      { content: 'The service returned HTTP 503.' }
    );
    await createInvestigationAgent({ tools, provider }).investigate('Show recent failures');

    const modelToolResult = provider.complete.mock.calls[1][0].messages.at(-1).content;
    for (const secret of ['user:pass', 'api_key=secret', 'db-password', 'db-token', 'session-cookie', 'header-token']) {
      expect(modelToolResult).not.toContain(secret);
    }
  });

  it('reports tool execution failures safely and continues the investigation', async () => {
    const tools = createTools();
    tools.get_service_health.mockRejectedValue(new Error('private database connection details'));
    const provider = createProvider(
      { content: null, tool_calls: [toolCall('call-1', 'get_service_health')] },
      { content: 'The health check could not be completed.' }
    );
    const result = await createInvestigationAgent({ tools, provider }).investigate('Check health');

    expect(result.toolCalls).toEqual([{ name: 'get_service_health', success: false }]);
    expect(provider.complete.mock.calls[1][0].messages.at(-1).content).toContain('TOOL_EXECUTION_FAILED');
    expect(provider.complete.mock.calls[1][0].messages.at(-1).content).not.toContain('private database');
  });

  it('rejects unknown tool names without executing them', async () => {
    const tools = createTools();
    const provider = createProvider(
      { content: null, tool_calls: [toolCall('call-1', 'delete_database')] },
      { content: 'I could not use that tool.' }
    );
    const result = await createInvestigationAgent({ tools, provider }).investigate('Check my API');

    expect(result.toolCalls).toEqual([{ name: 'delete_database', success: false }]);
    expect(tools.run_simulation).not.toHaveBeenCalled();
    expect(provider.complete.mock.calls[1][0].messages.at(-1).content).toContain('UNKNOWN_TOOL');
  });

  it('rejects invalid tool arguments before execution', async () => {
    const tools = createTools();
    const provider = createProvider(
      { content: null, tool_calls: [toolCall('call-1', 'get_recent_failures', '{"endpointId":"1","extra":true}')] },
      { content: 'The requested filter was invalid.' }
    );
    const result = await createInvestigationAgent({ tools, provider }).investigate('Show recent failures');

    expect(result.toolCalls).toEqual([{ name: 'get_recent_failures', success: false }]);
    expect(tools.get_recent_failures).not.toHaveBeenCalled();
    expect(provider.complete.mock.calls[1][0].messages.at(-1).content).toContain('INVALID_ARGUMENT');
  });

  it('rejects malformed tool JSON safely without executing the handler', async () => {
    const tools = createTools();
    const provider = createProvider(
      { content: null, tool_calls: [toolCall('call-1', 'get_recent_failures', '{"endpointId":')] },
      { content: 'The tool arguments were malformed.' }
    );
    const result = await createInvestigationAgent({ tools, provider }).investigate('Show recent failures');

    expect(result.toolCalls).toEqual([{ name: 'get_recent_failures', success: false }]);
    expect(tools.get_recent_failures).not.toHaveBeenCalled();
    expect(provider.complete.mock.calls[1][0].messages.at(-1).content).toContain('INVALID_ARGUMENT');
  });

  it('rejects impossible dates before executing the tool handler', async () => {
    const tools = createTools();
    const provider = createProvider(
      { content: null, tool_calls: [toolCall('call-1', 'get_recent_failures', '{"from":"2026-13-01"}')] },
      { content: 'The requested date was invalid.' }
    );
    const result = await createInvestigationAgent({ tools, provider }).investigate('Show recent failures');

    expect(result.toolCalls).toEqual([{ name: 'get_recent_failures', success: false }]);
    expect(tools.get_recent_failures).not.toHaveBeenCalled();
  });

  it('stops at the configured maximum model iteration count', async () => {
    const tools = createTools();
    const provider = createProvider(
      { content: null, tool_calls: [toolCall('call-1', 'get_service_health')] },
      { content: null, tool_calls: [toolCall('call-2', 'get_service_health')] },
      { content: 'This response must not be requested.' }
    );
    const result = await createInvestigationAgent({
      tools,
      provider,
      maxIterations: 2
    }).investigate('Check the service');

    expect(provider.complete).toHaveBeenCalledTimes(2);
    expect(result.complete).toBe(false);
    expect(result.answer).toContain('maximum of 2');
  });

  it('returns TOOL_NOT_ALLOWED without proposing or executing when policy disables operations', async () => {
    const tools = createTools();
    const provider = createProvider(
      {
        content: null,
        tool_calls: [
          toolCall('call-1', 'run_endpoint_check', '{"endpointId":1}'),
          toolCall('call-2', 'run_simulation', '{"key":"error"}')
        ]
      },
      { content: 'The simulation was not run.' }
    );
    const agent = createInvestigationAgent({ tools, provider });

    const result = await agent.investigate('Run the error simulation');
    expect(provider.complete.mock.calls[0][0].tools.map(({ function: fn }) => fn.name))
      .not.toContain('run_simulation');
    expect(result.pendingOperation).toBeUndefined();
    expect(result.toolCalls).toEqual([
      { name: 'run_endpoint_check', success: false },
      { name: 'run_simulation', success: false }
    ]);
    expect(result).toMatchObject({
      complete: true,
      answer: 'The simulation was not run.'
    });
    expect(provider.complete).toHaveBeenCalledTimes(2);
    expect(provider.complete.mock.calls[1][0].messages.at(-2).content).toContain('TOOL_NOT_ALLOWED');
    expect(tools.run_endpoint_check).not.toHaveBeenCalled();
    expect(tools.run_simulation).not.toHaveBeenCalled();
  });

  it('executes a preceding read-only call, then proposes and stops before remaining calls', async () => {
    const tools = createTools();
    const provider = createProvider({
      content: null,
      tool_calls: [
        toolCall('call-1', 'get_service_health'),
        toolCall('call-2', 'run_simulation', '{"key":"normal"}'),
        toolCall('call-3', 'get_recent_failures', '{"endpointId":1}')
      ]
    });
    const result = await createInvestigationAgent({
      tools,
      provider,
      allowOperationalTools: true
    }).investigate('Check health, then run a simulation');

    expect(tools.get_service_health).toHaveBeenCalledOnce();
    expect(tools.run_simulation).not.toHaveBeenCalled();
    expect(tools.get_recent_failures).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      complete: false,
      toolCalls: [{ name: 'get_service_health', success: true }],
      pendingOperation: { toolName: 'run_simulation', arguments: { key: 'normal' } }
    });
    expect(provider.complete).toHaveBeenCalledOnce();
  });

  it('proposes an initial operation and does not execute later read-only calls', async () => {
    const tools = createTools();
    const provider = createProvider({
      content: null,
      tool_calls: [
        toolCall('call-1', 'run_simulation', '{"key":"normal"}'),
        toolCall('call-2', 'get_service_health')
      ]
    });
    const result = await createInvestigationAgent({
      tools,
      provider,
      allowOperationalTools: true
    }).investigate('Run a simulation and check health');

    expect(result).toMatchObject({
      complete: false,
      toolCalls: [],
      pendingOperation: { toolName: 'run_simulation', arguments: { key: 'normal' } }
    });
    expect(tools.run_simulation).not.toHaveBeenCalled();
    expect(tools.get_service_health).not.toHaveBeenCalled();
    expect(provider.complete).toHaveBeenCalledOnce();
  });

  it('can offer operational tools but never executes them before approval', async () => {
    const tools = createTools();
    const provider = createProvider(
      { content: null, tool_calls: [toolCall('call-1', 'run_simulation', '{"key":"normal"}')] },
      { content: 'The local scenario returned HTTP 200.' }
    );
    const result = await createInvestigationAgent({
      tools,
      provider,
      allowOperationalTools: true
    }).investigate('Run the normal simulation');

    expect(provider.complete.mock.calls[0][0].tools.map(({ function: fn }) => fn.name))
      .toContain('run_simulation');
    expect(provider.complete.mock.calls[0][0].tools.map(({ function: fn }) => fn.name))
      .not.toEqual(expect.arrayContaining(['approve_operation', 'reject_operation']));
    expect(result).toMatchObject({
      complete: false,
      pendingOperation: { toolName: 'run_simulation', arguments: { key: 'normal' } }
    });
    expect(tools.run_simulation).not.toHaveBeenCalled();
    expect(provider.complete).toHaveBeenCalledOnce();
  });

  it('denies a non-read-only tool outside the approval allowlist', async () => {
    const tools = createTools();
    const customHandler = vi.fn(async () => ({ ok: true, data: { completed: true } }));
    tools.definitions = [
      ...definitions,
      {
        name: 'run_custom_operation',
        description: 'A future operational tool.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        readOnly: false
      }
    ];
    tools.run_custom_operation = customHandler;
    const provider = createProvider(
      { content: null, tool_calls: [toolCall('call-1', 'run_custom_operation')] },
      { content: 'The operation is not permitted.' }
    );

    const result = await createInvestigationAgent({
      tools,
      provider,
      allowOperationalTools: true
    }).investigate('Run the custom operation');

    expect(provider.complete.mock.calls[0][0].tools.map(({ function: fn }) => fn.name))
      .not.toContain('run_custom_operation');
    expect(result.pendingOperation).toBeUndefined();
    expect(result.complete).toBe(true);
    expect(result.answer).toBe('The operation is not permitted.');
    expect(result.toolCalls).toEqual([{ name: 'run_custom_operation', success: false }]);
    expect(customHandler).not.toHaveBeenCalled();
    expect(provider.complete).toHaveBeenCalledTimes(2);
    expect(provider.complete.mock.calls[1][0].messages.at(-1).content).toContain('TOOL_NOT_ALLOWED');
  });

  it('redacts common credentials in the question before sending it to the LLM', async () => {
    const provider = createProvider({ content: 'Please rotate the exposed credential.' });
    await createInvestigationAgent({ tools: createTools(), provider })
      .investigate('Investigate Authorization: Bearer abc123, api_key=sk-example, API key: visible-secret');
    const prompt = provider.complete.mock.calls[0][0].messages[1].content;
    expect(prompt).not.toContain('abc123');
    expect(prompt).not.toContain('sk-example');
    expect(prompt).not.toContain('visible-secret');
  });
});

describe('OpenAI provider and investigation endpoint', () => {
  it('uses the configured model through the OpenAI SDK adapter', async () => {
    const create = vi.fn(async () => ({ choices: [{ message: { content: 'Ready.' } }] }));
    class MockOpenAI {
      constructor(options) {
        expect(options).toEqual({ apiKey: 'test-key' });
        this.chat = { completions: { create } };
      }
    }
    const provider = createOpenAIProvider({
      apiKey: 'test-key',
      model: 'test-model',
      OpenAIClient: MockOpenAI
    });

    await expect(provider.complete({ messages: [], tools: [] })).resolves.toEqual({ content: 'Ready.' });
    expect(create).toHaveBeenCalledWith({
      model: 'test-model',
      messages: [],
      tools: [],
      tool_choice: 'auto'
    });
  });

  it('reports provider API failures without exposing provider details', async () => {
    class FailingOpenAI {
      constructor() {
        this.chat = { completions: { create: async () => { throw new Error('private upstream details'); } } };
      }
    }
    const provider = createOpenAIProvider({ apiKey: 'test-key', OpenAIClient: FailingOpenAI });

    await expect(provider.complete({ messages: [], tools: [] })).rejects.toBeInstanceOf(LlmRequestError);
  });

  it('returns a safe error when the API key is missing', async () => {
    const db = createDatabase(':memory:');
    const provider = createOpenAIProvider({ apiKey: '' });
    try {
      await request(createTestApp({ db, provider }))
        .post('/api/agent/investigate')
        .send({ question: 'Why is my API failing?' })
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

  it('serves the investigation endpoint with a mocked provider and validates questions', async () => {
    const db = createDatabase(':memory:');
    const provider = createProvider({ content: 'No failures were found in the evidence.' });
    try {
      await request(createTestApp({ db, provider }))
        .post('/api/agent/investigate')
        .send({ question: 'Why is my API failing?' })
        .expect(200)
        .expect(({ body }) => {
          expect(body).toMatchObject({
            success: true,
            answer: 'No failures were found in the evidence.',
            toolCalls: [],
            complete: true
          });
        });
      await request(createTestApp({ db, provider }))
        .post('/api/agent/investigate')
        .send({ question: ' ' })
        .expect(400);
    } finally {
      db.close();
    }
  });

  it('returns a generic response for LLM failures', async () => {
    const db = createDatabase(':memory:');
    const provider = createProvider(new LlmRequestError());
    try {
      await request(createTestApp({ db, provider }))
        .post('/api/agent/investigate')
        .send({ question: 'Why is my API failing?' })
        .expect(502)
        .expect(({ body }) => {
          expect(body).toEqual({
            success: false,
            error: 'The investigation could not be completed. Please try again later.'
          });
          expect(JSON.stringify(body)).not.toContain('stack');
        });
    } finally {
      db.close();
    }
  });

  it('does not expose unexpected provider errors over HTTP', async () => {
    const db = createDatabase(':memory:');
    const provider = createProvider(new Error('private upstream stack and credentials'));
    try {
      await request(createTestApp({ db, provider }))
        .post('/api/agent/investigate')
        .send({ question: 'Why is my API failing?' })
        .expect(500)
        .expect(({ body }) => {
          expect(body).toEqual({ success: false, error: 'The investigation could not be completed.' });
          expect(JSON.stringify(body)).not.toContain('private upstream');
        });
    } finally {
      db.close();
    }
  });
});

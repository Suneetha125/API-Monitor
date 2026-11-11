import { INVESTIGATION_SYSTEM_PROMPT } from './investigation-prompt.js';

const MAX_TOOL_ARGUMENT_LENGTH = 16_384;
const MAX_TOOL_RESULT_LENGTH = 24_576;
const MAX_FINAL_ANSWER_LENGTH = 4_000;
const MAX_INTERMEDIATE_ASSISTANT_CONTENT_LENGTH = 4_000;
const SENSITIVE_FIELD = /(secret|password|token|credential|authorization|cookie|api.?key)/i;
const APPROVAL_REQUIRED_TOOL_NAMES = new Set(['run_endpoint_check', 'run_simulation']);

export class AgentInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AgentInputError';
  }
}

export class AgentProtocolError extends Error {
  constructor() {
    super('The language model returned an invalid response.');
    this.name = 'AgentProtocolError';
  }
}

export function parseMaxIterations(value = process.env.AGENT_MAX_ITERATIONS ?? '5') {
  const iterations = Number(value);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10) {
    throw new TypeError('AGENT_MAX_ITERATIONS must be an integer between 1 and 10.');
  }
  return iterations;
}

function parseBoundedInteger(value, name, fallback, maximum) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new TypeError(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return parsed;
}

export function parseMaxToolCallsPerResponse(value = process.env.AGENT_MAX_TOOL_CALLS_PER_RESPONSE ?? '5') {
  return parseBoundedInteger(value, 'AGENT_MAX_TOOL_CALLS_PER_RESPONSE', 5, 20);
}

export function parseMaxToolExecutions(value = process.env.AGENT_MAX_TOOL_EXECUTIONS ?? '10') {
  return parseBoundedInteger(value, 'AGENT_MAX_TOOL_EXECUTIONS', 10, 50);
}

function redactSensitiveText(text) {
  const scrubbedText = text
    .replace(/\b(authorization)\s*[:=]\s*(?:(?:bearer|basic)\s+)?(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[REDACTED]')
    .replace(/\b(?:bearer|basic)\s+(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '[REDACTED_AUTH]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g, '[REDACTED]')
    .replace(
      /\b(api\s*[_-]?\s*key|access\s*[_-]?\s*token|refresh\s*[_-]?\s*token|client\s*[_-]?\s*secret|x-amz-signature|signature|sig|key|secret|password|token|authorization)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1=[REDACTED]'
    );
  return scrubbedText.replace(/https?:\/\/[^\s<>"']+/gi, (match) => {
    const punctuation = match.match(/[),.;!?]+$/)?.[0] ?? '';
    const candidate = punctuation ? match.slice(0, -punctuation.length) : match;
    try {
      const url = new URL(candidate);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return `${url.toString()}${punctuation}`;
    } catch {
      return '[REDACTED_URL]';
    }
  });
}

function sanitizeIntermediateContent(content) {
  const sanitized = redactSensitiveText(content);
  if (sanitized.length <= MAX_INTERMEDIATE_ASSISTANT_CONTENT_LENGTH) return sanitized;
  const suffix = '\n[Assistant content truncated.]';
  return `${sanitized.slice(0, MAX_INTERMEDIATE_ASSISTANT_CONTENT_LENGTH - suffix.length)}${suffix}`;
}

function sanitizeFinalAnswer(answer) {
  const sanitized = redactSensitiveText(answer);
  if (sanitized.length <= MAX_FINAL_ANSWER_LENGTH) return sanitized;
  const suffix = '\n[Response truncated.]';
  return `${sanitized.slice(0, MAX_FINAL_ANSWER_LENGTH - suffix.length)}${suffix}`;
}

function validateSchema(value, schema, path = 'arguments') {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new AgentInputError(`${path} must be a JSON object.`);
    }
    const properties = schema.properties ?? {};
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(properties, key) && schema.additionalProperties === false) {
        throw new AgentInputError(`Unexpected argument: ${key}.`);
      }
    }
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) throw new AgentInputError(`${key} is required.`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) validateSchema(item, properties[key], key);
    }
    return;
  }

  if (schema.type === 'integer') {
    if (!Number.isInteger(value)) throw new AgentInputError(`${path} must be an integer.`);
    if (schema.minimum !== undefined && value < schema.minimum) {
      throw new AgentInputError(`${path} must be at least ${schema.minimum}.`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      throw new AgentInputError(`${path} must be at most ${schema.maximum}.`);
    }
    return;
  }

  if (schema.type === 'string') {
    if (typeof value !== 'string') throw new AgentInputError(`${path} must be a string.`);
    if (schema.enum && !schema.enum.includes(value)) {
      throw new AgentInputError(`${path} must be one of the allowed values.`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      throw new AgentInputError(`${path} has an invalid format.`);
    }
    if (schema.pattern === '^\\d{4}-\\d{2}-\\d{2}$') {
      const date = new Date(`${value}T00:00:00.000Z`);
      if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
        throw new AgentInputError(`${path} must be a valid date.`);
      }
    }
    return;
  }

  throw new AgentInputError('The tool has an unsupported argument schema.');
}

function sanitizeForModel(value) {
  if (Array.isArray(value)) return value.map(sanitizeForModel);
  if (typeof value === 'string') {
    return redactSensitiveText(value).replace(/https?:\/\/\S+/gi, '[REDACTED_URL]');
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key.toLowerCase() !== 'url' && !SENSITIVE_FIELD.test(key))
      .map(([key, item]) => [key, sanitizeForModel(item)])
  );
}

function sanitizeToolArgumentsForHistory(rawArguments) {
  if (rawArguments.length > MAX_TOOL_ARGUMENT_LENGTH) return '{}';
  try {
    const sanitizeArgument = (value) => {
      if (Array.isArray(value)) return value.map(sanitizeArgument);
      if (typeof value === 'string') return redactSensitiveText(value);
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [
        key,
        (SENSITIVE_FIELD.test(key) || /^(?:key|sig|signature|x-amz-signature)$/i.test(key))
          ? '[REDACTED]'
          : sanitizeArgument(item)
      ]));
    };
    return JSON.stringify(sanitizeArgument(JSON.parse(rawArguments)));
  } catch {
    return '{}';
  }
}

function serializeToolResult(result) {
  let serialized;
  try {
    serialized = JSON.stringify(sanitizeForModel(result));
  } catch {
    serialized = undefined;
  }
  if (typeof serialized !== 'string') {
    return JSON.stringify({
      ok: false,
      error: { code: 'RESULT_SERIALIZATION_FAILED', message: 'Tool result could not be shared with the model.' }
    });
  }
  return serialized.length <= MAX_TOOL_RESULT_LENGTH
    ? serialized
    : JSON.stringify({
      ok: false,
      error: { code: 'RESULT_TOO_LARGE', message: 'Tool result was too large to share with the model.' }
    });
}

function parseArguments(rawArguments) {
  if (typeof rawArguments !== 'string' || rawArguments.length > MAX_TOOL_ARGUMENT_LENGTH) {
    throw new AgentInputError('Tool arguments must be a JSON object within the size limit.');
  }
  let parsed;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    throw new AgentInputError('Tool arguments must contain valid JSON.');
  }
  return parsed;
}

function getToolCallParts(call) {
  const id = call?.id;
  const name = call?.function?.name;
  const rawArguments = call?.function?.arguments;
  if (typeof id !== 'string' || !id || typeof name !== 'string' || !name ||
      typeof rawArguments !== 'string') {
    throw new AgentProtocolError();
  }
  return { id, name, rawArguments };
}

function getPublicResult(name, success) {
  return { name, success };
}

export function createInvestigationAgent({
  tools,
  provider,
  maxIterations = parseMaxIterations(),
  allowOperationalTools = false,
  maxToolCallsPerResponse = parseMaxToolCallsPerResponse(),
  maxToolExecutions = parseMaxToolExecutions()
} = {}) {
  if (!tools || !Array.isArray(tools.definitions) || typeof provider?.complete !== 'function') {
    throw new TypeError('Agent tools and a language model provider are required.');
  }
  if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 10) {
    throw new TypeError('maxIterations must be an integer between 1 and 10.');
  }
  if (!Number.isInteger(maxToolCallsPerResponse) || maxToolCallsPerResponse < 1 || maxToolCallsPerResponse > 20) {
    throw new TypeError('maxToolCallsPerResponse must be an integer between 1 and 20.');
  }
  if (!Number.isInteger(maxToolExecutions) || maxToolExecutions < 1 || maxToolExecutions > 50) {
    throw new TypeError('maxToolExecutions must be an integer between 1 and 50.');
  }

  const knownDefinitions = new Map(tools.definitions.map((definition) => [definition.name, definition]));
  const offeredDefinitions = tools.definitions.filter(
    (definition) =>
      definition.readOnly ||
      (allowOperationalTools && APPROVAL_REQUIRED_TOOL_NAMES.has(definition.name))
  );
  const providerTools = offeredDefinitions.map((definition) => ({
    type: 'function',
    function: {
      name: definition.name,
      description: definition.description,
      parameters: definition.inputSchema
    }
  }));
  async function executeTool(name, rawArguments) {
    if (!knownDefinitions.has(name)) {
      return { result: { ok: false, error: { code: 'UNKNOWN_TOOL', message: 'Unknown tool.' } }, success: false };
    }
    const definition = knownDefinitions.get(name);
    if (!definition.readOnly && !APPROVAL_REQUIRED_TOOL_NAMES.has(name)) {
      return {
        result: { ok: false, error: { code: 'TOOL_NOT_ALLOWED', message: 'This operational tool is not permitted.' } },
        success: false
      };
    }
    if (!definition.readOnly && !allowOperationalTools) {
      return {
        result: { ok: false, error: { code: 'TOOL_NOT_ALLOWED', message: 'This tool is disabled by server policy.' } },
        success: false
      };
    }
    try {
      const args = parseArguments(rawArguments);
      validateSchema(args, definition.inputSchema);
      if (typeof tools[name] !== 'function') {
        return { result: { ok: false, error: { code: 'UNKNOWN_TOOL', message: 'Unknown tool.' } }, success: false };
      }
      const result = await tools[name](args);
      return { result, success: Boolean(result?.ok) };
    } catch (error) {
      if (error instanceof AgentInputError) {
        return {
          result: { ok: false, error: { code: 'INVALID_ARGUMENT', message: error.message } },
          success: false
        };
      }
      return {
        result: { ok: false, error: { code: 'TOOL_EXECUTION_FAILED', message: 'The tool could not complete the request.' } },
        success: false
      };
    }
  }

  return {
    async investigate(question) {
      if (typeof question !== 'string' || !question.trim() || question.length > 2000) {
        throw new AgentInputError('question must be a non-empty string of at most 2000 characters.');
      }

      const messages = [
        { role: 'system', content: INVESTIGATION_SYSTEM_PROMPT },
        { role: 'user', content: redactSensitiveText(question.trim()) }
      ];
      const toolCalls = [];
      const usedCallIds = new Set();

      for (let iteration = 0; iteration < maxIterations; iteration += 1) {
        const message = await provider.complete({ messages, tools: providerTools });
        if (!message || typeof message !== 'object' ||
            (message.content !== null && message.content !== undefined && typeof message.content !== 'string') ||
            (message.tool_calls !== undefined && !Array.isArray(message.tool_calls))) {
          throw new AgentProtocolError();
        }

        const calls = message.tool_calls ?? [];
        if (calls.length === 0) {
          if (typeof message.content !== 'string') throw new AgentProtocolError();
          return { answer: sanitizeFinalAnswer(message.content), toolCalls, complete: true };
        }
        if (calls.length > maxToolCallsPerResponse) throw new AgentProtocolError();

        const parsedCalls = calls.map(getToolCallParts);
        if (toolCalls.length + parsedCalls.length > maxToolExecutions) throw new AgentProtocolError();
        for (const { id } of parsedCalls) {
          if (usedCallIds.has(id)) throw new AgentProtocolError();
          usedCallIds.add(id);
        }

        messages.push({
          role: 'assistant',
          content: message.content == null ? null : sanitizeIntermediateContent(message.content),
          tool_calls: calls.map((call, index) => ({
            id: parsedCalls[index].id,
            type: 'function',
            function: {
              name: parsedCalls[index].name,
              arguments: sanitizeToolArgumentsForHistory(parsedCalls[index].rawArguments)
            }
          }))
        });

        for (const { id, name, rawArguments } of parsedCalls) {
          const definition = knownDefinitions.get(name);
          if (definition && APPROVAL_REQUIRED_TOOL_NAMES.has(name)) {
            if (!allowOperationalTools) {
              const execution = await executeTool(name, rawArguments);
              toolCalls.push(getPublicResult(name, execution.success));
              messages.push({
                role: 'tool',
                tool_call_id: id,
                content: serializeToolResult(execution.result)
              });
              continue;
            }

            let args;
            try {
              args = parseArguments(rawArguments);
              validateSchema(args, definition.inputSchema);
            } catch (error) {
              if (!(error instanceof AgentInputError)) throw error;
              const invalidResult = {
                ok: false,
                error: { code: 'INVALID_ARGUMENT', message: error.message }
              };
              toolCalls.push(getPublicResult(name, false));
              messages.push({ role: 'tool', tool_call_id: id, content: serializeToolResult(invalidResult) });
              continue;
            }

            return {
              answer: 'This operation requires explicit approval before it can run.',
              toolCalls,
              complete: false,
              pendingOperation: { toolName: name, arguments: args }
            };
          }

          const execution = await executeTool(name, rawArguments);
          toolCalls.push(getPublicResult(name, execution.success));
          messages.push({
            role: 'tool',
            tool_call_id: id,
            content: serializeToolResult(execution.result)
          });
        }
      }

      return {
        answer: `Investigation stopped after reaching the maximum of ${maxIterations} model iterations before a final response was produced.`,
        toolCalls,
        complete: false
      };
    }
  };
}

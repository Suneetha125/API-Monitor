import { SIMULATIONS } from './database.js';
import { InputError } from './security.js';
import {
  executeSimulation,
  getCheckHistory,
  getMonitoringSummary,
  getServiceHealth,
  listMonitors,
  listSimulations,
  runEndpointCheck
} from './services.js';

const TOOL_DEFINITIONS = [
  {
    name: 'get_service_health',
    description: 'Check the monitoring service liveness status.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true
  },
  {
    name: 'list_monitors',
    description: 'List monitored endpoints with their latest status and stored aggregates.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true
  },
  {
    name: 'run_endpoint_check',
    description: 'Execute and persist one health check for an existing monitor.',
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
    name: 'get_check_history',
    description: 'Retrieve check history with optional endpoint, date, and limit filters.',
    inputSchema: {
      type: 'object',
      properties: {
        endpointId: { type: 'integer', minimum: 1 },
        from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        limit: { type: 'integer', minimum: 1, maximum: 1000 }
      },
      additionalProperties: false
    },
    readOnly: true
  },
  {
    name: 'get_monitoring_summary',
    description: 'Summarize stored check counts, success rate, and average latency.',
    inputSchema: {
      type: 'object',
      properties: {
        endpointId: { type: 'integer', minimum: 1 },
        from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }
      },
      additionalProperties: false
    },
    readOnly: true
  },
  {
    name: 'get_recent_failures',
    description: 'Retrieve recent failed checks only, with their error details.',
    inputSchema: {
      type: 'object',
      properties: {
        endpointId: { type: 'integer', minimum: 1 },
        from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        limit: { type: 'integer', minimum: 1, maximum: 1000 }
      },
      additionalProperties: false
    },
    readOnly: true
  },
  {
    name: 'list_simulations',
    description: 'List available built-in local simulation scenarios.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true
  },
  {
    name: 'run_simulation',
    description: 'Execute one built-in local scenario without creating a stored check.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', enum: ['normal', 'slow', 'timeout', 'error'] }
      },
      required: ['key'],
      additionalProperties: false
    },
    readOnly: false,
    effect: 'simulation_execution'
  }
];

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
  }
}

function validateArguments(args, allowed, required = []) {
  if (args === undefined) args = {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new InputError('Tool arguments must be a JSON object.');
  }
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw new InputError(`Unexpected argument: ${key}.`);
  }
  for (const key of required) {
    if (!(key in args)) throw new InputError(`${key} is required.`);
  }
  return args;
}

function validatePositiveInteger(value, key) {
  if (!Number.isInteger(value) || value < 1) {
    throw new InputError(`${key} must be a positive integer.`);
  }
}

function validateFilterArguments(args, { includeLimit = false } = {}) {
  const allowed = ['endpointId', 'from', 'to', ...(includeLimit ? ['limit'] : [])];
  const input = validateArguments(args, allowed);
  if (input.endpointId !== undefined) validatePositiveInteger(input.endpointId, 'endpointId');
  if (input.limit !== undefined) {
    validatePositiveInteger(input.limit, 'limit');
    if (input.limit > 1000) throw new InputError('limit must be an integer between 1 and 1000.');
  }
  return input;
}

function wrapTool(handler) {
  return async (args) => {
    try {
      return { ok: true, data: await handler(args) };
    } catch (error) {
      if (error instanceof InputError) {
        return { ok: false, error: { code: 'INVALID_ARGUMENT', message: error.message } };
      }
      if (error instanceof NotFoundError) {
        return { ok: false, error: { code: 'NOT_FOUND', message: error.message } };
      }
      return {
        ok: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'The tool could not complete the request.'
        }
      };
    }
  };
}

export function createAgentTools({ db, serverPort, simulations = SIMULATIONS } = {}) {
  if (!db || typeof db.get !== 'function' || typeof db.all !== 'function') {
    throw new TypeError('An initialized database adapter is required.');
  }
  if (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535) {
    throw new TypeError('A valid serverPort is required for local simulations.');
  }

  const tools = {
    get_service_health: wrapTool(async (args) => {
      validateArguments(args, []);
      return getServiceHealth();
    }),
    list_monitors: wrapTool(async (args) => {
      validateArguments(args, []);
      return listMonitors(db);
    }),
    run_endpoint_check: wrapTool(async (args) => {
      const input = validateArguments(args, ['endpointId'], ['endpointId']);
      validatePositiveInteger(input.endpointId, 'endpointId');
      const result = await runEndpointCheck(db, input.endpointId, serverPort);
      if (!result) throw new NotFoundError('Endpoint not found.');
      return { ...result, success: Boolean(result.success) };
    }),
    get_check_history: wrapTool(async (args) => (
      getCheckHistory(db, validateFilterArguments(args, { includeLimit: true }))
    )),
    get_monitoring_summary: wrapTool(async (args) => {
      const summary = await getMonitoringSummary(db, validateFilterArguments(args));
      return {
        total_checks: summary.request_count,
        successful_checks: summary.success_count,
        failed_checks: summary.error_count,
        success_rate: summary.success_rate,
        average_latency_ms: summary.average_latency_ms
      };
    }),
    get_recent_failures: wrapTool(async (args) => (
      getCheckHistory(db, validateFilterArguments(args, { includeLimit: true }), { failuresOnly: true })
    )),
    list_simulations: wrapTool(async (args) => {
      validateArguments(args, []);
      return listSimulations(simulations);
    }),
    run_simulation: wrapTool(async (args) => {
      const input = validateArguments(args, ['key'], ['key']);
      if (typeof input.key !== 'string') throw new InputError('key must be a string.');
      const result = await executeSimulation(input.key, simulations);
      return {
        status_code: result.statusCode,
        success: result.statusCode >= 200 && result.statusCode < 300,
        body: result.body
      };
    })
  };

  return {
    definitions: TOOL_DEFINITIONS.map((definition) => structuredClone(definition)),
    ...tools
  };
}

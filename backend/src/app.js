import express from 'express';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  AgentInputError,
  AgentProtocolError,
  createInvestigationAgent,
  parseMaxIterations,
  parseMaxToolCallsPerResponse,
  parseMaxToolExecutions
} from './agent.js';
import { createAgentTools } from './agent-tools.js';
import { createClerkAuthentication } from './auth.js';
import { createInvestigationRateLimiter } from './agent-rate-limit.js';
import {
  createDatabase,
  claimApprovalRecord,
  createApprovalRecord,
  expireApprovalRecord,
  finishApprovalRecord,
  getApprovalRecord,
  getInvestigationRecord,
  listApprovalRecords,
  listInvestigationRecords,
  rejectApprovalRecord,
  saveInvestigationRecord,
  SIMULATIONS
} from './database.js';
import { createOpenAIProvider, LlmRequestError, MissingApiKeyError } from './openai-provider.js';
import { createGeminiProvider } from './gemini-provider.js';
import { InputError, validateEndpointInput } from './security.js';
import {
  executeSimulation,
  getCheckHistory,
  getMonitoringSummary,
  getServiceHealth,
  listMonitors,
  projectCheckForAgent,
  runEndpointCheck
} from './services.js';

function parsePagination(query, { defaultLimit = 20, maxLimit = 100 } = {}) {
  const page = Number(query.page ?? 1);
  const limit = Number(query.limit ?? defaultLimit);
  if (!Number.isInteger(page) || page < 1) {
    throw new InputError('page must be a positive integer.');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
    throw new InputError(`limit must be an integer between 1 and ${maxLimit}.`);
  }
  return { page, limit };
}

const APPROVAL_TTL_MS = 15 * 60 * 1000;
const APPROVAL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APPROVABLE_OPERATIONAL_TOOLS = new Set(['run_endpoint_check', 'run_simulation']);

export function createConfiguredProvider(providerName = process.env.LLM_PROVIDER) {
  const selectedProvider = typeof providerName === 'string'
    ? providerName.trim().toLowerCase()
    : providerName;
  if (selectedProvider === undefined || selectedProvider === 'openai') {
    return createOpenAIProvider();
  }
  if (selectedProvider === 'gemini') return createGeminiProvider();
  throw new TypeError('LLM_PROVIDER must be either "openai" or "gemini".');
}

function safeApprovalArguments(record) {
  if (record.toolName === 'run_endpoint_check') {
    return { endpointId: record.arguments?.endpointId };
  }
  if (record.toolName === 'run_simulation') {
    return { key: record.arguments?.key };
  }
  return {};
}

function publicApproval(record) {
  return {
    id: record.approvalId,
    investigationId: record.investigationId,
    toolName: record.toolName,
    arguments: safeApprovalArguments(record),
    status: record.status,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    executionAt: record.executionAt,
    result: record.safeResult
  };
}

function safeExecutionResult(toolName, toolResult) {
  if (!toolResult?.ok) {
    const code = typeof toolResult?.error?.code === 'string' ? toolResult.error.code : 'OPERATION_FAILED';
    return { success: false, code };
  }
  const data = toolResult.data ?? {};
  if (toolName === 'run_endpoint_check') {
    return projectCheckForAgent(data);
  }
  return {
    success: Boolean(data.success),
    status_code: data.status_code
  };
}

function approvalNotFound(res) {
  return res.status(404).json({ success: false, error: 'Approval not found.' });
}

function approvalConflict(res, approval) {
  return res.status(409).json({
    success: false,
    error: 'Approval is no longer pending.',
    approval: publicApproval(approval)
  });
}

function approvalExpiredOrChanged(res, approval) {
  if (!approval) return approvalNotFound(res);
  if (approval.status !== 'expired') return approvalConflict(res, approval);
  return res.status(410).json({ success: false, error: 'Approval has expired.', approval: publicApproval(approval) });
}

async function persistFailedInvestigation(db, ownerId, question, answerText) {
  if (typeof question !== 'string') return;
  const normalizedQuestion = question.trim();
  if (!normalizedQuestion || normalizedQuestion.length > 2000) return;

  try {
    await saveInvestigationRecord(db, {
      ownerId,
      question: normalizedQuestion,
      answer: answerText || 'The investigation could not be completed.',
      status: 'failed',
      toolCalls: []
    });
  } catch {
    // Database persistence errors are intentionally suppressed to prevent leaking internals.
  }
}

export function createApp({
  db = createDatabase(),
  simulations = SIMULATIONS,
  provider = createConfiguredProvider(),
  maxAgentIterations = parseMaxIterations(),
  maxToolCallsPerResponse = parseMaxToolCallsPerResponse(),
  maxToolExecutions = parseMaxToolExecutions(),
  allowOperationalTools = process.env.AGENT_ALLOW_OPERATIONAL_TOOLS === 'true',
  clerkMiddlewareFactory,
  authGetter,
  investigationRateLimit = 5,
  investigationRateWindowMs = 15 * 60 * 1000
} = {}) {
  const app = express();
  const internalSimulationToken = randomBytes(32).toString('hex');
  const authentication = createClerkAuthentication({
    middlewareFactory: clerkMiddlewareFactory,
    authGetter
  });
  app.locals.db = db;
  app.locals.internalSimulationToken = internalSimulationToken;
  app.use(authentication.middleware);

  app.get('/api/health', async (_req, res, next) => {
    try {
      res.json(await getServiceHealth());
    } catch (error) {
      next(error);
    }
  });

  app.use('/api', (req, res, next) => {
    const suppliedToken = req.get('x-pulsecheck-simulation-token');
    const expectedToken = Buffer.from(internalSimulationToken);
    const providedToken = Buffer.from(typeof suppliedToken === 'string' ? suppliedToken : '');
    const internalSimulationRequest = req.method === 'GET' &&
      /^\/simulations\/(?:normal|slow|timeout|error)$/.test(req.path) &&
      providedToken.length === expectedToken.length &&
      timingSafeEqual(providedToken, expectedToken);
    if (internalSimulationRequest) return next();
    return authentication.requireAuthenticatedUser(req, res, next);
  });
  app.use(express.json({ limit: '16kb' }));

  const investigationRateLimiter = createInvestigationRateLimiter({
    db,
    limit: investigationRateLimit,
    windowMs: investigationRateWindowMs,
    enabled: () => provider.isConfigured !== false
  });

  app.post('/api/agent/investigate', (req, res, next) => {
    const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
    if (!question || question.length > 2000) {
      return res.status(400).json({
        success: false,
        error: 'question must be a non-empty string of at most 2000 characters.'
      });
    }
    req.investigationQuestion = question;
    return next();
  }, investigationRateLimiter, async (req, res) => {
    const question = req.investigationQuestion;
    const ownerId = req.authenticatedUserId;

    try {
      if (provider.isConfigured === false) throw new MissingApiKeyError();

      const agent = createInvestigationAgent({
        tools: createAgentTools({
          db,
          serverPort: req.socket.localPort,
          simulations,
          allowOperationalTools,
          internalSimulationToken
        }),
        provider,
        maxIterations: maxAgentIterations,
        allowOperationalTools,
        maxToolCallsPerResponse,
        maxToolExecutions
      });
      const result = await agent.investigate(question);

      try {
        const investigation = await saveInvestigationRecord(db, {
          ownerId,
          question,
          answer: result.answer,
          status: result.complete ? 'completed' : 'incomplete',
          toolCalls: result.toolCalls
        });
        if (result.pendingOperation) {
          const approval = await createApprovalRecord(db, {
            approvalId: randomUUID(),
            investigationId: investigation.id,
            ownerId,
            toolName: result.pendingOperation.toolName,
            arguments: result.pendingOperation.arguments,
            expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString()
          });
          return res.json({
            success: true,
            answer: result.answer,
            toolCalls: result.toolCalls,
            complete: false,
            investigationId: investigation.id,
            approvalRequired: true,
            approval: publicApproval(approval)
          });
        }
        return res.json({
          success: true,
          answer: result.answer,
          toolCalls: result.toolCalls,
          complete: result.complete,
          investigationId: investigation.id
        });
      } catch (databaseError) {
        console.error('Investigation persistence failed.');
        return res.status(500).json({
          success: false,
          error: 'The investigation could not be saved.'
        });
      }
    } catch (error) {
      if (error instanceof AgentInputError) {
        return res.status(400).json({ success: false, error: error.message });
      }
      if (error instanceof MissingApiKeyError) {
        await persistFailedInvestigation(db, ownerId, question, 'The investigation service is not configured.');
        return res.status(503).json({
          success: false,
          error: 'The investigation service is not configured.'
        });
      }
      if (error instanceof LlmRequestError || error instanceof AgentProtocolError) {
        await persistFailedInvestigation(db, ownerId, question, 'The investigation could not be completed.');
        return res.status(502).json({
          success: false,
          error: 'The investigation could not be completed. Please try again later.'
        });
      }

      await persistFailedInvestigation(db, ownerId, question, 'The investigation could not be completed.');
      console.error('Investigation failed unexpectedly.');
      return res.status(500).json({
        success: false,
        error: 'The investigation could not be completed.'
      });
    }
  });

  app.get('/api/agent/investigations/:id/approvals', async (req, res) => {
    try {
      const investigationId = Number(req.params.id);
      if (!Number.isInteger(investigationId) || investigationId < 1) {
        return res.status(400).json({ success: false, error: 'id must be a positive integer.' });
      }
      if (!await getInvestigationRecord(db, investigationId, req.authenticatedUserId)) {
        return res.status(404).json({ success: false, error: 'Investigation not found.' });
      }
      const approvals = await listApprovalRecords(db, investigationId, req.authenticatedUserId);
      return res.json({ success: true, approvals: approvals.map(publicApproval) });
    } catch {
      console.error('Approval history lookup failed.');
      return res.status(500).json({ success: false, error: 'Approvals could not be loaded.' });
    }
  });

  app.post('/api/agent/approvals/:approvalId/reject', async (req, res) => {
    try {
      const { approvalId } = req.params;
      if (!APPROVAL_ID_PATTERN.test(approvalId)) return approvalNotFound(res);
      const ownerId = req.authenticatedUserId;
      let approval = await getApprovalRecord(db, approvalId, ownerId);
      if (!approval) return approvalNotFound(res);

      const now = new Date().toISOString();
      if (approval.status === 'pending' && approval.expiresAt <= now) {
        await expireApprovalRecord(db, approvalId, ownerId, now);
        approval = await getApprovalRecord(db, approvalId, ownerId);
        return approvalExpiredOrChanged(res, approval);
      }
      if (approval.status !== 'pending') return approvalConflict(res, approval);

      const rejected = await rejectApprovalRecord(db, approvalId, ownerId, new Date().toISOString());
      approval = await getApprovalRecord(db, approvalId, ownerId);
      if (!rejected) {
        if (approval?.status === 'pending' && approval.expiresAt <= new Date().toISOString()) {
          await expireApprovalRecord(db, approvalId, ownerId);
          approval = await getApprovalRecord(db, approvalId, ownerId);
          return approvalExpiredOrChanged(res, approval);
        }
        return approval ? approvalConflict(res, approval) : approvalNotFound(res);
      }
      return res.json({ success: true, approval: publicApproval(approval) });
    } catch {
      console.error('Approval rejection failed.');
      return res.status(500).json({ success: false, error: 'Approval could not be rejected.' });
    }
  });

  app.post('/api/agent/approvals/:approvalId/approve', async (req, res) => {
    try {
      const { approvalId } = req.params;
      if (!APPROVAL_ID_PATTERN.test(approvalId)) return approvalNotFound(res);
      const ownerId = req.authenticatedUserId;
      let approval = await getApprovalRecord(db, approvalId, ownerId);
      if (!approval) return approvalNotFound(res);

      const now = new Date().toISOString();
      if (approval.status === 'pending' && approval.expiresAt <= now) {
        await expireApprovalRecord(db, approvalId, ownerId, now);
        approval = await getApprovalRecord(db, approvalId, ownerId);
        return approvalExpiredOrChanged(res, approval);
      }
      if (approval.status !== 'pending') return approvalConflict(res, approval);
      if (!allowOperationalTools) {
        return res.status(403).json({ success: false, error: 'Operational tools are disabled by server policy.' });
      }
      if (!APPROVABLE_OPERATIONAL_TOOLS.has(approval.toolName)) {
        return res.status(403).json({ success: false, error: 'This operation is not permitted.' });
      }

      const claimed = await claimApprovalRecord(db, approvalId, ownerId, new Date().toISOString());
      if (!claimed) {
        approval = await getApprovalRecord(db, approvalId, ownerId);
        if (approval?.status === 'pending' && approval.expiresAt <= new Date().toISOString()) {
          await expireApprovalRecord(db, approvalId, ownerId);
          approval = await getApprovalRecord(db, approvalId, ownerId);
          return approvalExpiredOrChanged(res, approval);
        }
        return approval ? approvalConflict(res, approval) : approvalNotFound(res);
      }

      approval = await getApprovalRecord(db, approvalId, ownerId);
      const tools = createAgentTools({
        db,
        serverPort: req.socket.localPort,
        simulations,
        allowOperationalTools,
        internalSimulationToken
      });
      const definition = tools.definitions.find(({ name }) => name === approval?.toolName);
        if (!allowOperationalTools || approval?.status !== 'approved' ||
          !APPROVABLE_OPERATIONAL_TOOLS.has(approval.toolName) || !definition || definition.readOnly) {
        await finishApprovalRecord(db, approvalId, ownerId, 'failed', { success: false, code: 'OPERATION_NOT_ALLOWED' });
        return res.status(403).json({ success: false, error: 'The approved operation is not allowed.' });
      }

      const handler = tools[approval.toolName];
      if (typeof handler !== 'function' || !approval.arguments || typeof approval.arguments !== 'object' || Array.isArray(approval.arguments)) {
        await finishApprovalRecord(db, approvalId, ownerId, 'failed', { success: false, code: 'INVALID_STORED_OPERATION' });
        return res.status(409).json({ success: false, error: 'The stored operation is invalid.' });
      }

      let toolResult;
      try {
        toolResult = await handler(approval.arguments);
      } catch {
        toolResult = { ok: false, error: { code: 'OPERATION_FAILED' } };
      }
      const safeResult = safeExecutionResult(approval.toolName, toolResult);
      const status = toolResult?.ok ? 'executed' : 'failed';
      const finished = await finishApprovalRecord(db, approvalId, ownerId, status, safeResult);
      if (!finished) {
        return res.status(500).json({ success: false, error: 'The operation result could not be recorded.' });
      }
      const updatedApproval = await getApprovalRecord(db, approvalId, ownerId);
      return res.status(status === 'executed' ? 200 : 502).json({
        success: status === 'executed',
        approval: publicApproval(updatedApproval),
        result: safeResult
      });
    } catch {
      console.error('Approved operation failed.');
      return res.status(500).json({ success: false, error: 'The approved operation could not be completed.' });
    }
  });

  app.get('/api/agent/investigations', async (req, res) => {
    try {
      const { page, limit } = parsePagination(req.query);
      const result = await listInvestigationRecords(db, req.authenticatedUserId, { page, limit });
      res.json({
        success: true,
        investigations: result.investigations,
        pagination: result.pagination
      });
    } catch (error) {
      if (error instanceof InputError) {
        return res.status(400).json({ success: false, error: error.message });
      }
      console.error('Failed to load investigation history.');
      return res.status(500).json({
        success: false,
        error: 'The investigation history could not be loaded.'
      });
    }
  });

  app.get('/api/agent/investigations/:id', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) {
        return res.status(400).json({ success: false, error: 'id must be a positive integer.' });
      }
      const investigation = await getInvestigationRecord(db, id, req.authenticatedUserId);
      if (!investigation) {
        return res.status(404).json({ success: false, error: 'Investigation not found.' });
      }
      res.json({ success: true, investigation });
    } catch (error) {
      console.error('Failed to load investigation details.');
      return res.status(500).json({
        success: false,
        error: 'The investigation details could not be loaded.'
      });
    }
  });

  app.delete('/api/agent/investigations/:id', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) {
        return res.status(400).json({ success: false, error: 'id must be a positive integer.' });
      }
      const result = await db.run(
        'DELETE FROM investigations WHERE id = ? AND owner_id = ?',
        id,
        req.authenticatedUserId
      );
      if (Number(result.changes ?? result.rowCount ?? 0) === 0) {
        return res.status(404).json({ success: false, error: 'Investigation not found.' });
      }
      return res.status(204).end();
    } catch {
      console.error('Failed to delete investigation.');
      return res.status(500).json({
        success: false,
        error: 'The investigation could not be deleted.'
      });
    }
  });

  app.get('/api/simulations', (_req, res) => res.json(simulations));
  app.get('/api/simulations/:key', async (req, res, next) => {
    try {
      const result = await executeSimulation(req.params.key, simulations);
      res.status(result.statusCode).json(result.body);
    } catch (error) {
      if (error instanceof InputError) return res.status(404).json({ error: error.message });
      next(error);
    }
  });

  app.get('/api/endpoints', async (_req, res, next) => {
    try {
      res.json(await listMonitors(db));
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/endpoints', async (req, res, next) => {
    try {
      const endpoint = await validateEndpointInput(req.body);
      const id = await db.insert(
        'INSERT INTO endpoints (name, url, simulation) VALUES (?, ?, ?)',
        endpoint.name,
        endpoint.url,
        endpoint.simulation
      );
      res.status(201).json(await db.get('SELECT * FROM endpoints WHERE id = ?', id));
    } catch (error) {
      next(error);
    }
  });

  app.put('/api/endpoints/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) throw new InputError('Endpoint id must be a positive integer.');
      if (!await db.get('SELECT id FROM endpoints WHERE id = ?', id)) {
        return res.status(404).json({ error: 'Endpoint not found.' });
      }
      const endpoint = await validateEndpointInput(req.body);
      await db.run(
        'UPDATE endpoints SET name = ?, url = ?, simulation = ? WHERE id = ?',
        endpoint.name,
        endpoint.url,
        endpoint.simulation,
        id
      );
      res.json(await db.get('SELECT * FROM endpoints WHERE id = ?', id));
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/endpoints/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) throw new InputError('Endpoint id must be a positive integer.');
      const result = await db.run('DELETE FROM endpoints WHERE id = ?', id);
      if (db.dialect === 'sqlite' && result.changes === 0) {
        return res.status(404).json({ error: 'Endpoint not found.' });
      }
      if (db.dialect === 'postgres' && result.rowCount === 0) {
        return res.status(404).json({ error: 'Endpoint not found.' });
      }
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/endpoints/:id/check', async (req, res, next) => {
    try {
      const check = await runEndpointCheck(db, req.params.id, req.socket.localPort, {
        internalSimulationToken
      });
      if (!check) return res.status(404).json({ error: 'Endpoint not found.' });
      res.status(201).json(check);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/checks', async (req, res, next) => {
    try {
      res.json(await getCheckHistory(db, req.query));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/dashboard', async (req, res, next) => {
    try {
      res.json(await getMonitoringSummary(db, req.query));
    } catch (error) {
      next(error);
    }
  });

  app.use((error, _req, res, _next) => {
    if (error instanceof SyntaxError && 'body' in error) {
      return res.status(400).json({ error: 'Request body must be valid JSON.' });
    }
    if (error.status === 413) return res.status(413).json({ error: 'Request body exceeds the 16 KB limit.' });
    const status = error instanceof InputError ? error.status : 500;
    if (status === 500) console.error('Unhandled API request error.');
    return res.status(status).json({ error: status === 500 ? 'An unexpected server error occurred.' : error.message });
  });

  return app;
}

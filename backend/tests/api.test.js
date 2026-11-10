import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  createDatabase,
  listInvestigationRecords,
  normalizeInvestigationRecord,
  saveInvestigationRecord
} from '../src/database.js';
import { LlmRequestError } from '../src/openai-provider.js';
import { createTestApp } from './test-app.js';

let db;
let temporaryDirectory;
let app;

beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'pulsecheck-test-'));
  db = createDatabase(join(temporaryDirectory, 'test.sqlite'));
  app = createTestApp({ db });
});

afterEach(() => {
  db?.close();
  db = undefined;
  if (temporaryDirectory) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

async function getSimulation(key) {
  const response = await request(app).get('/api/endpoints').expect(200);
  const endpoint = response.body.find((item) => item.simulation === key);
  expect(endpoint).toBeDefined();
  return endpoint;
}

async function createPendingApproval(
  toolName,
  argumentsValue,
  { allowOperationalTools = true, ownerId = 'test-user' } = {}
) {
  const provider = createMockInvestigationProvider({
    content: null,
    tool_calls: [{
      id: 'call-operational-1',
      type: 'function',
      function: { name: toolName, arguments: JSON.stringify(argumentsValue) }
    }]
  });
  const approvalApp = createTestApp({
    db,
    provider,
    allowOperationalTools,
    testDefaultUserId: ownerId
  });
  const response = await request(approvalApp)
    .post('/api/agent/investigate')
    .send({ question: 'Please perform this operation.' })
    .expect(200);
  return { approvalApp, provider, response, approval: response.body.approval };
}

function createMockInvestigationProvider(...responses) {
  return {
    isConfigured: true,
    complete: vi.fn(async () => {
      const next = responses.shift();
      if (!next) {
        throw new Error('No mocked response defined.');
      }
      return next;
    })
  };
}

describe('PulseCheck API', () => {
  it('keeps health public while requiring verified identity for API routes', async () => {
    await request(app).get('/api/health').expect(200);
    await request(app)
      .get('/api/endpoints')
      .set('x-test-user-id', 'anonymous')
      .expect(401);
    await request(app)
      .post('/api/agent/investigate')
      .set('x-test-user-id', 'anonymous')
      .send({ question: 'Investigate this endpoint.' })
      .expect(401);
    await request(app)
      .post('/api/agent/approvals/not-a-real-id/approve')
      .set('x-test-user-id', 'anonymous')
      .expect(401);
  });

  it('returns HTTP 200 from the health endpoint', async () => {
    await request(app)
      .get('/api/health')
      .expect(200)
      .expect({ status: 'ok' });
  });

  it('creates a valid local endpoint and retrieves it from the endpoint list', async () => {
    const created = await request(app)
      .post('/api/endpoints')
      .send({
        name: 'Checkout health simulation',
        url: 'simulation://normal',
        simulation: 'normal'
      })
      .expect(201);

    expect(created.body).toMatchObject({
      name: 'Checkout health simulation',
      url: 'simulation://normal',
      simulation: 'normal'
    });

    const listed = await request(app).get('/api/endpoints').expect(200);
    expect(listed.body).toContainEqual(expect.objectContaining({
      id: created.body.id,
      name: 'Checkout health simulation',
      request_count: 0,
      success_rate: null,
      average_latency_ms: null
    }));
  });

  it('rejects invalid input without creating an endpoint or accessing the network', async () => {
    await request(app)
      .post('/api/endpoints')
      .send({ name: '', url: 'not-a-url' })
      .expect(400);
    await request(app)
      .post('/api/endpoints')
      .send({ name: 'Private target', url: 'http://127.0.0.1/admin' })
      .expect(400);
    await request(app)
      .post('/api/endpoints')
      .send({ name: 'Invalid simulation', url: 'simulation://unknown', simulation: 'unknown' })
      .expect(400);

    const listed = await request(app).get('/api/endpoints').expect(200);
    expect(listed.body).toHaveLength(4);
  });

  it('records a successful local mock check with status, latency, and timestamp', async () => {
    const endpoint = await getSimulation('normal');
    const result = await request(app)
      .post(`/api/endpoints/${endpoint.id}/check`)
      .expect(201);

    expect(result.body).toMatchObject({
      endpoint_id: endpoint.id,
      status_code: 200,
      success: 1,
      error: null
    });
    expect(result.body.duration_ms).toEqual(expect.any(Number));
    expect(result.body.duration_ms).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(result.body.checked_at))).toBe(false);
  });

  it('records an HTTP 500 mock response as a failed check', async () => {
    const endpoint = await getSimulation('error');

    const result = await request(app)
      .post(`/api/endpoints/${endpoint.id}/check`)
      .expect(201);

    expect(result.body).toMatchObject({
      endpoint_id: endpoint.id,
      status_code: 500,
      success: 0,
      error: 'HTTP 500'
    });
  });

  it('times out a slow mock check while keeping the API responsive', async () => {
    const endpoint = await getSimulation('timeout');
    const checkPromise = request(app)
      .post(`/api/endpoints/${endpoint.id}/check`)
      .timeout({ response: 5000, deadline: 6000 })
      .expect(201);

    await new Promise((resolve) => setTimeout(resolve, 50));
    await request(app).get('/api/health').expect(200);

    const result = await checkPromise;
    expect(result.body).toMatchObject({
      status_code: null,
      success: 0,
      error: 'Request timed out'
    });
    expect(result.body.duration_ms).toBeGreaterThanOrEqual(1900);
    expect(result.body.duration_ms).toBeLessThan(3500);
  }, 10000);

  it('saves check results to SQLite and returns them from the history route', async () => {
    const endpoint = await getSimulation('normal');
    const result = await request(app)
      .post(`/api/endpoints/${endpoint.id}/check`)
      .expect(201);

    const history = await request(app)
      .get(`/api/checks?endpointId=${endpoint.id}`)
      .expect(200);

    expect(history.body).toHaveLength(1);
    expect(history.body[0]).toMatchObject({
      id: result.body.id,
      endpoint_id: endpoint.id,
      endpoint_name: endpoint.name,
      status_code: 200,
      success: 1
    });
  });

  it('calculates success rate and average latency from stored check results', async () => {
    const endpoint = await getSimulation('normal');
    const insertCheck = db.prepare(`
      INSERT INTO checks (endpoint_id, status_code, duration_ms, success, error, checked_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertCheck.run(endpoint.id, 200, 100, 1, null, '2026-10-22T10:00:00.000Z');
    insertCheck.run(endpoint.id, 503, 300, 0, 'HTTP 503', '2026-10-22T10:01:00.000Z');
    insertCheck.run(endpoint.id, 200, 200, 1, null, '2026-10-22T10:02:00.000Z');

    const dashboard = await request(app)
      .get(`/api/dashboard?endpointId=${endpoint.id}`)
      .expect(200);
    const endpoints = await request(app).get('/api/endpoints').expect(200);
    const summary = endpoints.body.find((item) => item.id === endpoint.id);

    expect(dashboard.body).toMatchObject({
      request_count: 3,
      success_count: 2,
      success_rate: 66.7,
      average_latency_ms: 200,
      error_count: 1
    });
    expect(summary).toMatchObject({
      request_count: 3,
      success_rate: 66.7,
      average_latency_ms: 200,
      error_count: 1
    });
  });

  it('supports endpoint updates and deletes associated checks', async () => {
    const endpoint = await getSimulation('normal');
    await request(app).post(`/api/endpoints/${endpoint.id}/check`).expect(201);

    await request(app)
      .put(`/api/endpoints/${endpoint.id}`)
      .send({
        name: 'Renamed simulation',
        url: 'simulation://normal',
        simulation: 'normal'
      })
      .expect(200)
      .expect(({ body }) => expect(body.name).toBe('Renamed simulation'));

    await request(app).delete(`/api/endpoints/${endpoint.id}`).expect(204);
    await request(app).get(`/api/checks?endpointId=${endpoint.id}`).expect(200).expect(({ body }) => {
      expect(body).toHaveLength(0);
    });
  });

  it('validates date filters and returns matching check history', async () => {
    const endpoint = await getSimulation('normal');
    await request(app).post(`/api/endpoints/${endpoint.id}/check`).expect(201);

    await request(app).get('/api/checks?from=2026-02-31').expect(400);
    const today = new Date().toISOString().slice(0, 10);
    const filtered = await request(app)
      .get(`/api/checks?endpointId=${endpoint.id}&from=${today}&to=${today}`)
      .expect(200);

    expect(filtered.body).toHaveLength(1);
  });

  it('persists completed investigations with sanitized metadata', async () => {
    const provider = createMockInvestigationProvider(
      {
        content: null,
        tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: { name: 'get_recent_failures', arguments: '{"limit":1}' }
        }]
      },
      { content: 'The API is failing because several recent checks returned HTTP 500.' }
    );
    const investigationApp = createTestApp({ db, provider });

    const response = await request(investigationApp)
      .post('/api/agent/investigate')
      .send({ question: 'Why is my API failing? Authorization: Bearer super-secret-token-123' })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.complete).toBe(true);
    expect(response.body.toolCalls).toEqual([{ name: 'get_recent_failures', success: true }]);

    const stored = await db.get('SELECT * FROM investigations ORDER BY id DESC LIMIT 1');
    expect(stored.status).toBe('completed');
    expect(stored.question).not.toContain('super-secret-token-123');
    expect(stored.answer).not.toContain('super-secret-token-123');
    expect(stored.tool_count).toBe(1);
    expect(JSON.parse(stored.tool_calls)).toEqual([{ name: 'get_recent_failures', success: true }]);
  });

  it('scopes investigation records to the verified user and ignores supplied owner fields', async () => {
    const provider = createMockInvestigationProvider({ content: 'Evidence-based answer.' });
    const aliceApp = createTestApp({ db, provider, testDefaultUserId: 'clerk-user-alice' });
    const created = await request(aliceApp)
      .post('/api/agent/investigate?ownerId=clerk-user-bob')
      .send({
        question: 'Why did the API fail?',
        ownerId: 'clerk-user-bob',
        userId: 'clerk-user-bob'
      })
      .expect(200);
    const stored = await db.get('SELECT owner_id FROM investigations WHERE id = ?', created.body.investigationId);
    expect(stored.owner_id).toBe('clerk-user-alice');

    const bobApp = createTestApp({ db, testDefaultUserId: 'clerk-user-bob' });
    const bobHistory = await request(bobApp)
      .get('/api/agent/investigations?ownerId=clerk-user-alice')
      .expect(200);
    expect(bobHistory.body.investigations).toHaveLength(0);
    await request(bobApp)
      .get(`/api/agent/investigations/${created.body.investigationId}`)
      .expect(404);
    await request(aliceApp)
      .get(`/api/agent/investigations/${created.body.investigationId}`)
      .expect(200);
  });

  it('hides legacy ownerless investigations from authenticated users', async () => {
    const legacyPath = join(temporaryDirectory, 'legacy.sqlite');
    const legacyConnection = new DatabaseSync(legacyPath);
    legacyConnection.exec(`
      CREATE TABLE endpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        simulation TEXT,
        created_at TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE investigations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        status TEXT NOT NULL,
        tool_count INTEGER NOT NULL DEFAULT 0,
        tool_calls TEXT NOT NULL DEFAULT '[]',
        safe_summary TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        completed_at TEXT NOT NULL
      );
      CREATE TABLE agent_approvals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        approval_id TEXT NOT NULL UNIQUE,
        investigation_id INTEGER NOT NULL,
        tool_name TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        execution_at TEXT,
        safe_result TEXT
      );
    `);
    legacyConnection.prepare(`
      INSERT INTO investigations
        (question, answer, status, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('Legacy question', 'Legacy answer', 'completed', '2026-01-01', '2026-01-01');
    legacyConnection.close();

    const migratedDb = createDatabase(legacyPath);
    try {
      const ownerless = await migratedDb.get('SELECT owner_id FROM investigations WHERE id = 1');
      expect(ownerless.owner_id).toBeNull();
      const history = await listInvestigationRecords(migratedDb, 'clerk-user-alice');
      expect(history.investigations).toEqual([]);
      expect(history.pagination.total).toBe(0);
    } finally {
      migratedDb.close();
    }
  });

  it("does not expose or mutate another user's approval", async () => {
    const { approvalApp, approval } = await createPendingApproval(
      'run_simulation',
      { key: 'normal' },
      { ownerId: 'clerk-user-alice' }
    );
    const bobApp = createTestApp({ db, testDefaultUserId: 'clerk-user-bob' });

    const hiddenApprovals = await request(bobApp)
      .get(`/api/agent/investigations/${approval.investigationId}/approvals`)
      .expect(404);
    expect(hiddenApprovals.body.error).toBe('Investigation not found.');
    await request(bobApp)
      .post(`/api/agent/approvals/${approval.id}/approve`)
      .expect(404);
    await request(bobApp)
      .post(`/api/agent/approvals/${approval.id}/reject`)
      .expect(404);
    expect((await db.get(
      'SELECT status FROM agent_approvals WHERE approval_id = ?',
      approval.id
    )).status).toBe('pending');
    await request(approvalApp)
      .get(`/api/agent/investigations/${approval.investigationId}/approvals`)
      .expect(200)
      .expect(({ body }) => expect(body.approvals[0].status).toBe('pending'));
  });

  it('rate-limits configured investigations per user and fails closed on storage errors', async () => {
    const provider = createMockInvestigationProvider(
      { content: 'First answer.' },
      { content: 'Second answer.' },
      { content: 'Should not be requested.' }
    );
    const limitedApp = createTestApp({
      db,
      provider,
      investigationRateLimit: 2,
      investigationRateWindowMs: 60_000
    });
    const postQuestion = () => request(limitedApp)
      .post('/api/agent/investigate')
      .send({ question: 'Investigate the latest failure.' });

    await postQuestion().expect(200);
    await postQuestion().expect(200);
    const limited = await postQuestion().expect(429);
    expect(limited.headers['ratelimit-limit']).toBe('2');
    expect(Number(limited.headers['ratelimit-remaining'])).toBe(0);
    expect(provider.complete).toHaveBeenCalledTimes(2);

    const failingDb = {
      ...db,
      get: (sql, ...params) => {
        if (sql.includes('agent_rate_limits')) throw new Error('private database details');
        return db.get(sql, ...params);
      }
    };
    const unavailableProvider = createMockInvestigationProvider({ content: 'Not executed.' });
    const unavailableApp = createTestApp({ db: failingDb, provider: unavailableProvider });
    const unavailable = await request(unavailableApp)
      .post('/api/agent/investigate')
      .send({ question: 'Investigate the latest failure.' })
      .expect(503);
    expect(JSON.stringify(unavailable.body)).not.toContain('private database');
    expect(unavailableProvider.complete).not.toHaveBeenCalled();
  });

  it('rejects oversized JSON requests and investigation questions', async () => {
    await request(app)
      .post('/api/agent/investigate')
      .send({ question: 'x'.repeat(2001) })
      .expect(400);
    await request(app)
      .post('/api/endpoints')
      .send({ name: 'x'.repeat(20_000), url: 'https://example.com/health' })
      .expect(413);
  });

  it('creates a pending approval without executing an operational tool', async () => {
    const endpoint = await getSimulation('normal');
    const before = Number((await db.get('SELECT COUNT(*) AS count FROM checks')).count);
    const { approvalApp, response, approval } = await createPendingApproval(
      'run_endpoint_check',
      { endpointId: endpoint.id }
    );

    expect(response.body).toMatchObject({
      success: true,
      complete: false,
      approvalRequired: true,
      approval: {
        toolName: 'run_endpoint_check',
        arguments: { endpointId: endpoint.id },
        status: 'pending'
      }
    });
    expect(approval.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(Number((await db.get('SELECT COUNT(*) AS count FROM checks')).count)).toBe(before);
    const approvals = await request(approvalApp)
      .get(`/api/agent/investigations/${response.body.investigationId}/approvals`)
      .expect(200);
    expect(approvals.body.approvals).toHaveLength(1);
    expect(approvals.body.approvals[0].status).toBe('pending');
  });

  it('executes the stored operation after explicit approval and ignores submitted arguments', async () => {
    const { approvalApp, approval } = await createPendingApproval('run_simulation', { key: 'normal' });

    const response = await request(approvalApp)
      .post(`/api/agent/approvals/${approval.id}/approve`)
      .send({ toolName: 'run_endpoint_check', arguments: { endpointId: 9999 } })
      .expect(200);

    expect(response.body).toMatchObject({
      success: true,
      approval: { status: 'executed', toolName: 'run_simulation', arguments: { key: 'normal' } },
      result: { success: true, status_code: 200 }
    });
    const stored = await db.get('SELECT status, arguments_json, execution_at FROM agent_approvals WHERE approval_id = ?', approval.id);
    expect(stored.status).toBe('executed');
    expect(JSON.parse(stored.arguments_json)).toEqual({ key: 'normal' });
    expect(stored.execution_at).toBeTruthy();
  });

  it('rejects a pending operation without executing it', async () => {
    const endpoint = await getSimulation('normal');
    const before = Number((await db.get('SELECT COUNT(*) AS count FROM checks')).count);
    const { approvalApp, approval } = await createPendingApproval('run_endpoint_check', { endpointId: endpoint.id });

    const rejected = await request(approvalApp)
      .post(`/api/agent/approvals/${approval.id}/reject`)
      .send({ arguments: { endpointId: 9999 } })
      .expect(200);
    expect(rejected.body.approval.status).toBe('rejected');
    await request(approvalApp).post(`/api/agent/approvals/${approval.id}/approve`).expect(409);
    expect(Number((await db.get('SELECT COUNT(*) AS count FROM checks')).count)).toBe(before);
  });

  it('records failed operational executions and prevents retry', async () => {
    const { approvalApp, approval } = await createPendingApproval('run_endpoint_check', { endpointId: 99999 });

    const failed = await request(approvalApp)
      .post(`/api/agent/approvals/${approval.id}/approve`)
      .expect(502);
    expect(failed.body).toMatchObject({
      success: false,
      approval: { status: 'failed' },
      result: { success: false, code: 'NOT_FOUND' }
    });
    await request(approvalApp).post(`/api/agent/approvals/${approval.id}/approve`).expect(409);
  });

  it('expires pending approvals and prevents their execution', async () => {
    const endpoint = await getSimulation('normal');
    const before = Number((await db.get('SELECT COUNT(*) AS count FROM checks')).count);
    const { approvalApp, approval } = await createPendingApproval('run_endpoint_check', { endpointId: endpoint.id });
    await db.run('UPDATE agent_approvals SET expires_at = ? WHERE approval_id = ?', '2000-01-01T00:00:00.000Z', approval.id);

    const response = await request(approvalApp)
      .post(`/api/agent/approvals/${approval.id}/approve`)
      .expect(410);
    expect(response.body.approval.status).toBe('expired');
    expect(Number((await db.get('SELECT COUNT(*) AS count FROM checks')).count)).toBe(before);
  });

  it('allows only one execution for concurrent approval requests', async () => {
    const endpoint = await getSimulation('normal');
    const before = Number((await db.get('SELECT COUNT(*) AS count FROM checks')).count);
    const { approvalApp, approval } = await createPendingApproval('run_endpoint_check', { endpointId: endpoint.id });

    const responses = await Promise.all([
      request(approvalApp).post(`/api/agent/approvals/${approval.id}/approve`).send({}),
      request(approvalApp).post(`/api/agent/approvals/${approval.id}/approve`).send({})
    ]);
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
    expect(Number((await db.get('SELECT COUNT(*) AS count FROM checks')).count)).toBe(before + 1);
  });

  it('rejects unknown approval IDs and creates no approval when policy disables operations', async () => {
    await request(app)
      .post('/api/agent/approvals/00000000-0000-4000-8000-000000000000/approve')
      .expect(404);
    const endpoint = await getSimulation('normal');
    const provider = createMockInvestigationProvider(
      {
        content: null,
        tool_calls: [{
          id: 'call-operational-1',
          type: 'function',
          function: { name: 'run_endpoint_check', arguments: JSON.stringify({ endpointId: endpoint.id }) }
        }]
      },
      { content: 'The operation is disabled by server policy.' }
    );
    const before = Number((await db.get('SELECT COUNT(*) AS count FROM checks')).count);
    const result = await request(createTestApp({ db, provider, allowOperationalTools: false }))
      .post('/api/agent/investigate')
      .send({ question: 'Please check this endpoint.' })
      .expect(200);

    expect(result.body.approvalRequired).toBeUndefined();
    expect(result.body.approval).toBeUndefined();
    expect(result.body.toolCalls).toEqual([{ name: 'run_endpoint_check', success: false }]);
    expect(Number((await db.get('SELECT COUNT(*) AS count FROM agent_approvals')).count)).toBe(0);
    expect(Number((await db.get('SELECT COUNT(*) AS count FROM checks')).count)).toBe(before);
  });

  it('keeps pending approvals unexecuted after reopening the database', async () => {
    const endpoint = await getSimulation('normal');
    const before = Number((await db.get('SELECT COUNT(*) AS count FROM checks')).count);
    const { response, approval } = await createPendingApproval('run_endpoint_check', { endpointId: endpoint.id });
    const filename = join(temporaryDirectory, 'test.sqlite');
    db.close();
    db = createDatabase(filename);

    const reopenedApp = createTestApp({ db });
    const approvals = await request(reopenedApp)
      .get(`/api/agent/investigations/${response.body.investigationId}/approvals`)
      .expect(200);
    expect(approvals.body.approvals[0]).toMatchObject({ id: approval.id, status: 'pending' });
    expect(Number((await db.get('SELECT COUNT(*) AS count FROM checks')).count)).toBe(before);
  });

  it('handles approval persistence failures without exposing internals or executing tools', async () => {
    const endpoint = await getSimulation('normal');
    const provider = createMockInvestigationProvider({
      content: null,
      tool_calls: [{
        id: 'call-operational-1',
        type: 'function',
        function: { name: 'run_endpoint_check', arguments: JSON.stringify({ endpointId: endpoint.id }) }
      }]
    });
    const before = Number((await db.get('SELECT COUNT(*) AS count FROM checks')).count);
    const failingDb = {
      ...db,
      run: (sql, ...params) => {
        if (sql.includes('agent_approvals')) throw new Error('private database details');
        return db.run(sql, ...params);
      }
    };

    const response = await request(createTestApp({ db: failingDb, provider, allowOperationalTools: true }))
      .post('/api/agent/investigate')
      .send({ question: 'Please check the endpoint.' })
      .expect(500);
    expect(response.body.error).toBe('The investigation could not be saved.');
    expect(JSON.stringify(response.body)).not.toContain('private database');
    expect(Number((await db.get('SELECT COUNT(*) AS count FROM checks')).count)).toBe(before);
  });

  it('fails closed when the atomic approval claim cannot be persisted', async () => {
    const endpoint = await getSimulation('normal');
    const before = Number((await db.get('SELECT COUNT(*) AS count FROM checks')).count);
    const { approval, response } = await createPendingApproval('run_endpoint_check', { endpointId: endpoint.id });
    const failingDb = {
      ...db,
      run: (sql, ...params) => {
        if (sql.includes('UPDATE agent_approvals SET status = \'approved\'')) {
          throw new Error('private database details');
        }
        return db.run(sql, ...params);
      }
    };

    const failed = await request(createTestApp({ db: failingDb, allowOperationalTools: true }))
      .post(`/api/agent/approvals/${approval.id}/approve`)
      .expect(500);
    expect(failed.body.error).toBe('The approved operation could not be completed.');
    expect(JSON.stringify(failed.body)).not.toContain('private database');
    expect(Number((await db.get('SELECT COUNT(*) AS count FROM checks')).count)).toBe(before);
    expect(response.body.approval.status).toBe('pending');
  });

  it('normalizes PostgreSQL-style JSONB array tool calls', () => {
    const record = normalizeInvestigationRecord({
      id: 1,
      question: 'Why is my API failing?',
      answer: 'Likely a backend error.',
      status: 'completed',
      tool_count: 2,
      tool_calls: [
        { name: 'get_service_health', success: true, raw: 'ignore me' },
        { name: 'get_recent_failures', success: false, something: 'else' },
        null,
        'not-an-object'
      ],
      safe_summary: 'get_service_health:ok, get_recent_failures:failed',
      created_at: '2026-11-10T00:00:00.000Z',
      completed_at: '2026-11-10T00:00:01.000Z'
    });

    expect(record.tool_calls).toEqual([
      { name: 'get_service_health', success: true },
      { name: 'get_recent_failures', success: false }
    ]);
  });

  it('persists failed investigation attempts with safe metadata', async () => {
    const provider = {
      isConfigured: true,
      complete: vi.fn(async () => {
        throw new LlmRequestError();
      })
    };

    const response = await request(createTestApp({ db, provider }))
      .post('/api/agent/investigate')
      .send({ question: 'Why is my API failing? Authorization: Bearer top-secret-token' })
      .expect(502);

    expect(response.body.error).toBe('The investigation could not be completed. Please try again later.');

    const stored = await db.get('SELECT * FROM investigations ORDER BY id DESC LIMIT 1');
    expect(stored.status).toBe('failed');
    expect(stored.question).not.toContain('top-secret-token');
    expect(stored.answer).toBe('The investigation could not be completed.');
    expect(stored.tool_calls).toBe('[]');
  });

  it('awaits failed investigation persistence before returning the HTTP response', async () => {
    let persisted = false;
    const provider = {
      isConfigured: true,
      complete: vi.fn(async () => {
        throw new LlmRequestError();
      })
    };
    const appWithHookedDb = createTestApp({
      db: {
        ...db,
        insert: async (...params) => {
          persisted = true;
          return db.insert(...params);
        }
      },
      provider
    });

    const response = await request(appWithHookedDb)
      .post('/api/agent/investigate')
      .send({ question: 'Why is my API failing?' })
      .expect(502);

    expect(response.body.error).toBe('The investigation could not be completed. Please try again later.');
    expect(persisted).toBe(true);
  });

  it('does not persist invalid investigation questions', async () => {
    const before = await db.get('SELECT COUNT(*) AS count FROM investigations');

    await request(app)
      .post('/api/agent/investigate')
      .send({ question: '' })
      .expect(400);

    const after = await db.get('SELECT COUNT(*) AS count FROM investigations');
    expect(Number(after.count)).toBe(Number(before.count));
  });

  it('handles SQLite JSON string normalization and malformed tool entries', () => {
    const record = normalizeInvestigationRecord({
      id: 7,
      question: 'Why is my API failing?',
      answer: 'Likely a backend error.',
      status: 'completed',
      tool_count: 99,
      tool_calls: JSON.stringify([
        { name: 'get_service_health', success: true },
        { name: '', success: true },
        null,
        { name: 'run_simulation', success: false },
        'string-entry'
      ]),
      safe_summary: 'get_service_health:ok, run_simulation:failed',
      created_at: '2026-11-10T00:00:00.000Z',
      completed_at: '2026-11-10T00:00:01.000Z'
    });

    expect(record.tool_calls).toEqual([
      { name: 'get_service_health', success: true },
      { name: 'run_simulation', success: false }
    ]);
    expect(record.tool_count).toBe(2);
  });

  it('uses safe timestamps and accurate tool counts for failed investigations', async () => {
    const provider = {
      isConfigured: true,
      complete: vi.fn(async () => {
        throw new Error('Unexpected provider crash');
      })
    };

    const response = await request(createTestApp({ db, provider }))
      .post('/api/agent/investigate')
      .send({ question: 'Why is my API failing?' })
      .expect(500);

    expect(response.body.error).toBe('The investigation could not be completed.');

    const stored = await db.get('SELECT * FROM investigations ORDER BY id DESC LIMIT 1');
    expect(stored.status).toBe('failed');
    expect(stored.created_at).toBeTruthy();
    expect(stored.completed_at).toBeTruthy();
    expect(stored.tool_count).toBe(0);
  });

  it('sanitizes bearer tokens, API keys, and credential-bearing URLs', () => {
    const record = normalizeInvestigationRecord({
      id: 9,
      question: 'Authorization: Bearer top-secret-token; Basic c2VjcmV0; api_key=abc123; password=letmein; https://user:pass@example.com/path?api_key=abc123&token=xyz&signature=signed-value',
      answer: 'Bearer abc123 and https://example.com?refresh_token=secret; user@example.com',
      status: 'failed',
      tool_count: 0,
      tool_calls: [],
      safe_summary: 'No tools were used.',
      created_at: '2026-11-10T00:00:00.000Z',
      completed_at: '2026-11-10T00:00:02.000Z'
    });

    expect(record.question).not.toContain('top-secret-token');
    expect(record.question).not.toContain('abc123');
    expect(record.question).not.toContain('letmein');
    expect(record.question).not.toContain('user:pass');
    expect(record.question).not.toContain('c2VjcmV0');
    expect(record.question).not.toContain('signed-value');
    expect(record.answer).not.toContain('abc123');
    expect(record.answer).not.toContain('secret');
    expect(record.answer).not.toContain('user@example.com');
  });

  it('returns paginated investigation history and a single investigation record', async () => {
    await saveInvestigationRecord(db, {
      ownerId: 'test-user',
      question: 'Question one',
      answer: 'Answer one',
      status: 'completed',
      toolCalls: [{ name: 'get_service_health', success: true }]
    });
    await saveInvestigationRecord(db, {
      ownerId: 'test-user',
      question: 'Question two',
      answer: 'Answer two',
      status: 'completed',
      toolCalls: [{ name: 'get_recent_failures', success: false }]
    });
    await saveInvestigationRecord(db, {
      ownerId: 'test-user',
      question: 'Question three',
      answer: 'Answer three',
      status: 'incomplete',
      toolCalls: []
    });

    const list = await request(app)
      .get('/api/agent/investigations?page=1&limit=2')
      .expect(200);

    expect(list.body.success).toBe(true);
    expect(list.body.pagination.total).toBe(3);
    expect(list.body.pagination.page).toBe(1);
    expect(list.body.pagination.limit).toBe(2);
    expect(list.body.investigations).toHaveLength(2);

    const single = await request(app)
      .get(`/api/agent/investigations/${list.body.investigations[0].id}`)
      .expect(200);

    expect(single.body.success).toBe(true);
    expect(single.body.investigation.question).toBe('Question three');
    expect(single.body.investigation.status).toBe('incomplete');
  });

  it('validates pagination and request parameters for investigation history', async () => {
    await request(app).get('/api/agent/investigations?page=0').expect(400);
    await request(app).get('/api/agent/investigations?limit=0').expect(400);
    await request(app).get('/api/agent/investigations/0').expect(400);
    await request(app).get('/api/agent/investigations/9999').expect(404);
  });

  it('returns a safe error when investigation persistence fails', async () => {
    const provider = createMockInvestigationProvider(
      {
        content: null,
        tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: { name: 'get_service_health', arguments: '{}' }
        }]
      },
      { content: 'The service is healthy.' }
    );
    const brokenDb = {
      ...db,
      insert: () => { throw new Error('database write failure'); }
    };

    await request(createTestApp({ db: brokenDb, provider }))
      .post('/api/agent/investigate')
      .send({ question: 'Why is my API failing?' })
      .expect(500)
      .expect(({ body }) => expect(body.error).toBe('The investigation could not be saved.'));
  });

  it('returns a safe error when investigation history queries fail', async () => {
    const brokenDb = {
      ...db,
      get: () => { throw new Error('database read failure'); },
      all: () => { throw new Error('database read failure'); }
    };

    await request(createTestApp({ db: brokenDb }))
      .get('/api/agent/investigations')
      .expect(500)
      .expect(({ body }) => expect(body.error).toBe('The investigation history could not be loaded.'));
  });
});

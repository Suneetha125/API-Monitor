import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { newDb } from 'pg-mem';
import { createPostgresDatabase } from '../src/database.js';
import { createTestApp } from './test-app.js';

let db;
let app;
let memoryDatabase;

beforeEach(async () => {
  memoryDatabase = newDb();
  const { Pool } = memoryDatabase.adapters.createPg();
  db = await createPostgresDatabase('postgres://pulsecheck:test@localhost/pulsecheck', Pool);
  app = createTestApp({ db });
});

afterEach(async () => {
  await db?.close();
  db = undefined;
  memoryDatabase = undefined;
});

describe('PostgreSQL production adapter', () => {
  it('runs endpoint creation, checks, metrics, history, and cascade deletion through the API', async () => {
    const created = await request(app)
      .post('/api/endpoints')
      .send({
        name: 'PostgreSQL health simulation',
        url: 'simulation://normal',
        simulation: 'normal'
      })
      .expect(201);

    const check = await request(app)
      .post(`/api/endpoints/${created.body.id}/check`)
      .expect(201);
    expect(check.body).toMatchObject({
      endpoint_id: created.body.id,
      status_code: 200,
      success: 1,
      error: null
    });

    const history = await request(app)
      .get(`/api/checks?endpointId=${created.body.id}`)
      .expect(200);
    expect(history.body).toHaveLength(1);
    expect(history.body[0].success).toBe(1);

    const dashboard = await request(app)
      .get(`/api/dashboard?endpointId=${created.body.id}`)
      .expect(200);
    expect(dashboard.body).toMatchObject({
      request_count: 1,
      success_count: 1,
      success_rate: 100,
      error_count: 0
    });
    expect(Number(dashboard.body.average_latency_ms)).toBeGreaterThanOrEqual(0);

    await request(app).delete(`/api/endpoints/${created.body.id}`).expect(204);
    await request(app)
      .get(`/api/checks?endpointId=${created.body.id}`)
      .expect(200)
      .expect(({ body }) => expect(body).toHaveLength(0));
  });

  it('retains the seed marker when all endpoints are intentionally deleted', async () => {
    await db.run('DELETE FROM endpoints');
    const marker = await db.get(
      'SELECT key FROM app_metadata WHERE key = ?',
      'simulations_seeded'
    );
    const endpoints = await db.get('SELECT COUNT(*) AS count FROM endpoints');
    expect(marker.key).toBe('simulations_seeded');
    expect(Number(endpoints.count)).toBe(0);
  });

  it('persists and atomically executes an approval through PostgreSQL', async () => {
    const provider = {
      isConfigured: true,
      complete: async () => ({
        content: null,
        tool_calls: [{
          id: 'call-operational-1',
          type: 'function',
          function: { name: 'run_simulation', arguments: '{"key":"normal"}' }
        }]
      })
    };
    const approvalApp = createTestApp({
      db,
      provider,
      allowOperationalTools: true,
      testDefaultUserId: 'clerk-user-alice'
    });
    const investigation = await request(approvalApp)
      .post('/api/agent/investigate')
      .send({ question: 'Run the local normal simulation.' })
      .expect(200);

    expect(investigation.body.approval).toMatchObject({
      toolName: 'run_simulation',
      arguments: { key: 'normal' },
      status: 'pending'
    });
    const bobApp = createTestApp({ db, testDefaultUserId: 'clerk-user-bob' });
    await request(bobApp)
      .post(`/api/agent/approvals/${investigation.body.approval.id}/approve`)
      .expect(404);
    expect((await db.get(
      'SELECT status FROM agent_approvals WHERE approval_id = ?',
      investigation.body.approval.id
    )).status).toBe('pending');
    const approved = await request(approvalApp)
      .post(`/api/agent/approvals/${investigation.body.approval.id}/approve`)
      .expect(200);
    expect(approved.body).toMatchObject({
      success: true,
      approval: { status: 'executed' },
      result: { success: true, status_code: 200 }
    });
  });

  it('uses the PostgreSQL rate-limit upsert per authenticated user', async () => {
    const provider = {
      isConfigured: true,
      complete: async () => ({ content: 'No failures were found.' })
    };
    const limitedApp = createTestApp({
      db,
      provider,
      investigationRateLimit: 1,
      testDefaultUserId: 'clerk-user-rate-limited'
    });
    const first = await request(limitedApp)
      .post('/api/agent/investigate')
      .send({ question: 'Review recent checks.' })
      .expect(200);
    expect(first.body.success).toBe(true);

    await request(limitedApp)
      .post('/api/agent/investigate')
      .send({ question: 'Review recent checks again.' })
      .expect(429);
    expect(Number((await db.get(
      'SELECT request_count FROM agent_rate_limits WHERE owner_id = ?',
      'clerk-user-rate-limited'
    )).request_count)).toBe(2);
  });
});

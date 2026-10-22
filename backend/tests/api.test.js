import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/database.js';

let db;
let temporaryDirectory;
let app;

beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'pulsecheck-test-'));
  db = createDatabase(join(temporaryDirectory, 'test.sqlite'));
  app = createApp({ db });
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

describe('PulseCheck API', () => {
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
});

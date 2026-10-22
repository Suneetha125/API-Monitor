import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { newDb } from 'pg-mem';
import { createApp } from '../src/app.js';
import { createPostgresDatabase } from '../src/database.js';

let db;
let app;
let memoryDatabase;

beforeEach(async () => {
  memoryDatabase = newDb();
  const { Pool } = memoryDatabase.adapters.createPg();
  db = await createPostgresDatabase('postgres://pulsecheck:test@localhost/pulsecheck', Pool);
  app = createApp({ db });
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
});

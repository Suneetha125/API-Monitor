import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentTools } from '../src/agent-tools.js';
import { createDatabase } from '../src/database.js';
import { createTestApp } from './test-app.js';

let db;
let tools;
let server;
let app;
let temporaryDirectory;
let queryLog;

beforeEach(async () => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'pulsecheck-agent-tools-'));
  db = createDatabase(join(temporaryDirectory, 'test.sqlite'));
  queryLog = [];
  const trackedDb = {
    ...db,
    get: (sql, ...params) => {
      queryLog.push(sql);
      return db.get(sql, ...params);
    },
    all: (sql, ...params) => {
      queryLog.push(sql);
      return db.all(sql, ...params);
    }
  };
  app = createTestApp({ db });
  server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  tools = createAgentTools({
    db: trackedDb,
    serverPort: server.address().port,
    internalSimulationToken: app.locals.internalSimulationToken
  });
});

afterEach(async () => {
  if (server?.listening) {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  db?.close();
  db = undefined;
  server = undefined;
  app = undefined;
  if (temporaryDirectory) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

function endpointIdFor(simulation) {
  return db.get('SELECT id FROM endpoints WHERE simulation = ?', simulation).id;
}

function insertCheck(endpointId, success, checkedAt, error = null) {
  db.prepare(`
    INSERT INTO checks (endpoint_id, status_code, duration_ms, success, error, checked_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(endpointId, success ? 200 : 503, success ? 100 : 350, Number(success), error, checkedAt);
}

describe('agent tools', () => {
  it('exposes provider-neutral definitions for all tools', () => {
    expect(tools.definitions.map(({ name }) => name)).toEqual([
      'get_service_health',
      'list_monitors',
      'run_endpoint_check',
      'get_check_history',
      'get_monitoring_summary',
      'get_recent_failures',
      'list_simulations',
      'run_simulation'
    ]);
    expect(tools.definitions.find(({ name }) => name === 'run_endpoint_check').readOnly).toBe(false);
    expect(tools.definitions.find(({ name }) => name === 'run_simulation').effect).toBe('simulation_execution');
  });

  it('returns service liveness and rejects invalid arguments', async () => {
    await expect(tools.get_service_health({})).resolves.toEqual({ ok: true, data: { status: 'ok' } });
    await expect(tools.get_service_health({ extra: true })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENT' }
    });
  });

  it('lists monitors with latest status aggregates', async () => {
    const id = endpointIdFor('normal');
    insertCheck(id, true, '2026-11-03T10:00:00.000Z');
    insertCheck(id, false, '2026-11-03T10:01:00.000Z', 'HTTP 503');

    const result = await tools.list_monitors({});
    expect(result.ok).toBe(true);
    expect(result.data.find((item) => item.id === id)).toMatchObject({
      request_count: 2,
      success_count: 1,
      error_count: 1,
      last_success: 0,
      success_rate: 50
    });
    expect(result.data.find((item) => item.id === id)).not.toHaveProperty('url');
    expect(queryLog.at(-1)).not.toMatch(/e\.url/);
    await expect(tools.list_monitors(null)).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENT' }
    });
  });

  it('runs and persists endpoint checks, including failed HTTP responses', async () => {
    const enabledTools = createAgentTools({
      db,
      serverPort: server.address().port,
      allowOperationalTools: true,
      internalSimulationToken: app.locals.internalSimulationToken
    });
    const successful = await enabledTools.run_endpoint_check({ endpointId: endpointIdFor('normal') });
    expect(successful).toMatchObject({
      ok: true,
      data: { status_code: 200, success: true, error: null }
    });
    expect(successful.data.duration_ms).toEqual(expect.any(Number));
    expect(successful.data.id).toEqual(expect.any(Number));

    const failed = await enabledTools.run_endpoint_check({ endpointId: endpointIdFor('error') });
    expect(failed).toMatchObject({
      ok: true,
      data: { status_code: 500, success: false, error: 'HTTP 500' }
    });
    expect((await enabledTools.run_endpoint_check({ endpointId: 0 })).error.code).toBe('INVALID_ARGUMENT');
    expect(await enabledTools.run_endpoint_check({ endpointId: 9999 })).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Endpoint not found.' }
    });
  });

  it('returns filtered check history and validates filters', async () => {
    const id = endpointIdFor('normal');
    insertCheck(id, true, '2026-11-02T10:00:00.000Z');
    insertCheck(id, false, '2026-11-03T10:00:00.000Z', 'HTTP 503');
    insertCheck(endpointIdFor('error'), false, '2026-11-03T12:00:00.000Z', 'HTTP 500');

    const result = await tools.get_check_history({
      endpointId: id,
      from: '2026-11-03',
      to: '2026-11-03',
      limit: 1
    });
    expect(result).toMatchObject({ ok: true, data: [{ endpoint_id: id, error: 'HTTP 503', success: 0 }] });
    expect((await tools.get_check_history({ endpointId: 0 })).error.code).toBe('INVALID_ARGUMENT');
    expect((await tools.get_check_history({ from: '2026-02-31' })).error.code).toBe('INVALID_ARGUMENT');
    expect((await tools.get_check_history({ limit: 1001 })).error.code).toBe('INVALID_ARGUMENT');
    expect((await tools.get_check_history({ other: 'ignored?' })).error.code).toBe('INVALID_ARGUMENT');
  });

  it('summarizes total, successful, failed checks and average latency', async () => {
    const id = endpointIdFor('normal');
    insertCheck(id, true, '2026-11-03T10:00:00.000Z');
    insertCheck(id, false, '2026-11-03T10:01:00.000Z', 'HTTP 503');

    await expect(tools.get_monitoring_summary({ endpointId: id })).resolves.toEqual({
      ok: true,
      data: {
        total_checks: 2,
        successful_checks: 1,
        failed_checks: 1,
        success_rate: 50,
        average_latency_ms: 225
      }
    });
    expect((await tools.get_monitoring_summary({ to: 'not-a-date' })).error.code).toBe('INVALID_ARGUMENT');
  });

  it('loads failures only in the database query', async () => {
    const id = endpointIdFor('normal');
    insertCheck(id, true, '2026-11-03T10:00:00.000Z');
    insertCheck(id, false, '2026-11-03T10:01:00.000Z', 'HTTP 503');

    const result = await tools.get_recent_failures({ endpointId: id });
    expect(result).toMatchObject({
      ok: true,
      data: [{ endpoint_id: id, success: 0, error: 'HTTP 503' }]
    });
    expect(queryLog.at(-1)).toMatch(/c\.success = 0/);
    expect((await tools.get_recent_failures({ limit: 0 })).error.code).toBe('INVALID_ARGUMENT');
  });

  it('bounds and sanitizes agent-facing check errors while preserving status codes', async () => {
    const id = endpointIdFor('error');
    const error = 'HTTP 503 Authorization: Bearer header-secret at https://user:pass@example.com/health?sig=one&key=two&X-Amz-Signature=three#fragment; ' + 'detail '.repeat(100);
    insertCheck(id, false, '2026-11-03T10:01:00.000Z', error);

    const result = await tools.get_recent_failures({ endpointId: id });
    const check = result.data[0];
    expect(check).toMatchObject({ endpoint_id: id, status_code: 503, success: 0 });
    expect(check.error.length).toBeLessThanOrEqual(500);
    expect(check.error).toContain('HTTP 503');
    expect(check.error).toContain('https://example.com/health');
    for (const secret of ['header-secret', 'user:pass', 'sig=one', 'key=two', 'X-Amz-Signature=three', '#fragment']) {
      expect(check.error).not.toContain(secret);
    }
    expect(check).not.toHaveProperty('url');
  });

  it('lists and executes built-in simulations with structured outcomes', async () => {
    await expect(tools.list_simulations({})).resolves.toMatchObject({
      ok: true,
      data: expect.arrayContaining([expect.objectContaining({ key: 'normal' }), expect.objectContaining({ key: 'error' })])
    });
    expect((await tools.list_simulations({ unexpected: true })).error.code).toBe('INVALID_ARGUMENT');
    const enabledTools = createAgentTools({
      db,
      serverPort: server.address().port,
      allowOperationalTools: true
    });
    const checksBefore = Number(db.get('SELECT COUNT(*) AS count FROM checks').count);
    await expect(enabledTools.run_simulation({ key: 'normal' })).resolves.toEqual({
      ok: true,
      data: { status_code: 200, success: true, body: { status: 'ok', simulation: 'normal' } }
    });
    await expect(enabledTools.run_simulation({ key: 'error' })).resolves.toEqual({
      ok: true,
      data: { status_code: 500, success: false, body: { error: 'Simulated server error.' } }
    });
    expect((await enabledTools.run_simulation({ key: 'unknown' })).error.code).toBe('INVALID_ARGUMENT');
    expect((await enabledTools.run_simulation({ key: 12 })).error.code).toBe('INVALID_ARGUMENT');
    expect(Number(db.get('SELECT COUNT(*) AS count FROM checks').count)).toBe(checksBefore);
  });

  it('blocks direct operational handler calls unless server policy enables them', async () => {
    const checksBefore = Number(db.get('SELECT COUNT(*) AS count FROM checks').count);
    expect(await tools.run_endpoint_check({ endpointId: endpointIdFor('normal') })).toEqual({
      ok: false,
      error: { code: 'TOOL_NOT_ALLOWED', message: 'This tool is disabled by server policy.' }
    });
    expect(await tools.run_simulation({ key: 'normal' })).toEqual({
      ok: false,
      error: { code: 'TOOL_NOT_ALLOWED', message: 'This tool is disabled by server policy.' }
    });
    expect(Number(db.get('SELECT COUNT(*) AS count FROM checks').count)).toBe(checksBefore);
  });

  it('returns explicit internal errors when a database operation fails', async () => {
    const failingTools = createAgentTools({
      db: {
        get: () => { throw new Error('database connection detail'); },
        all: () => { throw new Error('database connection detail'); }
      },
      serverPort: server.address().port,
      allowOperationalTools: true
    });
    await expect(failingTools.list_monitors({})).resolves.toEqual({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'The tool could not complete the request.' }
    });
    await expect(failingTools.get_monitoring_summary({})).resolves.toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR' }
    });
    await expect(failingTools.run_endpoint_check({ endpointId: 1 })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR' }
    });
  });
});

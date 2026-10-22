import express from 'express';
import { createDatabase, SIMULATIONS } from './database.js';
import { InputError, validateEndpointInput } from './security.js';
import { runHealthCheck } from './monitor.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function dateFilter(query) {
  const clauses = [];
  const values = [];
  if (query.from !== undefined) {
    if (typeof query.from !== 'string' || !isValidDate(query.from)) {
      throw new InputError('from must be a date in YYYY-MM-DD format.');
    }
    clauses.push('c.checked_at >= ?');
    values.push(`${query.from}T00:00:00.000Z`);
  }
  if (query.to !== undefined) {
    if (typeof query.to !== 'string' || !isValidDate(query.to)) {
      throw new InputError('to must be a date in YYYY-MM-DD format.');
    }
    clauses.push('c.checked_at < ?');
    values.push(new Date(Date.parse(`${query.to}T00:00:00Z`) + 86_400_000).toISOString());
  }
  if (query.from && query.to && query.from > query.to) {
    throw new InputError('from must be on or before to.');
  }
  if (query.endpointId !== undefined) {
    const endpointId = Number(query.endpointId);
    if (!Number.isInteger(endpointId) || endpointId < 1) throw new InputError('endpointId must be a positive integer.');
    clauses.push('c.endpoint_id = ?');
    values.push(endpointId);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values };
}

function isValidDate(value) {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function createApp({ db = createDatabase(), simulations = SIMULATIONS } = {}) {
  const app = express();
  app.locals.db = db;
  app.use(express.json({ limit: '16kb' }));

  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/simulations', (_req, res) => res.json(simulations));
  app.get('/api/simulations/:key', async (req, res) => {
    const { key } = req.params;
    if (!simulations.some((simulation) => simulation.key === key)) {
      return res.status(404).json({ error: 'Simulation not found.' });
    }
    if (key === 'slow') await new Promise((resolve) => setTimeout(resolve, 700));
    if (key === 'timeout') await new Promise((resolve) => setTimeout(resolve, 5000));
    if (key === 'error') return res.status(500).json({ error: 'Simulated server error.' });
    return res.json({ status: 'ok', simulation: key });
  });

  app.get('/api/endpoints', async (_req, res, next) => {
    try {
      const endpoints = await db.all(`
      SELECT e.id, e.name, e.url, e.simulation, e.created_at,
        COUNT(c.id) AS request_count,
        COALESCE(SUM(CASE WHEN c.success THEN 1 ELSE 0 END), 0) AS success_count,
        AVG(c.duration_ms) AS average_latency_ms,
        COALESCE(SUM(CASE WHEN c.success THEN 0 ELSE 1 END), 0) AS error_count,
        MAX(c.checked_at) AS last_checked_at,
        (SELECT latest.success FROM checks latest
          WHERE latest.endpoint_id = e.id
          ORDER BY latest.checked_at DESC, latest.id DESC LIMIT 1) AS last_success
      FROM endpoints e LEFT JOIN checks c ON c.endpoint_id = e.id
      GROUP BY e.id ORDER BY e.id
      `);
      res.json(endpoints.map((endpoint) => {
        const requestCount = Number(endpoint.request_count);
        const successCount = Number(endpoint.success_count);
        return {
          ...endpoint,
          request_count: requestCount,
          success_count: successCount,
          average_latency_ms: endpoint.average_latency_ms == null
            ? null
            : Math.round(Number(endpoint.average_latency_ms) * 10) / 10,
          error_count: Number(endpoint.error_count),
          last_success: endpoint.last_success == null ? null : Number(Boolean(endpoint.last_success)),
          success_rate: requestCount
            ? Number(((successCount / requestCount) * 100).toFixed(1))
            : null
        };
      }));
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
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) throw new InputError('Endpoint id must be a positive integer.');
      const endpoint = await db.get('SELECT * FROM endpoints WHERE id = ?', id);
      if (!endpoint) return res.status(404).json({ error: 'Endpoint not found.' });
      const result = await runHealthCheck(endpoint, req.socket.localPort);
      const checkId = await db.insert(`
        INSERT INTO checks (endpoint_id, status_code, duration_ms, success, error, checked_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `, id, result.statusCode, result.durationMs,
      db.dialect === 'postgres' ? Boolean(result.success) : Number(result.success),
      result.error, new Date().toISOString());
      const check = await db.get(`
        SELECT c.id, c.endpoint_id, e.name AS endpoint_name, c.status_code, c.duration_ms,
          c.success, c.error, c.checked_at
        FROM checks c JOIN endpoints e ON e.id = c.endpoint_id WHERE c.id = ?
      `, checkId);
      res.status(201).json({ ...check, success: Number(Boolean(check.success)) });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/checks', async (req, res, next) => {
    try {
      const filter = dateFilter(req.query);
      const limit = req.query.limit === undefined ? 200 : Number(req.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw new InputError('limit must be an integer between 1 and 1000.');
      }
      const checks = await db.all(`
        SELECT c.id, c.endpoint_id, e.name AS endpoint_name, c.status_code, c.duration_ms,
          c.success, c.error, c.checked_at
        FROM checks c JOIN endpoints e ON e.id = c.endpoint_id
        ${filter.where} ORDER BY c.checked_at DESC, c.id DESC LIMIT ?
      `, ...filter.values, limit);
      res.json(checks.map((check) => ({ ...check, success: Number(Boolean(check.success)) })));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/dashboard', async (req, res, next) => {
    try {
      const filter = dateFilter(req.query);
      const summary = await db.get(`
        SELECT COUNT(*) AS request_count,
          COALESCE(SUM(CASE WHEN c.success THEN 1 ELSE 0 END), 0) AS success_count,
          AVG(c.duration_ms) AS average_latency_ms,
          COALESCE(SUM(CASE WHEN c.success THEN 0 ELSE 1 END), 0) AS error_count
        FROM checks c ${filter.where}
      `, ...filter.values);
      const requestCount = Number(summary.request_count);
      const successCount = Number(summary.success_count);
      res.json({
        ...summary,
        request_count: requestCount,
        success_count: successCount,
        average_latency_ms: summary.average_latency_ms == null
          ? null
          : Math.round(Number(summary.average_latency_ms) * 10) / 10,
        error_count: Number(summary.error_count),
        success_rate: requestCount
          ? Number(((successCount / requestCount) * 100).toFixed(1))
          : null
      });
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
    if (status === 500) console.error(error);
    return res.status(status).json({ error: status === 500 ? 'An unexpected server error occurred.' : error.message });
  });

  return app;
}

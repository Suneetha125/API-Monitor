import express from 'express';
import { createDatabase, SIMULATIONS } from './database.js';
import { InputError, validateEndpointInput } from './security.js';
import {
  executeSimulation,
  getCheckHistory,
  getMonitoringSummary,
  getServiceHealth,
  listMonitors,
  runEndpointCheck
} from './services.js';

export function createApp({ db = createDatabase(), simulations = SIMULATIONS } = {}) {
  const app = express();
  app.locals.db = db;
  app.use(express.json({ limit: '16kb' }));

  app.get('/api/health', async (_req, res, next) => {
    try {
      res.json(await getServiceHealth());
    } catch (error) {
      next(error);
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
      const check = await runEndpointCheck(db, req.params.id, req.socket.localPort);
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
    if (status === 500) console.error(error);
    return res.status(status).json({ error: status === 500 ? 'An unexpected server error occurred.' : error.message });
  });

  return app;
}

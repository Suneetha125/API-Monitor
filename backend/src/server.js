import { createApp } from './app.js';
import { createDatabase, createPostgresDatabase } from './database.js';
import express from 'express';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.PORT ?? 3001);
if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required in production so monitoring data uses persistent storage.');
}
const db = process.env.DATABASE_URL
  ? await createPostgresDatabase(process.env.DATABASE_URL)
  : createDatabase();
const app = createApp({ db });
const host = process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1';

if (process.env.NODE_ENV === 'production') {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const frontendDirectory = resolve(projectRoot, 'frontend', 'dist');
  app.use(express.static(frontendDirectory, { index: false }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(resolve(frontendDirectory, 'index.html'), (error) => {
      if (error) next(error);
    });
  });
}

const server = app.listen(port, host, () => {
  console.log(`PulseCheck listening on http://${host}:${port}`);
});

function shutdown() {
  server.close(() => {
    Promise.resolve(app.locals.db?.close()).finally(() => process.exit(0));
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

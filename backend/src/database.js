import { DatabaseSync } from 'node:sqlite';

export const SIMULATIONS = [
  { key: 'normal', name: 'Healthy response', description: 'Returns a successful JSON response.' },
  { key: 'slow', name: 'Slow response', description: 'Waits before returning a successful response.' },
  { key: 'timeout', name: 'Timeout', description: 'Waits longer than the health-check limit.' },
  { key: 'error', name: 'HTTP 500', description: 'Returns an intentional server error.' }
];

export function createDatabase(filename = process.env.DATABASE_PATH ?? 'pulsecheck.sqlite') {
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const isNewDatabase = !db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'endpoints'"
  ).get();
  db.exec(`
    CREATE TABLE IF NOT EXISTS endpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      simulation TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint_id INTEGER NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
      status_code INTEGER,
      duration_ms INTEGER NOT NULL,
      success INTEGER NOT NULL CHECK (success IN (0, 1)),
      error TEXT,
      checked_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS checks_endpoint_checked_at
      ON checks(endpoint_id, checked_at DESC);
    CREATE INDEX IF NOT EXISTS checks_checked_at
      ON checks(checked_at DESC);
  `);
  if (isNewDatabase) seedDatabase(db);
  return db;
}

function seedDatabase(db) {
  const addEndpoint = db.prepare(
    'INSERT INTO endpoints (name, url, simulation) VALUES (?, ?, ?)'
  );
  for (const simulation of SIMULATIONS) {
    addEndpoint.run(
      simulation.name,
      `simulation://${simulation.key}`,
      simulation.key
    );
  }
}

import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

export const SIMULATIONS = [
  { key: 'normal', name: 'Healthy response', description: 'Returns a successful JSON response.' },
  { key: 'slow', name: 'Slow response', description: 'Waits before returning a successful response.' },
  { key: 'timeout', name: 'Timeout', description: 'Waits longer than the health-check limit.' },
  { key: 'error', name: 'HTTP 500', description: 'Returns an intentional server error.' }
];

function sanitizeInvestigationText(value) {
  if (typeof value !== 'string') return '';
  let text = value.trim();
  if (!text) return '';

  text = text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:authorization\s*[:=]\s*)?(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, 'Authorization: [REDACTED]')
    .replace(/\b(?:authorization|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|id[_ -]?token|client[_ -]?secret|signature|secret|password)\s*[:=]\s*(['"]?)[^\s,;"'`]+/gi, '$1[REDACTED]')
    .replace(/(?:^|[?&])(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|signature|secret|password|token|client[_-]?secret|authorization)=([^&\s]+)/gi, '$1=[REDACTED]')
    .replace(/https?:\/\/[^\s:@/]+:[^@\s/]+@/gi, 'https://[REDACTED_CREDENTIALS]@')
    .replace(/https?:\/\/[^\s]+/gi, (match) => {
      try {
        const url = new URL(match);
        if (url.username || url.password) {
          url.username = '';
          url.password = '';
        }
        for (const key of [...url.searchParams.keys()]) {
          if (/^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|signature|secret|password|token|client[_-]?secret|authorization|auth)$/i.test(key)) {
            url.searchParams.set(key, '[REDACTED]');
          }
        }
        return url.toString();
      } catch {
        return '[REDACTED_URL]';
      }
    })
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]');

  return text.slice(0, 4000);
}

function normalizeInvestigationToolCalls(rawToolCalls) {
  const normalizeToolEntry = (tool) => {
    if (!tool || typeof tool !== 'object') return null;
    const name = typeof tool.name === 'string' ? tool.name.trim() : '';
    if (!name) return null;
    return {
      name,
      success: Boolean(tool.success)
    };
  };

  if (Array.isArray(rawToolCalls)) {
    return rawToolCalls.map(normalizeToolEntry).filter(Boolean);
  }
  if (typeof rawToolCalls === 'string' && rawToolCalls.trim()) {
    try {
      const parsed = JSON.parse(rawToolCalls);
      if (Array.isArray(parsed)) {
        return parsed.map(normalizeToolEntry).filter(Boolean);
      }
    } catch {
      return [];
    }
  }
  return [];
}

function serializeInvestigationTools(toolCalls = []) {
  const safeCalls = normalizeInvestigationToolCalls(toolCalls);
  return JSON.stringify(safeCalls);
}

function buildInvestigationSummary(toolCalls = []) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return 'No tools were used.';
  }
  const calls = toolCalls
    .filter((tool) => tool && typeof tool === 'object')
    .map((tool) => `${tool.name ?? 'unknown'}:${tool.success ? 'ok' : 'failed'}`)
    .slice(0, 10);
  return calls.join(', ');
}

export function normalizeInvestigationRecord(record) {
  if (!record) return null;

  const toolCalls = normalizeInvestigationToolCalls(record.tool_calls);
  const toolCount = toolCalls.length;
  const status = typeof record.status === 'string' ? record.status : 'completed';

  return {
    id: Number(record.id),
    question: sanitizeInvestigationText(record.question),
    answer: sanitizeInvestigationText(record.answer),
    status,
    tool_count: toolCount,
    tool_calls: toolCalls,
    safe_summary: sanitizeInvestigationText(record.safe_summary ?? buildInvestigationSummary(toolCalls)),
    created_at: record.created_at,
    completed_at: record.completed_at
  };
}

export async function saveInvestigationRecord(db, {
  ownerId,
  question,
  answer,
  status = 'completed',
  toolCalls = []
} = {}) {
  if (typeof ownerId !== 'string' || !ownerId.trim()) {
    throw new TypeError('An authenticated investigation owner is required.');
  }
  const safeQuestion = sanitizeInvestigationText(String(question ?? ''));
  const safeAnswer = sanitizeInvestigationText(String(answer ?? ''));
  const currentStatus = ['completed', 'incomplete', 'failed'].includes(status) ? status : 'completed';
  const normalizedToolCalls = normalizeInvestigationToolCalls(toolCalls);
  const safeToolCalls = serializeInvestigationTools(normalizedToolCalls);
  const timestamp = new Date().toISOString();
  const toolCount = normalizedToolCalls.length;
  const summary = buildInvestigationSummary(normalizedToolCalls);
  const insertSql = `INSERT INTO investigations
    (owner_id, question, answer, status, tool_count, tool_calls, safe_summary, created_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  const id = await db.insert(
    insertSql,
    ownerId,
    safeQuestion,
    safeAnswer,
    currentStatus,
    toolCount,
    safeToolCalls,
    summary,
    timestamp,
    timestamp
  );
  const record = await db.get('SELECT * FROM investigations WHERE id = ? AND owner_id = ?', id, ownerId);
  return normalizeInvestigationRecord(record);
}

function parseApprovalJson(value) {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeApprovalRecord(record) {
  if (!record) return null;
  return {
    id: Number(record.id),
    approvalId: record.approval_id,
    investigationId: Number(record.investigation_id),
    toolName: record.tool_name,
    arguments: parseApprovalJson(record.arguments_json),
    status: record.status,
    createdAt: record.created_at,
    expiresAt: record.expires_at,
    executionAt: record.execution_at,
    decidedBy: record.decided_by,
    safeResult: parseApprovalJson(record.safe_result)
  };
}

export async function createApprovalRecord(db, {
  approvalId,
  investigationId,
  ownerId,
  toolName,
  arguments: operationArguments,
  expiresAt
}) {
  const createdAt = new Date().toISOString();
  const argumentsJson = JSON.stringify(operationArguments);
  const result = await db.run(`
    INSERT INTO agent_approvals
      (approval_id, investigation_id, tool_name, arguments_json, status, created_at, expires_at)
    SELECT ?, i.id, ?, ?, 'pending', ?, ?
    FROM investigations i
    WHERE i.id = ? AND i.owner_id = ?
  `, approvalId, toolName, argumentsJson, createdAt, expiresAt, investigationId, ownerId);
  if (Number(result.changes ?? result.rowCount ?? 0) !== 1) {
    throw new Error('The investigation is not available to this owner.');
  }
  return getApprovalRecord(db, approvalId, ownerId);
}

export async function getApprovalRecord(db, approvalId, ownerId) {
  const record = await db.get(`
    SELECT a.id, a.approval_id, a.investigation_id, a.tool_name, a.arguments_json, a.status,
      a.created_at, a.expires_at, a.execution_at, a.decided_by, a.safe_result
    FROM agent_approvals a
    JOIN investigations i ON i.id = a.investigation_id
    WHERE a.approval_id = ? AND i.owner_id = ?
  `, approvalId, ownerId);
  return normalizeApprovalRecord(record);
}

export async function listApprovalRecords(db, investigationId, ownerId, now = new Date().toISOString()) {
  await db.run(`
    UPDATE agent_approvals SET status = 'expired'
    WHERE investigation_id = ? AND status = 'pending' AND expires_at <= ?
      AND investigation_id IN (SELECT id FROM investigations WHERE owner_id = ?)
  `, investigationId, now, ownerId);
  const records = await db.all(`
    SELECT a.id, a.approval_id, a.investigation_id, a.tool_name, a.arguments_json, a.status,
      a.created_at, a.expires_at, a.execution_at, a.decided_by, a.safe_result
    FROM agent_approvals a
    JOIN investigations i ON i.id = a.investigation_id
    WHERE a.investigation_id = ? AND i.owner_id = ?
    ORDER BY a.created_at, a.id
  `, investigationId, ownerId);
  return records.map(normalizeApprovalRecord);
}

export async function expireApprovalRecord(db, approvalId, ownerId, now = new Date().toISOString()) {
  const result = await db.run(`
    UPDATE agent_approvals SET status = 'expired'
    WHERE approval_id = ? AND status = 'pending' AND expires_at <= ?
      AND investigation_id IN (SELECT id FROM investigations WHERE owner_id = ?)
  `, approvalId, now, ownerId);
  return Number(result.changes ?? result.rowCount ?? 0) === 1;
}

export async function claimApprovalRecord(db, approvalId, ownerId, now = new Date().toISOString()) {
  const result = await db.run(`
    UPDATE agent_approvals SET status = 'approved', decided_by = ?
    WHERE approval_id = ? AND status = 'pending' AND expires_at > ?
      AND investigation_id IN (SELECT id FROM investigations WHERE owner_id = ?)
  `, ownerId, approvalId, now, ownerId);
  return Number(result.changes ?? result.rowCount ?? 0) === 1;
}

export async function rejectApprovalRecord(db, approvalId, ownerId, now = new Date().toISOString()) {
  const result = await db.run(`
    UPDATE agent_approvals SET status = 'rejected', decided_by = ?
    WHERE approval_id = ? AND status = 'pending' AND expires_at > ?
      AND investigation_id IN (SELECT id FROM investigations WHERE owner_id = ?)
  `, ownerId, approvalId, now, ownerId);
  return Number(result.changes ?? result.rowCount ?? 0) === 1;
}

export async function finishApprovalRecord(db, approvalId, ownerId, status, safeResult, executionAt = new Date().toISOString()) {
  if (!['executed', 'failed'].includes(status)) {
    throw new TypeError('Approval completion status must be executed or failed.');
  }
  const result = await db.run(`
    UPDATE agent_approvals SET status = ?, execution_at = ?, safe_result = ?
    WHERE approval_id = ? AND status = 'approved'
      AND investigation_id IN (SELECT id FROM investigations WHERE owner_id = ?)
  `, status, executionAt, JSON.stringify(safeResult), approvalId, ownerId);
  return Number(result.changes ?? result.rowCount ?? 0) === 1;
}

export async function getInvestigationRecord(db, id, ownerId) {
  const investigationId = Number(id);
  if (!Number.isInteger(investigationId) || investigationId < 1) {
    return null;
  }
  const record = await db.get(
    'SELECT * FROM investigations WHERE id = ? AND owner_id = ?',
    investigationId,
    ownerId
  );
  return normalizeInvestigationRecord(record);
}

export async function listInvestigationRecords(db, ownerId, { page = 1, limit = 20 } = {}) {
  const pageNumber = Number(page) || 1;
  const pageSize = Number(limit) || 20;
  const safePage = Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber : 1;
  const safeLimit = Number.isInteger(pageSize) && pageSize > 0 && pageSize <= 100 ? pageSize : 20;
  const offset = (safePage - 1) * safeLimit;

  const total = await db.get('SELECT COUNT(*) AS count FROM investigations WHERE owner_id = ?', ownerId);
  const rows = await db.all(
    `SELECT * FROM investigations WHERE owner_id = ?
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    ownerId,
    safeLimit,
    offset
  );
  const investigations = rows.map((row) => normalizeInvestigationRecord(row));
  return {
    investigations,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total: Number(total.count || 0),
      totalPages: Math.max(1, Math.ceil((Number(total.count || 0) || 0) / safeLimit))
    }
  };
}

export async function consumeInvestigationRateLimit(db, ownerId, {
  now = Date.now(),
  windowMs = 15 * 60 * 1000,
  limit = 5
} = {}) {
  if (typeof ownerId !== 'string' || !ownerId.trim()) {
    throw new TypeError('An authenticated investigation owner is required.');
  }
  if (!Number.isInteger(now) || !Number.isInteger(windowMs) || windowMs < 1000 ||
      !Number.isInteger(limit) || limit < 1) {
    throw new TypeError('Investigation rate-limit settings are invalid.');
  }
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const row = await db.get(`
    INSERT INTO agent_rate_limits (owner_id, window_start, request_count)
    VALUES (?, ?, 1)
    ON CONFLICT(owner_id) DO UPDATE SET
      request_count = CASE
        WHEN agent_rate_limits.window_start = excluded.window_start
          THEN agent_rate_limits.request_count + 1
        ELSE 1
      END,
      window_start = excluded.window_start
    RETURNING request_count
  `, ownerId, windowStart);
  const requestCount = Number(row?.request_count);
  if (!Number.isInteger(requestCount) || requestCount < 1) {
    throw new Error('Investigation rate limit could not be recorded.');
  }
  return {
    allowed: requestCount <= limit,
    remaining: Math.max(0, limit - requestCount),
    retryAfterSeconds: Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000))
  };
}

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
    CREATE TABLE IF NOT EXISTS investigations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id TEXT,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('completed', 'incomplete', 'failed')),
      tool_count INTEGER NOT NULL DEFAULT 0,
      tool_calls TEXT NOT NULL DEFAULT '[]',
      safe_summary TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      completed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      approval_id TEXT NOT NULL UNIQUE,
      investigation_id INTEGER NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
      tool_name TEXT NOT NULL,
      arguments_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'executed', 'failed')),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      execution_at TEXT,
      decided_by TEXT,
      safe_result TEXT
    );
    CREATE TABLE IF NOT EXISTS agent_rate_limits (
      owner_id TEXT PRIMARY KEY,
      window_start INTEGER NOT NULL,
      request_count INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS checks_endpoint_checked_at
      ON checks(endpoint_id, checked_at DESC);
    CREATE INDEX IF NOT EXISTS checks_checked_at
      ON checks(checked_at DESC);
    CREATE INDEX IF NOT EXISTS agent_approvals_investigation_created
      ON agent_approvals(investigation_id, created_at, id);
  `);
  const investigationColumns = db.prepare('PRAGMA table_info(investigations)').all();
  if (!investigationColumns.some(({ name }) => name === 'owner_id')) {
    db.exec('ALTER TABLE investigations ADD COLUMN owner_id TEXT');
  }
  const approvalColumns = db.prepare('PRAGMA table_info(agent_approvals)').all();
  if (!approvalColumns.some(({ name }) => name === 'decided_by')) {
    db.exec('ALTER TABLE agent_approvals ADD COLUMN decided_by TEXT');
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS investigations_owner_created
      ON investigations(owner_id, created_at DESC, id DESC);
  `);
  if (isNewDatabase) seedDatabase(db);
  return {
    dialect: 'sqlite',
    prepare: db.prepare.bind(db),
    exec: db.exec.bind(db),
    get: (sql, ...params) => db.prepare(sql).get(...params),
    all: (sql, ...params) => db.prepare(sql).all(...params),
    run: (sql, ...params) => db.prepare(sql).run(...params),
    insert: (sql, ...params) => db.prepare(sql).run(...params).lastInsertRowid,
    close: () => db.close()
  };
}

export async function createPostgresDatabase(connectionString, PoolClass = pg.Pool) {
  if (typeof connectionString !== 'string' || !connectionString.startsWith('postgres')) {
    throw new Error('DATABASE_URL must be a PostgreSQL connection URL.');
  }

  const client = new PoolClass({
    connectionString,
    max: 1,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 15_000
  });
  const db = {
    dialect: 'postgres',
    async get(sql, ...params) {
      const result = await client.query(toPostgresPlaceholders(sql), params);
      return result.rows[0];
    },
    async all(sql, ...params) {
      const result = await client.query(toPostgresPlaceholders(sql), params);
      return result.rows;
    },
    async run(sql, ...params) {
      return client.query(toPostgresPlaceholders(sql), params);
    },
    async insert(sql, ...params) {
      const result = await client.query(
        `${toPostgresPlaceholders(sql)} RETURNING id`,
        params
      );
      return result.rows[0].id;
    },
    async close() {
      await client.end();
    }
  };

  await client.query(`
    CREATE TABLE IF NOT EXISTS endpoints (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      simulation TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS checks (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      endpoint_id INTEGER NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
      status_code INTEGER,
      duration_ms INTEGER NOT NULL,
      success BOOLEAN NOT NULL,
      error TEXT,
      checked_at TIMESTAMPTZ NOT NULL
    )
  `);
  await client.query('CREATE INDEX IF NOT EXISTS checks_endpoint_checked_at ON checks(endpoint_id, checked_at DESC)');
  await client.query('CREATE INDEX IF NOT EXISTS checks_checked_at ON checks(checked_at DESC)');
  await client.query(`
    CREATE TABLE IF NOT EXISTS investigations (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    owner_id TEXT,
    question TEXT NOT NULL,
      answer TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('completed', 'incomplete', 'failed')),
      tool_count INTEGER NOT NULL DEFAULT 0,
      tool_calls JSONB NOT NULL DEFAULT '[]'::jsonb,
      safe_summary TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ NOT NULL
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_approvals (
      id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      approval_id TEXT NOT NULL UNIQUE,
      investigation_id BIGINT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
      tool_name TEXT NOT NULL,
      arguments_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'executed', 'failed')),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      execution_at TEXT,
      decided_by TEXT,
      safe_result TEXT
    )
  `);
  await client.query('ALTER TABLE investigations ADD COLUMN IF NOT EXISTS owner_id TEXT');
  await client.query('ALTER TABLE agent_approvals ADD COLUMN IF NOT EXISTS decided_by TEXT');
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_rate_limits (
      owner_id TEXT PRIMARY KEY,
      window_start BIGINT NOT NULL,
      request_count INTEGER NOT NULL
    )
  `);
  await client.query('CREATE INDEX IF NOT EXISTS agent_approvals_investigation_created ON agent_approvals(investigation_id, created_at, id)');
  await client.query('CREATE INDEX IF NOT EXISTS investigations_owner_created ON investigations(owner_id, created_at DESC, id DESC)');
  await client.query(`
    CREATE TABLE IF NOT EXISTS app_metadata (
      key TEXT PRIMARY KEY
    )
  `);

  const existingEndpoint = await client.query('SELECT id FROM endpoints LIMIT 1');
  const seedMarker = await client.query(`
    INSERT INTO app_metadata (key) VALUES ('simulations_seeded')
    ON CONFLICT (key) DO NOTHING
    RETURNING key
  `);
  if (seedMarker.rowCount > 0 && existingEndpoint.rows.length === 0) {
    for (const simulation of SIMULATIONS) {
      await client.query(`
        INSERT INTO endpoints (name, url, simulation)
        VALUES ($1, $2, $3)
      `, [simulation.name, `simulation://${simulation.key}`, simulation.key]);
    }
  }

  return db;
}

function toPostgresPlaceholders(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
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

import { SIMULATIONS } from './database.js';
import { InputError } from './security.js';
import { runHealthCheck } from './monitor.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(value) {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function positiveInteger(value, label) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(number) || number < 1) {
    throw new InputError(`${label} must be a positive integer.`);
  }
  return number;
}

function getCheckFilter(input) {
  const clauses = [];
  const values = [];
  if (input.from !== undefined) {
    if (typeof input.from !== 'string' || !isValidDate(input.from)) {
      throw new InputError('from must be a date in YYYY-MM-DD format.');
    }
    clauses.push('c.checked_at >= ?');
    values.push(`${input.from}T00:00:00.000Z`);
  }
  if (input.to !== undefined) {
    if (typeof input.to !== 'string' || !isValidDate(input.to)) {
      throw new InputError('to must be a date in YYYY-MM-DD format.');
    }
    clauses.push('c.checked_at < ?');
    values.push(new Date(Date.parse(`${input.to}T00:00:00Z`) + 86_400_000).toISOString());
  }
  if (input.from && input.to && input.from > input.to) {
    throw new InputError('from must be on or before to.');
  }
  if (input.endpointId !== undefined) {
    clauses.push('c.endpoint_id = ?');
    values.push(positiveInteger(input.endpointId, 'endpointId'));
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values };
}

function normalizeSummary(summary) {
  const requestCount = Number(summary.request_count);
  const successCount = Number(summary.success_count);
  return {
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
  };
}

export async function getServiceHealth() {
  return { status: 'ok' };
}

export async function listMonitors(db) {
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
  return endpoints.map((endpoint) => {
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
  });
}

export async function runEndpointCheck(db, idInput, serverPort) {
  const id = positiveInteger(idInput, 'Endpoint id');
  const endpoint = await db.get('SELECT * FROM endpoints WHERE id = ?', id);
  if (!endpoint) return null;
  const result = await runHealthCheck(endpoint, serverPort);
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
  return { ...check, success: Number(Boolean(check.success)) };
}

export async function getCheckHistory(db, input = {}, { failuresOnly = false } = {}) {
  const filter = getCheckFilter(input);
  const limit = input.limit === undefined ? 200 : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new InputError('limit must be an integer between 1 and 1000.');
  }
  const where = [
    filter.where.slice('WHERE '.length),
    ...(failuresOnly ? ['c.success = 0'] : [])
  ].filter(Boolean);
  const checks = await db.all(`
    SELECT c.id, c.endpoint_id, e.name AS endpoint_name, c.status_code, c.duration_ms,
      c.success, c.error, c.checked_at
    FROM checks c JOIN endpoints e ON e.id = c.endpoint_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY c.checked_at DESC, c.id DESC LIMIT ?
  `, ...filter.values, limit);
  return checks.map((check) => ({ ...check, success: Number(Boolean(check.success)) }));
}

export async function getMonitoringSummary(db, input = {}) {
  const filter = getCheckFilter(input);
  const summary = await db.get(`
    SELECT COUNT(*) AS request_count,
      COALESCE(SUM(CASE WHEN c.success THEN 1 ELSE 0 END), 0) AS success_count,
      AVG(c.duration_ms) AS average_latency_ms,
      COALESCE(SUM(CASE WHEN c.success THEN 0 ELSE 1 END), 0) AS error_count
    FROM checks c ${filter.where}
  `, ...filter.values);
  return normalizeSummary(summary);
}

export function listSimulations(simulations = SIMULATIONS) {
  return simulations.map(({ key, name, description }) => ({ key, name, description }));
}

export async function executeSimulation(key, simulations = SIMULATIONS) {
  if (!simulations.some((simulation) => simulation.key === key)) {
    throw new InputError('Simulation not found.');
  }
  if (key === 'slow') await new Promise((resolve) => setTimeout(resolve, 700));
  if (key === 'timeout') await new Promise((resolve) => setTimeout(resolve, 5000));
  if (key === 'error') {
    return { statusCode: 500, body: { error: 'Simulated server error.' } };
  }
  return { statusCode: 200, body: { status: 'ok', simulation: key } };
}

import { consumeInvestigationRateLimit } from './database.js';

export const DEFAULT_INVESTIGATION_RATE_LIMIT = 5;
export const DEFAULT_INVESTIGATION_RATE_WINDOW_MS = 15 * 60 * 1000;

export function createInvestigationRateLimiter({
  db,
  limit = DEFAULT_INVESTIGATION_RATE_LIMIT,
  windowMs = DEFAULT_INVESTIGATION_RATE_WINDOW_MS,
  enabled = () => true
} = {}) {
  if (!db || typeof db.get !== 'function') {
    throw new TypeError('An initialized database adapter is required for investigation rate limiting.');
  }
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowMs) || windowMs < 1000) {
    throw new TypeError('Investigation rate-limit settings are invalid.');
  }

  return async (req, res, next) => {
    if (!enabled()) return next();
    if (typeof req.authenticatedUserId !== 'string' || !req.authenticatedUserId) {
      return res.status(401).json({ success: false, error: 'Authentication is required.' });
    }
    try {
      const result = await consumeInvestigationRateLimit(db, req.authenticatedUserId, {
        limit,
        windowMs
      });
      res.set('RateLimit-Limit', String(limit));
      res.set('RateLimit-Remaining', String(result.remaining));
      res.set('RateLimit-Reset', String(Math.ceil(result.retryAfterSeconds)));
      if (!result.allowed) {
        res.set('Retry-After', String(result.retryAfterSeconds));
        return res.status(429).json({
          success: false,
          error: 'Too many investigation requests. Please try again later.'
        });
      }
      return next();
    } catch {
      console.error('Investigation rate-limit storage is unavailable.');
      return res.status(503).json({
        success: false,
        error: 'The investigation service is temporarily unavailable.'
      });
    }
  };
}

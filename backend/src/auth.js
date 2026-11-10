import { clerkMiddleware as clerkExpressMiddleware, getAuth as getClerkAuth } from '@clerk/express';

export function assertClerkConfiguration({
  secretKey = process.env.CLERK_SECRET_KEY,
  publishableKey = process.env.CLERK_PUBLISHABLE_KEY
} = {}) {
  if (typeof secretKey !== 'string' || !secretKey.trim() ||
      typeof publishableKey !== 'string' || !publishableKey.trim()) {
    throw new Error('CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY are required.');
  }
}

export function createClerkAuthentication({
  middlewareFactory = clerkExpressMiddleware,
  authGetter = getClerkAuth,
  secretKey = process.env.CLERK_SECRET_KEY,
  publishableKey = process.env.CLERK_PUBLISHABLE_KEY
} = {}) {
  const middleware = middlewareFactory({ secretKey, publishableKey });
  return {
    middleware,
    requireAuthenticatedUser(req, res, next) {
      try {
        const auth = authGetter(req);
        if (auth?.isAuthenticated !== true ||
            typeof auth.userId !== 'string' ||
            !auth.userId.trim()) {
          return res.status(401).json({ success: false, error: 'Authentication is required.' });
        }
        req.authenticatedUserId = auth.userId;
        return next();
      } catch {
        return res.status(401).json({ success: false, error: 'Authentication is required.' });
      }
    }
  };
}

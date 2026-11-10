import { createApp } from '../src/app.js';

export function createTestApp(options = {}) {
  const { testDefaultUserId = 'test-user', ...appOptions } = options;
  return createApp({
    ...appOptions,
    clerkMiddlewareFactory: () => (_req, _res, next) => next(),
    authGetter: (req) => {
      const requestedUserId = req.get('x-test-user-id');
      const userId = requestedUserId === 'anonymous'
        ? null
        : requestedUserId || testDefaultUserId;
      return { userId, isAuthenticated: Boolean(userId) };
    }
  });
}

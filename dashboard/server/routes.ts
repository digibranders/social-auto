/**
 * The dashboard's API addresses and which handler answers each. Shared by the production server (server/main.ts) and
 * the local test server (dev/server.ts). Handlers are loaded on first use.
 */
export type Handler = (request: Request) => Response | Promise<Response>;

export const routes: Record<string, { method: string | string[]; load: () => Promise<Handler> } | undefined> = {
  '/api/auth/login': { method: 'POST', load: () => import('../api/auth/[step].js').then((m) => m.POST) },
  '/api/auth/logout': { method: 'POST', load: () => import('../api/auth/[step].js').then((m) => m.POST as Handler) },
  '/api/data': { method: 'GET', load: () => import('../api/data.js').then((m) => m.GET) },
  '/api/analytics-refresh': { method: 'POST', load: () => import('../api/analytics-refresh.js').then((m) => m.POST) },
  '/api/analytics': { method: 'GET', load: () => import('../api/analytics.js').then((m) => m.GET) },
  '/api/inbox': { method: ['GET', 'POST'], load: () => import('../api/inbox.js').then((m) => (request: Request) => (request.method === 'POST' ? m.POST(request) : m.GET(request))) },
  '/api/facebook-start': { method: 'GET', load: () => import('../api/_connect/facebook-start.js').then((m) => m.GET as Handler) },
  '/api/facebook-callback': { method: 'GET', load: () => import('../api/_connect/facebook-callback.js').then((m) => m.GET) },
  '/api/instagram-start': { method: 'GET', load: () => import('../api/_connect/instagram-start.js').then((m) => m.GET as Handler) },
  '/api/instagram-callback': { method: 'GET', load: () => import('../api/_connect/instagram-callback.js').then((m) => m.GET) },
  '/api/linkedin-invite': { method: 'POST', load: () => import('../api/_connect/linkedin-invite.js').then((m) => m.POST as Handler) },
  '/api/linkedin-start': { method: 'GET', load: () => import('../api/_connect/linkedin-start.js').then((m) => m.GET as Handler) },
  '/api/linkedin-callback': { method: 'GET', load: () => import('../api/_connect/linkedin-callback.js').then((m) => m.GET) },
  '/api/google/start': { method: 'GET', load: () => import('../api/google/[step].js').then((m) => m.GET) },
  '/api/google/callback': { method: 'GET', load: () => import('../api/google/[step].js').then((m) => m.GET) },
  '/api/google/pick': { method: ['GET', 'POST'], load: () => import('../api/google/[step].js').then((m) => (request: Request) => (request.method === 'POST' ? m.POST(request) : m.GET(request))) },
  '/api/google/choose': { method: ['GET', 'POST'], load: () => import('../api/google/[step].js').then((m) => (request: Request) => (request.method === 'POST' ? m.POST(request) : m.GET(request))) },
  '/api/disconnect': { method: 'POST', load: () => import('../api/disconnect.js').then((m) => m.POST) },
  '/api/clients': { method: 'POST', load: () => import('../api/clients.js').then((m) => m.POST) },
  '/api/manual': { method: 'POST', load: () => import('../api/manual.js').then((m) => m.POST) },
  '/api/pause': { method: 'POST', load: () => import('../api/pause.js').then((m) => m.POST) },
  '/api/edit': { method: 'POST', load: () => import('../api/edit.js').then((m) => m.POST) },
  '/api/review': { method: ['GET', 'POST'], load: () => import('../api/review.js').then((m) => (request: Request) => (request.method === 'POST' ? m.POST(request) : m.GET(request))) },
};

export type Match = { kind: 'ok'; route: NonNullable<(typeof routes)[string]> } | { kind: 'not-found' } | { kind: 'method-not-allowed' };

/** The route for a request, or why there is none. */
export function matchRoute(method: string, pathname: string): Match {
  const route = routes[pathname.replace(/\/+$/, '') || '/'];
  if (!route) return { kind: 'not-found' };
  if (![route.method].flat().includes(method)) return { kind: 'method-not-allowed' };
  return { kind: 'ok', route };
}

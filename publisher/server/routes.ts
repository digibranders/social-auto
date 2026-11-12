/**
 * The publisher's addresses and which handler answers each. Shared by the production server (server/main.ts) and the
 * local test server (dev/server.ts). Handlers are loaded on first use.
 */
export type Handler = (request: Request) => Response | Promise<Response>;

export const routes: Record<string, { method: string; load: () => Promise<Handler> } | undefined> = {
  '/api/cron': { method: 'GET', load: () => import('../api/cron.js').then((m) => m.GET) },
  '/api/status': { method: 'GET', load: () => import('../api/status.js').then((m) => m.GET) },
  '/api/channels': { method: 'POST', load: () => import('../api/channels.js').then((m) => m.POST) },
  '/api/v1/workspaces': { method: 'ANY', load: async () => { const m = await import('../api/_v1/workspaces.js'); return (request) => (request.method === 'POST' ? m.POST(request) : m.GET(request)); } },
  '/api/v1/pictures': { method: 'POST', load: () => import('../api/_v1/pictures.js').then((m) => m.POST) },
  '/api/v1/posts': { method: 'ANY', load: async () => { const m = await import('../api/_v1/posts.js'); return (request) => (request.method === 'POST' ? m.POST(request) : request.method === 'DELETE' ? m.DELETE(request) : request.method === 'PATCH' ? m.PATCH(request) : m.GET(request)); } },
  '/api/v1/site-jobs': { method: 'ANY', load: async () => { const m = await import('../api/_v1/site-jobs.js'); return (request) => (request.method === 'POST' ? m.POST(request) : m.GET(request)); } },
  '/api/v1/facts': { method: 'ANY', load: async () => { const m = await import('../api/_v1/facts.js'); return (request) => (request.method === 'POST' ? m.POST(request) : m.GET(request)); } },
  '/api/v1/batches': { method: 'ANY', load: async () => { const m = await import('../api/_v1/batches.js'); return (request) => (request.method === 'POST' ? m.POST(request) : m.GET(request)); } },
  '/api/v1/posters': { method: 'ANY', load: async () => { const m = await import('../api/_v1/posters.js'); return (request) => (request.method === 'POST' ? m.POST(request) : m.GET(request)); } },
  '/api/v1/events': { method: 'GET', load: () => import('../api/_v1/events.js').then((m) => m.GET) },
  '/api/v1/analytics': { method: 'GET', load: () => import('../api/_v1/analytics.js').then((m) => m.GET) },
  '/api/v1/topics': { method: 'GET', load: () => import('../api/_v1/topics.js').then((m) => m.GET) },
  '/api/v1/workspaces/archive': { method: 'POST', load: () => import('../api/_v1/workspace-archive.js').then((m) => m.POST) },
  '/api/v1/send': { method: 'POST', load: () => import('../api/_v1/send.js').then((m) => m.POST) },
  '/api/v1/connect-link': { method: 'POST', load: () => import('../api/_v1/connect-link.js').then((m) => m.POST) },
  '/api/clients': { method: 'POST', load: () => import('../api/clients.js').then((m) => m.POST) },
  '/api/pause': { method: 'ANY', load: async () => { const m = await import('../api/pause.js'); return (request) => (request.method === 'POST' ? m.POST(request) : m.GET(request)); } },
  '/api/manual': { method: 'POST', load: () => import('../api/manual.js').then((m) => m.POST) },
  '/api/edit': { method: 'POST', load: () => import('../api/edit.js').then((m) => m.POST) },
  '/api/edited-image': { method: 'GET', load: () => import('../api/edited-image.js').then((m) => m.GET) },
  '/api/facebook-connect': { method: 'POST', load: () => import('../api/_connect/facebook.js').then((m) => m.POST) },
  '/api/instagram-connect': { method: 'POST', load: () => import('../api/_connect/instagram.js').then((m) => m.POST) },
  '/api/analytics': { method: 'GET', load: () => import('../api/analytics.js').then((m) => m.GET) },
  '/api/analytics-refresh': { method: 'POST', load: () => import('../api/analytics-refresh.js').then((m) => m.POST) },
  '/api/analytics-collect': { method: 'GET', load: () => import('../api/analytics-collect.js').then((m) => m.GET) },
  '/api/inbox': { method: 'ANY', load: async () => { const m = await import('../api/inbox.js'); return (request) => (request.method === 'POST' ? m.POST(request) : m.GET(request)); } },
  '/api/inbox-collect': { method: 'GET', load: () => import('../api/inbox-collect.js').then((m) => m.GET) },
  '/api/refresh': { method: 'GET', load: () => import('../api/refresh.js').then((m) => m.GET) },
  '/api/google-connect': { method: 'POST', load: () => import('../api/_connect/google.js').then((m) => m.POST) },
  '/api/linkedin-connect': { method: 'POST', load: () => import('../api/_connect/linkedin.js').then((m) => m.POST) },
};


export type Match = { kind: 'ok'; route: NonNullable<(typeof routes)[string]> } | { kind: 'not-found' } | { kind: 'method-not-allowed' };

/** The route for a request, or why there is none. */
export function matchRoute(method: string, pathname: string): Match {
  const route = routes[pathname.replace(/\/+$/, '') || '/'];
  if (!route) return { kind: 'not-found' };
  if (route.method !== 'ANY' && route.method !== method) return { kind: 'method-not-allowed' };
  return { kind: 'ok', route };
}

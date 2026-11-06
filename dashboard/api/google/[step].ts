/**
 * One function for the whole "Connect Google" hand-off, because the free Vercel plan allows only 12 functions per
 * project. The handlers live in ../_google (a folder starting with "_" is not a function of its own).
 *
 * GET  /api/google/start?brand=<client>
 * GET  /api/google/callback?code=...&state=...
 * GET  /api/google/pick          POST /api/google/pick?location=<id>     (signed-in team members, from the dashboard)
 * GET  /api/google/choose        POST /api/google/choose                 (a client with no login: plain page and form)
 */
import * as callback from '../_google/callback.js';
import * as choose from '../_google/choose.js';
import * as pick from '../_google/pick.js';
import * as start from '../_google/start.js';
import { json } from '../../lib/http.js';

const stepOf = (request: Request): string => new URL(request.url).pathname.replace(/\/+$/, '').split('/').pop() ?? '';

export function GET(request: Request): Response | Promise<Response> {
  switch (stepOf(request)) {
    case 'start':
      return start.GET(request);
    case 'callback':
      return callback.GET(request);
    case 'pick':
      return pick.GET(request);
    case 'choose':
      return choose.GET(request);
    default:
      return json(404, { error: 'Not found' });
  }
}

export function POST(request: Request): Response | Promise<Response> {
  switch (stepOf(request)) {
    case 'pick':
      return pick.POST(request);
    case 'choose':
      return choose.POST(request);
    default:
      return json(404, { error: 'Not found' });
  }
}

/**
 * One function for signing in and out, because the free Vercel plan allows only 12 functions per project.
 * The handlers live in ../_auth (a folder starting with "_" is not a function of its own).
 *
 * POST /api/auth/login   { "password": "..." }
 * POST /api/auth/logout
 */
import * as login from '../_auth/login.js';
import * as logout from '../_auth/logout.js';
import { json } from '../../lib/http.js';

export function POST(request: Request): Response | Promise<Response> {
  switch (new URL(request.url).pathname.replace(/\/+$/, '').split('/').pop()) {
    case 'login':
      return login.POST(request);
    case 'logout':
      return logout.POST();
    default:
      return json(404, { error: 'Not found' });
  }
}

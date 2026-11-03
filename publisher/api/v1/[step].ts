/**
 * One function for the whole product API, because the free Vercel plan allows only 12 functions per project. The
 * handlers live in ../_v1 (a folder starting with "_" is not a function of its own); the addresses are unchanged.
 *
 * POST|GET /api/v1/workspaces      POST /api/v1/connect-link      POST /api/v1/pictures
 * POST /api/v1/send
 * POST|GET|PATCH|DELETE /api/v1/posts
 */
import { json } from '../../lib/http.js';
import * as connectLink from '../_v1/connect-link.js';
import * as pictures from '../_v1/pictures.js';
import * as posts from '../_v1/posts.js';
import * as send from '../_v1/send.js';
import * as workspaces from '../_v1/workspaces.js';

const stepOf = (request: Request): string => new URL(request.url).pathname.replace(/\/+$/, '').split('/').pop() ?? '';

export function GET(request: Request): Response | Promise<Response> {
  switch (stepOf(request)) {
    case 'workspaces':
      return workspaces.GET(request);
    case 'posts':
      return posts.GET(request);
    default:
      return json(404, { error: 'Not found' });
  }
}

export function POST(request: Request): Response | Promise<Response> {
  switch (stepOf(request)) {
    case 'workspaces':
      return workspaces.POST(request);
    case 'connect-link':
      return connectLink.POST(request);
    case 'pictures':
      return pictures.POST(request);
    case 'posts':
      return posts.POST(request);
    case 'send':
      return send.POST(request);
    default:
      return json(404, { error: 'Not found' });
  }
}

export function DELETE(request: Request): Response | Promise<Response> {
  return stepOf(request) === 'posts' ? posts.DELETE(request) : json(404, { error: 'Not found' });
}

export function PATCH(request: Request): Response | Promise<Response> {
  return stepOf(request) === 'posts' ? posts.PATCH(request) : json(404, { error: 'Not found' });
}

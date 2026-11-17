/**
 * One function for the whole product API, because the free Vercel plan allows only 12 functions per project. The
 * handlers live in ../_v1 (a folder starting with "_" is not a function of its own); the addresses are unchanged.
 *
 * POST|GET /api/v1/workspaces      POST /api/v1/connect-link      POST /api/v1/pictures
 * POST /api/v1/send
 * POST|GET|PATCH|DELETE /api/v1/posts
 * POST|GET /api/v1/site-jobs      POST|GET /api/v1/facts      POST|GET /api/v1/batches
 * POST|GET /api/v1/posters      GET /api/v1/events      GET /api/v1/topics      GET /api/v1/analytics      GET /api/v1/limits
 */
import { json } from '../../lib/http.js';
import * as analytics from '../_v1/analytics.js';
import * as batches from '../_v1/batches.js';
import * as connectLink from '../_v1/connect-link.js';
import * as events from '../_v1/events.js';
import * as facts from '../_v1/facts.js';
import * as pictures from '../_v1/pictures.js';
import * as limits from '../_v1/limits.js';
import * as posters from '../_v1/posters.js';
import * as posts from '../_v1/posts.js';
import * as send from '../_v1/send.js';
import * as siteJobs from '../_v1/site-jobs.js';
import * as topics from '../_v1/topics.js';
import * as workspaceArchive from '../_v1/workspace-archive.js';
import * as workspaceBilling from '../_v1/workspace-billing.js';
import * as workspaces from '../_v1/workspaces.js';

const stepOf = (request: Request): string => new URL(request.url).pathname.replace(/\/+$/, '').split('/').pop() ?? '';

export function GET(request: Request): Response | Promise<Response> {
  switch (stepOf(request)) {
    case 'workspaces':
      return workspaces.GET(request);
    case 'posts':
      return posts.GET(request);
    case 'site-jobs':
      return siteJobs.GET(request);
    case 'facts':
      return facts.GET(request);
    case 'batches':
      return batches.GET(request);
    case 'posters':
      return posters.GET(request);
    case 'events':
      return events.GET(request);
    case 'topics':
      return topics.GET(request);
    case 'limits':
      return limits.GET(request);
    case 'analytics':
      return analytics.GET(request);
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
    case 'archive':
      return workspaceArchive.POST(request);
    case 'billing':
      return workspaceBilling.POST(request);
    case 'site-jobs':
      return siteJobs.POST(request);
    case 'facts':
      return facts.POST(request);
    case 'batches':
      return batches.POST(request);
    case 'posters':
      return posters.POST(request);
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

/**
 * One function for the "connect a channel" hand-offs (the start and callback pages of Facebook, Instagram and LinkedIn, and
 * the LinkedIn/Instagram invite), because the free Vercel plan allows only 12 functions per project. The handlers live in
 * ./_connect (a folder starting with "_" is not a function of its own); vercel.json rewrites the original addresses here,
 * so the redirect addresses saved in the Meta and LinkedIn apps keep working.
 *
 * GET  /api/facebook-start | /api/facebook-callback | /api/instagram-start | /api/instagram-callback
 *      /api/linkedin-start | /api/linkedin-callback
 * POST /api/linkedin-invite
 */
import * as facebookCallback from './_connect/facebook-callback.js';
import * as facebookStart from './_connect/facebook-start.js';
import * as instagramCallback from './_connect/instagram-callback.js';
import * as instagramStart from './_connect/instagram-start.js';
import * as linkedinCallback from './_connect/linkedin-callback.js';
import * as linkedinInvite from './_connect/linkedin-invite.js';
import * as linkedinStart from './_connect/linkedin-start.js';
import { json } from '../lib/http.js';

/** The step comes from the rewrite's `step` value, or failing that from the last part of the address that was called. */
function stepOf(request: Request): string {
  const url = new URL(request.url);
  return url.searchParams.get('step') ?? url.pathname.replace(/\/+$/, '').split('/').pop() ?? '';
}

export function GET(request: Request): Response | Promise<Response> {
  switch (stepOf(request)) {
    case 'facebook-start':
      return facebookStart.GET(request);
    case 'facebook-callback':
      return facebookCallback.GET(request);
    case 'instagram-start':
      return instagramStart.GET(request);
    case 'instagram-callback':
      return instagramCallback.GET(request);
    case 'linkedin-start':
      return linkedinStart.GET(request);
    case 'linkedin-callback':
      return linkedinCallback.GET(request);
    default:
      return json(404, { error: 'Not found' });
  }
}

export function POST(request: Request): Response | Promise<Response> {
  return stepOf(request) === 'linkedin-invite' ? linkedinInvite.POST(request) : json(404, { error: 'Not found' });
}

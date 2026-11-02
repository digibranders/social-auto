/**
 * One function for every "save what the person approved" call the dashboard's server makes, because the free Vercel plan
 * allows only 12 functions per project. The handlers live in ./_connect (a folder starting with "_" is not a function of
 * its own); vercel.json rewrites the original addresses here, so they keep working.
 *
 * POST /api/facebook-connect | /api/instagram-connect | /api/linkedin-connect | /api/google-connect
 */
import { json } from '../lib/http.js';
import * as facebook from './_connect/facebook.js';
import * as google from './_connect/google.js';
import * as instagram from './_connect/instagram.js';
import * as linkedin from './_connect/linkedin.js';

/** The step comes from the rewrite's `step` value, or failing that from the last part of the address that was called. */
function stepOf(request: Request): string {
  const url = new URL(request.url);
  return url.searchParams.get('step') ?? url.pathname.replace(/\/+$/, '').split('/').pop() ?? '';
}

export function POST(request: Request): Response | Promise<Response> {
  switch (stepOf(request)) {
    case 'facebook-connect':
      return facebook.POST(request);
    case 'google-connect':
      return google.POST(request);
    case 'instagram-connect':
      return instagram.POST(request);
    case 'linkedin-connect':
      return linkedin.POST(request);
    default:
      return json(404, { error: 'Not found' });
  }
}

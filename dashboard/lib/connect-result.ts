import { isSignedIn } from './security.js';

export type Platform = 'facebook' | 'linkedin' | 'instagram' | 'google';
export type Outcome = 'connected' | 'denied' | 'failed' | 'expired' | 'nolocation' | 'inuse';

const NAME: Record<Platform, string> = { facebook: 'Facebook', linkedin: 'LinkedIn', instagram: 'Instagram', google: 'Google Business listing' };

function messageFor(platform: Platform, outcome: Outcome): { title: string; body: string } {
  const name = NAME[platform];
  switch (outcome) {
    case 'connected':
      return { title: 'You are connected', body: `Thank you. Your ${name} is now linked, and posts will appear there. You can close this page.` };
    case 'denied':
      return { title: 'Nothing was connected', body: 'You chose not to allow it, so nothing was linked. If that was a mistake, open the link again and press Allow.' };
    case 'expired':
      return { title: 'This link has run out of time', body: 'Please open the link you were sent again and press Allow. If it keeps failing, tell the person who sent it.' };
    case 'nolocation':
      return { title: 'No business listing found', body: 'That Google account does not manage a business listing. Please open the link again and sign in with the account that manages it. If it keeps failing, tell the person who sent it.' };
    case 'inuse':
      return { title: 'That account is already connected', body: `This ${name} is already connected somewhere else, so we did not change anything. Go back and choose whether to move it, or connect a different account.` };
    case 'failed':
      return { title: 'That did not work', body: 'The connection could not be completed. Please open the link again and press Allow. If it keeps failing, tell the person who sent it.' };
  }
}

/**
 * Where a person lands after Facebook, Instagram or LinkedIn sends them back. A person sent by a product returns to that
 * product's page, which shows the result itself. A signed-in team member returns to the dashboard. Anyone else
 * (a client with no login) sees a plain thank-you page.
 */
export function finishConnect(options: {
  request: Request;
  platform: Platform;
  outcome: Outcome;
  clearCookie: string;
  brand?: string;
  returnUrl?: string | null;
  /** With `inuse`: the customer's other brand that holds the account (never set for someone else's). */
  heldBy?: string;
  /** More cookies to set besides `clearCookie`. */
  extraCookies?: readonly string[];
}): Response {
  const { request, platform, outcome } = options;
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', options.clearCookie);
  for (const cookie of options.extraCookies ?? []) headers.append('Set-Cookie', cookie);
  if (options.returnUrl) {
    const back = new URL(options.returnUrl);
    // A product only knows connected, denied or failed; why it failed rides along as `reason` for a product that wants to say so.
    back.searchParams.set('social', outcome === 'expired' || outcome === 'nolocation' || outcome === 'inuse' ? 'failed' : outcome);
    back.searchParams.set('channel', platform);
    if (outcome === 'expired') back.searchParams.set('reason', 'EXPIRED');
    if (outcome === 'nolocation') back.searchParams.set('reason', 'NO_LOCATION');
    if (outcome === 'inuse') {
      back.searchParams.set('reason', 'ACCOUNT_IN_USE');
      if (options.heldBy) back.searchParams.set('heldBy', options.heldBy);
    }
    headers.set('Location', back.toString());
    return new Response(null, { status: 302, headers });
  }
  if (isSignedIn(request, process.env['SESSION_SECRET'], Date.now())) {
    const where = options.brand ? `#/client/${options.brand}/channels` : '';
    headers.set('Location', new URL(`/?${platform}=${outcome}${where}`, request.url).toString());
    return new Response(null, { status: 302, headers });
  }
  const { title, body } = messageFor(platform, outcome);
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <meta name="color-scheme" content="light dark" />
    <title>${title}</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body class="login-page">
    <main class="login">
      <h1>${title}</h1>
      <p class="muted">${body}</p>
    </main>
  </body>
</html>
`;
  headers.set('Content-Type', 'text/html; charset=utf-8');
  return new Response(html, { status: outcome === 'connected' || outcome === 'denied' ? 200 : 400, headers });
}

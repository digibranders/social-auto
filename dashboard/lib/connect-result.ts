import { isSignedIn } from './security.js';

export type Platform = 'facebook' | 'linkedin' | 'instagram';
export type Outcome = 'connected' | 'denied' | 'failed' | 'expired';

const NAME: Record<Platform, string> = { facebook: 'Facebook', linkedin: 'LinkedIn', instagram: 'Instagram' };

function messageFor(platform: Platform, outcome: Outcome): { title: string; body: string } {
  const name = NAME[platform];
  switch (outcome) {
    case 'connected':
      return { title: 'You are connected', body: `Thank you. Your ${name} is now linked, and posts will appear there. You can close this page.` };
    case 'denied':
      return { title: 'Nothing was connected', body: 'You chose not to allow it, so nothing was linked. If that was a mistake, open the link again and press Allow.' };
    case 'expired':
      return { title: 'This link has run out of time', body: 'Please open the link you were sent again and press Allow. If it keeps failing, tell the person who sent it.' };
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
}): Response {
  const { request, platform, outcome } = options;
  const headers = { 'Set-Cookie': options.clearCookie, 'Cache-Control': 'no-store' };
  if (options.returnUrl) {
    const back = new URL(options.returnUrl);
    // A product only knows connected, denied or failed.
    back.searchParams.set('social', outcome === 'expired' ? 'failed' : outcome);
    back.searchParams.set('channel', platform);
    return new Response(null, { status: 302, headers: { ...headers, Location: back.toString() } });
  }
  if (isSignedIn(request, process.env['SESSION_SECRET'], Date.now())) {
    const where = options.brand ? `#/client/${options.brand}/channels` : '';
    return new Response(null, { status: 302, headers: { ...headers, Location: new URL(`/?${platform}=${outcome}${where}`, request.url).toString() } });
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
  return new Response(html, { status: outcome === 'connected' || outcome === 'denied' ? 200 : 400, headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
}

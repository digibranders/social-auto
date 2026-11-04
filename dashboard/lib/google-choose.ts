import type { LocationChoice } from './google-publisher.js';

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * The page a client with no login sees when their Google account manages several business locations: one button per
 * location, sent as a plain form (no scripts). Location names come from Google, so they are escaped.
 */
export function chooserPage(choices: readonly LocationChoice[]): string {
  const buttons = choices.map((c) => `        <button class="btn" type="submit" name="location" value="${escapeHtml(c.id)}">${escapeHtml(c.title)}</button>`).join('\n');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <meta name="color-scheme" content="light dark" />
    <title>Choose your listing</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body class="login-page">
    <main class="login">
      <h1>Which listing is yours?</h1>
      <p class="muted">Your Google account manages several business listings. Choose the one we should post to.</p>
      <form method="post" action="/api/google/choose">
${buttons}
      </form>
    </main>
  </body>
</html>
`;
}

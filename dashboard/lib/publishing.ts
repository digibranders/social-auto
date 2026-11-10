/**
 * The dashboard's copy of the publishing switch: SOCIAL_PUBLISHING_ENABLED is a server setting that is off unless it is exactly "true". While it is
 * off, nothing the dashboard can do makes a post go out: hand-made posts cannot be created and a post's caption or picture cannot be changed.
 * Nothing in a request can turn it on.
 */
export const publishingEnabled = (env: Readonly<Record<string, string | undefined>> = process.env): boolean => env['SOCIAL_PUBLISHING_ENABLED'] === 'true';

export const PUBLISHING_OFF_MESSAGE = 'Publishing is switched off on this server, so posts cannot be created or changed here. Approved posters can be downloaded from the Review page.';

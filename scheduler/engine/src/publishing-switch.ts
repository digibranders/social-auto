/**
 * The one switch that decides whether anything may leave for a social platform. It is a server setting, SOCIAL_PUBLISHING_ENABLED, and it is off
 * unless it is exactly "true": a missing, empty, misspelt or differently cased value means off. No plan field, render mode, flag or request can turn
 * it on; it is read from the process environment at the moment of use. It is checked at every layer that could send something (the autopilot's
 * scheduling and export targets, the scheduling and export functions, and the scheduler client that makes the actual calls), so a mistake in one
 * layer cannot let a post out. Approval is a separate rule that always applies on top of this one; the switch never replaces it.
 */

export class PublishingDisabledError extends Error {
  constructor(what: string) {
    super(`Publishing is switched off, so ${what} was not done. Set SOCIAL_PUBLISHING_ENABLED=true on the server to allow it.`);
    this.name = 'PublishingDisabledError';
  }
}

export const publishingEnabled = (env: Readonly<Record<string, string | undefined>> = process.env): boolean => env['SOCIAL_PUBLISHING_ENABLED'] === 'true';

/** Throws unless publishing is switched on. `what` names the thing that was refused. */
export function assertPublishingEnabled(what: string, env: Readonly<Record<string, string | undefined>> = process.env): void {
  if (!publishingEnabled(env)) throw new PublishingDisabledError(what);
}

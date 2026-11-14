/**
 * The ask for a release pass. When a customer's decision changes what is approved (approve, or take it back), the review service writes this small file in
 * the brands folder; on the server a systemd path unit watches it and starts `campaign-runner.ts --release-only`, so the calendar follows within seconds
 * instead of at the next five-minute timer. Where no unit watches it, the file does nothing and the timer still releases as before.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const RELEASE_REQUEST_FILE = '.release-requested';

/** Writes the ask. A failure is told to the log and never fails the decision that was just made. */
export function requestRelease(brandsRoot: string, now: Date = new Date()): void {
  try {
    writeFileSync(join(brandsRoot, RELEASE_REQUEST_FILE), `${now.toISOString()}\n`);
  } catch (error) {
    console.error(`could not ask for a release: ${error instanceof Error ? error.message : String(error)}`);
  }
}

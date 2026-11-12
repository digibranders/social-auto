/**
 * A structural guard over the source tree: every place that can send something to a social platform (or hand posts to the program that does) is
 * known, and each one is behind the publishing switch. A new sender added later without the switch fails here, so the list in
 * docs/publishing-audit.md cannot quietly go out of date.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..', '..');

function sources(dir: string, include: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path, include));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && include(path)) out.push(path);
  }
  return out;
}
const text = (path: string): string => readFileSync(path, 'utf8');
const rel = (path: string): string => relative(REPO, path);

test('engine: the only code that makes network calls is the AI clients, the crawler, the guard proxy and the scheduler client, and the scheduler client is behind the switch', () => {
  const engine = join(REPO, 'scheduler', 'engine', 'src');
  const callers = sources(engine, () => true).filter((p) => /\bfetch\(|httpsRequest\(|httpRequest\(|\bhttps?\.request\(|netConnect\(/.test(text(p))).map((p) => rel(p)).sort();
  // (The AI clients and the crawler reach the network through an injected fetch function, so they are listed by the host check below, not here.)
  assert.deepEqual(callers, [
    'scheduler/engine/src/guard-proxy.ts',
    'scheduler/engine/src/scheduler-client.ts',
  ]);
  // The other network users go through these three: no file talks to a platform host directly.
  const hosts = sources(engine, () => true).filter((p) => /graph\.facebook\.com|graph\.instagram\.com|api\.linkedin\.com|mybusiness\.googleapis|googleapis\.com\/.*localPosts/.test(text(p)));
  assert.deepEqual(hosts.map(rel), []);
  const client = text(join(engine, 'scheduler-client.ts'));
  assert.equal((client.match(/assertPublishingEnabled\(/g) ?? []).length >= 2, true, 'upload and schedule both check the switch');
});

test('engine: every code path that schedules or exports checks the switch', () => {
  const engine = join(REPO, 'scheduler', 'engine', 'src');
  for (const file of ['schedule.ts', 'export-publisher.ts']) assert.match(text(join(engine, file)), /assertPublishingEnabled\(/, file);
  const autopilot = text(join(engine, 'autopilot.ts'));
  assert.match(autopilot, /route === 'template' && !values\['dry-run'\]\) assertPublishingEnabled\(/);
  // The AI route returns before anything is scheduled or exported.
  const aiBranch = autopilot.slice(autopilot.indexOf("if (route === 'ai' && !values['plan-only'])"), autopilot.indexOf("if (values['plan-only']) {"));
  assert.doesNotMatch(aiBranch, /schedulePlan\(|exportToPublisher\(/);
  assert.match(aiBranch, /return;/);
});

test('dashboard: the routes that talk to the publisher are exactly the known ones, and those that create or change a post are behind the switch', () => {
  const api = join(REPO, 'dashboard', 'api');
  const reaching = sources(api, () => true).filter((p) => /EDIT_URL|EDIT_SECRET/.test(text(p))).map(rel).sort();
  // Connection and client management and pausing (pausing only stops sending, so the switch never blocks it; no post is created or changed by these) and the two routes that do create or change posts. A new route that talks to
  // the publisher fails here until it is looked at and added to this list.
  assert.deepEqual(reaching, [
    'dashboard/api/_connect/facebook-callback.ts',
    'dashboard/api/_connect/instagram-callback.ts',
    'dashboard/api/_connect/linkedin-callback.ts',
    'dashboard/api/_google/callback.ts',
    'dashboard/api/analytics-refresh.ts',
    'dashboard/api/clients.ts',
    'dashboard/api/disconnect.ts',
    'dashboard/api/edit.ts',
    'dashboard/api/inbox.ts',
    'dashboard/api/manual.ts',
    'dashboard/api/pause.ts',
  ]);
  for (const file of ['edit.ts', 'manual.ts', 'inbox.ts']) assert.match(text(join(api, file)), /publishingEnabled\(\)/, file);
});

test('the weekly client run cannot become the approval-queue route by default', () => {
  assert.match(text(join(REPO, 'scheduler', 'engine', 'src', 'run-clients.ts')), /'--route', 'template'/);
});

test('the review service and the engine have no platform credentials in their example settings', () => {
  const review = text(join(REPO, 'deploy', 'env', 'review.env.example'));
  for (const name of ['INSTAGRAM_TOKEN', 'FACEBOOK_APP_SECRET', 'LINKEDIN_CLIENT_SECRET', 'GOOGLE_CLIENT_SECRET', 'SCHEDULER_API_KEY', 'CRON_SECRET', 'EDIT_SECRET']) assert.doesNotMatch(review, new RegExp(`^${name}=`, 'm'), name);
  assert.match(review, /^SOCIAL_PUBLISHING_ENABLED=false$/m);
  const unit = text(join(REPO, 'deploy', 'systemd', 'social-review.service'));
  assert.doesNotMatch(unit, /publisher\.env|dashboard\.env/, 'the review service does not read the publisher\'s or the dashboard\'s secrets');
  assert.match(unit, /NoNewPrivileges=true/);
  assert.match(unit, /HOST=127\.0\.0\.1/);
});

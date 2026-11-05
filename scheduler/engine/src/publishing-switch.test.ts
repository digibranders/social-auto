import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { exportToPublisher } from './export-publisher.ts';
import { assertPublishingEnabled, PublishingDisabledError, publishingEnabled } from './publishing-switch.ts';
import { schedulePlan } from './schedule.ts';
import { SchedulerClient } from './scheduler-client.ts';

const originalFetch = globalThis.fetch;
const originalSwitch = process.env['SOCIAL_PUBLISHING_ENABLED'];
let networkCalls = 0;
let root: string;

beforeEach(async () => {
  delete process.env['SOCIAL_PUBLISHING_ENABLED'];
  networkCalls = 0;
  globalThis.fetch = (async () => {
    networkCalls += 1;
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  root = await mkdtemp(join(tmpdir(), 'switch-'));
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalSwitch === undefined) delete process.env['SOCIAL_PUBLISHING_ENABLED'];
  else process.env['SOCIAL_PUBLISHING_ENABLED'] = originalSwitch;
  await rm(root, { recursive: true, force: true });
});

const planWith = (extra: Record<string, unknown>): Record<string, unknown> => ({
  brand: 'acme', timezone: 'Asia/Kolkata',
  posts: [{ id: 'w01-d1', date: '2099-01-01T10:00:00+05:30', painPoint: 'p', mode: 'ai', headline: 'H', subline: '', caption: 'C', hashtags: ['#a'], approval: { status: 'approved' } }],
  ...extra,
});

async function brandWith(plan: Record<string, unknown>): Promise<string> {
  const dir = join(root, 'brands', 'acme');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'week-01.json'), JSON.stringify(plan));
  return dir;
}

test('the switch is on only for the exact word "true"', () => {
  for (const off of [undefined, '', 'false', 'TRUE', 'True', '1', 'yes', 'on', ' true', 'true ', 'enabled']) assert.equal(publishingEnabled({ SOCIAL_PUBLISHING_ENABLED: off }), false, String(off));
  assert.equal(publishingEnabled({ SOCIAL_PUBLISHING_ENABLED: 'true' }), true);
  assert.throws(() => assertPublishingEnabled('x', {}), PublishingDisabledError);
  assert.doesNotThrow(() => assertPublishingEnabled('x', { SOCIAL_PUBLISHING_ENABLED: 'true' }));
});

test('scheduling is refused for every kind of plan, however approved, and nothing leaves the machine', async () => {
  for (const [name, extra] of [
    ['an approved ai_v1 plan', { renderMode: 'ai_v1' }],
    ['an approved art_v1 plan', { renderMode: 'art_v1' }],
    ['a legacy plan with no render mode', {}],
    ['a plan with a forged render mode', { renderMode: 'definitely_approved' }],
    ['a plan that claims publishing is enabled', { renderMode: 'legacy', publishingEnabled: true, SOCIAL_PUBLISHING_ENABLED: 'true' }],
  ] as const) {
    const brandDir = await brandWith(planWith(extra));
    await assert.rejects(schedulePlan({ brandDir, planFile: 'week-01.json', channel: 'acme', schedulerKey: 'k', schedulerUrl: 'http://127.0.0.1:1/api' }), PublishingDisabledError, name);
  }
  assert.equal(networkCalls, 0);
});

test('the scheduler client itself refuses to send, so no caller can bypass the layers above it', async () => {
  const client = new SchedulerClient('http://127.0.0.1:1/api', 'key');
  const picture = join(root, 'p.jpg');
  await writeFile(picture, 'x');
  await assert.rejects(client.uploadImage(picture), PublishingDisabledError);
  await assert.rejects(client.schedulePost({ integrationId: 'i', providerIdentifier: 'instagram', date: '2099-01-01T10:00:00+05:30', caption: 'c', image: { id: 'm', path: 'p' } }), PublishingDisabledError);
  assert.equal(networkCalls, 0);
});

test('exporting to the publisher app is refused and writes nothing', async () => {
  const brandDir = await brandWith(planWith({}));
  const publisherDir = join(root, 'publisher');
  await assert.rejects(exportToPublisher(brandDir, publisherDir), PublishingDisabledError);
  await assert.rejects(readdir(publisherDir), /ENOENT/);
});

test('a dry run sends nothing and is still allowed', async () => {
  const brandDir = await brandWith(planWith({ posts: [planWith({}).posts as never][0] }));
  await assert.rejects(schedulePlan({ brandDir, planFile: 'week-01.json', channel: 'acme', schedulerKey: 'k', dryRun: true, schedulerUrl: 'http://127.0.0.1:1/api' }), (error: unknown) => !(error instanceof PublishingDisabledError));
});

test('with the switch on the gate is open: the work goes on to the next real check', async () => {
  process.env['SOCIAL_PUBLISHING_ENABLED'] = 'true';
  globalThis.fetch = (async () => new Response(JSON.stringify([]), { status: 200 })) as typeof fetch;
  const brandDir = await brandWith(planWith({}));
  await assert.rejects(schedulePlan({ brandDir, planFile: 'week-01.json', channel: 'acme', schedulerKey: 'k', schedulerUrl: 'http://127.0.0.1:1/api' }), (error: unknown) => !(error instanceof PublishingDisabledError));
});

test('the command line refuses to schedule or export for real before doing any paid work, and no flag or look-alike value opens it', async () => {
  const script = join(process.cwd(), 'src', 'autopilot.ts');
  const run = (args: string[], extraEnv: Record<string, string> = {}): Promise<{ stderr: string }> =>
    promisify(execFile)('node', [script, ...args], { cwd: root, env: { PATH: process.env['PATH'] ?? '', OPENAI_API_KEY: 'sk-test-openai-key', ...extraEnv } }).then((r) => ({ stderr: String(r.stderr) }));
  const refused = (error: { stderr?: string; code?: number }): boolean => /PUBLISHING_DISABLED/.test(error.stderr ?? '') && error.code !== 0;
  for (const args of [
    ['--site', 'https://acme.example', '--route', 'template', '--target', 'scheduler', '--channel', 'acme'],
    ['--site', 'https://acme.example', '--route', 'template', '--target', 'publisher'],
    ['--site', 'https://acme.example', '--route', 'template', '--target', 'scheduler', '--channel', 'acme', '--allow-paid-ai', '--art'],
  ]) await assert.rejects(run(args), refused, args.join(' '));
  for (const value of ['TRUE', '1', 'yes', 'false', '']) await assert.rejects(run(['--site', 'https://acme.example', '--route', 'template', '--target', 'publisher'], { SOCIAL_PUBLISHING_ENABLED: value }), refused, `value "${value}"`);
});

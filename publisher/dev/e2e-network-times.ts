/**
 * End-to-end check of a network's own time for a planned post, against the real publisher server and the pretend LinkedIn and Facebook (nothing real is touched):
 *
 *   node --import ./dev/resolver.ts dev/e2e-network-times.ts
 *
 * One planned post goes to a Facebook Page and a LinkedIn profile. LinkedIn is given its own time through the product API; the post is listed as two posts; the frequent
 * send run then sends Facebook at the post's time and LinkedIn only at its own, with LinkedIn's own words and picture, and nothing is sent twice.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addFacebookPages, addLinkedInMember } from '../lib/channels.ts';
import { hashKey } from '../lib/products.ts';

const KEY = 'test-product-key-0123456789abcdef';
const CHANNEL_KEY = randomBytes(32).toString('hex');
const CRON_SECRET = 'cron-secret-0123456789abcdef-0123';
const dir = await mkdtemp(join(tmpdir(), 'network-times-'));
const store = join(dir, 'store');
const pub = join(dir, 'public');
await mkdir(join(pub, 'posts'), { recursive: true });
await mkdir(store, { recursive: true });
for (const name of ['ig.jpg', 'li.jpg']) await writeFile(join(pub, 'posts', name), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

const env = {
  ...process.env,
  LOCAL_STORE_DIR: store,
  PUBLIC_DIR: pub,
  PUBLIC_ORIGIN: 'http://127.0.0.1:4020',
  CHANNEL_KEY,
  EDIT_SECRET: 'edit-secret-0123456789abcdef-0123',
  CRON_SECRET,
  STATUS_SECRET: 'status-secret-0123456789abcdef-01',
  SCHEDULE_FILE: join(dir, 'schedule.ts'),
  PRODUCTS: JSON.stringify([{ id: 'brandbasket', keyHash: hashKey(KEY), returnUrls: ['https://app.example.test/social'] }]),
  LINKEDIN_API_URL: 'http://127.0.0.1:4040',
  FACEBOOK_GRAPH_URL: 'http://127.0.0.1:4041',
  SOCIAL_PUBLISHING_ENABLED: 'true',
};
delete (env as Record<string, string | undefined>)['BLOB_READ_WRITE_TOKEN'];

const children: ChildProcess[] = [];
const start = (file: string): void => void children.push(spawn('node', ['--import', './dev/resolver.ts', file], { env, stdio: 'ignore' }));
const stop = (): void => children.forEach((c) => c.kill());
let failed = 0;
const check = (ok: boolean, what: string, detail?: unknown): void => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${ok || detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`);
};
const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const response = await fetch(`http://127.0.0.1:4020${path}`, { method, headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json().catch(() => null) };
};
const ist = (ms: number): { iso: string; day: string; time: string } => {
  // To the minute, as the API stores a time.
  const shifted = new Date(Math.floor(ms / 60_000) * 60_000 + 5.5 * 3_600_000).toISOString();
  return { iso: `${shifted.slice(0, 19)}+05:30`, day: shifted.slice(0, 10), time: shifted.slice(11, 16) };
};
const cron = async (): Promise<Record<string, unknown>> => (await (await fetch('http://127.0.0.1:4020/api/cron?only=manual', { headers: { Authorization: `Bearer ${CRON_SECRET}` } })).json()) as Record<string, unknown>;
const state = async (port: number): Promise<{ posts: any[] }> => (await (await fetch(`http://127.0.0.1:${port}/__state`)).json()) as { posts: any[] };

try {
  await writeFile(join(dir, 'schedule.ts'), 'export const schedule = {"posts":[]};\n');
  ['dev/fake-linkedin.ts', 'dev/fake-facebook.ts', 'dev/server.ts'].forEach(start);
  for (let i = 0; i < 40; i += 1) {
    const up = await fetch('http://127.0.0.1:4040/__state').then(() => fetch('http://127.0.0.1:4041/__state')).then(() => fetch('http://127.0.0.1:4020/nothing')).then(() => true, () => false);
    if (up) break;
    await wait(250);
  }

  const made = await api('POST', '/api/v1/workspaces', { externalId: 'bb-e2e', name: 'E2E Co' });
  check(made.status === 200 || made.status === 201, 'a workspace is made', made);
  const clients = JSON.parse(await readFile(join(store, 'clients.json'), 'utf8')) as { clients: Array<{ brand: string; externalId?: string }> };
  const brand = clients.clients.find((c) => c.externalId === 'bb-e2e')?.brand ?? clients.clients[0]?.brand ?? '';
  check(brand !== '', 'the workspace has a brand', clients);

  const key = Buffer.from(CHANNEL_KEY, 'hex');
  const connectedAt = Date.now() - 86_400_000;
  let channels = addFacebookPages({ channels: [] }, brand, [{ id: '111222333', name: 'Test Page', accessToken: 'fake-page-token' }], key, connectedAt);
  channels = addLinkedInMember(channels, brand, { urn: 'urn:li:person:fake123', name: 'Steff Jay' }, 'fake-access-token', 5_184_000, key, connectedAt);
  await writeFile(join(store, 'channels.json'), JSON.stringify(channels));

  const postId = `${brand}-w01-d1`;
  const writeSchedule = (date: string): Promise<void> => writeFile(join(dir, 'schedule.ts'), `export const schedule = ${JSON.stringify({ posts: [{ id: postId, brand, date, caption: 'Facebook words', image: '/posts/ig.jpg', channels: ['facebook:111222333', 'linkedin:fake123'], fromPlan: true, ownTime: true, variants: { linkedin: { caption: 'LinkedIn own words', image: '/posts/li.jpg' } } }] })};\n`);
  const inTwoHours = ist(Date.now() + 2 * 3_600_000);
  await writeSchedule(inTwoHours.iso);

  const q = '?externalId=bb-e2e';
  let listed = await api('GET', `/api/v1/posts${q}`);
  check(listed.status === 200 && listed.body.posts.length === 1, 'one topic, one post, going to both networks', listed.body?.posts?.map((p: any) => p.id));

  const laterToday = ist(Date.now() + 5 * 3_600_000);
  const moved = await api('PATCH', `/api/v1/posts${q}&postId=${encodeURIComponent(postId)}`, { day: laterToday.day, time: laterToday.time, network: 'linkedin' });
  check(moved.status === 200, 'LinkedIn is given its own time', moved);

  listed = await api('GET', `/api/v1/posts${q}`);
  const ids = listed.body.posts.map((p: any) => p.id).sort();
  check(ids.length === 2 && ids[0] === postId && ids[1] === `${postId}~linkedin`, 'the topic is now two posts', ids);
  const main = listed.body.posts.find((p: any) => p.id === postId);
  const part = listed.body.posts.find((p: any) => p.id === `${postId}~linkedin`);
  check(Date.parse(main.date) === Date.parse(inTwoHours.iso), 'the post keeps its own time', main?.date);
  check(Date.parse(part.date) === Date.parse(laterToday.iso), "LinkedIn's post has its own time", part?.date);
  check(part.caption === 'LinkedIn own words' && String(part.imageUrl).endsWith('/posts/li.jpg'), "LinkedIn's post has LinkedIn's words and picture", { caption: part?.caption, image: part?.imageUrl });
  check(part.channels.length === 1 && part.channels[0].platform === 'linkedin' && main.channels.every((c: any) => c.platform === 'facebook'), 'each post goes only to its own network', { main: main?.channels?.map((c: any) => c.platform), part: part?.channels?.map((c: any) => c.platform) });

  const again = ist(Date.now() + 6 * 3_600_000);
  const movedAgain = await api('PATCH', `/api/v1/posts${q}&postId=${encodeURIComponent(`${postId}~linkedin`)}`, { day: again.day, time: again.time });
  listed = await api('GET', `/api/v1/posts${q}`);
  const part2 = listed.body.posts.find((p: any) => p.id === `${postId}~linkedin`);
  const main2 = listed.body.posts.find((p: any) => p.id === postId);
  check(movedAgain.status === 200 && Date.parse(part2.date) === Date.parse(again.iso) && Date.parse(main2.date) === Date.parse(inTwoHours.iso), "moving LinkedIn's post by its own id moves only LinkedIn", { status: movedAgain.status });

  const back = await api('PATCH', `/api/v1/posts${q}&postId=${encodeURIComponent(postId)}`, { day: inTwoHours.day, time: inTwoHours.time, network: 'linkedin' });
  listed = await api('GET', `/api/v1/posts${q}`);
  check(back.status === 200 && listed.body.posts.length === 1, "moving LinkedIn to the post's own moment puts it back on the post", listed.body?.posts?.map((p: any) => p.id));

  const refused = await api('PATCH', `/api/v1/posts${q}&postId=${encodeURIComponent(postId)}`, { day: laterToday.day, time: laterToday.time, network: 'google' });
  check(refused.status === 400, 'a network the post does not go to is refused', refused);

  // Give LinkedIn its own time again, then let the post's own time pass: the sender must send Facebook only.
  await api('PATCH', `/api/v1/posts${q}&postId=${encodeURIComponent(postId)}`, { day: laterToday.day, time: laterToday.time, network: 'linkedin' });
  // The post's own time has passed; LinkedIn's (given earlier through the API) has not.
  await writeSchedule(ist(Date.now() - 3 * 60_000).iso);
  await cron();
  const facebook = await state(4041);
  const linkedinBefore = await state(4040);
  check(facebook.posts.length >= 1, 'Facebook is sent at the post\'s own time', facebook.posts.length);
  check(linkedinBefore.posts.length === 0, 'LinkedIn is not sent then, its own time has not come', linkedinBefore.posts.length);

  // LinkedIn's own time comes: only LinkedIn is sent, with its own words.
  const overridesFile = join(store, 'overrides.json');
  const overrides = JSON.parse(await readFile(overridesFile, 'utf8')) as Record<string, { networkDates?: Record<string, string> }>;
  (overrides[postId] as { networkDates: Record<string, string> }).networkDates['linkedin'] = ist(Date.now() - 1 * 60_000).iso;
  await writeFile(overridesFile, JSON.stringify(overrides));
  const facebookCount = (await state(4041)).posts.length;
  const second = await cron();
  if (process.env['E2E_DEBUG']) console.log(JSON.stringify(second).slice(0, 1500));
  const sentPosts = ((second['posts'] ?? [second]) as Array<{ post: string }>).map((p) => p.post);
  check(sentPosts.includes(`${postId}~linkedin`), "the sender chose LinkedIn's own post", sentPosts);
  const linkedin = await state(4040);
  check(linkedin.posts.length === 1, 'LinkedIn is sent when its own time comes', linkedin.posts.length);
  check(JSON.stringify(linkedin.posts).includes('LinkedIn own words'), "with LinkedIn's own words", linkedin.posts.map((p: any) => p.specificContent ?? p.commentary));
  check((await state(4041)).posts.length === facebookCount, 'Facebook is not sent again', facebookCount);

  await cron();
  check((await state(4040)).posts.length === 1 && (await state(4041)).posts.length === facebookCount, 'a later run sends nothing twice');

  const late = await api('PATCH', `/api/v1/posts${q}&postId=${encodeURIComponent(`${postId}~linkedin`)}`, { day: laterToday.day, time: laterToday.time });
  check(late.status === 409, 'a network that has sent cannot be moved', late);
} finally {
  stop();
  await rm(dir, { recursive: true, force: true });
}
console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CopyStage } from './copy-stage.ts';
import { writeConnected } from './connected-networks.ts';
import { JobError, JobStore } from './job-store.ts';
import { planEnded, readPlanEnd, writePlanEnd } from './plan-end.ts';
import { ProductBrands } from './product-brands.ts';
import { createReviewServer } from './review-server.ts';
import { runCatchUpDraws, runWeeklyDraws, type WeeklyDeps } from './weekly-draw.ts';
import { runWeeklyCarousels, writeCarouselWeekly } from './weekly-carousel.ts';

const IST = (day: string, time = '00:00:00'): number => Date.parse(`${day}T${time}+05:30`);
const tmp = (): string => mkdtempSync(join(tmpdir(), 'plan-end-'));

test('the billing date is kept beside the brand, cleared with null, and a bad day is refused', () => {
  const dir = tmp();
  try {
    assert.equal(readPlanEnd(dir), null);
    assert.deepEqual(writePlanEnd(dir, '2026-12-10'), { changed: true });
    assert.equal(readPlanEnd(dir), '2026-12-10');
    assert.deepEqual(writePlanEnd(dir, '2026-12-10'), { changed: false });
    assert.throws(() => writePlanEnd(dir, '2026-02-30'), /real day/);
    assert.deepEqual(writePlanEnd(dir, null), { changed: true });
    assert.equal(readPlanEnd(dir), null);
    assert.deepEqual(writePlanEnd(dir, null), { changed: false });
    writeFileSync(join(dir, 'billing-end.json'), '{ not json');
    assert.equal(readPlanEnd(dir), null, 'a damaged file never blocks anyone');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the paid period has ended from midnight India time on the billing date', () => {
  const dir = tmp();
  try {
    writePlanEnd(dir, '2026-12-10');
    assert.equal(planEnded(dir, IST('2026-12-09', '23:59:59')), false);
    assert.equal(planEnded(dir, IST('2026-12-10')), true);
    assert.equal(planEnded(join(dir, 'nobody'), IST('2030-01-01')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with the guard set, no job is queued for a brand whose plan has ended, and nothing is written; another brand is unaffected', () => {
  const root = tmp();
  try {
    const jobs = new JobStore(join(root, 'jobs'));
    jobs.spendGuard = (brand) => brand === 'bb-ended';
    assert.throws(() => jobs.enqueue({ kind: 'copy', brand: 'bb-ended', site: 'https://a.example', by: 'u' }), (e: unknown) => e instanceof JobError && e.code === 'PLAN_ENDED');
    assert.deepEqual(jobs.list({ brand: 'bb-ended' }), []);
    assert.equal(jobs.enqueue({ kind: 'copy', brand: 'bb-fine', site: 'https://a.example', by: 'u' }).created, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const post = (id: string, date: string) => ({ postId: id, date, headline: `H ${id}`, caption: 'C', captions: { instagram: { text: `ig ${id}` }, facebook: { text: `fb ${id}` } } });

function setup() {
  const root = tmp();
  const brandsRoot = join(root, 'brands');
  const dir = join(brandsRoot, 'bb-acme');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'brand.json'), '{}');
  const owners = new ProductBrands(brandsRoot);
  owners.claim('bb-acme', 'brandbasket', () => false);
  const stage = new CopyStage(dir, 'bb-acme');
  stage.open('week-01.json', [post('w1-d1', '2026-11-16'), post('w2-d1', '2026-11-23')]);
  stage.decide('week-01.json', 'w2-d1', 'kept', 'u');
  writeConnected(dir, ['instagram', 'facebook']);
  const jobs = new JobStore(join(root, 'jobs'));
  const deps = (now: string): WeeklyDeps => ({ brandsRoot, jobs, owners, now: new Date(now), made: () => new Set(), room: () => null, siteOf: () => 'https://acme.example', register: () => undefined });
  return { root, dir, jobs, owners, brandsRoot, deps, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('the weekly draw and the weekly carousel skip a customer whose plan has ended, and take her up again when it is cleared', () => {
  const s = setup();
  try {
    const thursday = '2026-11-19T04:31:00Z';
    writePlanEnd(s.dir, '2026-11-18');
    assert.deepEqual(runWeeklyDraws(s.deps(thursday)), [], 'no draw after the date');
    assert.deepEqual(s.jobs.list({ brand: 'bb-acme' }), []);
    writeCarouselWeekly(s.dir, true);
    const carouselDeps = { brandsRoot: s.brandsRoot, jobs: s.jobs, owners: s.owners, now: new Date('2026-11-19T05:00:00Z'), made: () => [], siteOf: () => 'https://acme.example' };
    assert.deepEqual(runWeeklyCarousels(carouselDeps as never), [], 'no weekly carousel');
    assert.deepEqual(runCatchUpDraws({ brandsRoot: s.brandsRoot, jobs: s.jobs, owners: s.owners, now: new Date(thursday), made: () => new Set(), siteOf: () => 'https://acme.example' } as never), []);
    // She kept the plan: the same pass draws her week again.
    writePlanEnd(s.dir, null);
    assert.deepEqual(runWeeklyDraws(s.deps(thursday)).map((a) => a.action), ['drawing']);
    assert.equal(runWeeklyCarousels(carouselDeps as never).length, 1, 'the weekly carousel is written again once the plan is back');
  } finally {
    s.done();
  }
});

const PRODUCT = 'product-secret-0123456789';

async function startServer(now: string) {
  const root = tmp();
  const brandsRoot = join(root, 'brands');
  const dir = join(brandsRoot, 'bb-acme');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'brand.json'), JSON.stringify({ name: 'Acme', website: 'https://acme.example' }));
  new ProductBrands(brandsRoot).claim('bb-acme', 'brandbasket', () => false);
  writeConnected(dir, ['instagram']);
  const server = createReviewServer({ brandsRoot, secret: 'staff-secret-0123456789', jobsRoot: join(root, 'jobs'), products: [{ id: 'brandbasket', secret: PRODUCT }], ledgerFile: join(root, 'none.jsonl'), now: () => new Date(now) });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, body?: unknown, method?: string): Promise<Response> =>
    fetch(`${base}${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { Authorization: `Bearer ${PRODUCT}`, 'X-Brand': 'bb-acme', 'X-Actor': 'brandbasket:user-42', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { call, dir, base, done: async () => { await new Promise((resolve) => server.close(resolve)); rmSync(root, { recursive: true, force: true }); } };
}

test('the product tells the review service when the plan ends; staff cannot, a bad day is refused, and from the date no job is accepted (409 PLAN_ENDED)', async () => {
  const s = await startServer('2026-12-10T05:00:00Z');
  try {
    const put = (body: unknown): Promise<Response> => s.call('/review/billing-end', body, 'PUT');
    assert.equal((await put({ endDate: '2026-02-30' })).status, 400);
    assert.equal((await put({})).status, 400, 'leaving it out is not null');
    const staff = await fetch(`${s.base}/review/billing-end`, { method: 'PUT', headers: { Authorization: 'Bearer staff-secret-0123456789', 'Content-Type': 'application/json' }, body: JSON.stringify({ endDate: '2026-12-10' }) });
    assert.equal(staff.status, 404, 'staff do not write it');

    // A date still ahead: new work is accepted.
    assert.equal((await put({ endDate: '2026-12-20' })).status, 200);
    assert.equal(readPlanEnd(s.dir), '2026-12-20');
    assert.deepEqual(await (await s.call('/review/billing-end')).json(), { endDate: '2026-12-20' });
    const open = await s.call('/review/jobs', { kind: 'copy', brand: 'bb-acme', site: 'https://acme.example', networks: ['instagram'], weeks: 1, postsPerWeek: 2, by: 'u' });
    assert.equal(open.status, 202, JSON.stringify(await open.clone().json()));

    // The date has come (the server's clock is 10 Dec, 10:30 India time): refused before a job exists.
    assert.equal((await put({ endDate: '2026-12-10' })).status, 200);
    const refused = await s.call('/review/jobs', { kind: 'copy', brand: 'bb-acme', site: 'https://acme.example', networks: ['instagram'], weeks: 2, postsPerWeek: 2, by: 'u' });
    assert.equal(refused.status, 409, JSON.stringify(await refused.clone().json()));
    assert.equal(((await refused.json()) as { code: string }).code, 'PLAN_ENDED');

    // Cleared: accepted again.
    assert.equal((await put({ endDate: null })).status, 200);
    assert.equal(existsSync(join(s.dir, 'billing-end.json')), false);
    const again = await s.call('/review/jobs', { kind: 'copy', brand: 'bb-acme', site: 'https://acme.example', networks: ['instagram'], weeks: 2, postsPerWeek: 2, by: 'u' });
    // The first job is still waiting, so the same ask is that job (200): what matters is that it is no longer refused.
    assert.ok([200, 202].includes(again.status), JSON.stringify(await again.clone().json()));
  } finally {
    await s.done();
  }
});

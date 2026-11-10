import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewStore } from './review-store.ts';
import { acquireLease, autoApprove, listCampaigns, makeCampaigns, parseProgressLine, releaseCampaigns, statusOf, type PlannedClient, type RunnerDeps } from './campaign-runner.ts';

const NOW = new Date('2026-11-05T12:00:00Z');
const root = (): { dir: string; done: () => void } => { const dir = mkdtempSync(join(tmpdir(), 'campaign-')); return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }; };
/** `plan` is a shorthand for a client with that one plan. */
const client = (over: Partial<Omit<PlannedClient, 'plans'>> & { plan?: unknown; plans?: unknown[] } = {}): PlannedClient => {
  const { plan, plans, ...rest } = over;
  return { brand: 'oyechats', website: 'https://oyechats.com', ...rest, plans: plans ?? [plan ?? { platforms: ['instagram', 'facebook'], startDate: '2026-11-06', durationDays: 1 }] };
};
const deps = (over: Partial<RunnerDeps> & { calls?: string[][] } = {}): RunnerDeps => ({
  exec: async (args) => { over.calls?.push(args); return { code: 0, tail: 'done' }; },
  release: async () => 0,
  publishingEnabled: () => true,
  now: () => NOW,
  ...over,
});
const state = (dir: string, siteBrand = 'oyechats'): Array<Record<string, unknown>> => {
  const folder = join(dir, siteBrand, 'campaigns');
  return existsSync(folder) ? readdirSync(folder).map((f: string) => JSON.parse(readFileSync(join(folder, f), 'utf8'))) : [];
};

test('a single-day plan makes one run of the AI route for exactly that day, and records the platforms for the release', async () => {
  const r = root();
  try {
    const calls: string[][] = [];
    const [made] = await makeCampaigns([client()], r.dir, deps({ calls }));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.slice(0, 9), ['src/autopilot.ts', '--site', 'https://oyechats.com', '--route', 'ai', '--days', '1', '--start', '2026-11-06']);
    assert.equal(made?.status, 'awaiting_approval');
    assert.deepEqual((state(r.dir)[0]?.['plan'] as { platforms: string[] }).platforms, ['instagram', 'facebook'], 'the plan, with its platforms, is in the record the export reads');
  } finally {
    r.done();
  }
});

test('three times a week for a month is made in runs of at most eight posters, one after another', async () => {
  const r = root();
  try {
    const calls: string[][] = [];
    const [made] = await makeCampaigns([client({ plan: { platforms: ['instagram'], startDate: '2026-11-06', durationDays: 31, postsPerWeek: 3 } })], r.dir, deps({ calls }));
    assert.deepEqual(calls.map((c) => c[c.indexOf('--days') + 1]), ['8', '5']);
    assert.equal(made?.batches.length, 2);
    assert.equal(made?.status, 'awaiting_approval');
  } finally {
    r.done();
  }
});

test('the same plan is never made twice, and a changed plan is a new campaign', async () => {
  const r = root();
  try {
    const calls: string[][] = [];
    await makeCampaigns([client()], r.dir, deps({ calls }));
    await makeCampaigns([client()], r.dir, deps({ calls }));
    assert.equal(calls.length, 1, 'the second tick found it done');
    await makeCampaigns([client({ plan: { platforms: ['instagram'], startDate: '2026-11-07', durationDays: 1 } })], r.dir, deps({ calls }));
    assert.equal(calls.length, 2);
    assert.equal(state(r.dir).length, 2);
  } finally {
    r.done();
  }
});

test('a client with its own monthly spend limit passes it to every run; the month limit stopping a run is recorded and later batches are not tried', async () => {
  const r = root();
  try {
    const calls: string[][] = [];
    const plan = { platforms: ['instagram'], startDate: '2026-11-06', durationDays: 31 };
    const [made] = await makeCampaigns([client({ plan, spendCapUsd: 2.5 })], r.dir, deps({ calls, exec: async (a) => { calls.push(a); return { code: 1, tail: 'BUDGET_EXHAUSTED (BRAND_MONTH_BUDGET): this brand would spend $2.6 this month\n' }; } }));
    assert.equal(calls.length, 1, 'the later batches were not tried');
    assert.equal(calls[0]?.[calls[0].indexOf('--month-cap-usd') + 1], '2.5');
    assert.equal(made?.status, 'failed');
    assert.match(made?.batches[0]?.tail ?? '', /BRAND_MONTH_BUDGET/);
  } finally {
    r.done();
  }
});

test('a failed run is recorded with the end of its output and is not retried by itself; later batches of a plan that cannot work are not tried', async () => {
  const r = root();
  try {
    const calls: string[][] = [];
    const logs: string[] = [];
    const [made] = await makeCampaigns([client({ plan: { platforms: ['instagram'], startDate: '2026-11-06', durationDays: 31 } })], r.dir, deps({ calls, log: (m) => logs.push(m), exec: async (a) => { calls.push(a); return { code: 1, tail: 'INSUFFICIENT_EVIDENCE: the site gave 0 facts\n' }; } }));
    assert.ok(logs.some((m) => /batch 1 failed: INSUFFICIENT_EVIDENCE/.test(m)), 'the reason is in the service log, not only in the state file');
    assert.equal(calls.length, 1, 'the later batches were not tried');
    assert.equal(made?.status, 'failed');
    assert.match(made?.batches[0]?.tail ?? '', /INSUFFICIENT_EVIDENCE/);
    assert.ok(made?.batches.slice(1).every((b) => b.status === 'failed' && /not tried/.test(b.note ?? '')));
    await makeCampaigns([client({ plan: { platforms: ['instagram'], startDate: '2026-11-06', durationDays: 31 } })], r.dir, deps({ calls }));
    assert.equal(calls.length, 1, 'a failed campaign is not started again on its own');
  } finally {
    r.done();
  }
});

test('one failing batch of a month leaves the others made: partial', async () => {
  const r = root();
  try {
    let n = 0;
    const [made] = await makeCampaigns([client({ plan: { platforms: ['instagram'], startDate: '2026-11-06', durationDays: 31, postsPerWeek: 3 } })], r.dir, deps({ exec: async () => ({ code: n++ === 0 ? 0 : 1, tail: 'a model call failed' }) }));
    assert.equal(made?.status, 'partial');
    assert.deepEqual(made?.batches.map((b) => b.status), ['done', 'failed']);
  } finally {
    r.done();
  }
});

test('a batch left running by a runner that died is marked interrupted and never started again by itself', async () => {
  const r = root();
  try {
    const calls: string[][] = [];
    await makeCampaigns([client()], r.dir, deps({ calls, exec: async () => { throw new Error('killed'); } }));
    const folder = join(r.dir, 'oyechats', 'campaigns');
    const file = join(folder, readdirSync(folder)[0] as string);
    const s = JSON.parse(readFileSync(file, 'utf8'));
    s.batches[0].status = 'running';
    writeFileSync(file, JSON.stringify(s));
    const [after] = await makeCampaigns([client()], r.dir, deps({ calls }));
    assert.equal(after?.status, 'interrupted');
    assert.match(after?.batches[0]?.note ?? '', /check the paid-call ledger/);
    assert.equal(calls.length, 0);
  } finally {
    r.done();
  }
});

test('days that have already passed are not made, and a plan with nothing left makes nothing', async () => {
  const r = root();
  try {
    const calls: string[][] = [];
    await makeCampaigns([client({ plan: { platforms: ['instagram'], startDate: '2026-11-01', durationDays: 1 } })], r.dir, deps({ calls }));
    assert.equal(calls.length, 0);
    const [made] = await makeCampaigns([client({ plan: { platforms: ['instagram'], startDate: '2026-11-03', durationDays: 7 } })], r.dir, deps({ calls }));
    assert.deepEqual(made?.batches[0]?.dates, ['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09']);
  } finally {
    r.done();
  }
});

test('a client with a broken plan is skipped and the others still run', async () => {
  const r = root();
  try {
    const calls: string[][] = [];
    const logs: string[] = [];
    await makeCampaigns([client({ brand: 'bad', website: 'https://bad.example.org', plan: { platforms: [] } }), client()], r.dir, deps({ calls, log: (m) => logs.push(m) }));
    assert.equal(calls.length, 1);
    assert.match(logs.join('\n'), /bad: the posting plan is not valid/);
  } finally {
    r.done();
  }
});

test('release hands approved posters to the publisher only when publishing is on, and says so when it is off', async () => {
  const r = root();
  try {
    await makeCampaigns([client()], r.dir, deps());
    const off = await releaseCampaigns(r.dir, deps({ publishingEnabled: () => false, release: async () => { throw new Error('must not be called'); } }));
    assert.deepEqual(off, []);
    assert.match(String(state(r.dir)[0]?.['releaseNote']), /switched off/);
    const brands: string[] = [];
    const on = await releaseCampaigns(r.dir, deps({ release: async (dir) => { brands.push(dir); return 2; } }));
    assert.equal(on.length, 1);
    assert.deepEqual(state(r.dir)[0]?.['released'] && (state(r.dir)[0]?.['released'] as { posts: number }).posts, 2);
    assert.equal(state(r.dir)[0]?.['releaseNote'], undefined);
    assert.ok(brands[0]?.endsWith('oyechats'));
  } finally {
    r.done();
  }
});

test('a release that fails is recorded and does not stop the others', async () => {
  const r = root();
  try {
    await makeCampaigns([client()], r.dir, deps());
    await releaseCampaigns(r.dir, deps({ release: async () => { throw new Error('PUBLISHING_DISABLED'); } }));
    assert.match(String(state(r.dir)[0]?.['releaseNote']), /release failed: PUBLISHING_DISABLED/);
  } finally {
    r.done();
  }
});

test('a campaign with nothing made yet is not released', async () => {
  const r = root();
  try {
    await makeCampaigns([client()], r.dir, deps({ exec: async () => ({ code: 1, tail: 'failed' }) }));
    const out = await releaseCampaigns(r.dir, deps({ release: async () => { throw new Error('must not be called'); } }));
    assert.deepEqual(out, []);
  } finally {
    r.done();
  }
});

test('overall status follows the batches', () => {
  const b = (status: 'pending' | 'running' | 'done' | 'failed' | 'interrupted') => ({ index: 0, dates: [], status });
  assert.equal(statusOf([b('pending'), b('pending')]), 'queued');
  assert.equal(statusOf([b('done'), b('pending')]), 'running');
  assert.equal(statusOf([b('done'), b('failed')]), 'partial');
  assert.equal(statusOf([b('failed')]), 'failed');
  assert.equal(statusOf([b('done'), b('interrupted')]), 'interrupted');
  assert.equal(statusOf([b('done')]), 'awaiting_approval');
});

test('the runner lease: held by a live process it is refused, left by a dead one it is taken over', async () => {
  const r = root();
  try {
    const path = join(r.dir, '.lease');
    const give = await acquireLease(path);
    assert.ok(give);
    assert.equal(await acquireLease(path), null, 'this process is alive and holds it');
    await give?.();
    assert.ok(await acquireLease(path), 'free again');
    mkdirSync(r.dir, { recursive: true });
    writeFileSync(path, '999999999');
    const taken = await acquireLease(path);
    assert.ok(taken, 'a lease left by a process that is gone is taken over');
    await taken?.();
  } finally {
    r.done();
  }
});

test('several plans for one client are made one after the other, each remembers the week file it wrote, and a plan taken off the client is not made again', async () => {
  const r = root();
  try {
    let week = 0;
    const exec: RunnerDeps['exec'] = async () => {
      week += 1;
      mkdirSync(join(r.dir, 'oyechats'), { recursive: true });
      writeFileSync(join(r.dir, 'oyechats', `week-0${week}.json`), '{}');
      return { code: 0, tail: 'done' };
    };
    const instagram = { platforms: ['instagram'], startDate: '2026-11-06', durationDays: 31, postsPerWeek: 3 };
    const linkedin = { platforms: ['linkedin'], startDate: '2026-11-06', durationDays: 31, postsPerWeek: 1 };
    await makeCampaigns([client({ plans: [instagram, linkedin] })], r.dir, deps({ exec }));
    const records = state(r.dir) as Array<{ plan: { platforms: string[] }; batches: Array<{ weekFile?: string }> }>;
    assert.equal(records.length, 2, 'one record per plan');
    const files = Object.fromEntries(records.map((x) => [x.plan.platforms[0], x.batches.map((b) => b.weekFile)]));
    assert.deepEqual(files['instagram'], ['week-01.json', 'week-02.json']);
    assert.deepEqual(files['linkedin'], ['week-03.json']);
    const calls: string[][] = [];
    await makeCampaigns([client({ plans: [linkedin] })], r.dir, deps({ calls }));
    assert.equal(calls.length, 0, 'finished plans are not made again, and the removed one is not either');
  } finally {
    r.done();
  }
});

test('a client that requires a real logo has every batch asked for it, and one stopped for want of a logo does not start the later batches', async () => {
  const r = root();
  try {
    const calls: string[][] = [];
    const [made] = await makeCampaigns([client({ requireAuthenticLogo: true, plan: { platforms: ['instagram'], startDate: '2026-11-06', durationDays: 31 } })], r.dir, deps({ calls, exec: async (a) => { calls.push(a); return { code: 1, tail: 'Error: LOGO_REQUIRED: The website has no logo picture, only the name.\n' }; } }));
    assert.ok(calls[0]?.includes('--require-logo'));
    assert.equal(calls.length, 1, 'the later batches would be stopped the same way');
    assert.equal(made?.status, 'failed');
    assert.match(made?.batches[0]?.tail ?? '', /LOGO_REQUIRED/);
    const others: string[][] = [];
    await makeCampaigns([client({ brand: 'plain', website: 'https://plain.example.org' })], r.dir, deps({ calls: others }));
    assert.ok(!others[0]?.includes('--require-logo'));
  } finally {
    r.done();
  }
});

test('the autopilot\'s progress lines are read for the step, the latest thing said and posters finished, and other lines say nothing', () => {
  assert.deepEqual(parseProgressLine('1/4 Reading https://oyechats.com and building the brand profile…'), { stage: 'reading', detail: 'Reading https://oyechats.com and building the brand profile…' });
  assert.equal(parseProgressLine('2/4 Writing 4 new pain-point posts from 2026-11-09 (week-02.json)…')?.stage, 'writing');
  assert.equal(parseProgressLine('3/4 Drawing the posters with the picture model (no template)…')?.stage, 'drawing');
  assert.equal(parseProgressLine('4/4 Nothing was scheduled or published: every poster waits for the owner to approve it.')?.stage, 'finishing');
  assert.deepEqual(parseProgressLine('    w01-d1: attempt 1, drawing the poster…'), { detail: 'w01-d1: attempt 1, drawing the poster…' });
  assert.deepEqual(parseProgressLine('    w01-d2: accepted after 2 attempts'), { detail: 'w01-d2: accepted after 2 attempts', drawn: true });
  assert.equal(parseProgressLine('    w01-d3: dropped (the copy failed the claim gate)')?.detail, 'w01-d3: dropped (the copy failed the claim gate)');
  assert.deepEqual(parseProgressLine('    3 posters added to the owner\'s review queue.'), { queued: 3 });
  assert.deepEqual(parseProgressLine('    0 posters added to the owner\'s review queue.'), { queued: 0 });
  assert.equal(parseProgressLine('    1 poster added to the owner\'s review queue.')?.queued, 1);
  assert.equal(parseProgressLine(''), null);
  assert.equal(parseProgressLine('AI: OpenAI (gpt-5 for text, gpt-image-1 at medium quality for pictures)'), null);
  assert.equal(parseProgressLine('\u001b[32m3/4 Drawing\u001b[0m')?.stage, 'drawing', 'colour codes are removed');
  assert.equal((parseProgressLine(`3/4 ${'x'.repeat(500)}`)?.detail ?? '').length, 160, 'a long line is cut short');
});

test('while a batch runs its record says what it is doing, and when it ends that is cleared', async () => {
  const r = root();
  try {
    let during: Array<Record<string, unknown>> = [];
    const exec: RunnerDeps['exec'] = async (_args, onLine) => {
      onLine?.('1/4 Reading https://oyechats.com and building the brand profile…');
      onLine?.('3/4 Drawing the posters with the picture model (no template)…');
      onLine?.('    w01-d1: attempt 1, drawing the poster…');
      onLine?.('    1 poster added to the owner\'s review queue.');
      await new Promise((done) => setTimeout(done, 80));
      during = state(r.dir);
      return { code: 0, tail: 'done' };
    };
    await makeCampaigns([client()], r.dir, deps({ exec }));
    const mid = (during[0]?.['batches'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    assert.equal(during[0]?.['status'], 'running');
    assert.equal(mid['stage'], 'drawing');
    assert.equal(mid['detail'], 'w01-d1: attempt 1, drawing the poster…');
    assert.equal(mid['queued'], 1, 'how many reached the review queue is kept');
    const done = (state(r.dir)[0]?.['batches'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    assert.equal(done['status'], 'done');
    assert.equal(done['stage'], undefined);
    assert.equal(done['detail'], undefined);
  } finally {
    r.done();
  }
});

test('the campaign list gives the dashboard what each plan is doing, a short reason for a failure, and never the raw output', async () => {
  const r = root();
  try {
    await makeCampaigns([client()], r.dir, deps({ exec: async () => ({ code: 1, tail: `${'noise '.repeat(200)}\nError: LOGO_REQUIRED: The website has no logo picture, only the name.\n` }) }));
    mkdirSync(join(r.dir, 'broken', 'campaigns'), { recursive: true });
    writeFileSync(join(r.dir, 'broken', 'campaigns', 'x.json'), '{ not json');
    const list = await listCampaigns(r.dir);
    assert.equal(list.length, 1, 'an unreadable record is left out');
    const batch = list[0]?.batches[0];
    assert.equal(batch?.status, 'failed');
    assert.equal(batch?.failure, 'Error: LOGO_REQUIRED: The website has no logo picture, only the name.');
    assert.ok(!('tail' in (batch as object)), 'the raw output is not passed on');
    assert.deepEqual(list[0]?.plan.platforms, ['instagram', 'facebook']);
    assert.equal(list[0]?.brand, 'oyechats');
    assert.deepEqual(await listCampaigns(join(r.dir, 'nowhere')), []);
  } finally {
    r.done();
  }
});

test('a failed run remembers the step it had reached, and one that stopped before the first step remembers none', async () => {
  const r = root();
  try {
    await makeCampaigns([client()], r.dir, deps({ exec: async (_args, onLine) => { onLine?.('1/4 Reading https://oyechats.com…'); onLine?.('2/4 Writing 1 new pain-point posts…'); return { code: 1, tail: 'Error: insufficient_distinct_concepts: none of the 1 posts was a new idea' }; } }));
    const stopped = (await listCampaigns(r.dir))[0]?.batches[0];
    assert.equal(stopped?.status, 'failed');
    assert.equal(stopped?.stoppedAt, 'writing');
    assert.equal(stopped?.stage, undefined, 'what it was doing is cleared');
    const r2 = root();
    try {
      await makeCampaigns([client()], r2.dir, deps({ exec: async () => ({ code: 1, tail: 'Error: LOGO_REQUIRED: no logo' }) }));
      assert.equal((await listCampaigns(r2.dir))[0]?.batches[0]?.stoppedAt, undefined);
    } finally {
      r2.done();
    }
  } finally {
    r.done();
  }
});

test('the campaign list says what happens to approved posters: nothing is scheduled while publishing is off, and how many were handed over when it is on', async () => {
  const r = root();
  try {
    await makeCampaigns([client()], r.dir, deps());
    assert.equal((await listCampaigns(r.dir))[0]?.release, undefined, 'before the first release pass there is nothing to say');
    await releaseCampaigns(r.dir, deps({ publishingEnabled: () => false }));
    assert.deepEqual((await listCampaigns(r.dir))[0]?.release, { state: 'off' });
    await releaseCampaigns(r.dir, deps({ publishingEnabled: () => true, release: async () => 3 }));
    assert.deepEqual((await listCampaigns(r.dir))[0]?.release, { state: 'on', posts: 3 });
  } finally {
    r.done();
  }
});

test('a client\'s posters are released together, under the client\'s own name, from every week file its plans made, and once however many plans it has', async () => {
  const r = root();
  try {
    let week = 0;
    const exec: RunnerDeps['exec'] = async () => {
      week += 1;
      mkdirSync(join(r.dir, 'oyechats'), { recursive: true });
      writeFileSync(join(r.dir, 'oyechats', `week-0${week}.json`), '{}');
      return { code: 0, tail: 'done' };
    };
    const a = { platforms: ['instagram'], startDate: '2026-11-06', durationDays: 1 };
    const b = { platforms: ['linkedin'], startDate: '2026-11-09', durationDays: 1 };
    await makeCampaigns([client({ brand: 'oye-chats', plans: [a, b] })], r.dir, deps({ exec }));
    const calls: Array<{ dir: string; brand: string; weekFiles: string[] }> = [];
    const out = await releaseCampaigns(r.dir, deps({ publishingEnabled: () => true, release: async (dir, options) => { calls.push({ dir, ...options }); return 2; } }));
    assert.equal(calls.length, 1, 'one release for the client, not one per plan');
    assert.equal(calls[0]?.brand, 'oye-chats', 'the client\'s name, not the site folder\'s');
    assert.deepEqual([...(calls[0]?.weekFiles ?? [])].sort(), ['week-01.json', 'week-02.json']);
    assert.equal(out.length, 2, 'both plans are recorded as released');
    assert.ok(state(r.dir).every((s) => (s['released'] as { posts: number }).posts === 2));
  } finally {
    r.done();
  }
});


test('the campaign list counts the plan\'s posters by what the owner decided, and says when releasing them failed, until a later release works', async () => {
  const r = root();
  try {
    const exec: RunnerDeps['exec'] = async () => { mkdirSync(join(r.dir, 'oyechats'), { recursive: true }); writeFileSync(join(r.dir, 'oyechats', 'week-01.json'), '{}'); return { code: 0, tail: 'done' }; };
    await makeCampaigns([client()], r.dir, deps({ exec }));
    assert.equal((await listCampaigns(r.dir))[0]?.review, undefined, 'with no review queue yet, no counts are guessed');
    const store = new ReviewStore(join(r.dir, 'oyechats'), 'oyechats');
    const add = (postId: string, planFile: string) => store.addVersion({
      postId, planFile, headline: 'A headline', caption: 'A caption', ctaUrl: 'https://oyechats.com', factIds: [], evidence: [],
      imagePath: (() => { const p = join(r.dir, `${postId}.jpg`); writeFileSync(p, postId); return p; })(),
      validation: { accepted: true, readings: 1, defects: [], reportFile: 'report.json' }, attempts: 1, costUsd: 0,
    });
    const a = add('p1', join('brands', 'oyechats', 'week-01.json'));
    const b = add('p2', 'week-01.json');
    add('p3', 'week-01.json');
    add('elsewhere', 'week-09.json');
    store.approve(a.versionId, 'owner');
    store.reject(b.versionId, 'owner', 'style');
    assert.deepEqual((await listCampaigns(r.dir))[0]?.review, { approved: 1, pending: 1, rejected: 1 }, 'another plan\'s poster is not counted, and the file may be named with or without its folder');

    await releaseCampaigns(r.dir, deps({ release: async () => { throw new Error('the schedule file could not be written'); } }));
    assert.deepEqual((await listCampaigns(r.dir))[0]?.release, { state: 'failed', reason: 'the schedule file could not be written' });
    await releaseCampaigns(r.dir, deps({ release: async () => 1 }));
    assert.deepEqual((await listCampaigns(r.dir))[0]?.release, { state: 'on', posts: 1 }, 'a later release that works replaces the failure');
  } finally {
    r.done();
  }
});

test('a client on automatic approval has its pending posters approved by the system just before release; a client on manual approval does not', async () => {
  const run = async (mode: 'manual' | 'auto'): Promise<{ statuses: Record<string, string>; by: Array<string | undefined>; released: number }> => {
    const r = root();
    try {
      const exec: RunnerDeps['exec'] = async () => {
        mkdirSync(join(r.dir, 'oyechats'), { recursive: true });
        writeFileSync(join(r.dir, 'oyechats', 'week-01.json'), JSON.stringify({ posts: [{ id: 'future', date: '2026-11-09T10:00:00+05:30' }, { id: 'past', date: '2026-11-04T10:00:00+05:30' }, { id: 'blocked', date: '2026-11-09T10:00:00+05:30' }, { id: 'other', date: '2026-11-09T10:00:00+05:30' }] }));
        return { code: 0, tail: 'done' };
      };
      await makeCampaigns([client()], r.dir, deps({ exec }));
      const store = new ReviewStore(join(r.dir, 'oyechats'), 'oyechats');
      const add = (postId: string, planFile: string, accepted = true) => store.addVersion({
        postId, planFile, headline: 'A headline', caption: 'A caption', ctaUrl: 'https://oyechats.com', factIds: [], evidence: [],
        imagePath: (() => { const p = join(r.dir, `${postId}.jpg`); writeFileSync(p, postId); return p; })(),
        validation: { accepted, readings: 1, defects: accepted ? [] : ['extra_text: x'], reportFile: 'report.json' }, attempts: 1, costUsd: 0,
      });
      add('future', 'week-01.json'); add('past', 'week-01.json'); add('blocked', 'week-01.json', false); add('other', 'week-09.json');
      let released = 0;
      await releaseCampaigns(r.dir, deps({ approvalMode: () => mode, release: async () => { released += 1; return 1; } }));
      const items = store.list();
      return { statuses: Object.fromEntries(items.map((i) => [i.version.postId, i.status])), by: items.map((i) => i.decision?.by), released };
    } finally {
      r.done();
    }
  };
  const manual = await run('manual');
  assert.deepEqual(manual.statuses, { future: 'pending', past: 'pending', blocked: 'blocked', other: 'pending' }, 'a person approves on manual');
  const auto = await run('auto');
  assert.deepEqual(auto.statuses, { future: 'approved', past: 'pending', blocked: 'blocked', other: 'pending' }, 'only a pending poster of this plan whose time is still ahead is approved; one the checks blocked, one that is already late and another plan\'s poster are left');
  assert.deepEqual(auto.by.filter(Boolean), ['auto-checks'], 'the history says the system approved it');
  assert.equal(auto.released, 1, 'it is released in the same pass');
});

test('automatic approval never touches a version that a person rejected, and approving the same version twice gives the same decision', async () => {
  const r = root();
  try {
    const exec: RunnerDeps['exec'] = async () => { mkdirSync(join(r.dir, 'oyechats'), { recursive: true }); writeFileSync(join(r.dir, 'oyechats', 'week-01.json'), JSON.stringify({ posts: [{ id: 'p1', date: '2026-11-09T10:00:00+05:30' }] })); return { code: 0, tail: 'done' }; };
    await makeCampaigns([client()], r.dir, deps({ exec }));
    const store = new ReviewStore(join(r.dir, 'oyechats'), 'oyechats');
    const v = store.addVersion({ postId: 'p1', planFile: 'week-01.json', headline: 'H', caption: 'C', ctaUrl: 'https://oyechats.com', factIds: [], evidence: [], imagePath: (() => { const p = join(r.dir, 'p1.jpg'); writeFileSync(p, 'p1'); return p; })(), validation: { accepted: true, readings: 1, defects: [], reportFile: 'r.json' }, attempts: 1, costUsd: 0 });
    store.reject(v.versionId, 'owner', 'style');
    await releaseCampaigns(r.dir, deps({ approvalMode: () => 'auto', release: async () => 0 }));
    assert.equal(store.get(v.versionId).status, 'rejected', 'a rejection by a person stands');
    const again = autoApprove(join(r.dir, 'oyechats'), 'oyechats', ['week-01.json'], NOW);
    assert.deepEqual(again, { approved: 0, left: 0 });
  } finally {
    r.done();
  }
});

test('the release tells the owner about a poster close to its time that is still waiting, once, and a notice that cannot be sent never stops the release', async () => {
  const r = root();
  try {
    const exec: RunnerDeps['exec'] = async () => {
      mkdirSync(join(r.dir, 'oyechats'), { recursive: true });
      writeFileSync(join(r.dir, 'oyechats', 'week-01.json'), JSON.stringify({ posts: [{ id: 'soon', date: '2026-11-05T20:00:00Z' }] }));
      return { code: 0, tail: 'done' };
    };
    await makeCampaigns([client()], r.dir, deps({ exec }));
    new ReviewStore(join(r.dir, 'oyechats'), 'oyechats').addVersion({
      postId: 'soon', planFile: 'week-01.json', headline: 'H', caption: 'C', ctaUrl: 'https://oyechats.com', factIds: [], evidence: [],
      imagePath: (() => { const p = join(r.dir, 'soon.jpg'); writeFileSync(p, 'soon'); return p; })(),
      validation: { accepted: true, readings: 1, defects: [], reportFile: 'report.json' }, attempts: 1, costUsd: 0,
    });
    const titles: string[] = [];
    let released = 0;
    const release = async (): Promise<number> => { released += 1; return 0; };
    await releaseCampaigns(r.dir, deps({ release, notify: async () => { throw new Error('the phone service is down'); } }));
    assert.equal(released, 1, 'a failing notice does not stop the release');
    await releaseCampaigns(r.dir, deps({ release, notify: async (n) => { titles.push(n.title); return true; } }));
    await releaseCampaigns(r.dir, deps({ release, notify: async (n) => { titles.push(n.title); return true; } }));
    assert.deepEqual(titles, ['Poster waiting for approval: oyechats'], 'told once');
  } finally {
    r.done();
  }
});

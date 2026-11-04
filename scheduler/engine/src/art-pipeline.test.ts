import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { aiConfigFromEnv } from './ai.ts';
import { optionId } from './art-director.ts';
import { planShortlists, postFacts } from './art-options.ts';
import { acquireTenantLock, ArtNotAllowedError, artDirectPlan, assertArtAllowed, loadArtSettings, readArtHistory, writeFileAtomic, type ArtTenantSettings } from './art-pipeline.ts';
import { recordRenderedArt, ReviewError, setApproval } from './art-review.ts';
import { isPublishable, parseBrand, parseWeekPlan, type Brand, type WeekPlan } from './content.ts';
import { exportToPublisher } from './export-publisher.ts';
import { chromePath } from './platform.ts';
import { renderPlan } from './render.ts';

const real = { skip: existsSync(chromePath(process.env, process.platform)) ? false : 'Chrome is not installed' };
const ai = () => aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-openai-key' });

const brandJson = {
  name: 'Acme', website: 'https://acme.example', handleUrl: 'acme.example', offer: 'Project tracking software for small teams', audience: 'Small teams', tone: 'Warm',
  proofPoints: ['Teams cut 40% of status meetings'], callToAction: 'Book a demo', rules: ['No invented prices'],
  colors: { background: '#FFFFFF', ink: '#14213D', accent: '#FCA311', tile: '#F2F2F2' }, font: 'Inter',
  features: [{ icon: 'person', title: 'Deadline reminders', detail: 'Never miss a date' }], logo: 'assets/logo.svg', mark: 'assets/logo.svg',
};
const brand = (): Brand => parseBrand(brandJson, 'brand.json');

const post = (id: string, headline: string) => ({
  id, date: '2026-11-10T10:00:00+05:30', painPoint: `pain ${id}`, mode: 'template', headline, subline: 'Acme shows where work stands', caption: 'Body', hashtags: ['#one', '#two'], hook: 'direct_statement', pillar: 'problem',
  concept: { subject: 'projects', angle: id, message: `message ${id}`, visualSubject: `project board ${id}`, visualAction: 'with cards glowing', visualComposition: 'close' },
});
const weekPlan = (count: number): WeekPlan =>
  parseWeekPlan({ brand: 'acme', timezone: 'Asia/Kolkata', posts: Array.from({ length: count }, (_, i) => post(`p${i + 1}`, `Keep every |project| number ${i + 1} visible`)) }, 'plan');

/** A director answer choosing, for each post, its first option without a picture (so no image provider is ever needed). */
function mockDirector(plan: WeekPlan, skip: string[] = []): typeof fetch {
  const b = brand();
  const planned = planShortlists({ posts: plan.posts.map((p) => postFacts(p, b)), history: [] });
  const directions = plan.posts.flatMap((p, i) => {
    if (skip.includes(p.id)) return [];
    const option = planned[i]?.shortlist.find((o) => o.pictureRole === 'none') ?? planned[i]?.shortlist[0];
    return option ? [{ postId: p.id, optionId: optionId(option), headlineScale: 'large', alignment: 'start', ...(option.pictureRole === 'none' ? {} : { picture: { medium: option.mediums[0], scene: 'a quiet workspace', composition: 'close view', mood: 'calm', paletteUse: 'balanced' } }) }] : [];
  });
  return (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ directions }) } }] }), { status: 200 })) as typeof fetch;
}

const enabled: ArtTenantSettings = { enabled: true, fallbackToLegacy: false };

test('art direction is refused unless the tenant enabled it, the kill switch is off, and a paid dry run is allowed', () => {
  const ok = { settings: enabled, env: {}, dryRun: false, allowPaidAi: false };
  assert.doesNotThrow(() => assertArtAllowed(ok));
  assert.throws(() => assertArtAllowed({ ...ok, settings: { enabled: false, fallbackToLegacy: false } }), /not enabled for this brand/);
  assert.throws(() => assertArtAllowed({ ...ok, env: { ART_DIRECTION_DISABLED: '1' } }), /switched off/);
  assert.throws(() => assertArtAllowed({ ...ok, dryRun: true }), /--allow-paid-ai/);
  assert.doesNotThrow(() => assertArtAllowed({ ...ok, dryRun: true, allowPaidAi: true }));
  assert.throws(() => assertArtAllowed({ ...ok, env: { ART_DIRECTION_DISABLED: '1' }, allowPaidAi: true }), ArtNotAllowedError);
});

test('tenant settings come from art.json: absent means off, and bad values are refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'art-settings-'));
  try {
    assert.deepEqual(await loadArtSettings(dir), { enabled: false, fallbackToLegacy: false });
    await writeFile(join(dir, 'art.json'), JSON.stringify({ enabled: true, maxCostUsd: 0.5, maxPostsPerBatch: 7 }));
    assert.deepEqual(await loadArtSettings(dir), { enabled: true, fallbackToLegacy: false, maxCostUsd: 0.5, maxPostsPerBatch: 7 });
    await writeFile(join(dir, 'art.json'), JSON.stringify({ enabled: 'yes' }));
    await assert.rejects(loadArtSettings(dir), /enabled/);
    await writeFile(join(dir, 'art.json'), JSON.stringify({ enabled: true, maxCostUsd: -1 }));
    await assert.rejects(loadArtSettings(dir), /maxCostUsd/);
    await writeFile(join(dir, 'art.json'), '{nope');
    await assert.rejects(loadArtSettings(dir), /not valid JSON/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a mocked director turns a plan into an art plan: every post has art direction awaiting approval, and the report matches', async () => {
  const plan = weekPlan(4);
  const { plan: directed, report } = await artDirectPlan({ ai: ai(), plan, brand: brand(), history: [], settings: enabled, fetchFn: mockDirector(plan) });
  assert.equal(directed.renderMode, 'art_v1');
  for (const p of directed.posts) {
    assert.ok(p.art && p.art.candidates.length >= 1, p.id);
    assert.equal(p.approval?.status, 'pending');
    assert.equal(p.artFailure, undefined);
    assert.equal(isPublishable(directed, p), false, 'not publishable until approved');
  }
  assert.equal(report.requests, 1);
  assert.equal(report.counts.failed, 0);
  assert.equal(report.posts.length, 4);
  for (const row of report.posts) assert.equal(row.requestedOptionId === undefined || row.requestedOptionId === row.actualOptionId, true);
  assert.equal(parseWeekPlan(JSON.parse(JSON.stringify(directed)), 'again').posts.length, 4, 'the art plan survives a round trip through its file');
  assert.equal(plan.renderMode, undefined, 'the input plan was not changed');
});

test('a post the director cannot direct keeps its place with the reasons, and the others are untouched', async () => {
  const plan = weekPlan(3);
  const { plan: directed, report } = await artDirectPlan({ ai: ai(), plan, brand: brand(), history: [], settings: enabled, fetchFn: mockDirector(plan, ['p2']) });
  assert.equal(directed.posts.length, 3);
  assert.ok(directed.posts[0]?.art);
  assert.equal(directed.posts.length, report.posts.length);
  assert.equal(report.counts.directed + report.counts.repaired + report.counts.fallback + report.counts.failed, 3);
});

test('art history counts approved and pending posters and never rejected ones', () => {
  const rec = (layout: string) => ({ layout, hierarchy: 'headline-first' as const, textZone: 'center' as const, pictureRole: 'none' as const });
  const history = { weeks: [{ art: [{ postId: 'a', status: 'approved' as const, record: rec('x') }, { postId: 'b', status: 'pending' as const, record: rec('y') }, { postId: 'c', status: 'rejected' as const, record: rec('z') }] }, {}] };
  assert.deepEqual(readArtHistory(history).map((r) => r.layout), ['x', 'y']);
});

test('only one run per tenant at a time, a stale lock is replaced, and release frees it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'art-lock-'));
  try {
    const release = await acquireTenantLock(dir);
    await assert.rejects(acquireTenantLock(dir), /another run holds the lock/);
    await release();
    const again = await acquireTenantLock(dir);
    await again();
    const first = await acquireTenantLock(dir);
    const old = new Date(Date.now() - 7 * 3600 * 1000);
    await utimes(join(dir, '.autopilot.lock'), old, old);
    const takenOver = await acquireTenantLock(dir);
    await takenOver();
    await first();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an atomic write leaves the old or the new file and no temporary file behind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'art-atomic-'));
  try {
    const path = join(dir, 'f.json');
    await writeFileAtomic(path, 'one');
    await writeFileAtomic(path, 'two');
    assert.equal(await readFile(path, 'utf8'), 'two');
    await assert.rejects(writeFileAtomic(join(dir, 'missing', 'f.json'), 'x'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'art-flow-'));
  const brandDir = join(root, 'brands', 'acme');
  await mkdir(join(brandDir, 'assets'), { recursive: true });
  await writeFile(join(brandDir, 'brand.json'), JSON.stringify(brandJson));
  await writeFile(join(brandDir, 'assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#14213D"/></svg>');
  return { root, brandDir };
}

test('real Chrome: an art plan renders offline, the posters wait for review, approval alone makes them publishable, and only approved art enters history', real, async () => {
  const { root, brandDir } = await workspace();
  const previous = process.cwd();
  try {
    process.chdir(root);
    const plan = weekPlan(3);
    const { plan: directed } = await artDirectPlan({ ai: ai(), plan, brand: brand(), history: [], settings: enabled, fetchFn: mockDirector(plan) });
    await writeFile(join(brandDir, 'week-01.json'), JSON.stringify(directed));
    await writeFile(join(brandDir, 'history.json'), JSON.stringify({ weeks: [{ file: 'week-01.json', createdAt: 'now', painPoints: [] }] }));
    let calls = 0;
    const guarded = ai();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => { calls += 1; throw new Error('no network in this test'); }) as typeof fetch;
    try {
      await renderPlan({ brandDir, planFile: 'week-01.json', ai: guarded, log: () => undefined });
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(calls, 0, 'no image or model call was made for pictureless posters');
    const out = join(root, 'out', 'acme', 'week-01');
    for (const id of ['p1', 'p2', 'p3']) assert.ok(existsSync(join(out, `${id}.jpg`)), id);

    assert.equal(await recordRenderedArt({ brandDir, planFile: 'week-01.json' }), 3);
    assert.equal(await recordRenderedArt({ brandDir, planFile: 'week-01.json' }), 0, 'repeating adds nothing');
    const history = JSON.parse(await readFile(join(brandDir, 'history.json'), 'utf8')) as { weeks: Array<{ art: Array<{ postId: string; status: string; record: { layout: string } }> }> };
    assert.deepEqual(history.weeks[0]?.art.map((a) => a.status), ['pending', 'pending', 'pending']);
    const rendered = JSON.parse(await readFile(join(out, 'render-report.json'), 'utf8')) as Array<{ postId: string; optionId: string }>;
    assert.equal(history.weeks[0]?.art[0]?.record.layout, rendered[0]?.optionId.split(':')[0], 'the record holds what actually rendered');

    // Nothing is exported before approval.
    const publisher = join(root, 'publisher');
    assert.equal((await exportToPublisher(brandDir, publisher)).length, 0);

    await assert.rejects(setApproval({ brandDir, planFile: 'week-01.json', postId: 'p1', decision: 'reject' }), /needs a reason/);
    await setApproval({ brandDir, planFile: 'week-01.json', postId: 'p1', decision: 'approve', by: 'Steve', now: () => new Date('2026-11-05T00:00:00Z') });
    await setApproval({ brandDir, planFile: 'week-01.json', postId: 'p2', decision: 'reject', reason: 'type too small' });
    const reread = parseWeekPlan(JSON.parse(await readFile(join(brandDir, 'week-01.json'), 'utf8')), 'week-01.json');
    assert.equal(reread.posts[0]?.approval?.status, 'approved');
    assert.equal(reread.posts[0]?.approval?.by, 'Steve');
    assert.equal(reread.posts[1]?.approval?.reason, 'type too small');
    assert.equal(reread.posts[0]?.art !== undefined, true, 'the rest of the plan file is preserved');
    const exported = await exportToPublisher(brandDir, publisher, Date.parse('2026-11-09T00:00:00Z'));
    assert.deepEqual(exported.map((e) => e.id), ['acme-p1']);
    const afterReview = JSON.parse(await readFile(join(brandDir, 'history.json'), 'utf8')) as { weeks: Array<{ art: Array<{ status: string }> }> };
    assert.deepEqual(afterReview.weeks[0]?.art.map((a) => a.status), ['approved', 'rejected', 'pending']);
    assert.equal(readArtHistory(afterReview as never).length, 2, 'the rejected poster no longer steers variety');
  } finally {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  }
});

test('real Chrome: an art plan post without art direction fails explicitly; the older renderer is used only when explicitly allowed, and is then not recorded as art', real, async () => {
  const { root, brandDir } = await workspace();
  const previous = process.cwd();
  try {
    process.chdir(root);
    const plan = weekPlan(2);
    const { plan: directed } = await artDirectPlan({ ai: ai(), plan, brand: brand(), history: [], settings: enabled, fetchFn: mockDirector(plan) });
    const broken = { ...directed, posts: [directed.posts[0], { ...(directed.posts[1] as object), art: undefined, artFailure: { reasons: ['no_valid_family: nothing fits'] } }] };
    await writeFile(join(brandDir, 'week-01.json'), JSON.stringify(broken));
    await writeFile(join(brandDir, 'history.json'), JSON.stringify({ weeks: [{ file: 'week-01.json', createdAt: 'now', painPoints: [] }] }));
    const out = join(root, 'out', 'acme', 'week-01');

    await assert.rejects(renderPlan({ brandDir, planFile: 'week-01.json', ai: ai(), log: () => undefined }), /p2/);
    assert.ok(existsSync(join(out, 'p1.jpg')));
    assert.ok(!existsSync(join(out, 'p2.jpg')), 'no silent legacy render');
    const failed = JSON.parse(await readFile(join(out, 'render-report.json'), 'utf8')) as Array<{ postId: string; status: string; failure?: string; fallback?: string }>;
    assert.match(failed.find((r) => r.postId === 'p2')?.failure ?? '', /no_valid_family/);

    await renderPlan({ brandDir, planFile: 'week-01.json', ai: ai(), log: () => undefined, artFailure: 'legacy' });
    assert.ok(existsSync(join(out, 'p2.jpg')), 'explicitly allowed fallback rendered it');
    const allowed = JSON.parse(await readFile(join(out, 'render-report.json'), 'utf8')) as Array<{ postId: string; status: string; fallback?: string }>;
    assert.equal(allowed.find((r) => r.postId === 'p2')?.fallback, 'legacy');
    assert.equal(allowed.find((r) => r.postId === 'p2')?.status, 'render_failed', 'the failed art attempt stays on record');
    await recordRenderedArt({ brandDir, planFile: 'week-01.json' });
    const history = JSON.parse(await readFile(join(brandDir, 'history.json'), 'utf8')) as { weeks: Array<{ art: Array<{ postId: string }> }> };
    assert.deepEqual(history.weeks[0]?.art.map((a) => a.postId), ['p1'], 'a legacy render is not accepted art history');
    await assert.rejects(setApproval({ brandDir, planFile: 'week-01.json', postId: 'p2', decision: 'approve' }), ReviewError);
  } finally {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  }
});

test('a legacy plan is unaffected: every post is publishable and nothing needs review', () => {
  const legacy = parseWeekPlan({ brand: 'b', timezone: 'Asia/Kolkata', posts: [post('p1', 'Plain |accent|')] }, 'plan');
  assert.equal(legacy.renderMode, undefined);
  assert.equal(isPublishable(legacy, legacy.posts[0] as never), true);
  assert.equal(isPublishable({ renderMode: 'art_v1' }, {}), false);
  assert.equal(isPublishable({ renderMode: 'art_v1' }, { approval: { status: 'approved' } }), true);
  assert.throws(() => parseWeekPlan({ brand: 'b', timezone: 'x', renderMode: 'other', posts: [post('p1', 'x')] }, 'plan'), /renderMode/);
});

test('art-review refuses what it should: unknown posts, non-art posts and approval without a verified render', async () => {
  const { root, brandDir } = await workspace();
  try {
    const legacy = { brand: 'b', timezone: 'Asia/Kolkata', posts: [post('p1', 'Plain |accent|')] };
    await writeFile(join(brandDir, 'week-01.json'), JSON.stringify(legacy));
    await writeFile(join(brandDir, 'history.json'), JSON.stringify({ weeks: [{ file: 'week-01.json', createdAt: 'now', painPoints: [] }] }));
    await assert.rejects(setApproval({ brandDir, planFile: 'week-01.json', postId: 'p9', decision: 'approve', outDir: root }), /no post "p9"/);
    await assert.rejects(setApproval({ brandDir, planFile: 'week-01.json', postId: 'p1', decision: 'approve', outDir: root }), /not an art-directed post/);
    const art = { ...legacy, renderMode: 'art_v1' };
    await writeFile(join(brandDir, 'week-01.json'), JSON.stringify(art));
    await assert.rejects(setApproval({ brandDir, planFile: 'week-01.json', postId: 'p1', decision: 'approve', outDir: root }), /no verified art-directed render/);
    assert.ok(!existsSync(join(root, 'render-report.json')));
    await stat(join(brandDir, 'history.json'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the autopilot refuses --art before doing anything paid when the brand has not enabled it', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const root = await mkdtemp(join(tmpdir(), 'art-cli-'));
  try {
    const script = join(process.cwd(), 'src', 'autopilot.ts');
    const env = { PATH: process.env['PATH'] ?? '', OPENAI_API_KEY: 'sk-test-openai-key' };
    const run = (args: string[]): Promise<{ stdout: string; stderr: string }> => promisify(execFile)('node', [script, ...args], { cwd: root, env }).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr) }));
    await assert.rejects(run(['--site', 'https://acme.example', '--art', '--dry-run']), (error: { stderr?: string }) => /not enabled for this brand/.test(error.stderr ?? ''));
    await mkdir(join(root, 'brands', 'acme'), { recursive: true });
    await writeFile(join(root, 'brands', 'acme', 'art.json'), JSON.stringify({ enabled: true }));
    await assert.rejects(run(['--site', 'https://acme.example', '--art', '--dry-run']), (error: { stderr?: string }) => /--allow-paid-ai/.test(error.stderr ?? ''));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addNetworkToBatch, type NetworkWriter } from './add-network.ts';
import { releaseCampaigns } from './campaign-runner.ts';
import { exportToPublisher, parseScheduleModule } from './export-publisher.ts';
import { composeCaption } from './content.ts';
import { CopyStage, CopyStageError } from './copy-stage.ts';
import { registerManualRelease } from './manual-release.ts';
import { composeVariant, variantTexts, type PostVariants } from './networks.ts';
import type { EvidenceFact } from './evidence.ts';
import { ReviewStore } from './review-store.ts';

process.env['SOCIAL_PUBLISHING_ENABLED'] = 'true';

const post = (id: string, variants?: PostVariants) => ({ id, date: id === 'w01-d1' ? '2099-11-10T10:00:00+05:30' : '2099-11-13T10:00:00+05:30', painPoint: 'p', mode: 'ai', headline: 'Answers from your own docs', subline: '', caption: 'Hook.\n\nSee oyechats.com (link in bio)', hashtags: ['#a'], factIds: ['f1'], imagePrompt: 'a picture', ...(variants ? { variants } : {}) });
const IG = { caption: 'ig caption (link in bio)', hashtags: ['#a'] };
const LI = { caption: 'li caption oyechats.com', hashtags: [] as string[] };

/** A fake writer: the same answer the real one gives (a caption per topic), with one topic falling back when asked. */
const writer = (fallbackFor?: string): NetworkWriter => async (posts, networks) => {
  const network = networks[0] as 'facebook';
  const variants = Object.fromEntries(posts.map((p) => [p.id, { [network]: { caption: `${network} caption for ${p.id}`, hashtags: ['#f'], ...(p.id === fallbackFor ? { fallback: true } : {}) } }]));
  return { variants, report: { requested: posts.length, written: posts.length, retried: 0, fallback: fallbackFor ? [{ postId: fallbackFor, network, reason: 'the claim gate refused it twice' }] : [] } };
};

function setup(drawn: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'add-network-'));
  const dir = join(root, 'bb-acme');
  mkdirSync(dir, { recursive: true });
  const variants = { instagram: IG, linkedin: LI };
  const plan = { brand: 'bb-acme', timezone: '+05:30', renderMode: 'ai_v1', posts: [post('w01-d1', variants), post('w01-d2', variants)] };
  writeFileSync(join(dir, 'week-01.json'), JSON.stringify(plan));
  const stage = new CopyStage(dir, 'bb-acme');
  stage.open('week-01.json', plan.posts.map((p) => ({ postId: p.id, headline: p.headline, caption: composeCaption(p), captions: Object.fromEntries(Object.entries(variantTexts(p) ?? {}).map(([n, text]) => [n, { text }])) })));
  stage.decide('week-01.json', 'w01-d1', 'kept', 'u');
  stage.decide('week-01.json', 'w01-d2', 'kept', 'u');
  const store = new ReviewStore(dir, 'bb-acme');
  const picture = join(root, 'p.jpg');
  writeFileSync(picture, 'a picture');
  const add = (postId: string, network: string, width: number, height: number) => store.addVersion({ postId, planFile: 'week-01.json', network, width, height, headline: 'Answers from your own docs', caption: `${network} caption`, ctaUrl: 'https://oyechats.com', factIds: ['f1'], evidence: [], imagePath: picture, validation: { accepted: true, readings: 2, defects: [], reportFile: 'r.json' }, attempts: 1, costUsd: 0.02 });
  if (drawn) {
    stage.markDrawn('week-01.json');
    registerManualRelease({ brandDir: dir, siteBrand: 'bb-acme', client: 'bb-acme', site: 'https://oyechats.com', planFile: 'week-01.json' });
    add('w01-d1', 'instagram', 1024, 1024);
    add('w01-d1', 'linkedin', 1536, 1024);
    add('w01-d2', 'linkedin', 1536, 1024);
  }
  return { root, dir, stage, store, add, done: () => rmSync(root, { recursive: true, force: true }) };
}
const refusal = async (work: () => Promise<unknown>): Promise<string> => {
  try { await work(); } catch (error) { assert.ok(error instanceof CopyStageError, String(error)); return error.code; }
  return assert.fail('not refused');
};
const FACT = { id: 'f1', text: 'Setup takes under 10 minutes with one script tag.', status: 'usable', intent: 'claim', attribution: 'brand' } as unknown as EvidenceFact;
const run = (s: { dir: string }, network: 'facebook' | 'google' = 'facebook', write = writer(), facts: readonly EvidenceFact[] = [FACT]) => addNetworkToBatch({ brandDir: s.dir, brand: 'bb-acme', planFile: 'week-01.json', network, facts, write });

test('a network added to a batch that is still waiting is written into the plan and the list, and the kept choices still stand', async () => {
  const s = setup(false);
  try {
    const result = await run(s, 'facebook', writer('w01-d2'));
    assert.deepEqual(result.topics.map((t) => [t.postId, t.outcome, t.fallback ?? false, t.versionIds, t.needsDraw]), [['w01-d1', 'written', false, undefined, undefined], ['w01-d2', 'written', true, undefined, undefined]]);
    assert.equal(result.topics[1]?.reasonCode, 'WORDS_REFUSED', 'a fixed code, not the writer\'s sentence');
    assert.equal(JSON.stringify(result).includes('claim gate'), false);
    const bare = setup(false);
    try {
      const none = await run(bare, 'facebook', writer('w01-d1'), []);
      assert.equal(none.topics[0]?.reasonCode, 'NO_FACTS', 'the post has no facts to lean on');
    } finally {
      bare.done();
    }
    const plan = JSON.parse(readFileSync(join(s.dir, 'week-01.json'), 'utf8')) as { posts: Array<{ id: string; variants: Record<string, { caption: string }> }> };
    assert.deepEqual(Object.keys(plan.posts[0]?.variants ?? {}).sort(), ['facebook', 'instagram', 'linkedin']);
    assert.equal(plan.posts[0]?.variants['facebook']?.caption, 'facebook caption for w01-d1');
    const batch = s.stage.get('week-01.json');
    assert.equal(batch.posts[0]?.captions?.['facebook']?.text, composeVariant({ caption: 'facebook caption for w01-d1', hashtags: ['#f'] }));
    assert.equal(batch.posts[1]?.captions?.['facebook']?.fallback, true);
    // The words changed, but the choice was made about them: the kept posts are still the ones to draw.
    const current = plan.posts.map((p) => ({ postId: p.id, headline: 'Answers from your own docs', caption: composeCaption({ caption: 'Hook.\n\nSee oyechats.com (link in bio)', hashtags: ['#a'] }), captions: variantTexts(p as never) as Record<string, string> }));
    assert.deepEqual(s.stage.toDraw('week-01.json', current), { postIds: ['w01-d1', 'w01-d2'], changed: [] });
    assert.equal(await refusal(() => run(s)), 'CONFLICT', 'a network the batch already has');
    s.stage.close('week-01.json', 'u');
    assert.equal(await refusal(() => run(s, 'google')), 'CLOSED');
  } finally {
    s.done();
  }
});

test('on a drawn batch a topic with a picture of the same shape gets a new pending version of it, a topic without one needs its own draw, and the release record gains the network', async () => {
  const s = setup(true);
  try {
    const before = JSON.parse(readFileSync(join(s.dir, 'campaigns', 'manual-week-01.json'), 'utf8')) as { plan: { platforms: string[] } };
    assert.deepEqual(before.plan.platforms, ['instagram', 'linkedin']);
    const result = await run(s);
    const [d1, d2] = result.topics;
    // d1 has an Instagram picture (square), the shape Facebook uses: its bytes are reused with Facebook's own caption.
    assert.equal(d1?.versionIds?.length, 1);
    assert.equal(d1?.needsDraw, undefined);
    const made = s.store.get(d1?.versionIds?.[0] ?? '');
    const source = s.store.list().find((i) => i.version.postId === 'w01-d1' && i.version.network === 'instagram');
    assert.deepEqual([made.status, made.version.network, made.version.imageSha256 === source?.version.imageSha256, made.version.costUsd, made.version.caption], ['pending', 'facebook', true, 0, composeVariant({ caption: 'facebook caption for w01-d1', hashtags: ['#f'] })]);
    // d2 has only a wide picture (LinkedIn): Facebook needs a square one of its own.
    assert.deepEqual([d2?.versionIds, d2?.needsDraw], [undefined, true]);
    const after = JSON.parse(readFileSync(join(s.dir, 'campaigns', 'manual-week-01.json'), 'utf8')) as { plan: { platforms: string[] } };
    assert.deepEqual(after.plan.platforms, ['instagram', 'linkedin', 'facebook']);
    assert.equal(s.store.list().filter((i) => i.version.network === 'linkedin').every((i) => i.status === 'pending'), true, 'nothing that existed changed');
  } finally {
    s.done();
  }
});

test('a post written without per-network captions keeps Instagram when a network is added', async () => {
  const s = setup(false);
  try {
    const plain = { brand: 'bb-acme', timezone: '+05:30', renderMode: 'ai_v1', posts: [post('w01-d1'), post('w01-d2')] };
    writeFileSync(join(s.dir, 'week-01.json'), JSON.stringify(plain));
    // Rebuild the batch without captions, the way an older batch has it.
    rmSync(join(s.dir, 'copy-first'), { recursive: true, force: true });
    const old = new CopyStage(s.dir, 'bb-acme');
    old.open('week-01.json', plain.posts.map((p) => ({ postId: p.id, headline: p.headline, caption: composeCaption(p) })));
    await run(s, 'google');
    const plan = JSON.parse(readFileSync(join(s.dir, 'week-01.json'), 'utf8')) as { posts: Array<{ variants: Record<string, unknown> }> };
    assert.deepEqual(Object.keys(plan.posts[0]?.variants ?? {}).sort(), ['google', 'instagram']);
    assert.deepEqual(Object.keys(old.get('week-01.json').posts[0]?.captions ?? {}).sort(), ['google', 'instagram']);
  } finally {
    s.done();
  }
});

test('a network added after a draw reaches the schedule once its new picture is approved, and nothing before', async () => {
  const s = setup(true);
  try {
    const brands = join(s.root);
    const publisher = join(s.root, 'publisher');
    const scheduled = (): Array<{ channels?: string[] }> => parseScheduleModule(readFileSync(join(publisher, 'data', 'schedule.ts'), 'utf8'));
    const release = (): Promise<unknown> => releaseCampaigns(brands, { exec: async () => ({ code: 0, tail: '' }), release: async (d: string, o: { brand: string; weekFiles: string[] }) => (await exportToPublisher(d, publisher, Date.now(), o)).length, publishingEnabled: () => true });
    const instagram = s.store.list().find((i) => i.version.postId === 'w01-d1' && i.version.network === 'instagram');
    s.store.approve(instagram?.version.versionId ?? '', 'u');
    await release();
    assert.deepEqual(scheduled().map((p) => [...(p.channels ?? [])]), [['instagram']]);

    const result = await run(s);
    await release();
    assert.deepEqual(scheduled().map((p) => [...(p.channels ?? [])]), [['instagram']], 'the new network is pending, so nothing goes out for it yet');

    s.store.approve(result.topics[0]?.versionIds?.[0] ?? '', 'u');
    await release();
    assert.deepEqual(scheduled().map((p) => [...(p.channels ?? [])].sort()), [['facebook', 'instagram']], 'approved, it goes out with the record\'s refreshed networks');
  } finally {
    s.done();
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GET as carouselsGet, POST as carouselsPost } from '../api/_v1/carousels.ts';
import { GET as postersGet } from '../api/_v1/posters.ts';
import { GET as siteJobsGet } from '../api/_v1/site-jobs.ts';
import { POST as workspacesPost } from '../api/_v1/workspaces.ts';
import { call, CHANNEL_KEY, fakeEngine, OTHER_KEY, withProducts, type FakeEngine, type FakePoster } from '../dev/product-test-kit.ts';
import { addLinkedInMember } from './channels.ts';
import { setWebsite } from './clients.ts';
import { forgetConnected } from './connected-sync.ts';
import { parseKey } from './crypto.ts';
import { loadChannels, loadClients, saveChannels, saveClients } from './store.ts';

async function withEngine(run: (engine: FakeEngine) => Promise<void>): Promise<void> {
  await withProducts(async () => {
    const engine = await fakeEngine();
    try {
      await run(engine);
    } finally {
      await engine.close();
    }
  });
}

async function workspace(externalId: string, options: { website?: boolean; linkedin?: boolean } = {}): Promise<string> {
  const made = await call(workspacesPost, '/api/v1/workspaces', { json: { externalId, name: externalId } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const brand = String((made.body['workspace'] as { id: string }).id);
  if (options.website !== false) {
    const { file, etag } = await loadClients();
    await saveClients(setWebsite(file, brand, 'acme.com'), etag);
  }
  if (options.linkedin !== false) {
    const { file, etag } = await loadChannels();
    await saveChannels(addLinkedInMember(file, brand, { urn: 'urn:li:person:abcdefabc', name: 'T' }, 'token', 5_000_000, parseKey(CHANNEL_KEY), Date.now() - 3_600_000), etag);
  }
  return brand;
}

const act = { 'x-social-actor': 'user_42' };
const hex = (n: number): string => n.toString(16).padStart(16, '0');
const LIMIT_SENTENCE = 'A carousel is already made for the week of 2026-11-16. You can make another from 2026-11-23, or reject this week\'s and make one again.';

/** A carousel of three slides waiting for the customer, with its slides as the engine keeps them (versions that belong to the carousel). */
function addCarousel(engine: FakeEngine, brand: string, status: 'pending' | 'incomplete' = 'pending'): string[] {
  const ids = [1, 2, 3].map((n) => `${brand}.${hex(100 + n)}`);
  ids.forEach((versionId, i) => {
    const slide: FakePoster = { versionId, brand, postId: `car-1-s${i + 1}`, planFile: 'week-09.json', versionNumber: 1, network: '', status: 'pending', headline: 'H', caption: '', width: 1080, height: 1080, shape: 'square', createdAt: '2026-11-12T08:00:00Z', costUsd: 0, carousel: { id: 'car-1', position: i + 1, count: 3 } };
    engine.posters.push(slide);
  });
  engine.carousels.push({ brand, id: 'car-1', topic: 'Why it works', date: '2026-11-17T10:00:00+05:30', status, slides: ids, captions: [{ network: 'linkedin', caption: 'For LinkedIn.' }] });
  return ids;
}

test('asking for a carousel starts a carousel job for the connected channels only, after the poster service is told which are connected', async () => {
  await withEngine(async (engine) => {
    forgetConnected();
    await workspace('shop-1');
    const made = await call(carouselsPost, '/api/v1/carousels', { headers: act, json: { externalId: 'shop-1', action: 'make', networks: ['linkedin', 'instagram'] } });
    assert.equal(made.status, 202, JSON.stringify(made.body));
    const job = made.body['job'] as { kind: string; state: string };
    assert.deepEqual([job.kind, job.state, made.body['created']], ['carousel', 'queued', true]);
    assert.deepEqual(engine.connected, ['linkedin']);
    const ask = engine.seen.find((r) => r.method === 'POST' && r.url === '/review/jobs');
    assert.deepEqual(ask?.body?.['networks'], ['linkedin'], 'instagram is not connected, so nothing is made for it');
    assert.equal(ask?.body?.['kind'], 'carousel');
    const order = engine.seen.filter((r) => r.url === '/review/connected' || r.url === '/review/jobs').map((r) => r.method);
    assert.deepEqual(order, ['PUT', 'POST']);
    const again = await call(carouselsPost, '/api/v1/carousels', { headers: act, json: { externalId: 'shop-1', action: 'make' } });
    assert.equal(again.status, 200);
    assert.equal(again.body['created'], false, 'a second ask while one is being made is the same job');
    const jobs = await call(siteJobsGet, '/api/v1/site-jobs?externalId=shop-1');
    assert.equal((jobs.body['jobs'] as Array<{ kind: string }>)[0]?.kind, 'carousel');
  });
});

test('a carousel is refused until the website was read and a channel is connected, and a week that has its carousel answers 429 with the day it starts again', async () => {
  await withEngine(async (engine) => {
    await workspace('shop-nosite', { website: false });
    const noSite = await call(carouselsPost, '/api/v1/carousels', { headers: act, json: { externalId: 'shop-nosite', action: 'make' } });
    assert.equal(noSite.status, 409);
    await workspace('shop-nochannel', { linkedin: false });
    const noChannel = await call(carouselsPost, '/api/v1/carousels', { headers: act, json: { externalId: 'shop-nochannel', action: 'make' } });
    assert.equal(noChannel.status, 400);
    assert.equal(noChannel.body['code'], 'CHANNEL_NOT_CONNECTED');
    await workspace('shop-1');
    assert.equal((await call(carouselsPost, '/api/v1/carousels', { headers: act, json: { externalId: 'shop-1', action: 'make', networks: ['tiktok'] } })).status, 400);
    assert.equal((await call(carouselsPost, '/api/v1/carousels', { headers: act, json: { externalId: 'shop-1', action: 'make', startDate: 'tomorrow' } })).status, 400);
    engine.carouselRefusal = { restart: '2026-11-23', error: LIMIT_SENTENCE };
    const full = await call(carouselsPost, '/api/v1/carousels', { headers: act, json: { externalId: 'shop-1', action: 'make' } });
    assert.equal(full.status, 429);
    assert.deepEqual(full.body, { error: LIMIT_SENTENCE, code: 'CAROUSEL_LIMIT_REACHED', restart: '2026-11-23' });
    engine.carouselRefusal = { restart: '2026-11-23', error: 'internal: /home/social/brands/bb-x is full' };
    const odd = await call(carouselsPost, '/api/v1/carousels', { headers: act, json: { externalId: 'shop-1', action: 'make' } });
    assert.equal(odd.status, 429);
    assert.doesNotMatch(JSON.stringify(odd.body), /home|brands|bb-x/, 'only the engine\'s fixed sentences are shown');
  });
});

test('the carousel is listed and shown whole with its slides and the words for each channel; its slides are not pictures of her own', async () => {
  await withEngine(async (engine) => {
    const brand = await workspace('shop-1');
    addCarousel(engine, brand);
    const list = await call(carouselsGet, '/api/v1/carousels?externalId=shop-1');
    assert.deepEqual(list.body, { carousels: [{ id: 'car-1', topic: 'Why it works', date: '2026-11-17T10:00:00+05:30', count: 3, status: 'pending', headlines: ['Slide 1 words', 'Slide 2 words', 'Slide 3 words'] }], weekly: false });
    const one = await call(carouselsGet, '/api/v1/carousels?externalId=shop-1&id=car-1');
    assert.equal(one.status, 200, JSON.stringify(one.body));
    const carousel = one.body['carousel'] as { id: string; count: number; status: string; slides: Array<Record<string, unknown>>; captions: Array<{ network: string; caption: string }> };
    assert.deepEqual([carousel.id, carousel.count, carousel.status], ['car-1', 3, 'pending']);
    assert.deepEqual(carousel.slides, [{ position: 1, status: 'pending', headline: 'Slide 1 words' }, { position: 2, status: 'pending', headline: 'Slide 2 words' }, { position: 3, status: 'pending', headline: 'Slide 3 words' }], 'each slide says what is printed on it, without the emphasis marks');
    assert.deepEqual(carousel.captions.map((c) => [c.network, c.caption]), [['linkedin', 'For LinkedIn.']]);
    assert.doesNotMatch(JSON.stringify(one.body), /versionId|bb-|\.0000/, 'no engine ids or brand names are passed on');
    const posters = await call(postersGet, '/api/v1/posters?externalId=shop-1&status=all');
    assert.deepEqual(posters.body['posters'], [], 'a slide is shown with its carousel, not as a picture of its own');
  });
});

test('a slide is served as a JPEG by its position, and an unknown carousel, slide or another product\'s customer is not found', async () => {
  await withEngine(async (engine) => {
    const brand = await workspace('shop-1');
    addCarousel(engine, brand);
    const image = await carouselsGet(new Request('http://x/api/v1/carousels?externalId=shop-1&id=car-1&slide=2&image=1', { headers: { authorization: `Bearer test-product-key-0123456789abcdef` } }));
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/jpeg');
    assert.equal((await call(carouselsGet, '/api/v1/carousels?externalId=shop-1&id=car-1&slide=9&image=1')).status, 404);
    assert.equal((await call(carouselsGet, '/api/v1/carousels?externalId=shop-1&id=car-404')).status, 404);
    assert.equal((await call(carouselsGet, '/api/v1/carousels?externalId=shop-1&id=../x')).status, 400);
    assert.equal((await call(carouselsGet, '/api/v1/carousels?externalId=shop-1&id=car-1', { key: OTHER_KEY })).status, 404);
  });
});

test('the customer approves or rejects the whole carousel with her name; an unfinished one cannot be approved and a reason is required to reject', async () => {
  await withEngine(async (engine) => {
    const brand = await workspace('shop-1');
    addCarousel(engine, brand);
    const noActor = await call(carouselsPost, '/api/v1/carousels', { json: { externalId: 'shop-1', action: 'approve', id: 'car-1' } });
    assert.equal(noActor.status, 400);
    assert.equal(noActor.body['code'], 'ACTOR_REQUIRED');
    assert.equal((await call(carouselsPost, '/api/v1/carousels', { headers: act, json: { externalId: 'shop-1', action: 'reject', id: 'car-1' } })).status, 400);
    const approved = await call(carouselsPost, '/api/v1/carousels', { headers: act, json: { externalId: 'shop-1', action: 'approve', id: 'car-1' } });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.deepEqual(approved.body, { carousel: { id: 'car-1', status: 'approved' } });
    const approve = engine.seen.find((r) => r.url.endsWith('/car-1/approve'));
    assert.equal(approve?.actor, 'brandbasket:user_42');
    engine.carousels[0]!.status = 'pending';
    const rejected = await call(carouselsPost, '/api/v1/carousels', { headers: act, json: { externalId: 'shop-1', action: 'reject', id: 'car-1', reason: 'weak_copy', comment: 'Too vague' } });
    assert.deepEqual(rejected.body, { carousel: { id: 'car-1', status: 'rejected' } });
    engine.carousels[0]!.status = 'incomplete';
    const unfinished = await call(carouselsPost, '/api/v1/carousels', { headers: act, json: { externalId: 'shop-1', action: 'approve', id: 'car-1' } });
    assert.equal(unfinished.status, 400);
    assert.equal((await call(carouselsPost, '/api/v1/carousels', { headers: act, json: { externalId: 'shop-1', action: 'approve', id: 'car-404' } })).status, 404);
    assert.equal((await call(carouselsPost, '/api/v1/carousels', { headers: act, json: { externalId: 'shop-1', action: 'nonsense' } })).status, 400);
  });
});

test('the weekly carousel is switched on or off by the customer and the list says whether it is on', async () => {
  await withEngine(async (engine) => {
    await workspace('shop-1');
    assert.equal(((await call(carouselsGet, '/api/v1/carousels?externalId=shop-1')).body as { weekly: boolean }).weekly, false);
    const on = await call(carouselsPost, '/api/v1/carousels', { headers: act, json: { externalId: 'shop-1', action: 'weekly', enabled: true } });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.deepEqual(on.body, { weekly: true });
    assert.equal(engine.carouselWeekly, true);
    assert.equal(((await call(carouselsGet, '/api/v1/carousels?externalId=shop-1')).body as { weekly: boolean }).weekly, true);
    assert.equal((await call(carouselsPost, '/api/v1/carousels', { headers: act, json: { externalId: 'shop-1', action: 'weekly', enabled: 'yes' } })).status, 400);
    assert.equal((await call(carouselsPost, '/api/v1/carousels', { json: { externalId: 'shop-1', action: 'weekly', enabled: false } })).status, 400, 'a person is named');
    assert.deepEqual((await call(carouselsPost, '/api/v1/carousels', { headers: act, json: { externalId: 'shop-1', action: 'weekly', enabled: false } })).body, { weekly: false });
    assert.equal((await call(carouselsPost, '/api/v1/carousels', { headers: act, json: { externalId: 'nobody', action: 'weekly', enabled: true } })).status, 404);
  });
});

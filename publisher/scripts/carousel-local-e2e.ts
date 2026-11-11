/**
 * A carousel from start to the networks, on this machine, with nothing real involved: the engine makes a carousel with stand-ins for the model, the owner approves it as a
 * whole, the engine exports it, the publisher reads the schedule file it wrote and sends the post to a client's Facebook, LinkedIn, Instagram and Google accounts, whose
 * networks are faked (every network call is answered here, and any call that is not expected stops the run). No key is read, no picture is bought, nothing is posted.
 *
 *   cd publisher && node --import ./dev/resolver.ts scripts/carousel-local-e2e.ts
 *
 * The engine's code is loaded by path, so this file does not pull the engine into the publisher's type checks.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const E = new URL('../../scheduler/engine/src', import.meta.url).pathname;
const P = new URL('../lib', import.meta.url).pathname;
process.env['SOCIAL_PUBLISHING_ENABLED'] = 'true';
const dir = mkdtempSync(join(tmpdir(), 'carousel-e2e-'));
process.env['LOCAL_STORE_DIR'] = join(dir, 'store');
process.env['CHANNEL_KEY'] = '22'.repeat(32);
delete process.env['BLOB_READ_WRITE_TOKEN'];
delete process.env['ALERT_NTFY_TOPIC'];

const { aiConfigFromEnv } = await import(`${E}/ai.ts`);
const { runCarousel } = await import(`${E}/carousel-run.ts`);
const { parseCarouselDraft } = await import(`${E}/carousel.ts`);
const { ReviewStore } = await import(`${E}/review-store.ts`);
const { exportToPublisher, parseScheduleModule } = await import(`${E}/export-publisher.ts`);
const { defaultHeadlineGate } = await import(`${E}/headline-gate.ts`);
const { parseSchedule } = await import(`${P}/schedule.ts`);
const { sendPost } = await import(`${P}/send-post.ts`);
const { addFacebookPages, addGoogleLocation, addInstagramAccount, addLinkedInMember } = await import(`${P}/channels.ts`);
const { parseKey } = await import(`${P}/crypto.ts`);
const { saveChannels } = await import(`${P}/store.ts`);

// ---- 1. The engine makes a carousel (stand-ins for the model, no spending)
const brand = { name: 'Curry Cook', website: 'https://www.currycook.com', colors: { background: '#FFF8E7', ink: '#5A0F1E', accent: '#F4B400', tile: '#EEEEEE' }, cta: { kind: 'visit-site', label: 'Order', text: 'Order at currycook.com (link in bio)', evidence: null } };
const fact = (id: string, text: string) => ({ id, text, category: 'offer', source: { quote: text, url: 'https://currycook.com/', context: 'Home', heading: '', regionType: 'prose', pageRole: 'home', contentHash: 'h' } });
const facts = [fact('f1', 'Curry Cook offers popular curry menu items.'), fact('f2', 'Curry Cook offers a Build Your Own Curry option.'), fact('f3', 'The kitchen operates daily from 11:00 AM to 10:00 PM.')];
const draft = parseCarouselDraft({ topic: 'Choosing a curry', style: 'flat vector, cream background', typography: 'heavy rounded sans-serif, burgundy, top left', slides: [
  { role: 'hook', headline: 'Not sure what |curry to choose|?', scene: 'a bowl of curry', factIds: ['f1'] },
  { role: 'content', headline: 'Or |build your own curry|', scene: 'ingredient jars', factIds: ['f2'] },
  { role: 'closing', headline: 'Open |every day|, lunch to late', scene: 'a wall clock', factIds: ['f3'] }] }, facts.map((f) => ({ id: f.id, text: f.text })));
const clean = { graphicalLogoOrIcon: false, badgeSealAwardOrCertification: false, inventedNumberPriceOrStatistic: false, interfaceOrScreenshotWithText: false, personPresentedAsCustomerOrEndorser: false, flagOrReligiousSymbol: false };
const reading = (texts: string[]) => ({ regions: texts.map((text) => ({ text, readable: true })), marks: { ...clean }, relevance: 2, composition: 2, readableSmall: true, textOverImportantArt: false, people: { present: false, estimatedCount: 0, prominent: false, description: '' }, notes: 'none' });
const brandDir = join(dir, 'brands', 'currycook');
mkdirSync(brandDir, { recursive: true });
let drawn = 0;
const when = '2099-11-18T10:00:00+05:30';
const made = await runCarousel({
  ai: aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234', AI_PROVIDER: 'openai' }), brand, brandSlug: 'currycook', brandDir, facts, networks: ['instagram', 'facebook', 'linkedin', 'google'], date: when, outRoot: join(dir, 'out'), log: (m: string) => console.log('  engine:', m),
  deps: {
    plan: async () => draft,
    captions: async () => ({ captions: { instagram: 'Swipe through to find a curry.\n\nOrder at currycook.com (link in bio)\n\n#curry', facebook: 'A quick guide to choosing a curry.\n\nOrder at currycook.com', linkedin: 'How to choose a curry: popular favourites or build your own.\n\nOrder at currycook.com', google: 'Popular curries or build your own.\n\nOrder at currycook.com' }, fallback: [] }),
    slides: { headlineGate: { enabled: false, config: defaultHeadlineGate }, scene: async (_p: string, file: string) => { drawn += 1; writeFileSync(file, Buffer.from(`slide-${drawn}-bytes`)); }, review: async () => reading([(draft.slides[(drawn - 1) % 3]?.headline ?? '').replace(/\|/g, ''), ...(drawn % 3 === 0 ? ['Curry Cook', 'currycook.com'] : [])]) },
  },
});
assert.equal(made.status, 'queued', made.reason);
console.log('1. carousel made:', made.carouselId, made.planFile);

// ---- 2. Not approved: nothing is exported
const publisherDir = join(dir, 'publisher');
assert.deepEqual(await exportToPublisher(brandDir, publisherDir, Date.now(), { brand: 'currycook' }), []);
console.log('2. unapproved carousel exports nothing: ok');

// ---- 3. The owner approves it as a whole, and it is exported as ONE post with every slide
new ReviewStore(brandDir, 'currycook').approveCarousel(made.carouselId, 'owner');
const exported = await exportToPublisher(brandDir, publisherDir, Date.now(), { brand: 'currycook' });
assert.equal(exported.length, 1);
console.log('3. exported:', JSON.stringify({ id: exported[0].id, images: exported[0].images?.length, channels: exported[0].channels, variants: Object.keys(exported[0].variants ?? {}) }));
assert.equal(exported[0].images?.length, 3);

// ---- 4. The publisher reads the generated schedule file
const fromFile = parseScheduleModule(readFileSync(join(publisherDir, 'data', 'schedule.ts'), 'utf8'));
const scheduled = parseSchedule({ posts: fromFile })[0];
assert.equal(scheduled.images.length, 3);
assert.equal(scheduled.image, scheduled.images[0]);
console.log('4. publisher parsed the schedule: images', scheduled.images.length);

// ---- 5. Fake networks: the carousel is sent to every channel
const key = parseKey(process.env['CHANNEL_KEY'] as string);
const now = Date.now();
let file = addFacebookPages({ channels: [] }, 'currycook', [{ id: '77', name: 'Curry Cook', accessToken: 'fake-page-token' }], key, now);
file = addLinkedInMember(file, 'currycook', { urn: 'urn:li:person:me', name: 'Me' }, 'fake-li-token', 5_184_000, key, now);
file = addInstagramAccount(file, 'currycook', { userId: '9', username: 'currycook_ig' }, 'fake-ig-token', 5_184_000, key, now);
file = addGoogleLocation(file, 'currycook', { account: 'accounts/1', location: 'locations/2', title: 'Curry Cook' }, 'fake-refresh-token', key, now);
process.env['GOOGLE_CLIENT_ID'] = 'fake-id';
process.env['GOOGLE_CLIENT_SECRET'] = 'fake-secret';
await saveChannels(file, null);
const calls: Array<{ method: string; url: string; body: string }> = [];
let n = 0;
const origin = 'https://pub.example';
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  const raw = init?.body;
  const body = typeof raw === 'string' ? raw : raw instanceof URLSearchParams ? decodeURIComponent(raw.toString().replace(/\+/g, ' ')) : raw ? `<${(raw as Uint8Array).length} bytes>` : '';
  calls.push({ method, url, body });
  n += 1;
  if (url.startsWith(`${origin}/posts/`)) return new Response(Buffer.from(`picture ${n}`), { status: 200, headers: { 'content-type': 'image/jpeg' } });
  if (url.includes('/rest/images?action=initializeUpload')) return Response.json({ value: { uploadUrl: `https://upload.example/u${n}`, image: `urn:li:image:${n}` } });
  if (url.startsWith('https://upload.example/')) return new Response(null, { status: 201 });
  if (url.includes('/rest/posts') && method === 'POST') return new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:999' } });
  if (url.includes('oauth2.googleapis.com')) return Response.json({ access_token: 'fake-access', expires_in: 3600 });
  if (url.includes('/localPosts') && method === 'POST') return Response.json({ name: 'accounts/1/locations/2/localPosts/3', searchUrl: 'https://g.page/fake' });
  if (url.includes('graph.facebook.com') || url.includes('graph.instagram.com')) {
    if (method === 'POST' && url.includes('/photos')) return Response.json({ id: `photo${n}` });
    if (method === 'POST' && url.includes('/feed')) return Response.json({ id: '77_555' });
    if (method === 'POST' && url.includes('media_publish')) return Response.json({ id: 'ig-media-1' });
    if (method === 'POST' && url.endsWith('/media')) return Response.json({ id: `container${n}` });
    if (url.includes('status_code')) return Response.json({ status_code: 'FINISHED' });
    if (url.includes('permalink')) return Response.json({ permalink: 'https://instagram.com/p/fake/', permalink_url: 'https://facebook.com/77_555' });
    return Response.json({ id: `x${n}`, data: [] });
  }
  throw new Error(`UNEXPECTED NETWORK CALL: ${method} ${url}`);
}) as typeof fetch;
const outcome = await sendPost(scheduled, origin, false);
const urls = calls.map((c) => `${c.method} ${c.url.replace(/\?.*$/, '')}`);
const count = (match: string): number => urls.filter((u) => u.includes(match)).length;
const body = (match: string): string => calls.find((c) => c.method === 'POST' && c.url.includes(match))?.body ?? '';

// Facebook: every picture unpublished, then one post that attaches them, with Facebook's own caption.
assert.equal(count('POST https://graph.facebook.com/v23.0/77/photos'), 3);
assert.match(body('/77/feed'), /message=A quick guide to choosing a curry/);
assert.equal((body('/77/feed').match(/attached_media\[\d\]/g) ?? []).length, 3);
// LinkedIn: every picture registered and uploaded, then one multi-image post with LinkedIn's own caption.
assert.equal(count('POST https://api.linkedin.com/rest/images'), 3);
const linkedin = JSON.parse(body('/rest/posts')) as { commentary: string; content: { multiImage: { images: Array<{ id: string }> } } };
assert.equal(linkedin.content.multiImage.images.length, 3);
assert.match(linkedin.commentary, /How to choose a curry/);
// Instagram (the client's own account): three carousel items, the carousel, then publish, with Instagram's own caption.
assert.equal(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/9/media') && c.body.includes('is_carousel_item=true')).length, 3);
assert.match(calls.find((c) => c.body.includes('media_type=CAROUSEL'))?.body ?? '', /children=container\d+,container\d+,container\d+&caption=Swipe through/);
assert.equal(count('/9/media_publish'), 1);
// Google Business: the first slide only, with Google's own caption.
const google = JSON.parse(body('/localPosts')) as { summary: string; media: unknown[] };
assert.equal(google.media.length, 1);
assert.match(google.summary, /Popular curries or build your own/);
// Nothing went through the team's one shared Instagram account, and nothing failed.
assert.equal(outcome.instagram.status, 'not-selected', 'a carousel is never sent through the team\'s shared Instagram account');
assert.ok(!outcome.failed, 'no channel failed');
assert.deepEqual([...outcome.facebook, ...outcome.linkedin, ...outcome.google, ...outcome.accounts].map((r: { status: string }) => r.status), ['posted', 'posted', 'posted', 'posted']);
console.log(`5. sent to Facebook, LinkedIn, Google Business and Instagram: ${calls.length} fake network calls, every channel with its own caption`);
console.log('OK: the carousel went from the engine to every fake network.');
rmSync(dir, { recursive: true, force: true });

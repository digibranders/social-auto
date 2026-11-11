# Carousel Posting Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A scheduled post can carry two to ten pictures (`images`) and the publisher sends it as a carousel to Instagram (the team's account and customers' accounts), Facebook and LinkedIn; Google Business keeps posting the cover picture only.

**Architecture:** `ScheduledPost` and `PostToSend` gain an optional `images` list whose first entry is the cover (`image`). The four senders in `publisher/lib/crosspost.ts` ask one helper, `pictureUrls`, for the public addresses and choose the carousel call when there are two or more. The platform calls already exist for Instagram and LinkedIn (PR 78); Facebook gets `postPhotos`. Nothing creates a post with `images` yet (that is plan 2 to 4), so shipping this changes nothing live.

**Tech Stack:** TypeScript run by Node's type stripping, `node:test` with `mock.method(globalThis, 'fetch')` and stub API objects, no new dependencies.

**Working directory for every command:** `/Users/siddiqueahmed/social-auto-merge/publisher` (the checkout used for pull requests; link the installed tools with `ln -sfn /Users/siddiqueahmed/social-auto/publisher/node_modules node_modules` and remove the link before committing).

Tests: `node --import ./dev/resolver.ts --test lib/<file>.test.ts`. Whole suite: `npm test`. Types: `npm run typecheck`.

---

### Task 1: A scheduled post may carry pictures

**Files:**
- Modify: `publisher/lib/schedule.ts` (the `ScheduledPost` interface near line 3 to 24, and the end of `parseSchedule`)
- Modify: `publisher/lib/variants.ts:85-89` (`forPlatform`)
- Test: `publisher/lib/schedule.test.ts`, `publisher/lib/variants.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `publisher/lib/schedule.test.ts`:

```ts
test('a post may carry two to ten pictures as a carousel, and its first picture is its cover', () => {
  const base = { id: 'c1', brand: 'b', date: '2026-12-10T10:00:00+05:30', caption: 'Words' };
  const three = ['/posts/b/1.jpg', '/posts/b/2.jpg', '/posts/b/3.jpg'];
  const [filled] = parseSchedule({ posts: [{ ...base, image: null, images: three }] });
  assert.deepEqual(filled?.images, three);
  assert.equal(filled?.image, '/posts/b/1.jpg', 'a missing cover is the first picture');
  const [same] = parseSchedule({ posts: [{ ...base, image: '/posts/b/1.jpg', images: three }] });
  assert.equal(same?.image, '/posts/b/1.jpg');
  const [plain] = parseSchedule({ posts: [{ ...base, image: '/posts/b/1.jpg' }] });
  assert.equal(plain?.images, undefined, 'a post with one picture has no list');

  for (const bad of [
    { image: null, images: ['/posts/b/1.jpg'] },
    { image: null, images: Array.from({ length: 11 }, (_, i) => `/posts/b/${i}.jpg`) },
    { image: null, images: ['/posts/b/1.jpg', ''] },
    { image: null, images: '/posts/b/1.jpg' },
    { image: '/posts/b/9.jpg', images: three },
  ]) {
    assert.throws(() => parseSchedule({ posts: [{ ...base, ...bad }] }), ScheduleError, JSON.stringify(bad));
  }
});
```

Append to `publisher/lib/variants.test.ts`:

```ts
test('a carousel keeps its pictures: a network\'s own caption applies, a network\'s own picture does not', () => {
  const carousel = { id: 'c1', date: '2026-12-10T10:00:00+05:30', caption: 'Main', image: '/posts/b/1.jpg', images: ['/posts/b/1.jpg', '/posts/b/2.jpg'], variants: { linkedin: { caption: 'For LinkedIn', image: '/posts/b/other.jpg' } } } as unknown as ScheduledPost;
  const forLinkedIn = forPlatform(carousel, 'linkedin');
  assert.equal(forLinkedIn.caption, 'For LinkedIn');
  assert.equal(forLinkedIn.image, '/posts/b/1.jpg');
  assert.deepEqual(forLinkedIn.images, ['/posts/b/1.jpg', '/posts/b/2.jpg']);
  assert.equal(forPlatform(carousel, 'facebook'), carousel, 'a network without a version of its own gets the post as it is');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import ./dev/resolver.ts --test lib/schedule.test.ts lib/variants.test.ts`
Expected: the two new tests FAIL (`images` is dropped or not validated, and `forPlatform` replaces the cover).

- [ ] **Step 3: Write the minimal implementation**

In `publisher/lib/schedule.ts`, add after the `ScheduledPost` interface's `image: string | null;` line:

```ts
  /** A carousel: two to ten pictures shown together, in order. `image` is the first of them (the cover). Absent for a post with one picture. */
  images?: string[];
```

and above `export interface ScheduledPost` add:

```ts
/** A carousel shows between two and ten pictures. */
export const MIN_CAROUSEL_PICTURES = 2;
export const MAX_CAROUSEL_PICTURES = 10;
```

Replace the last statement of the `parseSchedule` callback, `return p as unknown as ScheduledPost;`, with:

```ts
    if (p['images'] === undefined) return p as unknown as ScheduledPost;
    const images = p['images'];
    if (!Array.isArray(images) || images.length < MIN_CAROUSEL_PICTURES || images.length > MAX_CAROUSEL_PICTURES || images.some((entry) => typeof entry !== 'string' || !entry)) {
      throw new ScheduleError(`posts[${i}].images must be a list of ${MIN_CAROUSEL_PICTURES} to ${MAX_CAROUSEL_PICTURES} non-empty strings`);
    }
    if (typeof p['image'] === 'string' && p['image'] !== images[0]) throw new ScheduleError(`posts[${i}].image must be the first of images`);
    return { ...p, image: images[0] } as unknown as ScheduledPost;
```

In `publisher/lib/variants.ts` replace the body of `forPlatform` after `if (!variant) return post;` with:

```ts
  // A carousel keeps its pictures: a network's own caption applies, a network's own picture does not (a carousel has one set of slides).
  if (post.images) return { ...post, caption: variant.caption ?? post.caption };
  return { ...post, caption: variant.caption ?? post.caption, image: variant.image ?? post.image };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import ./dev/resolver.ts --test lib/schedule.test.ts lib/variants.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add publisher/lib/schedule.ts publisher/lib/variants.ts publisher/lib/schedule.test.ts publisher/lib/variants.test.ts
git commit -m "A scheduled post may carry two to ten pictures as a carousel"
```

---

### Task 2: Facebook posts several pictures as one post

**Files:**
- Modify: `publisher/lib/facebook.ts` (add after `postPhotoFromUrl`, near line 121)
- Test: `publisher/lib/facebook.test.ts`

- [ ] **Step 1: Write the failing test**

Change the import line of `publisher/lib/facebook.test.ts` to also import `postPhotos` (add it to the braces), then append:

```ts
test('postPhotos uploads each picture unpublished, then makes one post that attaches them in order', async () => {
  const calls: Array<{ url: string; form: URLSearchParams }> = [];
  const fetchMock = mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), form: new URLSearchParams(String(init?.body)) });
    return Response.json({ id: calls.length < 4 ? `photo${calls.length}` : '77_post9' });
  });
  try {
    const posted = await postPhotos('77', 'page-token', ['https://p.example/1.jpg', 'https://p.example/2.jpg', 'https://p.example/3.jpg'], 'The words.\n\n#tag');
    assert.deepEqual(posted, { postId: '77_post9' });
  } finally {
    fetchMock.mock.restore();
  }
  assert.equal(calls.length, 4);
  assert.match(calls[0]?.url ?? '', /\/77\/photos$/);
  assert.equal(calls[0]?.form.get('url'), 'https://p.example/1.jpg');
  assert.equal(calls[0]?.form.get('published'), 'false');
  assert.equal(calls[0]?.form.get('caption'), null, 'the words belong to the post, not to a picture');
  assert.match(calls[3]?.url ?? '', /\/77\/feed$/);
  assert.equal(calls[3]?.form.get('message'), 'The words.\n\n#tag');
  assert.equal(calls[3]?.form.get('attached_media[0]'), JSON.stringify({ media_fbid: 'photo1' }));
  assert.equal(calls[3]?.form.get('attached_media[2]'), JSON.stringify({ media_fbid: 'photo3' }));
});

test('postPhotos refuses too few or too many pictures before sending, and names the step that failed', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => Response.json({ error: { message: 'bad picture' } }, { status: 400 }));
  try {
    await assert.rejects(postPhotos('77', 't', ['https://p.example/1.jpg'], 'c'), (e: unknown) => e instanceof FacebookApiError && /needs 2 to 10 pictures, not 1/.test(e.message));
    await assert.rejects(postPhotos('77', 't', Array.from({ length: 11 }, (_, i) => `https://p.example/${i}.jpg`), 'c'), /needs 2 to 10 pictures, not 11/);
    assert.equal(fetchMock.mock.callCount(), 0, 'nothing was sent');
    await assert.rejects(postPhotos('77', 't', ['https://p.example/1.jpg', 'https://p.example/2.jpg'], 'c'), /photo upload failed.*bad picture/);
  } finally {
    fetchMock.mock.restore();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import ./dev/resolver.ts --test lib/facebook.test.ts`
Expected: FAIL (`postPhotos` is not exported).

- [ ] **Step 3: Write the minimal implementation**

Add to `publisher/lib/facebook.ts` after `postPhotoFromUrl`:

```ts
/** A post with several pictures holds two to ten of them. */
export const PHOTOS_MIN = 2;
export const PHOTOS_MAX = 10;

/**
 * Posts several pictures as one timeline post: each is uploaded unpublished (Facebook fetches it by address), then one post attaches them all in order.
 * The words belong to the post, not to any picture.
 */
export async function postPhotos(pageId: string, pageToken: string, imageUrls: readonly string[], caption: string): Promise<{ postId: string }> {
  if (imageUrls.length < PHOTOS_MIN || imageUrls.length > PHOTOS_MAX) {
    throw new FacebookApiError('photo post', `a post with several pictures needs ${PHOTOS_MIN} to ${PHOTOS_MAX} pictures, not ${imageUrls.length}`);
  }
  const photoIds: string[] = [];
  for (const url of imageUrls) {
    const uploaded = await graph('photo upload', `/${pageId}/photos`, { method: 'POST', body: new URLSearchParams({ url, published: 'false', access_token: pageToken }) });
    photoIds.push(textOf(uploaded, 'id', 'photo upload'));
  }
  const form = new URLSearchParams({ message: caption, access_token: pageToken });
  photoIds.forEach((id, i) => form.set(`attached_media[${i}]`, JSON.stringify({ media_fbid: id })));
  const post = await graph('photo post', `/${pageId}/feed`, { method: 'POST', body: form });
  return { postId: textOf(post, 'id', 'photo post') };
}
```

If `FacebookApiError`'s constructor is not `(step, detail)`, match what `graph` throws (see `publisher/lib/facebook.ts:9-22`) and adjust the two `throw` lines to use the same constructor arguments.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import ./dev/resolver.ts --test lib/facebook.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add publisher/lib/facebook.ts publisher/lib/facebook.test.ts
git commit -m "Facebook: post several pictures as one post"
```

---

### Task 3: The channel senders choose the carousel call

**Files:**
- Modify: `publisher/lib/crosspost.ts` (imports; the `FacebookApi`, `LinkedInApi`, `InstagramApi` interfaces; `PostToSend`; `postToFacebook`, `postToLinkedIn`, `postToInstagram`; new `pictureUrls`)
- Test: create `publisher/lib/carousel-send.test.ts`

- [ ] **Step 1: Write the failing test**

Create `publisher/lib/carousel-send.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addFacebookPages, addInstagramAccount, addLinkedInMember, postedKey, type PostedLog } from './channels.ts';
import { parseKey } from './crypto.ts';
import { pictureUrls, postToFacebook, postToInstagram, postToLinkedIn, type FacebookApi, type InstagramApi, type LinkedInApi } from './crosspost.ts';

const KEY = parseKey('11'.repeat(32));
const T0 = Date.parse('2026-10-30T09:00:00Z');
const NOW = Date.parse('2026-11-11T05:00:00Z');
const ORIGIN = 'https://pub.example';
const three = ['/posts/acme/1.jpg', '/posts/acme/2.jpg', '/posts/acme/3.jpg'];
const carousel = { id: 'c1', brand: 'acme', date: '2026-11-11T10:00:00+05:30', caption: 'Words.', image: three[0] as string, images: three };
const single = { id: 's1', brand: 'acme', date: '2026-11-11T10:00:00+05:30', caption: 'One.', image: three[0] as string };

const facebookChannels = addFacebookPages({ channels: [] }, 'acme', [{ id: '77', name: 'Acme', accessToken: 'page-token' }], KEY, T0);
const linkedInChannels = addLinkedInMember({ channels: [] }, 'acme', { urn: 'urn:li:person:me', name: 'Me' }, 'li-token', 5_184_000, KEY, T0);
const instagramChannels = addInstagramAccount({ channels: [] }, 'acme', { userId: '9', username: 'acme_ig' }, 'ig-token', 5_184_000, KEY, T0);

const options = <A>(channels: Parameters<typeof postToFacebook>[0]['channels'], api: A, extra: Record<string, unknown> = {}) => {
  const recorded: PostedLog = {};
  return { post: carousel, channels, key: KEY, origin: ORIGIN, log: {} as PostedLog, dryRun: false, api, now: NOW, record: async (k: string, e: PostedLog[string]) => void (recorded[k] = e), recorded, ...extra };
};

const facebookApi = (): FacebookApi & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    postPhotoFromUrl: async (_page, _token, url, caption) => { calls.push(`single ${url} ${caption}`); return { photoId: 'photo1', postId: '77_single' }; },
    postPhotos: async (page, _token, urls, caption) => { calls.push(`carousel ${page} ${urls.join(',')} ${caption}`); return { postId: '77_carousel' }; },
    postLink: async (id) => `https://facebook.com/${id}`,
    pageHealth: async () => ({ ok: true }),
  };
};

const linkedInApi = (): LinkedInApi & { calls: string[] } => {
  const calls: string[] = [];
  let n = 0;
  return {
    calls,
    fetchImage: async (url) => new TextEncoder().encode(url),
    uploadImage: async () => 'urn:li:digitalmediaAsset:one',
    postImage: async (_token, _author, asset, caption) => { calls.push(`single ${asset} ${caption}`); return { urn: 'urn:li:share:single', url: 'https://linkedin.com/single' }; },
    uploadImageUrn: async (_token, _owner, image) => { n += 1; calls.push(`upload ${new TextDecoder().decode(image)}`); return `urn:li:image:${n}`; },
    postMultiImage: async (_token, _author, images, caption) => { calls.push(`carousel ${images.map((i) => `${i.urn}|${i.altText}`).join(',')} ${caption}`); return { urn: 'urn:li:share:carousel', url: 'https://linkedin.com/carousel' }; },
    memberHealth: async () => ({ ok: true }),
  };
};

const instagramApi = (): InstagramApi & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    createImageContainer: async (_user, _token, url, caption) => { calls.push(`item ${url} ${caption}`); return 'single-container'; },
    waitUntilReady: async (id) => { calls.push(`ready ${id}`); },
    prepareCarousel: async (user, _token, urls, caption) => { calls.push(`carousel ${user} ${urls.join(',')} ${caption}`); return { containerId: 'carousel-container' }; },
    publishContainer: async (_user, _token, id) => { calls.push(`publish ${id}`); return `media-of-${id}`; },
    permalink: async (id) => `https://instagram.com/p/${id}/`,
    tokenHealth: async () => ({ ok: true }),
  };
};

test('pictureUrls answers every picture of a carousel in order, the one picture of a plain post, or none', () => {
  assert.deepEqual(pictureUrls(carousel, ORIGIN), three.map((p) => `${ORIGIN}${p}`));
  assert.deepEqual(pictureUrls(single, ORIGIN), [`${ORIGIN}/posts/acme/1.jpg`]);
  assert.deepEqual(pictureUrls({ image: null }, ORIGIN), []);
  assert.deepEqual(pictureUrls({ image: '/a.jpg', images: ['/a.jpg'] }, ORIGIN), [`${ORIGIN}/a.jpg`], 'a list of one is a plain post');
});

test('Facebook gets a carousel as one post of several pictures, and a plain post as one picture', async () => {
  const api = facebookApi();
  const sent = options(facebookChannels, api);
  const results = await postToFacebook(sent as never);
  assert.deepEqual(results.map((r) => r.status), ['posted']);
  assert.equal(api.calls[0], `carousel 77 ${three.map((p) => `${ORIGIN}${p}`).join(',')} Words.`);
  assert.equal(sent.recorded[postedKey('c1', 'facebook:77')]?.remoteId, '77_carousel');
  assert.equal(results[0]?.permalink, 'https://facebook.com/77_carousel');

  const plainApi = facebookApi();
  await postToFacebook(options(facebookChannels, plainApi, { post: single }) as never);
  assert.deepEqual(plainApi.calls, [`single ${ORIGIN}/posts/acme/1.jpg One.`]);

  const dry = facebookApi();
  const dryResults = await postToFacebook(options(facebookChannels, dry, { dryRun: true }) as never);
  assert.deepEqual([dryResults[0]?.status, dry.calls], ['dry-run-ready', []]);
});

test('LinkedIn gets a carousel as pictures uploaded in order and shared as one multi-image post, and a plain post as before', async () => {
  const api = linkedInApi();
  const sent = options(linkedInChannels, api);
  const results = await postToLinkedIn(sent as never);
  assert.deepEqual(results.map((r) => r.status), ['posted']);
  assert.deepEqual(api.calls, [
    `upload ${ORIGIN}/posts/acme/1.jpg`,
    `upload ${ORIGIN}/posts/acme/2.jpg`,
    `upload ${ORIGIN}/posts/acme/3.jpg`,
    'carousel urn:li:image:1|Slide 1 of 3,urn:li:image:2|Slide 2 of 3,urn:li:image:3|Slide 3 of 3 Words.',
  ]);
  assert.equal(sent.recorded[postedKey('c1', linkedInChannels.channels[0]?.id ?? '')]?.remoteId, 'urn:li:share:carousel');

  const plainApi = linkedInApi();
  await postToLinkedIn(options(linkedInChannels, plainApi, { post: single }) as never);
  assert.deepEqual(plainApi.calls, ['single urn:li:digitalmediaAsset:one One.']);
});

test('Instagram gets a carousel as one prepared container that is then published, and a plain post as one picture', async () => {
  const api = instagramApi();
  const sent = options(instagramChannels, api);
  const results = await postToInstagram(sent as never);
  assert.deepEqual(results.map((r) => r.status), ['posted']);
  assert.deepEqual(api.calls, [`carousel 9 ${three.map((p) => `${ORIGIN}${p}`).join(',')} Words.`, 'publish carousel-container']);
  assert.equal(sent.recorded[postedKey('c1', 'instagram:9')]?.remoteId, 'media-of-carousel-container');

  const plainApi = instagramApi();
  await postToInstagram(options(instagramChannels, plainApi, { post: single }) as never);
  assert.deepEqual(plainApi.calls, [`item ${ORIGIN}/posts/acme/1.jpg One.`, 'ready single-container', 'publish single-container']);
});

test('a carousel without a cover picture fails clearly, and a failing channel does not throw', async () => {
  const api = facebookApi();
  const results = await postToFacebook(options(facebookChannels, api, { post: { ...carousel, image: null, images: undefined } }) as never);
  assert.equal(results[0]?.status, 'failed');
  assert.match(results[0]?.error ?? '', /no picture/);
  const failing = { ...facebookApi(), postPhotos: async () => { throw new Error('Facebook said no'); } };
  const failed = await postToFacebook(options(facebookChannels, failing) as never);
  assert.deepEqual([failed[0]?.status, failed[0]?.error], ['failed', 'Facebook said no']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import ./dev/resolver.ts --test lib/carousel-send.test.ts`
Expected: FAIL (`pictureUrls` is not exported; the API interfaces have no carousel methods).

- [ ] **Step 3: Write the minimal implementation**

In `publisher/lib/crosspost.ts`:

1. Change the LinkedIn import to `import type { CarouselImage, LinkedInPost, Visibility } from './linkedin.js';`.
2. Add to `FacebookApi` (after `postPhotoFromUrl`): 
```ts
  postPhotos(pageId: string, token: string, imageUrls: readonly string[], caption: string): Promise<{ postId: string }>;
```
3. Add to `LinkedInApi` (after `postImage`):
```ts
  uploadImageUrn(token: string, ownerUrn: string, image: Uint8Array): Promise<string>;
  postMultiImage(token: string, authorUrn: string, images: readonly CarouselImage[], caption: string, visibility: Visibility): Promise<LinkedInPost>;
```
4. Add to `InstagramApi` (after `createImageContainer`):
```ts
  prepareCarousel(userId: string, token: string, imageUrls: readonly string[], caption: string): Promise<{ containerId: string }>;
```
5. Add to `PostToSend` (after `image`):
```ts
  /** A carousel: every picture in order, the first being `image`. Absent for a post with one picture. */
  images?: string[];
```
6. Add above `postToFacebook`:
```ts
/**
 * The public addresses of every picture a post carries, the cover first. A post with a list of two or more is a carousel; otherwise it is the one `image`,
 * or nothing when the poster is gone.
 */
export function pictureUrls(post: { image: string | null; images?: string[] }, origin: string): string[] {
  const paths = post.images && post.images.length > 1 ? post.images : post.image ? [post.image] : [];
  return paths.map((path) => `${origin}${path}`);
}
```
7. In `postToFacebook` replace
```ts
      const posted = await api.postPhotoFromUrl(channel.pageId, token, `${options.origin}${post.image}`, post.caption);
```
with
```ts
      const urls = pictureUrls(post, options.origin);
      const posted = urls.length > 1
        ? { photoId: '', postId: (await api.postPhotos(channel.pageId, token, urls, post.caption)).postId }
        : await api.postPhotoFromUrl(channel.pageId, token, urls[0] as string, post.caption);
```
8. In `postToLinkedIn` replace the three lines from `const image = await api.fetchImage(...)` to `const posted = await api.postImage(...)` with:
```ts
      const urls = pictureUrls(post, options.origin);
      let posted: LinkedInPost;
      if (urls.length > 1) {
        const references: CarouselImage[] = [];
        for (const [i, url] of urls.entries()) {
          const urn = await api.uploadImageUrn(token, channel.memberUrn, await api.fetchImage(url));
          references.push({ urn, altText: `Slide ${i + 1} of ${urls.length}` });
        }
        posted = await api.postMultiImage(token, channel.memberUrn, references, post.caption, 'PUBLIC');
      } else {
        const image = await api.fetchImage(urls[0] as string);
        const asset = await api.uploadImage(token, channel.memberUrn, image);
        posted = await api.postImage(token, channel.memberUrn, asset, post.caption, 'PUBLIC');
      }
```
9. In `postToInstagram` replace
```ts
      const container = await api.createImageContainer(channel.userId, token, `${options.origin}${post.image}`, post.caption);
      await api.waitUntilReady(container, token);
```
with
```ts
      const urls = pictureUrls(post, options.origin);
      let container: string;
      if (urls.length > 1) {
        container = (await api.prepareCarousel(channel.userId, token, urls, post.caption)).containerId;
      } else {
        container = await api.createImageContainer(channel.userId, token, urls[0] as string, post.caption);
        await api.waitUntilReady(container, token);
      }
```
`postToGoogle` is unchanged on purpose: it sends `post.image`, the cover.

- [ ] **Step 4: Run the test and the typecheck to verify they pass**

Run: `node --import ./dev/resolver.ts --test lib/carousel-send.test.ts && npm run typecheck`
Expected: PASS. If the typecheck reports that an existing test's stub API object lacks the new methods (`postPhotos`, `uploadImageUrn`, `postMultiImage`, `prepareCarousel`), add a stub that throws `new Error('not used')` for each missing method in that test file's `fakeApi`/`api` object, then re-run.

- [ ] **Step 5: Commit**

```bash
git add publisher/lib/crosspost.ts publisher/lib/carousel-send.test.ts
git commit -m "The channel senders post a carousel to Instagram, Facebook and LinkedIn"
```

---

### Task 4: The real senders and the team's own Instagram

**Files:**
- Modify: `publisher/lib/send-post.ts` (imports and the three API objects near lines 5-30; `sendToInstagram`)
- Test: `publisher/lib/send-post.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `publisher/lib/send-post.test.ts` (add `mock` to the `node:test` import and `ScheduledPost` is already imported):

```ts
test('a carousel for the team\'s Instagram account is prepared as one container, and a dry run publishes nothing', async () => {
  const log: string[] = [];
  let n = 0;
  const fetchMock = mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('media_publish')) { log.push('PUBLISHED'); return Response.json({ id: 'media1' }); }
    if (init?.method === 'POST' && url.endsWith('/media')) {
      const form = new URLSearchParams(String(init.body));
      n += 1;
      log.push(form.get('media_type') === 'CAROUSEL' ? `carousel(${form.get('children')})` : `item(${form.get('image_url')})`);
      return Response.json({ id: `c${n}` });
    }
    if (url.includes('fields=status_code')) return Response.json({ status_code: 'FINISHED' });
    return Response.json({ data: [] });
  });
  const before = { token: process.env['INSTAGRAM_TOKEN'], user: process.env['INSTAGRAM_USER_ID'] };
  process.env['INSTAGRAM_TOKEN'] = 'ig-token';
  process.env['INSTAGRAM_USER_ID'] = '9';
  try {
    await withLocalStore(async () => {
      const post: ScheduledPost = { brand: 'acme', id: 'c1', date: '2026-11-11T10:00:00+05:30', caption: 'Words.', image: '/posts/acme/1.jpg', images: ['/posts/acme/1.jpg', '/posts/acme/2.jpg', '/posts/acme/3.jpg'] };
      const outcome = await sendPost(post, 'https://pub.example', true);
      assert.equal(outcome.instagram['status'], 'dry-run-ready');
      assert.equal(outcome.instagram['container'], 'c4');
    });
  } finally {
    fetchMock.mock.restore();
    if (before.token === undefined) delete process.env['INSTAGRAM_TOKEN']; else process.env['INSTAGRAM_TOKEN'] = before.token;
    if (before.user === undefined) delete process.env['INSTAGRAM_USER_ID']; else process.env['INSTAGRAM_USER_ID'] = before.user;
  }
  assert.deepEqual(log, ['item(https://pub.example/posts/acme/1.jpg)', 'item(https://pub.example/posts/acme/2.jpg)', 'item(https://pub.example/posts/acme/3.jpg)', 'carousel(c1,c2,c3)']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import ./dev/resolver.ts --test lib/send-post.test.ts`
Expected: FAIL (the single-picture path creates one container of the cover only, so the log has one `item(...)` and no `carousel(...)`).

- [ ] **Step 3: Write the minimal implementation**

In `publisher/lib/send-post.ts`:

1. Change the imports:
```ts
import { postToFacebook, postToGoogle, postToInstagram, postToLinkedIn, pictureUrls, type CrosspostResult, type FacebookApi, type GoogleApi, type InstagramApi, type LinkedInApi } from './crosspost.js';
import { pageHealth, postLink, postPhoto, postPhotoFromUrl, postPhotos } from './facebook.js';
```
(keep the names already imported from `./facebook.js`; add `postPhotos`) and
```ts
import { createImageContainer, permalink, prepareCarousel, publishContainer, recentMedia, tokenHealth, waitUntilReady } from './instagram.js';
import { fetchImage, memberHealth, postImage, postMultiImage, uploadImage, uploadImageUrn } from './linkedin.js';
```
2. Extend the API objects:
```ts
const facebookApi: FacebookApi = { postPhotoFromUrl, postPhotos, postLink, pageHealth };
const linkedInApi: LinkedInApi = { fetchImage, uploadImage, postImage, uploadImageUrn, postMultiImage, memberHealth };
const instagramApi: InstagramApi = { createImageContainer, waitUntilReady, prepareCarousel, publishContainer, permalink, tokenHealth };
```
(If `postPhoto` was not imported before, do not add it; only add `postPhotos`.)
3. In `sendToInstagram`, replace
```ts
  const containerId = await createImageContainer(userId, token, `${origin}${post.image}`, post.caption);
  await waitUntilReady(containerId, token);
```
with
```ts
  const urls = pictureUrls(post, origin);
  let containerId: string;
  if (urls.length > 1) {
    containerId = (await prepareCarousel(userId, token, urls, post.caption)).containerId;
  } else {
    containerId = await createImageContainer(userId, token, urls[0] as string, post.caption);
    await waitUntilReady(containerId, token);
  }
```

- [ ] **Step 4: Run the test and the typecheck to verify they pass**

Run: `node --import ./dev/resolver.ts --test lib/send-post.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add publisher/lib/send-post.ts publisher/lib/send-post.test.ts
git commit -m "Send a carousel through the real Instagram, Facebook and LinkedIn calls"
```

---

### Task 5: The feed tells a carousel from a plain post

**Files:**
- Modify: `publisher/lib/schedule.ts` (the `StatusPost` interface and the builder near line 208-222), `publisher/lib/post-view.ts:26-40`
- Test: `publisher/lib/schedule.test.ts`, `publisher/lib/post-view.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `publisher/lib/schedule.test.ts`:

```ts
test('the status feed lists every picture of a carousel with absolute addresses, and nothing extra for a plain post', () => {
  const carouselPost = { ...scheduled('car', 24, 'Words'), image: '/posts/b/car-1.jpg', images: ['/posts/b/car-1.jpg', '/posts/b/car-2.jpg'] } as unknown as ScheduledPost;
  const plainPost = scheduled('plain', 48, 'One') as unknown as ScheduledPost;
  const status = buildStatus([carouselPost, plainPost], [], NOW, 'https://pub.example');
  const car = status.posts.find((p) => p.id === 'car');
  const plain = status.posts.find((p) => p.id === 'plain');
  assert.deepEqual(car?.images, ['https://pub.example/posts/b/car-1.jpg', 'https://pub.example/posts/b/car-2.jpg']);
  assert.equal(car?.image, 'https://pub.example/posts/b/car-1.jpg');
  assert.equal(plain?.images, undefined);
});
```

(If `buildStatus`'s signature in this file differs from `(posts, media, now, origin)`, read how the existing tests in `schedule.test.ts` call it and use the same call shape.)

Append to `publisher/lib/post-view.test.ts`:

```ts
test('the product view of a carousel lists its pictures, and a plain post has no list', () => {
  const base = { id: 'p1', date: '2026-12-10T10:00:00+05:30', caption: 'Words' };
  const channels = { channels: [] };
  const carousel = scheduledView({ ...base, image: '/posts/x/1.jpg', images: ['/posts/x/1.jpg', '/posts/x/2.jpg'] } as ScheduledPost, channels, {}, Date.parse('2026-12-01T00:00:00Z'), 'https://pub.example');
  assert.deepEqual(carousel['imageUrls'], ['https://pub.example/posts/x/1.jpg', 'https://pub.example/posts/x/2.jpg']);
  assert.equal(carousel['imageUrl'], 'https://pub.example/posts/x/1.jpg');
  const plain = scheduledView({ ...base, image: '/posts/x/1.jpg' } as ScheduledPost, channels, {}, Date.parse('2026-12-01T00:00:00Z'), 'https://pub.example');
  assert.equal(plain['imageUrls'], undefined);
});
```

(Use the imports already at the top of `post-view.test.ts`; add `ScheduledPost` as a type import from `./schedule.ts` if it is missing.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import ./dev/resolver.ts --test lib/schedule.test.ts lib/post-view.test.ts`
Expected: the two new tests FAIL (`images` and `imageUrls` are not produced).

- [ ] **Step 3: Write the minimal implementation**

In `publisher/lib/schedule.ts`, add to the `StatusPost` interface after `image: string | null;`:
```ts
  /** For a carousel: every picture's absolute address in order (the first is `image`). Absent for a post with one picture. */
  images?: string[];
```
and in the object built for each post, directly after the `image: post.image ? ... : null,` line add:
```ts
      ...(post.images ? { images: post.images.map((path) => `${origin}${path}`) } : {}),
```
In `publisher/lib/post-view.ts` `scheduledView`, directly after the `...(post.image && origin ? { imageUrl: ... } : {}),` line add:
```ts
    ...(post.images && origin ? { imageUrls: post.images.map((path) => `${origin}${path}`) } : {}),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import ./dev/resolver.ts --test lib/schedule.test.ts lib/post-view.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add publisher/lib/schedule.ts publisher/lib/post-view.ts publisher/lib/schedule.test.ts publisher/lib/post-view.test.ts
git commit -m "The feed and the product view tell a carousel from a plain post"
```

---

### Task 6: Whole suite, pull request

- [ ] **Step 1: Run everything**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; every test passes.

- [ ] **Step 2: Remove the temporary link and check the tree**

Run: `rm -f node_modules && git status --short`
Expected: only the plan files and the files above are listed, no `node_modules`.

- [ ] **Step 3: Push and open the pull request**

```bash
git push -u origin carousel-posting
gh pr create --repo digibranders/social-auto --base main --head carousel-posting --title "Carousel posting path: a scheduled post can carry several pictures" --body "Plan 1 of 5 for the weekly carousel (docs/superpowers/plans/2026-11-11-carousel-overview.md). A scheduled post may carry two to ten pictures (images); Instagram (team and customer accounts), Facebook and LinkedIn send it as a carousel, Google keeps the cover. Nothing creates such a post yet, so live posting is unchanged."
```

---

## Self-review

**Spec coverage:** carousel on Instagram team account (Task 4) and customer accounts (Task 3), Facebook (Tasks 2 and 3), LinkedIn (Task 3, uses the PR 78 calls), Google keeps the cover (unchanged, stated in Task 3), parse and validate (Task 1), feed visibility (Task 5), variants do not replace slides (Task 1). Not in this plan on purpose: making carousels (plan 2), approving them (plan 3), scheduling them (plan 4), fake-network end to end and the Facebook live proof (plan 5).

**Placeholder scan:** every step has the code or the exact edit; the two spots that depend on a signature I could not see (the `FacebookApiError` constructor in Task 2, and `buildStatus`'s call shape in Task 5) say exactly where to look and what to match.

**Type consistency:** `images` is `string[]` everywhere; `pictureUrls(post, origin)` is defined in Task 3 and used in Tasks 3 and 4; `CarouselImage` comes from `publisher/lib/linkedin.ts` (PR 78); the API method names `postPhotos`, `uploadImageUrn`, `postMultiImage`, `prepareCarousel` match between the interfaces (Task 3), the real objects (Task 4) and the stubs (Task 3 tests).

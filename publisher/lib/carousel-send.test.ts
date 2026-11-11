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

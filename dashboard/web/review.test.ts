import assert from 'node:assert/strict';
import { test } from 'node:test';
import { brandingView, costText, failureText, imageUrl, parseBranding, parseQueue, REASON_LABELS } from './review.ts';
import { parseRoute, routeHash } from './route.ts';

const good = { versionId: 'acme.0123456789abcdef', brand: 'acme', postId: 'w01-d1', versionNumber: 2, status: 'pending', headline: 'H', caption: 'C', createdAt: '2026-11-05T10:00:00Z', costUsd: 0.016 };

test('the queue keeps well formed entries and drops anything else', () => {
  const parsed = parseQueue({ posts: [good, { ...good, status: 'weird' }, { ...good, versionId: 5 }, null, 'x'], reasons: ['weak_copy', 'made_up'] });
  assert.equal(parsed.posts.length, 1);
  assert.deepEqual(parsed.reasons, ['weak_copy']);
  assert.deepEqual(parseQueue(null), { posts: [], reasons: Object.keys(REASON_LABELS) });
});

test('pictures are asked for by version, as a preview or a download, with the id escaped', () => {
  assert.equal(imageUrl('acme.0123456789abcdef'), '/api/review?view=image&id=acme.0123456789abcdef');
  assert.equal(imageUrl('acme.0123456789abcdef', 'download'), '/api/review?view=download&id=acme.0123456789abcdef');
  assert.equal(imageUrl('a b&c'), '/api/review?view=image&id=a%20b%26c');
});

test('failures use the service\'s own words, or say what failed', () => {
  assert.equal(failureText({ error: 'a newer version of this post exists; approve that one' }, 409), 'a newer version of this post exists; approve that one');
  assert.equal(failureText(null, 502), 'That did not work (502).');
  assert.equal(costText(0.0161), '$0.016');
  assert.equal(costText(0), 'free');
});

test('the review page has its own address', () => {
  assert.deepEqual(parseRoute('#/review'), { page: 'review' });
  assert.equal(routeHash({ page: 'review' }), '#/review');
});

const record = (over: Record<string, unknown> = {}) => ({ intendedMode: 'authentic_logo', appliedMode: 'text_only', status: 'awaiting_compositor', logoKind: 'wordmark', logoFile: 'branding/abc.svg', logoWidth: 400, logoHeight: 100, sourcePage: 'https://acme.test/', sourceUrl: 'https://acme.test/logo.svg', provenance: 'in the site\'s header; says logo', reason: 'A real logo was found and verified, but real logos are not placed on posters yet, so this poster uses the brand name and web address as text.', ...over });

test('a version made before branding was kept, or with a record that makes no sense, shows no branding section', () => {
  assert.equal(parseBranding(undefined), null);
  assert.equal(parseBranding('x'), null);
  assert.equal(parseBranding({ intendedMode: 'authentic_logo' }), null);
  assert.equal(parseBranding(record({ status: 'amazing' })), null);
  assert.equal(parseBranding(record())?.hasLogoFile, true);
  assert.equal(parseBranding(record({ logoFile: undefined }))?.hasLogoFile, false);
  assert.equal(parseBranding(record({ sourcePage: 7 }))?.sourcePage, undefined, 'a field of the wrong kind is ignored, not trusted');
});

test('a real logo is never said to be on a poster unless the record says it was applied', () => {
  const found = brandingView(parseBranding(record()) as never);
  assert.equal(found.headline, 'Real logo found, not applied');
  assert.equal(found.tone, 'note');
  assert.deepEqual(found.rows[0], ['On this poster', 'The brand name and web address, written as text']);
  assert.ok(found.rows.some(([label, value]) => label === 'Found on' && value === 'https://acme.test/'));
  assert.ok(found.rows.some(([label, value]) => label === 'Logo found' && value === 'Full logo, 400 × 100'));
  const placement = { corner: 'top-right', treatment: 'halo', contrast: 12.5 };
  const applied = brandingView(parseBranding(record({ appliedMode: 'authentic_logo', status: 'applied', reason: undefined, placement })) as never);
  assert.equal(applied.headline, 'Real logo applied');
  assert.equal(applied.tone, 'done');
  assert.equal(applied.rows[0]?.[1], 'The website\'s real logo');
  assert.deepEqual(applied.rows.at(-1), ['Placed', 'top right corner, a thin outline around it so it stays readable']);
  const bare = brandingView(parseBranding(record({ appliedMode: 'authentic_logo', status: 'applied', reason: undefined })) as never);
  assert.equal(bare.headline, 'Real logo found, not applied', 'a record that says applied but shows no place on the poster is not believed');
  assert.equal(parseBranding(record({ placement: { corner: 'middle', treatment: 'halo', contrast: 3 } }))?.placement, undefined, 'a place that makes no sense is ignored');
});

test('with no usable logo the owner is told so, and given the real reason', () => {
  const plain = brandingView(parseBranding({ intendedMode: 'text_only_fallback', appliedMode: 'text_only', status: 'resolved', reason: 'The website has no logo picture, only the name.' }) as never);
  assert.equal(plain.headline, 'Text sign-off used: no usable logo');
  assert.equal(plain.tone, 'plain');
  assert.match(plain.explanation, /The website has no logo picture, only the name\./);
  assert.equal(plain.rows.length, 1, 'there is no logo to describe');
});


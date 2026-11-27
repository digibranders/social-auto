import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { addLinkedInPage } from './channels.js';
import { postToLinkedIn, type LinkedInApi } from './crosspost.js';
import { administeredPages, authorizeUrl, isPageUrn, LINKEDIN_PAGES_SCOPES, pageHealth, pagesEnabled } from './linkedin.js';

const ELEMENTS = { elements: [{ organization: 'urn:li:organization:111', role: 'ADMINISTRATOR', state: 'APPROVED' }, { organization: 'urn:li:organization:222', role: 'ADMINISTRATOR', state: 'APPROVED' }, { organization: 'urn:li:organization:111' }] };

/** A pretend LinkedIn: the page list and the names of two pages (the second one has no readable name). */
function fakeLinkedIn() {
  return mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/rest/organizationAcls')) return Response.json(ELEMENTS);
    if (url.endsWith('/rest/organizations/111')) return Response.json({ localizedName: 'Acme Foods' });
    return new Response('{}', { status: 404 });
  });
}

test('company pages are off unless LINKEDIN_PAGES is on, and ask for the page scopes, not the person\'s', () => {
  assert.equal(pagesEnabled({}), false);
  assert.equal(pagesEnabled({ LINKEDIN_PAGES: 'on' }), true);
  const url = new URL(authorizeUrl({ clientId: 'cid', redirectUri: 'http://x/cb', state: 's', pages: true }));
  assert.equal(url.searchParams.get('scope'), LINKEDIN_PAGES_SCOPES.join(' '));
  assert.equal(url.searchParams.get('scope'), 'r_organization_admin w_organization_social');
  assert.equal(new URL(authorizeUrl({ clientId: 'cid', redirectUri: 'http://x/cb', state: 's' })).searchParams.get('scope'), 'openid profile w_member_social');
});

test('the administered pages are listed once each, with their names, and a page with no readable name is named by its number', async () => {
  const fetchMock = fakeLinkedIn();
  try {
    assert.deepEqual(await administeredPages('tok'), [{ urn: 'urn:li:organization:111', name: 'Acme Foods' }, { urn: 'urn:li:organization:222', name: 'LinkedIn page 222' }]);
  } finally {
    fetchMock.mock.restore();
  }
});

test('a page is healthy only while the token\'s owner still administers it', async () => {
  const fetchMock = fakeLinkedIn();
  try {
    assert.deepEqual(await pageHealth('tok', 'urn:li:organization:111'), { ok: true });
    const gone = await pageHealth('tok', 'urn:li:organization:999');
    assert.equal(gone.ok, false);
    assert.match(gone.error ?? '', /no longer administers/);
  } finally {
    fetchMock.mock.restore();
  }
  const refused = mock.method(globalThis, 'fetch', async () => Response.json({ message: 'no access' }, { status: 403 }));
  try {
    assert.equal((await pageHealth('tok', 'urn:li:organization:111')).ok, false);
  } finally {
    refused.mock.restore();
  }
});

test('only an organization urn is a page', () => {
  assert.equal(isPageUrn('urn:li:organization:123'), true);
  for (const bad of ['urn:li:person:123', 'urn:li:organization:', 'urn:li:organization:12x', 'organization:123']) assert.equal(isPageUrn(bad), false, bad);
});

test('a page is saved as a LinkedIn channel of its own whose author is the page, and connecting again replaces it', () => {
  const key = randomBytes(32);
  const first = addLinkedInPage({ channels: [] }, 'acme', { urn: 'urn:li:organization:111', name: 'Acme Foods' }, 'tok-1', 5_184_000, key, 1_000);
  const channel = first.channels[0];
  assert.equal(channel?.id, 'linkedin:org-111');
  assert.equal(channel?.platform === 'linkedin' && channel.memberUrn, 'urn:li:organization:111');
  assert.notEqual(channel?.platform === 'linkedin' ? channel.token : '', 'tok-1', 'the token is stored encrypted');
  const again = addLinkedInPage(first, 'acme', { urn: 'urn:li:organization:111', name: 'Acme Foods' }, 'tok-2', 5_184_000, key, 2_000);
  assert.equal(again.channels.length, 1);
});

test('a dry run checks a page through the page check, and a member through the member check', async () => {
  const key = randomBytes(32);
  const channels = addLinkedInPage({ channels: [] }, 'acme', { urn: 'urn:li:organization:111', name: 'Acme Foods' }, 'tok', 5_184_000, key, Date.now() - 3_600_000);
  const calls: string[] = [];
  const api = {
    memberHealth: async () => { calls.push('member'); return { ok: true }; },
    pageHealth: async (_t: string, urn: string) => { calls.push(`page:${urn}`); return { ok: false, error: 'not an admin any more' }; },
  } as unknown as LinkedInApi;
  const post = { id: 'acme-p1', brand: 'acme', date: new Date(Date.now() - 60_000).toISOString(), caption: 'c', image: '/posts/a.png', ownTime: true } as never;
  const [result] = await postToLinkedIn({ post, channels, key, origin: 'https://x.example', log: {}, dryRun: true, api, now: Date.now(), record: async () => undefined });
  assert.deepEqual(calls, ['page:urn:li:organization:111']);
  assert.equal(result?.status, 'failed');
  assert.match(result?.error ?? '', /not an admin/);
});

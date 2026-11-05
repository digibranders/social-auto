import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addClient, allBrands, normalizeWebsite, parseClientsFile, setWebsite, slugFor } from './clients.ts';

const NOW = Date.parse('2026-11-02T08:00:00Z');

test('a name becomes a plain slug: accents and punctuation go, words are joined by one dash', () => {
  assert.equal(slugFor('Brand Basket'), 'brand-basket');
  assert.equal(slugFor('  Café & Co.!! '), 'cafe-co');
  assert.equal(slugFor('A'.repeat(60)), 'a'.repeat(41));
  assert.throws(() => slugFor('***'), /letter or number/);
  assert.throws(() => slugFor(42), /name/);
});

test('adding a client keeps the others, and refuses a name that is already a client', () => {
  const first = addClient({ clients: [] }, 'Acme Dental', new Set(['brandbasket']), NOW);
  assert.equal(first.brand, 'acme-dental');
  assert.deepEqual(parseClientsFile(JSON.parse(JSON.stringify(first.file))), first.file);
  assert.throws(() => addClient(first.file, 'acme dental', new Set(), NOW), /already a client/);
  assert.throws(() => addClient({ clients: [] }, 'BrandBasket', new Set(['brandbasket']), NOW), /already a client/);
  const second = addClient(first.file, 'Zed', new Set(), NOW);
  assert.deepEqual(second.file.clients.map((c) => c.brand), ['acme-dental', 'zed']);
});

test('every planned and added client is known; a malformed file is rejected', () => {
  assert.deepEqual([...allBrands(['a'], { clients: [{ brand: 'b', createdAt: 'x' }] })].sort(), ['a', 'b']);
  assert.throws(() => parseClientsFile({}), /clients/);
  assert.throws(() => parseClientsFile({ clients: [{ brand: '../x', createdAt: 'x' }] }), /malformed/);
});

test('a website is kept as its plain address: https, no path, no query, lower case', () => {
  assert.equal(normalizeWebsite('brandbasket.in'), 'https://brandbasket.in');
  assert.equal(normalizeWebsite('  HTTPS://WWW.BrandBasket.in/about?x=1#top '), 'https://www.brandbasket.in');
  assert.equal(normalizeWebsite('http://example.co.uk/'), 'https://example.co.uk');
  assert.equal(normalizeWebsite('münchen.de'), 'https://xn--mnchen-3ya.de');
});

test('a website must be a public web address: no local or private hosts, logins, ports or other schemes', () => {
  const refused = [
    '', '   ', 'localhost', 'http://127.0.0.1', '192.168.1.5', '10.0.0.1', '127.1', '0x7f.0.0.1', '[::1]', 'http://[::1]/x',
    'intranet', 'printer.local', 'db.internal', 'a.localhost', 'user:pass@example.com', 'https://user@example.com',
    'ftp://example.com', 'javascript:alert(1)', 'example.com:8080', 'exa mple.com', 'exa_mple.com', '-bad.example.com',
    `${'a'.repeat(64)}.com`, `${'a.'.repeat(130)}com`, 'example.123', 42, null, undefined,
  ];
  for (const input of refused) assert.throws(() => normalizeWebsite(input), /website|address/i, String(input));
});

test('a client can be added with a website, and its website can be changed and cleared', () => {
  const added = addClient({ clients: [] }, 'Acme Dental', new Set(), NOW, 'acmedental.com/book');
  assert.equal(added.file.clients[0]?.website, 'https://acmedental.com');
  assert.equal(addClient({ clients: [] }, 'Zed', new Set(), NOW).file.clients[0]?.website, undefined);
  assert.equal(addClient({ clients: [] }, 'Zed', new Set(), NOW, '').file.clients[0]?.website, undefined);
  assert.throws(() => addClient({ clients: [] }, 'Zed', new Set(), NOW, 'localhost'), /website|address/i);

  const changed = setWebsite(added.file, 'acme-dental', 'new-site.org');
  assert.equal(changed.clients[0]?.website, 'https://new-site.org');
  assert.equal(setWebsite(changed, 'acme-dental', '').clients[0]?.website, undefined);
  assert.throws(() => setWebsite(added.file, 'nobody', 'x.com'), /only a client added/);
  assert.deepEqual(parseClientsFile(JSON.parse(JSON.stringify(changed))), changed);
  assert.throws(() => parseClientsFile({ clients: [{ brand: 'a', createdAt: 'x', website: 5 }] }), /website/);
});

import { parseClientPlan, setPlan } from './clients.ts';

const NOW_MS = Date.parse('2026-11-05T12:00:00Z');
const planOf = (over: Record<string, unknown> = {}) => ({ platforms: ['instagram', 'facebook'], startDate: '2026-11-06', durationDays: 1, ...over });

test('a client can be added with a posting plan, which is checked and saved with it', () => {
  const made = addClient({ clients: [] }, 'Oye Chats', new Set(), NOW_MS, 'oyechats.com', planOf({ durationDays: 31, postsPerWeek: 3, platforms: ['facebook', 'instagram'] }));
  assert.deepEqual(made.file.clients[0]?.plan, { platforms: ['instagram', 'facebook'], startDate: '2026-11-06', durationDays: 31, time: '10:00', utcOffset: '+05:30', postsPerWeek: 3 });
  assert.equal(made.file.clients[0]?.website, 'https://oyechats.com');
  assert.deepEqual(parseClientsFile(JSON.parse(JSON.stringify(made.file))), made.file, 'it survives a save and a load');
});

test('a posting plan needs the website, and a plan that is not sensible is refused with a plain reason', () => {
  const add = (website: unknown, plan: unknown) => () => addClient({ clients: [] }, 'Oye Chats', new Set(), NOW_MS, website, plan);
  assert.throws(add(undefined, planOf()), /needs the client's website/);
  assert.throws(add('oyechats.com', planOf({ platforms: [] })), /at least one platform/);
  assert.throws(add('oyechats.com', planOf({ platforms: ['tiktok'] })), /not a platform/);
  assert.throws(add('oyechats.com', planOf({ startDate: '2026-11-04' })), /in the past/);
  assert.throws(add('oyechats.com', planOf({ startDate: '2026-02-30' })), /real date/);
  assert.throws(add('oyechats.com', planOf({ durationDays: 40 })), /1 to 31/);
  assert.throws(add('oyechats.com', planOf({ postsPerWeek: 9, durationDays: 7 })), /1 to 7/);
  assert.throws(add('oyechats.com', planOf({ weekdays: ['funday'], durationDays: 7 })), /weekdays/);
  assert.throws(add('oyechats.com', planOf({ time: '99:00' })), /time must look like/);
  assert.equal(addClient({ clients: [] }, 'Oye Chats', new Set(), NOW_MS, 'oyechats.com').file.clients[0]?.plan, undefined, 'a plan is optional');
});

test('exact weekdays are kept in week order and win over posts per week', () => {
  const plan = parseClientPlan(planOf({ durationDays: 14, weekdays: ['Fri', 'mon', 'wednesday'], postsPerWeek: 5 }), NOW_MS);
  assert.deepEqual(plan.weekdays, ['mon', 'wed', 'fri']);
  assert.equal(plan.postsPerWeek, undefined);
});

test('a saved plan may have a start date that has passed, but is not accepted as a new one', () => {
  const old = planOf({ startDate: '2026-10-01' });
  assert.doesNotThrow(() => parseClientPlan(old, NOW_MS, { allowPast: true }));
  assert.throws(() => parseClientPlan(old, NOW_MS), /in the past/);
  assert.throws(() => parseClientsFile({ clients: [{ brand: 'a', createdAt: 'x', website: 'https://a.example', plan: { platforms: [] } }] }), /plan is not valid/);
});

test('a plan can be set or cleared later, for an added client with a website only', () => {
  const made = addClient({ clients: [] }, 'Oye Chats', new Set(), NOW_MS, 'oyechats.com').file;
  const withPlan = setPlan(made, 'oye-chats', planOf(), NOW_MS);
  assert.equal(withPlan.clients[0]?.plan?.platforms.length, 2);
  assert.equal(setPlan(withPlan, 'oye-chats', null, NOW_MS).clients[0]?.plan, undefined);
  assert.throws(() => setPlan(made, 'nobody', planOf(), NOW_MS), /only a client added in the dashboard/);
  const noSite = addClient({ clients: [] }, 'No Site', new Set(), NOW_MS).file;
  assert.throws(() => setPlan(noSite, 'no-site', planOf(), NOW_MS), /add the client's website first/);
});

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

import { MAX_PLANS_PER_CLIENT, addPlan, parseClientPlan, removePlan, setRequireAuthenticLogo, setWeeklyLimit } from './clients.ts';

const NOW_MS = Date.parse('2026-11-05T12:00:00Z');
const planOf = (over: Record<string, unknown> = {}) => ({ platforms: ['instagram', 'facebook'], startDate: '2026-11-06', durationDays: 1, ...over });

test('a client can be added with a posting plan, which is checked and saved with it', () => {
  const made = addClient({ clients: [] }, 'Oye Chats', new Set(), NOW_MS, 'oyechats.com', planOf({ durationDays: 31, postsPerWeek: 3, platforms: ['facebook', 'instagram'] }));
  assert.deepEqual(made.file.clients[0]?.plans, [{ platforms: ['instagram', 'facebook'], startDate: '2026-11-06', durationDays: 31, time: '10:00', utcOffset: '+05:30', postsPerWeek: 3 }]);
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
  assert.equal(addClient({ clients: [] }, 'Oye Chats', new Set(), NOW_MS, 'oyechats.com').file.clients[0]?.plans, undefined, 'a plan is optional');
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
  assert.throws(() => parseClientsFile({ clients: [{ brand: 'a', createdAt: 'x', website: 'https://a.example', plans: [{ platforms: [] }] }] }), /plans\[0\] is not valid/);
});

test('plans can be added and removed later, for an added client with a website only, and each keeps its own platforms', () => {
  const made = addClient({ clients: [] }, 'Oye Chats', new Set(), NOW_MS, 'oyechats.com').file;
  const one = addPlan(made, 'oye-chats', planOf({ platforms: ['instagram'], durationDays: 31, postsPerWeek: 3 }), NOW_MS);
  const two = addPlan(one, 'oye-chats', planOf({ platforms: ['linkedin'], durationDays: 31, postsPerWeek: 1 }), NOW_MS);
  assert.deepEqual(two.clients[0]?.plans?.map((p) => [p.platforms, p.postsPerWeek]), [[['instagram'], 3], [['linkedin'], 1]]);
  assert.throws(() => addPlan(two, 'oye-chats', planOf({ platforms: ['linkedin'], durationDays: 31, postsPerWeek: 1 }), NOW_MS), /already there/);
  const left = removePlan(two, 'oye-chats', 0);
  assert.deepEqual(left.clients[0]?.plans?.map((p) => p.platforms), [['linkedin']]);
  assert.equal(removePlan(left, 'oye-chats', 0).clients[0]?.plans, undefined, 'the last plan removed leaves no plans');
  assert.throws(() => removePlan(left, 'oye-chats', 5), /not found/);
  assert.throws(() => removePlan(left, 'oye-chats', 'first'), /not found/);
  assert.throws(() => addPlan(made, 'nobody', planOf(), NOW_MS), /only a client added in the dashboard/);
  const noSite = addClient({ clients: [] }, 'No Site', new Set(), NOW_MS).file;
  assert.throws(() => addPlan(noSite, 'no-site', planOf(), NOW_MS), /add the client's website first/);
});

test('a client saved with the first version\'s single plan reads as a list of one, and the number of plans is limited', () => {
  const legacy = parseClientsFile({ clients: [{ brand: 'old', createdAt: 'x', website: 'https://old.example', plan: planOf() }] });
  assert.equal(legacy.clients[0]?.plans?.length, 1);
  assert.ok(!('plan' in (legacy.clients[0] as object)));
  // A higher limit for this client, so that the number of plans is what is tested here.
  let file = setWeeklyLimit(addClient({ clients: [] }, 'Busy', new Set(), NOW_MS, 'busy.com').file, 'busy', 7);
  for (let n = 0; n < MAX_PLANS_PER_CLIENT; n += 1) file = addPlan(file, 'busy', planOf({ startDate: `2026-11-${String(10 + n).padStart(2, '0')}` }), NOW_MS);
  assert.throws(() => addPlan(file, 'busy', planOf({ startDate: '2026-12-01' }), NOW_MS), /at most/);
});

test('a client\'s weekly limit can be changed, only governs plans added afterwards, and the default is not stored', () => {
  const made = addClient({ clients: [] }, 'Oye Chats', new Set(), NOW_MS, 'oyechats.com').file;
  const four = (file: typeof made) => addPlan(file, 'oye-chats', planOf({ platforms: ['instagram'], durationDays: 7, postsPerWeek: 4, startDate: '2026-11-09' }), NOW_MS);
  assert.throws(() => four(made), /can have 3 posts a week/);
  const raised = setWeeklyLimit(made, 'oye-chats', 5);
  assert.equal(raised.clients[0]?.weeklyLimit, 5);
  assert.equal(four(raised).clients[0]?.plans?.length, 1);
  const lowered = setWeeklyLimit(four(raised), 'oye-chats', 1);
  assert.equal(lowered.clients[0]?.plans?.length, 1, 'a plan already there stays when the limit is lowered');
  assert.equal(setWeeklyLimit(raised, 'oye-chats', 3).clients[0]?.weeklyLimit, undefined, 'the default is not stored');
  assert.throws(() => setWeeklyLimit(made, 'oye-chats', 0), /whole number from 1 to 7/);
  assert.throws(() => setWeeklyLimit(made, 'oye-chats', 2.5), /whole number from 1 to 7/);
  assert.throws(() => setWeeklyLimit(made, 'nobody', 2), /only a client added in the dashboard/);
  assert.throws(() => parseClientsFile({ clients: [{ brand: 'a', createdAt: 'x', weeklyLimit: 9 }] }), /weeklyLimit/);
});

test('the real-logo requirement defaults to off, is stored only when on, and can be changed later', () => {
  const plain = addClient({ clients: [] }, 'Oye Chats', new Set(), NOW_MS, 'oyechats.com').file;
  assert.equal('requireAuthenticLogo' in (plain.clients[0] as object), false);
  const strict = addClient({ clients: [] }, 'Strict Co', new Set(), NOW_MS, 'strict.com', undefined, true).file;
  assert.equal(strict.clients[0]?.requireAuthenticLogo, true);
  assert.deepEqual(parseClientsFile(JSON.parse(JSON.stringify(strict))), strict, 'it survives a save and a load');
  const on = setRequireAuthenticLogo(plain, 'oye-chats', true);
  assert.equal(on.clients[0]?.requireAuthenticLogo, true);
  assert.equal('requireAuthenticLogo' in (setRequireAuthenticLogo(on, 'oye-chats', false).clients[0] as object), false, 'off is not stored');
  assert.throws(() => setRequireAuthenticLogo(plain, 'oye-chats', 'yes'), /true or false/);
  assert.throws(() => setRequireAuthenticLogo(plain, 'nobody', true), /only a client added in the dashboard/);
  assert.throws(() => addClient({ clients: [] }, 'Bad', new Set(), NOW_MS, 'bad.com', undefined, 'yes'), /true or false/);
  assert.throws(() => parseClientsFile({ clients: [{ brand: 'a', createdAt: 'x', requireAuthenticLogo: 'yes' }] }), /requireAuthenticLogo/);
});

test('a plan keeps the time of day it was given, and a time that has already passed today is refused', () => {
  // NOW_MS is 17:30 in India on 5 November.
  const made = addClient({ clients: [] }, 'Oye Chats', new Set(), NOW_MS, 'oyechats.com', planOf({ time: '15:30', startDate: '2026-11-06' }));
  assert.equal(made.file.clients[0]?.plans?.[0]?.time, '15:30');
  assert.throws(() => addClient({ clients: [] }, 'Late', new Set(), NOW_MS, 'late.com', planOf({ time: '09:00', startDate: '2026-11-05' })), /already passed today/);
  assert.doesNotThrow(() => addClient({ clients: [] }, 'Later', new Set(), NOW_MS, 'later.com', planOf({ time: '18:00', startDate: '2026-11-05' })));
  assert.doesNotThrow(() => parseClientPlan(planOf({ time: '09:00', startDate: '2026-11-05' }), NOW_MS, { allowPast: true }), 'a saved plan is read back whatever the hour');
});


import { bindPlanChannels } from './clients.ts';

const chan = (id: string, brand = 'oye-chats') => ({ id, platform: id.slice(0, id.indexOf(':')) as 'facebook' | 'linkedin' | 'google' | 'instagram', brand });

test('a plan can name the exact account for each platform, one per platform, and only an account of its own platforms', () => {
  const ok = parseClientPlan(planOf({ platforms: ['linkedin', 'facebook'], channelIds: ['facebook:77', 'linkedin:abc'] }), NOW_MS);
  assert.deepEqual(ok.channelIds, ['facebook:77', 'linkedin:abc'], 'kept in the platform order');
  assert.throws(() => parseClientPlan(planOf({ platforms: ['linkedin'], channelIds: ['linkedin:a', 'linkedin:b'] }), NOW_MS), /one account for linkedin/);
  assert.throws(() => parseClientPlan(planOf({ platforms: ['linkedin'], channelIds: ['facebook:77'] }), NOW_MS), /not one of this plan's platforms/);
  assert.throws(() => parseClientPlan(planOf({ channelIds: ['tiktok:1'] }), NOW_MS), /not a valid account id/);
  assert.throws(() => parseClientPlan(planOf({ channelIds: [] }), NOW_MS), /short list/);
  assert.equal(parseClientPlan(planOf(), NOW_MS).channelIds, undefined, 'a plan with no accounts named is still valid');
});

test('binding a plan uses the only account on a platform, refuses to guess between two, and refuses an account that is not the client\'s', () => {
  const plan = parseClientPlan(planOf({ platforms: ['instagram', 'facebook', 'linkedin'] }), NOW_MS);
  const one = bindPlanChannels(plan, [chan('facebook:77'), chan('linkedin:abc'), chan('linkedin:zzz', 'someone-else')], 'oye-chats');
  assert.deepEqual(one.channelIds, ['facebook:77', 'linkedin:abc'], 'the only account of each platform is chosen, and nothing is chosen for a platform with none connected (instagram)');
  assert.throws(() => bindPlanChannels(plan, [chan('facebook:77'), chan('facebook:78')], 'oye-chats'), /2 facebook accounts connected: choose which one/);
  const named = parseClientPlan(planOf({ platforms: ['facebook'], channelIds: ['facebook:78'] }), NOW_MS);
  assert.deepEqual(bindPlanChannels(named, [chan('facebook:77'), chan('facebook:78')], 'oye-chats').channelIds, ['facebook:78'], 'a named account settles the choice');
  assert.throws(() => bindPlanChannels(named, [chan('facebook:78', 'someone-else')], 'oye-chats'), /not connected to this client/);
  assert.equal(bindPlanChannels(planOf() as never, [], 'oye-chats').channelIds, undefined, 'with nothing connected the plan stays unbound');
});

test('adding a plan binds it when the connected accounts are known, and a plan with two accounts on a platform must say which', () => {
  const made = addClient({ clients: [] }, 'Oye Chats', new Set(), NOW_MS, 'oyechats.com').file;
  const bound = addPlan(made, 'oye-chats', planOf({ platforms: ['linkedin'], durationDays: 7, postsPerWeek: 2, startDate: '2026-11-09' }), NOW_MS, [chan('linkedin:abc')]);
  assert.deepEqual(bound.clients[0]?.plans?.[0]?.channelIds, ['linkedin:abc']);
  assert.throws(() => addPlan(made, 'oye-chats', planOf({ platforms: ['linkedin'], startDate: '2026-11-09' }), NOW_MS, [chan('linkedin:abc'), chan('linkedin:def')]), /choose which one/);
  const chosen = addPlan(made, 'oye-chats', planOf({ platforms: ['linkedin'], startDate: '2026-11-09', channelIds: ['linkedin:def'] }), NOW_MS, [chan('linkedin:abc'), chan('linkedin:def')]);
  assert.deepEqual(chosen.clients[0]?.plans?.[0]?.channelIds, ['linkedin:def']);
  assert.equal(parseClientsFile(JSON.parse(JSON.stringify(chosen))).clients[0]?.plans?.[0]?.channelIds?.[0], 'linkedin:def', 'it survives a save and a load');
});

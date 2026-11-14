import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StatusPost, StatusResponse } from '../shared/status.ts';
import { describeDays, schedulePattern, spentThisMonth, summarizeClients, websiteHost } from './clients.ts';

const NOW = Date.parse('2026-11-02T00:00:00Z');
const post = (brand: string, date: string, state: StatusPost['state'] = 'scheduled'): StatusPost => ({
  id: `${brand}-${date}`, brand, platform: 'instagram', date, caption: 'c', image: null, state, permalink: null,
  publishedAt: null, mediaUrl: null, edited: false, editable: true, manual: false, channels: null, crossposts: [],
});
const weekdays = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'].map((d) => `${d}T10:00:00+05:30`);

test('describeDays names the common patterns', () => {
  assert.equal(describeDays(new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri'])), 'Mon–Fri');
  assert.equal(describeDays(new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])), 'every day');
  assert.equal(describeDays(new Set(['Fri', 'Mon', 'Wed'])), 'Mon, Wed, Fri');
});

test('schedulePattern reads the next two weeks and ignores the past and the far future', () => {
  const posts = [...weekdays.map((d) => post('a', d)), post('a', '2026-10-01T10:00:00+05:30'), post('a', '2027-03-01T18:00:00+05:30')];
  assert.equal(schedulePattern(posts, NOW - 2 * 3_600_000), 'Mon–Fri · 10:00 AM');
  assert.equal(schedulePattern([], NOW), null);
  assert.equal(schedulePattern([post('a', '2026-12-31T10:00:00+05:30')], NOW), null);
});

test('summarizeClients groups by client with channels, runway, problems and what is next', () => {
  const data: StatusResponse = {
    generatedAt: '2026-11-02T00:00:00Z',
    pauses: { all: false, brands: ['b'], channels: [] },
    channels: [
      { id: null, platform: 'instagram', account: 'ig', avatar: null, brands: ['a'], paused: false, ok: true },
      { id: 'facebook:12345', platform: 'facebook', account: 'Page', avatar: null, brands: ['a', 'b'], paused: false, ok: false, error: 'x' },
    ],
    posts: [...weekdays.map((d) => post('a', d)), post('a', '2026-10-30T10:00:00+05:30', 'missed'), post('b', weekdays[0] as string)],
    runway: [{ brand: 'a', postsLeft: 40 }, { brand: 'b', postsLeft: 3 }],
    costs: [{ brand: 'a', post: null, purpose: 'profile', at: '2026-11-04T05:00:00.000Z', usd: 0.002 }],
  };
  const [a, b] = summarizeClients(data, NOW - 2 * 3_600_000);
  assert.equal(a?.brand, 'a');
  assert.equal(a?.channels.length, 2);
  assert.equal(a?.problems, 1);
  assert.equal(a?.missed, 1);
  assert.equal(a?.queueLow, false);
  assert.equal(a?.upcoming[0]?.date, weekdays[0]);
  assert.equal(b?.queueLow, true);
  assert.equal(b?.channels.length, 1);
  assert.equal(a?.costs.length, 1);
  assert.equal(b?.costs.length, 0);
  assert.equal(a?.posts.length, 6);
});

test('hand-made extra posts do not change the described schedule pattern', () => {
  const planned = weekdays.map((d) => post('acme', d));
  const extra = { ...post('acme', '2026-11-07T18:00:00+05:30'), id: 'manual-0123456789ab', manual: true };
  const data: StatusResponse = { generatedAt: '', pauses: { all: false, brands: [], channels: [] }, channels: [], costs: [], runway: [{ brand: 'acme', postsLeft: 5 }], posts: [...planned, extra] };
  const [client] = summarizeClients(data, NOW);
  assert.equal(client?.pattern, schedulePattern(planned, NOW));
  assert.equal(client?.upcoming.length, 6);
});

test('a client added in the dashboard shows with no posts, is removable, and is not flagged as running low', () => {
  const data: StatusResponse = { generatedAt: '', pauses: { all: false, brands: [], channels: [] }, channels: [], costs: [], posts: [], runway: [{ brand: 'new-client', postsLeft: 0, added: true }, { brand: 'acme', postsLeft: 2 }] };
  const clients = summarizeClients(data, NOW);
  const added = clients.find((c) => c.brand === 'new-client');
  assert.equal(added?.label, 'New Client');
  assert.equal(added?.added, true);
  assert.equal(added?.queueLow, false);
  assert.equal(clients.find((c) => c.brand === 'acme')?.added, false);
  assert.equal(clients.find((c) => c.brand === 'acme')?.queueLow, true);
});

test('an added client shows its website, and a client without one has none', () => {
  const data: StatusResponse = {
    generatedAt: '2026-11-02T00:00:00Z',
    pauses: { all: false, brands: ['b'], channels: [] },
    channels: [],
    posts: [],
    costs: [],
    runway: [{ brand: 'acme', postsLeft: 0, added: true, website: 'https://www.acme.com' }, { brand: 'plain', postsLeft: 0, added: true }],
  };
  const [acme, plain] = summarizeClients(data, NOW);
  assert.equal(acme?.website, 'https://www.acme.com');
  assert.equal(plain?.website, null);
});

test('a client is manual unless the feed says it is automatic', () => {
  const data: StatusResponse = {
    generatedAt: '2026-11-02T00:00:00Z',
    pauses: { all: false, brands: [], channels: [] },
    channels: [],
    posts: [],
    costs: [],
    runway: [{ brand: 'auto', postsLeft: 0, approvalMode: 'auto' }, { brand: 'man', postsLeft: 0, approvalMode: 'manual' }, { brand: 'old', postsLeft: 0 }],
  };
  assert.deepEqual(summarizeClients(data, NOW).map((c) => [c.brand, c.approvalMode]), [['auto', 'auto'], ['man', 'manual'], ['old', 'manual']]);
});

test('a client has its own monthly AI limit only when the feed says so, and the month so far is added up from its costs', () => {
  const data: StatusResponse = {
    generatedAt: '2026-11-02T00:00:00Z',
    pauses: { all: false, brands: [], channels: [] },
    channels: [],
    posts: [],
    costs: [],
    runway: [{ brand: 'capped', postsLeft: 0, spendCapUsd: 3.5 }, { brand: 'plain', postsLeft: 0 }],
  };
  assert.deepEqual(summarizeClients(data, NOW).map((c) => [c.brand, c.spendCapUsd]), [['capped', 3.5], ['plain', null]]);
  assert.deepEqual(summarizeClients({ ...data, runway: [{ brand: 'days', postsLeft: 0, postingDays: { instagram: ['mon', 'tue', 'sat'] } }, { brand: 'none', postsLeft: 0 }] }, NOW).map((c) => [c.brand, c.postingDays]), [['days', { instagram: ['mon', 'tue', 'sat'] }], ['none', {}]], 'days come from the feed, and a client with none has none');
  const costs = [
    { brand: 'a', post: 'p1', purpose: 'picture' as const, at: '2026-11-03T10:00:00.000Z', usd: 0.03 },
    { brand: 'a', post: 'p1', purpose: 'writing' as const, at: '2026-11-30T23:59:59.000Z', usd: 0.01 },
    { brand: 'a', post: 'p0', purpose: 'picture' as const, at: '2026-10-31T23:59:59.000Z', usd: 0.5 },
    { brand: 'a', post: null, purpose: 'profile' as const, at: '2026-12-01T00:00:00.000Z', usd: 0.2 },
  ];
  assert.equal(spentThisMonth(costs, Date.parse('2026-11-15T00:00:00Z')), 0.04, 'only this UTC month counts');
  assert.equal(spentThisMonth([], Date.parse('2026-11-15T00:00:00Z')), 0);
});

test('websiteHost shows the address without the scheme', () => {
  assert.equal(websiteHost('https://www.acme.com'), 'www.acme.com');
  assert.equal(websiteHost(null), '');
});

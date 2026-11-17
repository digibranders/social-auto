import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { billingView, planNotices } from './billing.ts';
import { addLinkedInMember, postedKey } from './channels.ts';
import { crosspostStatusFor } from './crosspost.ts';
import { parseKey } from './crypto.ts';
import { billingEnded, billingState, brandIsPaused, isPaused, lastPostingDay, NO_PAUSES, parsePauses, setBilling, setPause } from './pauses.ts';
import { scheduledView } from './post-view.ts';
import { sendPost } from './send-post.ts';
import type { ScheduledPost } from './schedule.ts';
import { loadPosted, saveChannels, savePauses } from './store.ts';

const IST = (day: string, time = '00:00:00'): number => Date.parse(`${day}T${time}+05:30`);
const ENDS = setBilling(NO_PAUSES, 'acme', '2026-12-10', 'tester', '2026-12-02T09:00:00.000Z');

test('the last posting day is the day before the billing date, and the end is midnight India time', () => {
  assert.equal(lastPostingDay('2026-12-10'), '2026-12-09');
  assert.equal(lastPostingDay('2026-03-01'), '2026-02-28');
  // One second before the billing date started in India: still posting. At midnight: held.
  assert.equal(billingEnded(ENDS, 'acme', { nowMs: IST('2026-12-09', '23:59:59') }), false);
  assert.equal(billingEnded(ENDS, 'acme', { nowMs: IST('2026-12-10') }), true);
});

test('a post dated on the last day goes out, one dated on the billing date is held, and a late send of the last day is held too', () => {
  const during = IST('2026-12-09', '10:01:00');
  assert.equal(billingEnded(ENDS, 'acme', { nowMs: during, postMs: IST('2026-12-09', '10:00:00') }), false);
  assert.equal(billingEnded(ENDS, 'acme', { nowMs: during, postMs: IST('2026-12-10', '10:00:00') }), true);
  // A post of the 9th that is retried on the 10th is past the paid period: held.
  assert.equal(billingEnded(ENDS, 'acme', { nowMs: IST('2026-12-10', '03:00:00'), postMs: IST('2026-12-09', '10:00:00') }), true);
  // Another brand is untouched.
  assert.equal(billingEnded(ENDS, 'other', { nowMs: IST('2027-01-01'), postMs: IST('2027-01-01') }), false);
});

test('the paid period ending holds a brand in the same checks as a pause, for every channel', () => {
  const after = { nowMs: IST('2026-12-11', '10:00:00'), postMs: IST('2026-12-11', '10:00:00') };
  assert.equal(brandIsPaused(ENDS, 'acme', after), true);
  assert.equal(isPaused(ENDS, 'acme', 'facebook:1', after), true);
  assert.equal(isPaused(ENDS, 'acme', 'instagram', after), true);
  assert.equal(isPaused(ENDS, 'other', 'facebook:1', after), false);
});

test('the billing date is set, changed and cleared without touching the team\'s pauses, and survives being saved and read', () => {
  const paused = setPause(ENDS, 'brand', 'acme', true);
  const cleared = setBilling(paused, 'acme', null, 'tester', '2026-12-03T00:00:00.000Z');
  assert.equal(cleared.billing?.['acme'], undefined);
  assert.deepEqual(cleared.brands, ['acme']);
  const moved = setBilling(ENDS, 'acme', '2027-01-10', 'tester', '2026-12-20T00:00:00.000Z');
  assert.equal(moved.billing?.['acme']?.endDate, '2027-01-10');
  assert.deepEqual(parsePauses(JSON.parse(JSON.stringify(moved))), moved);
  // A file written before billing existed reads as before.
  assert.deepEqual(parsePauses({ all: false, brands: [], channels: [] }), NO_PAUSES);
});

test('a billing date that is not a real day, or a brand name that is not one, is refused', () => {
  assert.throws(() => setBilling(NO_PAUSES, 'acme', '2026-02-30', 't', 'x'), /real day/);
  assert.throws(() => setBilling(NO_PAUSES, 'acme', '10 Dec', 't', 'x'), /real day/);
  assert.throws(() => setBilling(NO_PAUSES, 'Not A Brand', '2026-12-10', 't', 'x'), /client name/);
  assert.throws(() => parsePauses({ all: false, brands: [], channels: [], billing: { acme: { endDate: 'soon', setAt: 'x', by: 'y' } } }), /bad entry/);
});

test('the state is none, ending or ended, and the customer is told in plain words', () => {
  assert.deepEqual(billingView(NO_PAUSES, 'acme', IST('2026-12-01')), { endDate: null, lastPostingDay: null, state: 'none' });
  assert.equal(billingState(ENDS, 'acme', IST('2026-12-05')), 'ending');
  assert.equal(billingState(ENDS, 'acme', IST('2026-12-10')), 'ended');
  assert.deepEqual(planNotices(billingView(NO_PAUSES, 'acme', 0)), []);
  const ending = planNotices(billingView(ENDS, 'acme', IST('2026-12-05')));
  assert.equal(ending[0]?.code, 'PLAN_ENDING');
  assert.match(ending[0]?.message ?? '', /Posting stops on 10 Dec/);
  assert.equal(planNotices(billingView(ENDS, 'acme', IST('2026-12-11')))[0]?.code, 'PLAN_ENDED');
});

const KEY = '22'.repeat(32);
const channels = addLinkedInMember({ channels: [] }, 'acme', { urn: 'urn:li:person:p1', name: 'Pat' }, 'token', 86_400 * 90, parseKey(KEY), Date.parse('2026-11-01T00:00:00Z'));
const post = (date: string): ScheduledPost => ({ brand: 'acme', id: `acme-${date}`, date: `${date}T10:00:00+05:30`, caption: 'Hello', image: '/posts/x.jpg', fromPlan: true });

test('a post is scheduled before the end, and paused with the reason PLAN_ENDED from the billing date on', () => {
  const before = scheduledView(post('2026-12-09'), channels, {}, IST('2026-12-05'), undefined, ENDS);
  assert.equal(before['state'], 'scheduled');
  assert.equal(before['reason'], undefined);
  const held = scheduledView(post('2026-12-12'), channels, {}, IST('2026-12-05'), undefined, ENDS);
  assert.equal(held['state'], 'paused');
  assert.equal(held['reason'], 'PLAN_ENDED');
  assert.equal((held['targets'] as Array<{ code?: string }>)[0]?.code, 'PLAN_ENDED');
  // Cleared (she kept the plan): the same post is scheduled again.
  const cleared = setBilling(ENDS, 'acme', null, 't', 'x');
  assert.equal(scheduledView(post('2026-12-12'), channels, {}, IST('2026-12-05'), undefined, cleared)['state'], 'scheduled');
  // A post that already went out stays published.
  const log = { [postedKey('acme-2026-12-12', channels.channels[0]?.id ?? '')]: { remoteId: 'r', permalink: 'p', postedAt: '2026-12-12T04:30:00Z' } };
  assert.equal(scheduledView(post('2026-12-12'), channels, log, IST('2026-12-13'), undefined, ENDS)['state'], 'published');
});

test('the status of a channel is paused (not missed) for a day after the end, even if the send window has passed', () => {
  const status = crosspostStatusFor(post('2026-12-12'), channels, {}, IST('2026-12-12', '10:05:00'), ENDS);
  assert.equal(status[0]?.state, 'paused');
});

async function withLocalStore(run: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'billing-test-'));
  const names = ['LOCAL_STORE_DIR', 'BLOB_READ_WRITE_TOKEN', 'CHANNEL_KEY', 'ALERT_NTFY_TOPIC'] as const;
  const before = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env['LOCAL_STORE_DIR'] = dir;
  process.env['CHANNEL_KEY'] = KEY;
  delete process.env['BLOB_READ_WRITE_TOKEN'];
  delete process.env['ALERT_NTFY_TOPIC'];
  try {
    await run();
  } finally {
    for (const name of names) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
    await rm(dir, { recursive: true, force: true });
  }
}

test('sending is refused at send time after the end, whatever was approved: nothing leaves, and the post is recorded as skipped', async () => {
  await withLocalStore(async () => {
    await saveChannels(channels, null);
    const fetchMock = mock.method(globalThis, 'fetch', async () => {
      throw new Error('a held post must never reach the network');
    });
    try {
      // The billing date was in the past when this runs, so the send time itself is past the paid period, even for a post dated the day before.
      const ended = setBilling(NO_PAUSES, 'acme', '2026-11-12', 'tester', '2026-11-01T00:00:00.000Z');
      const outcome = await sendPost(post('2026-11-11'), 'https://example.test', false, ended);
      assert.equal(fetchMock.mock.callCount(), 0);
      assert.equal(outcome.failed, false);
      const id = channels.channels[0]?.id ?? '';
      assert.equal((await loadPosted()).log[postedKey('acme-2026-11-11', id)]?.skipped, true);
    } finally {
      fetchMock.mock.restore();
    }
  });
});

test('a send that is not handed the pauses reads them from the store, so no way of sending can skip the end of a paid period', async () => {
  await withLocalStore(async () => {
    await saveChannels(channels, null);
    await savePauses(setBilling(NO_PAUSES, 'acme', '2026-11-12', 'tester', '2026-11-01T00:00:00.000Z'), null);
    const fetchMock = mock.method(globalThis, 'fetch', async () => {
      throw new Error('a held post must never reach the network');
    });
    try {
      await sendPost(post('2026-11-11'), 'https://example.test', false);
      assert.equal(fetchMock.mock.callCount(), 0);
      const id = channels.channels[0]?.id ?? '';
      assert.equal((await loadPosted()).log[postedKey('acme-2026-11-11', id)]?.skipped, true);
    } finally {
      fetchMock.mock.restore();
    }
  });
});

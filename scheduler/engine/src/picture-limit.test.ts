import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelPicturesUsed, ledgerPathFor, pictureLimitMessage, pictureWeek, plainDate, weeklyLimitFromEnv } from './picture-limit.ts';
import type { PaidCall } from './paid-ledger.ts';

const call = (over: Partial<PaidCall>): PaidCall => ({ callId: 'c', jobId: 'j', tenantId: 'owner', brandId: 'bb-acme', operation: 'image', model: 'm', requestHash: 'h', status: 'completed', reservedCostUsd: 0.02, createdAt: '2026-11-12T08:00:00Z', network: 'instagram', ...over });

test('the week runs Monday to Sunday in India time and restarts on the next Monday', () => {
  // Thursday 12 November 2026, midday in India.
  const week = pictureWeek(new Date('2026-11-12T06:30:00Z'));
  assert.deepEqual([week.from, week.to, week.restart], ['2026-11-09', '2026-11-15', '2026-11-16']);
  assert.equal(new Date(week.startMs).toISOString(), '2026-11-08T18:30:00.000Z', 'Monday 00:00 India time is Sunday 18:30 UTC');
  // Sunday 23:59 India is still that week; one minute later it is the next.
  assert.equal(pictureWeek(new Date('2026-11-15T18:29:00Z')).from, '2026-11-09');
  assert.equal(pictureWeek(new Date('2026-11-15T18:30:00Z')).from, '2026-11-16');
  // Monday 00:10 India time (Sunday 18:40 UTC) belongs to the new week even though UTC still says Sunday.
  assert.equal(pictureWeek(new Date('2026-11-15T18:40:00Z')).restart, '2026-11-23');
});

test('pictures are counted per channel for the brand in the week, never failed tries, other brands, other weeks or pictures with no channel', () => {
  const week = pictureWeek(new Date('2026-11-12T06:30:00Z'));
  const used = channelPicturesUsed([
    call({}), call({}), call({ network: 'facebook' }),
    call({ status: 'failed' }),
    call({ brandId: 'bb-other' }),
    call({ createdAt: '2026-11-08T18:29:59Z' }),
    call({ createdAt: '2026-11-15T18:30:00Z' }),
    call({ operation: 'text' }),
    (() => { const { network: _gone, ...plain } = call({}); return plain as PaidCall; })(),
  ], 'bb-acme', week);
  assert.deepEqual(used, { instagram: 2, facebook: 1, linkedin: 0, google: 0 });
});

test('the customer is told in plain words which channel is out and when it starts again', () => {
  assert.equal(plainDate('2026-11-16'), 'Monday 16 November');
  assert.equal(pictureLimitMessage('instagram', 5, 5, 1, '2026-11-16'), 'You have used your 5 Instagram pictures for this week. You can draw more from Monday 16 November.');
  assert.equal(pictureLimitMessage('linkedin', 5, 3, 4, '2026-11-16'), 'You have 2 of your 5 LinkedIn pictures left this week, and this needs 4. You can draw more from Monday 16 November.');
});

test('the weekly limit is 7 a channel unless a setting lowers or raises it, within a ceiling, and a bad value is an error', () => {
  assert.equal(weeklyLimitFromEnv({}), 7);
  assert.equal(weeklyLimitFromEnv({ PRODUCT_PICTURES_PER_CHANNEL_WEEK: '3' }), 3);
  for (const bad of ['0', '21', '2.5', 'many']) assert.throws(() => weeklyLimitFromEnv({ PRODUCT_PICTURES_PER_CHANNEL_WEEK: bad }), /whole number from 1 to 20/);
});

test('the ledger is read where PAID_LEDGER_FILE says, else beside the brands folder as the engine does', () => {
  assert.equal(ledgerPathFor('/srv/engine/brands', {}), '/srv/engine/ledger/paid-calls.jsonl');
  assert.equal(ledgerPathFor('/srv/engine/brands', { PAID_LEDGER_FILE: '/var/lib/x/calls.jsonl' }), '/var/lib/x/calls.jsonl');
  assert.equal(ledgerPathFor('/srv/engine/brands', { PAID_LEDGER_FILE: '' }), '/srv/engine/ledger/paid-calls.jsonl', 'an empty setting is not a path');
});

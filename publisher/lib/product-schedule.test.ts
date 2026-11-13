import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GET as jobsGet, POST as jobsPost } from '../api/_v1/site-jobs.ts';
import { GET as scheduleGet, PUT as schedulePut } from '../api/_v1/schedule.ts';
import { POST as workspacesPost } from '../api/_v1/workspaces.ts';
import { ERROR_CODES, type ErrorCode } from './api-error.ts';
import { call, fakeEngine, KEY, OTHER_KEY, withProducts, type Answer } from '../dev/product-test-kit.ts';
import { nextMonday } from './plan-days.ts';

function expectError(answer: Answer, status: number, code: ErrorCode, label: string): void {
  assert.equal(answer.status, status, `${label}: status (${JSON.stringify(answer.body)})`);
  assert.equal(answer.body['code'], code, `${label}: code (${JSON.stringify(answer.body)})`);
  assert.ok(ERROR_CODES.includes(code));
  assert.deepEqual(Object.keys(answer.body).sort(), ['code', 'error']);
}

const make = (externalId: string, key = KEY): Promise<Answer> => call(workspacesPost, '/api/v1/workspaces', { key, json: { externalId, name: externalId } });
const put = (json: unknown, key?: string): Promise<Answer> => call(schedulePut, '/api/v1/schedule', { method: 'PUT', ...(key ? { key } : {}), json });
const read = (externalId: string): Promise<Answer> => call(scheduleGet, `/api/v1/schedule?externalId=${externalId}`);
const start = (externalId: string, json: Record<string, unknown> = {}): Promise<Answer> => call(jobsPost, '/api/v1/site-jobs', { json: { externalId, site: 'https://www.acme.example.com', ...json } });
const channelsOf = (answer: Answer): Record<string, { days: string[]; nextWeek: string[] }> => (answer.body['schedule'] as { channels: Record<string, { days: string[]; nextWeek: string[] }> }).channels;
const dayName = (date: string): string => ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(`${date}T00:00:00Z`).getUTCDay()] as string;

test('days saved for each channel are read back in week order, with the dates of the next week; a channel not listed has none; {} clears it', async () => {
  await withProducts(async () => {
    await make('shop-1');
    assert.deepEqual(channelsOf(await read('shop-1')), {}, 'nothing saved yet');
    const saved = await put({ externalId: 'shop-1', channels: { instagram: ['sat', 'Monday', 'tue', 'mon'], facebook: ['wed', 'fri'] } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const channels = channelsOf(saved);
    assert.deepEqual(channels['instagram']?.days, ['mon', 'tue', 'sat']);
    assert.deepEqual(channels['facebook']?.days, ['wed', 'fri']);
    const monday = nextMonday(Date.now());
    assert.deepEqual(channels['instagram']?.nextWeek.map(dayName), ['mon', 'tue', 'sat']);
    assert.equal(channels['instagram']?.nextWeek[0], monday, 'the week that starts on the next Monday');
    assert.deepEqual(channelsOf(await read('shop-1')), channels, 'read back the same');

    const replaced = await put({ externalId: 'shop-1', channels: { facebook: ['sun'] } });
    assert.deepEqual(Object.keys(channelsOf(replaced)), ['facebook'], 'the whole setting is replaced: instagram is gone');
    assert.deepEqual(channelsOf(await put({ externalId: 'shop-1', channels: {} })), {}, 'cleared');
  });
});

test('another customer or product never sees or changes the days, and bad requests answer plainly', async () => {
  await withProducts(async () => {
    await make('shop-1');
    await make('shop-2');
    await put({ externalId: 'shop-1', channels: { instagram: ['mon'] } });
    assert.deepEqual(channelsOf(await read('shop-2')), {}, 'another customer');
    expectError(await put({ externalId: 'shop-1', channels: { instagram: ['tue'] } }, OTHER_KEY), 404, 'WORKSPACE_NOT_FOUND', 'another product');
    assert.deepEqual(channelsOf(await read('shop-1'))['instagram']?.days, ['mon'], 'unchanged');

    expectError(await put({ externalId: 'shop-1', channels: { instagram: [] } }), 400, 'INVALID_DAYS', 'empty list');
    expectError(await put({ externalId: 'shop-1', channels: { instagram: ['funday'] } }), 400, 'INVALID_DAYS', 'not a day');
    expectError(await put({ externalId: 'shop-1', channels: { instagram: 'mon' } }), 400, 'INVALID_DAYS', 'not a list');
    expectError(await put({ externalId: 'shop-1', channels: { tiktok: ['mon'] } }), 400, 'INVALID_NETWORKS', 'not a channel');
    expectError(await put({ externalId: 'shop-1', channels: ['mon'] }), 400, 'INVALID_REQUEST', 'channels not an object');
    expectError(await put({ externalId: 'shop-1' }), 400, 'INVALID_REQUEST', 'no channels');
    expectError(await put({ channels: {} }), 400, 'INVALID_EXTERNAL_ID', 'no externalId');
    expectError(await put({ externalId: 'nobody', channels: {} }), 404, 'WORKSPACE_NOT_FOUND', 'unknown workspace');
    expectError(await call(schedulePut, '/api/v1/schedule', { method: 'PUT', key: null, json: { externalId: 'shop-1', channels: {} } }), 401, 'UNAUTHORIZED', 'no key');
    expectError(await call(schedulePut, '/api/v1/schedule', { method: 'PUT', headers: { 'content-length': '5000' }, json: { externalId: 'shop-1', channels: {} } }), 413, 'REQUEST_TOO_LARGE', 'too large');
    assert.deepEqual(channelsOf(await read('shop-1'))['instagram']?.days, ['mon'], 'nothing changed by the refused calls');
  });
});

test('a batch is written on the days saved for its channel, a call can name its own days, and channels with different days cannot share a batch', async () => {
  await withProducts(async () => {
    const engine = await fakeEngine();
    try {
      await make('shop-1');
      await put({ externalId: 'shop-1', channels: { instagram: ['sat', 'mon', 'tue'], facebook: ['wed', 'fri'] } });
      const sentBody = (): Record<string, unknown> | undefined => engine.seen.filter((s) => s.method === 'POST' && s.url === '/review/jobs').at(-1)?.body as Record<string, unknown> | undefined;

      assert.equal((await start('shop-1', { networks: ['instagram'] })).status, 202);
      assert.deepEqual(sentBody()?.['weekdays'], ['mon', 'tue', 'sat'], 'the days saved for Instagram');
      engine.jobs.length = 0;

      assert.equal((await start('shop-1', { networks: ['facebook'] })).status, 202);
      assert.deepEqual(sentBody()?.['weekdays'], ['wed', 'fri'], 'and for Facebook, in its own batch');
      engine.jobs.length = 0;

      expectError(await start('shop-1', { networks: ['instagram', 'facebook'] }), 400, 'CHANNEL_DAYS_DIFFER', 'different days in one batch');
      expectError(await start('shop-1', { networks: ['instagram', 'linkedin'] }), 400, 'CHANNEL_DAYS_DIFFER', 'one channel with days and one without');

      assert.equal((await start('shop-1', { networks: ['instagram', 'facebook'], weekdays: ['thu'] })).status, 202);
      assert.deepEqual(sentBody()?.['weekdays'], ['thu'], 'days named in the call win');
      engine.jobs.length = 0;

      expectError(await start('shop-1', { networks: ['instagram'], weekdays: [] }), 400, 'INVALID_DAYS', 'bad days in the call');

      // A channel with no saved days keeps the usual spread: nothing about days is sent.
      assert.equal((await start('shop-1', { networks: ['linkedin'] })).status, 202);
      assert.equal(sentBody()?.['weekdays'], undefined);
      assert.ok(jobsGet);
    } finally {
      await engine.close();
    }
  });
});

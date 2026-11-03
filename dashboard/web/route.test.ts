import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRoute, routeHash } from './route.ts';

test('addresses map to screens, with safe fallbacks', () => {
  assert.deepEqual(parseRoute(''), { page: 'clients' });
  assert.deepEqual(parseRoute('#/calendar'), { page: 'calendar' });
  assert.deepEqual(parseRoute('#/client/brandbasket'), { page: 'client', brand: 'brandbasket', tab: 'channels' });
  assert.deepEqual(parseRoute('#/client/brandbasket/posts'), { page: 'client', brand: 'brandbasket', tab: 'posts' });
  assert.deepEqual(parseRoute('#/client/brandbasket/cost'), { page: 'client', brand: 'brandbasket', tab: 'cost' });
  assert.deepEqual(parseRoute('#/help/linkedin'), { page: 'help', channel: 'linkedin' });
  assert.deepEqual(parseRoute('#/help/nonsense'), { page: 'help', channel: 'facebook' });
  assert.deepEqual(parseRoute('#/client/../etc'), { page: 'clients' });
  assert.deepEqual(parseRoute('#/unknown'), { page: 'clients' });
});

test('every screen turns into an address and back', () => {
  for (const route of [
    { page: 'clients' },
    { page: 'calendar' },
    { page: 'client', brand: 'a-b', tab: 'posts' },
    { page: 'client', brand: 'a-b', tab: 'cost' },
    { page: 'help', channel: 'google' },
  ] as const) assert.deepEqual(parseRoute(routeHash(route)), route);
});

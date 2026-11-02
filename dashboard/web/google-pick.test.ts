import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLocations } from './google-pick.ts';

test('parseLocations accepts the publisher’s list and rejects anything else', () => {
  assert.deepEqual(parseLocations({ locations: [{ id: '100', title: 'Cafe One' }] }), [{ id: '100', title: 'Cafe One' }]);
  assert.deepEqual(parseLocations({ locations: [] }), []);
  assert.equal(parseLocations(null), null);
  assert.equal(parseLocations({}), null);
  assert.equal(parseLocations({ locations: [{ id: 100, title: 'x' }] }), null);
  assert.equal(parseLocations({ locations: [{ id: '1' }] }), null);
});

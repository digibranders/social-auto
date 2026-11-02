import assert from 'node:assert/strict';
import { test } from 'node:test';
import { previewLabel } from './add-client.ts';

test('the label shown matches the one the server will make from the name', () => {
  assert.equal(previewLabel('brand basket'), 'Brand Basket');
  assert.equal(previewLabel('  Café & Co.!! '), 'Cafe Co');
  assert.equal(previewLabel('***'), '');
});

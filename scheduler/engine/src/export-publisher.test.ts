import assert from 'node:assert/strict';
import { test } from 'node:test';
import { posterFileName } from './export-publisher.ts';

test('posterFileName is stable for the same image and different for others', () => {
  const a = Buffer.from('image-a');
  assert.equal(posterFileName(a), posterFileName(Buffer.from('image-a')));
  assert.notEqual(posterFileName(a), posterFileName(Buffer.from('image-b')));
});

test('posterFileName is a 32-character hex name that reveals nothing about the post', () => {
  const name = posterFileName(Buffer.from('w01-d1'));
  assert.match(name, /^[0-9a-f]{32}\.jpg$/);
  assert.ok(!name.includes('w01'));
});

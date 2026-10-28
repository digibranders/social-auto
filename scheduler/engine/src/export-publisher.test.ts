import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseScheduleModule, posterFileName, scheduleModule } from './export-publisher.ts';

test('the schedule module round-trips and rejects hand-written files', () => {
  const posts = [{ brand: 'b', id: 'b-w01-d1', date: '2026-10-29T10:00:00+05:30', caption: 'Hi\n\n#a', image: '/posts/b/x.jpg' }];
  assert.deepEqual(parseScheduleModule(scheduleModule(posts)), posts);
  assert.throws(() => parseScheduleModule('export const schedule = {"posts": []};\n'), /not generated/);
});

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

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { addLinkedInMember } from './channels.ts';
import { parseKey } from './crypto.ts';
import { loadChannels, saveChannels, storeConfigured } from './store.ts';

const KEY = parseKey('11'.repeat(32));

async function withLocalStore(run: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'store-test-'));
  const before = { dir: process.env['LOCAL_STORE_DIR'], blob: process.env['BLOB_READ_WRITE_TOKEN'] };
  process.env['LOCAL_STORE_DIR'] = dir;
  delete process.env['BLOB_READ_WRITE_TOKEN'];
  try {
    await run();
  } finally {
    if (before.dir === undefined) delete process.env['LOCAL_STORE_DIR'];
    else process.env['LOCAL_STORE_DIR'] = before.dir;
    if (before.blob !== undefined) process.env['BLOB_READ_WRITE_TOKEN'] = before.blob;
    await rm(dir, { recursive: true, force: true });
  }
}

test('the local folder store saves channels, reads them back, and refuses a stale write', async () => {
  await withLocalStore(async () => {
    assert.equal(storeConfigured(), true);
    const empty = await loadChannels();
    assert.deepEqual(empty.file, { channels: [] });
    assert.equal(empty.etag, null);

    const file = addLinkedInMember(empty.file, 'brandbasket', { urn: 'urn:li:person:abc', name: 'Asha' }, 'tok', 3600, KEY, 1_000);
    await saveChannels(file, empty.etag);
    const saved = await loadChannels();
    assert.deepEqual(saved.file, file);
    assert.ok(saved.etag);

    // A second writer that read the empty file must not overwrite what was saved since.
    await assert.rejects(saveChannels({ channels: [] }, empty.etag), /same moment/);
    await saveChannels({ channels: [] }, saved.etag);
    assert.deepEqual((await loadChannels()).file, { channels: [] });
  });
});

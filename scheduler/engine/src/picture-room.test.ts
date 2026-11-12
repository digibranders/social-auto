import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pictureRoomFor } from './picture-room.ts';

test('the room a channel has left this week is the limit less the pictures bought for it, never below 0; an unreadable or missing ledger gives none to buy blind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'room-'));
  try {
    const file = join(dir, 'paid-calls.jsonl');
    const now = new Date('2026-11-12T06:30:00Z');
    const input = { ledgerFile: file, brand: 'bb-acme', network: 'instagram', limit: 7, now };
    assert.equal(pictureRoomFor(input), 7, 'a ledger that does not exist yet: nothing bought, all the room');
    const bought = (n: number, network: string, over: Record<string, unknown> = {}) => {
      const call = { callId: `c${n}`, jobId: 'j', tenantId: 'o', brandId: 'bb-acme', postId: `p${n}`, network, operation: 'image', model: 'm', requestHash: `h${n}`, status: 'completed', reservedCostUsd: 0.02, createdAt: '2026-11-11T05:00:00Z', ...over };
      appendFileSync(file, `${JSON.stringify({ type: 'reserve', call })}\n`);
    };
    for (let i = 1; i <= 3; i += 1) bought(i, 'instagram');
    bought(4, 'facebook');
    bought(5, 'instagram', { status: 'failed' });
    assert.equal(pictureRoomFor(input), 4);
    assert.equal(pictureRoomFor({ ...input, network: 'facebook' }), 6);
    for (let i = 6; i <= 12; i += 1) bought(i, 'instagram');
    assert.equal(pictureRoomFor(input), 0, 'never below 0');
    assert.equal(pictureRoomFor({ ...input, network: 'myspace' }), 0);
    appendFileSync(file, 'not json\n');
    assert.equal(pictureRoomFor(input), 0, 'a damaged ledger: nothing is bought blind');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseUsageLog, summarizeUsage } from './usage.ts';

const line = (o: Record<string, unknown>): string =>
  JSON.stringify({ at: '2026-11-04T05:00:00.000Z', client: 'fynix', post: 'fynix-w01-d1', purpose: 'picture', model: 'm', inputTokens: 0, outputTokens: 0, costUsd: 0.01, estimated: false, ...o });

test('the log is read line by line, and a broken or foreign line is skipped instead of hiding the rest', () => {
  const text = [line({}), '{"half', '', line({ purpose: 'unknown' }), line({ costUsd: 'free' }), line({ costUsd: null, post: null, purpose: 'profile' })].join('\n');
  const { records, skipped } = parseUsageLog(text);
  assert.equal(records.length, 2);
  assert.equal(skipped, 3);
  assert.equal(records[1]?.costUsd, null);
});

test('costs are added up per client, post and purpose, keeping the latest time and ignoring unpriced calls', () => {
  const { records } = parseUsageLog(
    [
      line({ costUsd: 0.0138 }),
      line({ costUsd: 0.0138, at: '2026-11-11T05:00:00.000Z' }),
      line({ purpose: 'writing', costUsd: 0.0004 }),
      line({ purpose: 'profile', post: null, costUsd: 0.002 }),
      line({ purpose: 'writing', costUsd: null }),
      line({ client: 'other', costUsd: 1 }),
    ].join('\n'),
  );
  const summary = summarizeUsage(records);
  const fynix = summary.filter((s) => s.brand === 'fynix');
  assert.deepEqual(
    fynix.map((s) => [s.post, s.purpose, s.usd, s.at]),
    [
      ['fynix-w01-d1', 'picture', 0.0276, '2026-11-11T05:00:00.000Z'],
      ['fynix-w01-d1', 'writing', 0.0004, '2026-11-04T05:00:00.000Z'],
      [null, 'profile', 0.002, '2026-11-04T05:00:00.000Z'],
    ],
  );
  assert.equal(summary.find((s) => s.brand === 'other')?.usd, 1);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { POST as clientsPost } from '../api/clients.ts';
import { POST as connectLink } from '../api/_v1/connect-link.ts';
import { POST as workspacesPost } from '../api/_v1/workspaces.ts';
import { call, withProducts } from '../dev/product-test-kit.ts';

const invitePayload = (answer: { body: Record<string, unknown> }): Record<string, unknown> => {
  const url = new URL(String(answer.body['url']));
  const [payload] = (url.searchParams.get('invite') as string).split('.');
  return JSON.parse(Buffer.from(payload as string, 'base64url').toString('utf8')) as Record<string, unknown>;
};

test('a customer link always carries the guard, and names a brand to move from only when asked and only for her own brands', async () => {
  await withProducts(async () => {
    const saved = [process.env['EDIT_SECRET'], process.env['INVITE_SECRET'], process.env['DASHBOARD_ORIGIN']];
    process.env['EDIT_SECRET'] = 'staff-secret-for-tests';
    process.env['INVITE_SECRET'] = 'i'.repeat(40);
    process.env['DASHBOARD_ORIGIN'] = 'https://dash.example.test';
    try {
      await clientsPost(new Request('https://x.test/api/clients?action=set-brands-default', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer staff-secret-for-tests' }, body: JSON.stringify({ value: 2 }) }));
      await call(workspacesPost, '/api/v1/workspaces', { json: { externalId: 'biz-1', name: 'One' } });
      await call(workspacesPost, '/api/v1/workspaces', { json: { externalId: 'biz-1:b2', name: 'Two', group: 'biz-1' } });
      await call(workspacesPost, '/api/v1/workspaces', { json: { externalId: 'biz-2', name: 'Other customer' } });

      const plain = await call(connectLink, '/api/v1/connect-link', { json: { externalId: 'biz-1:b2', channel: 'instagram' } });
      assert.equal(plain.status, 200);
      assert.equal(invitePayload(plain)['g'], 1);
      assert.equal(invitePayload(plain)['m'], undefined);

      const move = await call(connectLink, '/api/v1/connect-link', { json: { externalId: 'biz-1:b2', channel: 'instagram', moveFrom: 'biz-1' } });
      assert.equal(move.status, 200);
      assert.equal(invitePayload(move)['m'], 'biz-1');

      for (const moveFrom of ['biz-2', 'biz-1:b2', 'nobody', 5]) {
        const bad = await call(connectLink, '/api/v1/connect-link', { json: { externalId: 'biz-1:b2', channel: 'instagram', moveFrom } });
        assert.equal(bad.status, 400, String(moveFrom));
        assert.equal(bad.body['code'], 'INVALID_MOVE_FROM');
      }
    } finally {
      ['EDIT_SECRET', 'INVITE_SECRET', 'DASHBOARD_ORIGIN'].forEach((n, i) => (saved[i] === undefined ? delete process.env[n] : (process.env[n] = saved[i])));
    }
  });
});

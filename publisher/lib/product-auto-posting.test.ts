import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GET as workspacesGet, PATCH as workspacesPatch, POST as workspacesPost } from '../api/_v1/workspaces.ts';
import { ERROR_CODES, type ErrorCode } from './api-error.ts';
import { addFacebookPages, addInstagramAccount, addLinkedInMember } from './channels.ts';
import { parseKey } from './crypto.ts';
import { forgetConnected } from './connected-sync.ts';
import { call, CHANNEL_KEY, fakeEngine, OTHER_KEY, withProducts, type Answer, type FakeEngine } from '../dev/product-test-kit.ts';
import { loadChannels, saveChannels } from './store.ts';

function expectError(answer: Answer, status: number, code: ErrorCode, label: string): void {
  assert.equal(answer.status, status, `${label}: status (${JSON.stringify(answer.body)})`);
  assert.equal(answer.body['code'], code, `${label}: code (${JSON.stringify(answer.body)})`);
  assert.ok(ERROR_CODES.includes(code));
  assert.deepEqual(Object.keys(answer.body).sort(), ['code', 'error']);
}

async function withEngine(run: (engine: FakeEngine) => Promise<void>): Promise<void> {
  await withProducts(async () => {
    const engine = await fakeEngine();
    try {
      forgetConnected();
      await run(engine);
    } finally {
      await engine.close();
    }
  });
}

type Network = 'instagram' | 'facebook' | 'linkedin';
async function connect(brand: string, networks: Network[]): Promise<void> {
  const key = parseKey(CHANNEL_KEY);
  const at = Date.now() - 3_600_000;
  const { file, etag } = await loadChannels();
  let next = file;
  if (networks.includes('instagram')) next = addInstagramAccount(next, brand, { userId: '1784140000001', username: 'shop' }, 'token', 5_000_000, key, at);
  if (networks.includes('facebook')) next = addFacebookPages(next, brand, [{ id: '1000000000001', name: 'Shop Page', accessToken: 'token' }], key, at);
  if (networks.includes('linkedin')) next = addLinkedInMember(next, brand, { urn: 'urn:li:person:abcdefabc', name: 'Member' }, 'token', 5_000_000, key, at);
  await saveChannels(next, etag);
}

const make = async (externalId: string, key?: string): Promise<string> => {
  const made = await call(workspacesPost, '/api/v1/workspaces', { ...(key ? { key } : {}), json: { externalId, name: externalId } });
  return String((made.body['workspace'] as { id: string }).id);
};
const patch = (json: unknown, headers: Record<string, string> = { 'x-social-actor': 'u1' }, key?: string): Promise<Answer> => call(workspacesPatch, '/api/v1/workspaces', { method: 'PATCH', headers, ...(key ? { key } : {}), json });
const view = (answer: Answer): Record<string, unknown> => answer.body['workspace'] as Record<string, unknown>;
const read = async (externalId: string): Promise<Record<string, unknown>> => view(await call(workspacesGet, `/api/v1/workspaces?externalId=${externalId}`));
const auto = (v: Record<string, unknown>): { channels: string[]; safetyHours: number; consentedAt: string; needsChoice: string[] } | null => v['autoPosting'] as never;

test('a customer is manual until she chooses; choosing auto covers the channels connected then, and a channel connected later waits for her choice', async () => {
  await withEngine(async (engine) => {
    const brand = await make('shop-1');
    await connect(brand, ['instagram', 'facebook']);
    const before = await read('shop-1');
    assert.deepEqual([before['approvalMode'], before['autoPosting']], ['manual', null]);

    const on = await patch({ externalId: 'shop-1', autoPosting: { channels: ['facebook', 'instagram'], consent: true } });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal(view(on)['approvalMode'], 'auto');
    const chosen = auto(view(on));
    assert.deepEqual([chosen?.channels, chosen?.safetyHours, chosen?.needsChoice], [['instagram', 'facebook'], 24, []]);
    assert.match(String(chosen?.consentedAt), /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual([engine.autoPosting[brand]?.channels, engine.autoPosting[brand]?.consent.by], [['facebook', 'instagram'], 'brandbasket:u1'], 'the poster service was told, with who agreed');
    assert.deepEqual(auto(await read('shop-1')), chosen, 'read back');

    // A week later she connects LinkedIn: it starts as manual and the product is told it needs her choice.
    await connect(brand, ['linkedin']);
    const later = auto(await read('shop-1'));
    assert.deepEqual([later?.channels, later?.needsChoice], [['instagram', 'facebook'], ['linkedin']]);
    assert.deepEqual(engine.autoPosting[brand]?.channels, ['facebook', 'instagram'], 'the poster service still does not approve for LinkedIn');

    const wider = await patch({ externalId: 'shop-1', autoPosting: { channels: ['instagram', 'facebook', 'linkedin'], safetyHours: 12, consent: true } }, { 'x-social-actor': 'u2' });
    assert.deepEqual([auto(view(wider))?.needsChoice, auto(view(wider))?.safetyHours], [[], 12]);
    assert.equal(engine.autoPosting[brand]?.consent.by, 'brandbasket:u2', 'a channel added is a new consent');

    const narrower = await patch({ externalId: 'shop-1', autoPosting: { channels: ['instagram'], consent: true } });
    assert.deepEqual([auto(view(narrower))?.channels, auto(view(narrower))?.needsChoice], [['instagram'], ['facebook', 'linkedin']]);

    const off = await patch({ externalId: 'shop-1', autoPosting: { channels: [] } });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.deepEqual([view(off)['approvalMode'], view(off)['autoPosting']], ['manual', null]);
    assert.deepEqual(engine.autoPosting[brand]?.channels, [], 'the poster service stopped approving');
  });
});

test('switching it on needs her consent, a named person and a connected channel; an engine that is down saves nothing; another product cannot', async () => {
  await withEngine(async (engine) => {
    const brand = await make('shop-1');
    await connect(brand, ['instagram']);
    const asked = (): number => engine.seen.filter((s) => s.url === '/review/auto-posting').length;
    expectError(await patch({ externalId: 'shop-1', autoPosting: { channels: ['instagram'] } }), 400, 'CONSENT_REQUIRED', 'no consent');
    expectError(await patch({ externalId: 'shop-1', autoPosting: { channels: ['instagram'], consent: false } }), 400, 'CONSENT_REQUIRED', 'consent false');
    expectError(await patch({ externalId: 'shop-1', autoPosting: { channels: ['instagram'], consent: true } }, {}), 400, 'ACTOR_REQUIRED', 'no person');
    expectError(await patch({ externalId: 'shop-1', autoPosting: { channels: ['facebook'], consent: true } }), 400, 'CHANNEL_NOT_CONNECTED', 'not connected');
    expectError(await patch({ externalId: 'shop-1', autoPosting: { channels: ['tiktok'], consent: true } }), 400, 'INVALID_NETWORKS', 'not a channel');
    expectError(await patch({ externalId: 'shop-1', autoPosting: { channels: ['instagram'], safetyHours: 100, consent: true } }), 400, 'INVALID_REQUEST', 'window too long');
    expectError(await patch({ externalId: 'shop-1', autoPosting: { channels: 'instagram', consent: true } }), 400, 'INVALID_REQUEST', 'channels not a list');
    expectError(await patch({ externalId: 'shop-1', autoPosting: 'on' }), 400, 'INVALID_REQUEST', 'not an object');
    expectError(await patch({ externalId: 'shop-1' }), 400, 'INVALID_REQUEST', 'neither a name nor automatic posting');
    expectError(await patch({ externalId: 'shop-1', autoPosting: { channels: ['instagram'], consent: true } }, { 'x-social-actor': 'u1' }, OTHER_KEY), 404, 'WORKSPACE_NOT_FOUND', 'another product');
    assert.equal(asked(), 0, 'nothing refused reached the poster service');

    engine.autoPostingDown = true;
    assert.equal((await patch({ externalId: 'shop-1', autoPosting: { channels: ['instagram'], consent: true } })).status, 503);
    engine.autoPostingDown = false;
    assert.deepEqual([(await read('shop-1'))['approvalMode'], engine.autoPosting[brand]], ['manual', undefined], 'nothing saved on either side');
  });
});

test('a rename and the automatic posting choice can come in one call, and a rename alone leaves the choice as it was', async () => {
  await withEngine(async () => {
    const brand = await make('shop-1');
    await connect(brand, ['instagram']);
    const both = await patch({ externalId: 'shop-1', name: 'Om Sweets', autoPosting: { channels: ['instagram'], consent: true } });
    assert.equal(both.status, 200, JSON.stringify(both.body));
    assert.deepEqual([view(both)['name'], view(both)['approvalMode']], ['Om Sweets', 'auto']);
    const renamed = await patch({ externalId: 'shop-1', name: 'Om Sweets & Cafe' }, {});
    assert.deepEqual([view(renamed)['name'], view(renamed)['approvalMode'], auto(view(renamed))?.channels], ['Om Sweets & Cafe', 'auto', ['instagram']]);
  });
});

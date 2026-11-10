import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autopilotArgs, parseClients } from './run-clients.ts';

test('parseClients defaults the target to scheduler and requires its channel', () => {
  assert.throws(() => parseClients({ clients: [{ site: 'a.com', days: 7, time: '10:00', utcOffset: '+05:30' }] }), /channel/);
  const [client] = parseClients({
    clients: [{ site: 'a.com', channel: 'insta', days: 7, time: '10:00', utcOffset: '+05:30' }],
  });
  assert.equal(client?.target, 'scheduler');
});

test('parseClients accepts publisher clients without a channel and rejects unknown targets', () => {
  const [client] = parseClients({
    clients: [{ site: 'a.com', days: 7, time: '10:00', utcOffset: '+05:30', target: 'publisher' }],
  });
  assert.equal(client?.target, 'publisher');
  assert.throws(
    () => parseClients({ clients: [{ site: 'a.com', days: 7, time: '10:00', utcOffset: '+05:30', target: 'x' }] }),
    /target/,
  );
});

test('autopilotArgs passes the target and only includes a channel when set', () => {
  const args = autopilotArgs({ site: 'a.com', days: 7, time: '10:00', utcOffset: '+05:30', target: 'publisher' });
  assert.deepEqual(args.slice(-2), ['--target', 'publisher']);
  assert.ok(!args.includes('--channel'));
});

test('the weekly client run asks for the template route explicitly, so it cannot silently become the approval-queue route', () => {
  const args = autopilotArgs({ site: 'a.com', days: 7, time: '10:00', utcOffset: '+05:30', target: 'publisher' });
  assert.equal(args[args.indexOf('--route') + 1], 'template');
});

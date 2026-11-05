import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { connect, createServer as createTcpServer, type AddressInfo } from 'node:net';
import { startGuardProxy } from './guard-proxy.ts';

/** Asks the proxy for a tunnel and returns the status line it answers with. */
function tunnel(proxyPort: number, target: string): Promise<{ status: string; socket: ReturnType<typeof connect> }> {
  return new Promise((resolve, reject) => {
    const socket = connect(proxyPort, '127.0.0.1', () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    socket.once('data', (data) => resolve({ status: data.toString().split('\r\n')[0] ?? '', socket }));
    socket.on('error', reject);
  });
}

test('a tunnel to a private, loopback or metadata address is refused and recorded', async () => {
  const proxy = await startGuardProxy({ resolve: async (host) => (host === 'rebind.example.com' ? ['93.184.216.34', '10.0.0.5'] : host === 'internal.example.com' ? ['192.168.1.20'] : ['93.184.216.34']) });
  try {
    for (const target of ['127.0.0.1:443', '169.254.169.254:443', '[::1]:443', 'internal.example.com:443', 'rebind.example.com:443', 'localhost:443', 'example.com:8080', 'example.com:22']) {
      const { status, socket } = await tunnel(proxy.port, target);
      assert.match(status, /403/, target);
      socket.destroy();
    }
    assert.equal(proxy.refused.length, 8);
    assert.match(proxy.refused.join('\n'), /not a public website address/);
    assert.match(proxy.refused.join('\n'), /standard web port/);
  } finally {
    await proxy.close();
  }
});

test('a tunnel to a checked address carries traffic both ways', async () => {
  const echo = createTcpServer((socket) => socket.on('data', (d) => socket.write(`echo:${d.toString()}`)));
  await new Promise<void>((done) => echo.listen(0, '127.0.0.1', done));
  const echoPort = (echo.address() as AddressInfo).port;
  // The proxy only opens the standard ports; a local server is reached through test-only allowances.
  const strict = await startGuardProxy({ resolve: async () => ['127.0.0.1'], allowAddress: () => true });
  const open = await startGuardProxy({ resolve: async () => ['127.0.0.1'], allowAddress: () => true, allowPort: (port) => port === String(echoPort) });
  try {
    const refusedPort = await tunnel(strict.port, `example.com:${echoPort}`);
    assert.match(refusedPort.status, /403/, 'a non-standard port is refused even for an allowed address');
    refusedPort.socket.destroy();
    const { status, socket } = await tunnel(open.port, `example.com:${echoPort}`);
    assert.match(status, /200/);
    const reply = await new Promise<string>((done) => {
      socket.once('data', (d) => done(d.toString()));
      socket.write('hello');
    });
    assert.equal(reply, 'echo:hello');
    socket.destroy();
  } finally {
    await strict.close();
    await open.close();
    echo.close();
  }
});

test('plain http through the proxy to a private address is refused, and Chrome is told to use no way around the proxy', async () => {
  const local = createServer((_req, res) => res.end('secret'));
  await new Promise<void>((done) => local.listen(0, '127.0.0.1', done));
  const localPort = (local.address() as AddressInfo).port;
  const proxy = await startGuardProxy();
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({ host: '127.0.0.1', port: proxy.port, path: `http://127.0.0.1:${localPort}/`, method: 'GET', headers: { Host: `127.0.0.1:${localPort}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      request.on('error', reject);
      request.end();
    });
    assert.equal(status, 403);
    assert.ok(proxy.chromeArgs.includes('--proxy-bypass-list=<-loopback>'));
    assert.ok(proxy.chromeArgs.some((a) => a.startsWith('--proxy-server=http://127.0.0.1:')));
    assert.ok(proxy.chromeArgs.some((a) => a.startsWith('--host-resolver-rules=MAP * ~NOTFOUND')));
  } finally {
    await proxy.close();
    local.close();
  }
});

test('connections beyond the limit are dropped', async () => {
  const proxy = await startGuardProxy({ maxConnections: 1 });
  try {
    const first = connect(proxy.port, '127.0.0.1');
    await new Promise<void>((done) => first.once('connect', done));
    const second = connect(proxy.port, '127.0.0.1');
    const closed = await new Promise<boolean>((done) => {
      second.on('close', () => done(true));
      second.on('error', () => done(true));
      setTimeout(() => done(false), 1500);
    });
    assert.equal(closed, true);
    first.destroy();
  } finally {
    await proxy.close();
  }
});

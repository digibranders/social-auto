/**
 * A proxy that lets Chrome reach only public websites. Chrome follows redirects and loads scripts, frames, images and requests of its own, none of
 * which pass through the address check done before the page was opened, and it resolves names itself, so a name can be made to point at a private
 * address after it was checked. Every connection Chrome makes goes through this proxy instead: the destination name is resolved here, every address
 * is checked (see safe-fetch.ts), and the connection is made to the address that was checked. Anything else is refused and recorded.
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import { assertPublicUrl, systemResolver, type Resolver } from './safe-fetch.ts';

export interface GuardProxy {
  port: number;
  /** Destinations that were refused, with the reason, in the order they were asked for. */
  refused: string[];
  /** Chrome's arguments that send everything through this proxy and leave it no way around it. */
  chromeArgs: string[];
  close: () => Promise<void>;
}

export interface GuardProxyOptions {
  resolve?: Resolver;
  /** The most connections open at once. */
  maxConnections?: number;
  /** The most bytes one tunnel may carry before it is cut. */
  maxTunnelBytes?: number;
  /** A tunnel with no traffic for this long is closed. */
  idleMs?: number;
  /** For tests only: accepts an address that would otherwise be refused, so a tunnel can be made to a local server. The port rule still applies unless `allowPort` says otherwise. */
  allowAddress?: (address: string) => boolean;
  /** For tests only: accepts a port other than 80 and 443, with `allowAddress`. */
  allowPort?: (port: string) => boolean;
}

const HOP_HEADERS = new Set(['connection', 'proxy-connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

export async function startGuardProxy(options: GuardProxyOptions = {}): Promise<GuardProxy> {
  const { resolve = systemResolver, maxConnections = 200, maxTunnelBytes = 60_000_000, idleMs = 60_000, allowAddress, allowPort } = options;
  const refused: string[] = [];
  const sockets = new Set<Socket>();
  const refuse = (reason: string): void => void refused.push(reason);

  /** The address a destination resolves to, or null (and a record) when it may not be reached. */
  const destination = async (host: string, port: string, scheme: 'http' | 'https'): Promise<string | null> => {
    try {
      const url = new URL(`${scheme}://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}/`);
      if (allowAddress) {
        if (port !== '80' && port !== '443' && !allowPort?.(port)) throw new Error('only the standard web port is read');
        const addresses = await resolve(url.hostname.replace(/^\[|\]$/g, ''));
        const first = addresses[0];
        if (first !== undefined && addresses.every(allowAddress)) return first;
      }
      return (await assertPublicUrl(url, resolve))[0] ?? null;
    } catch (error) {
      refuse(`${host}:${port} ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  const server: Server = createServer();
  server.on('connection', (socket) => {
    if (sockets.size >= maxConnections) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.setTimeout(idleMs, () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
  });

  // HTTPS: Chrome asks for a tunnel to host:port. Only the standard ports are opened, to an address that was checked.
  server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
    const target = req.url ?? '';
    const split = target.lastIndexOf(':');
    const host = target.slice(0, split).replace(/^\[|\]$/g, '');
    const port = target.slice(split + 1);
    void destination(host, port, 'https').then((address) => {
      if (address === null) {
        client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      const upstream = netConnect({ host: address, port: Number(port) });
      sockets.add(upstream);
      let carried = 0;
      const cut = (): void => {
        upstream.destroy();
        client.destroy();
      };
      const count = (chunk: Buffer): void => {
        carried += chunk.length;
        if (carried > maxTunnelBytes) cut();
      };
      upstream.setTimeout(idleMs, cut);
      upstream.on('close', () => sockets.delete(upstream));
      upstream.on('error', () => {
        if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      });
      client.on('error', cut);
      upstream.on('data', count);
      client.on('data', count);
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      client.on('close', () => upstream.destroy());
    });
  });

  // Plain http through the proxy: the request line carries the whole address.
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (url.protocol !== 'http:') {
      refuse(`${url.href} only http is forwarded this way`);
      res.writeHead(403).end();
      return;
    }
    void destination(url.hostname, url.port || '80', 'http').then((address) => {
      if (address === null) {
        res.writeHead(403).end();
        return;
      }
      const headers: Record<string, string | string[]> = {};
      for (const [key, value] of Object.entries(req.headers)) if (value !== undefined && !HOP_HEADERS.has(key)) headers[key] = value;
      const forward = httpRequest({ host: address, port: Number(url.port || 80), path: `${url.pathname}${url.search}`, method: req.method ?? 'GET', headers }, (answer) => {
        const out: Record<string, string | string[]> = {};
        for (const [key, value] of Object.entries(answer.headers)) if (value !== undefined && !HOP_HEADERS.has(key)) out[key] = value;
        res.writeHead(answer.statusCode ?? 502, out);
        answer.pipe(res);
      });
      forward.setTimeout(idleMs, () => forward.destroy());
      forward.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(forward);
    });
  });

  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the guard proxy could not start');
  return {
    port: address.port,
    refused,
    chromeArgs: [
      `--proxy-server=http://127.0.0.1:${address.port}`,
      // Chrome skips a proxy for loopback addresses unless told not to; a page must not reach this machine's own services either.
      '--proxy-bypass-list=<-loopback>',
      // Chrome resolves nothing itself: every name must go through the proxy, which resolves and checks it.
      '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--disable-quic',
    ],
    close: () =>
      new Promise<void>((done) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => done());
      }),
  };
}

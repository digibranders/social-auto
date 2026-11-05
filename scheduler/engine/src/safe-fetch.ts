import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

/**
 * Reading a website on behalf of a customer means fetching an address a person typed. This is the only way the engine
 * does it: public addresses only (every address the name resolves to, at every redirect), the standard ports, an
 * honest name, a size cap, and respect for the site's robots.txt.
 */

/** What we tell a site we are. */
export const UserAgentName = 'SocialAutoBot/1.0 (+https://social.digibranders.com)';
/** The name sites use for us in robots.txt. */
export const RobotsToken = 'socialautobot';

export class FetchRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FetchRefusedError';
  }
}

export type Resolver = (host: string) => Promise<string[]>;

export const systemResolver: Resolver = async (host) => (await lookup(host, { all: true })).map((entry) => entry.address);

function isPublicIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // this-network, private, loopback, multicast and reserved
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local, including cloud metadata addresses
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if ((a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return false; // documentation ranges
  return true;
}

export function isPublicAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '').toLowerCase();
  const kind = isIP(ip);
  if (kind === 4) return isPublicIpv4(ip);
  if (kind !== 6) return false;
  if (ip === '::' || ip === '::1') return false;
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (dotted) return isPublicIpv4(dotted[1] as string);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (hex) {
    const high = Number.parseInt(hex[1] as string, 16);
    const low = Number.parseInt(hex[2] as string, 16);
    return isPublicIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  // Only global unicast (2000::/3) is a public website address. That leaves out unique-local, link-local, multicast, NAT64 and every other range by default,
  // and the ranges inside it that embed or document other addresses: Teredo (2001::/32), documentation (2001:db8::/32, 3fff::/20) and 6to4 (2002::/16).
  const first = Number.parseInt(ip.split(':')[0] || '0', 16);
  if (!(first >= 0x2000 && first <= 0x3fff)) return false;
  if (first === 0x2002 || first === 0x3fff) return false;
  if (first === 0x2001) {
    // 2001::/23 is reserved for protocol assignments (Teredo, benchmarking, ORCHID, and others); 2001:db8::/32 is for documentation.
    const second = Number.parseInt(ip.split(':')[1] || '0', 16);
    if (second < 0x200 || second === 0xdb8) return false;
  }
  // AS112 and other special-purpose blocks inside 2620::/23 and 2a0?: a small list of well-known ones.
  if (ip.startsWith('2620:4f:8000:')) return false;
  return true;
}

const LOCAL_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home', '.corp', '.intranet', '.test', '.invalid', '.example'];

/** Throws unless the address is an ordinary public web address. Returns the addresses the name resolved to, every one of them public. */
export async function assertPublicUrl(url: URL, resolve: Resolver = systemResolver): Promise<string[]> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new FetchRefusedError('only http and https addresses are read');
  if (url.username || url.password) throw new FetchRefusedError('an address with a login in it is not read');
  if (url.port && url.port !== '80' && url.port !== '443') throw new FetchRefusedError('only the standard web port is read');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  // A name with no dot (localhost, intranet) or on a local-only suffix is never a public website.
  if (!isIP(host) && (!host.includes('.') || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix)))) {
    throw new FetchRefusedError(`${host} is not a public website address`);
  }
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new FetchRefusedError(`${host} is not a public website address`);
    return [host];
  }
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch (error) {
    throw new FetchRefusedError(`Could not find ${host} (${error instanceof Error ? error.message : String(error)})`);
  }
  if (addresses.length === 0 || !addresses.every(isPublicAddress)) throw new FetchRefusedError(`${host} is not a public website address`);
  return addresses;
}

/**
 * A fetch that connects to the very address it checked. Checking a name and then letting the client resolve it again leaves a gap in which the
 * name can start pointing at a private address (DNS rebinding); here the name is resolved once, every address is checked, and the connection is
 * made to that address (with the site's own name for the Host header and the certificate check). Redirects are not followed: the caller
 * answers a 3xx by checking the next address from the start.
 */
export function pinnedFetch(resolve: Resolver = systemResolver): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const addresses = await assertPublicUrl(url, resolve);
    const address = addresses[0] as string;
    const headers: Record<string, string> = { 'Accept-Encoding': 'gzip, deflate, br', Host: url.host };
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    return await new Promise<Response>((resolveResponse, reject) => {
      const clientRequest = send({ host: address, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: `${url.pathname}${url.search}`, method: 'GET', headers, ...(url.protocol === 'https:' ? { servername: isIP(url.hostname) ? undefined : url.hostname } : {}) }, (incoming) => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
        const encoding = String(incoming.headers['content-encoding'] ?? '').toLowerCase();
        const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : undefined;
        responseHeaders.delete('content-encoding');
        responseHeaders.delete('content-length');
        const status = incoming.statusCode ?? 0;
        const noBody = status === 204 || status === 205 || status === 304 || (status >= 300 && status < 400);
        if (noBody) incoming.resume();
        const source = noBody ? null : decoder ? incoming.pipe(decoder) : incoming;
        if (decoder) incoming.on('error', (error) => decoder.destroy(error));
        resolveResponse(new Response(source ? (Readable.toWeb(source) as unknown as ReadableStream) : null, { status, headers: responseHeaders }));
      });
      clientRequest.on('error', reject);
      init?.signal?.addEventListener('abort', () => clientRequest.destroy(new Error('the request was stopped (timeout)')), { once: true });
      clientRequest.end();
    });
  };
}

export interface SafeFetchOptions {
  fetchFn?: typeof fetch;
  resolve?: Resolver;
  timeoutMs?: number;
  maxRedirects?: number;
  maxBytes?: number;
  accept?: string;
}

export interface FetchedPage {
  finalUrl: string;
  body: string;
  type: string;
}

export interface FetchedBytes {
  finalUrl: string;
  bytes: Buffer;
  type: string;
}

async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.from(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel();
      throw new FetchRefusedError('the page is too large to read');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** One address fetched safely, as raw bytes (for pictures). Each redirect is checked like a new address. */
export async function safeFetchBytes(url: string, options: SafeFetchOptions = {}): Promise<FetchedBytes> {
  const { resolve = systemResolver, timeoutMs = 20_000, maxRedirects = 5, maxBytes = 3_000_000, accept = 'text/html,text/css,*/*' } = options;
  const fetchFn = options.fetchFn ?? pinnedFetch(resolve);
  let current = new URL(url);
  for (let hops = 0; hops <= maxRedirects; hops++) {
    await assertPublicUrl(current, resolve);
    const response = await fetchFn(current.href, {
      headers: { 'User-Agent': UserAgentName, Accept: accept },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new FetchRefusedError(`${current.href} answered ${response.status}`);
    return { finalUrl: current.href, bytes: await readCapped(response, maxBytes), type: response.headers.get('content-type') ?? '' };
  }
  throw new FetchRefusedError('too many redirects');
}

/** One address fetched safely, as text. Each redirect is checked like a new address; nothing private is ever requested. */
export async function safeFetch(url: string, options: SafeFetchOptions = {}): Promise<FetchedPage> {
  const { finalUrl, bytes, type } = await safeFetchBytes(url, options);
  return { finalUrl, body: bytes.toString('utf8'), type };
}

interface RobotsGroup {
  agents: string[];
  rules: Array<{ allow: boolean; path: string }>;
}

export type RobotsRules = RobotsGroup[];

export function parseRobots(text: string): RobotsRules {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if ((field === 'allow' || field === 'disallow') && current && value !== '') current.rules.push({ allow: field === 'allow', path: value });
  }
  return groups;
}

function matches(rule: string, path: string): boolean {
  if (!/[*$]/.test(rule)) return path.startsWith(rule);
  const pattern = rule.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\$$/, '$');
  return new RegExp(`^${pattern}`).test(path);
}

/** Whether robots.txt lets us read this path. Our own group applies if there is one, otherwise the * group. */
export function robotsAllows(rules: RobotsRules, path: string): boolean {
  const ours = rules.filter((g) => g.agents.some((agent) => agent !== '*' && RobotsToken.includes(agent.replace(/\/.*$/, '')) ));
  const group = ours.length > 0 ? ours : rules.filter((g) => g.agents.includes('*'));
  let best: { allow: boolean; length: number } | null = null;
  for (const { rules: list } of group) {
    for (const rule of list) {
      if (!matches(rule.path, path)) continue;
      if (!best || rule.path.length > best.length || (rule.path.length === best.length && rule.allow)) best = { allow: rule.allow, length: rule.path.length };
    }
  }
  return best ? best.allow : true;
}

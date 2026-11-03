import { createHash } from 'node:crypto';
import { EditError } from './overrides.js';

/** A client added in the dashboard, kept apart from the clients the content job plans posts for. */
export interface AddedClient {
  /** Lower-case slug, e.g. "brand-basket". The dashboard shows it as "Brand Basket". */
  brand: string;
  createdAt: string;
  /** The product that owns it (e.g. "brandbasket"); missing for clients added by hand in the dashboard. */
  product?: string;
  /** The product's own id for this customer, so asking twice never makes two. */
  externalId?: string;
  /** The name to show, when the slug alone would read badly. */
  name?: string;
  /** The client's own website (plain https address) that posts are planned from. */
  website?: string;
}

export interface ClientsFile {
  clients: AddedClient[];
}

export const MAX_ADDED_CLIENTS = 2000;
const BRAND = /^[a-z0-9][a-z0-9-]{0,40}$/;

export const isBrandSlug = (value: unknown): value is string => typeof value === 'string' && BRAND.test(value);

export function parseClientsFile(raw: unknown): ClientsFile {
  const list = (raw as { clients?: unknown } | null)?.clients;
  if (!Array.isArray(list)) throw new Error('clients file must contain a "clients" array');
  return {
    clients: list.map((c: Record<string, unknown>, i): AddedClient => {
      if (!isBrandSlug(c['brand'])) throw new Error(`clients[${i}].brand is malformed`);
      if (typeof c['createdAt'] !== 'string') throw new Error(`clients[${i}].createdAt must be a string`);
      for (const key of ['product', 'externalId', 'name', 'website'] as const) {
        if (c[key] !== undefined && typeof c[key] !== 'string') throw new Error(`clients[${i}].${key} must be a string`);
      }
      return c as unknown as AddedClient;
    }),
  };
}

/** "Brand Basket!" becomes "brand-basket": letters and digits only, words joined by one dash. */
export function slugFor(name: unknown): string {
  if (typeof name !== 'string') throw new EditError('write the client\'s name');
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 41)
    .replace(/-+$/g, '');
  if (!isBrandSlug(slug)) throw new EditError('the name needs at least one letter or number');
  return slug;
}

const REFUSED_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home', '.corp', '.intranet', '.test', '.invalid', '.example'];
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The plain address of a client's website: https, host only. The content job fetches it from the server, so it must be
 * a public web address: no logins, ports, local or private hosts, and no addresses written as numbers.
 */
export function normalizeWebsite(input: unknown): string {
  if (typeof input !== 'string' || input.trim() === '') throw new EditError('write the website\'s address, like example.com');
  const text = input.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new EditError('that is not a website address');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new EditError('the website address must start with http or https');
  if (url.username || url.password) throw new EditError('the website address must not contain a login');
  if (url.port) throw new EditError('write the website address without a port number');
  const host = url.hostname.toLowerCase();
  const labels = host.split('.');
  const bad =
    host.length > 253 ||
    host.includes(':') ||
    labels.length < 2 ||
    !labels.every((label) => LABEL.test(label)) ||
    !/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(labels[labels.length - 1] as string) ||
    REFUSED_SUFFIXES.some((suffix) => host.endsWith(suffix));
  if (bad) throw new EditError('that is not a public website address');
  return `https://${host}`;
}

/** Adds a client, refusing a name that is already a client (planned or added). */
export function addClient(file: ClientsFile, name: unknown, existing: ReadonlySet<string>, now: number, website?: unknown): { file: ClientsFile; brand: string } {
  const brand = slugFor(name);
  const site = website === undefined || website === null || (typeof website === 'string' && website.trim() === '') ? undefined : normalizeWebsite(website);
  if (existing.has(brand) || file.clients.some((c) => c.brand === brand)) throw new EditError('there is already a client with that name', 409);
  if (file.clients.length >= MAX_ADDED_CLIENTS) throw new EditError('too many added clients; remove one first');
  return { file: { clients: [...file.clients, { brand, createdAt: new Date(now).toISOString(), ...(site ? { website: site } : {}) }] }, brand };
}

/** Sets or clears (empty) the website of a client added in the dashboard. */
export function setWebsite(file: ClientsFile, brand: string, website: unknown): ClientsFile {
  const index = file.clients.findIndex((c) => c.brand === brand);
  if (index === -1) throw new EditError('only a client added in the dashboard has a website here', 404);
  const clear = website === null || (typeof website === 'string' && website.trim() === '');
  const site = clear ? undefined : normalizeWebsite(website);
  const { website: _old, ...rest } = file.clients[index] as AddedClient;
  return { clients: file.clients.map((c, i) => (i === index ? { ...rest, ...(site ? { website: site } : {}) } : c)) };
}

/** Every client the system knows: the planned ones from the content job, then the ones added by hand. */
export function allBrands(planned: Iterable<string>, file: ClientsFile): Set<string> {
  return new Set([...planned, ...file.clients.map((c) => c.brand)]);
}

const EXTERNAL_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_NAME_LENGTH = 80;

export const isExternalId = (value: unknown): value is string => typeof value === 'string' && EXTERNAL_ID.test(value);

/** The workspace id (brand) for a product's customer: stable, readable, and unique to that product. */
export function workspaceBrand(product: string, externalId: string): string {
  const tail = externalId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20).replace(/-+$/g, '');
  const digest = createHash('sha256').update(`${product}:${externalId}`).digest('hex').slice(0, 6);
  return `${product}-${tail ? `${tail}-` : ''}${digest}`;
}

/** Finds a product's customer by the product's own id. Another product's customers are never found. */
export const findWorkspace = (file: ClientsFile, product: string, externalId: string): AddedClient | undefined =>
  file.clients.find((c) => c.product === product && c.externalId === externalId);

/** Creates a workspace for a product's customer, or returns the one that already exists (asking twice is safe). */
export function ensureWorkspace(
  file: ClientsFile,
  product: string,
  externalId: unknown,
  name: unknown,
  now: number,
): { file: ClientsFile; client: AddedClient; created: boolean } {
  if (!isExternalId(externalId)) throw new EditError('externalId must be 1-64 letters, digits or . _ : -');
  const shown = typeof name === 'string' ? name.trim().slice(0, MAX_NAME_LENGTH) : '';
  const existing = findWorkspace(file, product, externalId);
  if (existing) return { file, client: existing, created: false };
  if (file.clients.length >= MAX_ADDED_CLIENTS) throw new EditError('too many clients', 409);
  const brand = workspaceBrand(product, externalId);
  const client: AddedClient = { brand, createdAt: new Date(now).toISOString(), product, externalId, ...(shown ? { name: shown } : {}) };
  return { file: { clients: [...file.clients, client] }, client, created: true };
}

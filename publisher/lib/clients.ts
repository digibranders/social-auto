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
      for (const key of ['product', 'externalId', 'name'] as const) {
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

/** Adds a client, refusing a name that is already a client (planned or added). */
export function addClient(file: ClientsFile, name: unknown, existing: ReadonlySet<string>, now: number): { file: ClientsFile; brand: string } {
  const brand = slugFor(name);
  if (existing.has(brand) || file.clients.some((c) => c.brand === brand)) throw new EditError('there is already a client with that name', 409);
  if (file.clients.length >= MAX_ADDED_CLIENTS) throw new EditError('too many added clients; remove one first');
  return { file: { clients: [...file.clients, { brand, createdAt: new Date(now).toISOString() }] }, brand };
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

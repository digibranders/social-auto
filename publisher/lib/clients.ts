import { EditError } from './overrides.js';

/** A client added in the dashboard, kept apart from the clients the content job plans posts for. */
export interface AddedClient {
  /** Lower-case slug, e.g. "brand-basket". The dashboard shows it as "Brand Basket". */
  brand: string;
  createdAt: string;
}

export interface ClientsFile {
  clients: AddedClient[];
}

export const MAX_ADDED_CLIENTS = 100;
const BRAND = /^[a-z0-9][a-z0-9-]{0,40}$/;

export const isBrandSlug = (value: unknown): value is string => typeof value === 'string' && BRAND.test(value);

export function parseClientsFile(raw: unknown): ClientsFile {
  const list = (raw as { clients?: unknown } | null)?.clients;
  if (!Array.isArray(list)) throw new Error('clients file must contain a "clients" array');
  return {
    clients: list.map((c: Record<string, unknown>, i): AddedClient => {
      if (!isBrandSlug(c['brand'])) throw new Error(`clients[${i}].brand is malformed`);
      if (typeof c['createdAt'] !== 'string') throw new Error(`clients[${i}].createdAt must be a string`);
      return { brand: c['brand'], createdAt: c['createdAt'] };
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

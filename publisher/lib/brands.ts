/**
 * How many brands (workspaces) one product customer may have under one login. The ceiling is a code constant: no screen and no stored value can go above it.
 * The default and a per-customer value live in one small record in the store, with a log of every change.
 */
import { groupOf, type AddedClient, type ClientsFile } from './clients.js';
import { EditError } from './overrides.js';

/** The most brands one customer can ever be allowed. */
export const BRANDS_CEILING = 4;
/** The most workspaces (archived or not) one customer's group can ever hold, so putting brands away and making new ones cannot dodge the limit. */
export const MAX_WORKSPACES_PER_GROUP = 8;
export const DEFAULT_BRANDS = 1;
const MAX_LOG = 500;

export interface BrandChange {
  at: string;
  /** Who changed it (the staff dashboard has one login, so this is a short fixed name). */
  by: string;
  /** "default" or "<product>:<group>". */
  what: string;
  old: number | null;
  new: number | null;
}

export interface BrandSettings {
  defaultBrands: number;
  /** Per customer, by "<product>:<group>". */
  groups: Record<string, number>;
  log: BrandChange[];
}

export const NO_BRAND_SETTINGS: BrandSettings = { defaultBrands: DEFAULT_BRANDS, groups: {}, log: [] };

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= BRANDS_CEILING;

/** Reads the stored record. A value outside 1 to the ceiling is an error, never trusted. */
export function parseBrandSettings(raw: unknown): BrandSettings {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('brands.json must be an object');
  const r = raw as Record<string, unknown>;
  const defaultBrands = r['defaultBrands'] ?? DEFAULT_BRANDS;
  if (!isCount(defaultBrands)) throw new Error(`brands.json defaultBrands must be a whole number from 1 to ${BRANDS_CEILING}`);
  const groups = r['groups'] ?? {};
  if (typeof groups !== 'object' || groups === null || Array.isArray(groups)) throw new Error('brands.json groups must be an object');
  for (const [key, value] of Object.entries(groups)) if (!isCount(value)) throw new Error(`brands.json groups["${key}"] must be a whole number from 1 to ${BRANDS_CEILING}`);
  const log = r['log'] ?? [];
  if (!Array.isArray(log)) throw new Error('brands.json log must be a list');
  return { defaultBrands, groups: { ...(groups as Record<string, number>) }, log: log.filter((e): e is BrandChange => typeof e === 'object' && e !== null && typeof (e as BrandChange).at === 'string').slice(-MAX_LOG) };
}

export const groupKey = (product: string, group: string): string => `${product}:${group}`;

/** How many brands this customer may have now. */
export const brandsAllowed = (settings: BrandSettings, product: string, group: string): number => settings.groups[groupKey(product, group)] ?? settings.defaultBrands;

/** The brands that count against the allowance: those not put away. */
export const brandsUsed = (workspaces: readonly Pick<AddedClient, 'archived'>[]): number => workspaces.filter((w) => w.archived !== true).length;

export interface BrandsFeed {
  defaultBrands: number;
  ceiling: number;
  /** One entry per customer of a product, with how many brands they may have and have. */
  customers: Array<{ product: string; group: string; name: string; brandsAllowed: number; brandsUsed: number; brandsTotal: number; custom: boolean }>;
  /** The latest changes, newest first. */
  log: BrandChange[];
}

/** What the staff dashboard shows: the default, every product customer with their allowance, and the latest changes. */
export function brandsFeed(settings: BrandSettings, clients: ClientsFile): BrandsFeed {
  const groups = new Map<string, AddedClient[]>();
  for (const c of clients.clients) {
    const group = groupOf(c);
    if (c.product === undefined || group === undefined) continue;
    const key = groupKey(c.product, group);
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const customers = [...groups.entries()].map(([key, members]) => {
    const first = [...members].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] as AddedClient;
    const product = first.product as string;
    const group = groupOf(first) as string;
    return { product, group, name: first.name ?? first.brand, brandsAllowed: brandsAllowed(settings, product, group), brandsUsed: brandsUsed(members), brandsTotal: members.length, custom: settings.groups[key] !== undefined };
  });
  return { defaultBrands: settings.defaultBrands, ceiling: BRANDS_CEILING, customers: customers.sort((a, b) => a.name.localeCompare(b.name)), log: [...settings.log].reverse().slice(0, 20) };
}

const brandsText = (n: number): string => `${n} brand${n === 1 ? '' : 's'}`;

/**
 * Refuses a new brand (or bringing one back) that would go over what the customer is allowed, or over the most workspaces a customer can ever hold.
 * `existing` are the customer's workspaces now; `adding` is false when a brand already in the list is being brought back (it is not new, only counted again).
 */
export function assertRoomForBrand(existing: readonly Pick<AddedClient, 'archived'>[], allowed: number, adding: boolean): void {
  if (brandsUsed(existing) >= allowed) throw new EditError(`You can have ${brandsText(allowed)}. Ask us to allow more.`, 409, 'BRAND_LIMIT_REACHED');
  if (adding && existing.length >= MAX_WORKSPACES_PER_GROUP) throw new EditError('This customer has reached the most brands that can ever be set up. Ask us for help.', 409, 'BRAND_LIMIT_REACHED');
}

export class BrandSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrandSettingsError';
  }
}

const logged = (settings: BrandSettings, change: BrandChange): BrandChange[] => [...settings.log, change].slice(-MAX_LOG);

/** The settings with the global default changed (and the change logged). */
export function withDefaultBrands(settings: BrandSettings, value: unknown, by: string, now: number): BrandSettings {
  if (!isCount(value)) throw new BrandSettingsError(`brands allowed must be a whole number from 1 to ${BRANDS_CEILING}`);
  if (value === settings.defaultBrands) return settings;
  return { ...settings, defaultBrands: value, log: logged(settings, { at: new Date(now).toISOString(), by, what: 'default', old: settings.defaultBrands, new: value }) };
}

/** The settings with one customer's value changed, or put back to the default with null (and the change logged). */
export function withGroupBrands(settings: BrandSettings, product: string, group: string, value: unknown, by: string, now: number): BrandSettings {
  if (value !== null && !isCount(value)) throw new BrandSettingsError(`brands allowed must be a whole number from 1 to ${BRANDS_CEILING}`);
  const key = groupKey(product, group);
  const old = settings.groups[key] ?? null;
  if (value === old) return settings;
  const { [key]: _gone, ...rest } = settings.groups;
  return { ...settings, groups: value === null ? rest : { ...rest, [key]: value }, log: logged(settings, { at: new Date(now).toISOString(), by, what: key, old, new: value }) };
}

import { createHash } from 'node:crypto';
import { EditError } from './overrides.js';
import { DEFAULT_WEEKLY_LIMIT, MAX_WEEKLY_LIMIT, assertWithinLimit } from './quota.js';

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
  /** What to post, where and for how long: one entry per plan, each with its own platforms, so Instagram can have a different rhythm from LinkedIn. The content job makes the posters; nothing posts before they are approved. */
  plans?: ClientPlan[];
  /** The most posters a week the website may make for each channel; missing means the default (3). */
  weeklyLimit?: number;
}

export const PLAN_PLATFORMS = ['instagram', 'facebook', 'linkedin', 'google'] as const;
export const PLAN_WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export const MAX_PLAN_DAYS = 31;
export const MAX_PLANS_PER_CLIENT = 8;

export interface ClientPlan {
  platforms: string[];
  /** YYYY-MM-DD, the first day that may be posted on. */
  startDate: string;
  /** 1 is a single day. */
  durationDays: number;
  postsPerWeek?: number;
  weekdays?: string[];
  time: string;
  utcOffset: string;
}

const isRealDate = (date: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(date) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;

/** Today's date at a UTC offset like "+05:30". */
function todayAt(utcOffset: string, now: number): string {
  const sign = utcOffset.startsWith('-') ? -1 : 1;
  const [h = 0, m = 0] = utcOffset.slice(1).split(':').map(Number);
  return new Date(now + sign * (h * 60 + m) * 60_000).toISOString().slice(0, 10);
}

/** Reads a posting plan from untrusted data, or says in plain words what is wrong. A saved plan may have a start date that has since passed. */
export function parseClientPlan(raw: unknown, now: number, options: { allowPast?: boolean } = {}): ClientPlan {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new EditError('the posting plan is not valid');
  const r = raw as Record<string, unknown>;
  const platforms = r['platforms'];
  if (!Array.isArray(platforms) || platforms.length === 0) throw new EditError('choose at least one platform to post on');
  const chosen = new Set<string>();
  for (const p of platforms) {
    if (typeof p !== 'string' || !(PLAN_PLATFORMS as readonly string[]).includes(p)) throw new EditError(`"${String(p)}" is not a platform to post on`);
    chosen.add(p);
  }
  const time = r['time'] === undefined ? '10:00' : r['time'];
  const utcOffset = r['utcOffset'] === undefined ? '+05:30' : r['utcOffset'];
  if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new EditError('the time must look like 10:00');
  if (typeof utcOffset !== 'string' || !/^[+-](0\d|1[0-4]):[0-5]\d$/.test(utcOffset)) throw new EditError('the time zone must look like +05:30');
  const startDate = r['startDate'];
  if (typeof startDate !== 'string' || !isRealDate(startDate)) throw new EditError('the start date must be a real date');
  if (!options.allowPast && startDate < todayAt(utcOffset, now)) throw new EditError('the start date is in the past');
  const durationDays = r['durationDays'];
  if (typeof durationDays !== 'number' || !Number.isInteger(durationDays) || durationDays < 1 || durationDays > MAX_PLAN_DAYS) throw new EditError(`the length must be from 1 to ${MAX_PLAN_DAYS} days`);
  const plan: ClientPlan = { platforms: PLAN_PLATFORMS.filter((p) => chosen.has(p)), startDate, durationDays, time, utcOffset };
  if (r['weekdays'] !== undefined) {
    const days = r['weekdays'];
    if (!Array.isArray(days) || days.length === 0 || !days.every((d) => typeof d === 'string' && (PLAN_WEEKDAYS as readonly string[]).includes(d.trim().toLowerCase().slice(0, 3)))) throw new EditError('the weekdays must be a list like mon, wed, fri');
    const set = new Set((days as string[]).map((d) => d.trim().toLowerCase().slice(0, 3)));
    plan.weekdays = PLAN_WEEKDAYS.filter((d) => set.has(d));
  } else if (r['postsPerWeek'] !== undefined) {
    const n = r['postsPerWeek'];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 7) throw new EditError('posts per week must be from 1 to 7');
    plan.postsPerWeek = n;
  }
  return plan;
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
      if (c['weeklyLimit'] !== undefined && (typeof c['weeklyLimit'] !== 'number' || !Number.isInteger(c['weeklyLimit']) || c['weeklyLimit'] < 1 || c['weeklyLimit'] > MAX_WEEKLY_LIMIT)) throw new Error(`clients[${i}].weeklyLimit must be a whole number from 1 to ${MAX_WEEKLY_LIMIT}`);
      // A client saved by the first version has one `plan`; it is read as a list of one.
      const { plan: single, ...rest } = c as Record<string, unknown>;
      const listed = rest['plans'] !== undefined ? rest['plans'] : single !== undefined ? [single] : undefined;
      if (listed !== undefined) {
        if (!Array.isArray(listed) || listed.length > MAX_PLANS_PER_CLIENT) throw new Error(`clients[${i}].plans must be a list of at most ${MAX_PLANS_PER_CLIENT}`);
        listed.forEach((entry, n) => {
          try {
            parseClientPlan(entry, 0, { allowPast: true });
          } catch (error) {
            throw new Error(`clients[${i}].plans[${n}] is not valid: ${error instanceof Error ? error.message : String(error)}`);
          }
        });
        return { ...rest, plans: listed } as unknown as AddedClient;
      }
      return rest as unknown as AddedClient;
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
export function addClient(file: ClientsFile, name: unknown, existing: ReadonlySet<string>, now: number, website?: unknown, plan?: unknown): { file: ClientsFile; brand: string } {
  const brand = slugFor(name);
  const site = website === undefined || website === null || (typeof website === 'string' && website.trim() === '') ? undefined : normalizeWebsite(website);
  const posting = plan === undefined || plan === null ? undefined : parseClientPlan(plan, now);
  if (posting && !site) throw new EditError('a posting plan needs the client\'s website to make the posts from');
  if (posting) assertWithinLimit([], posting, DEFAULT_WEEKLY_LIMIT, now);
  if (existing.has(brand) || file.clients.some((c) => c.brand === brand)) throw new EditError('there is already a client with that name', 409);
  if (file.clients.length >= MAX_ADDED_CLIENTS) throw new EditError('too many added clients; remove one first');
  return { file: { clients: [...file.clients, { brand, createdAt: new Date(now).toISOString(), ...(site ? { website: site } : {}), ...(posting ? { plans: [posting] } : {}) }] }, brand };
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

/** Adds one more posting plan to a client added in the dashboard (it needs the client's website). The plans already there, and the posters already made for them, are left alone. */
export function addPlan(file: ClientsFile, brand: string, plan: unknown, now: number): ClientsFile {
  const index = file.clients.findIndex((c) => c.brand === brand);
  if (index === -1) throw new EditError('only a client added in the dashboard has a posting plan here', 404);
  const current = file.clients[index] as AddedClient;
  if (!current.website) throw new EditError('add the client\'s website first: the posts are made from it');
  const added = parseClientPlan(plan, now);
  const plans = current.plans ?? [];
  if (plans.length >= MAX_PLANS_PER_CLIENT) throw new EditError(`a client can have at most ${MAX_PLANS_PER_CLIENT} plans; remove one first`);
  if (plans.some((p) => JSON.stringify(p) === JSON.stringify(added))) throw new EditError('that plan is already there');
  assertWithinLimit(plans, added, current.weeklyLimit ?? DEFAULT_WEEKLY_LIMIT, now);
  return { clients: file.clients.map((c, i) => (i === index ? { ...current, plans: [...plans, added] } : c)) };
}

/** Sets how many posters a week the website may make for each channel of a client. It only governs plans added afterwards; a plan already there stays. */
export function setWeeklyLimit(file: ClientsFile, brand: string, limit: unknown): ClientsFile {
  const index = file.clients.findIndex((c) => c.brand === brand);
  if (index === -1) throw new EditError('only a client added in the dashboard has a posting limit here', 404);
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_WEEKLY_LIMIT) throw new EditError(`the limit must be a whole number from 1 to ${MAX_WEEKLY_LIMIT} posts a week`);
  const { weeklyLimit: _old, ...rest } = file.clients[index] as AddedClient;
  return { clients: file.clients.map((c, i) => (i === index ? { ...rest, ...(limit !== DEFAULT_WEEKLY_LIMIT ? { weeklyLimit: limit } : {}) } : c)) };
}

/** Takes one plan off a client (by its place in the list). Posters already made for it stay in the review queue; no more are made. */
export function removePlan(file: ClientsFile, brand: string, position: unknown): ClientsFile {
  const index = file.clients.findIndex((c) => c.brand === brand);
  if (index === -1) throw new EditError('only a client added in the dashboard has a posting plan here', 404);
  const current = file.clients[index] as AddedClient;
  const plans = current.plans ?? [];
  if (typeof position !== 'number' || !Number.isInteger(position) || position < 0 || position >= plans.length) throw new EditError('that plan was not found', 404);
  const { plans: _old, ...rest } = current;
  const left = plans.filter((_, n) => n !== position);
  return { clients: file.clients.map((c, i) => (i === index ? { ...rest, ...(left.length > 0 ? { plans: left } : {}) } : c)) };
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

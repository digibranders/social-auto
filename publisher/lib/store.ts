import { NO_BRAND_SETTINGS, parseBrandSettings, type BrandSettings } from './brands.js';
import { EMPTY_ANALYTICS, parseAnalytics, type AnalyticsFile } from './analytics.js';
import { EMPTY_INBOX, parseInbox, type InboxFile } from './inbox.js';
import { EMPTY_OUTBOX, parseOutbox, type Outbox } from './outbox.js';
import { NO_ALERTS, parseAlertLog, type AlertLog } from './missed.js';
import { NO_PAUSES, parsePauses, type PauseFile } from './pauses.js';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BlobPreconditionFailedError, del, get, put } from '@vercel/blob';
import { parseChannels, parsePostedLog, type ChannelFile, type PostedLog } from './channels.js';
import { parseClientsFile, type ClientsFile } from './clients.js';
import { parseManualFile, type ManualFile } from './manual.js';
import { parseAutoDmFile, type AutoDmFile } from './autodm.js';
import { EditError, isImageKey, parseOverrides, type OverrideMap } from './overrides.js';

/**
 * Where dashboard edits live: one private Vercel Blob store (token in BLOB_READ_WRITE_TOKEN, created
 * by `vercel blob create-store`). The edits file is a single JSON document; pictures are separate blobs.
 */
const OVERRIDES_PATH = 'overrides.json';
const imagePath = (key: string): string => `images/${key}.jpg`;

/**
 * For local testing only: when LOCAL_STORE_DIR is set, the JSON documents (edits, channels, posted log) live in
 * that folder instead of the Blob store, so a test run can never touch real data. Pictures are not stored locally.
 */
const localDir = (): string | null => process.env['LOCAL_STORE_DIR'] || null;

export function storeConfigured(): boolean {
  return Boolean(process.env['BLOB_READ_WRITE_TOKEN']) || localDir() !== null;
}

export interface LoadedOverrides {
  overrides: OverrideMap;
  /** Version marker for a conditional write; null when nothing was saved yet. */
  etag: string | null;
}

/** Reads the saved edits. A store that is not configured or holds nothing yet means "no edits". */
export async function loadOverrides(): Promise<LoadedOverrides> {
  if (!storeConfigured()) return { overrides: {}, etag: null };
  const { value, etag } = await readJson(OVERRIDES_PATH);
  return { overrides: value === null ? {} : parseOverrides(value), etag };
}

/** Saves the edits, refusing to overwrite a version someone else saved since `etag` was read. */
export function saveOverrides(overrides: OverrideMap, etag: string | null): Promise<void> {
  return writeJson(OVERRIDES_PATH, overrides, etag, 'Another change was saved at the same moment. Reload and try again.');
}

export async function saveImage(key: string, bytes: Uint8Array): Promise<void> {
  const dir = localDir();
  if (dir) {
    await mkdir(join(dir, 'images'), { recursive: true });
    await writeFile(join(dir, imagePath(key)), bytes, { mode: 0o600 });
    return;
  }
  await put(imagePath(key), Buffer.from(bytes), {
    access: 'private',
    contentType: 'image/jpeg',
    addRandomSuffix: false,
    allowOverwrite: false,
  });
}

/** The picture's bytes, or null when no such picture exists. */
export async function loadImage(key: string): Promise<ReadableStream<Uint8Array> | null> {
  if (!isImageKey(key) || !storeConfigured()) return null;
  const dir = localDir();
  if (dir) {
    const bytes = await readFile(join(dir, imagePath(key))).catch(() => null);
    return bytes ? new Response(bytes).body : null;
  }
  const result = await get(imagePath(key), { access: 'private' });
  return result && result.statusCode === 200 ? result.stream : null;
}

export async function deleteImage(key: string): Promise<void> {
  const dir = localDir();
  if (dir) {
    await rm(join(dir, imagePath(key)), { force: true });
    return;
  }
  await del(imagePath(key));
}

const CHANNELS_PATH = 'channels.json';
const POSTED_PATH = 'posted.json';

interface LoadedJson {
  value: unknown;
  etag: string | null;
}

const fingerprint = (text: string): string => createHash('sha256').update(text).digest('hex');

async function readJson(path: string): Promise<LoadedJson> {
  const dir = localDir();
  if (dir) {
    const text = await readFile(join(dir, path), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    return text === null ? { value: null, etag: null } : { value: JSON.parse(text), etag: fingerprint(text) };
  }
  const result = await get(path, { access: 'private', useCache: false });
  if (!result) return { value: null, etag: null };
  if (result.statusCode !== 200) throw new Error(`unexpected status ${result.statusCode} reading ${path}`);
  return { value: JSON.parse(await new Response(result.stream).text()), etag: result.blob.etag };
}

const CONFLICT = 'Another change was saved at the same moment. Try again.';

async function writeJson(path: string, value: unknown, etag: string | null, conflict: string = CONFLICT): Promise<void> {
  const dir = localDir();
  if (dir) {
    const current = await readJson(path);
    if (current.etag !== etag) throw new EditError(conflict, 409, 'CONFLICT');
    const file = join(dir, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
    return;
  }
  try {
    await put(path, JSON.stringify(value), {
      access: 'private',
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true,
      ...(etag ? { ifMatch: etag } : {}),
    });
  } catch (error) {
    if (error instanceof BlobPreconditionFailedError) throw new EditError(conflict, 409, 'CONFLICT');
    throw error;
  }
}

export async function loadChannels(): Promise<{ file: ChannelFile; etag: string | null }> {
  if (!storeConfigured()) return { file: { channels: [] }, etag: null };
  const { value, etag } = await readJson(CHANNELS_PATH);
  return { file: value === null ? { channels: [] } : parseChannels(value), etag };
}

export function saveChannels(file: ChannelFile, etag: string | null): Promise<void> {
  return writeJson(CHANNELS_PATH, file, etag);
}

const CLIENTS_PATH = 'clients.json';

export async function loadClients(): Promise<{ file: ClientsFile; etag: string | null }> {
  if (!storeConfigured()) return { file: { clients: [] }, etag: null };
  const { value, etag } = await readJson(CLIENTS_PATH);
  return { file: value === null ? { clients: [] } : parseClientsFile(value), etag };
}

export function saveClients(file: ClientsFile, etag: string | null): Promise<void> {
  return writeJson(CLIENTS_PATH, file, etag);
}

const MANUAL_PATH = 'manual.json';

export async function loadManual(): Promise<{ file: ManualFile; etag: string | null }> {
  if (!storeConfigured()) return { file: { posts: [] }, etag: null };
  const { value, etag } = await readJson(MANUAL_PATH);
  return { file: value === null ? { posts: [] } : parseManualFile(value), etag };
}

export function saveManual(file: ManualFile, etag: string | null): Promise<void> {
  return writeJson(MANUAL_PATH, file, etag);
}

export async function loadPosted(): Promise<{ log: PostedLog; etag: string | null }> {
  if (!storeConfigured()) return { log: {}, etag: null };
  const { value, etag } = await readJson(POSTED_PATH);
  return { log: value === null ? {} : parsePostedLog(value), etag };
}

export function savePosted(log: PostedLog, etag: string | null): Promise<void> {
  return writeJson(POSTED_PATH, log, etag);
}

const PAUSES_PATH = 'pauses.json';

export async function loadPauses(): Promise<{ file: PauseFile; etag: string | null }> {
  if (!storeConfigured()) return { file: NO_PAUSES, etag: null };
  const { value, etag } = await readJson(PAUSES_PATH);
  return { file: value === null ? NO_PAUSES : parsePauses(value), etag };
}

export function savePauses(file: PauseFile, etag: string | null): Promise<void> {
  return writeJson(PAUSES_PATH, file, etag);
}

const BRANDS_PATH = 'brands.json';

/** How many brands a customer may have (the default and each customer's own value), with the log of changes. */
export async function loadBrandSettings(): Promise<{ settings: BrandSettings; etag: string | null }> {
  if (!storeConfigured()) return { settings: NO_BRAND_SETTINGS, etag: null };
  const { value, etag } = await readJson(BRANDS_PATH);
  return { settings: value === null ? NO_BRAND_SETTINGS : parseBrandSettings(value), etag };
}

export function saveBrandSettings(settings: BrandSettings, etag: string | null): Promise<void> {
  return writeJson(BRANDS_PATH, settings, etag);
}

const EVENTS_PATH = 'events.json';

/** The events told to products, with their delivery state (lib/outbox.ts). */
export async function loadOutbox(): Promise<{ outbox: Outbox; etag: string | null }> {
  if (!storeConfigured()) return { outbox: EMPTY_OUTBOX, etag: null };
  const { value, etag } = await readJson(EVENTS_PATH);
  return { outbox: value === null ? EMPTY_OUTBOX : parseOutbox(value), etag };
}

export function saveOutbox(outbox: Outbox, etag: string | null): Promise<void> {
  return writeJson(EVENTS_PATH, outbox, etag);
}

const ALERTS_PATH = 'alerts.json';

/** The notices already sent (the missed-post notice), so each is sent once. */
export async function loadAlerts(): Promise<{ log: AlertLog; etag: string | null }> {
  if (!storeConfigured()) return { log: NO_ALERTS, etag: null };
  const { value, etag } = await readJson(ALERTS_PATH);
  return { log: value === null ? NO_ALERTS : parseAlertLog(value), etag };
}

export function saveAlerts(log: AlertLog, etag: string | null): Promise<void> {
  return writeJson(ALERTS_PATH, log, etag);
}

const ANALYTICS_PATH = 'analytics.json';

/** The numbers kept from the networks (lib/analytics.ts). */
export async function loadAnalytics(): Promise<{ file: AnalyticsFile; etag: string | null }> {
  if (!storeConfigured()) return { file: EMPTY_ANALYTICS, etag: null };
  const { value, etag } = await readJson(ANALYTICS_PATH);
  return { file: value === null ? EMPTY_ANALYTICS : parseAnalytics(value), etag };
}

export function saveAnalytics(file: AnalyticsFile, etag: string | null): Promise<void> {
  return writeJson(ANALYTICS_PATH, file, etag);
}

const INBOX_PATH = 'inbox.json';

/** The comments waiting to be answered (lib/inbox.ts). */
export async function loadInbox(): Promise<{ file: InboxFile; etag: string | null }> {
  if (!storeConfigured()) return { file: EMPTY_INBOX, etag: null };
  const { value, etag } = await readJson(INBOX_PATH);
  return { file: value === null ? EMPTY_INBOX : parseInbox(value), etag };
}

export function saveInbox(file: InboxFile, etag: string | null): Promise<void> {
  return writeJson(INBOX_PATH, file, etag);
}

const AUTODM_PATH = 'autodm.json';

export async function loadAutoDm(): Promise<{ file: AutoDmFile; etag: string | null }> {
  if (!storeConfigured()) return { file: { rules: [] }, etag: null };
  const { value, etag } = await readJson(AUTODM_PATH);
  return { file: value === null ? { rules: [] } : parseAutoDmFile(value), etag };
}

export function saveAutoDm(file: AutoDmFile, etag: string | null): Promise<void> {
  return writeJson(AUTODM_PATH, file, etag);
}

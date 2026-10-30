import { BlobPreconditionFailedError, del, get, put } from '@vercel/blob';
import { parseChannels, parsePostedLog, type ChannelFile, type PostedLog } from './channels.js';
import { EditError, isImageKey, parseOverrides, type OverrideMap } from './overrides.js';

/**
 * Where dashboard edits live: one private Vercel Blob store (token in BLOB_READ_WRITE_TOKEN, created
 * by `vercel blob create-store`). The edits file is a single JSON document; pictures are separate blobs.
 */
const OVERRIDES_PATH = 'overrides.json';
const imagePath = (key: string): string => `images/${key}.jpg`;

export function storeConfigured(): boolean {
  return Boolean(process.env['BLOB_READ_WRITE_TOKEN']);
}

export interface LoadedOverrides {
  overrides: OverrideMap;
  /** Version marker for a conditional write; null when nothing was saved yet. */
  etag: string | null;
}

/** Reads the saved edits. A store that is not configured or holds nothing yet means "no edits". */
export async function loadOverrides(): Promise<LoadedOverrides> {
  if (!storeConfigured()) return { overrides: {}, etag: null };
  const result = await get(OVERRIDES_PATH, { access: 'private', useCache: false });
  if (!result) return { overrides: {}, etag: null };
  if (result.statusCode !== 200) throw new Error(`unexpected status ${result.statusCode} reading ${OVERRIDES_PATH}`);
  const text = await new Response(result.stream).text();
  return { overrides: parseOverrides(JSON.parse(text)), etag: result.blob.etag };
}

/** Saves the edits, refusing to overwrite a version someone else saved since `etag` was read. */
export async function saveOverrides(overrides: OverrideMap, etag: string | null): Promise<void> {
  try {
    await put(OVERRIDES_PATH, JSON.stringify(overrides), {
      access: 'private',
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true,
      ...(etag ? { ifMatch: etag } : {}),
    });
  } catch (error) {
    if (error instanceof BlobPreconditionFailedError) {
      throw new EditError('Another change was saved at the same moment. Reload and try again.', 409);
    }
    throw error;
  }
}

export async function saveImage(key: string, bytes: Uint8Array): Promise<void> {
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
  const result = await get(imagePath(key), { access: 'private' });
  return result && result.statusCode === 200 ? result.stream : null;
}

export async function deleteImage(key: string): Promise<void> {
  await del(imagePath(key));
}

const CHANNELS_PATH = 'channels.json';
const POSTED_PATH = 'posted.json';

interface LoadedJson {
  value: unknown;
  etag: string | null;
}

async function readJson(path: string): Promise<LoadedJson> {
  const result = await get(path, { access: 'private', useCache: false });
  if (!result) return { value: null, etag: null };
  if (result.statusCode !== 200) throw new Error(`unexpected status ${result.statusCode} reading ${path}`);
  return { value: JSON.parse(await new Response(result.stream).text()), etag: result.blob.etag };
}

async function writeJson(path: string, value: unknown, etag: string | null): Promise<void> {
  try {
    await put(path, JSON.stringify(value), {
      access: 'private',
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true,
      ...(etag ? { ifMatch: etag } : {}),
    });
  } catch (error) {
    if (error instanceof BlobPreconditionFailedError) throw new EditError('Another change was saved at the same moment. Try again.', 409);
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

export async function loadPosted(): Promise<{ log: PostedLog; etag: string | null }> {
  if (!storeConfigured()) return { log: {}, etag: null };
  const { value, etag } = await readJson(POSTED_PATH);
  return { log: value === null ? {} : parsePostedLog(value), etag };
}

export function savePosted(log: PostedLog, etag: string | null): Promise<void> {
  return writeJson(POSTED_PATH, log, etag);
}

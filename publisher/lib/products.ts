import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * A product (such as Brandbasket) that uses social-auto through its API. Each has its own key, so one product can
 * never read or change another's clients. The key itself is never stored: only its SHA-256 hash is.
 */
export interface Product {
  /** Short lower-case name, e.g. "brandbasket". Part of every workspace id it creates. */
  id: string;
  keyHash: string;
  /** Where a person may be sent after connecting a channel. Exact addresses, https only (http only for localhost). */
  returnUrls: string[];
  /** Where we tell the product about posts and connections; its own https address. Optional. */
  webhookUrl?: string;
  /** Signs those messages, so the product knows they came from us. */
  webhookSecret?: string;
}

const PRODUCT_ID = /^[a-z][a-z0-9]{1,19}$/;
const HASH = /^[0-9a-f]{64}$/;

export const hashKey = (key: string): string => createHash('sha256').update(key).digest('hex');

function isAllowedAddress(value: unknown, allowLocalhost: boolean): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return true;
    return allowLocalhost && url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

/** Reads the PRODUCTS setting: a JSON list of products. A malformed entry is an error, never skipped. */
export function parseProducts(raw: string | undefined): Product[] {
  if (!raw) return [];
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    throw new Error('PRODUCTS is not valid JSON');
  }
  if (!Array.isArray(list)) throw new Error('PRODUCTS must be a list');
  const ids = new Set<string>();
  return list.map((p: Record<string, unknown>, i): Product => {
    if (typeof p['id'] !== 'string' || !PRODUCT_ID.test(p['id'])) throw new Error(`PRODUCTS[${i}].id must be 2-20 lower-case letters or digits`);
    if (ids.has(p['id'])) throw new Error(`PRODUCTS[${i}].id "${p['id']}" is used twice`);
    ids.add(p['id']);
    if (typeof p['keyHash'] !== 'string' || !HASH.test(p['keyHash'])) throw new Error(`PRODUCTS[${i}].keyHash must be a SHA-256 hash in hex`);
    const returnUrls = p['returnUrls'] ?? [];
    if (!Array.isArray(returnUrls) || !returnUrls.every((u) => isAllowedAddress(u, true))) throw new Error(`PRODUCTS[${i}].returnUrls must be https addresses`);
    const product: Product = { id: p['id'], keyHash: p['keyHash'], returnUrls: returnUrls as string[] };
    if (p['webhookUrl'] !== undefined) {
      if (!isAllowedAddress(p['webhookUrl'], true)) throw new Error(`PRODUCTS[${i}].webhookUrl must be an https address`);
      if (typeof p['webhookSecret'] !== 'string' || p['webhookSecret'].length < 16) throw new Error(`PRODUCTS[${i}].webhookSecret must be at least 16 characters when a webhookUrl is set`);
      product.webhookUrl = p['webhookUrl'];
      product.webhookSecret = p['webhookSecret'];
    }
    return product;
  });
}

/** The product a request belongs to, from its Bearer key, or null. Compares hashes, so timing reveals nothing. */
export function authenticateProduct(request: Request, products: readonly Product[]): Product | null {
  const header = request.headers.get('authorization') ?? '';
  if (!header.startsWith('Bearer ') || header.length > 200) return null;
  const given = Buffer.from(hashKey(header.slice('Bearer '.length)));
  let found: Product | null = null;
  for (const product of products) {
    // Every product is compared, so a request takes the same time whichever one it matches.
    if (timingSafeEqual(given, Buffer.from(product.keyHash))) found = product;
  }
  return found;
}

/** Whether a product may send people to this address after they connect a channel. */
export const isReturnUrl = (product: Product, address: string): boolean => product.returnUrls.includes(address);

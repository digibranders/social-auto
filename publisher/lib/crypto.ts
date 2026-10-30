import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** AES-256-GCM for secrets kept at rest (channel tokens). The key is 32 random bytes as 64 hex characters. */
const VERSION = 'v1';

export function parseKey(hex: string | undefined): Buffer {
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('CHANNEL_KEY must be 64 hex characters (32 random bytes)');
  return Buffer.from(hex, 'hex');
}

/** Encrypts text. Output is "v1.<iv>.<tag>.<ciphertext>", each part base64url. */
export function encrypt(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

/** Decrypts what encrypt() made. Throws if the key is wrong or the text was changed. */
export function decrypt(payload: string, key: Buffer): string {
  const [version, iv, tag, body] = payload.split('.');
  if (version !== VERSION || !iv || !tag || !body) throw new Error('unknown encrypted format');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
}

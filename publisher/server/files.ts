import { resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

export const contentTypeFor = (path: string): string => TYPES[path.slice(path.lastIndexOf('.')).toLowerCase()] ?? 'application/octet-stream';

/**
 * The file a public address maps to, or null. Only the poster pictures (/posts/...) and robots.txt are public; anything
 * else, anything that climbs out of the folder, and anything odd (encoded slashes, null bytes) is refused.
 */
export function publicFile(publicDir: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  if (decoded !== '/robots.txt' && !/^\/posts\/[A-Za-z0-9._/-]+\.(jpe?g|png)$/i.test(decoded)) return null;
  const root = resolve(publicDir);
  const path = resolve(root, `.${decoded}`);
  return path.startsWith(root + sep) ? path : null;
}

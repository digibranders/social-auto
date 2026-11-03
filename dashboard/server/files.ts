import { resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

export const contentTypeFor = (path: string): string => TYPES[path.slice(path.lastIndexOf('.')).toLowerCase()] ?? 'application/octet-stream';

/** The file for a page address, or null. "/" is the app, "/login" the sign-in page; dot-files and anything outside the folder are refused. */
export function staticFile(publicDir: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const page = decoded === '/' ? '/index.html' : decoded === '/login' ? '/login.html' : decoded;
  if (page.split('/').some((part) => part.startsWith('.'))) return null;
  const root = resolve(publicDir);
  const path = resolve(root, `.${page}`);
  return path.startsWith(root + sep) ? path : null;
}

/** The same protections the Vercel config added to every response. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Robots-Tag': 'noindex, nofollow, noarchive, noimageindex',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

/** Guide pictures and fonts rarely change; pages and scripts must always be checked again. */
export function cacheControlFor(pathname: string): string {
  if (pathname.startsWith('/help/')) return 'public, max-age=86400, stale-while-revalidate=604800';
  if (pathname.startsWith('/fonts/')) return 'public, max-age=31536000, immutable';
  return 'no-cache';
}

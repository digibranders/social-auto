/**
 * Connects your Google Business Profile for testing: opens Google's approval page, catches the redirect on
 * localhost, lists the business locations your account manages, and saves the refresh token and the chosen
 * location to a private file (the token is never printed).
 *
 *   node --import ./dev/resolver.ts scripts/connect-google.ts
 *   NO_OPEN=1 ...        prints the link instead of opening it (to use the browser that has the right login)
 *   LOCATION=<id> ...    picks a location when the account manages several (ids are shown on the first run)
 *
 * Needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in ../scheduler/upstream/.env, and
 * http://localhost:4060/callback listed as an Authorized redirect URI on the Google OAuth client.
 */
import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { accessTokenFor, authorizeUrl, exchangeCode, listLocations, type GoogleLocation } from '../lib/google.js';

const PORT = 4060;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const OUTPUT = new URL('../.google-token.json', import.meta.url);
const WAIT_MS = 5 * 60 * 1000;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set in scheduler/upstream/.env`);
  return value;
}

function sameState(a: string | null, b: string): boolean {
  const left = Buffer.from(a ?? '');
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function main(): Promise<void> {
  process.loadEnvFile(new URL('../../scheduler/upstream/.env', import.meta.url));
  const app = { clientId: required('GOOGLE_CLIENT_ID'), clientSecret: required('GOOGLE_CLIENT_SECRET') };
  const state = randomBytes(16).toString('hex');
  const link = authorizeUrl({ clientId: app.clientId, redirectUri: REDIRECT_URI, state });

  const refreshToken = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for the Google approval (5 minutes).')), WAIT_MS);
    const server = createServer(async (req, res) => {
      const callback = new URL(req.url ?? '/', REDIRECT_URI);
      if (callback.pathname !== '/callback') return void ((res.statusCode = 404), res.end());
      const reply = (status: number, message: string): void => {
        res.statusCode = status;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end(message);
      };
      try {
        if (callback.searchParams.get('error')) throw new Error(`Google said: ${callback.searchParams.get('error')}`);
        if (!sameState(callback.searchParams.get('state'), state)) throw new Error('The approval did not come from this script (state mismatch).');
        const code = callback.searchParams.get('code');
        if (!code) throw new Error('Google sent no code.');
        const tokens = await exchangeCode(app, REDIRECT_URI, code);
        reply(200, 'Approved. You can close this tab and go back to the terminal.');
        resolve(tokens.refreshToken);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reply(400, message);
        reject(new Error(message));
      } finally {
        clearTimeout(timer);
        server.close();
      }
    });
    server.listen(PORT, '127.0.0.1', () => {
      console.log('Opening Google to approve the app. If nothing opens, paste this address into the browser:\n');
      console.log(`${link}\n`);
      if (!process.env['NO_OPEN']) execFile('open', [link], () => undefined);
    });
    server.on('error', reject);
  });

  const places = await listLocations(await accessTokenFor(app, refreshToken));
  if (places.length === 0) throw new Error('Approved, but this Google account manages no business locations. Check People and access on the listing.');
  const wanted = process.env['LOCATION'];
  const chosen: GoogleLocation | undefined = wanted ? places.find((p) => p.location.endsWith(`/${wanted}`)) : places.length === 1 ? places[0] : undefined;
  if (!chosen) {
    console.log('This account manages several locations. Run again with LOCATION=<id> to pick one:');
    for (const p of places) console.log(`  ${p.location.split('/').pop()}  ${p.title}`);
    throw new Error(wanted ? `No location with id ${wanted}.` : 'Pick a location.');
  }
  await writeFile(OUTPUT, `${JSON.stringify({ refreshToken, account: chosen.account, location: chosen.location, title: chosen.title, savedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  await chmod(OUTPUT, 0o600);
  console.log(`Saved the connection for "${chosen.title}" to publisher/.google-token.json (private, not in git).`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exitCode = 1;
});

/**
 * Connects one Facebook Page for testing: opens Facebook's approval page, catches the redirect on
 * localhost, and saves the Page's token to a private file (never printed).
 *
 *   node --import ./dev/resolver.ts scripts/connect-facebook.ts [--page "Page name"]
 *
 * Needs FACEBOOK_APP_ID and FACEBOOK_APP_SECRET in ../scheduler/upstream/.env, and
 * http://localhost:4020/callback listed as a valid redirect address in the Meta app.
 */
import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import { authorizeUrl, exchangeCode, listPages, longLivedUserToken } from '../lib/facebook.js';

const PORT = 4020;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const OUTPUT = new URL('../.facebook-page.json', import.meta.url);
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
  const { values } = parseArgs({ options: { page: { type: 'string' } } });
  process.loadEnvFile(new URL('../../scheduler/upstream/.env', import.meta.url));
  const app = { appId: required('FACEBOOK_APP_ID'), appSecret: required('FACEBOOK_APP_SECRET') };
  const state = randomBytes(16).toString('hex');
  const url = authorizeUrl({
    appId: app.appId,
    redirectUri: REDIRECT_URI,
    state,
    ...(process.env['FACEBOOK_CONFIG_ID'] ? { configId: process.env['FACEBOOK_CONFIG_ID'] } : {}),
  });

  const result = await new Promise<{ id: string; name: string; token: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for the Facebook approval (5 minutes).')), WAIT_MS);
    const server = createServer(async (req, res) => {
      const callback = new URL(req.url ?? '/', REDIRECT_URI);
      if (callback.pathname !== '/callback') return void ((res.statusCode = 404), res.end());
      const reply = (status: number, message: string): void => {
        res.statusCode = status;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end(message);
      };
      try {
        if (callback.searchParams.get('error')) {
          throw new Error(`Facebook said: ${callback.searchParams.get('error_description') ?? callback.searchParams.get('error')}`);
        }
        if (!sameState(callback.searchParams.get('state'), state)) throw new Error('The approval did not come from this script (state mismatch).');
        const code = callback.searchParams.get('code');
        if (!code) throw new Error('Facebook sent no code.');

        const userToken = await longLivedUserToken(app, await exchangeCode(app, REDIRECT_URI, code));
        const pages = await listPages(userToken);
        if (pages.length === 0) {
          throw new Error('No Pages came back. Approve the Page in the Facebook dialog, and check you manage the Page.');
        }
        const wanted = values.page?.toLowerCase();
        const chosen = wanted ? pages.find((p) => p.name.toLowerCase() === wanted) : pages.length === 1 ? pages[0] : undefined;
        if (!chosen) throw new Error(`Pick one with --page "<name>". Pages found: ${pages.map((p) => p.name).join(', ')}`);
        reply(200, `Connected "${chosen.name}". You can close this tab and go back to the terminal.`);
        resolve({ id: chosen.id, name: chosen.name, token: chosen.accessToken });
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
      console.log('Opening Facebook to approve the app. If nothing opens, paste this address into the browser:\n');
      console.log(`${url}\n`);
      execFile('open', [url], () => undefined);
    });
    server.on('error', reject);
  });

  await writeFile(OUTPUT, `${JSON.stringify({ pageId: result.id, pageName: result.name, pageToken: result.token, savedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  await chmod(OUTPUT, 0o600);
  console.log(`Saved the token for "${result.name}" (Page ${result.id}) to publisher/.facebook-page.json (private, not in git).`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exitCode = 1;
});

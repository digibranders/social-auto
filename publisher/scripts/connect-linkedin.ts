/**
 * Connects your LinkedIn profile for testing: opens LinkedIn's approval page, catches the redirect on
 * localhost, and saves the access token to a private file (never printed).
 *
 *   node --import ./dev/resolver.ts scripts/connect-linkedin.ts
 *   NO_OPEN=1 ...   prints the link instead of opening it (to use the browser that has the right login)
 *
 * Needs LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET in ../scheduler/upstream/.env, and
 * http://localhost:4030/callback listed under Authorized redirect URLs in the LinkedIn app.
 */
import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { authorizeUrl, exchangeCode, memberOf } from '../lib/linkedin.js';

const PORT = 4030;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const OUTPUT = new URL('../.linkedin-token.json', import.meta.url);
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
  const app = { clientId: required('LINKEDIN_CLIENT_ID'), clientSecret: required('LINKEDIN_CLIENT_SECRET') };
  const state = randomBytes(16).toString('hex');
  const link = authorizeUrl({ clientId: app.clientId, redirectUri: REDIRECT_URI, state });

  const saved = await new Promise<{ token: string; expiresIn: number; urn: string; name: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for the LinkedIn approval (5 minutes).')), WAIT_MS);
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
          throw new Error(`LinkedIn said: ${callback.searchParams.get('error_description') ?? callback.searchParams.get('error')}`);
        }
        if (!sameState(callback.searchParams.get('state'), state)) throw new Error('The approval did not come from this script (state mismatch).');
        const code = callback.searchParams.get('code');
        if (!code) throw new Error('LinkedIn sent no code.');
        const token = await exchangeCode(app, REDIRECT_URI, code);
        const member = await memberOf(token.accessToken);
        reply(200, `Connected as ${member.name}. You can close this tab and go back to the terminal.`);
        resolve({ token: token.accessToken, expiresIn: token.expiresInSeconds, urn: member.urn, name: member.name });
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
      console.log('Opening LinkedIn to approve the app. If nothing opens, paste this address into the browser:\n');
      console.log(`${link}\n`);
      if (!process.env['NO_OPEN']) execFile('open', [link], () => undefined);
    });
    server.on('error', reject);
  });

  const expiresAt = new Date(Date.now() + saved.expiresIn * 1000).toISOString();
  await writeFile(OUTPUT, `${JSON.stringify({ accessToken: saved.token, memberUrn: saved.urn, memberName: saved.name, expiresAt, savedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  await chmod(OUTPUT, 0o600);
  console.log(`Saved the token for ${saved.name} to publisher/.linkedin-token.json (private, not in git). It expires ${expiresAt.slice(0, 10)}.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exitCode = 1;
});

/**
 * Connects Google business locations to a client. Called only by the dashboard's server (EDIT_SECRET). Google's
 * refresh token is encrypted before it is stored and is never returned.
 *
 * POST /api/google-connect?action=exchange   {"code","redirectUri","brand"}
 *   One location is found: it is saved at once ({"status":"saved"}). Several: nothing is saved yet; the answer
 *   carries a sealed, short-lived token ({"status":"pick","sealed":"..."}) for the choice that follows.
 * POST /api/google-connect?action=locations  {"sealed","brand"}              the locations to choose from
 * POST /api/google-connect?action=save       {"sealed","brand","location"}   saves the chosen one
 */
import { scheduleData } from '../../lib/schedule-source.js';
import { addGoogleLocation } from '../../lib/channels.js';
import { allBrands } from '../../lib/clients.js';
import { parseKey } from '../../lib/crypto.js';
import { accessTokenFor, exchangeCode, GoogleApiError, listLocations, type GoogleLocation } from '../../lib/google.js';
import { openPending, sealPending } from '../../lib/google-pending.js';
import { describeError, isAuthorized, json, requireEnv } from '../../lib/http.js';
import { parseSchedule } from '../../lib/schedule.js';
import { loadChannels, loadClients, saveChannels, storeConfigured } from '../../lib/store.js';

const MAX_BODY_BYTES = 8 * 1024;

const plannedBrands = (): string[] => parseSchedule(scheduleData).map((p) => p.brand ?? 'default');
const idOf = (place: GoogleLocation): string => place.location.split('/').pop() as string;
const choices = (places: GoogleLocation[]): Array<{ id: string; title: string }> => places.map((p) => ({ id: idOf(p), title: p.title }));

async function save(brand: string, place: GoogleLocation, refreshToken: string, key: Buffer): Promise<void> {
  const { file, etag } = await loadChannels();
  await saveChannels(addGoogleLocation(file, brand, place, refreshToken, key, Date.now()), etag);
}

export async function POST(request: Request): Promise<Response> {
  if (!isAuthorized(request, process.env['EDIT_SECRET'])) return json(401, { error: 'unauthorized' });
  if (!storeConfigured()) return json(503, { error: 'storage is not set up' });
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return json(413, { error: 'request too large' });

  const action = new URL(request.url).searchParams.get('action');
  const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const { brand } = body;
  if (typeof brand !== 'string' || !brand) return json(400, { error: 'brand is required' });
  if (!allBrands(plannedBrands(), (await loadClients()).file).has(brand)) return json(400, { error: `unknown client "${brand}"` });

  try {
    const key = parseKey(process.env['CHANNEL_KEY']);
    const app = { clientId: requireEnv('GOOGLE_CLIENT_ID'), clientSecret: requireEnv('GOOGLE_CLIENT_SECRET') };

    if (action === 'exchange') {
      const { code, redirectUri } = body;
      if (typeof code !== 'string' || typeof redirectUri !== 'string' || !code || !redirectUri) return json(400, { error: 'code and redirectUri are required' });
      const tokens = await exchangeCode(app, redirectUri, code);
      const places = await listLocations(tokens.accessToken);
      if (places.length === 0) {
        return json(422, { error: 'No business locations were found. The Google account must be a manager of the client’s listing.' });
      }
      if (places.length === 1) {
        await save(brand, places[0] as GoogleLocation, tokens.refreshToken, key);
        return json(200, { status: 'saved', locations: choices(places) });
      }
      return json(200, { status: 'pick', sealed: sealPending(tokens.refreshToken, brand, key, Date.now()) });
    }

    if (action === 'locations' || action === 'save') {
      const { sealed } = body;
      if (typeof sealed !== 'string' || !sealed) return json(400, { error: 'sealed is required' });
      let refreshToken: string;
      try {
        refreshToken = openPending(sealed, brand, key, Date.now());
      } catch (error) {
        return json(410, { error: error instanceof Error ? error.message : 'the waiting connection is not valid' });
      }
      const places = await listLocations(await accessTokenFor(app, refreshToken));
      if (action === 'locations') return json(200, { locations: choices(places) });

      const chosen = places.find((p) => idOf(p) === body['location']);
      if (!chosen) return json(400, { error: 'that location is not available to this Google account' });
      await save(brand, chosen, refreshToken, key);
      return json(200, { status: 'saved', locations: choices([chosen]) });
    }
    return json(400, { error: 'unknown action' });
  } catch (error) {
    console.error(describeError(error));
    if (error instanceof GoogleApiError) return json(502, { error: 'Google did not accept the approval. Try connecting again.' });
    return json(500, { error: 'could not save the connection' });
  }
}

/**
 * Meta Instagram Webhook endpoint.
 *
 * GET  /api/webhooks/instagram  Verifies hub.verify_token against INSTAGRAM_WEBHOOK_VERIFY_TOKEN and echoes hub.challenge.
 * POST /api/webhooks/instagram  Verifies X-Hub-Signature-256 (INSTAGRAM_APP_SECRET), handles comment triggers (direct DM
 *                               or 2-step follow-gate prompt), and handles messaging postbacks (verifies is_user_follow_business).
 */
import { timingSafeEqual } from 'node:crypto';
import {
  AUTODM_PAYLOAD_PREFIX,
  matchAutoDmRule,
  parseInstagramCommentEvents,
  parseInstagramPostbackEvents,
  parseInstagramTextDmEvents,
  ruleIdFromPayload,
  verifyMetaSignature,
} from '../../lib/autodm.js';
import type { InstagramChannel } from '../../lib/channels.js';
import { decrypt, parseKey } from '../../lib/crypto.js';
import { describeError, json } from '../../lib/http.js';
import { isUserFollowing, sendDirectMessage, sendFollowGatePrompt, sendPrivateReply } from '../../lib/instagram.js';
import { loadAutoDm, loadChannels, storeConfigured } from '../../lib/store.js';

const MAX_WEBHOOK_BYTES = 128 * 1024;
const FOLLOW_PROMPT_TEXT = "Hey! Tap 'Get the Link' below (or reply YES) to get your link 👇";
const FOLLOW_RETRY_TEXT = "Looks like you aren’t following yet! Follow our page and tap 'I've Followed' (or reply YES) to try again.";

function matchesVerifyToken(provided: string | null, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  if (mode === 'subscribe' && challenge !== null && matchesVerifyToken(token, process.env['INSTAGRAM_WEBHOOK_VERIFY_TOKEN'])) {
    return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  return json(403, { error: 'verification failed' });
}

export async function POST(request: Request): Promise<Response> {
  const secrets = [process.env['INSTAGRAM_APP_SECRET'], process.env['FACEBOOK_APP_SECRET']].filter(
    (s): s is string => typeof s === 'string' && s.trim().length > 0,
  );
  if (secrets.length === 0) return json(503, { error: 'INSTAGRAM_APP_SECRET is not set' });

  if (Number(request.headers.get('content-length') ?? 0) > MAX_WEBHOOK_BYTES) return json(413, { error: 'payload too large' });
  const rawBody = new Uint8Array(await request.arrayBuffer());
  if (rawBody.length > MAX_WEBHOOK_BYTES) return json(413, { error: 'payload too large' });

  const signature = request.headers.get('x-hub-signature-256');
  if (!secrets.some((secret) => verifyMetaSignature(rawBody, signature, secret))) {
    return json(401, { error: 'invalid signature' });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(rawBody).toString('utf8'));
  } catch {
    return json(400, { error: 'invalid json' });
  }

  const commentEvents = parseInstagramCommentEvents(payload);
  const postbackEvents = parseInstagramPostbackEvents(payload);
  const textDmEvents = parseInstagramTextDmEvents(payload);
  if ((commentEvents.length === 0 && postbackEvents.length === 0 && textDmEvents.length === 0) || !storeConfigured()) {
    return json(200, { ok: true, processed: 0 });
  }

  let key: Buffer;
  try {
    key = parseKey(process.env['CHANNEL_KEY']);
  } catch (error) {
    console.error(describeError(error));
    return json(200, { ok: true, processed: 0 });
  }

  const [{ file: channelsFile }, { file: autoDmFile }] = await Promise.all([loadChannels(), loadAutoDm()]);
  const igByAccountId = new Map<string, InstagramChannel>();
  for (const channel of channelsFile.channels) {
    if (channel.platform === 'instagram') igByAccountId.set(channel.userId, channel);
  }

  let sent = 0;

  for (const event of commentEvents) {
    if (event.fromId && event.fromId === event.accountId) {
      console.log(`Auto-DM skip: self-comment on ${event.accountId}`);
      continue;
    }
    const channel = igByAccountId.get(event.accountId);
    if (!channel) {
      console.log(`Auto-DM skip: no IG channel for accountId=${event.accountId} (known: ${[...igByAccountId.keys()].join(',')})`);
      continue;
    }
    const rule = matchAutoDmRule(autoDmFile.rules, channel.brand, event.text, event.mediaId);
    if (!rule) {
      console.log(`Auto-DM skip: no rule for brand=${channel.brand} mediaId=${event.mediaId ?? ''} text=${JSON.stringify(event.text.slice(0, 40))}`);
      continue;
    }
    try {
      const token = decrypt(channel.token, key);
      if (rule.requireFollow) {
        await sendFollowGatePrompt(
          channel.userId,
          token,
          { comment_id: event.commentId },
          FOLLOW_PROMPT_TEXT,
          'Get the Link',
          `${AUTODM_PAYLOAD_PREFIX}${rule.id}`,
        );
      } else {
        await sendPrivateReply(channel.userId, token, event.commentId, rule.message);
      }
      sent++;
      console.log(`Auto-DM sent (${rule.requireFollow ? 'follow-gate' : 'direct'}) for ${channel.brand} comment=${event.commentId}`);
    } catch (error) {
      console.error(`Auto-DM comment reply failed for ${channel.brand} (${event.commentId}): ${describeError(error)}`);
    }
  }

  for (const event of postbackEvents) {
    const channel = igByAccountId.get(event.accountId);
    if (!channel) continue;
    const ruleId = ruleIdFromPayload(event.payload);
    if (!ruleId) continue;
    const rule = autoDmFile.rules.find((r) => r.id === ruleId && r.brand === channel.brand && r.enabled);
    if (!rule) continue;
    try {
      const token = decrypt(channel.token, key);
      const following = await isUserFollowing(event.senderId, token);
      if (following) {
        await sendDirectMessage(channel.userId, token, event.senderId, rule.message);
      } else {
        await sendFollowGatePrompt(
          channel.userId,
          token,
          { id: event.senderId },
          FOLLOW_RETRY_TEXT,
          "I've Followed ✅",
          `${AUTODM_PAYLOAD_PREFIX}${rule.id}`,
        );
      }
      sent++;
    } catch (error) {
      console.error(`Auto-DM postback failed for ${channel.brand} (${event.senderId}): ${describeError(error)}`);
    }
  }

  for (const event of textDmEvents) {
    const channel = igByAccountId.get(event.accountId);
    if (!channel) continue;
    // Match either a direct DM keyword rule or, if they replied to a follow-gate prompt, the brand's enabled follow-gated rule.
    const rule =
      matchAutoDmRule(autoDmFile.rules, channel.brand, event.text, null) ??
      autoDmFile.rules.find((r) => r.brand === channel.brand && r.enabled && r.requireFollow);
    if (!rule) continue;
    try {
      const token = decrypt(channel.token, key);
      if (rule.requireFollow) {
        const following = await isUserFollowing(event.senderId, token);
        if (following) {
          await sendDirectMessage(channel.userId, token, event.senderId, rule.message);
        } else {
          await sendFollowGatePrompt(
            channel.userId,
            token,
            { id: event.senderId },
            FOLLOW_RETRY_TEXT,
            "I've Followed",
            `${AUTODM_PAYLOAD_PREFIX}${rule.id}`,
          );
        }
      } else {
        await sendDirectMessage(channel.userId, token, event.senderId, rule.message);
      }
      sent++;
      console.log(`Auto-DM text-DM reply handled for ${channel.brand} sender=${event.senderId}`);
    } catch (error) {
      console.error(`Auto-DM text-DM failed for ${channel.brand} (${event.senderId}): ${describeError(error)}`);
    }
  }

  return json(200, { ok: true, processed: commentEvents.length + postbackEvents.length + textDmEvents.length, sent });
}

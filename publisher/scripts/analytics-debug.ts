/**
 * Shows what a network answers for one post's numbers, for working out why a number is missing. Read only. It prints the answer's field names, the numbers it
 * holds and any error the network gave, and never a token.
 *
 *   cd publisher && set -a && . /etc/social-auto/publisher.env && set +a && LOCAL_STORE_DIR=/var/lib/social-auto node --import ./dev/resolver.ts scripts/analytics-debug.ts "<post id>|<channel id>"
 *   (the channel id of the team's own Instagram account is just "instagram")
 */
import { channelToken } from '../lib/channels.ts';
import { parseKey } from '../lib/crypto.ts';
import { loadChannels, loadPosted } from '../lib/store.ts';

const logKey = process.argv[2];
if (!logKey) throw new Error('give the post as "<post id>|<channel id>"');
const channelId = logKey.slice(logKey.lastIndexOf('|') + 1);
const { log } = await loadPosted();
const entry = log[logKey];
if (!entry) throw new Error(`no such post in the posted log: ${logKey}`);
const { file } = await loadChannels();
const channel = file.channels.find((c) => c.id === channelId);
const token = channelId === 'instagram' ? process.env['INSTAGRAM_TOKEN'] : channel ? channelToken(channel, parseKey(process.env['CHANNEL_KEY'])) : undefined;
if (!token) throw new Error(`no token for ${channelId}: is the channel connected, and are INSTAGRAM_TOKEN or CHANNEL_KEY set?`);
const remoteId = entry.remoteId;
const instagram = channelId.startsWith('instagram');
const base = instagram ? `${process.env['INSTAGRAM_GRAPH_URL'] ?? 'https://graph.instagram.com'}/v23.0` : (process.env['FACEBOOK_GRAPH_URL'] ?? 'https://graph.facebook.com/v23.0');
const fields = instagram ? 'caption,permalink,like_count,comments_count' : 'message,permalink_url,shares,reactions.summary(true).limit(0),comments.summary(true).limit(0)';

async function show(label: string, path: string): Promise<void> {
  const response = await fetch(`${base}/${remoteId}${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token as string)}`, { signal: AbortSignal.timeout(30_000) });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const text = JSON.stringify(body, (k, v) => (k === 'message' || k === 'caption' || k === 'text' ? '<words>' : v));
  console.log(`${label}: HTTP ${response.status}; ${text.slice(0, 700)}`);
}

console.log(`post ${logKey}: remote id ${entry.remoteId}, posted ${entry.postedAt}`);
await show('numbers', `?fields=${encodeURIComponent(fields)}`);
await show('insights', instagram ? '/insights?metric=reach,views,shares,saved' : '/insights?metric=post_total_media_view_unique,post_media_view');

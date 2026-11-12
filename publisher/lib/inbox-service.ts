/**
 * What the inbox does with the store and the networks: the regular check, the list for one brand, and what a person does with a message. Written so the
 * staff pages and, later, the product API call the same code.
 */
import { channelLabel, channelToken, type Channel } from './channels.js';
import { parseKey } from './crypto.js';
import { act, markChannel, validReply, viewInbox, type InboxAction, type InboxQuery, type InboxView } from './inbox.js';
import { collectInbox, type InboxCollectReport, type InboxReaders } from './inbox-collect.js';
import { facebookComments, facebookReply, InboxWriteError, instagramComments, instagramReply } from './inbox-fetch.js';
import { TEAM_INSTAGRAM_ID } from './analytics-collect.js';
import { toScheduled } from './manual.js';
import { EditError } from './overrides.js';
import { parseSchedule } from './schedule.js';
import { scheduleData } from './schedule-source.js';
import { teamInstagram } from './team-instagram.js';
import { loadChannels, loadInbox, loadManual, loadPosted, saveInbox } from './store.js';

/** On by default; INBOX_ENABLED=false switches the check and the pages off. */
export const inboxEnabled = (): boolean => process.env['INBOX_ENABLED'] !== 'false';

const realReaders: InboxReaders = {
  instagramComments: (id, token) => instagramComments(id, token),
  facebookComments: (id, page, token) => facebookComments(id, page, token),
};

/** The first line of each post's words by post id, so a comment can say which post it is on. */
async function titles(): Promise<(postId: string) => string> {
  const { file: manual } = await loadManual();
  const map = new Map<string, string>();
  for (const p of [...parseSchedule(scheduleData), ...manual.posts.map(toScheduled)]) map.set(p.id, (p.caption.split('\n').find((l) => l.trim()) ?? '').slice(0, 100));
  return (postId) => map.get(postId) ?? '';
}

/** The regular check. Returns what it found, never the words people wrote. */
export async function runInboxCheck(now: number, readers: InboxReaders = realReaders): Promise<InboxCollectReport> {
  const key = parseKey(process.env['CHANNEL_KEY']);
  const [{ file: channels }, { log }, { file, etag }, titleOf, team] = await Promise.all([loadChannels(), loadPosted(), loadInbox(), titles(), teamInstagram()]);
  const result = await collectInbox({ file, channels: channels.channels, posted: log, key, readers, now, team, titleOf: (id, at) => titleOf(id) || `Post of ${at.slice(0, 10)}` });
  await saveInbox(result.file, etag);
  return result.report;
}

const commentChannels = (channels: readonly Channel[], brand: string) => channels.filter((c) => c.brand === brand && (c.platform === 'instagram' || c.platform === 'facebook')).map((c) => ({ id: c.id, platform: c.platform, label: channelLabel(c) }));

/** One brand's messages and the state of its accounts. */
export async function listInbox(query: InboxQuery): Promise<InboxView & { enabled: boolean }> {
  const [{ file }, { file: channels }] = await Promise.all([loadInbox(), loadChannels()]);
  const own = commentChannels(channels.channels, query.brand);
  // The team's own Instagram account is not a connected channel; it shows for a client that has messages from it and no Instagram account of its own.
  const hasTeam = Object.values(file.items).some((i) => i.channel === TEAM_INSTAGRAM_ID && i.brand === query.brand);
  const connected = hasTeam && !own.some((c) => c.platform === 'instagram') ? [...own, { id: TEAM_INSTAGRAM_ID, platform: 'instagram' as const, label: 'Instagram' }] : own;
  return { enabled: inboxEnabled(), ...viewInbox(file, query, connected) };
}

export type InboxCommand = (Exclude<InboxAction, { action: 'note' } | { action: 'replied' }> | { action: 'note'; text: string } | { action: 'reply'; text: string }) & { id: string };

export interface InboxWriters {
  instagramReply(commentId: string, token: string, message: string): Promise<string | null>;
  facebookReply(commentId: string, token: string, message: string): Promise<string | null>;
}
const realWriters: InboxWriters = { instagramReply: (c, t, m) => instagramReply(c, t, m), facebookReply: (c, t, m) => facebookReply(c, t, m) };

/** What a person does with a message. `by` is who did it. A reply is posted to the network first and only then recorded, so a failed post leaves the message as it was. */
export async function doInbox(command: InboxCommand, by: string, now: number, writers: InboxWriters = realWriters): Promise<void> {
  const { file, etag } = await loadInbox();
  const item = file.items[command.id];
  if (!item) throw new EditError('no such message', 404);
  if (command.action === 'reply') {
    const text = validReply(command.text);
    const { file: channels } = await loadChannels();
    const channel = channels.channels.find((c) => c.id === item.channel);
    const teamToken = item.channel === TEAM_INSTAGRAM_ID ? process.env['INSTAGRAM_TOKEN'] : undefined;
    if (!channel && !teamToken) throw new EditError('that account is no longer connected', 409);
    const token = teamToken ?? channelToken(channel as Channel, parseKey(process.env['CHANNEL_KEY']));
    const onInstagram = teamToken !== undefined || channel?.platform === 'instagram';
    let remoteId: string | null;
    try {
      remoteId = onInstagram ? await writers.instagramReply(item.remoteId, token, text) : await writers.facebookReply(item.remoteId, token, text);
    } catch (error) {
      if (error instanceof InboxWriteError && error.kind === 'permission') {
        await saveInbox(markChannel(file, item.channel, 'reconnect', now), etag).catch(() => undefined);
        throw new EditError('This account has not given permission to reply. Connect it again from the Channels tab, then try again.', 409);
      }
      throw new EditError(error instanceof Error ? error.message : 'the reply could not be posted', 502);
    }
    await saveInbox(act(file, command.id, { action: 'replied', by, text, remoteId }, now), etag);
    return;
  }
  const action: InboxAction = command.action === 'note' ? { action: 'note', by, text: command.text } : command;
  await saveInbox(act(file, command.id, action, now), etag);
}

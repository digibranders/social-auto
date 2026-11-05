/** The Clients screens: a folder per client, and inside each its channels and what is coming up. */
import type { ChannelHealth, Platform, StatusPost } from '../shared/status.ts';
import { planSentence } from '../shared/posting-plan.ts';
import { websiteHost, type ClientSummary } from './clients.ts';
import { costPage } from './cost-page.ts';
import { clientOption, dropdown } from './dropdown.ts';
import { postChannelId } from './new-post.ts';
import { stateLabel } from './calendar.ts';
import type { ClientTab, GuideKey, Route } from './route.ts';
import { brandMark, button, channelName, h, icon, statusMark, type ChannelKind } from './ui.ts';

export interface ClientsContext {
  go(route: Route): void;
  openCalendar(brand: string): void;
  /** One upcoming post as a card; opens its window when clicked. */
  postCard(post: StatusPost): HTMLElement;
  /** A post's picture as a small thumbnail. */
  postThumb(post: StatusPost): HTMLElement;
  addChannel(brand: string | null): void;
  /** Opens the New post window; `channel` (a post channel id) is ticked in advance. */
  newPost(brand: string | null, channel: string | null): void;
  addClient(): void;
  removeClient(client: ClientSummary): void;
  /** Saves (or, when empty, clears) the website; resolves to an explanation when it could not be saved. */
  saveWebsite(client: ClientSummary, website: string): Promise<string | null>;
  disconnect(channel: ChannelHealth): void;
  /** Whether everything is paused. */
  allPaused(): boolean;
  /** Pauses or resumes everything, one client or one channel (its id; "instagram" for the team's own account). */
  setPause(scope: 'all' | 'brand' | 'channel', id: string | null, paused: boolean): void;
}

/** The id a channel is paused by: its own, or "instagram" for the team's own Instagram account. */
export const pauseIdOf = (channel: ChannelHealth): string | null => channel.id ?? (channel.platform === 'instagram' ? 'instagram' : null);

const KINDS: readonly ChannelKind[] = ['facebook', 'instagram', 'google', 'linkedin'];
const GUIDE_FOR: Record<ChannelKind, GuideKey> = { facebook: 'facebook', instagram: 'instagram', google: 'google', linkedin: 'linkedin' };
const UPCOMING_SHOWN = 14;
const TAB_LABELS: Record<ClientTab, string> = { channels: 'Channels', posts: 'Next posts', cost: 'Cost' };

export function clientsPage(clients: ClientSummary[], ctx: ClientsContext): HTMLElement {
  const paused = ctx.allPaused();
  const add = h(
    'div',
    { class: 'page-actions' },
    button([icon('plus'), 'Add client'], 'btn btn-primary', () => ctx.addClient()),
    button(paused ? 'Resume everything' : 'Pause everything', paused ? 'btn' : 'btn btn-quiet btn-danger', () => ctx.setPause('all', null, !paused)),
  );
  if (clients.length === 0) return h('div', {}, add, h('p', { class: 'empty' }, 'No clients yet.'));
  return h('div', {}, add, h(
    'div',
    { class: 'folders' },
    ...clients.map((client) => {
      const card = h(
        'button',
        { type: 'button', class: 'folder', 'aria-label': `Open ${client.label}` },
        h('span', { class: 'folder-tab', 'aria-hidden': 'true' }),
        h('div', { class: 'folder-head' }, h('h3', {}, client.label), client.paused ? h('span', { class: 'tag-paused' }, 'Paused') : null),
        h('div', { class: 'folder-marks' }, ...client.channels.map((c) => h('span', { class: 'mark', title: channelName(c.platform) }, brandMark(c.platform)))),
        h('div', { class: 'folder-stats muted' }, h('span', {}, client.pattern ?? 'Nothing booked'), h('span', {}, `${client.postsLeft} days booked`)),
      );
      card.addEventListener('click', () => ctx.go({ page: 'client', brand: client.brand, tab: 'channels' }));
      return card;
    }),
  ));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** "Ends in 12 days" for a connection with an end date (LinkedIn cuts it after about 60 days). */
export function expiryNote(expiresAt: string | undefined, now: number): string | null {
  if (!expiresAt) return null;
  const days = Math.floor((Date.parse(expiresAt) - now) / DAY_MS);
  if (days < 0) return 'The connection has ended. Send the client a new link.';
  if (days === 0) return 'The connection ends today. Send the client a new link.';
  return `Connection ends in ${days} day${days === 1 ? '' : 's'}${days <= 7 ? '. Send the client a new link.' : '.'}`;
}

/**
 * Makes a link to connect LinkedIn, Instagram, Facebook or a Google Business listing: a client opens it and presses Allow on their own account, or you
 * open it in the browser where the right account is signed in.
 * Asking is one click; copying is a second, so the browser allows it.
 */
export function inviteLinkBox(brand: string, label: string, platform: 'linkedin' | 'instagram' | 'facebook' | 'google' = 'linkedin'): HTMLElement {
  const box = h('div', { class: 'link-box' });
  const result = h('div', { class: 'link-result', hidden: '' });
  const message = h('p', { class: 'muted', hidden: '' });
  const make = button(label, 'btn', () => {
    make.disabled = true;
    message.hidden = true;
    void (async () => {
      try {
        const response = await fetch(`/api/linkedin-invite?brand=${encodeURIComponent(brand)}${platform === 'linkedin' ? '' : `&channel=${platform}`}`, { method: 'POST', credentials: 'same-origin' });
        if (response.status === 401) return void location.replace('/login');
        const body = (await response.json().catch(() => null)) as { link?: unknown; expiresInDays?: unknown; error?: unknown } | null;
        if (!response.ok || typeof body?.link !== 'string') throw new Error(typeof body?.error === 'string' ? body.error : `Could not make a link (${response.status}).`);
        const field = h('input', { class: 'link-field', type: 'text', readonly: '', value: body.link, 'aria-label': 'Link for the client' });
        const copy = button('Copy', 'btn btn-primary', () => {
          field.select();
          void navigator.clipboard.writeText(body.link as string).then(
            () => { copy.textContent = 'Copied'; },
            () => { copy.textContent = 'Press Ctrl+C to copy'; },
          );
        });
        result.replaceChildren(field, copy, h('p', { class: 'muted' }, `Send this to the client. It works for ${String(body.expiresInDays ?? 7)} days and only lets them connect their ${{ linkedin: 'LinkedIn', instagram: 'Instagram', facebook: 'Facebook', google: 'Google Business listing' }[platform]} for this client.`));
        result.hidden = false;
      } catch (error) {
        message.textContent = error instanceof Error ? error.message : String(error);
        message.hidden = false;
      } finally {
        make.disabled = false;
      }
    })();
  });
  box.append(make, message, result);
  return box;
}

function channelRow(client: ClientSummary, channel: ChannelHealth, ctx: ClientsContext): HTMLElement {
  const canDisconnect = channel.id !== null;
  // A client's Instagram is renewed every week, so it is only worth mentioning once renewal has stopped working.
  const daysToEnd = channel.expiresAt ? (Date.parse(channel.expiresAt) - Date.now()) / DAY_MS : Infinity;
  const expiry = channel.platform === 'linkedin' || (channel.platform === 'instagram' && daysToEnd <= 7) ? expiryNote(channel.expiresAt, Date.now()) : null;
  return h(
    'div',
    { class: 'channel-row' },
    h('span', { class: 'mark mark-big' }, brandMark(channel.platform)),
    h(
      'div',
      { class: 'channel-meta' },
      h('b', {}, `${channelName(channel.platform)}${channel.account ? ` · ${channel.account}` : ''}`),
      h('span', { class: 'muted' }, client.pattern ?? 'Nothing booked'),
      h(
        'span',
        { class: `status-line ${channel.ok ? 'muted' : 'bad-text'}` },
        statusMark(channel.ok),
        channel.ok ? 'Connected' : `Connection problem: ${(channel.error ?? 'unknown').slice(0, 140)}`,
      ),
      channel.paused ? h('span', { class: 'tag-paused', role: 'status' }, client.paused ? 'Paused with the client' : 'Paused. Posts are not sent here until you resume it.') : null,
      expiry ? h('span', { class: 'muted' }, expiry) : null,
      channel.platform === 'linkedin' ? inviteLinkBox(client.brand, 'Get a new link for the client') : null,
      channel.platform === 'instagram' && channel.id !== null ? inviteLinkBox(client.brand, 'Get a new link for the client', 'instagram') : null,
      channel.platform === 'facebook' ? inviteLinkBox(client.brand, 'Get a link to connect another Page', 'facebook') : null,
      channel.platform === 'google' ? inviteLinkBox(client.brand, 'Get a link to connect another listing', 'google') : null,
    ),
    h(
      'div',
      { class: 'channel-actions' },
      channel.ok && postChannelId(channel) ? button('Post here', 'btn', () => ctx.newPost(client.brand, postChannelId(channel))) : null,
      // A channel held by its client (or by everything) is resumed there; its own pause is only for the channel itself.
      pauseIdOf(channel) !== null && !client.paused
        ? button(channel.paused ? 'Resume channel' : 'Pause channel', channel.paused ? 'btn' : 'btn btn-quiet', () => ctx.setPause('channel', pauseIdOf(channel), !channel.paused))
        : null,
      button('How to reconnect', 'btn btn-quiet', () => ctx.go({ page: 'help', channel: GUIDE_FOR[channel.platform] })),
      canDisconnect ? button('Disconnect', 'btn btn-quiet btn-danger', () => ctx.disconnect(channel)) : null,
    ),
  );
}

function notConnectedRow(brand: string, kind: ChannelKind, ctx: ClientsContext): HTMLElement {
  return h(
    'div',
    { class: 'channel-row' },
    h('span', { class: 'mark mark-big' }, brandMark(kind)),
    h('div', { class: 'channel-meta' }, h('b', {}, channelName(kind)), h('span', { class: 'muted' }, 'Not connected'),
      kind === 'linkedin' ? inviteLinkBox(brand, 'Get a link for the client') : null,
      kind === 'facebook' ? inviteLinkBox(brand, 'Get a link for the client', 'facebook') : null,
      kind === 'google' ? inviteLinkBox(brand, 'Get a link for the client', 'google') : null,
    ),
    h(
      'div',
      { class: 'channel-actions' },
      kind === 'google' ? button('Connect my own', 'btn', () => location.assign(`/api/google/start?brand=${encodeURIComponent(brand)}`)) : null,
      button('How to connect', 'btn', () => ctx.go({ page: 'help', channel: GUIDE_FOR[kind] })),
    ),
  );
}

/** For a client added in the dashboard: the website posts are planned from, with a box to set or change it. */
function websiteCard(client: ClientSummary, ctx: ClientsContext): HTMLElement {
  const input = h('input', { type: 'text', class: 'text-input', 'aria-label': 'Client website', maxlength: '200', autocomplete: 'off', inputmode: 'url', placeholder: 'e.g. brandbasket.in', value: websiteHost(client.website) });
  const message = h('p', { class: 'form-message', role: 'status' });
  const save = button('Save website', 'btn btn-primary', () => {
    save.disabled = true;
    message.textContent = 'Saving…';
    message.classList.remove('is-error');
    void ctx.saveWebsite(client, input.value.trim()).then((problem) => {
      if (!problem) return;
      message.textContent = problem;
      message.classList.add('is-error');
      save.disabled = false;
    });
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') save.click();
  });
  return h(
    'div',
    { class: 'panel-card website-card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Website')),
    h('p', { class: 'muted' }, client.website ? `Posts for ${client.label} are planned from ${websiteHost(client.website)}.` : `Add ${client.label}’s website. Posts are planned from it.`),
    h('div', { class: 'website-row' }, input, save),
    client.plan ? h('p', { class: 'muted plan-line' }, `Posting plan: ${planSentence(client.plan)}. The posters are made from the website and wait in Review until you approve them.`) : null,
    message,
  );
}

export function clientPage(client: ClientSummary | undefined, tab: ClientTab, ctx: ClientsContext): HTMLElement {
  if (!client) return h('p', { class: 'empty' }, 'That client was not found.', ' ', button('Back to clients', 'btn', () => ctx.go({ page: 'clients' })));
  const connected = new Set<Platform>(client.channels.map((c) => c.platform));
  const tabs = h(
    'div',
    { class: 'ctabs', role: 'tablist' },
    ...(['channels', 'posts', 'cost'] as const).map((key) =>
      button(TAB_LABELS[key], `ctab${key === tab ? ' ctab-on' : ''}`, () => ctx.go({ page: 'client', brand: client.brand, tab: key })),
    ),
  );

  const channels = h(
    'div',
    { class: 'panel-card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Channels'), button([icon('plus'), 'Add channel'], 'btn btn-primary', () => ctx.addChannel(client.brand))),
    ...client.channels.map((c) => channelRow(client, c, ctx)),
    ...KINDS.filter((k) => !connected.has(k)).map((k) => notConnectedRow(client.brand, k, ctx)),
  );

  const next = client.upcoming.slice(0, UPCOMING_SHOWN);
  const posts = h(
    'div',
    { class: 'panel-card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Coming up'), h('span', { class: 'muted' }, `${client.postsLeft} days of posts booked`)),
    next.length === 0 ? h('p', { class: 'empty' }, 'Nothing is booked.') : h('div', { class: 'post-list' }, ...next.map((p) => ctx.postCard(p))),
    client.upcoming.length > UPCOMING_SHOWN ? h('p', { class: 'muted' }, `Showing the next ${UPCOMING_SHOWN}. The calendar shows all of them.`) : null,
    h('p', { class: 'muted' }, stateLabel('scheduled'), ' posts can be edited in their window.'),
  );

  return h(
    'div',
    { class: 'client-page' },
    h(
      'div',
      { class: 'crumbs' },
      button('Clients', 'link-button', () => ctx.go({ page: 'clients' })),
      ` / ${client.label}`,
    ),
    h('div', { class: 'client-head' }, h('div', { class: 'client-title' }, h('h2', {}, client.label)), h('div', { class: 'actions' }, button([icon('plus'), 'New post'], 'btn btn-primary', () => ctx.newPost(client.brand, null)), button('Open calendar', 'btn', () => ctx.openCalendar(client.brand)), ctx.allPaused() ? null : button(client.paused ? 'Resume client' : 'Pause client', client.paused ? 'btn' : 'btn btn-quiet', () => ctx.setPause('brand', client.brand, !client.paused)), client.added ? button('Remove client', 'btn btn-quiet btn-danger', () => ctx.removeClient(client)) : null)),
    client.added ? websiteCard(client, ctx) : null,
    client.paused ? h('p', { class: 'banner banner-warn', role: 'status' }, ctx.allPaused() ? 'Everything is paused, so nothing is sent for this client.' : `${client.label} is paused. Nothing is sent for this client until you resume it. Posts whose time comes while it is paused are skipped, not sent late.`) : null,
    tabs,
    tab === 'channels' ? channels : tab === 'posts' ? posts : costPage(client, ctx),
  );
}

/** The Add channel window's contents. Facebook starts the real connection; the others point to their guide. */
export function channelPicker(
  brand: string | null,
  clients: Array<{ brand: string; label: string }>,
  connected: Record<string, Platform[]>,
  ctx: ClientsContext,
  close: () => void,
): HTMLElement {
  const note = h('div', { class: 'note', hidden: '' });
  // With several clients and none chosen yet, the person says whom the channel is for.
  const who = dropdown(clients.map((c) => clientOption(c.brand, c.label)), brand ?? clients[0]?.brand ?? '', 'Client');
  const choose = (kind: ChannelKind): void => {
    note.hidden = false;
    if (kind === 'facebook') {
      note.replaceChildren(
        'Facebook uses whichever account is signed in to the browser you connect from. Make a link and open it in the browser where the right Facebook account is signed in, or send it to the client. Or connect from this browser.',
        inviteLinkBox(who.value, 'Get a link', 'facebook'),
        button('Connect from this browser', 'btn', () => location.assign(`/api/facebook-start?brand=${encodeURIComponent(who.value)}`)),
      );
      return;
    }
    if (kind === 'linkedin') {
      note.replaceChildren(
        'LinkedIn is approved by the person who owns the profile. Make a link and send it to the client, or connect your own profile.',
        inviteLinkBox(who.value, 'Get a link for the client'),
        button('Connect my own profile', 'btn', () => location.assign(`/api/linkedin-start?brand=${encodeURIComponent(who.value)}`)),
      );
      return;
    }
    if (kind === 'google') {
      note.replaceChildren(
        'The client approves their own business listing: make a link and send it to them. They sign in with the Google account that manages the listing and press Allow. Or connect a listing your own account manages.',
        inviteLinkBox(who.value, 'Get a link for the client', 'google'),
        button('Connect my own', 'btn', () => location.assign(`/api/google/start?brand=${encodeURIComponent(who.value)}`)),
      );
      return;
    }
    if (kind === 'instagram') {
      note.replaceChildren(
        'A client connects their own Instagram (a Business or Creator account) by pressing Allow on their own account. Make a link and send it to the client. Our own account is connected with a token: the guide lists every step.',
        inviteLinkBox(who.value, 'Get a link for the client', 'instagram'),
        button('Open the guide', 'btn', () => { close(); ctx.go({ page: 'help', channel: GUIDE_FOR[kind] }); }),
      );
      return;
    }
    note.textContent = `${channelName(kind)} cannot be connected from here yet. The guide lists the steps and what to prepare.`;
    note.append(' ', button('Open the guide', 'btn', () => { close(); ctx.go({ page: 'help', channel: GUIDE_FOR[kind] }); }));
  };
  // A green tick on the channels this client already has; it follows the client chosen above.
  const ticks: Array<() => void> = [];
  const option = (kind: ChannelKind, sub: string): HTMLElement => {
    const slot = h('span', { class: 'option-state' });
    ticks.push(() => {
      const has = (connected[who.value] ?? []).includes(kind);
      slot.replaceChildren(...(has ? [statusMark(true), ' Connected'] : []));
    });
    return button([h('span', { class: 'mark mark-big' }, brandMark(kind)), h('span', { class: 'option-text' }, h('b', {}, channelName(kind)), h('small', {}, sub)), slot], 'option', () => choose(kind));
  };
  who.addEventListener('change', () => ticks.forEach((update) => update()));
  const soon = (letter: string, name: string): HTMLElement =>
    h('div', { class: 'option option-soon' }, h('span', { class: 'soon-mark' }, letter), h('b', {}, name), h('span', { class: 'soon-tag' }, 'Soon'));

  const content = h(
    'div',
    { class: 'dialog-inner' },
    h('div', { class: 'dialog-head' }, h('h2', {}, 'Add a channel'), button('Close', 'btn btn-quiet', close)),
    clients.length > 1 ? h('label', { class: 'picker-client' }, h('span', { class: 'muted' }, 'For client'), who) : null,
    h('h3', { class: 'label' }, 'Available'),
    h(
      'div',
      { class: 'options' },
      option('instagram', 'Business or Creator account'),
      option('facebook', 'A Page you manage'),
      option('linkedin', 'A personal profile'),
      option('google', 'Updates on the business listing'),
    ),
    h('h3', { class: 'label' }, 'More networks, coming later'),
    h('div', { class: 'options' }, soon('X', 'X'), soon('@', 'Threads'), soon('♪', 'TikTok'), soon('▶', 'YouTube'), soon('P', 'Pinterest')),
    note,
    h('p', { class: 'muted' }, 'Not sure how? ', button('Open the setup guides', 'link-button', () => { close(); ctx.go({ page: 'help', channel: 'facebook' }); })),
  );
  ticks.forEach((update) => update());
  return content;
}

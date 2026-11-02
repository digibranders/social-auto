/** The Clients screens: a folder per client, and inside each its channels and what is coming up. */
import type { ChannelHealth, Platform, StatusPost } from '../shared/status.ts';
import type { ClientSummary } from './clients.ts';
import { stateLabel } from './calendar.ts';
import type { ClientTab, GuideKey, Route } from './route.ts';
import { brandMark, button, channelName, h, icon, statusMark, type ChannelKind } from './ui.ts';

export interface ClientsContext {
  go(route: Route): void;
  openCalendar(brand: string): void;
  /** One upcoming post as a card; opens its window when clicked. */
  postCard(post: StatusPost): HTMLElement;
  addChannel(brand: string | null): void;
  disconnect(channel: ChannelHealth): void;
}

const KINDS: readonly ChannelKind[] = ['facebook', 'instagram', 'google', 'linkedin'];
const GUIDE_FOR: Record<ChannelKind, GuideKey> = { facebook: 'facebook', instagram: 'instagram', google: 'google', linkedin: 'linkedin' };
const UPCOMING_SHOWN = 14;

export function clientsPage(clients: ClientSummary[], ctx: ClientsContext): HTMLElement {
  if (clients.length === 0) return h('p', { class: 'empty' }, 'No clients yet.');
  return h(
    'div',
    { class: 'folders' },
    ...clients.map((client) => {
      const card = h(
        'button',
        { type: 'button', class: 'folder', 'aria-label': `Open ${client.label}` },
        h('span', { class: 'folder-tab', 'aria-hidden': 'true' }),
        h('div', { class: 'folder-head' }, h('h3', {}, client.label)),
        h('div', { class: 'folder-marks' }, ...client.channels.map((c) => h('span', { class: 'mark', title: channelName(c.platform) }, brandMark(c.platform)))),
        h('div', { class: 'folder-stats muted' }, h('span', {}, client.pattern ?? 'Nothing booked'), h('span', {}, `${client.postsLeft} days booked`)),
      );
      card.addEventListener('click', () => ctx.go({ page: 'client', brand: client.brand, tab: 'channels' }));
      return card;
    }),
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** "Ends in 12 days" for a LinkedIn connection, which LinkedIn cuts after about 60 days. */
export function expiryNote(expiresAt: string | undefined, now: number): string | null {
  if (!expiresAt) return null;
  const days = Math.floor((Date.parse(expiresAt) - now) / DAY_MS);
  if (days < 0) return 'The connection has ended. Send the client a new link.';
  if (days === 0) return 'The connection ends today. Send the client a new link.';
  return `Connection ends in ${days} day${days === 1 ? '' : 's'}${days <= 7 ? '. Send the client a new link.' : '.'}`;
}

/**
 * Makes a link the client opens to connect their own LinkedIn (they press Allow on their own account).
 * Asking is one click; copying is a second, so the browser allows it.
 */
export function inviteLinkBox(brand: string, label: string): HTMLElement {
  const box = h('div', { class: 'link-box' });
  const result = h('div', { class: 'link-result', hidden: '' });
  const message = h('p', { class: 'muted', hidden: '' });
  const make = button(label, 'btn', () => {
    make.disabled = true;
    message.hidden = true;
    void (async () => {
      try {
        const response = await fetch(`/api/linkedin-invite?brand=${encodeURIComponent(brand)}`, { method: 'POST', credentials: 'same-origin' });
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
        result.replaceChildren(field, copy, h('p', { class: 'muted' }, `Send this to the client. It works for ${String(body.expiresInDays ?? 7)} days and only lets them connect their LinkedIn for this client.`));
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
  const canDisconnect = (channel.platform === 'facebook' || channel.platform === 'linkedin') && channel.id !== null;
  const expiry = channel.platform === 'linkedin' ? expiryNote(channel.expiresAt, Date.now()) : null;
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
      expiry ? h('span', { class: 'muted' }, expiry) : null,
      channel.platform === 'linkedin' ? inviteLinkBox(client.brand, 'Get a new link for the client') : null,
    ),
    h(
      'div',
      { class: 'channel-actions' },
      button('How to reconnect', 'btn btn-quiet', () => ctx.go({ page: 'help', channel: GUIDE_FOR[channel.platform] })),
      canDisconnect ? button('Disconnect', 'btn btn-quiet btn-danger', () => ctx.disconnect(channel)) : null,
    ),
  );
}

function notConnectedRow(brand: string, kind: ChannelKind, ctx: ClientsContext): HTMLElement {
  const comingSoon = kind === 'google';
  return h(
    'div',
    { class: 'channel-row' },
    h('span', { class: 'mark mark-big' }, brandMark(kind)),
    h('div', { class: 'channel-meta' }, h('b', {}, channelName(kind)), h('span', { class: 'muted' }, comingSoon ? 'Not connected · connecting from the dashboard comes later' : 'Not connected'),
      kind === 'linkedin' ? inviteLinkBox(brand, 'Get a link for the client') : null,
    ),
    h(
      'div',
      { class: 'channel-actions' },
      button('How to connect', 'btn', () => ctx.go({ page: 'help', channel: GUIDE_FOR[kind] })),
    ),
  );
}

export function clientPage(client: ClientSummary | undefined, tab: ClientTab, ctx: ClientsContext): HTMLElement {
  if (!client) return h('p', { class: 'empty' }, 'That client was not found.', ' ', button('Back to clients', 'btn', () => ctx.go({ page: 'clients' })));
  const connected = new Set<Platform>(client.channels.map((c) => c.platform));
  const tabs = h(
    'div',
    { class: 'ctabs', role: 'tablist' },
    ...(['channels', 'posts'] as const).map((key) =>
      button(key === 'channels' ? 'Channels' : 'Next posts', `ctab${key === tab ? ' ctab-on' : ''}`, () => ctx.go({ page: 'client', brand: client.brand, tab: key })),
    ),
  );

  const channels = h(
    'div',
    { class: 'panel-card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Channels'), button([icon('plus'), 'Add channel'], 'btn btn-primary', () => ctx.addChannel(client.brand))),
    ...client.channels.map((c) => channelRow(client, c, ctx)),
    ...KINDS.filter((k) => k === 'google' || !connected.has(k)).map((k) => notConnectedRow(client.brand, k, ctx)),
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
    h('div', { class: 'client-head' }, h('div', { class: 'client-title' }, h('h2', {}, client.label)), button('Open calendar', 'btn', () => ctx.openCalendar(client.brand))),
    tabs,
    tab === 'channels' ? channels : posts,
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
  const who = h('select', { class: 'btn client-select', 'aria-label': 'Client' });
  for (const client of clients) {
    const option = h('option', { value: client.brand }, client.label);
    if (client.brand === (brand ?? clients[0]?.brand)) option.selected = true;
    who.append(option);
  }
  const choose = (kind: ChannelKind): void => {
    if (kind === 'facebook') {
      location.assign(`/api/facebook-start?brand=${encodeURIComponent(who.value)}`);
      return;
    }
    note.hidden = false;
    if (kind === 'linkedin') {
      note.replaceChildren(
        'LinkedIn is approved by the person who owns the profile. Make a link and send it to the client, or connect your own profile.',
        inviteLinkBox(who.value, 'Get a link for the client'),
        button('Connect my own profile', 'btn', () => location.assign(`/api/linkedin-start?brand=${encodeURIComponent(who.value)}`)),
      );
      return;
    }
    note.textContent =
      kind === 'instagram'
        ? 'Instagram is connected with a token for now. The guide lists every step.'
        : `${channelName(kind)} cannot be connected from here yet. The guide lists the steps and what to prepare.`;
    note.append(' ', button('Open the guide', 'btn', () => { close(); ctx.go({ page: 'help', channel: GUIDE_FOR[kind] }); }));
  };
  // A green tick on the channels this client already has; it follows the client chosen above.
  const ticks: Array<() => void> = [];
  const option = (kind: ChannelKind, sub: string): HTMLElement => {
    const slot = h('span', { class: 'option-state' });
    ticks.push(() => {
      const has = kind !== 'google' && (connected[who.value] ?? []).includes(kind);
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
      option('google', 'Posts on the business listing'),
    ),
    h('h3', { class: 'label' }, 'More networks, coming later'),
    h('div', { class: 'options' }, soon('X', 'X'), soon('@', 'Threads'), soon('♪', 'TikTok'), soon('▶', 'YouTube'), soon('P', 'Pinterest')),
    note,
    h('p', { class: 'muted' }, 'Not sure how? ', button('Open the setup guides', 'link-button', () => { close(); ctx.go({ page: 'help', channel: 'facebook' }); })),
  );
  ticks.forEach((update) => update());
  return content;
}

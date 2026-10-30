/** The Clients screens: a folder per client, and inside each its channels and what is coming up. */
import type { ChannelHealth, Platform, StatusPost } from '../shared/status.ts';
import type { ClientSummary } from './clients.ts';
import { stateLabel } from './calendar.ts';
import type { ClientTab, GuideKey, Route } from './route.ts';
import { brandMark, button, channelName, h, icon, type ChannelKind } from './ui.ts';

export interface ClientsContext {
  go(route: Route): void;
  openCalendar(brand: string): void;
  /** One upcoming post as a card; opens its window when clicked. */
  postCard(post: StatusPost): HTMLElement;
  addChannel(brand: string): void;
  disconnect(channel: ChannelHealth): void;
}

const KINDS: readonly ChannelKind[] = ['facebook', 'instagram', 'google', 'linkedin'];
const GUIDE_FOR: Record<ChannelKind, GuideKey> = { facebook: 'facebook', instagram: 'instagram', google: 'google', linkedin: 'linkedin' };
const UPCOMING_SHOWN = 14;

function healthOf(client: ClientSummary): { kind: 'ok' | 'warn' | 'bad'; text: string } {
  if (client.problems > 0 || client.missed > 0) return { kind: 'bad', text: 'Needs attention' };
  if (client.queueLow) return { kind: 'warn', text: 'Queue low' };
  return { kind: 'ok', text: 'All good' };
}

const healthPill = (client: ClientSummary): HTMLElement => {
  const { kind, text } = healthOf(client);
  return h('span', { class: `health-pill health-pill-${kind}` }, h('i', { class: 'dot' }), text);
};

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
        h('div', { class: 'folder-head' }, h('h3', {}, client.label), healthPill(client)),
        h('div', { class: 'folder-marks' }, ...client.channels.map((c) => h('span', { class: 'mark', title: channelName(c.platform) }, brandMark(c.platform)))),
        h('div', { class: 'folder-stats muted' }, h('span', {}, client.pattern ?? 'Nothing booked'), h('span', {}, `${client.postsLeft} days booked`)),
      );
      card.addEventListener('click', () => ctx.go({ page: 'client', brand: client.brand, tab: 'channels' }));
      return card;
    }),
  );
}

function channelRow(client: ClientSummary, channel: ChannelHealth, ctx: ClientsContext): HTMLElement {
  const canDisconnect = channel.platform === 'facebook' && channel.id !== null;
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
        { class: channel.ok ? 'muted' : 'bad-text' },
        h('i', { class: `dot ${channel.ok ? 'dot-ok' : 'dot-bad'}` }),
        channel.ok ? 'Connected' : `Connection problem: ${(channel.error ?? 'unknown').slice(0, 140)}`,
      ),
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
  const comingSoon = kind === 'google' || kind === 'linkedin';
  return h(
    'div',
    { class: 'channel-row' },
    h('span', { class: 'mark mark-big' }, brandMark(kind)),
    h('div', { class: 'channel-meta' }, h('b', {}, channelName(kind)), h('span', { class: 'muted' }, comingSoon ? 'Not connected · connecting from the dashboard comes later' : 'Not connected')),
    h(
      'div',
      { class: 'channel-actions' },
      kind === 'facebook' ? button('Connect', 'btn btn-primary', () => location.assign(`/api/facebook-start?brand=${encodeURIComponent(brand)}`)) : null,
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
    h('div', { class: 'client-head' }, h('div', { class: 'client-title' }, h('h2', {}, client.label), healthPill(client)), button('Open calendar', 'btn', () => ctx.openCalendar(client.brand))),
    tabs,
    tab === 'channels' ? channels : posts,
  );
}

/** The Add channel window's contents. Facebook starts the real connection; the others point to their guide. */
export function channelPicker(brand: string, ctx: ClientsContext, close: () => void): HTMLElement {
  const note = h('p', { class: 'note', hidden: '' });
  const choose = (kind: ChannelKind): void => {
    if (kind === 'facebook') {
      location.assign(`/api/facebook-start?brand=${encodeURIComponent(brand)}`);
      return;
    }
    note.hidden = false;
    note.textContent =
      kind === 'instagram'
        ? 'Instagram is connected with a token for now. The guide lists every step.'
        : `${channelName(kind)} cannot be connected from here yet. The guide lists the steps and what to prepare.`;
    note.append(' ', button('Open the guide', 'btn', () => { close(); ctx.go({ page: 'help', channel: GUIDE_FOR[kind] }); }));
  };
  const option = (kind: ChannelKind, sub: string): HTMLElement =>
    button([h('span', { class: 'mark mark-big' }, brandMark(kind)), h('span', {}, h('b', {}, channelName(kind)), h('small', {}, sub))], 'option', () => choose(kind));
  const soon = (letter: string, name: string): HTMLElement =>
    h('div', { class: 'option option-soon' }, h('span', { class: 'soon-mark' }, letter), h('b', {}, name), h('span', { class: 'soon-tag' }, 'Soon'));

  return h(
    'div',
    { class: 'dialog-inner' },
    h('div', { class: 'dialog-head' }, h('h2', {}, 'Add a channel'), button('Close', 'btn btn-quiet', close)),
    h('h3', { class: 'label' }, 'Available'),
    h(
      'div',
      { class: 'options' },
      option('instagram', 'Business or Creator account'),
      option('facebook', 'A Page you manage'),
      option('linkedin', 'Profile or company page'),
      option('google', 'Posts on the business listing'),
    ),
    h('h3', { class: 'label' }, 'More networks, coming later'),
    h('div', { class: 'options' }, soon('X', 'X'), soon('@', 'Threads'), soon('♪', 'TikTok'), soon('▶', 'YouTube'), soon('P', 'Pinterest')),
    note,
    h('p', { class: 'muted' }, 'Not sure how? ', button('Open the setup guides', 'link-button', () => { close(); ctx.go({ page: 'help', channel: 'facebook' }); })),
  );
}

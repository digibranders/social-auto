/** The calendar page. Every piece of text goes into the page as text, never as HTML. */
import { parseStatus, type ChannelHealth, type Platform, type PostState, type StatusPost, type StatusResponse } from '../shared/status.ts';
import {
  addDays,
  addMonths,
  brandLabel,
  dayKeyOf,
  formatDateTime,
  formatDayHeader,
  formatDayLabel,
  formatHourLabel,
  formatMonth,
  captionProblem,
  captionStats,
  formatTime,
  groupByDay,
  hourOf,
  minuteOf,
  monthGrid,
  MAX_CAPTION_LENGTH,
  MAX_HASHTAGS,
  monthOf,
  safeHttpsUrl,
  stateLabel,
  stateMark,
  weekDays,
  weekdayName,
} from './calendar.ts';
import { applyStoredTheme, currentTheme, setTheme } from './theme.ts';
import { brandMark, button, h, icon, platformLabel, statusMark, type Child } from './ui.ts';
import { channelPicker, clientPage, clientsPage, type ClientsContext } from './clients-page.ts';
import { summarizeClients } from './clients.ts';
import { helpPage } from './help-page.ts';
import { parseRoute, routeHash, type Route } from './route.ts';

type View = 'day' | 'week' | 'month' | 'list';

interface State {
  view: View;
  /** Any day inside the period being looked at. */
  cursor: string;
  /** The channel being looked at (see channelKey), or null for all. */
  channel: string | null;
  showEarlier: boolean;
  data: StatusResponse | null;
  error: string | null;
  /** A one-off message, e.g. the result of connecting a channel. */
  notice: { kind: 'ok' | 'warn'; text: string } | null;
  /** Which screen is showing (mirrors the address). */
  route: Route;
  /** The calendar shows only this client's posts and channels; null means every client. */
  calendarClient: string | null;
  loadedAt: number | null;
  loading: boolean;
  /** Scroll position of the hourly grid, kept across refreshes; null means "go to the first post". */
  gridScroll: number | null;
}

const REFRESH_MS = 5 * 60 * 1000;
const STALE_MS = 60 * 1000;
const PREFS_KEY = 'calendar.prefs';
const LIST_DAYS_BACK = 1;
const MONTH_CHIPS_PER_DAY = 3;
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const STATE_HELP: Record<PostState, string> = {
  published: 'This post is live.',
  scheduled: 'Goes out automatically at the scheduled time.',
  due: 'Its time has come. It should appear within the hour.',
  missed: 'Its time passed and it is not on the account.',
  unknown: 'The account could not be checked, so its status is not known.',
};
const state: State = {
  view: 'week',
  cursor: dayKeyOf(Date.now()),
  channel: null,
  showEarlier: false,
  data: null,
  error: null,
  loadedAt: null,
  loading: false,
  gridScroll: null,
  notice: null,
  route: parseRoute(location.hash),
  calendarClient: null,
};

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id} in the page`);
  return element as T;
}
const root = required<HTMLElement>('app');
const dialog = required<HTMLDialogElement>('detail');
const picker = required<HTMLDialogElement>('picker');
const narrow = window.matchMedia('(max-width: 900px)');

function loadPrefs(): void {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return;
    const prefs = JSON.parse(raw) as { view?: unknown; channel?: unknown };
    if (prefs.view === 'day' || prefs.view === 'week' || prefs.view === 'month' || prefs.view === 'list') state.view = prefs.view;
    if (typeof prefs.channel === 'string') state.channel = prefs.channel;
  } catch {
    // Saved preferences are a convenience; the page works without them.
  }
}

function savePrefs(): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ view: state.view, channel: state.channel }));
  } catch {
    // Same: ignore storage that is unavailable.
  }
}

const today = (): string => dayKeyOf(Date.now());
const shorten = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
const snippet = (caption: string, max = 90): string => shorten(caption.split('\n').find((line) => line.trim()) ?? '', max);
const channelKey = (channel: ChannelHealth): string => `${channel.platform}:${channel.account ?? channel.brands.join(',')}`;
const channelName = (channel: ChannelHealth): string => channel.account ?? platformLabel(channel.platform);
const pictureOf = (post: StatusPost): string | null =>
  safeHttpsUrl(post.image, location.origin) ?? safeHttpsUrl(post.mediaUrl, location.origin);

function channelOf(post: StatusPost): ChannelHealth | undefined {
  return state.data?.channels.find((c) => c.platform === post.platform && c.brands.includes(post.brand));
}

function visiblePosts(): StatusPost[] {
  const posts = (state.data?.posts ?? []).filter((p) => !state.calendarClient || p.brand === state.calendarClient);
  const selected = state.data?.channels.find((c) => channelKey(c) === state.channel);
  if (!selected) return posts;
  return posts.filter(
    (p) =>
      selected.brands.includes(p.brand) &&
      (p.platform === selected.platform || p.crossposts.some((c) => c.platform === selected.platform && c.account === selected.account)),
  );
}

/** The channel's picture, or its first letter, with a small badge for the platform. */
function avatar(channel: ChannelHealth | undefined, fallback: string): HTMLElement {
  const picture = channel ? safeHttpsUrl(channel.avatar, location.origin) : null;
  const letter = (channel ? channelName(channel) : fallback).charAt(0).toUpperCase();
  return h(
    'span',
    { class: 'avatar', 'aria-hidden': 'true' },
    picture ? h('img', { src: picture, alt: '', referrerpolicy: 'no-referrer' }) : h('span', { class: 'avatar-letter' }, letter),
    channel ? h('span', { class: 'badge' }, brandMark(channel.platform)) : null,
  );
}

function pill(postState: PostState): HTMLElement {
  return h('span', { class: `pill state-${postState}` }, h('span', { 'aria-hidden': 'true' }, stateMark(postState)), ` ${stateLabel(postState)}`);
}

function thumbnail(post: StatusPost): HTMLElement {
  const source = pictureOf(post);
  if (!source) return h('div', { class: 'thumb thumb-empty' }, 'No image');
  return h('img', { class: 'thumb', src: source, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
}

function describe(post: StatusPost): string {
  return `${brandLabel(post.brand)}, ${formatDateTime(post.date)}, ${stateLabel(post.state)}`;
}

/** A post inside an hourly cell: a small preview, like a draft in a calendar slot. */
function slotPost(post: StatusPost, large: boolean): HTMLElement {
  const element = h(
    'button',
    { type: 'button', class: `slot-post state-${post.state}`, 'aria-label': describe(post), title: `${brandLabel(post.brand)} · ${stateLabel(post.state)}` },
    large ? thumbnail(post) : avatar(channelOf(post), post.brand),
    h(
      'span',
      { class: 'slot-text' },
      h('span', { class: 'slot-time' }, h('span', { 'aria-hidden': 'true', class: 'slot-mark' }, stateMark(post.state)), ` ${formatTime(post.date)}`),
      h('span', { class: 'slot-snippet' }, snippet(post.caption, large ? 120 : 60)),
    ),
  );
  element.addEventListener('click', () => openDetail(post));
  return element;
}

/** A post as a card: used in the list and in the stacked layout on small screens. */
function postCard(post: StatusPost): HTMLElement {
  const card = h(
    'button',
    { type: 'button', class: `card state-${post.state}`, 'aria-label': describe(post) },
    thumbnail(post),
    h(
      'div',
      { class: 'card-body' },
      h('div', { class: 'card-meta' }, avatar(channelOf(post), post.brand), h('span', { class: 'time' }, formatTime(post.date)), h('span', { class: 'client' }, brandLabel(post.brand))),
      h('div', { class: 'pills' }, pill(post.state), editedTag(post)),
      h('p', { class: 'snippet' }, snippet(post.caption)),
    ),
  );
  card.addEventListener('click', () => openDetail(post));
  return card;
}

function monthChip(post: StatusPost): HTMLElement {
  const chip = h(
    'button',
    { type: 'button', class: `mchip state-${post.state}`, 'aria-label': describe(post), title: `${brandLabel(post.brand)} · ${stateLabel(post.state)}` },
    h('span', { class: 'mmark', 'aria-hidden': 'true' }, stateMark(post.state)),
    h('span', { class: 'mtime' }, formatTime(post.date)),
    h('span', { class: 'mtext' }, snippet(post.caption, 40)),
  );
  chip.addEventListener('click', () => openDetail(post));
  return chip;
}

function field(label: string, value: string): HTMLElement {
  return h('div', { class: 'field' }, h('span', { class: 'field-label' }, label), h('span', {}, value));
}

function editedTag(post: StatusPost): HTMLElement | false {
  return post.edited && h('span', { class: 'tag-edited', title: 'Changed in the dashboard' }, 'Edited');
}

const MAX_PICTURE_BYTES = 4 * 1024 * 1024;

/** Sends one change to the server; resolves to an explanation when it did not work. */
async function sendEdit(post: StatusPost, action: 'caption' | 'image' | 'revert', body?: BodyInit, contentType?: string): Promise<string | null> {
  try {
    const response = await fetch(`/api/edit?post=${encodeURIComponent(post.id)}&action=${action}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: contentType ? { 'Content-Type': contentType } : {},
      body,
    });
    if (response.status === 401) {
      location.replace('/login');
      return 'You were signed out.';
    }
    if (response.ok) return null;
    const answer: unknown = await response.json().catch(() => null);
    return messageOf(answer) ?? `The server answered ${response.status}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** After a saved change: fetch the fresh feed and show the same post again. */
async function reopenAfterChange(id: string, mode: 'view' | 'edit'): Promise<void> {
  await load();
  const fresh = state.data?.posts.find((p) => p.id === id);
  if (fresh) openDetail(fresh, mode);
  else dialog.close();
}

function editPanel(post: StatusPost): HTMLElement {
  const message = h('p', { class: 'form-message', role: 'status' });
  const show = (text: string, isError: boolean): void => {
    message.textContent = text;
    message.classList.toggle('is-error', isError);
  };
  const buttons: HTMLButtonElement[] = [];
  const busy = (working: boolean): void => {
    for (const element of buttons) element.disabled = working;
  };

  const area = h('textarea', { class: 'caption-input', rows: '12', 'aria-label': 'Caption', maxlength: String(MAX_CAPTION_LENGTH * 2) });
  area.value = post.caption;
  const count = h('p', { class: 'muted counter' });
  const update = (): void => {
    const { length, hashtags } = captionStats(area.value);
    count.textContent = `${length} / ${MAX_CAPTION_LENGTH} characters · ${hashtags} / ${MAX_HASHTAGS} hashtags`;
    count.classList.toggle('is-error', captionProblem(area.value) !== null);
  };
  area.addEventListener('input', update);
  update();

  const run = async (work: () => Promise<string | null>, mode: 'view' | 'edit'): Promise<void> => {
    busy(true);
    show('Saving…', false);
    const problem = await work();
    if (problem) {
      show(problem, true);
      busy(false);
      return;
    }
    await reopenAfterChange(post.id, mode);
  };

  const save = button('Save caption', 'btn btn-primary', () => {
    const problem = captionProblem(area.value);
    if (problem) return show(problem, true);
    void run(() => sendEdit(post, 'caption', JSON.stringify({ caption: area.value }), 'application/json'), 'view');
  });
  buttons.push(save);

  const file = h('input', { type: 'file', accept: 'image/jpeg', class: 'visually-hidden', id: 'picture-input' });
  file.addEventListener('change', () => {
    const chosen = file.files?.[0];
    file.value = '';
    if (!chosen) return;
    if (chosen.type !== 'image/jpeg') return show('Choose a JPG picture.', true);
    if (chosen.size > MAX_PICTURE_BYTES) return show('That picture is over 4 MB. Choose a smaller one.', true);
    void run(() => sendEdit(post, 'image', chosen, 'image/jpeg'), 'edit');
  });
  const pick = button('Replace picture', 'btn', () => file.click());
  buttons.push(pick);

  const revert = post.edited
    ? button('Revert to original', 'btn btn-quiet', () => {
        if (confirm('Discard your changes to this post and go back to the original?')) void run(() => sendEdit(post, 'revert'), 'view');
      })
    : null;
  if (revert) buttons.push(revert);
  const cancel = button('Cancel', 'btn btn-quiet', () => openDetail(post, 'view'));
  buttons.push(cancel);

  return h(
    'div',
    { class: 'edit-panel' },
    h('h3', {}, 'Caption'),
    area,
    count,
    h('p', { class: 'muted' }, 'The pictures must be square JPG, up to 4 MB. Changes go out at the scheduled time.'),
    h('div', { class: 'actions' }, save, pick, file, revert, cancel),
    message,
  );
}

function openDetail(post: StatusPost, mode: 'view' | 'edit' = 'view'): void {
  const source = pictureOf(post);
  const link = safeHttpsUrl(post.permalink);
  const editing = mode === 'edit' && post.editable;
  dialog.replaceChildren(
    h(
      'div',
      { class: 'dialog-inner' },
      h(
        'div',
        { class: 'dialog-head' },
        h('div', { class: 'dialog-title' }, avatar(channelOf(post), post.brand), h('h2', {}, `${brandLabel(post.brand)} · ${platformLabel(post.platform)}`)),
        button('Close', 'btn btn-quiet', () => dialog.close()),
      ),
      h(
        'div',
        { class: 'dialog-body' },
        source
          ? h('img', { class: 'poster', src: source, alt: `Poster for the ${brandLabel(post.brand)} post of ${formatDateTime(post.date)}`, referrerpolicy: 'no-referrer' })
          : h('div', { class: 'poster thumb-empty' }, 'The poster is no longer stored'),
        h(
          'div',
          { class: 'detail' },
          h('div', { class: 'pills' }, pill(post.state), editedTag(post)),
          h('p', { class: 'muted' }, STATE_HELP[post.state]),
          field('Scheduled for', formatDateTime(post.date)),
          post.publishedAt ? field('Published', formatDateTime(post.publishedAt)) : null,
          ...post.crossposts.map((c) => {
            const link = safeHttpsUrl(c.permalink);
            return h(
              'div',
              { class: 'field' },
              h('span', { class: 'field-label' }, `${platformLabel(c.platform)} · ${c.account}`),
              link ? h('a', { href: link, target: '_blank', rel: 'noopener noreferrer' }, `${stateLabel(c.state)} · view`) : h('span', {}, stateLabel(c.state)),
            );
          }),
          link ? h('a', { class: 'btn btn-primary', href: link, target: '_blank', rel: 'noopener noreferrer' }, `View on ${platformLabel(post.platform)}`) : null,
          editing
            ? editPanel(post)
            : h(
                'div',
                { class: 'view-panel' },
                post.editable ? button('Edit post', 'btn btn-primary', () => openDetail(post, 'edit')) : null,
                h('h3', {}, 'Caption'),
                h('p', { class: 'caption' }, post.caption),
              ),
        ),
      ),
    ),
  );
  if (!dialog.open) dialog.showModal();
}

function banner(kind: 'warn' | 'error', message: string): HTMLElement {
  return h('div', { class: `banner banner-${kind}`, role: 'alert' }, message);
}

function banners(): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (state.notice) {
    out.push(
      h(
        'div',
        { class: `banner banner-${state.notice.kind} banner-notice`, role: 'status' },
        h('span', {}, state.notice.text),
        button('Dismiss', 'btn btn-quiet banner-dismiss', () => {
          state.notice = null;
          render();
        }),
      ),
    );
  }
  if (state.error) {
    const since = state.loadedAt ? ` Showing what was loaded at ${formatTime(state.loadedAt)}.` : '';
    out.push(banner('warn', `Could not refresh: ${shorten(state.error, 200)}.${since}`));
  }
  const data = state.data;
  if (!data) return out;
  for (const channel of data.channels) {
    if (channel.ok) continue;
    const who = channel.account ? ` (${channel.account})` : '';
    out.push(banner('error', `${platformLabel(channel.platform)}${who} connection problem: ${shorten(channel.error ?? 'unknown error', 220)}. Posting may fail until this is fixed.`));
  }
  const missed = data.posts.filter((p) => p.state === 'missed').length;
  if (missed) out.push(banner('error', `${missed} post${missed === 1 ? ' was' : 's were'} missed. Open it to see the details.`));
  return out;
}

/** One Add channel button under the list: it opens the window with every channel type, Facebook among them. */
function addChannelButton(): HTMLElement {
  return button([icon('plus'), 'Add channel'], 'btn add-channel', () => openPicker(state.calendarClient));
}

function channelsPanel(): HTMLElement {
  const channels = (state.data?.channels ?? []).filter((c) => !state.calendarClient || c.brands.includes(state.calendarClient));
  const entry = (channel: ChannelHealth): HTMLElement => {
    const key = channelKey(channel);
    const on = state.channel === key;
    const item = h(
      'button',
      { type: 'button', class: `channel${on ? ' channel-on' : ''}`, 'aria-pressed': String(on) },
      avatar(channel, '?'),
      h(
        'span',
        { class: 'channel-text' },
        h('span', { class: 'channel-name' }, channelName(channel)),
        h('span', { class: 'channel-sub' }, `${platformLabel(channel.platform)} · ${channel.brands.map(brandLabel).join(', ')}`),
      ),
      channel.ok ? null : statusMark(false),
    );
    item.addEventListener('click', () => {
      // Choosing the channel that is already chosen shows every channel again.
      state.channel = on ? null : key;
      savePrefs();
      render();
    });
    return item;
  };

  const selected = channels.find((c) => channelKey(c) === state.channel);
  const runway = (state.data?.runway ?? []).filter((r) => !selected || selected.brands.includes(r.brand));

  return h(
    'aside',
    { class: 'channels', 'aria-label': 'Channels' },
    h('h2', { class: 'panel-title' }, 'Channels'),
    h('div', { class: 'channel-list' }, ...channels.map(entry)),
    addChannelButton(),
    ...runway.map((r) =>
      h(
        'p',
        { class: `runway${r.postsLeft <= 7 ? ' runway-low' : ''}` },
        `${brandLabel(r.brand)}: ${r.postsLeft} day${r.postsLeft === 1 ? '' : 's'} of posts booked`,
      ),
    ),
  );
}

function jumpTo(day: string): void {
  state.cursor = day;
  state.gridScroll = null;
  render();
}

function navigate(delta: number): void {
  const next = state.view === 'month' ? addMonths(state.cursor, delta) : addDays(state.cursor, delta * (state.view === 'day' ? 1 : 7));
  jumpTo(next);
}

function periodLabel(): string {
  if (state.view === 'month') return formatMonth(state.cursor);
  if (state.view === 'week') {
    const days = weekDays(state.cursor);
    return `${formatDayHeader(days[0] ?? state.cursor)} - ${formatDayHeader(days[6] ?? state.cursor)}`;
  }
  if (state.view === 'day') return formatDayHeader(state.cursor);
  return 'All posts';
}

function toolbar(): HTMLElement {
  const showNav = state.view !== 'list';
  const nav = h(
    'div',
    { class: 'nav' },
    showNav ? button(icon('left'), 'btn btn-icon', () => navigate(-1), 'Previous') : null,
    h('span', { class: 'period', 'aria-live': 'polite' }, periodLabel()),
    showNav ? button(icon('right'), 'btn btn-icon', () => navigate(1), 'Next') : null,
    showNav ? button('Today', 'btn', () => jumpTo(today())) : null,
  );

  const views: Array<[View, string]> = [['day', 'Day'], ['week', 'Week'], ['month', 'Month']];
  const tabs = h('div', { class: 'tabs', role: 'group', 'aria-label': 'Period' });
  for (const [view, label] of views) {
    const tab = button(label, `tab${state.view === view ? ' tab-on' : ''}`, () => {
      state.view = view;
      state.gridScroll = null;
      savePrefs();
      render();
    });
    tab.setAttribute('aria-pressed', String(state.view === view));
    tabs.append(tab);
  }
  const mode = h(
    'div',
    { class: 'modes', role: 'group', 'aria-label': 'Layout' },
    button(icon('calendar'), `mode${state.view !== 'list' ? ' mode-on' : ''}`, () => {
      state.view = state.view === 'list' ? 'week' : state.view;
      state.gridScroll = null;
      savePrefs();
      render();
    }, 'Calendar'),
    button(icon('list'), `mode${state.view === 'list' ? ' mode-on' : ''}`, () => {
      state.view = 'list';
      savePrefs();
      render();
    }, 'List'),
  );
  return h('div', { class: 'toolbar' }, nav, h('div', { class: 'toolbar-right' }, state.view === 'list' ? null : tabs, mode));
}

/** Hourly grid for one day or a whole week, with a pink line at the current time. */
function timeGrid(days: string[]): HTMLElement {
  const groups = groupByDay(visiblePosts());
  const nowKey = today();
  const nowHour = hourOf(Date.now());
  const large = days.length === 1;

  const head = h(
    'div',
    { class: 'thead' },
    h('div', { class: 'corner' }),
    ...days.map((day) =>
      h(
        'div',
        { class: `thday${day === nowKey ? ' thday-today' : ''}` },
        h('span', { class: 'thday-name' }, weekdayName(day)),
        h('span', { class: 'thday-date' }, `${day === nowKey ? '● ' : ''}${formatDayHeader(day)}`),
      ),
    ),
  );

  const body = h('div', { class: 'tbody' });
  for (const hour of HOURS) {
    const isNow = hour === nowHour;
    const row = h('div', { class: 'trow' }, h('div', { class: `tlabel${isNow ? ' tlabel-now' : ''}` }, isNow ? h('span', { class: 'now-chip' }, formatTime(Date.now())) : formatHourLabel(hour)));
    for (const day of days) {
      const posts = (groups.get(day) ?? []).filter((p) => hourOf(p.date) === hour);
      const past = day < nowKey || (day === nowKey && hour < nowHour);
      const cell = h('div', { class: `tcell${past ? ' tcell-past' : ''}`, role: 'gridcell' }, ...posts.map((p) => slotPost(p, large)));
      if (day === nowKey && isNow) {
        const line = h('span', { class: 'nowline', 'aria-hidden': 'true' });
        line.style.setProperty('--at', `${(minuteOf(Date.now()) / 60) * 100}%`);
        cell.append(line);
      }
      row.append(cell);
    }
    body.append(row);
  }
  return h('div', { class: `tgrid cols-${days.length}`, role: 'grid' }, head, body);
}

/** Small screens: each day as a heading with its posts below, instead of the hourly grid. */
function stackedDays(days: string[]): HTMLElement {
  const groups = groupByDay(visiblePosts());
  const now = today();
  return h(
    'div',
    { class: 'stack' },
    ...days.map((day) => {
      const cards = (groups.get(day) ?? []).map(postCard);
      return h(
        'section',
        { class: 'list-day', 'aria-label': formatDayLabel(day) },
        h('h3', { class: 'day-head' }, formatDayLabel(day), day === now ? h('span', { class: 'today-tag' }, 'Today') : null),
        ...(cards.length ? cards : [h('p', { class: 'empty' }, 'No posts')]),
      );
    }),
  );
}

function monthView(): HTMLElement {
  const groups = groupByDay(visiblePosts());
  const now = today();
  const month = monthOf(state.cursor);
  const heads = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((day) =>
    h('div', { class: 'mhead' }, h('span', { class: 'mhead-long' }, day), h('span', { class: 'mhead-short' }, day.slice(0, 3))),
  );
  const cells = monthGrid(state.cursor)
    .flat()
    .map((day) => {
      const posts = groups.get(day) ?? [];
      const more = posts.length - MONTH_CHIPS_PER_DAY;
      const classes = ['mcell', day < now ? 'mcell-past' : '', monthOf(day) !== month ? 'mcell-out' : ''].filter(Boolean).join(' ');
      return h(
        'div',
        { class: classes },
        h('div', { class: `mnum${day === now ? ' mnum-today' : ''}` }, String(Number(day.slice(8)))),
        ...posts.slice(0, MONTH_CHIPS_PER_DAY).map(monthChip),
        more > 0 ? button(`+${more} more`, 'more', () => { state.view = 'day'; jumpTo(day); }) : null,
      );
    });
  return h('div', { class: 'month' }, ...heads, ...cells);
}

function listView(): HTMLElement {
  const groups = groupByDay(visiblePosts());
  const cutoff = addDays(today(), -LIST_DAYS_BACK);
  const days = [...groups.keys()].filter((day) => state.showEarlier || day >= cutoff);
  const hidden = groups.size - days.length;
  const now = today();
  return h(
    'div',
    { class: 'list' },
    hidden > 0 ? button(`Show ${hidden} earlier day${hidden === 1 ? '' : 's'}`, 'btn', () => { state.showEarlier = true; render(); }) : null,
    ...days.map((day) =>
      h(
        'section',
        { class: 'list-day' },
        h('h3', { class: 'day-head' }, formatDayLabel(day), day === now ? h('span', { class: 'today-tag' }, 'Today') : null),
        ...(groups.get(day) ?? []).map(postCard),
      ),
    ),
    days.length === 0 ? h('p', { class: 'empty' }, 'No posts yet') : null,
  );
}

function calendarBody(): HTMLElement {
  if (!state.data) return h('p', { class: 'empty' }, state.error ? 'Nothing to show yet.' : 'Loading…');
  if (state.view === 'month') return monthView();
  if (state.view === 'list') return listView();
  const days = state.view === 'day' ? [state.cursor] : weekDays(state.cursor);
  return narrow.matches ? stackedDays(days) : timeGrid(days);
}

function go(route: Route): void {
  state.notice = null; // a message about the last action is not about the next screen
  const hash = routeHash(route);
  if (location.hash === hash) {
    state.route = route;
    render();
  } else {
    location.hash = hash; // the hashchange listener updates the route and redraws
  }
}

/** The page a route belongs to, for the menu: a client's folder counts as Clients. */
const sectionOf = (route: Route): 'clients' | 'calendar' | 'help' => (route.page === 'client' ? 'clients' : route.page);

function rail(): HTMLElement {
  const section = sectionOf(state.route);
  const item = (name: 'clients' | 'calendar' | 'help', iconName: string, label: string): HTMLElement => {
    const route: Route = name === 'help' ? { page: 'help', channel: 'facebook' } : { page: name };
    return button([icon(iconName), h('span', {}, label)], `rail-item rail-button${section === name ? ' rail-on' : ''}`, () => go(route), label);
  };
  return h(
    'nav',
    { class: 'rail', 'aria-label': 'Main' },
    h('div', { class: 'logo', 'aria-hidden': 'true' }, 'C'),
    item('clients', 'folder', 'Clients'),
    item('calendar', 'calendar', 'Calendar'),
    h('span', { class: 'rail-spacer' }),
    item('help', 'help', 'Help'),
    button([icon('logout'), h('span', {}, 'Sign out')], 'rail-item rail-button', () => void signOut(), 'Sign out'),
  );
}

const TITLES = { clients: 'Clients', client: 'Clients', calendar: 'Calendar', help: 'Help · Connect a channel' } as const;

function clientPicker(): HTMLElement {
  const select = h('select', { class: 'btn client-select', 'aria-label': 'Client' });
  select.append(h('option', { value: '' }, 'All clients'));
  for (const client of summarizeClients(state.data ?? { generatedAt: '', channels: [], posts: [], runway: [] }, Date.now())) {
    const option = h('option', { value: client.brand }, client.label);
    if (client.brand === state.calendarClient) option.selected = true;
    select.append(option);
  }
  select.addEventListener('change', () => {
    state.calendarClient = select.value || null;
    state.channel = null;
    render();
  });
  return select;
}

function panelHeader(): HTMLElement {
  const status = state.loadedAt ? `Updated ${formatTime(state.loadedAt)}` : 'Loading…';
  const dark = currentTheme() === 'dark';
  return h(
    'header',
    { class: 'panel-head' },
    h('h1', {}, TITLES[state.route.page]),
    h(
      'div',
      { class: 'head-tools' },
      state.route.page === 'calendar' ? clientPicker() : null,
      h('span', { class: 'muted status' }, status),
      button(icon('refresh'), `btn btn-icon${state.loading ? ' spinning' : ''}`, () => void load(), 'Refresh', state.loading),
      button(icon(dark ? 'sun' : 'moon'), 'btn btn-icon', () => { setTheme(dark ? 'light' : 'dark'); render(); }, dark ? 'Switch to light theme' : 'Switch to dark theme'),
      button(icon('logout'), 'btn btn-icon only-narrow', () => void signOut(), 'Sign out'),
    ),
  );
}

/** Removes a Facebook Page or LinkedIn profile from a client after asking, then reloads the feed. */
async function disconnect(channel: ChannelHealth): Promise<void> {
  if (!channel.id) return;
  const name = channel.account ?? 'this channel';
  if (!confirm(`Disconnect ${name}? New posts will stop going to it. You can connect it again later.`)) return;
  try {
    const response = await fetch(`/api/disconnect?id=${encodeURIComponent(channel.id)}`, { method: 'POST', credentials: 'same-origin' });
    if (response.status === 401) return void location.replace('/login');
    const body: unknown = await response.json().catch(() => null);
    state.notice = response.ok ? { kind: 'ok', text: `${name} was disconnected.` } : { kind: 'warn', text: messageOf(body) ?? `Could not disconnect (${response.status}).` };
  } catch (error) {
    state.notice = { kind: 'warn', text: error instanceof Error ? error.message : String(error) };
  }
  await load();
}

/** Opens the Add channel window; with no client chosen it asks which one the channel is for. */
function openPicker(brand: string | null): void {
  const clients = summarizeClients(state.data ?? { generatedAt: '', channels: [], posts: [], runway: [] }, Date.now()).map((c) => ({ brand: c.brand, label: c.label }));
  const connected: Record<string, Platform[]> = {};
  for (const channel of state.data?.channels ?? []) for (const b of channel.brands) (connected[b] ??= []).push(channel.platform);
  picker.replaceChildren(channelPicker(brand, clients, connected, clientsContext, () => picker.close()));
  picker.showModal();
}

const clientsContext: ClientsContext = {
  go,
  openCalendar: (brand) => {
    state.calendarClient = brand;
    state.channel = null;
    go({ page: 'calendar' });
  },
  postCard,
  addChannel: openPicker,
  disconnect: (channel) => void disconnect(channel),
};

function screen(): HTMLElement {
  const data = state.data;
  const route = state.route;
  if (route.page === 'help') {
    return helpPage(route.channel, (channel) => go({ page: 'help', channel }), render);
  }
  if (route.page === 'clients' || route.page === 'client') {
    if (!data) return h('p', { class: 'empty' }, state.error ? 'Could not load the clients.' : 'Loading…');
    const clients = summarizeClients(data, Date.now());
    return route.page === 'clients'
      ? clientsPage(clients, clientsContext)
      : clientPage(clients.find((c) => c.brand === route.brand), route.tab, clientsContext);
  }
  return h('div', { class: 'panel-body' }, channelsPanel(), h('div', { class: 'cal' }, toolbar(), calendarBody()));
}

function render(): void {
  const scrolled = root.querySelector<HTMLElement>('.tbody');
  if (scrolled) state.gridScroll = scrolled.scrollTop;
  const pageScroll = window.scrollY;

  root.replaceChildren(h('div', { class: 'shell' }, rail(), h('section', { class: 'panel' }, panelHeader(), ...banners(), screen())));

  const grid = root.querySelector<HTMLElement>('.tbody');
  if (grid) grid.scrollTop = state.gridScroll ?? firstPostScroll(grid);
  window.scrollTo(0, pageScroll);
}

/** Where to start the hourly grid: just above the earliest post shown, else a little before now. */
function firstPostScroll(grid: HTMLElement): number {
  const days = state.view === 'day' ? [state.cursor] : weekDays(state.cursor);
  const hours = visiblePosts().filter((p) => days.includes(dayKeyOf(p.date))).map((p) => hourOf(p.date));
  const target = Math.max(0, (hours.length ? Math.min(...hours) : hourOf(Date.now())) - 1);
  const rowHeight = grid.querySelector<HTMLElement>('.trow')?.offsetHeight ?? 0;
  return target * rowHeight;
}

function messageOf(body: unknown): string | null {
  const message = (body as { error?: unknown } | null)?.error;
  return typeof message === 'string' ? message : null;
}

async function load(): Promise<void> {
  if (state.loading) return;
  state.loading = true;
  render();
  try {
    const response = await fetch('/api/data', { credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 401) {
      location.replace('/login');
      return;
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(messageOf(body) ?? `The server answered ${response.status}`);
    state.data = parseStatus(body);
    state.loadedAt = Date.now();
    state.error = null;
    if (state.channel && !state.data.channels.some((c) => channelKey(c) === state.channel)) state.channel = null;
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.loading = false;
    render();
  }
}

async function signOut(): Promise<void> {
  await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => undefined);
  location.replace('/login');
}

dialog.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close();
});
picker.addEventListener('click', (event) => {
  if (event.target === picker) picker.close();
});
document.addEventListener('visibilitychange', () => {
  const stale = !state.loadedAt || Date.now() - state.loadedAt > STALE_MS;
  if (document.visibilityState === 'visible' && stale) void load();
});
narrow.addEventListener('change', () => {
  state.gridScroll = null;
  render();
});

/** After coming back from Facebook or LinkedIn the address says what happened; show it once and tidy the address. */
function readNoticeFromAddress(): void {
  const query = new URLSearchParams(location.search);
  const facebook = query.get('facebook');
  const linkedin = query.get('linkedin');
  if (!facebook && !linkedin) return;
  const facebookMessages: Record<string, { kind: 'ok' | 'warn'; text: string }> = {
    connected: { kind: 'ok', text: 'Facebook connected. Posts from now on will also go to the approved Pages.' },
    denied: { kind: 'warn', text: 'Facebook was not connected: the approval was cancelled.' },
    failed: { kind: 'warn', text: 'Facebook could not be connected. Try again, and choose at least one Page you manage.' },
    expired: { kind: 'warn', text: 'The Facebook approval took longer than 30 minutes, so it was stopped. Click Add channel and start again.' },
  };
  const linkedinMessages: Record<string, { kind: 'ok' | 'warn'; text: string }> = {
    connected: { kind: 'ok', text: 'LinkedIn connected. Posts from now on will also go to that profile.' },
    denied: { kind: 'warn', text: 'LinkedIn was not connected: the approval was cancelled.' },
    failed: { kind: 'warn', text: 'LinkedIn could not be connected. Try again and press Allow.' },
  };
  state.notice = (linkedin ? linkedinMessages[linkedin] : facebookMessages[facebook ?? '']) ?? null;
  history.replaceState(null, '', location.pathname);
}

window.addEventListener('hashchange', () => {
  state.notice = null;
  state.route = parseRoute(location.hash);
  render();
});

applyStoredTheme();
readNoticeFromAddress();
loadPrefs();
render();
void load();
setInterval(() => void load(), REFRESH_MS);

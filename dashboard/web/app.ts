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
const PLATFORM_LABELS: Record<Platform, string> = { instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn' };
const PLATFORM_BADGES: Record<Platform, string> = { instagram: 'IG', facebook: 'f', linkedin: 'in' };
const STATE_HELP: Record<PostState, string> = {
  published: 'This post is live.',
  scheduled: 'Goes out automatically at the scheduled time.',
  due: 'Its time has come. It should appear within the hour.',
  missed: 'Its time passed and it is not on the account.',
  unknown: 'The account could not be checked, so its status is not known.',
};
const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS: Record<string, string[]> = {
  calendar: ['M8 2v4', 'M16 2v4', 'M3 10h18', 'M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z'],
  list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'],
  refresh: ['M21 12a9 9 0 1 1-3-6.7', 'M21 4v5h-5'],
  sun: ['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z', 'M12 2v2', 'M12 20v2', 'M4.9 4.9l1.4 1.4', 'M17.7 17.7l1.4 1.4', 'M2 12h2', 'M20 12h2', 'M4.9 19.1l1.4-1.4', 'M17.7 6.3l1.4-1.4'],
  moon: ['M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z'],
  logout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9'],
  left: ['M15 18l-6-6 6-6'],
  right: ['M9 18l6-6-6-6'],
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
};

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id} in the page`);
  return element as T;
}
const root = required<HTMLElement>('app');
const dialog = required<HTMLDialogElement>('detail');
const narrow = window.matchMedia('(max-width: 900px)');

type Child = Node | string | false | null | undefined;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) if (value !== undefined) element.setAttribute(name, value);
  for (const child of children) if (child !== false && child !== null && child !== undefined) element.append(child);
  return element;
}

function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ICONS[name] ?? []) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

function button(content: Child | Child[], className: string, onClick: () => void, label?: string, disabled = false): HTMLButtonElement {
  const element = h('button', { type: 'button', class: className, 'aria-label': label }, ...(Array.isArray(content) ? content : [content]));
  element.disabled = disabled;
  element.addEventListener('click', onClick);
  return element;
}

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
const platformLabel = (platform: Platform): string => PLATFORM_LABELS[platform];
const snippet = (caption: string, max = 90): string => shorten(caption.split('\n').find((line) => line.trim()) ?? '', max);
const channelKey = (channel: ChannelHealth): string => `${channel.platform}:${channel.account ?? channel.brands.join(',')}`;
const channelName = (channel: ChannelHealth): string => channel.account ?? platformLabel(channel.platform);
const pictureOf = (post: StatusPost): string | null =>
  safeHttpsUrl(post.image, location.origin) ?? safeHttpsUrl(post.mediaUrl, location.origin);

function channelOf(post: StatusPost): ChannelHealth | undefined {
  return state.data?.channels.find((c) => c.platform === post.platform && c.brands.includes(post.brand));
}

function visiblePosts(): StatusPost[] {
  const posts = state.data?.posts ?? [];
  const selected = state.data?.channels.find((c) => channelKey(c) === state.channel);
  return selected ? posts.filter((p) => p.platform === selected.platform && selected.brands.includes(p.brand)) : posts;
}

/** The channel's picture, or its first letter, with a small badge for the platform. */
function avatar(channel: ChannelHealth | undefined, fallback: string): HTMLElement {
  const picture = channel ? safeHttpsUrl(channel.avatar, location.origin) : null;
  const letter = (channel ? channelName(channel) : fallback).charAt(0).toUpperCase();
  return h(
    'span',
    { class: 'avatar', 'aria-hidden': 'true' },
    picture ? h('img', { src: picture, alt: '', referrerpolicy: 'no-referrer' }) : h('span', { class: 'avatar-letter' }, letter),
    channel ? h('span', { class: `badge badge-${channel.platform}` }, PLATFORM_BADGES[channel.platform]) : null,
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

function channelsPanel(): HTMLElement {
  const channels = state.data?.channels ?? [];
  const entry = (channel: ChannelHealth | null): HTMLElement => {
    const key = channel ? channelKey(channel) : null;
    const on = state.channel === key;
    const item = h(
      'button',
      { type: 'button', class: `channel${on ? ' channel-on' : ''}`, 'aria-pressed': String(on) },
      channel ? avatar(channel, '?') : h('span', { class: 'avatar avatar-all', 'aria-hidden': 'true' }, h('span', { class: 'avatar-letter' }, '∗')),
      h(
        'span',
        { class: 'channel-text' },
        h('span', { class: 'channel-name' }, channel ? channelName(channel) : 'All channels'),
        h('span', { class: 'channel-sub' }, channel ? `${platformLabel(channel.platform)} · ${channel.brands.map(brandLabel).join(', ')}` : `${channels.length} connected`),
      ),
      channel ? h('span', { class: `health ${channel.ok ? 'health-ok' : 'health-bad'}`, title: channel.ok ? 'Connected' : 'Connection problem' }) : null,
    );
    item.addEventListener('click', () => {
      state.channel = key;
      savePrefs();
      render();
    });
    return item;
  };

  const posts = visiblePosts();
  const count = (...states: PostState[]): number => posts.filter((p) => states.includes(p.state)).length;
  const stat = (label: string, value: number, kind: string): HTMLElement =>
    h('div', { class: `stat stat-${kind}` }, h('span', { class: 'stat-value' }, String(value)), h('span', { class: 'stat-label' }, label));
  const selected = channels.find((c) => channelKey(c) === state.channel);
  const runway = (state.data?.runway ?? []).filter((r) => !selected || selected.brands.includes(r.brand));

  return h(
    'aside',
    { class: 'channels', 'aria-label': 'Channels' },
    h('h2', { class: 'panel-title' }, 'Channels'),
    h('div', { class: 'channel-list' }, entry(null), ...channels.map(entry)),
    h('h2', { class: 'panel-title panel-title-sub' }, 'Overview'),
    h('div', { class: 'stats' }, stat('Published', count('published'), 'published'), stat('Scheduled', count('scheduled', 'due'), 'scheduled'), stat('Needs attention', count('missed', 'unknown'), 'missed')),
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

function rail(): HTMLElement {
  return h(
    'nav',
    { class: 'rail', 'aria-label': 'Main' },
    h('div', { class: 'logo', 'aria-hidden': 'true' }, 'C'),
    h('div', { class: 'rail-item rail-on' }, icon('calendar'), h('span', {}, 'Calendar')),
    h('span', { class: 'rail-spacer' }),
    button([icon('logout'), h('span', {}, 'Sign out')], 'rail-item rail-button', () => void signOut(), 'Sign out'),
  );
}

function panelHeader(): HTMLElement {
  const status = state.loadedAt ? `Updated ${formatTime(state.loadedAt)}` : 'Loading…';
  const dark = currentTheme() === 'dark';
  return h(
    'header',
    { class: 'panel-head' },
    h('h1', {}, 'Calendar'),
    h(
      'div',
      { class: 'head-tools' },
      h('span', { class: 'muted status' }, status),
      button(icon('refresh'), `btn btn-icon${state.loading ? ' spinning' : ''}`, () => void load(), 'Refresh', state.loading),
      button(icon(dark ? 'sun' : 'moon'), 'btn btn-icon', () => { setTheme(dark ? 'light' : 'dark'); render(); }, dark ? 'Switch to light theme' : 'Switch to dark theme'),
      button(icon('logout'), 'btn btn-icon only-narrow', () => void signOut(), 'Sign out'),
    ),
  );
}

function render(): void {
  const scrolled = root.querySelector<HTMLElement>('.tbody');
  if (scrolled) state.gridScroll = scrolled.scrollTop;
  const pageScroll = window.scrollY;

  root.replaceChildren(
    h(
      'div',
      { class: 'shell' },
      rail(),
      h('section', { class: 'panel' }, panelHeader(), ...banners(), h('div', { class: 'panel-body' }, channelsPanel(), h('div', { class: 'cal' }, toolbar(), calendarBody()))),
    ),
  );

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
document.addEventListener('visibilitychange', () => {
  const stale = !state.loadedAt || Date.now() - state.loadedAt > STALE_MS;
  if (document.visibilityState === 'visible' && stale) void load();
});
narrow.addEventListener('change', () => {
  state.gridScroll = null;
  render();
});

applyStoredTheme();
loadPrefs();
render();
void load();
setInterval(() => void load(), REFRESH_MS);

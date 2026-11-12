/** The Analytics tab of a client: the numbers the networks give for its accounts and posts. Read only. */
import { dailySeries, followersNow, formatCount, sumAccounts, type AnalyticsAccount, type AnalyticsData, type AnalyticsPlatform, type AnalyticsPost } from '../shared/analytics.ts';
import type { ClientSummary } from './clients.ts';
import { button, h, logo } from './ui.ts';

export interface AnalyticsContext {
  /** Asks the server for this client's numbers for the last `days` days. */
  loadAnalytics(brand: string, days: number): Promise<AnalyticsData>;
  /** Asks the server to read this client's numbers from the networks again now; resolves to an explanation when it could not. */
  refreshAnalytics(brand: string): Promise<string | null>;
}

const RANGES = [7, 30, 90] as const;
const PLATFORM_LABEL: Record<AnalyticsPlatform, string> = { instagram: 'Instagram', facebook: 'Facebook', google: 'Google' };
const CAPTION_MAX = 60;

type Section = 'overview' | 'posts' | 'audience' | 'hashtags';
const SECTIONS: ReadonlyArray<[Section, string]> = [['overview', 'Overview'], ['posts', 'Posts'], ['audience', 'Audience'], ['hashtags', 'Hashtags']];

/** What each client was last looking at, so a refresh of the feed does not send them back to the start. */
const looking = new Map<string, { days: number; section: Section; off: Set<AnalyticsPlatform> }>();

const stat = (label: string, value: number | undefined, note: string): HTMLElement =>
  h('div', { class: 'stat' }, h('small', {}, label), h('b', { class: value === undefined ? 'na' : '' }, formatCount(value)), h('small', {}, note));

function titleOf(post: AnalyticsPost): string {
  const line = post.caption.split('\n').find((l) => l.trim()) ?? post.postId;
  return line.length > CAPTION_MAX ? `${line.slice(0, CAPTION_MAX - 1)}…` : line;
}

const tag = (platform: AnalyticsPlatform): HTMLElement => h('span', { class: 'an-tag' }, logo(platform), PLATFORM_LABEL[platform]);

function bars(rows: Array<{ label: string; value: number }>, unit = ''): HTMLElement {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return h(
    'div',
    { class: 'an-bars' },
    ...rows.map((r) => {
      const fill = h('b', {});
      fill.style.setProperty('--w', `${(r.value / max) * 100}%`);
      return h('div', { class: 'an-bar' }, h('span', {}, r.label), h('div', { class: 'an-track' }, fill), h('span', { class: 'num' }, `${r.value.toLocaleString('en-US')}${unit}`));
    }),
  );
}

function chart(series: Array<{ date: string; value: number }>): HTMLElement {
  if (series.length === 0) return h('p', { class: 'empty' }, 'No daily numbers yet.');
  const max = Math.max(1, ...series.map((s) => s.value));
  const wrap = h('div', { class: 'an-chart', role: 'img', 'aria-label': `Reach per day, ${series.length} days` });
  for (const s of series) {
    const bar = h('i', { title: `${s.date}: ${s.value.toLocaleString('en-US')}` });
    bar.style.setProperty('--h', `${Math.max(3, (s.value / max) * 100)}%`);
    wrap.append(bar);
  }
  return h('div', {}, wrap, h('div', { class: 'an-axis' }, h('span', {}, series[0]?.date ?? ''), h('span', {}, series[series.length - 1]?.date ?? '')));
}

function reconnectNotes(accounts: readonly AnalyticsAccount[]): HTMLElement[] {
  return accounts
    .filter((a) => a.needs?.includes('reconnect'))
    .map((a) => h('p', { class: 'banner banner-warn', role: 'status' }, `${PLATFORM_LABEL[a.platform]} (${a.label}): connect this account again to give permission to read its numbers. Until then only likes, comments and followers show.`));
}

function overview(data: AnalyticsData, accounts: AnalyticsAccount[], posts: AnalyticsPost[]): HTMLElement {
  const social = accounts.filter((a) => a.platform !== 'google');
  const google = accounts.filter((a) => a.platform === 'google');
  const sum = (key: 'likes' | 'comments' | 'shares' | 'saves'): number | undefined => {
    const given = posts.map((p) => p.total[key]).filter((v): v is number => v !== undefined);
    return given.length === 0 ? undefined : given.reduce((a, b) => a + b, 0);
  };
  const byChannel = accounts.map((a) => ({ label: `${PLATFORM_LABEL[a.platform]} · ${a.label}`, value: (a.platform === 'google' ? sumAccounts([a], 'views') : sumAccounts([a], 'reach')) ?? 0 }));
  const best = [...posts].sort((a, b) => (b.total.reach ?? b.total.likes ?? 0) - (a.total.reach ?? a.total.likes ?? 0)).slice(0, 3);
  return h(
    'div',
    { class: 'an-stack' },
    h(
      'div',
      { class: 'stats' },
      stat('Reach', sumAccounts(social, 'reach'), 'Instagram and Facebook'),
      stat('Followers now', followersNow(social), 'all accounts'),
      stat('Likes and reactions', sum('likes'), 'on posts made in this period'),
      stat('Comments', sum('comments'), 'on posts made in this period'),
    ),
    google.length > 0 ? h('div', { class: 'stats' }, stat('Google: views', sumAccounts(google, 'views'), 'Maps and Search'), stat('Google: calls', sumAccounts(google, 'calls'), 'taps on call'), stat('Google: directions', sumAccounts(google, 'directions'), 'requests'), stat('Google: website clicks', sumAccounts(google, 'websiteClicks'), 'taps')) : null,
    h('div', { class: 'panel-card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Reach per day')), chart(dailySeries(social, 'reach'))),
    h('div', { class: 'panel-card' }, h('div', { class: 'card-head' }, h('h2', {}, 'By channel')), byChannel.length === 0 ? h('p', { class: 'empty' }, 'Nothing yet.') : bars(byChannel), google.length > 0 ? h('p', { class: 'muted' }, 'Google shows how people found the business on Google (views), not post reach.') : null),
    h('div', { class: 'panel-card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Best posts')), best.length === 0 ? h('p', { class: 'empty' }, 'No posts with numbers yet.') : h('div', { class: 'an-best' }, ...best.map((p) => h('div', {}, tag(p.platform), ' ', titleOf(p), ' ', h('span', { class: 'muted' }, p.total.reach !== undefined ? `reach ${formatCount(p.total.reach)}` : `likes ${formatCount(p.total.likes)}`))))),
    google.flatMap((a) => a.searchTerms ?? []).length > 0 ? h('div', { class: 'panel-card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Google: what people searched')), bars(google.flatMap((a) => a.searchTerms ?? []).slice(0, 10).map((t) => ({ label: t.term, value: t.impressions })))) : null,
  );
}

function postsTable(posts: AnalyticsPost[]): HTMLElement {
  if (posts.length === 0) return h('div', { class: 'panel-card' }, h('p', { class: 'empty' }, 'No posts in this period have numbers yet. Google posts never have any: Google does not give numbers for single posts.'));
  const num = (v: number | undefined): HTMLElement => h('td', { class: `num${v === undefined ? ' na' : ''}` }, v === undefined ? '–' : v.toLocaleString('en-US'));
  return h(
    'div',
    { class: 'panel-card' },
    h('div', { class: 'table-scroll' }, h('table', { class: 'cost-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Post'), h('th', {}, 'Channel'), ...['Reach', 'Likes', 'Comments', 'Shares', 'Saves', 'Clicks'].map((t) => h('th', { class: 'num' }, t)))),
      h('tbody', {}, ...posts.map((p) => h('tr', {}, h('td', {}, p.permalink ? h('a', { href: p.permalink, target: '_blank', rel: 'noopener noreferrer' }, titleOf(p)) : titleOf(p), h('div', { class: 'muted' }, p.postedAt.slice(0, 10))), h('td', {}, tag(p.platform)), num(p.total.reach), num(p.total.likes), num(p.total.comments), num(p.total.shares), num(p.total.saves), num(p.total.clicks)))),
    )),
    h('p', { class: 'fineprint' }, 'A dash means the network does not give that number.'),
  );
}

function audience(accounts: AnalyticsAccount[]): HTMLElement {
  const ig = accounts.filter((a) => a.platform === 'instagram');
  const blocks: HTMLElement[] = [];
  for (const a of ig) {
    if (a.needs?.includes('followers')) blocks.push(h('p', { class: 'banner', role: 'status' }, `${a.label}: not enough followers yet. Instagram shows who follows an account once it has 100 followers.`));
    const parts: Array<[string, Record<string, number> | undefined]> = [['Age', a.audience?.age], ['Gender', a.audience?.gender], ['Countries', a.audience?.country], ['Cities', a.audience?.city]];
    for (const [title, values] of parts) {
      if (!values) continue;
      blocks.push(h('div', { class: 'panel-card' }, h('div', { class: 'card-head' }, h('h2', {}, `${title} · ${a.label}`)), bars(Object.entries(values).sort(([, x], [, y]) => y - x).slice(0, 8).map(([label, value]) => ({ label, value })))));
    }
  }
  return h('div', { class: 'an-stack' }, ...blocks, blocks.length === 0 ? h('div', { class: 'panel-card' }, h('p', { class: 'empty' }, 'No audience numbers yet.')) : null, h('p', { class: 'fineprint' }, 'Only Instagram gives the audience (with 100 or more followers). Facebook gives very little, and Google and LinkedIn give none.'));
}

function hashtags(data: AnalyticsData): HTMLElement {
  return h(
    'div',
    { class: 'panel-card' },
    data.hashtags.length === 0
      ? h('p', { class: 'empty' }, 'No hashtags used in this period.')
      : h('div', { class: 'table-scroll' }, h('table', { class: 'cost-table' }, h('thead', {}, h('tr', {}, h('th', {}, 'Hashtag'), h('th', { class: 'num' }, 'Posts'), h('th', { class: 'num' }, 'Average reach'))), h('tbody', {}, ...data.hashtags.map((t) => h('tr', {}, h('td', {}, t.tag), h('td', { class: 'num' }, String(t.posts)), h('td', { class: 'num' }, t.avgReach.toLocaleString('en-US'))))))),
    h('p', { class: 'fineprint' }, 'Worked out by us from this client’s own posts: the average reach of the posts that used each hashtag. The networks do not give hashtag numbers themselves.'),
  );
}

export function analyticsPage(client: ClientSummary, ctx: AnalyticsContext): HTMLElement {
  const root = h('div', { class: 'cost-page' });
  const state = looking.get(client.brand) ?? { days: 30, section: 'overview' as Section, off: new Set<AnalyticsPlatform>() };
  looking.set(client.brand, state);
  let data: AnalyticsData | null = null;
  let problem: string | null = null;
  let refreshing = false;
  let refreshNote: string | null = null;

  const draw = (): void => {
    const head = h(
      'div',
      { class: 'stat-head' },
      h('h3', {}, 'Analytics'),
      h('span', { class: 'an-controls' },
        ...(['instagram', 'facebook', 'google'] as const).map((p) => button(PLATFORM_LABEL[p], `chip${state.off.has(p) ? '' : ' chip-on'}`, () => { if (state.off.has(p)) state.off.delete(p); else state.off.add(p); draw(); }, `Show ${PLATFORM_LABEL[p]}`)),
        button(refreshing ? 'Refreshing…' : 'Refresh now', 'btn', () => void refresh(), 'Read the numbers from the networks again now', refreshing),
        ...RANGES.map((d) => button(`${d} days`, `chip${state.days === d ? ' chip-on' : ''}`, () => { state.days = d; void load(); })),
      ),
    );
    const tabs = h('div', { class: 'ctabs', role: 'tablist' }, ...SECTIONS.map(([key, label]) => button(label, `ctab${state.section === key ? ' ctab-on' : ''}`, () => { state.section = key; draw(); })));
    if (problem !== null) return void root.replaceChildren(head, h('p', { class: 'banner banner-warn', role: 'alert' }, problem));
    if (data === null) return void root.replaceChildren(head, h('p', { class: 'muted' }, 'Loading the numbers…'));
    const accounts = data.accounts.filter((a) => !state.off.has(a.platform));
    const posts = data.posts.filter((p) => !state.off.has(p.platform));
    const body = !data.enabled
      ? h('div', { class: 'panel-card' }, h('p', { class: 'empty' }, 'Analytics is switched off on the server, so no numbers are being collected yet.'))
      : data.accounts.length === 0
        ? h('div', { class: 'panel-card' }, h('p', { class: 'empty' }, 'No numbers yet.'), h('p', { class: 'muted' }, 'They appear after the first daily check, once this client has an Instagram, Facebook or Google account connected.'))
        : state.section === 'overview' ? overview(data, accounts, posts) : state.section === 'posts' ? postsTable(posts) : state.section === 'audience' ? audience(accounts) : hashtags(data);
    root.replaceChildren(head, ...(refreshNote ? [h('p', { class: 'banner banner-ok', role: 'status' }, refreshNote)] : []), ...(data.enabled ? reconnectNotes(accounts) : []), tabs, body, h('p', { class: 'fineprint' }, data.checkedAt ? `Numbers come from each network once a day. Last check: ${data.checkedAt.replace('T', ' ').slice(0, 16)} UTC.` : 'Numbers come from each network once a day.'));
  };

  /** Reads the numbers again on the server (it skips anything read in the last few minutes), then shows what it has. */
  const refresh = async (): Promise<void> => {
    if (refreshing) return;
    refreshing = true;
    refreshNote = null;
    draw();
    const problemText = await ctx.refreshAnalytics(client.brand);
    refreshing = false;
    if (problemText) {
      refreshNote = null;
      problem = problemText;
      draw();
      return;
    }
    await load();
    refreshNote = 'Numbers refreshed. Anything the networks already gave in the last few minutes was not asked again.';
    draw();
  };

  const load = async (): Promise<void> => {
    data = null;
    problem = null;
    draw();
    try {
      data = await ctx.loadAnalytics(client.brand, state.days);
    } catch (error) {
      problem = error instanceof Error ? error.message : 'The numbers could not be loaded.';
    }
    draw();
  };
  void load();
  return root;
}

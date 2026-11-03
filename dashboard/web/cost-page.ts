/** The Cost tab of a client: what the AI cost this month, where it went, and what each post cost. */
import type { StatusPost } from '../shared/status.ts';
import { formatDateTime, formatMonth } from './calendar.ts';
import type { ClientSummary } from './clients.ts';
import { costView, formatUsd, pageOf, type CostRow } from './cost.ts';
import { button, h } from './ui.ts';

export const COST_PAGE_SIZE = 10;
const TITLE_MAX = 70;

export interface CostContext {
  /** The post's picture as a small thumbnail. */
  postThumb(post: StatusPost): HTMLElement;
}

const monthName = (month: string): string => formatMonth(`${month}-01`);

function titleOf(post: StatusPost | null, id: string): string {
  const line = post?.caption.split('\n').find((l) => l.trim());
  if (!line) return id;
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

function stat(label: string, value: string, note: string): HTMLElement {
  return h('div', { class: 'stat' }, h('small', {}, label), h('b', {}, value), h('small', {}, note));
}

function splitBar(split: { pictureUsd: number; writingUsd: number; profileUsd: number }): HTMLElement[] {
  const parts = [
    { key: 'pic', label: 'Pictures', usd: split.pictureUsd },
    { key: 'txt', label: 'Writing posts', usd: split.writingUsd },
    { key: 'prof', label: 'Reading the website', usd: split.profileUsd },
  ];
  const total = parts.reduce((a, p) => a + p.usd, 0);
  const percent = (usd: number): number => (total > 0 ? (usd / total) * 100 : 0);
  const bar = h('div', { class: 'split', role: 'img', 'aria-label': parts.map((p) => `${p.label} ${Math.round(percent(p.usd))} percent`).join(', ') });
  for (const p of parts) {
    const segment = h('span', { class: `seg-${p.key}` });
    segment.style.setProperty('--w', `${percent(p.usd)}%`);
    bar.append(segment);
  }
  const legend = h('div', { class: 'legend' }, ...parts.map((p) => h('span', {}, h('i', { class: `dot-${p.key}` }), `${p.label} ${formatUsd(p.usd)}`)));
  return [bar, legend];
}

function rowElement(row: CostRow, ctx: CostContext): HTMLElement {
  const cell = (text: string): HTMLElement => h('td', { class: 'num' }, text);
  const when = row.post ? formatDateTime(row.post.date) : 'Plan no longer listed';
  return h(
    'tr',
    {},
    h('td', {}, h('div', { class: 'post-cell' }, row.post ? ctx.postThumb(row.post) : h('div', { class: 'thumb thumb-empty' }, 'No image'), h('div', {}, h('b', {}, titleOf(row.post, row.id)), h('small', {}, when)))),
    cell(formatUsd(row.pictureUsd)),
    cell(formatUsd(row.writingUsd)),
    cell(formatUsd(row.totalUsd)),
  );
}

/** Which month and page each client was last looking at, so a refresh of the feed does not send them back to the start. */
const looking = new Map<string, { month: string | null; page: number }>();

export function costPage(client: ClientSummary, ctx: CostContext): HTMLElement {
  const root = h('div', { class: 'cost-page' });
  const draw = (): void => {
    const where = looking.get(client.brand) ?? { month: null, page: 1 };
    const view = costView(client.costs, client.posts, client.brand, where.month);
    if (view.month === null) {
      root.replaceChildren(
        h('div', { class: 'panel-card' }, h('p', { class: 'empty' }, 'No AI cost recorded yet.'), h('p', { class: 'muted' }, 'It appears here after the next time posts are made for this client.')),
      );
      return;
    }
    const pageInfo = pageOf(view.rows, where.page, COST_PAGE_SIZE);
    const move = (month: string | null, page: number): void => {
      looking.set(client.brand, { month, page });
      draw();
    };

    const monthPicker = h('select', { class: 'month-pick', 'aria-label': 'Month' }, ...view.months.map((m) => h('option', { value: m }, monthName(m))));
    monthPicker.value = view.month;
    monthPicker.addEventListener('change', () => move(monthPicker.value, 1));

    const buttons = h(
      'span',
      { class: 'pager-buttons' },
      button('Previous', '', () => move(view.month, pageInfo.page - 1), 'Previous page', pageInfo.page === 1),
      ...Array.from({ length: pageInfo.pages }, (_, i) => {
        const number = i + 1;
        const b = button(String(number), '', () => move(view.month, number), `Page ${number}`);
        if (number === pageInfo.page) b.setAttribute('aria-current', 'page');
        return b;
      }),
      button('Next', '', () => move(view.month, pageInfo.page + 1), 'Next page', pageInfo.page === pageInfo.pages),
    );

    root.replaceChildren(
      h('div', { class: 'stat-head' }, h('h3', {}, 'AI cost'), monthPicker),
      h(
        'div',
        { class: 'stats' },
        stat('This month', formatUsd(view.monthUsd), 'estimated'),
        stat('Posts made', String(view.postsMade), 'this month'),
        stat('Average per post', view.averageUsd === null ? '–' : formatUsd(view.averageUsd), 'picture and writing'),
        stat('Since the start', formatUsd(view.allTimeUsd), 'all months'),
      ),
      h('div', { class: 'panel-card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Where it goes')), ...splitBar(view.split)),
      h(
        'div',
        { class: 'panel-card' },
        h('div', { class: 'card-head' }, h('h2', {}, 'Cost per post'), h('span', { class: 'muted' }, `${view.postsMade} post${view.postsMade === 1 ? '' : 's'} in ${monthName(view.month)}`)),
        view.rows.length === 0
          ? h('p', { class: 'empty' }, 'No posts were made this month.')
          : h(
              'div',
              { class: 'table-scroll' },
              h(
                'table',
                { class: 'cost-table' },
                h('thead', {}, h('tr', {}, h('th', {}, 'Post'), h('th', { class: 'num' }, 'Picture'), h('th', { class: 'num' }, 'Writing'), h('th', { class: 'num' }, 'Total'))),
                h('tbody', {}, ...pageInfo.items.map((row) => rowElement(row, ctx))),
                h(
                  'tfoot',
                  {},
                  h('tr', { class: 'total-row' }, h('td', {}, `All ${view.postsMade} post${view.postsMade === 1 ? '' : 's'} this month`), h('td', { class: 'num' }, formatUsd(view.split.pictureUsd)), h('td', { class: 'num' }, formatUsd(view.split.writingUsd)), h('td', { class: 'num' }, formatUsd(view.split.pictureUsd + view.split.writingUsd))),
                ),
              ),
            ),
        view.rows.length > 0
          ? h('div', { class: 'pager', role: 'navigation', 'aria-label': 'Pages of posts' }, h('span', { class: 'muted' }, `Showing ${pageInfo.from} to ${pageInfo.to} of ${view.rows.length}`), buttons)
          : null,
      ),
      h('p', { class: 'fineprint' }, 'Costs are estimates from OpenAI’s token counts and published prices. Your OpenAI usage page is the real bill. Posts made before this view existed show no cost.'),
    );
  };
  draw();
  return root;
}

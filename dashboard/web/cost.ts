import type { CostEntry, StatusPost } from '../shared/status.ts';
import { dayKeyOf } from './calendar.ts';

/** What one client's AI spending looks like for a month, worked out from the status feed's cost entries. */
export interface CostRow {
  /** The post's id; the post itself is null when its plan is no longer in the feed. */
  id: string;
  post: StatusPost | null;
  pictureUsd: number;
  writingUsd: number;
  totalUsd: number;
}

export interface CostView {
  /** Months ("2026-11") with any spending, newest first. */
  months: string[];
  /** The month shown; null when nothing has been spent. */
  month: string | null;
  monthUsd: number;
  postsMade: number;
  /** Picture and writing per post this month; null with no posts. */
  averageUsd: number | null;
  allTimeUsd: number;
  split: { pictureUsd: number; writingUsd: number; profileUsd: number };
  /** Newest post first. */
  rows: CostRow[];
}

const round = (dollars: number): number => Math.round(dollars * 1e8) / 1e8;
const sum = (values: number[]): number => round(values.reduce((a, b) => a + b, 0));
const monthOf = (entry: CostEntry): string => dayKeyOf(entry.at).slice(0, 7);

export function costView(costs: readonly CostEntry[], posts: readonly StatusPost[], brand: string, month: string | null): CostView {
  const mine = costs.filter((c) => c.brand === brand);
  const months = [...new Set(mine.map(monthOf))].sort().reverse();
  const shown = month && months.includes(month) ? month : (months[0] ?? null);
  const inMonth = mine.filter((c) => monthOf(c) === shown);
  const by = (purpose: CostEntry['purpose']): number => sum(inMonth.filter((c) => c.purpose === purpose).map((c) => c.usd));

  const postsById = new Map(posts.map((p) => [p.id, p]));
  const ids = [...new Set(inMonth.flatMap((c) => (c.post ? [c.post] : [])))];
  const sortKey = (id: string): number => Date.parse(postsById.get(id)?.date ?? inMonth.find((c) => c.post === id)?.at ?? '');
  const rows = ids
    .map((id): CostRow => {
      const forPost = (purpose: CostEntry['purpose']): number => sum(inMonth.filter((c) => c.post === id && c.purpose === purpose).map((c) => c.usd));
      const pictureUsd = forPost('picture');
      const writingUsd = forPost('writing');
      return { id, post: postsById.get(id) ?? null, pictureUsd, writingUsd, totalUsd: round(pictureUsd + writingUsd) };
    })
    .sort((a, b) => sortKey(b.id) - sortKey(a.id));

  const split = { pictureUsd: by('picture'), writingUsd: by('writing'), profileUsd: by('profile') };
  const perPostTotal = round(split.pictureUsd + split.writingUsd);
  return {
    months,
    month: shown,
    monthUsd: round(split.pictureUsd + split.writingUsd + split.profileUsd),
    postsMade: rows.length,
    averageUsd: rows.length ? round(perPostTotal / rows.length) : null,
    allTimeUsd: sum(mine.map((c) => c.usd)),
    split,
    rows,
  };
}

/** "$0.0138" for amounts under a dollar, "$12.35" above; zero is "$0.00". */
export function formatUsd(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export interface Page<T> {
  items: T[];
  page: number;
  pages: number;
  /** 1-based position of the first and last item shown; 0 when there are none. */
  from: number;
  to: number;
}

/** One page of a list; a page number outside the list is pulled to the nearest real page. */
export function pageOf<T>(list: readonly T[], page: number, size: number): Page<T> {
  const pages = Math.max(1, Math.ceil(list.length / size));
  const current = Math.min(Math.max(1, Math.trunc(page) || 1), pages);
  const start = (current - 1) * size;
  const items = list.slice(start, start + size);
  return { items, page: current, pages, from: items.length ? start + 1 : 0, to: start + items.length };
}

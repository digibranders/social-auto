/**
 * The status panel, bottom right: what is being made for each client's plans, which step it is on, how far along it is, roughly how long is left and what it
 * costs. It lives outside the page the app redraws, so a redraw never wipes it, and it asks the review service for the runner's records on its own: quickly
 * while something is being made, slowly otherwise. What it says comes from `shared/campaigns.ts`. It only reads; nothing here changes anything.
 */
import { parseCampaigns, planKey, statusItems, type CalendarPost, type Campaign, type ClientForStatus, type StatusItem } from '../shared/campaigns.ts';
import { button, h, icon } from './ui.ts';

const FAST_MS = 5_000;
const SLOW_MS = 30_000;
const STORE = { collapsed: 'makeStatus.collapsed', dismissed: 'makeStatus.dismissed', firstSeen: 'makeStatus.firstSeen' } as const;

export interface MakeStatusDeps {
  /** The clients with their plans, as the dashboard knows them now. */
  clients(): ClientForStatus[];
  /** The posts on the calendar now, or undefined while the dashboard has not loaded them. */
  calendar(): readonly CalendarPost[] | undefined;
  /** Goes to the Review page. */
  openReview(): void;
}

/** Browser storage may be blocked or full; the panel works the same without it. */
function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // not remembered; nothing else depends on it
  }
}

const active = (item: StatusItem): boolean => item.state === 'waiting' || item.state === 'working' || item.state === 'stalled' || item.state === 'unplaced';

function stepsRow(item: StatusItem): HTMLElement {
  return h('ol', { class: 'make-steps', 'aria-label': 'Steps' },
    ...item.steps.map((step) => h('li', { class: `make-step make-step-${step.state}`, ...(step.state === 'now' ? { 'aria-current': 'step' } : {}) }, h('span', { class: 'make-dot', 'aria-hidden': 'true' }), h('span', { class: 'make-step-label' }, step.label))),
  );
}

function itemView(item: StatusItem, dismiss: (item: StatusItem) => void, openReview: () => void): HTMLElement {
  const bar = h('div', { class: 'make-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(item.percent), 'aria-label': `${item.title}, ${item.percent}%` }, h('span', {}));
  (bar.firstElementChild as HTMLElement).style.width = `${item.percent}%`;
  return h('section', { class: `make-item make-${item.state}` },
    h('div', { class: 'make-top' },
      h('b', { class: 'make-name' }, item.title),
      active(item) ? null : button('×', 'make-x', () => dismiss(item), `Dismiss: ${item.title}`),
    ),
    h('p', { class: 'make-sub' }, item.subtitle),
    bar,
    h('p', { class: 'make-head' }, item.headline),
    item.detail ? h('p', { class: 'make-detail' }, item.detail) : null,
    stepsRow(item),
    item.eta || item.state === 'working' || item.state === 'waiting' ? h('p', { class: 'make-meta' }, [item.eta, `cost ${item.cost}`].filter(Boolean).join(' · ')) : h('p', { class: 'make-meta' }, `Cost ${item.cost}`),
    item.note ? h('p', { class: 'make-note' }, item.note) : null,
    item.failure ? h('p', { class: 'make-failure', role: item.state === 'failed' ? 'alert' : undefined }, item.failure) : null,
    item.state === 'review' ? button('Open Review', 'btn btn-primary make-open', openReview) : null,
  );
}

/** Starts the panel. Call `refresh()` whenever the dashboard's own data changes, so the plans shown are the current ones. */
export function startMakeStatus(deps: MakeStatusDeps): { refresh(): void } {
  const panel = h('aside', { class: 'make-panel', 'aria-label': 'Posters being made', hidden: 'hidden' });
  document.body.append(panel);

  let campaigns: Campaign[] = [];
  /** False when the review service is not set up on this server: there is nothing to say, so the panel stays away rather than claim a plan is stuck. */
  let available = true;
  let collapsed = read<boolean>(STORE.collapsed, false);
  const dismissed = new Set<string>(read<string[]>(STORE.dismissed, []));
  const firstSeen = read<Record<string, number>>(STORE.firstSeen, {});
  let timer: number | undefined;

  const dismissKey = (item: StatusItem): string => `${item.key}|${item.updatedAt}`;

  function items(): StatusItem[] {
    if (!available) return [];
    const now = Date.now();
    const all = statusItems(deps.clients(), campaigns, now, (key) => firstSeen[key], deps.calendar());
    // Remember when a plan was first seen waiting (or approved and not yet on the calendar); forget plans that no longer are.
    const waiting = new Set(all.filter((i) => i.state === 'waiting' || i.state === 'stalled').map((i) => i.key));
    for (const i of all) if (i.state === 'approved' || i.state === 'unplaced') waiting.add(`${i.key}|gap`);
    let changed = false;
    for (const key of waiting) if (firstSeen[key] === undefined) { firstSeen[key] = now; changed = true; }
    for (const key of Object.keys(firstSeen)) if (!waiting.has(key)) { delete firstSeen[key]; changed = true; }
    if (changed) write(STORE.firstSeen, firstSeen);
    return all.filter((i) => active(i) || !dismissed.has(dismissKey(i)));
  }

  function draw(): void {
    const shown = items();
    panel.hidden = shown.length === 0;
    if (shown.length === 0) return;
    const busy = shown.filter(active).length;
    panel.classList.toggle('make-collapsed', collapsed);
    const toggle = button(
      [h('span', { class: 'make-title' }, busy > 0 ? 'Making posters' : 'Posters'), h('span', { class: 'make-count' }, String(shown.length)), icon(collapsed ? 'left' : 'down')],
      'make-toggle',
      () => { collapsed = !collapsed; write(STORE.collapsed, collapsed); draw(); },
      collapsed ? 'Show what is being made' : 'Hide what is being made',
    );
    toggle.setAttribute('aria-expanded', String(!collapsed));
    panel.replaceChildren(
      toggle,
      ...(collapsed ? [] : [h('div', { class: 'make-body' }, ...shown.map((item) => itemView(item, (done) => { dismissed.add(dismissKey(done)); write(STORE.dismissed, [...dismissed].slice(-50)); draw(); }, deps.openReview)))]),
    );
  }

  async function poll(): Promise<void> {
    try {
      const response = await fetch('/api/review?view=campaigns', { credentials: 'same-origin', cache: 'no-store' });
      if (response.status === 503) available = false;
      else if (response.ok) {
        available = true;
        campaigns = parseCampaigns(await response.json().catch(() => null));
      }
    } catch {
      // The network is down for a moment: keep what was last known.
    }
    draw();
    timer = window.setTimeout(() => void poll(), items().some(active) ? FAST_MS : SLOW_MS);
  }

  void poll();
  return {
    refresh: () => {
      draw();
      // A plan was just added or removed: look again soon instead of waiting out a slow turn.
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void poll(), 1_000);
    },
  };
}

/** For tests and callers that need the same key the panel uses. */
export { planKey };

/** The Clients screens: a folder per client, and inside each its channels and what is coming up. */
import { PLATFORMS, WEEKDAYS, type BrandsStatus, type ChannelHealth, type Platform, type PostingDaysData, type StatusPost, type Weekday } from '../shared/status.ts';
import { connectedPlatforms, planPayload, planSentence } from '../shared/posting-plan.ts';
import { planFields } from './add-client.ts';
import { MAX_WEEKLY_LIMIT } from '../shared/quota.ts';
import { AUTO_WARNING, SPEND_CAP_DEFAULT_USD, spentThisMonth, websiteHost, type ClientSummary } from './clients.ts';
import { analyticsPage, type AnalyticsContext } from './analytics-page.ts';
import { autoDmPanel } from './autodm-page.ts';
import { costPage } from './cost-page.ts';
import { clientOption, dropdown } from './dropdown.ts';
import { postChannelId } from './new-post.ts';
import { stateLabel } from './calendar.ts';
import type { ClientTab, GuideKey, Route } from './route.ts';
import { brandMark, button, channelName, h, icon, statusMark, type ChannelKind } from './ui.ts';

export interface ClientsContext extends AnalyticsContext {
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
  /** Adds one more posting plan to the client; resolves to an explanation when it could not be added. */
  addPlan(client: ClientSummary, plan: Record<string, unknown>): Promise<string | null>;
  /** Takes the plan at this place off the client; resolves to an explanation when it could not be. */
  removePlan(client: ClientSummary, index: number): Promise<string | null>;
  /** Changes how many posters a week the website may make for each channel of the client. */
  setLimit(client: ClientSummary, limit: number): Promise<string | null>;
  /** Sets whether every poster made from the website must carry its real logo. */
  setLogoRequired(client: ClientSummary, required: boolean): Promise<string | null>;
  /** Chooses who approves the posters: a person in Review (manual) or the system after the automatic checks (auto). */
  setApprovalMode(client: ClientSummary, mode: 'manual' | 'auto'): Promise<string | null>;
  /** Sets what the AI may cost for the client in a calendar month, in dollars; null goes back to the default limit. */
  setSpendCap(client: ClientSummary, cap: number | null): Promise<string | null>;
  /** Saves the days of the week each channel posts on (an empty object clears them); resolves to an explanation when it could not be saved. */
  setPostingDays(client: ClientSummary, days: PostingDaysData): Promise<string | null>;
  /** How many brands each customer of a product app may have (the default, each customer and the latest changes), or null when the status could not say. */
  brands(): BrandsStatus | null;
  /** Sets how many brands a customer of a product app may have unless set otherwise (1 to the ceiling). */
  setBrandsDefault(value: number): Promise<string | null>;
  /** Sets one customer's number of brands, or null to put them back on the default. */
  setBrandsAllowed(product: string, group: string, name: string, value: number | null): Promise<string | null>;
  /** True once when the New post window sent the owner here to make posters from the website: the plan form then opens by itself. */
  wantsPlanForm(brand: string): boolean;
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
const TAB_LABELS: Record<ClientTab, string> = { channels: 'Channels', posts: 'Next posts', cost: 'Cost', analytics: 'Analytics', autodm: 'Auto-DM' };

export function clientsPage(clients: ClientSummary[], ctx: ClientsContext): HTMLElement {
  const paused = ctx.allPaused();
  const add = h(
    'div',
    { class: 'page-actions' },
    button([icon('plus'), 'Add client'], 'btn btn-primary', () => ctx.addClient()),
    button(paused ? 'Resume everything' : 'Pause everything', paused ? 'btn' : 'btn btn-quiet btn-danger', () => ctx.setPause('all', null, !paused)),
  );
  if (clients.length === 0) return h('div', {}, add, h('p', { class: 'empty' }, 'No clients yet.'), brandsPanel(ctx));
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
  ), brandsPanel(ctx));
}

/** A number from 1 to the ceiling, as a choice (so a wrong number cannot be typed). */
function countSelect(label: string, ceiling: number, value: number): HTMLSelectElement {
  return h('select', { class: 'text-input limit-select', 'aria-label': label }, ...Array.from({ length: ceiling }, (_, i) => h('option', { value: String(i + 1), ...(i + 1 === value ? { selected: 'selected' } : {}) }, String(i + 1)))) as HTMLSelectElement;
}

const logWhat = (what: string, customers: BrandsStatus['customers']): string => {
  if (what === 'default') return 'the default';
  const found = customers.find((c) => `${c.product}:${c.group}` === what);
  return found ? found.name : what;
};
const logNumber = (value: number | null): string => (value === null ? 'the default' : String(value));

/**
 * How many brands each customer of a product app (such as Brandbasket) may have under one login. The app makes one workspace per brand and is refused past this
 * number, so changing it here takes effect at once; the highest number is fixed in the code and cannot be raised from this screen.
 */
export function brandsPanel(ctx: ClientsContext): HTMLElement | null {
  const brands = ctx.brands();
  if (!brands) return null;
  const message = h('p', { class: 'muted', role: 'status' }, '');
  const say = (text: string, bad: boolean): void => {
    message.textContent = text;
    message.className = bad ? 'form-error' : 'muted';
  };
  const defaultSelect = countSelect('How many brands a customer may have by default', brands.ceiling, brands.defaultBrands);
  const saveDefault = button('Save', 'btn', () => {
    defaultSelect.disabled = true;
    say('Saving…', false);
    void ctx.setBrandsDefault(Number(defaultSelect.value)).then((problem) => {
      defaultSelect.disabled = false;
      if (problem) say(problem, true);
    });
  });
  const rows = brands.customers.map((customer) => {
    const select = countSelect(`Brands ${customer.name} may have`, brands.ceiling, customer.brandsAllowed);
    const run = (value: number | null): void => {
      select.disabled = true;
      say('Saving…', false);
      void ctx.setBrandsAllowed(customer.product, customer.group, customer.name, value).then((problem) => {
        select.disabled = false;
        if (problem) say(problem, true);
      });
    };
    return h(
      'li',
      { class: 'brands-row' },
      h('span', {}, h('strong', {}, customer.name), ` (${customer.product}) uses ${customer.brandsUsed} of ${customer.brandsAllowed}${customer.brandsTotal > customer.brandsUsed ? `, ${customer.brandsTotal - customer.brandsUsed} put away` : ''}${customer.custom ? '' : ' (the default)'} `),
      select,
      button('Save', 'btn', () => run(Number(select.value))),
      customer.custom ? button('Use the default', 'btn btn-quiet', () => run(null)) : null,
    );
  });
  const log = brands.log.slice(0, 8).map((l) => h('li', { class: 'muted' }, `${new Date(l.at).toLocaleString()}: ${l.by} changed ${logWhat(l.what, brands.customers)} from ${logNumber(l.old)} to ${logNumber(l.new)}.`));
  return h(
    'section',
    { class: 'brands-panel', 'aria-label': 'Brands per customer' },
    h('h3', {}, 'Brands per customer'),
    h('p', { class: 'muted' }, `Customers of an app (such as Brandbasket) can have several brands under one login, up to ${brands.ceiling}. The app cannot make more than the number set here, and it sees a change at once. Lowering a number never removes a brand; it only stops new ones.`),
    h('p', {}, 'By default a customer may have ', defaultSelect, ' brand(s). ', saveDefault),
    rows.length > 0 ? h('ul', { class: 'brands-list' }, ...rows) : h('p', { class: 'muted' }, 'No customers of an app yet.'),
    message,
    log.length > 0 ? h('details', {}, h('summary', {}, 'Recent changes'), h('ul', {}, ...log)) : null,
  );
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
    message,
  );
}

/** The posting plans of a client added in the dashboard: each listed with a way to take it off, and a form to add another. Needs the website, because posters are made from it. */
function plansCard(client: ClientSummary, ctx: ClientsContext): HTMLElement | null {
  if (!client.website) return null;
  const message = h('p', { class: 'form-message', role: 'status' });
  const say = (text: string, error: boolean): void => {
    message.textContent = text;
    message.classList.toggle('is-error', error);
  };
  const fields = planFields(`newplan-${client.brand}`, { existing: client.plans, limit: client.weeklyLimit, available: connectedPlatforms(client.channels) });
  const save = button('Add this plan', 'btn btn-primary', () => {
    const chosen = fields.read(true);
    if (!chosen.plan) return say(chosen.problem ?? 'Choose what to post.', true);
    save.disabled = true;
    say('Saving…', false);
    void ctx.addPlan(client, planPayload(chosen.plan)).then((problem) => {
      if (!problem) return;
      say(problem, true);
      save.disabled = false;
    });
  });
  const form = h('div', { class: 'plan-box', hidden: 'hidden' }, fields.element, h('div', { class: 'actions' }, save, button('Cancel', 'btn btn-quiet', () => { form.hidden = true; say('', false); })));
  for (const control of fields.controls) {
    control.addEventListener('input', () => fields.refresh(true));
    control.addEventListener('change', () => fields.refresh(true));
  }
  const limitSelect = h('select', { id: `limit-${client.brand}`, class: 'text-input limit-select', 'aria-label': 'Posters a week for each channel' }, ...Array.from({ length: MAX_WEEKLY_LIMIT }, (_, i) => i + 1).map((n) => h('option', { value: String(n), ...(n === client.weeklyLimit ? { selected: 'selected' } : {}) }, String(n))));
  limitSelect.addEventListener('change', () => {
    limitSelect.disabled = true;
    say('Saving…', false);
    void ctx.setLimit(client, Number(limitSelect.value)).then((problem) => {
      limitSelect.disabled = false;
      if (problem) say(problem, true);
    });
  });
  const logoBox = h('input', { id: `logo-${client.brand}`, type: 'checkbox', ...(client.requireAuthenticLogo ? { checked: 'checked' } : {}) });
  logoBox.addEventListener('change', () => {
    logoBox.disabled = true;
    say('Saving…', false);
    void ctx.setLogoRequired(client, logoBox.checked).then((problem) => {
      logoBox.disabled = false;
      if (problem) {
        logoBox.checked = !logoBox.checked;
        say(problem, true);
      }
    });
  });
  const modeSelect = h('select', { id: `mode-${client.brand}`, class: 'text-input limit-select', 'aria-label': 'Who approves the posters' },
    h('option', { value: 'manual', ...(client.approvalMode === 'manual' ? { selected: 'selected' } : {}) }, 'Manual: a person approves each poster in Review'),
    h('option', { value: 'auto', ...(client.approvalMode === 'auto' ? { selected: 'selected' } : {}) }, 'Automatic: approved by the system after the checks'),
  );
  const modeWarning = h('p', { class: 'approval-warning', role: 'note', ...(client.approvalMode === 'auto' ? {} : { hidden: 'hidden' }) }, AUTO_WARNING);
  modeSelect.addEventListener('change', () => {
    const chosen = modeSelect.value === 'auto' ? 'auto' : 'manual';
    const previous = chosen === 'auto' ? 'manual' : 'auto';
    if (chosen === 'auto' && !confirm(`${AUTO_WARNING}\n\nSwitch ${client.label} to automatic?`)) {
      modeSelect.value = previous;
      return;
    }
    modeSelect.disabled = true;
    say('Saving…', false);
    void ctx.setApprovalMode(client, chosen).then((problem) => {
      modeSelect.disabled = false;
      if (problem) {
        modeSelect.value = previous;
        say(problem, true);
      } else {
        modeWarning.hidden = chosen !== 'auto';
      }
    });
  });
  const capNow = client.spendCapUsd ?? SPEND_CAP_DEFAULT_USD;
  const capInput = h('input', { id: `cap-${client.brand}`, type: 'number', class: 'text-input cap-input', min: '0.01', max: '500', step: '0.01', value: String(capNow), 'aria-label': 'Most the AI may cost for this client in a month, in dollars' });
  const saveCap = (cap: number | null): void => {
    capInput.disabled = true;
    say('Saving…', false);
    void ctx.setSpendCap(client, cap).then((problem) => {
      capInput.disabled = false;
      if (problem) say(problem, true);
    });
  };
  const capSave = button('Save limit', 'btn', () => {
    const cap = Number(capInput.value);
    if (capInput.value.trim() === '' || !Number.isFinite(cap) || cap <= 0 || cap > 500 || Math.round(cap * 100) / 100 !== cap) {
      say('Enter an amount in dollars above 0 and at most 500, with at most two decimals.', true);
      return;
    }
    saveCap(cap);
  });
  const capReset = client.spendCapUsd === null ? null : button('Use the default', 'btn btn-quiet', () => saveCap(null));
  const spent = spentThisMonth(client.costs, Date.now());
  const open = button('Add a plan', 'btn', () => {
    form.hidden = false;
    fields.refresh(true);
  });
  if (ctx.wantsPlanForm(client.brand)) {
    form.hidden = false;
    fields.refresh(true);
  }
  return h(
    'div',
    { class: 'panel-card plans-card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Posting plans'), open),
    h('div', { class: 'limit-row' },
      h('label', { class: 'label', for: `limit-${client.brand}` }, 'Posters a week for each channel'),
      limitSelect,
    ),
    h('label', { class: 'check-row', for: `logo-${client.brand}` }, logoBox, h('span', {}, 'Require the website\'s real logo on every poster. When off, a poster uses the brand name as text if no usable logo is found.')),
    h('div', { class: 'limit-row' },
      h('label', { class: 'label', for: `mode-${client.brand}` }, 'Approval'),
      modeSelect,
    ),
    modeWarning,
    h('div', { class: 'limit-row' },
      h('label', { class: 'label', for: `cap-${client.brand}` }, 'Most the AI may cost in a month ($)'),
      capInput,
      capSave,
      ...(capReset ? [capReset] : []),
    ),
    h('p', { class: 'muted' }, `Used so far this month: $${spent.toFixed(2)} of $${capNow.toFixed(2)}${client.spendCapUsd === null ? ' (the default limit)' : ''}. When the limit is reached no more posters are made for this client until next month; posters already made stay as they are.`),
    h('p', { class: 'muted' }, 'Each plan has its own platforms, days and rhythm. The posters are made from the website. With manual approval they wait in Review and nothing is posted until you approve them; with automatic approval the ones that pass the checks go out on their day.'),
    client.plans.length === 0
      ? h('p', { class: 'muted' }, 'No plan yet. Add one to have posters made.')
      : h('ul', { class: 'plan-list' }, ...client.plans.map((plan, index) => h('li', { class: 'plan-item' }, h('span', {}, planSentence(plan)), button('Remove', 'btn btn-quiet', () => {
        if (!confirm('Stop making posters for this plan? Posters already made stay in Review.')) return;
        void ctx.removePlan(client, index).then((problem) => { if (problem) say(problem, true); });
      })))),
    form,
    message,
  );
}

const PLATFORM_NAMES: Record<Platform, string> = { instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn', google: 'Google' };
const DAY_NAMES: Record<Weekday, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

/**
 * The days of the week each channel posts on: a row of seven day boxes for every connected channel (and any channel that already has days). Used when a
 * batch of posts is written, so posts already written keep their days. A channel with no day ticked keeps the usual spread.
 */
export function daysCard(client: ClientSummary, ctx: ClientsContext): HTMLElement {
  const message = h('p', { class: 'form-message', role: 'status' });
  const say = (text: string, error: boolean): void => {
    message.textContent = text;
    message.classList.toggle('is-error', error);
  };
  const connected = new Set<Platform>(client.channels.map((c) => c.platform));
  const shown = PLATFORMS.filter((p) => connected.has(p) || client.postingDays[p] !== undefined);
  const boxes = new Map<Platform, Map<Weekday, HTMLInputElement>>();
  const rows = shown.map((platform) => {
    const row = new Map<Weekday, HTMLInputElement>();
    boxes.set(platform, row);
    const picks = WEEKDAYS.map((day) => {
      const box = h('input', { type: 'checkbox', id: `day-${client.brand}-${platform}-${day}`, value: day, ...(client.postingDays[platform]?.includes(day) ? { checked: 'checked' } : {}) }) as HTMLInputElement;
      row.set(day, box);
      return h('label', { class: 'day-pick', for: box.id }, box, h('span', {}, DAY_NAMES[day]));
    });
    return h('div', { class: 'day-row', role: 'group', 'aria-label': `${PLATFORM_NAMES[platform]} posts on` }, h('span', { class: 'label day-channel' }, PLATFORM_NAMES[platform]), ...picks);
  });
  const read = (): PostingDaysData => {
    const days: PostingDaysData = {};
    for (const [platform, row] of boxes) {
      const chosen = WEEKDAYS.filter((d) => row.get(d)?.checked === true);
      if (chosen.length > 0) days[platform] = chosen;
    }
    return days;
  };
  const submit = (days: PostingDaysData): void => {
    save.disabled = true;
    clear.disabled = true;
    say('Saving…', false);
    void ctx.setPostingDays(client, days).then((problem) => {
      save.disabled = false;
      clear.disabled = false;
      if (problem) say(problem, true);
    });
  };
  const save = button('Save days', 'btn btn-primary', () => submit(read()));
  const clear = button('Use the usual spread', 'btn btn-quiet', () => submit({}));
  return h(
    'div',
    { class: 'panel-card days-card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Days to post')),
    h('p', { class: 'muted' }, 'Tick the days of the week each channel posts on, for example Instagram on Mon, Tue and Sat and Facebook on Wed and Fri. One post goes out on each ticked day. This is used when a new batch of posts is written: posts already written or drawn keep their days. A channel with no day ticked keeps the usual spread.'),
    ...(rows.length === 0 ? [h('p', { class: 'muted' }, 'No channel is connected yet. Connect one to choose its days.')] : rows),
    h('div', { class: 'actions' }, save, clear),
    message,
  );
}

/**
 * What the customer chose about automatic posting, for the team to read. Only the customer can change it (the product asks her and records her consent), so there
 * is nothing to press here: it says what the system does for her and who agreed.
 */
export function autoPostingCard(client: ClientSummary): HTMLElement {
  const auto = client.autoPosting;
  const connected = new Set<Platform>(client.channels.map((c) => c.platform));
  const names = (list: readonly Platform[]): string => list.map((p) => PLATFORM_NAMES[p]).join(', ');
  const body: HTMLElement[] = [];
  if (auto === null) {
    body.push(h('p', { class: 'muted' }, 'Off. Every poster waits for the customer to approve it.'));
  } else {
    const manual = PLATFORMS.filter((p) => connected.has(p) && !auto.channels.includes(p));
    body.push(h('p', {}, `On for ${names(auto.channels)}. The system approves a picture that passed every check ${auto.safetyHours === 0 ? 'as soon as it is ready' : `${auto.safetyHours} hour${auto.safetyHours === 1 ? '' : 's'} before it posts`}; the customer can still change or take it back until it goes out.`));
    body.push(h('p', { class: 'muted' }, `Agreed by ${auto.consentBy} on ${auto.consentAt.slice(0, 10)}.${manual.length > 0 ? ` Still approved by the customer: ${names(manual)} (connected after, or not chosen).` : ''}`));
    body.push(h('p', { class: 'muted' }, 'Carousels, her own topic requests, topics the checks warned about and any picture the checks blocked always wait for her.'));
  }
  return h('div', { class: 'panel-card auto-card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Automatic posting')), ...body, h('p', { class: 'muted' }, 'Only the customer can change this, from the app.'));
}

export function clientPage(client: ClientSummary | undefined, tab: ClientTab, ctx: ClientsContext): HTMLElement {
  if (!client) return h('p', { class: 'empty' }, 'That client was not found.', ' ', button('Back to clients', 'btn', () => ctx.go({ page: 'clients' })));
  const connected = new Set<Platform>(client.channels.map((c) => c.platform));
  const tabs = h(
    'div',
    { class: 'ctabs', role: 'tablist' },
    ...(['channels', 'posts', 'cost', 'analytics', 'autodm'] as const).map((key) =>
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
    client.added ? plansCard(client, ctx) : null,
    // Only a product's customer: a client the team added has plans of its own, which choose their own days.
    client.product !== null ? daysCard(client, ctx) : null,
    client.product !== null ? autoPostingCard(client) : null,
    client.paused ? h('p', { class: 'banner banner-warn', role: 'status' }, ctx.allPaused() ? 'Everything is paused, so nothing is sent for this client.' : `${client.label} is paused. Nothing is sent for this client until you resume it. Posts whose time comes while it is paused are skipped, not sent late.`) : null,
    tabs,
    tab === 'channels' ? channels : tab === 'posts' ? posts : tab === 'analytics' ? analyticsPage(client, ctx) : tab === 'autodm' ? autoDmPanel(client) : costPage(client, ctx),
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

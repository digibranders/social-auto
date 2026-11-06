import { brandLabel } from './calendar.ts';
import { DURATIONS, PLATFORMS, dayLabel, planCost, planDates, planPayload, planProblem, platformNames, todayAt, tomorrowAt, type PlanInput, type PlanPlatform } from '../shared/posting-plan.ts';
import { WEEKLY_LIMIT_DEFAULT, availability, quotaProblem, type QuotaPlan } from '../shared/quota.ts';
import { button, h } from './ui.ts';

/** What the Add client window needs from the page. */
export interface AddClientDeps {
  /** Resolves to an explanation when the client could not be added. */
  /** `plan` is what to post, where and for how long; null when the client is only being added. */
  submit(name: string, website: string, plan: Record<string, unknown> | null): Promise<string | null>;
  close(): void;
}

/** The slug the server will make from a name, to show what the client will be called. */
export function previewLabel(name: string): string {
  return brandLabel(
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, ''),
  );
}

/** The plan the form's choices make, or why they do not make one. Pure, so it is tested without a page. */
/** `quota` is what the client already has planned and its weekly limit; without it only the choices themselves are checked. */
export function readPlan(values: { on: boolean; platforms: readonly string[]; startDate: string; durationId: string; postsPerWeek: number }, now: Date = new Date(), quota?: { existing: readonly QuotaPlan[]; limit: number }): { plan: PlanInput | null; problem: string | null } {
  if (!values.on) return { plan: null, problem: null };
  const duration = DURATIONS.find((d) => d.id === values.durationId) ?? DURATIONS[0];
  const platforms = PLATFORMS.map((p) => p.id).filter((id) => values.platforms.includes(id));
  const plan: PlanInput = { platforms, startDate: values.startDate, durationDays: duration.days, ...(duration.days > 1 && values.postsPerWeek > 0 ? { postsPerWeek: values.postsPerWeek } : {}), time: '10:00', utcOffset: '+05:30' };
  const problem = planProblem(plan, now, plan.utcOffset) ?? (quota ? quotaProblem(quota.existing, plan, quota.limit, todayAt(plan.utcOffset, now)) : null);
  return { plan: problem ? null : plan, problem };
}

/** What the owner is told about the plan they have chosen: the sentence, every day when there are few, and what it may cost. */
export function describePlan(plan: PlanInput): string[] {
  const dates = planDates(plan);
  const cost = planCost(dates.length);
  const lines = [`${dates.length} post${dates.length === 1 ? '' : 's'} on ${platformNames(plan.platforms)}, at 10:00 India time.`];
  lines.push(dates.length <= 14 ? dates.map(dayLabel).join(' · ') : `${dayLabel(dates[0] as string)} to ${dayLabel(dates.at(-1) as string)}`);
  lines.push(`The posters cost about $${cost.low.toFixed(2)} to $${cost.high.toFixed(2)} to make. Nothing is posted until you have looked at each poster and approved it.`);
  return lines;
}

/** The choices that make a posting plan (platforms, how long, how often, first day) with the live summary under them. Used by the Add client window and the client's own page. */
export interface PlanFields {
  element: HTMLElement;
  /** The plan the choices make (or why not); `on: false` reads as no plan. */
  read(on: boolean): ReturnType<typeof readPlan>;
  /** Redraws the summary, and the how-often box, from the current choices. */
  refresh(on: boolean): void;
  /** Every control, so a caller can redraw when any of them changes. */
  controls: HTMLElement[];
}

/**
 * `prefix` keeps the element ids apart when two forms are on the page. `existing` is what the client already has planned: when it is given, the form shows
 * which weeks still have free places on each chosen channel, and holds the choices to them. `limit` is the client's posters a week for each channel.
 */
export function planFields(prefix: string, options: { existing?: readonly QuotaPlan[]; limit?: number } = {}): PlanFields {
  const limit = options.limit ?? WEEKLY_LIMIT_DEFAULT;
  const existing = options.existing ?? [];
  const ticks = new Map<PlanPlatform, HTMLInputElement>(PLATFORMS.map((p) => [p.id, h('input', { type: 'checkbox', id: `${prefix}-${p.id}`, ...(p.id === 'instagram' ? { checked: 'checked' } : {}) })]));
  const duration = h('select', { id: `${prefix}-duration`, class: 'text-input', 'aria-label': 'For how long' }, ...DURATIONS.map((d) => h('option', { value: d.id }, d.label)));
  const often = h('select', { id: `${prefix}-often`, class: 'text-input', 'aria-label': 'How often' }, ...Array.from({ length: limit }, (_, i) => i + 1).map((n) => h('option', { value: String(n), ...(n === Math.min(3, limit) ? { selected: 'selected' } : {}) }, `${n} time${n === 1 ? '' : 's'} a week`)));
  const startDate = h('input', { id: `${prefix}-start`, type: 'date', class: 'text-input', 'aria-label': 'First day to post' });
  startDate.value = tomorrowAt('+05:30');
  const summary = h('div', { class: 'plan-summary', role: 'status', 'aria-live': 'polite' });
  const quota = h('div', { class: 'quota' });
  const element = h('div', { class: 'plan-fields' },
    h('p', { class: 'label' }, 'Post on'),
    h('div', { class: 'check-grid' }, ...PLATFORMS.map((p) => h('label', { class: 'check-row', for: `${prefix}-${p.id}` }, ticks.get(p.id) as HTMLInputElement, h('span', {}, p.label)))),
    h('label', { class: 'label', for: `${prefix}-duration` }, 'For how long'),
    duration,
    h('label', { class: 'label', for: `${prefix}-often` }, 'How often'),
    often,
    h('label', { class: 'label', for: `${prefix}-start` }, 'First day'),
    startDate,
    options.existing ? quota : null,
    summary,
  );
  const chosen = (): string[] => [...ticks].filter(([, box]) => box.checked).map(([id]) => id);
  const read = (on: boolean, now: Date = new Date()): ReturnType<typeof readPlan> => readPlan({ on, platforms: chosen(), startDate: startDate.value, durationId: duration.value, postsPerWeek: Number(often.value) }, now, { existing, limit });
  const drawQuota = (): void => {
    const channels = chosen();
    if (channels.length === 0) return void quota.replaceChildren();
    const rows = availability(existing, channels, limit, todayAt('+05:30'));
    quota.replaceChildren(
      h('p', { class: 'label' }, `Places free each week (${limit} a week for each channel)`),
      h('table', { class: 'quota-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Week'), ...channels.map((c) => h('th', {}, platformNames([c]))))),
        h('tbody', {}, ...rows.map((row) => h('tr', {}, h('td', {}, row.label), ...channels.map((c) => {
          const cell = row.channels[c] as { used: number; free: number };
          return h('td', { class: cell.free === 0 ? 'is-full' : '' }, cell.free === 0 ? `full (${cell.used} of ${limit})` : `${cell.free} free${cell.used > 0 ? ` (${cell.used} planned)` : ''}`);
        })))),
      ),
      h('p', { class: 'muted' }, 'Weeks that have passed are not listed, and what was not used in them is gone.'),
    );
  };
  const refresh = (on: boolean): void => {
    often.disabled = duration.value === 'day';
    if (options.existing) drawQuota();
    const { plan, problem } = read(on);
    summary.classList.toggle('is-error', Boolean(problem));
    summary.replaceChildren(...(problem ? [h('p', {}, problem)] : plan ? describePlan(plan).map((line) => h('p', {}, line)) : []));
  };
  return { element, read, refresh, controls: [duration, often, startDate, ...ticks.values()] };
}

export function addClientForm(deps: AddClientDeps): HTMLElement {
  const input = h('input', { id: 'client-name', type: 'text', class: 'text-input', 'aria-label': 'Client name', maxlength: '60', autocomplete: 'off', placeholder: 'e.g. Brand Basket' });
  const site = h('input', { id: 'client-website', type: 'text', class: 'text-input', 'aria-label': 'Client website', maxlength: '200', autocomplete: 'off', inputmode: 'url', placeholder: 'e.g. brandbasket.in' });
  const shown = h('p', { class: 'muted' });
  input.addEventListener('input', () => {
    const label = previewLabel(input.value);
    shown.textContent = label ? `It will appear as “${label}”.` : '';
  });
  // What to post, where and for how long. Offered once a website is written, because the posts are made from it.
  const planOn = h('input', { id: 'plan-on', type: 'checkbox', checked: 'checked' });
  const fields = planFields('plan');
  const planBox = h('div', { class: 'plan-box' },
    h('label', { class: 'check-row', for: 'plan-on' }, planOn, h('span', {}, 'Make posts from this website')),
    fields.element,
  );
  const currentPlan = (): ReturnType<typeof readPlan> => fields.read(planOn.checked && site.value.trim() !== '');
  const refresh = (): void => {
    planBox.hidden = site.value.trim() === '';
    fields.element.hidden = !planOn.checked;
    fields.refresh(planOn.checked && site.value.trim() !== '');
  };
  for (const control of [planOn, site, ...fields.controls]) control.addEventListener('input', refresh);
  for (const control of [planOn, ...fields.controls]) control.addEventListener('change', refresh);
  refresh();
  const message = h('p', { class: 'form-message', role: 'status' });
  const save = button('Add client', 'btn btn-primary', () => {
    if (!previewLabel(input.value)) {
      message.textContent = 'Write the client’s name.';
      message.classList.add('is-error');
      return;
    }
    save.disabled = true;
    message.textContent = 'Saving…';
    message.classList.remove('is-error');
    const chosen = currentPlan();
    if (chosen.problem) {
      message.textContent = chosen.problem;
      message.classList.add('is-error');
      save.disabled = false;
      return;
    }
    void deps.submit(input.value, site.value.trim(), chosen.plan ? planPayload(chosen.plan) : null).then((problem) => {
      if (!problem) return;
      message.textContent = problem;
      message.classList.add('is-error');
      save.disabled = false;
    });
  });
  for (const field of [input, site]) {
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') save.click();
    });
  }
  return h(
    'div',
    { class: 'dialog-inner' },
    h('div', { class: 'dialog-head' }, h('h2', {}, 'Add a client'), button('Close', 'btn btn-quiet', deps.close)),
    h('label', { class: 'label', for: 'client-name' }, 'Client name'),
    input,
    shown,
    h('label', { class: 'label', for: 'client-website' }, 'Website (optional)'),
    site,
    h('p', { class: 'muted' }, 'Posts are planned from this site. You can add or change it later on the client’s page.'),
    planBox,
    h('p', { class: 'muted' }, 'This makes the client’s folder so you can connect their channels and write posts by hand.'),
    h('div', { class: 'actions' }, save, button('Cancel', 'btn btn-quiet', deps.close)),
    message,
  );
}

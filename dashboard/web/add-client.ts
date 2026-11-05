import { brandLabel } from './calendar.ts';
import { DURATIONS, PLATFORMS, dayLabel, planCost, planDates, planPayload, planProblem, platformNames, tomorrowAt, type PlanInput, type PlanPlatform } from '../shared/posting-plan.ts';
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
export function readPlan(values: { on: boolean; platforms: readonly string[]; startDate: string; durationId: string; postsPerWeek: number }, now: Date = new Date()): { plan: PlanInput | null; problem: string | null } {
  if (!values.on) return { plan: null, problem: null };
  const duration = DURATIONS.find((d) => d.id === values.durationId) ?? DURATIONS[0];
  const platforms = PLATFORMS.map((p) => p.id).filter((id) => values.platforms.includes(id));
  const plan: PlanInput = { platforms, startDate: values.startDate, durationDays: duration.days, ...(duration.days > 1 && values.postsPerWeek > 0 ? { postsPerWeek: values.postsPerWeek } : {}), time: '10:00', utcOffset: '+05:30' };
  const problem = planProblem(plan, now, plan.utcOffset);
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
  const ticks = new Map<PlanPlatform, HTMLInputElement>(PLATFORMS.map((p) => [p.id, h('input', { type: 'checkbox', id: `plan-${p.id}`, ...(p.id === 'instagram' ? { checked: 'checked' } : {}) })]));
  const duration = h('select', { id: 'plan-duration', class: 'text-input', 'aria-label': 'For how long' }, ...DURATIONS.map((d) => h('option', { value: d.id }, d.label)));
  const often = h('select', { id: 'plan-often', class: 'text-input', 'aria-label': 'How often' }, h('option', { value: '0' }, 'Every day'), ...[1, 2, 3, 4, 5, 6].map((n) => h('option', { value: String(n), ...(n === 3 ? { selected: 'selected' } : {}) }, `${n} time${n === 1 ? '' : 's'} a week`)));
  const startDate = h('input', { id: 'plan-start', type: 'date', class: 'text-input', 'aria-label': 'First day to post' });
  startDate.value = tomorrowAt('+05:30');
  const summary = h('div', { class: 'plan-summary', role: 'status', 'aria-live': 'polite' });
  const planBox = h('div', { class: 'plan-box' },
    h('label', { class: 'check-row', for: 'plan-on' }, planOn, h('span', {}, 'Make posts from this website')),
  );
  const planFields = h('div', { class: 'plan-fields' },
    h('p', { class: 'label' }, 'Post on'),
    h('div', { class: 'check-grid' }, ...PLATFORMS.map((p) => h('label', { class: 'check-row', for: `plan-${p.id}` }, ticks.get(p.id) as HTMLInputElement, h('span', {}, p.label)))),
    h('label', { class: 'label', for: 'plan-duration' }, 'For how long'),
    duration,
    h('label', { class: 'label', for: 'plan-often' }, 'How often'),
    often,
    h('label', { class: 'label', for: 'plan-start' }, 'First day'),
    startDate,
    summary,
  );
  planBox.append(planFields);
  const currentPlan = (): ReturnType<typeof readPlan> => readPlan({ on: planOn.checked && site.value.trim() !== '', platforms: [...ticks].filter(([, box]) => box.checked).map(([id]) => id), startDate: startDate.value, durationId: duration.value, postsPerWeek: Number(often.value) });
  const refresh = (): void => {
    const hasSite = site.value.trim() !== '';
    planBox.hidden = !hasSite;
    planFields.hidden = !planOn.checked;
    often.disabled = duration.value === 'day';
    const { plan, problem } = currentPlan();
    summary.classList.toggle('is-error', Boolean(problem));
    summary.replaceChildren(...(problem ? [h('p', {}, problem)] : plan ? describePlan(plan).map((line) => h('p', {}, line)) : []));
  };
  for (const control of [planOn, duration, often, startDate, site, ...ticks.values()]) control.addEventListener('input', refresh);
  for (const control of [planOn, duration, often, startDate, ...ticks.values()]) control.addEventListener('change', refresh);
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

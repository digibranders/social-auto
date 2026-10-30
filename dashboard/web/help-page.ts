/** The Help screen: pick a channel, follow its guide, tick steps off. Text goes in as text, never as HTML. */
import { GUIDES, type Shot, type Step } from './guides.ts';
import { GUIDE_KEYS, type GuideKey } from './route.ts';
import { brandMark, button, h } from './ui.ts';

const TICKS_KEY = 'help.ticks';
const WHO_LABEL: Record<Step['who'], string> = { client: 'Client', you: 'You', system: 'Automatic' };
const GUIDE_MARK: Record<GuideKey, 'facebook' | 'instagram' | 'google' | 'linkedin'> = {
  facebook: 'facebook',
  instagram: 'instagram',
  google: 'google',
  linkedin: 'linkedin',
};

function loadTicks(): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(TICKS_KEY) ?? '{}');
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function saveTicks(ticks: Record<string, boolean>): void {
  try {
    localStorage.setItem(TICKS_KEY, JSON.stringify(ticks));
  } catch {
    // Ticks are a convenience; the guide works without them.
  }
}

function picture(shot: Shot): HTMLElement {
  return h(
    'div',
    { class: 'shot', 'aria-hidden': 'true' },
    h('div', { class: 'shot-bar' }, h('i'), h('i'), h('i'), h('span', {}, shot.url)),
    h(
      'div',
      { class: 'shot-body' },
      ...shot.rows.map((r) =>
        h(
          'div',
          { class: `shot-row${r.hi ? ' shot-hi' : ''}` },
          r.av ? h('span', { class: 'shot-av' }) : null,
          r.chk !== undefined ? h('span', { class: `shot-chk${r.chk ? ' shot-chk-on' : ''}` }) : null,
          h('span', {}, r.t, r.s ? h('small', {}, r.s) : null),
          r.hi || r.chk !== undefined || r.av ? null : h('span', { class: 'shot-go' }, '›'),
        ),
      ),
      shot.btn ? h('div', { class: 'shot-actions' }, h('span', { class: `shot-btn${shot.bhi ? ' shot-btn-hi' : ''}` }, shot.btn)) : null,
    ),
  );
}

export function helpPage(channel: GuideKey, select: (key: GuideKey) => void, redraw: () => void): HTMLElement {
  const guide = GUIDES[channel];
  const ticks = loadTicks();
  const keyOf = (group: number, step: number): string => `${channel}.${group}.${step}`;
  const total = guide.groups.reduce((n, g) => n + g.steps.length, 0);
  const progress = h('b', {}, '0');
  const refreshProgress = (): void => {
    progress.textContent = String(guide.groups.reduce((n, g, gi) => n + g.steps.filter((_, si) => ticks[keyOf(gi, si)]).length, 0));
  };

  const list = h(
    'aside',
    { class: 'help-list', 'aria-label': 'Channels' },
    h('h2', { class: 'panel-title' }, 'Channels'),
    ...GUIDE_KEYS.map((key) =>
      button(
        [h('span', { class: 'mark' }, brandMark(GUIDE_MARK[key])), h('span', { class: 'channel-name' }, GUIDES[key].name)],
        `channel${key === channel ? ' channel-on' : ''}`,
        () => select(key),
      ),
    ),
  );

  const groups = guide.groups.map((group, gi) => {
    const details = h('details', { class: 'group', ...(group.open ? { open: '' } : {}) });
    details.append(
      h('summary', {}, group.title, h('span', { class: 'muted' }, ` · ${group.steps.length} step${group.steps.length === 1 ? '' : 's'}`)),
      ...group.steps.map((step, si) => {
        const box = h('input', { type: 'checkbox', 'aria-label': `Done: ${step.t}` });
        box.checked = ticks[keyOf(gi, si)] === true;
        box.addEventListener('change', () => {
          ticks[keyOf(gi, si)] = box.checked;
          saveTicks(ticks);
          refreshProgress();
        });
        return h(
          'div',
          { class: 'step' },
          h('div', { class: 'step-num' }, String(si + 1)),
          h(
            'div',
            { class: 'step-main' },
            h('h3', {}, step.t, h('span', { class: `who who-${step.who}` }, WHO_LABEL[step.who]), h('label', { class: 'tick' }, box, ' Done')),
            h('p', { class: 'muted' }, step.d),
            ...(step.images?.length ? step.images.map((image) => h('img', { class: 'shot-real', src: image.src, alt: image.alt, loading: 'lazy', decoding: 'async' })) : [picture(step.shot)]),
          ),
        );
      }),
    );
    return details;
  });

  const reset = button('Start over for a new client', 'btn btn-quiet', () => {
    for (const key of Object.keys(ticks)) if (key.startsWith(`${channel}.`)) delete ticks[key];
    saveTicks(ticks);
    redraw();
  });
  refreshProgress();

  const body = h(
    'div',
    { class: 'help-body' },
    h('div', { class: 'help-head' }, h('span', { class: 'mark mark-big' }, brandMark(GUIDE_MARK[channel])), h('div', {}, h('h2', {}, `Connect ${guide.name}`), h('p', { class: 'muted' }, guide.intro))),
    h('div', { class: 'help-progress' }, h('span', { class: 'muted' }, progress, ` of ${total} steps ticked`), reset),
    ...groups,
    h('h3', { class: 'label' }, 'If something goes wrong'),
    ...guide.problems.map(([title, text]) => h('div', { class: 'problem' }, h('b', {}, title), h('span', { class: 'muted' }, text))),
  );
  return h('div', { class: 'help' }, list, body);
}

/** The review page: the posters the system made, waiting for the owner to approve or reject each one. */
import { button, h } from './ui.ts';
import { BATCH_QUESTION, brandingView, costText, failureText, groupBatches, imageUrl, parseBranding, parseQueue, queryStatus, REASON_LABELS, REVIEW_FILTERS, STATUS_LABELS, type ReviewFilter, type ReviewSummary } from './review.ts';

interface Detail {
  version: { versionId: string; headline: string; caption: string; ctaUrl: string; versionNumber: number; attempts: number; costUsd: number; createdAt: string; evidence: Array<{ text: string; quote: string; url: string; context: string }>; validation: { readings: number; defects: string[] }; branding?: unknown };
  status: ReviewSummary['status'];
  decision?: { by: string; at: string; reason?: string; comment?: string };
  history: ReviewSummary[];
}

interface CopyBatch { brand: string; planFile: string; posts: Array<{ postId: string; headline: string; caption: string; advice?: string; state: 'pending' | 'kept' | 'dropped' }> }

interface State {
  /** Written posts waiting to be kept or dropped, before any picture is bought. */
  copy: CopyBatch[];
  filter: ReviewFilter;
  /** "cards": one poster at a time. "compare": the whole batch side by side. */
  view: 'cards' | 'compare';
  queue: ReviewSummary[] | null;
  reasons: string[];
  problems: string[];
  openId: string | null;
  detail: Detail | null;
  error: string | null;
  notice: string | null;
  busy: boolean;
  rejecting: boolean;
}

const state: State = { copy: [], filter: 'pending', view: 'cards', queue: null, reasons: Object.keys(REASON_LABELS), problems: [], openId: null, detail: null, error: null, notice: null, busy: false, rejecting: false };

async function call(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: unknown }> {
  const response = await fetch(url, { credentials: 'same-origin', ...init });
  if (response.status === 401) {
    location.replace('/login');
    return { ok: false, status: 401, body: null };
  }
  const body: unknown = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, body };
}

async function loadCopy(redraw: () => void): Promise<void> {
  const result = await call('/api/review?view=copy').catch(() => null);
  const batches = (result?.body as { batches?: unknown } | null)?.batches;
  if (result?.ok && Array.isArray(batches)) state.copy = batches as CopyBatch[];
  redraw();
}

async function chooseCopy(batch: CopyBatch, postId: string, action: 'keep' | 'drop', redraw: () => void): Promise<void> {
  state.busy = true;
  state.error = null;
  redraw();
  const result = await call('/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ copy: { brand: batch.brand, planFile: batch.planFile, postId, action } }) }).catch(() => null);
  state.busy = false;
  if (!result?.ok) state.error = result ? failureText(result.body, result.status) : 'Your choice could not be saved. Nothing changed.';
  await loadCopy(redraw);
}

function copyView(redraw: () => void): HTMLElement | null {
  const open = state.copy.filter((b) => b.posts.length > 0);
  if (open.length === 0) return null;
  return h(
    'section',
    { class: 'rv-copy', 'aria-label': 'Written posts waiting for your choice' },
    h('h3', {}, 'Written posts: keep the ones you want drawn'),
    h('p', { class: 'rv-hint' }, 'No picture has been bought yet. Only the posts you keep will be drawn.'),
    ...open.map((batch) => h(
      'div',
      { class: 'rv-copy-batch' },
      h('b', {}, `${batch.brand} · ${batch.planFile}`),
      ...batch.posts.map((post) => h(
        'div',
        { class: `rv-copy-post rv-copy-${post.state}` },
        h('p', {}, h('b', {}, post.headline)),
        h('p', {}, post.caption),
        post.advice ? h('p', { class: 'rv-copy-advice' }, `Suggested drop: ${post.advice}`) : null,
        h('div', { class: 'rv-actions' },
          h('span', {}, post.state === 'kept' ? 'Kept' : post.state === 'dropped' ? 'Dropped' : 'Waiting for you'),
          button('Keep', `btn${post.state === 'kept' ? ' btn-primary' : ''}`, () => void chooseCopy(batch, post.postId, 'keep', redraw), `Keep: ${post.headline}`),
          button('Drop', 'btn', () => void chooseCopy(batch, post.postId, 'drop', redraw), `Drop: ${post.headline}`),
        ),
      )),
    )),
  );
}

async function loadQueue(redraw: () => void): Promise<void> {
  state.error = null;
  void loadCopy(redraw);
  const result = await call(`/api/review?view=list&status=${queryStatus(state.filter)}`).catch(() => null);
  if (!result?.ok) state.error = result ? failureText(result.body, result.status) : 'The review queue could not be reached.';
  else {
    const parsed = parseQueue(result.body);
    state.queue = parsed.posts;
    state.reasons = parsed.reasons;
    state.problems = parsed.problems;
  }
  redraw();
}

async function open(id: string, redraw: () => void): Promise<void> {
  state.openId = id;
  state.detail = null;
  state.rejecting = false;
  state.notice = null;
  redraw();
  const result = await call(`/api/review?view=detail&id=${encodeURIComponent(id)}`).catch(() => null);
  if (state.openId !== id) return;
  if (!result?.ok) state.error = result ? failureText(result.body, result.status) : 'That poster could not be loaded.';
  else state.detail = result.body as Detail;
  redraw();
}

async function decide(id: string, body: Record<string, string>, done: string, redraw: () => void): Promise<void> {
  state.busy = true;
  state.error = null;
  redraw();
  const result = await call('/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, ...body }) }).catch(() => null);
  state.busy = false;
  if (!result?.ok) state.error = result ? failureText(result.body, result.status) : 'The decision could not be saved. Nothing changed.';
  else state.notice = done;
  state.rejecting = false;
  await Promise.all([loadQueue(redraw), open(id, redraw)]);
}

const when = (iso: string): string => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

function card(post: ReviewSummary, redraw: () => void): HTMLElement {
  const on = state.openId === post.versionId;
  const element = h(
    'button',
    { type: 'button', class: `rv-card${on ? ' rv-on' : ''}`, 'aria-label': `${post.brand}: ${post.headline}` },
    h('img', { class: 'rv-thumb', src: imageUrl(post.versionId), alt: '', loading: 'lazy' }),
    h('span', { class: 'rv-card-text' }, h('b', {}, post.headline), h('small', {}, `${post.brand} · ${STATUS_LABELS[post.status]}`)),
  );
  element.addEventListener('click', () => void open(post.versionId, redraw));
  return element;
}

/** Which logo this poster was branded with, or why none was used: the owner is never left to guess whether a real logo is on it. */
function brandingBlock(versionId: string, raw: unknown): HTMLElement | null {
  const record = parseBranding(raw);
  if (!record) return null;
  const view = brandingView(record);
  return h(
    'div',
    { class: `rv-branding rv-branding-${view.tone}` },
    h('h3', {}, 'Branding'),
    h('p', { class: 'rv-branding-head' }, view.headline),
    h('p', { class: 'muted' }, view.explanation),
    record.hasLogoFile ? h('img', { class: 'rv-logo', src: imageUrl(versionId, 'logo'), alt: 'The logo that was found on the website' }) : null,
    h('dl', { class: 'rv-branding-rows' }, ...view.rows.flatMap(([label, value]) => [h('dt', {}, label), h('dd', {}, value)])),
  );
}

function detailView(detail: Detail, redraw: () => void): HTMLElement {
  const v = detail.version;
  const decided = detail.status === 'approved' || detail.status === 'rejected';
  const actions = h('div', { class: 'rv-actions' });
  if (detail.status === 'pending' || detail.status === 'held') {
    actions.append(
      button(detail.status === 'held' ? 'Confirm approval again' : 'Approve', 'btn btn-primary', () => void decide(v.versionId, { action: 'approve' }, 'Approved. It can now be downloaded.', redraw), undefined, state.busy),
      button('Reject', 'btn', () => { state.rejecting = true; redraw(); }, undefined, state.busy),
    );
  }
  if (detail.status === 'approved') {
    actions.append(
      h('a', { class: 'btn btn-primary', href: imageUrl(v.versionId, 'download'), download: '' }, 'Download'),
      button('Withdraw approval', 'btn btn-danger', () => { state.rejecting = true; redraw(); }, undefined, state.busy),
    );
  }
  const reasonSelect = h('select', { class: 'rv-input', 'aria-label': 'Why' }, ...state.reasons.map((r) => h('option', { value: r }, REASON_LABELS[r] ?? r)));
  const comment = h('input', { class: 'rv-input', type: 'text', maxlength: '500', placeholder: 'Anything else? (optional)', 'aria-label': 'Comment' });
  const rejectForm = state.rejecting
    ? h('div', { class: 'rv-reject' }, reasonSelect, comment, button('Confirm', 'btn btn-danger', () => void decide(v.versionId, { action: 'reject', reason: reasonSelect.value, comment: comment.value }, 'Rejected.', redraw), undefined, state.busy), button('Cancel', 'btn', () => { state.rejecting = false; redraw(); }))
    : null;

  return h(
    'article',
    { class: 'rv-detail' },
    h('img', { class: 'rv-image', src: imageUrl(v.versionId), alt: `Poster: ${v.headline}` }),
    h('div', { class: 'rv-side' },
      h('h2', {}, v.headline),
      h('p', { class: `rv-status rv-${detail.status}` }, STATUS_LABELS[detail.status]),
      detail.decision ? h('p', { class: 'muted' }, `${detail.decision.by}, ${when(detail.decision.at)}${detail.decision.reason ? ` · ${REASON_LABELS[detail.decision.reason] ?? detail.decision.reason}` : ''}${detail.decision.comment ? ` · “${detail.decision.comment}”` : ''}`) : null,
      detail.status === 'blocked' ? h('p', { class: 'muted' }, 'This poster did not pass the automatic checks, so it cannot be approved.') : null,
      detail.status === 'superseded' ? h('p', { class: 'muted' }, 'A newer version of this post replaced it.') : null,
      detail.status === 'held' ? h('p', { class: 'muted' }, 'The review record was repaired after a crash and it could not be told whether this approval had been withdrawn. It cannot be downloaded until you approve this exact poster again.') : null,
      actions,
      rejectForm,
      h('h3', {}, 'Caption'),
      h('p', { class: 'rv-caption' }, v.caption),
      h('p', { class: 'muted' }, `Link: ${v.ctaUrl}`),
      brandingBlock(v.versionId, v.branding),
      h('h3', {}, 'What it is based on'),
      ...(v.evidence.length > 0
        ? v.evidence.map((e) => h('blockquote', { class: 'rv-quote' }, `“${e.quote}”`, h('small', {}, e.context ? `${e.context} · ${e.url}` : e.url)))
        : [h('p', { class: 'muted' }, 'No source fact is recorded for this poster.')]),
      h('details', { class: 'rv-more' }, h('summary', {}, 'Checks and cost'),
        h('p', { class: 'muted' }, `The text on the picture was read ${v.validation.readings} times and matched exactly. Pictures drawn: ${v.attempts}. Cost: ${costText(v.costUsd)}. Version ${v.versionNumber}, made ${when(v.createdAt)}.`),
        decided || detail.history.length > 1 ? h('div', {}, h('b', {}, 'History'), ...detail.history.map((p) => h('p', { class: 'muted' }, `Version ${p.versionNumber}: ${STATUS_LABELS[p.status]}${p.reason ? ` (${REASON_LABELS[p.reason] ?? p.reason})` : ''}`))) : null),
    ),
  );
}

function compareView(redraw: () => void): HTMLElement {
  const batches = groupBatches(state.queue ?? []);
  if (batches.length === 0) return h('p', { class: 'empty' }, 'Nothing to compare here yet.');
  return h(
    'div',
    { class: 'rv-compare' },
    ...batches.map((batch) => h(
      'section',
      { class: 'rv-batch' },
      h('h2', {}, `${batch.brand} · ${batch.planFile.replace(/\.json$/, '')} · ${batch.posts.length} poster${batch.posts.length === 1 ? '' : 's'}`),
      h('p', { class: 'muted' }, BATCH_QUESTION),
      h('div', { class: 'rv-compare-grid' }, ...batch.posts.map((post) => {
        const tile = h(
          'button',
          { type: 'button', class: `rv-tile${state.openId === post.versionId ? ' rv-on' : ''}`, 'aria-label': `${post.brand}: ${post.headline}` },
          h('img', { class: 'rv-tile-image', src: imageUrl(post.versionId), alt: '', loading: 'lazy' }),
          h('span', { class: 'rv-tile-text' }, h('b', {}, post.headline), h('small', {}, STATUS_LABELS[post.status])),
        );
        tile.addEventListener('click', () => void open(post.versionId, redraw));
        return tile;
      })),
    )),
  );
}

export function reviewPage(redraw: () => void): HTMLElement {
  if (state.queue === null && !state.error) void loadQueue(redraw);
  const tabs = h('div', { class: 'rv-tabs', role: 'tablist' }, ...REVIEW_FILTERS.map((f) => {
    const tab = button(f.label, `btn${state.filter === f.key ? ' btn-primary' : ''}`, () => { state.filter = f.key; state.queue = null; state.openId = null; state.detail = null; state.error = null; redraw(); }, f.label);
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(state.filter === f.key));
    return tab;
  }));
  const views = h('div', { class: 'rv-tabs' }, ...(['cards', 'compare'] as const).map((view) => {
    const tab = button(view === 'cards' ? 'One by one' : 'Compare the batch', `btn${state.view === view ? ' btn-primary' : ''}`, () => { state.view = view; redraw(); });
    tab.setAttribute('aria-pressed', String(state.view === view));
    return tab;
  }));
  const list = h('div', { class: 'rv-list' }, ...(state.queue ?? []).map((p) => card(p, redraw)));
  const empty = state.queue !== null && state.queue.length === 0 ? h('p', { class: 'empty' }, state.filter === 'pending' ? 'Nothing is waiting for you.' : 'Nothing here yet.') : null;
  return h(
    'div',
    { class: 'rv' },
    state.notice ? h('p', { class: 'rv-notice', role: 'status' }, state.notice) : null,
    state.error ? h('p', { class: 'rv-error', role: 'alert' }, state.error) : null,
    ...state.problems.map((p) => h('p', { class: 'rv-error', role: 'alert' }, p)),
    copyView(redraw),
    tabs,
    state.queue === null && !state.error ? h('p', { class: 'empty' }, 'Loading…') : null,
    views,
    state.view === 'compare' && state.queue !== null ? compareView(redraw) : null,
    h('div', { class: 'rv-grid' }, state.view === 'compare' ? h('div', {}) : h('div', {}, list, empty), state.openId ? (state.detail ? detailView(state.detail, redraw) : h('p', { class: 'empty' }, 'Loading…')) : h('p', { class: 'empty rv-hint' }, 'Choose a poster to look at it.')),
  );
}

/** Forgets what was loaded, so the page asks again (after a refresh or when the owner comes back to it). */
export function resetReview(): void {
  state.queue = null;
  state.error = null;
}

/** The review page: the posters the system made, waiting for the owner to approve or reject each one. */
import { button, h } from './ui.ts';
import { AUTO_WARNING, type ClientSummary } from './clients.ts';
import { BATCH_QUESTION, brandingView, chosenClient, clientOptions, connectedNetworkKeys, networkState, NEW_CLIENT, startClientOptions, costText, failureText, groupBatches, imageUrl, jobActive, jobText, looksLikeSite, NETWORK_CHOICES, parseBranding, splitHashtags, parseJobs, parseQueue, queryStatus, REASON_LABELS, REVIEW_FILTERS, STATUS_LABELS, type JobView, type ReviewFilter, type ReviewSummary } from './review.ts';

interface Detail {
  version: { versionId: string; headline: string; caption: string; ctaUrl: string; versionNumber: number; attempts: number; costUsd: number; createdAt: string; evidence: Array<{ text: string; quote: string; url: string; context: string }>; validation: { readings: number; defects: string[] }; branding?: unknown };
  status: ReviewSummary['status'];
  decision?: { by: string; at: string; reason?: string; comment?: string };
  history: ReviewSummary[];
}

interface CopyPost { postId: string; headline: string; caption: string; captions?: Record<string, { text: string; edited?: boolean }>; edited?: boolean; advice?: string; state: 'pending' | 'kept' | 'dropped' }
interface CopyBatch { brand: string; planFile: string; posts: CopyPost[]; drawnAt?: string }

/** What the owner is typing in the "write posts for a website" form; kept here so a redraw does not wipe it. */
interface StartForm { site: string; page: boolean; networks: string[]; weeks: number; postsPerWeek: number; /** The client the posts are for: a client's name, or NEW_CLIENT for one named after the website. */ client: string }

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
  jobs: JobView[];
  start: StartForm;
  /** The written post being edited, and which network's caption ('' is the main caption). */
  editing: { batch: string; postId: string; network: string; draft?: { headline: string; caption: string } } | null;
  /** The client each batch's pictures are drawn for, chosen from the clients list; the client named like the website until the owner picks another. */
  clientFor: Record<string, string>;
  /** The client chosen when the posts were written, by the batch's name (the website's), used until another is picked under the batch. */
  clientForBrand: Record<string, string>;
  /** The clients, from the dashboard's data; null while it is still loading. */
  clients: readonly ClientSummary[] | null;
}

const state: State = { copy: [], filter: 'pending', view: 'cards', queue: null, reasons: Object.keys(REASON_LABELS), problems: [], openId: null, detail: null, error: null, notice: null, busy: false, rejecting: false, jobs: [], start: { site: '', page: false, networks: ['instagram', 'linkedin'], weeks: 1, postsPerWeek: 2, client: NEW_CLIENT }, editing: null, clientFor: {}, clientForBrand: {}, clients: null };

/** Saves a client's approval mode (set by the page that owns the data); null means saved, else the problem in words. */
let saveApprovalMode: (client: ClientSummary, mode: 'manual' | 'auto') => Promise<string | null> = async () => 'Not available here.';

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

async function post(body: Record<string, unknown>, failed: string): Promise<{ ok: boolean; body: unknown }> {
  state.busy = true;
  state.error = null;
  const result = await call('/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
  state.busy = false;
  if (!result?.ok) state.error = result ? failureText(result.body, result.status) : failed;
  return { ok: Boolean(result?.ok), body: result?.body };
}

async function chooseCopy(batch: CopyBatch, postId: string, action: 'keep' | 'drop', redraw: () => void): Promise<void> {
  redraw();
  await post({ copy: { brand: batch.brand, planFile: batch.planFile, postId, action } }, 'Your choice could not be saved. Nothing changed.');
  await loadCopy(redraw);
}

let pollTimer: ReturnType<typeof setTimeout> | undefined;

/** Asks for the jobs, and keeps asking every few seconds while one is waiting or running; when one finishes the written posts and the pictures are asked for again. */
async function loadJobs(redraw: () => void): Promise<void> {
  const before = new Set(state.jobs.filter(jobActive).map((j) => j.id));
  const result = await call('/api/review?view=jobs').catch(() => null);
  if (result?.ok) state.jobs = parseJobs(result.body).slice(0, 8);
  const finished = state.jobs.some((j) => before.has(j.id) && !jobActive(j));
  if (finished) {
    await Promise.all([loadCopy(() => undefined), loadQueueOnly()]);
  }
  // Redrawing would wipe what is being typed or edited: wait for the owner to finish.
  if (state.editing === null && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') redraw();
  clearTimeout(pollTimer);
  if (state.jobs.some(jobActive)) pollTimer = setTimeout(() => void loadJobs(redraw), 4000);
}

async function loadQueueOnly(): Promise<void> {
  const result = await call(`/api/review?view=list&status=${queryStatus(state.filter)}`).catch(() => null);
  if (result?.ok) {
    const parsed = parseQueue(result.body);
    state.queue = parsed.posts;
    state.problems = parsed.problems;
  }
}

async function startWriting(redraw: () => void): Promise<void> {
  const form = state.start;
  if (!looksLikeSite(form.site)) { state.error = 'Type the website address, like acme.com.'; redraw(); return; }
  if (form.networks.length === 0) { state.error = 'Choose at least one network to write for.'; redraw(); return; }
  redraw();
  const done = await post({ job: { site: form.site.trim(), networks: form.networks, weeks: form.weeks, postsPerWeek: form.postsPerWeek, ...(form.page ? { page: true } : {}) } }, 'The request could not be sent. Nothing was started.');
  if (done.ok) {
    state.notice = 'Started. The website is being read; the posts appear below when they are written. Nothing is drawn or paid for until you ask.';
    // The batch is named after the website; remember who it is for, so the draw step starts on that client.
    const batchName = (done.body as { job?: { brand?: unknown } } | null)?.job?.brand;
    if (form.client !== NEW_CLIENT && typeof batchName === 'string') state.clientForBrand[batchName] = form.client;
    state.start.site = '';
  }
  await loadJobs(redraw);
}

async function saveEdit(batch: CopyBatch, post_: CopyPost, network: string, headline: string, caption: string, redraw: () => void): Promise<void> {
  const done = await post({ edit: { brand: batch.brand, planFile: batch.planFile, postId: post_.postId, headline, caption, ...(network ? { network } : {}) } }, 'Your change could not be saved. Nothing changed.');
  if (done.ok) { state.editing = null; state.notice = 'Saved. The words were checked against the website.'; }
  await loadCopy(redraw);
}

async function drawKept(batch: CopyBatch, redraw: () => void, retry = false): Promise<void> {
  const options = clientOptions(state.clients ?? [], batch.brand);
  const client = chosenClient(options, state.clientFor[`${batch.brand}|${batch.planFile}`] ?? state.clientForBrand[batch.brand], batch.brand)?.value ?? batch.brand;
  const done = await post({ draw: { brand: batch.brand, planFile: batch.planFile, client, ...(retry ? { retry: true } : {}) } }, 'The request could not be sent. Nothing was started.');
  if (done.ok) state.notice = retry ? 'Drawing the missing posts again. Pictures already made are kept and not bought twice.' : 'Drawing started for the posts you kept. The pictures appear in the review list when they are ready; nothing is published until you approve them.';
  await Promise.all([loadJobs(redraw), loadCopy(redraw)]);
}

async function putAway(batch: CopyBatch, redraw: () => void): Promise<void> {
  const done = await post({ close: { brand: batch.brand, planFile: batch.planFile } }, 'The batch could not be put away. Nothing changed.');
  if (done.ok) state.notice = 'Put away. Nothing was drawn.';
  await loadCopy(redraw);
}

const NETWORK_NAME: Readonly<Record<string, string>> = Object.fromEntries(NETWORK_CHOICES.map((n) => [n.key, n.label]));

/** The switch between a person approving each poster and the system approving the ones that pass its checks, for one client. */
function approvalControl(client: ClientSummary | undefined, redraw: () => void): HTMLElement {
  const select = h('select', { class: 'rv-input', 'aria-label': 'Who approves the posters' },
    h('option', { value: 'manual' }, 'Manual: you approve each poster in Review'),
    h('option', { value: 'auto' }, 'Automatic: approved by the system after the checks'),
  );
  select.value = client?.approvalMode ?? 'manual';
  select.disabled = client === undefined || state.busy;
  const warning = h('p', { class: 'approval-warning', role: 'note', ...(client?.approvalMode === 'auto' ? {} : { hidden: 'hidden' }) }, AUTO_WARNING);
  select.addEventListener('change', () => {
    if (!client) return;
    const chosen = select.value === 'auto' ? 'auto' : 'manual';
    if (chosen === 'auto' && !confirm(`${AUTO_WARNING}\n\nSwitch ${client.label} to automatic?`)) {
      select.value = client.approvalMode;
      return;
    }
    select.disabled = true;
    void saveApprovalMode(client, chosen).then((problem) => {
      if (problem) state.error = problem;
      redraw();
    });
  });
  return h('div', { class: 'rv-approval' },
    h('label', { class: 'rv-check rv-client-pick' }, 'Approval ', select),
    client === undefined ? h('p', { class: 'muted rv-client-detail' }, 'Choose an existing client to set how its posters are approved. A new client starts on manual.') : null,
    warning,
  );
}

function startView(redraw: () => void): HTMLElement {
  const form = state.start;
  const site = h('input', { class: 'rv-input', type: 'text', inputmode: 'url', maxlength: '200', placeholder: 'acme.com or acme.com/pricing', 'aria-label': 'Website address', value: form.site });
  site.value = form.site;
  site.addEventListener('input', () => { form.site = site.value; });
  const onePage = h('input', { type: 'checkbox', id: 'rv-page' });
  onePage.checked = form.page;
  onePage.addEventListener('change', () => { form.page = onePage.checked; });
  const startOptions = state.clients === null ? [] : startClientOptions(state.clients);
  const picked = startOptions.find((o) => o.value === form.client) ?? startOptions[0];
  const pickedClient = picked && picked.value !== NEW_CLIENT ? state.clients?.find((c) => c.brand === picked.value) : undefined;
  const networks = NETWORK_CHOICES.map((n) => {
    const box = h('input', { type: 'checkbox', id: `rv-net-${n.key}` });
    box.checked = form.networks.includes(n.key);
    box.addEventListener('change', () => { form.networks = box.checked ? [...form.networks, n.key] : form.networks.filter((k) => k !== n.key); });
    // For an existing client: which accounts are connected on this network and which are not.
    const connection = networkState(pickedClient, n.key);
    const note = connection === null ? null
      : connection.state === 'not-connected' ? h('small', { class: 'rv-net-note rv-net-off' }, 'not connected')
        : h('small', { class: `rv-net-note${connection.state === 'problem' ? ' rv-net-problem' : ' rv-net-on'}` }, `${connection.account ?? 'connected'}${connection.state === 'problem' ? ' (has a problem)' : ''}`);
    return h('label', { class: 'rv-check', for: `rv-net-${n.key}` }, box, ` ${n.label} `, note);
  });
  const number = (label: string, value: number, max: number, set: (n: number) => void): HTMLElement => {
    const select = h('select', { class: 'rv-input', 'aria-label': label }, ...Array.from({ length: max }, (_, i) => h('option', { value: String(i + 1) }, String(i + 1))));
    select.value = String(value);
    select.addEventListener('change', () => set(Number(select.value)));
    return h('label', { class: 'rv-check rv-number' }, `${label} `, select);
  };
  const running = state.jobs.some((j) => j.kind === 'copy' && jobActive(j));
  const clientSelect = h('select', { class: 'rv-input', 'aria-label': 'Client' }, ...startOptions.map((o) => h('option', { value: o.value }, o.label)));
  if (picked) clientSelect.value = picked.value;
  clientSelect.disabled = state.clients === null;
  clientSelect.addEventListener('change', () => {
    form.client = clientSelect.value;
    // Tick the networks this client has accounts on (left as they were when it has none, so the choice is never emptied).
    const chosen = state.clients?.find((c) => c.brand === form.client);
    const connected = chosen ? connectedNetworkKeys(chosen) : [];
    if (connected.length > 0) form.networks = connected;
    redraw();
  });
  return h(
    'section',
    { class: 'rv-copy rv-start', 'aria-label': 'Write posts for a website' },
    h('h3', {}, 'Write posts for a website'),
    h('p', { class: 'rv-hint' }, 'The website is read and its posts are written, with a caption for each network. Nothing is drawn, paid for or published at this step.'),
    h('div', { class: 'rv-actions' }, site),
    h('div', { class: 'rv-actions' }, h('label', { class: 'rv-check rv-client-pick' }, 'Client ', clientSelect), h('p', { class: 'muted rv-client-detail' }, state.clients === null ? 'Loading your clients…' : picked?.detail ?? '')),
    approvalControl(pickedClient, redraw),
    h('div', { class: 'rv-actions' }, h('label', { class: 'rv-check', for: 'rv-page' }, onePage, ' Only this page (a new website only)')),
    h('div', { class: 'rv-actions' }, h('b', {}, 'Write for:'), ...networks),
    h('div', { class: 'rv-actions rv-last' }, number('Weeks', form.weeks, 4, (n) => { form.weeks = n; }), number('Posts a week', form.postsPerWeek, 7, (n) => { form.postsPerWeek = n; }),
      button(running ? 'Writing…' : 'Write the posts', 'btn btn-primary', () => void startWriting(redraw), 'Write the posts', state.busy)),
  );
}

function jobsView(): HTMLElement | null {
  if (state.jobs.length === 0) return null;
  return h('section', { class: 'rv-copy rv-jobs', 'aria-label': 'What is being made' }, h('h3', {}, 'What is being made'), ...state.jobs.map((j) => h('p', { class: `rv-job rv-job-${j.state}`, role: j.state === 'failed' ? 'alert' : 'status' }, jobText(j))));
}

function postCaptions(batch: CopyBatch, p: CopyPost, locked: boolean, redraw: () => void): HTMLElement[] {
  const batchKey = `${batch.brand}|${batch.planFile}`;
  const entries: Array<{ network: string; label: string; text: string; edited: boolean }> = p.captions && Object.keys(p.captions).length > 0
    ? Object.entries(p.captions).map(([network, c]) => ({ network, label: NETWORK_NAME[network] ?? network, text: c.text, edited: c.edited === true }))
    : [{ network: '', label: 'Caption', text: p.caption, edited: p.edited === true }];
  return entries.map((e) => {
    const isEditing = state.editing?.batch === batchKey && state.editing.postId === p.postId && state.editing.network === e.network;
    const { body, hashtags } = splitHashtags(e.text);
    if (!isEditing) {
      return h('div', { class: 'rv-copy-caption' },
        h('small', { class: 'muted' }, `${e.label}${e.edited ? ' · edited by you' : ''}`),
        h('p', {}, body),
        hashtags ? h('p', { class: 'muted' }, hashtags) : null,
        button('Edit', 'btn', () => { state.editing = { batch: batchKey, postId: p.postId, network: e.network }; redraw(); }, `Edit the ${e.label} words of: ${p.headline}`, state.busy || locked));
    }
    const editing = state.editing as NonNullable<State['editing']>;
    const headline = h('input', { class: 'rv-input', type: 'text', maxlength: '300', 'aria-label': 'Headline' });
    headline.value = editing.draft?.headline ?? p.headline;
    const caption = h('textarea', { class: 'rv-input rv-textarea', rows: '6', maxlength: '4000', 'aria-label': `${e.label} caption` });
    caption.value = editing.draft?.caption ?? body;
    // What is typed is kept in the page's state, so a redraw (the page refreshes itself) does not wipe it.
    const remember = (): void => { editing.draft = { headline: headline.value, caption: caption.value }; };
    headline.addEventListener('input', remember);
    caption.addEventListener('input', remember);
    // After a redraw the owner carries on typing where they were.
    if (editing.draft) setTimeout(() => { if (caption.isConnected) { caption.focus(); caption.setSelectionRange(caption.value.length, caption.value.length); } }, 0);
    return h('div', { class: 'rv-copy-caption' },
      h('small', { class: 'muted' }, `Editing ${e.label}. The words are checked against the website before they are saved.${hashtags ? ' The hashtags stay as they are.' : ''}`),
      headline, caption,
      h('div', { class: 'rv-actions' },
        button('Save', 'btn btn-primary', () => void saveEdit(batch, p, e.network, headline.value, caption.value, redraw), 'Save', state.busy),
        button('Cancel', 'btn', () => { state.editing = null; redraw(); })));
  });
}

function copyView(redraw: () => void): HTMLElement | null {
  const open = state.copy.filter((b) => b.posts.length > 0);
  if (open.length === 0) return null;
  return h(
    'section',
    { class: 'rv-copy', 'aria-label': 'Written posts waiting for your choice' },
    h('h3', {}, 'Written posts: keep the ones you want drawn'),
    h('p', { class: 'rv-hint' }, 'No picture has been bought yet. Only the posts you keep will be drawn.'),
    ...open.map((batch) => {
      const kept = batch.posts.filter((p) => p.state === 'kept').length;
      const waiting = batch.posts.filter((p) => p.state === 'pending').length;
      const batchKey = `${batch.brand}|${batch.planFile}`;
      // A batch is drawn once only: after it was asked for, the button says where it stands instead.
      const drawJob = state.jobs.find((j) => j.kind === 'draw' && j.brand === batch.brand && j.planFile === batch.planFile);
      // Once drawing is asked for the choices and words are final.
      const locked = batch.drawnAt !== undefined || drawJob !== undefined;
      const options = state.clients === null ? [] : clientOptions(state.clients, batch.brand);
      const chosen = chosenClient(options, state.clientFor[batchKey] ?? state.clientForBrand[batch.brand], batch.brand);
      const client = h('select', { class: 'rv-input', 'aria-label': 'Client' }, ...options.map((o) => h('option', { value: o.value }, o.label)));
      if (chosen) client.value = chosen.value;
      client.disabled = locked || state.clients === null;
      client.addEventListener('change', () => { state.clientFor[batchKey] = client.value; redraw(); });
      return h(
        'div',
        { class: 'rv-copy-batch' },
        h('b', {}, `${batch.brand} · ${batch.planFile}`),
        batch.drawnAt ? h('p', { class: 'rv-copy-advice' }, 'Drawing stopped before it finished. The choices and words are final now; pictures already made are kept, and the button below draws only the posts that have none yet.') : null,
        ...batch.posts.map((p) => h(
          'div',
          { class: `rv-copy-post rv-copy-${p.state}` },
          h('p', {}, h('b', {}, p.headline), p.edited ? ' (edited by you)' : ''),
          ...postCaptions(batch, p, locked, redraw),
          p.advice ? h('p', { class: 'rv-copy-advice' }, `Suggested drop: ${p.advice}`) : null,
          h('div', { class: 'rv-actions' },
            h('span', {}, p.state === 'kept' ? 'Kept' : p.state === 'dropped' ? 'Dropped' : 'Waiting for you'),
            button('Keep', `btn${p.state === 'kept' ? ' btn-primary' : ''}`, () => void chooseCopy(batch, p.postId, 'keep', redraw), `Keep: ${p.headline}`, state.busy || locked),
            button('Drop', 'btn', () => void chooseCopy(batch, p.postId, 'drop', redraw), `Drop: ${p.headline}`, state.busy || locked),
          ),
        )),
        h('div', { class: 'rv-actions rv-draw' },
          h('span', {}, `${kept} kept${waiting > 0 ? `, ${waiting} still waiting for your choice (they will not be drawn)` : ''}`),
          h('label', { class: 'rv-check' }, 'Client ', client),
          h('p', { class: 'muted rv-client-detail' }, state.clients === null ? 'Loading your clients…' : chosen?.detail ?? ''),
          approvalControl(chosen ? state.clients?.find((c) => c.brand === chosen.value) : undefined, redraw),
          button(drawJob ? (jobActive(drawJob) ? 'Drawing…' : drawJob.state === 'failed' ? 'Drawing stopped' : 'Drawn') : `Draw the ${kept} kept post${kept === 1 ? '' : 's'}`, 'btn btn-primary', () => void drawKept(batch, redraw), `Draw the kept posts of ${batch.brand}`, state.busy || kept === 0 || drawJob !== undefined || chosen === undefined),
          drawJob?.state === 'failed' ? button('Draw the posts that are missing', 'btn btn-primary', () => void drawKept(batch, redraw, true), `Draw again the kept posts of ${batch.brand} that have no picture`, state.busy) : null,
          button('Put this batch away', 'btn', () => void putAway(batch, redraw), `Put away: ${batch.brand} ${batch.planFile}`, state.busy),
        ),
      );
    }),
  );
}

async function loadQueue(redraw: () => void): Promise<void> {
  state.error = null;
  void loadCopy(redraw);
  void loadJobs(redraw);
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

export function reviewPage(redraw: () => void, clients: readonly ClientSummary[] | null, setApprovalMode: (client: ClientSummary, mode: 'manual' | 'auto') => Promise<string | null>): HTMLElement {
  state.clients = clients;
  saveApprovalMode = setApprovalMode;
  // The page redraws itself now and then: a box the owner is typing in keeps its focus and cursor (found by its label in the new page).
  const typing = document.activeElement;
  const focused = (typing instanceof HTMLInputElement || typing instanceof HTMLTextAreaElement) && typing.closest('.rv') !== null && typing.getAttribute('aria-label') ? { label: typing.getAttribute('aria-label') as string, start: typing.selectionStart, end: typing.selectionEnd } : null;
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
  const page = h(
    'div',
    { class: 'rv' },
    state.notice ? h('p', { class: 'rv-notice', role: 'status' }, state.notice) : null,
    state.error ? h('p', { class: 'rv-error', role: 'alert' }, state.error) : null,
    ...state.problems.map((p) => h('p', { class: 'rv-error', role: 'alert' }, p)),
    startView(redraw),
    jobsView(),
    copyView(redraw),
    tabs,
    state.queue === null && !state.error ? h('p', { class: 'empty' }, 'Loading…') : null,
    views,
    state.view === 'compare' && state.queue !== null ? compareView(redraw) : null,
    h('div', { class: 'rv-grid' }, state.view === 'compare' ? h('div', {}) : h('div', {}, list, empty), state.openId ? (state.detail ? detailView(state.detail, redraw) : h('p', { class: 'empty' }, 'Loading…')) : h('p', { class: 'empty rv-hint' }, 'Choose a poster to look at it.')),
  );
  if (focused) {
    setTimeout(() => {
      const box = [...page.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')].find((e) => e.getAttribute('aria-label') === focused.label);
      if (!box || !page.isConnected || document.activeElement === box) return;
      box.focus();
      if (focused.start !== null && focused.end !== null) box.setSelectionRange(focused.start, focused.end);
    }, 0);
  }
  return page;
}

/** Forgets what was loaded, so the page asks again (after a refresh or when the owner comes back to it). */
export function resetReview(): void {
  state.queue = null;
  state.error = null;
}

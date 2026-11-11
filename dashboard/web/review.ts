import type { ClientSummary } from './clients.ts';

/** What the review page shows, kept apart from the drawing so it can be tested: the labels, the filters and the wording of each state. */
export type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'blocked' | 'superseded' | 'held';
export type ReviewFilter = 'pending' | 'approved' | 'rejected';
export const REVIEW_FILTERS: readonly { key: ReviewFilter; label: string }[] = [
  { key: 'pending', label: 'To review' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
];

export const REASON_LABELS: Readonly<Record<string, string>> = {
  weak_copy: 'The wording is weak',
  irrelevant_image: 'The picture does not fit',
  poor_design: 'Poor design',
  incorrect_branding: 'Wrong branding',
  factual_issue: 'A fact is wrong',
  repetitive: 'Too like other posters',
  style: 'Not our style',
  other: 'Something else',
};

export const STATUS_LABELS: Readonly<Record<ReviewStatus, string>> = {
  pending: 'Waiting for you',
  approved: 'Approved',
  rejected: 'Rejected',
  blocked: 'Failed the checks',
  superseded: 'Replaced by a newer version',
  held: 'Confirm again (the record was repaired)',
};

export interface ReviewSummary {
  versionId: string;
  brand: string;
  postId: string;
  /** The plan the poster belongs to: posters of one brand and plan are one week's batch. */
  planFile: string;
  versionNumber: number;
  status: ReviewStatus;
  headline: string;
  caption: string;
  createdAt: string;
  costUsd: number;
  decidedBy?: string;
  decidedAt?: string;
  reason?: string;
  /** The network this version was written for, when it was written for one. */
  network?: string;
  /** Set when this version is a slide of a carousel (position 1 to count) or one of its captions (position 0). */
  carousel?: { id: string; position: number; count: number };
}

/** The carousel a version belongs to, when the service says so in a well formed way. */
function carouselOf(value: unknown): { carousel?: NonNullable<ReviewSummary['carousel']> } {
  const c = value as { id?: unknown; position?: unknown; count?: unknown } | null;
  return c && typeof c.id === 'string' && c.id !== '' && Number.isInteger(c.position) && Number.isInteger(c.count) && (c.position as number) >= 0 && (c.count as number) >= 2
    ? { carousel: { id: c.id, position: c.position as number, count: c.count as number } } : {};
}

const STATUSES: readonly string[] = ['pending', 'approved', 'rejected', 'blocked', 'superseded', 'held'];

/** The list the service sends, kept only where it is well formed: a malformed entry is dropped, never drawn. */
export function parseQueue(value: unknown): { posts: ReviewSummary[]; reasons: string[]; problems: string[] } {
  const raw = value as { posts?: unknown; reasons?: unknown; problems?: unknown } | null;
  const problems = Array.isArray(raw?.problems) ? raw.problems.flatMap((p): string[] => {
    const e = p as { brand?: unknown; message?: unknown } | null;
    return e && typeof e.brand === 'string' && typeof e.message === 'string' ? [`${e.brand}: ${e.message}`] : [];
  }) : [];
  const posts = Array.isArray(raw?.posts) ? raw.posts.flatMap((p): ReviewSummary[] => {
    const e = p as Partial<ReviewSummary> | null;
    if (!e || typeof e.versionId !== 'string' || typeof e.brand !== 'string' || typeof e.postId !== 'string' || typeof e.headline !== 'string' || typeof e.caption !== 'string' || typeof e.status !== 'string' || !STATUSES.includes(e.status)) return [];
    return [{
      versionId: e.versionId, brand: e.brand, postId: e.postId, planFile: typeof e.planFile === 'string' ? e.planFile : '', versionNumber: Number(e.versionNumber) || 1, status: e.status as ReviewStatus, headline: e.headline, caption: e.caption,
      createdAt: typeof e.createdAt === 'string' ? e.createdAt : '', costUsd: Number(e.costUsd) || 0,
      ...(typeof e.network === 'string' ? { network: e.network } : {}), ...carouselOf(e.carousel),
      ...(typeof e.decidedBy === 'string' ? { decidedBy: e.decidedBy } : {}), ...(typeof e.decidedAt === 'string' ? { decidedAt: e.decidedAt } : {}), ...(typeof e.reason === 'string' ? { reason: e.reason } : {}),
    }];
  }) : [];
  const reasons = Array.isArray(raw?.reasons) ? raw.reasons.filter((r): r is string => typeof r === 'string' && r in REASON_LABELS) : Object.keys(REASON_LABELS);
  return { posts, reasons: reasons.length > 0 ? reasons : Object.keys(REASON_LABELS), problems };
}

/** The status the service is asked for: the "To review" tab shows what is waiting and what must be confirmed again. */
export const queryStatus = (filter: ReviewFilter): string => (filter === 'pending' ? 'open' : filter);

/** Where to ask for a version's picture, as a preview or as a download. */
export const imageUrl = (versionId: string, view: 'image' | 'download' | 'logo' = 'image'): string => `/api/review?view=${view}&id=${encodeURIComponent(versionId)}`;

/** How the page words a failed request: the service's own words when it gave any. */
export function failureText(body: unknown, status: number): string {
  const message = (body as { error?: unknown } | null)?.error;
  return typeof message === 'string' && message ? message : `That did not work (${status}).`;
}

/** The poster's cost as shown to the owner. */
export const costText = (usd: number): string => (usd > 0 ? `$${usd.toFixed(3)}` : 'free');

export interface Batch {
  key: string;
  brand: string;
  planFile: string;
  posts: ReviewSummary[];
}

/** Posters grouped into the batch they were made in (one brand, one plan), in the order posts were planned, so a week can be judged as a whole. */
export function groupBatches(posts: readonly ReviewSummary[]): Batch[] {
  const batches = new Map<string, Batch>();
  for (const post of posts) {
    const key = `${post.brand}|${post.planFile}`;
    const batch = batches.get(key) ?? { key, brand: post.brand, planFile: post.planFile, posts: [] };
    batch.posts.push(post);
    batches.set(key, batch);
  }
  return [...batches.values()].map((b) => ({ ...b, posts: [...b.posts].sort((x, y) => x.postId.localeCompare(y.postId)) })).sort((a, b) => a.brand.localeCompare(b.brand) || b.planFile.localeCompare(a.planFile));
}

/** The question the owner is asked when looking at a batch together. */
export const BATCH_QUESTION = 'Would these look meaningfully different if they were all published in the same week\'s feed?';
/** How a poster was branded, as the review service records it (frozen before the picture was bought). */
export interface BrandingRecord {
  intendedMode: 'authentic_logo' | 'text_only_fallback' | 'logo_required_unavailable';
  appliedMode: 'text_only' | 'authentic_logo' | 'none';
  status: 'resolved' | 'awaiting_compositor' | 'applied' | 'blocked';
  logoKind?: 'wordmark' | 'symbol';
  /** True when a kept copy of the logo can be shown. */
  hasLogoFile: boolean;
  sourcePage?: string;
  sourceUrl?: string;
  provenance?: string;
  reason?: string;
  logoWidth?: number;
  logoHeight?: number;
  /** Where and how the logo was put on this poster; only a poster that carries it has one. */
  placement?: { corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'; treatment: 'none' | 'halo' | 'plate'; contrast: number };
}

const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | null => (typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/** Reads the branding record of a version, or null for a version made before it was kept. Anything unexpected is ignored rather than trusted. */
export function parseBranding(raw: unknown): BrandingRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const intendedMode = oneOf(r['intendedMode'], ['authentic_logo', 'text_only_fallback', 'logo_required_unavailable'] as const);
  const appliedMode = oneOf(r['appliedMode'], ['text_only', 'authentic_logo', 'none'] as const);
  const status = oneOf(r['status'], ['resolved', 'awaiting_compositor', 'applied', 'blocked'] as const);
  if (!intendedMode || !appliedMode || !status) return null;
  const sourcePage = text(r['sourcePage']);
  const sourceUrl = text(r['sourceUrl']);
  const provenance = text(r['provenance']);
  const reason = text(r['reason']);
  const logoKind = oneOf(r['logoKind'], ['wordmark', 'symbol'] as const);
  const p = typeof r['placement'] === 'object' && r['placement'] !== null ? (r['placement'] as Record<string, unknown>) : null;
  const corner = p ? oneOf(p['corner'], ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const) : null;
  const treatment = p ? oneOf(p['treatment'], ['none', 'halo', 'plate'] as const) : null;
  const placement = corner && treatment && typeof p?.['contrast'] === 'number' && Number.isFinite(p['contrast']) ? { corner, treatment, contrast: p['contrast'] } : undefined;
  return {
    intendedMode, appliedMode, status, hasLogoFile: typeof r['logoFile'] === 'string' && r['logoFile'] !== '',
    ...(logoKind ? { logoKind } : {}), ...(sourcePage ? { sourcePage } : {}), ...(sourceUrl ? { sourceUrl } : {}), ...(provenance ? { provenance } : {}), ...(reason ? { reason } : {}),
    ...(typeof r['logoWidth'] === 'number' ? { logoWidth: r['logoWidth'] } : {}), ...(typeof r['logoHeight'] === 'number' ? { logoHeight: r['logoHeight'] } : {}),
    ...(placement ? { placement } : {}),
  };
}

export interface BrandingView {
  /** `done`: the real logo is on the poster. `note`: a real logo was found but is not on it. `plain`: the brand name and web address as text, no logo was usable. */
  tone: 'done' | 'note' | 'plain';
  headline: string;
  explanation: string;
  rows: Array<[string, string]>;
}

/** What the owner is told. A real logo is never said to be on a poster unless the record says it was applied. */
export function brandingView(b: BrandingRecord): BrandingView {
  const onPoster = b.appliedMode === 'authentic_logo' ? 'The website\'s real logo' : b.appliedMode === 'text_only' ? 'The brand name and web address, written as text' : 'Nothing: this poster should not have been made';
  const rows: Array<[string, string]> = [['On this poster', onPoster]];
  if (b.logoKind) rows.push(['Logo found', `${b.logoKind === 'wordmark' ? 'Full logo' : 'Symbol only'}${b.logoWidth && b.logoHeight ? `, ${Math.round(b.logoWidth)} × ${Math.round(b.logoHeight)}` : ''}`]);
  if (b.sourcePage) rows.push(['Found on', b.sourcePage]);
  if (b.sourceUrl) rows.push(['Picture address', b.sourceUrl]);
  if (b.provenance) rows.push(['Why it is their logo', b.provenance]);
  // Only a poster whose own record says where the logo was put is said to carry it.
  if (b.status === 'applied' && b.placement) {
    const where = b.placement.corner.replace('-', ' ');
    const how = b.placement.treatment === 'none' ? 'nothing added behind it' : b.placement.treatment === 'halo' ? 'a thin outline around it so it stays readable' : 'a small plate behind it so it stays readable';
    return { tone: 'done', headline: 'Real logo applied', explanation: 'The website\'s own logo, unchanged, is on this poster.', rows: [...rows, ['Placed', `${where} corner, ${how}`]] };
  }
  if (b.intendedMode === 'authentic_logo') return { tone: 'note', headline: 'Real logo found, not applied', explanation: b.reason ?? 'The website\'s logo was found and verified, but this poster uses the brand name and web address as text.', rows };
  return { tone: 'plain', headline: 'Text sign-off used: no usable logo', explanation: b.reason ? `No real logo was used. ${b.reason}` : 'No real logo was used on this poster.', rows };
}


/** The networks a client can be written for, in the order they are offered. */
export const NETWORK_CHOICES: readonly { key: string; label: string }[] = [
  { key: 'instagram', label: 'Instagram' },
  { key: 'facebook', label: 'Facebook' },
  { key: 'linkedin', label: 'LinkedIn' },
  { key: 'google', label: 'Google Business' },
];

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed';

export interface JobView {
  id: string;
  kind: 'copy' | 'draw' | 'carousel';
  brand: string;
  site: string;
  state: JobState;
  step?: number;
  planFile?: string;
  error?: string;
  /** When it ended (milliseconds), for a job that has ended. */
  finishedAt?: number;
}

/** The jobs the service sends, kept only where well formed. */
export function parseJobs(value: unknown): JobView[] {
  const list = (value as { jobs?: unknown } | null)?.jobs;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry): JobView[] => {
    const j = entry as Record<string, unknown> | null;
    if (!j || typeof j['id'] !== 'string' || (j['kind'] !== 'copy' && j['kind'] !== 'draw' && j['kind'] !== 'carousel') || typeof j['brand'] !== 'string' || typeof j['site'] !== 'string' || !['queued', 'running', 'succeeded', 'failed'].includes(String(j['state']))) return [];
    const error = (j['error'] as { message?: unknown } | undefined)?.message;
    const planFile = typeof j['planFileMade'] === 'string' ? j['planFileMade'] : typeof j['planFile'] === 'string' ? j['planFile'] : undefined;
    return [{ id: j['id'], kind: j['kind'], brand: j['brand'], site: j['site'], state: j['state'] as JobState, ...(typeof j['step'] === 'number' ? { step: j['step'] } : {}), ...(planFile ? { planFile } : {}), ...(typeof error === 'string' ? { error } : {}), ...(Number.isFinite(Date.parse(String(j['finishedAt']))) ? { finishedAt: Date.parse(String(j['finishedAt'])) } : {}) }];
  });
}

export const jobActive = (job: JobView): boolean => job.state === 'queued' || job.state === 'running';

/** How long a job that finished well stays in the box, and how long one that stopped does (a stop stays a little longer, so it is not missed). */
export const DONE_VISIBLE_MS = 15 * 60 * 1000;
export const STOPPED_VISIBLE_MS = 60 * 60 * 1000;

/**
 * The jobs worth showing now: the ones in progress, then the ones that just finished. Older finished jobs are history and are left out. A finished job
 * with no end time (an older record) is not shown, and neither is a stop that a later try of the same work has replaced.
 */
export function visibleJobs(jobs: readonly JobView[], now: number): JobView[] {
  const recent = (job: JobView): boolean => job.finishedAt !== undefined && now - job.finishedAt >= 0 && now - job.finishedAt <= (job.state === 'failed' ? STOPPED_VISIBLE_MS : DONE_VISIBLE_MS);
  // A stop that a later try of the same work has since replaced (the same kind, client and plan, done or still going) is no longer news.
  const replaced = (job: JobView): boolean =>
    job.state === 'failed' && jobs.some((other) => other !== job && other.kind === job.kind && other.brand === job.brand && other.planFile === job.planFile && other.state !== 'failed' && (jobActive(other) || (other.finishedAt ?? 0) > (job.finishedAt ?? 0)));
  const active = jobs.filter(jobActive);
  const finished = jobs.filter((j) => !jobActive(j) && recent(j) && !replaced(j)).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
  return [...active, ...finished];
}

const STEP_WORDS: Readonly<Record<number, string>> = { 1: 'reading the website', 2: 'writing the posts', 3: 'drawing the pictures', 4: 'putting them in the review list' };
const CAROUSEL_STEP_WORDS: Readonly<Record<number, string>> = { 1: 'planning the slides', 2: 'writing the captions', 3: 'drawing the slides', 4: 'putting it in the review list' };

/** What a job is doing, in plain words. */
export function jobText(job: JobView): string {
  if (job.kind === 'carousel') {
    const what = `Making a carousel for ${job.site}`;
    if (job.state === 'queued') return `${what}: waiting for its turn`;
    if (job.state === 'running') return `${what}: ${job.step ? CAROUSEL_STEP_WORDS[job.step] ?? 'working' : 'starting'}`;
    if (job.state === 'succeeded') return `${what}: done, the carousel is waiting for you in the list below`;
    return `${what}: stopped. ${(job.error ?? 'It did not finish').replace(/[.\s]+$/, '')}. Nothing was published.`;
  }
  const what = job.kind === 'copy' ? `Writing posts for ${job.site}` : `Drawing the kept posts of ${job.brand}${job.planFile ? ` (${job.planFile.replace(/\.json$/, '')})` : ''}`;
  if (job.state === 'queued') return `${what}: waiting for its turn`;
  if (job.state === 'running') return `${what}: ${job.step ? STEP_WORDS[job.step] ?? 'working' : 'starting'}`;
  if (job.state === 'succeeded') return job.kind === 'copy' ? `${what}: done, the posts are waiting for you below` : `${what}: done, the pictures are waiting for you to approve`;
  return `${what}: stopped. ${(job.error ?? 'It did not finish').replace(/[.\s]+$/, '')}. Nothing was published.`;
}

/** Whether a website address looks like something the service will accept: a real domain, with or without https://. */
export function looksLikeSite(value: string): boolean {
  const text = value.trim();
  if (text === '' || text.length > 200 || /\s/.test(text)) return false;
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(url.hostname) && !/^\d+(\.\d+)*$/.test(url.hostname);
  } catch {
    return false;
  }
}

const ONLY_TAGS = /^(?:#[^\s#]+\s*)+$/;

/** A caption's own words and the hashtags that close it. The owner edits the words; the hashtags stay as the writer made them (the service adds them back). */
export function splitHashtags(text: string): { body: string; hashtags: string } {
  const paragraphs = text.trim().split(/\n{2,}/);
  const tags: string[] = [];
  while (paragraphs.length > 1 && ONLY_TAGS.test((paragraphs.at(-1) as string).trim())) tags.unshift((paragraphs.pop() as string).trim());
  return { body: paragraphs.join('\n\n').trim(), hashtags: tags.join(' ') };
}

/** One choice in the "which client" list under a written batch. */
export interface ClientOption {
  /** The client's name as the engine knows it. */
  value: string;
  label: string;
  /** What choosing it means, in plain words: where posts will go and who approves them. */
  detail: string;
}

const networkName = (platform: string): string => NETWORK_CHOICES.find((n) => n.key === platform)?.label ?? platform;

const NO_ACCOUNTS = 'no accounts connected';

/** The accounts a client posts to, e.g. "Instagram: @acme, LinkedIn: Acme Ltd (problem)". */
export function accountsText(client: Pick<ClientSummary, 'channels'>): string {
  const own = client.channels.filter((c) => c.id !== null || c.account !== null);
  if (own.length === 0) return NO_ACCOUNTS;
  return own.map((c) => `${networkName(c.platform)}: ${c.account ?? 'connected'}${c.ok ? '' : ' (has a problem)'}`).join(', ');
}

/** What a client's approval mode means for a poster that was just drawn. */
export const approvalText = (mode: ClientSummary['approvalMode']): string =>
  mode === 'auto'
    ? 'Automatic: posters that pass the automatic checks are approved by the system and published without you looking at them.'
    : 'Manual: you approve each poster in Review before it can be published.';

/** The clients you already have, by name, each with where its posts go and who approves them. */
export function existingClientOptions(clients: readonly ClientSummary[]): ClientOption[] {
  return [...clients].sort((a, b) => a.label.localeCompare(b.label)).map((c): ClientOption => ({
    value: c.brand,
    label: c.label,
    detail: `${accountsText(c) === NO_ACCOUNTS ? 'No accounts are connected, so nothing can be published yet.' : `Posts to ${accountsText(c)}.`} ${approvalText(c.approvalMode)}`,
  }));
}

/**
 * The clients a batch's posters can be drawn for. The existing clients come first; when the website's own name is not one of them it is offered
 * first as a new client, which has no accounts yet. Nothing is typed, so a name cannot be mistyped into a different client.
 */
export function clientOptions(clients: readonly ClientSummary[], batchBrand: string): ClientOption[] {
  const existing = existingClientOptions(clients);
  if (clients.some((c) => c.brand === batchBrand)) return existing;
  return [{ value: batchBrand, label: `New client: ${batchBrand}`, detail: `${batchBrand} is not one of your clients yet, so it has no accounts connected. Connect accounts on the Clients page before anything can be published.` }, ...existing];
}

/** The choice to show: the one picked earlier if it is still on offer, else the client named like the website, else the first. */
export function chosenClient(options: readonly ClientOption[], picked: string | undefined, batchBrand: string): ClientOption | undefined {
  return options.find((o) => o.value === picked) ?? options.find((o) => o.value === batchBrand) ?? options[0];
}

/** The value of the "new client" choice in the write form: the client is named after the website. */
export const NEW_CLIENT = '';

/** The choices for who the posts are written for: a new client named after the website first, then the existing clients. */
export function startClientOptions(clients: readonly ClientSummary[]): ClientOption[] {
  const newClient: ClientOption = { value: NEW_CLIENT, label: 'New client (named after the website)', detail: 'A new client with no accounts connected yet. Connect accounts on the Clients page before anything can be published.' };
  return [newClient, ...existingClientOptions(clients)];
}

export interface NetworkState {
  state: 'connected' | 'problem' | 'not-connected';
  /** The account's name when one is connected. */
  account: string | null;
}

/** Whether a client has an account connected on a network, for the "write for" choices. Null when no client is chosen yet (a new client has none). */
export function networkState(client: Pick<ClientSummary, 'channels'> | undefined, platform: string): NetworkState | null {
  if (client === undefined) return null;
  const own = client.channels.find((c) => c.platform === platform && (c.id !== null || c.account !== null));
  if (!own) return { state: 'not-connected', account: null };
  return { state: own.ok ? 'connected' : 'problem', account: own.account };
}

/** The networks a client has an account on, in the order they are offered; used to tick the right boxes when the client is chosen. */
export const connectedNetworkKeys = (client: Pick<ClientSummary, 'channels'>): string[] =>
  NETWORK_CHOICES.filter((n) => networkState(client, n.key)?.state !== 'not-connected').map((n) => n.key);

/** What a poster's sign-off says: the brand's name and the website's address, unless the owner changed either for this poster. */
export interface SignoffView { brandName: string; domain: string; changed: boolean }

export function signoffView(batch: { signoffDefault?: { brandName: string; domain: string } }, post: { signoff?: { brandName?: string; domain?: string } }): SignoffView | null {
  const base = batch.signoffDefault;
  if (!base) return null;
  const brandName = post.signoff?.brandName ?? base.brandName;
  const domain = post.signoff?.domain ?? base.domain;
  return { brandName, domain, changed: brandName !== base.brandName || domain !== base.domain };
}

/** What a poster's sign-off line says in words, e.g. "Alsonotify | alsonotify.com", or what is left off. */
export function signoffText(view: Pick<SignoffView, 'brandName' | 'domain'>): string {
  if (view.brandName !== '' && view.domain !== '') return `${view.brandName} | ${view.domain}`;
  if (view.brandName !== '') return `${view.brandName} (no web address)`;
  if (view.domain !== '') return `${view.domain} (no brand name)`;
  return 'no brand name and no web address';
}

/** The time of day a post goes out when none is chosen (India time). */
export const DEFAULT_POST_TIME = '10:00';
/** How far ahead the first post may be put, as the engine allows. */
export const MAX_START_DAYS_AHEAD = 180;

/** Tomorrow's date in India time, YYYY-MM-DD: the earliest day the first post can be put on. */
export const tomorrowIst = (now: number): string => new Date(now + 5.5 * 3600_000 + 86_400_000).toISOString().slice(0, 10);

/** What is wrong with the day and time chosen for the posts, in plain words; null when they are fine (the day may be left empty). */
export function whenProblem(startDate: string, time: string, now: number): string | null {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return 'Choose the time of day the posts go out, like 10:00.';
  if (startDate === '') return null;
  const at = Date.parse(`${startDate}T00:00:00Z`);
  // 30 February parses in JavaScript (as 2 March), so the day must read back as the same day.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== startDate) return 'Choose a real day for the first post.';
  if (startDate < tomorrowIst(now)) return 'The first post can go out tomorrow or later (India time).';
  if (at - Date.parse(`${tomorrowIst(now)}T00:00:00Z`) > MAX_START_DAYS_AHEAD * 86_400_000) return `The first post must be within ${MAX_START_DAYS_AHEAD} days.`;
  return null;
}

/** What a network takes in a caption, as the service sends it. */
export interface CaptionRules { maxCaption: number; recommendedMin: number; recommendedMax: number; visibleChars: number; maxHashtags: number }

/** The caption rules of every network, keeping only what is well formed. */
export function parseCaptionRules(value: unknown): Record<string, CaptionRules> {
  const out: Record<string, CaptionRules> = {};
  if (typeof value !== 'object' || value === null) return out;
  for (const [network, raw] of Object.entries(value as Record<string, unknown>)) {
    const r = raw as Record<string, unknown> | null;
    const whole = (k: string): number | null => (typeof r?.[k] === 'number' && Number.isFinite(r[k] as number) && (r[k] as number) >= 0 ? (r[k] as number) : null);
    const maxCaption = whole('maxCaption');
    const recommendedMin = whole('recommendedMin');
    const recommendedMax = whole('recommendedMax');
    const visibleChars = whole('visibleChars');
    const maxHashtags = whole('maxHashtags');
    if (maxCaption === null || recommendedMin === null || recommendedMax === null || visibleChars === null || maxHashtags === null || recommendedMin > recommendedMax || recommendedMax > maxCaption) continue;
    out[network] = { maxCaption, recommendedMin, recommendedMax, visibleChars, maxHashtags };
  }
  return out;
}

export type MeterLevel = 'short' | 'good' | 'long' | 'over';
export interface CaptionMeter {
  /** The characters of the words (the closing hashtags are sent after them and are not counted). */
  length: number;
  level: MeterLevel;
  /** One line for the owner: the count, what to aim for, and what is wrong if anything. */
  text: string;
  /** The start of the caption a reader sees before the network folds the rest behind "more", cut at a whole word. */
  seen: string;
  /** Whether part of the caption is folded away. */
  folded: boolean;
}

/** How a caption reads against what its network takes: its length, where it falls against the range worth aiming for, and what a reader sees first. */
export function captionMeter(text: string, rules: CaptionRules, networkLabel: string): CaptionMeter {
  const words = splitHashtags(text).body.trim();
  const length = words.length;
  const aim = `${rules.recommendedMin} to ${rules.recommendedMax}`;
  const level: MeterLevel = length > rules.maxCaption ? 'over' : length > rules.recommendedMax ? 'long' : length < rules.recommendedMin ? 'short' : 'good';
  const note: Record<MeterLevel, string> = {
    over: `Too long for ${networkLabel}: at most ${rules.maxCaption} characters.`,
    long: `A little long for ${networkLabel}: readers often stop early, so the hook should come first.`,
    short: `Shorter than the usual range for ${networkLabel}, which is fine if the message is clear.`,
    good: `A good length for ${networkLabel}.`,
  };
  let seen = words;
  if (length > rules.visibleChars) {
    const cut = words.slice(0, rules.visibleChars);
    seen = (/\s/.test(words.charAt(rules.visibleChars)) ? cut : cut.replace(/\s+\S*$/, '')).trim();
  }
  return { length, level, text: `${length} characters (aim for ${aim}). ${note[level]}`, seen, folded: length > rules.visibleChars };
}

/** A carousel as one card of the queue: its slides in order, its captions, the cover and where it stands. */
export interface CarouselGroup {
  key: string;
  brand: string;
  id: string;
  count: number;
  slides: ReviewSummary[];
  captions: ReviewSummary[];
  cover: ReviewSummary | undefined;
  /** Slides the list does not show (another tab holds them, or they are not made yet). */
  missing: number;
  /** The least settled status among the parts shown: it is approved only when every part is. */
  status: ReviewStatus;
}

const SETTLED_ORDER: readonly ReviewStatus[] = ['blocked', 'rejected', 'held', 'pending', 'superseded', 'approved'];

/** Splits the queue into single posters and carousels, keeping the order posters came in. */
export function groupCarousels(posts: readonly ReviewSummary[]): { singles: ReviewSummary[]; carousels: CarouselGroup[] } {
  const singles: ReviewSummary[] = [];
  const groups = new Map<string, CarouselGroup>();
  for (const post of posts) {
    const member = post.carousel;
    if (!member) { singles.push(post); continue; }
    const key = `${post.brand}|${member.id}`;
    const group = groups.get(key) ?? { key, brand: post.brand, id: member.id, count: member.count, slides: [], captions: [], cover: undefined, missing: 0, status: 'approved' as ReviewStatus };
    (member.position === 0 ? group.captions : group.slides).push(post);
    groups.set(key, group);
  }
  const carousels = [...groups.values()].map((group): CarouselGroup => {
    const slides = [...group.slides].sort((a, b) => (a.carousel?.position ?? 0) - (b.carousel?.position ?? 0));
    const parts = [...slides, ...group.captions];
    const status = parts.reduce<ReviewStatus>((worst, p) => (SETTLED_ORDER.indexOf(p.status) < SETTLED_ORDER.indexOf(worst) ? p.status : worst), 'approved');
    return { ...group, slides, cover: slides[0], missing: Math.max(0, group.count - slides.length), status };
  });
  return { singles, carousels };
}

/** A carousel as the service shows it when opened: every slide in order (a slide with no picture yet is "Missing"), the captions, and where it stands. */
export interface CarouselView {
  id: string;
  count: number;
  status: 'incomplete' | 'blocked' | 'rejected' | 'approved' | 'pending';
  slides: Array<{ position: number; versionId: string | null; status: string; headline: string }>;
  captions: Array<{ network: string; versionId: string; caption: string; status: string }>;
  reasons: string[];
}

const CAROUSEL_STATES: readonly string[] = ['incomplete', 'blocked', 'rejected', 'approved', 'pending'];

export function parseCarousel(value: unknown): CarouselView | null {
  const raw = value as { id?: unknown; count?: unknown; status?: unknown; slides?: unknown; captions?: unknown; reasons?: unknown } | null;
  if (!raw || typeof raw.id !== 'string' || !Number.isInteger(raw.count) || typeof raw.status !== 'string' || !CAROUSEL_STATES.includes(raw.status) || !Array.isArray(raw.slides) || !Array.isArray(raw.captions)) return null;
  const slides = raw.slides.flatMap((entry): CarouselView['slides'] => {
    const e = entry as { position?: unknown; versionId?: unknown; status?: unknown; headline?: unknown } | null;
    if (!e || !Number.isInteger(e.position) || typeof e.status !== 'string') return [];
    return [{ position: e.position as number, versionId: typeof e.versionId === 'string' ? e.versionId : null, status: e.status, headline: typeof e.headline === 'string' ? e.headline : 'Missing' }];
  });
  const captions = raw.captions.flatMap((entry): CarouselView['captions'] => {
    const e = entry as { network?: unknown; versionId?: unknown; caption?: unknown; status?: unknown } | null;
    return e && typeof e.network === 'string' && typeof e.versionId === 'string' && typeof e.caption === 'string' ? [{ network: e.network, versionId: e.versionId, caption: e.caption, status: typeof e.status === 'string' ? e.status : 'pending' }] : [];
  });
  const reasons = Array.isArray(raw.reasons) ? raw.reasons.filter((r): r is string => typeof r === 'string' && r in REASON_LABELS) : Object.keys(REASON_LABELS);
  return { id: raw.id, count: raw.count as number, status: raw.status as CarouselView['status'], slides, captions, reasons: reasons.length > 0 ? reasons : Object.keys(REASON_LABELS) };
}

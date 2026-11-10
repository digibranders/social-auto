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
  kind: 'copy' | 'draw';
  brand: string;
  site: string;
  state: JobState;
  step?: number;
  planFile?: string;
  error?: string;
}

/** The jobs the service sends, kept only where well formed. */
export function parseJobs(value: unknown): JobView[] {
  const list = (value as { jobs?: unknown } | null)?.jobs;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry): JobView[] => {
    const j = entry as Record<string, unknown> | null;
    if (!j || typeof j['id'] !== 'string' || (j['kind'] !== 'copy' && j['kind'] !== 'draw') || typeof j['brand'] !== 'string' || typeof j['site'] !== 'string' || !['queued', 'running', 'succeeded', 'failed'].includes(String(j['state']))) return [];
    const error = (j['error'] as { message?: unknown } | undefined)?.message;
    const planFile = typeof j['planFileMade'] === 'string' ? j['planFileMade'] : typeof j['planFile'] === 'string' ? j['planFile'] : undefined;
    return [{ id: j['id'], kind: j['kind'], brand: j['brand'], site: j['site'], state: j['state'] as JobState, ...(typeof j['step'] === 'number' ? { step: j['step'] } : {}), ...(planFile ? { planFile } : {}), ...(typeof error === 'string' ? { error } : {}) }];
  });
}

export const jobActive = (job: JobView): boolean => job.state === 'queued' || job.state === 'running';

const STEP_WORDS: Readonly<Record<number, string>> = { 1: 'reading the website', 2: 'writing the posts', 3: 'drawing the pictures', 4: 'putting them in the review list' };

/** What a job is doing, in plain words. */
export function jobText(job: JobView): string {
  const what = job.kind === 'copy' ? `Writing posts for ${job.site}` : `Drawing the kept posts of ${job.brand}${job.planFile ? ` (${job.planFile.replace(/\.json$/, '')})` : ''}`;
  if (job.state === 'queued') return `${what}: waiting for its turn`;
  if (job.state === 'running') return `${what}: ${job.step ? STEP_WORDS[job.step] ?? 'working' : 'starting'}`;
  if (job.state === 'succeeded') return job.kind === 'copy' ? `${what}: done, the posts are waiting for you below` : `${what}: done, the pictures are waiting for you to approve`;
  return `${what}: stopped. ${job.error ?? 'It did not finish.'} Nothing was published.`;
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

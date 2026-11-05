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
export const imageUrl = (versionId: string, view: 'image' | 'download' = 'image'): string => `/api/review?view=${view}&id=${encodeURIComponent(versionId)}`;

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

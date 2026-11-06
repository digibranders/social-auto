/** What the review page shows, kept apart from the drawing so it can be tested: the labels, the filters and the wording of each state. */
export type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'blocked' | 'superseded';
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
};

export interface ReviewSummary {
  versionId: string;
  brand: string;
  postId: string;
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

const STATUSES: readonly string[] = ['pending', 'approved', 'rejected', 'blocked', 'superseded'];

/** The list the service sends, kept only where it is well formed: a malformed entry is dropped, never drawn. */
export function parseQueue(value: unknown): { posts: ReviewSummary[]; reasons: string[] } {
  const raw = value as { posts?: unknown; reasons?: unknown } | null;
  const posts = Array.isArray(raw?.posts) ? raw.posts.flatMap((p): ReviewSummary[] => {
    const e = p as Partial<ReviewSummary> | null;
    if (!e || typeof e.versionId !== 'string' || typeof e.brand !== 'string' || typeof e.postId !== 'string' || typeof e.headline !== 'string' || typeof e.caption !== 'string' || typeof e.status !== 'string' || !STATUSES.includes(e.status)) return [];
    return [{
      versionId: e.versionId, brand: e.brand, postId: e.postId, versionNumber: Number(e.versionNumber) || 1, status: e.status as ReviewStatus, headline: e.headline, caption: e.caption,
      createdAt: typeof e.createdAt === 'string' ? e.createdAt : '', costUsd: Number(e.costUsd) || 0,
      ...(typeof e.decidedBy === 'string' ? { decidedBy: e.decidedBy } : {}), ...(typeof e.decidedAt === 'string' ? { decidedAt: e.decidedAt } : {}), ...(typeof e.reason === 'string' ? { reason: e.reason } : {}),
    }];
  }) : [];
  const reasons = Array.isArray(raw?.reasons) ? raw.reasons.filter((r): r is string => typeof r === 'string' && r in REASON_LABELS) : Object.keys(REASON_LABELS);
  return { posts, reasons: reasons.length > 0 ? reasons : Object.keys(REASON_LABELS) };
}

/** Where to ask for a version's picture, as a preview or as a download. */
export const imageUrl = (versionId: string, view: 'image' | 'download' | 'logo' = 'image'): string => `/api/review?view=${view}&id=${encodeURIComponent(versionId)}`;

/** How the page words a failed request: the service's own words when it gave any. */
export function failureText(body: unknown, status: number): string {
  const message = (body as { error?: unknown } | null)?.error;
  return typeof message === 'string' && message ? message : `That did not work (${status}).`;
}

/** The poster's cost as shown to the owner. */
export const costText = (usd: number): string => (usd > 0 ? `$${usd.toFixed(3)}` : 'free');

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
  return {
    intendedMode, appliedMode, status, hasLogoFile: typeof r['logoFile'] === 'string' && r['logoFile'] !== '',
    ...(logoKind ? { logoKind } : {}), ...(sourcePage ? { sourcePage } : {}), ...(sourceUrl ? { sourceUrl } : {}), ...(provenance ? { provenance } : {}), ...(reason ? { reason } : {}),
    ...(typeof r['logoWidth'] === 'number' ? { logoWidth: r['logoWidth'] } : {}), ...(typeof r['logoHeight'] === 'number' ? { logoHeight: r['logoHeight'] } : {}),
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
  if (b.status === 'applied') return { tone: 'done', headline: 'Real logo applied', explanation: 'The website\'s own logo, unchanged, is on this poster.', rows };
  if (b.intendedMode === 'authentic_logo') return { tone: 'note', headline: 'Real logo found, not applied', explanation: b.reason ?? 'The website\'s logo was found and verified, but this poster uses the brand name and web address as text.', rows };
  return { tone: 'plain', headline: 'Text sign-off used: no usable logo', explanation: b.reason ? `No real logo was used. ${b.reason}` : 'No real logo was used on this poster.', rows };
}


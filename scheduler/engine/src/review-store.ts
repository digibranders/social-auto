/**
 * The owner's review queue: immutable versions of each poster, and the decisions made about them. An approval belongs to one exact version (its
 * headline, caption, link, evidence and the bytes of its picture), never to a post's name, so changing anything afterwards makes a new version that
 * must be approved again. Nothing can be published or downloaded as approved unless the version exists, was decided "approved", is the latest of
 * its post, passed the system's checks, and still has the picture and content it was approved with.
 *
 * The store is an append-only JSON-lines file per brand, written under a lock so two requests cannot make conflicting decisions, and each picture is
 * copied once into a folder named by its own hash so a later run can never overwrite what was approved. Nothing here is ever deleted or edited.
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extname, join, resolve, sep } from 'node:path';
import { withLock } from './paid-ledger.ts';

export type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'blocked' | 'superseded';
export const REJECTION_REASONS = ['weak_copy', 'irrelevant_image', 'poor_design', 'incorrect_branding', 'factual_issue', 'repetitive', 'style', 'other'] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

export interface EvidenceSnapshot {
  factId: string;
  text: string;
  quote: string;
  url: string;
  context: string;
}

import type { BrandingDecision } from './branding.ts';

export interface PostVersion {
  versionId: string;
  brand: string;
  postId: string;
  planFile: string;
  versionNumber: number;
  headline: string;
  caption: string;
  ctaUrl: string;
  factIds: string[];
  /** The facts as they were when the post was made, so the page shows what was verified even if the site changes later. */
  evidence: EvidenceSnapshot[];
  /** The picture, relative to the brand's folder. */
  imageFile: string;
  imageSha256: string;
  contentSha256: string;
  /** What the system's own checks found. A version that did not pass is blocked and can never be approved. */
  validation: { accepted: boolean; readings: number; defects: string[]; reportFile: string };
  attempts: number;
  costUsd: number;
  /** How the poster was branded: what was intended, what the poster really carries, the logo that was found and why it was or was not used. Frozen before the picture was bought; not part of the hashes. Older versions have none. */
  branding?: BrandingDecision;
  parentVersionId?: string;
  createdAt: string;
  createdBy: string;
}

export interface Decision {
  versionId: string;
  decision: 'approve' | 'reject';
  by: string;
  at: string;
  reason?: RejectionReason;
  comment?: string;
  /** The hashes the decision was made against. */
  imageSha256: string;
  contentSha256: string;
}

type Event = { type: 'version'; version: PostVersion } | { type: 'decision'; decision: Decision };

export class ReviewError extends Error {
  readonly code: 'NOT_FOUND' | 'BLOCKED' | 'STALE' | 'ALREADY_DECIDED' | 'TAMPERED' | 'NOT_APPROVED' | 'INVALID';
  constructor(code: ReviewError['code'], message: string) {
    super(message);
    this.name = 'ReviewError';
    this.code = code;
  }
}

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

/** The hash of what a person reads and approves: the headline, the caption, the link and the facts it rests on. */
export const contentHashOf = (v: Pick<PostVersion, 'headline' | 'caption' | 'ctaUrl' | 'factIds'>): string => sha256(JSON.stringify({ headline: v.headline, caption: v.caption, ctaUrl: v.ctaUrl, factIds: v.factIds }));

export interface NewVersion {
  postId: string;
  planFile: string;
  headline: string;
  caption: string;
  ctaUrl: string;
  factIds: string[];
  evidence: EvidenceSnapshot[];
  /** The picture file as the engine made it (any folder). */
  imagePath: string;
  validation: PostVersion['validation'];
  attempts: number;
  costUsd: number;
  branding?: BrandingDecision;
  parentVersionId?: string;
  createdBy?: string;
}

export interface ReviewItem {
  version: PostVersion;
  status: ReviewStatus;
  decision?: Decision;
}

export class ReviewStore {
  readonly brandDir: string;
  readonly brand: string;
  private readonly file: string;
  private readonly lockPath: string;
  private readonly now: () => Date;

  constructor(brandDir: string, brand: string, now: () => Date = () => new Date()) {
    this.brandDir = brandDir;
    this.brand = brand;
    this.file = join(brandDir, 'reviews.jsonl');
    this.lockPath = `${this.file}.lock`;
    this.now = now;
    mkdirSync(join(brandDir, 'versions'), { recursive: true });
  }

  private events(): Event[] {
    let text = '';
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return text.split('\n').filter((l) => l.trim() !== '').map((line) => {
      try {
        return JSON.parse(line) as Event;
      } catch {
        throw new ReviewError('TAMPERED', `${this.file} has a damaged record; nothing can be approved until it is checked`);
      }
    });
  }

  private fold(): ReviewItem[] {
    const versions = new Map<string, PostVersion>();
    const decisions = new Map<string, Decision>();
    for (const event of this.events()) {
      if (event.type === 'version') versions.set(event.version.versionId, event.version);
      else decisions.set(event.decision.versionId, event.decision);
    }
    const latest = new Map<string, number>();
    for (const v of versions.values()) latest.set(v.postId, Math.max(latest.get(v.postId) ?? 0, v.versionNumber));
    return [...versions.values()].map((version): ReviewItem => {
      const decision = decisions.get(version.versionId);
      const status: ReviewStatus = !version.validation.accepted ? 'blocked'
        : decision?.decision === 'approve' ? 'approved'
        : decision?.decision === 'reject' ? 'rejected'
        : version.versionNumber < (latest.get(version.postId) ?? 0) ? 'superseded'
        : 'pending';
      // A later version supersedes an approval too: the earlier one stays on record as approved history but is no longer what goes out.
      const final: ReviewStatus = status === 'approved' && version.versionNumber < (latest.get(version.postId) ?? 0) ? 'superseded' : status;
      return { version, status: final, ...(decision ? { decision } : {}) };
    });
  }

  /** Every version, oldest first, with its status. */
  list(filter?: { status?: ReviewStatus }): ReviewItem[] {
    const all = this.fold();
    return filter?.status ? all.filter((i) => i.status === filter.status) : all;
  }

  get(versionId: string): ReviewItem {
    const found = this.fold().find((i) => i.version.versionId === versionId);
    if (!found) throw new ReviewError('NOT_FOUND', `there is no version ${versionId}`);
    return found;
  }

  /** The versions of one post, newest first. */
  history(postId: string): ReviewItem[] {
    return this.fold().filter((i) => i.version.postId === postId).sort((a, b) => b.version.versionNumber - a.version.versionNumber);
  }

  /**
   * Records a new version of a post. The picture is copied into the brand's `versions` folder under its own hash. The same content and picture
   * for the same post is the same version (so registering twice makes nothing new).
   */
  addVersion(input: NewVersion): PostVersion {
    const bytes = readFileSync(input.imagePath);
    const imageSha256 = sha256(bytes);
    const imageFile = join('versions', `${imageSha256}.jpg`);
    const contentSha256 = contentHashOf(input);
    return withLock(this.lockPath, () => {
      const items = this.fold().filter((i) => i.version.postId === input.postId);
      const same = items.find((i) => i.version.imageSha256 === imageSha256 && i.version.contentSha256 === contentSha256);
      if (same) return same.version;
      const target = join(this.brandDir, imageFile);
      if (!existsSync(target)) copyFileSync(input.imagePath, target);
      const versionNumber = items.reduce((max, i) => Math.max(max, i.version.versionNumber), 0) + 1;
      const version: PostVersion = {
        versionId: `${this.brand}.${sha256(`${input.postId}|${versionNumber}|${imageSha256}|${contentSha256}`).slice(0, 16)}`,
        brand: this.brand, postId: input.postId, planFile: input.planFile, versionNumber,
        headline: input.headline, caption: input.caption, ctaUrl: input.ctaUrl, factIds: input.factIds, evidence: input.evidence,
        imageFile, imageSha256, contentSha256, validation: input.validation, attempts: input.attempts, costUsd: input.costUsd,
        ...(input.branding ? { branding: input.branding } : {}),
        ...(input.parentVersionId ? { parentVersionId: input.parentVersionId } : {}),
        createdAt: this.now().toISOString(), createdBy: input.createdBy ?? 'engine',
      };
      appendFileSync(this.file, `${JSON.stringify({ type: 'version', version } satisfies Event)}\n`);
      return version;
    });
  }

  /** Checks that the picture and the content are still what they were when the version was made. */
  private verify(version: PostVersion): void {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(this.brandDir, version.imageFile));
    } catch {
      throw new ReviewError('TAMPERED', `the picture of ${version.versionId} is missing`);
    }
    if (sha256(bytes) !== version.imageSha256) throw new ReviewError('TAMPERED', `the picture of ${version.versionId} is not the one that was made`);
    if (contentHashOf(version) !== version.contentSha256) throw new ReviewError('TAMPERED', `the content of ${version.versionId} does not match its record`);
  }

  /** Approves one exact version. The same request twice gives the same decision, never a second one. */
  approve(versionId: string, by: string): Decision {
    if (by.trim() === '') throw new ReviewError('INVALID', 'an approval needs the name of the person who approved it');
    return withLock(this.lockPath, () => {
      const item = this.get(versionId);
      if (item.status === 'approved' && item.decision) return item.decision;
      if (item.status === 'blocked') throw new ReviewError('BLOCKED', 'the system\'s checks did not pass for this version, so it cannot be approved');
      if (item.status === 'superseded') throw new ReviewError('STALE', 'a newer version of this post exists; approve that one');
      if (item.status === 'rejected') throw new ReviewError('ALREADY_DECIDED', 'this version was rejected; a new version has to be made');
      this.verify(item.version);
      const decision: Decision = { versionId, decision: 'approve', by, at: this.now().toISOString(), imageSha256: item.version.imageSha256, contentSha256: item.version.contentSha256 };
      appendFileSync(this.file, `${JSON.stringify({ type: 'decision', decision } satisfies Event)}\n`);
      return decision;
    });
  }

  /** Rejects a version (or withdraws an approval that has not gone out). The reason is kept for the history. */
  reject(versionId: string, by: string, reason: RejectionReason, comment?: string): Decision {
    if (by.trim() === '') throw new ReviewError('INVALID', 'a rejection needs the name of the person who made it');
    if (!(REJECTION_REASONS as readonly string[]).includes(reason)) throw new ReviewError('INVALID', `the reason must be one of ${REJECTION_REASONS.join(', ')}`);
    return withLock(this.lockPath, () => {
      const item = this.get(versionId);
      if (item.status === 'rejected' && item.decision) return item.decision;
      if (item.status === 'blocked') throw new ReviewError('BLOCKED', 'this version never passed the system\'s checks and is already excluded');
      const decision: Decision = { versionId, decision: 'reject', by, at: this.now().toISOString(), reason, ...(comment ? { comment: comment.slice(0, 500) } : {}), imageSha256: item.version.imageSha256, contentSha256: item.version.contentSha256 };
      appendFileSync(this.file, `${JSON.stringify({ type: 'decision', decision } satisfies Event)}\n`);
      return decision;
    });
  }

  /**
   * The only way to get a file for publishing or download: the version must be approved, the latest of its post, and its picture and content must
   * still match what was approved. Returns the picture's path and the version.
   */
  approvedFile(versionId: string): { version: PostVersion; path: string } {
    const item = this.get(versionId);
    if (item.status !== 'approved' || !item.decision) throw new ReviewError('NOT_APPROVED', `version ${versionId} is ${item.status}, not approved`);
    this.verify(item.version);
    if (item.decision.imageSha256 !== item.version.imageSha256 || item.decision.contentSha256 !== item.version.contentSha256) throw new ReviewError('TAMPERED', 'the approval was made against a different picture or content');
    return { version: item.version, path: join(this.brandDir, item.version.imageFile) };
  }

  /** The approved version of a post that may go out now, if there is one. */
  approvedFor(postId: string): { version: PostVersion; path: string } | undefined {
    const item = this.history(postId).find((i) => i.status === 'approved');
    return item ? this.approvedFile(item.version.versionId) : undefined;
  }

  /** The picture of any version for a signed-in reviewer to look at (a preview, never a download of something unapproved). */
  /**
   * The frozen copy of the logo a version was branded with, for the owner to see next to the poster. Only a file inside the brand's own folder, and only
   * while it still has the hash recorded for it; anything else is not served.
   */
  logoPath(versionId: string): { path: string; ext: string } {
    const { branding } = this.get(versionId).version;
    if (!branding?.logoFile || !branding.logoAssetSha256) throw new ReviewError('NOT_FOUND', 'no logo was kept for this poster');
    const root = resolve(this.brandDir);
    const path = resolve(root, branding.logoFile);
    if (!path.startsWith(root + sep) || !existsSync(path)) throw new ReviewError('NOT_FOUND', 'no logo was kept for this poster');
    if (sha256(readFileSync(path)) !== branding.logoAssetSha256) throw new ReviewError('TAMPERED', `the kept logo of ${versionId} is not the one that was recorded`);
    return { path, ext: extname(path).toLowerCase() };
  }

  previewPath(versionId: string): string {
    const item = this.get(versionId);
    this.verify(item.version);
    return join(this.brandDir, item.version.imageFile);
  }
}

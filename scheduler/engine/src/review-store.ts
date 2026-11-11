/**
 * The owner's review queue: immutable versions of each poster, and the decisions made about them. An approval belongs to one exact version (its
 * headline, caption, link, evidence and the bytes of its picture), never to a post's name, so changing anything afterwards makes a new version that
 * must be approved again. Nothing can be published or downloaded as approved unless the version exists, was decided "approved", is the latest of
 * its post, passed the system's checks, and still has the picture and content it was approved with.
 *
 * The store is an append-only JSON-lines file per brand, written under a lock so two requests cannot make conflicting decisions, and each picture is
 * copied once into a folder named by its own hash so a later run can never overwrite what was approved. Nothing here is ever deleted or edited.
 */
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extname, join, resolve, sep } from 'node:path';
import { appendDurable, copyDurable, LockError, withFileLock } from './file-lock.ts';

/** "held": approved before a log recovery that could not tell whether the approval was withdrawn in the damaged tail; it goes nowhere until the owner confirms it again. */
export type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'blocked' | 'superseded' | 'held';
export const REJECTION_REASONS = ['weak_copy', 'irrelevant_image', 'poor_design', 'incorrect_branding', 'factual_issue', 'repetitive', 'style', 'other'] as const;
/** Recorded by the system, never chosen by a person: nobody decided in time. */
export const EXPIRED_REASON = 'expired' as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number] | typeof EXPIRED_REASON;

export interface EvidenceSnapshot {
  factId: string;
  text: string;
  quote: string;
  url: string;
  context: string;
}

import type { BrandingDecision } from './branding.ts';

/** The group a version belongs to when it is part of a carousel: its id, the slide it is (1 to count), or 0 for the carousel's captions (which show the cover picture). */
export interface CarouselMembership {
  id: string;
  position: number;
  count: number;
}

export interface PostVersion {
  versionId: string;
  brand: string;
  postId: string;
  planFile: string;
  versionNumber: number;
  /** The network this version was made for (instagram, facebook, linkedin, google). Versions made before networks existed have none. */
  network?: string;
  /** Set when the version is a slide of a carousel, or one of its captions. */
  carousel?: CarouselMembership;
  /** The picture's size in pixels, for the screen that shows it. */
  width?: number;
  height?: number;
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

/** What an administrator did to repair the log, written into the log itself. */
export interface RecoveryRecord {
  at: string;
  actor: string;
  reason: string;
  /** What was found: a record cut short at the end of the log, or only a missing line ending. */
  kind: 'torn_tail' | 'missing_newline';
  originalSha256: string;
  repairedSha256: string;
  quarantinedBytes: number;
  quarantinedSha256: string;
  /** Approvals that were in force before the repair and are now held until confirmed again. */
  heldVersionIds: string[];
  evidenceDir: string;
}

export type Event = { type: 'version'; version: PostVersion } | { type: 'decision'; decision: Decision } | { type: 'recovery'; recovery: RecoveryRecord };

export class ReviewError extends Error {
  readonly code: 'NOT_FOUND' | 'BLOCKED' | 'STALE' | 'ALREADY_DECIDED' | 'TAMPERED' | 'NOT_APPROVED' | 'INVALID' | 'LOCKED' | 'FORBIDDEN' | 'CONFLICT' | 'LIMIT';
  constructor(code: ReviewError['code'], message: string) {
    super(message);
    this.name = 'ReviewError';
    this.code = code;
  }
}

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

/** The hash of what a person reads and approves: the headline, the caption, the link and the facts it rests on. */
export const contentHashOf = (v: Pick<PostVersion, 'headline' | 'caption' | 'ctaUrl' | 'factIds' | 'network'>): string =>
  // The network is part of what is approved, so the same words on two networks are two versions; a version with no network hashes as it always did.
  sha256(JSON.stringify({ headline: v.headline, caption: v.caption, ctaUrl: v.ctaUrl, factIds: v.factIds, ...(v.network ? { network: v.network } : {}) }));

export const NETWORK = /^[a-z]{2,20}$/;
/** The key a post's versions are replaced by: a new version of a post replaces the older ones of the same network only. */
const lineOf = (v: Pick<PostVersion, 'postId' | 'network'>): string => `${v.postId}|${v.network ?? ''}`;

export interface NewVersion {
  postId: string;
  planFile: string;
  network?: string;
  carousel?: CarouselMembership;
  width?: number;
  height?: number;
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
  /** True while this store holds its own lock, so a read inside a change does not ask for the lock again. */
  private holding = false;

  private readonly lockTimeoutMs: number | undefined;

  constructor(brandDir: string, brand: string, now: () => Date = () => new Date(), lockTimeoutMs?: number) {
    this.lockTimeoutMs = lockTimeoutMs;
    this.brandDir = brandDir;
    this.brand = brand;
    this.file = join(brandDir, 'reviews.jsonl');
    this.lockPath = `${this.file}.lock`;
    this.now = now;
    mkdirSync(join(brandDir, 'versions'), { recursive: true });
  }

  /** Runs a change to the log under the lock. A lock that cannot be had stops the change: nothing is decided without it. */
  private locked<T>(work: (owns: () => boolean) => T): T {
    try {
      return withFileLock(this.lockPath, (owns) => {
        this.holding = true;
        try {
          return work(owns);
        } finally {
          this.holding = false;
        }
      }, this.lockTimeoutMs === undefined ? {} : { timeoutMs: this.lockTimeoutMs });
    } catch (error) {
      if (error instanceof LockError) throw new ReviewError('LOCKED', 'the review store is busy or its lock needs a person to look at it, so nothing was changed');
      throw error;
    }
  }

  /** Just before a change is written: the lock must still be this process's, or nothing is written. */
  private mustOwn(owns: () => boolean): void {
    if (!owns()) throw new ReviewError('LOCKED', 'this process no longer holds the review store\'s lock, so nothing was written');
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

  /** The log as it stands. A read that meets a damaged record looks again under the lock, because a writer in the middle of an append can look damaged to a reader; damage that is still there with no writer is real and stops everything. */
  private fold(): ReviewItem[] {
    if (this.holding) return this.foldUnlocked();
    try {
      return this.foldUnlocked();
    } catch (error) {
      if (!(error instanceof ReviewError) || error.code !== 'TAMPERED') throw error;
      return this.locked(() => this.foldUnlocked());
    }
  }

  private foldUnlocked(): ReviewItem[] {
    const versions = new Map<string, PostVersion>();
    const decisions = new Map<string, Decision>();
    const held = new Set<string>();
    for (const event of this.events()) {
      if (event.type === 'version') versions.set(event.version.versionId, event.version);
      else if (event.type === 'recovery') {
        // After a repair that could not tell whether the lost tail withdrew an approval, every approval then in force waits for a new, explicit confirmation.
        if (event.recovery.heldVersionIds.length > 0) for (const [id, decision] of decisions) if (decision.decision === 'approve') held.add(id);
      } else {
        decisions.set(event.decision.versionId, event.decision);
        held.delete(event.decision.versionId);
      }
    }
    const latest = new Map<string, number>();
    for (const v of versions.values()) latest.set(lineOf(v), Math.max(latest.get(lineOf(v)) ?? 0, v.versionNumber));
    return [...versions.values()].map((version): ReviewItem => {
      const decision = decisions.get(version.versionId);
      // A version that did not pass the checks is blocked and can never be approved; the person it belongs to may put it away, which shows as rejected.
      const status: ReviewStatus = !version.validation.accepted ? (decision?.decision === 'reject' ? 'rejected' : 'blocked')
        : decision?.decision === 'approve' ? (held.has(version.versionId) ? 'held' : 'approved')
        : decision?.decision === 'reject' ? 'rejected'
        : version.versionNumber < (latest.get(lineOf(version)) ?? 0) ? 'superseded'
        : 'pending';
      // A later version supersedes an approval too: the earlier one stays on record as approved history but is no longer what goes out.
      const final: ReviewStatus = (status === 'approved' || status === 'held') && version.versionNumber < (latest.get(lineOf(version)) ?? 0) ? 'superseded' : status;
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

  /** The versions of one post, newest first. With a network ("" for a version made without one) only that network's versions; without, every network's. */
  history(postId: string, network?: string): ReviewItem[] {
    return this.fold().filter((i) => i.version.postId === postId && (network === undefined || (i.version.network ?? '') === network)).sort((a, b) => b.version.versionNumber - a.version.versionNumber);
  }

  /**
   * Records a new version of a post. The picture is copied into the brand's `versions` folder under its own hash. The same content and picture
   * for the same post is the same version (so registering twice makes nothing new).
   */
  addVersion(input: NewVersion): PostVersion {
    const bytes = readFileSync(input.imagePath);
    const imageSha256 = sha256(bytes);
    const imageFile = join('versions', `${imageSha256}.jpg`);
    if (input.network !== undefined && !NETWORK.test(input.network)) throw new ReviewError('INVALID', 'the network must be a short lower-case name');
    const contentSha256 = contentHashOf(input);
    const group = input.carousel;
    if (group && (group.id === '' || !Number.isInteger(group.position) || !Number.isInteger(group.count) || group.count < 2 || group.count > 10 || group.position < 0 || group.position > group.count)) {
      throw new ReviewError('INVALID', 'a carousel version needs a group id, a count of two to ten and a position from 0 to the count');
    }
    return this.locked((owns) => {
      const items = this.fold().filter((i) => lineOf(i.version) === lineOf(input));
      const same = items.find((i) => i.version.imageSha256 === imageSha256 && i.version.contentSha256 === contentSha256);
      if (same) return same.version;
      const target = join(this.brandDir, imageFile);
      if (!existsSync(target)) copyDurable(input.imagePath, target);
      const versionNumber = items.reduce((max, i) => Math.max(max, i.version.versionNumber), 0) + 1;
      const version: PostVersion = {
        versionId: `${this.brand}.${sha256(`${input.postId}|${versionNumber}|${imageSha256}|${contentSha256}${input.network ? `|${input.network}` : ''}`).slice(0, 16)}`,
        brand: this.brand, postId: input.postId, planFile: input.planFile, versionNumber,
        ...(input.network ? { network: input.network } : {}),
        ...(group ? { carousel: { id: group.id, position: group.position, count: group.count } } : {}),
        ...(input.width && input.height ? { width: input.width, height: input.height } : {}),
        headline: input.headline, caption: input.caption, ctaUrl: input.ctaUrl, factIds: input.factIds, evidence: input.evidence,
        imageFile, imageSha256, contentSha256, validation: input.validation, attempts: input.attempts, costUsd: input.costUsd,
        ...(input.branding ? { branding: input.branding } : {}),
        ...(input.parentVersionId ? { parentVersionId: input.parentVersionId } : {}),
        createdAt: this.now().toISOString(), createdBy: input.createdBy ?? 'engine',
      };
      this.mustOwn(owns);
      appendDurable(this.file, JSON.stringify({ type: 'version', version } satisfies Event));
      return version;
    });
  }

  /**
   * A new version of an already drawn picture with other words: the same picture bytes (nothing is drawn or bought), the new caption, for that version's own
   * network. It replaces the older version of that network (an approval of the older one stops being in force) and is pending, so it needs approving again.
   * The caller has checked the words. A version the system blocked cannot be given new words; asking for the words it already has changes nothing.
   */
  addCaptionVersion(versionId: string, caption: string, by: string): PostVersion {
    if (by.trim() === '') throw new ReviewError('INVALID', 'who is changing the words must be given');
    const item = this.get(versionId);
    const v = item.version;
    if (item.status === 'blocked') throw new ReviewError('BLOCKED', 'this picture did not pass the system\'s checks, so its words cannot be changed');
    if (item.status === 'superseded') throw new ReviewError('STALE', 'a newer version of this post exists; change the words of that one');
    if (caption.trim() === v.caption.trim()) throw new ReviewError('CONFLICT', 'these are already the words of this picture');
    return this.addVersion({
      postId: v.postId, planFile: v.planFile, ...(v.network ? { network: v.network } : {}), ...(v.width && v.height ? { width: v.width, height: v.height } : {}),
      headline: v.headline, caption, ctaUrl: v.ctaUrl, factIds: v.factIds, evidence: v.evidence, imagePath: join(this.brandDir, v.imageFile),
      validation: v.validation, attempts: v.attempts, costUsd: 0, ...(v.branding ? { branding: v.branding } : {}), parentVersionId: v.versionId, createdBy: by.trim().slice(0, 80),
    });
  }

  /** Checks that the picture and the content are still what they were when the version was made. */
  private verify(version: PostVersion): void {
    this.readVerified(version);
  }

  /**
   * The picture's bytes, read in a way that cannot be steered out of the brand's folder, and checked against the hash they were approved with. The brand
   * folder and its `versions` folder must be real folders (not links), the picture's name must be exactly `versions/<hash>.jpg`, and the file is opened
   * without following a link and must be a plain file: a link to a file with the same bytes elsewhere is refused, because the hash alone would not notice it.
   * The bytes that were hashed are the bytes returned, so there is no gap between the check and the use.
   */
  private readVerified(version: PostVersion): Buffer {
    const refuse = (what: string): never => {
      throw new ReviewError('TAMPERED', `the picture of ${version.versionId} ${what}`);
    };
    if (!/^versions\/[0-9a-f]{64}\.jpg$/.test(version.imageFile)) return refuse('is named outside the allowed folder');
    for (const folder of [this.brandDir, join(this.brandDir, 'versions')]) {
      let info;
      try {
        info = lstatSync(folder);
      } catch {
        return refuse('is missing');
      }
      if (info.isSymbolicLink() || !info.isDirectory()) return refuse('is in a folder that is not a plain folder');
    }
    let fd: number;
    try {
      fd = openSync(join(this.brandDir, version.imageFile), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      return refuse('is missing or is a link');
    }
    let bytes: Buffer;
    try {
      const info = fstatSync(fd);
      if (!info.isFile()) return refuse('is not a plain file');
      bytes = Buffer.alloc(info.size);
      let read = 0;
      while (read < info.size) {
        const n = readSync(fd, bytes, read, info.size - read, read);
        if (n === 0) break;
        read += n;
      }
      if (read !== info.size) return refuse('changed while it was being read');
    } finally {
      closeSync(fd);
    }
    if (sha256(bytes) !== version.imageSha256) return refuse('is not the one that was made');
    if (contentHashOf(version) !== version.contentSha256) throw new ReviewError('TAMPERED', `the content of ${version.versionId} does not match its record`);
    return bytes;
  }

  /** Approves one exact version. The same request twice gives the same decision, never a second one. */
  approve(versionId: string, by: string): Decision {
    if (by.trim() === '') throw new ReviewError('INVALID', 'an approval needs the name of the person who approved it');
    return this.locked((owns) => {
      const item = this.get(versionId);
      if (item.status === 'approved' && item.decision) return item.decision;
      if (item.status === 'blocked') throw new ReviewError('BLOCKED', 'the system\'s checks did not pass for this version, so it cannot be approved');
      if (item.status === 'superseded') throw new ReviewError('STALE', 'a newer version of this post exists; approve that one');
      if (item.status === 'rejected') throw new ReviewError('ALREADY_DECIDED', 'this version was rejected; a new version has to be made');
      this.verify(item.version);
      const decision: Decision = { versionId, decision: 'approve', by, at: this.now().toISOString(), imageSha256: item.version.imageSha256, contentSha256: item.version.contentSha256 };
      this.mustOwn(owns);
      appendDurable(this.file, JSON.stringify({ type: 'decision', decision } satisfies Event));
      return decision;
    });
  }

  /** Rejects a version (or withdraws an approval that has not gone out). The reason is kept for the history. */
  reject(versionId: string, by: string, reason: RejectionReason, comment?: string): Decision {
    if (by.trim() === '') throw new ReviewError('INVALID', 'a rejection needs the name of the person who made it');
    if (![...REJECTION_REASONS, EXPIRED_REASON].includes(reason as never)) throw new ReviewError('INVALID', `the reason must be one of ${REJECTION_REASONS.join(', ')}`);
    return this.locked((owns) => {
      const item = this.get(versionId);
      if (item.status === 'rejected' && item.decision) return item.decision;
      const decision: Decision = { versionId, decision: 'reject', by, at: this.now().toISOString(), reason, ...(comment ? { comment: comment.slice(0, 500) } : {}), imageSha256: item.version.imageSha256, contentSha256: item.version.contentSha256 };
      this.mustOwn(owns);
      appendDurable(this.file, JSON.stringify({ type: 'decision', decision } satisfies Event));
      return decision;
    });
  }

  /**
   * The only way to get a file for publishing or download: the version must be approved, the latest of its post, and its picture and content must
   * still match what was approved. Returns the picture's path and the version.
   */
  approvedFile(versionId: string): { version: PostVersion; path: string; bytes: Buffer } {
    const item = this.get(versionId);
    if (item.status !== 'approved' || !item.decision) throw new ReviewError('NOT_APPROVED', `version ${versionId} is ${item.status}, not approved`);
    const bytes = this.readVerified(item.version);
    if (item.decision.imageSha256 !== item.version.imageSha256 || item.decision.contentSha256 !== item.version.contentSha256) throw new ReviewError('TAMPERED', 'the approval was made against a different picture or content');
    return { version: item.version, path: join(this.brandDir, item.version.imageFile), bytes };
  }

  /** The latest approved version of each network a post was made for, ready to be released through that network. */
  approvedForNetworks(postId: string): Array<{ version: PostVersion; path: string; bytes: Buffer }> {
    return this.history(postId).filter((i) => i.status === 'approved' && i.version.network !== undefined).map((i) => this.approvedFile(i.version.versionId));
  }

  /** True when the post id is a carousel: some version names it as its group. */
  isCarousel(postId: string): boolean {
    return this.fold().some((i) => i.version.carousel?.id === postId);
  }

  /** A carousel as it stands: each slide's latest version in order (undefined where a slide has none yet) and each network's latest caption. */
  carouselSlides(id: string): { count: number; slides: Array<ReviewItem | undefined>; captions: ReviewItem[] } {
    const members = this.fold().filter((i) => i.version.carousel?.id === id);
    const first = members[0]?.version.carousel;
    if (!first) throw new ReviewError('NOT_FOUND', `there is no carousel ${id}`);
    const newest = (items: ReviewItem[]): ReviewItem | undefined => items.reduce<ReviewItem | undefined>((best, i) => (best === undefined || i.version.versionNumber > best.version.versionNumber ? i : best), undefined);
    const slides = Array.from({ length: first.count }, (_, index) => newest(members.filter((i) => i.version.carousel?.position === index + 1)));
    const networks = [...new Set(members.filter((i) => i.version.carousel?.position === 0).map((i) => i.version.network ?? ''))];
    const captions = networks.flatMap((network) => { const latest = newest(members.filter((i) => i.version.carousel?.position === 0 && (i.version.network ?? '') === network)); return latest ? [latest] : []; });
    return { count: first.count, slides, captions };
  }

  /** Where a carousel stands as a whole: waiting for a slide, blocked, rejected, approved (everything, as it is now) or waiting for the owner. */
  carouselStatus(id: string): 'incomplete' | 'blocked' | 'rejected' | 'approved' | 'pending' {
    const { slides, captions } = this.carouselSlides(id);
    if (slides.some((s) => s === undefined)) return 'incomplete';
    const all = [...(slides as ReviewItem[]), ...captions];
    if (all.some((i) => i.status === 'blocked')) return 'blocked';
    if (all.some((i) => i.status === 'rejected')) return 'rejected';
    if (captions.length > 0 && all.every((i) => i.status === 'approved')) return 'approved';
    return 'pending';
  }

  /**
   * Approves a whole carousel in one step: the latest version of every slide and of every network's caption. Everything is checked first and nothing is approved
   * unless all of it can be (every slide present, none blocked or rejected, at least one caption, every picture as it was made).
   */
  approveCarousel(id: string, by: string): Decision[] {
    if (by.trim() === '') throw new ReviewError('INVALID', 'an approval needs the name of the person who approved it');
    return this.locked((owns) => {
      const { slides, captions } = this.carouselSlides(id);
      const missing = slides.findIndex((s) => s === undefined);
      if (missing !== -1) throw new ReviewError('INVALID', `slide ${missing + 1} has no picture yet`);
      if (captions.length === 0) throw new ReviewError('INVALID', 'no caption was written for this carousel');
      const all = [...(slides as ReviewItem[]), ...captions];
      for (const item of all) {
        if (item.status === 'blocked') throw new ReviewError('BLOCKED', `${item.version.postId} did not pass the system's checks, so the carousel cannot be approved`);
        if (item.status === 'rejected') throw new ReviewError('ALREADY_DECIDED', `${item.version.postId} was rejected; make a new version of it first`);
        if (item.status !== 'approved') this.verify(item.version);
      }
      const decisions: Decision[] = [];
      this.mustOwn(owns);
      for (const item of all) {
        if (item.status === 'approved' && item.decision) continue;
        const decision: Decision = { versionId: item.version.versionId, decision: 'approve', by, at: this.now().toISOString(), imageSha256: item.version.imageSha256, contentSha256: item.version.contentSha256 };
        appendDurable(this.file, JSON.stringify({ type: 'decision', decision } satisfies Event));
        decisions.push(decision);
      }
      return decisions;
    });
  }

  /** Withdraws a whole carousel: every slide and caption that is not already rejected or blocked is rejected, with one reason. */
  rejectCarousel(id: string, by: string, reason: RejectionReason, comment?: string): Decision[] {
    if (by.trim() === '') throw new ReviewError('INVALID', 'a rejection needs the name of the person who made it');
    if (!(REJECTION_REASONS as readonly string[]).includes(reason)) throw new ReviewError('INVALID', `the reason must be one of ${REJECTION_REASONS.join(', ')}`);
    return this.locked((owns) => {
      const { slides, captions } = this.carouselSlides(id);
      const open = [...slides.filter((s): s is ReviewItem => s !== undefined), ...captions].filter((i) => i.status !== 'rejected' && i.status !== 'blocked');
      this.mustOwn(owns);
      return open.map((item): Decision => {
        const decision: Decision = { versionId: item.version.versionId, decision: 'reject', by, at: this.now().toISOString(), reason, ...(comment ? { comment: comment.slice(0, 500) } : {}), imageSha256: item.version.imageSha256, contentSha256: item.version.contentSha256 };
        appendDurable(this.file, JSON.stringify({ type: 'decision', decision } satisfies Event));
        return decision;
      });
    });
  }

  /** The only way to get a carousel for posting: every slide's latest version approved and still as approved, and at least one approved caption. */
  approvedCarousel(id: string): { slides: Array<{ version: PostVersion; path: string; bytes: Buffer }>; captions: Array<{ version: PostVersion; path: string; bytes: Buffer }> } {
    const { slides, captions } = this.carouselSlides(id);
    const notReady = slides.findIndex((s) => s === undefined || s.status !== 'approved');
    if (notReady !== -1) throw new ReviewError('NOT_APPROVED', `slide ${notReady + 1} of carousel ${id} is not approved`);
    const approvedCaptions = captions.filter((c) => c.status === 'approved');
    if (approvedCaptions.length === 0) throw new ReviewError('NOT_APPROVED', `carousel ${id} has no approved caption`);
    return {
      slides: (slides as ReviewItem[]).map((s) => this.approvedFile(s.version.versionId)),
      captions: approvedCaptions.map((c) => this.approvedFile(c.version.versionId)),
    };
  }

  /** The approved version of a post that may go out now, if there is one. */
  approvedFor(postId: string): { version: PostVersion; path: string; bytes: Buffer } | undefined {
    // Only a version made without a network: a poster made for one network is released through that network's own version, never by the post's name alone.
    const item = this.history(postId, '').find((i) => i.status === 'approved');
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

  /** The bytes of any version's picture, checked as they are read (what the review page shows). */
  previewBytes(versionId: string): Buffer {
    return this.readVerified(this.get(versionId).version);
  }
}

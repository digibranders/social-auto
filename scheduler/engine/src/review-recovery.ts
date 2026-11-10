/**
 * Recovery of a review log that a crash left damaged. It is for an administrator, never automatic and never an owner's button, and it is built around
 * one danger: the record that was being written when the crash came may have been a withdrawal. Throwing it away would turn a withdrawn approval back
 * into an approved one. So:
 *
 *   - only a damaged FINAL record can be repaired; damage anywhere else, a record that makes no sense, or a picture or text that no longer matches its
 *     hash is refused, and the log is left exactly as it is for a restore from a backup or an offline investigation;
 *   - nothing is repaired while any writer might be active (the store's lock and the review service's lock must both be free);
 *   - the original log, the quarantined bytes and a report are kept, read-only, before anything is changed;
 *   - every approval in force at the moment of the repair is put on hold: it stays unpublishable and undownloadable until the owner approves that exact
 *     version again, which is recorded as a new decision;
 *   - the repair is written into the log as a record of its own (who, why, when, hashes), and the result is checked before the store is released.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { acquireLock, appendDurable, LockError, lockState, syncDir, type LockState } from './file-lock.ts';
import { contentHashOf, ReviewStore, type Event, type PostVersion, type RecoveryRecord } from './review-store.ts';

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

export class RecoveryRefused extends Error {
  readonly code: 'NOTHING_TO_RECOVER' | 'UNRECOVERABLE' | 'WRITER_ACTIVE' | 'INVALID';
  readonly problems: string[];
  constructor(code: RecoveryRefused['code'], message: string, problems: string[] = []) {
    super(message);
    this.name = 'RecoveryRefused';
    this.code = code;
    this.problems = problems;
  }
}

export interface Inspection {
  logFile: string;
  records: number;
  /** clean: nothing to do. recoverable: only the final record is damaged. unrecoverable: anything else is wrong. */
  status: 'clean' | 'recoverable' | 'unrecoverable';
  kind?: 'torn_tail' | 'missing_newline';
  problems: string[];
  /** The bytes of the damaged final record, if there are any. */
  tail?: { bytes: number; sha256: string };
  /** Approvals in force in the valid part of the log. */
  approvedInForce: string[];
  storeLock: LockState;
  serviceLock: LockState;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string' && v !== '';

/** Whether a parsed line is a well formed record of one of the three kinds. */
function wellFormed(value: unknown): value is Event {
  if (!isRecord(value)) return false;
  if (value['type'] === 'version') {
    const v = value['version'];
    return isRecord(v) && str(v['versionId']) && str(v['brand']) && str(v['postId']) && typeof v['versionNumber'] === 'number' && str(v['headline']) && typeof v['caption'] === 'string' && str(v['imageFile']) && str(v['imageSha256']) && str(v['contentSha256'])
      && Array.isArray(v['factIds']) && isRecord(v['validation']) && typeof v['validation']['accepted'] === 'boolean';
  }
  if (value['type'] === 'decision') {
    const d = value['decision'];
    return isRecord(d) && str(d['versionId']) && (d['decision'] === 'approve' || d['decision'] === 'reject') && str(d['by']) && str(d['at']) && str(d['imageSha256']) && str(d['contentSha256']);
  }
  if (value['type'] === 'recovery') {
    const r = value['recovery'];
    return isRecord(r) && str(r['actor']) && str(r['at']) && Array.isArray(r['heldVersionIds']);
  }
  return false;
}

/** Reads the log and says what is wrong with it, without changing anything. */
export function inspectLog(brandDir: string, brandsRoot: string = dirname(brandDir)): Inspection {
  const logFile = join(brandDir, 'reviews.jsonl');
  const storeLock = lockState(`${logFile}.lock`);
  const serviceLock = lockState(join(brandsRoot, '.review-service.lock'));
  const base = { logFile, storeLock, serviceLock, approvedInForce: [] as string[] };
  let text = '';
  try {
    text = readFileSync(logFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...base, records: 0, status: 'clean', problems: [] };
    throw error;
  }
  if (text === '') return { ...base, records: 0, status: 'clean', problems: [] };

  const endsWithNewline = text.endsWith('\n');
  const lines = (endsWithNewline ? text.slice(0, -1) : text).split('\n');
  const problems: string[] = [];
  const events: Event[] = [];
  let tail: { index: number; text: string } | undefined;
  for (const [index, line] of lines.entries()) {
    const last = index === lines.length - 1;
    let value: unknown;
    let parsed = true;
    try {
      value = JSON.parse(line);
    } catch {
      parsed = false;
    }
    if (parsed && wellFormed(value)) {
      events.push(value);
      continue;
    }
    if (last) {
      tail = { index, text: line };
    } else {
      problems.push(`record ${index + 1} of ${lines.length} is ${parsed ? 'not a valid review record' : 'damaged'}, and it is not the last one: the log cannot be repaired by cutting its end`);
    }
  }

  // Everything before the end must make sense: versions are unique, a decision follows its version, pictures and text still match their hashes.
  const versions = new Map<string, PostVersion>();
  const decisions = new Map<string, string>();
  for (const [i, event] of events.entries()) {
    if (event.type === 'version') {
      if (versions.has(event.version.versionId)) problems.push(`version ${event.version.versionId} appears twice (record ${i + 1})`);
      versions.set(event.version.versionId, event.version);
      if (contentHashOf(event.version) !== event.version.contentSha256) problems.push(`the content of ${event.version.versionId} does not match its hash`);
      try {
        if (sha256(readFileSync(join(brandDir, event.version.imageFile))) !== event.version.imageSha256) problems.push(`the picture of ${event.version.versionId} does not match its hash`);
      } catch {
        problems.push(`the picture of ${event.version.versionId} is missing`);
      }
    } else if (event.type === 'decision') {
      const version = versions.get(event.decision.versionId);
      if (!version) problems.push(`a decision at record ${i + 1} is about a version that does not exist yet`);
      else if (event.decision.imageSha256 !== version.imageSha256 || event.decision.contentSha256 !== version.contentSha256) problems.push(`a decision about ${event.decision.versionId} was made against a different picture or text`);
      decisions.set(event.decision.versionId, event.decision.decision);
    }
  }
  const approvedInForce = [...decisions].filter(([, d]) => d === 'approve').map(([id]) => id);
  const common = { ...base, records: events.length, approvedInForce };
  if (problems.length > 0) return { ...common, status: 'unrecoverable', problems, ...(tail ? { tail: { bytes: Buffer.byteLength(tail.text), sha256: sha256(tail.text) } } : {}) };
  if (tail) {
    const bytes = Buffer.from(tail.text);
    return { ...common, status: 'recoverable', kind: 'torn_tail', problems: ['the last record was cut short'], tail: { bytes: bytes.length, sha256: sha256(bytes) } };
  }
  if (!endsWithNewline) return { ...common, status: 'recoverable', kind: 'missing_newline', problems: ['the last record is complete but has no line ending'] };
  return { ...common, status: 'clean', problems: [] };
}

function writeFileDurable(path: string, data: string | Buffer, mode?: number): void {
  const own = `${path}.${randomUUID()}.tmp`;
  writeFileSync(own, data);
  const fd = openSync(own, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (mode !== undefined) chmodSync(own, mode);
  renameSync(own, path);
  syncDir(path);
}

export interface RecoveryResult {
  record: RecoveryRecord;
  evidenceDir: string;
}

export interface RecoverOptions {
  brandDir: string;
  brand: string;
  actor: string;
  reason: string;
  brandsRoot?: string;
  now?: () => Date;
  /** How long to wait for the store's lock before concluding a writer is active. */
  lockTimeoutMs?: number;
}

/** Repairs a log whose only damage is its final record, as described at the top of this file. Throws RecoveryRefused for everything else. */
export function recoverLog(options: RecoverOptions): RecoveryResult {
  const { brandDir, brand, actor, reason } = options;
  if (actor.trim() === '') throw new RecoveryRefused('INVALID', 'a recovery needs the name of the administrator who does it (--actor)');
  if (reason.trim().length < 5) throw new RecoveryRefused('INVALID', 'a recovery needs a reason of at least a few words (--reason)');
  const brandsRoot = options.brandsRoot ?? dirname(brandDir);
  const now = options.now ?? ((): Date => new Date());

  // No writer may be active: the review service's own lock, then the store's lock (held for the whole repair).
  const service = lockState(join(brandsRoot, '.review-service.lock'));
  if (service.state === 'held' || service.state === 'damaged' || service.state === 'foreign_holder') {
    throw new RecoveryRefused('WRITER_ACTIVE', `the review service lock is ${service.state === 'held' ? `held by a running process (${service.pid})` : service.state}: stop the review service first`);
  }
  let release: ReturnType<typeof acquireLock>;
  try {
    release = acquireLock(`${join(brandDir, 'reviews.jsonl')}.lock`, { timeoutMs: options.lockTimeoutMs ?? 1000 });
  } catch (error) {
    if (error instanceof LockError) throw new RecoveryRefused('WRITER_ACTIVE', `a writer holds the review store (${error.message}): stop everything that writes to this brand first`);
    throw error;
  }
  try {
    const inspection = inspectLog(brandDir, brandsRoot);
    if (inspection.status === 'clean') throw new RecoveryRefused('NOTHING_TO_RECOVER', 'the log is intact, so there is nothing to recover');
    if (inspection.status === 'unrecoverable') throw new RecoveryRefused('UNRECOVERABLE', 'the log is damaged in a way that cutting its end cannot repair; restore it from a verified backup or investigate it offline. It has not been changed.', inspection.problems);

    const logFile = inspection.logFile;
    const original = readFileSync(logFile);
    const text = original.toString('utf8');
    const stamp = now().toISOString().replace(/[:.]/g, '-');
    const evidenceDir = join(brandDir, 'recovery', `${stamp}-${randomUUID().slice(0, 8)}`);
    mkdirSync(evidenceDir, { recursive: true });
    // 1. The evidence, before anything changes.
    copyFileSync(logFile, join(evidenceDir, 'reviews.jsonl.original'));
    chmodSync(join(evidenceDir, 'reviews.jsonl.original'), 0o444);

    // 2. The valid part, and the cut-off bytes set aside.
    const cut = text.endsWith('\n') ? text.slice(0, -1).lastIndexOf('\n') + 1 : text.lastIndexOf('\n') + 1;
    const prefix = text.slice(0, cut);
    const tailText = text.slice(cut);
    const kind = inspection.kind as 'torn_tail' | 'missing_newline';
    const quarantined = kind === 'torn_tail' ? Buffer.from(tailText) : Buffer.alloc(0);
    if (kind === 'torn_tail') writeFileDurable(join(evidenceDir, 'torn-tail.bin'), quarantined, 0o444);
    const repaired = kind === 'torn_tail' ? prefix : `${text}\n`;

    // 3. The repair, and its record in the log. A complete record that only lacked its line ending is kept as it is; a cut-off record is lost, so the approvals in force are held.
    writeFileDurable(logFile, repaired);
    const record: RecoveryRecord = {
      at: now().toISOString(), actor, reason: reason.trim(), kind,
      originalSha256: sha256(original), repairedSha256: sha256(repaired),
      quarantinedBytes: quarantined.length, quarantinedSha256: sha256(quarantined),
      heldVersionIds: kind === 'torn_tail' ? inspection.approvedInForce : [],
      evidenceDir,
    };
    appendDurable(logFile, JSON.stringify({ type: 'recovery', recovery: record } satisfies Event));
    writeFileDurable(join(evidenceDir, 'report.json'), `${JSON.stringify({ ...record, inspection: { ...inspection, storeLock: undefined, serviceLock: undefined } }, null, 2)}\n`, 0o444);

    // 4. Check the result before the lock is let go: the log reads cleanly, every approval that was in force is held, and nothing is downloadable.
    const check = inspectLog(brandDir, brandsRoot);
    if (check.status !== 'clean') throw new RecoveryRefused('UNRECOVERABLE', 'after the repair the log still does not check out; the original is kept in the recovery folder', check.problems);
    const store = new ReviewStore(brandDir, brand);
    for (const id of record.heldVersionIds) {
      if (store.get(id).status !== 'held') throw new RecoveryRefused('UNRECOVERABLE', `after the repair ${id} is not held; the original is kept in the recovery folder`);
    }
    return { record, evidenceDir };
  } finally {
    release();
  }
}

export const evidenceExists = (dir: string): boolean => existsSync(join(dir, 'reviews.jsonl.original'));

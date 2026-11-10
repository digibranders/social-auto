/**
 * The lead-time check. A poster can only go out on its day if it is approved before then. This looks at the posters still waiting for approval and tells the
 * owner, once each, about two cases:
 *
 *   closing  the poster's time is less than LEAD_TIME_HOURS away and nobody has approved it yet: approve it now or it will be missed;
 *   lapsed   the poster's time passed while it was still waiting: it can no longer go out on its day and will not be posted by itself.
 *
 * A client on automatic approval has its passing posters approved before this runs, so what is left here failed a check or was drawn too late. The check
 * only reads (the review queue and the plan files); the only thing it writes is the list of notices already sent, so the 5-minute timer does not repeat them.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { ReviewStore } from './review-store.ts';

/** A poster still waiting for approval this close to its time is reported. */
export const LEAD_TIME_HOURS = 24;
/** A lapsed poster is reported only while it is this recent, so an old backlog never floods the phone. */
export const LAPSED_REPORT_HOURS = 48;
const HOUR_MS = 60 * 60 * 1000;
/** Notices already sent are forgotten after this long. */
const KEEP_NOTICES_DAYS = 60;

export interface WaitingPost {
  postId: string;
  /** When the poster is meant to go out, in ms since the epoch. */
  at: number;
}

export interface LeadTimeFindings {
  closing: WaitingPost[];
  lapsed: WaitingPost[];
}

/** Sorts waiting posters into those about to run out of time and those whose time has gone. Pure. */
export function classifyWaiting(waiting: readonly WaitingPost[], now: number, leadHours: number = LEAD_TIME_HOURS, lapsedHours: number = LAPSED_REPORT_HOURS): LeadTimeFindings {
  const closing = waiting.filter((p) => p.at > now && p.at - now < leadHours * HOUR_MS).sort((a, b) => a.at - b.at);
  const lapsed = waiting.filter((p) => p.at <= now && now - p.at < lapsedHours * HOUR_MS).sort((a, b) => a.at - b.at);
  return { closing, lapsed };
}

/** The posters of these plan files that have a version waiting and none approved, each once, with the time its plan gives it. A plan file that cannot be read gives none: nothing is guessed. */
export function waitingPosts(brandDir: string, site: string, weekFiles: readonly string[], now: Date): WaitingPost[] {
  if (!existsSync(join(brandDir, 'reviews.jsonl'))) return [];
  const wanted = new Set(weekFiles);
  const dates = new Map<string, number>();
  const dateOf = (planFile: string, postId: string): number | undefined => {
    const name = basename(planFile);
    if (!dates.has(`${name}|`)) {
      dates.set(`${name}|`, 0);
      try {
        const plan = JSON.parse(readFileSync(join(brandDir, name), 'utf8')) as { posts?: Array<{ id?: unknown; date?: unknown }> };
        for (const p of plan.posts ?? []) if (typeof p.id === 'string' && typeof p.date === 'string') dates.set(`${name}|${p.id}`, Date.parse(p.date));
      } catch {
        // an unreadable plan file means no date is known
      }
    }
    return dates.get(`${name}|${postId}`);
  };
  const items = new ReviewStore(brandDir, site, () => now).list().filter((i) => wanted.has(basename(i.version.planFile)));
  const approved = new Set(items.filter((i) => i.status === 'approved').map((i) => i.version.postId));
  const out = new Map<string, WaitingPost>();
  for (const item of items) {
    if (item.status !== 'pending' || approved.has(item.version.postId) || out.has(item.version.postId)) continue;
    const at = dateOf(item.version.planFile, item.version.postId);
    if (at !== undefined && Number.isFinite(at)) out.set(item.version.postId, { postId: item.version.postId, at });
  }
  return [...out.values()];
}

interface NoticeLedger {
  sent: Record<string, string>;
}

const ledgerPath = (brandDir: string): string => join(brandDir, 'notices.json');

async function readLedger(brandDir: string): Promise<NoticeLedger> {
  try {
    const parsed = JSON.parse(await readFile(ledgerPath(brandDir), 'utf8')) as Partial<NoticeLedger>;
    return { sent: typeof parsed.sent === 'object' && parsed.sent !== null ? parsed.sent : {} };
  } catch {
    return { sent: {} };
  }
}

async function writeLedger(brandDir: string, ledger: NoticeLedger, now: Date): Promise<void> {
  const cutoff = now.getTime() - KEEP_NOTICES_DAYS * 24 * HOUR_MS;
  const sent = Object.fromEntries(Object.entries(ledger.sent).filter(([, at]) => Date.parse(at) > cutoff));
  const file = ledgerPath(brandDir);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify({ sent }, null, 2));
  await rename(`${file}.tmp`, file);
}

const when = (at: number): string => new Date(at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

export interface LeadTimeNotice {
  title: string;
  message: string;
  priority: 'default' | 'high';
}

/** The notices still to send for a client, one per finding, in plain words. `dashboardNote` says where to act. */
export function noticesFor(client: string, findings: LeadTimeFindings, sent: ReadonlySet<string>, now: number): Array<LeadTimeNotice & { key: string }> {
  const out: Array<LeadTimeNotice & { key: string }> = [];
  for (const p of findings.closing) {
    const key = `closing:${p.postId}`;
    if (sent.has(key)) continue;
    const hours = Math.max(1, Math.round((p.at - now) / HOUR_MS));
    out.push({ key, priority: hours <= 6 ? 'high' : 'default', title: `Poster waiting for approval: ${client}`, message: `${client}: the poster for ${when(p.at)} (in about ${hours} hour${hours === 1 ? '' : 's'}) is not approved yet. Approve it in the Review tab, or it will be missed.` });
  }
  for (const p of findings.lapsed) {
    const key = `lapsed:${p.postId}`;
    if (sent.has(key)) continue;
    out.push({ key, priority: 'high', title: `Poster missed its time: ${client}`, message: `${client}: the poster for ${when(p.at)} was never approved, so it was not posted and will not be posted by itself. Reschedule it from the dashboard if it is still wanted.` });
  }
  return out;
}

/**
 * Looks at one client's waiting posters and sends the notices not sent before. A notice is recorded as sent only when it was delivered, so one that could
 * not be sent is tried again at the next run. Returns the notices that were delivered.
 */
export async function checkLeadTime(
  brandDir: string, site: string, client: string, weekFiles: readonly string[], now: Date,
  send: (notice: LeadTimeNotice) => Promise<boolean>,
): Promise<LeadTimeNotice[]> {
  const findings = classifyWaiting(waitingPosts(brandDir, site, weekFiles, now), now.getTime());
  if (findings.closing.length === 0 && findings.lapsed.length === 0) return [];
  const ledger = await readLedger(brandDir);
  const todo = noticesFor(client, findings, new Set(Object.keys(ledger.sent)), now.getTime());
  const delivered: LeadTimeNotice[] = [];
  for (const { key, ...notice } of todo) {
    if (await send(notice)) {
      ledger.sent[key] = now.toISOString();
      delivered.push(notice);
    }
  }
  if (delivered.length > 0) await writeLedger(brandDir, ledger, now);
  return delivered;
}

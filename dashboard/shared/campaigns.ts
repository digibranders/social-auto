/**
 * What the status panel says about the posters being made for each client's plans: which step each plan is on, how far along it is, roughly how long is
 * left and roughly what it costs. The engine's campaign runner records the facts (what each batch is doing); this turns them, together with the plans the
 * dashboard already knows, into plain words. Nothing here is exact: times are an average of what real runs took, and the panel says "about".
 * It only reads. A plan with no record yet is "waiting": the runner looks for new plans every few minutes.
 */
import { dayLabel, planCost, planDates, platformNames, todayAt } from './posting-plan.ts';

/** What one run measured: about 100 seconds to read the site and write the posts, and about 110 seconds for each poster drawn and checked (a retry is common). */
export const BASE_SECONDS = 100;
export const PER_POSTER_SECONDS = 110;
/** How often the runner looks for new plans, in minutes (the timer on the server). */
export const CHECK_EVERY_MINUTES = 5;
/** A plan that has waited this long without the runner picking it up is probably not being looked at. */
export const STALLED_AFTER_MINUTES = 15;

export type BatchStatus = 'pending' | 'running' | 'done' | 'failed' | 'interrupted';
export type BatchStage = 'reading' | 'writing' | 'drawing' | 'finishing';

export interface CampaignBatch {
  index: number;
  dates: string[];
  status: BatchStatus;
  stage?: BatchStage;
  /** The step a failed run had reached; missing when it stopped before the first one. */
  stoppedAt?: BatchStage;
  detail?: string;
  drawn?: number;
  /** How many posters of this batch reached the review queue; missing in older records. */
  queued?: number;
  startedAt?: string;
  finishedAt?: string;
  failure?: string;
  note?: string;
}

export interface Campaign {
  id: string;
  brand: string;
  site: string;
  plan: { platforms: string[]; startDate: string; durationDays: number; postsPerWeek?: number; time: string };
  status: 'queued' | 'running' | 'awaiting_approval' | 'partial' | 'failed' | 'interrupted';
  createdAt: string;
  updatedAt: string;
  batches: CampaignBatch[];
}

/** What the dashboard knows of a client's plan. */
export interface PlanOfClient {
  platforms: readonly string[];
  startDate: string;
  durationDays: number;
  postsPerWeek?: number;
  weekdays?: readonly string[];
  time: string;
}

export interface ClientForStatus {
  brand: string;
  label: string;
  plans: readonly PlanOfClient[];
}

const BATCH_STATUSES: readonly string[] = ['pending', 'running', 'done', 'failed', 'interrupted'];
const STAGES: readonly string[] = ['reading', 'writing', 'drawing', 'finishing'];
const CAMPAIGN_STATUSES: readonly string[] = ['queued', 'running', 'awaiting_approval', 'partial', 'failed', 'interrupted'];

const str = (v: unknown, max = 400): string | undefined => (typeof v === 'string' && v !== '' ? v.slice(0, max) : undefined);

/** Reads the review service's campaign list. Anything that is not what is expected is left out, never trusted. */
export function parseCampaigns(raw: unknown): Campaign[] {
  const list = (raw as { campaigns?: unknown } | null)?.campaigns;
  if (!Array.isArray(list)) return [];
  const out: Campaign[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const c = entry as Record<string, unknown>;
    const plan = c['plan'] as Record<string, unknown> | undefined;
    const id = str(c['id'], 80);
    const brand = str(c['brand'], 80);
    const status = str(c['status'], 40);
    if (!id || !brand || !status || !CAMPAIGN_STATUSES.includes(status) || !plan || !Array.isArray(plan['platforms']) || typeof plan['startDate'] !== 'string' || typeof plan['durationDays'] !== 'number' || !Array.isArray(c['batches'])) continue;
    const batches: CampaignBatch[] = [];
    for (const b of c['batches']) {
      const r = b as Record<string, unknown>;
      const bstatus = str(r['status'], 20);
      if (!bstatus || !BATCH_STATUSES.includes(bstatus) || !Array.isArray(r['dates']) || typeof r['index'] !== 'number') continue;
      const stage = str(r['stage'], 20);
      const stoppedAt = str(r['stoppedAt'], 20);
      const detail = str(r['detail'], 200);
      const failure = str(r['failure'], 300);
      const note = str(r['note'], 300);
      const startedAt = str(r['startedAt'], 40);
      const finishedAt = str(r['finishedAt'], 40);
      batches.push({
        index: r['index'], dates: (r['dates'] as unknown[]).filter((d): d is string => typeof d === 'string'), status: bstatus as BatchStatus,
        ...(stage && STAGES.includes(stage) ? { stage: stage as BatchStage } : {}), ...(stoppedAt && STAGES.includes(stoppedAt) ? { stoppedAt: stoppedAt as BatchStage } : {}), ...(detail ? { detail } : {}), ...(typeof r['drawn'] === 'number' ? { drawn: r['drawn'] } : {}), ...(typeof r['queued'] === 'number' ? { queued: r['queued'] } : {}),
        ...(startedAt ? { startedAt } : {}), ...(finishedAt ? { finishedAt } : {}), ...(failure ? { failure } : {}), ...(note ? { note } : {}),
      });
    }
    out.push({
      id, brand, site: str(c['site'], 200) ?? '', status: status as Campaign['status'], createdAt: str(c['createdAt'], 40) ?? '', updatedAt: str(c['updatedAt'], 40) ?? '', batches,
      plan: { platforms: (plan['platforms'] as unknown[]).filter((p): p is string => typeof p === 'string'), startDate: plan['startDate'], durationDays: plan['durationDays'], ...(typeof plan['postsPerWeek'] === 'number' ? { postsPerWeek: plan['postsPerWeek'] } : {}), time: str(plan['time'], 10) ?? '10:00' },
    });
  }
  return out;
}

/** The same plan, recognised by what the owner chose (the record and the client's list carry the same fields). */
export function samePlan(a: Pick<PlanOfClient, 'platforms' | 'startDate' | 'durationDays' | 'postsPerWeek' | 'time'>, b: Pick<PlanOfClient, 'platforms' | 'startDate' | 'durationDays' | 'postsPerWeek' | 'time'>): boolean {
  return [...a.platforms].sort().join(',') === [...b.platforms].sort().join(',') && a.startDate === b.startDate && a.durationDays === b.durationDays && (a.postsPerWeek ?? 0) === (b.postsPerWeek ?? 0) && a.time === b.time;
}

/** A key that stays the same for the same plan of the same client, so a dismissal or a first sighting can be remembered. */
export const planKey = (brand: string, plan: PlanOfClient): string => `${brand}|${[...plan.platforms].sort().join('+')}|${plan.startDate}|${plan.durationDays}|${plan.postsPerWeek ?? 0}|${plan.time}`;

/** Roughly how long `posters` take to make from the start, in seconds. */
export const estimateSeconds = (posters: number): number => BASE_SECONDS + PER_POSTER_SECONDS * posters;

/** "under a minute", "about 4 minutes", "about 1 h 20 min". */
export function durationText(seconds: number): string {
  if (seconds < 60) return 'under a minute';
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  return `about ${hours} h ${minutes % 60 > 0 ? `${minutes % 60} min` : ''}`.trim();
}

export type ItemState = 'waiting' | 'working' | 'review' | 'failed' | 'stalled';

export interface StatusItem {
  key: string;
  state: ItemState;
  /** "Oye Chats: 4 posters" */
  title: string;
  /** "Instagram and Facebook, Sat 7 Nov to Sat 5 Dec at 10:00" */
  subtitle: string;
  headline: string;
  /** The latest thing the run said, when it is working. */
  detail?: string;
  /** 0 to 100. */
  percent: number;
  steps: Array<{ label: string; state: 'done' | 'now' | 'todo' }>;
  /** "about 3 minutes left". */
  eta?: string;
  /** "about $0.02 to $0.08". */
  cost: string;
  failure?: string;
  /** For a finished item: how many posters wait in Review. */
  ready?: number;
  updatedAt: string;
}

const STEP_LABELS = ['Waiting to start', 'Reading the website', 'Writing the posts', 'Drawing the posters', 'Ready for you'] as const;

/** `index` is the step a plan is on (0 waiting, 1 reading, 2 writing, 3 drawing, 4 ready); -1 marks none, for a plan that stopped before the first step. */
function stepsFor(index: number, finished: boolean): StatusItem['steps'] {
  return STEP_LABELS.map((label, i) => ({ label, state: finished || i < index ? 'done' : i === index ? 'now' : 'todo' }));
}

const money = (c: { low: number; high: number }): string => `about $${c.low.toFixed(2)} to $${c.high.toFixed(2)}`;

/** The days of a plan that are still to come, which is what is left to make. */
function futureDates(plan: PlanOfClient, today: string): string[] {
  return planDates({ startDate: plan.startDate, durationDays: plan.durationDays, ...(plan.postsPerWeek ? { postsPerWeek: plan.postsPerWeek } : {}), ...(plan.weekdays ? { weekdays: plan.weekdays } : {}) }).filter((d) => d >= today);
}

function subtitleOf(plan: PlanOfClient, dates: readonly string[]): string {
  const span = dates.length > 1 ? `${dayLabel(dates[0] as string)} to ${dayLabel(dates.at(-1) as string)}` : dayLabel((dates[0] ?? plan.startDate));
  return `${platformNames(plan.platforms)}, ${span} at ${plan.time}`;
}

/** The codes the poster maker stops with, in words the owner can act on. */
const FAILURE_WORDS: Readonly<Record<string, string>> = {
  BUDGET_EXHAUSTED: 'The spending limit was reached, so no more posters were drawn.',
  SITE_ACCESS_BLOCKED: 'The website does not allow its pages to be read.',
  SITE_UNREACHABLE: 'The website could not be reached.',
  URL_REFUSED: 'That website address cannot be used.',
  UNSUPPORTED_LANGUAGE: 'The website is in a language the poster maker does not write in.',
  INSUFFICIENT_EVIDENCE: 'The website did not give enough facts to write posters from.',
};

/** What to do about a stop the owner can fix themselves. */
const FAILURE_HINTS: Readonly<Record<string, string>> = {
  LOGO_REQUIRED: 'Turn off "Require the website\'s real logo" on the client\'s page to have the brand name used as text instead.',
};

/**
 * The last line of a failed run, without "Error:" or "BrandingError:" and its code in front: the sentence after the code when there is one, else the code
 * in words, and, for a stop the owner can fix, what to do about it.
 */
export function plainFailure(text: string): string {
  const line = text.replace(/^\s*(?:[A-Za-z]*Error):\s*/, '').trim();
  // The writing step gives its reasons post by post, in the engine's own words; the owner needs the meaning, not the list.
  if (/^insufficient_distinct_concepts\b/.test(line)) return 'The posts written from this website did not pass the checks, so no poster was drawn and nothing was spent on pictures. This happens when a site gives too few facts that can be stated safely. Try again later, or add a plan for a different day.';
  const coded = /^([A-Z][A-Z_]{3,})(?::\s*(.*))?$/.exec(line);
  if (!coded) return line;
  const code = coded[1] as string;
  const rest = coded[2] ?? '';
  const said = rest !== '' ? rest : (FAILURE_WORDS[code] ?? line);
  const hint = FAILURE_HINTS[code];
  return hint ? `${said} ${hint}` : said;
}

const posters = (n: number): string => `${n} poster${n === 1 ? '' : 's'}`;

/** How far through its work a batch is, 0 to 1, from the step it is on and the posters it has finished. */
export function batchFraction(batch: CampaignBatch): number {
  if (batch.status === 'done') return 1;
  if (batch.status !== 'running') return 0;
  const n = Math.max(1, batch.dates.length);
  switch (batch.stage) {
    case 'reading': return 0.08;
    case 'writing': return 0.2;
    case 'drawing': return 0.25 + 0.7 * Math.min(1, (batch.drawn ?? 0) / n);
    case 'finishing': return 0.97;
    default: return 0.05;
  }
}

/**
 * One item for each plan of each client that has something to say: waiting to start, being made, finished and waiting in Review, or failed. A plan whose
 * days have all passed and that was never made says nothing. `firstSeen` is when the panel first saw a plan waiting (milliseconds), used only to tell
 * "waiting a minute" from "nobody is picking this up".
 */
export function statusItems(clients: readonly ClientForStatus[], campaigns: readonly Campaign[], now: number, firstSeen: (key: string) => number | undefined = () => undefined): StatusItem[] {
  const items: StatusItem[] = [];
  for (const client of clients) {
    for (const plan of client.plans) {
      const today = todayAt('+05:30', new Date(now));
      const key = planKey(client.brand, plan);
      const record = campaigns.find((c) => c.brand === client.brand && samePlan(c.plan, plan));
      const dates = record ? record.batches.flatMap((b) => b.dates) : futureDates(plan, today);
      if (dates.length === 0) continue;
      const total = dates.length;
      const cost = money(planCost(total));
      const base = { key, title: `${client.label}: ${posters(total)}`, subtitle: subtitleOf(plan, dates), cost, updatedAt: record?.updatedAt ?? '' };

      if (!record || record.status === 'queued') {
        const waited = firstSeen(key) === undefined ? 0 : (now - (firstSeen(key) as number)) / 60_000;
        const stalled = waited >= STALLED_AFTER_MINUTES;
        items.push({
          ...base, state: stalled ? 'stalled' : 'waiting', percent: 0, steps: stepsFor(0, false),
          headline: stalled ? 'Still waiting to start' : `Waiting to start (checked every ${CHECK_EVERY_MINUTES} minutes)`,
          ...(stalled ? { failure: 'It has not started after more than 15 minutes. The poster maker may be switched off: tell whoever looks after the server.' } : { eta: `starts within ${CHECK_EVERY_MINUTES} minutes, then ${durationText(estimateSeconds(Math.min(total, 8)))}` }),
        });
        continue;
      }

      const failed = record.batches.filter((b) => b.status === 'failed' || b.status === 'interrupted');
      const running = record.batches.find((b) => b.status === 'running');
      const doneCount = record.batches.filter((b) => b.status === 'done').reduce((n, b) => n + b.dates.length, 0);

      if (running || (record.batches.some((b) => b.status === 'pending') && failed.length === 0)) {
        const current = running ?? record.batches.find((b) => b.status === 'pending') as CampaignBatch;
        const fraction = batchFraction(current);
        const percent = Math.min(99, Math.round(((doneCount + current.dates.length * fraction) / total) * 100));
        const elapsed = current.startedAt ? Math.max(0, (now - Date.parse(current.startedAt)) / 1000) : 0;
        const currentLeft = running ? Math.max(20, estimateSeconds(current.dates.length) * (1 - fraction)) : estimateSeconds(current.dates.length);
        const later = record.batches.filter((b) => b.status === 'pending' && b !== current).reduce((n, b) => n + estimateSeconds(b.dates.length), 0);
        const left = currentLeft + later;
        const stageIndex = !running ? 0 : current.stage === 'reading' ? 1 : current.stage === 'writing' ? 2 : 3;
        const n = current.dates.length;
        const drawing = current.stage === 'drawing' ? `Drawing poster ${Math.min(n, (current.drawn ?? 0) + 1)} of ${n}` : undefined;
        const headline = !running ? 'Waiting for the next part' : drawing ?? (current.stage === 'writing' ? 'Writing the posts' : current.stage === 'finishing' ? 'Checking the posters' : 'Reading the website');
        const slow = running && elapsed > estimateSeconds(current.dates.length) * 1.6;
        items.push({
          ...base, state: 'working', percent, steps: stepsFor(stageIndex, false), headline,
          ...(running && current.detail ? { detail: current.detail } : {}),
          eta: slow ? 'taking longer than usual' : `${durationText(left)} left`,
        });
        continue;
      }

      if (failed.length > 0) {
        const first = failed[0] as CampaignBatch;
        // The red dot goes where the run stopped; a run that stopped before its first step has no step to blame.
        const stoppedIndex = doneCount > 0 ? 3 : first.stoppedAt === 'reading' ? 1 : first.stoppedAt === 'writing' ? 2 : first.stoppedAt ? 3 : -1;
        items.push({
          ...base, state: 'failed', percent: Math.round((doneCount / total) * 100), steps: stepsFor(stoppedIndex, false),
          headline: doneCount > 0 ? `${posters(doneCount)} made, the rest did not work` : 'It did not work',
          failure: plainFailure(first.failure ?? first.note ?? 'The run stopped. The reason was not recorded.'), ...(doneCount > 0 ? { ready: doneCount } : {}),
        });
        continue;
      }

      // Everything ran. The runner records how many posters really reached Review: a run can finish with none, because the automatic checks turned them all back.
      const updated = Date.parse(record.updatedAt);
      if (Number.isFinite(updated) && now - updated > 6 * 3_600_000) continue;
      const counted = record.batches.every((b) => typeof b.queued === 'number');
      const ready = record.batches.reduce((n, b) => n + (b.queued ?? 0), 0);
      if (counted && ready === 0) {
        items.push({ ...base, state: 'failed', percent: 100, steps: stepsFor(3, false), headline: 'No poster passed the checks', failure: 'The posters were drawn, but the automatic checks turned every one back, so nothing is waiting in Review. Adding the plan again makes new ones.' });
        continue;
      }
      items.push({ ...base, state: 'review', percent: 100, steps: stepsFor(4, true), headline: counted ? `${posters(ready)} ready for your review${ready < total ? `, ${total - ready} did not pass the checks` : ''}` : 'Finished: look in Review', ...(counted ? { ready } : {}) });
    }
  }
  return items;
}

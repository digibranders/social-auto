/**
 * The record that lets the owner's approved posters of one written batch reach the calendar through the same path the posting plans use.
 *
 * The campaign runner's release pass (campaign-runner.ts releaseCampaigns, run by a timer on the server) looks for a record per plan under
 * brands/<site>/campaigns/ to learn which client a week file belongs to and which networks it may go to, then hands the publisher the exact approved
 * versions (export-publisher.ts). A batch written and drawn through the owner's review has no posting plan, so this writes that record for it.
 *
 * It is made when the owner asks for the kept posts to be drawn. That is safe to do before anything is approved: only approved versions are ever
 * exported, so until the owner approves a poster nothing is released, and while publishing is switched off nothing is released at all.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWeekPlan } from './content.ts';
import { isNetwork } from './networks.ts';
import type { CampaignState } from './campaign-runner.ts';
import type { PlanPlatform } from './posting-plan.ts';

export const CLIENT_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const WEEK_FILE = /^week-\d{2,4}\.json$/;

export interface ManualReleaseInput {
  brandDir: string;
  siteBrand: string;
  /** The client the posters belong to: the name its channels are connected under in the dashboard. */
  client: string;
  site: string;
  planFile: string;
  /** The networks it may go to, when they are known better than the plan says (a carousel's are the networks of its approved captions). */
  platforms?: readonly string[];
  now?: Date;
}

/**
 * A network added to a batch after its record was made: the record's networks gain it, so an approved picture for it reaches the schedule. A batch with no
 * record yet (not drawn) needs nothing: the record is made at the draw from the plan's own networks.
 */
export function addPlatformToRelease(brandDir: string, planFile: string, network: PlanPlatform): boolean {
  const file = join(brandDir, 'campaigns', `manual-${planFile.replace(/\.json$/, '')}.json`);
  if (!existsSync(file)) return false;
  const state = JSON.parse(readFileSync(file, 'utf8')) as CampaignState;
  if (state.plan.platforms.includes(network)) return false;
  state.plan.platforms = [...state.plan.platforms, network];
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temp, file);
  return true;
}

/** Writes the record once; asking again for the same batch changes nothing. Returns the networks the batch may go to. */
export function registerManualRelease(input: ManualReleaseInput): { file: string; platforms: PlanPlatform[]; created: boolean } {
  if (!CLIENT_NAME.test(input.client)) throw new Error('the client name must be lowercase letters, digits and dashes');
  if (!WEEK_FILE.test(input.planFile)) throw new Error('that is not a plan file name');
  const plan = parseWeekPlan(JSON.parse(readFileSync(join(input.brandDir, input.planFile), 'utf8')) as unknown, input.planFile);
  if (plan.posts.length === 0) throw new Error('the plan has no posts');
  const platforms = [...new Set((input.platforms ?? plan.posts.flatMap((p) => (p.variants ? Object.keys(p.variants) : ['instagram']))).filter(isNetwork))] as PlanPlatform[];
  if (platforms.length === 0) throw new Error('the plan has no network to go to');
  const dir = join(input.brandDir, 'campaigns');
  const id = `manual-${input.planFile.replace(/\.json$/, '')}`;
  const file = join(dir, `${id}.json`);
  if (existsSync(file)) return { file, platforms, created: false };
  const dates = [...new Set(plan.posts.map((p) => p.date.slice(0, 10)))].sort();
  const first = plan.posts.map((p) => p.date).sort()[0] as string;
  const now = (input.now ?? new Date()).toISOString();
  const state: CampaignState = {
    id,
    brand: input.client,
    siteBrand: input.siteBrand,
    site: input.site,
    plan: { platforms, startDate: dates[0] as string, durationDays: Math.max(1, Math.round((Date.parse(`${dates.at(-1)}T00:00:00Z`) - Date.parse(`${dates[0]}T00:00:00Z`)) / 86_400_000) + 1), time: first.slice(11, 16), utcOffset: /([+-]\d{2}:\d{2})$/.exec(first)?.[1] ?? '+00:00' },
    status: 'awaiting_approval',
    batches: [{ index: 0, dates, status: 'done', weekFile: input.planFile, queued: plan.posts.length }],
    createdAt: now,
    updatedAt: now,
  };
  mkdirSync(dir, { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temp, file);
  return { file, platforms, created: true };
}

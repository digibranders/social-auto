/**
 * A customer's choice to let the system post for her without approving each poster first. It is chosen per channel: she agrees for the channels she has connected
 * at that moment, and a channel she connects later starts as manual until she chooses again. The poster service does the work (scheduler/engine/src/auto-posting.ts);
 * this keeps what she agreed to, shows it, and says which connected channels still need her choice.
 */
import { PLAN_PLATFORMS, type AddedClient, type ClientsFile } from './clients.js';
import { EditError } from './overrides.js';

export const MAX_SAFETY_HOURS = 72;
export const DEFAULT_SAFETY_HOURS = 24;
type Platform = (typeof PLAN_PLATFORMS)[number];

export interface AutoPostingRequest {
  channels: Platform[];
  safetyHours: number;
  /** True when she agreed in this call; required whenever any channel is switched on. */
  consent: boolean;
}

/** What a product sent as `autoPosting`: `{channels: ["instagram", ...], safetyHours?, consent?}`. An empty list switches it off. */
export function parseAutoPostingRequest(raw: unknown): AutoPostingRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new EditError('autoPosting must be an object like {"channels": ["instagram"], "consent": true}', 400, 'INVALID_REQUEST');
  const body = raw as Record<string, unknown>;
  const list = body['channels'];
  if (!Array.isArray(list)) throw new EditError('channels must be a list of instagram, facebook, linkedin, google', 400, 'INVALID_REQUEST');
  const bad = list.find((c) => typeof c !== 'string' || !(PLAN_PLATFORMS as readonly string[]).includes(c));
  if (bad !== undefined) throw new EditError(`"${String(bad).slice(0, 20)}" is not a channel; use ${PLAN_PLATFORMS.join(', ')}`, 400, 'INVALID_NETWORKS');
  const hours = body['safetyHours'] ?? DEFAULT_SAFETY_HOURS;
  if (typeof hours !== 'number' || !Number.isInteger(hours) || hours < 0 || hours > MAX_SAFETY_HOURS) throw new EditError(`safetyHours must be a whole number of hours from 0 to ${MAX_SAFETY_HOURS}`, 400, 'INVALID_REQUEST');
  if (body['consent'] !== undefined && typeof body['consent'] !== 'boolean') throw new EditError('consent must be true or false', 400, 'INVALID_REQUEST');
  return { channels: PLAN_PLATFORMS.filter((p) => list.includes(p)), safetyHours: hours, consent: body['consent'] === true };
}

/** The file with this workspace's automatic posting set to what the poster service saved, or removed when it is switched off. Nothing else changes. */
export function setAutoPosting(file: ClientsFile, brand: string, saved: AutoPostingRequest & { consentBy: string; consentAt: string }): ClientsFile {
  if (!file.clients.some((c) => c.brand === brand)) throw new EditError('no such workspace', 404, 'WORKSPACE_NOT_FOUND');
  return {
    clients: file.clients.map((c) => {
      if (c.brand !== brand) return c;
      const { autoPosting: _old, ...rest } = c;
      return saved.channels.length === 0 ? rest : { ...rest, autoPosting: { channels: saved.channels, safetyHours: saved.safetyHours, consentBy: saved.consentBy, consentAt: saved.consentAt } };
    }),
  };
}

/** What a product reads: the channels it is on for and the window, when she agreed, and the connected channels that still need her choice. */
export function autoPostingView(client: AddedClient, connected: readonly string[]): { channels: string[]; safetyHours: number; consentedAt: string; needsChoice: string[] } | null {
  const auto = client.autoPosting;
  if (auto === undefined || auto.channels.length === 0) return null;
  return { channels: auto.channels, safetyHours: auto.safetyHours, consentedAt: auto.consentAt, needsChoice: PLAN_PLATFORMS.filter((p) => connected.includes(p) && !auto.channels.includes(p)) };
}

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

/** One keyword-triggered Instagram Auto-DM rule for a client brand. */
export interface AutoDmRule {
  id: string;
  brand: string;
  /** One or more comma-separated keywords (e.g. "LINK, PRICE"), matched case-insensitively. */
  keyword: string;
  /** The private reply DM text sent to the commenter. */
  message: string;
  /** Optional Instagram media ID to restrict this rule to one post; empty/undefined means all posts. */
  mediaId?: string;
  /** When true, sends a 2-step button first and verifies `is_user_follow_business` before sending `message`. */
  requireFollow?: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AutoDmFile {
  rules: AutoDmRule[];
}

export interface InstagramCommentEvent {
  accountId: string;
  commentId: string;
  text: string;
  fromId: string | null;
  fromUsername: string | null;
  mediaId: string | null;
}

export interface InstagramPostbackEvent {
  accountId: string;
  senderId: string;
  payload: string;
}

export const AUTODM_PAYLOAD_PREFIX = 'AUTODM:';

export const MAX_KEYWORD_LENGTH = 120;
export const MAX_DM_MESSAGE_LENGTH = 1000;

export function parseAutoDmFile(raw: unknown): AutoDmFile {
  const list = (raw as { rules?: unknown } | null)?.rules;
  if (!Array.isArray(list)) throw new Error('autodm file must contain a "rules" array');
  const rules = list.map((item: Record<string, unknown>, i): AutoDmRule => {
    for (const key of ['id', 'brand', 'keyword', 'message', 'createdAt', 'updatedAt']) {
      if (typeof item[key] !== 'string' || !item[key]) {
        throw new Error(`rules[${i}].${key} must be a non-empty string`);
      }
    }
    if (typeof item['enabled'] !== 'boolean') {
      throw new Error(`rules[${i}].enabled must be a boolean`);
    }
    if (item['mediaId'] !== undefined && typeof item['mediaId'] !== 'string') {
      throw new Error(`rules[${i}].mediaId must be a string`);
    }
    return {
      id: item['id'] as string,
      brand: item['brand'] as string,
      keyword: item['keyword'] as string,
      message: item['message'] as string,
      ...(typeof item['mediaId'] === 'string' && item['mediaId'].trim() ? { mediaId: item['mediaId'].trim() } : {}),
      ...(item['requireFollow'] === true ? { requireFollow: true } : {}),
      enabled: item['enabled'] as boolean,
      createdAt: item['createdAt'] as string,
      updatedAt: item['updatedAt'] as string,
    };
  });
  return { rules };
}

export function validateRuleInput(keywordRaw: unknown, messageRaw: unknown, mediaIdRaw?: unknown): { keyword: string; message: string; mediaId?: string } {
  const keyword = typeof keywordRaw === 'string' ? keywordRaw.trim() : '';
  const message = typeof messageRaw === 'string' ? messageRaw.trim() : '';
  const mediaId = typeof mediaIdRaw === 'string' ? mediaIdRaw.trim() : '';
  if (!keyword) throw new Error('Keyword is required');
  if (keyword.length > MAX_KEYWORD_LENGTH) throw new Error(`Keyword must be ${MAX_KEYWORD_LENGTH} characters or less`);
  if (!message) throw new Error('DM message is required');
  if (message.length > MAX_DM_MESSAGE_LENGTH) throw new Error(`DM message must be ${MAX_DM_MESSAGE_LENGTH} characters or less`);
  if (mediaId && !/^[0-9_]+$/.test(mediaId)) throw new Error('Post ID must be a numeric Instagram media ID');
  return { keyword, message, ...(mediaId ? { mediaId } : {}) };
}

export function addAutoDmRule(
  file: AutoDmFile,
  brand: string,
  input: { keyword: string; message: string; mediaId?: string; requireFollow?: boolean; enabled?: boolean },
  now: number,
): { file: AutoDmFile; rule: AutoDmRule } {
  const clean = validateRuleInput(input.keyword, input.message, input.mediaId);
  const iso = new Date(now).toISOString();
  const rule: AutoDmRule = {
    id: randomUUID(),
    brand,
    keyword: clean.keyword,
    message: clean.message,
    ...(clean.mediaId ? { mediaId: clean.mediaId } : {}),
    ...(input.requireFollow === true ? { requireFollow: true } : {}),
    enabled: input.enabled ?? true,
    createdAt: iso,
    updatedAt: iso,
  };
  return { file: { rules: [...file.rules, rule] }, rule };
}

export function updateAutoDmRule(
  file: AutoDmFile,
  id: string,
  patch: { keyword?: unknown; message?: unknown; mediaId?: unknown; requireFollow?: unknown; enabled?: unknown },
  now: number,
): { file: AutoDmFile; rule: AutoDmRule } {
  const existing = file.rules.find((r) => r.id === id);
  if (!existing) throw new Error('Auto-DM rule not found');
  const clean = validateRuleInput(
    patch.keyword !== undefined ? patch.keyword : existing.keyword,
    patch.message !== undefined ? patch.message : existing.message,
    patch.mediaId !== undefined ? patch.mediaId : existing.mediaId,
  );
  const enabled = typeof patch.enabled === 'boolean' ? patch.enabled : existing.enabled;
  const requireFollow = typeof patch.requireFollow === 'boolean' ? patch.requireFollow : existing.requireFollow === true;
  const updated: AutoDmRule = {
    ...existing,
    keyword: clean.keyword,
    message: clean.message,
    enabled,
    updatedAt: new Date(now).toISOString(),
  };
  if (clean.mediaId) updated.mediaId = clean.mediaId;
  else delete updated.mediaId;
  if (requireFollow) updated.requireFollow = true;
  else delete updated.requireFollow;
  return { file: { rules: file.rules.map((r) => (r.id === id ? updated : r)) }, rule: updated };
}

export function deleteAutoDmRule(file: AutoDmFile, id: string): { file: AutoDmFile; removed: boolean } {
  const next = file.rules.filter((r) => r.id !== id);
  return { file: { rules: next }, removed: next.length !== file.rules.length };
}

/** Splits comma-separated keywords into normalized lowercase terms. */
export function keywordsOf(keywordField: string): string[] {
  return keywordField
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

/** Matches a comment text against a rule's keyword(s) (case-insensitive whole-word/phrase boundary match). */
export function keywordMatches(keywordField: string, commentText: string): boolean {
  const text = commentText.toLowerCase();
  for (const term of keywordsOf(keywordField)) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}([^\\p{L}\\p{N}_]|$)`, 'iu');
    if (pattern.test(text)) return true;
  }
  return false;
}

/**
 * Picks the first enabled Auto-DM rule for `brand` that matches `commentText` and optional `mediaId`.
 * Post-specific rules are checked before account-wide rules.
 */
export function matchAutoDmRule(rules: readonly AutoDmRule[], brand: string, commentText: string, mediaId: string | null): AutoDmRule | null {
  const candidates = rules.filter((r) => r.brand === brand && r.enabled);
  const specific = mediaId ? candidates.filter((r) => r.mediaId === mediaId) : [];
  const global = candidates.filter((r) => !r.mediaId);
  for (const rule of [...specific, ...global]) {
    if (keywordMatches(rule.keyword, commentText)) return rule;
  }
  return null;
}

/** Verifies Meta's `X-Hub-Signature-256: sha256=<hex>` header against the raw request body. */
export function verifyMetaSignature(rawBody: Uint8Array | string, signatureHeader: string | null, appSecret: string): boolean {
  if (!signatureHeader || !appSecret) return false;
  const prefix = 'sha256=';
  if (!signatureHeader.startsWith(prefix)) return false;
  const providedHex = signatureHeader.slice(prefix.length).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(providedHex)) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const provided = Buffer.from(providedHex, 'hex');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/** Extracts Instagram comment webhook events from Meta's webhook payload. */
export function parseInstagramCommentEvents(payload: unknown): InstagramCommentEvent[] {
  if (!payload || typeof payload !== 'object') return [];
  const root = payload as Record<string, unknown>;
  if (root['object'] !== 'instagram' || !Array.isArray(root['entry'])) return [];
  const events: InstagramCommentEvent[] = [];
  for (const entry of root['entry']) {
    if (!entry || typeof entry !== 'object') continue;
    const entryObj = entry as Record<string, unknown>;
    const accountId = typeof entryObj['id'] === 'string' ? entryObj['id'] : '';
    const changes = Array.isArray(entryObj['changes']) ? entryObj['changes'] : [];
    for (const change of changes) {
      if (!change || typeof change !== 'object') continue;
      const changeObj = change as Record<string, unknown>;
      if (changeObj['field'] !== 'comments') continue;
      const value = changeObj['value'];
      if (!value || typeof value !== 'object') continue;
      const v = value as Record<string, unknown>;
      const commentId = typeof v['id'] === 'string' ? v['id'] : '';
      const text = typeof v['text'] === 'string' ? v['text'] : '';
      if (!accountId || !commentId || !text) continue;
      const from = v['from'] && typeof v['from'] === 'object' ? (v['from'] as Record<string, unknown>) : null;
      const media = v['media'] && typeof v['media'] === 'object' ? (v['media'] as Record<string, unknown>) : null;
      events.push({
        accountId,
        commentId,
        text,
        fromId: typeof from?.['id'] === 'string' ? from['id'] : null,
        fromUsername: typeof from?.['username'] === 'string' ? from['username'] : null,
        mediaId: typeof media?.['id'] === 'string' ? media['id'] : null,
      });
    }
  }
  return events;
}

/** Extracts Instagram messaging postback / quick-reply events carrying an Auto-DM rule payload. */
export function parseInstagramPostbackEvents(payload: unknown): InstagramPostbackEvent[] {
  if (!payload || typeof payload !== 'object') return [];
  const root = payload as Record<string, unknown>;
  if (root['object'] !== 'instagram' || !Array.isArray(root['entry'])) return [];
  const events: InstagramPostbackEvent[] = [];
  for (const entry of root['entry']) {
    if (!entry || typeof entry !== 'object') continue;
    const entryObj = entry as Record<string, unknown>;
    const accountId = typeof entryObj['id'] === 'string' ? entryObj['id'] : '';
    const messaging = Array.isArray(entryObj['messaging']) ? entryObj['messaging'] : [];
    for (const item of messaging) {
      if (!item || typeof item !== 'object') continue;
      const msgObj = item as Record<string, unknown>;
      const sender = msgObj['sender'] && typeof msgObj['sender'] === 'object' ? (msgObj['sender'] as Record<string, unknown>) : null;
      const senderId = typeof sender?.['id'] === 'string' ? sender['id'] : '';
      if (!accountId || !senderId || senderId === accountId) continue;

      const postback = msgObj['postback'] && typeof msgObj['postback'] === 'object' ? (msgObj['postback'] as Record<string, unknown>) : null;
      const message = msgObj['message'] && typeof msgObj['message'] === 'object' ? (msgObj['message'] as Record<string, unknown>) : null;
      const quickReply =
        message?.['quick_reply'] && typeof message['quick_reply'] === 'object' ? (message['quick_reply'] as Record<string, unknown>) : null;

      const rawPayload =
        typeof postback?.['payload'] === 'string'
          ? postback['payload']
          : typeof quickReply?.['payload'] === 'string'
            ? quickReply['payload']
            : '';
      if (!rawPayload.startsWith(AUTODM_PAYLOAD_PREFIX)) continue;
      events.push({ accountId, senderId, payload: rawPayload });
    }
  }
  return events;
}

export function ruleIdFromPayload(payload: string): string | null {
  return payload.startsWith(AUTODM_PAYLOAD_PREFIX) ? payload.slice(AUTODM_PAYLOAD_PREFIX.length) || null : null;
}

export interface InstagramTextDmEvent {
  accountId: string;
  senderId: string;
  text: string;
}

/** Extracts incoming plain-text DM events (ignoring echoes and messages already carrying an AUTODM quick-reply). */
export function parseInstagramTextDmEvents(payload: unknown): InstagramTextDmEvent[] {
  if (!payload || typeof payload !== 'object') return [];
  const root = payload as Record<string, unknown>;
  if (root['object'] !== 'instagram' || !Array.isArray(root['entry'])) return [];
  const events: InstagramTextDmEvent[] = [];
  for (const entry of root['entry']) {
    if (!entry || typeof entry !== 'object') continue;
    const entryObj = entry as Record<string, unknown>;
    const accountId = typeof entryObj['id'] === 'string' ? entryObj['id'] : '';
    const messaging = Array.isArray(entryObj['messaging']) ? entryObj['messaging'] : [];
    for (const item of messaging) {
      if (!item || typeof item !== 'object') continue;
      const msgObj = item as Record<string, unknown>;
      const sender = msgObj['sender'] && typeof msgObj['sender'] === 'object' ? (msgObj['sender'] as Record<string, unknown>) : null;
      const senderId = typeof sender?.['id'] === 'string' ? sender['id'] : '';
      if (!accountId || !senderId || senderId === accountId) continue;
      const message = msgObj['message'] && typeof msgObj['message'] === 'object' ? (msgObj['message'] as Record<string, unknown>) : null;
      if (!message || message['is_echo'] === true) continue;
      const quickReply =
        message['quick_reply'] && typeof message['quick_reply'] === 'object' ? (message['quick_reply'] as Record<string, unknown>) : null;
      if (typeof quickReply?.['payload'] === 'string' && quickReply['payload'].startsWith(AUTODM_PAYLOAD_PREFIX)) continue;
      const text = typeof message['text'] === 'string' ? message['text'].trim() : '';
      if (!text) continue;
      events.push({ accountId, senderId, text });
    }
  }
  return events;
}

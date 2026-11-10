import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { assertPublishingEnabled } from './publishing-switch.ts';

const REQUEST_TIMEOUT_MS = 60_000;

export class SchedulerApiError extends Error {
  readonly endpoint: string;
  readonly status: number;

  constructor(endpoint: string, status: number, body: string) {
    super(`Scheduler ${endpoint} failed with ${status}: ${body.slice(0, 300)}`);
    this.name = 'SchedulerApiError';
    this.endpoint = endpoint;
    this.status = status;
  }
}

export interface SchedulerChannel {
  id: string;
  identifier: string;
  profile: string;
  disabled: boolean;
}

export interface SchedulerMedia {
  id: string;
  path: string;
}

export interface SchedulePostInput {
  integrationId: string;
  providerIdentifier: string;
  /** ISO 8601 date-time with offset. */
  date: string;
  caption: string;
  image: SchedulerMedia;
}

export interface CreatedPost {
  postId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Scheduler stores post bodies as HTML; one paragraph per line keeps Instagram's line breaks. */
export function captionToHtml(caption: string): string {
  return caption
    .split('\n')
    .map((line) => `<p>${line.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</p>`)
    .join('');
}

export class SchedulerClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  private async request(endpoint: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}/public/v1${endpoint}`, {
      ...init,
      headers: { Authorization: this.apiKey, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) throw new SchedulerApiError(endpoint, response.status, text);
    return text ? (JSON.parse(text) as unknown) : null;
  }

  async listIntegrations(): Promise<SchedulerChannel[]> {
    const data = await this.request('/integrations');
    if (!Array.isArray(data)) throw new SchedulerApiError('/integrations', 200, 'expected an array');
    return data.filter(isRecord).map((i) => ({
      id: String(i['id']),
      identifier: String(i['identifier'] ?? i['providerIdentifier'] ?? ''),
      profile: String(i['profile'] ?? i['name'] ?? ''),
      disabled: i['disabled'] === true,
    }));
  }

  async uploadImage(filePath: string): Promise<SchedulerMedia> {
    // The last line of defence: whatever called this, nothing is sent while publishing is switched off.
    assertPublishingEnabled('the upload to the scheduler');
    const form = new FormData();
    form.append('file', new Blob([await readFile(filePath)], { type: 'image/jpeg' }), basename(filePath));
    const data = await this.request('/upload', { method: 'POST', body: form });
    if (!isRecord(data) || typeof data['id'] !== 'string' || typeof data['path'] !== 'string') {
      throw new SchedulerApiError('/upload', 200, `unexpected response ${JSON.stringify(data)}`);
    }
    return { id: data['id'], path: data['path'] };
  }

  async schedulePost(input: SchedulePostInput): Promise<CreatedPost> {
    assertPublishingEnabled('scheduling the post');
    const body = {
      type: 'schedule',
      shortLink: false,
      date: input.date,
      tags: [],
      posts: [
        {
          integration: { id: input.integrationId },
          value: [{ content: captionToHtml(input.caption), image: [input.image] }],
          settings: { __type: input.providerIdentifier, post_type: 'post', collaborators: [] },
        },
      ],
    };
    const data = await this.request('/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const first: unknown = Array.isArray(data) ? data[0] : data;
    if (!isRecord(first) || typeof first['postId'] !== 'string') {
      throw new SchedulerApiError('/posts', 200, `unexpected response ${JSON.stringify(data)}`);
    }
    return { postId: first['postId'] };
  }
}

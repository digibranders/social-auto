/**
 * Development only: builds a realistic status feed from the real schedule, plus invented history
 * and a second client, so every state and the multi-client views can be seen.
 * MOCK_SCENARIO = ok (default) | missed | down
 */
import { schedule } from '../../publisher/data/schedule.ts';
import { buildStatus, parseSchedule, type MediaItem, type ScheduledPost } from '../../publisher/lib/schedule.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

function invented(now: number): ScheduledPost[] {
  const posts: ScheduledPost[] = [];
  for (let offset = -21; offset <= 6; offset++) {
    const date = new Date(now + offset * DAY_MS);
    date.setUTCHours(5, 30, 0, 0);
    posts.push({
      brand: 'currycook',
      id: `currycook-d${offset}`,
      date: date.toISOString(),
      caption: `Sample post ${offset}\n\nA short example caption for the second client, to check how the calendar looks with several clients at once.\n\n#sample`,
      image: null,
    });
  }
  return posts;
}

export function mockStatus(scenario: string, origin: string, now = Date.now()): Record<string, unknown> {
  const posts = [...parseSchedule(schedule), ...invented(now)];
  const lostId = scenario === 'missed' ? 'currycook-d-3' : null;

  const media: MediaItem[] | null =
    scenario === 'down'
      ? null
      : posts
          .filter((p) => Date.parse(p.date) < now - 15 * 60 * 1000 && p.id !== lostId)
          .map((p) => ({
            id: `ig-${p.id}`,
            caption: p.caption,
            timestamp: p.date,
            permalink: `https://www.instagram.com/p/mock-${p.id}/`,
            mediaUrl: null,
          }));

  const down = scenario === 'down';
  const channels = [
    {
      platform: 'instagram',
      account: down ? null : 'dai23_sy',
      avatar: null,
      brands: ['brandbasket'],
      ok: !down,
      ...(down ? { error: 'InstagramApiError: Error validating access token: The session has been invalidated' } : {}),
    },
    { platform: 'instagram', account: 'currycook_demo', avatar: null, brands: ['currycook'], ok: true },
  ];
  return { generatedAt: new Date(now).toISOString(), channels, ...buildStatus(posts, media, now, origin) };
}

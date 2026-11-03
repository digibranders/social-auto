import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aiConfigFromEnv } from './ai.ts';
import type { Brand } from './content.ts';
import { planWeek } from './planner.ts';

const brand = {
  name: 'Acme Dental', handleUrl: 'acme.com', offer: 'Family dental care in town', audience: 'Families', tone: 'Warm', proofPoints: ['Free first visit for new patients'],
  callToAction: 'Visit acme.com (link in bio)', rules: ['No invented prices'], colors: { background: '#FCFBF9', ink: '#102234', accent: '#E9AF88', tile: '#0C1E2E' }, font: 'Inter', features: [],
} as unknown as Brand;
const ai = aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234' });
const schedule = { startDate: '2026-11-04', time: '10:00', utcOffset: '+05:30', count: 3 };
const TOPICS = ['waiting rooms', 'tooth care', 'check-ups', 'braces'];
const draft = (n: number, over: Record<string, string> = {}) => ({
  painPoint: `A post about ${TOPICS[n - 1]}`, headline: `Thinking about ${TOPICS[n - 1]}?`, subline: 'Acme Dental keeps it simple.', visual: 'A single glowing key on a table.', visualLink: 'the key stands for access',
  caption: `A short note about ${TOPICS[n - 1]}.`, hashtags: ['#acme'], ...over,
});
const PROOF_TEXT: Record<string, string> = { subline: 'Acme Dental offers a free first visit.', caption: 'New patients start with a free first visit.' };
const answer = (posts: object[]): Response => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ posts }) } }] }), { status: 200 });

test('every post of a week gets its pillar from code, the prompt carries the assignments, and the plan records them', async () => {
  const prompts: string[] = [];
  const plan = await planWeek({
    ai, brand, brandSlug: 'acme', weekNumber: 1, schedule, usedPainPoints: [],
    fetchFn: (async (_url: string, init?: RequestInit) => {
      prompts.push(String(init?.body));
      return answer([draft(1, PROOF_TEXT), draft(2, PROOF_TEXT), draft(3, PROOF_TEXT)]);
    }) as typeof fetch,
  });
  assert.deepEqual(plan.posts.map((p) => p.pillar), ['problem', 'education', 'proof']);
  assert.equal(new Set(plan.posts.map((p) => p.pillar)).size, 3);
  assert.match(prompts[0] ?? '', /Post 1 \(problem\)/);
  assert.match(prompts[0] ?? '', /Free first visit for new patients/);
});

test('a proof post that ignores its proof point is sent back to the model once, then accepted when it is built on it', async () => {
  let calls = 0;
  const plan = await planWeek({
    ai, brand, brandSlug: 'acme', weekNumber: 1, schedule: { ...schedule, count: 3 }, usedPainPoints: [], recentPillars: ['problem', 'education'],
    fetchFn: (async () => {
      calls += 1;
      const text: Record<string, string> = calls > 1 ? PROOF_TEXT : {};
      return answer([draft(1, text), draft(2, text), draft(3, text)]);
    }) as typeof fetch,
  });
  assert.equal(calls, 2);
  assert.equal(plan.posts.filter((p) => p.pillar === 'proof').length, 1);
});

test('a brand without proof points gets a week without a proof post', async () => {
  const plan = await planWeek({
    ai, brand: { ...brand, proofPoints: [] }, brandSlug: 'acme', weekNumber: 1, schedule: { ...schedule, count: 4 }, usedPainPoints: [],
    fetchFn: (async () => answer([draft(1), draft(2), draft(3), draft(4)])) as typeof fetch,
  });
  assert.ok(plan.posts.every((p) => p.pillar !== 'proof'));
  assert.equal(plan.posts.length, 4);
});

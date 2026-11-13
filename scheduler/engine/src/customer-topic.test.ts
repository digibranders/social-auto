/**
 * A post written from the customer's own statement goes through the same claim gate as one written from the website: what she wrote is used exactly, and a figure the
 * writer changes is turned back. Fakes only; no model is called.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aiConfigFromEnv } from './ai.ts';
import type { Brand } from './content.ts';
import { factsOfStatement } from './customer-facts.ts';
import { InsufficientConceptsError, planWeek } from './planner.ts';

const brand = {
  name: 'Curry Cook', handleUrl: 'currycook.com', offer: 'SECRET-OFFER-TEXT', audience: 'Diners', tone: 'Warm and plain', proofPoints: ['SECRET-PROOF-POINT'],
  callToAction: 'Order at currycook.com', rules: [], colors: { background: '#FFF8E7', ink: '#5A0F1E', accent: '#F4B400', tile: '#EEEEEE' }, font: 'Inter', features: [],
  identity: { line: 'Home-style curries', kind: 'homepage', type: 'descriptive', source: null, verification: { status: 'verified', reasons: [] } },
} as unknown as Brand;
const ai = aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234' });
const schedule = { startDate: '2026-11-20', time: '10:00', utcOffset: '+05:30', count: 1 };
const STATEMENT = 'Diwali special: 20% off all thalis until 2 Nov.';
const facts = factsOfStatement({ id: 't-1', text: STATEMENT, by: 'user_42', at: '2026-11-13T05:00:00.000Z' });

/** A pretend model that writes the one post with the given headline, subline and caption. */
function model(copy: { headline: string; subline: string; caption: string }) {
  const prompts: string[] = [];
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    const body = String(init?.body);
    prompts.push(body);
    // The first post is assigned a hook; a question hook must end in a question mark.
    const hook = /Post 1 \((\w+), (\w+)\)/.exec(body)?.[2];
    const headline = hook === 'question' && !copy.headline.endsWith('?') ? `${copy.headline}?` : copy.headline;
    const moveId = /Creative move for this post's picture idea.*?(direct_demonstration|input_output|evidence_hero|mapped_metaphor):/s.exec(body)?.[1];
    const moved = moveId ? { moveId, visualRelationship: 'the picture shows the thali as the offer states it', relationshipExplanation: 'each part of the picture matches a part of the offer' } : {};
    const post = {
      concept: { ...moved, subject: 'thalis', angle: 'the Diwali offer', message: 'thalis are cheaper for Diwali', visualSubject: 'a thali', visualAction: 'steaming', visualComposition: 'overhead' },
      painPoint: 'A festive offer', ...copy, headline, visual: 'A thali on a table.', visualLink: 'the thali is the offer', hashtags: ['#currycook'],
    };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ posts: [post] }) } }] }), { status: 200 });
  }) as typeof fetch;
  return { fetchFn, prompts };
}

const write = (m: ReturnType<typeof model>) => planWeek({ ai, brand, brandSlug: 'curry', weekNumber: 1, schedule, usedPainPoints: [], fetchFn: m.fetchFn, evidence: { facts, recentFactIds: [] } });

test('the writer is given only her own words, and a post that states them as she wrote them is kept with her statement as its source', async () => {
  const m = model({ headline: 'Diwali thalis, 20% off', subline: 'Curry Cook, until 2 Nov.', caption: 'Celebrate Diwali with 20% off all thalis until 2 Nov.' });
  const plan = await write(m);
  assert.equal(plan.posts.length, 1);
  const prompt = m.prompts[0] ?? '';
  assert.match(prompt, /20% off all thalis until 2 Nov/);
  for (const secret of ['SECRET-OFFER-TEXT', 'SECRET-PROOF-POINT']) assert.ok(!prompt.includes(secret), `${secret} is not shown to the writer`);
  assert.deepEqual(plan.posts[0]?.factIds, facts.map((f) => f.id).filter((id) => plan.posts[0]?.factIds?.includes(id)));
  assert.ok((plan.posts[0]?.factIds ?? []).length >= 1);
});

test('a figure the writer changes is turned back, never published: 30% instead of her 20%, or a date she did not write', async () => {
  for (const copy of [
    { headline: 'Diwali thalis, 30% off', subline: 'Curry Cook, until 2 Nov.', caption: 'Celebrate Diwali with 30% off all thalis until 2 Nov.' },
    { headline: 'Diwali thalis, 20% off', subline: 'Curry Cook, until 9 Nov.', caption: 'Celebrate Diwali with 20% off all thalis until 9 Nov.' },
    { headline: 'Diwali thalis, 20% off', subline: 'Curry Cook, free delivery.', caption: 'Celebrate Diwali with 20% off all thalis and free delivery for 50 orders.' },
  ]) {
    await assert.rejects(write(model(copy)), (error: Error) => error instanceof InsufficientConceptsError, JSON.stringify(copy));
  }
});

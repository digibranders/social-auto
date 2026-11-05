import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aiConfigFromEnv } from './ai.ts';
import type { Brand } from './content.ts';
import type { Concept, ConceptRecord } from './concepts.ts';
import { conceptRecordOf, InsufficientConceptsError, planWeek } from './planner.ts';

const brand = {
  name: 'Acme Dental', handleUrl: 'acme.com', offer: 'Family dental care in town', audience: 'Families', tone: 'Warm', proofPoints: ['Free first visit for new patients'],
  callToAction: 'Visit acme.com (link in bio)', rules: ['No invented prices'], colors: { background: '#FCFBF9', ink: '#102234', accent: '#E9AF88', tile: '#0C1E2E' }, font: 'Inter', features: [],
  identity: { line: 'Family dental care for the whole town', kind: 'homepage', type: 'descriptive', source: null, verification: { status: 'verified', reasons: [] } },
} as unknown as Brand;
const ai = aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234' });
const schedule = { startDate: '2026-11-04', time: '10:00', utcOffset: '+05:30', count: 3 };
const TOPICS = ['waiting rooms', 'tooth care', 'check-ups', 'braces', 'cleaning', 'sensitive teeth', 'new patients'];
const PROOF_TEXT = { subline: 'Acme Dental offers a free first visit.', caption: 'New patients start with a free first visit.' };

interface Behaviour {
  /** Write every headline as a question whatever hook was assigned. */
  ignoreHooks?: boolean;
  /** Build proof and education posts on their proof point. */
  anchored?: boolean;
  /** Replaces the concept of a post: given the slot and which call this is (1-based); undefined leaves the concept out. */
  concept?: (slot: number, call: number, own: Concept) => Concept | undefined;
}

/** A pretend model: reads "Post N (pillar, hook)" from the prompt and writes a draft that follows it (or ignores it). */
const COMPOSITIONS = ['close-up', 'overhead', 'wide', 'macro', 'low angle', 'side view', 'top down'];
const ownConcept = (i: number): Concept => {
  const topic = TOPICS[i % TOPICS.length] as string;
  return { subject: topic, angle: `how people feel about ${topic}`, message: `a calm note about ${topic}`, visualSubject: `${topic} object`, visualAction: `slowly ${['opening', 'turning', 'rising', 'folding', 'glowing', 'sliding', 'tilting'][i % 7]}`, visualComposition: COMPOSITIONS[i % COMPOSITIONS.length] as string };
};

function model(behaviour: Behaviour = {}) {
  const prompts: string[] = [];
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    const body = String(init?.body);
    prompts.push(body);
    const call = prompts.length;
    const slots = [...body.matchAll(/Post (\d+) \((\w+), (\w+)\)/g)].map((m) => ({ pillar: m[2] as string, hook: m[3] as string }));
    const posts = slots.map(({ pillar, hook }, i) => {
      const topic = TOPICS[i % TOPICS.length] as string;
      const asked = behaviour.ignoreHooks ? 'question' : hook;
      const headline = asked === 'question' ? `Thinking about ${topic}?` : asked === 'numbered_list' ? `3 things about ${topic}` : `Notes on ${topic}`;
      const anchored = (behaviour.anchored ?? true) && (pillar === 'proof' || pillar === 'education');
      const concept = behaviour.concept ? behaviour.concept(i, call, ownConcept(i)) : ownConcept(i);
      return {
        ...(concept ? { concept } : {}),
        painPoint: `A post about ${topic}`, headline, subline: 'Acme Dental keeps it simple.', visual: 'A single glowing key on a table.', visualLink: 'the key stands for access',
        caption: `A short note about ${topic}.`, hashtags: ['#acme'], ...(anchored ? PROOF_TEXT : {}),
        ...(asked === 'numbered_list' && !behaviour.ignoreHooks ? { listItems: ['Ask us anything', 'Plan one small step', 'Share what you learn'] } : {}),
      };
    });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ posts }) } }] }), { status: 200 });
  }) as typeof fetch;
  return { fetchFn, prompts };
}

const plan = (count: number, over: Partial<Parameters<typeof planWeek>[0]> = {}, behaviour: Behaviour = {}) => {
  const m = model(behaviour);
  return planWeek({ ai, brand, brandSlug: 'acme', weekNumber: 1, schedule: { ...schedule, count }, usedPainPoints: [], fetchFn: m.fetchFn, ...over }).then((result) => ({ result, prompts: m.prompts }));
};

test('every post of a week gets its pillar and hook from code, the prompt carries the assignments, and the plan records them', async () => {
  const { result, prompts } = await plan(3);
  assert.deepEqual(result.posts.map((p) => p.pillar), ['problem', 'education', 'proof']);
  assert.ok(result.posts.every((p) => typeof p.hook === 'string'));
  assert.match(prompts[0] ?? '', /Post 1 \(problem, \w+\)/);
  assert.match(prompts[0] ?? '', /Free first visit for new patients/);
  assert.match(prompts[0] ?? '', /Headline hook:/);
});

test('a seven-post week uses several hooks, never the same twice in a row, with one model call and nothing else', async () => {
  const { result, prompts } = await plan(7);
  const hooks = result.posts.map((p) => p.hook as string);
  assert.ok(new Set(hooks).size >= 3, hooks.join(','));
  for (let i = 1; i < hooks.length; i++) assert.notEqual(hooks[i], hooks[i - 1]);
  assert.equal(prompts.length, 1);
  assert.ok(result.posts.every((p) => p.requestedHook === undefined));
});

test('a numbered-list post keeps its promise: the items are in the caption and recorded', async () => {
  const { result } = await plan(7);
  const listed = result.posts.find((p) => p.hook === 'numbered_list');
  assert.ok(listed, 'a week of seven includes a numbered list');
  assert.deepEqual(listed.listItems, ['Ask us anything', 'Plan one small step', 'Share what you learn']);
  assert.match(listed.caption, /\n\n1\. Ask us anything\n2\. Plan one small step\n3\. Share what you learn$/);
});

test('a proof or education post that ignores its proof point is sent back to the model, then accepted when it is built on it', async () => {
  let calls = 0;
  const first = model({ anchored: false });
  const second = model({ anchored: true });
  const result = await planWeek({
    ai, brand, brandSlug: 'acme', weekNumber: 1, schedule, usedPainPoints: [], recentPillars: ['problem', 'education'],
    fetchFn: (async (url: string, init?: RequestInit) => (++calls === 1 ? first : second).fetchFn(url, init)) as typeof fetch,
  });
  assert.equal(calls, 2);
  assert.equal(result.posts.length, 3);
});

test('a brand without proof points gets a week without proof or education posts', async () => {
  const { result } = await plan(4, { brand: { ...brand, proofPoints: [] } });
  assert.ok(result.posts.every((p) => p.pillar !== 'proof' && p.pillar !== 'education'));
  assert.equal(result.posts.length, 4);
});

test('headlines that ignore their hook are sent back once, then replaced by a complete safe line, with the requested hook kept apart from the real one', async () => {
  const { result, prompts } = await plan(7, {}, { ignoreHooks: true });
  assert.equal(prompts.length, 2);
  const replaced = result.posts.filter((p) => p.requestedHook !== undefined);
  assert.ok(replaced.length > 0);
  for (const post of replaced) {
    assert.equal(post.hook, 'direct_statement');
    assert.notEqual(post.requestedHook, 'direct_statement');
    const safe = ['Free first visit for new patients', 'Family dental care for the whole town'];
    assert.ok(safe.includes(post.headline), post.headline);
    // A post built on a proof point may only fall back to that whole proof point, never to a generic line.
    if (post.pillar === 'proof' || post.pillar === 'education') assert.equal(post.headline, 'Free first visit for new patients');
  }
  // A post that was assigned "direct_statement" and got the safe line has nothing to report apart; the others kept the question that was valid.
  for (const post of result.posts.filter((p) => p.requestedHook === undefined)) {
    assert.ok(post.hook === 'question' || post.hook === 'direct_statement', post.hook);
    if (post.hook === 'question') assert.match(post.headline, /\?$/);
  }
});

test('when no safe complete line exists the plan fails before any picture is made', async () => {
  const bare = { ...brand, proofPoints: [], identity: { ...(brand.identity as object), kind: 'name-only', line: 'Acme Dental' } } as unknown as Brand;
  await assert.rejects(plan(4, { brand: bare }, { ignoreHooks: true }), /question|statement|hook/i);
});

test('repetition with recent headlines is a recorded warning, not a retry', async () => {
  const { result, prompts } = await plan(3, { recentHeadlines: ['Thinking about waiting rooms?', 'Notes on waiting rooms'] });
  assert.equal(prompts.length, 1);
  const warned = result.posts.flatMap((p) => p.hookWarnings ?? []);
  assert.ok(warned.some((w) => w.startsWith('opening:')), warned.join('|'));
});

// ---- 1.4: repeated ideas are caught before any picture is made
/** A concept no slot of the pretend model ever writes, so a draft can repeat it on purpose. */
const oldConcept = (k: number): Concept => ({ subject: `legacy subject ${k}`, angle: `legacy angle ${k}`, message: `legacy message ${k}`, visualSubject: `legacy thing ${k}`, visualAction: `legacy action ${k}`, visualComposition: `legacy frame ${k}` });
const sevenWeek = (behaviour: Behaviour, over: Partial<Parameters<typeof planWeek>[0]> = {}) => plan(7, over, behaviour);
const historyOf = (...indexes: number[]): ConceptRecord[] =>
  indexes.map((i) => ({ id: `old-${i}`, date: '2026-09-01T10:00:00+05:30', concept: oldConcept(i), headline: `old headline ${i}`, pillar: 'education', hook: 'direct_statement', format: 'illustration' }));

test('every accepted post keeps its concept, anchor and a history record, and the prompt shows recent concepts', async () => {
  const { result, prompts } = await sevenWeek({}, { recentConcepts: historyOf(1, 2).map((r, i) => ({ ...r, concept: { ...r.concept, subject: `earlier topic ${'ab'[i]}`, angle: `earlier angle ${'cd'[i]}`, message: `earlier message ${'ef'[i]}`, visualSubject: `earlier thing ${'gh'[i]}`, visualAction: `earlier act ${'ij'[i]}`, visualComposition: `earlier frame ${'kl'[i]}` } })) });
  assert.ok(result.posts.every((p) => p.concept !== undefined));
  assert.match(prompts[0] ?? '', /Avoid repeating these recent creative angles and pictures/);
  assert.match(prompts[0] ?? '', /earlier topic a/);
  const records = result.posts.map((p) => conceptRecordOf(p) as ConceptRecord);
  assert.equal(records.length, 7);
  assert.deepEqual(records.map((r) => r.id), result.posts.map((p) => p.id));
  assert.ok(result.posts.some((p) => p.anchor === 'Free first visit for new patients'));
});

test('a draft that repeats the history is sent back, and accepted once the model writes a new idea; no picture is involved', async () => {
  const { result, prompts } = await sevenWeek({ concept: (slot, call, own) => (slot === 0 && call === 1 ? oldConcept(3) : own) }, { recentConcepts: historyOf(3) });
  assert.equal(prompts.length, 2);
  assert.equal(result.posts.length, 7);
  assert.equal(result.insufficientConcepts, undefined);
});

test('a repeated picture idea alone asks only for a new picture', async () => {
  const { result } = await sevenWeek({ concept: (slot, call, own) => (slot === 0 && call === 1 ? { ...own, subject: 'brand new subject', angle: 'brand new angle', message: 'brand new message', visualSubject: oldConcept(3).visualSubject, visualAction: oldConcept(3).visualAction, visualComposition: oldConcept(3).visualComposition } : own) }, { recentConcepts: historyOf(3) });
  assert.equal(result.posts.length, 7);
});

test('a duplicate inside the same plan is caught like a duplicate of history', async () => {
  const { prompts } = await sevenWeek({ concept: (slot, call, own) => (slot === 1 && call === 1 ? ownConcept(0) : own) });
  assert.equal(prompts.length, 2);
});

test('a draft that still repeats after the last try is left out: a narrow brand gets fewer posts, never a repeat, and the plan says why', async () => {
  const { result, prompts } = await sevenWeek({ concept: (slot, _call, own) => (slot < 2 ? oldConcept(5) : own) }, { recentConcepts: historyOf(5) });
  assert.equal(prompts.length, 2);
  assert.equal(result.posts.length, 5);
  assert.equal(result.insufficientConcepts?.requested, 7);
  assert.equal(result.insufficientConcepts?.produced, 5);
  assert.equal(result.insufficientConcepts?.reasons.length, 2);
  assert.ok(result.posts.every((p) => p.concept?.subject !== 'legacy subject 5'));
});

test('when no draft is a new idea the plan fails with a clear status before any picture', async () => {
  await assert.rejects(sevenWeek({ concept: () => oldConcept(5) }, { recentConcepts: historyOf(5) }), (error: Error) => error instanceof InsufficientConceptsError && /insufficient_distinct_concepts/.test(error.message));
  await assert.rejects(plan(2, { recentConcepts: historyOf(0, 1) }, { concept: (slot) => oldConcept(slot) }), /insufficient_distinct_concepts/);
});

test('a missing or malformed concept is sent back, never skipped', async () => {
  const { result, prompts } = await sevenWeek({ concept: (slot, call, own) => (slot === 2 && call === 1 ? undefined : own) });
  assert.equal(prompts.length, 2);
  assert.equal(result.posts.length, 7);
  await assert.rejects(sevenWeek({ concept: (slot, _call, own) => (slot === 2 ? undefined : own) }), /concept/);
});

test('a one-product brand can reuse its subject across a week when the angles, messages and pictures differ', async () => {
  const { result } = await sevenWeek({ concept: (slot, _call, own) => ({ ...own, subject: 'the planner', angle: `use case ${'abcdefg'[slot]}${slot}`, message: `message number ${slot} ${['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf'][slot]}` }) });
  assert.equal(result.posts.length, 7);
  assert.equal(result.insufficientConcepts, undefined);
});

test('older posts without a concept are simply not compared', () => {
  assert.equal(conceptRecordOf({ id: 'x', date: '2026-01-01T00:00:00Z', painPoint: 'p', mode: 'template', headline: 'h', subline: 's', caption: 'c', hashtags: [] }), undefined);
});

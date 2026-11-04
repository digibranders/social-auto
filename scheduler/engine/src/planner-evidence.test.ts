import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aiConfigFromEnv } from './ai.ts';
import type { Brand } from './content.ts';
import type { Concept } from './concepts.ts';
import { buildEvidence, displayFact, type EvidenceFact } from './evidence.ts';
import type { PageBlock, PageStructure } from './evidence-extract.ts';
import { assignFacts, offerableFacts, rankFacts } from './fact-assignment.ts';
import { InsufficientConceptsError, planWeek, profileForPrompt } from './planner.ts';

const NOW = new Date('2026-11-04T00:00:00Z');
const block = (over: Partial<PageBlock>): PageBlock => ({ id: 'b', text: '', tag: 'p', region: 'prose', isHeading: false, headingText: '', chrome: '', cardId: '', cardGroup: '', cardTitle: '', rowLabel: '', colLabel: '', tableHeader: false, demo: false, strip: false, lang: 'en', ...over });
const structure = (url: string, blocks: Array<Partial<PageBlock>>): PageStructure => ({ url, title: '', lang: 'en', truncated: false, unstyled: false, variantSwitch: false, htmlHash: '', blocks: blocks.map((b, i) => block({ id: `b${i}`, ...b })) });

const SETUP = 'Installation takes under 10 minutes and uses one script tag.';
const TRIAL = '14-day free trial on every paid plan.';
const FLOW = 'When a visitor asks for a human, the chat moves to an operator in the same thread.';
const SOURCES = 'Crawl your website or upload PDF, DOCX, TXT and Markdown files.';
const facts = (): EvidenceFact[] => buildEvidence([
  structure('https://acme.example/features', [{ text: SETUP }, { text: FLOW }, { text: SOURCES }]),
  structure('https://acme.example/pricing', [{ text: TRIAL }, { text: 'Our uptime target is 99.9% every month.' }, { text: 'Free', cardId: 'c0', cardGroup: 'g', cardTitle: 'Free' }, { text: '₹599 /mo', cardId: 'c1', cardGroup: 'g', cardTitle: 'Starter' }]),
], NOW).facts;

const brand = {
  name: 'Acme Replies', handleUrl: 'acme.example', offer: 'SECRET-OFFER-TEXT free plan with 100 credits', audience: 'Small websites', tone: 'Warm and plain', proofPoints: ['SECRET-PROOF-POINT one script tag'],
  callToAction: 'Try it at acme.example', rules: ['SECRET-RULE keep the GST note with pricing'], colors: { background: '#FCFBF9', ink: '#102234', accent: '#E9AF88', tile: '#0C1E2E' }, font: 'Inter', features: [],
  identity: { line: 'A support chatbot for small websites', kind: 'homepage', type: 'descriptive', source: null, verification: { status: 'verified', reasons: [] } },
} as unknown as Brand;
const ai = aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234' });
const schedule = { startDate: '2026-11-04', time: '10:00', utcOffset: '+05:30', count: 3 };
const TOPICS = ['reply times', 'handing off', 'sources', 'setup', 'pricing', 'trials', 'tone'];
const concept = (i: number): Concept => ({ subject: TOPICS[i % 7] as string, angle: `how people see ${TOPICS[i % 7]}`, message: `a calm note on ${TOPICS[i % 7]}`, visualSubject: `${TOPICS[i % 7]} object`, visualAction: ['opening', 'turning', 'rising', 'folding', 'glowing', 'sliding', 'tilting'][i % 7] as string, visualComposition: ['close-up', 'overhead', 'wide', 'macro', 'low angle', 'side view', 'top down'][i % 7] as string });

/** A pretend model. `copy` decides the subline and caption of each post from its slot; the rest follows the assignment. */
function model(copy: (slot: number, prompt: string, headline: string) => { subline: string; caption: string } = () => ({ subline: 'Acme Replies keeps it simple.', caption: 'A short note.' })) {
  const prompts: string[] = [];
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    const body = String(init?.body);
    prompts.push(body);
    const slots = [...body.matchAll(/Post (\d+) \((\w+), (\w+)\)/g)];
    const segments = body.split(/Post \d+ \(/).slice(1);
    const posts = slots.map((m, i) => {
      const hook = m[3] as string;
      const anchor = /Build it on this proof point: \\"(.*?)\\"\./.exec(segments[i] ?? '')?.[1];
      
      const headline = hook === 'question' ? `Thinking about ${TOPICS[i]}?` : hook === 'numbered_list' ? `3 things about ${TOPICS[i]}` : `Notes on ${TOPICS[i]}`;
      const written = copy(i, body, headline);
      return { concept: concept(i), painPoint: `A post about ${TOPICS[i]}`, headline, ...written, ...(anchor ? { caption: `${written.caption} ${anchor}` } : {}), visual: 'A single glowing key on a table.', visualLink: 'the key stands for access', hashtags: ['#acme'],
        ...(hook === 'numbered_list' ? { listItems: ['Ask us anything', 'Plan one small step', 'Share what you learn'] } : {}) };
    });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ posts }) } }] }), { status: 200 });
  }) as typeof fetch;
  return { fetchFn, prompts };
}

const run = (m: ReturnType<typeof model>, evidence?: Parameters<typeof planWeek>[0]['evidence'], count = 3) =>
  planWeek({ ai, brand, brandSlug: 'acme', weekNumber: 1, schedule: { ...schedule, count }, usedPainPoints: [], fetchFn: m.fetchFn, ...(evidence ? { evidence } : {}) });

test('with usable facts the writer never sees the free-text offer, rules or proof points; it sees each post\'s own facts', async () => {
  const m = model();
  const plan = await run(m, { facts: facts() });
  const prompt = m.prompts[0] ?? '';
  for (const secret of ['SECRET-OFFER-TEXT', 'SECRET-RULE', 'SECRET-PROOF-POINT']) assert.ok(!prompt.includes(secret), secret);
  assert.match(prompt, /Facts you may use for this post/);
  assert.match(prompt, /one script tag/);
  assert.ok(!prompt.includes('uptime target'), 'a fact held for review is never offered');
  assert.equal(plan.evidenceCoverage, 'facts');
  assert.ok(plan.posts.every((p) => (p.factIds?.length ?? 0) >= 1 && p.evidenceChecks?.includes('semantic_support_unverified') && p.evidenceChecks.includes('numbers_prices_periods_qualifiers_checked')));
});

test('legacy brands behave as before and are labelled legacy coverage', async () => {
  const m = model();
  const plan = await run(m);
  assert.match(m.prompts[0] ?? '', /SECRET-OFFER-TEXT/);
  assert.match(m.prompts[0] ?? '', /SECRET-PROOF-POINT/);
  assert.equal(plan.evidenceCoverage, 'legacy');
  assert.ok(plan.posts.every((p) => p.factIds === undefined));
  const onlyHeld = facts().map((f) => ({ ...f, status: 'needs_review' as const }));
  const m2 = model();
  assert.equal((await run(m2, { facts: onlyHeld })).evidenceCoverage, 'legacy');
  assert.ok(!(m2.prompts[0] ?? '').includes('uptime target'));
});

test('profile text that states a figure reaches the writer only when no facts are in use', () => {
  const withFigures = { ...brand, audience: '1,000 small websites', tone: 'Warm' } as Brand;
  assert.equal(profileForPrompt(withFigures, true)['audience'], undefined);
  assert.equal(profileForPrompt(withFigures, true)['tone'], 'Warm');
  assert.equal(profileForPrompt(withFigures, true)['offer'], undefined);
  assert.equal(profileForPrompt(withFigures, false)['audience'], '1,000 small websites');
  assert.equal(profileForPrompt(withFigures, false)['offer'], brand.offer);
});

test('a figure that no assigned fact of that post states is turned back and, on the last try, the post is dropped', async () => {
  await assert.rejects(run(model(() => ({ subline: 'Acme Replies is live in 5 minutes.', caption: 'Go live fast.' })), { facts: facts() }, 1), InsufficientConceptsError);
});

test('a post may use a figure its own fact states; the same figure in a post assigned other facts is refused', async () => {
  const all = facts();
  const setupFact = all.find((f) => f.text === SETUP) as EvidenceFact;
  const others = all.filter((f) => f.id !== setupFact.id);
  // Only the setup fact is offered: a post can say "under 10 minutes".
  const ok = await run(model(() => ({ subline: 'Acme Replies installs in under 10 minutes.', caption: 'Setup takes under 10 minutes with one script tag.' })), { facts: [setupFact] }, 1);
  assert.equal(ok.posts.length, 1);
  assert.deepEqual(ok.posts[0]?.factIds, [setupFact.id]);
  // Only other facts are offered: the same sentence states a figure none of them has.
  await assert.rejects(run(model(() => ({ subline: 'Acme Replies installs in under 10 minutes.', caption: 'Setup takes under 10 minutes.' })), { facts: others.filter((f) => !/\d/.test(f.text)) }, 1), InsufficientConceptsError);
});

test('facts used recently are offered later, not banned', async () => {
  const all = facts();
  const first = rankFacts(offerableFacts(all), [])[0] as EvidenceFact;
  const recent = rankFacts(offerableFacts(all), [first.id])[0] as EvidenceFact;
  assert.notEqual(first.id, recent.id);
  const ranked = rankFacts(offerableFacts(all), [first.id]);
  assert.equal(ranked.at(-1)?.id, first.id);
  assert.equal(ranked.length, offerableFacts(all).length);
  const only = [first];
  assert.deepEqual(assignFacts({ facts: only, anchors: [undefined, undefined], recentFactIds: [first.id] }).map((a) => a.map((f) => f.id)), [[first.id], [first.id]]);
});

test('fact assignment: usable brand claims only, one fact per wording, a second fact from another category, no repeats within a week while facts last', () => {
  const all = facts();
  const offered = offerableFacts(all);
  assert.ok(offered.every((f) => f.status === 'usable' && f.intent === 'claim'));
  assert.ok(!offered.some((f) => f.text.includes('uptime target')));
  assert.equal(offerableFacts([...all, ...all]).length, offered.length);
  const perPost = assignFacts({ facts: offered, anchors: [undefined, undefined, undefined], recentFactIds: [] });
  assert.ok(perPost.every((p) => p.length >= 1 && p.length <= 2));
  assert.ok(perPost.every((p) => p.length === 1 || p[0]?.category !== p[1]?.category));
  const firsts = perPost.map((p) => p[0]?.id);
  assert.equal(new Set(firsts).size, firsts.length);
  const anchor = offered[2] as EvidenceFact;
  assert.equal(assignFacts({ facts: offered, anchors: [anchor], recentFactIds: [] })[0]?.[0]?.id, anchor.id);
  assert.equal(displayFact(anchor), anchor.scope ? `${anchor.scope}: ${anchor.text}` : anchor.text);
});

test('editorial: a subline that repeats the headline goes back to the writer once, and the retry is used', async () => {
  let calls = 0;
  const m = model((slot, _prompt, headline) => {
    const bad = calls === 0;
    if (slot === 0) calls += 1;
    return bad ? { subline: `Acme Replies: ${headline}`, caption: 'A short note.' } : { subline: 'Acme Replies keeps it simple.', caption: 'A short note.' };
  });
  const plan = await run(m, undefined, 1);
  assert.equal(m.prompts.length, 2);
  assert.match(m.prompts[1] ?? '', /says the headline again/);
  assert.equal(plan.posts[0]?.subline, 'Acme Replies keeps it simple.');
  assert.ok(!(plan.posts[0]?.hookWarnings ?? []).some((w) => /editorial/.test(w)));
});

test('editorial: a subline that is exactly the headline after the second try leaves the post out', async () => {
  await assert.rejects(run(model((_slot, _prompt, headline) => ({ subline: `Acme Replies: ${headline}`, caption: 'A short note.' })), undefined, 1), InsufficientConceptsError);
});

test('editorial: a near-identical subline that survives the second try stays with the reason noted for the reviewer', async () => {
  const plan = await run(model((_slot, _prompt, headline) => ({ subline: `Acme Replies: ${headline} the`, caption: 'A short note.' })), undefined, 1);
  assert.equal(plan.posts.length, 1);
  assert.ok(plan.posts[0]?.hookWarnings?.includes('editorial: subline_adds_nothing'));
});

test('editorial: a subline that shares words with the headline but adds a fact is not touched', async () => {
  const m = model(() => ({ subline: 'Acme Replies: notes on reply times, 2 clicks.', caption: 'A short note.' }));
  const plan = await run(m, undefined, 1).catch((e: Error) => e);
  // A figure no profile proof point states is turned back by the claim gate, not by the editorial check.
  assert.ok(plan instanceof Error);
  assert.match((plan as Error).message, /2/);
  assert.ok(!/editorial|says the headline again/.test((plan as Error).message));
});

import { memoryCache, type Judge } from './semantic-verifier.ts';
import { modelJudge } from './semantic-judge.ts';

test('copy judge: a post found stronger than its facts is left out, an undecided one stays with a note, a supported one is marked model-judged', async () => {
  const all = facts();
  const requests: string[] = [];
  const judge: Judge = async (items) => { requests.push(String(items.length)); return items.map((i, n) => ({ key: i.key, answer: (['supported', 'unsupported', 'unclear'] as const)[n % 3] as 'supported' | 'unsupported' | 'unclear' })); };
  const plan = await planWeek({ ai, brand, brandSlug: 'acme', weekNumber: 1, schedule: { ...schedule, count: 3 }, usedPainPoints: [], fetchFn: model().fetchFn, evidence: { facts: all }, copyJudge: { judge, cache: memoryCache() } });
  assert.deepEqual(requests, ['3']);
  assert.equal(plan.posts.length, 2);
  assert.equal(plan.insufficientConcepts?.produced, 2);
  assert.ok(plan.posts[0]?.evidenceChecks?.includes('semantic_support_model_judged'));
  assert.ok(!plan.posts[0]?.evidenceChecks?.includes('semantic_support_unverified'));
  assert.ok(plan.posts[1]?.evidenceChecks?.includes('semantic_support_unverified'));
  assert.ok(plan.posts[1]?.hookWarnings?.some((w) => /evidence:/.test(w)));
});

test('copy judge: ignored without evidence facts', async () => {
  let called = false;
  const judge: Judge = async () => { called = true; return []; };
  const plan = await planWeek({ ai, brand, brandSlug: 'acme', weekNumber: 1, schedule: { ...schedule, count: 3 }, usedPainPoints: [], fetchFn: model().fetchFn, copyJudge: { judge } });
  assert.equal(called, false);
  assert.equal(plan.evidenceCoverage, 'legacy');
});

test('the model judge sends one request for the batch, with source and copy, and reads the verdicts', async () => {
  const bodies: string[] = [];
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ verdicts: [{ key: 'k1', answer: 'unsupported' }, { key: 'k2', answer: 'supported' }, { key: 'k3', answer: 'bogus' }] }) } }] }), { status: 200 });
  }) as typeof fetch;
  const verdicts = await modelJudge(ai, fetchFn)([{ key: 'k1', claim: 'Automatically resolves everything', quote: 'The chatbot can suggest responses.', context: 'Features' }, { key: 'k2', claim: 'c2', quote: 'q2', context: '' }, { key: 'k3', claim: 'c3', quote: 'q3', context: '' }]);
  assert.equal(bodies.length, 1);
  assert.match(bodies[0] ?? '', /can suggest responses/);
  assert.deepEqual(verdicts, [{ key: 'k1', answer: 'unsupported' }, { key: 'k2', answer: 'supported' }]);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aiConfigFromEnv } from './ai.ts';
import type { Brand } from './content.ts';
import type { Concept } from './concepts.ts';
import { buildEvidence, displayFact, type EvidenceFact } from './evidence.ts';
import type { PageBlock, PageStructure } from './evidence-extract.ts';
import { assignFacts, offerableFacts, rankFacts } from './fact-assignment.ts';
import { InsufficientConceptsError, planWeek, profileForPrompt } from './planner.ts';
import { materialSentences } from './claim-verdict.ts';

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
      const moveId = /Creative move for this post's picture idea.*?(direct_demonstration|input_output|evidence_hero|mapped_metaphor):/s.exec(segments[i] ?? '')?.[1];
      const moved = moveId ? { moveId, visualRelationship: `the picture shows ${TOPICS[i]} as its fact states it`, relationshipExplanation: 'each part of the picture matches a part of the fact' } : {};
      return { concept: { ...concept(i), ...moved }, painPoint: `A post about ${TOPICS[i]}`, headline, ...written, ...(anchor ? { caption: `${written.caption} ${anchor}` } : {}), visual: 'A single glowing key on a table.', visualLink: 'the key stands for access', hashtags: ['#acme'],
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

test('unverified profile text (audience, offer, rules, proof points, a tone with figures) reaches the writer only when no facts are in use', () => {
  const withFigures = { ...brand, audience: '1,000 small websites', tone: 'Warm' } as Brand;
  assert.equal(profileForPrompt(withFigures, true)['audience'], undefined);
  assert.equal(profileForPrompt({ ...withFigures, audience: 'Small websites' } as Brand, true)['audience'], undefined);
  assert.equal(profileForPrompt(withFigures, true)['tone'], 'Warm');
  assert.equal(profileForPrompt({ ...withFigures, tone: 'Warm, 24/7' } as Brand, true)['tone'], undefined);
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
  const ok = await run(model(() => ({ subline: 'Acme Replies installs in under 10 minutes.', caption: 'Quick to start.' })), { facts: [setupFact] }, 1);
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
  assert.ok(perPost.every((p) => p.length === 1 || (p[0]?.source.url === p[1]?.source.url && (p[0]?.scope === p[1]?.scope || p[0]?.source.heading === p[1]?.source.heading))));
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

test('editorial: a subline that says the headline in nearly the same words, with nothing new supported, leaves the post out after the second try', async () => {
  await assert.rejects(run(model((_slot, _prompt, headline) => ({ subline: `Acme Replies: ${headline} the`, caption: 'A short note.' })), undefined, 1), InsufficientConceptsError);
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

import { withoutCta } from './planner.ts';

test('the brand\'s own call to action is not shown to the copy judge as a claim', () => {
  assert.equal(withoutCta('A note about replies.\n\nSee pricing at oyechats.com (link in bio)', 'See pricing at oyechats.com (link in bio)'), 'A note about replies.');
  assert.equal(withoutCta('A note. See pricing at oyechats.com today', 'See pricing at oyechats.com (link in bio)'), 'A note. today');
  assert.equal(withoutCta('A note.', ''), 'A note.');
});

test('categories: a sentence that merely mentions a pricing page or a plan is not a commercial term; a stated term is', () => {
  const set = buildEvidence([structure('https://acme.example/home', [
    { text: 'Point Acme at your docs, help center, and pricing page.' },
    { text: 'Free plan forever, no credit card required.' },
    { text: 'Pick the plan that suits your team size.' },
    { text: 'Start a 14-day trial of any plan.' },
  ])], NOW);
  const cat = (needle: string): string => (set.facts.find((f) => f.text.includes(needle)) as EvidenceFact).category;
  assert.equal(cat('pricing page'), 'capability');
  assert.equal(cat('Pick the plan'), 'capability');
  assert.equal(cat('Free plan forever'), 'commercial_term');
  assert.equal(cat('14-day trial'), 'commercial_term');
});

test('a second fact is added only when the page ties it to the first: the same plan or card on the same page, never just a shared heading', () => {
  const base = structure('https://acme.example/pricing', []);
  const set = buildEvidence([{ ...base, blocks: [
    block({ text: '₹599 /mo', cardId: 'c1', cardGroup: 'g', cardTitle: 'Starter' }),
    block({ text: '14-day free trial', cardId: 'c1', cardGroup: 'g', cardTitle: 'Starter' }),
    block({ text: '₹1,199 /mo', cardId: 'c2', cardGroup: 'g', cardTitle: 'Standard' }),
    block({ text: 'Answers come from your own pages and documents.', headingText: 'Answers' }),
    block({ text: 'Installation takes under 10 minutes and uses one script tag.', headingText: 'Setup' }),
  ] }], NOW).facts;
  const find = (needle: string): EvidenceFact => set.find((f) => f.text.includes(needle)) as EvidenceFact;
  const [starterPrice, trial, standardPrice, answers, setup] = [find('₹599'), find('14-day'), find('₹1,199'), find('Answers come'), find('Installation')];
  assert.equal(assignFacts({ facts: [starterPrice, trial, standardPrice], anchors: [starterPrice], recentFactIds: [] })[0]?.map((f) => f.text).join('|'), '₹599 /mo|14-day free trial');
  assert.equal(assignFacts({ facts: [starterPrice, standardPrice], anchors: [starterPrice], recentFactIds: [] })[0]?.length, 1);
  assert.equal(assignFacts({ facts: [answers, setup], anchors: [answers], recentFactIds: [] })[0]?.length, 1);
  const sameHeading = buildEvidence([{ ...base, blocks: [block({ text: 'Answers come from your own pages and documents.', headingText: 'Features' }), block({ text: 'Installation takes under 10 minutes and uses one script tag.', headingText: 'Features' })] }], NOW).facts;
  assert.equal(assignFacts({ facts: sameHeading, anchors: [sameHeading[0]], recentFactIds: [] })[0]?.length, 1, 'a shared heading does not tie two facts');
});

const pricingBrand = { ...brand, callToAction: 'See pricing at acme.example (link in bio)', handleUrl: 'acme.example' } as Brand;
const planWith = (b: Brand, evidence: Parameters<typeof planWeek>[0]['evidence'], m = model(), count = 1) =>
  planWeek({ ai, brand: b, brandSlug: 'acme', weekNumber: 1, schedule: { ...schedule, count }, usedPainPoints: [], fetchFn: m.fetchFn, ...(evidence ? { evidence } : {}) }).then((plan) => ({ plan, m }));

test('a pricing call to action is replaced by the neutral one on a post that is not about price or plan, and the writer is told', async () => {
  const setup = facts().filter((f) => f.text === SETUP);
  const { plan, m } = await planWith(pricingBrand, { facts: setup });
  assert.match(m.prompts[0] ?? '', /Call to action for this post \(use this one, not the profile's\): \\"Visit acme.example \(link in bio\)\\"/);
  assert.equal(plan.posts[0]?.cta?.label, 'Visit the website');
  assert.equal(plan.posts[0]?.cta?.text, 'Visit acme.example (link in bio)');
  assert.match(plan.posts[0]?.ctaReason ?? '', /cta_relevance_fallback/);
  assert.ok(!(plan.posts[0]?.hookWarnings ?? []).includes('editorial: cta_mismatch'));
});

test('the brand call to action is kept on a post built on a commercial fact, and for legacy brands', async () => {
  const trial = facts().filter((f) => f.text === TRIAL);
  const kept = await planWith(pricingBrand, { facts: trial });
  assert.equal(kept.plan.posts[0]?.cta, undefined);
  assert.ok(!/Call to action for this post/.test(kept.m.prompts[0] ?? ''));
  const legacy = await planWith(pricingBrand, undefined);
  assert.equal(legacy.plan.posts[0]?.cta, undefined);
});

test('caption length follows the evidence: a short target for one fact, no 450 to 900 floor in fact mode, the old range for legacy', async () => {
  const one = await planWith(brand, { facts: facts().filter((f) => f.text === SETUP) });
  assert.match(one.m.prompts[0] ?? '', /Caption length for this post: about 300 to 450 characters; say each fact once/);
  assert.ok(!/450-900/.test(one.m.prompts[0] ?? ''));
  const legacy = await planWith(brand, undefined);
  assert.match(legacy.m.prompts[0] ?? '', /450-900 characters/);
  assert.ok(!/Caption length for this post/.test(legacy.m.prompts[0] ?? ''));
});

test('in fact mode the caption is told to stay within the facts; legacy keeps the problem-and-solution caption', async () => {
  const withFacts = await planWith(brand, { facts: facts().filter((f) => f.text === SETUP) });
  assert.match(withFacts.m.prompts[0] ?? '', /Do not add benefits, outcomes, scenarios, customers, scope or capabilities that the facts do not state/);
  assert.ok(!/the problem in the customer's words/.test(withFacts.m.prompts[0] ?? ''));
  const legacy = await planWith(brand, undefined);
  assert.match(legacy.m.prompts[0] ?? '', /the problem in the customer's words/);
});

test('a post with no anchor never takes the fact a later post is anchored on, so no two posts of a batch share a primary fact', () => {
  const offered = offerableFacts(facts());
  const [a, b] = [offered[0] as EvidenceFact, offered[1] as EvidenceFact];
  const perPost = assignFacts({ facts: offered, anchors: [undefined, a, undefined, b], recentFactIds: [] });
  const firsts = perPost.map((p) => p[0]?.id);
  assert.equal(new Set(firsts).size, firsts.length, firsts.join(','));
  assert.equal(perPost[1]?.[0]?.id, a.id);
  assert.equal(perPost[3]?.[0]?.id, b.id);
  assert.ok(!firsts.slice(0, 1).includes(a.id) && !firsts.slice(0, 1).includes(b.id));
});

test('when the evidence cannot support more distinct posts, facts are reused rather than refused', () => {
  const only = offerableFacts(facts()).slice(0, 1);
  const perPost = assignFacts({ facts: only, anchors: [undefined, undefined], recentFactIds: [] });
  assert.deepEqual(perPost.map((p) => p[0]?.id), [only[0]?.id, only[0]?.id]);
});

test('a post that invents a figure its fact does not state is turned back, and on the last try only that post is left out, not the whole batch', async () => {
  const all = facts();
  const setup = all.find((f) => f.text === SETUP) as EvidenceFact;
  const sources = all.find((f) => f.text === SOURCES) as EvidenceFact;
  // Post 1 invents "go live in 10 minutes" against a fact with no such figure; the others write plainly from their facts.
  const m = model((slot) => (slot === 0 ? { subline: 'Acme Replies: go live in 10 minutes.', caption: 'Go live fast.' } : { subline: 'Acme Replies keeps it simple.', caption: 'A short note.' }));
  const plan = await run(m, { facts: [sources, setup] }, 2);
  assert.ok(plan.posts.length >= 1);
  assert.ok(plan.insufficientConcepts !== undefined);
  assert.ok(plan.insufficientConcepts.reasons.length >= 1);
});

test('in fact mode the numbered-list hook is never assigned; legacy brands keep it', async () => {
  const hooks = new Set<string>();
  for (let week = 1; week <= 4; week += 1) {
    const m = model();
    await planWeek({ ai, brand, brandSlug: 'acme', weekNumber: week, schedule: { ...schedule, count: 7 }, usedPainPoints: [], recentHooks: [], fetchFn: m.fetchFn, evidence: { facts: facts() } }).catch(() => undefined);
    for (const body of m.prompts) for (const match of body.matchAll(/Post \d+ \(\w+, (\w+)\)/g)) hooks.add(match[1] as string);
  }
  assert.ok(hooks.size > 0);
  assert.ok(!hooks.has('numbered_list'));
});


test('the writer is told which fact is the post\'s one message and that a second is only a supporting detail', async () => {
  const all = facts();
  const starter = all.find((f) => f.scope === 'Starter') as EvidenceFact;
  const m = model();
  await run(m, { facts: [starter, ...all.filter((f) => f.scope === undefined).slice(0, 1)] }, 1).catch(() => undefined);
  const prompt = m.prompts[0] ?? '';
  assert.match(prompt, /Main fact \(the one message of this post\)/);
  assert.match(prompt, /write one proposition, and say nothing that is not in these facts/);
});

test('with poster-worthiness scores, only worthy facts lead a post and fewer posts are written when too few facts are worth one', async () => {
  const all = facts();
  const worth: Record<string, number> = {};
  const sorted = offerableFacts(all);
  sorted.forEach((f, i) => { worth[f.id] = i < 2 ? 5 : 1; });
  const m = model();
  const plan = await planWeek({ ai, brand, brandSlug: 'acme', weekNumber: 1, schedule: { ...schedule, count: 4 }, usedPainPoints: [], fetchFn: m.fetchFn, evidence: { facts: all, worth } });
  assert.equal(plan.posts.length, 2);
  assert.equal(plan.insufficientConcepts?.requested, 4);
  assert.equal(plan.insufficientConcepts?.produced, 2);
  assert.match(plan.insufficientConcepts?.reasons[0] ?? '', /only 2 facts are worth a post of its own/);
  assert.ok(plan.posts.every((p) => (p.factIds ?? []).every((id, n) => n > 0 || (worth[id] ?? 0) >= 3)));
  // Without scores nothing is held back.
  const open = await planWeek({ ai, brand, brandSlug: 'acme', weekNumber: 1, schedule: { ...schedule, count: 3 }, usedPainPoints: [], fetchFn: model().fetchFn, evidence: { facts: all } });
  assert.equal(open.posts.length, 3);
});

test('the writer is told to write one clear reader-relevant message and not a feature list or menu line', async () => {
  const m = model();
  await run(m, { facts: facts() }, 1).catch(() => undefined);
  assert.match(m.prompts[0] ?? '', /Write one clear, reader-relevant statement or question/);
  assert.match(m.prompts[0] ?? '', /must not read like a menu item or a specification line/);
});

test('in fact mode the subline is optional: an empty one is accepted, and the writer is told to leave it empty unless it adds something', async () => {
  const m = model(() => ({ subline: '', caption: 'A short note.' }));
  const plan = await run(m, { facts: facts() }, 1);
  assert.equal(plan.posts[0]?.subline, '');
  assert.match(m.prompts[0] ?? '', /return an empty string unless it adds a detail, condition or fact/);
  const legacy = model(() => ({ subline: '', caption: 'A short note.' }));
  await assert.rejects(run(legacy, undefined, 1));
});

test('in fact mode a subline that restates the headline is taken away on the last try and the post stays; without facts the post is left out', async () => {
  const restate = (_slot: number, _prompt: string, headline: string) => ({ subline: `Acme Replies: ${headline}`, caption: 'A short note.' });
  const plan = await run(model(restate), { facts: facts() }, 1);
  assert.equal(plan.posts.length, 1);
  assert.equal(plan.posts[0]?.subline, '');
  assert.ok(plan.posts[0]?.hookWarnings?.includes('editorial: subline_removed_as_redundant'));
  await assert.rejects(run(model(restate), undefined, 1), InsufficientConceptsError);
});

test('a caption that says the same thing twice goes back to the writer and, on the last try, the post is left out', async () => {
  await assert.rejects(run(model(() => ({ subline: '', caption: 'Setup is quick and easy to do. Setup is easy and quick to do today.' })), { facts: facts() }, 1), InsufficientConceptsError);
});

test('with candidates: twice as many are written, each reviewed before any picture, the best are kept in order on the real days, and the rest wait as reserve drafts', async () => {
  const m = model();
  const seen: string[] = [];
  const review = {
    judge: async (input: { id: string; draft: { headline: string; subline?: string; caption: string }; facts: readonly EvidenceFact[] }) => {
      seen.push(input.id);
      const f = input.facts[0] as EvidenceFact;
      return { decision: 'SUPPORTED' as const, factId: f.id, violations: [], coverage: materialSentences({ headline: input.draft.headline, subline: (input.draft as { subline?: string }).subline ?? '', caption: input.draft.caption }).map((sentence) => ({ field: sentence.field, claimText: sentence.text, sourceQuote: f.source.quote })) };
    },
    adjudicate: async () => { throw new Error('not needed'); },
    rewrite: async () => { throw new Error('not needed'); },
    recheck: () => [],
  };
  const plan = await planWeek({ ai, brand, brandSlug: 'acme', weekNumber: 1, schedule: { ...schedule, count: 2 }, usedPainPoints: [], fetchFn: m.fetchFn, evidence: { facts: facts() }, candidates: { review } });
  assert.equal(plan.posts.length, 2);
  assert.deepEqual(plan.posts.map((p) => p.id), ['w01-d1', 'w01-d2'], 'the chosen posts take the real days in order');
  assert.deepEqual(plan.posts.map((p) => p.date), ['2026-11-04T10:00:00+05:30', '2026-11-05T10:00:00+05:30']);
  assert.ok(plan.candidateReport && plan.candidateReport.written >= 3 && plan.candidateReport.written <= 4, `candidates written: ${plan.candidateReport?.written}`);
  assert.equal(plan.candidateReport?.requested, 2);
  assert.equal(seen.length, plan.candidateReport?.written, 'every candidate was reviewed once');
  const factsUsed = plan.posts.map((p) => p.factIds?.[0]);
  assert.equal(new Set(factsUsed).size, factsUsed.length, 'no fact twice in the batch');
  assert.ok((plan.reserveDrafts?.length ?? 0) + plan.posts.length <= (plan.candidateReport?.written ?? 0));
  assert.ok(plan.posts.every((p) => p.evidenceChecks?.includes('semantic_support_structured_verdict')));
});

test('with candidates, a candidate the review drops is not used, and with too few left there are fewer posts, never padded', async () => {
  const m = model();
  const review = {
    judge: async (input: { id: string; draft: { headline: string; subline?: string; caption: string }; facts: readonly EvidenceFact[] }) => {
      const f = input.facts[0] as EvidenceFact;
      const bad = input.id !== 'w01-d1';
      return bad
        ? { decision: 'UNSUPPORTED' as const, factId: f.id, coverage: [], violations: [{ field: 'headline' as const, unsupportedText: input.draft.headline, reasonCode: 'CHANGED_MEANING', explanation: 'The source says something quite different from this headline.', sourceContext: f.source.quote }] }
        : { decision: 'SUPPORTED' as const, factId: f.id, violations: [], coverage: materialSentences({ headline: input.draft.headline, subline: (input.draft as { subline?: string }).subline ?? '', caption: input.draft.caption }).map((sentence) => ({ field: sentence.field, claimText: sentence.text, sourceQuote: f.source.quote })) };
    },
    adjudicate: async () => { throw new Error('not needed'); },
    rewrite: async () => { throw new Error('the rewrite is not possible'); },
    recheck: () => [],
  };
  const plan = await planWeek({ ai, brand, brandSlug: 'acme', weekNumber: 1, schedule: { ...schedule, count: 3 }, usedPainPoints: [], fetchFn: m.fetchFn, evidence: { facts: facts() }, candidates: { review } });
  assert.equal(plan.posts.length, 1);
  assert.equal(plan.posts[0]?.id, 'w01-d1');
  assert.ok(plan.insufficientConcepts && plan.insufficientConcepts.produced === 1);
  assert.match(plan.insufficientConcepts?.reasons.join(' ') ?? '', /could not be rewritten/);
});

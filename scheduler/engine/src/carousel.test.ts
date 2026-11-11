import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CarouselError, parseCarouselDraft } from './carousel.ts';

const facts = [
  { id: 'f1', text: 'Curry Cook offers popular curry menu items.' },
  { id: 'f2', text: 'Curry Cook offers a Build Your Own Curry option.' },
  { id: 'f3', text: 'The kitchen operates daily from 11:00 AM to 10:00 PM.' },
];
const good = {
  topic: 'Choosing a curry',
  style: 'flat vector illustration, thick rounded outlines, warm cream background, burgundy and saffron only',
  typography: 'heavy rounded sans-serif, burgundy, left aligned in the top third, same size on every slide',
  slides: [
    { role: 'hook', headline: 'Not sure what |curry to choose|?', scene: 'a bowl of curry with a question mark above it', factIds: ['f1'] },
    { role: 'content', headline: 'Start with a |popular favourite|', scene: 'three curry bowls in a row', factIds: ['f1'] },
    { role: 'content', headline: 'Or |build your own curry|', scene: 'ingredient jars around an empty bowl', factIds: ['f2'] },
    { role: 'closing', headline: 'Open |every day|, lunch to late', scene: 'a wall clock above a laid table', factIds: ['f3'] },
  ],
};
const withSlides = (slides: unknown[]): unknown => ({ ...good, slides });

test('a well-formed draft is accepted and keeps its slides in order', () => {
  const draft = parseCarouselDraft(good, facts);
  assert.equal(draft.slides.length, 4);
  assert.deepEqual(draft.slides.map((s) => s.role), ['hook', 'content', 'content', 'closing']);
  assert.equal(draft.slides[0]?.headline, 'Not sure what |curry to choose|?');
});

test('a carousel has three to five slides', () => {
  assert.throws(() => parseCarouselDraft(withSlides(good.slides.slice(0, 2)), facts), /three to five/);
  const six = [...good.slides, good.slides[1], good.slides[2]].map((s, i) => ({ ...s, headline: `${s?.headline} ${i}` }));
  assert.throws(() => parseCarouselDraft(withSlides(six), facts), /three to five/);
});

test('the first slide is the hook, the last is the closing, and nothing else is either', () => {
  const swapped = [good.slides[1], good.slides[0], good.slides[2], good.slides[3]];
  assert.throws(() => parseCarouselDraft(withSlides(swapped), facts), /first slide must be the hook/);
  const noClose = good.slides.map((s, i) => (i === 3 ? { ...s, role: 'content' } : s));
  assert.throws(() => parseCarouselDraft(withSlides(noClose), facts), /last slide must be the closing/);
  const twoHooks = good.slides.map((s, i) => (i === 1 ? { ...s, role: 'hook' } : s));
  assert.throws(() => parseCarouselDraft(withSlides(twoHooks), facts), /only the first slide/);
});

test('a slide may only name facts the brand has, and must name at least one', () => {
  const unknown = good.slides.map((s, i) => (i === 1 ? { ...s, factIds: ['nope'] } : s));
  assert.throws(() => parseCarouselDraft(withSlides(unknown), facts), /unknown fact "nope"/);
  const none = good.slides.map((s, i) => (i === 2 ? { ...s, factIds: [] } : s));
  assert.throws(() => parseCarouselDraft(withSlides(none), facts), /at least one fact/);
});

test('headlines are short, different from each other, and say something the named facts support', () => {
  const long = good.slides.map((s, i) => (i === 1 ? { ...s, headline: 'x'.repeat(61) } : s));
  assert.throws(() => parseCarouselDraft(withSlides(long), facts), /at most 60/);
  const twin = good.slides.map((s, i) => (i === 2 ? { ...s, headline: good.slides[1]?.headline } : s));
  assert.throws(() => parseCarouselDraft(withSlides(twin), facts), /same headline/);
  const claim = good.slides.map((s, i) => (i === 1 ? { ...s, headline: 'Ready in |10 minutes| flat' } : s));
  assert.throws(() => parseCarouselDraft(withSlides(claim), facts), /slide 2.*no verified claim supports/);
});

test('the shared style and typography must be written out, and a malformed answer is refused', () => {
  assert.throws(() => parseCarouselDraft({ ...good, style: '' }, facts), /style/);
  assert.throws(() => parseCarouselDraft({ ...good, typography: '  ' }, facts), /typography/);
  assert.throws(() => parseCarouselDraft(null, facts), CarouselError);
  assert.throws(() => parseCarouselDraft(withSlides([{ role: 'hook' }, {}, {}]), facts), CarouselError);
});

import { aiConfigFromEnv } from './ai.ts';
import { planCarousel } from './carousel.ts';

const ai = aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234' });
const reply = (...answers: unknown[]): { fetchFn: typeof fetch; messages: string[] } => {
  const messages: string[] = [];
  let n = 0;
  const fetchFn: typeof fetch = async (_url, init) => {
    messages.push(String(init?.body));
    const answer = answers[Math.min(n++, answers.length - 1)];
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
  };
  return { fetchFn, messages };
};

test('planCarousel asks the model once and returns the checked draft', async () => {
  const { fetchFn, messages } = reply(good);
  const draft = await planCarousel({ ai, brandName: 'Curry Cook', facts, avoidTopics: ['Weekend specials'], fetchFn });
  assert.equal(draft.topic, 'Choosing a curry');
  assert.equal(messages.length, 1);
  assert.match(messages[0] ?? '', /f2/);
  assert.match(messages[0] ?? '', /Weekend specials/);
});

test('planCarousel asks again when the first answer breaks a rule, and gives up with the reason after that', async () => {
  const bad = { ...good, slides: good.slides.slice(0, 2) };
  const second = reply(bad, good);
  assert.equal((await planCarousel({ ai, brandName: 'Curry Cook', facts, avoidTopics: [], fetchFn: second.fetchFn })).slides.length, 4);
  assert.equal(second.messages.length, 2);
  assert.match(second.messages[1] ?? '', /three to five slides/);
  await assert.rejects(planCarousel({ ai, brandName: 'Curry Cook', facts, avoidTopics: [], fetchFn: reply(bad).fetchFn }), /three to five slides/);
});

test('planCarousel refuses to start without enough verified facts', async () => {
  await assert.rejects(planCarousel({ ai, brandName: 'Curry Cook', facts: facts.slice(0, 2), avoidTopics: [] }), /at least three verified facts/);
});

import { slideConcepts, slidePosts } from './carousel.ts';

test('slidePosts makes one post per slide, with the brand name and address only on the last', () => {
  const draft = parseCarouselDraft(good, facts);
  const posts = slidePosts(draft, { idPrefix: 'cc-w46-car', date: '2026-11-18T10:00:00+05:30' });
  assert.deepEqual(posts.map((p) => p.id), ['cc-w46-car-s1', 'cc-w46-car-s2', 'cc-w46-car-s3', 'cc-w46-car-s4']);
  assert.ok(posts.every((p) => p.date === '2026-11-18T10:00:00+05:30' && p.mode === 'ai' && p.pillar === 'carousel'));
  assert.deepEqual(posts.slice(0, 3).map((p) => p.signoff), [{ brandName: '', domain: '' }, { brandName: '', domain: '' }, { brandName: '', domain: '' }]);
  assert.equal(posts[3]?.signoff, undefined);
  assert.deepEqual(posts[2]?.factIds, ['f2']);
  assert.equal(posts[0]?.headline, 'Not sure what |curry to choose|?');
});

test('slideConcepts gives every slide the same style and typography and its own scene', () => {
  const draft = parseCarouselDraft(good, facts);
  const posts = slidePosts(draft, { idPrefix: 'p', date: '2026-11-18T10:00:00+05:30' });
  const concepts = slideConcepts(draft, posts);
  assert.equal(concepts.length, 4);
  assert.ok(concepts.every((c, i) => c.postId === posts[i]?.id && c.concept.includes(good.style) && c.typography === good.typography && c.people === false && c.replans === 0));
  assert.match(concepts[1]?.concept ?? '', /THIS SLIDE: three curry bowls in a row/);
  assert.equal(new Set(concepts.map((c) => c.concept)).size, 4);
  assert.match(concepts[0]?.concept ?? '', /ONE CAROUSEL OF 4 SLIDES/);
});

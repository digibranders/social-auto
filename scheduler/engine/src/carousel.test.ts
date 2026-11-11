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

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { aiConfigFromEnv } from './ai.ts';
import type { CreativeReview } from './ai-creative.ts';
import { drawCarousel, planCarouselTopic, readHistory, runCarousel, type CarouselRunInput } from './carousel-run.ts';
import { decideCarousel, drawProblem } from './carousel-stage.ts';
import { parseCarouselDraft, type CarouselDraft } from './carousel.ts';
import { parseWeekPlan, type Brand } from './content.ts';
import type { EvidenceFact } from './evidence.ts';
import { defaultHeadlineGate } from './headline-gate.ts';
import { ReviewStore } from './review-store.ts';

const brand = { name: 'Curry Cook', website: 'https://www.currycook.com', colors: { background: '#FFF8E7', ink: '#5A0F1E', accent: '#F4B400', tile: '#EEEEEE' }, cta: { kind: 'visit-site', label: 'Order', text: 'Order at currycook.com (link in bio)', evidence: null } } as unknown as Brand;
const fact = (id: string, text: string): EvidenceFact => ({ id, text, category: 'offer', source: { quote: text, url: 'https://currycook.com/', context: 'Home', heading: '', regionType: 'prose', pageRole: 'home', contentHash: 'h' } } as unknown as EvidenceFact);
const facts = [fact('f1', 'Curry Cook offers popular curry menu items.'), fact('f2', 'Curry Cook offers a Build Your Own Curry option.'), fact('f3', 'The kitchen operates daily from 11:00 AM to 10:00 PM.')];
const factList = facts.map((f) => ({ id: f.id, text: f.text }));
const draft: CarouselDraft = parseCarouselDraft({
  topic: 'Choosing a curry', style: 'flat vector, cream background', typography: 'heavy rounded sans-serif, burgundy, top left',
  slides: [
    { role: 'hook', headline: 'Not sure what |curry to choose|?', scene: 'a bowl of curry', factIds: ['f1'] },
    { role: 'content', headline: 'Or |build your own curry|', scene: 'ingredient jars', factIds: ['f2'] },
    { role: 'closing', headline: 'Open |every day|, lunch to late', scene: 'a wall clock', factIds: ['f3'] },
  ],
}, factList);
const clean = { graphicalLogoOrIcon: false, badgeSealAwardOrCertification: false, inventedNumberPriceOrStatistic: false, interfaceOrScreenshotWithText: false, personPresentedAsCustomerOrEndorser: false, flagOrReligiousSymbol: false };
const reading = (texts: string[]): CreativeReview => ({ regions: texts.map((text) => ({ text, readable: true })), marks: { ...clean }, relevance: 2, composition: 2, readableSmall: true, textOverImportantArt: false, people: { present: false, estimatedCount: 0, prominent: false, description: '' }, notes: 'none' });

function setup(): { dir: string; brandDir: string; input: (over?: Partial<CarouselRunInput>) => CarouselRunInput; asked: { avoid: string[][] }; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'carousel-run-'));
  const brandDir = join(dir, 'brands', 'currycook');
  mkdirSync(brandDir, { recursive: true });
  const asked = { avoid: [] as string[][] };
  let drawn = 0;
  const input = (over: Partial<CarouselRunInput> = {}): CarouselRunInput => ({
    ai: aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234', AI_PROVIDER: 'openai' }), brand, brandSlug: 'currycook', brandDir, facts, networks: ['instagram', 'linkedin'], date: '2026-11-18T10:00:00+05:30', outRoot: join(dir, 'out'),
    deps: {
      plan: async (request) => { asked.avoid.push([...request.avoidTopics]); return draft; },
      captions: async () => ({ captions: { instagram: 'Swipe through.\n\nOrder at currycook.com (link in bio)\n\n#curry', linkedin: 'A short guide to choosing a curry.\n\nOrder at currycook.com' }, fallback: [] }),
      slides: {
        headlineGate: { enabled: false, config: defaultHeadlineGate },
        scene: async (_prompt, file) => { drawn += 1; writeFileSync(file, `slide ${drawn}`); },
        review: async () => reading([(draft.slides[(drawn - 1) % 3]?.headline ?? '').replace(/\|/g, '')]),
      },
    },
    ...over,
  });
  return { dir, brandDir, input, asked, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a carousel is planned, captioned, drawn, put up for review and written into a plan file the export can read', async () => {
  const s = setup();
  try {
    const out = await runCarousel(s.input());
    assert.equal(out.status, 'queued', out.reason);
    assert.match(out.carouselId, /^car-20261118/);
    const store = new ReviewStore(s.brandDir, 'currycook');
    assert.equal(store.carouselStatus(out.carouselId), 'pending');
    assert.equal(store.carouselSlides(out.carouselId).slides.length, 3);
    assert.deepEqual(store.carouselSlides(out.carouselId).captions.map((c) => c.version.network).sort(), ['instagram', 'linkedin']);
    const plan = parseWeekPlan(JSON.parse(readFileSync(join(s.brandDir, out.planFile ?? ''), 'utf8')), 'plan');
    assert.equal(plan.renderMode, 'ai_v1');
    assert.equal(plan.posts.length, 1);
    assert.equal(plan.posts[0]?.id, out.carouselId);
    assert.equal(plan.posts[0]?.date, '2026-11-18T10:00:00+05:30');
    assert.equal(plan.posts[0]?.pillar, 'carousel');
    const history = JSON.parse(readFileSync(join(s.brandDir, 'carousels.json'), 'utf8')) as { carousels: Array<{ id: string; topic: string }> };
    assert.deepEqual(history.carousels.map((c) => [c.id, c.topic]), [[out.carouselId, 'Choosing a curry']]);
  } finally {
    s.done();
  }
});

test('the next carousel is told the topics already used, and a second one on the same day has its own id and plan file', async () => {
  const s = setup();
  try {
    const first = await runCarousel(s.input());
    const second = await runCarousel(s.input());
    assert.deepEqual(s.asked.avoid, [[], ['Choosing a curry']]);
    assert.notEqual(first.carouselId, second.carouselId);
    assert.notEqual(first.planFile, second.planFile);
    assert.equal(readdirSync(s.brandDir).filter((f) => /^week-\d+\.json$/.test(f)).length, 2);
  } finally {
    s.done();
  }
});

test('nothing is bought without three verified facts or a channel, and a carousel that is not ready writes nothing', async () => {
  const s = setup();
  try {
    const few = await runCarousel(s.input({ facts: facts.slice(0, 2) }));
    assert.equal(few.status, 'skipped');
    assert.match(few.reason ?? '', /three verified facts/);
    const none = await runCarousel(s.input({ networks: [] }));
    assert.equal(none.status, 'skipped');
    assert.match(none.reason ?? '', /channel/);
    const base = s.input();
    const broken = await runCarousel({ ...base, deps: { ...base.deps, slides: { ...base.deps?.slides, maxAttempts: 1, review: async () => reading(['Something else entirely']) } } });
    assert.equal(broken.status, 'not_ready');
    assert.match(broken.reason ?? '', /slide 1/);
    assert.deepEqual(readHistory(s.brandDir), [], 'nothing is left in the history, not even the topic');
    assert.equal(readdirSync(s.brandDir).filter((f) => /^week-/.test(f)).length, 0);
    assert.equal(new ReviewStore(s.brandDir, 'currycook').list().length, 0);
  } finally {
    s.done();
  }
});

test('the topic stage writes the words and nothing is drawn or put up for review; the drawing follows only for a kept carousel, from the very same words', async () => {
  const s = setup();
  try {
    const topic = await planCarouselTopic(s.input());
    assert.equal(topic.status, 'topic', topic.reason);
    assert.equal(existsSync(join(s.dir, 'out')), false, 'no picture was drawn');
    assert.equal(readdirSync(s.brandDir).filter((f) => /^week-\d+\.json$/.test(f)).length, 0, 'and no plan file the export could read');
    assert.equal(new ReviewStore(s.brandDir, 'currycook').list().length, 0, 'nothing is in review yet');
    const saved = readHistory(s.brandDir);
    assert.deepEqual(saved.map((h) => [h.id, h.stage, h.planFile, h.plan?.draft.slides.length, Object.keys(h.plan?.captions ?? {}).sort()]), [[topic.carouselId, 'topic', undefined, 3, ['instagram', 'linkedin']]]);

    // Not kept yet: it is not drawn.
    const early = await drawCarousel(s.input(), topic.carouselId);
    assert.equal(early.status, 'skipped');
    assert.match(early.reason ?? '', /kept/);
    assert.equal(drawProblem(readHistory(s.brandDir)[0], '2026-11-17')?.code, 'CONFLICT');

    decideCarousel({ brandDir: s.brandDir, id: topic.carouselId, choice: 'kept', today: '2026-11-17', drawActive: false });
    assert.equal(drawProblem(readHistory(s.brandDir)[0], '2026-11-17'), null);
    const drawn = await drawCarousel(s.input(), topic.carouselId);
    assert.equal(drawn.status, 'queued', drawn.reason);
    const store = new ReviewStore(s.brandDir, 'currycook');
    assert.equal(store.carouselStatus(topic.carouselId), 'pending');
    assert.deepEqual(store.carouselSlides(topic.carouselId).slides.map((i) => i?.version.headline), draft.slides.map((sl) => sl.headline.replaceAll('|', '')), 'the slides carry the words written in the first stage');
    assert.deepEqual(store.carouselSlides(topic.carouselId).captions.map((c) => c.version.network).sort(), ['instagram', 'linkedin']);
    const after = readHistory(s.brandDir)[0];
    assert.deepEqual([after?.stage, after?.planFile !== undefined, after?.plan], ['drawn', true, undefined], 'drawn: it has its plan file and the saved words are no longer needed');
    assert.equal(drawProblem(after, '2026-11-17')?.code, 'ALREADY_DRAWN');
    assert.throws(() => decideCarousel({ brandDir: s.brandDir, id: topic.carouselId, choice: 'dropped', today: '2026-11-17', drawActive: false }), /already drawn/, 'a drawn carousel\'s choice is final');
  } finally {
    s.done();
  }
});

test('a topic is kept, dropped or put back to undecided until its day or its drawing; a drawing that fails leaves it kept to try again', async () => {
  const s = setup();
  try {
    const topic = await planCarouselTopic(s.input());
    const choose = (choice: 'kept' | 'dropped' | 'topic', today = '2026-11-17', drawActive = false) => decideCarousel({ brandDir: s.brandDir, id: topic.carouselId, choice, today, drawActive }).stage;
    assert.equal(choose('kept'), 'kept');
    assert.equal(choose('topic'), 'topic', 'put back to undecided');
    assert.equal(choose('dropped'), 'dropped');
    assert.equal(choose('kept'), 'kept', 'a dropped topic can still be kept');
    assert.throws(() => choose('kept', '2026-11-18'), (e: Error) => (e as { code?: string }).code === 'DAY_PASSED', 'its day is today');
    assert.equal(choose('dropped', '2026-11-18'), 'dropped', 'dropping is always allowed');
    assert.equal(choose('kept'), 'kept');
    assert.throws(() => choose('dropped', '2026-11-17', true), (e: Error) => (e as { code?: string }).code === 'ALREADY_DRAWN', 'while it is being drawn the choice is final');
    assert.throws(() => decideCarousel({ brandDir: s.brandDir, id: 'nope', choice: 'kept', today: '2026-11-17', drawActive: false }), (e: Error) => (e as { code?: string }).code === 'NOT_FOUND');

    // The drawing fails: nothing is bought again by itself, the topic stays kept, and nothing is left in review.
    const base = s.input();
    const broken = await drawCarousel({ ...base, deps: { ...base.deps, slides: { ...base.deps?.slides, maxAttempts: 1, review: async () => reading(['Something else entirely']) } } }, topic.carouselId);
    assert.equal(broken.status, 'not_ready');
    assert.equal(readHistory(s.brandDir)[0]?.stage, 'kept');
    assert.equal(new ReviewStore(s.brandDir, 'currycook').list().length, 0);
    assert.equal((await drawCarousel(s.input(), topic.carouselId)).status, 'queued', 'asked again, it is drawn');
  } finally {
    s.done();
  }
});

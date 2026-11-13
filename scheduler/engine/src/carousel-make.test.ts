import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { aiConfigFromEnv } from './ai.ts';
import type { CreativeReview } from './ai-creative.ts';
import { makeCarouselSlides } from './carousel-make.ts';
import { parseCarouselDraft } from './carousel.ts';
import type { Brand } from './content.ts';
import { defaultHeadlineGate } from './headline-gate.ts';
import { BudgetError, defaultBudgetLimits, PaidLedger } from './paid-ledger.ts';

const brand = { name: 'Curry Cook', website: 'https://www.currycook.com', colors: { background: '#FFF8E7', ink: '#5A0F1E', accent: '#F4B400', tile: '#EEEEEE' } } as unknown as Brand;
const facts = [
  { id: 'f1', text: 'Curry Cook offers popular curry menu items.' },
  { id: 'f2', text: 'Curry Cook offers a Build Your Own Curry option.' },
  { id: 'f3', text: 'The kitchen operates daily from 11:00 AM to 10:00 PM.' },
];
const draft = parseCarouselDraft({
  topic: 'Choosing a curry',
  style: 'flat vector illustration, warm cream background',
  typography: 'heavy rounded sans-serif, burgundy, top left',
  slides: [
    { role: 'hook', headline: 'Not sure what |curry to choose|?', scene: 'a bowl of curry', factIds: ['f1'] },
    { role: 'content', headline: 'Or |build your own curry|', scene: 'ingredient jars', factIds: ['f2'] },
    { role: 'closing', headline: 'Open |every day|, lunch to late', scene: 'a wall clock', factIds: ['f3'] },
  ],
}, facts);
const clean = { graphicalLogoOrIcon: false, badgeSealAwardOrCertification: false, inventedNumberPriceOrStatistic: false, interfaceOrScreenshotWithText: false, personPresentedAsCustomerOrEndorser: false, flagOrReligiousSymbol: false };
const reading = (texts: string[]): CreativeReview => ({ regions: texts.map((text) => ({ text, readable: true })), marks: { ...clean }, relevance: 2, composition: 2, readableSmall: true, textOverImportantArt: false, people: { present: false, estimatedCount: 0, prominent: false, description: '' }, notes: 'none' });
/** What a faithful picture of each slide would show: its headline, and the sign-off only on the last. */
const shown = (headline: string): string[] => [headline.replace(/\|/g, '')];

function setup(): { dir: string; ai: ReturnType<typeof aiConfigFromEnv>; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'carousel-make-'));
  const ai = aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234', AI_PROVIDER: 'openai' });
  ai.ledger = new PaidLedger(join(dir, 'ledger.jsonl'), { ...defaultBudgetLimits }, { jobId: 'job', tenantId: 'owner', brandId: 'currycook' });
  return { dir, ai, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const base = (ctx: ReturnType<typeof setup>) => ({ ai: ctx.ai, brand, brandSlug: 'currycook', facts, draft, idPrefix: 'cc-car', date: '2026-11-18T10:00:00+05:30', outDir: join(ctx.dir, 'out') });

test('every slide drawn and accepted makes a ready carousel, in order, with one shared style in every prompt', async () => {
  const ctx = setup();
  try {
    const prompts: string[] = [];
    const out = await makeCarouselSlides({
      ...base(ctx),
      deps: {
        headlineGate: { enabled: false, config: defaultHeadlineGate },
        lookAlikes: async () => ({ scenes: [], typography: [] }),
        scene: async (prompt, file) => { prompts.push(prompt); writeFileSync(file, 'x'); },
        review: async (_file, _msg, _n) => reading(shown(draft.slides[Math.min(prompts.length, 3) - 1]?.headline ?? '')),
      },
    });
    assert.equal(out.ready, true);
    assert.deepEqual(out.slides.map((s) => s.postId), ['cc-car-s1', 'cc-car-s2', 'cc-car-s3']);
    assert.ok(out.slides.every((s) => s.file?.endsWith('.jpg')));
    assert.ok(prompts.every((p) => p.includes('flat vector illustration, warm cream background') && p.includes('heavy rounded sans-serif')));
    assert.doesNotMatch(prompts[0] ?? '', /WEB ADDRESS/);
    assert.doesNotMatch(prompts[2] ?? '', /WEB ADDRESS:/, 'no web address on any slide');
    assert.ok(prompts.every((p) => !p.includes('BRAND NAME')), 'the business name is not on any slide');
    assert.match(prompts[2] ?? '', /The brand name is not part of the text on this poster/);
  } finally {
    ctx.done();
  }
});

test('one slide that cannot be accepted makes the whole carousel not ready, and says which slide and why', async () => {
  const ctx = setup();
  try {
    let drawn = 0;
    const out = await makeCarouselSlides({
      ...base(ctx),
      deps: {
        headlineGate: { enabled: false, config: defaultHeadlineGate },
        lookAlikes: async () => ({ scenes: [], typography: [] }),
        maxAttempts: 1,
        scene: async (_p, file) => { drawn += 1; writeFileSync(file, 'x'); },
        // The second slide's picture shows wrong words.
        review: async () => reading(drawn === 2 ? ['Something else entirely'] : shown(draft.slides[drawn - 1]?.headline ?? '')),
      },
    });
    assert.equal(out.ready, false);
    assert.match(out.reason ?? '', /slide 2/);
    assert.equal(out.slides[1]?.status, 'rejected');
  } finally {
    ctx.done();
  }
});

test('a spending stop is passed on as the reason, and no slide is called ready', async () => {
  const ctx = setup();
  try {
    const out = await makeCarouselSlides({
      ...base(ctx),
      deps: {
        headlineGate: { enabled: false, config: defaultHeadlineGate },
        lookAlikes: async () => ({ scenes: [], typography: [] }),
        scene: async () => { throw new BudgetError('RUN_BUDGET', 'the run limit was reached'); },
      },
    });
    assert.equal(out.ready, false);
    assert.match(out.reason ?? '', /the run limit was reached/);
  } finally {
    ctx.done();
  }
});

test('the real logo is asked for and placed on the last slide only', async () => {
  const ctx = setup();
  try {
    const prompts: string[] = [];
    const placed: string[] = [];
    const out = await makeCarouselSlides({
      ...base(ctx),
      logo: { path: '/logos/currycook.png', kind: 'wordmark', sha256: 'abc' },
      deps: {
        headlineGate: { enabled: false, config: defaultHeadlineGate },
        scene: async (prompt, file) => { prompts.push(prompt); writeFileSync(file, 'x'); },
        // With the logo, the name is inside it and is not drawn: the last slide shows its headline only.
        review: async () => {
          const seen = reading(shown(draft.slides[Math.min(prompts.length, 3) - 1]?.headline ?? ''));
          return { ...seen, regions: seen.regions.map((r) => ({ ...r, box: [100, 600, 900, 700] as [number, number, number, number] })) };
        },
        place: async (input) => {
          placed.push(input.posterPath);
          writeFileSync(input.outPath, 'with logo');
          return { placed: true, logoRect: [0, 0, 10, 10], plateRect: null, plateColor: null, treatment: 'none', haloColor: null, score: 1, contrast: 7, logoSha256: 'abc', outputSha256: 'def', width: 1024, height: 1024, considered: 1, bestScores: [1] };
        },
      },
    });
    assert.equal(out.ready, true, out.reason);
    assert.equal(placed.length, 1);
    assert.match(placed[0] ?? '', /cc-car-s3/);
    assert.doesNotMatch(`${prompts[0]}${prompts[1]}`, /LOGO SPACE/);
    assert.match(prompts[2] ?? '', /LOGO SPACE/);
  } finally {
    ctx.done();
  }
});

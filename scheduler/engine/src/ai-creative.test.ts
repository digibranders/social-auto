import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aiConfigFromEnv } from './ai.ts';
import { buildCreativePrompt, displayDomain, judgeCreative, plainHeadline, retryNoteFor, reviewCreative, type CreativeReview, type TextManifest } from './ai-creative.ts';
import { defaultHeadlineGate } from './headline-gate.ts';
import { makeCreatives, manifestOf } from './ai-creative-pipeline.ts';
import type { DirectorResult } from './creative-director.ts';
import { BudgetError, defaultBudgetLimits, PaidLedger } from './paid-ledger.ts';
import type { Brand, PlannedPost } from './content.ts';

const manifest: TextManifest = { headline: 'Answers from your own docs', brandName: 'OyeChats', domain: 'oyechats.com' };
const clean: CreativeReview['marks'] = { graphicalLogoOrIcon: false, badgeSealAwardOrCertification: false, inventedNumberPriceOrStatistic: false, interfaceOrScreenshotWithText: false, personPresentedAsCustomerOrEndorser: false, flagOrReligiousSymbol: false };
const review = (texts: string[], over: Partial<CreativeReview> = {}): CreativeReview => ({ regions: texts.map((text) => ({ text, readable: true })), marks: { ...clean }, relevance: 2, composition: 2, readableSmall: true, notes: 'none', ...over });

test('a poster that carries exactly the allowed text, once, is accepted', () => {
  const verdict = judgeCreative(manifest, review(['Answers from', 'your own docs', 'OyeChats', 'oyechats.com']));
  assert.deepEqual(verdict, { accepted: true, defects: [] });
});

test('case, accents, spacing and punctuation do not matter, wording does', () => {
  assert.equal(judgeCreative(manifest, review(['ANSWERS FROM YOUR OWN DOCS.', 'oyechats', 'OyeChats.com'])).accepted, true);
  const misspelled = judgeCreative(manifest, review(['Answers from your own dcos', 'OyeChats', 'oyechats.com']));
  assert.equal(misspelled.accepted, false);
  assert.ok(misspelled.defects.some((d) => d.kind === 'missing_text' && d.text === 'the headline'));
  assert.ok(misspelled.defects.some((d) => d.kind === 'extra_text'), 'the misspelled words are left over as extra text');
});

test('any other readable text rejects it: invented interface words, labels, small print', () => {
  const found = judgeCreative(manifest, review(['Answers from your own docs', 'OyeChats', 'oyechats.com', 'Reply sent', 'Docs 3']));
  assert.equal(found.accepted, false);
  assert.deepEqual(found.defects, [{ kind: 'extra_text', text: 'reply sent docs 3' }]);
});

test('missing or repeated required text rejects it', () => {
  assert.ok(judgeCreative(manifest, review(['Answers from your own docs', 'OyeChats'])).defects.some((d) => d.kind === 'missing_text' && d.text === 'the web address'));
  assert.ok(judgeCreative(manifest, review(['Answers from your own docs', 'Answers from your own docs', 'OyeChats', 'oyechats.com'])).defects.some((d) => d.kind === 'repeated_text'));
  assert.ok(judgeCreative({ ...manifest, headline: 'Plan your week' }, review(['Plan your week', 'oyechats.com'])).defects.some((d) => d.kind === 'missing_text' && d.text === 'the brand name'));
});

test('a headline that names the brand makes the separate name optional, and a name inside the web address does not count as the sign-off', () => {
  const named: TextManifest = { headline: 'OyeChats answers from your own docs', brandName: 'OyeChats', domain: 'oyechats.com' };
  assert.equal(judgeCreative(named, review(['OyeChats answers from your own docs', 'oyechats.com'])).accepted, true);
  assert.equal(judgeCreative(named, review(['OyeChats answers from your own docs', 'OyeChats', 'oyechats.com'])).accepted, true);
  assert.equal(judgeCreative(manifest, review(['Answers from your own docs', 'oyechats.com'])).accepted, false, 'the name only inside the address is not a sign-off');
});

test('text the reader was unsure of rejects the poster', () => {
  const unsure = review(['Answers from your own docs', 'OyeChats', 'oyechats.com']);
  unsure.regions[1] = { text: 'OyeChats', readable: false };
  const verdict = judgeCreative(manifest, unsure);
  assert.equal(verdict.accepted, false);
  assert.deepEqual(verdict.defects, [{ kind: 'unreadable_text', text: 'OyeChats' }]);
});

test('every forbidden thing rejects it, and so do artwork that says nothing and a headline that is hard to read', () => {
  const ok = ['Answers from your own docs', 'OyeChats', 'oyechats.com'];
  for (const key of Object.keys(clean) as Array<keyof typeof clean>) {
    const verdict = judgeCreative(manifest, review(ok, { marks: { ...clean, [key]: true } }));
    assert.equal(verdict.accepted, false, key);
    assert.equal(verdict.defects[0]?.kind, 'forbidden_mark');
  }
  assert.deepEqual(judgeCreative(manifest, review(ok, { relevance: 0 })).defects, [{ kind: 'not_relevant' }]);
  assert.deepEqual(judgeCreative(manifest, review(ok, { composition: 0 })).defects, [{ kind: 'poor_composition' }]);
  assert.equal(judgeCreative(manifest, review(ok, { relevance: 1, composition: 1 })).accepted, true);
});

test('text that would not be readable at a small size rejects it, and the retry says so', () => {
  const verdict = judgeCreative(manifest, review(['Answers from your own docs', 'OyeChats', 'oyechats.com'], { readableSmall: false }));
  assert.deepEqual(verdict.defects, [{ kind: 'illegible_small' }]);
  assert.match(retryNoteFor(verdict.defects), /not be readable at a small size/);
});

test('a poster with an optional supporting line must carry it once', () => {
  const withSub: TextManifest = { ...manifest, subline: 'Set up in minutes' };
  assert.equal(judgeCreative(withSub, review(['Answers from your own docs', 'Set up in minutes', 'OyeChats', 'oyechats.com'])).accepted, true);
  assert.ok(judgeCreative(withSub, review(['Answers from your own docs', 'OyeChats', 'oyechats.com'])).defects.some((d) => d.kind === 'missing_text' && d.text === 'the supporting line'));
});

test('the prompt names every allowed text, forbids the rest, and carries a correction when given one', () => {
  const colors = { background: '#FFFFFF', ink: '#111111', accent: '#6B3FD4' };
  const prompt = buildCreativePrompt(manifest, { fact: 'OyeChats answers from your own documents.', colors });
  assert.match(prompt, /HEADLINE: "Answers from your own docs"/);
  assert.match(prompt, /BRAND NAME: "OyeChats"/);
  assert.match(prompt, /WEB ADDRESS: "oyechats\.com"/);
  assert.match(prompt, /Never draw or imitate a logo/);
  assert.match(prompt, /no other words, letters, numbers/i);
  assert.doesNotMatch(prompt, /CORRECTION/);
  assert.doesNotMatch(prompt, /large, easy to read and high in contrast/, 'legibility is an acceptance rule, not the creative direction');
  assert.match(prompt, /LEGIBILITY applies to every treatment/);
  const typed = buildCreativePrompt(manifest, { fact: 'f', colors, concept: { concept: 'A picture.', factToPicture: 'It shows it.', typography: 'The headline climbs the right edge in a thin condensed face, tinted like the lamp.' } });
  assert.match(typed, /TYPOGRAPHY \(an essential part of the concept, not optional styling\): The headline climbs the right edge/);
  assert.match(typed, /do not fall back to a large black headline above the artwork/);
  assert.doesNotMatch(typed, /small sign-off/);
  const retry = buildCreativePrompt(manifest, { fact: 'f', colors, retryNote: retryNoteFor([{ kind: 'extra_text', text: 'reply sent' }]) });
  assert.match(retry, /CORRECTION/);
  assert.match(retry, /reply sent/);
});

test('headlines and addresses are shown as a person reads them', () => {
  assert.equal(plainHeadline('Track |tasks, not just deliverables|'), 'Track tasks, not just deliverables');
  assert.equal(displayDomain('https://www.oyechats.com/pricing'), 'oyechats.com');
  assert.equal(displayDomain('oyechats.com'), 'oyechats.com');
});

test('the vision answer must be well formed, or the call is retried and then fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'creative-'));
  try {
    const image = join(dir, 'a.jpg');
    writeFileSync(image, 'x');
    const ai = aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234', AI_PROVIDER: 'openai' });
    const answer = (content: unknown): typeof fetch => async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
    const good = await reviewCreative(ai, image, 'a fact', answer({ regions: [{ text: 'Hi', readable: true }], marks: clean, relevance: 2, composition: 1, readableSmall: true, notes: 'none' }));
    assert.equal(good.regions[0]?.text, 'Hi');
    await assert.rejects(reviewCreative(ai, image, 'a fact', answer({ regions: [{ text: 'Hi' }], marks: clean, relevance: 2, composition: 1 })), /No valid response/);
    await assert.rejects(reviewCreative(ai, image, 'a fact', answer({ regions: [], marks: { ...clean, flagOrReligiousSymbol: 'no' }, relevance: 2, composition: 1 })), /No valid response/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- The pipeline

const brand = { name: 'OyeChats', website: 'https://www.oyechats.com', colors: { background: '#FFFFFF', ink: '#111111', accent: '#6B3FD4', tile: '#EEEEEE' } } as unknown as Brand;
const post = (id: string, headline: string): PlannedPost => ({ id, headline }) as unknown as PlannedPost;

function setup(limits: Partial<typeof defaultBudgetLimits> = {}): { dir: string; ai: ReturnType<typeof aiConfigFromEnv>; ledger: PaidLedger; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'creative-run-'));
  const ai = aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234', AI_PROVIDER: 'openai' });
  const ledger = new PaidLedger(join(dir, 'ledger.jsonl'), { ...defaultBudgetLimits, ...limits }, { jobId: 'job', tenantId: 'owner', brandId: 'oyechats' });
  ai.ledger = ledger;
  return { dir, ai, ledger, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const CONCEPTS = [
  'Blank paper sheets fold themselves into a dimensional speech bubble on a sunlit wooden table, macro photograph, shallow depth of field.',
  'A single continuous violet line loops across the whole frame and ties itself into one long chain of connected bubbles, hand drawn on cream paper.',
  'A cut-paper collage of a shop window at dusk where one lantern is lit and the others are dark, layered card in deep blues.',
  'A sculpted clay hand passes a glowing key across a canyon between two floating stone platforms, studio lighting, miniature scale.',
];
/** A stand-in for the creative director: one distinct concept per post, none showing people. */
const directed = (posts: ReadonlyArray<{ id: string }>): Promise<DirectorResult> =>
  Promise.resolve({ concepts: posts.map((p, i) => ({ postId: p.id, concept: CONCEPTS[i % CONCEPTS.length] as string, people: false, factToPicture: 'The picture shows the fact as one clear idea.', typography: 'The headline is set large in the top left in a plain heavy letterform.', replans: 0 })), dropped: [], flags: [] });

const run = (ctx: ReturnType<typeof setup>, posts: PlannedPost[], deps: Parameters<typeof makeCreatives>[0]['deps']) =>
  makeCreatives({ ai: ctx.ai, brand, brandSlug: 'oyechats', posts, factOf: () => 'OyeChats answers from your own documents.', outDir: join(ctx.dir, 'out'), directorEnabled: true, deps: { headlineGate: { enabled: false, config: defaultHeadlineGate }, direct: directed, lookAlikes: async () => ({ scenes: [], typography: [] }), ...deps } });

const scene = (calls: string[]) => async (prompt: string, out: string): Promise<void> => {
  calls.push(prompt);
  writeFileSync(out, `picture ${calls.length}`);
};

test('an accepted first attempt is kept as the poster, one picture bought, nothing approved', async () => {
  const ctx = setup();
  try {
    const prompts: string[] = [];
    const report = await run(ctx, [post('w01-d1', 'Answers from your |own docs|')], { scene: scene(prompts), review: async () => review(['Answers from your own docs', 'OyeChats', 'oyechats.com']) });
    assert.equal(report.results[0]?.status, 'accepted');
    assert.equal(report.results[0]?.attempts.length, 1);
    assert.equal(prompts.length, 1);
    assert.equal(readFileSync(report.results[0]?.file as string, 'utf8'), 'picture 1');
    assert.deepEqual(report.results[0]?.manifest, { headline: 'Answers from your own docs', brandName: 'OyeChats', domain: 'oyechats.com' });
    assert.ok(readFileSync(join(ctx.dir, 'out', 'creative-report.json'), 'utf8').includes('"accepted"'));
  } finally {
    ctx.done();
  }
});

test('a poster rejected for invented text gets one retry that says what was wrong, and the retry can be accepted', async () => {
  const ctx = setup();
  try {
    const prompts: string[] = [];
    const report = await run(ctx, [post('w01-d1', 'Answers from your own docs')], {
      scene: scene(prompts),
      review: async (file) => (file.includes('attempt1') ? review(['Answers from your own docs', 'OyeChats', 'oyechats.com', 'Reply sent']) : review(['Answers from your own docs', 'OyeChats', 'oyechats.com'])),
    });
    const result = report.results[0];
    assert.equal(result?.status, 'accepted');
    assert.equal(result?.attempts.length, 2);
    assert.equal(result?.attempts[0]?.accepted, false);
    assert.match(prompts[1] ?? '', /CORRECTION.*reply sent/is);
    assert.doesNotMatch(prompts[0] ?? '', /CORRECTION/);
  } finally {
    ctx.done();
  }
});

test('a poster rejected twice is dropped with its reasons: fewer posters, never one that failed', async () => {
  const ctx = setup();
  try {
    const prompts: string[] = [];
    const report = await run(ctx, [post('w01-d1', 'Answers from your own docs'), post('w01-d2', 'A free plan forever')], {
      scene: scene(prompts),
      review: async (_file, _fact) => review(['Something else entirely', 'oyechats.com']),
    });
    assert.deepEqual(report.results.map((r) => r.status), ['rejected', 'rejected']);
    assert.equal(prompts.length, 4, 'two attempts each, no more');
    assert.match(report.results[0]?.reason ?? '', /rejected after 2 attempts/);
    assert.equal(report.results[0]?.file, undefined);
  } finally {
    ctx.done();
  }
});

test('a poster must pass every independent reading: one dissenting reading rejects it, and all its defects are kept', async () => {
  const ctx = setup();
  try {
    const prompts: string[] = [];
    const calls: number[] = [];
    const report = await run(ctx, [post('w01-d1', 'Answers from your own docs')], {
      scene: scene(prompts),
      review: async (_file, _fact, reading) => {
        calls.push(reading);
        return reading === 2 ? review(['Answers from your own docs', 'OyeChats', 'oyechats.com'], { marks: { ...clean, graphicalLogoOrIcon: true } }) : review(['Answers from your own docs', 'OyeChats', 'oyechats.com']);
      },
    });
    assert.deepEqual(calls.slice(0, 2), [1, 2], 'two independent readings per attempt');
    assert.equal(report.results[0]?.status, 'rejected');
    assert.equal(report.results[0]?.attempts[0]?.readings.length, 2);
    assert.ok(report.results[0]?.attempts[0]?.defects.some((d) => d.kind === 'forbidden_mark'));
  } finally {
    ctx.done();
  }
});

test('a poster that cannot be read is failed, not assumed fine, and costs no second picture', async () => {
  const ctx = setup();
  try {
    const prompts: string[] = [];
    const report = await run(ctx, [post('w01-d1', 'Answers from your own docs')], { scene: scene(prompts), review: async () => { throw new Error('No valid response'); } });
    assert.equal(report.results[0]?.status, 'failed');
    assert.match(report.results[0]?.reason ?? '', /could not be read/);
    assert.equal(prompts.length, 1);
  } finally {
    ctx.done();
  }
});

test('a spending cap ends the run, keeps what was made, and no further picture is bought', async () => {
  const ctx = setup();
  try {
    let drawn = 0;
    const report = await run(ctx, [post('w01-d1', 'Answers from your own docs'), post('w01-d2', 'A free plan forever'), post('w01-d3', 'Plan your week')], {
      scene: async (_prompt, out) => {
        drawn += 1;
        if (drawn === 2) throw new BudgetError('RUN_BUDGET', 'this run would spend more than its limit');
        writeFileSync(out, 'x');
      },
      review: async () => review(['Answers from your own docs', 'OyeChats', 'oyechats.com']),
    });
    assert.equal(report.results[0]?.status, 'accepted');
    assert.equal(report.results[1]?.status, 'budget_stopped');
    assert.equal(report.results.length, 2, 'the third post was never started');
    assert.match(report.stoppedBy ?? '', /RUN_BUDGET/);
  } finally {
    ctx.done();
  }
});

test('a poster-level limit drops that poster only', async () => {
  const ctx = setup();
  try {
    let drawn = 0;
    const report = await run(ctx, [post('w01-d1', 'Answers from your own docs'), post('w01-d2', 'Plan your week')], {
      scene: async (_p, out) => {
        drawn += 1;
        if (drawn === 1) throw new BudgetError('IMAGE_LIMIT', 'no more pictures for this poster');
        writeFileSync(out, 'x');
      },
      review: async () => review(['Plan your week', 'OyeChats', 'oyechats.com']),
    });
    assert.equal(report.results[0]?.status, 'budget_stopped');
    assert.equal(report.results[1]?.status, 'accepted');
    assert.equal(report.stoppedBy, undefined);
  } finally {
    ctx.done();
  }
});

test('manifestOf strips the accent markers and shows the plain address', () => {
  assert.deepEqual(manifestOf(post('p', 'Track |tasks|'), brand), { headline: 'Track tasks', brandName: 'OyeChats', domain: 'oyechats.com' });
});

test('with the creative director off (the default), no director call, comparison, side-by-side check or concept memory happens, and each poster is drawn on its own', async () => {
  const ctx = setup();
  try {
    const prompts: string[] = [];
    let touched = 0;
    const forbidden = async (): Promise<never> => { touched += 1; throw new Error('the creative director must not run'); };
    const report = await makeCreatives({
      ai: ctx.ai, brand, brandSlug: 'oyechats', brandDir: join(ctx.dir, 'brand'), outDir: join(ctx.dir, 'out'),
      posts: [post('w01-d1', 'Answers from your own docs'), post('w01-d2', 'Plan your week')], factOf: () => 'OyeChats answers from your own documents.',
      deps: {
        headlineGate: { enabled: false, config: defaultHeadlineGate },
        direct: forbidden,
        lookAlikes: forbidden,
        scene: scene(prompts),
        review: async (file) => review([file.includes('d1') ? 'Answers from your own docs' : 'Plan your week', 'OyeChats', 'oyechats.com']),
      },
    });
    assert.equal(touched, 0);
    assert.deepEqual(report.results.map((r) => r.status), ['accepted', 'accepted']);
    assert.equal(prompts.length, 2, 'one picture each, nothing extra');
    assert.ok(prompts.every((p) => !/THE PICTURE \(follow it/.test(p)), 'no concept was chosen for either poster');
    assert.equal(report.direction, undefined);
    assert.equal(report.lookAlikes, undefined);
    assert.ok(report.results.every((r) => r.concept === undefined));
    assert.equal(existsSync(join(ctx.dir, 'brand', 'creative-history.json')), false, 'no concept memory is written');
    assert.equal(ctx.ledger.calls().length, 0, 'no paid call was made for the director');
  } finally {
    ctx.done();
  }
});

test('the first prompt asks for a sign-off that survives a phone screen, so the first attempt is not rejected for small print', () => {
  const prompt = buildCreativePrompt(manifest, { fact: 'f', colors: { background: '#FFFFFF', ink: '#111111', accent: '#6B3FD4' } });
  assert.match(prompt, /BRAND NAME: "OyeChats", as a clear sign-off in bold or semibold lettering/);
  assert.match(prompt, /at least 4 percent of the poster's height/);
  assert.match(prompt, /WEB ADDRESS: "oyechats\.com", set at the same size and weight as the brand name/);
  assert.doesNotMatch(prompt, /small and secondary|small but clearly legible/);
});

test('without a concept the prompt asks for a picture that is specific to the fact and names the stock scenes to avoid, without offering a menu of styles', () => {
  const prompt = buildCreativePrompt(manifest, { fact: 'OyeChats answers from your own documents.', colors: { background: '#FFFFFF', ink: '#111111', accent: '#6B3FD4' } });
  assert.match(prompt, /THE VISUAL IDEA/);
  assert.match(prompt, /visible, specific relationship to this fact/);
  assert.match(prompt, /people sitting at laptops, floating browser or app windows, targets, megaphones, growth arrows/);
  assert.match(prompt, /only when the fact is actually about one/);
  assert.match(prompt, /do not imply an outcome the fact does not state/);
  assert.match(prompt, /Invent the treatment fresh/);
  // The text contract and the legibility rule are untouched, and no list of allowed visual types is given.
  assert.match(prompt, /TEXT CONTRACT/);
  assert.match(prompt, /LEGIBILITY applies to every treatment/);
  assert.doesNotMatch(prompt, /choose (one )?(of|from) the following|photographic still life|isometric|collage/i);
});

test("with a concept the director's picture is followed and the generic-visual instruction is not added on top of it", () => {
  const prompt = buildCreativePrompt(manifest, { fact: 'f', colors: { background: '#FFFFFF', ink: '#111111', accent: '#6B3FD4' }, concept: { concept: 'A clay key passes across a canyon.', factToPicture: 'It shows access.' } });
  assert.match(prompt, /THE PICTURE \(follow it/);
  assert.doesNotMatch(prompt, /THE VISUAL IDEA/);
});

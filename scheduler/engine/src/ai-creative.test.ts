import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aiConfigFromEnv } from './ai.ts';
import { NETWORK_RULES } from './networks.ts';
import { leanFor, loadTypeHistory } from './type-direction.ts';
import { buildCreativePrompt, displayDomain, judgeCreative, plainHeadline, retryNoteFor, reviewCreative, type CreativeReview, type TextManifest } from './ai-creative.ts';
import { defaultHeadlineGate } from './headline-gate.ts';
import { makeCreatives, manifestOf } from './ai-creative-pipeline.ts';
import type { DirectorResult } from './creative-director.ts';
import { BudgetError, defaultBudgetLimits, PaidLedger } from './paid-ledger.ts';
import { parseWeekPlan, type Brand, type PlannedPost } from './content.ts';

const manifest: TextManifest = { headline: 'Answers from your own docs', brandName: 'OyeChats', domain: 'oyechats.com' };
const clean: CreativeReview['marks'] = { graphicalLogoOrIcon: false, badgeSealAwardOrCertification: false, inventedNumberPriceOrStatistic: false, interfaceOrScreenshotWithText: false, personPresentedAsCustomerOrEndorser: false, flagOrReligiousSymbol: false };
const review = (texts: string[], over: Partial<CreativeReview> = {}): CreativeReview => ({ regions: texts.map((text) => ({ text, readable: true })), marks: { ...clean }, relevance: 2, composition: 2, readableSmall: true, textOverImportantArt: false, people: { present: false, estimatedCount: 0, prominent: false, description: '' }, notes: 'none', ...over });

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

test('text that covers the main artwork rejects it', () => {
  const verdict = judgeCreative(manifest, review(['Answers from your own docs', 'OyeChats', 'oyechats.com'], { textOverImportantArt: true }));
  assert.deepEqual(verdict.defects, [{ kind: 'text_over_art' }]);
  assert.match(retryNoteFor(verdict.defects), /sits on quiet space/);
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
  assert.match(typed, /Do not automatically place the headline at the top or the brand details at the bottom/);
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
    const good = await reviewCreative(ai, image, 'a fact', answer({ regions: [{ text: 'Hi', readable: true }], marks: clean, relevance: 2, composition: 1, readableSmall: true, textOverImportantArt: false, people: { present: false, estimatedCount: 0, prominent: false, description: '' }, notes: 'none' }));
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
    const report = await run(ctx, [post('w01-d1', 'Answers from your |own docs|')], { scene: scene(prompts), review: async () => review(['Answers from your own docs', 'oyechats.com']) });
    assert.equal(report.results[0]?.status, 'accepted');
    assert.equal(report.results[0]?.attempts.length, 1);
    assert.equal(prompts.length, 1);
    assert.equal(readFileSync(report.results[0]?.file as string, 'utf8'), 'picture 1');
    assert.deepEqual(report.results[0]?.manifest, { headline: 'Answers from your own docs', brandName: '', domain: 'oyechats.com' });
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
      review: async (file) => (file.includes('attempt1') ? review(['Answers from your own docs', 'oyechats.com', 'Reply sent']) : review(['Answers from your own docs', 'oyechats.com'])),
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

test('a mark that only one reader saw goes to one third reading: cleared it passes, confirmed it is rejected', async () => {
  const ctx = setup();
  try {
    const prompts: string[] = [];
    const thirds: number[] = [];
    const flagged = (reading: number) => (reading === 2 ? review(['Answers from your own docs', 'oyechats.com'], { marks: { ...clean, graphicalLogoOrIcon: true } }) : review(['Answers from your own docs', 'oyechats.com']));
    const cleared = await run(ctx, [post('w01-d1', 'Answers from your own docs')], {
      scene: scene(prompts),
      review: async (_f, _m, reading) => flagged(reading),
      third: async () => { thirds.push(1); return { reading: review(['Answers from your own docs', 'oyechats.com']), cropped: false }; },
    });
    assert.equal(cleared.results[0]?.status, 'accepted');
    assert.equal(thirds.length, 1, 'exactly one third reading');
    assert.deepEqual(cleared.results[0]?.attempts[0]?.adjudication?.cleared, ['mark:graphicalLogoOrIcon']);
    assert.equal(cleared.results[0]?.attempts[0]?.readings.length, 3);
    const confirmed = await run(ctx, [post('w01-d2', 'Answers from your own docs')], {
      scene: scene(prompts),
      review: async (_f, _m, reading) => flagged(reading),
      third: async () => ({ reading: review(['Answers from your own docs', 'oyechats.com'], { marks: { ...clean, graphicalLogoOrIcon: true } }), cropped: true }),
      maxAttempts: 1,
    });
    assert.equal(confirmed.results[1]?.status ?? confirmed.results[0]?.status, 'rejected');
    const last = confirmed.results.at(-1);
    assert.ok(last?.attempts[0]?.defects.some((d) => d.kind === 'forbidden_mark'));
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
      review: async () => review(['Answers from your own docs', 'oyechats.com']),
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
      review: async () => review(['Plan your week', 'oyechats.com']),
    });
    assert.equal(report.results[0]?.status, 'budget_stopped');
    assert.equal(report.results[1]?.status, 'accepted');
    assert.equal(report.stoppedBy, undefined);
  } finally {
    ctx.done();
  }
});

test('manifestOf strips the accent markers and shows the plain address', () => {
  assert.deepEqual(manifestOf(post('p', 'Track |tasks|'), brand), { headline: 'Track tasks', brandName: '', domain: 'oyechats.com' });
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
        review: async (file) => review([file.includes('d1') ? 'Answers from your own docs' : 'Plan your week', 'oyechats.com']),
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

const folks = (present: boolean, prominent: boolean, description = ''): CreativeReview['people'] => ({ present, estimatedCount: present ? 3 : 0, prominent, description });

test('people: a concept with no people and a poster where they are a main part is not the planned poster; small background figures are not a defect', () => {
  const ok = ['Answers from your own docs', 'OyeChats', 'oyechats.com'];
  const big = judgeCreative(manifest, review(ok, { people: folks(true, true, 'two large illustrated colleagues at a desk') }), { people: false });
  assert.deepEqual(big.defects, [{ kind: 'people_plan_mismatch', description: 'two large illustrated colleagues at a desk' }]);
  assert.match(retryNoteFor(big.defects), /showed people prominently.*no people|concept has none/);
  assert.equal(judgeCreative(manifest, review(ok, { people: folks(true, false, 'three tiny figures in the background') }), { people: false }).accepted, true);
  assert.equal(judgeCreative(manifest, review(ok, { people: folks(true, true, 'a presenter') }), { people: true }).accepted, true, 'people that the plan asked for are not a defect');
  assert.equal(judgeCreative(manifest, review(ok, { people: folks(true, true, 'a presenter') })).accepted, true, 'with no plan nothing is compared');
});

test('people: a reading must say what it saw of people, or it is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'creative-'));
  try {
    const image = join(dir, 'a.jpg');
    writeFileSync(image, 'x');
    const ai = aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234', AI_PROVIDER: 'openai' });
    const answer = (people: unknown): typeof fetch => async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ regions: [], marks: clean, relevance: 2, composition: 2, readableSmall: true, textOverImportantArt: false, ...(people === undefined ? {} : { people }), notes: 'none' }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
    await assert.rejects(reviewCreative(ai, image, 'f', answer(undefined)), /No valid response/);
    await assert.rejects(reviewCreative(ai, image, 'f', answer({ present: 'yes' })), /No valid response/);
    const seen = await reviewCreative(ai, image, 'f', answer({ present: false, estimatedCount: 2, prominent: true, description: 'x' }));
    assert.equal(seen.people.prominent, false, 'prominent without presence is not prominent');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('people in the pipeline: a mismatch with small figures is a warning, and a batch with too many prominent people loses the later posters', async () => {
  const { observedPeople } = await import('./ai-creative-pipeline.ts');
  assert.deepEqual(observedPeople([review(['x'])]), { observed: 'none', description: '' });
  assert.equal(observedPeople([review(['x'], { people: folks(true, false, 'tiny') }), review(['x'])]).observed, 'background');
  assert.equal(observedPeople([review(['x'], { people: folks(true, false, 'tiny') }), review(['x'], { people: folks(true, true, 'big') })]).observed, 'prominent');
  const ctx = setup();
  try {
    const prompts: string[] = [];
    const out = ['Answers from your own docs', 'oyechats.com'];
    const report = await makeCreatives({
      ai: ctx.ai, brand, brandSlug: 'oyechats', outDir: join(ctx.dir, 'out'), peopleCap: 1, directorEnabled: true, factOf: () => 'f',
      posts: [post('p1', 'Answers from your own docs'), post('p2', 'Answers from your own docs'), post('p3', 'Answers from your own docs')],
      deps: {
        direct: async (ps) => ({ concepts: ps.map((p, i) => ({ postId: p.id, concept: CONCEPTS[i] as string, people: i === 0, factToPicture: 'It shows the fact as an idea.', typography: 'Set it large at the top left.', replans: 0 })), dropped: [], flags: [] }),
        lookAlikes: async () => ({ scenes: [], typography: [] }),
        scene: scene(prompts),
        // p1 is planned with people and shows them; p2 shows people prominently although it was planned without (a mismatch that both readers see: a retry); p3 has small background figures.
        review: async (file) => review(out, { people: file.includes('p3.') ? folks(true, false, 'three tiny figures in the background') : file.includes('attempt2') && file.includes('p2.') ? folks(false, false) : folks(true, true, 'two large colleagues') }),
        third: async () => { throw new Error('no third reading expected'); },
      },
    });
    const [p1, p2, p3] = report.results;
    assert.equal(p1?.status, 'accepted');
    assert.equal(p2?.attempts.length, 2, 'the mismatch asked for a second picture');
    assert.match(p2?.attempts[0]?.defects.map((d) => d.kind).join(' ') ?? '', /people_plan_mismatch/);
    assert.equal(p2?.status, 'accepted');
    assert.equal(p3?.status, 'accepted');
    assert.deepEqual(p3?.people, { planned: false, observed: 'background', description: 'three tiny figures in the background' });
    assert.match((p3?.attempts[0]?.warnings ?? []).join(' '), /PEOPLE_PLAN_MISMATCH/);
    assert.deepEqual(report.peopleRule, { cap: 1, prominent: ['p1'] });
  } finally {
    ctx.done();
  }
});

test('people in the pipeline: more prominent people than the batch may have rejects the later poster', async () => {
  const ctx = setup();
  try {
    const out = ['Answers from your own docs', 'oyechats.com'];
    const report = await makeCreatives({
      ai: ctx.ai, brand, brandSlug: 'oyechats', outDir: join(ctx.dir, 'out'), peopleCap: 1, directorEnabled: true, factOf: () => 'f',
      posts: [post('p1', 'Answers from your own docs'), post('p2', 'Answers from your own docs')],
      deps: {
        direct: async (ps) => ({ concepts: ps.map((p, i) => ({ postId: p.id, concept: CONCEPTS[i] as string, people: true, factToPicture: 'It shows the fact as an idea.', typography: 'Set it large at the top left.', replans: 0 })), dropped: [], flags: [] }),
        lookAlikes: async () => ({ scenes: [], typography: [] }),
        scene: scene([]),
        review: async () => review(out, { people: folks(true, true, 'a presenter') }),
      },
    });
    assert.deepEqual(report.results.map((r) => r.status), ['accepted', 'rejected']);
    assert.match(report.results[1]?.reason ?? '', /too many posters of this batch show people prominently \(2, at most 1\)/);
    assert.equal(report.results[1]?.file, undefined);
  } finally {
    ctx.done();
  }
});

test('a business named after its own address: the name and the address together are accepted, one alone or three are not, and it is the same for any such business', () => {
  const same: TextManifest = { headline: 'How can B2B companies earn trust?', brandName: 'Fynix Digital', domain: 'fynix.digital' };
  assert.equal(judgeCreative(same, review(['How can', 'B2B companies earn trust?', 'Fynix Digital', 'fynix.digital'])).accepted, true);
  const onlyOne = judgeCreative(same, review(['How can B2B companies earn trust?', 'fynix.digital']));
  assert.deepEqual(onlyOne.defects.map((d) => d.kind), ['missing_text']);
  const three = judgeCreative(same, review(['How can B2B companies earn trust?', 'Fynix Digital', 'fynix.digital', 'Fynix Digital']));
  assert.deepEqual(three.defects.map((d) => d.kind), ['repeated_text']);
  assert.ok(!judgeCreative(same, review(['How can B2B companies earn trust?', 'Fynix Digital', 'fynix.digital', 'Free quote'])).accepted, 'other text is still extra');
  // When the headline already names the business, the address alone is enough, and the name may also be shown.
  const named: TextManifest = { headline: 'Why Fynix Digital earns trust', brandName: 'Fynix Digital', domain: 'fynix.digital' };
  assert.equal(judgeCreative(named, review(['Why Fynix Digital earns trust', 'fynix.digital'])).accepted, true);
  assert.equal(judgeCreative(named, review(['Why Fynix Digital earns trust', 'Fynix Digital', 'fynix.digital'])).accepted, true);
  assert.deepEqual(judgeCreative(named, review(['Why Fynix Digital earns trust'])).defects.map((d) => d.kind), ['missing_text']);
});

test('a business named after its own address: the name shown twice with no address is rejected, and the address twice with no name is too', () => {
  const same: TextManifest = { headline: 'How can B2B companies earn trust?', brandName: 'Fynix Digital', domain: 'fynix.digital' };
  const nameTwice = judgeCreative(same, review(['How can B2B companies earn trust?', 'Fynix Digital', 'Fynix Digital']));
  assert.deepEqual(nameTwice.defects.map((d) => [d.kind, (d as { text?: string }).text]), [['missing_text', 'the web address'], ['repeated_text', 'the brand name']]);
  const addressTwice = judgeCreative(same, review(['How can B2B companies earn trust?', 'fynix.digital', 'fynix.digital']));
  assert.deepEqual(addressTwice.defects.map((d) => [d.kind, (d as { text?: string }).text]), [['repeated_text', 'the web address'], ['missing_text', 'the brand name']]);
  // A sign-off the reader returns as one line shows both; only the total can be counted then.
  assert.equal(judgeCreative(same, review(['How can B2B companies earn trust?', 'Fynix Digital fynix.digital'])).accepted, true);
  assert.equal(judgeCreative(same, review(['How can B2B companies earn trust?', 'fynix.digital'])).accepted, false, 'one piece of text cannot be both');
});


// ---- The real logo: what is drawn, what is left to the logo, and what is checked

const logoManifest: TextManifest = { ...manifest, brandSignoff: 'logo' };

test('with a full logo the prompt leaves a calm upper corner and does not ask for the brand name; with a symbol alone the name stays; with no logo nothing changes', () => {
  const context = { fact: 'a fact', colors: { background: '#fff', ink: '#111', accent: '#63d' } };
  const wordmark = buildCreativePrompt(logoManifest, { ...context, logo: 'wordmark' });
  assert.match(wordmark, /LOGO SPACE.*upper corners/s);
  assert.doesNotMatch(wordmark, /BRAND NAME/);
  assert.match(wordmark, /brand name is not part of the text/i);
  assert.match(wordmark, /2\. WEB ADDRESS: "oyechats\.com"/, 'the web address is the second text once the name is not drawn');
  const symbol = buildCreativePrompt(manifest, { ...context, logo: 'symbol' });
  assert.match(symbol, /LOGO SPACE/);
  assert.match(symbol, /BRAND NAME: "OyeChats"/, 'a symbol does not carry the name, so the name is drawn');
  const plain = buildCreativePrompt(manifest, context);
  assert.doesNotMatch(plain, /LOGO SPACE/);
  assert.match(plain, /BRAND NAME: "OyeChats"/);
});

test('with a full logo the poster must not draw the brand name again, and the headline may still name it', () => {
  assert.deepEqual(judgeCreative(logoManifest, review(['Answers from your own docs', 'oyechats.com'])), { accepted: true, defects: [] });
  const doubled = judgeCreative(logoManifest, review(['Answers from your own docs', 'OyeChats', 'oyechats.com']));
  assert.equal(doubled.accepted, false);
  assert.deepEqual(doubled.defects, [{ kind: 'extra_text', text: 'oyechats' }], 'a drawn name beside the logo is text that was not asked for');
  const named = { ...logoManifest, headline: 'OyeChats answers from your docs' };
  assert.equal(judgeCreative(named, review(['OyeChats answers from your docs', 'oyechats.com'])).accepted, true, 'the name inside the approved headline is the headline\'s own');
  assert.equal(judgeCreative(named, review(['OyeChats answers from your docs', 'OyeChats', 'oyechats.com'])).accepted, false, 'but a second, separate name is not');
  assert.ok(judgeCreative(logoManifest, review(['Answers from your own docs'])).defects.some((d) => d.kind === 'missing_text' && d.text === 'the web address'));
  const fynix: TextManifest = { headline: 'Grow with search', brandName: 'Fynix Digital', domain: 'fynix.digital', brandSignoff: 'logo' };
  assert.equal(judgeCreative(fynix, review(['Grow with search', 'fynix.digital'])).accepted, true);
  assert.equal(judgeCreative(fynix, review(['Grow with search', 'Fynix Digital', 'fynix.digital'])).accepted, false, 'a business named after its address cannot hide a drawn name behind the address');
});

const placement = (over: Partial<import('./logo-compositor.ts').Placement> = {}): import('./logo-compositor.ts').Placement => ({
  placed: true, logoRect: [740, 60, 200, 50], plateRect: null, plateColor: null, treatment: 'none', haloColor: null, score: 0.9, contrast: 12, logoSha256: 'a'.repeat(64), outputSha256: 'b'.repeat(64), width: 1024, height: 1024, considered: 100, bestScores: [0.9], ...over,
});
const logoInput = { path: '/frozen/logo.png', kind: 'wordmark' as const, sha256: 'a'.repeat(64) };
const withLogo = (ctx: ReturnType<typeof setup>, posts: PlannedPost[], deps: Parameters<typeof makeCreatives>[0]['deps'], logo: typeof logoInput = logoInput) =>
  makeCreatives({ ai: ctx.ai, brand, brandSlug: 'oyechats', posts, factOf: () => 'OyeChats answers from your own documents.', outDir: join(ctx.dir, 'out'), logo, deps: { direct: directed, lookAlikes: async () => ({ scenes: [], typography: [] }), ...deps } });
const boxed = (texts: string[]): CreativeReview => review(texts, { regions: texts.map((text, i) => ({ text, readable: true, box: [50, 50 + i * 100, 500, 120 + i * 100] as [number, number, number, number] })) });

test('an accepted poster gets the real logo: the logo-free picture is kept as the attempt, the poster carries the logo, and its place is recorded', async () => {
  const ctx = setup();
  try {
    const prompts: string[] = [];
    const placed: Array<{ avoid: unknown; kind: string; sha: string | undefined }> = [];
    const report = await withLogo(ctx, [post('w01-d1', 'Answers from your own docs')], {
      scene: scene(prompts),
      review: async () => boxed(['Answers from your own docs', 'oyechats.com']),
      place: async (input) => { placed.push({ avoid: input.avoid, kind: input.logoKind, sha: input.expectedLogoSha256 }); writeFileSync(input.outPath, 'poster with logo'); return placement(); },
    });
    const result = report.results[0];
    assert.equal(result?.status, 'accepted');
    assert.equal(readFileSync(result?.file as string, 'utf8'), 'poster with logo');
    assert.equal(readFileSync(result?.attempts[0]?.imageFile as string, 'utf8'), 'picture 1', 'the picture the model drew is not overwritten');
    assert.deepEqual(result?.logo, { corner: 'top-right', treatment: 'none', logoRect: [740, 60, 200, 50], contrast: 12, logoSha256: 'a'.repeat(64), outputSha256: 'b'.repeat(64) });
    assert.equal(result?.manifest.brandSignoff, 'logo');
    assert.match(prompts[0] ?? '', /LOGO SPACE/);
    assert.deepEqual(placed[0]?.avoid, [[51, 51, 512, 123], [51, 154, 512, 225], [51, 51, 512, 123], [51, 154, 512, 225]], 'every piece of text either reading found is kept clear, in the poster\'s pixels');
    assert.deepEqual([placed[0]?.kind, placed[0]?.sha], ['wordmark', 'a'.repeat(64)]);
  } finally {
    ctx.done();
  }
});

test('when no corner is calm the poster is drawn once more with that asked for, and a second failure drops it', async () => {
  const ctx = setup();
  try {
    const prompts: string[] = [];
    let calls = 0;
    const refuse = async (): Promise<import('./logo-compositor.ts').PlacementFailure> => ({ placed: false, reason: 'NO_SAFE_PLACEMENT', detail: 'no place on the poster was quiet and clear enough' });
    const second = await withLogo(ctx, [post('w01-d1', 'Answers from your own docs')], {
      scene: scene(prompts), review: async () => boxed(['Answers from your own docs', 'oyechats.com']),
      place: async (input) => { calls += 1; if (calls === 1) return refuse(); writeFileSync(input.outPath, 'poster with logo'); return placement(); },
    });
    assert.equal(second.results[0]?.status, 'accepted');
    assert.equal(second.results[0]?.attempts.length, 2);
    assert.match(prompts[1] ?? '', /CORRECTION.*calm corner/is);
    assert.ok(second.results[0]?.attempts[0]?.warnings?.some((w) => w.startsWith('NO_SAFE_LOGO_PLACEMENT')));

    const ctx2 = setup();
    try {
      const failed = await withLogo(ctx2, [post('w01-d1', 'Answers from your own docs')], { scene: scene([]), review: async () => boxed(['Answers from your own docs', 'oyechats.com']), place: refuse });
      assert.equal(failed.results[0]?.status, 'rejected');
      assert.equal(failed.results[0]?.file, undefined);
      assert.equal(failed.results[0]?.logo, undefined);
      assert.match(failed.results[0]?.reason ?? '', /calm corner/);
    } finally {
      ctx2.done();
    }
  } finally {
    ctx.done();
  }
});

test('text the readers could not place means no place can be called clear of it, and a changed logo file fails the poster without another picture', async () => {
  const ctx = setup();
  try {
    let asked = 0;
    const unplaced = await withLogo(ctx, [post('w01-d1', 'Answers from your own docs')], {
      scene: scene([]), review: async () => review(['Answers from your own docs', 'oyechats.com']),
      place: async () => { asked += 1; return placement(); },
    });
    assert.equal(asked, 0, 'the compositor is never asked when a piece of text has no known place');
    assert.equal(unplaced.results[0]?.status, 'rejected');

    const ctx2 = setup();
    try {
      const prompts: string[] = [];
      const changed = await withLogo(ctx2, [post('w01-d1', 'Answers from your own docs')], {
        scene: scene(prompts), review: async () => boxed(['Answers from your own docs', 'oyechats.com']),
        place: async () => ({ placed: false, reason: 'LOGO_CHANGED', detail: 'the logo file is not the one that was checked and kept' }),
      });
      assert.equal(changed.results[0]?.status, 'failed');
      assert.equal(prompts.length, 1, 'a different picture would not fix a changed logo');
      assert.match(changed.results[0]?.reason ?? '', /real logo could not be put/);
    } finally {
      ctx2.done();
    }
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

test('a symbol alone keeps the drawn name; the brand sign-off is only dropped for a full logo', () => {
  assert.equal(manifestOf(post('p', 'Hello there'), brand, { ...logoInput, kind: 'wordmark' }).brandSignoff, 'logo');
  assert.equal(manifestOf(post('p', 'Hello there'), brand, { ...logoInput, kind: 'symbol' }).brandSignoff, undefined);
  assert.equal(manifestOf(post('p', 'Hello there'), brand).brandSignoff, undefined);
});

test('with the director off, a poster that shows people when the batch is already at its limit is asked to be redrawn without them, not thrown away after it was paid for', async () => {
  const ctx = setup();
  try {
    const prompts: string[] = [];
    const report = await makeCreatives({
      ai: ctx.ai, brand, brandSlug: 'oyechats', outDir: join(ctx.dir, 'out'), peopleCap: 1, factOf: () => 'OyeChats answers from your own documents.',
      posts: [post('p1', 'Answers from your own docs'), post('p2', 'Plan your week')],
      deps: {
        headlineGate: { enabled: false, config: defaultHeadlineGate },
        scene: scene(prompts),
        // Both posters first show people prominently; the second, drawn again after the note, shows none.
        review: async (file) => review([file.includes('p1') ? 'Answers from your own docs' : 'Plan your week', 'oyechats.com'], { people: file.includes('p2') && file.includes('attempt2') ? folks(false, false) : folks(true, true, 'a person at a desk') }),
        third: async () => { throw new Error('no third reading expected'); },
      },
    });
    const [p1, p2] = report.results;
    assert.equal(p1?.status, 'accepted');
    assert.equal(p1?.attempts.length, 1);
    assert.equal(p2?.attempts.length, 2, 'the second poster was redrawn once');
    assert.match(p2?.attempts[0]?.defects.map((d) => d.kind).join(' ') ?? '', /people_plan_mismatch/);
    assert.equal(p2?.status, 'accepted');
    assert.deepEqual(report.peopleRule, { cap: 1, prominent: ['p1'] });
  } finally {
    ctx.done();
  }
});

test('a wide run asks the picture model for the wide size and the prompt for a wide frame; a square run is as before', async () => {
  const ctx = setup();
  try {
    const seen: Array<{ prompt: string; width: number; height: number }> = [];
    const draw = (shape: { shape: 'square' | 'wide'; width: number; height: number }) => makeCreatives({
      ai: ctx.ai, brand, brandSlug: 'oyechats', outDir: join(ctx.dir, `out-${shape.shape}`), shape, factOf: () => 'OyeChats answers from your own documents.',
      posts: [post('p1', 'Answers from your own docs')],
      deps: {
        headlineGate: { enabled: false, config: defaultHeadlineGate },
        scene: async (prompt, out, s) => { seen.push({ prompt, width: s.width, height: s.height }); writeFileSync(out, 'x'); },
        review: async () => review(['Answers from your own docs', 'oyechats.com']),
      },
    });
    const square = await draw({ shape: 'square', width: 1024, height: 1024 });
    const wide = await draw({ shape: 'wide', width: 1536, height: 1024 });
    assert.equal(square.results[0]?.status, 'accepted');
    assert.equal(wide.results[0]?.status, 'accepted');
    assert.deepEqual(seen.map((s) => [s.width, s.height]), [[1024, 1024], [1536, 1024]]);
    assert.match(seen[0]?.prompt ?? '', /square \(1:1\)/);
    assert.match(seen[1]?.prompt ?? '', /wide landscape \(3:2/);
    assert.doesNotMatch(seen[1]?.prompt ?? '', /square \(1:1\)/);
  } finally {
    ctx.done();
  }
});

test('each network a post is drawn for gets its own composition, told apart in the prompt, and its own ledger id; the facts and the text contract stay the same', async () => {
  const ctx = setup();
  try {
    const seen: string[] = [];
    const ids: string[] = [];
    const draw = async (network: 'instagram' | 'facebook' | 'linkedin' | 'google') => {
      const shape = NETWORK_RULES[network].picture;
      await makeCreatives({
        ai: ctx.ai, brand, brandSlug: 'oyechats', outDir: join(ctx.dir, `out-${network}`), shape, network, factOf: () => 'OyeChats answers from your own documents.',
        posts: [post('p1', 'Answers from your own docs')],
        deps: {
          headlineGate: { enabled: false, config: defaultHeadlineGate },
          scene: async (prompt, out) => { seen.push(prompt); ids.push(ctx.ai.usage.post ?? ''); writeFileSync(out, 'x'); },
          review: async () => review(['Answers from your own docs', 'oyechats.com']),
        },
      });
    };
    for (const network of ['instagram', 'facebook', 'google', 'linkedin'] as const) await draw(network);
    assert.equal(new Set(seen).size, 4, 'four different prompts');
    const compositions = seen.map((p) => /COMPOSITION FOR THIS VERSION\. ([^\n]+)/.exec(p)?.[1]);
    assert.equal(compositions.every((c) => typeof c === 'string' && c.length > 20), true);
    assert.equal(new Set(compositions).size, 4, 'each network is told a different composition');
    for (const prompt of seen) {
      assert.match(prompt, /HEADLINE: "Answers from your own docs"/);
      assert.match(prompt, /OyeChats answers from your own documents\./);
      assert.match(prompt, /different network/);
      assert.match(prompt, /about what the brand does and who it is for.*Never an unrelated subject/);
    }
    assert.deepEqual(ids, ['oyechats-p1-instagram', 'oyechats-p1-facebook', 'oyechats-p1-google', 'oyechats-p1-linkedin']);
    assert.match(seen[3] ?? '', /wide landscape \(3:2/);
  } finally {
    ctx.done();
  }
});

test('a picture drawn again because it looked like another network\'s is told so in its first prompt, and an ordinary run is not', async () => {
  const ctx = setup();
  try {
    const seen: string[] = [];
    const run = (startNote?: string) => makeCreatives({
      ai: ctx.ai, brand, brandSlug: 'oyechats', outDir: join(ctx.dir, `out-${seen.length}`), network: 'facebook', factOf: () => 'OyeChats answers from your own documents.', ...(startNote ? { startNote } : {}),
      posts: [post('p1', 'Answers from your own docs')],
      deps: { headlineGate: { enabled: false, config: defaultHeadlineGate }, scene: async (prompt, out) => { seen.push(prompt); writeFileSync(out, 'x'); }, review: async () => review(['Answers from your own docs', 'oyechats.com']) },
    });
    await run();
    await run('The first picture for this network looked too much like the picture made for instagram. Choose a clearly different scene.');
    assert.doesNotMatch(seen[0] ?? '', /looked too much like/);
    assert.match(seen[1] ?? '', /looked too much like the picture made for instagram/);
  } finally {
    ctx.done();
  }
});

test('each network picture is nudged towards a headline look of its own and asked for an original typographic voice; the report records it; a plain post or a switched-off setting asks for none', async () => {
  const ctx = setup();
  const before = process.env['HEADLINE_STYLES_ENABLED'];
  try {
    const seen: string[] = [];
    const draw = async (network: 'instagram' | 'facebook' | 'linkedin' | 'google' | undefined, brandDir?: string) => makeCreatives({
      ai: ctx.ai, brand, brandSlug: 'oyechats', ...(brandDir ? { brandDir } : {}), outDir: join(ctx.dir, `out-${network ?? 'plain'}-${seen.length}`), ...(network ? { shape: NETWORK_RULES[network].picture, network } : {}), factOf: () => 'OyeChats answers from your own documents.',
      posts: [post('p1', 'Answers from your own docs')],
      deps: { headlineGate: { enabled: false, config: defaultHeadlineGate }, scene: async (prompt, out) => { seen.push(prompt); writeFileSync(out, 'x'); }, review: async () => review(['Answers from your own docs', 'oyechats.com']) },
    });
    delete process.env['HEADLINE_STYLES_ENABLED'];
    const brandDir = join(ctx.dir, 'brandmemory');
    const reports = [];
    for (const network of ['instagram', 'facebook', 'linkedin', 'google'] as const) reports.push(await draw(network, brandDir));
    const leans = seen.map((p) => /lean strongly towards a (\w+) weight, a ([\w -]+?) character and a (\w+) attitude, with ([^,]+?)(?:,| unless)/.exec(p)?.slice(1, 5).join('/'));
    assert.equal(leans.every((l) => typeof l === 'string'), true);
    assert.equal(new Set(leans).size, 4, 'four different leans');
    for (const prompt of seen) {
      assert.match(prompt, /TYPOGRAPHIC VOICE\. Invent an original typographic voice/);
      assert.match(prompt, /HEADLINE: "Answers from your own docs"/);
    }
    assert.deepEqual(reports.map((r) => r.results[0]?.typeLean), ['instagram', 'facebook', 'linkedin', 'google'].map((n) => leanFor('p1', n as 'instagram')));
    const remembered = await loadTypeHistory(brandDir);
    assert.equal(remembered.length, 4, 'the brand remembers the four looks it asked for');
    // A plain post (no network) keeps the model's own choice and adds nothing to the memory.
    await draw(undefined, brandDir);
    assert.doesNotMatch(seen.at(-1) ?? '', /TYPOGRAPHIC VOICE/);
    assert.equal((await loadTypeHistory(brandDir)).length, 4);
    // Switched off: no direction, nothing recorded.
    process.env['HEADLINE_STYLES_ENABLED'] = 'false';
    const off = await draw('instagram', brandDir);
    assert.doesNotMatch(seen.at(-1) ?? '', /TYPOGRAPHIC VOICE/);
    assert.equal(off.results[0]?.typeLean, undefined);
  } finally {
    if (before === undefined) delete process.env['HEADLINE_STYLES_ENABLED']; else process.env['HEADLINE_STYLES_ENABLED'] = before;
    ctx.done();
  }
});

test('a brand does not get the same headline look twice in a row: the second draw of the same post steers clear of what the first asked for', async () => {
  const ctx = setup();
  const before = process.env['HEADLINE_STYLES_ENABLED'];
  try {
    delete process.env['HEADLINE_STYLES_ENABLED'];
    const brandDir = join(ctx.dir, 'brandmemory2');
    const looks: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      await makeCreatives({
        ai: ctx.ai, brand, brandSlug: 'oyechats', brandDir, outDir: join(ctx.dir, `again-${i}`), shape: NETWORK_RULES.instagram.picture, network: 'instagram', factOf: () => 'OyeChats answers from your own documents.',
        posts: [post('p1', 'Answers from your own docs')],
        deps: { headlineGate: { enabled: false, config: defaultHeadlineGate }, scene: async (prompt, out) => { looks.push(/lean strongly towards a (\w+) weight, a ([\w -]+?) character and a (\w+) attitude, with ([^,]+?)(?:,| unless)/.exec(prompt)?.slice(1, 5).join('/') ?? ''); writeFileSync(out, 'x'); }, review: async () => review(['Answers from your own docs', 'oyechats.com']) },
      });
    }
    assert.equal(looks.length, 2);
    assert.notEqual(looks[0], looks[1]);
  } finally {
    if (before === undefined) delete process.env['HEADLINE_STYLES_ENABLED']; else process.env['HEADLINE_STYLES_ENABLED'] = before;
    ctx.done();
  }
});

test('the creative director\'s own typography plan wins: no second typographic voice is added', () => {
  const manifest = { headline: 'Answers', brandName: '', domain: '' } as TextManifest;
  const base = { fact: 'f', colors: { background: '#fff', ink: '#000', accent: '#f00' }, network: 'instagram' as const, typeLean: { weight: 'bold', character: 'geometric', attitude: 'warm', colour: 'light lettering on a dark area of the picture' } };
  assert.match(buildCreativePrompt(manifest, base), /TYPOGRAPHIC VOICE/);
  assert.doesNotMatch(buildCreativePrompt(manifest, { ...base, concept: { concept: 'c', factToPicture: 'x', typography: 'Huge words across the whole poster.' } }), /TYPOGRAPHIC VOICE/);
});

test('a poster drawn with no network is as before: no version line and the old ledger id', async () => {
  const ctx = setup();
  try {
    const seen: string[] = [];
    const ids: string[] = [];
    await makeCreatives({
      ai: ctx.ai, brand, brandSlug: 'oyechats', outDir: join(ctx.dir, 'plain'), factOf: () => 'OyeChats answers from your own documents.',
      posts: [post('p1', 'Answers from your own docs')],
      deps: {
        headlineGate: { enabled: false, config: defaultHeadlineGate },
        scene: async (prompt, out) => { seen.push(prompt); ids.push(ctx.ai.usage.post ?? ''); writeFileSync(out, 'x'); },
        review: async () => review(['Answers from your own docs', 'oyechats.com']),
      },
    });
    assert.doesNotMatch(seen[0] ?? '', /COMPOSITION FOR THIS VERSION/);
    assert.deepEqual(ids, ['oyechats-p1']);
  } finally {
    ctx.done();
  }
});

test('manifestOf draws the owner\'s sign-off wording when one was chosen, else the brand\'s name and the website\'s address', () => {
  const chosen = { ...post('p', 'Track |tasks|'), signoff: { brandName: 'Oye Chats', domain: 'oyechats.com/pricing' } };
  assert.deepEqual(manifestOf(chosen, brand), { headline: 'Track tasks', brandName: 'Oye Chats', domain: 'oyechats.com/pricing' });
  assert.deepEqual(manifestOf({ ...chosen, signoff: { brandName: 'Oye Chats' } }, brand), { headline: 'Track tasks', brandName: 'Oye Chats', domain: 'oyechats.com' });
});

test('a poster is judged against the sign-off the owner chose: the edited text passes, the old default no longer does, and no sign-off at all is rejected', () => {
  const chosen = manifestOf({ ...post('p', 'Track tasks'), signoff: { brandName: 'Oye Chats Pro', domain: 'oyechats.com/pricing' } }, brand);
  assert.equal(judgeCreative(chosen, review(['Track tasks', 'Oye Chats Pro', 'oyechats.com/pricing'])).accepted, true);
  assert.equal(judgeCreative(chosen, review(['Track tasks', 'OyeChats', 'oyechats.com'])).accepted, false, 'the old wording is not what was chosen');
  const plain = manifestOf(post('p', 'Track tasks'), brand);
  assert.equal(judgeCreative(plain, review(['Track tasks'])).defects.filter((d) => d.kind === 'missing_text').map((d) => d.text).join(', '), 'the web address', 'with no sign-off typed, only the address is required');
});

test('a poster whose owner left the brand name and web address off is asked for, and judged on, the headline alone', () => {
  const bare = manifestOf({ ...post('p', 'Track |tasks|'), signoff: { brandName: '', domain: '' } }, brand);
  assert.deepEqual(bare, { headline: 'Track tasks', brandName: '', domain: '' });
  const prompt = buildCreativePrompt(bare, { fact: 'f', colors: { background: '#fff', ink: '#000', accent: '#f00' } });
  assert.match(prompt, /1\. HEADLINE: "Track tasks"/);
  assert.doesNotMatch(prompt, /BRAND NAME:|WEB ADDRESS:/);
  assert.match(prompt, /The brand name is not part of the text on this poster\. Do not write the brand name anywhere/);
  assert.match(prompt, /No web address is part of the text on this poster\. Do not write a web address/);
  assert.equal(judgeCreative(bare, review(['Track tasks'])).accepted, true, 'the headline alone is the whole poster');
  assert.deepEqual(judgeCreative(bare, review(['Track tasks', 'OyeChats', 'oyechats.com'])).defects, [{ kind: 'extra_text', text: 'oyechats oyechats com' }], 'a name or address that was left off must not appear');
});

test('leaving off only one of the two keeps the other required and renumbers the contract', () => {
  const noName = manifestOf({ ...post('p', 'Track tasks'), signoff: { brandName: '' } }, brand);
  const promptNoName = buildCreativePrompt(noName, { fact: 'f', colors: { background: '#fff', ink: '#000', accent: '#f00' } });
  assert.match(promptNoName, /2\. WEB ADDRESS: "oyechats\.com", clearly legible and not tiny/);
  assert.equal(judgeCreative(noName, review(['Track tasks', 'oyechats.com'])).accepted, true);
  assert.ok(judgeCreative(noName, review(['Track tasks'])).defects.some((d) => d.kind === 'missing_text' && d.text === 'the web address'));
  assert.equal(judgeCreative(noName, review(['Track tasks', 'OyeChats', 'oyechats.com'])).accepted, false, 'the name was left off, so it is extra');
  const noAddress = manifestOf({ ...post('p', 'Track tasks'), signoff: { brandName: 'OyeChats', domain: '' } }, brand);
  const promptNoAddress = buildCreativePrompt(noAddress, { fact: 'f', colors: { background: '#fff', ink: '#000', accent: '#f00' } });
  assert.match(promptNoAddress, /2\. BRAND NAME: "OyeChats"/);
  assert.doesNotMatch(promptNoAddress, /WEB ADDRESS:/);
  assert.equal(judgeCreative(noAddress, review(['Track tasks', 'OyeChats'])).accepted, true);
  assert.ok(judgeCreative(noAddress, review(['Track tasks'])).defects.some((d) => d.kind === 'missing_text' && d.text === 'the brand name'));
});

test('the sign-off saved in a plan file reaches the poster request: the file is read, the manifest follows it, and the prompt leaves the lines off', () => {
  // The same path a draw takes: the plan as saved by the review page, read back, then turned into the text the poster is asked for and judged on.
  const saved = { brand: 'oyechats', timezone: '+05:30', posts: [{ id: 'p1', date: '2026-11-04T10:00:00+05:30', painPoint: 'p', mode: 'template', headline: 'Track |tasks|', subline: '', caption: 'c', hashtags: ['#a'], signoff: { brandName: '', domain: '' } }] };
  const read = parseWeekPlan(JSON.parse(JSON.stringify(saved)), 'week-01.json').posts[0] as PlannedPost;
  const bare = manifestOf(read, brand);
  assert.deepEqual(bare, { headline: 'Track tasks', brandName: '', domain: '' });
  assert.doesNotMatch(buildCreativePrompt(bare, { fact: 'f', colors: { background: '#fff', ink: '#000', accent: '#f00' } }), /BRAND NAME:|WEB ADDRESS:/);
  // And a plan with no sign-off still draws the default one: the web address, without the brand's name.
  const plain = parseWeekPlan(JSON.parse(JSON.stringify({ ...saved, posts: [{ ...saved.posts[0], signoff: undefined }] })), 'week-01.json').posts[0] as PlannedPost;
  assert.deepEqual(manifestOf(plain, brand), { headline: 'Track tasks', brandName: '', domain: 'oyechats.com' });
});

test('a draw from a saved plan whose owner left the brand name and web address off asks the picture model for neither and accepts the headline alone', async () => {
  const ctx = setup();
  try {
    const saved = { brand: 'oyechats', timezone: '+05:30', posts: [{ id: 'w01-d1', date: '2026-11-04T10:00:00+05:30', painPoint: 'p', mode: 'template', headline: 'Answers from your |own docs|', subline: '', caption: 'c', hashtags: ['#a'], signoff: { brandName: '', domain: '' } }] };
    const posts = parseWeekPlan(JSON.parse(JSON.stringify(saved)), 'week-01.json').posts;
    const prompts: string[] = [];
    const report = await run(ctx, posts, { scene: scene(prompts), review: async () => review(['Answers from your own docs']) });
    assert.equal(report.results[0]?.status, 'accepted');
    assert.equal(prompts.length, 1);
    assert.match(prompts[0] ?? '', /1\. HEADLINE: "Answers from your own docs"/);
    assert.doesNotMatch(prompts[0] ?? '', /BRAND NAME:|WEB ADDRESS:/);
    assert.deepEqual(report.results[0]?.manifest, { headline: 'Answers from your own docs', brandName: '', domain: '' });
  } finally {
    ctx.done();
  }
});

test('the same draw, when the picture model writes the name and address anyway, is rejected as extra text and retried', async () => {
  const ctx = setup();
  try {
    const saved = { brand: 'oyechats', timezone: '+05:30', posts: [{ id: 'w01-d1', date: '2026-11-04T10:00:00+05:30', painPoint: 'p', mode: 'template', headline: 'Answers from your |own docs|', subline: '', caption: 'c', hashtags: ['#a'], signoff: { brandName: '', domain: '' } }] };
    const posts = parseWeekPlan(JSON.parse(JSON.stringify(saved)), 'week-01.json').posts;
    const prompts: string[] = [];
    const report = await run(ctx, posts, { scene: scene(prompts), review: async (file) => (file.includes('attempt1') ? review(['Answers from your own docs', 'OyeChats', 'oyechats.com']) : review(['Answers from your own docs'])) });
    assert.equal(report.results[0]?.status, 'accepted');
    assert.equal(report.results[0]?.attempts.length, 2);
    assert.equal(report.results[0]?.attempts[0]?.accepted, false);
    assert.match(prompts[1] ?? '', /CORRECTION.*oyechats/is);
  } finally {
    ctx.done();
  }
});

test('a poster\'s sign-off is the web address; the brand\'s name is drawn only when one was typed for that post, and an empty one leaves the line off', () => {
  assert.deepEqual(manifestOf(post('p', 'Track |tasks|'), brand), { headline: 'Track tasks', brandName: '', domain: 'oyechats.com' });
  assert.equal(manifestOf({ ...post('p', 'Hello there'), signoff: { brandName: 'Oye Chats' } }, brand).brandName, 'Oye Chats', 'a name typed on the post is drawn');
  assert.equal(manifestOf({ ...post('p', 'Hello there'), signoff: { brandName: '' } }, brand).brandName, '', 'an empty name on the post leaves it off');
  assert.equal(manifestOf(post('p', 'Hello there'), brand, { ...logoInput, kind: 'wordmark' }).brandSignoff, 'logo', 'the logo is not affected');
});

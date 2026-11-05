import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aiConfigFromEnv } from './ai.ts';
import { decide, decideAfterRepair, parseReview, REVIEW_COST_ESTIMATE_USD, reviewPosters, ReviewBudget, type PosterReview } from './poster-review.ts';

const ai = () => aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-123456' });
const base = { observed: 'A knot of purple cord on a desk.', defects: [] as PosterReview['defects'] };
const scores = (over: Partial<PosterReview['scores']> = {}): PosterReview['scores'] => ({ message: 2, picture: 2, subject: 2, layout: 2, ...over });

test('a poster that scores 2 everywhere is accepted', () => {
  assert.deepEqual(decide({ ...base, scores: scores() }), { action: 'accept' });
});

test('a pictureless poster is judged on message and layout only: no picture is not a failure', () => {
  assert.deepEqual(decide({ ...base, scores: scores({ picture: null, subject: null }) }), { action: 'accept' });
});

test('an irrelevant picture is repaired by dropping it, never by buying another', () => {
  const decision = decide({ ...base, scores: scores({ picture: 0 }), defects: [{ code: 'picture_irrelevant', detail: 'a knot, not routing' }] });
  assert.deepEqual(decision, { action: 'repair', repairs: ['drop_picture'], defects: ['picture_irrelevant'] });
});

test('a button over the subject is a CTA move, a collision is a relayout', () => {
  assert.deepEqual((decide({ ...base, scores: scores({ layout: 1 }), defects: [{ code: 'cta_covers_subject', detail: 'covers the cord end' }] }) as { repairs: string[] }).repairs, ['move_cta']);
  assert.deepEqual((decide({ ...base, scores: scores({ layout: 0 }), defects: [{ code: 'text_overlap', detail: 'headline over logo' }] }) as { repairs: string[] }).repairs, ['relayout']);
});

test('dropping the picture also settles its crop, the button over it and the empty space, so a cropped irrelevant picture needs one repair', () => {
  const decision = decide({
    ...base,
    scores: scores({ picture: 0, subject: 1, layout: 1 }),
    defects: [{ code: 'picture_misleading', detail: '' }, { code: 'subject_cropped', detail: '' }, { code: 'dead_space', detail: '' }, { code: 'cta_covers_subject', detail: '' }],
  });
  assert.deepEqual(decision, { action: 'repair', repairs: ['drop_picture'], defects: ['picture_misleading', 'subject_cropped', 'dead_space', 'cta_covers_subject'] });
});

test('a poster repeating itself loses its subline, with no model call, and can take one more repair', () => {
  const decision = decide({ ...base, scores: scores({ message: 1, layout: 1, picture: null, subject: null }), defects: [{ code: 'copy_repeats_itself', detail: '' }, { code: 'dead_space', detail: '' }] });
  assert.deepEqual((decision as { repairs: string[] }).repairs, ['drop_subline', 'relayout']);
});

test('a weak headline is a note on a picture poster but a discard on a text-only one, and a 0 is always a discard, because rewriting is not automated', () => {
  assert.deepEqual(decide({ ...base, scores: scores({ message: 1 }), defects: [{ code: 'message_unclear', detail: '' }] }), { action: 'accept' });
  assert.equal(decide({ ...base, scores: scores({ message: 1, picture: null, subject: null }), defects: [{ code: 'message_unclear', detail: '' }] }).action, 'discard');
  assert.equal(decide({ ...base, scores: scores({ message: 0, picture: null, subject: null }), defects: [{ code: 'message_unclear', detail: '' }] }).action, 'discard');
});

test('a slightly cropped picture is a note; a picture cut beyond recognition is dropped', () => {
  assert.deepEqual(decide({ ...base, scores: scores({ subject: 1 }), defects: [{ code: 'subject_cropped', detail: '' }] }), { action: 'accept' });
  assert.deepEqual((decide({ ...base, scores: scores({ subject: 0 }), defects: [{ code: 'subject_cropped', detail: '' }] }) as { repairs: string[] }).repairs, ['drop_picture']);
});

test('after the one repair, a critical failure discards and anything else is accepted', () => {
  assert.equal(decideAfterRepair({ ...base, scores: scores({ layout: 1 }) }).action, 'accept');
  assert.equal(decideAfterRepair({ ...base, scores: scores({ picture: 0 }) }).action, 'discard');
  assert.equal(decideAfterRepair({ ...base, scores: scores({ picture: null, subject: null }) }).action, 'accept');
});

test('after the repair, a text-only poster must have a clear message, and a picture poster cannot be so-so on both message and picture', () => {
  assert.equal(decideAfterRepair({ ...base, scores: scores({ message: 1, picture: null, subject: null, layout: 2 }) }).action, 'discard');
  assert.equal(decideAfterRepair({ ...base, scores: scores({ message: 2, picture: null, subject: null, layout: 1 }) }).action, 'accept');
  assert.equal(decideAfterRepair({ ...base, scores: scores({ message: 1, picture: 1 }) }).action, 'discard');
  assert.equal(decideAfterRepair({ ...base, scores: scores({ message: 1, picture: 2 }) }).action, 'accept');
});

test('three kinds of repair, or two critical failures, are discarded instead of patched', () => {
  const three = decide({ ...base, scores: scores({ message: 1, layout: 1 }), defects: [{ code: 'copy_repeats_itself', detail: '' }, { code: 'text_overlap', detail: '' }, { code: 'cta_covers_subject', detail: '' }] });
  assert.equal(three.action, 'discard');
  const twoZeros = decide({ ...base, scores: scores({ message: 0, layout: 0 }), defects: [{ code: 'message_unclear', detail: '' }, { code: 'text_overlap', detail: '' }] });
  assert.equal(twoZeros.action, 'discard');
});

test('the decision comes from the scores and codes, whatever else the model says', () => {
  const parsed = parseReview({ observed: 'x', verdict: 'pass', scores: { message: 2, picture: 0, subject: 2, layout: 2 }, defects: [{ code: 'picture_misleading', detail: 'tangle' }] }, true);
  assert.equal(decide(parsed).action, 'repair');
});

test('parseReview names what is wrong so the corrective retry can fix it', () => {
  assert.throws(() => parseReview({ observed: '', scores: {}, defects: [] }, false), /observed/);
  assert.throws(() => parseReview({ observed: 'x', scores: { message: 2, layout: 2 }, defects: [] }, true), /picture/);
  assert.throws(() => parseReview({ observed: 'x', scores: { message: 1, layout: 2 }, defects: [{ code: 'invented_code', detail: '' }] }, false), /below 2/);
  assert.throws(() => parseReview({ observed: 'x', scores: { message: 5, layout: 2 }, defects: [] }, false), /0, 1 or 2/);
});

test('picture scores are ignored for a pictureless poster', () => {
  const parsed = parseReview({ observed: 'text only', scores: { message: 2, picture: 2, subject: 2, layout: 2 }, defects: [] }, false);
  assert.equal(parsed.scores.picture, null);
  assert.equal(parsed.scores.subject, null);
});

const reply = (content: object, tokens = { prompt_tokens: 1900, completion_tokens: 150 }): Response =>
  new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: tokens }), { status: 200 });

const input = { key: 'p1', imagePath: '/x/p1.jpg', headline: 'Routes to the right department', fact: 'Routes chats to the right department.', hasPicture: true };
const png = async () => Buffer.from('fake-bytes');

test('the poster, the copy and the source fact go to the model as an image message, and the cost is recorded', async () => {
  const config = ai();
  let body: { messages: Array<{ role: string; content: unknown }> } | undefined;
  const fetchFn = (async (_url: string, init: RequestInit) => {
    body = JSON.parse(init.body as string);
    return reply({ observed: 'A purple knot.', scores: { message: 2, picture: 0, subject: 2, layout: 2 }, defects: [{ code: 'picture_misleading', detail: 'a knot reads as tangled' }] });
  }) as unknown as typeof fetch;
  const outcomes = await reviewPosters({ ai: config, posts: [input], budget: new ReviewBudget(config, 0.02), fetchFn, readImage: png });
  const outcome = outcomes.get('p1');
  assert.equal(outcome?.status, 'reviewed');
  assert.equal(outcome?.status === 'reviewed' && outcome.review.decision.action, 'repair');
  const user = body?.messages.find((m) => m.role === 'user');
  assert.ok(Array.isArray(user?.content));
  const parts = user?.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
  assert.ok(parts.some((p) => p.type === 'image_url' && p.image_url?.url.startsWith('data:image/jpeg;base64,')));
  assert.match(parts.find((p) => p.type === 'text')?.text ?? '', /sourceFact/);
  assert.ok(config.usage.summary().totalUsd > 0);
});

test('reviews stop when the budget cannot cover the next one, and the skipped poster is reported, not approved', async () => {
  const config = ai();
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    return reply({ observed: 'ok', scores: { message: 2, picture: 2, subject: 2, layout: 2 }, defects: [] }, { prompt_tokens: 1_000_000, completion_tokens: 0 });
  }) as unknown as typeof fetch;
  const budget = new ReviewBudget(config, 0.1 + REVIEW_COST_ESTIMATE_USD / 2);
  const outcomes = await reviewPosters({ ai: config, posts: [input, { ...input, key: 'p2' }], budget, fetchFn, readImage: png });
  assert.equal(calls, 1);
  assert.equal(outcomes.get('p1')?.status, 'reviewed');
  assert.deepEqual(outcomes.get('p2'), { status: 'skipped', reason: 'budget' });
});

test('a review that cannot be parsed after the corrective retry is reported as failed', async () => {
  const config = ai();
  const fetchFn = (async () => reply({ nonsense: true })) as unknown as typeof fetch;
  const outcomes = await reviewPosters({ ai: config, posts: [input], budget: new ReviewBudget(config, 0.02), fetchFn, readImage: png });
  const outcome = outcomes.get('p1');
  assert.equal(outcome?.status, 'skipped');
  assert.equal(outcome?.status === 'skipped' && outcome.reason, 'failed');
});

test('pictures are never sent to the backup provider', async () => {
  const config = { ...ai(), primary: 'pollinations' as const, fallback: false, pollinationsKey: 'pk-x', openaiKey: undefined };
  const outcomes = await reviewPosters({ ai: config as never, posts: [input], budget: new ReviewBudget(config as never, 0.02), fetchFn: (async () => reply({})) as unknown as typeof fetch, readImage: png });
  const outcome = outcomes.get('p1');
  assert.equal(outcome?.status, 'skipped');
});

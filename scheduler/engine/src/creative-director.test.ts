import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aiConfigFromEnv } from './ai.ts';
import { cosine, flagSimilar, meaningfulWords, wordOverlap } from './concept-similarity.ts';
import { batchLookAlikes, DIRECTOR_SYSTEM, directBatch, inventConcepts, loadConceptHistory, openAiEmbedder, saveConceptHistory, type BatchPost, type CreativeConcept } from './creative-director.ts';
import { makeCreatives } from './ai-creative-pipeline.ts';
import { defaultBudgetLimits, PaidLedger } from './paid-ledger.ts';
import type { Brand, PlannedPost } from './content.ts';

const DOCS = 'Blank paper sheets fold themselves into a dimensional speech bubble on a sunlit wooden table, macro photograph with a shallow depth of field.';
const DOCS_AGAIN = 'Blank paper sheets fold themselves into a dimensional speech bubble on a sunlit wooden desk, macro photograph with shallow depth of field.';
const LINE = 'A single continuous violet line loops across the whole frame and ties itself into a chain of connected bubbles, hand drawn on cream paper.';
const SHOP = 'A cut-paper collage of a shop window at dusk where one lantern is lit and all the others are dark, layered card in deep blues.';
const CLAY = 'A sculpted clay hand passes a glowing key across a canyon between two floating stone platforms, studio lighting, miniature scale.';

test('concepts are compared by the words that say what is pictured, not by art-direction filler', () => {
  assert.ok(wordOverlap(DOCS, DOCS_AGAIN) > 0.7);
  assert.ok(wordOverlap(DOCS, LINE) < 0.15);
  // The same filler around different pictures does not make them alike.
  assert.ok(wordOverlap('A modern, professional, clean, minimal poster showing a lighthouse in warm soft light', 'A modern, professional, clean, minimal poster showing a bakery in warm soft light') < 0.3);
  assert.deepEqual([...meaningfulWords('A modern bold design of the brand', undefined, ['brand'])], ['modern'].filter(() => false));
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
});

test('near-duplicates are flagged within the batch and against history, and history is never compared with itself', () => {
  const flagged = flagSimilar([
    { id: 'p1', concept: DOCS },
    { id: 'p2', concept: DOCS_AGAIN },
    { id: 'p3', concept: LINE },
    { id: 'past-0', concept: SHOP, past: true },
    { id: 'past-1', concept: SHOP, past: true },
  ]);
  assert.deepEqual(flagged.map((f) => [f.a, f.b]), [['p1', 'p2']]);
  const against = flagSimilar([{ id: 'p1', concept: SHOP }, { id: 'past-0', concept: SHOP, past: true }]);
  assert.equal(against[0]?.reason, 'identical');
  const byMeaning = flagSimilar([{ id: 'a', concept: LINE }, { id: 'b', concept: CLAY }], { embeddings: new Map([['a', [1, 0.1]], ['b', [1, 0.12]]]) });
  assert.match(byMeaning[0]?.reason ?? '', /embedding/);
});

const posts: BatchPost[] = [
  { id: 'p1', headline: 'Answers from your own docs', fact: 'Answers come from your documents.' },
  { id: 'p2', headline: 'Keep the conversation in one thread', fact: 'One thread per customer.' },
  { id: 'p3', headline: 'A free plan forever', fact: 'There is a free plan.' },
];
const TYPE_A = 'Headline in a tall condensed grotesque stacked down the left edge in cream, small, with the last word picked out in the lantern orange.';
const TYPE_B = 'Headline set in a heavy rounded face across the bottom third, white on the dark water, filling the width of the frame.';
const TYPE_C = 'Headline in a light serif italic hanging from the top right corner like a sign, tinted the same blue as the card layers.';
const concept = (postId: string, text: string, people = false, typography = [TYPE_A, TYPE_B, TYPE_C][Number(postId.slice(1)) % 3] as string): CreativeConcept => ({ postId, concept: text, people, factToPicture: 'It shows the fact as one idea.', typography });

test('distinct concepts pass at once, with no second call and no flags', async () => {
  let calls = 0;
  const result = await directBatch({ ai: aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234' }), brandName: 'OyeChats', posts, history: [], peopleCap: 1 }, {
    invent: async (ps) => { calls += 1; return ps.map((p, i) => concept(p.id, [DOCS, LINE, SHOP][i] as string)); },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.concepts.map((c) => c.postId), ['p1', 'p2', 'p3']);
  assert.deepEqual(result.dropped, []);
  assert.deepEqual(result.flags, []);
});

test('a concept that repeats another is sent back with the reason and what is already chosen, and the new idea replaces it', async () => {
  const seen: Array<{ ids: string[]; keep: string[]; problems: string[] }> = [];
  const result = await directBatch({ ai: aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234' }), brandName: 'OyeChats', posts, history: [], peopleCap: 1 }, {
    invent: async (ps, keep, problems) => {
      seen.push({ ids: ps.map((p) => p.id), keep: keep.map((k) => k.postId), problems: [...problems] });
      return seen.length === 1 ? [concept('p1', DOCS), concept('p2', DOCS_AGAIN), concept('p3', SHOP)] : ps.map((p) => concept(p.id, CLAY));
    },
  });
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1]?.ids, ['p2'], 'only the later poster of the pair is redone');
  assert.deepEqual(seen[1]?.keep, ['p1', 'p3']);
  assert.match(seen[1]?.problems[0] ?? '', /concept for p2 is too much like the concept for p1/);
  assert.equal(result.concepts.find((c) => c.postId === 'p2')?.concept, CLAY);
  assert.equal(result.concepts.find((c) => c.postId === 'p2')?.replans, 1);
  assert.equal(result.flags[0]?.decision, 'same');
});

test('a concept that repeats the brand history is sent back too, and the history concept is never the one changed', async () => {
  let call = 0;
  const result = await directBatch({ ai: aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234' }), brandName: 'OyeChats', posts: posts.slice(0, 2), history: [DOCS], peopleCap: 1 }, {
    invent: async (ps) => { call += 1; return call === 1 ? [concept('p1', DOCS_AGAIN), concept('p2', LINE)] : ps.map((p) => concept(p.id, SHOP)); },
  });
  assert.equal(call, 2);
  assert.equal(result.concepts[0]?.concept, SHOP);
});

test('a post that still repeats after every round is dropped: fewer posters, never a repeat', async () => {
  const result = await directBatch({ ai: aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234' }), brandName: 'OyeChats', posts: posts.slice(0, 2), history: [], peopleCap: 1 }, {
    invent: async (ps) => ps.map((p) => concept(p.id, p.id === 'p1' ? DOCS : DOCS_AGAIN)),
    maxReplans: 2,
  });
  assert.deepEqual(result.concepts.map((c) => c.postId), ['p1']);
  assert.equal(result.dropped[0]?.postId, 'p2');
});

test('too many posters with people are sent back, and a pair flagged only by meaning goes to a focused comparison', async () => {
  let call = 0;
  const result = await directBatch({ ai: aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234' }), brandName: 'OyeChats', posts, history: [], peopleCap: 1 }, {
    invent: async (ps) => { call += 1; return call === 1 ? [concept('p1', DOCS, true), concept('p2', LINE, true), concept('p3', SHOP, true)] : ps.map((p) => concept(p.id, CLAY, false)); },
  });
  assert.equal(result.concepts.filter((c) => c.people).length, 1);
  let compared = 0;
  const kept = await directBatch({ ai: aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234' }), brandName: 'OyeChats', posts: posts.slice(0, 2), history: [], peopleCap: 1 }, {
    invent: async (ps) => ps.map((p, i) => concept(p.id, [LINE, CLAY][i] as string)),
    embed: async (texts) => texts.map(() => [1, 0.01]),
    sameIdea: async () => { compared += 1; return { same: false, why: 'a line against a hand and a key' }; },
  });
  assert.equal(compared, 1);
  assert.equal(kept.concepts.length, 2);
  assert.equal(kept.flags[0]?.decision, 'different');
});

test('an embedding failure falls back to the words, and an answer that does not fit is rejected', async () => {
  const result = await directBatch({ ai: aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234' }), brandName: 'OyeChats', posts: posts.slice(0, 2), history: [], peopleCap: 1 }, {
    invent: async (ps) => ps.map((p, i) => concept(p.id, [LINE, CLAY][i] as string)),
    embed: async () => { throw new Error('embeddings are down'); },
  });
  assert.equal(result.concepts.length, 2);
  const ai = aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234' });
  const answer = (content: unknown): typeof fetch => async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
  const input = { ai, brandName: 'OyeChats', posts: posts.slice(0, 1), history: [], peopleCap: 1 };
  await assert.rejects(inventConcepts({ ...input, fetchFn: answer({ concepts: [{ postId: 'p1', concept: 'too short', people: false, factToPicture: 'It shows the fact.' }] }) }, posts.slice(0, 1)), /No valid response/);
  await assert.rejects(inventConcepts({ ...input, fetchFn: answer({ concepts: [{ postId: 'nope', concept: DOCS, people: false, factToPicture: 'It shows the fact as an idea.', typography: TYPE_A }] }) }, posts.slice(0, 1)), /No valid response/);
  await assert.rejects(inventConcepts({ ...input, fetchFn: answer({ concepts: [{ postId: 'p1', concept: DOCS, people: false, factToPicture: 'It shows the fact as an idea.' }] }) }, posts.slice(0, 1)), /No valid response/, 'a concept without a typography idea is refused');
  const good = await inventConcepts({ ...input, fetchFn: answer({ concepts: [{ postId: 'p1', concept: DOCS, people: false, factToPicture: 'It shows the fact as an idea.', typography: TYPE_A }] }) }, posts.slice(0, 1));
  assert.equal(good[0]?.concept, DOCS);
  assert.equal(good[0]?.typography, TYPE_A);
});

test('the director is told to invent, not to pick: no list of styles in its instructions, clichés named only to be avoided', () => {
  assert.doesNotMatch(DIRECTOR_SYSTEM, /photographic_still_life|isometric|collage|paper-?cut|taxonomy|one of the following/i);
  assert.match(DIRECTOR_SYSTEM, /Do not name a style category or choose from a list/);
  assert.match(DIRECTOR_SYSTEM, /Avoid the clichés/);
  assert.match(DIRECTOR_SYSTEM, /no writing of any kind/);
});

test('concept memory keeps the newest 40, rejected ones included, and survives a missing file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-'));
  try {
    assert.deepEqual(await loadConceptHistory(dir), []);
    const first = Array.from({ length: 30 }, (_, i) => ({ at: 'a', postId: `x${i}`, concept: `concept ${i}`, people: false, accepted: true }));
    await saveConceptHistory(dir, [], first);
    const second = Array.from({ length: 20 }, (_, i) => ({ at: 'b', postId: `y${i}`, concept: `newer ${i}`, people: false, accepted: i % 2 === 0 }));
    await saveConceptHistory(dir, await loadConceptHistory(dir), second);
    const all = await loadConceptHistory(dir);
    assert.equal(all.length, 40);
    assert.equal(all[0]?.concept, 'newer 0');
    assert.equal(all.some((r) => !r.accepted), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('embeddings are reserved on the ledger first and refused when a cap says so', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'embed-'));
  try {
    const ai = aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234' });
    ai.ledger = new PaidLedger(join(dir, 'l.jsonl'), { ...defaultBudgetLimits, globalDayUsd: 0.0005 }, { jobId: 'j', tenantId: 'o', brandId: 'b' });
    let sent = 0;
    const embed = openAiEmbedder(ai, 'text-embedding-3-small', async () => { sent += 1; return new Response('{}', { status: 200 }); });
    await assert.rejects(embed(['a', 'b']), /limit/);
    assert.equal(sent, 0);
    const ok = new PaidLedger(join(dir, 'l2.jsonl'), defaultBudgetLimits, { jobId: 'j', tenantId: 'o', brandId: 'b' });
    ai.ledger = ok;
    const vectors = await openAiEmbedder(ai, 'text-embedding-3-small', async () => new Response(JSON.stringify({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }], usage: { total_tokens: 20 } }), { status: 200 }))(['a', 'b']);
    assert.deepEqual(vectors, [[1, 0], [0, 1]]);
    assert.equal(ok.calls()[0]?.status, 'completed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the side-by-side check sends every poster once and returns the pairs it names', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'looks-'));
  try {
    const files = ['a', 'b', 'c'].map((n) => { const f = join(dir, `${n}.jpg`); writeFileSync(f, n); return { id: n, file: f }; });
    const ai = aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234' });
    let images = 0;
    const fetchFn: typeof fetch = async (_url, init) => {
      images = (JSON.parse(String(init?.body)) as { messages: Array<{ content: unknown }> }).messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((p: { type?: string }) => p.type === 'image_url').length;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ scenes: [{ a: 'a', b: 'c', why: 'the same desk scene' }], typography: [{ a: 'a', b: 'b', why: 'the same heavy headline at the top' }] }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
    };
    assert.deepEqual(await batchLookAlikes(ai, files, fetchFn), { scenes: [{ a: 'a', b: 'c', why: 'the same desk scene' }], typography: [{ a: 'a', b: 'b', why: 'the same heavy headline at the top' }] });
    assert.equal(images, 3);
    assert.deepEqual(await batchLookAlikes(ai, files.slice(0, 1)), { scenes: [], typography: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Inside the pipeline

const brand = { name: 'OyeChats', website: 'https://www.oyechats.com', colors: { background: '#FFFFFF', ink: '#111111', accent: '#6B3FD4', tile: '#EEEEEE' } } as unknown as Brand;
const planned = (id: string, headline: string): PlannedPost => ({ id, headline }) as unknown as PlannedPost;
const reviewOk = async () => ({ regions: [{ text: 'x', readable: true }], marks: { graphicalLogoOrIcon: false, badgeSealAwardOrCertification: false, inventedNumberPriceOrStatistic: false, interfaceOrScreenshotWithText: false, personPresentedAsCustomerOrEndorser: false, flagOrReligiousSymbol: false }, relevance: 2, composition: 2, readableSmall: true, notes: 'none' });

function ctx(): { dir: string; ai: ReturnType<typeof aiConfigFromEnv>; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pipe-'));
  const ai = aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234', AI_PROVIDER: 'openai' });
  ai.ledger = new PaidLedger(join(dir, 'l.jsonl'), defaultBudgetLimits, { jobId: 'j', tenantId: 'o', brandId: 'oyechats' });
  return { dir, ai, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('each poster is drawn from its own concept, a dropped post buys nothing, and every concept is remembered', async () => {
  const c = ctx();
  try {
    const prompts: string[] = [];
    const report = await makeCreatives({
      ai: c.ai, brand, brandSlug: 'oyechats', brandDir: c.dir, outDir: join(c.dir, 'out'), directorEnabled: true,
      posts: [planned('p1', 'Answers from your own docs'), planned('p2', 'One thread'), planned('p3', 'Free plan')],
      factOf: () => 'a fact',
      deps: {
        direct: async () => ({ concepts: [{ postId: 'p1', concept: DOCS, people: false, factToPicture: 'It shows the fact as an idea.', typography: TYPE_A, replans: 0 }, { postId: 'p3', concept: LINE, people: false, factToPicture: 'It shows the fact as an idea.', typography: TYPE_B, replans: 1 }], dropped: [{ postId: 'p2', reason: 'no distinct idea' }], flags: [] }),
        lookAlikes: async () => ({ scenes: [], typography: [] }),
        scene: async (prompt, out) => { prompts.push(prompt); writeFileSync(out, 'x'); },
        review: async (file) => ({ ...(await reviewOk()), regions: [{ text: file.includes('p1.') ? 'Answers from your own docs OyeChats oyechats.com' : 'Something unrelated', readable: true }] }),
      },
    });
    assert.deepEqual(report.results.map((r) => r.status), ['accepted', 'dropped', 'rejected']);
    assert.equal(prompts.length >= 2, true);
    assert.match(prompts[0] ?? '', /THE PICTURE.*speech bubble/);
    assert.match(prompts.find((p) => p.includes('HEADLINE: "Free plan"')) ?? '', /continuous violet line/);
    assert.equal(report.results[1]?.reason, 'no distinct idea');
    const memory = await loadConceptHistory(c.dir);
    assert.equal(memory.length, 2);
    assert.equal(memory.find((m) => m.postId === 'oyechats-p1')?.accepted, true);
    assert.equal(memory.find((m) => m.postId === 'oyechats-p3')?.accepted, false);
  } finally {
    c.done();
  }
});

test('if the director fails, no picture is bought', async () => {
  const c = ctx();
  try {
    let drawn = 0;
    const report = await makeCreatives({
      ai: c.ai, brand, brandSlug: 'oyechats', outDir: join(c.dir, 'out'), directorEnabled: true, posts: [planned('p1', 'A'), planned('p2', 'B')], factOf: () => 'f',
      deps: { direct: async () => { throw new Error('No valid response'); }, scene: async () => { drawn += 1; } },
    });
    assert.equal(drawn, 0);
    assert.deepEqual(report.results.map((r) => r.status), ['failed', 'failed']);
    assert.match(report.results[0]?.reason ?? '', /creative director could not plan/);
  } finally {
    c.done();
  }
});

test('posters that look alike side by side: the later one is rejected and its file set aside', async () => {
  const c = ctx();
  try {
    const report = await makeCreatives({
      ai: c.ai, brand, brandSlug: 'oyechats', outDir: join(c.dir, 'out'), directorEnabled: true, posts: [planned('p1', 'Answers from your own docs'), planned('p2', 'Answers from your own docs')], factOf: () => 'f',
      deps: {
        direct: async (ps) => ({ concepts: ps.map((p, i) => ({ postId: p.id, concept: [DOCS, LINE][i] as string, people: false, factToPicture: 'It shows the fact as an idea.', typography: TYPE_A, replans: 0 })), dropped: [], flags: [] }),
        scene: async (_p, out) => writeFileSync(out, 'x'),
        review: async () => ({ ...(await reviewOk()), regions: [{ text: 'Answers from your own docs OyeChats oyechats.com', readable: true }] }),
        lookAlikes: async () => ({ scenes: [{ a: 'p1', b: 'p2', why: 'the same desk scene' }], typography: [{ a: 'p1', b: 'p2', why: 'the same heavy headline at the top' }] }),
      },
    });
    assert.deepEqual(report.results.map((r) => r.status), ['accepted', 'rejected']);
    assert.match(report.results[1]?.reason ?? '', /looks like p1: the same desk scene/);
    assert.equal(report.results[1]?.file, undefined);
    assert.match(readFileSync(join(c.dir, 'out', 'p2.rejected.jpg'), 'utf8'), /x/);
    assert.equal(report.lookAlikes?.scenes.length, 1);
    assert.equal(report.lookAlikes?.typography.length, 1, 'typography repeats are recorded, not punished');
    assert.equal(report.results[0]?.status, 'accepted');
  } finally {
    c.done();
  }
});

test('typography that repeats is sent back with the reason, but never drops a post', async () => {
  const SAME = 'Headline in a heavy black sans serif at the top left of the frame, two lines, tight leading, filling half the width.';
  const SAME_AGAIN = 'Headline in a heavy black sans serif at the top left of the frame, two lines, tight leading, filling half of the width.';
  let call = 0;
  const seen: string[][] = [];
  const result = await directBatch({ ai: aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234' }), brandName: 'OyeChats', posts: posts.slice(0, 2), history: [], peopleCap: 1 }, {
    invent: async (ps, _keep, problems) => { call += 1; seen.push([...problems]); return ps.map((p) => concept(p.id, p.id === 'p1' ? DOCS : LINE, false, call === 1 ? (p.id === 'p1' ? SAME : SAME_AGAIN) : TYPE_C)); },
  });
  assert.equal(call, 2);
  assert.match(seen[1]?.[0] ?? '', /typography for p2 is too much like the typography for p1/);
  assert.equal(result.concepts.length, 2);
  assert.equal(result.concepts[1]?.typography, TYPE_C);
  // If it never changes, the post is kept: a repeated headline treatment is a weaker fault than a repeated picture.
  const stubborn = await directBatch({ ai: aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234' }), brandName: 'OyeChats', posts: posts.slice(0, 2), history: [], peopleCap: 1 }, {
    invent: async (ps) => ps.map((p) => concept(p.id, p.id === 'p1' ? DOCS : LINE, false, p.id === 'p1' ? SAME : SAME_AGAIN)),
    maxReplans: 1,
  });
  assert.equal(stubborn.concepts.length, 2);
  assert.deepEqual(stubborn.dropped, []);
});

test('the director is given the brand\'s recent headline treatments, and brand character is built from what the website says', async () => {
  const { brandCharacter } = await import('./ai-creative-pipeline.ts');
  const character = brandCharacter({ name: 'Acme', tone: 'warm and plain-spoken', audience: 'small clinics', offer: 'online booking', font: 'Inter', colors: { accent: '#0E8C8C', ink: '#12303A', background: '#FFFFFF', tile: '#EEE' } } as never);
  assert.match(character, /Tone: warm and plain-spoken\./);
  assert.match(character, /Audience: small clinics\./);
  assert.match(character, /sets text in Inter/);
  let message = '';
  const ai = aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234' });
  await inventConcepts({ ai, brandName: 'Acme', posts: posts.slice(0, 1), history: [], typographyHistory: ['A thin serif headline in the lower right.'], peopleCap: 1, fetchFn: async (_u, init) => { message = String(init?.body); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ concepts: [{ postId: 'p1', concept: DOCS, people: false, factToPicture: 'It shows the fact as an idea.', typography: TYPE_A }] }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 }); } }, posts.slice(0, 1));
  assert.match(message, /TYPOGRAPHY_HISTORY/);
  assert.match(message, /thin serif headline in the lower right/);
});

/**
 * The creative director of a batch. One text call sees every post of the batch at once (its approved headline and verified fact), the brand, and the
 * concepts the brand has already used, and invents one visual concept for each post, in its own words. There is no menu of styles, scenes or layouts:
 * a concept is free text. What is fixed is what keeps the batch honest. Code checks that no two concepts are alike (concept-similarity.ts), that
 * the concepts of a batch do not all show people, and that every concept says how its picture communicates the fact, all BEFORE any picture is bought;
 * a conflict is sent back to the director for a new idea, and a post that still has no distinct, truthful idea is dropped: fewer posters, not repeats.
 * After the pictures are drawn, one vision request compares the finished posters side by side for repeated scenes (batchLookAlikes).
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AiConfig } from './ai.ts';
import { chatJson } from './llm.ts';
import { BudgetError } from './paid-ledger.ts';
import { defaultSimilarityConfig, flagSimilar, type ConceptRef, type FlaggedPair, type SimilarityConfig } from './concept-similarity.ts';

export interface BatchPost {
  id: string;
  headline: string;
  /** The verified fact the post is about. */
  fact: string;
}

export interface CreativeConcept {
  postId: string;
  /** The picture in the director's own words: subject, world, execution, materials, mood, composition, and what makes it unlike the other posters. */
  concept: string;
  /** Whether people are a prominent part of the picture. */
  people: boolean;
  /** One sentence: how the picture communicates the approved fact. */
  factToPicture: string;
  /** How the headline is set, in the director's own words: personality, scale against the picture, weight, letterforms, colour, placement, spacing and how the type interacts with the artwork. It grows out of the concept; it is not chosen from a list. */
  typography: string;
}

export interface DirectorInput {
  ai: AiConfig;
  brandName: string;
  /** What the brand's profile says about its look, as one input among others: the director decides what to do with it. */
  brandLook?: string;
  posts: readonly BatchPost[];
  /** Concepts this brand used recently, newest first. */
  history: readonly string[];
  /** How the headlines of this brand's recent posters were set, newest first. */
  typographyHistory?: readonly string[];
  /** The most posters of the batch that may show people prominently, unless a post's fact is about people. */
  peopleCap: number;
  fetchFn?: typeof fetch;
}

const MIN_CONCEPT_CHARS = 80;
const MIN_TYPOGRAPHY_CHARS = 60;
/** Typography descriptions share more words than pictures do (weight, size, colour), so their overlap threshold is higher. */
const TYPOGRAPHY_OVERLAP = 0.4;
/** Descriptions of type all use the same few words, so a higher similarity than for pictures is needed before two are called alike. */
const TYPOGRAPHY_EMBEDDING = 0.9;

export const DIRECTOR_SYSTEM = `You are the creative director of a batch of social media posters. For each post you are given its approved headline and the verified fact it states. Invent ONE visual concept per post, in your own words.
A concept is a description of an actual picture, complete and specific enough that an illustrator could make it without asking you anything: the subject, the world or setting it lives in, how it is made (the medium, materials, light, camera, mood), how it is composed, and the single idea that makes it communicate the fact. Do not name a style category or choose from a list of looks; describe this picture. "A modern professional illustration showing business growth" is not a concept. "A tiny website built from individual architectural blocks sits under a photographer's hard side light, one section lifted out so the structure under it shows, almost monochrome except for one small coral detail" is.
Rules:
- The concepts of the batch must be clearly unlike each other and unlike every concept in HISTORY. The difference must be in the central visual idea (the subject and what happens to it), never only in colours, backgrounds or camera angle. Say, inside each concept, what makes it unlike the other posters of the batch.
- Avoid the clichés that every business poster uses unless the fact is really about them: people at laptops, people around screens, dashboards or whiteboards, offices, handshakes, light bulbs, rockets, gears, generic charts with an arrow, a robot at a desk.
- At most PEOPLE_CAP of the posters may show people prominently, unless a post's fact is about people. Set "people" to true only when people are a prominent part of the picture.
- The picture contains no writing of any kind: no words, numbers, labels, interface text, signs, logos, badges, seals or awards. Do not invent product screenshots, customer quotes, results or statistics. Any interface you imagine must be an obvious abstraction made of shapes, with no text in it.
- The picture must communicate THIS post's fact. In "factToPicture", say in one sentence how it does; if you cannot, the concept is decoration and must be replaced.
- The brand's colours and look are an input, not a rule: they may appear as a detail or an accent and need not fill the scene. Do not repeat the same palette treatment on every poster.
- Never put the headline's words into the picture as text: the headline is added separately.
TYPOGRAPHY AND TEXT PLACEMENT. The headline is part of the poster's design, not a caption stuck on a picture. In "typography", invent a complete typographic composition that belongs to this poster's concept, in your own words:
- how the headline looks: its personality, its scale against the picture, its weight, its letterforms, its colour (it may be taken from the scene), its spacing and rhythm;
- precisely where it sits relative to the subjects and to the empty space the picture leaves for it, and how the text and the artwork interact to form one advertisement (beside, above, below, around, within the scene);
- how the placement guides the viewer's eye through the poster;
- where the brand name and the web address sit and how they are integrated as secondary elements (they are always added by the image model, small, legible and secondary, but you decide where they belong in this composition).
Describe what the viewer will actually see; "bold and modern" says nothing. Say why the treatment strengthens the message. Do not choose from a list of fonts, styles, layouts or positions.
The posters of a batch, and the posters in TYPOGRAPHY_HISTORY, must differ in the whole typographic composition: the relationship between text and picture, the hierarchy and the position, not only the colour or one word's size. Do not default to a headline at the top with the brand details at the bottom, or to a small first line over a larger second line in dark sans-serif; use them only when that arrangement is genuinely the best answer to this picture. Make real choices: a different type personality, scale relationship and position for each poster, such as a large single statement that the picture is built around, a headline running down one side, a headline set low on a quiet surface, type that shares the scene's colour, or a headline that is small and calm in a large silence. These are illustrations of the freedom you have, not a menu.
Keep it within what image models letter correctly: every character complete and fully legible. Avoid script or very decorative lettering, very condensed or overlapping letters, letters built out of objects, text crossing an important object or a face, text on a busy area, long headlines in capitals. Keep the headline's own capitalisation and punctuation exactly: you may not change its case.
Return JSON only: {"concepts":[{"postId":"...","concept":"...","people":false,"factToPicture":"...","typography":"..."}]} with exactly one concept for every post, using the given postId.`;

function parseConcepts(posts: readonly BatchPost[]): (value: unknown) => CreativeConcept[] {
  return (value) => {
    const list = (value as { concepts?: unknown }).concepts;
    if (!Array.isArray(list)) throw new Error('"concepts" must be a list');
    const out: CreativeConcept[] = [];
    for (const item of list) {
      const c = item as Partial<CreativeConcept>;
      if (typeof c.postId !== 'string' || !posts.some((p) => p.id === c.postId)) throw new Error(`a concept names a post that is not in the batch: ${String(c.postId)}`);
      if (typeof c.concept !== 'string' || c.concept.trim().length < MIN_CONCEPT_CHARS) throw new Error(`the concept for ${c.postId} must describe the picture in at least ${MIN_CONCEPT_CHARS} characters`);
      if (typeof c.people !== 'boolean') throw new Error(`"people" for ${c.postId} must be true or false`);
      if (typeof c.factToPicture !== 'string' || c.factToPicture.trim().length < 20) throw new Error(`"factToPicture" for ${c.postId} must say how the picture communicates the fact`);
      if (typeof c.typography !== 'string' || c.typography.trim().length < MIN_TYPOGRAPHY_CHARS) throw new Error(`"typography" for ${c.postId} must describe how the headline is set in at least ${MIN_TYPOGRAPHY_CHARS} characters`);
      if (out.some((o) => o.postId === c.postId)) throw new Error(`more than one concept for ${c.postId}`);
      out.push({ postId: c.postId, concept: c.concept.trim(), people: c.people, factToPicture: c.factToPicture.trim(), typography: c.typography.trim() });
    }
    const missing = posts.filter((p) => !out.some((o) => o.postId === p.id)).map((p) => p.id);
    if (missing.length > 0) throw new Error(`no concept for ${missing.join(', ')}`);
    return out;
  };
}

const userMessage = (input: DirectorInput, posts: readonly BatchPost[], keep: readonly CreativeConcept[], problems: readonly string[]): string =>
  JSON.stringify({
    brand: input.brandName,
    ...(input.brandLook ? { brandLook: input.brandLook } : {}),
    posts: posts.map((p) => ({ postId: p.id, headline: p.headline, fact: p.fact })),
    HISTORY: input.history.slice(0, 30),
    TYPOGRAPHY_HISTORY: (input.typographyHistory ?? []).slice(0, 30),
    ...(keep.length > 0 ? { ALREADY_CHOSEN_FOR_OTHER_POSTS_OF_THIS_BATCH_make_yours_unlike_these: keep.map((k) => ({ concept: k.concept, typography: k.typography })) } : {}),
    ...(problems.length > 0 ? { PROBLEMS_WITH_THE_LAST_ATTEMPT_fix_them: problems } : {}),
  });

/** One call: concepts for the given posts. Everything in the answer is checked; an answer that does not fit is asked for again once. */
export async function inventConcepts(input: DirectorInput, posts: readonly BatchPost[], keep: readonly CreativeConcept[] = [], problems: readonly string[] = []): Promise<CreativeConcept[]> {
  return chatJson({
    ai: input.ai,
    ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
    system: DIRECTOR_SYSTEM.replace('PEOPLE_CAP', String(input.peopleCap)),
    user: userMessage(input, posts, keep, problems),
    parse: parseConcepts(posts),
  });
}

export interface PlannedConcept extends CreativeConcept {
  /** How many times the director was asked again for this post. */
  replans: number;
}

export interface DirectorResult {
  concepts: PlannedConcept[];
  /** Posts that have no concept: no distinct, truthful idea could be found. */
  dropped: Array<{ postId: string; reason: string }>;
  /** Every flagged pair that was looked at, with what was decided. */
  flags: Array<FlaggedPair & { decision: 'different' | 'same'; why: string }>;
}

export interface DirectorDeps {
  /** For tests: replaces the director call. */
  invent?: (posts: readonly BatchPost[], keep: readonly CreativeConcept[], problems: readonly string[]) => Promise<CreativeConcept[]>;
  /** Embeddings of texts, by the same order; absent or failing means only the words are compared. */
  embed?: (texts: readonly string[]) => Promise<number[][]>;
  /** Whether two concepts show the same visual idea (a focused comparison of the pictured scene and mechanism). */
  sameIdea?: (a: string, b: string) => Promise<{ same: boolean; why: string }>;
  /** How many times conflicting concepts are sent back. */
  maxReplans?: number;
  similarity?: SimilarityConfig;
}

const SAME_IDEA_SYSTEM = `You compare two descriptions of pictures for social media posters. Decide whether they show the SAME visual idea: the same main subject doing or undergoing the same thing, in a scene a viewer would call the same picture. Two pictures that explain the same fact in clearly different ways (a different subject, a different visual mechanism) are NOT the same, even when their colours, mood or materials match. Return JSON only: {"same":true,"why":"one sentence"}`;

export async function compareIdeas(ai: AiConfig, a: string, b: string, fetchFn?: typeof fetch): Promise<{ same: boolean; why: string }> {
  return chatJson({
    ai,
    ...(fetchFn ? { fetchFn } : {}),
    system: SAME_IDEA_SYSTEM,
    user: JSON.stringify({ A: a, B: b }),
    parse: (v) => {
      const r = v as { same?: unknown; why?: unknown };
      if (typeof r.same !== 'boolean') throw new Error('"same" must be true or false');
      return { same: r.same, why: typeof r.why === 'string' ? r.why.slice(0, 200) : '' };
    },
  });
}

/** The words every poster of a brand has to use (its name, the product's words in the headlines), which say nothing about what is pictured. */
const sharedWords = (brandName: string, posts: readonly BatchPost[]): string[] => [...brandName.split(/\s+/), ...posts.flatMap((p) => p.headline.split(/\s+/))];

/**
 * Plans the concepts of a whole batch before anything is drawn. Returns a concept for every post that could get a distinct, truthful one, and the reason
 * for every post that could not.
 */
export async function directBatch(input: DirectorInput, deps: DirectorDeps = {}): Promise<DirectorResult> {
  const invent = deps.invent ?? ((posts, keep, problems) => inventConcepts(input, posts, keep, problems));
  const maxReplans = deps.maxReplans ?? 2;
  const config = deps.similarity ?? defaultSimilarityConfig;
  const shared = sharedWords(input.brandName, input.posts);
  const flags: DirectorResult['flags'] = [];
  const planned = new Map<string, PlannedConcept>();
  const dropped: DirectorResult['dropped'] = [];
  const byId = new Map(input.posts.map((p) => [p.id, p]));

  for (const c of await invent(input.posts, [], [])) planned.set(c.postId, { ...c, replans: 0 });

  const peopleProblem = (): string | undefined => {
    const withPeople = [...planned.values()].filter((c) => c.people);
    return withPeople.length > input.peopleCap ? `${withPeople.length} of ${planned.size} posters show people prominently, and at most ${input.peopleCap} may` : undefined;
  };

  for (let round = 0; round <= maxReplans; round++) {
    const refs: ConceptRef[] = [...planned.values()].map((c) => ({ id: c.postId, concept: c.concept }));
    input.history.slice(0, 30).forEach((concept, i) => refs.push({ id: `past-${i}`, concept, past: true }));
    let embeddings: Map<string, number[]> | undefined;
    if (deps.embed) {
      try {
        const vectors = await deps.embed(refs.map((r) => r.concept));
        embeddings = new Map(refs.map((r, i) => [r.id, vectors[i] as number[]]));
      } catch (error) {
        if (error instanceof BudgetError) throw error;
        // Without embeddings only the words are compared; that is stricter about wording and blind to paraphrase, and the look-alike check after drawing covers the rest.
      }
    }
    const candidates = flagSimilar(refs, { config, shared, ...(embeddings ? { embeddings } : {}) });
    const conflicts: Array<{ pair: FlaggedPair; later: string; problem: string }> = [];
    for (const pair of candidates) {
      // The later poster of a pair is the one sent back; a past concept is never changed.
      const later = pair.b.startsWith('past-') ? pair.a : pair.a.startsWith('past-') ? pair.b : pair.b;
      const other = later === pair.a ? pair.b : pair.a;
      const a = refs.find((r) => r.id === pair.a)?.concept as string;
      const b = refs.find((r) => r.id === pair.b)?.concept as string;
      let verdict: { same: boolean; why: string };
      // Identical text and a high word overlap are decided by the words; a pair flagged only by embedding gets the focused comparison.
      if (pair.reason === 'identical' || pair.reason.startsWith('word overlap') || !deps.sameIdea) verdict = { same: true, why: pair.reason };
      else verdict = await deps.sameIdea(a, b);
      flags.push({ ...pair, decision: verdict.same ? 'same' : 'different', why: verdict.why });
      if (verdict.same) conflicts.push({ pair, later, problem: `the concept for ${later} is too much like ${other.startsWith('past-') ? 'a concept the brand used recently' : `the concept for ${other}`} (${pair.reason}${verdict.why && verdict.why !== pair.reason ? `: ${verdict.why}` : ''}); invent a different picture, with a different main subject and a different thing happening to it` });
    }
    // Typography is compared the same way, but only as a reason to ask again: a headline set like another is a weaker fault than a repeated picture, so it never drops a post.
    const typeRefs: ConceptRef[] = [...planned.values()].map((c) => ({ id: c.postId, concept: c.typography }));
    (input.typographyHistory ?? []).slice(0, 30).forEach((t, i) => typeRefs.push({ id: `past-${i}`, concept: t, past: true }));
    let typeEmbeddings: Map<string, number[]> | undefined;
    if (deps.embed) {
      try {
        const vectors = await deps.embed(typeRefs.map((r) => r.concept));
        typeEmbeddings = new Map(typeRefs.map((r, i) => [r.id, vectors[i] as number[]]));
      } catch (error) {
        if (error instanceof BudgetError) throw error;
      }
    }
    const typeConflicts: Array<{ later: string; problem: string }> = [];
    for (const pair of flagSimilar(typeRefs, { config: { ...config, maxWordOverlap: TYPOGRAPHY_OVERLAP, maxEmbeddingSimilarity: TYPOGRAPHY_EMBEDDING }, shared, ...(typeEmbeddings ? { embeddings: typeEmbeddings } : {}) })) {
      const later = pair.b.startsWith('past-') ? pair.a : pair.a.startsWith('past-') ? pair.b : pair.b;
      const other = later === pair.a ? pair.b : pair.a;
      flags.push({ ...pair, decision: 'same', why: `typography: ${pair.reason}` });
      typeConflicts.push({ later, problem: `the typography for ${later} is too much like ${other.startsWith('past-') ? 'how a recent poster of the brand was set' : `the typography for ${other}`} (${pair.reason}); set this headline in a clearly different way, with a different hierarchy and a different relationship to the artwork` });
    }
    const people = peopleProblem();
    const stuck = [...new Set([...conflicts.map((c) => c.later), ...typeConflicts.map((c) => c.later)])];
    const stuckPictures = new Set(conflicts.map((c) => c.later));
    if (stuck.length === 0 && !people) break;
    if (round === maxReplans) {
      // Out of rounds: a post that still repeats another is dropped (the later one of each pair), never published as a repeat.
      for (const postId of stuck) {
        if (!stuckPictures.has(postId)) continue;
        planned.delete(postId);
        dropped.push({ postId, reason: 'no distinct visual idea was found after sending it back to the director' });
      }
      if (people) {
        const excess = [...planned.values()].filter((c) => c.people).slice(input.peopleCap);
        for (const c of excess) {
          planned.delete(c.postId);
          dropped.push({ postId: c.postId, reason: 'too many posters showing people, and no picture without people was found' });
        }
      }
      break;
    }
    const redo = new Set(stuck);
    if (people) for (const c of [...planned.values()].filter((p) => p.people).slice(input.peopleCap)) redo.add(c.postId);
    const redoPosts = [...redo].map((id) => byId.get(id)).filter((p): p is BatchPost => p !== undefined);
    const keep = [...planned.values()].filter((c) => !redo.has(c.postId));
    const problems = [...conflicts.filter((c) => redo.has(c.later)).map((c) => c.problem), ...typeConflicts.filter((c) => redo.has(c.later)).map((c) => c.problem), ...(people ? [people] : [])];
    const fresh = await invent(redoPosts, keep, problems);
    for (const c of fresh) planned.set(c.postId, { ...c, replans: (planned.get(c.postId)?.replans ?? 0) + 1 });
  }
  return { concepts: input.posts.flatMap((p) => planned.get(p.id) ?? []), dropped, flags };
}

// ---- Memory across weeks

export interface ConceptRecord {
  at: string;
  postId: string;
  concept: string;
  /** How the headline was set; absent in records from before typography was planned. */
  typography?: string;
  people: boolean;
  /** Whether a poster made from it was accepted; rejected concepts are remembered too, so they are not tried again. */
  accepted: boolean;
}

const HISTORY_KEEP = 40;

export async function loadConceptHistory(brandDir: string): Promise<ConceptRecord[]> {
  try {
    const raw = JSON.parse(await readFile(join(brandDir, 'creative-history.json'), 'utf8')) as { concepts?: unknown };
    return Array.isArray(raw.concepts) ? (raw.concepts as ConceptRecord[]).filter((r) => typeof r.concept === 'string') : [];
  } catch {
    return [];
  }
}

/** Adds this batch's concepts to the brand's memory (newest first, the last 40 kept). */
export async function saveConceptHistory(brandDir: string, existing: readonly ConceptRecord[], added: readonly ConceptRecord[]): Promise<void> {
  const file = join(brandDir, 'creative-history.json');
  await mkdir(dirname(file), { recursive: true });
  const body = `${JSON.stringify({ concepts: [...added, ...existing].slice(0, HISTORY_KEEP) }, null, 2)}\n`;
  await writeFile(`${file}.tmp`, body);
  await rename(`${file}.tmp`, file);
}

// ---- Embeddings (an optional second pair of eyes for paraphrases)

/** Embeds texts with OpenAI's embedding endpoint, reserved on the ledger like every paid call. */
export function openAiEmbedder(ai: AiConfig, model = process.env['OPENAI_EMBEDDING_MODEL'] || 'text-embedding-3-small', fetchFn: typeof fetch = fetch): (texts: readonly string[]) => Promise<number[][]> {
  return async (texts) => {
    if (!ai.openaiKey) throw new Error('embeddings need an OpenAI key');
    const callId = ai.ledger?.reserve({ operation: 'text', model, ...(ai.usage.post !== null ? { postId: ai.usage.post } : {}), requestKey: JSON.stringify(texts), maxCostUsd: 0.001 });
    if (ai.ledger && callId) ai.ledger.markInFlight(callId);
    let response: Response;
    try {
      response = await fetchFn(`${ai.openaiBase}/embeddings`, { method: 'POST', headers: { Authorization: `Bearer ${ai.openaiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, input: texts }), signal: AbortSignal.timeout(60_000) });
    } catch (error) {
      if (ai.ledger && callId) ai.ledger.markUnknown(callId, error instanceof Error ? error.message : String(error));
      throw error;
    }
    if (!response.ok) {
      if (ai.ledger && callId) ai.ledger.fail(callId, `status ${response.status}`);
      throw new Error(`embeddings returned ${response.status}`);
    }
    const body = (await response.json()) as { data?: Array<{ embedding?: number[]; index?: number }>; usage?: { total_tokens?: number } };
    const vectors = (body.data ?? []).sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding ?? []);
    if (vectors.length !== texts.length || vectors.some((v) => v.length === 0)) {
      if (ai.ledger && callId) ai.ledger.markUnknown(callId, 'embeddings answered with the wrong number of vectors');
      throw new Error('embeddings answered with the wrong number of vectors');
    }
    // Embedding prices are tiny: $0.02 per million tokens for the small model, counted at ten times that, which is never below the real charge.
    if (ai.ledger && callId) ai.ledger.complete(callId, { actualCostUsd: ((body.usage?.total_tokens ?? 0) * 0.2) / 1_000_000, inputTokens: body.usage?.total_tokens ?? 0 });
    return vectors;
  };
}


// ---- Looking at the finished posters side by side

export interface LookAlikePair {
  a: string;
  b: string;
  why: string;
}

const LOOKALIKE_SYSTEM = `You are shown several finished social media posters from one brand, in order, each named by an id. Answer two separate questions.
1. scenes: pairs that look materially alike as pictures: the same kind of scene, the same main subject, the same visual execution or a very similar composition, so that a person scrolling would think they are one repeated image. Different headlines, small colour changes and different props do not make two posters different.
2. typography: ignoring the artwork completely, pairs whose HEADLINE is set in substantially the same way: the same apparent typeface character, weight, size against the poster, alignment, position, colour and hierarchy. Say what you can see that is the same.
Do not judge the wording of any text. If there are no such pairs, return empty lists. Return JSON only: {"scenes":[{"a":"id","b":"id","why":"one sentence"}],"typography":[{"a":"id","b":"id","why":"one sentence"}]}`;

export interface LookAlikes {
  /** Pairs whose pictures look alike. */
  scenes: LookAlikePair[];
  /** Pairs whose headlines are set alike. */
  typography: LookAlikePair[];
}

/** One vision request with every poster of the batch: which pairs look alike as pictures, and which are lettered alike. The decision about what to do with a pair is made by the caller. */
export async function batchLookAlikes(ai: AiConfig, posters: ReadonlyArray<{ id: string; file: string }>, fetchFn?: typeof fetch): Promise<LookAlikes> {
  if (posters.length < 2) return { scenes: [], typography: [] };
  const images = await Promise.all(posters.map(async (p) => `data:image/jpeg;base64,${(await readFile(p.file)).toString('base64')}`));
  const pairsOf = (list: unknown): LookAlikePair[] => {
    if (!Array.isArray(list)) throw new Error('"scenes" and "typography" must be lists');
    return list.map((p) => {
      const pair = p as Partial<LookAlikePair>;
      if (typeof pair.a !== 'string' || typeof pair.b !== 'string' || !posters.some((x) => x.id === pair.a) || !posters.some((x) => x.id === pair.b) || pair.a === pair.b) throw new Error('every pair must name two different posters of the batch');
      return { a: pair.a, b: pair.b, why: typeof pair.why === 'string' ? pair.why.slice(0, 200) : '' };
    });
  };
  return chatJson({
    ai,
    ...(fetchFn ? { fetchFn } : {}),
    system: LOOKALIKE_SYSTEM,
    user: `The posters, in the order of the pictures: ${posters.map((p) => p.id).join(', ')}.`,
    images,
    parse: (v) => {
      const r = v as { scenes?: unknown; typography?: unknown };
      return { scenes: pairsOf(r.scenes), typography: pairsOf(r.typography ?? []) };
    },
  });
}

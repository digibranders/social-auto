import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiConfigFromEnv } from './ai.ts';
import { writeNetworkCaptions, type CaptionPost } from './network-captions.ts';
import { composeVariant, countWords } from './networks.ts';

const ai = aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234', AI_PROVIDER: 'openai' });
const CTA = 'Explore our services at acme.example (link in bio)';
const posts: CaptionPost[] = [
  { id: 'p1', headline: 'Set up in under ten minutes', caption: `One script tag and the assistant is live on your site.\n\n${CTA}`, hashtags: ['#acme', '#setup', '#chatbot'], facts: ['Installation takes under 10 minutes and uses one script tag.'] },
  { id: 'p2', headline: 'Answers from your own pages', caption: `The assistant answers from your own pages and documents.\n\n${CTA}`, hashtags: ['#acme'], facts: ['Answers come from your own pages and documents.'] },
];

function model(answers: unknown[]): { fetchFn: typeof fetch; requests: string[] } {
  const requests: string[] = [];
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    requests.push(String(init?.body));
    const answer = answers[Math.min(requests.length - 1, answers.length - 1)];
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
  }) as typeof fetch;
  return { fetchFn, requests };
}
const good = (network: string, postId: string, caption: string, hashtags: string[] = []) => ({ postId, network, caption, hashtags });

test('each network gets its own caption from one request, the closing line is added by code for that network, and Instagram keeps the main caption', async () => {
  const { fetchFn, requests } = model([{ captions: [
    good('linkedin', 'p1', 'Teams can put an assistant on their site with one script tag, in under 10 minutes.', ['#chatbot']),
    good('linkedin', 'p2', 'Customers get answers drawn from your own pages and documents.'),
    good('google', 'p1', 'Install takes under 10 minutes and needs one script tag.', ['#nope']),
    good('google', 'p2', 'Answers come from your own pages and documents.'),
  ] }]);
  const { variants, report } = await writeNetworkCaptions({ ai, posts, networks: ['instagram', 'linkedin', 'google'], fetchFn });
  assert.equal(requests.length, 1, 'one request for the whole batch');
  assert.equal(variants['p1']?.instagram?.caption, posts[0]?.caption, 'Instagram is the main caption');
  const li = variants['p1']?.linkedin;
  assert.match(li?.caption ?? '', /one script tag, in under 10 minutes\.\n\nExplore our services at acme\.example$/, 'the address line is added by code');
  assert.doesNotMatch(li?.caption ?? '', /link in bio/, 'only Instagram says link in bio');
  assert.deepEqual(variants['p1']?.google?.hashtags, [], 'Google takes no hashtags, even when the model gave one');
  assert.equal(composeVariant(li as never).endsWith('#chatbot'), true);
  assert.equal(report.requested, 6);
  assert.equal(report.written, 6);
  assert.deepEqual(report.fallback, []);
});

test('a caption that states something the facts do not is asked for again with the reason, and the corrected one is used', async () => {
  const { fetchFn, requests } = model([
    { captions: [good('linkedin', 'p1', 'Set up in 3 minutes with one script tag.'), good('linkedin', 'p2', 'Answers come from your own pages and documents.')] },
    { captions: [good('linkedin', 'p1', 'Set up in under 10 minutes with one script tag.')] },
  ]);
  const { variants, report } = await writeNetworkCaptions({ ai, posts, networks: ['linkedin'], fetchFn });
  assert.equal(requests.length, 2);
  assert.match(requests[1] ?? '', /fixThis/);
  assert.match(variants['p1']?.linkedin?.caption ?? '', /under 10 minutes/);
  assert.equal(variants['p1']?.linkedin?.fallback, undefined);
  assert.equal(report.retried, 1);
  assert.deepEqual(report.fallback, []);
});

test('a caption that still fails after one more try is replaced by the main caption adapted to the network, and marked', async () => {
  const bad = { captions: [good('linkedin', 'p1', 'Set up in 3 minutes with one script tag.'), good('linkedin', 'p2', 'Answers come from your own pages and documents.')] };
  const { fetchFn } = model([bad, bad]);
  const { variants, report } = await writeNetworkCaptions({ ai, posts, networks: ['linkedin'], fetchFn });
  const fallback = variants['p1']?.linkedin;
  assert.equal(fallback?.fallback, true);
  assert.match(fallback?.caption ?? '', /^One script tag and the assistant is live on your site\.\n\nExplore our services at acme\.example$/);
  assert.equal(report.fallback.length, 1);
  assert.equal(report.fallback[0]?.postId, 'p1');
  assert.match(report.fallback[0]?.reason ?? '', /does not support|facts/);
  assert.equal(variants['p2']?.linkedin?.fallback, undefined, 'the other post kept its own caption');
});

test('a network that was not asked for, and an answer for a post that does not exist, are ignored', async () => {
  const { fetchFn } = model([{ captions: [good('facebook', 'p1', 'The assistant is live on your site with one script tag.'), good('tiktok', 'p1', 'x'), good('facebook', 'zz', 'x'), good('facebook', 'p2', 'The assistant answers from your own pages and documents.')] }]);
  const { variants } = await writeNetworkCaptions({ ai, posts, networks: ['facebook'], fetchFn });
  assert.deepEqual(Object.keys(variants['p1'] ?? {}), ['facebook']);
  assert.equal(variants['zz'], undefined);
});

test('a plan keeps its per-network captions when it is read back, and refuses a network that does not exist', async () => {
  const { parseWeekPlan } = await import('./content.ts');
  const post = { id: 'w01-d1', date: '2026-11-10T10:00:00+05:30', painPoint: 'p', mode: 'ai', headline: 'Set up in ten minutes', subline: '', imagePrompt: 'x', caption: 'One script tag.', hashtags: ['#acme'], variants: { linkedin: { caption: 'One script tag for teams.', hashtags: ['#acme'], fallback: true } } };
  const plan = parseWeekPlan({ brand: 'acme', timezone: '+05:30', renderMode: 'ai_v1', posts: [post] }, 'week-01.json');
  assert.deepEqual(plan.posts[0]?.variants, { linkedin: { caption: 'One script tag for teams.', hashtags: ['#acme'], fallback: true } });
  assert.throws(() => parseWeekPlan({ brand: 'acme', timezone: '+05:30', renderMode: 'ai_v1', posts: [{ ...post, variants: { tiktok: { caption: 'x', hashtags: [] } } }] }, 'week-01.json'), /not a network/);
});

test('the writer is told how long each network\'s caption should be and that the hook comes first', async () => {
  const { fetchFn, requests } = model([{ captions: [
    good('linkedin', 'p1', 'Teams can put an assistant on their site with one script tag, in under 10 minutes.'),
    good('linkedin', 'p2', 'Customers get answers drawn from your own pages and documents.'),
    good('google', 'p1', 'Install takes under 10 minutes and needs one script tag.'),
    good('google', 'p2', 'Answers come from your own pages and documents.'),
  ] }]);
  await writeNetworkCaptions({ ai, posts, networks: ['linkedin', 'google'], fetchFn });
  const asked = requests[0] ?? '';
  assert.match(asked, /linkedin: .*Aim for 150 to 300 words/);
  assert.match(asked, /google: .*Aim for about 150 to 300 characters/);
  assert.match(asked, /the hook comes first/);
});

/** `count` distinct made-up words in sentences of ten, so no sentence repeats another (the writing check turns repetition back). */
const wordsOf = (count: number, seed = 0): string => {
  const syl = ['ka', 'lo', 'mi', 'ra', 'su', 'te', 'vo', 'zi', 'ne', 'pa'];
  const word = (i: number): string => `${syl[(i + seed) % 10]}${syl[Math.floor((i + seed) / 10) % 10]}${syl[Math.floor((i + seed) / 100) % 10]}${syl[(i * 7 + seed) % 10]}`;
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) out.push(word(i + 1) + ((i + 1) % 10 === 0 ? '.' : ''));
  return out.join(' ').replace(/\.$/, '') + '.';
};

test('a caption outside its network\'s word range is asked for again; too long always, too short on the first tries, and the last try takes a short one', async () => {
  const input = { ai, networks: ['linkedin'] as const, posts: [{ id: 'p1', headline: 'Track your reports', caption: 'Track your reports.\n\nVisit acme.example (link in bio)', hashtags: ['#Reports'], facts: ['Acme tracks and analyzes business reports.'] }] };
  const answer = (text: string) => Response.json({ choices: [{ message: { content: JSON.stringify({ captions: [{ postId: 'p1', network: 'linkedin', caption: text, hashtags: ['#Reports'] }] }) } }] });
  const bodies: string[] = [];
  const asking = (texts: string[]) => async (_url: string | URL | Request, init?: RequestInit) => { bodies.push(String(init?.body)); return answer(texts[Math.min(bodies.length - 1, texts.length - 1)] as string); };
  const run = (texts: string[], extra: { minCaptions?: boolean } = {}) => writeNetworkCaptions({ ...input, networks: [...input.networks], ...extra, fetchFn: asking(texts) as unknown as typeof fetch });
  const short = wordsOf(40, 1);
  const inside = wordsOf(180, 2);
  const tooLong = wordsOf(340, 3);
  assert.equal(countWords(short), 40);
  assert.equal(countWords(inside), 180);

  // Too short on the first try: asked again, with the count and the range; the longer answer is used.
  const grown = await run([short, inside], { minCaptions: true });
  assert.equal(bodies.length, 2);
  assert.match(bodies[1] ?? '', /too short for linkedin: 40 words; it must be between 150 and 300 words/);
  assert.equal(countWords(grown.variants['p1']?.linkedin?.caption ?? ''), 180 + 2, 'the words plus the closing line');
  // Too long is sent back on every try, with or without the option.
  bodies.length = 0;
  await run([tooLong, inside]);
  assert.equal(bodies.length, 2);
  assert.match(bodies[1] ?? '', /too long for linkedin: 340 words; it must be between 150 and 300 words, so cut it to at most 300/);
  // A short answer every time: two corrections, then the last try takes it.
  bodies.length = 0;
  const stubborn = await run([short], { minCaptions: true });
  assert.equal(bodies.length, 3);
  assert.equal(stubborn.report.fallback.length, 0);
  // Without the option a short caption is left alone.
  bodies.length = 0;
  await run([short]);
  assert.equal(bodies.length, 1);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiConfigFromEnv } from './ai.ts';
import { writeNetworkCaptions, type CaptionPost } from './network-captions.ts';
import { composeVariant } from './networks.ts';

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
  assert.match(asked, /linkedin: .*Aim for about 900 to 1200 characters/);
  assert.match(asked, /google: .*Aim for about 150 to 300 characters/);
  assert.match(asked, /the hook comes first/);
});

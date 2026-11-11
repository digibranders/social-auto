import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aiConfigFromEnv } from './ai.ts';
import { writeCarouselCaptions } from './carousel-copy.ts';

const ai = aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234' });
const answers = (...list: unknown[]): { fetchFn: typeof fetch; bodies: string[] } => {
  const bodies: string[] = [];
  let n = 0;
  const fetchFn: typeof fetch = async (_url, init) => {
    bodies.push(String(init?.body));
    const answer = list[Math.min(n++, list.length - 1)];
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
  };
  return { fetchFn, bodies };
};
const input = {
  ai, topic: 'Choosing a curry',
  headlines: ['Not sure what curry to choose?', 'Start with a popular favourite', 'Or build your own curry', 'Order your curry today'],
  facts: ['Curry Cook offers popular curry menu items.', 'Curry Cook offers a Build Your Own Curry option.'],
  closingLine: 'Order at currycook.com (link in bio)',
};
const main = { caption: 'Swipe through to find a curry you will love. Popular favourites, or build your own.', hashtags: ['#curry', '#food'] };
const others = { captions: [
  { postId: 'carousel', network: 'linkedin', caption: 'A short guide to choosing a curry: start with a popular favourite, or build your own.', hashtags: [] },
  { postId: 'carousel', network: 'google', caption: 'Popular curries and a build your own option.', hashtags: [] },
] };

test('every channel gets a caption of its own, the Instagram one first, each ending with the brand\'s closing line', async () => {
  const { fetchFn, bodies } = answers(main, others);
  const out = await writeCarouselCaptions({ ...input, networks: ['instagram', 'linkedin', 'google'], fetchFn });
  assert.deepEqual(Object.keys(out.captions).sort(), ['google', 'instagram', 'linkedin']);
  assert.match(out.captions['instagram'] ?? '', /Swipe through to find a curry/);
  assert.match(out.captions['instagram'] ?? '', /Order at currycook\.com \(link in bio\)/);
  assert.match(out.captions['instagram'] ?? '', /#curry #food/);
  assert.match(out.captions['linkedin'] ?? '', /short guide to choosing a curry/);
  assert.doesNotMatch(out.captions['linkedin'] ?? '', /link in bio/, 'only Instagram says link in bio');
  assert.equal(out.fallback.length, 0);
  assert.equal(bodies.length, 2);
  assert.match(bodies[0] ?? '', /Choosing a curry/);
  assert.match(bodies[0] ?? '', /Build Your Own Curry/);
});

test('only the channels asked for are written, and the main caption alone is one call', async () => {
  const { fetchFn, bodies } = answers(main);
  const out = await writeCarouselCaptions({ ...input, networks: ['instagram'], fetchFn });
  assert.deepEqual(Object.keys(out.captions), ['instagram']);
  assert.equal(bodies.length, 1);
  await assert.rejects(writeCarouselCaptions({ ...input, networks: [], fetchFn }), /at least one channel/);
});

test('a main caption that states something the facts do not is asked for again, and a plain one is used when it still fails', async () => {
  const bad = { caption: 'Ready in 10 minutes, guaranteed, with 500 five star reviews.', hashtags: [] };
  const retried = answers(bad, main);
  const second = await writeCarouselCaptions({ ...input, networks: ['instagram'], fetchFn: retried.fetchFn });
  assert.match(second.captions['instagram'] ?? '', /Swipe through to find a curry/);
  assert.equal(retried.bodies.length, 2);
  assert.match(retried.bodies[1] ?? '', /no verified claim supports|facts do not support|states/);
  const hopeless = answers(bad);
  const third = await writeCarouselCaptions({ ...input, networks: ['instagram'], fetchFn: hopeless.fetchFn });
  assert.match(third.captions['instagram'] ?? '', /Not sure what curry to choose\?/);
  assert.deepEqual(third.fallback.map((f) => f.network), ['instagram']);
});

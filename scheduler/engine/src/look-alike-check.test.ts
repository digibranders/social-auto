import { test } from 'node:test';
import assert from 'node:assert/strict';
import { differentScene, flagAlike, redrawAlike, type DrawnPicture } from './look-alike-check.ts';
import type { LookAlikes } from './creative-director.ts';

const pics = (postId: string, ...networks: Array<DrawnPicture['network']>): DrawnPicture[] => networks.map((network) => ({ postId, network, file: `/x/${postId}-${network}.jpg` }));
const none: LookAlikes = { scenes: [], typography: [] };
const pairs = (...p: Array<[string, string, string?]>): LookAlikes => ({ scenes: p.map(([a, b, why]) => ({ a, b, why: why ?? '' })), typography: [] });

test('the later network of a pair that is clearly the same scene is flagged, each picture once, and the earlier one is left alone', async () => {
  const seen: string[][] = [];
  const flagged = await flagAlike(pics('p1', 'instagram', 'facebook', 'linkedin', 'google'), async (posters) => {
    seen.push(posters.map((p) => p.id));
    return pairs(['p1|linkedin', 'p1|facebook', 'people around a laptop'], ['p1|facebook', 'p1|linkedin'], ['p1|instagram', 'p1|google']);
  });
  assert.deepEqual(seen, [['p1|instagram', 'p1|facebook', 'p1|linkedin', 'p1|google']], 'one comparison per topic, all of its pictures together');
  assert.deepEqual(flagged.map((f) => [f.network, f.alikeWith]), [['linkedin', 'facebook'], ['google', 'instagram']], 'a pair named twice is flagged once; the later network is the one drawn again');
  assert.equal(flagged[0]?.why, 'people around a laptop');
});

test('a topic with one picture is not compared, a pair the comparison does not name is left, and a comparison that fails flags nothing', async () => {
  let calls = 0;
  assert.deepEqual(await flagAlike(pics('p1', 'instagram'), async () => { calls += 1; return none; }), []);
  assert.equal(calls, 0);
  assert.deepEqual(await flagAlike(pics('p1', 'instagram', 'facebook'), async () => none), []);
  const messages: string[] = [];
  assert.deepEqual(await flagAlike(pics('p1', 'instagram', 'facebook'), async () => { throw new Error('no vision'); }, (m) => messages.push(m)), []);
  assert.match(messages[0] ?? '', /could not be compared.*none is drawn again/);
  // Unknown ids in the answer are ignored.
  assert.deepEqual(await flagAlike(pics('p1', 'instagram', 'facebook'), async () => pairs(['p1|instagram', 'p9|facebook'])), []);
});

test('each topic is compared on its own, and the flagged picture is drawn once more with a note about what it looked like; the first stays when the second fails or is refused', async () => {
  const all = [...pics('p1', 'instagram', 'facebook'), ...pics('p2', 'instagram', 'facebook', 'google')];
  const redrawn: Array<[string, string, string]> = [];
  const log: string[] = [];
  const replaced = await redrawAlike({
    pictures: all,
    lookAlikes: async (posters) => (posters[0]?.id.startsWith('p1') ? pairs(['p1|instagram', 'p1|facebook', 'two dogs on a desk']) : pairs(['p2|instagram', 'p2|facebook'], ['p2|instagram', 'p2|google'])),
    redraw: async (f, note) => {
      redrawn.push([f.postId, f.network, note]);
      if (f.network === 'google') throw new Error('limit reached');
      return f.postId === 'p2' ? null : { file: `/x/${f.postId}-${f.network}-again.jpg` };
    },
    log: (m) => log.push(m),
  });
  assert.deepEqual(redrawn.map(([p, n]) => `${p}|${n}`), ['p1|facebook', 'p2|facebook', 'p2|google']);
  assert.deepEqual(replaced.map((r) => [r.flagged.postId, r.flagged.network, r.file]), [['p1', 'facebook', '/x/p1-facebook-again.jpg']]);
  assert.match(redrawn[0]?.[2] ?? '', /looked too much like the picture made for instagram \(two dogs on a desk\).*clearly different scene/);
  assert.ok(log.some((m) => /second facebook picture was not accepted/.test(m)));
  assert.ok(log.some((m) => /second google picture could not be made \(limit reached\)/.test(m)));
  assert.equal(differentScene({ postId: 'p', network: 'google', alikeWith: 'facebook', why: '' }).includes('()'), false);
});

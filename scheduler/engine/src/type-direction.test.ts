import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NETWORKS } from './networks.ts';
import { COLOUR_USE, headlineStylesEnabled, leanFor, loadTypeHistory, saveTypeHistory, TRAITS, typeDirectionLine, type LeanRecord } from './type-direction.ts';

test('the four networks of any post are nudged towards four different weights and four different characters', () => {
  for (let i = 1; i <= 80; i += 1) {
    const leans = NETWORKS.map((n) => leanFor(`w01-d${i}`, n));
    assert.equal(new Set(leans.map((l) => l.weight)).size, 4, `post ${i} weights`);
    assert.equal(new Set(leans.map((l) => l.character)).size, 4, `post ${i} characters`);
    assert.equal(new Set(leans.map((l) => l.attitude)).size, 4, `post ${i} attitudes`);
    assert.equal(new Set(leans.map((l) => l.colour)).size, 4, `post ${i} colour uses`);
  }
});

test('a lean follows from the post and the network, so a redraw keeps it, and posts spread across every weight and character', () => {
  for (const network of NETWORKS) {
    assert.deepEqual(leanFor('w02-d3', network), leanFor('w02-d3', network));
    const weights = new Set<string>();
    const characters = new Set<string>();
    for (let i = 0; i < 60; i += 1) { const l = leanFor(`w03-d${i}`, network); weights.add(l.weight); characters.add(l.character); }
    assert.equal(weights.size, TRAITS.weight.length, `${network}: every weight is reachable, no network is tied to a few`);
    assert.equal(characters.size, TRAITS.character.length);
  }
});

test('a network is not tied to a kind of lettering: every network can lean towards every weight', () => {
  for (const network of NETWORKS) {
    const seen = new Set(Array.from({ length: 80 }, (_, i) => leanFor(`p${i}`, network).weight));
    assert.deepEqual([...seen].sort(), [...TRAITS.weight].sort(), network);
  }
});

test('a lean steers clear of the brand\'s recent ones, the same way every time, and falls back when nothing is free', () => {
  const first = leanFor('w01-d1', 'instagram');
  const avoided = leanFor('w01-d1', 'instagram', [first]);
  assert.notDeepEqual(avoided, first);
  assert.deepEqual(avoided, leanFor('w01-d1', 'instagram', [first]));
  const everyPair = TRAITS.weight.flatMap((weight) => TRAITS.character.map((character) => ({ weight, character, attitude: 'warm', colour: COLOUR_USE[0] })));
  assert.ok(leanFor('w01-d1', 'instagram', everyPair), 'a brand that has used every pair is still given one');
});

test('the prompt asks for an original voice, gives traits as inspiration and the lean as a nudge, names no layout, and limits script to an accent', () => {
  const line = typeDirectionLine({ network: 'linkedin', lean: { weight: 'heavy', character: 'humanist', attitude: 'warm', colour: COLOUR_USE[2] } });
  assert.match(line, /Invent an original typographic voice/);
  assert.match(line, /for inspiration only, to use, combine or go beyond/);
  assert.match(line, /must be clearly its own: lean strongly towards a heavy weight, a humanist character and a warm attitude, with the whole headline in the brand's accent colour, unless the words truly call for something else/);
  assert.match(line, /see at a glance that their lettering is not the same/);
  assert.match(line, /choose the composition, scale, line breaks, alignment and placement yourself/);
  assert.match(line, /only for one short accent word, never for the whole headline/);
  assert.match(line, /credible and considered/);
  for (const values of [...Object.values(TRAITS), COLOUR_USE]) for (const v of values) assert.doesNotMatch(v, /\b(left|right|centre|center|top|bottom|corner|lines?|align)/i, v);
  // The traits are ingredients, not a fixed menu to pick one from: nothing says "choose one of".
  assert.doesNotMatch(line, /choose (one|a) (of|style)|pick one/i);
});

test('headline typography is on unless the setting is exactly "false"', () => {
  assert.equal(headlineStylesEnabled({}), true);
  assert.equal(headlineStylesEnabled({ HEADLINE_STYLES_ENABLED: 'false' }), false);
  assert.equal(headlineStylesEnabled({ HEADLINE_STYLES_ENABLED: 'off' }), true);
});

test('a brand\'s memory keeps the newest 20 leans, survives a missing or damaged file, and adds nothing when there is nothing to add', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'type-history-'));
  try {
    assert.deepEqual(await loadTypeHistory(dir), []);
    const rec = (n: number): LeanRecord => ({ weight: 'bold', character: 'geometric', attitude: 'warm', colour: COLOUR_USE[0], at: `2026-11-12T10:00:${String(n).padStart(2, '0')}Z`, postId: `p${n}`, network: 'instagram' });
    await saveTypeHistory(dir, [], []);
    assert.deepEqual(await loadTypeHistory(dir), [], 'nothing written for nothing');
    await saveTypeHistory(dir, [], Array.from({ length: 15 }, (_, i) => rec(i)));
    await saveTypeHistory(dir, await loadTypeHistory(dir), Array.from({ length: 10 }, (_, i) => rec(30 + i)));
    const kept = await loadTypeHistory(dir);
    assert.equal(kept.length, 20);
    assert.equal(kept[0]?.postId, 'p30', 'newest first');
    JSON.parse(readFileSync(join(dir, 'type-history.json'), 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

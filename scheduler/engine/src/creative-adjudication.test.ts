import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CreativeReview, TextManifest } from './ai-creative.ts';
import { cropHtml, decideReadings, disputedBoxes, paddedBox, unionBox, type Dispute } from './creative-adjudication.ts';

const manifest: TextManifest = { headline: 'Answers from your own docs', brandName: 'OyeChats', domain: 'oyechats.com' };
const clean: CreativeReview['marks'] = { graphicalLogoOrIcon: false, badgeSealAwardOrCertification: false, inventedNumberPriceOrStatistic: false, interfaceOrScreenshotWithText: false, personPresentedAsCustomerOrEndorser: false, flagOrReligiousSymbol: false };
const read = (texts: Array<string | { text: string; box?: [number, number, number, number] | null }>, over: Partial<CreativeReview> = {}): CreativeReview => ({
  regions: texts.map((t) => (typeof t === 'string' ? { text: t, readable: true, box: null } : { text: t.text, readable: true, box: t.box ?? null })),
  marks: { ...clean }, relevance: 2, composition: 2, readableSmall: true, textOverImportantArt: false, people: { present: false, estimatedCount: 0, prominent: false, description: '' }, notes: 'none', ...over,
});
const OK = ['Answers from your own docs', 'OyeChats', 'oyechats.com'];
const never = async (): Promise<never> => { throw new Error('no third reading expected'); };
const thirdOf = (reading: CreativeReview) => async (dispute: Dispute) => { thirds.push(dispute); return { reading, cropped: dispute.boxes.length > 0 }; };
let thirds: Dispute[] = [];

test('C1: both readings match the required text exactly: pass, no third reading', async () => {
  thirds = [];
  const out = await decideReadings(manifest, [read(OK), read(OK)], never);
  assert.deepEqual([out.accepted, out.defects, out.third], [true, [], undefined]);
});

test('C2: both find the same invented word: reject at once', async () => {
  const bad = read([...OK, 'Reply sent']);
  const out = await decideReadings(manifest, [bad, read([...OK, 'Reply sent'])], never);
  assert.equal(out.accepted, false);
  assert.deepEqual(out.defects, [{ kind: 'extra_text', text: 'reply sent' }]);
});

test('C3: one reader finds an extra word and the other does not: one targeted third reading, which decides', async () => {
  thirds = [];
  const withExtra = read([...OK, { text: 'Reply sent', box: [100, 600, 400, 650] }]);
  const cleared = await decideReadings(manifest, [withExtra, read(OK)], thirdOf(read(OK)));
  assert.equal(cleared.accepted, true);
  assert.equal(thirds.length, 1);
  assert.deepEqual(thirds[0]?.gates, ['text']);
  assert.deepEqual(thirds[0]?.boxes, [[100, 600, 400, 650]], 'the third reading is pointed at where the extra word was seen');
  assert.deepEqual(cleared.third?.cleared, ['text']);
  const confirmed = await decideReadings(manifest, [withExtra, read(OK)], thirdOf(read([...OK, 'Reply sent'])));
  assert.equal(confirmed.accepted, false);
  assert.deepEqual(confirmed.third?.confirmed, ['text']);
});

test('C4: one reader reads 25 and another 28: a third reading, and only a positively exact result passes', async () => {
  const man: TextManifest = { ...manifest, headline: 'Up to 25 team members' };
  const a = read(['Up to 25 team members', 'OyeChats', 'oyechats.com']);
  const b = read(['Up to 28 team members', 'OyeChats', 'oyechats.com']);
  assert.equal((await decideReadings(man, [a, b], thirdOf(a))).accepted, true);
  assert.equal((await decideReadings(man, [a, b], thirdOf(b))).accepted, false);
});

test('C5, C6: a mark seen by one reader goes to a third look; seen by both it is rejected immediately', async () => {
  thirds = [];
  const logo = read(OK, { marks: { ...clean, badgeSealAwardOrCertification: true }, markBoxes: { badgeSealAwardOrCertification: [700, 100, 900, 300] } });
  const split = await decideReadings(manifest, [logo, read(OK)], thirdOf(read(OK)));
  assert.equal(split.accepted, true);
  assert.deepEqual(thirds[0]?.gates, ['mark:badgeSealAwardOrCertification']);
  assert.deepEqual(thirds[0]?.boxes, [[700, 100, 900, 300]]);
  const both = await decideReadings(manifest, [logo, read(OK, { marks: { ...clean, badgeSealAwardOrCertification: true } })], never);
  assert.equal(both.accepted, false);
  assert.equal(both.defects[0]?.kind, 'forbidden_mark');
});

test('C7: a third reading that cannot establish the lettering rejects: uncertainty is not averaged away', async () => {
  const unsure: CreativeReview = read(OK);
  unsure.regions[0] = { text: 'Answers from your own', readable: false, box: null };
  const out = await decideReadings(manifest, [read([...OK, 'Docs 3']), read(OK)], thirdOf(unsure));
  assert.equal(out.accepted, false);
  assert.ok(out.defects.some((d) => d.kind === 'unreadable_text'));
});

test('C8: when no reader could place the dispute, the third reading gets the whole poster', async () => {
  thirds = [];
  await decideReadings(manifest, [read([...OK, 'Reply sent']), read(OK)], thirdOf(read(OK)));
  assert.deepEqual(thirds[0]?.boxes, []);
});

test('C9: readers that differ only in soft judgements never trigger a text adjudication, and one reader\'s doubt is a warning', async () => {
  const doubtful = read(OK, { composition: 0, readableSmall: false });
  const out = await decideReadings(manifest, [doubtful, read(OK)], never);
  assert.equal(out.accepted, true);
  assert.equal(out.warnings.length, 2);
  assert.match(out.warnings.join(' '), /not a rejection/);
  const both = await decideReadings(manifest, [doubtful, read(OK, { readableSmall: false })], never);
  assert.equal(both.accepted, false, 'when both readers find the text too small, that is a rejection');
  assert.deepEqual(both.defects, [{ kind: 'illegible_small' }]);
});

test('C10, C11: the brand named in the headline and the sign-off both count; a third reading that disproves an extra region passes that region', async () => {
  const named: TextManifest = { headline: 'OyeChats answers from your docs', brandName: 'OyeChats', domain: 'oyechats.com' };
  const ok = read(['OyeChats answers from your docs', 'OyeChats', 'oyechats.com']);
  assert.equal((await decideReadings(named, [ok, ok], never)).accepted, true);
  const stray = read([...OK, 'Docs 3']);
  assert.equal((await decideReadings(manifest, [stray, read(OK)], thirdOf(read(OK)))).accepted, true);
});

test('only the disputed gates are settled by the third reading: an agreed defect still rejects', async () => {
  const both = read([...OK, 'Reply sent'], { marks: { ...clean, flagOrReligiousSymbol: true } });
  const other = read([...OK, 'Reply sent']);
  const out = await decideReadings(manifest, [both, other], thirdOf(read(OK)));
  assert.equal(out.accepted, false, 'the extra text both readers found stands');
  assert.deepEqual(out.third?.gates, ['mark:flagOrReligiousSymbol']);
  assert.deepEqual(out.third?.cleared, ['mark:flagOrReligiousSymbol']);
});

test('a single reading decides alone, and a poster is never accepted without a reading', async () => {
  assert.equal((await decideReadings(manifest, [read(OK)], never)).accepted, true);
  assert.equal((await decideReadings(manifest, [read([...OK, 'Reply sent'])], never)).accepted, false);
  assert.equal((await decideReadings(manifest, [], never)).accepted, false, 'no reading is no acceptance');
});

test('boxes: padded by 15 percent inside the poster, joined into one region, ignored when they are not boxes', () => {
  assert.deepEqual(paddedBox([100, 100, 300, 200]), [70, 85, 330, 215]);
  assert.deepEqual(paddedBox([0, 0, 100, 100]), [0, 0, 115, 115]);
  assert.deepEqual(unionBox([[100, 100, 200, 200], [500, 600, 700, 800]]), paddedBox([100, 100, 700, 800]));
  assert.equal(unionBox([]), null);
  assert.deepEqual(disputedBoxes(manifest, [read([{ text: 'Answers from your own docs', box: [0, 0, 500, 100] }, { text: 'Stray', box: [1, 2, 3, 4] }])], ['text']), [[1, 2, 3, 4]], 'allowed text is not what is in dispute');
});

test('the crop page shows only the box, enlarged, with nothing fetched and no scripts', () => {
  const html = cropHtml('data:image/jpeg;base64,AAAA', [250, 250, 500, 500]);
  assert.match(html, /default-src 'none'; img-src data:/);
  assert.doesNotMatch(html, /<script/);
  assert.match(html, /width:4320px;height:4320px/, 'a quarter of the poster is shown at four times the width');
  assert.match(html, /left:-1080px;top:-1080px/);
});

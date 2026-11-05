import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  chooseBrandSlots,
  eligibleOptions,
  estimateFit,
  planShortlists,
  postFacts,
  scoreOptions,
  shortlistOf,
  type ArtRecord,
  type PostFacts,
} from './art-options.ts';
import type { Brand, PlannedPost } from './content.ts';
import { coversPicture, familyById, layoutRegistry, SAFE_FAMILY } from './layout-registry.ts';

const facts = (over: Partial<PostFacts> = {}): PostFacts => ({
  headline: 'Keep every |project| visible',
  subline: 'Acme shows where work stands',
  listItems: [],
  concernsOffering: false,
  ...over,
});
const NEUTRAL = facts({ headline: 'Keep every |project| visible at a glance' });
const RICH = facts({ listItems: ['Review status', 'Track tasks', 'Check deadlines'], figure: '40%', concernsOffering: true });
const record = (layout: string, over: Partial<ArtRecord> = {}): ArtRecord => ({ layout, hierarchy: 'headline-first', textZone: 'left', pictureRole: 'hero', ...over });
const layoutsOf = (f: PostFacts, settings = {}): string[] => [...new Set(eligibleOptions(f, layoutRegistry, settings).options.map((o) => o.layout))];

test('list content is needed for structured information, whatever the hook', () => {
  assert.ok(!layoutsOf(facts()).includes('structured-information'));
  assert.ok(!layoutsOf(facts({ listItems: ['only one'] })).includes('structured-information'));
  assert.ok(layoutsOf(facts({ listItems: ['Plan', 'Build', 'Ship'] })).includes('structured-information'));
});

test('an evidence layout needs a figure or a verified quote, and figure-first needs a figure', () => {
  assert.ok(!layoutsOf(facts()).includes('evidence-spotlight'));
  const quoteOnly = eligibleOptions(facts({ quote: 'Saved us hours every week' }), layoutRegistry, {}).options.filter((o) => o.layout === 'evidence-spotlight');
  assert.ok(quoteOnly.length > 0);
  assert.ok(quoteOnly.every((o) => o.hierarchy !== 'figure-first'));
  const withFigure = eligibleOptions(facts({ figure: '40%' }), layoutRegistry, {}).options.filter((o) => o.layout === 'evidence-spotlight');
  assert.ok(withFigure.some((o) => o.hierarchy === 'figure-first'));
});

test('an offering layout needs a post that concerns a verified offering, not a particular pillar', () => {
  assert.ok(layoutsOf(facts({ concernsOffering: true })).includes('feature-spotlight'));
  const reasons = eligibleOptions(facts(), layoutRegistry, {}).ineligible;
  assert.ok(reasons.some((r) => r.layout === 'feature-spotlight' && /offering/.test(r.reason)));
});

test('list-first needs list items and picture-first needs a picture', () => {
  const options = eligibleOptions(RICH, layoutRegistry, {}).options;
  assert.ok(options.some((o) => o.hierarchy === 'list-first'));
  assert.ok(options.every((o) => o.hierarchy !== 'picture-first' || o.pictureRole !== 'none'));
  const plain = eligibleOptions(facts(), layoutRegistry, {}).options;
  assert.ok(plain.every((o) => o.hierarchy !== 'list-first' && o.hierarchy !== 'figure-first'));
});

test('a tenant can switch a family off, except the safe fallback', () => {
  const off = layoutsOf(RICH, { disabled: ['full-bleed-editorial', SAFE_FAMILY] });
  assert.ok(!off.includes('full-bleed-editorial'));
  assert.ok(off.includes(SAFE_FAMILY));
  const weighted = layoutsOf(RICH, { familyWeights: { 'split-composition': 0 } });
  assert.ok(!weighted.includes('split-composition'));
});

test('when only the fallback family remains the shortlist has one option and no forced variety', () => {
  const only = { disabled: layoutRegistry.map((f) => f.id).filter((id) => id !== SAFE_FAMILY) };
  const [planned] = planShortlists({ posts: [facts()], history: [], settings: only });
  assert.equal(planned?.shortlist.length, 1);
  assert.equal(planned?.shortlist[0]?.layout, SAFE_FAMILY);
});

test('text fit is advisory: long headlines are penalised, not excluded', () => {
  const long = facts({ headline: 'Everything your whole team needs to keep every single project moving without any delay at all' });
  const family = familyById(layoutRegistry, 'split-composition');
  const zone = family?.zones.left;
  assert.ok(family && zone);
  assert.equal(estimateFit(facts(), family, zone, {}), 'likely_fit');
  assert.equal(estimateFit(long, family, zone, {}), 'likely_overflow');
  const options = eligibleOptions(long, layoutRegistry, {}).options;
  assert.ok(options.some((o) => o.layout === 'split-composition' && o.fit === 'likely_overflow'), 'still offered');
  const scored = scoreOptions(options, long, [], {}, layoutRegistry);
  const worst = scored.find((o) => o.fit === 'likely_overflow');
  const best = scored.find((o) => o.fit === 'likely_fit');
  if (worst && best) assert.ok(worst.score < best.score);
});

test('a non-Latin headline is never judged an overflow from English-sized glyphs', () => {
  const hindi = facts({ headline: 'हर प्रोजेक्ट को हमेशा साफ़ दिखाइए ताकि पूरी टीम समय पर काम पूरा कर सके और ग्राहक खुश रहें' });
  const options = eligibleOptions(hindi, layoutRegistry, {}).options;
  assert.ok(options.length > 0);
  assert.ok(options.every((o) => o.fit !== 'likely_overflow'));
  assert.ok(options.some((o) => o.fit === 'uncertain_fit'));
});

test('the shortlist spans families instead of returning three layouts of one family', () => {
  const scored = scoreOptions(eligibleOptions(RICH, layoutRegistry, {}).options, RICH, [], {}, layoutRegistry);
  const list = shortlistOf(scored, 3);
  assert.equal(list.length, 3);
  assert.equal(new Set(list.map((o) => o.layout)).size, 3);
  assert.deepEqual(list[0], scored[0]);
});

test('one eligible family returns its best option without padding', () => {
  const settings = { familyWeights: { 'split-composition': 0, 'full-bleed-editorial': 0 }, disabled: ['split-slim', 'split-wide', 'inset-card', 'feature-spotlight', 'structured-information', 'evidence-spotlight'] };
  const scored = scoreOptions(eligibleOptions(facts(), layoutRegistry, settings).options, facts(), [], settings, layoutRegistry);
  assert.deepEqual([...new Set(scored.map((o) => o.layout))], [SAFE_FAMILY]);
  assert.equal(shortlistOf(scored, 3).length, 1);
});

test('a seven-post week of varied posts uses at least four families and never repeats back to back', () => {
  const week = [RICH, NEUTRAL, facts({ listItems: ['One', 'Two', 'Three'] }), facts({ figure: '40%' }), facts({ concernsOffering: true }), facts({ headline: 'Plan |less|' }), NEUTRAL];
  const plans = planShortlists({ posts: week, history: [] });
  const picks = plans.map((p) => p.shortlist[0]?.layout);
  assert.ok(new Set(picks).size >= 4, picks.join(','));
  for (let i = 1; i < picks.length; i++) assert.notEqual(picks[i], picks[i - 1]);
});

test('repeated identical posts still rotate among the families that suit them', () => {
  const picks = planShortlists({ posts: Array.from({ length: 6 }, () => NEUTRAL), history: [] }).map((p) => p.shortlist[0]?.layout);
  assert.ok(new Set(picks).size >= 3, picks.join(','));
  for (let i = 1; i < picks.length; i++) assert.notEqual(picks[i], picks[i - 1]);
});

test('the same family used twice before makes an alternative preferred', () => {
  const history = [record('split-composition'), record('split-composition')];
  const scored = scoreOptions(eligibleOptions(RICH, layoutRegistry, {}).options, RICH, history, {}, layoutRegistry);
  assert.notEqual(scored[0]?.layout, 'split-composition');
});

test('a preferred family is used more, without removing the others', () => {
  const usage = (weights: Record<string, number>): Map<string, number> => {
    const counts = new Map<string, number>();
    const history: ArtRecord[] = [];
    for (let i = 0; i < 14; i++) {
      const [plan] = planShortlists({ posts: [NEUTRAL], history, settings: { familyWeights: weights } });
      const top = plan?.shortlist[0];
      assert.ok(top);
      counts.set(top.layout, (counts.get(top.layout) ?? 0) + 1);
      history.push({ layout: top.layout, hierarchy: top.hierarchy, textZone: top.zone, pictureRole: top.pictureRole });
    }
    return counts;
  };
  const even = usage({});
  const heavy = usage({ 'typography-hero': 12 });
  assert.ok((heavy.get('typography-hero') ?? 0) > (even.get('typography-hero') ?? 0));
  assert.ok(heavy.size >= 3, 'other families still appear');
});

test('suitability beats diversity: a figure post keeps its evidence layout even after it was used', () => {
  const post = facts({ figure: '40%', headline: 'Teams cut |40%| of status meetings', subline: 'Acme keeps work visible' });
  const scored = scoreOptions(eligibleOptions(post, layoutRegistry, {}).options, post, [record('evidence-spotlight', { hierarchy: 'figure-first', textZone: 'center', pictureRole: 'none' })], {}, layoutRegistry);
  assert.equal(scored[0]?.layout, 'evidence-spotlight');
});

test('suitability beats diversity: a short headline goes to a type-led layout when nothing else distinguishes the options', () => {
  const post = facts({ headline: 'Plan |less|', subline: 'Acme' });
  const scored = scoreOptions(eligibleOptions(post, layoutRegistry, {}).options, post, [], {}, layoutRegistry);
  assert.ok(scored[0]?.pictureRole === 'none' || scored[0]?.pictureRole === 'texture', `${scored[0]?.layout}`);
});

test('suitability beats diversity: options that would overflow rank below every option that fits, even when they are less used', () => {
  const post = facts({ headline: 'Everything your whole team needs to keep every single project moving without any delay at all', subline: 'Acme' });
  const history = [record(SAFE_FAMILY, { pictureRole: 'none', textZone: 'center' })];
  const scored = scoreOptions(eligibleOptions(post, layoutRegistry, {}).options, post, history, {}, layoutRegistry);
  assert.ok(scored.some((o) => o.fit === 'likely_overflow'), 'the case has overflowing options');
  assert.notEqual(scored[0]?.fit, 'likely_overflow');
  const best = scored[0]?.score ?? 0;
  for (const o of scored.filter((x) => x.fit === 'likely_overflow')) assert.ok(o.score < best, `${o.layout}/${o.zone}`);
});

test('the picture medium never blocks a repeat: mediums are only ordered, least recently used first', () => {
  const history = [record('split-composition', { pictureMedium: 'illustration' }), record('split-composition', { pictureMedium: 'illustration' })];
  const options = scoreOptions(eligibleOptions(RICH, layoutRegistry, {}).options, RICH, history, {}, layoutRegistry);
  const split = options.find((o) => o.layout === 'split-composition');
  assert.ok(split);
  assert.ok(split.mediums.includes('illustration'), 'still allowed');
  assert.notEqual(split.mediums[0], 'illustration');
});

test('brand elements rotate away from the last placements when a clean alternative exists, as a minor preference', () => {
  const split = familyById(layoutRegistry, 'split-composition');
  assert.ok(split);
  // The right zone puts the picture on the left, so the CTA stays top-right and only the logo seat can rotate.
  const first = chooseBrandSlots(split, 'right', []);
  assert.ok(first);
  const next = chooseBrandSlots(split, 'right', [{ ...record('split-composition'), logoSlot: first.logoSlot, ctaSlot: first.ctaSlot }]);
  assert.ok(next);
  assert.ok(next.logoSlot !== first.logoSlot || next.ctaSlot !== first.ctaSlot);
  const none = chooseBrandSlots({ ...split, logoSlots: [{ id: 'x', rect: { x: 64, y: 200, w: 400, h: 72 } }] }, 'left', []);
  assert.equal(none, undefined);
});

test('a brand slot is never worth more than a layout: slots are not shortlist candidates', () => {
  const options = eligibleOptions(RICH, layoutRegistry, {}).options;
  const keys = options.map((o) => `${o.layout}|${o.zone}|${o.hierarchy}|${o.pictureRole}`);
  assert.equal(new Set(keys).size, keys.length);
});

test('a provisional pick is replaced by the actual choice, and later shortlists follow the choice', () => {
  const posts = [RICH, RICH, RICH];
  const provisional = planShortlists({ posts, history: [] });
  const forced = record('typography-hero', { hierarchy: 'headline-first', textZone: 'top', pictureRole: 'none' });
  const updated = planShortlists({ posts, history: [], chosen: [forced] });
  assert.notEqual(updated[0]?.shortlist[0]?.layout, undefined);
  assert.notEqual(updated[1]?.shortlist[0]?.layout, 'typography-hero', 'the next post avoids the family actually used');
  assert.deepEqual(updated[0]?.shortlist, provisional[0]?.shortlist, 'earlier shortlists do not depend on later choices');
});

test('history belongs to one tenant: results depend only on the history passed in', () => {
  const busy = [record('split-composition'), record('split-composition'), record('split-composition')];
  const a = planShortlists({ posts: [RICH], history: busy });
  const b = planShortlists({ posts: [RICH], history: [] });
  const again = planShortlists({ posts: [RICH], history: busy });
  assert.deepEqual(a, again);
  assert.notDeepEqual(a[0]?.shortlist, b[0]?.shortlist);
});

test('ineligible families come with reasons, and a whole weekly batch needs no model or image', () => {
  const plans = planShortlists({ posts: [facts(), facts(), facts()], history: [] });
  for (const plan of plans) {
    assert.ok(plan.shortlist.length >= 1);
    assert.ok(plan.ineligible.length >= 1);
    for (const gone of plan.ineligible) assert.ok(gone.reason.length > 0);
  }
});

test('postFacts: distinct list items, a figure only when the verified anchor and the copy both carry it, and offering by shared content words', () => {
  const brand: Pick<Brand, 'offer' | 'features' | 'proofPoints'> = {
    offer: 'Project tracking software for small teams',
    features: [{ icon: 'monitor', title: 'Deadline reminders', detail: 'Never miss a due date' }],
    proofPoints: ['Teams cut 40% of status meetings'],
  };
  const post = (over: Partial<PlannedPost> = {}): PlannedPost => ({
    id: 'p1', date: '2026-11-10', painPoint: 'status', mode: 'ai', headline: 'Cut |40%| of status meetings', subline: 'Acme tracks projects', caption: 'c', hashtags: [],
    anchor: 'Teams cut 40% of status meetings', ...over,
  });
  const built = postFacts(post({ listItems: ['Plan work', 'plan work', 'Ship it', ' '] }), brand);
  assert.deepEqual(built.listItems, ['Plan work', 'Ship it']);
  assert.equal(built.figure, '40%');
  assert.equal(built.concernsOffering, true);
  assert.equal(postFacts(post({ headline: 'Cut meetings', subline: 'Less talk' }), brand).figure, undefined);
  assert.equal(postFacts(post({ anchor: 'Teams cut 90% of status meetings' }), brand).figure, undefined, 'an anchor that is not a verified proof point gives no figure');
  assert.equal(postFacts(post({ headline: 'A calm morning', subline: 'Coffee first' }), brand).concernsOffering, false);
});

test('identical inputs and settings give identical eligibility, ranking and shortlist', () => {
  const run = (): unknown => planShortlists({ posts: [RICH, facts()], history: [record('full-bleed-editorial')] });
  assert.deepEqual(run(), run());
});


test('the typography family offers its light editorial variant without a picture, so a short plain post has more than one safe treatment', () => {
  const options = eligibleOptions(NEUTRAL, layoutRegistry, {}).options.filter((o) => o.layout === 'typography-hero');
  const zones = new Set(options.map((o) => o.zone));
  assert.ok(zones.has('left') && zones.has('center') && zones.has('bottom') && zones.has('top'));
  assert.ok(options.filter((o) => o.zone === 'left').every((o) => o.pictureRole === 'none'));
});


test('a numbered-list headline keeps only layouts that show the list, so the count it promises is on the poster', () => {
  const required = eligibleOptions(facts({ listItems: ['WordPress', 'Webflow', 'Plain HTML'], listRequired: true }), layoutRegistry, {});
  assert.ok(required.options.length > 0);
  assert.ok(required.options.every((o) => o.layout === 'structured-information'));
  assert.ok(required.ineligible.some((i) => i.layout === 'feature-spotlight'));
  const open = eligibleOptions(facts({ listItems: ['WordPress', 'Webflow', 'Plain HTML'] }), layoutRegistry, {});
  assert.ok(open.options.some((o) => o.layout !== 'structured-information'));
  const brand = { offer: '', features: [], proofPoints: [] } as unknown as Pick<Brand, 'offer' | 'features' | 'proofPoints'>;
  const post = { id: 'p', date: '2026-11-04T10:00:00+05:30', painPoint: 'p', mode: 'template', headline: '3 |platforms| it works with', subline: 'Acme', caption: 'c', hashtags: [], hook: 'numbered_list', listItems: ['WordPress', 'Webflow', 'Plain HTML'] } as unknown as PlannedPost;
  assert.equal(postFacts(post, brand).listRequired, true);
  assert.equal(postFacts({ ...post, hook: 'question' } as PlannedPost, brand).listRequired, undefined);
});


import { surfaceOf } from './art-options.ts';

test('a poster with the same kind of surface as the one before it scores lower, so picture-free posts mix dark and light', () => {
  assert.equal(surfaceOf('typography-hero', 'center'), 'dark');
  assert.equal(surfaceOf('typography-hero', 'bottom'), 'light');
  assert.equal(surfaceOf('typography-hero', 'left'), 'light');
  assert.equal(surfaceOf('full-bleed-editorial', 'top'), 'picture');
  assert.equal(surfaceOf('structured-information', 'top'), 'light');
  const typeOnly = eligibleOptions(facts({ picture: { eligible: false, reasons: ['x'] } }), layoutRegistry, {}).options.filter((o) => o.layout === 'typography-hero');
  const scoreOf = (previousZone: 'center' | 'bottom', zone: string): number => {
    const history: ArtRecord[] = [{ layout: 'typography-hero', hierarchy: 'headline-first', textZone: previousZone, pictureRole: 'none' }];
    return scoreOptions(typeOnly, facts({ picture: { eligible: false, reasons: ['x'] } }), history, {}, layoutRegistry).find((o) => o.zone === zone)?.score ?? NaN;
  };
  // After a dark poster a light one is preferred to another dark one of equal standing; after a light one the reverse.
  assert.ok(scoreOf('center', 'bottom') > scoreOf('center', 'top'), 'light after dark');
  assert.ok(scoreOf('bottom', 'top') > scoreOf('bottom', 'left'), 'dark after light');
});

test('a CTA seat clear of the picture is chosen over one on top of it, even against the rotation preference', () => {
  const split = familyById(layoutRegistry, 'split-composition');
  assert.ok(split);
  const zone = split.zones.top;
  assert.ok(zone);
  const worn = split.ctaSlots.map((cta) => ({ ...record('split-composition'), ctaSlot: cta.id }));
  for (const history of [[], worn.slice(0, 1), worn.slice(1)]) {
    const chosen = chooseBrandSlots(split, 'top', history);
    assert.ok(chosen);
    const cta = split.ctaSlots.find((s) => s.id === chosen.ctaSlot);
    assert.ok(cta && !coversPicture(zone, cta), `CTA "${chosen.ctaSlot}" must stay off the picture`);
  }
});

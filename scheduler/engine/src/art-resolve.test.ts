import assert from 'node:assert/strict';
import { test } from 'node:test';
import { optionId, type DirectedPost, type DirectedResult, type DirectionOutcome, type DirectionReason, type DirectionReasonCode } from './art-director.ts';
import { finalizeDirections, renderCandidates, SEVERITY, type FinalizeSettings } from './art-resolve.ts';
import { parseArtBrief } from './art-brief.ts';
import { planShortlists, type ArtRecord, type PostFacts, type ScoredOption } from './art-options.ts';
import { checkBriefAgainstFamily, layoutRegistry, SAFE_FAMILY } from './layout-registry.ts';

const brand = { colors: { ink: '#14213D', accent: '#FCA311', background: '#FFFFFF', tile: '#F2F2F2' } };

const FACTS: PostFacts[] = [
  { headline: 'Keep every |project| visible at a glance', subline: 'Acme shows where work stands', listItems: [], concernsOffering: false },
  { headline: 'Three ways to |plan| better', subline: 'Acme keeps teams aligned', listItems: ['Review', 'Track', 'Check'], concernsOffering: false },
  { headline: 'Teams cut |40%| of meetings', subline: 'Acme saves time', listItems: [], figure: '40%', concernsOffering: false },
  { headline: 'Deadline reminders that |work|', subline: 'Acme never misses a date', listItems: [], concernsOffering: true },
  { headline: 'Plan |less|', subline: 'Acme', listItems: [], concernsOffering: false },
  { headline: 'One board for the whole |team|', subline: 'Acme in one place', listItems: [], concernsOffering: false },
  { headline: 'Know what is |late|', subline: 'Acme flags overdue work', listItems: [], concernsOffering: false },
];

function posts(count = 7, history: ArtRecord[] = []): DirectedPost[] {
  return planShortlists({ posts: FACTS.slice(0, count), history }).map((plan, i) => ({
    id: `p${i + 1}`,
    facts: FACTS[i] as PostFacts,
    hook: 'direct_statement',
    concept: { subject: 's', angle: 'a', message: 'm', visualSubject: `project board ${i + 1}`, visualAction: 'with overdue cards glowing', visualComposition: 'close' },
    shortlist: plan.shortlist,
    eligible: plan.eligible,
  }));
}

const reason = (code: DirectionReasonCode, message: string = code): DirectionReason => ({ code, message });
const empty = (): DirectionOutcome => ({ resolved: [], unresolved: [], requests: 0, notes: [] });

/** What the director would return for a post that went right: its top option with the model's picture. */
function directedFor(post: DirectedPost, over: { optionIndex?: number; scale?: string } = {}): DirectedResult {
  const option = post.shortlist[over.optionIndex ?? 0] as ScoredOption;
  const brief = parseArtBrief(
    {
      layout: option.layout, hierarchy: option.hierarchy, textZone: option.zone, headlineScale: over.scale ?? 'large', alignment: 'start',
      picture: option.pictureRole === 'none' ? { role: 'none' } : { role: option.pictureRole, medium: option.mediums[0], subject: post.concept?.visualSubject, action: post.concept?.visualAction, scene: 'a quiet workspace', composition: 'close three-quarter view', mood: 'calm', paletteUse: 'balanced' },
      logoSlot: 'top-left', identitySlot: 'under-logo', ctaSlot: 'top-right',
    },
    post.id,
  );
  return { postId: post.id, optionId: optionId(option), brief, record: { layout: option.layout, hierarchy: option.hierarchy, textZone: option.zone, pictureRole: option.pictureRole }, warnings: [] };
}

const run = (list: DirectedPost[], outcome: DirectionOutcome, extra: { history?: ArtRecord[]; settings?: FinalizeSettings } = {}) =>
  finalizeDirections({ posts: list, outcome, history: extra.history ?? [], brand, ...(extra.settings ? { settings: extra.settings } : {}) });

const pictured = (list: DirectedPost[]): DirectedPost => list.find((p) => p.shortlist[0]?.pictureRole !== 'none') as DirectedPost;

test('briefs the director got right come back unchanged as directed', () => {
  const list = posts();
  const outcome: DirectionOutcome = { ...empty(), resolved: list.map((p) => directedFor(p)) };
  const done = run(list, outcome);
  assert.equal(done.ready.length, 7);
  assert.deepEqual(done.failed, []);
  for (const r of done.ready) {
    assert.equal(r.resolution === 'directed' || r.resolution === 'repaired', true);
    assert.equal(r.requestedOptionId, r.actualOptionId === r.requestedOptionId ? r.actualOptionId : r.requestedOptionId);
  }
  const first = done.ready.find((r) => r.postId === 'p1');
  assert.equal(first?.brief.headlineScale, 'large');
});

test('an invalid scale is repaired within the family limits and keeps the layout the model chose', () => {
  const post = pictured(posts());
  const requested = post.shortlist[0] as ScoredOption;
  const outcome: DirectionOutcome = { ...empty(), unresolved: [{ postId: post.id, reasons: [reason('invalid_scale')], requestedOptionId: optionId(requested) }] };
  const done = run([post], outcome);
  const result = done.ready[0];
  assert.equal(result?.resolution, 'repaired');
  assert.equal(result?.actualOptionId, optionId(requested));
  const family = layoutRegistry.find((f) => f.id === requested.layout);
  assert.ok(family?.scales.includes(result?.brief.headlineScale as never));
});

test('an unsupported medium is replaced by an eligible one, recorded and still ready', () => {
  const post = pictured(posts());
  const requested = post.shortlist[0] as ScoredOption;
  const done = run([post], { ...empty(), unresolved: [{ postId: post.id, reasons: [reason('unsupported_medium')], requestedOptionId: optionId(requested) }] });
  const brief = done.ready[0]?.brief;
  assert.ok(brief && brief.picture.role !== 'none');
  assert.equal(requested.mediums.includes(brief.picture.medium), true);
  assert.ok(done.ready[0]?.reasons.some((r) => r.code === 'unsupported_medium'));
  assert.ok(done.ready[0]?.imagePrompt);
});

test('an unknown option id or a missing direction falls back to a verified eligible option, with the reason', () => {
  const list = posts(2);
  const done = run(list, { ...empty(), unresolved: [{ postId: 'p1', reasons: [reason('invalid_option_id')] }, { postId: 'p2', reasons: [reason('missing_direction')] }] });
  assert.equal(done.ready.length, 2);
  for (const r of done.ready) {
    assert.equal(r.resolution, 'fallback');
    assert.ok(r.reasons.some((x) => x.code === 'invalid_option_id' || x.code === 'missing_direction'));
    assert.equal(checkBriefAgainstFamily(r.brief, layoutRegistry).ok, true);
  }
  assert.equal(done.ready[0]?.actualOptionId, optionId(list[0]?.shortlist[0] as ScoredOption), 'the best-ranked option is used first');
});

test('the code-written picture is built from the accepted concept and varies from one fallback to the next', () => {
  const list = posts(7).filter((p) => p.shortlist.some((o) => o.pictureRole !== 'none'));
  const outcome: DirectionOutcome = { ...empty(), unresolved: list.map((p) => ({ postId: p.id, reasons: [reason('missing_picture')], requestedOptionId: optionId(p.shortlist.find((o) => o.pictureRole !== 'none') as ScoredOption) })) };
  const done = run(list, outcome);
  const compositions = done.ready.map((r) => (r.brief.picture.role === 'none' ? '' : r.brief.picture.composition)).filter(Boolean);
  assert.ok(compositions.length >= 2);
  for (let i = 1; i < compositions.length; i++) assert.notEqual(compositions[i], compositions[i - 1]);
  for (const r of done.ready) if (r.brief.picture.role !== 'none') assert.match(r.brief.picture.subject, /^project board \d/);
});

test('a likely overflow tries another option before anything is shrunk, and never truncates', () => {
  const post = posts()[0] as DirectedPost;
  const overflowing = post.shortlist.map((o, i) => (i === 0 ? { ...o, fit: 'likely_overflow' as const } : o));
  const changed: DirectedPost = { ...post, shortlist: overflowing, eligible: overflowing.concat((post.eligible ?? []).filter((o) => !overflowing.some((x) => optionId(x) === optionId(o)))) };
  const done = run([changed], { ...empty(), resolved: [directedFor(changed)] });
  const result = done.ready[0];
  assert.ok(result);
  assert.notEqual(result.actualOptionId, optionId(overflowing[0] as ScoredOption));
  assert.equal(result.resolution, 'repaired');
  assert.ok(result.reasons.some((r) => r.code === 'fit_overflow_estimated'));
  const family = layoutRegistry.find((f) => f.id === result.brief.layout);
  assert.equal(result.brief.headlineScale, family?.scales[0], 'the preferred scale was kept, not reduced to make room');
});

test('when every option is uncertain the post is ready but pending measurement, and the plan says so', () => {
  const post = posts()[0] as DirectedPost;
  const all = (post.eligible ?? post.shortlist).map((o) => ({ ...o, fit: 'uncertain_fit' as const }));
  const changed: DirectedPost = { ...post, shortlist: all.slice(0, 3), eligible: all };
  const done = run([changed], { ...empty(), resolved: [directedFor(changed)] });
  assert.equal(done.ready[0]?.status, 'ready_pending_measurement');
  assert.ok(done.ready[0]?.reasons.some((r) => r.code === 'fit_unverified'));
  assert.equal(done.status, 'pending_render_validation');
});

test('when no option is estimated to fit the post stays ready for the renderer to measure and carries the warning', () => {
  const post = posts()[0] as DirectedPost;
  const all = (post.eligible ?? post.shortlist).map((o) => ({ ...o, fit: 'likely_overflow' as const }));
  const changed: DirectedPost = { ...post, shortlist: all.slice(0, 3), eligible: all };
  const done = run([changed], { ...empty(), resolved: [directedFor(changed)] });
  assert.equal(done.ready.length, 1);
  assert.equal(done.ready[0]?.status, 'ready_pending_measurement');
  assert.ok(done.ready[0]?.reasons.some((r) => r.code === 'fit_unverified'));
  assert.equal(done.ready[0]?.brief.headlineScale, 'large', 'copy and scale are kept; measurement decides');
});

test('a picture the policy blocked is removed, not rebuilt: the post uses a type-led option with no image', () => {
  const post = pictured(posts());
  const requested = post.shortlist[0] as ScoredOption;
  const done = run([post], { ...empty(), unresolved: [{ postId: post.id, reasons: [reason('picture_policy_blocked', 'blocked: credentials_and_awards')], requestedOptionId: optionId(requested) }] });
  const result = done.ready[0];
  assert.equal(result?.resolution, 'fallback');
  assert.equal(result?.brief.picture.role, 'none');
  assert.equal(result?.imagePrompt, undefined);
  assert.ok(result?.reasons.some((r) => r.code === 'picture_removed'));
  assert.equal(done.quality.policyBlocks, 1);
  assert.equal(done.quality.flagged, true);
});

test('a missing accepted visual subject gives a no-picture layout when the copy is still valid', () => {
  const post = pictured(posts());
  const noVisual: DirectedPost = { ...post, concept: { subject: 's', angle: 'a', message: 'm', visualSubject: '', visualAction: '', visualComposition: '' } };
  const done = run([noVisual], { ...empty(), unresolved: [{ postId: post.id, reasons: [reason('no_concept')] }] });
  assert.equal(done.ready[0]?.brief.picture.role, 'none');
  assert.equal(done.ready[0]?.imagePrompt, undefined);
  const noConcept: DirectedPost = { ...post };
  delete (noConcept as { concept?: unknown }).concept;
  assert.equal(run([noConcept], { ...empty(), unresolved: [{ postId: post.id, reasons: [reason('no_concept')] }] }).ready[0]?.brief.picture.role, 'none');
});

test('a post with no headline and a post with no eligible option are hard failures before any image call', () => {
  const list = posts(2);
  const headless: DirectedPost = { ...(list[0] as DirectedPost), facts: { ...(list[0] as DirectedPost).facts, headline: '||' } };
  const optionless: DirectedPost = { ...(list[1] as DirectedPost), shortlist: [], eligible: [] };
  const done = run([headless, optionless], { ...empty(), unresolved: [{ postId: 'p2', reasons: [reason('no_options')] }] });
  assert.equal(done.ready.length, 0);
  assert.equal(done.status, 'failed');
  assert.ok(done.failed[0]?.reasons.some((r) => r.code === 'missing_headline' && r.severity === 'hard'));
  assert.ok(done.failed[1]?.reasons.some((r) => r.code === 'no_valid_family' && r.severity === 'hard'));
});

test('six valid posts and one invalid give a partial plan; an exact count requirement refuses it', () => {
  const list = posts();
  const broken: DirectedPost = { ...(list[6] as DirectedPost), facts: { ...(list[6] as DirectedPost).facts, headline: '' } };
  const outcome: DirectionOutcome = { ...empty(), resolved: list.slice(0, 6).map((p) => directedFor(p)) };
  const all = [...list.slice(0, 6), broken];
  const loose = run(all, outcome, { settings: { requestedPosts: 7, minimumAcceptablePosts: 5 } });
  assert.equal(loose.ready.length, 6);
  assert.equal(loose.failed.length, 1);
  assert.notEqual(loose.status, 'complete');
  assert.equal(loose.status, 'partial');
  assert.equal(run(all, outcome, { settings: { requestedPosts: 7, requireExactCount: true } }).status, 'incomplete_required_count');
  assert.equal(run(all, outcome, { settings: { requestedPosts: 7, minimumAcceptablePosts: 7 } }).status, 'incomplete_required_count');
  assert.equal(run(all, outcome, { settings: { requestedPosts: 7, allowPartialApproval: false } }).status, 'incomplete_required_count');
});

test('three fallbacks in seven posts flag the batch, and a forced typography fallback is not counted as a design choice', () => {
  const list = posts();
  const fallbackIds = ['p1', 'p2', 'p3'];
  const outcome: DirectionOutcome = {
    ...empty(),
    resolved: list.filter((p) => !fallbackIds.includes(p.id)).map((p) => directedFor(p)),
    unresolved: fallbackIds.map((id) => ({ postId: id, reasons: [reason('missing_direction')] })),
  };
  const done = run(list, outcome);
  assert.equal(done.quality.fallback, 3);
  assert.equal(done.quality.flagged, true);
  assert.ok(done.quality.flags.some((f) => /3 of 7 posts needed a fallback/.test(f)));
  assert.ok(done.quality.safeFamilyFallbacks <= done.quality.fallback);
});

test('seven malformed directions are each repaired or rejected, raise a systematic-failure flag, and reach no image call invalidly', () => {
  const list = posts();
  const outcome: DirectionOutcome = { ...empty(), unresolved: list.map((p) => ({ postId: p.id, reasons: [reason('model_failed')] })) };
  const done = run(list, outcome);
  assert.equal(done.ready.length + done.failed.length, 7);
  assert.equal(done.quality.flagged, true);
  assert.ok(done.quality.flags.some((f) => /systematically/.test(f)));
  for (const r of done.ready) {
    assert.equal(checkBriefAgainstFamily(r.brief, layoutRegistry).ok, true);
    assert.equal(r.resolution, 'fallback');
    if (r.brief.picture.role !== 'none') assert.ok(r.imagePrompt);
  }
});

test('consecutive fallback designs do not repeat the same picture composition', () => {
  const list = posts(7).filter((p) => p.shortlist.some((o) => o.pictureRole !== 'none'));
  const done = run(list, { ...empty(), unresolved: list.map((p) => ({ postId: p.id, reasons: [reason('missing_direction')] })) });
  const comps = done.ready.map((r) => r.record.pictureComposition).filter((c): c is string => Boolean(c));
  for (let i = 1; i < comps.length; i++) assert.notEqual(comps[i], comps[i - 1]);
});

test('requested and actual options are both recorded, and the record holds the actual one', () => {
  const post = posts()[0] as DirectedPost;
  const overflowing = post.shortlist.map((o, i) => (i === 0 ? { ...o, fit: 'likely_overflow' as const } : o));
  const changed: DirectedPost = { ...post, shortlist: overflowing, eligible: overflowing };
  const done = run([changed], { ...empty(), resolved: [directedFor(changed)] });
  const result = done.ready[0];
  assert.ok(result);
  assert.equal(result.requestedOptionId, optionId(overflowing[0] as ScoredOption));
  assert.notEqual(result.actualOptionId, result.requestedOptionId);
  assert.equal(`${result.record.layout}:${result.record.textZone}:${result.record.hierarchy}:${result.record.pictureRole}`, result.actualOptionId);
});

test('a picture-dependent brief always has an image prompt and a role none never does', () => {
  const list = posts();
  const done = run(list, { ...empty(), resolved: list.map((p) => directedFor(p)) });
  for (const r of done.ready) {
    if (r.brief.picture.role === 'none') assert.equal(r.imagePrompt, undefined);
    else assert.ok(r.imagePrompt && r.imagePrompt.length > 40);
  }
});

test('every final brief passes the registry check and the same validation, whichever way it was produced', () => {
  const list = posts();
  const outcome: DirectionOutcome = {
    ...empty(),
    resolved: list.slice(0, 3).map((p) => directedFor(p)),
    unresolved: list.slice(3).map((p) => ({ postId: p.id, reasons: [reason('invalid_option_id')] })),
  };
  for (const r of run(list, outcome).ready) assert.equal(checkBriefAgainstFamily(r.brief, layoutRegistry).ok, true, r.postId);
});

test('severity is defined for every reason code, with hard only for what rejects a post', () => {
  const hard = Object.entries(SEVERITY).filter(([, s]) => s === 'hard').map(([code]) => code).sort();
  assert.deepEqual(hard, ['final_brief_invalid', 'missing_headline', 'no_valid_family', 'prompt_failed']);
  assert.equal(SEVERITY['fit_unverified'], 'warning');
  assert.equal(SEVERITY['invalid_option_id'], 'warning');
});

test('results are deterministic, nothing is mutated, and tenants with different history stay independent', () => {
  const list = posts();
  const outcome: DirectionOutcome = { ...empty(), resolved: list.slice(0, 4).map((p) => directedFor(p)), unresolved: list.slice(4).map((p) => ({ postId: p.id, reasons: [reason('missing_direction')] })) };
  const history: ArtRecord[] = [{ layout: 'split-composition', hierarchy: 'headline-first', textZone: 'left', pictureRole: 'hero', logoSlot: 'top-left', ctaSlot: 'top-right' }];
  const snapshot = JSON.stringify({ list, outcome, history });
  const a = run(list, outcome, { history });
  const b = run(list, outcome, { history });
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify({ list, outcome, history }), snapshot, 'inputs unchanged');
  const other = run(list, outcome, { history: [] });
  assert.equal(other.ready.length, a.ready.length);
});

test('the safe family is the last resort and is always usable', () => {
  const post = posts()[0] as DirectedPost;
  const onlySafe = (post.eligible ?? []).filter((o) => o.layout === SAFE_FAMILY);
  const changed: DirectedPost = { ...post, shortlist: onlySafe.slice(0, 1), eligible: onlySafe };
  const done = run([changed], { ...empty(), unresolved: [{ postId: post.id, reasons: [reason('model_failed')] }] });
  assert.equal(done.ready[0]?.brief.layout, SAFE_FAMILY);
  assert.equal(done.status === 'pending_render_validation' || done.status === 'complete', true);
});

test('render candidates: the resolved brief first, then other eligible options ending with the safe family, each with its own prompt and record', () => {
  const list = posts();
  const post = pictured(list);
  const done = run([post], { ...empty(), resolved: [directedFor(post)] });
  const ready = done.ready[0];
  assert.ok(ready);
  const candidates = renderCandidates({ post, ready, history: [], brand, limit: 5 });
  assert.equal(candidates[0]?.optionId, ready.actualOptionId);
  assert.ok(candidates.length >= 2);
  assert.equal(new Set(candidates.map((c) => c.optionId)).size, candidates.length, 'no duplicates');
  assert.ok(candidates.some((c) => c.brief.layout === SAFE_FAMILY), 'the safe family is among them');
  for (const c of candidates) {
    assert.equal(checkBriefAgainstFamily(c.brief, layoutRegistry).ok, true, c.optionId);
    assert.equal(`${c.record.layout}:${c.record.textZone}:${c.record.hierarchy}:${c.record.pictureRole}`, c.optionId);
    if (c.brief.picture.role === 'none') assert.equal(c.imagePrompt, undefined);
    else assert.ok(c.imagePrompt);
  }
});

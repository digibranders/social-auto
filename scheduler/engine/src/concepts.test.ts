import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkConcept, parseConcept, type Concept, type ConceptRecord } from './concepts.ts';

const FRESH_LOOK = { visualSubject: 'wall calendar', visualAction: 'circling a date', visualComposition: 'overhead' };
const concept = (over: Partial<Concept> = {}): Concept => ({
  subject: 'project tracking', angle: 'deadline visibility', message: 'spot overdue tasks early', visualSubject: 'project dashboard', visualAction: 'highlighting overdue work', visualComposition: 'close-up',
  ...over,
});
let n = 0;
const record = (over: Omit<Partial<ConceptRecord>, 'concept'> & { concept?: Partial<Concept> } = {}): ConceptRecord => {
  n += 1;
  const { concept: c, ...rest } = over;
  return { id: `p${n}`, date: '2026-10-01T10:00:00+05:30', headline: `headline ${n}`, pillar: 'education', hook: 'question', format: 'illustration', concept: concept(c), ...rest };
};
const candidate = (over: { concept?: Partial<Concept>; headline?: string; pillar?: string; anchor?: string; date?: string } = {}) => ({
  concept: concept(over.concept), headline: over.headline ?? 'a new headline', pillar: over.pillar ?? 'education', date: over.date ?? '2026-10-05T10:00:00+05:30', ...(over.anchor ? { anchor: over.anchor } : {}),
});
const check = (c: ReturnType<typeof candidate>, history: ConceptRecord[] = [], batch: ConceptRecord[] = [], config = {}) => checkConcept(c, { history, batch }, config);

test('the same concept is a repeat whatever hook, headline or pillar carries it', () => {
  const result = check(candidate({ headline: 'something else entirely', pillar: 'problem' }), [record({ hook: 'numbered_list' })]);
  assert.equal(result.status, 'duplicate_message');
  assert.equal(result.matches.length, 1);
});

test('an identical normalized headline is a repeat even with a different concept', () => {
  const result = check(candidate({ concept: { subject: 'team chat', angle: 'noise', message: 'mute channels' }, headline: 'Is your |inbox| full?' }), [record({ headline: 'is your inbox full', concept: { subject: 'email' } })]);
  assert.equal(result.status, 'duplicate_message');
});

test('the same product with a different angle or use case is allowed', () => {
  assert.equal(check(candidate({ concept: { angle: 'team visibility', message: 'everyone sees the same status', ...FRESH_LOOK } }), [record()]).status, 'ok');
});

test('different wording of the same idea is a repeat only when the brand approved the words as equivalent', () => {
  const reworded = candidate({ concept: { angle: 'late awareness', message: 'find delayed work sooner', ...FRESH_LOOK } });
  const history = [record({ concept: { angle: 'deadline visibility', message: 'spot overdue tasks early' } })];
  assert.equal(check(reworded, history).status, 'ok');
  const synonyms = { late: 'overdue', delayed: 'overdue', awareness: 'visibility', find: 'spot', sooner: 'early', work: 'task', deadline: 'late' };
  assert.equal(check(reworded, history, [], { synonyms }).status, 'duplicate_message');
});

test('reversed meaning is not the same idea: prevent versus recover, and negation is kept', () => {
  const prevent = [record({ concept: { subject: 'data protection', angle: 'loss', message: 'prevent data loss' } })];
  assert.equal(check(candidate({ concept: { subject: 'data protection', angle: 'loss', message: 'recover from data loss', ...FRESH_LOOK } }), prevent).status, 'ok');
  const lose = [record({ concept: { subject: 'data protection', angle: 'loss', message: 'lose data' } })];
  assert.equal(check(candidate({ concept: { subject: 'data protection', angle: 'loss', message: 'do not lose data', ...FRESH_LOOK } }), lose).status, 'ok');
});

test('a repeated picture idea is a visual repeat, and a new composition of the same subject is fine', () => {
  const history = [record()];
  const sameLook = check(candidate({ concept: { angle: 'team visibility', message: 'everyone sees one status' } }), history);
  assert.equal(sameLook.status, 'duplicate_visual');
  assert.match(sameLook.reasons.join(' '), /picture|visual/i);
  assert.equal(check(candidate({ concept: { angle: 'team visibility', message: 'everyone sees one status', visualComposition: 'wide overhead' } }), history).status, 'ok');
});

test('a message repeat outranks a visual repeat, and both reasons are reported', () => {
  const result = check(candidate(), [record()]);
  assert.equal(result.status, 'duplicate_message');
  assert.ok(result.reasons.length >= 2);
});

test('the same proof point for the same pillar and angle within a few posts is a repeat; from a different angle it is only noted, and later or for another pillar it is nothing', () => {
  const anchor = 'Free first visit for new patients';
  const earlier = { subject: 'new patients', angle: 'first visit', message: 'nothing to pay at first', visualSubject: 'door', visualAction: 'opening', visualComposition: 'wide' };
  const history = [record({ anchor, pillar: 'proof', concept: earlier })];
  const sameTopic = { concept: { subject: 'patient welcome', angle: 'first visit', message: 'start without paying', visualSubject: 'ticket', visualAction: 'tearing', visualComposition: 'macro' }, anchor, pillar: 'proof' };
  assert.equal(check(candidate(sameTopic), history).status, 'duplicate_message');
  const otherTopic = { ...sameTopic, concept: { ...sameTopic.concept, angle: 'cost worries' } };
  const noted = check(candidate(otherTopic), history);
  assert.equal(noted.status, 'ok');
  assert.match(noted.warnings.join(' '), /proof point was also used/);
  assert.equal(check(candidate({ ...sameTopic, pillar: 'education' }), history).status, 'ok');
  const farBack = [record({ anchor, pillar: 'proof', concept: earlier }), ...Array.from({ length: 6 }, () => record({ concept: { subject: `other ${n}`, angle: `x${n}`, message: `m${n}`, visualSubject: `v${n}`, visualAction: `a${n}`, visualComposition: `c${n}` } }))];
  assert.equal(check(candidate(sameTopic), farBack).status, 'ok');
});

test('repeats inside the same plan are caught like repeats of history', () => {
  assert.equal(check(candidate(), [], [record()]).status, 'duplicate_message');
});

test('only the last 40 posts count, wherever the week boundaries fall', () => {
  const fillers = Array.from({ length: 40 }, () => record({ concept: { subject: `s${n}`, angle: `a${n}`, message: `m${n}`, visualSubject: `vs${n}`, visualAction: `va${n}`, visualComposition: `vc${n}` } }));
  assert.equal(check(candidate(), [record(), ...fillers]).status, 'ok');
  assert.equal(check(candidate(), [record(), ...fillers.slice(0, 39)]).status, 'duplicate_message');
});

test('the same subject and angle with a new message soon after is allowed with a warning, and after the cooldown it is a labelled revisit', () => {
  const old = record({ date: '2026-09-01T10:00:00+05:30', concept: { message: 'track every deadline in one view', visualSubject: 'calendar', visualAction: 'filling', visualComposition: 'wide' } });
  const different = { message: 'see which tasks slipped', visualSubject: 'clock', visualAction: 'ticking', visualComposition: 'macro' };
  const soon = check(candidate({ concept: different, date: '2026-09-05T10:00:00+05:30' }), [old]);
  assert.equal(soon.status, 'ok');
  assert.match(soon.warnings.join(' '), /same angle/i);
  const later = check(candidate({ concept: different, date: '2026-10-05T10:00:00+05:30' }), [old]);
  assert.equal(later.status, 'revisit');
  assert.equal(later.revisitOf, old.id);
});

test('a revisit still fails the exact-duplicate checks', () => {
  const old = record({ date: '2026-08-01T10:00:00+05:30' });
  assert.equal(check(candidate({ date: '2026-10-05T10:00:00+05:30' }), [old]).status, 'duplicate_message');
});

test('text the checker cannot compare is reported as unchecked, never passed as unique', () => {
  const result = check(candidate({ concept: { subject: 'プロジェクト管理', angle: '期限', message: '遅れを見つける' } }), [record()]);
  assert.equal(result.status, 'unchecked');
  assert.match(result.reasons.join(' '), /language|script/i);
});

test('words every post of the brand uses do not make two posts the same', () => {
  const base = { subject: 'acme planner', angle: 'acme planner usage' };
  const filler = (i: number) => record({ concept: { ...base, message: `acme planner topic${'abcdefghijkl'[i]}${i}`, visualSubject: `thing${i}x`, visualAction: `act${i}y`, visualComposition: `frame${i}z` } });
  const target = record({ concept: { ...base, message: 'acme planner shows weekly team status report', visualSubject: 'chart', visualAction: 'rising', visualComposition: 'wide' } });
  const next = candidate({ concept: { ...base, message: 'acme planner shows weekly team status invoice', ...FRESH_LOOK } });
  assert.equal(check(next, [target]).status, 'duplicate_message');
  assert.equal(check(next, [target, ...Array.from({ length: 11 }, (_, i) => filler(i))]).status, 'ok');
});

test('concept fields must all be present text: a malformed concept fails, so the check cannot be skipped', () => {
  assert.deepEqual(parseConcept(concept()), concept());
  assert.throws(() => parseConcept(undefined), /concept/);
  assert.throws(() => parseConcept({ ...concept(), message: '' }), /message/);
  assert.throws(() => parseConcept({ ...concept(), visualAction: 3 }), /visualAction/);
  // A field over the limit is cut at a word, not refused.
  const long = `${'word '.repeat(40)}end`;
  const clipped = parseConcept({ ...concept(), subject: long }).subject;
  assert.ok(clipped.length <= 100 && clipped.startsWith('word word'));
  assert.throws(() => parseConcept({ ...concept(), subject: '   ' }), /subject/);
  // The picture's subject and action are kept whole up to the picture limit, and refused (not cut) beyond it.
  const kept = `${'a '.repeat(70)}b`.trim();
  assert.equal(parseConcept({ ...concept(), visualSubject: kept }).visualSubject, kept);
  assert.throws(() => parseConcept({ ...concept(), visualAction: 'x '.repeat(100) }), /visualAction.*160/);
});

test('the decision is a pure function: the same inputs give the same result', () => {
  const history = [record(), record({ concept: { angle: 'other' } })];
  assert.deepEqual(check(candidate(), history), check(candidate(), history));
});

test('with creative moves offered, the concept must name one of them with what the picture shows and why it matches; without, a move is optional', () => {
  const base = { subject: 'handoff', angle: 'to a person', message: 'a human takes over', visualSubject: 'a chat bubble', visualAction: 'passes to a second bubble', visualComposition: 'wide' };
  assert.throws(() => parseConcept(base, ['direct_demonstration']), /moveId/);
  assert.throws(() => parseConcept({ ...base, moveId: 'evidence_hero', visualRelationship: 'x', relationshipExplanation: 'y' }, ['direct_demonstration']), /one of: direct_demonstration/);
  assert.throws(() => parseConcept({ ...base, moveId: 'direct_demonstration', visualRelationship: 'x' }, ['direct_demonstration']), /relationshipExplanation/);
  const ok = parseConcept({ ...base, moveId: 'direct_demonstration', visualRelationship: 'a bubble passing along a line to a second bubble', relationshipExplanation: 'the hand-off in the fact is the pass between bubbles' }, ['direct_demonstration', 'mapped_metaphor']);
  assert.equal(ok.moveId, 'direct_demonstration');
  assert.match(ok.visualRelationship ?? '', /passing/);
  assert.equal(parseConcept(base).moveId, undefined);
});

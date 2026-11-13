import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidateCount, headlineLengthScore, noveltyScore, scoreCandidate, selectBest, type Candidate } from './candidate-selection.ts';
import { assessVerdict, isEmptyQuestion, materialSentences, parseClaimVerdict, type ClaimVerdict } from './claim-verdict.ts';
import { buildRewriteRequest, validateRewrite } from './copy-rewrite.ts';
import type { EvidenceFact } from './evidence.ts';

// ---- A. candidate count, ranking and selection

test('A1-A2: twice as many candidates as posts, never more than there are distinct eligible facts, and never padded', () => {
  assert.equal(candidateCount(4, 12), 8);
  assert.equal(candidateCount(4, 3), 3, 'only three eligible facts: at most three candidates, so fewer posts');
  assert.equal(candidateCount(1, 9), 2);
  assert.equal(candidateCount(3, 100), 6);
  assert.equal(candidateCount(4, 0), 0);
  assert.equal(candidateCount(10, 100), 10, 'the cap of 8 never goes below the number requested');
});

const c = (id: string, factId: string, headline: string, proposition: string, worth?: number): Candidate => ({ id, factId, headline, proposition, ...(worth !== undefined ? { worth } : {}) });

test('A3, A5: one candidate per fact in the batch, and a repeated proposition is not chosen twice', () => {
  const result = selectBest([
    c('a', 'f1', 'Sales picks up with full context', 'a salesperson takes over a chat with the whole transcript', 6),
    c('b', 'f1', 'Your team gets the whole transcript', 'a salesperson takes over a chat with the whole transcript', 5),
    c('c', 'f2', 'Hand a chat over with the whole transcript to sales', 'a salesperson takes over a chat with the whole transcript', 5),
    c('d', 'f3', 'A free plan with no credit card', 'the product has a free plan', 4),
  ], 4);
  assert.deepEqual(result.selected.map((s) => s.id), ['a', 'd']);
  assert.ok(result.skipped.some((s) => s.id === 'b' && /same fact/.test(s.reason)));
  assert.ok(result.skipped.some((s) => s.id === 'c' && /says what a post already chosen says/.test(s.reason)));
});

test('A6: a long headline with an essential qualification is only ranked lower, never cut', () => {
  assert.equal(headlineLengthScore('Free plan: up to five active projects for small teams that are just starting out'), 0.5);
  assert.equal(headlineLengthScore('Answers from your own docs'), 1);
  assert.equal(headlineLengthScore('Hi'), 0);
  const long = c('long', 'f1', 'Basic plan: up to 25 team members for every small team starting out with us today', 'basic plan limit', 5);
  assert.ok(scoreCandidate(long, []) < scoreCandidate({ ...long, headline: 'Basic plan: up to 25 team members' }, []));
  assert.deepEqual(selectBest([long], 1).selected.map((s) => s.headline), [long.headline], 'the headline text is untouched');
});

test('scoring: 0.55 worth + 0.35 novelty + 0.10 length, reproducible, and ties go to the lower fact id', () => {
  const x = c('x', 'f1', 'Answers from your own docs', 'answers from documents', 6);
  assert.ok(Math.abs(scoreCandidate(x, []) - (0.55 * 1 + 0.35 * 1 + 0.1 * 1)) < 1e-9);
  assert.ok(Math.abs(scoreCandidate({ ...x, worth: undefined }, []) - (0.55 * 0.5 + 0.35 + 0.1)) < 1e-9, 'an unjudged fact counts as 0.5');
  assert.equal(noveltyScore(x, ['Answers from your own docs answers from documents']), 0, 'a repeat of recent work has no novelty');
  const tie = selectBest([c('b', 'f9', 'Plan your week in one place', 'weekly planning', 3), c('a', 'f2', 'Track every task to the end', 'task tracking', 3)], 2);
  assert.deepEqual(tie.selected.map((s) => s.factId), ['f2', 'f9']);
  assert.deepEqual(selectBest([x], 1).selected, selectBest([x], 1).selected);
});

test('the better ranked candidate wins, and of two near-equal ones the more different is preferred', () => {
  const lead = c('lead', 'f1', 'Answers from your own docs', 'answers drawn from your documents', 6);
  const alike = c('alike', 'f2', 'Answers drawn from your own documents', 'answers drawn from your documents library', 5.9);
  const other = c('other', 'f3', 'Scores come from the conversation', 'conversation scoring without a form', 5.9);
  const result = selectBest([lead, alike, other], 2);
  assert.equal(result.selected[0]?.id, 'lead');
  assert.equal(result.selected[1]?.id, 'other');
  assert.deepEqual(result.reserve.map((r) => r.id).concat(result.skipped.map((s) => s.id)).sort(), ['alike']);
});

test('A10: candidates that were not chosen come back as the reserve, best first', () => {
  const result = selectBest([c('a', 'f1', 'Answers from your own docs', 'answers from documents', 6), c('b', 'f2', 'Scores come from the conversation', 'conversation scoring', 5), c('d', 'f3', 'A free plan forever', 'a free plan', 4)], 1);
  assert.deepEqual(result.selected.map((s) => s.id), ['a']);
  assert.deepEqual(result.reserve.map((r) => r.id), ['b', 'd']);
});

// ---- B. the claim verdict

const evidence = { factId: 'f1', quotes: ['Answers visitor questions using your website content.'] };
const draft = { headline: 'Answer visitor questions using your website content', subline: '', caption: 'Help visitors find answers drawn from your website content.' };
const supported = (over: Partial<ClaimVerdict> = {}): ClaimVerdict => ({
  decision: 'SUPPORTED', factId: 'f1', violations: [],
  coverage: [
    { field: 'headline', claimText: 'Answer visitor questions using your website content', sourceQuote: 'Answers visitor questions using your website content.' },
    { field: 'caption', claimText: 'Help visitors find answers drawn from your website content.', sourceQuote: 'Answers visitor questions using your website content.' },
  ], ...over,
});

test('B1: SUPPORTED with every material sentence mapped to a stored quote continues', () => {
  assert.deepEqual(assessVerdict(supported(), draft, evidence), { action: 'continue' });
});

test('B2: SUPPORTED while the caption holds an unmapped promise is invalid and goes to adjudication', () => {
  const loaded = { ...draft, caption: 'Help visitors find answers drawn from your website content. Every question is answered in seconds.' };
  const result = assessVerdict(supported(), loaded, evidence);
  assert.equal(result.action, 'adjudicate');
  assert.match((result as { problems: string[] }).problems.join(' '), /Every question is answered in seconds/);
});

test('B2b: a hook question that asserts nothing needs no quote, but a question that carries a claim, and every statement, still does', () => {
  assert.equal(isEmptyQuestion('Ready to talk?'), true);
  assert.equal(isEmptyQuestion('Which kind of digital support are you looking for?'), true);
  assert.equal(isEmptyQuestion('Why is it the fastest?'), false, 'a superlative inside a question is a claim');
  assert.equal(isEmptyQuestion('Want 50% off?'), false, 'a figure inside a question is a claim');
  assert.equal(isEmptyQuestion('Help visitors find answers drawn from your website content.'), false, 'a statement is never skipped');
  const asked = { ...draft, headline: 'Which kind of support are you looking for?' };
  const forQuestion = supported({ coverage: supported().coverage.filter((x) => x.field !== 'headline') });
  assert.deepEqual(assessVerdict(forQuestion, asked, evidence), { action: 'continue' }, 'the question needs no quote');
  const claimed = { ...asked, headline: 'Why is it the fastest?' };
  assert.equal(assessVerdict(forQuestion, claimed, evidence).action, 'adjudicate', 'a question with a claim still needs its quote');
  const loaded = { ...asked, caption: `${draft.caption} Every question is answered in seconds.` };
  assert.equal(assessVerdict(forQuestion, loaded, evidence).action, 'adjudicate', 'a statement beside the question is still checked');
});

test('B3: UNSUPPORTED that names the exact phrase and explains it means one rewrite', () => {
  const verdict: ClaimVerdict = { decision: 'UNSUPPORTED', factId: 'f1', coverage: [], violations: [{ field: 'headline', unsupportedText: 'instantly', reasonCode: 'UNSUPPORTED_SPEED', explanation: 'The source confirms answers from website content but no response time.', sourceContext: 'Answers visitor questions using your website content.' }] };
  const result = assessVerdict(verdict, { ...draft, headline: 'Answer visitor questions instantly' }, evidence);
  assert.equal(result.action, 'rewrite');
});

test('B4, B10: UNSUPPORTED with no violation, or naming text that is not in the draft, is invalid', () => {
  const none: ClaimVerdict = { decision: 'UNSUPPORTED', factId: 'f1', coverage: [], violations: [] };
  assert.equal(assessVerdict(none, draft, evidence).action, 'adjudicate');
  const absent: ClaimVerdict = { decision: 'UNSUPPORTED', factId: 'f1', coverage: [], violations: [{ field: 'headline', unsupportedText: 'in seconds', reasonCode: 'X', explanation: 'The source gives no response time at all.', sourceContext: '' }] };
  assert.match((assessVerdict(absent, draft, evidence) as { problems: string[] }).problems.join(' '), /not in the draft/);
});

test('B5, B6: UNCERTAIN needs the disputed text and the question; without them it is invalid', () => {
  const named: ClaimVerdict = { decision: 'UNCERTAIN', factId: 'f1', coverage: [], violations: [], uncertainty: { disputedText: 'drawn from your website content', questionToResolve: 'Does "using" mean "drawn from"?' } };
  assert.equal(assessVerdict(named, draft, evidence).action, 'adjudicate');
  assert.deepEqual((assessVerdict(named, draft, evidence) as { problems: string[] }).problems, []);
  const vague: ClaimVerdict = { decision: 'UNCERTAIN', factId: 'f1', coverage: [], violations: [] };
  assert.ok((assessVerdict(vague, draft, evidence) as { problems: string[] }).problems.length > 0);
});

test('B7: a deterministic hold always wins over a model that says SUPPORTED', () => {
  assert.equal(assessVerdict(supported(), draft, evidence, { deterministicHold: true }).action, 'drop');
});

test('B9: a quote the model cites that is not in the stored evidence makes the verdict invalid', () => {
  const invented = supported({ coverage: [{ field: 'headline', claimText: 'Answer visitor questions using your website content', sourceQuote: 'We answer every question within one second.' }, { field: 'caption', claimText: 'Help visitors find answers drawn from your website content.', sourceQuote: 'Answers visitor questions using your website content.' }] });
  const result = assessVerdict(invented, draft, evidence);
  assert.equal(result.action, 'adjudicate');
  assert.match((result as { problems: string[] }).problems.join(' '), /not in the stored evidence/);
  assert.equal(assessVerdict({ ...supported(), factId: 'f9' }, draft, evidence).action, 'adjudicate');
});

test('verdict parsing: a malformed answer is refused, hashtags and the call to action are not claims', () => {
  assert.throws(() => parseClaimVerdict({ decision: 'MAYBE', factId: 'f1' }), /SUPPORTED, UNSUPPORTED or UNCERTAIN/);
  assert.throws(() => parseClaimVerdict({ decision: 'SUPPORTED', factId: 'f1', coverage: [{ field: 'footer' }] }), /field/);
  assert.equal(parseClaimVerdict({ decision: 'SUPPORTED', factId: 'f1' }).coverage.length, 0);
  const sentences = materialSentences({ headline: 'A |free| plan', subline: '', caption: 'Start free today.\n\n#Free #Plan' });
  assert.deepEqual(sentences.map((s) => s.field), ['headline', 'caption']);
});

// ---- the rewrite

const fact = (over: Partial<EvidenceFact> = {}): EvidenceFact => ({
  id: 'f1', category: 'capability', text: 'OyeChats never trains models on your data.', source: { url: 'https://acme.example/', quote: 'OyeChats never trains models on your data.', context: 'Privacy', heading: '', contentHash: 'h', regionType: 'prose', pageRole: 'home' },
  qualifiers: [], status: 'usable', intent: 'claim', attribution: 'brand', values: { numbers: [], prices: [], currencies: [], periods: [], units: [] }, reasonCodes: [], language: 'en', associationStatus: 'confirmed', capturedAt: 'x', ...over,
}) as unknown as EvidenceFact;

test('the request carries what must survive: the negation, the qualifier and the plan', () => {
  const plan = fact({ text: 'Up to 25 team members', scope: 'Basic', source: { url: 'u', quote: 'Up to 25 team members', context: 'Basic', heading: '', contentHash: 'h', regionType: 'prose', pageRole: 'pricing' } as never });
  const request = buildRewriteRequest({ headline: '25 team members', subline: '', caption: 'Room for 25.' }, plan, []);
  assert.deepEqual(request.requiredQualifiers, ['up to']);
  assert.equal(request.requiredPlanName, 'Basic');
  assert.deepEqual(buildRewriteRequest({ headline: 'h', subline: '', caption: 'c' }, fact(), []).requiredNegations, ['never']);
});

test('A7-A9: a rewrite that narrows the claim is accepted; one that drops a negation, a plan or a qualifier, changes the fact, or adds a claim is rejected', () => {
  const f = fact();
  const request = buildRewriteRequest({ headline: 'Your data never trains any model, guaranteed', subline: '', caption: 'We never train on your data and never will.' }, f, []);
  const good = { factId: 'f1', headline: 'OyeChats never trains models on your data', subline: '', caption: 'Your data is not used to train models.' };
  assert.deepEqual(validateRewrite(request, good, f), []);
  assert.match(validateRewrite(request, { ...good, headline: 'OyeChats trains models on your data', caption: 'Your data helps models improve.' }, f).join(' '), /drops the negation "never"/);
  assert.match(validateRewrite(request, { ...good, factId: 'f2' }, f).join(' '), /never changes the fact/);
  assert.match(validateRewrite(request, { ...good, caption: 'Your data is never used to train models, and 100% of chats stay private.' }, f).join(' '), /states 100%/);
  assert.match(validateRewrite(request, { ...good, headline: 'The most secure chat tool, and OyeChats never trains models on your data' }, f).join(' '), /market-position|proof claim/);
  assert.match(validateRewrite(request, { factId: 'f1', headline: 'Your data never trains any model, guaranteed', subline: '', caption: 'We never train on your data and never will.' }, f).join(' '), /same as the draft that failed|guarantee/);
});

test('a rewrite may not drop a plan name next to a figure, a qualifier, or a period', () => {
  const plan = fact({ text: 'Basic: up to 25 team members', scope: 'Basic', source: { url: 'u', quote: 'Basic: up to 25 team members', context: 'Basic', heading: '', contentHash: 'h', regionType: 'prose', pageRole: 'pricing' } as never });
  const request = buildRewriteRequest({ headline: 'Run 25 team members', subline: '', caption: 'Everything for 25 people.' }, plan, []);
  assert.match(validateRewrite(request, { factId: 'f1', headline: 'Up to 25 team members', subline: '', caption: 'Plenty of room for your team.' }, plan).join(' '), /without naming the plan/);
  assert.match(validateRewrite(request, { factId: 'f1', headline: 'Basic plan: 25 team members', subline: '', caption: 'Plenty of room.' }, plan).join(' '), /drops the qualifier "up to"/);
  assert.deepEqual(validateRewrite(request, { factId: 'f1', headline: 'Basic plan: up to 25 team members', subline: '', caption: 'Plenty of room for your team.' }, plan), []);
});

test('the writer is told how long a rewritten headline may be, and a rewrite whose headline is too long is refused with its length', () => {
  const f = fact();
  const request = buildRewriteRequest({ headline: 'Your data never trains any model, guaranteed', subline: '', caption: 'We never train on your data and never will.' }, f, []);
  assert.equal(request.maxHeadlineChars, 45, 'the request carries the limit the writer is asked to keep');
  const base = { factId: 'f1', subline: '', caption: 'Your data is not used to train models.' };
  const fits = 'OyeChats never trains models on your data';
  assert.deepEqual(validateRewrite(request, { ...base, headline: fits }, f), []);
  const long = 'OyeChats never trains any of its models on the data that you share with it in conversations';
  assert.ok(long.length > 60);
  assert.match(validateRewrite(request, { ...base, headline: long }, f).join(' '), new RegExp(`the headline is ${long.length} characters; it must be at most 60`));
  assert.deepEqual(validateRewrite(request, { ...base, headline: 'OyeChats never trains models on |your data|' }, f), [], 'the emphasis marks are not counted');
});


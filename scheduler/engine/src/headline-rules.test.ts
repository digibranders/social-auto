import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brandPrefixProblem, planQualifierProblem } from './headline-rules.ts';
import { validateDraft, type DraftPost } from './planner.ts';
import type { EvidenceFact } from './evidence.ts';

test('a headline that opens with the brand as a label is turned back, whatever the separator or the plan word after it', () => {
  for (const bad of ['OyeChats: one thread through the deal', 'Alsonotify: Free: 5 active projects', 'Alsonotify Advanced: Unlimited team members', 'ALSONOTIFY — manages team relationships', '|OyeChats:| one thread', 'oyechats - answers from your docs']) {
    const name = /alsonotify/i.test(bad) ? 'Alsonotify' : 'OyeChats';
    assert.ok(brandPrefixProblem(bad, name), bad);
  }
});

test('a headline where the brand is part of the sentence, or absent, is left alone', () => {
  for (const good of ['OyeChats never trains models on your data', 'Alsonotify manages team relationships', 'One conversation, from first message to handoff', 'Free plan: 5 active projects', 'Why OyeChats: the short version', 'Ask OyeChats anything']) {
    assert.equal(brandPrefixProblem(good, /alsonotify/i.test(good) ? 'Alsonotify' : 'OyeChats'), undefined, good);
  }
  assert.equal(brandPrefixProblem('Anything', ''), undefined);
});

const fact = (text: string, scope: string | undefined, numbers: string[]): EvidenceFact => ({ text, ...(scope ? { scope } : {}), values: { numbers, prices: [], currencies: [], periods: [], units: [] } }) as unknown as EvidenceFact;

test('a figure that belongs to a plan keeps the plan in the headline', () => {
  const basic = [fact('Up to 25 team members', 'Basic', ['25'])];
  assert.match(planQualifierProblem('Up to 25 team members', basic) ?? '', /without its plan "Basic"/);
  assert.equal(planQualifierProblem('Basic plan: up to 25 team members', basic), undefined);
  assert.equal(planQualifierProblem('Room for your whole team', basic), undefined, 'no figure, nothing to qualify');
  const advanced = [fact('Unlimited team members', 'Advanced', [])];
  assert.match(planQualifierProblem('Unlimited team members', advanced) ?? '', /"Advanced"/);
  assert.equal(planQualifierProblem('Unlimited team members on the Advanced plan', advanced), undefined);
  assert.equal(planQualifierProblem('Up to 25 team members', [fact('Up to 25 team members', undefined, ['25'])]), undefined, 'a fact with no plan is not qualified');
});

const draft: DraftPost = { painPoint: 'p', headline: 'Answers from your own docs', subline: '', visual: 'a thing', visualLink: 'it links', concept: {}, caption: 'c', hashtags: [] } as unknown as DraftPost;

test('the copy stage turns such a draft back with the reason, and passes a clean one', () => {
  assert.throws(() => validateDraft({ ...draft, headline: 'OyeChats: one thread' }, 2, 'OyeChats', undefined, undefined, { optionalSubline: true }), /post 2 headline rule: the headline begins with the brand name as a label/);
  assert.throws(() => validateDraft({ ...draft, headline: 'Up to 25 team members' }, 1, 'Acme', undefined, undefined, { optionalSubline: true, facts: [fact('Up to 25 team members', 'Basic', ['25'])] }), /headline rule: the headline states "25" without its plan/);
  assert.doesNotThrow(() => validateDraft(draft, 1, 'OyeChats', undefined, undefined, { optionalSubline: true }));
});

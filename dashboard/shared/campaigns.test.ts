import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batchFraction, durationText, estimateSeconds, parseCampaigns, plainFailure, planKey, samePlan, statusItems, type Campaign, type CampaignBatch, type PlanOfClient } from './campaigns.ts';

const NOW = Date.parse('2026-11-06T08:00:00Z'); // 13:30 in India on Friday 6 November
const plan = (over: Partial<PlanOfClient> = {}): PlanOfClient => ({ platforms: ['instagram'], startDate: '2026-11-07', durationDays: 1, time: '10:00', ...over });
const client = (over: Partial<{ brand: string; label: string; plans: PlanOfClient[] }> = {}) => ({ brand: 'oye-chats', label: 'Oye Chats', plans: [plan()], ...over });
const batch = (over: Partial<CampaignBatch> = {}): CampaignBatch => ({ index: 0, dates: ['2026-11-07'], status: 'pending', ...over });
const campaign = (over: Partial<Campaign> = {}, batches: CampaignBatch[] = [batch()]): Campaign => ({
  id: 'c1', brand: 'oye-chats', site: 'https://oyechats.com', plan: { platforms: ['instagram'], startDate: '2026-11-07', durationDays: 1, time: '10:00' },
  status: 'queued', createdAt: '2026-11-06T07:55:00Z', updatedAt: '2026-11-06T07:59:00Z', batches, ...over,
});

test('a plan nobody has picked up yet says it is waiting, with the check interval and an estimate, and warns when it has waited too long', () => {
  const [waiting] = statusItems([client()], [], NOW);
  assert.equal(waiting?.state, 'waiting');
  assert.match(waiting?.headline ?? '', /Waiting to start \(checked every 5 minutes\)/);
  assert.match(waiting?.eta ?? '', /starts within 5 minutes, then about 4 minutes/);
  assert.equal(waiting?.title, 'Oye Chats: 1 poster');
  assert.equal(waiting?.cost, 'about $0.02 to $0.08');
  assert.deepEqual(waiting?.steps.map((s) => s.state), ['now', 'todo', 'todo', 'todo', 'todo']);
  const [stalled] = statusItems([client()], [], NOW, () => NOW - 20 * 60_000);
  assert.equal(stalled?.state, 'stalled');
  assert.match(stalled?.failure ?? '', /not started after more than 15 minutes/);
  assert.equal(statusItems([client()], [], NOW, () => NOW - 5 * 60_000)[0]?.state, 'waiting', 'five minutes is still normal');
});

test('a plan whose days have all passed, and that was never made, says nothing; a client with no plans says nothing', () => {
  assert.deepEqual(statusItems([client({ plans: [plan({ startDate: '2026-11-01' })] })], [], NOW), []);
  assert.deepEqual(statusItems([client({ plans: [] })], [], NOW), []);
});

test('a plan being made says which step it is on, which poster, how far along and about how long is left', () => {
  const four = ['2026-11-07', '2026-11-09', '2026-11-11', '2026-11-13'];
  const record = campaign({ status: 'running', plan: { platforms: ['instagram'], startDate: '2026-11-07', durationDays: 7, postsPerWeek: 4, time: '10:00' } }, [batch({ dates: four, status: 'running', stage: 'drawing', drawn: 1, detail: 'w01-d2: attempt 1, drawing the poster…', startedAt: '2026-11-06T07:58:00Z' })]);
  const [item] = statusItems([client({ plans: [plan({ durationDays: 7, postsPerWeek: 4 })] })], [record], NOW);
  assert.equal(item?.state, 'working');
  assert.equal(item?.headline, 'Drawing poster 2 of 4');
  assert.equal(item?.detail, 'w01-d2: attempt 1, drawing the poster…');
  assert.deepEqual(item?.steps.map((s) => s.state), ['done', 'done', 'done', 'now', 'todo']);
  // 0.25 + 0.7 * (1 / 4) = 0.425 of the batch.
  assert.equal(item?.percent, 43);
  assert.match(item?.eta ?? '', /^about \d+ minutes? left$/);
  assert.equal(item?.title, 'Oye Chats: 4 posters');
  const reading = statusItems([client()], [campaign({ status: 'running' }, [batch({ status: 'running', stage: 'reading', startedAt: '2026-11-06T07:59:30Z' })])], NOW)[0];
  assert.equal(reading?.headline, 'Reading the website');
  assert.deepEqual(reading?.steps.map((s) => s.state), ['done', 'now', 'todo', 'todo', 'todo']);
  const writing = statusItems([client()], [campaign({ status: 'running' }, [batch({ status: 'running', stage: 'writing', startedAt: '2026-11-06T07:59:30Z' })])], NOW)[0];
  assert.equal(writing?.headline, 'Writing the posts');
});

test('a run that is taking much longer than the estimate says so instead of promising a time', () => {
  const slow = campaign({ status: 'running' }, [batch({ status: 'running', stage: 'drawing', startedAt: '2026-11-06T07:20:00Z' })]);
  assert.equal(statusItems([client()], [slow], NOW)[0]?.eta, 'taking longer than usual');
});

test('a month in two batches counts the finished batch and adds the time of the one still to come', () => {
  const dates = (from: number, n: number) => Array.from({ length: n }, (_, i) => `2026-11-${String(from + i * 2).padStart(2, '0')}`);
  const record = campaign({ status: 'running', plan: { platforms: ['instagram'], startDate: '2026-11-07', durationDays: 31, postsPerWeek: 3, time: '10:00' } }, [
    batch({ index: 0, dates: dates(7, 8), status: 'done', queued: 8 }),
    batch({ index: 1, dates: dates(23, 5), status: 'pending' }),
  ]);
  const [item] = statusItems([client({ plans: [plan({ durationDays: 31, postsPerWeek: 3 })] })], [record], NOW);
  assert.equal(item?.state, 'working');
  assert.equal(item?.headline, 'Waiting for the next part');
  assert.equal(item?.percent, 62, '8 of 13 posters are done');
  assert.match(item?.eta ?? '', /left$/);
});

test('a failed run says why, in the words recorded, and how many posters were made before it stopped', () => {
  const failed = campaign({ status: 'failed' }, [batch({ status: 'failed', failure: 'Error: LOGO_REQUIRED: The website has no logo picture, only the name.' })]);
  const [item] = statusItems([client()], [failed], NOW);
  assert.equal(item?.state, 'failed');
  assert.equal(item?.headline, 'It did not work');
  assert.deepEqual(item?.steps.map((s) => s.state), ['todo', 'todo', 'todo', 'todo', 'todo'], 'it stopped before the first step, so no step is blamed');
  assert.match(item?.failure ?? '', /^The website has no logo picture, only the name\. Turn off/, 'the sentence after the code, without the technical prefix');
  const partial = campaign({ status: 'partial', plan: { platforms: ['instagram'], startDate: '2026-11-07', durationDays: 31, postsPerWeek: 3, time: '10:00' } }, [
    batch({ index: 0, dates: ['2026-11-07', '2026-11-09'], status: 'done', queued: 2 }), batch({ index: 1, dates: ['2026-11-11'], status: 'failed', failure: 'a model call failed' }),
  ]);
  const second = statusItems([client({ plans: [plan({ durationDays: 31, postsPerWeek: 3 })] })], [partial], NOW)[0];
  assert.equal(second?.headline, '2 posters made, the rest did not work');
  assert.equal(second?.failure, 'a model call failed');
});

test('a finished plan says how many posters really reached Review, and is honest when none did', () => {
  const done = campaign({ status: 'awaiting_approval' }, [batch({ status: 'done', queued: 1 })]);
  const [ready] = statusItems([client()], [done], NOW);
  assert.equal(ready?.state, 'review');
  assert.equal(ready?.headline, '1 poster ready for your review');
  assert.equal(ready?.ready, 1);
  assert.deepEqual(ready?.steps.map((s) => s.state), ['done', 'done', 'done', 'done', 'done']);
  const four = ['2026-11-07', '2026-11-09', '2026-11-11', '2026-11-13'];
  const some = campaign({ status: 'awaiting_approval' }, [batch({ dates: four, status: 'done', queued: 3 })]);
  assert.equal(statusItems([client({ plans: [plan({ durationDays: 7, postsPerWeek: 4 })] })], [{ ...some, plan: { ...some.plan, durationDays: 7, postsPerWeek: 4 } }], NOW)[0]?.headline, '3 posters ready for your review, 1 did not pass the checks');
  const none = campaign({ status: 'awaiting_approval' }, [batch({ status: 'done', queued: 0 })]);
  const [empty] = statusItems([client()], [none], NOW);
  assert.equal(empty?.state, 'failed');
  assert.equal(empty?.headline, 'No poster passed the checks');
  assert.match(empty?.failure ?? '', /nothing is waiting in Review/);
  const older = campaign({ status: 'awaiting_approval', updatedAt: '2026-11-06T00:00:00Z' }, [batch({ status: 'done', queued: 1 })]);
  assert.deepEqual(statusItems([client()], [older], NOW), [], 'a finished plan stops being shown after a few hours');
  const uncounted = campaign({ status: 'awaiting_approval' }, [batch({ status: 'done' })]);
  assert.equal(statusItems([client()], [uncounted], NOW)[0]?.headline, 'Finished: look in Review', 'an older record with no count claims no number');
});

test('each plan is matched to its own record, by what was chosen, and records of other clients are not mixed in', () => {
  const a = plan({ platforms: ['instagram'] });
  const b = plan({ platforms: ['linkedin'], startDate: '2026-11-09' });
  const recordB = campaign({ id: 'cb', status: 'running', plan: { platforms: ['linkedin'], startDate: '2026-11-09', durationDays: 1, time: '10:00' } }, [batch({ dates: ['2026-11-09'], status: 'running', stage: 'writing', startedAt: '2026-11-06T07:59:30Z' })]);
  const other = campaign({ id: 'co', brand: 'someone-else', status: 'running' }, [batch({ status: 'running', stage: 'drawing', startedAt: '2026-11-06T07:59:00Z' })]);
  const items = statusItems([client({ plans: [a, b] })], [recordB, other], NOW);
  assert.deepEqual(items.map((i) => [i.subtitle.split(',')[0], i.state]), [['Instagram', 'waiting'], ['LinkedIn', 'working']]);
  assert.equal(samePlan({ ...a, platforms: ['facebook', 'instagram'] }, { ...a, platforms: ['instagram', 'facebook'] }), true, 'the order of platforms does not matter');
  assert.equal(samePlan(a, { ...a, time: '15:30' }), false);
  assert.notEqual(planKey('x', a), planKey('x', b));
});

test('times are said in plain words and the estimate matches what a real run took', () => {
  assert.equal(estimateSeconds(1), 210, 'one poster took about 3.5 minutes');
  assert.equal(durationText(20), 'under a minute');
  assert.equal(durationText(210), 'about 4 minutes');
  assert.equal(durationText(60), 'about 1 minute');
  assert.equal(durationText(3 * 3600), 'about 3 h');
  assert.equal(durationText(80 * 60 + 30 * 60), 'about 1 h 50 min');
  assert.equal(batchFraction(batch({ status: 'done' })), 1);
  assert.equal(batchFraction(batch({ status: 'pending' })), 0);
  assert.equal(batchFraction(batch({ status: 'running', stage: 'drawing', drawn: 4, dates: ['a', 'b', 'c', 'd'] })), 0.95);
});

test('the campaign list is read with care: entries that are not campaigns, and fields of the wrong kind, are left out', () => {
  const good = { id: 'c1', brand: 'oye-chats', site: 'https://oyechats.com', status: 'running', createdAt: 'a', updatedAt: 'b', plan: { platforms: ['instagram', 7], startDate: '2026-11-07', durationDays: 1, time: '10:00' }, batches: [{ index: 0, dates: ['2026-11-07', 3], status: 'running', stage: 'drawing', detail: 'x', drawn: 1, queued: 1 }, { index: 1, dates: [], status: 'nonsense' }, 'junk'] };
  const parsed = parseCampaigns({ campaigns: [good, { id: 'c2' }, 'x', null, { ...good, status: 'amazing' }] });
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0]?.plan.platforms, ['instagram']);
  assert.equal(parsed[0]?.batches.length, 1, 'a batch with a status that is not one is left out');
  assert.deepEqual(parsed[0]?.batches[0]?.dates, ['2026-11-07']);
  assert.equal(parsed[0]?.batches[0]?.queued, 1);
  assert.deepEqual(parseCampaigns(undefined), []);
  assert.deepEqual(parseCampaigns({ campaigns: 'x' }), []);
});

test('a failure is told without its technical prefix, and a bare code is put into words', () => {
  assert.equal(plainFailure('Error: LOGO_REQUIRED: The website has no logo picture, only the name.'), 'The website has no logo picture, only the name. Turn off "Require the website\'s real logo" on the client\'s page to have the brand name used as text instead.', 'a stop the owner can fix says how');
  assert.equal(plainFailure('BrandingError: LOGO_REQUIRED: The real logo cannot be placed on posters yet, and this client requires one.'), 'The real logo cannot be placed on posters yet, and this client requires one. Turn off "Require the website\'s real logo" on the client\'s page to have the brand name used as text instead.', 'the error\'s own name is dropped too');
  assert.equal(plainFailure('Error: BUDGET_EXHAUSTED'), 'The spending limit was reached, so no more posters were drawn.');
  assert.equal(plainFailure('SITE_ACCESS_BLOCKED:'), 'The website does not allow its pages to be read.');
  assert.equal(plainFailure('a model call failed'), 'a model call failed');
  assert.equal(plainFailure('Error: SOMETHING_NEW'), 'SOMETHING_NEW', 'an unknown code is shown as it is rather than guessed at');
});

test('a failed plan points at the step it really stopped on', () => {
  const stopped = (stoppedAt: 'reading' | 'writing' | 'drawing' | 'finishing' | undefined) => statusItems([client()], [campaign({ status: 'failed' }, [batch({ status: 'failed', failure: 'x', ...(stoppedAt ? { stoppedAt } : {}) })])], NOW)[0];
  assert.deepEqual(stopped('writing')?.steps.map((s) => s.state), ['done', 'done', 'now', 'todo', 'todo']);
  assert.deepEqual(stopped('reading')?.steps.map((s) => s.state), ['done', 'now', 'todo', 'todo', 'todo']);
  assert.deepEqual(stopped('drawing')?.steps.map((s) => s.state), ['done', 'done', 'done', 'now', 'todo']);
  assert.equal(parseCampaigns({ campaigns: [{ id: 'c', brand: 'b', status: 'failed', plan: { platforms: ['instagram'], startDate: '2026-11-07', durationDays: 1, time: '10:00' }, batches: [{ index: 0, dates: ['2026-11-07'], status: 'failed', stoppedAt: 'writing' }] }] })[0]?.batches[0]?.stoppedAt, 'writing');
});

test('the writing step\'s long list of reasons is told as its meaning', () => {
  const long = 'Error: insufficient_distinct_concepts: none of the 1 posts was a new idea (w03-d1: the rewritten copy failed the checks again: the headline is too long [headline: "Strengthen your |digital presence|"] | w03-d2: the rewri';
  assert.match(plainFailure(long), /^The posts written from this website did not pass the checks, so no poster was drawn/);
  assert.doesNotMatch(plainFailure(long), /w03-d1|headline/);
});


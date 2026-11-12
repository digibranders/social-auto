import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetError, budgetLimitsFromEnv, defaultBudgetLimits, MAX_PICTURES_PER_BRAND_MONTH_CEILING, PaidLedger, type BudgetLimits, type BudgetRefusal } from './paid-ledger.ts';

const DAY = new Date('2026-11-05T10:00:00Z');

function workspace(): { file: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  return { file: join(dir, 'paid-calls.jsonl'), done: () => rmSync(dir, { recursive: true, force: true }) };
}

const open = (file: string, over: Partial<BudgetLimits> = {}, ids: { jobId?: string; brandId?: string; now?: Date } = {}): PaidLedger =>
  new PaidLedger(file, { ...defaultBudgetLimits, ...over }, { jobId: ids.jobId ?? 'job-1', tenantId: 'owner', brandId: ids.brandId ?? 'acme', now: () => ids.now ?? DAY });

const refusal = (work: () => unknown): BudgetRefusal => {
  try {
    work();
  } catch (error) {
    assert.ok(error instanceof BudgetError, `expected a BudgetError, got ${String(error)}`);
    return error.code;
  }
  assert.fail('the call was not refused');
};

test('a call that would break the budget is refused before it is sent, not checked afterwards', () => {
  const { file, done } = workspace();
  try {
    const ledger = open(file, { perRunUsd: 0.03, perPosterUsd: 0.05 });
    const text = ledger.reserve({ operation: 'text', model: 'm', postId: 'p1', requestKey: 'a', maxCostUsd: 0.02 });
    ledger.complete(text, { actualCostUsd: 0.02 });
    // $0.01 is left in the run; the next picture may cost up to $0.02.
    assert.equal(refusal(() => ledger.reserve({ operation: 'image', model: 'img', postId: 'p1', requestKey: 'b', maxCostUsd: 0.02 })), 'RUN_BUDGET');
    assert.equal(ledger.calls().filter((c) => c.operation === 'image').length, 0, 'a refused call leaves no record of being sent');
  } finally {
    done();
  }
});

test('a crash after the request began leaves the call unknown, keeps its reservation, and the same request is never sent again', () => {
  const { file, done } = workspace();
  try {
    const first = open(file);
    const call = first.reserve({ operation: 'image', model: 'img', postId: 'p1', requestKey: 'same prompt', maxCostUsd: 0.03 });
    first.markInFlight(call);
    // The process dies here. A new process opens the same file.
    const second = open(file, {}, { jobId: 'job-1' });
    const found = second.calls().find((c) => c.callId === call);
    assert.equal(found?.status, 'unknown');
    assert.equal(second.spend('p1').run, 0.03, 'the reservation still counts');
    assert.equal(refusal(() => second.reserve({ operation: 'image', model: 'img', postId: 'p1', requestKey: 'same prompt', maxCostUsd: 0.03 })), 'REPLAY_BLOCKED');
  } finally {
    done();
  }
});

test('two workers racing for the last dollar: only one gets it', () => {
  const { file, done } = workspace();
  try {
    const a = open(file, { perRunUsd: 0.05 }, { jobId: 'job-1' });
    const b = open(file, { perRunUsd: 0.05 }, { jobId: 'job-1' });
    a.reserve({ operation: 'text', model: 'm', requestKey: 'x', maxCostUsd: 0.03 });
    assert.equal(refusal(() => b.reserve({ operation: 'text', model: 'm', requestKey: 'y', maxCostUsd: 0.03 })), 'RUN_BUDGET');
  } finally {
    done();
  }
});

test('a poster gets its picture purchases: a failed attempt still counts and nothing regenerates', () => {
  const { file, done } = workspace();
  try {
    const ledger = open(file, { maxImagesPerPoster: 1 });
    const call = ledger.reserve({ operation: 'image', model: 'img', postId: 'p1', requestKey: 'one', maxCostUsd: 0.03 });
    ledger.markInFlight(call);
    ledger.fail(call, 'provider returned 500');
    assert.equal(refusal(() => ledger.reserve({ operation: 'image', model: 'img', postId: 'p1', requestKey: 'two', maxCostUsd: 0.03 })), 'IMAGE_LIMIT');
    // Another poster is not affected.
    assert.ok(ledger.reserve({ operation: 'image', model: 'img', postId: 'p2', requestKey: 'three', maxCostUsd: 0.03 }));
  } finally {
    done();
  }
});

test('the brand-day cap holds across jobs and resets with the UTC day; the deployment cap holds across brands', () => {
  const { file, done } = workspace();
  try {
    const limits = { perBrandDayUsd: 0.06, globalDayUsd: 0.1, perRunUsd: 1, perPosterUsd: 1 };
    const morning = open(file, limits, { jobId: 'job-1' });
    morning.complete(morning.reserve({ operation: 'text', model: 'm', requestKey: '1', maxCostUsd: 0.06 }), { actualCostUsd: 0.06 });
    const later = open(file, limits, { jobId: 'job-2' });
    assert.equal(refusal(() => later.reserve({ operation: 'text', model: 'm', requestKey: '2', maxCostUsd: 0.01 })), 'BRAND_DAY_BUDGET');
    const other = open(file, limits, { jobId: 'job-3', brandId: 'other' });
    other.complete(other.reserve({ operation: 'text', model: 'm', requestKey: '3', maxCostUsd: 0.04 }), { actualCostUsd: 0.04 });
    assert.equal(refusal(() => other.reserve({ operation: 'text', model: 'm', requestKey: '4', maxCostUsd: 0.01 })), 'GLOBAL_DAY_BUDGET');
    const nextDay = open(file, limits, { jobId: 'job-4', now: new Date('2026-11-06T00:00:01Z') });
    assert.ok(nextDay.reserve({ operation: 'text', model: 'm', requestKey: '5', maxCostUsd: 0.05 }));
  } finally {
    done();
  }
});

test('the brand-month cap holds across days and jobs, not across brands, and resets with the UTC month', () => {
  const { file, done } = workspace();
  try {
    const limits = { perBrandMonthUsd: 0.1, perBrandDayUsd: 1, globalDayUsd: 5, perRunUsd: 1, perPosterUsd: 1 };
    const first = open(file, limits, { jobId: 'job-1', now: new Date('2026-11-03T09:00:00Z') });
    first.complete(first.reserve({ operation: 'text', model: 'm', requestKey: '1', maxCostUsd: 0.08 }), { actualCostUsd: 0.08 });
    // A later day of the same month, another job: the month is still counted.
    const later = open(file, limits, { jobId: 'job-2', now: new Date('2026-11-20T09:00:00Z') });
    assert.equal(later.spend().brandMonth, 0.08);
    assert.equal(refusal(() => later.reserve({ operation: 'text', model: 'm', requestKey: '2', maxCostUsd: 0.03 })), 'BRAND_MONTH_BUDGET');
    assert.ok(later.reserve({ operation: 'text', model: 'm', requestKey: '3', maxCostUsd: 0.02 }), 'what still fits is allowed');
    // Another brand has its own month.
    const other = open(file, limits, { jobId: 'job-3', brandId: 'other', now: new Date('2026-11-20T09:00:00Z') });
    assert.ok(other.reserve({ operation: 'text', model: 'm', requestKey: '4', maxCostUsd: 0.09 }));
    // The next month starts empty.
    const december = open(file, limits, { jobId: 'job-4', now: new Date('2026-12-01T00:00:01Z') });
    assert.equal(december.spend().brandMonth, 0);
    assert.ok(december.reserve({ operation: 'text', model: 'm', requestKey: '5', maxCostUsd: 0.1 }));
  } finally {
    done();
  }
});

test('the monthly limit can be set from the environment, and a value that is not a positive number is an error', () => {
  assert.equal(budgetLimitsFromEnv({}).perBrandMonthUsd, defaultBudgetLimits.perBrandMonthUsd);
  assert.equal(budgetLimitsFromEnv({ BUDGET_BRAND_MONTH_USD: '3.5' }).perBrandMonthUsd, 3.5);
  assert.throws(() => budgetLimitsFromEnv({ BUDGET_BRAND_MONTH_USD: '-1' }), BudgetError);
});

test('a completed call is charged what it really cost, not what was reserved', () => {
  const { file, done } = workspace();
  try {
    const ledger = open(file);
    const call = ledger.reserve({ operation: 'text', model: 'm', postId: 'p1', requestKey: 'k', maxCostUsd: 0.02 });
    ledger.markInFlight(call);
    ledger.complete(call, { actualCostUsd: 0.004, inputTokens: 100, outputTokens: 50 });
    assert.equal(ledger.spend('p1').poster, 0.004);
  } finally {
    done();
  }
});

test('a request that failed outright may be asked again; one that is unknown or done may not', () => {
  const { file, done } = workspace();
  try {
    const ledger = open(file);
    const call = ledger.reserve({ operation: 'text', model: 'm', requestKey: 'k', maxCostUsd: 0.01 });
    ledger.fail(call, 'bad request');
    const again = ledger.reserve({ operation: 'text', model: 'm', requestKey: 'k', maxCostUsd: 0.01 });
    ledger.markUnknown(again, 'timeout');
    assert.equal(refusal(() => ledger.reserve({ operation: 'text', model: 'm', requestKey: 'k', maxCostUsd: 0.01 })), 'REPLAY_BLOCKED');
  } finally {
    done();
  }
});

test('the log survives a restart, and a lock left by a process that is gone does not freeze spending', () => {
  const { file, done } = workspace();
  try {
    const ledger = open(file);
    ledger.complete(ledger.reserve({ operation: 'text', model: 'm', postId: 'p1', requestKey: 'k', maxCostUsd: 0.01 }), { actualCostUsd: 0.01 });
    assert.equal(open(file).spend('p1').poster, 0.01);
    assert.match(readFileSync(file, 'utf8'), /"type":"reserve"/);
    // A lock whose process no longer exists (a crash in the middle of a change).
    writeFileSync(`${file}.lock`, JSON.stringify({ pid: 99999999, token: 'dead', host: hostname() }));
    assert.ok(open(file).reserve({ operation: 'text', model: 'm', requestKey: 'other', maxCostUsd: 0.01 }));
  } finally {
    done();
  }
});

test('a damaged lock file stops spending instead of being guessed at', () => {
  const { file, done } = workspace();
  try {
    open(file);
    writeFileSync(`${file}.lock`, '');
    // Even opening the ledger needs the lock, so nothing can be spent through it.
    assert.equal(refusal(() => new PaidLedger(file, defaultBudgetLimits, { jobId: 'job-2', tenantId: 'owner', brandId: 'acme', now: () => DAY, lockTimeoutMs: 200 })), 'KILL_SWITCH');
    assert.equal(readFileSync(`${file}.lock`, 'utf8'), '', 'the damaged lock was left for a person');
  } catch (error) {
    done();
    throw error;
  }
  done();
});

test('limits come from settings, and a value that is not a positive number is an error', () => {
  assert.deepEqual(budgetLimitsFromEnv({}), defaultBudgetLimits);
  assert.equal(budgetLimitsFromEnv({ BUDGET_RUN_USD: '0.5' }).perRunUsd, 0.5);
  assert.throws(() => budgetLimitsFromEnv({ BUDGET_RUN_USD: 'lots' }), /BUDGET_RUN_USD/);
  assert.throws(() => budgetLimitsFromEnv({ BUDGET_POSTER_USD: '0' }), /BUDGET_POSTER_USD/);
});

test('a brand may buy as many pictures a month as its limit says: pictures are counted, not topics or dollars, across jobs and days, per brand and per UTC month', () => {
  const { file, done } = workspace();
  try {
    assert.equal(defaultBudgetLimits.maxPicturesPerBrandMonth, MAX_PICTURES_PER_BRAND_MONTH_CEILING, 'the default is the backstop, not a limit');
    const limits = { maxPicturesPerBrandMonth: 3, maxImagesPerPoster: 2, perBrandMonthUsd: 50, perBrandDayUsd: 50, globalDayUsd: 50, perRunUsd: 50, perPosterUsd: 50 };
    const buy = (ledger: PaidLedger, key: string, postId: string) => ledger.complete(ledger.reserve({ operation: 'image', model: 'img', postId, requestKey: key, maxCostUsd: 0.02 }), { actualCostUsd: 0.02 });
    const first = open(file, limits, { jobId: 'job-1', now: new Date('2026-11-03T09:00:00Z') });
    buy(first, 'a', 'p1-instagram');
    buy(first, 'b', 'p1-facebook');
    // A text call is not a picture.
    first.complete(first.reserve({ operation: 'text', model: 'm', requestKey: 't', maxCostUsd: 0.01 }), { actualCostUsd: 0.01 });
    const later = open(file, limits, { jobId: 'job-2', now: new Date('2026-11-20T09:00:00Z') });
    assert.equal(later.spend().brandMonthPictures, 2);
    buy(later, 'c', 'p1-google');
    assert.equal(refusal(() => buy(later, 'd', 'p1-linkedin')), 'BRAND_MONTH_PICTURES');
    // A picture that failed was not bought, so it does not count.
    const failing = open(file, limits, { jobId: 'job-3', brandId: 'other', now: new Date('2026-11-20T09:00:00Z') });
    const lost = failing.reserve({ operation: 'image', model: 'img', postId: 'q1', requestKey: 'x', maxCostUsd: 0.02 });
    failing.fail(lost, 'the provider refused');
    assert.equal(failing.spend().brandMonthPictures, 0);
    // Another brand has its own month, and the next month starts empty.
    buy(failing, 'y', 'q1');
    const december = open(file, limits, { jobId: 'job-4', now: new Date('2026-12-01T00:00:01Z') });
    assert.equal(december.spend().brandMonthPictures, 0);
    buy(december, 'e', 'p2');
  } finally {
    done();
  }
});

test('a draw that needs more pictures than are left this month is refused whole, before any is bought', () => {
  const { file, done } = workspace();
  try {
    const ledger = open(file, { maxPicturesPerBrandMonth: 5, perBrandMonthUsd: 50, perBrandDayUsd: 50, globalDayUsd: 50, perRunUsd: 50, perPosterUsd: 50 });
    ledger.assertPicturesFit(5);
    ledger.complete(ledger.reserve({ operation: 'image', model: 'img', postId: 'p1', requestKey: 'a', maxCostUsd: 0.02 }), { actualCostUsd: 0.02 });
    ledger.assertPicturesFit(4);
    assert.equal(refusal(() => ledger.assertPicturesFit(5)), 'BRAND_MONTH_PICTURES');
    assert.equal(ledger.calls().length, 1, 'the check buys and records nothing');
  } finally {
    done();
  }
});

test('the picture limit can be set from the environment but never above the ceiling in code, and a bad value is an error', () => {
  assert.equal(budgetLimitsFromEnv({}).maxPicturesPerBrandMonth, MAX_PICTURES_PER_BRAND_MONTH_CEILING);
  assert.equal(budgetLimitsFromEnv({ BUDGET_BRAND_MONTH_PICTURES: '25' }).maxPicturesPerBrandMonth, 25);
  assert.equal(budgetLimitsFromEnv({ BUDGET_BRAND_MONTH_PICTURES: String(MAX_PICTURES_PER_BRAND_MONTH_CEILING) }).maxPicturesPerBrandMonth, MAX_PICTURES_PER_BRAND_MONTH_CEILING);
  assert.throws(() => budgetLimitsFromEnv({ BUDGET_BRAND_MONTH_PICTURES: String(MAX_PICTURES_PER_BRAND_MONTH_CEILING + 1) }), BudgetError);
  assert.throws(() => budgetLimitsFromEnv({ BUDGET_BRAND_MONTH_PICTURES: '0' }), BudgetError);
  assert.throws(() => budgetLimitsFromEnv({ BUDGET_BRAND_MONTH_PICTURES: '2.5' }), BudgetError);
});

test('a weekly limit per channel refuses the sixth Instagram picture while Facebook still has room, and the week restarts on Monday', () => {
  const { file, done } = workspace();
  try {
    const wide = { perBrandMonthUsd: 50, perBrandDayUsd: 50, globalDayUsd: 50, perRunUsd: 50, perPosterUsd: 50, maxImagesPerPoster: 5, maxPicturesPerChannelWeek: 2 };
    const buy = (ledger: PaidLedger, key: string, network: 'instagram' | 'facebook') => ledger.complete(ledger.reserve({ operation: 'image', model: 'img', postId: `p-${key}`, network, requestKey: key, maxCostUsd: 0.02 }), { actualCostUsd: 0.02 });
    const thursday = new Date('2026-11-12T06:30:00Z');
    const first = open(file, wide, { jobId: 'job-1', now: thursday });
    buy(first, 'a', 'instagram');
    buy(first, 'b', 'instagram');
    const later = open(file, wide, { jobId: 'job-2', now: new Date('2026-11-14T06:30:00Z') });
    try {
      buy(later, 'c', 'instagram');
      assert.fail('the third Instagram picture of the week was not refused');
    } catch (error) {
      assert.ok(error instanceof BudgetError);
      assert.equal(error.code, 'PICTURE_LIMIT_REACHED');
      assert.deepEqual(error.channel, { network: 'instagram', restart: '2026-11-16' });
      assert.match(error.message, /used your 2 Instagram pictures for this week.*Monday 16 November/);
    }
    buy(later, 'd', 'facebook');
    assert.deepEqual(later.channelUsage().used, { instagram: 2, facebook: 1, linkedin: 0, google: 0 });
    // A failed try is not a picture bought.
    const failed = later.reserve({ operation: 'image', model: 'img', postId: 'p-f', network: 'facebook', requestKey: 'f', maxCostUsd: 0.02 });
    later.fail(failed, 'the provider refused');
    assert.equal(later.channelUsage().used.facebook, 1);
    // Monday: a new week.
    const monday = open(file, wide, { jobId: 'job-3', now: new Date('2026-11-16T04:30:00Z') });
    buy(monday, 'e', 'instagram');
    assert.equal(monday.channelUsage().used.instagram, 1);
  } finally {
    done();
  }
});

test('a draw that needs more pictures for a channel than the week has left is refused whole and names the channel', () => {
  const { file, done } = workspace();
  try {
    const ledger = open(file, { maxPicturesPerChannelWeek: 3, perBrandMonthUsd: 50, perBrandDayUsd: 50, globalDayUsd: 50, perRunUsd: 50, perPosterUsd: 50 }, { now: new Date('2026-11-12T06:30:00Z') });
    ledger.assertChannelPicturesFit({ instagram: 3, facebook: 3, linkedin: 0 });
    ledger.complete(ledger.reserve({ operation: 'image', model: 'img', postId: 'p1', network: 'linkedin', requestKey: 'a', maxCostUsd: 0.02 }), { actualCostUsd: 0.02 });
    assert.throws(() => ledger.assertChannelPicturesFit({ instagram: 3, linkedin: 3 }), (error: unknown) => error instanceof BudgetError && error.code === 'PICTURE_LIMIT_REACHED' && error.channel?.network === 'linkedin' && /2 of your 3 LinkedIn pictures left/.test(error.message));
    assert.equal(ledger.calls().length, 1, 'the check buys and records nothing');
    // With no weekly limit set (a staff client) nothing is checked.
    open(file, { perBrandMonthUsd: 50 }).assertChannelPicturesFit({ instagram: 99 });
  } finally {
    done();
  }
});

test('a picture with no channel, and any picture of a client with no weekly limit, is never held back by the weekly limit', () => {
  const { file, done } = workspace();
  try {
    const limited = open(file, { maxPicturesPerChannelWeek: 1, maxImagesPerPoster: 9, perBrandMonthUsd: 50, perBrandDayUsd: 50, globalDayUsd: 50, perRunUsd: 50, perPosterUsd: 50 });
    for (const key of ['a', 'b', 'c']) limited.complete(limited.reserve({ operation: 'image', model: 'img', postId: `plain-${key}`, requestKey: key, maxCostUsd: 0.02 }), { actualCostUsd: 0.02 });
    const staff = open(file, { maxImagesPerPoster: 9, perBrandMonthUsd: 50, perBrandDayUsd: 50, globalDayUsd: 50, perRunUsd: 50, perPosterUsd: 50 }, { brandId: 'staffco' });
    for (const key of ['x', 'y']) staff.complete(staff.reserve({ operation: 'image', model: 'img', postId: `s-${key}`, network: 'instagram', requestKey: key, maxCostUsd: 0.02 }), { actualCostUsd: 0.02 });
  } finally {
    done();
  }
});

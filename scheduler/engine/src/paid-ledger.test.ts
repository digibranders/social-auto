import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetError, budgetLimitsFromEnv, defaultBudgetLimits, PaidLedger, type BudgetLimits, type BudgetRefusal } from './paid-ledger.ts';

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

/**
 * A worker process for the safety-gate tests: it asks the ledger for money the way a real run would, in a process of its own, so that
 * concurrency and being killed in the middle of a call can be tested for real. Not used by the engine.
 *   node src/ledger-worker.ts <ledger file> <job id> <attempts> <cost per attempt> <mode>
 * mode "spend": reserve, send (mark in flight) and complete each attempt, printing the number that were allowed;
 * mode "hang":  reserve and mark one call in flight, print READY, then wait to be killed.
 */
import { budgetLimitsFromEnv, BudgetError, PaidLedger } from './paid-ledger.ts';

const [file, jobId, attempts, cost, mode] = process.argv.slice(2);
if (!file || !jobId || !attempts || !cost || !mode) throw new Error('usage: ledger-worker <file> <job> <attempts> <cost> <mode>');
const ledger = new PaidLedger(file, budgetLimitsFromEnv(process.env), { jobId, tenantId: 'owner', brandId: `brand-${jobId}` });
let allowed = 0;
for (let i = 0; i < Number(attempts); i++) {
  try {
    const id = ledger.reserve({ operation: 'text', model: 'm', postId: `p${i}`, requestKey: `${jobId}-${i}`, maxCostUsd: Number(cost) });
    ledger.markInFlight(id);
    if (mode === 'hang') {
      console.log('READY');
      setInterval(() => undefined, 1000);
      await new Promise(() => undefined);
    }
    ledger.complete(id, { actualCostUsd: Number(cost) });
    allowed += 1;
  } catch (error) {
    if (!(error instanceof BudgetError)) throw error;
  }
}
console.log(`ALLOWED ${allowed}`);

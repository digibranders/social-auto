/**
 * Administrator commands for the review log. Not for the owner, not run by the service, never automatic.
 *
 *   node src/review-admin.ts doctor  --brand-dir <brands/acme>
 *       Reads the log and the locks and says what is wrong, if anything. Changes nothing.
 *   node src/review-admin.ts recover --brand-dir <brands/acme> --actor <name> --reason "<why>" [--yes]
 *       Repairs a log whose only damage is its last record (see review-recovery.ts). Needs the review service stopped. Asks for confirmation unless --yes.
 *
 * Exit codes: 0 fine, 1 wrong use, 2 the log needs recovery, 3 refused (nothing was changed), 4 the repair was made but did not check out.
 */
import { basename, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { inspectLog, recoverLog, RecoveryRefused } from './review-recovery.ts';
import { ReviewStore } from './review-store.ts';

const lockLine = (name: string, lock: ReturnType<typeof inspectLog>['storeLock']): string => {
  switch (lock.state) {
    case 'free': return `${name}: free`;
    case 'held': return `${name}: HELD by running process ${lock.pid}`;
    case 'dead_holder': return `${name}: left by process ${lock.pid}, which is gone (it is cleared automatically the next time a writer needs it)`;
    case 'foreign_holder': return `${name}: held by process ${lock.pid} on another machine (${lock.host})`;
    case 'damaged': return `${name}: DAMAGED lock file (it is never removed automatically)`;
  }
};

export async function main(argv: readonly string[], io: { out: (line: string) => void; confirm: (question: string) => Promise<string> } = { out: console.log, confirm: async (q) => (await createInterface({ input: process.stdin, output: process.stdout }).question(q)) }): Promise<number> {
  const command = argv[0];
  const { values } = parseArgs({ args: [...argv.slice(1)], options: { 'brand-dir': { type: 'string' }, actor: { type: 'string' }, reason: { type: 'string' }, yes: { type: 'boolean', default: false } }, allowPositionals: false });
  if ((command !== 'doctor' && command !== 'recover') || !values['brand-dir']) {
    io.out('Usage: review-admin doctor --brand-dir <dir>\n       review-admin recover --brand-dir <dir> --actor <name> --reason "<why>" [--yes]');
    return 1;
  }
  const brandDir = resolve(values['brand-dir']);
  const brand = basename(brandDir);

  if (command === 'doctor') {
    const report = inspectLog(brandDir);
    io.out(`Log: ${report.logFile}`);
    io.out(`Records: ${report.records}`);
    io.out(`State: ${report.status}${report.kind ? ` (${report.kind})` : ''}`);
    for (const problem of report.problems) io.out(`  - ${problem}`);
    io.out(lockLine('Store lock', report.storeLock));
    io.out(lockLine('Service lock', report.serviceLock));
    io.out(`Approvals in force: ${report.approvedInForce.length}`);
    if (report.status === 'recoverable') io.out('This can be repaired: stop the review service, then run "recover". Any approval in force will be held until the owner confirms it again.');
    if (report.status === 'unrecoverable') io.out('This cannot be repaired by cutting the end of the log. Restore it from a verified backup or investigate it offline. Do not edit the file or delete locks by hand.');
    return report.status === 'clean' ? 0 : report.status === 'recoverable' ? 2 : 3;
  }

  if (!values.actor || !values.reason) {
    io.out('A recovery needs --actor (who is doing it) and --reason (why).');
    return 1;
  }
  const before = inspectLog(brandDir);
  io.out(`About to repair ${before.logFile}: ${before.status}${before.kind ? ` (${before.kind})` : ''}. ${before.approvedInForce.length} approval(s) in force would be held until the owner confirms them again.`);
  if (!values.yes) {
    const answer = (await io.confirm(`Type "RECOVER ${brand}" to go on: `)).trim();
    if (answer !== `RECOVER ${brand}`) {
      io.out('Not confirmed. Nothing was changed.');
      return 3;
    }
  }
  try {
    const { record, evidenceDir } = recoverLog({ brandDir, brand, actor: values.actor, reason: values.reason });
    io.out(`Repaired (${record.kind}). Evidence kept read-only in ${evidenceDir}`);
    io.out(`Held until confirmed again: ${record.heldVersionIds.length === 0 ? 'none' : record.heldVersionIds.join(', ')}`);
    const store = new ReviewStore(brandDir, brand);
    io.out(`Check: ${store.list().length} versions read cleanly. Restart the review service when ready.`);
    return 0;
  } catch (error) {
    if (error instanceof RecoveryRefused) {
      io.out(`Refused (${error.code}): ${error.message}`);
      for (const problem of error.problems) io.out(`  - ${problem}`);
      return error.code === 'UNRECOVERABLE' && error.message.startsWith('after the repair') ? 4 : error.code === 'INVALID' ? 1 : 3;
    }
    throw error;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exitCode = 1;
  });
}

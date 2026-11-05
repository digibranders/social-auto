/**
 * The zero-spend safety gate: faults injected into the ledger and the crawler with no money and no site involved. Three normal runs cannot
 * prove these protections, so they are proven here: real processes racing for one budget, a process killed in the middle of a paid call, a
 * write torn in half, a damaged log, and a real Chrome that is not allowed to reach this machine or its neighbours however it tries.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { startGuardProxy } from './guard-proxy.ts';
import { BudgetError, defaultBudgetLimits, PaidLedger } from './paid-ledger.ts';
import { chromeDumpArgs, chromePath } from './platform.ts';

const run = promisify(execFile);
const WORKER = new URL('./ledger-worker.ts', import.meta.url).pathname;

function workspace(): { file: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  return { file: join(dir, 'paid-calls.jsonl'), done: () => rmSync(dir, { recursive: true, force: true }) };
}

const worker = (file: string, job: string, attempts: number, cost: number, mode: 'spend' | 'hang', env: Record<string, string> = {}): ReturnType<typeof spawn> =>
  spawn(process.execPath, [WORKER, file, job, String(attempts), String(cost), mode], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });

const output = (child: ReturnType<typeof spawn>): Promise<string> =>
  new Promise((resolve, reject) => {
    let text = '';
    child.stdout?.on('data', (d: Buffer) => (text += d.toString()));
    child.on('error', reject);
    child.on('close', () => resolve(text));
  });

test('eight real processes racing for one deployment-day budget never spend more than it', async () => {
  const { file, done } = workspace();
  try {
    // Each process is its own job and brand, so only the deployment cap ($0.10) is shared: 8 processes x 10 attempts x $0.02 would be $1.60.
    const env = { BUDGET_GLOBAL_DAY_USD: '0.10', BUDGET_RUN_USD: '5', BUDGET_BRAND_DAY_USD: '5', BUDGET_POSTER_USD: '5' };
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => output(worker(file, `job${i}`, 10, 0.02, 'spend', env))));
    const allowed = results.reduce((sum, text) => sum + Number(/ALLOWED (\d+)/.exec(text)?.[1] ?? Number.NaN), 0);
    assert.equal(allowed, 5, 'exactly five $0.02 calls fit in $0.10');
    const ledger = new PaidLedger(file, { ...defaultBudgetLimits, globalDayUsd: 0.1 }, { jobId: 'check', tenantId: 'owner', brandId: 'check' });
    assert.ok(ledger.spend().globalDay <= 0.1 + 1e-9, `the log holds ${ledger.spend().globalDay}`);
    assert.equal(existsSync(`${file}.lock`), false, 'no lock is left behind');
  } finally {
    done();
  }
});

test('a process killed in the middle of a paid call leaves it unknown, still counted, and never replayed', async () => {
  const { file, done } = workspace();
  try {
    const child = worker(file, 'job-killed', 3, 0.02, 'hang');
    await new Promise<void>((resolve) => child.stdout?.on('data', (d: Buffer) => d.toString().includes('READY') && resolve()));
    child.kill('SIGKILL');
    await new Promise((resolve) => child.on('close', resolve));
    const restarted = new PaidLedger(file, defaultBudgetLimits, { jobId: 'job-killed', tenantId: 'owner', brandId: 'brand-job-killed' });
    const [call] = restarted.calls();
    assert.equal(call?.status, 'unknown');
    assert.equal(restarted.spend('p0').poster, 0.02, 'the reservation still counts');
    assert.throws(() => restarted.reserve({ operation: 'text', model: 'm', postId: 'p0', requestKey: 'job-killed-0', maxCostUsd: 0.02 }), (error: unknown) => error instanceof BudgetError && error.code === 'REPLAY_BLOCKED');
  } finally {
    done();
  }
});

test('a write torn in half is set aside, nothing is lost, and the next record does not glue to it', () => {
  const { file, done } = workspace();
  try {
    const first = new PaidLedger(file, defaultBudgetLimits, { jobId: 'job', tenantId: 'owner', brandId: 'acme' });
    const kept = first.reserve({ operation: 'text', model: 'm', requestKey: 'kept', maxCostUsd: 0.01 });
    first.complete(kept, { actualCostUsd: 0.01 });
    // A process dies half-way through writing a record.
    appendFileSync(file, '{"type":"reserve","call":{"callId":"torn","jobId":"job","tenant');
    const second = new PaidLedger(file, defaultBudgetLimits, { jobId: 'job', tenantId: 'owner', brandId: 'acme' });
    assert.equal(second.calls().length, 1);
    assert.equal(second.calls()[0]?.status, 'completed');
    assert.ok(second.reserve({ operation: 'text', model: 'm', requestKey: 'after', maxCostUsd: 0.01 }));
    assert.equal(new PaidLedger(file, defaultBudgetLimits, { jobId: 'job', tenantId: 'owner', brandId: 'acme' }).calls().length, 2);
    assert.match(readFileSync(`${file}.torn`, 'utf8'), /"callId":"torn"/);
  } finally {
    done();
  }
});

test('a damaged record in the middle of the log means nothing is spent until a person looks', () => {
  const { file, done } = workspace();
  try {
    const ledger = new PaidLedger(file, defaultBudgetLimits, { jobId: 'job', tenantId: 'owner', brandId: 'acme' });
    ledger.complete(ledger.reserve({ operation: 'text', model: 'm', requestKey: 'a', maxCostUsd: 0.01 }), { actualCostUsd: 0.01 });
    const text = readFileSync(file, 'utf8').split('\n');
    writeFileSync(file, [text[0], 'this is not json', ...text.slice(1)].join('\n'));
    const refused = (work: () => unknown): void => assert.throws(work, (error: unknown) => error instanceof BudgetError && error.code === 'KILL_SWITCH');
    refused(() => new PaidLedger(file, defaultBudgetLimits, { jobId: 'job', tenantId: 'owner', brandId: 'acme' }));
    refused(() => ledger.reserve({ operation: 'text', model: 'm', requestKey: 'b', maxCostUsd: 0.01 }));
  } finally {
    done();
  }
});

test('a ledger that cannot be read or written spends nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  try {
    // The log's own path is a folder: reading it fails with something other than "no such file", which must never be taken for an empty ledger.
    mkdirSync(join(dir, 'paid-calls.jsonl'));
    assert.throws(() => new PaidLedger(join(dir, 'paid-calls.jsonl'), defaultBudgetLimits, { jobId: 'job', tenantId: 'owner', brandId: 'acme' }), (error: unknown) => error instanceof BudgetError && error.code === 'KILL_SWITCH');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Chrome containment (real Chrome; skipped where there is none)

const chrome = ((): string | undefined => {
  try {
    const path = chromePath(process.env, process.platform);
    return existsSync(path) ? path : undefined;
  } catch {
    return undefined;
  }
})();

const ATTEMPTS = (port: number): string => `
  const t = 'http://127.0.0.1:${port}';
  const l = 'http://localhost:${port}';
  const hit = (u) => { try { fetch(u, { mode: 'no-cors' }).catch(() => {}); } catch (e) {} };
  hit(t + '/fetch'); hit(l + '/fetch'); hit('http://[::1]:${port}/fetch'); hit('http://[::ffff:7f00:1]:${port}/fetch'); hit('http://2130706433:${port}/fetch');
  hit('http://169.254.169.254/latest/meta-data'); hit('http://10.0.0.1/'); hit('http://192.168.0.1/');
  try { new WebSocket('ws://127.0.0.1:${port}/ws'); } catch (e) {}
  try { new EventSource(t + '/events'); } catch (e) {}
  try { navigator.sendBeacon(t + '/beacon', 'x'); } catch (e) {}
  const img = new Image(); img.src = t + '/img';
  const frame = document.createElement('iframe'); frame.src = t + '/frame'; document.body.appendChild(frame);
  const link = document.createElement('link'); link.rel = 'prefetch'; link.href = t + '/prefetch'; document.head.appendChild(link);
  try { const w = new Worker(URL.createObjectURL(new Blob(['fetch("' + t + '/worker")']))); } catch (e) {}
  setTimeout(() => { location.href = t + '/redirect'; }, 200);
`;

test('real Chrome cannot reach this machine or its neighbours however it tries, with the proxy up or down', { skip: chrome === undefined }, async () => {
  let hits = 0;
  const http: Server = createServer((_req, res) => { hits += 1; res.end('x'); });
  const tcp = createTcpServer((socket) => { hits += 1; socket.destroy(); });
  await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
  const port = (http.address() as AddressInfo).port;
  // The same port on TCP for the WebSocket handshake is covered by the HTTP server above; this one watches a second port.
  await new Promise<void>((done) => tcp.listen(0, '127.0.0.1', done));
  const page = `data:text/html,${encodeURIComponent(`<body>hello<script>${ATTEMPTS(port)}</script></body>`)}`;
  const guard = await startGuardProxy();
  try {
    const profile = await mkdtemp(join(tmpdir(), 'gate-chrome-'));
    await run(chrome as string, chromeDumpArgs(profile, page, process.env, guard.chromeArgs), { timeout: 40_000, maxBuffer: 4 << 20 });
    assert.equal(hits, 0, 'nothing on this machine was reached through the proxy');
    assert.ok(guard.refused.length > 0, 'the attempts were seen and refused');
    // The proxy is down: Chrome must not quietly go direct.
    const deadPort = guard.port;
    await guard.close();
    hits = 0;
    const profile2 = await mkdtemp(join(tmpdir(), 'gate-chrome-'));
    await run(chrome as string, chromeDumpArgs(profile2, page, process.env, [`--proxy-server=http://127.0.0.1:${deadPort}`, '--proxy-bypass-list=<-loopback>', '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1']), { timeout: 40_000, maxBuffer: 4 << 20 }).catch(() => undefined);
    assert.equal(hits, 0, 'with the proxy down Chrome reached nothing');
  } finally {
    await guard.close().catch(() => undefined);
    http.close();
    tcp.close();
  }
});

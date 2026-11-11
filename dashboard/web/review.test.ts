import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BATCH_QUESTION, accountsText, brandingView, chosenClient, clientOptions, connectedNetworkKeys, signoffText, signoffView, tomorrowIst, visibleJobs, whenProblem, DONE_VISIBLE_MS, STOPPED_VISIBLE_MS, networkState, NEW_CLIENT, startClientOptions, costText, failureText, groupBatches, imageUrl, jobActive, jobText, looksLikeSite, parseBranding, splitHashtags, parseJobs, parseQueue, queryStatus, REASON_LABELS, type JobView } from './review.ts';
import type { ClientSummary } from './clients.ts';
import { parseRoute, routeHash } from './route.ts';

const good = { versionId: 'acme.0123456789abcdef', brand: 'acme', postId: 'w01-d1', versionNumber: 2, status: 'pending', headline: 'H', caption: 'C', createdAt: '2026-11-05T10:00:00Z', costUsd: 0.016 };

test('the queue keeps well formed entries and drops anything else', () => {
  const parsed = parseQueue({ posts: [good, { ...good, status: 'weird' }, { ...good, versionId: 5 }, null, 'x'], reasons: ['weak_copy', 'made_up'] });
  assert.equal(parsed.posts.length, 1);
  assert.deepEqual(parsed.reasons, ['weak_copy']);
  assert.deepEqual(parseQueue(null), { posts: [], reasons: Object.keys(REASON_LABELS), problems: [] });
  assert.deepEqual(parseQueue({ posts: [], problems: [{ brand: 'acme', message: 'The review record needs administrator recovery.' }, { brand: 5 }] }).problems, ['acme: The review record needs administrator recovery.']);
});

test('pictures are asked for by version, as a preview or a download, with the id escaped', () => {
  assert.equal(imageUrl('acme.0123456789abcdef'), '/api/review?view=image&id=acme.0123456789abcdef');
  assert.equal(imageUrl('acme.0123456789abcdef', 'download'), '/api/review?view=download&id=acme.0123456789abcdef');
  assert.equal(imageUrl('a b&c'), '/api/review?view=image&id=a%20b%26c');
});

test('failures use the service\'s own words, or say what failed', () => {
  assert.equal(failureText({ error: 'a newer version of this post exists; approve that one' }, 409), 'a newer version of this post exists; approve that one');
  assert.equal(failureText(null, 502), 'That did not work (502).');
  assert.equal(costText(0.0161), '$0.016');
  assert.equal(costText(0), 'free');
});

test('the review page has its own address', () => {
  assert.deepEqual(parseRoute('#/review'), { page: 'review' });
  assert.equal(routeHash({ page: 'review' }), '#/review');
});

test('the "To review" tab asks for what waits and what must be confirmed again; a held poster is a valid entry', () => {
  assert.equal(queryStatus('pending'), 'open');
  assert.equal(queryStatus('approved'), 'approved');
  const parsed = parseQueue({ posts: [{ versionId: 'acme.0123456789abcdef', brand: 'acme', postId: 'p', versionNumber: 1, status: 'held', headline: 'H', caption: 'C', createdAt: '', costUsd: 0 }] });
  assert.equal(parsed.posts[0]?.status, 'held');
});

test('posters are grouped into the batch they were made in, one brand and one plan, so a week can be judged as a whole', () => {
  const entry = (brand: string, planFile: string, postId: string) => ({ versionId: `${brand}.${postId.padStart(16, '0')}`, brand, postId, planFile, versionNumber: 1, status: 'pending', headline: postId, caption: 'c', createdAt: '', costUsd: 0 });
  const parsed = parseQueue({ posts: [entry('acme', 'week-02.json', 'w02-d2'), entry('globex', 'week-01.json', 'w01-d1'), entry('acme', 'week-02.json', 'w02-d1'), entry('acme', 'week-01.json', 'w01-d1')] });
  const batches = groupBatches(parsed.posts);
  assert.deepEqual(batches.map((b) => [b.brand, b.planFile, b.posts.map((p) => p.postId)]), [
    ['acme', 'week-02.json', ['w02-d1', 'w02-d2']],
    ['acme', 'week-01.json', ['w01-d1']],
    ['globex', 'week-01.json', ['w01-d1']],
  ]);
  assert.match(BATCH_QUESTION, /meaningfully different/);
  assert.equal(parseQueue({ posts: [{ ...entry('acme', 'x', 'p'), planFile: 5 }] }).posts[0]?.planFile, '', 'a missing plan name is tolerated, not drawn as a batch of its own');
});
const record = (over: Record<string, unknown> = {}) => ({ intendedMode: 'authentic_logo', appliedMode: 'text_only', status: 'awaiting_compositor', logoKind: 'wordmark', logoFile: 'branding/abc.svg', logoWidth: 400, logoHeight: 100, sourcePage: 'https://acme.test/', sourceUrl: 'https://acme.test/logo.svg', provenance: 'in the site\'s header; says logo', reason: 'A real logo was found and verified, but real logos are not placed on posters yet, so this poster uses the brand name and web address as text.', ...over });

test('a version made before branding was kept, or with a record that makes no sense, shows no branding section', () => {
  assert.equal(parseBranding(undefined), null);
  assert.equal(parseBranding('x'), null);
  assert.equal(parseBranding({ intendedMode: 'authentic_logo' }), null);
  assert.equal(parseBranding(record({ status: 'amazing' })), null);
  assert.equal(parseBranding(record())?.hasLogoFile, true);
  assert.equal(parseBranding(record({ logoFile: undefined }))?.hasLogoFile, false);
  assert.equal(parseBranding(record({ sourcePage: 7 }))?.sourcePage, undefined, 'a field of the wrong kind is ignored, not trusted');
});

test('a real logo is never said to be on a poster unless the record says it was applied', () => {
  const found = brandingView(parseBranding(record()) as never);
  assert.equal(found.headline, 'Real logo found, not applied');
  assert.equal(found.tone, 'note');
  assert.deepEqual(found.rows[0], ['On this poster', 'The brand name and web address, written as text']);
  assert.ok(found.rows.some(([label, value]) => label === 'Found on' && value === 'https://acme.test/'));
  assert.ok(found.rows.some(([label, value]) => label === 'Logo found' && value === 'Full logo, 400 × 100'));
  const placement = { corner: 'top-right', treatment: 'halo', contrast: 12.5 };
  const applied = brandingView(parseBranding(record({ appliedMode: 'authentic_logo', status: 'applied', reason: undefined, placement })) as never);
  assert.equal(applied.headline, 'Real logo applied');
  assert.equal(applied.tone, 'done');
  assert.equal(applied.rows[0]?.[1], 'The website\'s real logo');
  assert.deepEqual(applied.rows.at(-1), ['Placed', 'top right corner, a thin outline around it so it stays readable']);
  const bare = brandingView(parseBranding(record({ appliedMode: 'authentic_logo', status: 'applied', reason: undefined })) as never);
  assert.equal(bare.headline, 'Real logo found, not applied', 'a record that says applied but shows no place on the poster is not believed');
  assert.equal(parseBranding(record({ placement: { corner: 'middle', treatment: 'halo', contrast: 3 } }))?.placement, undefined, 'a place that makes no sense is ignored');
});

test('with no usable logo the owner is told so, and given the real reason', () => {
  const plain = brandingView(parseBranding({ intendedMode: 'text_only_fallback', appliedMode: 'text_only', status: 'resolved', reason: 'The website has no logo picture, only the name.' }) as never);
  assert.equal(plain.headline, 'Text sign-off used: no usable logo');
  assert.equal(plain.tone, 'plain');
  assert.match(plain.explanation, /The website has no logo picture, only the name\./);
  assert.equal(plain.rows.length, 1, 'there is no logo to describe');
});


test('jobs are read only where well formed and told in plain words', () => {
  const jobs = parseJobs({ jobs: [
    { id: 'job-abc123-0123abcd', kind: 'copy', brand: 'acme', site: 'https://acme.example.com', state: 'running', step: 2 },
    { id: 'job-abc124-0123abcd', kind: 'draw', brand: 'acme', site: 'https://acme.example.com', state: 'failed', planFile: 'week-03.json', error: { code: 'BUDGET_EXHAUSTED', message: 'the day is spent' } },
    { id: 5, kind: 'copy' }, { id: 'x', kind: 'weird', brand: 'a', site: 'b', state: 'queued' },
  ] });
  assert.equal(jobs.length, 2);
  assert.equal(jobText(jobs[0] as JobView), 'Writing posts for https://acme.example.com: writing the posts');
  assert.match(jobText(jobs[1] as JobView), /Drawing the kept posts of acme \(week-03\): stopped\. the day is spent\. Nothing was published\./);
  assert.deepEqual(jobs.map(jobActive), [true, false]);
  assert.deepEqual(parseJobs(null), []);
});

test('a website address is accepted with or without https and refused when it is not a domain', () => {
  for (const good of ['acme.example.com', 'https://www.acme.com/pricing', ' acme.com ']) assert.equal(looksLikeSite(good), true, good);
  for (const bad of ['', 'localhost', '127.0.0.1', 'not a site', 'http://', 'a'.repeat(201)]) assert.equal(looksLikeSite(bad), false, bad);
});

test('the words of a caption are split from its closing hashtags so an edit does not add them twice', () => {
  assert.deepEqual(splitHashtags('Words.\n\nVisit acme.com\n\n#One #Two'), { body: 'Words.\n\nVisit acme.com', hashtags: '#One #Two' });
  assert.deepEqual(splitHashtags('No tags.'), { body: 'No tags.', hashtags: '' });
});

const clientNamed = (brand: string, over: Partial<ClientSummary> = {}): ClientSummary => ({
  brand, label: brand, channels: [], postsLeft: 0, upcoming: [], pattern: null, problems: 0, missed: 0, queueLow: false, added: false, product: null, website: null,
  paused: false, plans: [], weeklyLimit: 3, requireAuthenticLogo: false, approvalMode: 'manual', spendCapUsd: null, posts: [], costs: [], ...over,
});
const channel = (platform: 'instagram' | 'linkedin', account: string | null, ok = true): ClientSummary['channels'][number] => ({ id: account ? `${platform}:${account}` : null, platform, account, avatar: null, brands: [], paused: false, ok });

test('a client with accounts says where its posts go; one without says so', () => {
  assert.equal(accountsText(clientNamed('a')), 'no accounts connected');
  assert.equal(accountsText(clientNamed('a', { channels: [channel('instagram', '@acme'), channel('linkedin', 'Acme Ltd', false)] })), 'Instagram: @acme, LinkedIn: Acme Ltd (has a problem)');
});

test('the client list offers the existing clients, and the website name as a new client only when it is not one of them', () => {
  const clients = [clientNamed('zeta'), clientNamed('acme', { approvalMode: 'auto', channels: [channel('instagram', '@acme')] })];
  const known = clientOptions(clients, 'acme');
  assert.deepEqual(known.map((o) => o.value), ['acme', 'zeta']);
  assert.match(known[0]?.detail ?? '', /Posts to Instagram: @acme\. Automatic: .*without you looking at them/);
  assert.match(known[1]?.detail ?? '', /^No accounts are connected, so nothing can be published yet\. Manual: you approve each poster in Review/);

  const fresh = clientOptions(clients, 'newsite');
  assert.deepEqual(fresh.map((o) => o.value), ['newsite', 'acme', 'zeta']);
  assert.equal(fresh[0]?.label, 'New client: newsite');
  assert.match(fresh[0]?.detail ?? '', /not one of your clients yet, so it has no accounts connected/);
});

test('the shown client is the one picked if still offered, else the one named like the website, else the first', () => {
  const options = clientOptions([clientNamed('acme'), clientNamed('zeta')], 'acme');
  assert.equal(chosenClient(options, 'zeta', 'acme')?.value, 'zeta');
  assert.equal(chosenClient(options, 'gone', 'acme')?.value, 'acme');
  assert.equal(chosenClient(options, undefined, 'other')?.value, 'acme');
  assert.equal(chosenClient([], undefined, 'acme'), undefined);
});

test('the write form offers a new client first, then the existing clients, none of them typed', () => {
  const options = startClientOptions([clientNamed('zeta'), clientNamed('acme', { approvalMode: 'auto' })]);
  assert.deepEqual(options.map((o) => o.value), [NEW_CLIENT, 'acme', 'zeta']);
  assert.equal(options[0]?.label, 'New client (named after the website)');
  assert.match(options[0]?.detail ?? '', /no accounts connected yet/);
  assert.match(options[1]?.detail ?? '', /Automatic: .*without you looking at them/);
  assert.deepEqual(startClientOptions([]).map((o) => o.value), [NEW_CLIENT]);
});

test('each network says whether the chosen client has an account on it, and a new client says nothing', () => {
  const client = clientNamed('acme', { channels: [channel('instagram', '@acme'), channel('linkedin', 'Acme Ltd', false)] });
  assert.deepEqual(networkState(client, 'instagram'), { state: 'connected', account: '@acme' });
  assert.deepEqual(networkState(client, 'linkedin'), { state: 'problem', account: 'Acme Ltd' });
  assert.deepEqual(networkState(client, 'facebook'), { state: 'not-connected', account: null });
  assert.equal(networkState(undefined, 'instagram'), null);
  assert.deepEqual(connectedNetworkKeys(client), ['instagram', 'linkedin']);
  assert.deepEqual(connectedNetworkKeys(clientNamed('empty')), []);
});

test('a poster\'s sign-off is the brand and website default unless the owner changed it, and says so', () => {
  const batch = { signoffDefault: { brandName: 'Acme', domain: 'acme.com' } };
  assert.deepEqual(signoffView(batch, {}), { brandName: 'Acme', domain: 'acme.com', changed: false });
  assert.deepEqual(signoffView(batch, { signoff: { domain: 'acme.com/pricing' } }), { brandName: 'Acme', domain: 'acme.com/pricing', changed: true });
  assert.deepEqual(signoffView(batch, { signoff: { brandName: 'Acme', domain: 'acme.com' } }), { brandName: 'Acme', domain: 'acme.com', changed: false });
  assert.equal(signoffView({}, {}), null, 'without the brand\'s name and website nothing is shown or editable');
});

test('the box shows what is in progress, then what just finished, and no older history', () => {
  const now = Date.parse('2026-11-11T12:00:00Z');
  const job = (id: string, state: JobView['state'], finishedAgoMs?: number): JobView => ({ id, kind: 'draw', brand: 'acme', site: 'https://acme.com', state, ...(finishedAgoMs !== undefined ? { finishedAt: now - finishedAgoMs } : {}) });
  const shown = visibleJobs([
    job('old-done', 'succeeded', DONE_VISIBLE_MS + 1000),
    job('new-done', 'succeeded', 60_000),
    job('running', 'running'),
    job('queued', 'queued'),
    { ...job('stopped-recently', 'failed', 30 * 60 * 1000), brand: 'other' },
    job('stopped-long-ago', 'failed', STOPPED_VISIBLE_MS + 1000),
    job('done-no-time', 'succeeded'),
    job('newest-done', 'succeeded', 1000),
  ], now);
  assert.deepEqual(shown.map((j) => j.id), ['running', 'queued', 'newest-done', 'new-done', 'stopped-recently']);
  assert.deepEqual(visibleJobs([], now), []);
});

test('a job\'s end time is read when the service gives one', () => {
  const [done, running] = parseJobs({ jobs: [
    { id: 'job-a-1', kind: 'copy', brand: 'a', site: 'https://a.com', state: 'succeeded', finishedAt: '2026-11-11T11:00:00.000Z' },
    { id: 'job-b-1', kind: 'copy', brand: 'b', site: 'https://b.com', state: 'running' },
  ] });
  assert.equal(done?.finishedAt, Date.parse('2026-11-11T11:00:00.000Z'));
  assert.equal(running?.finishedAt, undefined);
});

test('a stop that a later try has replaced is not shown, but one nothing replaced is', () => {
  const now = Date.parse('2026-11-11T12:00:00Z');
  const draw = (id: string, brand: string, planFile: string, state: JobView['state'], finishedAgoMs?: number): JobView => ({ id, kind: 'draw', brand, site: 'https://x.com', state, planFile, ...(finishedAgoMs !== undefined ? { finishedAt: now - finishedAgoMs } : {}) });
  const jobs = [
    draw('stopped-then-done', 'acme', 'week-02.json', 'failed', 17 * 60_000),
    draw('done-after', 'acme', 'week-02.json', 'succeeded', 15 * 60_000 - 60_000),
    draw('stopped-then-running', 'beta', 'week-01.json', 'failed', 10 * 60_000),
    draw('running-after', 'beta', 'week-01.json', 'running'),
    draw('stopped-alone', 'gamma', 'week-03.json', 'failed', 5 * 60_000),
    draw('stopped-other-plan', 'acme', 'week-09.json', 'failed', 4 * 60_000),
    draw('done-earlier', 'delta', 'week-01.json', 'succeeded', 20 * 60_000),
    draw('stopped-later', 'delta', 'week-01.json', 'failed', 3 * 60_000),
  ];
  assert.deepEqual(visibleJobs(jobs, now).map((j) => j.id), ['running-after', 'stopped-later', 'stopped-other-plan', 'stopped-alone', 'done-after']);
});

test('the sign-off line says in words what the poster carries, including what was left off', () => {
  assert.equal(signoffText({ brandName: 'Acme', domain: 'acme.com' }), 'Acme | acme.com');
  assert.equal(signoffText({ brandName: 'Acme', domain: '' }), 'Acme (no web address)');
  assert.equal(signoffText({ brandName: '', domain: 'acme.com' }), 'acme.com (no brand name)');
  assert.equal(signoffText({ brandName: '', domain: '' }), 'no brand name and no web address');
  const batch = { signoffDefault: { brandName: 'Acme', domain: 'acme.com' } };
  assert.deepEqual(signoffView(batch, { signoff: { brandName: '', domain: '' } }), { brandName: '', domain: '', changed: true });
});

test('the day and time of the posts are checked in plain words, with India time deciding what tomorrow is', () => {
  const now = Date.parse('2026-11-11T06:55:00Z'); // 12:25 on 11 November in India
  assert.equal(tomorrowIst(now), '2026-11-12');
  assert.equal(tomorrowIst(Date.parse('2026-11-11T19:00:00Z')), '2026-11-13', 'already the 12th in India');
  assert.equal(whenProblem('', '10:00', now), null, 'no day: the next free day is used');
  assert.equal(whenProblem('2026-11-12', '09:30', now), null);
  assert.equal(whenProblem('2026-12-14', '23:59', now), null);
  assert.match(whenProblem('2026-11-11', '10:00', now) ?? '', /tomorrow or later/);
  assert.match(whenProblem('2026-02-30', '10:00', now) ?? '', /real day/);
  assert.match(whenProblem('2027-06-01', '10:00', now) ?? '', /within 180 days/);
  for (const bad of ['', '9:30', '25:00', '10:60']) assert.match(whenProblem('2026-12-14', bad, now) ?? '', /time of day/, bad);
});

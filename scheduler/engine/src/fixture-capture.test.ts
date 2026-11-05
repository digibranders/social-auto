import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertApproved, captureFixture, FixtureNotApprovedError, tidyHtml, type ApprovedSites } from './fixture-capture.ts';
import type { FetchedPage } from './safe-fetch.ts';

const approved: ApprovedSites = { approvedBy: 'test', hosts: ['fynix.digital', 'digibranders.com'] };

test('only an approved site, with or without www, may be captured', () => {
  assert.equal(assertApproved('https://fynix.digital', approved).hostname, 'fynix.digital');
  assert.equal(assertApproved('https://www.fynix.digital/', approved).hostname, 'www.fynix.digital');
  assert.equal(assertApproved('digibranders.com', approved).hostname, 'digibranders.com');
});

test('look-alike hosts, subdomains that were not approved, sneaky addresses and other schemes are refused', () => {
  for (const url of [
    'https://example.com',
    'https://fynix.digital.evil.example',
    'https://notfynix.digital',
    'https://blog.fynix.digital',
    'https://fynix.digital@evil.example/',
    'https://evil.example/?u=fynix.digital',
    'ftp://fynix.digital',
    'not a url at all',
  ]) {
    assert.throws(() => assertApproved(url, approved), FixtureNotApprovedError, url);
  }
  assert.throws(() => assertApproved('https://fynix.digital', { approvedBy: 'x', hosts: [] }), FixtureNotApprovedError);
});

test('the saved copy keeps what ranking reads (links, language, canonical, alternates, headings) and drops scripts, styles, comments and inline pictures', () => {
  const html = `<!doctype html><html lang="en"><head><title>T</title><link rel="canonical" href="https://a.example/"><link rel="alternate" hreflang="fr" href="/fr/"><style>.x{color:red}</style><script>var secret = 1;</script></head>
  <body><!-- note --><nav><a href="/pricing">Pricing</a></nav><h1>Hello</h1><img src="data:image/png;base64,AAAAAAAA"><svg viewBox="0 0 1 1"><path d="M0 0L1 1"/></svg><noscript>no js</noscript></body></html>`;
  const tidy = tidyHtml(html);
  for (const keep of ['lang="en"', 'rel="canonical"', 'hreflang="fr"', '<a href="/pricing">Pricing</a>', '<h1>Hello</h1>', '<title>T</title>']) assert.ok(tidy.includes(keep), keep);
  for (const drop of ['secret', 'color:red', 'note', 'AAAAAAAA', 'M0 0L1 1', 'no js']) assert.ok(!tidy.includes(drop), drop);
});

const page = (body: string): FetchedPage => ({ finalUrl: 'https://fynix.digital/', body, type: 'text/html' });
const richHome = `<html lang="en"><body><nav><a href="/services">Services</a><a href="/about">About</a><a href="/contact">Contact</a><a href="/pricing">Pricing</a></nav><main>${'Words about the business. '.repeat(30)}</main></body></html>`;

test('an unapproved site is refused before any request is made', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixture-test-'));
  try {
    let asked = 0;
    await assert.rejects(captureFixture({ site: 'https://example.com', name: 'x', dir, approved, fetchPage: async () => { asked += 1; return page(richHome); } }), FixtureNotApprovedError);
    assert.equal(asked, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an approved site is saved as a tidy homepage plus a record of where and when, and no expectation file is invented', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixture-test-'));
  try {
    const seen: string[] = [];
    const result = await captureFixture({
      site: 'https://fynix.digital', name: 'fynix', dir, approved, now: new Date('2026-11-03T12:00:00Z'),
      fetchPage: async (url) => {
        seen.push(url);
        return url.endsWith('/robots.txt') ? { finalUrl: url, body: 'User-agent: *\nAllow: /\n', type: 'text/plain' } : page(`<script>x()</script>${richHome}`);
      },
    });
    assert.deepEqual(seen, ['https://fynix.digital/robots.txt', 'https://fynix.digital/']);
    assert.ok(!(await readFile(join(dir, 'fynix', 'home.html'), 'utf8')).includes('x()'));
    const source = JSON.parse(await readFile(join(dir, 'fynix', 'source.json'), 'utf8')) as Record<string, unknown>;
    assert.deepEqual([source['url'], source['rendered'], source['capturedAt'], source['approvedBy']], ['https://fynix.digital/', false, '2026-11-03T12:00:00.000Z', 'test']);
    await assert.rejects(access(join(dir, 'fynix', 'expect.json')));
    assert.equal(result.rendered, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a homepage that builds itself in the browser is saved as the browser sees it, and says so', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixture-test-'));
  try {
    const result = await captureFixture({
      site: 'https://fynix.digital', name: 'fynix', dir, approved,
      fetchPage: async (url) => (url.endsWith('/robots.txt') ? { finalUrl: url, body: '', type: 'text/plain' } : page('<html><body><div id="app"></div></body></html>')),
      render: async () => richHome,
    });
    assert.equal(result.rendered, true);
    assert.ok((await readFile(join(dir, 'fynix', 'home.html'), 'utf8')).includes('/services'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a site whose robots.txt disallows the homepage is not read, and folder names are kept safe', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixture-test-'));
  try {
    const seen: string[] = [];
    await assert.rejects(
      captureFixture({ site: 'https://fynix.digital', name: 'fynix', dir, approved, fetchPage: async (url) => { seen.push(url); return { finalUrl: url, body: 'User-agent: *\nDisallow: /\n', type: 'text/plain' }; } }),
      /robots\.txt/,
    );
    assert.deepEqual(seen, ['https://fynix.digital/robots.txt']);
    for (const name of ['../escape', 'a/b', '', 'Has Space']) {
      await assert.rejects(captureFixture({ site: 'https://fynix.digital', name, dir, approved, fetchPage: async () => page(richHome) }), /name/i, name);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

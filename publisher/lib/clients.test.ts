import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addClient, allBrands, normalizeWebsite, parseClientsFile, setWebsite, slugFor } from './clients.ts';

const NOW = Date.parse('2026-11-02T08:00:00Z');

test('a name becomes a plain slug: accents and punctuation go, words are joined by one dash', () => {
  assert.equal(slugFor('Brand Basket'), 'brand-basket');
  assert.equal(slugFor('  Café & Co.!! '), 'cafe-co');
  assert.equal(slugFor('A'.repeat(60)), 'a'.repeat(41));
  assert.throws(() => slugFor('***'), /letter or number/);
  assert.throws(() => slugFor(42), /name/);
});

test('adding a client keeps the others, and refuses a name that is already a client', () => {
  const first = addClient({ clients: [] }, 'Acme Dental', new Set(['brandbasket']), NOW);
  assert.equal(first.brand, 'acme-dental');
  assert.deepEqual(parseClientsFile(JSON.parse(JSON.stringify(first.file))), first.file);
  assert.throws(() => addClient(first.file, 'acme dental', new Set(), NOW), /already a client/);
  assert.throws(() => addClient({ clients: [] }, 'BrandBasket', new Set(['brandbasket']), NOW), /already a client/);
  const second = addClient(first.file, 'Zed', new Set(), NOW);
  assert.deepEqual(second.file.clients.map((c) => c.brand), ['acme-dental', 'zed']);
});

test('every planned and added client is known; a malformed file is rejected', () => {
  assert.deepEqual([...allBrands(['a'], { clients: [{ brand: 'b', createdAt: 'x' }] })].sort(), ['a', 'b']);
  assert.throws(() => parseClientsFile({}), /clients/);
  assert.throws(() => parseClientsFile({ clients: [{ brand: '../x', createdAt: 'x' }] }), /malformed/);
});

test('a website is kept as its plain address: https, no path, no query, lower case', () => {
  assert.equal(normalizeWebsite('brandbasket.in'), 'https://brandbasket.in');
  assert.equal(normalizeWebsite('  HTTPS://WWW.BrandBasket.in/about?x=1#top '), 'https://www.brandbasket.in');
  assert.equal(normalizeWebsite('http://example.co.uk/'), 'https://example.co.uk');
  assert.equal(normalizeWebsite('münchen.de'), 'https://xn--mnchen-3ya.de');
});

test('a website must be a public web address: no local or private hosts, logins, ports or other schemes', () => {
  const refused = [
    '', '   ', 'localhost', 'http://127.0.0.1', '192.168.1.5', '10.0.0.1', '127.1', '0x7f.0.0.1', '[::1]', 'http://[::1]/x',
    'intranet', 'printer.local', 'db.internal', 'a.localhost', 'user:pass@example.com', 'https://user@example.com',
    'ftp://example.com', 'javascript:alert(1)', 'example.com:8080', 'exa mple.com', 'exa_mple.com', '-bad.example.com',
    `${'a'.repeat(64)}.com`, `${'a.'.repeat(130)}com`, 'example.123', 42, null, undefined,
  ];
  for (const input of refused) assert.throws(() => normalizeWebsite(input), /website|address/i, String(input));
});

test('a client can be added with a website, and its website can be changed and cleared', () => {
  const added = addClient({ clients: [] }, 'Acme Dental', new Set(), NOW, 'acmedental.com/book');
  assert.equal(added.file.clients[0]?.website, 'https://acmedental.com');
  assert.equal(addClient({ clients: [] }, 'Zed', new Set(), NOW).file.clients[0]?.website, undefined);
  assert.equal(addClient({ clients: [] }, 'Zed', new Set(), NOW, '').file.clients[0]?.website, undefined);
  assert.throws(() => addClient({ clients: [] }, 'Zed', new Set(), NOW, 'localhost'), /website|address/i);

  const changed = setWebsite(added.file, 'acme-dental', 'new-site.org');
  assert.equal(changed.clients[0]?.website, 'https://new-site.org');
  assert.equal(setWebsite(changed, 'acme-dental', '').clients[0]?.website, undefined);
  assert.throws(() => setWebsite(added.file, 'nobody', 'x.com'), /only a client added/);
  assert.deepEqual(parseClientsFile(JSON.parse(JSON.stringify(changed))), changed);
  assert.throws(() => parseClientsFile({ clients: [{ brand: 'a', createdAt: 'x', website: 5 }] }), /website/);
});

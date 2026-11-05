import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { logoToneHtml, measureLogoTone, parseTone, plateFor } from './logo-tone.ts';

const LIGHT = '#F6F6F6';
const DARK = '#14161C';

test('only a mostly pale logo gets the dark plate; mixed, dark and unknown logos keep the light one', () => {
  assert.equal(plateFor({ pale: 1, dark: 0 }, LIGHT, DARK), DARK);
  assert.equal(plateFor({ pale: 0.6, dark: 0.1 }, LIGHT, DARK), DARK);
  assert.equal(plateFor({ pale: 0, dark: 0.9 }, LIGHT, DARK), LIGHT);
  assert.equal(plateFor({ pale: 0.3, dark: 0.3 }, LIGHT, DARK), LIGHT);
  assert.equal(plateFor({ pale: 0.1, dark: 0 }, LIGHT, DARK), LIGHT);
  assert.equal(plateFor(null, LIGHT, DARK), LIGHT);
});

test('the measuring page carries the logo as data, so the browser can read its pixels', () => {
  const html = logoToneHtml('data:image/svg+xml;base64,AAAA');
  assert.ok(html.includes('data:image/svg+xml;base64,AAAA'));
  assert.match(html, /getImageData/);
  assert.match(html, /data-pale/);
  assert.match(html, /data-dark/);
});

test('the browser\'s answer is read back as two shares, and anything else is no answer', () => {
  assert.deepEqual(parseTone('<html><body data-pale="0.7712" data-dark="0"></body></html>'), { pale: 0.7712, dark: 0 });
  assert.equal(parseTone('<html><body></body></html>'), null);
  assert.equal(parseTone('<body data-pale="0.5">'), null);
  assert.equal(parseTone('<body data-pale="nope" data-dark="0.1">'), null);
  assert.equal(parseTone('<body data-pale="1.7" data-dark="0">'), null);
});

test('measuring a logo file sends it to the browser by its type and returns the brightness; a failure is no answer, not a crash', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tone-test-'));
  try {
    const file = join(dir, 'logo.svg');
    await writeFile(file, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="4"><rect width="10" height="4" fill="#E0E3FF"/></svg>');
    let page = '';
    const tone = await measureLogoTone(file, {
      dump: async (html) => {
        page = html;
        return '<body data-pale="0.9" data-dark="0.05">';
      },
    });
    assert.deepEqual(tone, { pale: 0.9, dark: 0.05 });
    assert.ok(page.includes('data:image/svg+xml;base64,'));
    assert.equal(await measureLogoTone(file, { dump: async () => { throw new Error('no chrome'); } }), null);
    assert.equal(await measureLogoTone(join(dir, 'missing.png'), { dump: async () => '<body data-pale="0.5" data-dark="0.5">' }), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

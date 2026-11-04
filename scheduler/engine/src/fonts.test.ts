import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FontError, fontCoverage, loadFontManifest, resolveFont } from './fonts.ts';

const bytes = Buffer.from('not really a font');
const sha = createHash('sha256').update(bytes).digest('hex');
const entry = (over: Record<string, unknown> = {}) => ({ family: 'Inter', weight: 700, file: 'Inter-Bold.woff2', sha256: sha, scripts: ['latin'], ...over });

async function dirWith(manifest: unknown, files: Record<string, Buffer> = { 'Inter-Bold.woff2': bytes }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fonts-test-'));
  await writeFile(join(dir, 'manifest.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, name, '..'), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  return dir;
}

test('a directory without a manifest has no local fonts, so brands fall back to the system stack', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fonts-test-'));
  try {
    assert.equal(await loadFontManifest(dir), undefined);
    assert.equal(resolveFont('Inter', undefined).source, 'system');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a verified manifest resolves the brand font to local @font-face rules with no network', async () => {
  const dir = await dirWith({ fonts: [entry()] });
  try {
    const manifest = await loadFontManifest(dir);
    assert.ok(manifest);
    const font = resolveFont('inter', manifest);
    assert.equal(font.source, 'local');
    assert.match(font.css, /@font-face\{font-family:"Inter";font-weight:700;font-style:normal;src:url\("file:\/\//);
    assert.doesNotMatch(font.css, /https?:/);
    assert.equal(resolveFont('Other', manifest).source, 'system');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing file, a changed file, a path outside the directory and a bad manifest are all refused', async () => {
  const cases: Array<[unknown, Record<string, Buffer>, RegExp]> = [
    [{ fonts: [entry()] }, {}, /missing/],
    [{ fonts: [entry()] }, { 'Inter-Bold.woff2': Buffer.from('tampered') }, /hash/],
    [{ fonts: [entry({ file: '../outside.woff2' })] }, {}, /outside the fonts directory/],
    [{ fonts: [entry({ sha256: 'abc' })] }, {}, /sha256/],
    [{ fonts: [entry({ weight: 42 })] }, {}, /weight/],
    [{ fonts: [entry({ scripts: ['klingon'] })] }, {}, /scripts/],
    ['{nope', {}, /not valid JSON/],
    [{ nofonts: true }, {}, /array/],
  ];
  for (const [manifest, files, expected] of cases) {
    const dir = await dirWith(manifest, files);
    try {
      await assert.rejects(loadFontManifest(dir), (error: unknown) => error instanceof FontError && expected.test(error.message));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('font coverage is verified only for scripts the local font declares', async () => {
  const dir = await dirWith({ fonts: [entry({ scripts: ['latin', 'devanagari'] })] });
  try {
    const manifest = await loadFontManifest(dir);
    assert.equal(fontCoverage('Inter', 'Keep projects visible', manifest), 'verified');
    assert.equal(fontCoverage('Inter', 'हर प्रोजेक्ट', manifest), 'verified');
    assert.equal(fontCoverage('Inter', 'اجعل كل مشروع', manifest), 'unverified');
    assert.equal(fontCoverage('Other', 'Keep projects', manifest), 'unverified');
    assert.equal(fontCoverage('Inter', 'Keep projects', undefined), 'unverified');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

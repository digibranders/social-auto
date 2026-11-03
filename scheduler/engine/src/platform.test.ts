import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromeArgs, chromePath, envFilePath, jpegCommand, loadEnvIfPresent } from './platform.ts';

test('chromePath uses CHROME_PATH first, then the usual place for the operating system', () => {
  assert.equal(chromePath({ CHROME_PATH: '/opt/chrome/chrome' }, 'linux'), '/opt/chrome/chrome');
  assert.equal(chromePath({}, 'darwin'), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  assert.equal(chromePath({}, 'linux'), 'google-chrome');
  assert.equal(chromePath({ CHROME_PATH: '' }, 'linux'), 'google-chrome');
});

test('chromeArgs adds --no-sandbox only when asked for', () => {
  const base = chromeArgs('/tmp/profile', '/tmp/a.png', 'file:///tmp/a.html', 1080, {});
  assert.ok(!base.includes('--no-sandbox'));
  assert.ok(base.includes('--headless=new') && base.includes('--window-size=1080,1080') && base.includes('--screenshot=/tmp/a.png'));
  assert.equal(base.at(-1), 'file:///tmp/a.html');
  assert.ok(chromeArgs('/tmp/profile', '/tmp/a.png', 'file:///tmp/a.html', 1080, { CHROME_NO_SANDBOX: '1' }).includes('--no-sandbox'));
});

test('jpegCommand picks sips on a Mac and ImageMagick elsewhere', () => {
  assert.deepEqual(jpegCommand('darwin', '/a.png', '/b.jpg', 90), {
    file: 'sips',
    args: ['-s', 'format', 'jpeg', '-s', 'formatOptions', '90', '/a.png', '--out', '/b.jpg'],
  });
  assert.deepEqual(jpegCommand('linux', '/a.png', '/b.jpg', 90), { file: 'convert', args: ['/a.png', '-quality', '90', '/b.jpg'] });
});

test('envFilePath follows the flag, then SOCIAL_AUTO_ENV, then the default', () => {
  assert.equal(envFilePath(undefined, { SOCIAL_AUTO_ENV: '/etc/social-auto.env' }), '/etc/social-auto.env');
  assert.equal(envFilePath('/x/.env', { SOCIAL_AUTO_ENV: '/etc/social-auto.env' }), '/x/.env');
  assert.match(envFilePath(undefined, {}), /upstream\/\.env$/);
});

test('loadEnvIfPresent loads a file, never overrides what is already set, and tolerates a missing file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'env-test-'));
  try {
    const file = join(dir, 'x.env');
    await writeFile(file, 'PLATFORM_TEST_NEW=from-file\nPLATFORM_TEST_SET=from-file\n');
    process.env['PLATFORM_TEST_SET'] = 'from-environment';
    assert.equal(loadEnvIfPresent(file), true);
    assert.equal(process.env['PLATFORM_TEST_NEW'], 'from-file');
    assert.equal(process.env['PLATFORM_TEST_SET'], 'from-environment');
    assert.equal(loadEnvIfPresent(join(dir, 'missing.env')), false);
  } finally {
    delete process.env['PLATFORM_TEST_NEW'];
    delete process.env['PLATFORM_TEST_SET'];
    await rm(dir, { recursive: true, force: true });
  }
});

import { neutralCta } from './cta.ts';
import { posterBrand } from './render.ts';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { aiConfigFromEnv } from './ai.ts';
import { ContentValidationError, parseWeekPlan } from './content.ts';
import { chromePath } from './platform.ts';
import { renderPlan } from './render.ts';

const real = { skip: existsSync(chromePath(process.env, process.platform)) ? false : 'Chrome is not installed' };

const brandJson = {
  name: 'Acme', website: 'https://acme.example', handleUrl: 'acme.example', offer: 'Project tracking software', audience: 'Small teams', tone: 'Warm',
  proofPoints: ['Open Saturdays'], callToAction: 'Book a demo', rules: ['No invented prices'],
  colors: { background: '#FFFFFF', ink: '#14213D', accent: '#FCA311', tile: '#F2F2F2' }, font: 'Inter',
  features: [{ icon: 'person', title: 'Teams', detail: 'All sizes' }], logo: 'assets/logo.svg', mark: 'assets/logo.svg',
};

const brief = (layout: string, textZone: string, picture: Record<string, unknown>) => ({
  layout, hierarchy: 'headline-first', headlineScale: 'large', alignment: 'start', textZone, picture, logoSlot: 'top-left', identitySlot: 'under-logo', ctaSlot: 'top-right',
});
const candidate = (layout: string, textZone: string, picture: Record<string, unknown> = { role: 'none' }) => ({
  optionId: `${layout}:${textZone}`, brief: brief(layout, textZone, picture),
  record: { layout, hierarchy: 'headline-first', textZone, pictureRole: picture['role'] },
});
const post = (id: string, headline: string, candidates: unknown[]) => ({
  id, date: '2026-11-10T10:00:00+05:30', painPoint: `pain ${id}`, mode: 'template', headline, subline: 'Acme shows where work stands', caption: 'Body', hashtags: ['#one', '#two'],
  art: { resolution: 'directed', candidates },
});

test('a plan file may carry art directions, and each must be a valid brief with its own prompt when it has a picture', () => {
  const ok = parseWeekPlan({ brand: 'b', timezone: 'Asia/Kolkata', posts: [post('p1', 'Plain |accent|', [candidate('typography-hero', 'center')])] }, 'plan');
  assert.equal(ok.posts[0]?.art?.candidates[0]?.brief.layout, 'typography-hero');
  const bad = (art: unknown): void => assert.throws(() => parseWeekPlan({ brand: 'b', timezone: 'Asia/Kolkata', posts: [{ ...post('p1', 'x', []), art }] }, 'plan'), ContentValidationError);
  bad({ resolution: 'directed', candidates: [] });
  bad({ resolution: 'invented', candidates: [candidate('typography-hero', 'center')] });
  bad({ resolution: 'directed', candidates: [{ ...candidate('typography-hero', 'center'), brief: { layout: 'typography-hero' } }] });
  bad({ resolution: 'directed', candidates: [candidate('split-composition', 'left', { role: 'hero', medium: 'illustration', subject: 's', action: 'a', scene: 'c', composition: 'd', mood: 'm', paletteUse: 'balanced' })] });
});

test('real Chrome: a plan with art directions renders its posters, reports honestly, and a failed poster fails the run without losing the others', real, async () => {
  const root = await mkdtemp(join(tmpdir(), 'render-art-'));
  const previous = process.cwd();
  try {
    const brandDir = join(root, 'brands', 'acme');
    await mkdir(join(brandDir, 'assets'), { recursive: true });
    await writeFile(join(brandDir, 'brand.json'), JSON.stringify(brandJson));
    await writeFile(join(brandDir, 'assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#14213D"/></svg>');
    const unfittable = 'x'.repeat(60) + ' ' + 'word '.repeat(80);
    await writeFile(join(brandDir, 'week-01.json'), JSON.stringify({
      brand: 'acme', timezone: 'Asia/Kolkata',
      posts: [post('p1', 'Keep every |project| visible', [candidate('typography-hero', 'center')]), post('p2', unfittable, [candidate('typography-hero', 'center')])],
    }));
    process.chdir(root);
    const ai = aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-openai-key' });
    await assert.rejects(renderPlan({ brandDir, planFile: 'week-01.json', ai, log: () => undefined }), /p2/);
    const out = join(root, 'out', 'acme', 'week-01');
    assert.ok(existsSync(join(out, 'p1.jpg')), 'the good poster was kept');
    assert.ok(!existsSync(join(out, 'p2.jpg')), 'the failed poster was not written');
    const report = JSON.parse(await readFile(join(out, 'render-report.json'), 'utf8')) as Array<{ postId: string; status: string; chromeVersion: string; warnings: Array<{ code: string }> }>;
    assert.equal(report.find((r) => r.postId === 'p1')?.status, 'capture_complete');
    assert.ok(report.find((r) => r.postId === 'p1')?.warnings.some((w) => w.code === 'system_font'));
    assert.equal(report.find((r) => r.postId === 'p2')?.status, 'render_failed');
    assert.match(report[0]?.chromeVersion ?? '', /Chrome/);
  } finally {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  }
});

test('the poster shows the post\'s own call to action when it has one, and the brand\'s otherwise', () => {
  const brand = { name: 'Acme', handleUrl: 'acme.example', colors: { ink: '#111111', accent: '#FCA311', background: '#FFFFFF', tile: '#F2F2F2' }, cta: { kind: 'site-action', label: 'See pricing', evidence: null, text: 'See pricing at acme.example (link in bio)' } } as never;
  assert.equal(posterBrand(brand, undefined, undefined).cta?.label, 'See pricing');
  assert.equal(posterBrand(brand, undefined, undefined, neutralCta('acme.example')).cta?.label, 'Visit the website');
  assert.equal(posterBrand(brand, undefined, undefined, neutralCta('acme.example')).cta?.host, 'acme.example');
});

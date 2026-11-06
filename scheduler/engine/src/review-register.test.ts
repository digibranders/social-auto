import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPublishable, type Brand, type PlannedPost } from './content.ts';
import { brandingFor, registerForReview } from './review-register.ts';
import type { BrandingDecision, LogoPlacementRecord } from './branding.ts';
import { ReviewStore } from './review-store.ts';
import type { CreativeReport } from './ai-creative-pipeline.ts';
import type { EvidenceFact } from './evidence.ts';

const post = (id: string): PlannedPost => ({ id, date: '2026-11-10T10:00:00+05:30', painPoint: 'p', mode: 'ai', headline: 'Answers from your |own docs|', subline: '', caption: 'Hook.\n\nFacts.', hashtags: ['#a'], factIds: ['f1'] }) as unknown as PlannedPost;
const fact = { id: 'f1', text: 'Answers from docs', source: { quote: 'Answers from your own documents', url: 'https://oyechats.com/', context: 'Features' } } as unknown as EvidenceFact;

test('an ai_v1 plan is never publishable from the plan itself, whatever the post says about approval', () => {
  assert.equal(isPublishable({ renderMode: 'ai_v1' }, { approval: { status: 'approved' } }), false);
  assert.equal(isPublishable({ renderMode: 'art_v1' }, { approval: { status: 'approved' } }), true);
  assert.equal(isPublishable({}, {}), true);
});

test('only accepted posters enter the queue, as pending versions that carry their evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'register-'));
  try {
    const picture = join(dir, 'w01-d1.jpg');
    writeFileSync(picture, 'accepted picture');
    const manifest = { headline: 'Answers from your own docs', brandName: 'OyeChats', domain: 'oyechats.com' };
    const report: CreativeReport = {
      brand: 'oyechats', generatedAt: 'now',
      results: [
        { postId: 'w01-d1', manifest, status: 'accepted', file: picture, attempts: [{ n: 1, prompt: 'p', imageFile: picture, readings: [{}, {}] as never, accepted: true, defects: [] }], costUsd: 0.02 },
        { postId: 'w01-d2', manifest, status: 'rejected', attempts: [], reason: 'x', costUsd: 0.03 },
      ],
    };
    const brand = { website: 'https://www.oyechats.com' } as unknown as Brand;
    const made = registerForReview({ brandDir: join(dir, 'brand'), brandSlug: 'oyechats', planFile: 'week-01.json', report, posts: [post('w01-d1'), post('w01-d2')], brand, facts: [fact], reportFile: '/x/creative-report.json' });
    assert.equal(made.length, 1);
    const store = new ReviewStore(join(dir, 'brand'), 'oyechats');
    const item = store.get(made[0]?.versionId as string);
    assert.equal(item.status, 'pending');
    assert.equal(item.version.headline, 'Answers from your own docs');
    assert.equal(item.version.ctaUrl, 'https://www.oyechats.com');
    assert.equal(item.version.evidence[0]?.quote, 'Answers from your own documents');
    assert.equal(item.version.validation.readings, 2);
    assert.equal(store.approvedFor('w01-d1'), undefined, 'registered is not approved');
    // Registering again makes nothing new.
    registerForReview({ brandDir: join(dir, 'brand'), brandSlug: 'oyechats', planFile: 'week-01.json', report, posts: [post('w01-d1')], brand, facts: [fact], reportFile: '/x/creative-report.json' });
    assert.equal(store.list().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a poster is recorded as carrying the real logo only when its own result shows where it was put', () => {
  const decision: BrandingDecision = { intendedMode: 'authentic_logo', appliedMode: 'authentic_logo', status: 'applied', logoKind: 'wordmark', logoAssetSha256: 'a'.repeat(64) };
  const placement: LogoPlacementRecord = { corner: 'top-left', treatment: 'halo', haloColor: 'rgb(255,255,255)', logoRect: [50, 50, 143, 44], contrast: 17.6, logoSha256: 'a'.repeat(64), outputSha256: 'b'.repeat(64) };
  assert.deepEqual(brandingFor(decision, placement), { ...decision, placement }, 'with a place on the poster the record keeps it');
  const without = brandingFor(decision, undefined);
  assert.deepEqual([without.appliedMode, without.status, without.placement], ['text_only', 'awaiting_compositor', undefined], 'a poster that came back without the logo is not said to carry it');
  assert.match(without.reason ?? '', /not placed/);
  const text: BrandingDecision = { intendedMode: 'text_only_fallback', appliedMode: 'text_only', status: 'resolved' };
  assert.deepEqual(brandingFor(text, undefined), text, 'a text sign-off decision is left as it was');
});

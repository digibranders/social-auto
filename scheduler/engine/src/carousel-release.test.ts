/**
 * A product's customer's carousel, end to end with fakes and no spending: made, registered for release, approved as a whole by the customer, exported to the publisher's
 * calendar as one post with every slide, for every channel she connected (and nothing before she approves).
 */
process.env['SOCIAL_PUBLISHING_ENABLED'] = 'true';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { aiConfigFromEnv } from './ai.ts';
import type { CreativeReview } from './ai-creative.ts';
import { runCarousel } from './carousel-run.ts';
import { parseCarouselDraft, type CarouselDraft } from './carousel.ts';
import { writeConnected } from './connected-networks.ts';
import type { Brand } from './content.ts';
import type { EvidenceFact } from './evidence.ts';
import { exportToPublisher } from './export-publisher.ts';
import { defaultHeadlineGate } from './headline-gate.ts';
import { registerManualRelease } from './manual-release.ts';
import { ProductBrands } from './product-brands.ts';
import { ReviewStore } from './review-store.ts';

const brand = { name: 'Curry Cook', website: 'https://www.currycook.com', colors: { background: '#FFF8E7', ink: '#5A0F1E', accent: '#F4B400', tile: '#EEEEEE' }, cta: { kind: 'visit-site', label: 'Order', text: 'Order at currycook.com (link in bio)', evidence: null } } as unknown as Brand;
const fact = (id: string, text: string): EvidenceFact => ({ id, text, category: 'offer', source: { quote: text, url: 'https://currycook.com/', context: 'Home', heading: '', regionType: 'prose', pageRole: 'home', contentHash: 'h' } } as unknown as EvidenceFact);
const facts = [fact('f1', 'Curry Cook offers popular curry menu items.'), fact('f2', 'Curry Cook offers a Build Your Own Curry option.'), fact('f3', 'The kitchen operates daily from 11:00 AM to 10:00 PM.')];
const draft: CarouselDraft = parseCarouselDraft({
  topic: 'Choosing a curry', style: 'flat vector, cream background', typography: 'heavy rounded sans-serif, burgundy, top left',
  slides: [
    { role: 'hook', headline: 'Not sure what |curry to choose|?', scene: 'a bowl of curry', factIds: ['f1'] },
    { role: 'content', headline: 'Or |build your own curry|', scene: 'ingredient jars', factIds: ['f2'] },
    { role: 'closing', headline: 'Open |every day|, lunch to late', scene: 'a wall clock', factIds: ['f3'] },
  ],
}, facts.map((f) => ({ id: f.id, text: f.text })));
const clean = { graphicalLogoOrIcon: false, badgeSealAwardOrCertification: false, inventedNumberPriceOrStatistic: false, interfaceOrScreenshotWithText: false, personPresentedAsCustomerOrEndorser: false, flagOrReligiousSymbol: false };
const reading = (texts: string[]): CreativeReview => ({ regions: texts.map((text) => ({ text, readable: true })), marks: { ...clean }, relevance: 2, composition: 2, readableSmall: true, textOverImportantArt: false, people: { present: false, estimatedCount: 0, prominent: false, description: '' }, notes: 'none' });

test('a customer\'s carousel reaches the calendar only after she approves the whole set, as one post with every slide, for every channel she connected', async () => {
  const root = mkdtempSync(join(tmpdir(), 'carousel-release-'));
  try {
    const brandsRoot = join(root, 'brands');
    const brandDir = join(brandsRoot, 'bb-curry');
    mkdirSync(brandDir, { recursive: true });
    new ProductBrands(brandsRoot).claim('bb-curry', 'brandbasket', () => false);
    writeConnected(brandDir, ['instagram', 'linkedin']);
    let drawn = 0;
    const made = await runCarousel({
      ai: aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234', AI_PROVIDER: 'openai' }), brand, brandSlug: 'bb-curry', brandDir, facts, networks: ['instagram', 'linkedin'], date: '2099-11-13T10:00:00+05:30', outRoot: join(root, 'out'),
      deps: {
        plan: async () => draft,
        captions: async () => ({ captions: { instagram: 'Swipe through.\n\nOrder at currycook.com (link in bio)', linkedin: 'A short guide to choosing a curry.\n\nOrder at currycook.com' }, fallback: [] }),
        slides: {
          headlineGate: { enabled: false, config: defaultHeadlineGate },
          scene: async (_prompt, file) => { drawn += 1; writeFileSync(file, `slide ${drawn}`); },
          review: async () => reading([(draft.slides[(drawn - 1) % 3]?.headline ?? '').replace(/\|/g, ''), ...(drawn % 3 === 0 ? ['currycook.com'] : [])]),
        },
      },
    });
    assert.equal(made.status, 'queued', made.reason);
    // What the carousel job does for a customer once the carousel is queued.
    const release = registerManualRelease({ brandDir, siteBrand: 'bb-curry', client: 'bb-curry', site: 'https://www.currycook.com', planFile: made.planFile as string });
    assert.deepEqual(release.platforms, ['instagram', 'linkedin'], 'both connected channels, not Instagram alone');

    const publisher = join(root, 'publisher');
    const before = await exportToPublisher(brandDir, publisher, Date.now(), { brand: 'bb-curry', weekFiles: [made.planFile as string] });
    assert.deepEqual(before, [], 'nothing goes out before she approves');

    const store = new ReviewStore(brandDir, 'bb-curry');
    store.approveCarousel(made.carouselId, 'brandbasket:user-42');
    const after = await exportToPublisher(brandDir, publisher, Date.now(), { brand: 'bb-curry', weekFiles: [made.planFile as string] });
    assert.equal(after.length, 1, 'one post, the carousel');
    const [post] = after;
    assert.equal(post?.id, `bb-curry-${made.carouselId}`);
    assert.equal(post?.images?.length, 3);
    assert.equal(new Set(post?.images).size, 3);
    assert.equal(post?.image, post?.images?.[0]);
    assert.deepEqual(post?.channels, ['instagram', 'linkedin']);
    assert.match(post?.caption ?? '', /Swipe through/);
    assert.match(post?.variants?.['linkedin']?.caption ?? '', /short guide/);
    assert.equal(readdirSync(join(publisher, 'public', 'posts', 'bb-curry')).length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

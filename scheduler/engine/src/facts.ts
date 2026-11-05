/**
 * Builds evidence facts for a brand from its site, without writing a new profile: crawl (read only), read each page's structure in headless
 * Chrome, apply conflicts, write brands/<slug>/facts.json. No model is called.
 *
 *   node src/facts.ts --site https://example.com
 */
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { crawlSite } from './crawl.ts';
import { buildSiteFacts, writeFacts } from './evidence-pipeline.ts';
import { slugFromSite } from './analyze.ts';

const { values } = parseArgs({ options: { site: { type: 'string' }, brands: { type: 'string', default: 'brands' } } });
if (!values.site) {
  console.error('Usage: node src/facts.ts --site https://example.com [--brands brands]');
  process.exit(1);
}
const snapshot = await crawlSite(values.site);
const file = await buildSiteFacts(snapshot);
const path = await writeFacts(join(values.brands as string, slugFromSite(snapshot.origin)), file);
const c = file.coverage;
console.log(`${path}: ${c.usable} usable, ${c.needsReview} held for review, ${file.conflicts.length} conflict${file.conflicts.length === 1 ? '' : 's'}, ${c.structured}/${c.pages} pages read with structure.`);
for (const note of c.notes) console.log(`  note: ${note}`);
for (const conflict of file.conflicts) console.log(`  conflict: ${conflict.reason}`);
for (const conflict of file.conflictsWithHeld ?? []) console.log(`  conflict involving a held fact: ${conflict.reason}`);

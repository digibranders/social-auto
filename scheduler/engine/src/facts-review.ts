/**
 * Review a brand's evidence facts: list the shortlist, approve or reject by id. No model is called.
 *
 *   node src/facts-review.ts --brand oyechats --list 25
 *   node src/facts-review.ts --brand oyechats --approve a1b2c3,d4e5f6
 *   node src/facts-review.ts --brand oyechats --reject 9f8e7d
 *   node src/facts-review.ts --brand oyechats --status
 */
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { displayFact } from './evidence.ts';
import { applyReview, decide, emptyReview, loadReview, saveReview, shortlist } from './fact-review.ts';
import { loadFacts } from './evidence-pipeline.ts';

const { values } = parseArgs({ options: { brand: { type: 'string' }, brands: { type: 'string', default: 'brands' }, list: { type: 'string' }, approve: { type: 'string' }, reject: { type: 'string' }, status: { type: 'boolean' } } });
if (!values.brand) {
  console.error('Usage: node src/facts-review.ts --brand <slug> [--list N] [--approve ids] [--reject ids] [--status]');
  process.exit(1);
}
const dir = join(values.brands as string, values.brand);
const loaded = await loadFacts(dir);
if (!loaded) {
  console.error(`${dir} has no facts.json: run node src/facts.ts --site <url> first.`);
  process.exit(1);
}
let review = (await loadReview(dir)) ?? emptyReview();
const split = (v: string): string[] => v.split(',').map((s) => s.trim()).filter(Boolean);
if (values.approve) review = decide(review, loaded.facts, split(values.approve), 'approved', new Date());
if (values.reject) review = decide(review, loaded.facts, split(values.reject), 'rejected', new Date());
if (values.approve || values.reject) {
  await saveReview(dir, review);
  console.log('Saved.');
}
const reviewed = applyReview(loaded.facts.filter((f) => f.status === 'usable'), review);
console.log(`Posts will be written from: ${reviewed.mode === 'approved_only' ? `${reviewed.approved} approved facts only` : 'every usable fact (nothing approved yet)'}; ${reviewed.rejected} rejected.`);
if (values.list !== undefined) {
  for (const fact of shortlist(reviewed.facts, [], Number(values.list) || 25)) {
    const mark = review.decisions[fact.id]?.decision === 'approved' ? '[approved]' : '';
    console.log(`${fact.id}  ${fact.category.padEnd(15)} ${fact.source.pageRole.padEnd(10)} ${displayFact(fact).slice(0, 140)} ${mark}`);
  }
}

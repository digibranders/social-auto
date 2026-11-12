/**
 * One page, not the whole website: only the address given is read. It is for a website that has no saved profile with facts yet. A website that already has facts is
 * read already and its facts are used, so reading one page of it again is refused. A website whose first try did not finish (a profile was saved but no facts were
 * built) has nothing worth keeping, so a page may be read for it again.
 */
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { loadFacts } from './evidence-pipeline.ts';

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

/** True when a one-page read must be refused: the brand already has a saved profile with its facts. */
export async function pageModeBlocked(brandDir: string): Promise<boolean> {
  if (!(await exists(join(brandDir, 'brand.json')))) return false;
  try {
    return (await loadFacts(brandDir)) !== null;
  } catch {
    // A facts file that cannot be read is not a finished read either.
    return false;
  }
}

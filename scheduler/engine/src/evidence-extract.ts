/**
 * Reads a page's structure with headless Chrome. The page's HTML is opened under a content security policy that blocks its own scripts
 * and every network request, then the structure script (evidence-script.ts) runs and writes its blocks into the page, which are read
 * from the dumped DOM and validated. If Chrome is missing or the page writes nothing, this throws and the caller falls back to flat text,
 * where every fact is held for review.
 *
 * Known limit: the page is opened without its external stylesheets, so content hidden only by an external stylesheet shows up as visible.
 * Hidden attributes, aria-hidden and inline styles are respected.
 */
import { createHash, randomUUID } from 'node:crypto';
import { measureHtml, type ChromeDeps } from './chrome-render.ts';
import { EVIDENCE_ELEMENT_ID, EVIDENCE_SCRIPT } from './evidence-script.ts';

export type BlockRegion = 'prose' | 'table' | 'list' | 'ui';
export type ChromeRegion = '' | 'nav' | 'header' | 'footer' | 'aside';

export interface PageBlock {
  id: string;
  text: string;
  tag: string;
  region: BlockRegion;
  isHeading: boolean;
  headingText: string;
  chrome: ChromeRegion;
  cardId: string;
  /** The set of sibling cards this card belongs to. */
  cardGroup: string;
  cardTitle: string;
  rowLabel: string;
  colLabel: string;
  tableHeader: boolean;
  demo: boolean;
  strip: boolean;
  /** The whole block is the label of a link or a button: a call to action, not a statement. */
  linkOnly?: boolean;
  lang: string;
}

export interface PageStructure {
  url: string;
  title: string;
  lang: string;
  blocks: PageBlock[];
  truncated: boolean;
  /** Stylesheets the page links (not inlined by the caller): without them hidden content may look visible. */
  unstyled: boolean;
  /** The page has a switch between billing variants (monthly/yearly); only the shown one was read. */
  variantSwitch: boolean;
  /** Hash of the exact HTML that was read. */
  htmlHash: string;
}

export class StructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StructureError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const bool = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

function parseBlock(raw: unknown): PageBlock {
  if (!isRecord(raw)) throw new StructureError('a block is not an object');
  const text = str(raw['text']);
  const id = str(raw['id']);
  const tag = str(raw['tag']);
  const region = str(raw['region']);
  const chrome = str(raw['chrome']);
  const flags = [bool(raw['isHeading']), bool(raw['demo']), bool(raw['strip']), bool(raw['tableHeader'])];
  const strings = ['headingText', 'cardId', 'cardGroup', 'cardTitle', 'rowLabel', 'colLabel', 'lang'].map((k) => str(raw[k]));
  if (text === null || id === null || tag === null || region === null || chrome === null || flags.includes(null) || strings.includes(null)) throw new StructureError('a block has the wrong shape');
  if (!['prose', 'table', 'list', 'ui'].includes(region) || !['', 'nav', 'header', 'footer', 'aside'].includes(chrome)) throw new StructureError('a block has an unknown region');
  return {
    id, text, tag, region: region as BlockRegion, isHeading: flags[0] as boolean, headingText: strings[0] as string, chrome: chrome as ChromeRegion,
    cardId: strings[1] as string, cardGroup: strings[2] as string, cardTitle: strings[3] as string, rowLabel: strings[4] as string, colLabel: strings[5] as string,
    tableHeader: flags[3] as boolean, demo: flags[1] as boolean, strip: flags[2] as boolean, lang: strings[6] as string, ...(raw['linkOnly'] === true ? { linkOnly: true } : {}),
  };
}

/** Finds and validates the structure in a dumped page. */
export function parseStructure(dom: string, url: string, htmlHash = '', stylesInlined = false): PageStructure {
  const match = new RegExp(`<script[^>]*\\sid="${EVIDENCE_ELEMENT_ID}"[^>]*>([\\s\\S]*?)</script>`).exec(dom);
  if (!match) throw new StructureError('the page wrote no structure');
  let raw: unknown;
  try {
    raw = JSON.parse(match[1] ?? '');
  } catch {
    throw new StructureError('the structure is not valid JSON');
  }
  if (!isRecord(raw) || raw['done'] !== true || !Array.isArray(raw['blocks']) || !Array.isArray(raw['errors'])) {
    throw new StructureError(`the structure is incomplete${isRecord(raw) && Array.isArray(raw['errors']) && raw['errors'].length ? `: ${String(raw['errors'][0])}` : ''}`);
  }
  const externalStyles = typeof raw['externalStyles'] === 'number' ? raw['externalStyles'] : 0;
  return {
    url, title: str(raw['title']) ?? '', lang: str(raw['lang']) ?? '', blocks: raw['blocks'].map(parseBlock), truncated: raw['truncated'] === true,
    unstyled: externalStyles > 0 && !stylesInlined, variantSwitch: raw['variantSwitch'] === true, htmlHash,
  };
}

/** The page wrapped so only the structure script can run: no scripts of its own, no network, inline styles only. */
export function wrapForExtraction(html: string, nonce: string, styles: readonly string[] = []): string {
  const policy = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; font-src data:`;
  const sheets = styles.map((css) => `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`).join('');
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}">${sheets}${html}<script nonce="${nonce}">${EVIDENCE_SCRIPT}</script>`;
}

/** `styles` are the page's stylesheets, fetched by the caller and applied inline, so visibility is judged as a browser would judge it. */
export async function extractStructure(html: string, url: string, deps: ChromeDeps & { styles?: readonly string[] } = {}): Promise<PageStructure> {
  const styles = deps.styles ?? [];
  const dom = await measureHtml(wrapForExtraction(html, randomUUID().replace(/-/g, ''), styles), deps);
  return parseStructure(dom, url, `sha256:${createHash('sha256').update(html).digest('hex')}`, styles.length > 0);
}

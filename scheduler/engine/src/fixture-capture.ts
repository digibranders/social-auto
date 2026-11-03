/**
 * Saves a site's homepage as a test fixture for page ranking. Only sites on the approved list can be saved (the list is a file in the
 * repository, written by the person who owns them), so this can never be pointed at an arbitrary site. It reads the way the engine does:
 * honest user agent, robots.txt respected, public addresses only.
 *
 *   node src/fixture-capture.ts --site fynix.digital --name fynix
 *
 * It writes src/fixtures/sites/<name>/home.html and source.json. The expect.json is written by hand from what the business really offers.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { htmlToText, renderWithChrome } from './crawl.ts';
import { parseRobots, robotsAllows, safeFetch, type FetchedPage } from './safe-fetch.ts';

export interface ApprovedSites {
  approvedBy: string;
  hosts: string[];
}

export class FixtureNotApprovedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FixtureNotApprovedError';
  }
}

const bare = (host: string): string => host.toLowerCase().replace(/^www\./, '');

/** The address, if its host is exactly an approved one (a leading www is fine). Anything else, however it is spelt, is refused. */
export function assertApproved(site: string, approved: ApprovedSites): URL {
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(site) ? site : `https://${site}`);
  } catch {
    throw new FixtureNotApprovedError(`"${site}" is not a web address`);
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new FixtureNotApprovedError(`${site} is not a plain web address`);
  if (!approved.hosts.some((host) => bare(host) === bare(url.hostname))) {
    throw new FixtureNotApprovedError(`${url.hostname} is not on the approved list (src/fixtures/approved-sites.json); only the owner may add a site`);
  }
  return url;
}

/** The page without what ranking never reads: scripts, styles, comments, inline pictures and graphics. Links, language and headings stay. */
export function tidyHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<svg\b([^>]*)>[\s\S]*?<\/svg>/gi, '<svg$1></svg>')
    .replace(/(\s(?:src|href|srcset|poster)=["'])data:[^"']*/gi, '$1data:')
    .replace(/\s+/g, ' ')
    .trim();
}

const SAFE_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;
const THIN_CHARS = 300;
const MIN_LINKS = 3;

export interface CaptureOptions {
  site: string;
  name: string;
  /** The folder that holds one folder per site (src/fixtures/sites). */
  dir: string;
  approved: ApprovedSites;
  fetchPage?: (url: string) => Promise<FetchedPage>;
  render?: (url: string) => Promise<string>;
  now?: Date;
}

export async function captureFixture(options: CaptureOptions): Promise<{ folder: string; rendered: boolean }> {
  const start = assertApproved(options.site, options.approved);
  if (!SAFE_NAME.test(options.name)) throw new Error(`The fixture name "${options.name}" must be lowercase letters, digits and dashes`);
  const fetchPage = options.fetchPage ?? ((url: string) => safeFetch(url));
  const render = options.render ?? ((url: string) => renderWithChrome(url));

  const robots = await fetchPage(new URL('/robots.txt', start).href).then((page) => parseRobots(page.body)).catch(() => []);
  if (!robotsAllows(robots, start.pathname || '/')) throw new Error(`${start.hostname} asks automated readers not to read it (robots.txt)`);

  const home = await fetchPage(start.href);
  if (!home.type.includes('html')) throw new Error(`${start.href} is not a web page`);
  const linkCount = [...home.body.matchAll(/<a\b[^>]*\shref=/gi)].length;
  let body = home.body;
  let rendered = false;
  if (htmlToText(body).length < THIN_CHARS || linkCount < MIN_LINKS) {
    const built = await render(home.finalUrl).catch(() => null);
    if (built && [...built.matchAll(/<a\b[^>]*\shref=/gi)].length > linkCount) {
      body = built;
      rendered = true;
    }
  }

  const folder = join(options.dir, options.name);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'home.html'), `${tidyHtml(body)}\n`);
  const source = { url: home.finalUrl, rendered, capturedAt: (options.now ?? new Date()).toISOString(), approvedBy: options.approved.approvedBy };
  await writeFile(join(folder, 'source.json'), `${JSON.stringify(source, null, 2)}\n`);
  return { folder, rendered };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { site: { type: 'string' }, name: { type: 'string' } } });
  if (!values.site || !values.name) throw new Error('Usage: node src/fixture-capture.ts --site <address> --name <folder>');
  const here = dirname(fileURLToPath(import.meta.url));
  const approved = JSON.parse(await readFile(join(here, 'fixtures', 'approved-sites.json'), 'utf8')) as ApprovedSites;
  const { folder, rendered } = await captureFixture({ site: values.site, name: values.name, dir: join(here, 'fixtures', 'sites'), approved });
  console.log(`Saved ${folder}${rendered ? ' (as the browser builds it)' : ''}. Now write its expect.json by hand.`);
}

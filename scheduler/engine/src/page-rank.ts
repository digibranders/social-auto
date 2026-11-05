/**
 * The page-ranking interface that `page-rank.test.ts` was written against: link information in, decisions out. It is a thin layer over
 * the one implementation in pages.ts, so there is a single set of ranking rules to test and to configure.
 */
import { extractLinkInfo, rankLinks, type PageDecision, type PageInfo, type RankingConfig, type LinkInfo } from './pages.ts';

export { extractLinkInfo };
export type { LinkInfo, PageDecision, PageInfo };

export interface RankPageOptions {
  limit: number;
  /** False for an address the site's robots.txt asks readers to skip. */
  robotsAllows?: (pathname: string) => boolean;
  config?: Partial<RankingConfig>;
}

export function rankPages(info: PageInfo, base: URL, options: RankPageOptions): PageDecision[] {
  return rankLinks(info, base, options.limit, { ...(options.robotsAllows ? { allowed: options.robotsAllows } : {}), ...(options.config ? { config: options.config } : {}) });
}

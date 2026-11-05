/**
 * Proof-claim hold. A sentence on a site is evidence that the company made the claim, not proof that the claim is true, so the claims that
 * persuade by asserting proof (traction numbers, certifications, performance figures, customer results, guarantees, superlatives, awards,
 * comparisons with rivals, and offers that may have expired) are never used by the automatic flow. Facts about what a product does are.
 *
 * Three outcomes:
 *   ALLOW            an operational fact, or a price or offer that is current and fully qualified;
 *   ATTRIBUTED_ONLY  a short customer quote with a named source and no outcome claim: usable only while the attribution is shown;
 *   HOLD             not used by the automatic flow. An owner approving it later does not make it verified.
 *
 * The rules are patterns over the meaning of the sentence (a figure next to a kind of thing, an assertion next to a credential), not
 * brand words, and every list is a setting so nothing here belongs to an industry. A sentence that explains or teaches about a topic
 * ("our guide explains SOC 2 reports") is not a claim about the company. Deterministic rules decide the clear cases; a semantic judge may
 * only make the result stricter, never release a hold (see `strictest`).
 */

export type ProofDecision = 'ALLOW' | 'ATTRIBUTED_ONLY' | 'HOLD';

export type ProofHoldCode =
  | 'HOLD_PROOF_STATISTIC'
  | 'HOLD_RATING'
  | 'HOLD_CREDENTIAL'
  | 'HOLD_PERFORMANCE'
  | 'HOLD_CUSTOMER_RESULT'
  | 'HOLD_GUARANTEE'
  | 'HOLD_SUPERLATIVE'
  | 'HOLD_AWARD'
  | 'HOLD_COMPETITOR_COMPARISON'
  | 'HOLD_PRICE_QUALIFIER'
  | 'HOLD_STALE_OFFER'
  | 'HOLD_ELIGIBILITY';

export interface ProofAssessment {
  decision: ProofDecision;
  code?: ProofHoldCode;
  reason: string;
}

export interface ProofConfig {
  /** Things a company counts to show traction. */
  tractionNouns: readonly string[];
  /** Words that lead a traction figure ("trusted by 500 ..."). */
  tractionLeads: readonly string[];
  /** Past participles that make a counted thing an achievement ("500 tasks completed"). */
  achievementVerbs: readonly string[];
  /** Vague counts that are traction in all but number. */
  vagueCounts: readonly string[];
  credentialTerms: readonly string[];
  credentialAssertions: readonly string[];
  /** Words that say a sentence teaches or points somewhere instead of claiming something. */
  educationalMarkers: readonly string[];
  improvementWords: readonly string[];
  resultVerbs: readonly string[];
  guaranteePhrases: readonly string[];
  superlativePhrases: readonly string[];
  /** Words after "best" that make it an adverb or a noun, not a superlative claim. */
  bestNotSuperlative: readonly string[];
  awardPhrases: readonly string[];
  /** Words that make an offer depend on the day. */
  timeBoundWords: readonly string[];
  /** The oldest a page may be for a price or an offer to be used. */
  maxOfferAgeDays: number;
  /** Words in the surrounding text that restrict who a "free" offer is for. */
  eligibilityWords: readonly string[];
  annualBillingWords: readonly string[];
}

export const defaultProofConfig: ProofConfig = {
  tractionNouns: ['customers', 'clients', 'agencies', 'businesses', 'brands', 'companies', 'teams', 'users', 'organizations', 'organisations', 'enterprises', 'startups', 'merchants', 'stores', 'sellers', 'professionals', 'marketers', 'developers', 'members', 'subscribers', 'people', 'websites', 'sites', 'projects', 'tasks', 'transactions', 'orders', 'downloads', 'installs', 'installations', 'reviews', 'ratings', 'sales', 'campaigns', 'conversations', 'messages', 'leads', 'tickets', 'bookings'],
  tractionLeads: ['trusted by', 'used by', 'loved by', 'chosen by', 'relied on by', 'join', 'joined by', 'over', 'more than', 'serving', 'served', 'helped', 'helping', 'powering', 'powers', 'across'],
  achievementVerbs: ['completed', 'delivered', 'served', 'built', 'launched', 'processed', 'handled', 'managed', 'sent', 'created', 'resolved', 'booked', 'sold', 'installed', 'shipped'],
  vagueCounts: ['thousands of', 'hundreds of', 'millions of', 'tens of thousands of', 'countless', 'dozens of'],
  credentialTerms: ['soc 2', 'soc2', 'soc 1', 'iso 27001', 'iso27001', 'iso 9001', 'iso 27701', 'iso 22301', 'hipaa', 'pci dss', 'pci-dss', 'pci', 'gdpr', 'ccpa', 'fedramp', 'nist', 'cmmc'],
  credentialAssertions: ['certified', 'certification', 'compliant', 'compliance', 'accredited', 'attested', 'audited', 'approved', 'verified', 'secured by', 'type ii', 'type 2', 'ready'],
  educationalMarkers: ['guide', 'guides', 'explains', 'explain', 'learn', 'read our', 'read about', 'how to', 'what is', 'blog', 'article', 'webinar', 'ebook', 'checklist', 'explore', 'tutorial', 'overview of', 'documentation', 'practices', 'tips'],
  improvementWords: ['faster', 'quicker', 'cheaper', 'increase', 'increases', 'increased', 'reduce', 'reduces', 'reduced', 'cut', 'cuts', 'save', 'saves', 'saved', 'saving', 'savings', 'boost', 'boosts', 'grow', 'grows', 'growth', 'improve', 'improves', 'improved', 'improvement', 'lower', 'lowers', 'higher', 'more', 'less', 'roi', 'uplift', 'conversions', 'conversion', 'productivity', 'efficiency', 'accuracy', 'success rate', 'uptime', 'revenue', 'sales', 'costs', 'cost'],
  resultVerbs: ['doubled', 'tripled', 'quadrupled', 'achieved', 'achieve', 'grew', 'increased', 'boosted', 'saved', 'save', 'saves', 'reached', 'hit', 'generated', 'recovered', 'earned', 'won', 'reduced'],
  guaranteePhrases: ['guarantee', 'guaranteed', 'guarantees', 'money-back', 'money back', 'risk-free', 'risk free', 'we promise', 'no questions asked', 'or your money', 'satisfaction guaranteed', 'zero risk', 'zero downtime', 'zero security breaches', 'zero breaches'],
  superlativePhrases: ['#1', 'no. 1', 'no.1', 'number one', 'number 1', 'leading', 'top-rated', 'top rated', 'world-class', 'world class', 'best-in-class', 'best in class', 'largest', 'fastest', 'cheapest', 'most trusted', 'most popular', 'most advanced', 'most secure', 'most powerful', 'most reliable', 'unmatched', 'unbeatable', 'unrivaled', 'unrivalled', 'premier', 'ultimate'],
  bestNotSuperlative: ['practice', 'practices', 'fit', 'fits', 'suit', 'suits', 'match', 'matches', 'way', 'ways', 'time', 'effort', 'efforts', 'wishes', 'regards', 'of luck'],
  awardPhrases: ['award-winning', 'award winning', 'winner of', 'winners of', 'finalist', 'shortlisted', 'ranked', 'recognized as', 'recognized among', 'recognised as', 'recognised among', 'named a', 'named the', 'named one', 'top 10', 'top 5', 'top 20', 'hall of fame', 'voted'],
  timeBoundWords: ['today', 'now', 'limited time', 'limited-time', 'this week', 'this month', 'ends', 'until', 'expires', 'hurry', 'last chance', 'flash sale', 'black friday', 'cyber monday'],
  maxOfferAgeDays: 7,
  eligibilityWords: ['eligible', 'eligibility', 'restrictions apply', 'terms apply', 'conditions apply', 'subject to', 'qualifying', 'qualify', 'new customers only', 'selected'],
  annualBillingWords: ['billed annually', 'billed yearly', 'billed once a year', 'paid annually', 'paid yearly', 'per year', 'annual plan', 'annual billing'],
};

export interface ProofContext {
  /** Text around the sentence on its page (its card, row or heading), used to qualify prices and offers. */
  context?: string;
  /** When the page was read; a price or an offer older than the configured age is held. */
  fetchedAt?: string;
  now?: Date;
  /** True when a named customer, shown on the page, said the sentence: a testimonial. */
  attributed?: boolean;
  config?: Partial<ProofConfig>;
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const normalize = (text: string): string => text.normalize('NFKC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[‐-―−]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();

/** A phrase as a whole-word pattern; phrases that begin or end with a symbol (#1, no. 1) match without a word edge there. */
function phraseRegex(phrase: string): string {
  const body = escapeRegex(normalize(phrase));
  const start = /^[\p{L}\p{N}]/u.test(phrase) ? '(?<![\\p{L}\\p{N}])' : '';
  const end = /[\p{L}\p{N}]$/u.test(phrase) ? '(?![\\p{L}\\p{N}])' : '';
  return `${start}${body}${end}`;
}

const anyOf = (phrases: readonly string[]): RegExp => new RegExp(phrases.map(phraseRegex).join('|'), 'u');
const has = (phrases: readonly string[], text: string): boolean => phrases.length > 0 && anyOf(phrases).test(text);

const FIGURE = String.raw`(?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d+)?`;
const SCALE = String.raw`(?:\s?(?:k|m|bn|million|billion|thousand|lakh|crore))?`;

const hold = (code: ProofHoldCode, reason: string): ProofAssessment => ({ decision: 'HOLD', code, reason });
const allow = (reason: string): ProofAssessment => ({ decision: 'ALLOW', reason });

function trackRecord(t: string, c: ProofConfig): ProofAssessment | undefined {
  // Ratings: "4.9/5", "rated 4.8", "4.7 out of 5", "5 stars".
  if (new RegExp(String.raw`(?<![\p{L}\p{N}.])\d(?:\.\d)?\s*(?:/\s*(?:5|10)|out of\s*(?:5|10)|stars?)(?![\p{L}\p{N}])`, 'u').test(t) || new RegExp(String.raw`(?<![\p{L}\p{N}])rated\s+\d`, 'u').test(t)) {
    return hold('HOLD_RATING', 'an aggregate rating is a claim about customers, not a fact about the product');
  }
  const nouns = c.tractionNouns.map(escapeRegex).join('|');
  const leads = c.tractionLeads.map(escapeRegex).join('|');
  const verbs = c.achievementVerbs.map(escapeRegex).join('|');
  const vague = c.vagueCounts.map(escapeRegex).join('|');
  // "1,000+ agencies", "10k users": a figure with a plus or a scale, then a counted thing.
  if (new RegExp(String.raw`(?<![\p{L}\p{N}.])${FIGURE}(?:\s?\+|${SCALE}\s?\+?)\s*(?:[\p{L}'-]+\s+){0,2}?(?:${nouns})(?![\p{L}])`, 'u').test(t) && new RegExp(String.raw`${FIGURE}(?:\s?\+|\s?(?:k|m|bn|million|billion|thousand|lakh|crore)(?![\p{L}]))`, 'u').test(t)) {
    return hold('HOLD_PROOF_STATISTIC', 'a count of customers, users or results is a traction claim that the site makes about itself');
  }
  // "trusted by 500 teams", "over 2,000 clients": a lead word, then a figure, then a counted thing.
  if (new RegExp(String.raw`(?<![\p{L}\p{N}])(?:${leads})\s+${FIGURE}${SCALE}\s*\+?\s*(?:[\p{L}'-]+\s+){0,2}?(?:${nouns})(?![\p{L}])`, 'u').test(t)) {
    return hold('HOLD_PROOF_STATISTIC', 'a count of customers, users or results is a traction claim that the site makes about itself');
  }
  // "500,000 tasks completed": a figure, a counted thing, an achievement.
  if (new RegExp(String.raw`(?<![\p{L}\p{N}.])${FIGURE}${SCALE}\s*\+?\s*(?:[\p{L}'-]+\s+){0,2}?(?:${nouns})\s+(?:${verbs})(?![\p{L}])`, 'u').test(t)) {
    return hold('HOLD_PROOF_STATISTIC', 'a count of finished work is a traction claim that the site makes about itself');
  }
  // "trusted by thousands of agencies".
  if (new RegExp(String.raw`(?<![\p{L}\p{N}])(?:${vague})\s+(?:[\p{L}'-]+\s+){0,2}?(?:${nouns})(?![\p{L}])`, 'u').test(t)) {
    return hold('HOLD_PROOF_STATISTIC', 'a vague count of customers is still a traction claim');
  }
  return undefined;
}

function credential(t: string, c: ProofConfig): ProofAssessment | undefined {
  if (!has(c.credentialTerms, t)) return undefined;
  // A standard named in a sentence that teaches about it is not a claim about the company.
  if (has(c.educationalMarkers, t)) return undefined;
  return hold('HOLD_CREDENTIAL', 'a certification or compliance claim needs evidence that can be checked outside the site');
}

function performance(t: string, c: ProofConfig): ProofAssessment | undefined {
  const percent = new RegExp(String.raw`(?<![\p{L}\p{N}.])${FIGURE}\s?%`, 'u').test(t);
  const multiple = new RegExp(String.raw`(?<![\p{L}\p{N}.])${FIGURE}\s?x(?![\p{L}])`, 'u').test(t);
  const hasFigure = percent || multiple;
  if (!hasFigure) return undefined;
  if (has(c.improvementWords, t)) return hold('HOLD_PERFORMANCE', 'a claimed improvement, saving or benchmark figure is a result the site cannot prove by stating it');
  return undefined;
}

function customerResult(t: string, c: ProofConfig, ctx: ProofContext): ProofAssessment | undefined {
  const subject = /(?<![\p{L}\p{N}])(?:customers?|clients?|businesses|brands|users|teams|companies|agencies|merchants|stores|sellers)(?![\p{L}])/u.test(t);
  if (!subject) return undefined;
  const verbs = c.resultVerbs.map(escapeRegex).join('|');
  const outcome = new RegExp(String.raw`(?<![\p{L}\p{N}])(?:${verbs})(?![\p{L}])`, 'u').test(t) || /(?<![\p{L}\p{N}])record\s+(?:sales|revenue|profits?|growth|results?)(?![\p{L}])/u.test(t);
  if (!outcome) return undefined;
  if (ctx.attributed === true && !/\d/.test(t)) return undefined;
  return hold('HOLD_CUSTOMER_RESULT', 'what customers achieved is a result claim; it is not used unless a named customer says it and it is shown with their name');
}

function guarantee(t: string, c: ProofConfig): ProofAssessment | undefined {
  if (!has(c.guaranteePhrases, t)) return undefined;
  // "no guarantee", "not guaranteed" disclaim; they say the opposite of a promise.
  if (/(?<![\p{L}])(?:no|not|without|cannot|can't|don't|doesn't)\s+(?:\w+\s+)?guarantee/u.test(t)) return undefined;
  return hold('HOLD_GUARANTEE', 'a guarantee is a legal or commercial commitment that an automatic post must not make for the company');
}

function superlative(t: string, c: ProofConfig): ProofAssessment | undefined {
  if (has(c.educationalMarkers.filter((m) => m !== 'practices' && m !== 'tips'), t)) return undefined;
  const leadingNonClaim = /(?<![\p{L}])leading\s+(?:to|up|into|from|by|the way|edge)(?![\p{L}])/u;
  const phrases = c.superlativePhrases.filter((p) => p !== 'leading' || !leadingNonClaim.test(t));
  if (has(phrases, t)) return hold('HOLD_SUPERLATIVE', 'a claim to be the best, first or leading is a market-position claim the site cannot substantiate by stating it');
  const notAfter = c.bestNotSuperlative.map(escapeRegex).join('|');
  if (new RegExp(String.raw`(?<![\p{L}])best(?![\p{L}])(?!\s+(?:${notAfter})(?![\p{L}]))(?!-(?:${notAfter}))`, 'u').test(t.replace(/best-practices?/g, 'best practices'))) {
    return hold('HOLD_SUPERLATIVE', 'a claim to be the best is a market-position claim the site cannot substantiate by stating it');
  }
  return undefined;
}

function award(t: string, c: ProofConfig): ProofAssessment | undefined {
  if (has(c.educationalMarkers, t)) return undefined;
  if (has(c.awardPhrases, t)) return hold('HOLD_AWARD', 'an award or ranking needs evidence that can be checked outside the site');
  return undefined;
}

function comparison(t: string, c: ProofConfig): ProofAssessment | undefined {
  if (has(c.educationalMarkers, t)) return undefined;
  const comparative = String.raw`(?:(?:[\p{L}]{3,}er)|more\s+[\p{L}]+|less\s+[\p{L}]+|better|worse)`;
  if (new RegExp(String.raw`(?<![\p{L}])${comparative}\s+than(?![\p{L}])`, 'u').test(t) || /(?<![\p{L}])(?:unlike|outperforms?|beats?)\s+(?:every|any|other|all|our competitors|competitors|rivals|alternatives)/u.test(t)) {
    return hold('HOLD_COMPETITOR_COMPARISON', 'a claim of being better than other companies cannot be verified from the company\'s own site');
  }
  return undefined;
}

function commercial(raw: string, t: string, c: ProofConfig, ctx: ProofContext): ProofAssessment | undefined {
  const around = normalize(ctx.context ?? '');
  const now = ctx.now ?? new Date();
  const fetched = ctx.fetchedAt === undefined ? Number.NaN : Date.parse(ctx.fetchedAt);
  const ageDays = Number.isFinite(fetched) ? (now.getTime() - fetched) / 86_400_000 : Number.NaN;
  const price = /[$€£₹¥]\s*\d|\d\s*[$€£₹¥]|\b(?:usd|eur|gbp|inr)\b\s*\d|\d+\s*%\s*off|\b(?:free|discount|trial)\b/u.test(t);
  if (!price) return undefined;
  const timeBound = has(c.timeBoundWords, t);
  if (timeBound && (!Number.isFinite(ageDays) || ageDays > c.maxOfferAgeDays)) {
    return hold('HOLD_STALE_OFFER', Number.isFinite(ageDays) ? `an offer that depends on the day was read ${Math.round(ageDays)} days ago, longer than ${c.maxOfferAgeDays}` : 'an offer that depends on the day has no known read date');
  }
  if (Number.isFinite(ageDays) && ageDays > c.maxOfferAgeDays && /[$€£₹¥]\s*\d|\d\s*[$€£₹¥]/u.test(t)) {
    return hold('HOLD_STALE_OFFER', `the price was read ${Math.round(ageDays)} days ago, longer than ${c.maxOfferAgeDays}`);
  }
  // "Only ₹999/month" next to "billed annually": the monthly figure is a yearly commitment the sentence hides.
  if (/(?:\/|per\s+)\s*(?:month|mo)(?![\p{L}])|monthly/u.test(t) && has(c.annualBillingWords, around) && !has(['billed monthly'], t)) {
    return hold('HOLD_PRICE_QUALIFIER', 'the price is per month but the plan is billed annually, and the sentence does not say so');
  }
  if (/(?<![\p{L}])free\s+for\s+(?:everyone|all|anyone|everybody)(?![\p{L}])/u.test(t) && has(c.eligibilityWords, around)) {
    return hold('HOLD_ELIGIBILITY', 'the offer is free for everyone in the sentence but restricted by eligibility around it');
  }
  void raw;
  return allow('a price, trial or plan offer that is current and states its own qualifier');
}

/** What the rules say about one sentence. The first rule that holds decides; a held sentence carries the code of the rule. */
export function assessProofClaim(text: string, ctx: ProofContext = {}): ProofAssessment {
  const config: ProofConfig = { ...defaultProofConfig, ...ctx.config };
  const t = normalize(text);
  const rules: Array<() => ProofAssessment | undefined> = [
    () => credential(t, config),
    () => guarantee(t, config),
    () => customerResult(t, config, ctx),
    () => trackRecord(t, config),
    () => comparison(t, config),
    () => performance(t, config),
    () => superlative(t, config),
    () => award(t, config),
    () => commercial(text, t, config, ctx),
  ];
  for (const rule of rules) {
    const found = rule();
    if (found) return found;
  }
  if (ctx.attributed === true) return { decision: 'ATTRIBUTED_ONLY', reason: 'a customer quote with a named source and no outcome claim; usable only with the attribution shown' };
  return allow('no proof claim found');
}

/** True when the automatic flow may use the sentence (a hold never may; attributed quotes only with their attribution). */
export const isAutoUsable = (assessment: ProofAssessment): boolean => assessment.decision !== 'HOLD';

/**
 * Combines the verdict of the rules with a verdict from a semantic judge: the stricter one wins. A judge can add a hold the patterns missed;
 * it can never release one the patterns made.
 */
export function strictest(rules: ProofAssessment, judge: ProofAssessment | undefined): ProofAssessment {
  if (judge === undefined || rules.decision === 'HOLD') return rules;
  return judge.decision === 'HOLD' ? judge : rules;
}

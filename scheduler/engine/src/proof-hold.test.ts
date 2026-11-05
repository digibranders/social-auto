import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessProofClaim, isAutoUsable, strictest, type ProofContext, type ProofHoldCode } from './proof-hold.ts';

const NOW = new Date('2026-11-05T10:00:00Z');
const FRESH = '2026-11-04T10:00:00Z';
const OLD = '2026-10-20T10:00:00Z';

interface Case {
  text: string;
  code?: ProofHoldCode;
  ctx?: ProofContext;
}

const base: ProofContext = { now: NOW, fetchedAt: FRESH };
const withCtx = (extra: ProofContext = {}): ProofContext => ({ ...base, ...extra });

const MUST_HOLD: Record<string, Case[]> = {
  'statistics, counts and ratings': [
    { text: 'Trusted by 1,000+ agencies', code: 'HOLD_PROOF_STATISTIC' },
    { text: '500,000 tasks completed', code: 'HOLD_PROOF_STATISTIC' },
    { text: 'Rated 4.9/5 by customers', code: 'HOLD_RATING' },
  ],
  'certifications and compliance': [
    { text: 'SOC 2 certified', code: 'HOLD_CREDENTIAL' },
    { text: 'ISO 27001 compliant', code: 'HOLD_CREDENTIAL' },
    { text: 'Fully GDPR and HIPAA compliant', code: 'HOLD_CREDENTIAL' },
  ],
  'performance statistics': [
    { text: '30% faster project delivery', code: 'HOLD_PERFORMANCE' },
    { text: 'Cuts operating costs by 40%', code: 'HOLD_PERFORMANCE' },
    { text: 'Increases conversions by 25%', code: 'HOLD_PERFORMANCE' },
  ],
  'customer results': [
    { text: 'Customer doubled revenue', code: 'HOLD_CUSTOMER_RESULT' },
    { text: 'Clients save 10 hours weekly', code: 'HOLD_CUSTOMER_RESULT' },
    { text: 'Businesses achieved record sales using us', code: 'HOLD_CUSTOMER_RESULT' },
  ],
  'guarantees and promises': [
    { text: 'Guaranteed 100% uptime', code: 'HOLD_GUARANTEE' },
    { text: 'Double your sales or your money back', code: 'HOLD_GUARANTEE' },
    { text: 'We guarantee zero security breaches', code: 'HOLD_GUARANTEE' },
  ],
  superlatives: [
    { text: "India's #1 agency", code: 'HOLD_SUPERLATIVE' },
    { text: 'The best CRM software', code: 'HOLD_SUPERLATIVE' },
    { text: "The industry's leading platform", code: 'HOLD_SUPERLATIVE' },
  ],
  'awards and recognition': [
    { text: 'Award-winning agency', code: 'HOLD_AWARD' },
    { text: 'Winner of the National Design Award', code: 'HOLD_AWARD' },
    { text: 'Recognized among the top 10 providers', code: 'HOLD_AWARD' },
  ],
  'competitor comparisons': [
    { text: 'Faster than Competitor X', code: 'HOLD_COMPETITOR_COMPARISON' },
    { text: '50% cheaper than other providers', code: 'HOLD_COMPETITOR_COMPARISON' },
    { text: 'More secure than every alternative', code: 'HOLD_COMPETITOR_COMPARISON' },
  ],
  'prices and offers that are not current or not fully qualified': [
    { text: 'Only ₹999/month', code: 'HOLD_PRICE_QUALIFIER', ctx: withCtx({ context: 'Pro plan, billed annually' }) },
    { text: 'Free for everyone', code: 'HOLD_ELIGIBILITY', ctx: withCtx({ context: 'Free plan. Eligibility restrictions apply.' }) },
    { text: '50% off today', code: 'HOLD_STALE_OFFER', ctx: withCtx({ fetchedAt: OLD }) },
  ],
};

const MUST_PASS: Record<string, Case[]> = {
  'ordinary quantities': [
    { text: 'Includes three permission levels' },
    { text: 'Book a 15-minute consultation' },
    { text: 'Supports five file formats' },
  ],
  'credentials named without a claim': [
    { text: 'Exports audit logs' },
    { text: 'Our guide explains SOC 2 reports' },
    { text: 'Provides configurable data-retention settings' },
  ],
  'percentages that describe the product': [
    { text: 'Displays task completion percentages' },
    { text: 'Exports performance reports' },
    { text: 'Tracks project progress in real time' },
  ],
  'attributed testimonials': [
    { text: 'Setup was straightforward', ctx: withCtx({ attributed: true }) },
    { text: 'The team was responsive', ctx: withCtx({ attributed: true }) },
    { text: 'The dashboard is easy to navigate', ctx: withCtx({ attributed: true }) },
  ],
  'policy pointers': [
    { text: 'View our refund policy' },
    { text: 'Contact support about warranty terms' },
    { text: 'Service-level terms are available on request' },
  ],
  'best as an adverb or in a guide': [
    { text: 'Read our SEO best-practices guide' },
    { text: 'Find the option that best fits your needs' },
    { text: 'Explore common website-design practices' },
  ],
  'awards as a topic': [
    { text: 'Read our guide to design awards' },
    { text: 'Explore award submission requirements' },
    { text: 'We developed a website for an awards event' },
  ],
  'comparisons that are not claims': [
    { text: 'Compare our Basic and Pro plans' },
    { text: 'Our plans have different storage limits' },
    { text: 'This guide explains paid versus organic search' },
  ],
  'current, qualified prices': [
    { text: 'Starter: ₹999/month, billed monthly', ctx: withCtx({ context: 'Starter plan' }) },
    { text: '14-day trial on eligible plans', ctx: withCtx() },
    { text: 'Free plan includes one workspace', ctx: withCtx() },
  ],
};

for (const [group, cases] of Object.entries(MUST_HOLD)) {
  test(`held: ${group}`, () => {
    for (const { text, code, ctx } of cases) {
      const found = assessProofClaim(text, ctx ?? base);
      assert.equal(found.decision, 'HOLD', `"${text}" should be held, got ${found.decision} (${found.reason})`);
      assert.equal(found.code, code, `"${text}" should be held as ${code}, got ${found.code}`);
      assert.equal(isAutoUsable(found), false);
    }
  });
}

for (const [group, cases] of Object.entries(MUST_PASS)) {
  test(`eligible: ${group}`, () => {
    for (const { text, ctx } of cases) {
      const found = assessProofClaim(text, ctx ?? base);
      assert.notEqual(found.decision, 'HOLD', `"${text}" should stay eligible, but was held as ${found.code}: ${found.reason}`);
      assert.equal(isAutoUsable(found), true);
    }
  });
}

test('every fixture is covered: 27 held and 27 eligible', () => {
  assert.equal(Object.values(MUST_HOLD).flat().length, 27);
  assert.equal(Object.values(MUST_PASS).flat().length, 27);
});

test('an attributed quote is usable only with its attribution, and an outcome inside it is still held', () => {
  const quote = assessProofClaim('Setup was straightforward', withCtx({ attributed: true }));
  assert.equal(quote.decision, 'ATTRIBUTED_ONLY');
  const outcome = assessProofClaim('We saved 10 hours every week as a customer', withCtx({ attributed: true }));
  assert.equal(outcome.decision, 'HOLD');
});

test('wording changes do not release a held claim: vague counts, case and spacing', () => {
  assert.equal(assessProofClaim('TRUSTED   BY thousands of agencies worldwide', base).decision, 'HOLD');
  assert.equal(assessProofClaim('Over 10k users', base).decision, 'HOLD');
  assert.equal(assessProofClaim('SOC2 compliant', base).decision, 'HOLD');
  assert.equal(assessProofClaim('#1 rated by clients', base).decision, 'HOLD');
});

test('a plan allowance or a feature quantity is not traction', () => {
  for (const text of ['Up to 10 projects per workspace', 'Create 25 tasks in the free plan', 'Add 3 team members', 'Connects to over a dozen apps']) {
    assert.notEqual(assessProofClaim(text, base).decision, 'HOLD', text);
  }
});

test('a disclaimer of a guarantee is not a guarantee', () => {
  assert.notEqual(assessProofClaim('Results are not guaranteed', base).decision, 'HOLD');
});

test('a price read too long ago is held, and one read today is not', () => {
  assert.equal(assessProofClaim('Starter: $29/month, billed monthly', withCtx({ fetchedAt: OLD })).code, 'HOLD_STALE_OFFER');
  assert.equal(assessProofClaim('Starter: $29/month, billed monthly', withCtx()).decision, 'ALLOW');
});

test('a judge can only make the result stricter, never release a hold', () => {
  const held = assessProofClaim('SOC 2 certified', base);
  const released = strictest(held, { decision: 'ALLOW', reason: 'judge says fine' });
  assert.equal(released.decision, 'HOLD');
  const clear = assessProofClaim('Exports audit logs', base);
  const tightened = strictest(clear, { decision: 'HOLD', code: 'HOLD_PERFORMANCE', reason: 'judge saw a claim' });
  assert.equal(tightened.decision, 'HOLD');
});

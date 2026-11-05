# Evidence audit: oyechats.com (4 Nov 2026)

Question: why could the engine only write about two facts when the site says far more?
Method: read `brands/oyechats/{brand,evidence,pages}.json` as saved by the profile run, re-crawled the same 10 pages with the engine's own crawler (no model call, no spend), and compared what the site states with what the planner was allowed to use.

## Result in one paragraph

The profile run proposed 7 claims. **All 7 had a verbatim quote that really is on the cited page, and all 7 are faithful to it.** Only 2 became usable proof points. The other 5 were marked "uncertain" by one rule: the model's wording shares too few words with the quote (0%, 25%, 25%, 33%, 33% of the longer words). So the verifier discarded 5 true, sourced facts because they were paraphrased, not because they were doubtful. Separately, no commercial fact (free plan terms, prices, trial, GST) was ever proposed as a claim, so the planner had no evidence for the numbers the brand's own rules told it to keep.

## What the planner could use vs what the site says

| Fact (exact words on the page) | Page | In profile |
|---|---|---|
| "hybrid ... grounded answers retrieved from your own content" | /features | verified proof point |
| "One script tag installs everywhere." | /integrations | verified proof point |
| "No credit card · Free plan forever · One script tag" | / | uncertain (paraphrase) |
| "OyeChats scores each conversation on Budget, Authority, Need, and Timeline, read from the chat itself, so visitors never fill out a form." | / | uncertain (paraphrase) |
| "hands the chat to an operator in the same thread, with the full transcript and score already in hand." | / | uncertain (paraphrase) |
| "A grounded AI bot, free forever." / "1 chatbot  100 credits / month" | /pricing | uncertain (0% overlap) |
| "Each study opens with its results and shows the funnel that produced them." | /case-studies | uncertain (paraphrase) |
| "14-day free trial on every plan · No credit card required" | /pricing | not a claim; only in the unverified `offer` text |
| Starter ₹ 599 /mo, Standard ₹ 1,199 /mo, Professional ₹ 2,999 /mo, Enterprise ₹ 5,999 /mo | /pricing | not a claim; only in `offer` |
| "Prices exclude GST. 18% GST is added at checkout ..." | /pricing | not a claim; only in `offer` and `rules` |
| Standard plan includes "BANT lead qualification & scoring" | /pricing | not a claim |
| "BANT, MEDDIC, CHAMP or GPCTBA scoring from the conversation itself." | /docs | not a claim |
| "Pick from five event types: tier_transition, lead_captured, handoff_requested, meeting_booked, chat_closed." / HMAC-signed webhooks | /integrations | not a claim |
| "Crawl your website or upload PDFs, DOCX, TXT and Markdown." | /docs | not a claim |
| One published study: 18,742 conversations handled, 1,146 potential B2B leads identified, 241 quotations shared | /case-studies | not a claim (needs attribution and context) |

## Things on the pages that must NOT become claims

- Product-demo mockups: "87 BANT", "84 BANT Composite BANT Score Budget 85 ...", "indexed 1,247 passages" are example values in the page's illustrations.
- "99.9% Uptime target": a target, not a guarantee. The word "target" must travel with the number.
- Setup time is stated three ways ("< 10 min", "5 min From signup to live bot", "under 10 minutes"). A post may use one only with its qualifier, or none.
- Plan feature lists contain numbers (credits, seats, history days) that are facts only for the named plan.

## Root causes (in the code)

1. **Lexical overlap is the only paraphrase test.** `verifyClaim` downgrades a claim to "uncertain" when under about half of its longer words appear in the quote. A faithful paraphrase scores low; it cannot tell paraphrase from distortion. Semantic comparison needs an approved model review, which has not been built.
2. **Commercial facts are never proposed.** The profile prompt asks the model for "5-8 factual selling points". Pricing, trial and tax terms end up in the free-text `offer` and `rules`, which nothing verifies.
3. **The claim gate only knows `proofPoints`.** So `rules` such as "Keep the GST note with pricing: 18% GST is added at checkout" push the writer towards figures the gate then rejects. This is what failed the two earlier oyechats plans.
4. **Fact types are mixed.** Product capabilities, commercial terms and measured results are all "proof points", though they need different evidence and different wording rules.
5. **The crawl keeps 3,000 characters per page, navigation included.** /pricing, /features, /solutions and /docs hit the cap; the repeated site menu uses part of it, and /solutions yields almost no usable text. 13 pages (blog, security, legal, changelog) are skipped by policy.

## Recommended fixes, in order

1. **Quote-as-fact.** A verbatim quote found on the page is verified by construction. Offer the quote itself (not the model's paraphrase) to the planner and the claim gate as a "quoted fact" with its URL. This needs no model and removes the paraphrase risk. Keep numbers, prices, periods and qualifiers exactly as quoted.
2. **Commercial facts, extracted by code.** Sentences on pricing-type pages that state prices, trials, billing periods or taxes become claims with their sentence as the quote, flagged for owner review the first time.
3. **Fact categories with usage rules**: product capability, commercial term, performance result, and "ignore" (mockups, targets without qualifiers, conflicting values).
4. **Crawl:** strip repeated navigation and raise or paginate the cap for pages that hit it.
5. **`rules` and `offer` must not carry figures** the claim gate will not allow; generate them from the evidence set instead.

## Not checked

This audit did not run a model, did not check pages the crawler skipped, and cannot judge truth beyond what the pages say. Page content may change after 4 Nov 2026.

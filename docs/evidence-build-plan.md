# Evidence and editorial build plan (steps 1 to 5)

Status: agreed design, nothing built yet (4 Nov 2026). Sources: `docs/evidence-audit-oyechats.md`, ChatGPT's improvement plan and its rebuttal of my lean version (same session). Where I changed ChatGPT's proposal, and where it changed mine, is marked.

## Principles
- Quote-as-fact: the verbatim text on the page is the usable wording. No paraphrase is trusted as evidence.
- Association by position is evidence, not proof: every context link carries `associationStatus: confirmed | inferred | unknown`. Only confirmed links are used automatically; the rest are `needs_review`.
- Conservative classification: `needs_review`, never silent rejection or silent acceptance. Report both precision (usable facts that are correct) and recall (real facts recovered) on fixtures.
- Honest limits: the engine checks numbers, prices, periods, qualifiers, source and intent. It does not prove that prose means what the source means. Reports say `source_quote_verified`, `numeric_claim_checked`, `semantic_support_unverified`; the third is never shown as "verified".

## Step 1. Fixtures and baseline
- Synthetic site fixtures (no real client): nav chrome repeated on every page; pricing as div cards AND as a real table; three plans with different prices and trial terms; one shared GST footnote; a demo dashboard ("87 leads"); a legitimate three-metric stat strip; "99.9% uptime target"; "up to 50 users"; "No credit card required"; "Free forever"; conflicting-looking setup times ("under 10 minutes" vs "5 minutes", which are NOT a conflict) and a true conflict; a customer case study; a sentence with two number-bearing claims; a non-English block.
- The two failing oyechats posters become regression cases for later steps (plug for "one script tag", booklet for "free plan").

## Step 2. Evidence facts (`evidence.ts`) and Chrome DOM extraction
- `EvidenceFact`: id, category (identity, capability, process, offer, commercial_term, outcome, credential, testimonial, educational), text (verbatim), scope?, qualifiers, source {url, contentHash, quote, context, heading, regionType prose|table|list|ui, pageRole}, associationStatus, attribution, intent, values (existing `extractFacts`), language support per block, status (usable | needs_review), reasonCodes, capturedAt.
- Extraction runs inside headless Chrome with an in-page script (same pattern as `measure-script.ts`) for evidence-relevant pages (pricing, features, docs, case studies). It emits blocks with visible text, nearest heading, ancestors, table row/column labels, repeated-card grouping and block ids. No regex HTML parser. If Chrome fails, flat-text facts are all `needs_review`. The stored snapshot is kept for quote checks; excluded content is recorded.
- Repeated navigation is removed from extraction candidates only, never from the stored source. Page cap is replaced by bounded extraction per region.
- Short fragments ("Free forever", "No credit card required", "24/7 support") are kept. "Up to" is a qualifier, not a hypothetical. Target, goal, projected, expected, sample, demo, mock become `needs_review`. Stat strips and demo numbers are `needs_review`, never automatic rejection. Customer results are attributed to the customer and `needs_review` until attribution is handled in copy.
- A sentence with more than one number-bearing claim is kept whole with all conditions or marked `needs_review` ("multi_claim"); it is never partially used.
- Language is judged per block; non-supported blocks stay available for manual review.

## Step 3. Commercial terms and the (not live) verifier
- Commercial terms derived from facts: plan, price, currency, period, trial, tax, discount, guarantee, with scope from table headers or confirmed card grouping. "Free plan" and "free trial" are separate terms. A tax note attaches only to the scope it is confirmed for (e.g. one shared footnote may cover all plans only if the DOM confirms it).
- Conflicts are range-aware: "under 10 min" and "5 min" do not conflict; "up to 50" and "20" do not conflict. Conflict needs matching subject, metric, scope and timeframe, incompatible values, and the same intent. Otherwise `needs_review`.
- Freshness: store capturedAt and contentHash; commercial facts older than a configurable validity are not treated as current.
- Semantic verifier: a pure layer with an injected judge, a versioned cache keyed by tenant + source hash + claim hash + context + verifier version, mocked tests. No live call in this round.

## Step 4. Planner and claim gate
- Code assigns 1 to 2 usable facts to each post slot (like pillar and hook): category matched to pillar, per-tenant cooldown on recently used facts (a cooldown, not a ban, because narrow brands may have only a few facts), concept history from step 1.4 stays authoritative.
- The planner prompt no longer contains the brand's free-text `offer` or `rules` for art-mode plans, and no other unverified brand context (audit every field reaching the planner, including summaries and earlier plan text). The model is told to write only from the assigned facts, and the facts are given per field where the planner can support it.
- Gate: every number, price, period and qualifier in the copy must appear in the assigned facts with its qualifiers; a fact that is `needs_review` can never be cited. The existing lexical anchor stays as a heuristic and is reported as `semantic_support_unverified`. Failure feedback to the model is specific; a post that still fails on the last attempt is dropped. Legacy brands without facts behave exactly as today and are labelled "legacy evidence coverage".

## Step 5. Editorial checks (`editorial.ts`)
- Hard (sent back to the model with the reason): exact normalized restatement of the headline or identity line in the subline; near-identical wording that adds no additional supported information.
- Warnings only: high overlap with uncertain extra meaning, repeated brand name without new information, CTA mismatch (CTA selection among destinations is deferred because the profile stores one verified CTA), headline strength (never scored by code).
- A similar-vocabulary subline that adds a new fact or qualification is allowed ("Free plan. No credit card required." after "Start with a free plan").

## Disagreements recorded
- ChatGPT first proposed per-field model citations; I proposed code-assigned facts; it agreed, adding the per-field allowed-facts variant if the planner can take it without restructuring. v1 checks numbers across the whole copy against the assigned facts and says so.
- ChatGPT proposed a regex-free but heavier structured schema; we cut subject/predicate/object, ontology, decomposition, multilingual classifiers.
- ChatGPT corrected my conflict example ("<10 min" vs "5 min" is not a conflict) and my subline rule (two new stems was dropped).
- Open risk neither of us can remove: wording that is stronger than its source ("installation uses one script tag" becoming "no technical setup required") passes a number gate. It needs the semantic verifier or approved-wording lists later.

## Acceptance tests that must exist before this ships
Correct plan, price, trial and tax association on the div-card and table fixtures with zero wrong associations; precision and recall reported on fixtures; demo and target numbers never usable; "up to" kept as a qualifier; fragments kept; true conflicts flagged and false ones not; multi-claim sentences not partially used; mixed-language blocks handled per block; planner never sees unverified offer or rules text in art mode; a post citing a `needs_review` fact is rejected; legacy brands unchanged; both oyechats posters reproduced as regression cases.

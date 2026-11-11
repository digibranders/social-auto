# Carousel Generation (Plan 2 of 5)

> **For agentic workers:** execute task by task, tests first, small commits.

**Goal:** From a client's verified facts, produce one carousel: 3 to 5 slides in one shared look, each slide drawn and checked by the existing poster pipeline, brand name and web address only on the last slide. Engine only; nothing is stored in review or posted yet (Plans 3 and 4).

**Architecture:** One new file, `scheduler/engine/src/carousel.ts`, with four small parts. (1) `parseCarouselDraft` validates what the model proposes. (2) `planCarousel` asks the model for one topic, one shared style, one shared typography and the slides, using `chatJson`. (3) `slidePosts` and `slideConcepts` turn a draft into `PlannedPost`s (sign-off switched off on slides 1 to n-1 with empty strings) and into the creative-director result the pipeline already accepts through `deps.direct`, so every slide gets the same style and typography text. (4) `makeCarouselSlides` runs `makeCreatives` on the slides and answers `ready` only when every slide was accepted (a carousel is all or nothing). Slides reuse the whole poster pipeline: text contract, two readings, third reading, real-logo placement, cost caps.

**Proven by the one-day proof (PR 78):** one shared style spec passed as each slide's concept through `deps.direct` made five slides read as one set, about 1.8 cents a slide. The model does not draw a progress bar reliably, so a bar is not asked for here (any bar is added by code in a later plan).

**Rules:** each slide headline goes through the existing claim gate (`checkCopy`) against only the facts that slide names; a slide that names a fact the brand does not have is refused; headlines at most 60 characters and no two slides alike; hook first, closing last; 3 to 5 slides.

## Tasks

1. `parseCarouselDraft` and the claim check on each slide (pure, tests: bad counts, wrong order of roles, unknown fact id, unsupported claim, duplicate headline, too-long headline, missing style).
2. `planCarousel` (model call, tests with a stub fetch: asks once more on a bad answer, returns a checked draft).
3. `slidePosts` and `slideConcepts` (pure, tests: sign-off empty on all but the last, ids and dates, same style text on every slide, scene differs per slide).
4. `makeCarouselSlides` (tests with the pipeline's own stubs `deps.scene`/`deps.review`: all accepted gives `ready`, one rejected gives not ready with the reason, budget stop passes through).
5. Whole engine suite, typecheck, PR.

## Out of scope (later plans)

Storing slides as a group in the review store (3), the weekly option and scheduling (4), the progress bar, per-channel captions for a carousel (3, using the existing caption writer on the carousel topic).

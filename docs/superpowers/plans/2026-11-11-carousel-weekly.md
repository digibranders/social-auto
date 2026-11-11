# Weekly Carousel in a Client's Posting Plan (Plan 4b of 5)

**Goal:** A client's posting plan can include "a weekly carousel": each week of the plan, one of its posting days is a carousel instead of a single poster. The campaign runner makes the carousels ahead of their days, they wait in Review for approval, and the weekly limit counts each as one post.

**Rules (decided with the owner):** the carousel replaces one of the week's posts, never adds one; it counts as one post against the channel's weekly limit; a carousel not approved by its day is not posted; Google Business gets the first slide as a single post.

**Design:**
- `PostingPlan.carousel: true`. The carousel takes the LAST posting weekday of the pattern (Mon..Sun order), every week it occurs. Choosing a whole weekday keeps the single posters' pattern a plain weekday pattern, so the autopilot (which picks "the first N days matching these weekdays") still lands exactly on the single days. A plan needs more than one day and at least two posting days a week, so the carousel never takes the only post of a week.
- `planDates` stays every posting day, so the weekly limit and the post count already count a carousel as one post and nothing changes there. `planSingleDates` and `planCarouselDates` split it. Batches of single posters are made from `planSingleDates`; each carousel date becomes its own batch (`kind: 'carousel'`) run with `carousel-cli.ts` for that day, so its plan file is tied to the plan's platforms like any other batch.
- The plan is checked the same way in the three places that read a plan: the engine (`posting-plan.ts`), the publisher (`clients.ts`, where it is saved) and the dashboard's own copy (`shared/posting-plan.ts`), plus a "Weekly carousel" tick in the add-client form.
- Lead-time notices already work per post id from the review queue; the carousel's captions are versions of the carousel's own post id, so a waiting carousel is reported like a waiting poster (test added).

**Not here:** the first real carousel (Plan 5), per-slide redraw.

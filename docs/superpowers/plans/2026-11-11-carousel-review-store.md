# Carousel Review Store and Export (Plan 3a of 5)

**Goal:** A carousel's slides are stored in the review store as hash-bound versions, linked as a group; one approval covers the whole group; the export gives the publisher ONE post with `images`. Engine only (review page and server are Plan 3b).

**Design:**
- A slide is an ordinary review version of its own post id (`<carousel>-s1` ... `-sN`), carrying `carousel: { id, position, count }`. Redrawing a slide is a new version of that slide, which supersedes the old one exactly as for any post.
- The carousel's captions are ordinary per-network versions of the carousel's own id, showing the cover (slide 1) picture, marked `carousel: { id, position: 0, count }`. So the existing per-network export keeps working for captions.
- `approveCarousel(id, by)` approves every slide's latest version and every network caption's latest version in one locked step, after checking all of them first: nothing is approved unless all can be. `rejectCarousel` withdraws the group the same way.
- `approvedCarousel(id)` is the only way to get the slides for posting: every slide's latest version must be approved, none missing, at least one caption approved, every picture still matching its hash. A slide redrawn after approval is pending again, so the carousel stops being postable until the group is approved again.
- Export: a post id that is a carousel is exported only through `approvedCarousel`; the cover-only fallback must never happen (a half-approved carousel posts nothing). `ExportedPost.images` lists every slide picture, `image` is the first.
- `registerCarousel` turns a ready `makeCarouselSlides` result plus the per-network captions into versions; a carousel that is not ready registers nothing.

**Tasks:** 1 version carries `carousel` (add, list, hash unaffected). 2 `carouselSlides`, `approveCarousel`, `rejectCarousel`, `approvedCarousel` with tests (all-or-nothing, redraw, tamper, rejected slide). 3 `registerCarousel`. 4 export with `images` and the never-cover-only guard. 5 suites, PR.

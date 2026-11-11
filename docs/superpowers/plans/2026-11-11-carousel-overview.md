# Weekly Carousel: Overview of the Plans

**Goal:** One carousel per channel per week, the same slides on every channel that can take one (Instagram, Facebook, LinkedIn) with a caption written for each channel; Google Business gets the first slide as a normal post. The carousel replaces one of the four weekly posts per channel and counts as one post against the weekly limit. The owner approves each carousel before it posts. Slides are 3 to 5 pictures, one shared look per carousel, no business name on any slide, the web address only on the last slide.

**Decisions already made by the owner (2026-11-11):** same slides everywhere; replaces one of the 4 weekly posts; scheduled weekly through the client's posting plan; approved in Review first; a carousel not approved by its day is not posted (the engine already leaves out posters whose day has passed).

**Proven already (PR 78):** Instagram and LinkedIn accept the calls (`createCarouselItem`, `createCarouselContainer`, `prepareCarousel`, `uploadImageUrn`, `postMultiImage`); five real slides drawn from one shared style looked like one set at about 1.8 cents a slide; the model does not draw a growing progress bar reliably (any bar is added by code).

## The five plans (each produces working, testable software on its own)

1. **Posting path** (`2026-11-11-carousel-posting-path.md`): a scheduled post can carry several pictures and is sent as a carousel to Instagram (team and customer accounts), Facebook and LinkedIn; Google keeps the cover. Publisher only. Nothing makes a carousel yet, so it is safe to ship.
2. **Generation** (engine): choose a topic from the client's verified facts, split it into 3 to 5 slides (hook, content, closing), one shared style, draw each slide with the existing poster pipeline, check each slide's text, sign-off only on the last slide, write the slides as a group.
3. **Review and export**: the review store keeps each slide as its own hash-bound version, linked by a carousel id; one approval covers the group; the Review page shows the slide strip with per-slide redraw and edit; the export gives the publisher one post with `images`.
4. **Plan and schedule**: a weekly carousel option in a client's posting plan (weekday and time), the campaign runner prepares it ahead, the weekly limit counts it as one post, the lead-time notices cover it.
5. **End to end**: a local run with fake networks from plan to post, the Facebook proof, then one real carousel on a test account with the owner's approval.

## Rules that hold for every plan

- Nothing posts to a real account without the owner's say-so; tests use stubs or fake networks.
- Each approval stays bound to exact picture hashes; a carousel is approved as a group of exact versions, never by a plan file saying so.
- Test first, small commits, full suites and typechecks before each PR, no attribution lines in commits or PRs.

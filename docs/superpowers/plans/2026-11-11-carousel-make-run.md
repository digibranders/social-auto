# Making a Carousel for a Client (Plan 4a of 5)

**Goal:** From the dashboard, the owner asks for one carousel for a client on a chosen day; the engine reads the client's verified facts, plans and draws the slides (Plan 2), writes a caption for every channel, puts the carousel into the review queue (Plan 3) and writes the plan file the export needs. The weekly repeat, the weekly post limit and the lead-time notices are Plan 4b.

**Parts:**
1. `carousel-copy.ts`: one caption per channel for the carousel. The Instagram caption is written first from the topic, the slide headlines and the verified facts, checked by the claim gate and the writing check, with a plain fallback; the other channels' captions come from the existing per-channel writer. The closing line is the brand's own, added by code.
2. `carousel-run.ts`: the whole run for one client: topic history (so a carousel is not about last week's topic), plan, captions, draw, put up for review, and write the week file (`renderMode: ai_v1`, one post: the carousel) that the export reads. Nothing is bought when there are fewer than three verified facts or no channel to write for.
3. `carousel-cli.ts` and a `carousel` job kind: the job runner starts the run like it starts a copy or a draw.
4. The review service and the dashboard accept the job, and the Review page has a "Make a carousel" control next to "Write the posts".

**Not here (4b):** repeating weekly, counting the carousel as one of the week's posts, notices.

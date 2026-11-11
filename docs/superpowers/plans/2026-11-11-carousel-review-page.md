# Carousel Review Page (Plan 3b of 5)

**Goal:** The owner sees a carousel in Review as one card, opens it to see every slide in order and each channel's caption, and approves or rejects the whole set in one step.

**Parts:** (1) review service: versions say which carousel they belong to; `GET /review/carousels/<brand>/<id>` shows a carousel whole; `POST .../approve` and `.../reject` decide it as a group (`ReviewStore.carouselStatus` says where it stands). (2) dashboard proxy: `view=carousel` and `{ carousel: { brand, id, action } }`, with the reviewer added on the server. (3) Review page: `groupCarousels` gathers slides and captions into one card with a strip of thumbnails; the opened view shows the slides side by side (scrolls sideways), the status, captions per channel, Approve / Reject / Withdraw. The Compare view lists single posters only.

**Not here:** redrawing or editing a single slide (the owner rejects the carousel with a reason; a per-slide redraw needs a drawing job for one slide and is a later step), the weekly option and scheduling (Plan 4), the end-to-end run (Plan 5).

**Verified:** typecheck, unit tests for the service routes, the proxy and the page helpers; and in the browser pane against a local review service holding a five-slide carousel with real slide pictures (card, opened view, approve, mobile width).

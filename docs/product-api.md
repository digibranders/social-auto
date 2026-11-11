# Product API

How a product (such as Brandbasket) uses social-auto. Every call is made by the product's **server** with its own key; the key must never reach a browser.

```
Authorization: Bearer <product key>
```

## Settings (social-auto)

| Where | Name | Meaning |
|---|---|---|
| publisher | `ANALYTICS_ENABLED` | on by default; `false` switches off the daily check of the networks' numbers and `GET /api/v1/analytics` (which then answers `503 SERVICE_NOT_CONFIGURED`). The daily check itself runs from `social-analytics.timer`, which has to be installed and enabled on the server |
| publisher | `PRODUCTS` | JSON list: `{id, keyHash (SHA-256 hex of the key), returnUrls[], webhookUrl?, webhookSecret? (16+ chars)}` |
| publisher + dashboard | `INVITE_SECRET` | 32+ characters, the same value in both; signs connect links |
| publisher | `DASHBOARD_ORIGIN` | the dashboard's address, where connect links point |
| publisher + dashboard | `LINKEDIN_CLIENT_ID` (+ publisher `LINKEDIN_CLIENT_SECRET`) | the LinkedIn app |
| publisher + dashboard | `FACEBOOK_APP_ID` (+ publisher `FACEBOOK_APP_SECRET`) | the Meta app, for Facebook Pages |
| publisher + dashboard | `INSTAGRAM_APP_ID` (+ publisher `INSTAGRAM_APP_SECRET`) | the Instagram app of the same Meta app (Instagram API with Instagram login). Its redirect address is the dashboard's `/api/instagram-callback` |

## Endpoints (publisher)

- `POST /api/v1/workspaces` `{externalId, name, group?}`: creates the workspace (a brand), or returns the existing one. A customer may own several brands under one login: brand 1 keeps its own id as `externalId` and is its own `group`; further brands use another `externalId` (for example `<businessId>:<brandKey>`) with `group` set to the customer's id. The group is fixed when the workspace is made: another group for an existing workspace answers `409 GROUP_MISMATCH`; a bad group `400 INVALID_GROUP`. `GET /api/v1/workspaces?group=` lists the customer's workspaces `{workspaces: [{id, externalId, name, website, archived}], brandsAllowed, brandsUsed, ceiling}` (only your product's; an unknown group is an empty list). The workspace read also has `archived` and `group: {id, brandsAllowed, brandsUsed}`. **A customer may have only as many brands as they are allowed** (1 by default; our team can allow up to 4, which is a fixed ceiling): a create beyond that answers `409 BRAND_LIMIT_REACHED` with a plain sentence ("You can have 1 brand. Ask us to allow more."). A group can also never hold more than 8 workspaces in all, archived ones included. `POST /api/v1/workspaces/archive` `{externalId, archived: true|false}` puts a brand away or brings it back: a brand put away is kept but **paused** (nothing new is sent, written or drawn: calls that write, draw or spend answer `409 WORKSPACE_ARCHIVED`; reads still work), it no longer counts toward `brandsUsed`, so it frees a slot, and bringing it back needs a free slot (`409 BRAND_LIMIT_REACHED`) and lifts only the pause that putting it away made, never one our team made. Doing either twice is safe. Our team sets the default and each customer's number in the social dashboard (Clients page, "Brands per customer"); the highest number, 4, is fixed in the code, and every change is logged with who and when. `GET ?externalId=` reads it with its channels (never tokens). The workspace and each channel carry `paused`: true when the team has paused the workspace, everything, or that account, so posts are not being sent there. It also carries, read only: `website` (the customer's website once they gave one, else null), `approvalMode` (always `manual`: the customer approves their own posters, and nothing in the API or in our dashboard can make it automatic) and `notices`, a list of `{code, channelId?, platform?, message}` in plain words for the customer: `CONNECTION_EXPIRING` (7 days or less), `CONNECTION_EXPIRED` (posts to that account are on hold until it is connected again), `ACCOUNT_DISCONNECTED` (`platform`; scheduled posts still ahead are aimed at a platform with no connected account, so they are on hold; the message says how many and that they go out once it is connected again if their time has not passed) and `PAUSED`. Posting plans cannot be added for a product's customer; their posts are made when they ask.
- `POST /api/v1/connect-link` `{externalId, channel: "linkedin" | "facebook" | "instagram" | "google", returnUrl?}`: a link (valid 1 hour) the customer opens to press Allow. `returnUrl` must be one of the product's registered `returnUrls`; the customer comes back to it with `?social=connected|denied|failed&channel=linkedin` (or `facebook`, `instagram`, `google`). A Facebook link connects every Page the customer chooses; each Page appears as its own channel id (`facebook:<page id>`). A Google link has the customer sign in with the Google account that manages their Business Profile; with one listing it is connected at once, with several a plain page asks which one is theirs (one listing per link, press it again to add another). Each appears as `google:<location id>` and is posted to as an update. Google drops hashtags and shortens text over 1500 characters, so the same caption reads a little differently there. A Google account with no listing comes back as `failed`. An Instagram link connects the customer's own Business or Creator account (no Facebook Page needed) as `instagram:<account id>`. Social-auto renews it every week, so it only ends if the customer removes the app or renewal fails, and then `connection.expiring` is sent.
- `POST /api/v1/pictures`: body is the JPG (square, 320-4096 px, up to 4 MB); answers `{pictureId}`.
- `POST /api/v1/posts` `{externalId, day: "YYYY-MM-DD", time?: "HH:MM", caption, pictureId, channels?, variants?}`: goes out that day at `time` (India time, default 10:00; a post with its own time is sent by the frequent run within about 5 minutes of it) to the chosen channel ids (default: all connected). The moment must be ahead of now and within 90 days. `variants` gives a platform its own caption or picture, see [Per-channel versions](#per-channel-versions-variants).
- `GET /api/v1/posts?externalId=[&from=YYYY-MM-DD&to=YYYY-MM-DD]`: all of the customer's posts, planned and extra, earliest first. Each has `id, date, caption, imageUrl?, manual, variants?, state` (overall) and `channels[]` (`id, platform, account, state, permalink`). `state` is one of `scheduled`, `due`, `published`, `missed`, `skipped` (the team skipped it, or its channel was paused when its time came, so it is never sent late) `paused` (held back by a pause for now) or `held` (every account or platform the post is aimed at is missing, see below; while another network is still to be sent the post stays `scheduled`, `due` or `missed` and the missing one shows only in `targets`). `from` is the first day and `to` the last day shown, in India time.
- `PATCH /api/v1/posts?externalId=&postId=` `{day?, time?, caption?, pictureId?, channels?, variants?}`: changes a post the product made (`manual: true`) while it has not gone out; anything left out stays. A scheduled post that was written and approved for the customer (not `manual`) can only be **moved**: send `day` and/or `time` (India time; without a day it stays on its day), and nothing else (`400 INVALID_REQUEST`). Its words and pictures stay, every network moves together, and the move survives the hourly release (it is kept apart from the schedule). It must still be ahead (`409 POST_NOT_EDITABLE`), the day must not already have another planned post of the customer (`409 CONFLICT`), and a time or day in the past answers `400 TIME_PASSED`/`DAY_PASSED`. Another customer's post, or one that does not exist, answers `404 POST_NOT_FOUND`. A post moved to its own planned day and time is back as planned. A moved post is sent by the frequent run at its time. Answers `{post}`.
- Each post also has `targets[]`: every account it is meant for (`id, platform, account, state, permalink`, and `code`), including accounts that were **disconnected**. A target for a disconnected account has `account: null`, `code: "ACCOUNT_DISCONNECTED"` and the state `held` while the post's time window is open (the post waits: connecting the same account again lets it go out), then `missed`. A post aimed at a whole platform (written and approved posts name the platform, for example `facebook`) gets the same kind of target when no account of that platform is connected any more: `id` is the platform name, `account: null`, `code: "ACCOUNT_DISCONNECTED"`. A post for every connected account (no accounts named) never has such a target. The `post.held` and `post.missed` events say the same (`channel` is the account id or the platform name).
- `POST /api/v1/send` `{externalId, postId}`: sends a post the product made right now (409 while it is skipped or paused), to its chosen channels, and dates it now. Answers `{post, failed, problems?}`; `failed: true` means a channel did not take it, and the post stays due for 20 hours so the next daily run tries again. `problems` lists each channel that failed as `{account, code, error}` (codes `CHANNEL_UNREACHABLE`, `RECONNECT_NEEDED`, `CHANNEL_REFUSED`; the channel's own error text is never passed on). Only the channels that failed are tried again. 409 when it has already gone out. Anyone's post that is not the product's own, and planned posts, answer 404/400.
- `DELETE /api/v1/posts?externalId=&postId=`: removes a post that has not gone out.
- `POST /api/v1/site-jobs` `{externalId, site, networks?, page?}` and `GET /api/v1/site-jobs?externalId=[&jobId=]`: read a customer's website and write posts for it, see [Writing posts from a website](#writing-posts-from-a-website-site-jobs).

- `GET|POST /api/v1/posters`: the drawn pictures the customer approves or rejects, see [Pictures to approve](#pictures-to-approve).
- `GET|POST /api/v1/facts` and `GET|POST /api/v1/batches`: the facts found on the website and the written posts, which the customer decides on before anything is drawn, see [Facts and written posts](#facts-and-written-posts).

A product only ever reaches workspaces it created. Another product's customers answer "no such workspace" (`WORKSPACE_NOT_FOUND`).

## Writing posts from a website (site jobs)

`POST /api/v1/site-jobs` `{externalId, site, networks?, page?}` starts a batch of written posts for a customer: the website is read and posts are written, with a caption for each network. **Nothing is drawn, paid for on the picture side, or published at this step.**

- `site` is the customer's website, like `acme.com` (with or without `https://`). **A customer keeps the first website they give**: a different one answers `SITE_MISMATCH`. `www.acme.com` and `acme.com` are the same website. With `page: true` only the page you give is read (for a customer's first website).
- `networks` is a list of `instagram`, `facebook`, `linkedin`, `google`. Left out, the networks the customer has connected are used; with none connected and none given the answer is `CHANNEL_NOT_CONNECTED`.
- The rhythm is fixed by social-auto: 2 posts per network per week. A product does not choose it.
- Answers `202 {job, created: true}`. If a batch is already waiting or running for the customer, that job comes back instead (`200`, `created: false`), so pressing twice never starts two.
- A customer may start 3 batches a day and 10 a month; beyond that the answer is `429 JOB_LIMIT_REACHED`. A job that is still waiting is always returned.
- `X-Social-Actor` (optional here) names the person who asked, 1 to 64 letters, digits or `. _ : -`; it is recorded with the job.

`GET /api/v1/site-jobs?externalId=` lists the customer's jobs, newest first; with `&jobId=` it answers one `{job}` (an id that is not this customer's answers `404 JOB_NOT_FOUND`). A job is `{id, kind, state, step?, createdAt, finishedAt?}`:

- `kind` is `write` (a batch of written posts), `draw` (pictures: the first draw, a redraw, or the picture of a network added later) or `network` (the words for a network added to a batch).
- `state` is `queued`, `running`, `done` or `failed`; `step` is 1 to 4 while it runs (reading the website, writing, drawing, putting the results in review).

If the poster service is not available, the answer is `503 ENGINE_UNAVAILABLE`; try again shortly.

## Facts and written posts

Both need `X-Social-Actor` (the customer's person) to **decide**; reading works without it. Nothing here is drawn or paid for.

`GET /api/v1/facts?externalId=` answers `{builtAt, profile, facts: [{id, text, sourceUrl, sourceQuote, state, held}], counts}`. `state` is `suggested`, `confirmed` or `removed`; a `held` fact cannot be confirmed. Before the website has been read the answer is `404 NOT_FOUND`.
`POST /api/v1/facts` `{externalId, factId, action}` with `action` `confirm`, `remove` or `restore` answers the facts as they are now. A held fact answers `409 FACT_HELD`.

`GET /api/v1/batches?externalId=` answers the written posts still waiting: `{expired: [{id, expiredAt}], batches: [{id, createdAt, networks, signoffDefault?, posts: [{id, headline, caption, captions, state, edited?, signoff?, advice?}]}], networkRules}`. `expired` lists written batches that were put away because nobody decided in 14 days (shown for about 2 months so the customer can be told); `captions` is the text for each network; `state` is `pending`, `kept` or `dropped`; `advice` is a short note about the post; `networkRules` gives each network's length limits.
`POST /api/v1/batches` `{externalId, batchId, action, postId?, ...}`:

- `keep` or `drop` (needs `postId`): the customer's choice for one post.
- `edit` (needs `postId`) with any of `headline`, `caption`, `network` (change that network's caption), `brandName`, `domain` (the poster sign-off; an empty text leaves that line off). The words are checked against the facts found on the customer's website: `422 WORDS_NOT_ACCEPTED` when they do not agree. **What the check covers:** numbers, prices, percentages, deadlines, superlatives and market-position claims ("number one", "best", "leading"), vague quantities and endorsements ("thousands of", "award-winning") and guarantees are accepted only when a verified fact states the same thing. Other statements are not judged: the customer is responsible for what they write and approve.
- `close`: put the whole batch away.

- `draw` (optional `retry: true`): ask for pictures for the kept posts. **This is what costs money**, so it is limited: once per batch (a second ask returns the same job, `200`, `created: false`; `retry` only after a failed one), and per customer 3 times a day and 10 a month (`429 DRAW_LIMIT_REACHED`). Keeping nothing answers `422 NOTHING_KEPT`. Answers `202 {job, created}`; the job has `kind: draw` and the `batchId`, and follows the same states as a write job (`GET /api/v1/site-jobs`). The pictures then appear in `GET /api/v1/posters`.

- `add-network` (with `network`): write the words of **one more of her connected networks** for every topic of the batch, from the same topics (no website read, no new batch). It is a **job** (the words need the AI): `202 {job, created}` with `job.kind: "network"` and the `batchId`; pressing twice while it runs answers the same job (`200`, `created: false`). Follow it in `GET /api/v1/site-jobs`: a finished job has `result: {network, topics: [{postId, outcome: "written", fallback?: true, posterIds?, drawJobId?}]}`: every topic gets words for the new network; `fallback: true` means its own words could not pass the checks, so the main words adapted to the network are used (she can change them with the words check), and `reasonCode` says why: `WORDS_REFUSED` (the facts do not support them), `TOO_LONG` (over the network's limit), `NO_FACTS` (the topic names no facts to check against) or `NO_CAPTION` (nothing could be written); `posterIds` are the new waiting pictures of that network for a topic that was already drawn (a picture of the same shape was reused); `drawJobId` is a drawing job (follow it in the same list) for a topic that needed its own picture. A failed job has `failure` (a fixed code). For a topic already drawn, a new **waiting** picture for that network is made: it reuses a picture of the same shape (square for Instagram, Facebook and Google; wide for LinkedIn) at no cost, and a shape the topic does not have yet is drawn (that counts against her draw limits). She approves only that network's new picture; nothing already approved changes. Errors: `400 INVALID_NETWORKS`, `400 CHANNEL_NOT_CONNECTED` (no account of that platform), `409 NETWORK_ALREADY_THERE`, `409 BATCH_LOCKED` (closed or expired), `404 NOT_FOUND`, `503 ENGINE_UNAVAILABLE`.

The other actions each answer `{batch}` as it is now. Once pictures have been asked for, or the batch was put away, the choices are final: `409 BATCH_LOCKED`.

## Topics

`GET /api/v1/topics?externalId=` answers `{topics: [{batchId, postId, headline, networks: [{network, status}], missing: [...]}], connected: [...]}`. A topic is one post idea. `networks` are the networks it already has: `status` is `written` (words only, not drawn yet) or the status of that network's newest picture. `missing` lists the customer's connected networks the topic does not have yet (so a product can offer "add Facebook to this topic"); it is empty for a topic that was put away unanswered. `connected` is every platform she has an account on.

## Pictures to approve

`GET /api/v1/posters?externalId=` lists the pictures waiting for the customer: `{posters: [{id, batchId, postId, network, shape, width, height, headline, caption, versionNumber, status, notice?, sharedWith?, canRedraw, redrawsLeft, createdAt}], reasons}`. `sharedWith` lists the OTHER networks whose current picture of the same post is the very same drawing (Instagram, Facebook and Google share one square drawing; LinkedIn's wide one is its own); it is left out when none. A redraw makes a different image, so a redrawn picture stops being shared with the others; a picture added for a new network that reuses another's drawing shares it. `&status=` is `pending` (default), `approved`, `rejected`, `blocked`, `superseded`, `held`, `expired` (put away because nobody decided in 14 days; these also appear as `expired` under `rejected` and `all`), `open` (pending and held) or `all`. A picture that did not pass the checks is `blocked` and cannot be approved; a `held` one needs the customer to confirm again. For both, `notice` is a plain sentence to show the customer, and `canRedraw` says whether one more picture can be drawn. A newer version of the same post and network makes the older one `superseded`.
`GET /api/v1/posters?externalId=&id=` answers `{poster}` with, in addition, `ctaUrl`, `evidence` (where each fact the picture states was found: `{text, quote, url}`), `decidedAt` and `history` (earlier versions). With `&image=1` it answers the picture itself (JPEG).

`POST /api/v1/posters` (needs `X-Social-Actor`; repeating a decision gives the same answer):

- `{externalId, action: "approve", id}`, or `"reject"` with `reason` (one of the `reasons`) and optional `comment` (500 characters), or `"withdraw"` to take back an approval: answers `{decision: {id, status, decidedAt}}`. A withdraw also stops the post if it is already in the schedule and no other network of it is approved (`postStopped: true`); with another network still approved, the other one is kept and the withdrawn one leaves at the next hourly pass. A post that has already gone out cannot be withdrawn (`409 POST_ALREADY_SENT`). Approving again lets a stopped post go ahead; a skip made by our team is never undone that way.
- `{externalId, action: "redraw", id}` draws one more picture for that network of the post: **once per poster** (`canRedraw`, `redrawsLeft`). Not while it is approved (withdraw first: `409 CONFLICT`). Beyond the allowance `409 REDRAW_LIMIT_REACHED`. It counts against the customer's picture limit (`429 DRAW_LIMIT_REACHED`). Answers `202 {job, created}`; the new picture arrives as a new waiting picture (`poster.ready`), and the old one becomes `superseded`.
- `{externalId, action: "approve-topic", batchId, postId}` approves every network's waiting picture of one topic: `{decisions: [{id, status, decidedAt}]}`.

**Expiry.** A written batch or a picture that nobody decides on within 14 days is put away by us (no staff action): the picture then shows `status: "expired"` in `GET /api/v1/posters?id=`, and the customer can start a fresh batch. Two days before, the product gets `poster.expiring`; when it happens, `poster.expired` (see Webhooks).

A picture that did not pass the checks (`blocked`) cannot be approved, but the customer can put it away: `reject` with `reason: "other"` answers `200` and the picture moves to `rejected` (repeating gives the same answer). After the one redraw is used, that is the customer's way to clear it.

- `{externalId, action: "change-words", id, caption}` changes the words of that network's picture. It makes a **new waiting version of the same picture** (no new picture is drawn, nothing is bought, no redraw is used) that replaces the older one, even an approved one, and the customer must approve it again. Answers `{poster, postStopped}` (`poster` is the new waiting picture). The headline is printed on the picture, so it cannot be changed here (`400 INVALID_REQUEST`; a new headline needs a new picture). The words are checked like a written-post edit (facts, the network's length): `422 WORDS_NOT_ACCEPTED`; the same words as now: `400 NOTHING_TO_CHANGE`; empty or too long: `400 CAPTION_REQUIRED` / `CAPTION_TOO_LONG`; a blocked picture `409 POSTER_BLOCKED`; an old version `409 POSTER_SUPERSEDED` (change the newest); a post that already went out `409 POST_ALREADY_SENT`. If the old approval was already in the schedule, the post is stopped at once (`postStopped: true`) so it cannot go out with the old words, and goes ahead once she approves the new words **and** the hourly release has put them in the schedule: an approval answers `waitingForRelease: true` until then (and the next cron run lets it go). With another network of the post still approved, that network keeps going out and the changed one leaves at the next release.

Only the customer decides. A picture replaced by a newer one answers `409 POSTER_SUPERSEDED`, one that did not pass the checks `409 POSTER_BLOCKED`, and a withdraw of something that was never approved `409 CONFLICT`.

## Per-channel versions (`variants`)

A post has one main caption and picture. `variants` gives one platform its own caption, its own picture, or both. It is an object keyed by platform (`instagram`, `facebook`, `linkedin`, `google`); any other key is refused (`INVALID_VARIANTS`).

```
POST  { ..., "caption": "Fresh laddoos this Diwali.", "variants": { "linkedin": { "caption": "Diwali is our busiest season." } } }
PATCH { "variants": { "instagram": null, "linkedin": { "caption": "New words." } } }
```

- Each platform's value is `{caption?, pictureId?}`. Only the platforms that differ need to be listed; a platform without a version, or a version that leaves a field out, uses the main caption or picture.
- `pictureId` is optional and works like the main one: a picture added through `POST /api/v1/pictures` (square JPG). A product that only wants different words sends captions only.
- On `PATCH`, a platform left out stays as it is, `null` puts the platform back on the main caption and picture, and inside a platform a field left out stays while `null` or `""` removes it. A version with neither a caption nor a picture is dropped.
- A variant caption follows the same rules as the main one (`CAPTION_TOO_LONG`, `TOO_MANY_HASHTAGS`).
- `GET` and the answers of `POST`/`PATCH` show `variants` only for the platforms that have their own version, as `{caption?, imageUrl?}`.

## Analytics

`GET /api/v1/analytics?externalId=[&from=YYYY-MM-DD&to=YYYY-MM-DD]` (default: the last 30 days, at most one year) gives the numbers the networks report for a customer's connected accounts and for the posts we sent. Read only; your own workspaces only (`WORKSPACE_NOT_FOUND` otherwise). A daily check on our side asks each network once a day, so numbers are up to a day old; nothing is ever written to a network. If analytics is switched off on the server the answer is `503 SERVICE_NOT_CONFIGURED`.

```
{ "channels": [{ "channel", "platform", "label", "status": "ok" | "waiting" | "reconnect" | "unsupported", "lastCheckedAt" }],
  "posts":    [{ "postId", "channel", "platform", "permalink", "postedAt", "caption",
                 "total": { "reach", "views", "likes", "comments", "shares", "saves", "clicks" },
                 "series": [{ "date", ...the same numbers, counted since the post went out }] }],
  "accounts": [{ "channel", "platform", "label", "checkedAt",
                 "series": [{ "date", "reach", "views", "profileViews", "followers", "calls", "directions", "websiteClicks" }],
                 "searchTerms": [{ "term", "impressions" }], "needs": ["reconnect" | "followers"] }],
  "audience": { "instagram"?: { "status": "ok", "age"?, "gender"?, "country"?, "city"? }
                            | { "status": "too_few_followers", "followers": 64 | null } | { "status": "reconnect" } | { "status": "none" } },
  "hashtags": [{ "tag": "#diwali", "posts", "avgReach" }], "checkedAt" }
```

- **`channels`** has one entry for every account connected for the workspace: `ok` (numbers exist), `waiting` (connected, first daily check not done yet), `reconnect` (the customer must connect the account again to give the permission to read its numbers; likes, comments, shares and followers may still show), `unsupported` (this network gives no numbers: LinkedIn). `lastCheckedAt` is that account's last check (`null` before the first); the top-level `checkedAt` is when the last whole daily check finished.
- **`audience.instagram`** (the workspace's first Instagram account; absent when none is connected): `ok` with lists of `{label, value}` (largest first; `age` and `gender` as percentages of followers, `country` and `city` as Instagram reports them), `too_few_followers` with the follower count (Instagram gives the audience from 100 followers), `reconnect`, or `none` (nothing yet). Facebook gives no audience, nor does Google.
- **A number a network does not give is absent, never 0.** Instagram and Facebook give per-post numbers; Google gives account numbers only (`views` = Maps and Search together, `calls`, `directions`, `websiteClicks`, `searchTerms` for the last full month) and nothing per post. Only posts we sent to Instagram or Facebook appear in `posts`, from the last 60 days.
- **Per-post totals:** `total` is the post's numbers since it went out (each field from the newest day that has it). A post is listed when it was made inside the range, and its `series` then covers its whole life so far, not only the range.
- **Dates** are UTC calendar days (`YYYY-MM-DD`), `from` and `to` inclusive; `postedAt` is an ISO time so you can show it in any time zone. Series are sorted oldest first; a day we have no reading for is simply absent (we read a post daily for its first week, then weekly). `from` after `to`, a bad date or a range over a year answers `400 INVALID_REQUEST`.
- **`hashtags`** is worked out by us: for each hashtag used by posts made in the range (with the leading `#`), how many posts used it and the average reach of those that have a reach number.

## Errors

Every error answers `{"error": "<a plain sentence>", "code": "<CODE>"}`. The sentence is for a person; the code never changes, so match on it to show your own words. Nothing that would only help a developer is sent: an unexpected failure answers `INTERNAL` with a general sentence.

| Code | Status | When |
|---|---|---|
| `UNAUTHORIZED` | 401 | the key is missing or unknown |
| `SERVICE_NOT_CONFIGURED` | 500 | social-auto's product settings are wrong (a problem on our side) |
| `STORAGE_NOT_SET_UP` | 503 | social-auto's storage is not set up |
| `CONNECT_LINKS_NOT_SET_UP` | 503 | connect links are not set up on our side |
| `SERVICE_UNAVAILABLE` | 503 | the service cannot answer right now; try again |
| `INVALID_REQUEST` | 400 | the body is not JSON, or a field is missing or of the wrong kind |
| `REQUEST_TOO_LARGE` | 413 | the request body is too large |
| `ACTOR_REQUIRED` | 400 | a call that decides something (approve, reject, keep, drop, edit, facts) has no `X-Social-Actor` header |
| `INVALID_ACTOR` | 400 | `X-Social-Actor` is not 1 to 64 letters, digits or `. _ : -` |
| `ENGINE_UNAVAILABLE` | 503 | the poster service (the AI side) is not available just now; try again shortly |
| `INVALID_SITE` | 400 | `site` is missing or not a public website address |
| `SITE_MISMATCH` | 400 | the customer already uses a different website |
| `INVALID_NETWORKS` | 400 | `networks` is not a list of `instagram`, `facebook`, `linkedin`, `google` |
| `JOB_NOT_FOUND` | 404 | no such job for this customer |
| `JOB_LIMIT_REACHED` | 429 | the customer has started as many batches as they may for now |
| `FACT_HELD` | 409 | a held fact cannot be confirmed |
| `BATCH_LOCKED` | 409 | the batch is final: its pictures were already asked for, or it was put away |
| `WORDS_NOT_ACCEPTED` | 422 | edited words do not agree with the facts found on the website |
| `NOTHING_KEPT` | 422 | pictures were asked for but no post of the batch was kept |
| `DRAW_LIMIT_REACHED` | 429 | the customer has asked for pictures as often as they may for now |
| `POSTER_SUPERSEDED` | 409 | a newer picture replaced this one |
| `POSTER_BLOCKED` | 409 | the picture did not pass the checks, so it cannot be approved |
| `POSTER_ALREADY_DECIDED` | 409 | the picture was already decided differently |
| `NETWORK_ALREADY_THERE` | 409 | the written batch already has that network |
| `BRAND_LIMIT_REACHED` | 409 | the customer already has as many brands as they are allowed |
| `GROUP_MISMATCH` | 409 | the workspace already belongs to another customer (group) |
| `INVALID_GROUP` | 400 | `group` is not 1-64 letters, digits or `. _ : -` |
| `WORKSPACE_ARCHIVED` | 409 | the brand is put away, so nothing new is written, drawn or sent for it |
| `REDRAW_LIMIT_REACHED` | 409 | the picture was already drawn again as often as is allowed |
| `INVALID_REASON` | 400 | `reason` of a rejection is missing or not one of the listed reasons |
| `INVALID_EXTERNAL_ID` | 400 | `externalId` is missing or not 1-64 letters, digits or `. _ : -` |
| `WORKSPACE_NOT_FOUND` | 404 | no workspace with that `externalId` belongs to this product |
| `INVALID_CHANNEL` | 400 | `channel` of a connect link is not `linkedin`, `facebook`, `instagram` or `google` |
| `RETURN_URL_NOT_REGISTERED` | 400 | `returnUrl` is not one of the product's registered addresses |
| `INVALID_CHANNELS` | 400 | `channels` is not a list of channel ids, or is empty |
| `CHANNEL_NOT_CONNECTED` | 400 | a chosen channel is not connected for this customer |
| `PICTURE_REQUIRED` | 400 | no picture was sent or chosen |
| `PICTURE_NOT_FOUND` | 400 | the `pictureId` is unknown; add the picture again |
| `PICTURE_NOT_JPG` | 400 | the picture is not a valid JPG |
| `PICTURE_TOO_SMALL` | 400 | the picture is under 320 x 320 pixels |
| `PICTURE_NOT_SQUARE` | 400 | the picture is not square |
| `PICTURE_TOO_LARGE` | 413 or 400 | the picture is over 4 MB (413) or over 4096 x 4096 pixels (400) |
| `INVALID_DAY` | 400 | `day` (or `from` / `to`) is not a real day like `2026-11-20` |
| `INVALID_TIME` | 400 | `time` is not like `12:05` |
| `DAY_PASSED` | 400 | the day has already passed |
| `TIME_PASSED` | 400 | the time has already passed today |
| `TOO_FAR_AHEAD` | 400 | the day is more than 90 days away |
| `CAPTION_REQUIRED` | 400 | the caption is empty |
| `CAPTION_TOO_LONG` | 400 | the caption is longer than Instagram allows (2200 characters) |
| `TOO_MANY_HASHTAGS` | 400 | the caption has more than 30 hashtags |
| `INVALID_VARIANTS` | 400 | `variants` is not an object keyed by platform, or one value is wrong |
| `NOTHING_TO_CHANGE` | 400 | a `PATCH` that changes nothing |
| `POST_NOT_FOUND` | 404 | no such post for this customer |
| `POST_NOT_EDITABLE` | 409 | the post is already due or sent, so it can no longer be changed or deleted |
| `POST_ALREADY_SENT` | 409 | `send` for a post that has already gone out |
| `POST_SKIPPED` | 409 | `send` for a post the team skipped |
| `PAUSED` | 409 | `send` while the post is paused |
| `OVER_LIMIT` | 400 or 409 | a limit of social-auto is reached, such as too many stored posts or customers |
| `NOT_FOUND` | 404 | anything else that is not there |
| `CONFLICT` | 409 | another change was saved at the same moment; read again and retry |
| `INTERNAL` | 500 | something unexpected went wrong on our side; nothing more is said |
| `CHANNEL_UNREACHABLE` | in `problems` | a channel could not be reached just now; it is tried again |
| `RECONNECT_NEEDED` | in `problems` | the customer must connect that account again |
| `CHANNEL_REFUSED` | in `problems` | the platform did not accept the post |

## Webhooks (social-auto to the product)

`POST` JSON to the product's `webhookUrl` for each event. Every event is written to a log first, so none is lost: a delivery that is not answered with a 2xx is tried again after 1 minute, 5 minutes, 30 minutes, 2 hours and 6 hours (6 tries in all, started by the cron), then given up on. The same events can be read at any time (see [Catching up](#catching-up-events)), so a product that was down loses nothing. An event can arrive more than once, or both by webhook and when read: **handle each `id` once.**

```
X-Social-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with webhookSecret>
X-Social-Event: post.published | post.failed | connection.expiring | job.finished | poster.ready
{ "id", "seq", "type", "createdAt", "data": {...} }
```

Check the signature over the **raw** body and reject a `t` more than 5 minutes old. Data: `post.published` has `externalId, postId, channel, account, permalink`; `post.failed` has the same with `error`; `connection.expiring` has `externalId, platform, account, daysLeft (7, 3, 1 or 0), expiresAt`. `job.finished` (a batch of written posts, or a draw, ended) has `externalId, jobId, kind (write or draw), state (done or failed), batchId?`. `poster.ready` (a picture is waiting for the customer's decision) has `externalId, posterId, batchId, postId, network`. `poster.expiring` (a waiting picture or written batch will be put away in 2 days) has `externalId, kind (poster or batch), batchId, postId?, network?, posterId?, expiresAt`; `poster.expired` (it was put away because nobody decided in 14 days) has the same with `expiredAt` (when it was put away) instead of `expiresAt`; for a written batch (`kind: "batch"`) there is no `postId`, `network` or `posterId`. `post.held` (a post is due but an account it was aimed at is no longer connected, so it waits) has `externalId, postId, channel, platform, date, code (ACCOUNT_DISCONNECTED)`; `post.missed` (the post's window passed without it going out) has `externalId, postId, channel, account, date`. Each is sent once per post and account. The last six are found by the cron, so they arrive within a few minutes, not instantly.

### Catching up (events)

`GET /api/v1/events?after=<seq>&limit=<1..100>` answers `{events: [{seq, id, type, createdAt, data}], hasMore}`: this product's events after the one with that `seq`, oldest first (leave `after` out to start from the beginning). Remember the last `seq` you handled. Events are kept for 14 days. Use it on start-up and after any time your webhook address was down.

## Not built yet

The AI that reads a website and writes posts on a server.

# Product API

How a product (such as Brandbasket) uses social-auto. Every call is made by the product's **server** with its own key; the key must never reach a browser.

```
Authorization: Bearer <product key>
```

## Settings (social-auto)

| Where | Name | Meaning |
|---|---|---|
| publisher | `PRODUCTS` | JSON list: `{id, keyHash (SHA-256 hex of the key), returnUrls[], webhookUrl?, webhookSecret? (16+ chars)}` |
| publisher + dashboard | `INVITE_SECRET` | 32+ characters, the same value in both; signs connect links |
| publisher | `DASHBOARD_ORIGIN` | the dashboard's address, where connect links point |
| publisher + dashboard | `LINKEDIN_CLIENT_ID` (+ publisher `LINKEDIN_CLIENT_SECRET`) | the LinkedIn app |
| publisher + dashboard | `FACEBOOK_APP_ID` (+ publisher `FACEBOOK_APP_SECRET`) | the Meta app, for Facebook Pages |
| publisher + dashboard | `INSTAGRAM_APP_ID` (+ publisher `INSTAGRAM_APP_SECRET`) | the Instagram app of the same Meta app (Instagram API with Instagram login). Its redirect address is the dashboard's `/api/instagram-callback` |

## Endpoints (publisher)

- `POST /api/v1/workspaces` `{externalId, name}`: creates the customer's workspace, or returns the existing one. `GET ?externalId=` reads it with its channels (never tokens). The workspace and each channel carry `paused`: true when the team has paused the workspace, everything, or that account, so posts are not being sent there.
- `POST /api/v1/connect-link` `{externalId, channel: "linkedin" | "facebook" | "instagram" | "google", returnUrl?}`: a link (valid 1 hour) the customer opens to press Allow. `returnUrl` must be one of the product's registered `returnUrls`; the customer comes back to it with `?social=connected|denied|failed&channel=linkedin` (or `facebook`, `instagram`, `google`). A Facebook link connects every Page the customer chooses; each Page appears as its own channel id (`facebook:<page id>`). A Google link has the customer sign in with the Google account that manages their Business Profile; with one listing it is connected at once, with several a plain page asks which one is theirs (one listing per link, press it again to add another). Each appears as `google:<location id>` and is posted to as an update. Google drops hashtags and shortens text over 1500 characters, so the same caption reads a little differently there. A Google account with no listing comes back as `failed`. An Instagram link connects the customer's own Business or Creator account (no Facebook Page needed) as `instagram:<account id>`. Social-auto renews it every week, so it only ends if the customer removes the app or renewal fails, and then `connection.expiring` is sent.
- `POST /api/v1/pictures`: body is the JPG (square, 320-4096 px, up to 4 MB); answers `{pictureId}`.
- `POST /api/v1/posts` `{externalId, day: "YYYY-MM-DD", time?: "HH:MM", caption, pictureId, channels?, variants?}`: goes out that day at `time` (India time, default 10:00; a post with its own time is sent by the frequent run within about 5 minutes of it) to the chosen channel ids (default: all connected). The moment must be ahead of now and within 90 days. `variants` gives a platform its own caption or picture, see [Per-channel versions](#per-channel-versions-variants).
- `GET /api/v1/posts?externalId=[&from=YYYY-MM-DD&to=YYYY-MM-DD]`: all of the customer's posts, planned and extra, earliest first. Each has `id, date, caption, imageUrl?, manual, variants?, state` (overall) and `channels[]` (`id, platform, account, state, permalink`). `state` is one of `scheduled`, `due`, `published`, `missed`, `skipped` (the team skipped it, or its channel was paused when its time came, so it is never sent late) or `paused` (held back by a pause for now). `from` is the first day and `to` the last day shown, in India time.
- `PATCH /api/v1/posts?externalId=&postId=` `{day?, time?, caption?, pictureId?, channels?, variants?}`: changes a post the product made (`manual: true`) while it has not gone out; anything left out stays. Planned posts cannot be changed (409/404). Answers `{post}`.
- `POST /api/v1/send` `{externalId, postId}`: sends a post the product made right now (409 while it is skipped or paused), to its chosen channels, and dates it now. Answers `{post, failed, problems?}`; `failed: true` means a channel did not take it, and the post stays due for 20 hours so the next daily run tries again. `problems` lists each channel that failed as `{account, code, error}` (codes `CHANNEL_UNREACHABLE`, `RECONNECT_NEEDED`, `CHANNEL_REFUSED`; the channel's own error text is never passed on). Only the channels that failed are tried again. 409 when it has already gone out. Anyone's post that is not the product's own, and planned posts, answer 404/400.
- `DELETE /api/v1/posts?externalId=&postId=`: removes a post that has not gone out.

A product only ever reaches workspaces it created. Another product's customers answer "no such workspace" (`WORKSPACE_NOT_FOUND`).

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

`POST` JSON to the product's `webhookUrl`, once per event, no retries: the product treats `GET /api/v1/posts` as the source of truth.

```
X-Social-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with webhookSecret>
X-Social-Event: post.published | post.failed | connection.expiring
{ "id", "type", "createdAt", "data": {...} }
```

Check the signature over the **raw** body and reject a `t` more than 5 minutes old. Data: `post.published` has `externalId, postId, channel, account, permalink`; `post.failed` has the same with `error`; `connection.expiring` has `externalId, platform, account, daysLeft (7, 3, 1 or 0), expiresAt`.

## Not built yet

The AI that reads a website and writes posts on a server.

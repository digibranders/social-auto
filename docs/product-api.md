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

- `POST /api/v1/workspaces` `{externalId, name}`: creates the customer's workspace, or returns the existing one. `GET ?externalId=` reads it with its channels (never tokens).
- `POST /api/v1/connect-link` `{externalId, channel: "linkedin" | "facebook" | "instagram", returnUrl?}`: a link (valid 1 hour) the customer opens to press Allow. `returnUrl` must be one of the product's registered `returnUrls`; the customer comes back to it with `?social=connected|denied|failed&channel=linkedin` (or `facebook`, `instagram`). A Facebook link connects every Page the customer chooses; each Page appears as its own channel id (`facebook:<page id>`). An Instagram link connects the customer's own Business or Creator account (no Facebook Page needed) as `instagram:<account id>`. Social-auto renews it every week, so it only ends if the customer removes the app or renewal fails, and then `connection.expiring` is sent.
- `POST /api/v1/pictures`: body is the JPG (square, 320-4096 px, up to 4 MB); answers `{pictureId}`.
- `POST /api/v1/posts` `{externalId, day: "YYYY-MM-DD", caption, pictureId, channels?}`: goes out at 10:00 IST that day to the chosen channel ids (default: all connected).
- `GET /api/v1/posts?externalId=[&from=YYYY-MM-DD&to=YYYY-MM-DD]`: all of the customer's posts, planned and extra, earliest first. Each has `id, date, caption, imageUrl?, manual, state` (overall) and `channels[]` (`id, platform, account, state, permalink`). `from` is the first day and `to` the last day shown, in India time.
- `PATCH /api/v1/posts?externalId=&postId=` `{day?, caption?, pictureId?, channels?}`: changes a post the product made (`manual: true`) while it has not gone out; anything left out stays. Planned posts cannot be changed (409/404). Answers `{post}`.
- `POST /api/v1/send` `{externalId, postId}`: sends a post the product made right now, to its chosen channels, and dates it now. Answers `{post, failed}`; `failed: true` means a channel refused it, and the post stays due for 20 hours so the next daily run tries again. 409 when it has already gone out. Anyone's post that is not the product's own, and planned posts, answer 404/400.
- `DELETE /api/v1/posts?externalId=&postId=`: removes a post that has not gone out.

A product only ever reaches workspaces it created. Another product's customers answer "no such workspace".

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

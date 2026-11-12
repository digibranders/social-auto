# Placeholder pictures for local testing

To try the whole flow (written posts, the weekly draw, one picture per channel, the weekly limit, the review screen) on a local machine **without spending anything on the picture model**, start the job runner (or the engine) with both settings:

```
PICTURE_MODE=placeholder
LOCAL_PLACEHOLDER_PICTURES=yes
```

- Two settings are needed on purpose, so it cannot be switched on by mistake on a real server. Never set them in `/etc/social-auto/*.env`.
- The picture model and the vision check are replaced. Everything else is the normal pipeline: the prompt is built, the picture is accepted, registered for review and counted.
- Each picture is a plain coloured card with the headline and the word `PLACEHOLDER`, in a colour of its own for each channel (Instagram, Facebook, LinkedIn, Google), so the four pictures of a topic are told apart at a glance. It is always the engine's square canvas, whatever the shape of the channel's picture.
- Each placeholder is written to the paid ledger at no cost and with its channel, so the weekly limit of a channel counts it and `GET /api/v1/limits` shows it.
- Writing the posts (the website read and the captions) still uses the text model and its key; only the pictures are placeholders.
- It needs Chrome (the engine's normal requirement) and, for the JPEG, `sips` on a Mac or ImageMagick `convert` elsewhere.

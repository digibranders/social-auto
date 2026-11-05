# Page-ranking fixtures

Each folder holds `home.html` (the homepage as a site served it) and `expect.json`:

```json
{ "base": "https://example.com", "mustSelect": ["/pricing"], "atLeast": [{ "from": ["/services/a", "/services/b", "/services/c"], "count": 2 }], "mustReject": ["/privacy"], "maxSelected": 7 }
```

`pages.test.ts` ranks every folder here. Paths are matched against the page address without the host.

The folders below are **synthetic**: hand-written to copy the structure of the kinds of sites we have seen (a SaaS site with a customer carousel,
a shop with a region switcher, a regional business, a service business, a clinic, a very large menu). They contain no copied content.

**Real sites** (`*-real`) were saved with `node src/fixture-capture.ts --site <address> --name <folder>`. That script only accepts a host listed in
`src/fixtures/approved-sites.json`, a file only the owner edits, and a test checks it refuses look-alikes and unlisted hosts. Each real folder has
`home.html` (scripts, styles and inline graphics removed), `source.json` (address, time, whether it was read as the browser builds it) and a hand-written
`expect.json`. Write the expectation from what the business really offers, never from the ranker's own output, or the test only agrees with itself.

Fixtures cover different industries and content shapes on purpose: a business with prices and products, one with none (`nonprofit`), a
restaurant whose vocabulary ("menu") is not in any built-in list, a clinic, a region switcher, a very large menu, and a one-page site with
nowhere to go. Nothing in the engine may depend on which industry a fixture is.

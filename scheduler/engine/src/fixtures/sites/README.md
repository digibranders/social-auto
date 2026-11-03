# Page-ranking fixtures

Each folder holds `home.html` (the homepage as a site served it) and `expect.json`:

```json
{ "base": "https://example.com", "mustSelect": ["/pricing"], "mustReject": ["/privacy"], "maxSelected": 7 }
```

`pages.test.ts` ranks every folder here. Paths are matched against the page address without the host.

The folders below are **synthetic**: hand-written to copy the structure of the kinds of sites we have seen (a SaaS site with a customer carousel,
a shop with a region switcher, a regional business, a service business, a clinic, a very large menu). They contain no copied content.

To add a real site, save its homepage HTML here and write its `expect.json` by hand from what the business really offers. Only do that for a
site its owner (or Siddique) has approved; never fetch sites to fill this folder on a whim.

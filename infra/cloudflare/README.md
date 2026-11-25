# Public sites on Cloudflare

Two static Workers serve the public sites. Both are built from sources in this repository:

| Host                          | Source                                                  | Worker config         |
| ----------------------------- | ------------------------------------------------------- | --------------------- |
| `lp.agentworkspace.indx.jp`   | `sites/lp/`                                             | `lp.wrangler.jsonc`   |
| `docs.agentworkspace.indx.jp` | `docs/sdk/site` (Mintlify), exported with `mint export` | `docs.wrangler.jsonc` |

```sh
pnpm sites:build          # both sites into dist/sites/ (or: pnpm sites:build lp|docs)
pnpm sites:deploy         # build, then wrangler deploy both Workers
```

The LP is several static pages (`index`, `product`, `use-cases`, `examples`, `security`, `compare`,
`404`) that share `sites/lp/assets/` and one head, header and footer. Those three live once in
`sites/lp/_partials/` and are copied into each page between `<!-- chrome:… -->` markers; after
editing a partial or adding a page, run `node scripts/sites/chrome.mjs --write`. The LP build refuses
to run while any page has drifted from the partials. The Worker's `auto-trailing-slash` handling
serves `use-cases.html` at `/use-cases`, and `404.html` for any missing path.

The build also writes each page in Japanese under `ja/` (`/ja/use-cases`, with `ja/404.html` for a
missing Japanese path), from the English page and the strings in `sites/lp/_i18n/ja/`
(`scripts/sites/i18n.mjs`; `node scripts/sites/i18n.mjs --missing` lists the English strings that
have no Japanese one yet, and the build refuses to run while there are any). It fills each
`<!-- data:… -->` slot, the Agent Store's entries and counts, from the store catalog
(`scripts/sites/store-data.mjs`, which also holds the store's address, `STORE_ORIGIN`).

`wrangler deploy` attaches each host as a Workers Custom Domain (the `custom_domain` route), which
creates the DNS record and certificate in the `indx.jp` zone. It needs `wrangler login`, or
`CLOUDFLARE_API_TOKEN` with Workers Scripts:Edit, Workers Routes:Edit, DNS:Edit and Zone:Read.

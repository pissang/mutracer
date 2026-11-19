# MuTracer site

The static site at <https://mutracer.meimu-studio.com>:

| Path | Source |
| --- | --- |
| `/` | Home page (`site/`): features, gallery, MaterialX samples and example scenes |
| `/viewer/` | [Viewer](../viewer/README.md) |
| `/examples/` | [Examples](../examples/README.md) |
| `/oidn/weights/` | OIDN weights shared by the viewer and the examples |

```bash
npm run site            # home page only, http://localhost:3013
npm run build:site      # everything in dist-site/
npm run typecheck:site
```

The home page has no Three.js or renderer code. Gallery tiles and
example cards use the viewer's preset thumbnails; the MaterialX swatches reuse
the viewer's sample thumbnails.
Example cards link to
`viewer/#model=<id>` and use the viewer's presets and thumbnails. Dropped or
picked files are stored in IndexedDB (same origin) and the viewer opens with
`#open=files`, loads them and clears the store.

## Cloudflare deployment

From the repository root, with Node.js 22 or later:

```bash
npm ci
npx wrangler login      # once per machine
npm run deploy
```

`wrangler.jsonc` checks the site, viewer and example types, runs
`build:site` and deploys `dist-site/` as static assets for the `mutracer`
Worker, attached to the custom domain `mutracer.meimu-studio.com` (the
`meimu-studio.com` zone must be on the same Cloudflare account; Wrangler
creates the DNS record and certificate). No server code or runtime secrets
are needed. Fingerprinted files under `assets/`, `viewer/assets/` and
`examples/bundle/` receive an immutable browser cache (`site/public/_headers`).
Viewer state uses the URL hash, so missing asset URLs return 404.

For Cloudflare Workers Builds, use `npm run build:site` as the build command
and `npm run deploy` as the deploy command (the latter also rebuilds and
checks types).

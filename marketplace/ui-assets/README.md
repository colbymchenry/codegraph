# Marketplace assets

The marketplace uses the light CodeGraph theme from `site/src/styles/theme.css`: Archivo Variable, IBM Plex Mono, paper/ink colors, thin rules and square corners. This keeps the existing light-only behavior; no theme switch or marketing/docs-site changes are introduced.

Run from the repository root:

```sh
npm ci --prefix marketplace/ui-assets --ignore-scripts
npm run build --prefix marketplace/ui-assets
npm run check --prefix marketplace/ui-assets
```

The lockfile pins `lucide-static` 0.468.0, `@fontsource-variable/archivo` 5.2.8 and `@fontsource/ibm-plex-mono` 5.2.7. The build copies only 26 used icons and four WOFF2 Latin font subsets, with no runtime CDN or package dependency. `public/asset-manifest.json` records exact package inputs and generated outputs. Other writing systems use system font fallbacks. All SVG interface icons are decorative, `aria-hidden`, unfocusable and `currentColor`; their containing controls retain text or accessible labels. Source files are rendered with `textContent`, never as icon markup.

Licenses shipped under `public/licenses/`: Lucide ISC and its Feather-derived MIT notice; Archivo and IBM Plex Mono SIL OFL. Brand marks are separate from the Lucide library:

- `brand/codegraph.svg` uses the actual mark served by https://getcodegraph.com/ on 2026-09-23, with the shared light-theme colors and no Svelte-specific class. CodeGraph branding remains subject to the project's rights.
- `brand/drupal.svg` uses the path from Drupal core `core/themes/default_admin/migration/media/icons/general/drupal.svg`, revision `eaba66f418831210acc6bc5b49c61d171853455b`, with Drupal blue fill. Drupal's GPL-2.0 license is included as `licenses/drupal.txt`; the Drupal name and logo are trademarks of Dries Buytaert. These marks identify the products, not a new icon design.

Cloudflare serves these assets before the Worker; `/api/*` continues through the Worker. The local Miniflare harness now uses the same native asset routing, and the portable Node server permits only the fixed UI asset paths with correct MIME types. Neither change modifies registry publication, graph execution or immutable packages.

`marketplace-theme-browser.cjs` checks local or real hosted read-only UI, loaded fonts/tokens, CSP, SVG event targets, keyboard navigation, 320/390px layouts and verified legacy Drupal source. The separate source-browser acceptance retains real managed installation, selection races and inert display checks. A live test does not submit releases or connect to local projects.

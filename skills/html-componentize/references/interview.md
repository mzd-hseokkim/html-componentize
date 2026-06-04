# Interview — phase 0 (detect first, then ask only the gaps)

Run `detect-project.mjs` FIRST. Most of these are auto-detected from the
surrounding project — only **confirm** detected values and **ask** what's under
`ambiguities` or undetectable. Write merged answers to `.componentize/config.json`.
Don't re-ask a high-confidence detection; don't proceed on an ambiguous one.
Defaults marked ★.

## Questions

(🔍 = usually auto-detected — confirm, don't ask, unless flagged ambiguous)

1. 🔍 **Target framework** — React / Vue. (Detected from deps / file types.)
2. 🔍 **Language** — TypeScript / JavaScript. (tsconfig / `typescript` dep / `.tsx`.)
3. 🔍 **Styling strategy** — CSS Modules ★ / scoped (Vue) / plain CSS / Tailwind.
   - Detected from `*.module.css`, tailwind config, css-in-js deps, `<style scoped>`.
   - CSS Modules and plain/scoped PRESERVE authored CSS (safe).
   - Tailwind REWRITES → fidelity risk; if detected, confirm a CSS-preserving
     alternative when fidelity matters.
4. 🔍 **Mode** — integrate / greenfield. (integrate if a framework/components dir
   is detected.) If integrate: **source root to index** (detected `indexRoot`).
5. **Output location** — where generated files go (default detected
   `componentsDir`, else `src/components/generated`).
5b. **Directory structure** — co-location ★ (one folder per component:
   `Card/{Card.tsx, Card.module.css, index.ts}`) / nested (item folders inside
   their container) / flat (everything in outDir). Drives `plan-files.mjs`.
5c. 🔍 **Layout strategy** — how page chrome (header/nav/footer) is handled.
   Detected from `routing` (react-router/next/vue-router/nuxt) + existing layout:
   - `reuse-layout` ★ if an existing layout is found — page renders only its
     content into that layout's outlet; don't regenerate chrome.
   - `hoist` if routing exists but no layout — generate a shared Layout + outlet,
     page becomes a route component (chrome NOT duplicated per page).
   - `inline` if no router / standalone page — chrome stays in the page.
   Confirm when `ambiguities` flags it.
6. **Component granularity** — how aggressively to split? default: extract
   repeated structures + landmark layout; keep one-offs inline unless they have
   clear visual identity.
7. **Asset handling** — copy `img`/fonts into the project, rewrite paths to an
   asset import, or leave URLs as-is ★.
8. **Interactivity expected?** — is this purely presentational (most cases) or
   are there behaviors to preserve? If behaviors exist, confirm they'll be
   flagged as stubs rather than guessed.
9. **Verification viewports** — default `1280x800,375x667`. Add any breakpoints
   the design cares about. **Pixel-diff threshold** default `0.01` (1%).

## config.json shape

```json
{
  "framework": "react",
  "lang": "ts",
  "styling": "cssModules",
  "mode": "integrate",
  "indexRoot": "src",
  "outDir": "src/components/generated",
  "structure": "co-location",
  "layoutStrategy": "reuse-layout",
  "routing": { "library": "react-router", "outlet": "<Outlet/>", "hasLayout": true, "layoutPath": "src/Layout.tsx" },
  "granularity": "default",
  "assetStrategy": "as-is",
  "interactivity": "presentational",
  "viewports": ["1280x800", "375x667"],
  "diffThreshold": 0.01
}
```

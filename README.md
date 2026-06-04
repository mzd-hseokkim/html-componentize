# html-componentize (Claude Code plugin)

Convert static **HTML+CSS → React or Vue components** deterministically, with
fidelity proven by render-and-pixel-diff.

The wedge no existing tool fills (see `PLAN.md` §8): HTML input · cascade-
preserving · reuses your existing components · verifies the result renders
identically. Builder.io/v0/Locofy are Figma-input, AI-probabilistic, unverified.

## How it works

The model orchestrates; deterministic Node scripts do the heavy lifting.
**One rule: restructure, never re-author** (`skills/html-componentize/references/principles.md`).
Authored CSS, source text, and DOM are moved verbatim by scripts — computed
style is used only to *verify*, never to generate.

```
.claude-plugin/
  plugin.json           plugin manifest (current: v0.6.0)
  marketplace.json      so the repo is installable as a marketplace
commands/
  componentize.md       the /componentize slash command
skills/html-componentize/
  SKILL.md              orchestration playbook (the skill entrypoint)
  scripts/              deterministic engine (Node, .mjs)
    detect-project.mjs      infer framework/lang/styling/routing+layout from the project → detected.json
    parse-source.mjs        HTML+CSS → source-map.json (incl. inline-SVG rawHTML + head font assets)
    index-workspace.mjs     existing+generated components (tag-sig + class vocab) → workspace-index.json
    detect-boundaries.mjs   classify layout|reuse|new-component|leaf; exact+fuzzy reuse match
    extract-data.mjs        instance tree-diff → props + verbatim data array
    plan-files.mjs          boundary tree → dir plan + layout/chrome + shared placement + write-mode + hoist plan
    manifest.mjs            record generated files (path+hash) so re-runs reconcile, not blind-overwrite
    lint-deps.mjs           flag page→page import coupling (a component that should be hoisted to common)
    css-to-modules.mjs      authored CSS → scoped *.module.css + classMap
    verify-fidelity.mjs     Playwright render (waits fonts, full page) + global/local/DOM diff gate + report.html
  templates/{react,vue}/  canonical codegen idioms
  references/             principles.md, interview.md
  examples/               sample HTML + an existing-project for reuse demo
PLAN.md                 design, decisions, market research
```

---

## Requirements

- **Claude Code** (the plugin runs inside it).
- **Node.js ≥ 18** on PATH (the engine scripts are ESM `.mjs`; developed on Node 24).
- **git** (for installing the plugin from GitHub).
- **GitHub CLI `gh`, authenticated** — only because this repo is **private**.
  Run `gh auth status` to confirm you're logged in to an account with access.
  (If you later make the repo public, `gh` auth is no longer required to install.)
- **~150 MB disk** for the one-time Playwright Chromium download (phase 5 only).
  Skip it if you don't need fidelity verification.

---

## Installation

There are two ways to use it: **(A) install as a plugin** (recommended — gives
you the `/componentize` command and auto-triggering), or **(B) run from a local
clone** (no install; you drive the scripts).

### A. Install as a Claude Code plugin

1. **Add this repo as a plugin marketplace** (inside Claude Code):

   ```
   /plugin marketplace add mzd-hseokkim/html-componentize
   ```

   This reads `.claude-plugin/marketplace.json` from the repo. Because the repo
   is private, Claude Code uses your `gh` credentials to clone it — make sure
   `gh auth status` shows you're logged in first.

2. **Install the plugin from that marketplace:**

   ```
   /plugin install html-componentize@html-componentize-marketplace
   ```

   - `html-componentize` = the plugin name (`.claude-plugin/plugin.json` → `name`)
   - `html-componentize-marketplace` = the marketplace name
     (`.claude-plugin/marketplace.json` → `name`)

   After this, `/componentize` appears in your command list and the skill can
   auto-trigger from natural language. The plugin is cached under:
   ```
   ~/.claude/plugins/cache/html-componentize-marketplace/html-componentize/<version>/
   ```

3. **Install the engine dependencies (one time per machine).**
   The deterministic engine needs npm packages (cheerio, postcss, playwright,
   babel, …). On the **first conversion**, the skill runs this for you per
   `SKILL.md`; you can also do it manually against the cached plugin:

   ```
   cd ~/.claude/plugins/cache/html-componentize-marketplace/html-componentize/<version>/skills/html-componentize/scripts
   npm install
   npx playwright install chromium      # only needed for phase-5 verification
   ```

   `npm install` is per-plugin-version; the Chromium download is global, so it's
   reused across projects and future plugin versions.

### B. Run from a local clone (no plugin install)

```
git clone https://github.com/mzd-hseokkim/html-componentize
cd html-componentize/skills/html-componentize/scripts
npm install
npx playwright install chromium
```

Then invoke the scripts directly with absolute paths from inside your target
project (see "Manual / scripted run" below). You don't get the `/componentize`
command this way, but the engine is identical.

### Updating the plugin

```
/plugin marketplace update html-componentize-marketplace
/plugin install html-componentize@html-componentize-marketplace
```

After updating to a version with new engine deps, re-run `npm install` in the
new cached version's `scripts/` dir (or just let the next conversion do it).

---

## Usage

> **Run it from your target project** — the directory that contains (or will
> contain) the HTML and the components. The plugin is just an installed tool;
> all output is written into your project's current working directory under
> `.componentize/`. Do **not** run it inside this plugin's own repo.

### Option 1 — the `/componentize` command

```
/componentize <html-path> [react|vue]
```

Examples:

```
/componentize ./mockups/landing.html
/componentize src/legacy/pricing.html react
/componentize ./page.html vue
```

- `<html-path>` — the source HTML file to convert (required; if omitted, you'll
  be asked which file).
- `react` | `vue` — optional target framework. If omitted, the framework is
  auto-detected from your project (see Phase 0).

### Option 2 — natural language

Just ask, with the path:

```
이 HTML을 React 컴포넌트로 변환해줘. 경로: ./page.html
Convert ./page.html into Vue components.
```

The skill auto-triggers on requests like "turn this HTML into a React/Vue
component", "migrate this HTML to components", etc.

### What you provide

- **HTML file path** (required).
- **CSS**: if styles are inline (`<style>`) or via `<link rel="stylesheet">`,
  they're picked up automatically. For separate stylesheet files you want to
  force, you can mention them and the engine accepts `--css a.css --css b.css`.
- **Target framework**: usually auto-detected; specify only to override.
- **Output location** (optional): defaults to your project's detected components
  directory (e.g. `src/components/`); say where else if you prefer.

### What happens (the pipeline)

Each phase writes an inspectable artifact into `.componentize/` and has a gate
that must pass before the next phase runs:

| Phase | Action | Artifact |
|------|--------|----------|
| 0  | **Detect** framework/lang/styling from the project, then interview only the gaps | `detected.json` → `config.json` |
| 0.5| **Index** existing components (so they get reused, not regenerated) | `workspace-index.json` |
| 1  | **Parse** HTML + authored CSS + assets | `source-map.json` |
| 2  | **Classify** each node: layout / reuse / new-component / leaf; find repeated structures | `boundaries.json` |
| 3  | **Extract data** — diff repeated instances → props + a verbatim data array | `data-spec.json` |
| 4  | **Plan + codegen** — derive a co-location directory layout, move CSS into `*.module.css`, write components | `file-plan.json`, component files |
| 4.5| **Reuse decision** — import indexed components instead of generating duplicates | `reuse-decision.json` |
| 5  | **Verify fidelity** — render original vs result (fonts loaded, full page); gate on global + local-block + DOM diff | `verify-report.json`, **`verify/report.html`** |

### What you get

- **Generated / reused component files** at your chosen output location.
- **`.componentize/verify/report.html`** — a self-contained, side-by-side
  **original vs result vs diff** comparison per viewport, with diff %, DOM-match,
  and PASS/FAIL badges. Open it in a browser. This is the comparison report.
- **`.componentize/unknowns.md`** — anything that was flagged rather than
  guessed (inline handlers/`<script>`, unmappable reuse props, low-confidence
  boundaries, unresolved diff regions). The plugin never silently invents these.

Fidelity is never claimed without a passing `verify-report.json`. On a failing
diff, the model opens `report.html`, finds the divergent region, fixes the cause
(usually a missed CSS rule or a layout node mistaken for a component), and re-runs.

### Manual / scripted run (advanced)

You can drive the engine yourself from your target project's directory. Point a
variable at the engine's `scripts/` dir, then run the phases in order:

```bash
SCRIPTS="<plugin-or-clone>/skills/html-componentize/scripts"

node "$SCRIPTS/detect-project.mjs"   --root . --out .componentize/detected.json
node "$SCRIPTS/index-workspace.mjs"  --root src --out .componentize/workspace-index.json
node "$SCRIPTS/parse-source.mjs"     --html ./page.html --out .componentize/source-map.json
node "$SCRIPTS/detect-boundaries.mjs" --in .componentize/source-map.json \
     --out .componentize/boundaries.json --index .componentize/workspace-index.json
node "$SCRIPTS/extract-data.mjs"     --map .componentize/source-map.json \
     --boundaries .componentize/boundaries.json --out .componentize/data-spec.json
node "$SCRIPTS/css-to-modules.mjs"   --map .componentize/source-map.json \
     --classes "card,card-title" --out src/components/Card.module.css
# ...write components from templates/, then:
node "$SCRIPTS/verify-fidelity.mjs"  --original ./page.html --result http://localhost:5173 \
     --viewports 1280x800,375x667 --threshold 0.01 --out .componentize/verify
```

Every script prints a compact JSON summary and writes its full artifact.

---

## Status

Engine smoke-tested end-to-end on `examples/sample`: repetition → `Card` (3×),
props `{image, alt, cardTitle, cardDesc}` extracted verbatim, CSS moved to a
module intact, reuse-matched an indexed `Card.tsx`, phase-5 self-diff passes and
emits `report.html`.

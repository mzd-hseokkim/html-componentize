# html-componentize (Claude Code plugin)

Convert static **HTML+CSS → React or Vue components** deterministically, with
fidelity proven by render-and-pixel-diff.

The wedge no existing tool fills (see `PLAN.md` §8): HTML input · cascade-
preserving · reuses your existing components · verifies the result renders
identically. Builder.io/v0/Locofy are Figma-input, AI-probabilistic, unverified.

## How it works

The model orchestrates; deterministic Node scripts do the heavy lifting.
**One rule: restructure, never re-author** (`references/principles.md`). Authored
CSS, source text, and DOM are moved verbatim by scripts — computed style is used
only to *verify*, never to generate.

```
.claude-plugin/
  plugin.json           plugin manifest (v0.1.0)
  marketplace.json      so the repo is installable as a marketplace
skills/html-componentize/
  SKILL.md              orchestration playbook (the skill entrypoint)
  scripts/              deterministic engine (Node, .mjs)
    detect-project.mjs      infer framework/lang/styling from the project → detected.json
    parse-source.mjs        HTML+CSS → source-map.json
    index-workspace.mjs     existing+generated components → workspace-index.json
    detect-boundaries.mjs   classify layout|reuse|new-component|leaf + repetition
    extract-data.mjs        instance tree-diff → props + verbatim data array
    css-to-modules.mjs      authored CSS → scoped *.module.css + classMap
    verify-fidelity.mjs     Playwright render + pixel/DOM diff (pass/fail gate)
  templates/{react,vue}/  canonical codegen idioms
  references/             principles.md, interview.md
  examples/               sample HTML + an existing-project for reuse demo
PLAN.md                 design, decisions, market research
```

## Install (as a plugin)

```
/plugin marketplace add mzd-hseokkim/html-componentize
/plugin install html-componentize@html-componentize-marketplace
```

Then, once per machine, install the engine deps:

```
cd skills/html-componentize/scripts && npm install
npx playwright install chromium     # phase 5 only
```

## Usage

In the target project (cwd = where the HTML lives), either:

- run the command: `/componentize <html-path> [react|vue]`, or
- just ask in natural language ("이 HTML을 React 컴포넌트로 변환해줘") — the skill
  auto-triggers.

Artifacts (incl. the side-by-side `verify/report.html`) land in `.componentize/`.

## Status

Engine smoke-tested end-to-end on `examples/sample`: repetition → `Card` (3×),
props `{image, alt, cardTitle, cardDesc}` extracted verbatim, CSS moved to a
module intact, reuse-matched an indexed `Card.tsx`, phase-5 self-diff passes.

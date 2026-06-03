# Principles — why this is deterministic

## The one rule: restructure, never re-author

Every failure mode of naive HTML→component conversion is the same mistake:
**the LLM re-authors source material it should only be moving.**

| Material | Wrong (re-author) | Right (restructure) |
|---|---|---|
| CSS | read `getComputedStyle`, inline 200+ props, or rewrite to Tailwind | move the **authored** rules verbatim into a CSS Module (`css-to-modules.mjs`) |
| Text content | retype / paraphrase list copy | copy verbatim from `data-spec.json` (extracted by tree-diff) |
| DOM structure | eyeball and rebuild the markup | mirror the parsed tree from `source-map.json` |
| Existing components | regenerate a new Button/Card | match via structural signature → import & reuse |

**computed style is used in exactly one place: phase 5 verification, as an
oracle.** It is never an input to code generation. If you ever find yourself
reading computed styles to *write* a component, stop — that is the failure.

## What "deterministic" means here

Not bit-identical output. It means:

1. **Mechanical work is done by scripts**, not the model — parsing, structural
   hashing, instance diffing, CSS extraction, screenshot diffing, indexing.
   Same input → same artifact.
2. **Typed artifacts between phases** (`source-map.json`, `boundaries.json`,
   `data-spec.json`, `workspace-index.json`, `reuse-decision.json`,
   `verify-report.json`) — each is inspectable and checkable.
3. **Gates** — a phase cannot be declared done until its check passes
   (every node classified, text copied verbatim, no duplicate generation,
   pixel diff under threshold).
4. **Ambiguity is resolved by the interview**, not by guessing. Anything the
   pipeline can't decide mechanically and the interview didn't cover goes into
   the **unknowns ledger** and is surfaced — never silently invented.

## Layout ≠ component

Not every element is a component. Phase 2 classifies each node:

- **layout** — page scaffolding, grid/flex wrappers, landmark tags. Positioning
  CSS dominates, not repeated, large subtree. Renders structure & the `.map`/
  `v-for`; not extracted into a props-driven component.
- **reuse** — structural signature matches an indexed existing component. Import
  it; do not generate.
- **new-component** — repeated item or a bounded unit with visual identity.
- **leaf-markup** — inline/leaf elements; stay as plain markup.

The script proposes labels from mechanical signals + a confidence; the model
confirms or overrides. Low-confidence nodes are flagged for review.

## The reuse index is living

`.componentize/workspace-index.json` holds **existing + previously generated**
components, each with a structural signature. Re-index after every codegen so
the next page reuses what this page produced. This is what prevents N copies of
the same Button across a multi-page migration — the gap no existing tool fills.

## Flag, don't guess (interactivity)

Inline `onclick`, `<script>` blocks, and any behavior the pipeline can't
faithfully translate are recorded in `source-map.json` → `interactions` and
carried to the unknowns ledger. Emit a clearly-marked `// TODO(componentize):`
stub and report it. Never fabricate handler logic.

# Improvement backlog

Field feedback (real multi-page migration). Confirmed against current code.

> **Status: implemented in v0.6.0.** P1 (sharedDir placement) + P2 (dependency
> lint) + P3 candidate flagging are deterministic in the engine; P3 hoist op +
> P4/P5/P6 are LLM-executed per SKILL phase 4.5 guidance, riding on writeMode:
> reconcile. Kept below as the design record.

## Root cause (confirmed)
integrate-mode reuse is **in-place import**: a shared component lands in the
first page's folder (`cart/`) and later pages depend on it there. There is **no
hoist-to-common step** in the pipeline.
- `detect-boundaries` reuse → imports `matchedComponent.path` as-is (existing location).
- `plan-files` has **no `sharedDir`** — components only go to `outDir` (page folder).
  v0.4 chrome→Layout hoist covers the *layout shell* only, not general primitives.
- re-index + manifest record the cart-owned path as canonical → next page couples to `cart/`.

## Items (priority order)

### P1 — proactive shared placement (biggest effect, one place: plan-files)
- Add `config.sharedDir` (default `src/components/common`).
- In `plan-files`, route `shellRole:'chrome'` (header/nav/footer) AND general
  primitives (StatePanel, LoadingState/skeleton, icon sets) to `sharedDir`, not
  the page folder. → on the FIRST page, SiteHeader/SiteFooter are born in
  `common/`, so coupling never forms.

### P2 — dependency-direction lint (low cost, regression guard)
- After codegen, check "page/feature folders must not import each other".
- Emit `couplingViolations` in `reuse-decision.json` (this case = the 5
  `mypage → cart` imports). Author sees missed hoist immediately.

### P3 — reuse-time hoist (heaviest; reconcile/manifest entangled)
- In reuse matching: if the matched component lives in another page/feature
  folder, mark `hoistCandidate`. Ownership: under `common|shared|ui|layout` →
  shared; under a page folder → page-owned.
- Phase 4.5 hoist as one op: (a) move `cart/SiteHeader` → `common/SiteHeader`,
  (b) rewrite original owner imports + drop from `cart/index.ts` barrel,
  (c) new consumer imports from `common`, (d) update workspace-index + manifest
  canonical path → common. Lean on v0.5 `writeMode:reconcile` (surgical + diff).
- Policy: `config.hoistPolicy: 'chrome-always' | 'on-second-use' | 'manual'`.

### P4 — icon dedup
- Per-page `icons.tsx` overlap (AccountIcon, ErrorIcon) leaks as cross-import.
- Collect shared icons → `common/icons`, keep page-only icons local. Icons are
  `rawHTML` units → signature matching makes duplicate detection easy.

### P5 — partial-shared split
- Shell shared (StatePanel/LoadingState), content page-specific (EmptyState /
  ErrorState copy differs). Hoist unit must be the **reused node**, not the whole
  tree. boundaries is already node-level → hoist the shared node, keep the
  page-specific wrapper local.

### P6 — CSS hoists with the component
- Hoisting only the component but leaving CSS duplicated in `cart.css`/`mypage.css`
  is half a fix (shared chrome styles duplicated across two globals → conflict/
  leak risk, same family as the index.css scaffold issue).
- Tie component promotion to `css-to-modules`: move the shared component's
  authored rules to `common.css`. Aligns with the verify DOM/pixel gate.

## Suggested sequence
P1 (sharedDir + chrome/primitive proactive) → P2 (lint) → P3 (reuse-time hoist),
with P4/P5/P6 folded into P3.

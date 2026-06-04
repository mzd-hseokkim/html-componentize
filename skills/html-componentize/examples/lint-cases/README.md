# lint-deps regression fixture

Expected: exactly **1** violation — `mypage → cart` (same-layer component→component
coupling via alias). Everything else must stay clean:

| case | flagged? | why |
|---|---|---|
| `components/mypage → @/components/cart/SiteHeader` | **YES** | same layer (component), different feature → real coupling |
| `components/cart/StatesPreview → ./EmptyState` | no | same feature |
| `components/cart/StatesPreview → @/components/common/StatePanel` | no | shared |
| `pages/CartPage → @/components/cart/CartList` | no | cross-layer (page→component) = intended composition |
| `pages/HomePage.test.tsx → @/pages/HomePage` | no | test file, excluded from scan |

Guards: alias resolution (`@/…`), exact-segment match (`view` ⊄ `Preview`),
layer awareness (page→component allowed), feature = directory only (flat page
files aren't features), test/spec/stories excluded.

```
node ../../scripts/lint-deps.mjs \
  --root src --componentsDir src/components --sharedDir src/components/common \
  --out /tmp/coupling.json
# → violations: 1  (mypage → cart)
```

# lint-deps regression fixture

Expected: exactly **1** violation — `mypage → cart` (the aliased page→page import).
The same-feature (`./EmptyState`) and shared (`@/components/common/StatePanel`)
imports must NOT be flagged. Also guards against the `view` ⊂ `Preview` substring
false-positive.

```
node ../../scripts/lint-deps.mjs \
  --root src --componentsDir src/components --sharedDir src/components/common \
  --out /tmp/coupling.json
# → violations: 1  (mypage → cart)
```

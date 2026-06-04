# Vue codegen pattern (CSS Modules default, `<script setup>`)

Canonical idiom. Values from `data-spec.json` (verbatim), styles from
`css-to-modules.mjs` (verbatim) imported as a CSS Module.

## Item component — `Card.vue`

```vue
<script setup lang="ts">
import styles from './Card.module.css';
defineProps<{
  image: string;     // from data-spec props[].key + .type
  alt: string;
  cardTitle: string;
  cardDesc: string;
}>();
</script>

<template>
  <article :class="styles.card">
    <img :class="styles['card-img']" :src="image" :alt="alt" />
    <div :class="styles['card-body']">
      <h3 :class="styles['card-title']">{{ cardTitle }}</h3>
      <p :class="styles['card-desc']">{{ cardDesc }}</p>
    </div>
  </article>
</template>
```

Notes:
- CSS Modules in Vue: either `import styles from './x.module.css'` (above) or
  `<style module>`. Prefer the import so the emitted `.module.css` is reused as-is.
- `:class="styles.x"`; hyphenated class → bracket access.

## Data — `cards.data.ts`

```ts
// VERBATIM from data-spec.json groups[].data
export const cards = [
  { image: '/img/a.jpg', alt: 'Alpha', cardTitle: 'Alpha', cardDesc: 'First product in the lineup.' },
  { image: '/img/b.jpg', alt: 'Beta',  cardTitle: 'Beta',  cardDesc: 'Second product in the lineup.' },
  { image: '/img/c.jpg', alt: 'Gamma', cardTitle: 'Gamma', cardDesc: 'Third product in the lineup.' },
];
```

## List container (a `layout` node renders the v-for)

```vue
<script setup lang="ts">
import styles from './CardGrid.module.css';
import Card from './Card.vue';
import { cards } from './cards.data';
</script>

<template>
  <main :class="styles['card-grid']">
    <Card v-for="(c, i) in cards" :key="i" v-bind="c" />
  </main>
</template>
```

## Inline SVG / raw markup (`node.rawHTML` in source-map)

`svg`/`math` nodes carry a verbatim `rawHTML` outerHTML and no children. SVG is
valid in a Vue template, so prefer pasting it inline verbatim; or use `v-html`:

```vue
<button :class="styles['qty-button']" v-html="minusIconSvg" />
<!-- or paste the <svg>…</svg> directly into the template, unchanged -->
```

Never leave an empty `<button>` where the source had an icon.

## Web fonts & head assets (`source-map.document`)

`document.fontLinks` / `fontFaceCount` list fonts the ORIGINAL `<head>` loads
(Google Fonts `<link>`, `@font-face`). They aren't in any component — wire them
into `index.html` `<head>` and/or import the global stylesheet (`global.css`
from `css-to-modules --globals`, which holds `@font-face`) at the app entry, or
`font-family` falls back to the wrong font.

## Reuse (boundaries label = `reuse`)

Import the indexed `.vue` component and bind data-spec fields to its existing
`defineProps`. Unmappable fields → unknowns ledger, never invent a prop.

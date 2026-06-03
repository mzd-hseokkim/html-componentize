# React codegen pattern (CSS Modules default)

Canonical idiom the skill emits. Wiring is mechanical — values come from
`data-spec.json` (verbatim), styles from `css-to-modules.mjs` (verbatim).

## Item component — `Card.tsx`

```tsx
import styles from './Card.module.css';

export interface CardProps {
  image: string;   // from data-spec props[].key + .type
  alt: string;
  cardTitle: string;
  cardDesc: string;
}

export function Card({ image, alt, cardTitle, cardDesc }: CardProps) {
  return (
    <article className={styles.card}>
      <img className={styles['card-img']} src={image} alt={alt} />
      <div className={styles['card-body']}>
        <h3 className={styles['card-title']}>{cardTitle}</h3>
        <p className={styles['card-desc']}>{cardDesc}</p>
      </div>
    </article>
  );
}
```

Rules:
- `className={styles.x}` for every class in the classMap. Hyphenated → bracket access.
- Static text stays inline; only diffed fields become `{props}`.
- `.module.css` is the file emitted by `css-to-modules.mjs` — never hand-write styles.

## Data — `cards.data.ts`

```ts
import type { CardProps } from './Card';
// VERBATIM from data-spec.json groups[].data — do not retype, do not paraphrase
export const cards: CardProps[] = [
  { image: '/img/a.jpg', alt: 'Alpha', cardTitle: 'Alpha', cardDesc: 'First product in the lineup.' },
  { image: '/img/b.jpg', alt: 'Beta',  cardTitle: 'Beta',  cardDesc: 'Second product in the lineup.' },
  { image: '/img/c.jpg', alt: 'Gamma', cardTitle: 'Gamma', cardDesc: 'Third product in the lineup.' },
];
```

## List container (a `layout` node renders the map)

```tsx
import styles from './CardGrid.module.css';
import { Card } from './Card';
import { cards } from './cards.data';

export function CardGrid() {
  return (
    <main className={styles['card-grid']}>
      {cards.map((c, i) => <Card key={i} {...c} />)}
    </main>
  );
}
```

## Reuse (boundaries label = `reuse`)

Do NOT generate. Import the indexed component and map data-spec fields onto its
existing props (from `workspace-index.json` → `props`). If a field has no prop
to map to, add it to the unknowns ledger instead of inventing a prop.

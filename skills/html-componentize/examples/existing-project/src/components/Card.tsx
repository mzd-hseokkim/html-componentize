import styles from './Card.module.css';

export interface CardProps {
  imageUrl: string;
  imageAlt: string;
  title: string;
  description: string;
}

export function Card({ imageUrl, imageAlt, title, description }: CardProps) {
  return (
    <article className={styles.card}>
      <img className={styles.cardImg} src={imageUrl} alt={imageAlt} />
      <div className={styles.cardBody}>
        <h3 className={styles.cardTitle}>{title}</h3>
        <p className={styles.cardDesc}>{description}</p>
      </div>
    </article>
  );
}

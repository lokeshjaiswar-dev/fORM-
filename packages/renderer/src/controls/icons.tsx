import type { RatingConfig } from '@form/schema';

const PATHS: Readonly<Record<Exclude<RatingConfig['icon'], 'number'>, string>> = {
  star: 'M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.4l-5.8 3.1 1.1-6.5L2.6 9.4l6.5-.9z',
  heart: 'M12 20.3l-1.3-1.2C5.6 14.5 2.5 11.7 2.5 8.2 2.5 5.4 4.7 3.2 7.5 3.2c1.6 0 3.1.7 4.5 2 1.4-1.3 2.9-2 4.5-2 2.8 0 5 2.2 5 5 0 3.5-3.1 6.3-8.2 10.9z',
  thumb: 'M2.5 10.5h3.5v10H2.5zM8 20.5V10.3l4.6-7.3c.9-.4 2 .2 2 1.3v4.9h5.2c1.2 0 2.1 1.1 1.8 2.3l-1.9 7.2c-.3 1-1.2 1.8-2.3 1.8z',
  smiley: 'M12 2.5a9.5 9.5 0 1 0 0 19 9.5 9.5 0 0 0 0-19zM8.6 9.2a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6zm6.8 0a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6zM7.7 14.2h8.6c-.6 2-2.3 3.4-4.3 3.4s-3.7-1.4-4.3-3.4z',
};

/** A rating point: filled up to the selected value. */
export function RatingIcon({ icon, filled, value }: { icon: RatingConfig['icon']; filled: boolean; value: number }) {
  if (icon === 'number') return <span className="fr-point-number">{value}</span>;
  return (
    <svg className="fr-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" data-filled={filled ? '' : undefined}>
      <path d={PATHS[icon]} />
    </svg>
  );
}

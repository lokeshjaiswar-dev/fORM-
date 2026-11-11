import { themeImageUrl } from '../theme/media.ts';

/** Resolves an option's stored asset id to the picture shown on image-choice tiles. */
export function ChoicePicture({ image, label }: { image?: { assetId: string; alt?: string; decorative?: boolean } | undefined; label: string }) {
  const url = themeImageUrl(image?.assetId);
  if (!url) return <span className="fr-image-choice-fallback" />;
  return <img src={url} alt={image?.decorative === true ? '' : (image?.alt?.trim() || label)} />;
}

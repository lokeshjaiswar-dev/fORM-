import { rememberThemeImage } from '@form/renderer/author';

const KEY = 'formplus.themeMedia.v1';
const MAX = 64;

function read(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].startsWith('data:image/')));
  } catch {
    return {};
  }
}

/** Restores pictures uploaded in this browser so covers and backgrounds survive a reload. */
export function hydrateThemeImages(extra?: Record<string, string>): void {
  for (const [id, url] of Object.entries(read())) rememberThemeImage(id, url);
  if (!extra) return;
  for (const [id, url] of Object.entries(extra)) {
    if (typeof url === 'string' && url.startsWith('data:image/')) rememberThemeImage(id, url);
  }
}

function collectAssetIds(value: unknown, into: Set<string>): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectAssetIds(item, into));
    return;
  }
  const rec = value as Record<string, unknown>;
  if (typeof rec.assetId === 'string' && rec.assetId) into.add(rec.assetId);
  for (const nested of Object.values(rec)) collectAssetIds(nested, into);
}

/** Pictures used on this draft (image choice, cover, background) so a shared fill link can show them. */
export function themeMediaForDraft(draft: unknown): Record<string, string> {
  const ids = new Set<string>();
  collectAssetIds(draft, ids);
  if (ids.size === 0) return {};
  const stored = read();
  const media: Record<string, string> = {};
  for (const id of ids) {
    const url = stored[id];
    if (url) media[id] = url;
  }
  return media;
}

export function storeThemeImage(assetId: string, url: string): void {
  rememberThemeImage(assetId, url);
  const next = { ...read(), [assetId]: url };
  const ids = Object.keys(next);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX))) delete next[id];
  localStorage.setItem(KEY, JSON.stringify(next));
}

/** Shrinks a picked file to a JPEG data URL the theme can paint. */
export function fileToThemeImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read'));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('canvas'));
          return;
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.72));
      };
      img.onerror = () => reject(new Error('image'));
      img.src = typeof reader.result === 'string' ? reader.result : '';
    };
    reader.readAsDataURL(file);
  });
}

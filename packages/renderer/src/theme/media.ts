import type { ThemeTokens } from '@form/schema';

/**
 * Theme photos are asset ids. Built-in scenes ship as SVG data URLs (no remote hosts).
 * Uploaded pictures are registered at runtime and kept in the builder's local storage.
 */

const extra = new Map<string, string>();

const svg = (body: string) => `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800" preserveAspectRatio="xMidYMid slice">${body}</svg>`,
)}`;

export interface ThemeScene {
  id: string;
  name: string;
  url: string;
}

export const THEME_SCENES: readonly ThemeScene[] = [
  { id: 'scene-coast', name: 'Coast', url: svg(`<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#7dd3fc"/><stop offset=".45" stop-color="#38bdf8"/><stop offset=".72" stop-color="#0ea5e9"/><stop offset="1" stop-color="#155e75"/></linearGradient></defs><rect width="1200" height="800" fill="url(#g)"/><ellipse cx="220" cy="150" rx="90" ry="40" fill="#fff" opacity=".85"/><ellipse cx="280" cy="150" rx="60" ry="30" fill="#fff" opacity=".7"/><path d="M0 520 C200 470 320 560 520 520 C760 470 860 580 1200 500 V800 H0Z" fill="#0f766e"/><path d="M0 600 C240 540 400 660 680 600 C900 560 1040 640 1200 590 V800 H0Z" fill="#134e4a" opacity=".85"/>`) },
  { id: 'scene-dunes', name: 'Dunes', url: svg(`<rect width="1200" height="800" fill="#fdba74"/><circle cx="980" cy="140" r="70" fill="#fbbf24"/><path d="M0 420 C180 300 340 480 560 400 C820 300 900 460 1200 360 V800 H0Z" fill="#c2410c"/><path d="M0 560 C260 460 420 620 700 520 C960 430 1080 560 1200 500 V800 H0Z" fill="#9a3412"/>`) },
  { id: 'scene-forest', name: 'Forest', url: svg(`<rect width="1200" height="800" fill="#14532d"/><circle cx="180" cy="620" r="220" fill="#166534"/><circle cx="480" cy="560" r="260" fill="#15803d"/><circle cx="860" cy="600" r="280" fill="#166534"/><circle cx="1140" cy="540" r="200" fill="#14532d"/><circle cx="200" cy="120" r="50" fill="#fde68a" opacity=".9"/><rect y="640" width="1200" height="160" fill="#052e16"/>`) },
  { id: 'scene-city', name: 'Night city', url: svg(`<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#1e1b4b"/><stop offset="1" stop-color="#0f172a"/></linearGradient></defs><rect width="1200" height="800" fill="url(#g)"/><circle cx="180" cy="90" r="2" fill="#fff"/><circle cx="420" cy="60" r="1.5" fill="#fff"/><circle cx="700" cy="110" r="2" fill="#fff"/><circle cx="980" cy="40" r="1.5" fill="#fff"/><g fill="#312e81"><rect x="40" y="360" width="90" height="440"/><rect x="150" y="280" width="70" height="520"/><rect x="250" y="420" width="120" height="380"/><rect x="400" y="240" width="80" height="560"/><rect x="510" y="340" width="140" height="460"/><rect x="680" y="200" width="90" height="600"/><rect x="800" y="380" width="110" height="420"/><rect x="940" y="300" width="80" height="500"/><rect x="1050" y="440" width="120" height="360"/></g><g fill="#fbbf24"><rect x="60" y="400" width="14" height="18"/><rect x="170" y="320" width="12" height="16"/><rect x="430" y="280" width="12" height="16"/><rect x="700" y="250" width="14" height="18"/><rect x="960" y="360" width="12" height="16"/></g>`) },
  { id: 'scene-studio', name: 'Studio', url: svg(`<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#f8fafc"/><stop offset=".5" stop-color="#e2e8f0"/><stop offset="1" stop-color="#cbd5e1"/></linearGradient></defs><rect width="1200" height="800" fill="url(#g)"/><circle cx="900" cy="160" r="180" fill="#fff" opacity=".7"/><rect x="0" y="620" width="1200" height="180" fill="#94a3b8" opacity=".25"/>`) },
  { id: 'scene-bloom', name: 'Bloom', url: svg(`<rect width="1200" height="800" fill="#fce7f3"/><circle cx="200" cy="200" r="160" fill="#f9a8d4" opacity=".8"/><circle cx="980" cy="180" r="200" fill="#fb7185" opacity=".55"/><circle cx="640" cy="680" r="260" fill="#f472b6" opacity=".45"/><circle cx="360" cy="520" r="90" fill="#fff" opacity=".5"/>`) },
  { id: 'scene-aurora', name: 'Aurora', url: svg(`<rect width="1200" height="800" fill="#020617"/><path d="M0 260 C200 80 300 420 520 240 C760 40 900 380 1200 180 V420 C980 520 760 280 520 400 C280 520 160 300 0 420Z" fill="#22d3ee" opacity=".55"/><path d="M0 340 C240 200 360 500 640 320 C900 160 1000 420 1200 300 V500 C900 620 700 360 460 480 C220 600 120 380 0 500Z" fill="#a78bfa" opacity=".45"/>`) },
  { id: 'scene-summit', name: 'Summit', url: svg(`<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#7dd3fc"/><stop offset="1" stop-color="#e0f2fe"/></linearGradient></defs><rect width="1200" height="800" fill="url(#g)"/><path d="M0 800 L280 320 L460 560 L700 180 L980 520 L1200 300 V800Z" fill="#334155"/><path d="M620 260 L700 180 L790 280 L700 250Z" fill="#fff"/><path d="M200 420 L280 320 L360 430 L280 390Z" fill="#fff" opacity=".85"/>`) },
  { id: 'scene-botanical', name: 'Botanical', url: svg(`<rect width="1200" height="800" fill="#ecfccb"/><g fill="none" stroke="#3f6212" stroke-width="8"><path d="M80 800 C120 500 60 300 180 80"/><path d="M180 80 C240 160 200 220 260 280"/><path d="M1040 800 C1000 480 1100 300 980 60"/><path d="M980 60 C900 160 960 240 880 320"/></g><ellipse cx="600" cy="420" rx="180" ry="80" fill="#84cc16" opacity=".35"/><circle cx="600" cy="400" r="70" fill="#65a30d"/>`) },
  { id: 'scene-confetti', name: 'Celebration', url: svg(`<rect width="1200" height="800" fill="#fff7ed"/><g><rect x="80" y="80" width="36" height="14" fill="#f97316" transform="rotate(20 80 80)"/><rect x="240" y="160" width="28" height="12" fill="#2563eb" transform="rotate(-15 240 160)"/><rect x="480" y="70" width="40" height="14" fill="#db2777" transform="rotate(30 480 70)"/><rect x="760" y="140" width="32" height="12" fill="#16a34a" transform="rotate(-25 760 140)"/><rect x="980" y="60" width="36" height="14" fill="#7c3aed" transform="rotate(12 980 60)"/><rect x="160" y="360" width="30" height="12" fill="#eab308" transform="rotate(40 160 360)"/><rect x="640" y="300" width="34" height="12" fill="#0ea5e9" transform="rotate(-20 640 300)"/><rect x="900" y="420" width="28" height="12" fill="#f43f5e" transform="rotate(18 900 420)"/></g><circle cx="600" cy="640" r="220" fill="#fdba74" opacity=".45"/>`) },
  { id: 'scene-ink', name: 'Ink wash', url: svg(`<rect width="1200" height="800" fill="#0f172a"/><circle cx="300" cy="300" r="240" fill="#1e293b"/><circle cx="860" cy="480" r="300" fill="#334155" opacity=".7"/><circle cx="980" cy="140" r="80" fill="#e2e8f0" opacity=".15"/>`) },
  { id: 'scene-citrus', name: 'Citrus', url: svg(`<rect width="1200" height="800" fill="#fef9c3"/><circle cx="280" cy="260" r="160" fill="#facc15"/><circle cx="280" cy="260" r="70" fill="#fef08a"/><circle cx="920" cy="520" r="200" fill="#f59e0b" opacity=".8"/><circle cx="920" cy="520" r="80" fill="#fde68a"/>`) },
];

const STOCK = new Map(THEME_SCENES.map((scene) => [scene.id, scene.url]));

export function rememberThemeImage(assetId: string, url: string): void {
  extra.set(assetId, url);
}

export function themeImageUrl(assetId: string | undefined): string | undefined {
  if (!assetId) return undefined;
  return extra.get(assetId) ?? STOCK.get(assetId);
}

export function pagePhoto(tokens: ThemeTokens): { url: string; fit: 'cover' | 'contain' | 'tile' } | undefined {
  const background = tokens.background;
  if (background?.kind !== 'image') return undefined;
  const url = themeImageUrl(background.image.assetId);
  return url ? { url, fit: background.fit } : undefined;
}

export function coverPhoto(tokens: ThemeTokens): { url: string; heightPx: number } | undefined {
  const cover = tokens.cover;
  if (!cover) return undefined;
  const url = themeImageUrl(cover.image.assetId);
  return url ? { url, heightPx: cover.heightPx } : undefined;
}

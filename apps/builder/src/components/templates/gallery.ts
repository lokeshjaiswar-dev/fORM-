import { lazy } from 'react';

/* The gallery, the template engine and the bundled pack are their own chunk, outside the main one (BL-123). */
export const loadGallery = () => import('@/components/templates/TemplateGallery');
export const TemplateGallery = lazy(loadGallery);

/** Fetches the gallery chunk once the page is idle, so the New-form gallery also opens with the network gone. */
export function preloadGallery(): void {
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 1000));
  idle(() => void loadGallery().catch(() => {}));
}

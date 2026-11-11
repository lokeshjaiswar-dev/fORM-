import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
}

if (typeof Element !== 'undefined') {
  Object.defineProperty(Element.prototype, 'hasPointerCapture', { configurable: true, value: () => false });
  Object.defineProperty(Element.prototype, 'setPointerCapture', { configurable: true, value: () => undefined });
  Object.defineProperty(Element.prototype, 'releasePointerCapture', { configurable: true, value: () => undefined });
}
if (typeof HTMLElement !== 'undefined') {
  HTMLElement.prototype.scrollIntoView = () => undefined;
  HTMLElement.prototype.scrollTo = () => undefined;
}
if (typeof Element !== 'undefined' && !Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => undefined;
}
if (typeof ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver;
}
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

afterEach(() => {
  cleanup();
});

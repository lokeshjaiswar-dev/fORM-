import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;

/* jsdom has no layout; ProseMirror asks for rectangles when it scrolls the selection into view. */
const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
Range.prototype.getBoundingClientRect = () => rect;
Range.prototype.getClientRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
document.elementFromPoint = () => null;

afterEach(() => {
  cleanup();
});

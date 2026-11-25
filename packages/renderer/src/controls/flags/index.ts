/// <reference types="vite/client" />
/*
 * Our own country flags for the phone picker (emoji flags do not render on Windows: it shows the letters "IN").
 * The SVGs are country-flag-icons 3x2 (MIT, see LICENSE), one file per calling-code region. This module is only ever
 * imported lazily (phone.tsx), and each flag is its own chunk, so a form loads exactly the flag it shows.
 */
const FLAGS = import.meta.glob<string>('./svg/*.svg', { query: '?url', import: 'default' });

/** The image URL of a region's flag (a small `data:` URL or a same-origin file), or undefined when there is none. */
export async function flagUrl(region: string): Promise<string | undefined> {
  const load = FLAGS[`./svg/${region}.svg`];
  return load ? load() : undefined;
}

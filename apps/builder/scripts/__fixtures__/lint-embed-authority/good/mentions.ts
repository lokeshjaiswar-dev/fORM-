/*
 * Words in comments do not count: document.cookie, localStorage, sessionStorage, indexedDB, cookieStore.
 */
const note = 'document.cookie and localStorage are never read here';
const shape = { localStorage: 1, cookie: 2, indexedDB: 3 };
const other = { cookie: 'x', sessionStorage: 'y' } as { cookie: string; sessionStorage: string };
export const text = (): string => `${note} ${shape.localStorage} ${other.cookie} ${other.sessionStorage}`;

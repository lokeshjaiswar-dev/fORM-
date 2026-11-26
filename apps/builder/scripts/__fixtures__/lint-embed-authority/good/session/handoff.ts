// the one file that may use sessionStorage
export const take = (): string | null => globalThis.sessionStorage?.getItem('fp.lv') ?? null;
export const drop = (): void => sessionStorage.removeItem('fp.lv');

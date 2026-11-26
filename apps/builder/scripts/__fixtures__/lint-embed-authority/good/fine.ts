export const get = (url: string): Promise<Response> => fetch(url, { credentials: 'omit' });

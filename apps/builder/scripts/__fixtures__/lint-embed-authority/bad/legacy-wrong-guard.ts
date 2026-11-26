export async function load() {
  if (import.meta.env.MODE === 'development') {
    return import('./legacy/cookieToken');
  }
  return null;
}

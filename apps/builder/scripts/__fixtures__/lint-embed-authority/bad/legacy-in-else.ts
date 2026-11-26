export async function load() {
  if (import.meta.env.VITE_FP_LEGACY_DESCRIPTOR === '1') {
    return null;
  } else {
    return import('./legacy/cookieToken');
  }
}

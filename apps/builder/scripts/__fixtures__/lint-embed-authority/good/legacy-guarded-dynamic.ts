export async function load() {
  if (import.meta.env.VITE_FP_LEGACY_DESCRIPTOR === '1') {
    const legacy = await import('./legacy/cookieToken');
    return legacy.token();
  }
  return null;
}

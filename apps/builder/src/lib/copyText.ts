/**
 * Copy text on http LAN hosts as well as https. `navigator.clipboard` is missing or throws
 * outside a secure context (plain http on an IP, as on the VM).
 */
export async function copyText(text: string): Promise<void> {
  if (globalThis.isSecureContext !== false && typeof navigator.clipboard?.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* Fall through to the execCommand path. */
    }
  }
  const el = document.createElement('textarea');
  el.value = text;
  el.setAttribute('readonly', '');
  el.style.position = 'fixed';
  el.style.left = '-9999px';
  document.body.appendChild(el);
  el.select();
  el.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } finally {
    el.remove();
  }
  if (!ok) throw new Error('copy failed');
}

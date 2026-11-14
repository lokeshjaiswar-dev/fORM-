/** Whether the asynchronous Clipboard API can be used here. It is missing outside a secure context (plain http on a LAN IP). */
export const clipboardAvailable = (): boolean =>
  globalThis.isSecureContext !== false && typeof navigator.clipboard?.writeText === 'function';

/**
 * Copies `text` with the Clipboard API. Resolves `true` when it was copied and `false` when this browser gives no way to
 * do it (the API is missing, as on http://192.168.x.x, or the browser refused). The caller then shows the text for the
 * person to copy by hand: see `CopyLink`. There is deliberately no hidden-textarea fallback; it needs a deprecated
 * document command and still fails silently in some browsers.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!clipboardAvailable()) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function protocolOf(url: string) {
  try {
    return new URL(url.trim()).protocol;
  } catch {
    return null;
  }
}

export function safeRedirectUrl(url: string) {
  const protocol = protocolOf(url);
  return protocol === 'https:' || protocol === 'http:' ? url.trim() : null;
}

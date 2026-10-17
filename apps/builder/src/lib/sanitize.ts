import createDOMPurify from 'dompurify';

const LINK_PROTOCOLS = ['https:', 'http:', 'mailto:', 'tel:'];
export const LINK_REL = 'noopener noreferrer nofollow';

const purify = createDOMPurify(window);

purify.addHook('afterSanitizeAttributes', (node) => {
  if (!(node instanceof HTMLElement)) return;
  if (node.hasAttribute('style')) {
    const { color, backgroundColor } = node.style;
    node.removeAttribute('style');
    if (color) node.style.color = color;
    if (backgroundColor) node.style.backgroundColor = backgroundColor;
    if (!node.getAttribute('style')) node.removeAttribute('style');
  }
  if (node.tagName === 'A') {
    if (!isSafeLink(node.getAttribute('href') ?? '')) node.removeAttribute('href');
    node.setAttribute('rel', LINK_REL);
    node.setAttribute('target', '_blank');
  }
});

export function sanitizeHtml(html: string) {
  return purify.sanitize(html, {
    ALLOWED_TAGS: ['b', 'i', 'u', 's', 'a', 'span', 'br', 'p'],
    ALLOWED_ATTR: ['href', 'style'],
    ALLOWED_URI_REGEXP: /^(?:https?|mailto|tel):/i,
  });
}

export function escapeHtml(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function protocolOf(url: string) {
  try {
    return new URL(url.trim()).protocol;
  } catch {
    return null;
  }
}

export function isSafeLink(url: string) {
  const protocol = protocolOf(url);
  return !!protocol && LINK_PROTOCOLS.includes(protocol);
}

export function safeRedirectUrl(url: string) {
  const protocol = protocolOf(url);
  return protocol === 'https:' || protocol === 'http:' ? url.trim() : null;
}

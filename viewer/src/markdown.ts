import { marked } from 'marked';
import DOMPurify from 'dompurify';

/** Resolves a repository-relative link or image target to a viewer URL, or null when unavailable. */
export type MarkdownResourceUrl = (target: string, image: boolean) => string | null;
export type RenderMarkdownPreview = (source: string, resourceUrl: MarkdownResourceUrl) => string;

declare global {
  interface Window { renderMarkdownPreview?: RenderMarkdownPreview }
}

// Keep repository markup out of the viewer's action and styling namespaces.
window.renderMarkdownPreview = (source, resourceUrl) => {
  const clean = DOMPurify.sanitize(marked.parse(source, { gfm: true, async: false }), {
    ALLOWED_TAGS: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'em', 'strong', 'del', 'a', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input', 'img'],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'type', 'checked', 'disabled', 'start'],
    ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
  });
  const template = document.createElement('template');
  template.innerHTML = clean;
  for (const input of template.content.querySelectorAll('input')) {
    input.type = 'checkbox'; input.disabled = true;
  }
  for (const element of template.content.querySelectorAll<HTMLAnchorElement | HTMLImageElement>('a, img')) {
    const image = element.tagName === 'IMG';
    const attr = image ? 'src' : 'href';
    const value = element.getAttribute(attr);
    let resolved: string | null = null;
    if (value && !/[\u0000- \u007f\\]/.test(value)) {
      if (/^https?:\/\//i.test(value) || (!image && /^mailto:/i.test(value))) resolved = value;
      else if (!/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.startsWith('//')) resolved = resourceUrl(value, image);
    }
    if (resolved) {
      element.setAttribute(attr, resolved);
      if (!image) { const anchor = element as HTMLAnchorElement; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; }
      else element.setAttribute('referrerpolicy', 'no-referrer');
    } else {
      element.removeAttribute(attr);
      element.setAttribute('title', 'Target unavailable in this preview');
      if (!image) element.setAttribute('aria-disabled', 'true');
    }
  }
  return template.innerHTML;
};

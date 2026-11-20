import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { joinHintList, labelHint } from './tooltips';

/** Resolves a repository-relative link or image target to a viewer URL, or null when unavailable. */
export type MarkdownResourceUrl = (target: string, image: boolean) => string | null;
export type RenderMarkdownPreview = (source: string, resourceUrl: MarkdownResourceUrl) => string;

declare global {
  interface Window { renderMarkdownPreview?: RenderMarkdownPreview }
}

// An absolute URL naming this machine could reach this or another review viewer;
// those take their resources only from the viewer's own resource URLs.
function viewerAddress(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === window.location.hostname.toLowerCase() || host === 'localhost' || host.endsWith('.localhost') ||
      host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host) || host === '0.0.0.0';
  } catch { return true; }
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
      if (/^https?:\/\//i.test(value)) resolved = viewerAddress(value) ? null : value;
      else if (!image && /^mailto:/i.test(value)) resolved = value;
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
  showTitlesAsTooltips(template.content);
  return template.innerHTML;
};

// The viewer shows titles in its own tooltip (see tooltips.ts). A link is the
// keyboard stop for the hints of the parts it holds, such as an image, and also
// names a part whose title repeats its text while the layout cuts that part off.
function showTitlesAsTooltips(root: DocumentFragment): void {
  const titled = [...root.querySelectorAll('[title]')];
  // Per link, the hints of its parts that always show, and all of them.
  const parts = new Map<Element, { shown: string[]; all: string[] }>();
  for (const element of titled) {
    const owner = element.parentElement?.closest('a');
    const own = labelHint(element.getAttribute('title') || '', element.textContent || '');
    const hint = own.tooltip || own.clipped;
    if (!owner || !hint) continue;
    let held = parts.get(owner);
    if (!held) parts.set(owner, held = { shown: [], all: [] });
    if (own.tooltip) held.shown.push(hint);
    held.all.push(hint);
  }
  for (const element of new Set([...titled, ...parts.keys()])) {
    const title = element.getAttribute('title') || '';
    const { shown = [], all = [] } = parts.get(element) || {};
    const hint = labelHint(title, element.textContent || '', shown);
    element.removeAttribute('title');
    if (hint.tooltip) element.setAttribute('data-tooltip', hint.tooltip);
    if (hint.clipped || all.length > shown.length) element.setAttribute('data-tooltip-clipped', joinHintList([title, ...all]));
    if (hint.clipped) element.setAttribute('data-clippable', '');
  }
}

import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { joinHintList, joinHints, labelHint } from './tooltips';

/** Resolves a repository-relative link or image target to a viewer URL, or null when unavailable. */
export type MarkdownResourceUrl = (target: string, image: boolean) => string | null;
export type RenderMarkdownPreview = (source: string, resourceUrl: MarkdownResourceUrl) => string;

declare global {
  interface Window { renderMarkdownPreview?: RenderMarkdownPreview }
}

// An absolute URL naming this machine could reach this or another review viewer.
// The browser loads images by itself, so those come only from the viewer's own
// resource URLs; links open only when the reviewer follows them.
function viewerAddress(value: string): boolean {
  try {
    // A final dot names the same host.
    const host = new URL(value).hostname.toLowerCase().replace(/\.$/, '');
    return host === window.location.hostname.toLowerCase().replace(/\.$/, '') || host === 'localhost' || host.endsWith('.localhost') ||
      host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host) || host === '0.0.0.0' || host === '[::]' ||
      // IPv6 addresses that embed one of the IPv4 addresses above.
      /^\[::ffff:(?:7f[0-9a-f]{2}:[0-9a-f]{1,4}|0:0)\]$/.test(host);
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
  const unavailable = new Set<Element>();
  for (const element of template.content.querySelectorAll<HTMLAnchorElement | HTMLImageElement>('a, img')) {
    const image = element.tagName === 'IMG';
    const attr = image ? 'src' : 'href';
    const value = element.getAttribute(attr);
    let resolved: string | null = null;
    if (value && !/[\u0000- \u007f\\]/.test(value)) {
      if (/^https?:\/\//i.test(value)) resolved = image && viewerAddress(value) ? null : value;
      else if (!image && /^mailto:/i.test(value)) resolved = value;
      else if (!/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.startsWith('//')) resolved = resourceUrl(value, image);
    }
    if (resolved) {
      element.setAttribute(attr, resolved);
      if (!image) { const anchor = element as HTMLAnchorElement; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; }
      else element.setAttribute('referrerpolicy', 'no-referrer');
    } else {
      element.removeAttribute(attr);
      unavailable.add(element);
      if (!image) element.setAttribute('aria-disabled', 'true');
    }
  }
  showTitlesAsTooltips(template.content, unavailable);
  return template.innerHTML;
};

// Elements that take no keyboard focus here: checkboxes are always disabled.
const UNFOCUSABLE = new Set(['INPUT', 'BR']);
const UNAVAILABLE = 'Target unavailable in this preview';

// The viewer shows titles in its own tooltip (see tooltips.ts). A link is the
// keyboard stop for the hints of the parts it holds, such as an image, and also
// names a part whose title repeats its text while the layout cuts that part off.
// The parent of an element that takes no focus holds its hint the same way.
// Every other element with a hint becomes a keyboard stop of its own, so the
// keyboard reaches each hint the pointer does; elements without one get none.
// A link or image whose target is unavailable says so after its own title.
function showTitlesAsTooltips(root: DocumentFragment, unavailable: ReadonlySet<Element>): void {
  // The titles as written, before any is replaced by a hint.
  const authored = new Map<Element, string>();
  for (const element of root.querySelectorAll('[title], a, img')) {
    if (element.hasAttribute('title') || unavailable.has(element)) authored.set(element, element.getAttribute('title') || '');
  }
  const titled = [...authored.keys()];
  const titleOf = (element: Element) => joinHints(authored.get(element), unavailable.has(element) ? UNAVAILABLE : '');
  // An element that takes no focus and has no parent to hold its hint gets one.
  for (const element of titled) {
    if (!UNFOCUSABLE.has(element.tagName) || element.parentElement) continue;
    const holder = document.createElement('span');
    element.replaceWith(holder);
    holder.append(element);
  }
  // Per link or parent, the hints of its parts that always show, and all of them.
  const parts = new Map<Element, { shown: string[]; all: string[] }>();
  for (const element of titled) {
    const owner = element.parentElement?.closest('a') || (UNFOCUSABLE.has(element.tagName) ? element.parentElement : null);
    const own = labelHint(titleOf(element), element.textContent || '');
    const hint = own.tooltip || own.clipped;
    if (!owner || !hint) continue;
    let held = parts.get(owner);
    if (!held) parts.set(owner, held = { shown: [], all: [] });
    if (own.tooltip) held.shown.push(hint);
    held.all.push(hint);
  }
  for (const element of new Set([...titled, ...parts.keys()])) {
    const title = titleOf(element);
    const { shown = [], all = [] } = parts.get(element) || {};
    const hint = labelHint(title, element.textContent || '', shown);
    element.removeAttribute('title');
    if (hint.tooltip) element.setAttribute('data-tooltip', hint.tooltip);
    if (hint.clipped || all.length > shown.length) element.setAttribute('data-tooltip-clipped', joinHintList([title, ...all]));
    if (hint.clipped) element.setAttribute('data-clippable', '');
    const inLink = element.parentElement?.closest('a');
    // Without its title, a link or image the title alone named would have no name.
    if (!inLink && (element.tagName === 'A' || element.tagName === 'IMG') && !hasContentName(element)) {
      const name = joinHintList([authored.get(element), ...[...element.querySelectorAll('img')].map((img) => authored.get(img))]);
      if (name) element.setAttribute('aria-label', name);
    }
    const hinted = element.hasAttribute('data-tooltip') || element.hasAttribute('data-tooltip-clipped');
    // A link's parts share its stop, and a focusable inside a link is invalid.
    if (!hinted || UNFOCUSABLE.has(element.tagName) || inLink) continue;
    if (element.tagName === 'A') {
      if (element.hasAttribute('href')) continue;
      // A link without a usable target stays a link, disabled but focusable.
      element.setAttribute('role', 'link');
    }
    element.setAttribute('tabindex', '0');
  }
  // Chromium makes a part that scrolls a keyboard stop of its own, which inside
  // a link would be a second stop for it.
  for (const scroller of root.querySelectorAll('a :is(pre, table)')) scroller.setAttribute('tabindex', '-1');
}

/** Whether a link or image is named by what it shows: its text, or an image's description. */
function hasContentName(element: Element): boolean {
  if (element.tagName === 'IMG') return Boolean(element.getAttribute('alt')?.trim());
  return Boolean(element.textContent?.trim()) || [...element.querySelectorAll('img')].some(hasContentName);
}

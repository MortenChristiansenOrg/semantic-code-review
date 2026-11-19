import { marked } from 'marked';
import DOMPurify from 'dompurify';

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
  for (const element of template.content.querySelectorAll('a, img')) {
    const image = element.tagName === 'IMG';
    const attr = image ? 'src' : 'href';
    const value = element.getAttribute(attr);
    let resolved = null;
    if (value && !/[\u0000-\u0020\u007f\\]/.test(value)) {
      if (/^https?:\/\//i.test(value) || (!image && /^mailto:/i.test(value))) resolved = value;
      else if (!/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.startsWith('//')) resolved = resourceUrl(value, image);
    }
    if (resolved) {
      element.setAttribute(attr, resolved);
      if (!image) { element.target = '_blank'; element.rel = 'noopener noreferrer'; }
      else element.setAttribute('referrerpolicy', 'no-referrer');
    } else {
      element.removeAttribute(attr);
      element.setAttribute('title', 'Target unavailable in this preview');
      if (!image) element.setAttribute('aria-disabled', 'true');
    }
  }
  return template.innerHTML;
};

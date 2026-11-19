// Applies legacy HTML strings to the page while keeping the DOM that did not
// change. Regions still built from strings use this until they move to lit
// templates; the keyed reconciler goes away with the last of them.
import { noChange, type ChildPart } from "lit-html";
import { Directive, directive, PartType, type PartInfo } from "lit-html/directive.js";

interface RenderSnapshot {
  markup: string;
  attributes: Map<string, string>;
}

// Keep the last requested markup separate from the live DOM. Unchanged
// subtrees retain scroll, selection, image state and running animations.
const renderedNodes = new WeakMap<Element, RenderSnapshot>();
// The attributes that identify an element of the legacy diff panel.
const identity = ["data-render-key", "id", "data-stage", "data-action", "data-id", "data-kind", "data-node-id", "data-mode"];

function renderKey(node: Node): string {
  if (!(node instanceof Element)) return String(node.nodeType);
  return JSON.stringify([node.tagName, (node.getAttribute("class") || "").split(/\s+/)[0], ...identity.map((key) => node.getAttribute(key))]);
}
function renderSnapshot(node: Element): RenderSnapshot {
  // Store values, not detached nodes whose parent links would keep entire
  // obsolete page trees alive for every independently updated component.
  return { markup: node.outerHTML, attributes: new Map(Array.from(node.attributes, (attr) => [attr.name, attr.value])) };
}
function rememberRendered(node: Node, template: Node): void {
  if (node instanceof Element && template instanceof Element) renderedNodes.set(node, renderSnapshot(template));
  Array.from(node.childNodes).forEach((child, index) => rememberRendered(child, template.childNodes[index]!));
}
function nodesBetween(parent: Node, start: Node | null, end: Node | null): Node[] {
  const nodes: Node[] = [];
  for (let node = start ? start.nextSibling : parent.firstChild; node && node !== end; node = node.nextSibling) nodes.push(node);
  return nodes;
}

/** Marks an empty element in legacy markup whose content lit renders. The
 * reconciler keeps such an element's children; give it a `data-render-key` so
 * it is never reused for another element. */
export const LIT_ISLAND = "data-lit-island";

/** Makes the children of `parent` between `start` and `end` (both exclusive;
 * null means the parent's edge) match the children of `next`, reusing nodes
 * with the same key so unchanged elements keep their state. */
export function patchChildren(parent: Node, next: Node, start: Node | null = null, end: Node | null = null): void {
  const available = new Map<string, Node[]>();
  for (const node of nodesBetween(parent, start, end)) {
    const key = renderKey(node);
    if (!available.has(key)) available.set(key, []);
    available.get(key)!.push(node);
  }
  const matches = Array.from(next.childNodes, (desired) => ({ desired, existing: available.get(renderKey(desired))?.shift() }));
  // Remove obsolete siblings first: otherwise their surviving neighbours
  // would be needlessly moved, restarting animations and losing focus.
  for (const nodes of available.values()) for (const node of nodes) parent.removeChild(node);
  let cursor = start ? start.nextSibling : parent.firstChild;
  for (const { desired, existing } of matches) {
    const node = existing || desired.cloneNode(true);
    if (!existing) rememberRendered(node, desired);
    else if (node instanceof Element) patchElement(node, desired as Element);
    else if (node.nodeValue !== desired.nodeValue) node.nodeValue = desired.nodeValue;
    if (node !== cursor) parent.insertBefore(node, cursor);
    cursor = node.nextSibling;
  }
}

/** Updates `node` in place to match `next`, skipping it when the markup last
 * applied to it is unchanged. */
export function patchElement(node: Element, next: Element): void {
  const previous = renderedNodes.get(node);
  const snapshot = renderSnapshot(next);
  if (previous?.markup === snapshot.markup) return;
  for (const name of (previous?.attributes || renderSnapshot(node).attributes).keys()) {
    if (next.hasAttribute(name)) continue;
    node.removeAttribute(name);
    // The tooltip enhancer moves a title into these; they go with it.
    if (name === "title") { node.removeAttribute("data-tooltip"); node.removeAttribute("data-tooltip-title"); }
  }
  for (const attr of next.attributes) {
    if (!previous || previous.attributes.get(attr.name) !== attr.value) node.setAttribute(attr.name, attr.value);
  }
  // lit renders an island's content; its key keeps it the same island.
  if (!next.hasAttribute(LIT_ISLAND)) patchChildren(node, next);
  renderedNodes.set(node, snapshot);
}

class LegacyHtmlDirective extends Directive {
  // lit commits `content` to the part once and keeps it while it receives the
  // same object back, so later updates patch in place. Because lit knows the
  // part holds content, switching the binding to anything else clears it.
  private anchor: Comment | null = null;
  private content: DocumentFragment | null = null;

  constructor(info: PartInfo) {
    super(info);
    if (info.type !== PartType.CHILD) throw new Error("legacyHtml() can only be used as child content.");
  }
  render(_markup: string): unknown {
    return noChange;
  }
  override update(part: ChildPart, [markup]: Parameters<this["render"]>): unknown {
    const next = document.createElement("div");
    next.innerHTML = markup;
    const anchor = this.anchor;
    if (anchor && this.content && anchor.parentNode && anchor.parentNode === part.startNode?.parentNode) {
      patchChildren(anchor.parentNode, next, anchor, part.endNode);
      return this.content;
    }
    // First render, or the part showed other content since: hand lit new nodes
    // after an anchor that marks where the legacy range starts.
    const content = document.createDocumentFragment();
    this.anchor = document.createComment("");
    content.append(this.anchor);
    for (const node of Array.from(next.childNodes)) {
      rememberRendered(node, node);
      content.append(node);
    }
    this.content = content;
    return content;
  }
}

/** Renders a legacy HTML string in place of the binding. The markup must
 * escape every value itself; nodes are reused by key between renders. */
export const legacyHtml = directive(LegacyHtmlDirective);

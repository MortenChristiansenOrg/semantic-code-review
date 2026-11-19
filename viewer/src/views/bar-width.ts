import { noChange } from "lit-html";
import { Directive, directive, PartType, type ElementPart, type PartInfo } from "lit-html/directive.js";

/** The share of `done` in `total` as a whole percentage; 0 when there is nothing to do. */
export function percentOf(done: number, total: number): number {
  return total ? Math.round((done / total) * 100) : 0;
}

class BarWidthDirective extends Directive {
  constructor(info: PartInfo) {
    super(info);
    if (info.type !== PartType.ELEMENT) throw new Error("barWidth() can only be used on an element.");
  }
  render(_percent: number): unknown {
    return noChange;
  }
  override update(part: ElementPart, [percent]: Parameters<this["render"]>): unknown {
    // The CSSOM is allowed by a content security policy that blocks style attributes.
    (part.element as HTMLElement).style.width = `${percent}%`;
    return noChange;
  }
}

/** Sets a progress bar's width as a percentage, e.g. `<i ${barWidth(40)}></i>`. */
export const barWidth = directive(BarWidthDirective);

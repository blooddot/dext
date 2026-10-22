/**
 * Diagnostic for the conversation scroll port (`#result-body`).
 *
 * A scrollbar can only "lie" in three ways, and they have different causes:
 *
 *   1. The range outruns the content that is in flow: a bottom margin that
 *      collapses out of `#result`, a float, or a `transform` that moves painted
 *      content past its layout box. Then the thumb stops short of the track's
 *      end and dragging it to the end walks into blank space.
 *   2. The content is laid out but not painted - `visibility: hidden`, an
 *      ancestor with `opacity: 0`, `content-visibility: hidden`, or a box
 *      clipped away by an ancestor. The range stays honest, so the old range
 *      diagnostic said nothing, while the reader sees blank space where the
 *      newest output should be.
 *   3. The port itself is covered or clipped - it extends below the visible
 *      area, so pinning to the range's end still leaves the newest output out
 *      of view and no correction can fix it.
 *
 * Enable logging in the Webview DevTools console with `dextScrollWatch = true`;
 * `dextScrollReport()` returns the same measurement on demand.
 */

export interface ScrollProbeTargets {
  /** The scroll port (`#result-body`). */
  body: HTMLElement;
  /** The content the port scrolls (`#result`). */
  result: HTMLElement;
}

export interface ScrollBox {
  label: string;
  /** Distance past the in-flow content, in scroll coordinates. */
  past: number;
  height: number;
  position: string;
  marginBottom: string;
  transform: string;
  /** Ancestors between the box and `#result`, innermost first. */
  chain: string;
}

export interface ScrollProbeReport {
  at: string;
  port: { top: number; bottom: number; height: number; visibleBottom: number; covered: number };
  scroll: { scrollTop: number; max: number; gap: number; clientHeight: number; scrollHeight: number };
  content: {
    resultTop: number;
    resultBottom: number;
    paintedBottom: number;
    inFlowBottom: number;
    /** Range past the in-flow content. */
    excess: number;
    /** Range past everything painted: blank space at the reading end. */
    phantom: number;
    /** Painted content the reader can never bring on screen. */
    unreachable: number;
  };
  margins: { last: string; marginBottom: number; resultPaddingBottom: number };
  innerScrollers: string[];
  culprits: ScrollBox[];
  unpainted: ScrollBox[];
  innerClips: ScrollBox[];
}

const MAX_BOXES = 8;

function number(value: number): number {
  return Math.round(value);
}

function label(element: Element): string {
  const id = element.id ? `#${element.id}` : "";
  const className = typeof element.className === "string" && element.className
    ? `.${element.className.trim().split(/\s+/).slice(0, 2).join(".")}`
    : "";
  return `${element.tagName.toLowerCase()}${id}${className}`.slice(0, 72);
}

function chain(element: Element, stop: Element): string {
  const parts: string[] = [];
  let current: Element | null = element.parentElement;
  while (current && current !== stop && parts.length < 4) {
    const style = getComputedStyle(current);
    parts.push(`${label(current)}[${style.overflow}/${style.visibility}]`);
    current = current.parentElement;
  }
  return parts.join(" < ");
}

/** The part of the port's box the reader can actually see: clipped by every
 * scrolling ancestor and by the window. */
function visibleBottom(port: HTMLElement): number {
  let bottom = port.getBoundingClientRect().bottom;
  let current: Element | null = port.parentElement;
  while (current) {
    const style = getComputedStyle(current);
    if (style.overflowY !== "visible") bottom = Math.min(bottom, current.getBoundingClientRect().bottom);
    current = current.parentElement;
  }
  return Math.min(bottom, window.innerHeight);
}

/** Whether this box would draw once the port is scrolled to it, and how far
 * down its nearest clipping ancestor lets it be seen. The port's own scroll
 * clip is deliberately excluded: content below the fold is still content the
 * range has to cover. A box inside a nested scroller is reachable through that
 * scroller, so the clip stops at the scroller's own edge. */
function paintState(element: Element, port: HTMLElement): { painted: boolean; clippedBottom: number } {
  const rect = element.getBoundingClientRect();
  let clipTop = -Infinity;
  let clipBottom = Infinity;
  let clipLeft = -Infinity;
  let clipRight = Infinity;
  let clipped = false;
  let current: Element | null = element;
  while (current && current !== port) {
    const style = getComputedStyle(current);
    if (style.display === "none") return { painted: false, clippedBottom: clipBottom };
    if (style.visibility !== "visible") return { painted: false, clippedBottom: clipBottom };
    if (Number(style.opacity) === 0) return { painted: false, clippedBottom: clipBottom };
    if (style.contentVisibility === "hidden") return { painted: false, clippedBottom: clipBottom };
    if (current !== element && style.overflowY !== "visible") {
      const box = current.getBoundingClientRect();
      clipTop = Math.max(clipTop, box.top);
      clipBottom = Math.min(clipBottom, box.bottom);
      clipLeft = Math.max(clipLeft, box.left);
      clipRight = Math.min(clipRight, box.right);
      clipped = true;
    }
    current = current.parentElement;
  }
  const visible = rect.bottom > clipTop && rect.top < clipBottom && rect.right > clipLeft && rect.left < clipRight;
  return { painted: visible, clippedBottom: clipped ? clipBottom : Infinity };
}

interface MeasuredBox extends ScrollBox {
  /** Bottom edge in scroll coordinates, after any ancestor clip. */
  bottom: number;
  /** Bottom edge before an ancestor clip shortened it. */
  rawBottom: number;
  painted: boolean;
}

/** Measure the port against everything it paints, and name whatever makes the
 * two disagree. */
export function measureResultScroll(targets: ScrollProbeTargets): ScrollProbeReport {
  const { body, result } = targets;
  const bodyRect = body.getBoundingClientRect();
  const scrollTop = body.scrollTop;
  const toScroll = (value: number): number => value - bodyRect.top + scrollTop;

  const resultBottom = toScroll(result.getBoundingClientRect().bottom);
  // Kept in step with the shipped diagnostic: content shorter than the viewport
  // does not make the port scrollable, so the range never starts below it.
  const inFlowBottom = Math.max(body.clientHeight, resultBottom);

  const boxes: MeasuredBox[] = [];
  const innerScrollers: string[] = [];
  for (const element of result.querySelectorAll<HTMLElement>("*")) {
    const rect = element.getBoundingClientRect();
    if (!rect.height && !rect.width) continue;
    const style = getComputedStyle(element);
    const state = paintState(element, body);
    const rawBottom = toScroll(rect.bottom);
    boxes.push({
      label: label(element),
      bottom: toScroll(Math.min(rect.bottom, state.clippedBottom)),
      rawBottom,
      past: 0,
      height: number(rect.height),
      painted: state.painted,
      position: style.position,
      marginBottom: style.marginBottom,
      transform: style.transform === "none" ? "" : style.transform,
      chain: chain(element, result)
    });
    if ((style.overflowY === "auto" || style.overflowY === "scroll") && rect.height > 0) {
      innerScrollers.push(`${label(element)} ${number(rect.height)}px of ${element.scrollHeight}px`);
    }
  }

  const painted = boxes.filter((box) => box.painted && box.height > 0);
  const paintedBottom = painted.reduce((deepest, box) => Math.max(deepest, box.bottom), 0);
  const reachable = Math.max(body.clientHeight, paintedBottom);
  const inFlowReachable = Math.max(body.clientHeight, inFlowBottom);
  // Boxes whose painted bottom reaches past the content they sit in: a float, or
  // content moved down by a transform.
  const pastInFlow = boxes
    .filter((box) => box.painted && box.height > 0 && box.bottom > inFlowBottom + 1)
    .map((box) => ({ ...box, past: number(box.bottom - inFlowBottom) }))
    .sort((left, right) => right.past - left.past);
  // Boxes that still own height while nothing draws them.
  const unpainted = boxes
    .filter((box) => !box.painted && box.height > 0)
    .map((box) => ({ ...box, past: number(box.bottom - inFlowBottom) }))
    .sort((left, right) => right.past - left.past || right.height - left.height);
  // Boxes a nested clipper cuts off: their own rect still looks tall while the
  // reader can never see that part.
  const innerClips = boxes
    .filter((box) => box.rawBottom > box.bottom + 1)
    .map((box) => ({ ...box, past: number(box.rawBottom - box.bottom) }))
    .sort((left, right) => right.past - left.past);

  const last = result.lastElementChild;
  const lastMargin = last ? parseFloat(getComputedStyle(last).marginBottom) || 0 : 0;
  const portVisibleBottom = visibleBottom(body);

  return {
    at: new Date().toISOString().slice(11, 23),
    port: {
      top: number(bodyRect.top),
      bottom: number(bodyRect.bottom),
      height: number(bodyRect.height),
      visibleBottom: number(portVisibleBottom),
      covered: number(Math.max(0, bodyRect.bottom - portVisibleBottom))
    },
    scroll: {
      scrollTop: number(scrollTop),
      max: number(Math.max(0, body.scrollHeight - body.clientHeight)),
      gap: number(body.scrollHeight - scrollTop - body.clientHeight),
      clientHeight: number(body.clientHeight),
      scrollHeight: number(body.scrollHeight)
    },
    content: {
      resultTop: number(toScroll(result.getBoundingClientRect().top)),
      resultBottom: number(resultBottom),
      paintedBottom: number(paintedBottom),
      inFlowBottom: number(inFlowBottom),
      excess: number(Math.max(0, body.scrollHeight - inFlowReachable)),
      phantom: number(Math.max(0, body.scrollHeight - reachable)),
      unreachable: number(Math.max(0, paintedBottom - body.scrollHeight))
    },
    margins: {
      last: last ? label(last) : "",
      marginBottom: number(lastMargin),
      resultPaddingBottom: number(parseFloat(getComputedStyle(result).paddingBottom) || 0)
    },
    innerScrollers: innerScrollers.slice(0, 6),
    culprits: pastInFlow.slice(0, MAX_BOXES),
    unpainted: unpainted.slice(0, MAX_BOXES),
    innerClips: innerClips.slice(0, MAX_BOXES)
  };
}

/** One readable line per measurement - the shape a reader can paste back. */
export function formatResultScroll(report: ScrollProbeReport): string {
  const { scroll, content, port, margins } = report;
  return [
    `range ${scroll.scrollHeight}`,
    `painted ${content.paintedBottom}`,
    `inflow ${content.inFlowBottom}`,
    `excess ${content.excess}`,
    `phantom ${content.phantom}`,
    `unreachable ${content.unreachable}`,
    `covered ${port.covered}`,
    `gap ${scroll.gap}`,
    `top ${scroll.scrollTop}/${scroll.max}`,
    `view ${scroll.clientHeight}`,
    `last-margin ${margins.marginBottom}`
  ].join(" · ");
}

/** Install the console surface. Logging stays off until `dextScrollWatch` is
 * set, so a reader who does not need it never sees a line. */
export function installResultScrollProbe(targets: ScrollProbeTargets): void {
  let watch = false;
  let lastLoggedAt = 0;
  const describe = (): ScrollProbeReport => {
    const value = measureResultScroll(targets);
    console.log(`dext scroll: ${formatResultScroll(value)}`, value);
    return value;
  };
  Object.defineProperty(window, "dextScrollReport", { value: describe, configurable: true });
  Object.defineProperty(window, "dextScrollWatch", {
    get: () => watch,
    set: (value: boolean) => {
      watch = value === true;
      if (watch) describe();
    },
    configurable: true
  });
  const maybeLog = (): void => {
    if (!watch) return;
    const now = Date.now();
    if (now - lastLoggedAt < 250) return;
    lastLoggedAt = now;
    describe();
  };
  targets.body.addEventListener("scroll", maybeLog, { passive: true });
  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(maybeLog);
    observer.observe(targets.body);
    observer.observe(targets.result);
  }
}

declare global {
  interface Window {
    /** Measure the conversation scroll port on demand (Webview DevTools). */
    dextScrollReport?: () => ScrollProbeReport;
    /** Log a scroll measurement on every scroll/layout pass. */
    dextScrollWatch?: boolean;
  }
}

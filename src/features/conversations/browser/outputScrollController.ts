/** The scroll behavior of the rendered conversation: following the newest
 * output, recognizing the reader's own gestures, and owning every deferred
 * frame. The DOM is injected, so the controller can be tested without a
 * browser and no timer outlives the conversation it belongs to. */

/** Distance from the end that still counts as "the reader is at the end". A
 * single streamed batch is routinely taller than this, so this measurement
 * alone cannot decide whether to keep following - see following. */
const RESULT_END_TOLERANCE = 24;
/** How close to the track's end a released scrollbar drag must be to count as
 * "show me the newest output" rather than "stop at this earlier position". */
const RESULT_TRACK_END_TOLERANCE = 6;
/** How far the port's range may exceed the content it paints before the
 * difference stops being a rounding artifact. */
const RESULT_RANGE_TOLERANCE = 32;

export interface ScrollViewport {
  /** The scroll port (#result-body). */
  body: HTMLElement;
  /** The painted conversation inside the port (#result). */
  result: HTMLElement;
  /** The section that positions the floating jump controls. */
  section: HTMLElement;
  jumpToLatest: HTMLElement;
  jumpToTop: HTMLElement;
}

export interface OutputScrollOptions {
  viewport: ScrollViewport;
  /** The tab the reader selected and the conversation painted in the port. */
  conversation: { activeId: () => string | undefined; renderedId: () => string | undefined };
  /** A running turn follows its Process timeline only while that timeline is
   * visible; keeping the disclosure closed is an explicit reader choice. */
  canFollow: () => boolean;
  /** A stale scroll range is reported once per rendered conversation. */
  onDiagnostic: (message: string) => void;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
  warn?: (message: string) => void;
}

/** Owns the deferred scroll frames and the follow state. A tab switch, a user
 * gesture or disposal invalidates every older frame, so a queued correction
 * cannot move a different conversation. */
export class OutputScrollController {
  private frame: number | undefined;
  private generation = 0;
  // The browser can emit a scroll event when content or the scroll port changes
  // size. Keep the last laid-out dimensions so that event is not mistaken for a
  // reader dragging away from the live end.
  private measuredScrollHeight = -1;
  private measuredClientHeight = -1;
  private followingEnd = true;
  private gesture = false;
  private forceInitialScroll = false;
  private reportedRangeFor: string | undefined;

  constructor(private readonly options: OutputScrollOptions) {}

  get following(): boolean {
    return this.followingEnd;
  }

  get initialScrollForced(): boolean {
    return this.forceInitialScroll;
  }

  private get viewport(): ScrollViewport {
    return this.options.viewport;
  }

  private requestFrame(callback: FrameRequestCallback): number {
    return this.options.requestFrame ? this.options.requestFrame(callback) : requestAnimationFrame(callback);
  }

  private cancelFrame(handle: number): void {
    if (this.options.cancelFrame) this.options.cancelFrame(handle);
    else cancelAnimationFrame(handle);
  }

  /** Whether the port currently sits at its end, within a tolerance that
   * absorbs the sub-pixel differences hosts report. */
  isNearBottom(): boolean {
    const { scrollTop, scrollHeight, clientHeight } = this.viewport.body;
    return scrollHeight - scrollTop - clientHeight <= RESULT_END_TOLERANCE;
  }

  syncJumpControls(): void {
    // The control is useful for both a live stream and already-finished
    // conversations. Tying visibility to `executing` (or to an active stream
    // panel) made it disappear as soon as a response finished, even when the
    // reader had scrolled away from the newest output.
    this.viewport.jumpToLatest.hidden = this.isNearBottom();
    this.viewport.jumpToTop.hidden = this.viewport.body.scrollTop <= 1;
  }

  /** Cancels a queued correction. Every caller that changes what the port
   * represents must run this before scheduling a new frame. */
  cancelScheduled(): void {
    this.generation += 1;
    if (this.frame !== undefined) this.cancelFrame(this.frame);
    this.frame = undefined;
  }

  /** A conversation switch starts a fresh follow state and invalidates any
   * frame queued for the conversation that was just replaced. */
  beginSwitch(): void {
    this.cancelScheduled();
    this.forceInitialScroll = false;
    // The next conversation opens at its newest reply, whatever position the
    // reader had left the previous one in.
    this.followingEnd = true;
    this.gesture = false;
    this.reportedRangeFor = undefined;
  }

  setFollowing(following: boolean): void {
    this.followingEnd = following;
  }

  /** A restored running conversation receives its live row and buffered events
   * after the cached/history DOM has been painted. Force one final bottom snap
   * for that replay. */
  forceInitialBottom(): void {
    this.forceInitialScroll = true;
  }

  consumeForcedInitialScroll(): boolean {
    const forced = this.forceInitialScroll;
    this.forceInitialScroll = false;
    return forced;
  }

  /** A scroll range larger than the content makes the scrollbar lie: the thumb
   * stops short of the newest output, and the end of the track is blank space.
   * Measure the port against what it paints and name the box that owns the
   * difference instead of repeatedly moving the position. */
  reportStaleRange(): void {
    const { body, result } = this.viewport;
    if (!result.childElementCount) return;
    const bodyRect = body.getBoundingClientRect();
    // A conversation shorter than its viewport does not make the port
    // scrollable, so the range never starts below the viewport's own height.
    const contentBottom = Math.max(
      body.clientHeight,
      result.getBoundingClientRect().bottom - bodyRect.top + body.scrollTop
    );
    const excess = body.scrollHeight - contentBottom;
    if (excess <= RESULT_RANGE_TOLERANCE) return;
    const conversation = this.options.conversation.renderedId() ?? "unknown";
    if (this.reportedRangeFor === conversation) return;
    this.reportedRangeFor = conversation;
    // Lowest boxes win: the length the port scrolls into is the union of them.
    const boxes: Array<{ bottom: number; label: string }> = [];
    for (const element of result.querySelectorAll<HTMLElement>("*")) {
      const rect = element.getBoundingClientRect();
      if (!rect.height && !rect.width) continue;
      boxes.push({
        bottom: rect.bottom - bodyRect.top + body.scrollTop - contentBottom,
        label: `${element.tagName.toLowerCase()}.${String(element.className || "?").slice(0, 48)}`
      });
    }
    boxes.sort((left, right) => right.bottom - left.bottom);
    const summary = [
      `port ${body.clientHeight}px view / ${body.scrollHeight}px range`,
      `content ${Math.round(contentBottom)}px`,
      `closed sections ${result.querySelectorAll("details:not([open])").length}`,
      ...boxes.slice(0, 3).map((box) => `${Math.round(box.bottom)}px past content: ${box.label}`)
    ].join(" · ");
    this.options.warn?.(`dext scroll range: ${summary}`);
    this.options.onDiagnostic(`Dext scroll diagnostic — ${summary}`);
  }

  /** #result-body owns the vertical scrollbar while the floating control is
   * positioned against the section, so the button needs the measured gutter.
   * Hosts pick that width themselves (VS Code paints a 10px slider, Chromium a
   * wider one). A control placed on a guessed width can land on the track,
   * which hides the thumb exactly where the reader drags it to reach the end. */
  syncGutter(): void {
    const { body, section } = this.viewport;
    const scrollbar = Math.max(0, body.offsetWidth - body.clientWidth);
    const padding = section.getBoundingClientRect().right - body.getBoundingClientRect().right;
    const gutter = padding + scrollbar;
    // Leave the stylesheet fallback in place until the panel has been laid out.
    if (gutter > 0) section.style.setProperty("--dext-result-scroll-gutter", `${gutter}px`);
  }

  /** Write the live end into the scroll port. A scrollbar drag and a deferred
   * follow both act on heights measured in an earlier frame, so the assignment
   * has to read scrollHeight itself instead of trusting a remembered maximum. */
  snapToBottom(): void {
    const body = this.viewport.body;
    const end = Math.max(0, body.scrollHeight - body.clientHeight);
    if (body.scrollTop !== end) body.scrollTop = end;
    this.measuredScrollHeight = body.scrollHeight;
    this.measuredClientHeight = body.clientHeight;
    this.syncJumpControls();
  }

  /** A batch of output has been rendered: keep a reader who is following at the
   * end. The pin runs in the frame after the batch so the deferred Markdown pass
   * cannot leave the view above the message that just grew. */
  pin(): void {
    if (!this.followingEnd || !this.options.canFollow()) return;
    this.cancelScheduled();
    const generation = this.generation;
    const pin = (settle: boolean): void => {
      this.frame = this.requestFrame(() => {
        this.frame = undefined;
        if (generation !== this.generation || !this.followingEnd || !this.options.canFollow()) return;
        this.snapToBottom();
        // Opening a disclosure or hydrating a stored turn can still add height
        // after this frame; one settle pass keeps the newest output in view.
        if (settle && !this.isNearBottom()) pin(false);
      });
    };
    pin(true);
  }

  /** The reader asked for the newest output: the jump control, a drag released
   * against the track's end, or a conversation that opens at its latest reply. */
  followToBottom(): void {
    this.followingEnd = true;
    this.snapToBottom();
    this.pin();
  }

  /** Selecting a conversation should open at its latest reply, like a chat
   * timeline. Defer until the freshly-rendered disclosures have been laid out
   * so scrollHeight reflects the complete session. */
  scrollToBottom(): void {
    this.cancelScheduled();
    if (!this.options.canFollow()) return;
    this.followingEnd = true;
    const generation = this.generation;
    this.frame = this.requestFrame(() => {
      this.frame = this.requestFrame(() => {
        this.frame = undefined;
        if (generation !== this.generation || !this.followingEnd || !this.options.canFollow()) return;
        if (!this.options.conversation.activeId() || this.options.conversation.activeId() !== this.options.conversation.renderedId()) return;
        this.snapToBottom();
      });
    });
  }

  /** A layout pass keeps the remembered dimensions current only while the
   * reader is not following; a following reader needs the old values so content
   * growth is recognized as layout, not as a gesture away from the end. */
  measureLayout(): void {
    if (!this.followingEnd || this.measuredScrollHeight < 0) {
      this.measuredScrollHeight = this.viewport.body.scrollHeight;
      this.measuredClientHeight = this.viewport.body.clientHeight;
    }
  }

  /** A user gesture in progress decides where the view lands when it ends, so
   * the scroll events it produces are not the reader's final word. */
  isGestureActive(): boolean {
    return this.gesture;
  }

  onScroll(): void {
    if (this.gesture) {
      this.syncJumpControls();
      return;
    }
    // Reaching the end - by wheel, keyboard, or our own correction - resumes
    // following. A scroll event away from the end is not enough to release the
    // follow: content growth, a font reflow, and the browser's own clamping can
    // all emit one while the reader is still following the newest output. The
    // explicit wheel/touch/keyboard/track handlers are the user intent signals
    // that release it.
    const body = this.viewport.body;
    const layoutChanged = this.measuredScrollHeight !== body.scrollHeight
      || this.measuredClientHeight !== body.clientHeight;
    if (this.isNearBottom()) this.followingEnd = true;
    else if (!layoutChanged) this.followingEnd = false;
    this.syncJumpControls();
    this.reportStaleRange();
  }

  /** A pointer press on the scrollbar strip never reaches the track itself, so
   * the gesture is recognized by its position inside the port's measured
   * gutter. Returns true when the press started on that strip. */
  beginPointerGesture(event: { clientX: number }): boolean {
    const body = this.viewport.body;
    const scrollbar = body.offsetWidth - body.clientWidth;
    const rect = body.getBoundingClientRect();
    // Overlay scrollbars report no width through offsetWidth/clientWidth, even
    // though their thumb still receives pointer input. Keep a narrow fallback
    // hit strip so releasing that thumb at the track end gets a fresh snap.
    const hitWidth = scrollbar > 0 ? scrollbar : 16;
    if (event.clientX < rect.right - hitWidth) return false;
    this.gesture = true;
    // The reader is choosing a position by hand, so the stream must not pull the
    // view back while the thumb is held.
    this.followingEnd = false;
    return true;
  }

  endPointerGesture(event: { clientY: number }): void {
    if (!this.gesture) return;
    this.gesture = false;
    const body = this.viewport.body;
    // A drag whose height was measured before the last batch can stop short of
    // the real end. Releasing against the track's end still means "newest
    // output", so snap with the height of this frame instead of the one the
    // drag was computed from.
    const releasedAtTrackEnd = event.clientY >= body.getBoundingClientRect().bottom - RESULT_TRACK_END_TOLERANCE;
    if (releasedAtTrackEnd || this.isNearBottom()) this.followToBottom();
  }

  /** Wheeling up is a deliberate move into earlier output. Wheeling down is
   * left to the scroll handler, so returning to the end resumes following. */
  onWheel(deltaY: number): void {
    if (deltaY < 0) this.followingEnd = false;
  }

  beginTouchGesture(): void {
    this.gesture = true;
    this.followingEnd = false;
  }

  endTouchGesture(): void {
    if (!this.gesture) return;
    this.gesture = false;
    if (this.isNearBottom()) this.followToBottom();
  }

  /** #result-body is focusable so the jump control can hand the reader a
   * keyboard scroller; these are the keys that move it. */
  onKeydown(event: { key: string; preventDefault?(): void }): void {
    if (event.key === "End" || event.key === "PageDown" || event.key === "ArrowDown") {
      this.followToBottom();
      return;
    }
    if (event.key === "Home" || event.key === "PageUp" || event.key === "ArrowUp") this.followingEnd = false;
  }

  jumpToTop(): void {
    this.followingEnd = false;
    this.cancelScheduled();
    this.viewport.body.scrollTop = 0;
    this.syncJumpControls();
    this.viewport.body.focus({ preventScroll: true });
  }

  /** Disposal invalidates queued frames so unloading the view leaves no timer
   * or animation callback behind. */
  dispose(): void {
    this.cancelScheduled();
    this.gesture = false;
    this.forceInitialScroll = false;
  }
}

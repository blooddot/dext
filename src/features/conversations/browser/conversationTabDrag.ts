/** Pointer capture belongs to the strip: host updates can replace tab nodes
 * while a conversation is being selected or a running turn changes its title. */
export function enableConversationTabDrag(
  strip: HTMLElement,
  move: (sessionId: string, beforeSessionId: string | null) => void
): { refresh: () => void; tracking: () => boolean } {
  let drag: {
    pointerId: number;
    sessionId: string;
    startX: number;
    x: number;
    y: number;
    started: boolean;
    before: string | null | undefined;
  } | undefined;
  let frame = 0;
  let suppressClick = false;
  const tabs = () => [...strip.querySelectorAll<HTMLElement>(".conversation-tab")];

  function clearMarks(): void {
    for (const tab of tabs()) tab.classList.remove("dragging", "drop-before", "drop-after");
  }

  function refresh(): void {
    clearMarks();
    if (!drag?.started) return;
    drag.before = undefined;
    const all = tabs();
    const source = all.find((tab) => tab.dataset.sessionId === drag?.sessionId);
    if (!source) { finish(false); return; }
    source.classList.add("dragging");
    const bounds = strip.getBoundingClientRect();
    if (drag.y < bounds.top || drag.y > bounds.bottom || drag.x < bounds.left || drag.x > bounds.right) return;
    const group = all.filter((tab) => tab !== source
      && tab.classList.contains("pinned") === source.classList.contains("pinned"));
    const before = group.find((tab) => {
      const rect = tab.getBoundingClientRect();
      return drag!.x < rect.left + rect.width / 2;
    });
    drag.before = before?.dataset.sessionId ?? null;
    if (before) before.classList.add("drop-before");
    else (group.at(-1) ?? source).classList.add("drop-after");
  }

  function scroll(): void {
    frame = 0;
    if (!drag?.started) return;
    const bounds = strip.getBoundingClientRect();
    if (drag.y >= bounds.top && drag.y <= bounds.bottom && drag.x >= bounds.left && drag.x <= bounds.right) {
      const edge = Math.min(36, bounds.width / 4);
      const delta = drag.x < bounds.left + edge ? -Math.min(12, (bounds.left + edge - drag.x) / 3)
        : drag.x > bounds.right - edge ? Math.min(12, (drag.x - bounds.right + edge) / 3) : 0;
      if (delta) { strip.scrollLeft += delta; refresh(); }
    }
    frame = requestAnimationFrame(scroll);
  }

  function finish(commit: boolean): void {
    const current = drag;
    drag = undefined;
    cancelAnimationFrame(frame);
    frame = 0;
    strip.classList.remove("dragging-tabs");
    clearMarks();
    if (!current) return;
    if (strip.hasPointerCapture(current.pointerId)) strip.releasePointerCapture(current.pointerId);
    if (!commit || !current.started || current.before === undefined) return;
    const all = tabs();
    const source = all.find((tab) => tab.dataset.sessionId === current.sessionId);
    if (!source) return;
    const group = all.filter((tab) => tab.classList.contains("pinned") === source.classList.contains("pinned"));
    if ((group[group.indexOf(source) + 1]?.dataset.sessionId ?? null) === current.before) return;
    const before = current.before === null
      ? all.find((tab) => !tab.classList.contains("pinned") && source.classList.contains("pinned"))
      : all.find((tab) => tab.dataset.sessionId === current.before);
    strip.insertBefore(source, before ?? null);
    source.scrollIntoView({ block: "nearest", inline: "nearest" });
    move(current.sessionId, current.before);
  }

  strip.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !event.isPrimary || !(event.target instanceof Element)) return;
    // A cancelled drag may release outside the strip without emitting a click.
    // Only suppress the drag's own click, never the next press on a close button.
    suppressClick = false;
    if (event.target.closest(".conversation-tab-close, .conversation-tab-pin")) return;
    const tab = event.target.closest<HTMLElement>(".conversation-tab");
    if (!tab?.dataset.sessionId) return;
    finish(false);
    drag = { pointerId: event.pointerId, sessionId: tab.dataset.sessionId,
      startX: event.clientX, x: event.clientX, y: event.clientY, started: false, before: undefined };
    strip.setPointerCapture(event.pointerId);
  });
  strip.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (!drag.started && Math.abs(drag.x - drag.startX) < 5) return;
    event.preventDefault();
    if (!drag.started) {
      drag.started = true;
      suppressClick = true;
      strip.classList.add("dragging-tabs");
      frame = requestAnimationFrame(scroll);
    }
    refresh();
  });
  strip.addEventListener("pointerup", (event) => {
    if (event.pointerId !== drag?.pointerId) return;
    drag.x = event.clientX;
    drag.y = event.clientY;
    refresh();
    finish(true);
  });
  strip.addEventListener("pointercancel", () => finish(false));
  strip.addEventListener("lostpointercapture", () => finish(false));
  strip.addEventListener("dragstart", (event) => event.preventDefault());
  strip.addEventListener("click", (event) => {
    if (!suppressClick || event.detail === 0) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  window.addEventListener("blur", () => finish(false));
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && drag) { event.preventDefault(); finish(false); }
  });
  return { refresh, tracking: () => Boolean(drag) };
}

/** Collapse optional controls based on their rendered widths, including the
 * current model label, font size, permission, and Send/Stop button. */
export function observeComposerOverflow(controls: HTMLElement): void {
  const row = controls.closest<HTMLElement>(".action-row")!;
  const actions = row.querySelector<HTMLElement>(".action-actions")!;
  const extras = controls.querySelector<HTMLElement>(".composer-extras")!;
  const mode = controls.querySelector<HTMLElement>(".composer-menu")!;
  const more = controls.querySelector<HTMLButtonElement>(".composer-more")!;
  let pending = false;

  function measure(): void {
    pending = false;
    if (!row.clientWidth) return;
    controls.classList.add("measure-extras");
    const gap = parseFloat(getComputedStyle(controls).columnGap) || 0;
    const rowGap = parseFloat(getComputedStyle(row).columnGap) || 0;
    const required = mode.getBoundingClientRect().width + extras.getBoundingClientRect().width
      + gap + rowGap + actions.getBoundingClientRect().width;
    controls.classList.remove("measure-extras");
    const compact = required > row.clientWidth;
    controls.classList.toggle("is-compact", compact);
    if (!compact) {
      controls.classList.remove("show-extra");
      more.setAttribute("aria-expanded", "false");
    }
  }

  function schedule(): void {
    if (pending) return;
    pending = true;
    requestAnimationFrame(measure);
  }

  const resize = new ResizeObserver(schedule);
  resize.observe(row);
  resize.observe(actions);
  // Model/permission changes may alter natural widths without resizing the
  // compact toolbar itself. Ignore the layout classes we toggle above.
  const content = new MutationObserver(schedule);
  content.observe(controls, {
    subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ["hidden"]
  });
  const theme = new MutationObserver(schedule);
  for (const element of [document.documentElement, document.body]) {
    theme.observe(element, { attributes: true, attributeFilter: ["class", "style"] });
  }
  document.fonts.addEventListener("loadingdone", schedule);
  void document.fonts.ready.then(schedule);
  schedule();
}

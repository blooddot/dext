/** Collapse optional controls based on their rendered widths, including the
 * current model label, font size, permission, and Send/Stop button. */
export function observeComposerOverflow(controls: HTMLElement): void {
  const row = controls.closest<HTMLElement>(".action-row")!;
  const actions = row.querySelector<HTMLElement>(".action-actions")!;
  const extras = controls.querySelector<HTMLElement>(".composer-extras")!;
  // Permission now sits beside Mode and Skills, so every left-hand menu counts.
  const leftMenus = [...controls.querySelectorAll<HTMLElement>(".composer-menu")]
    .filter((menu) => !extras.contains(menu));
  const more = controls.querySelector<HTMLButtonElement>(".composer-more")!;
  let pending = false;

  function measure(): void {
    pending = false;
    if (!row.clientWidth) return;
    const gap = parseFloat(getComputedStyle(controls).columnGap) || 0;
    const rowGap = parseFloat(getComputedStyle(row).columnGap) || 0;
    const menusWidth = (): number => leftMenus.reduce((total, menu) => {
      const width = menu.getBoundingClientRect().width;
      return width ? total + width + gap : total;
    }, 0);
    const actionWidth = (): number => rowGap + actions.getBoundingClientRect().width;
    // A squeezed menu reports the width it was squeezed to, so every natural
    // measurement runs with the extras unfolded and the menus unshrinkable.
    const natural = <T>(read: () => T): T => {
      controls.classList.add("measure-extras");
      const measured = read();
      controls.classList.remove("measure-extras");
      return measured;
    };
    const fullWidth = (): number =>
      natural(() => menusWidth() + extras.getBoundingClientRect().width + actionWidth());
    let required = fullWidth();
    const skillsCompact = required > row.clientWidth;
    controls.classList.toggle("skills-compact", skillsCompact);
    if (skillsCompact) required = fullWidth();
    const compact = required > row.clientWidth;
    controls.classList.toggle("is-compact", compact);
    if (!compact) {
      controls.classList.remove("is-tight", "show-extra");
      more.setAttribute("aria-expanded", "false");
      return;
    }
    // Compact folds Agent and Model into the ... popover. The triggers left on
    // the row drop their text when even that row is too wide.
    // shortcut: icons are the floor, so a ~190px row cannot shrink further.
    controls.classList.remove("is-tight");
    const collapsed = natural(() => menusWidth() + more.offsetWidth + actionWidth());
    controls.classList.toggle("is-tight", collapsed > row.clientWidth);
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

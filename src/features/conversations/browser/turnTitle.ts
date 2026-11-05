/** Keep a custom name through deferred Plan hydration and cached tab restores.
 * The title target is only the element's text writer, so a cached page can hold
 * a title without the renderer reaching into the live DOM tree. */
export class TurnTitle {
  constructor(
    private readonly element: Pick<HTMLElement, "textContent" | "hidden">,
    private fallback: string,
    private name?: string,
    /** The rendered prompt. Without a name it is the row label itself, so the
     * name element stays hidden instead of repeating it. */
    private readonly prompt?: object
  ) {
    this.render();
  }

  rename(name: string | undefined, fallback: string): void {
    this.name = name;
    this.fallback = fallback;
    this.render();
  }

  setPlanPath(path: string): void {
    this.fallback = `Plan: ${path.split("/").pop() ?? path}`;
    this.render();
  }

  private render(): void {
    this.element.textContent = this.name || this.fallback;
    this.element.hidden = !this.name && this.prompt !== undefined;
  }
}

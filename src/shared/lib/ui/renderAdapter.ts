export type ComponentAttributes = Record<string, string | boolean>;
export type Children<E> = readonly (E | string)[];

/** Both adapters treat string children as text. */
export interface UiRenderAdapter<E> {
  element(this: void, tag: string, attributes: ComponentAttributes, children: Children<E>): E;
}

/** Markup is supplied by trusted renderers such as Markdown. */
export interface MarkupAdapter<E> extends UiRenderAdapter<E> {
  markup(this: void, tag: string, attributes: ComponentAttributes, html: string, children: Children<E>): E;
}

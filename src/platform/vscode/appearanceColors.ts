import * as vscode from "vscode";

/** The user's `workbench.colorCustomizations`, split per Dext palette. Bare
 * entries apply to every theme; bracketed ones only to the theme they name, and
 * the Light and Dark palettes are snapshots of VS Code's two modern defaults, so
 * those are the scopes they inherit. VS Code only ships the *active* theme's
 * colours, which is why a palette that deliberately differs from the workbench
 * has to carry the user's own colours itself. */
const SCOPES = {
  light: ["Light Modern", "Default Light Modern"],
  dark: ["Dark Modern", "Default Dark Modern"]
} as const;

export interface DextColorOverrides {
  light: Record<string, string>;
  dark: Record<string, string>;
}

/** A colour value that cannot close the declaration or the `<style>` element. */
const COLOR_VALUE = /^[\w#(),.%\s/-]+$/;

function entries(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  // A bracketed key is a theme scope; a colour id is what maps onto `--vscode-*`.
  return Object.fromEntries(Object.entries(value).filter(([id, color]) =>
    /^[\w.-]+$/.test(id) && typeof color === "string" && COLOR_VALUE.test(color)));
}

export function dextColorOverrides(customizations: unknown): DextColorOverrides {
  const root = entries(customizations);
  const scoped = (kind: keyof typeof SCOPES): Record<string, string> => {
    const value = customizations as Record<string, unknown> | undefined;
    return SCOPES[kind].reduce<Record<string, string>>(
      (all, name) => ({ ...all, ...entries(value?.[`[${name}]`]) }),
      {}
    );
  };
  return { light: { ...root, ...scoped("light") }, dark: { ...root, ...scoped("dark") } };
}

/** The CSS a page bakes next to `appearance.css`, empty when the user customised
 * no colour. Gated on `data-dext-theme`, so `auto` keeps the workbench's own
 * variables, and `!important` because the palette sets these ids on a selector
 * that is more specific than a bare `body`. */
export function appearanceColorStyle(): string {
  const customizations = vscode.workspace.getConfiguration("workbench").get<unknown>("colorCustomizations");
  const overrides = dextColorOverrides(customizations);
  return (["light", "dark"] as const).flatMap((kind) => {
    const rules = Object.entries(overrides[kind])
      .map(([id, color]) => `--vscode-${id.replaceAll(".", "-")}:${color} !important`);
    return rules.length ? [`body[data-dext-theme="${kind}"]{${rules.join(";")}}`] : [];
  }).join("");
}

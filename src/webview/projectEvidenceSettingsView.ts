import { PROJECT_EVIDENCE_DEPTHS, type ProjectEvidenceSettings } from "../core/projectEvidenceSettings.js";

const escape = (value: string): string => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

export function renderProjectEvidenceSettings(settings: ProjectEvidenceSettings, version: number, disabled: boolean): string {
  const preset = PROJECT_EVIDENCE_DEPTHS[settings.depth];
  const number = (key: "files" | "chars" | "fileChars", label: string, min: number, max: number) =>
    `<label>${label}<input type="number" name="${key}" min="${min}" max="${max}" step="1" value="${settings[key] ?? ""}" placeholder="${preset[key]}"></label>`;
  return `<form class="project-evidence-settings" data-project-evidence-settings data-version="${version}">
    <h3>Project settings</h3>
    <p class="project-help">Choose how much source text AI can read when initializing knowledge or generating diagrams. Saved settings apply to the next run.</p>
    <fieldset${disabled ? " disabled" : ""}>
      <label>Reading depth<select name="depth">${Object.entries(PROJECT_EVIDENCE_DEPTHS).map(([id, value]) => `<option value="${id}"${id === settings.depth ? " selected" : ""}>${id === "standard" ? "Standard" : id === "deep" ? "Deep" : "Whole"} · up to ${value.files} files · ${value.chars.toLocaleString("en-US")} characters</option>`).join("")}</select></label>
      <p class="project-help">Whole is the largest budget, with a 1,000-file limit. Text excerpts also depend on the character budget.</p>
      <details><summary>Advanced reading settings</summary>
        <p class="project-help">Leave number fields empty to follow the selected depth. Custom values override it.</p>
        <div class="project-evidence-fields">${number("files", "File limit", 1, 1000)}${number("chars", "Total evidence characters", 20_000, 1_200_000)}${number("fileChars", "Characters per file", 512, 262_144)}</div>
        <label>Reading scope<textarea name="include" rows="3" placeholder="src/**&#10;docs/**">${escape(settings.include.join("\n"))}</textarea></label>
        <p class="project-help">One workspace-relative pattern per line. Empty uses the built-in README, documentation, manifest and source file set.</p>
        <button type="button" data-evidence-use-preset>Use depth defaults</button>
      </details>
    </fieldset>
    <p class="project-help" role="status" aria-live="polite" data-evidence-settings-status>Changes save automatically.</p>
  </form>`;
}

/** Executes inside the existing Project webview with its shared VS Code API handle. */
export function projectEvidenceSettingsScript(): string {
  return `(${bindEvidenceSettings.toString()})(api,${JSON.stringify(PROJECT_EVIDENCE_DEPTHS)});`;
}

function bindEvidenceSettings(api: { postMessage(message: unknown): void }, presets: typeof PROJECT_EVIDENCE_DEPTHS): void {
  const form = document.querySelector<HTMLFormElement>("[data-project-evidence-settings]");
  if (!form) return;
  const fieldset = form.querySelector("fieldset")!;
  const status = form.querySelector<HTMLElement>("[data-evidence-settings-status]")!;
  const depth = form.elements.namedItem("depth") as HTMLSelectElement;
  const fields = ["files", "chars", "fileChars"] as const;
  const input = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saving = false;
  let queued = false;
  const save = (): void => {
    timer = undefined;
    if (fieldset.disabled || !form.reportValidity()) return;
    if (saving) { queued = true; return; }
    saving = true;
    const settings: Record<string, unknown> = { depth: depth.value, include: input("include").value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) };
    for (const name of fields) if (input(name).value !== "") settings[name] = Number(input(name).value);
    fieldset.disabled = true;
    status.textContent = "Saving…";
    api.postMessage({ type: "projectEvidenceSettings", settings, version: Number(form.dataset.version) });
  };
  const scheduleSave = (): void => {
    status.textContent = "Unsaved changes";
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 500);
  };
  form.addEventListener("input", scheduleSave);
  depth.addEventListener("change", () => {
    for (const name of fields) input(name).placeholder = String(presets[depth.value as keyof typeof presets][name]);
    scheduleSave();
  });
  form.querySelector("[data-evidence-use-preset]")!.addEventListener("click", () => {
    for (const name of fields) input(name).value = "";
    scheduleSave();
  });
  form.addEventListener("change", scheduleSave);
  form.addEventListener("submit", (event) => { event.preventDefault(); scheduleSave(); });
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    const message = event.data && typeof event.data === "object" ? event.data as { type?: unknown; version?: unknown; error?: unknown } : {};
    if (message.type === "projectDefinitionVersion") {
      form.dataset.version = String(message.version);
      return;
    }
    if (message.type !== "projectEvidenceSettingsSaved") return;
    saving = false;
    fieldset.disabled = false;
    const errorText = typeof message.error === "string" ? message.error : "Save failed.";
    status.textContent = message.error ? `Could not save: ${errorText}` : "Saved. Applies to the next initialization or diagram generation.";
    if (!message.error) {
      form.dataset.version = String(message.version);
      document.querySelector("[data-project-legacy-scan]")?.remove();
      if (queued) { queued = false; scheduleSave(); }
    }
  });
}

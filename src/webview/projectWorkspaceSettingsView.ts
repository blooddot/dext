import type { ProjectWorkspaceSettings } from "../core/projectSettings.js";

const escape = (value: string): string => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

export function renderProjectWorkspaceSettings(settings: ProjectWorkspaceSettings, version: number, disabled: boolean): string {
  const directoryList = (name: "apiDirs" | "skillDirs" | "mcpDirs", label: string, values: readonly string[], placeholder: string): string => {
    const rows = values.length ? values : [""];
    return `<div class="project-directory-field" data-project-directory-list="${name}">
      <span class="project-field-label">${label}</span>
      <div class="project-directory-items">${rows.map((value) => `<div class="project-directory-row" data-project-directory-row><input name="${name}" value="${escape(value)}" placeholder="${placeholder}" spellcheck="false"><button type="button" class="project-directory-remove" data-project-directory-remove aria-label="Remove directory">Remove</button></div>`).join("")}</div>
      <button type="button" class="project-directory-add" data-project-directory-add>Add directory</button>
    </div>`;
  };
  return `<form class="project-workspace-settings" data-project-workspace-settings data-version="${version}">
    <details>
    <summary><strong>Project configuration</strong><span>Review preset, Plan, API, Skill and MCP directories</span></summary>
    <div class="project-workspace-settings-body">
      <p class="project-help">These choices travel with the project in <code>.dext/project.json</code>. They apply to new turns, plans and resource reloads.</p>
      <fieldset${disabled ? " disabled" : ""}>
      <label>Default Review<select name="reviewPreset"><option value="engineering"${settings.reviewPreset === "engineering" ? " selected" : ""}>Engineering · correctness and implementation evidence</option><option value="experience"${settings.reviewPreset === "experience" ? " selected" : ""}>Experience · user behavior and visible outcome</option></select></label>
      <label>Plan directory<input name="planDirectory" value="${escape(settings.planDirectory)}" placeholder=".dext/plans" spellcheck="false"></label>
      <p class="project-help">Workspace-relative directory used when storage is set to Workspace. Global storage keeps its existing location.</p>
      ${directoryList("apiDirs", "Additional project API directories", settings.apiDirs, "tools/api")}
      ${directoryList("skillDirs", "Additional project Skill directories", settings.skillDirs, "tools/skills")}
      ${directoryList("mcpDirs", "Additional project MCP directories", settings.mcpDirs, "tools/mcp")}
      <p class="project-help">Each row is a workspace-relative directory. The built-in <code>.dext/api</code>, <code>.dext/skills</code> and <code>.dext/mcp</code> directories remain enabled.</p>
      </fieldset>
      <p class="project-help" role="status" aria-live="polite" data-project-workspace-status>Changes save automatically.</p>
    </div>
    </details>
  </form>`;
}

export function projectWorkspaceSettingsScript(): string {
  return `(${bindProjectWorkspaceSettings.toString()})(api);`;
}

function bindProjectWorkspaceSettings(api: { postMessage(message: unknown): void }): void {
  const form = document.querySelector<HTMLFormElement>("[data-project-workspace-settings]");
  if (!form) return;
  const fieldset = form.querySelector("fieldset")!;
  const status = form.querySelector<HTMLElement>("[data-project-workspace-status]")!;
  const value = (name: string): HTMLInputElement | HTMLSelectElement => form.elements.namedItem(name)! as HTMLInputElement;
  const directoryValues = (name: string): string[] => [...form.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)].map((input) => input.value.trim()).filter(Boolean);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saving = false;
  let queued = false;
  const readSettings = () => ({
    reviewPreset: value("reviewPreset").value,
    planDirectory: value("planDirectory").value.trim(),
    apiDirs: directoryValues("apiDirs"),
    skillDirs: directoryValues("skillDirs"),
    mcpDirs: directoryValues("mcpDirs")
  });
  const save = (): void => {
    timer = undefined;
    if (fieldset.disabled || !form.reportValidity()) return;
    if (saving) { queued = true; return; }
    saving = true;
    fieldset.disabled = true;
    status.textContent = "Saving…";
    api.postMessage({ type: "projectWorkspaceSettings", settings: readSettings(), version: Number(form.dataset.version) });
  };
  const scheduleSave = (): void => {
    status.textContent = "Unsaved changes";
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 500);
  };
  const addDirectoryRow = (name: string): void => {
    const list = form.querySelector<HTMLElement>(`[data-project-directory-list="${name}"] .project-directory-items`);
    if (!list) return;
    const row = document.createElement("div");
    row.className = "project-directory-row";
    row.dataset.projectDirectoryRow = "";
    const input = document.createElement("input");
    input.name = name;
    input.placeholder = list.querySelector<HTMLInputElement>("input")?.placeholder ?? "";
    input.spellcheck = false;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "project-directory-remove";
    button.dataset.projectDirectoryRemove = "";
    button.setAttribute("aria-label", "Remove directory");
    button.textContent = "Remove";
    row.append(input, button);
    list.append(row);
    input.focus();
  };
  form.querySelectorAll<HTMLButtonElement>("[data-project-directory-add]").forEach((button) => button.addEventListener("click", () => addDirectoryRow(button.closest<HTMLElement>("[data-project-directory-list]")?.dataset.projectDirectoryList ?? "")));
  form.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-project-directory-remove]") : null;
    if (!target) return;
    const rows = target.closest<HTMLElement>(".project-directory-items")?.querySelectorAll("[data-project-directory-row]") ?? [];
    if (rows.length <= 1) {
      const input = target.closest<HTMLElement>("[data-project-directory-row]")?.querySelector<HTMLInputElement>("input");
      if (input) input.value = "";
    } else target.closest("[data-project-directory-row]")?.remove();
    scheduleSave();
  });
  form.addEventListener("input", scheduleSave);
  form.addEventListener("change", scheduleSave);
  form.addEventListener("submit", (event) => { event.preventDefault(); scheduleSave(); });
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    const message = event.data && typeof event.data === "object" ? event.data as { type?: unknown; version?: unknown; error?: unknown } : {};
    if (message.type === "projectDefinitionVersion") {
      form.dataset.version = String(message.version);
      return;
    }
    if (message.type !== "projectWorkspaceSettingsSaved") return;
    saving = false;
    fieldset.disabled = false;
    const errorText = typeof message.error === "string" ? message.error : "Save failed.";
    status.textContent = message.error ? `Could not save: ${errorText}` : "Saved. New turns and resource reloads use this project configuration.";
    if (!message.error) {
      form.dataset.version = String(message.version);
      if (queued) { queued = false; scheduleSave(); }
    }
  });
}

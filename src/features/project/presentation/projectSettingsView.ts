import { PROJECT_EVIDENCE_DEPTHS, type ProjectEvidenceSettings } from "../contracts/projectEvidenceSettings.js";
import type { ProjectSettings, ProjectToolSettings, ProjectWorkspaceSettings } from "../contracts/projectSettings.js";

const escape = (value: string): string => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

const DEFAULT_RESOURCE_DIRECTORIES = {
  apiDirs: ".dext/api",
  skillDirs: ".dext/skills",
  mcpDirs: ".dext/mcp"
} as const;

function directoryList(name: "apiDirs" | "skillDirs" | "mcpDirs", label: string, values: readonly string[]): string {
  const displayed = [...new Set([DEFAULT_RESOURCE_DIRECTORIES[name], ...values])];
  return `<label class="project-directory-field" data-project-directory-list="${name}">
    <span class="project-field-label">${label}</span>
    <input name="${name}" value="${escape(displayed.join(", "))}" spellcheck="false" aria-describedby="resource-directories-help">
  </label>`;
}

function evidenceNumber(settings: ProjectEvidenceSettings, key: "files" | "chars" | "fileChars", label: string, min: number, max: number): string {
  const preset = PROJECT_EVIDENCE_DEPTHS[settings.depth];
  return `<label>${label}<input type="number" name="${key}" min="${min}" max="${max}" step="1" value="${settings[key] ?? ""}" placeholder="${preset[key]}"></label>`;
}

export function renderProjectSettings(settings: ProjectWorkspaceSettings, evidence: ProjectEvidenceSettings, tool: ProjectToolSettings, version: number, disabled: boolean, initialization: string, evidenceConfigured = true): string {
  const depth = evidence.depth === "standard" ? "Standard" : evidence.depth === "deep" ? "Deep" : "Whole";
  return `<form class="project-settings project-workspace-settings" data-project-settings data-version="${version}" data-evidence-configured="${evidenceConfigured}">
    <details>
      <summary><i class="project-settings-chevron codicon codicon-chevron-right" aria-hidden="true"></i><span class="project-settings-summary-content"><strong>Project settings</strong><span>${depth} · ${escape(settings.planDirectory)}</span></span><span class="project-settings-summary-hint">Click to expand</span></summary>
      <div class="project-workspace-settings-body">
        <p class="project-help">Project-owned choices travel with the project in <code>.dext/project.json</code> and apply automatically to new turns and resource reloads.</p>
        <fieldset data-project-settings-fields${disabled ? " disabled" : ""}>
          ${initialization ? `<section class="project-settings-section"><h3>Initialization</h3>${initialization}</section>` : ""}
          <section class="project-settings-section">
            <h3>Workflow</h3>
            <label>Plan directory<input name="planDirectory" value="${escape(settings.planDirectory)}" placeholder=".dext/plans" spellcheck="false"></label>
            <p class="project-help">Workspace-relative directory used when storage is set to Workspace. Global storage keeps its existing location.</p>
          </section>
          <section class="project-settings-section">
            <h3>Resource directories</h3>
            ${directoryList("apiDirs", "API directories", settings.apiDirs)}
            ${directoryList("skillDirs", "Skill directories", settings.skillDirs)}
            ${directoryList("mcpDirs", "MCP directories", settings.mcpDirs)}
            <p class="project-help" id="resource-directories-help">Enter workspace-relative directories separated by commas.</p>
          </section>
          <section class="project-settings-section">
            <h3>Agent tools</h3>
            <label class="project-checkbox-field"><input type="checkbox" name="structureQuery"${tool.structureQuery ? " checked" : ""}> Structure query tool</label>
            <label class="project-checkbox-field"><input type="checkbox" name="projectQuery"${tool.projectQuery !== false ? " checked" : ""}> Project norms query tool</label>
            <p class="project-help">Offers a read-only structure lookup (consumers, dependencies, hubs, communities and import paths) to Codex, Claude and DeepSeek conversations. It starts only after this project has a saved model and never reads source text or changes files. Turn it off to skip launching the tool for every Agent turn.</p>
          </section>
          <section class="project-settings-section project-evidence-settings" data-project-evidence-settings>
            <h3>Evidence reading</h3>
            <p class="project-help">Choose how much source text AI can read when initializing knowledge or generating diagrams.</p>
            <label>Reading depth<select name="depth">${Object.entries(PROJECT_EVIDENCE_DEPTHS).map(([id, value]) => `<option value="${id}"${id === evidence.depth ? " selected" : ""}>${id === "standard" ? "Standard" : id === "deep" ? "Deep" : "Whole"} · up to ${value.files} files · ${value.chars.toLocaleString("en-US")} characters</option>`).join("")}</select></label>
            <p class="project-help">Whole is the largest budget, with a 1,000-file limit. Text excerpts also depend on the character budget.</p>
            <details class="project-advanced-settings"><summary><i class="project-settings-chevron codicon codicon-chevron-right" aria-hidden="true"></i><span>Advanced reading settings</span><small>File limits and scope patterns</small></summary>
              <p class="project-help">Leave number fields empty to follow the selected depth. Custom values override it.</p>
              <div class="project-evidence-fields">${evidenceNumber(evidence, "files", "File limit", 1, 1000)}${evidenceNumber(evidence, "chars", "Total evidence characters", 20_000, 1_200_000)}${evidenceNumber(evidence, "fileChars", "Characters per file", 512, 262_144)}</div>
              <label>Reading scope<textarea name="include" rows="3" placeholder="src/**&#10;docs/**">${escape(evidence.include.join("\n"))}</textarea></label>
              <p class="project-help">One workspace-relative pattern per line. Empty uses the built-in README, documentation, manifest and source file set.</p>
              <button type="button" data-evidence-use-preset>Use depth defaults</button>
            </details>
            ${!evidenceConfigured ? '<button type="button" data-project-evidence-save>Save reading settings</button>' : ""}
          </section>
        </fieldset>
        <p class="project-help" role="status" aria-live="polite" data-project-settings-status>Changes save automatically.</p>
      </div>
    </details>
  </form>`;
}

export function projectSettingsScript(): string {
  return `(${bindProjectSettings.toString()})(api,${JSON.stringify(PROJECT_EVIDENCE_DEPTHS)});`;
}

function bindProjectSettings(api: { postMessage(message: unknown): void }, presets: typeof PROJECT_EVIDENCE_DEPTHS): void {
  const form = document.querySelector<HTMLFormElement>("[data-project-settings]");
  if (!form) return;
  const fieldset = form.querySelector<HTMLFieldSetElement>("[data-project-settings-fields]")!;
  const status = form.querySelector<HTMLElement>("[data-project-settings-status]")!;
  const value = (name: string): HTMLInputElement | HTMLSelectElement => form.elements.namedItem(name)! as HTMLInputElement;
  const input = (name: string): HTMLInputElement => form.elements.namedItem(name)! as HTMLInputElement;
  const checked = (name: string): boolean => form.querySelector<HTMLInputElement>(`input[name="${name}"]`)?.checked ?? false;
  const directoryValues = (name: string): string[] => [...form.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)].flatMap((item) => item.value.split(",").map((entry) => entry.trim()).filter(Boolean));
  const evidenceFields = ["files", "chars", "fileChars"] as const;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saving = false;
  let queued = false;
  let dirty = false;
  const readSettings = (): ProjectSettings => {
    const evidence: Record<string, unknown> = { depth: value("depth").value, include: input("include").value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) };
    for (const name of evidenceFields) if (input(name).value !== "") evidence[name] = Number(input(name).value);
    return {
      workspace: {
        planDirectory: value("planDirectory").value.trim(),
        apiDirs: directoryValues("apiDirs"),
        skillDirs: directoryValues("skillDirs"),
        mcpDirs: directoryValues("mcpDirs")
      },
      evidence: evidence as ProjectSettings["evidence"],
      tool: { structureQuery: checked("structureQuery"), projectQuery: checked("projectQuery") }
    };
  };
  const save = (): void => {
    timer = undefined;
    if (!form.reportValidity()) return;
    if (saving) { queued = true; return; }
    saving = true;
    fieldset.disabled = true;
    status.textContent = "Saving…";
    api.postMessage({ type: "projectSettings", settings: readSettings(), version: Number(form.dataset.version) });
  };
  const scheduleSave = (): void => {
    dirty = true;
    status.textContent = "Unsaved changes";
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 500);
  };
  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element) || !event.target.closest("[data-project-initialize]")) return;
    if (form.dataset.evidenceConfigured !== "false" && !dirty && !saving) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    form.querySelector<HTMLDetailsElement>("details")!.open = true;
    form.querySelector<HTMLDetailsElement>(".project-advanced-settings")!.open = true;
    status.textContent = saving ? "Wait for reading settings to finish saving before building the index."
      : "Save the reading depth and scope before building the index. Empty scope uses the built-in file set.";
    form.querySelector("[data-project-evidence-settings]")?.scrollIntoView({ block: "nearest" });
    input("include").focus();
  }, true);
  form.querySelector("[data-project-evidence-save]")?.addEventListener("click", scheduleSave);
  form.addEventListener("input", scheduleSave);
  form.addEventListener("change", (event) => {
    if (event.target instanceof Element && event.target.matches("[data-project-ai-cli]")) return;
    scheduleSave();
  });
  form.querySelector("[data-evidence-use-preset]")?.addEventListener("click", () => {
    for (const name of evidenceFields) input(name).value = "";
    scheduleSave();
  });
  form.querySelector("[name=depth]")?.addEventListener("change", () => {
    const depth = value("depth").value as keyof typeof presets;
    for (const name of evidenceFields) input(name).placeholder = String(presets[depth][name]);
    scheduleSave();
  });
  form.addEventListener("submit", (event) => { event.preventDefault(); scheduleSave(); });
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    const message = event.data && typeof event.data === "object" ? event.data as { type?: unknown; version?: unknown; error?: unknown } : {};
    if (message.type === "projectDefinitionVersion") {
      form.dataset.version = String(message.version);
      return;
    }
    if (message.type !== "projectSettingsSaved") return;
    saving = false;
    fieldset.disabled = false;
    const errorText = typeof message.error === "string" ? message.error : "Save failed.";
    status.textContent = message.error ? `Could not save: ${errorText}` : "Saved. New turns and resource reloads use this project configuration.";
    if (!message.error) {
      form.dataset.version = String(message.version);
      dirty = queued;
      form.dataset.evidenceConfigured = "true";
      document.querySelector("[data-project-evidence-required]")?.remove();
      form.querySelector("[data-project-evidence-save]")?.remove();
      if (queued) { queued = false; scheduleSave(); }
    }
  });
}

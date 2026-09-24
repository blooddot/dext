import { PROJECT_EVIDENCE_DEPTHS, type ProjectEvidenceSettings } from "../core/projectEvidenceSettings.js";
import type { ProjectSettings, ProjectWorkspaceSettings } from "../core/projectSettings.js";

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
    <input name="${name}" value="${escape(displayed.join(", "))}" spellcheck="false" aria-describedby="${name}-help">
    <span class="project-help" id="${name}-help">Enter workspace-relative directories separated by commas.</span>
  </label>`;
}

function evidenceNumber(settings: ProjectEvidenceSettings, key: "files" | "chars" | "fileChars", label: string, min: number, max: number): string {
  const preset = PROJECT_EVIDENCE_DEPTHS[settings.depth];
  return `<label>${label}<input type="number" name="${key}" min="${min}" max="${max}" step="1" value="${settings[key] ?? ""}" placeholder="${preset[key]}"></label>`;
}

export function renderProjectSettings(settings: ProjectWorkspaceSettings, evidence: ProjectEvidenceSettings, version: number, disabled: boolean, initialization: string): string {
  const depth = evidence.depth === "standard" ? "Standard" : evidence.depth === "deep" ? "Deep" : "Whole";
  const review = settings.reviewPreset === "engineering" ? "Engineering" : "Experience";
  return `<form class="project-settings project-workspace-settings" data-project-settings data-version="${version}">
    <details>
      <summary><i class="project-settings-chevron codicon codicon-chevron-right" aria-hidden="true"></i><span class="project-settings-summary-content"><strong>Project settings</strong><span>${depth} · ${review} · ${escape(settings.planDirectory)}</span></span><span class="project-settings-summary-hint">Click to expand</span></summary>
      <div class="project-workspace-settings-body">
        <p class="project-help">Project-owned choices travel with the project in <code>.dext/project.json</code> and apply automatically to new turns and resource reloads.</p>
        <fieldset data-project-settings-fields${disabled ? " disabled" : ""}>
          ${initialization ? `<section class="project-settings-section"><h3>Initialization</h3>${initialization}</section>` : ""}
          <section class="project-settings-section">
            <h3>Review &amp; workflow</h3>
            <label>Default Review<select name="reviewPreset"><option value="engineering"${settings.reviewPreset === "engineering" ? " selected" : ""}>Engineering · correctness and implementation evidence</option><option value="experience"${settings.reviewPreset === "experience" ? " selected" : ""}>Experience · user behavior and visible outcome</option></select></label>
            <label>Plan directory<input name="planDirectory" value="${escape(settings.planDirectory)}" placeholder=".dext/plans" spellcheck="false"></label>
            <p class="project-help">Workspace-relative directory used when storage is set to Workspace. Global storage keeps its existing location.</p>
          </section>
          <section class="project-settings-section">
            <h3>Resource directories</h3>
            ${directoryList("apiDirs", "API directories", settings.apiDirs)}
            ${directoryList("skillDirs", "Skill directories", settings.skillDirs)}
            ${directoryList("mcpDirs", "MCP directories", settings.mcpDirs)}
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
  const directoryValues = (name: string): string[] => [...form.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)].flatMap((item) => item.value.split(",").map((entry) => entry.trim()).filter(Boolean));
  const evidenceFields = ["files", "chars", "fileChars"] as const;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saving = false;
  let queued = false;
  const readSettings = (): ProjectSettings => {
    const evidence: Record<string, unknown> = { depth: value("depth").value, include: input("include").value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) };
    for (const name of evidenceFields) if (input(name).value !== "") evidence[name] = Number(input(name).value);
    return {
      workspace: {
        reviewPreset: value("reviewPreset").value as ProjectSettings["workspace"]["reviewPreset"],
        planDirectory: value("planDirectory").value.trim(),
        apiDirs: directoryValues("apiDirs"),
        skillDirs: directoryValues("skillDirs"),
        mcpDirs: directoryValues("mcpDirs")
      },
      evidence: evidence as ProjectSettings["evidence"]
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
    status.textContent = "Unsaved changes";
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 500);
  };
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
      document.querySelector("[data-project-legacy-scan]")?.remove();
      if (queued) { queued = false; scheduleSave(); }
    }
  });
}

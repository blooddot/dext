import * as vscode from "vscode";
import {
  COMPLETION_APIS,
  DEFAULT_ENDPOINTS,
  isChatApi,
  requiresApiKey,
  type CompletionApi,
  type CompletionSettings
} from "./core/completionProvider.js";

export interface CompletionSetupOptions {
  settings: () => CompletionSettings;
  writeSettings: (patch: Partial<CompletionSettings>) => Promise<void>;
  apiKey: () => Promise<string | undefined>;
  setApiKey: (value: string) => Promise<void>;
  clearApiKey: () => Promise<void>;
  /** Resolves with the sample completion, or rejects with why it failed. */
  verify: (settings: CompletionSettings, apiKey?: string) => Promise<string>;
  /** Whether completion is currently switched off for this window only. */
  suspended: () => boolean;
  toggle: () => void;
  refresh: () => void;
  /** Which settings file the value in force came from, if it can be told. */
  scope?: (field: keyof CompletionSettings) => string;
}

interface Format {
  label: string;
  description: string;
  detail: string;
}

const FORMATS: Record<CompletionApi, Format> = {
  openai: {
    label: "OpenAI-compatible FIM",
    description: "POST <base>/completions",
    detail:
      "Sends a prefix and a suffix to a fill-in-the-middle model. The fastest and most accurate option, but only dedicated FIM models serve it: a chat model here answers with a body this format cannot read."
  },
  "openai-chat": {
    label: "OpenAI Chat Completions",
    description: "POST <base>/chat/completions",
    detail:
      "What most providers expose, including DeepSeek, Qwen and OpenAI's own current models. There is no suffix field, so the code around the cursor is sent as a chat prompt. Choose this if unsure."
  },
  anthropic: {
    label: "Anthropic Messages",
    description: "POST <base>/messages",
    detail:
      "Claude has no fill-in-the-middle endpoint, so the code around the cursor is sent as a chat prompt instead. Slower and less exact than a real FIM model."
  },
  ollama: {
    label: "Ollama",
    description: "POST <base>/api/generate",
    detail: "A local Ollama server, using its own fill-in-the-middle fields. No API key required."
  }
};

const STEPS = 4;
const TITLE = "Dext completion model";

function step(index: number): string {
  return `${TITLE} (${index}/${STEPS})`;
}

function summarize(settings: CompletionSettings): string {
  if (!settings.endpoint || !settings.model) return "Not configured";
  return `${FORMATS[settings.api].label} · ${settings.model}`;
}

/** A base URL that is not a URL produces a completion that silently never
 * arrives, so it is worth catching while the box is still open. */
function validateEndpoint(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return "A base URL is required.";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "Enter a full URL, including the scheme.";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return "The URL must use http or https.";
  }
  return undefined;
}

/** The Trae-style setup flow: pick a format, then fill in the three things that
 * differ between providers. Linear rather than a form, because that is what VS
 * Code offers natively and it matches `dext.configureAgent`. */
export async function configureCompletionModel(options: CompletionSetupOptions): Promise<void> {
  const current = options.settings();

  const format = await vscode.window.showQuickPick(
    COMPLETION_APIS.map((api) => ({
      ...FORMATS[api],
      api,
      picked: api === current.api
    })),
    {
      title: step(1),
      placeHolder: "Choose the API format the completion model speaks",
      ignoreFocusOut: true,
      matchOnDetail: true
    }
  );
  if (!format) return;

  const endpoint = await vscode.window.showInputBox({
    title: step(2),
    prompt: `Base URL. Dext appends the API path, so ${FORMATS[format.api].description.replace("POST ", "")} is reached either way.`,
    value: current.api === format.api && current.endpoint ? current.endpoint : DEFAULT_ENDPOINTS[format.api],
    ignoreFocusOut: true,
    validateInput: validateEndpoint
  });
  if (endpoint === undefined) return;

  const model = await vscode.window.showInputBox({
    title: step(3),
    prompt: isChatApi(format.api)
      ? "Model ID. Prefer the fastest model available: this runs between keystrokes."
      : "Model ID. It must support fill-in-the-middle, since Dext sends both a prefix and a suffix.",
    value: current.api === format.api ? current.model : "",
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : "A model ID is required.")
  });
  if (model === undefined) return;

  const existingKey = await options.apiKey();
  let apiKey = existingKey;
  if (requiresApiKey(format.api)) {
    const entered = await vscode.window.showInputBox({
      title: step(4),
      prompt: existingKey
        ? "API key. Leave empty to keep the key already stored."
        : "API key. It is kept in VS Code's encrypted secret storage, never in settings.",
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) =>
        value.trim() || existingKey ? undefined : "An API key is required for this format."
    });
    if (entered === undefined) return;
    if (entered.trim()) apiKey = entered.trim();
  }

  const candidate: CompletionSettings = {
    ...current,
    api: format.api,
    endpoint: endpoint.trim(),
    model: model.trim(),
    enabled: true
  };

  const tested = await offerTest(options, candidate, apiKey);
  if (!tested) return;

  if (requiresApiKey(format.api) && apiKey && apiKey !== existingKey) {
    await options.setApiKey(apiKey);
  }
  await options.writeSettings({
    api: candidate.api,
    endpoint: candidate.endpoint,
    model: candidate.model,
    enabled: true
  });
  options.refresh();
  await vscode.window.showInformationMessage(
    `Dext completion is on for every project, using ${summarize(candidate)}.${overrideWarning(options)}`
  );
}

/** The wizard writes to user settings so a model is configured once. A project
 * that sets the same key wins over that, and the only symptom is a model that
 * works in one window and not the next, so it gets said out loud. */
function overrideWarning(options: CompletionSetupOptions): string {
  if (!options.scope) return "";
  const overridden = (["api", "endpoint", "model", "enabled"] as const).filter(
    (field) => options.scope?.(field) !== "user"
  );
  if (overridden.length === 0) return "";
  return ` This project overrides ${overridden.join(", ")} in its own settings, which will win here.`;
}

/** Returns false only when the user backed out. A failed test still offers to
 * save, since a provider can be down while the settings are right. */
async function offerTest(
  options: CompletionSetupOptions,
  candidate: CompletionSettings,
  apiKey: string | undefined
): Promise<boolean> {
  const choice = await vscode.window.showQuickPick(
    [
      {
        label: "Test connection and save",
        detail: "Sends one real completion request, which uses a small number of tokens.",
        test: true
      },
      { label: "Save without testing", detail: "", test: false }
    ],
    { title: TITLE, placeHolder: "Ready to save", ignoreFocusOut: true }
  );
  if (!choice) return false;
  if (!choice.test) return true;

  const failure = await runTest(options, candidate, apiKey);
  if (!failure) return true;
  const retry = await vscode.window.showWarningMessage(failure, { modal: true }, "Save anyway");
  return retry === "Save anyway";
}

/** Resolves with the failure message, or undefined when the model answered. */
async function runTest(
  options: CompletionSetupOptions,
  candidate: CompletionSettings,
  apiKey: string | undefined
): Promise<string | undefined> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Testing the Dext completion model..." },
    async () => {
      try {
        await options.verify(candidate, apiKey);
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }
  );
}

/** Runs the connectivity test against whatever is configured right now. */
export async function testCompletionModel(options: CompletionSetupOptions): Promise<void> {
  const settings = options.settings();
  if (!settings.endpoint || !settings.model) {
    await vscode.window.showInformationMessage("Set up a completion model first.");
    await configureCompletionModel(options);
    return;
  }
  const failure = await runTest(options, settings, await options.apiKey());
  if (failure) {
    await vscode.window.showErrorMessage(failure);
    return;
  }
  await vscode.window.showInformationMessage(`${summarize(settings)} answered.`);
}

export interface CompletionDiagnostics {
  /** How many times the editor has asked the provider for a completion. */
  invocations: number;
  outcome: string;
  since: string;
}

/** Builds the report shown by the diagnose command. Pure so the wording is
 * testable: the whole point is that it names one concrete cause. */
export function diagnosisReport(input: {
  settings: CompletionSettings;
  hasKey: boolean;
  suspended: boolean;
  inlineSuggestEnabled: boolean;
  editor: { languageId: string; scheme: string; path: string } | undefined;
  report: CompletionDiagnostics;
  probe: { completion: string } | { error: string } | undefined;
  /** Which settings file each value came from, if it can be determined. */
  scope?: (field: keyof CompletionSettings) => string;
}): string {
  const lines: string[] = [];
  const settings = input.settings;
  lines.push("# Dext inline completion");
  lines.push("");
  const scope = (field: keyof CompletionSettings): string =>
    input.scope ? ` [from ${input.scope(field)} settings]` : "";
  lines.push(`Format:    ${settings.api}${scope("api")}`);
  lines.push(`Endpoint:  ${settings.endpoint || "(not set)"}${scope("endpoint")}`);
  lines.push(`Model:     ${settings.model || "(not set)"}${scope("model")}`);
  lines.push(`API key:   ${input.hasKey ? "stored" : "none stored"}`);
  lines.push(`Enabled:   ${settings.enabled}${scope("enabled")}`);
  lines.push(`Budget:    ${settings.maxTokens} tokens, ${settings.timeoutMs}ms timeout`);
  lines.push(`Suspended: ${input.suspended} (this window only)`);
  lines.push("");
  lines.push(`Editor asked for a completion ${input.report.invocations} time(s).`);
  lines.push(`Last outcome: ${input.report.outcome} (${input.report.since})`);
  if (input.editor) {
    lines.push(`Active file:  ${input.editor.path} [${input.editor.languageId}, ${input.editor.scheme}]`);
  } else {
    lines.push("Active file:  none");
  }
  lines.push("");

  if (input.probe) {
    lines.push("A request sent from the current cursor, bypassing the debounce and cache:");
    lines.push("error" in input.probe
      ? `  FAILED: ${input.probe.error}`
      : `  OK: ${JSON.stringify(input.probe.completion)}`);
    lines.push("");
  }

  lines.push("## What this means");
  lines.push("");
  for (const line of conclusions(input)) lines.push(`- ${line}`);
  return lines.join("\n");
}

function conclusions(input: Parameters<typeof diagnosisReport>[0]): string[] {
  const found: string[] = [];
  if (!input.settings.endpoint || !input.settings.model) {
    found.push("No endpoint or model is set. Run 'Dext: Configure Completion Model'.");
  } else if (!input.settings.enabled) {
    found.push("dext.completion.enabled is false, so the provider returns nothing.");
  }
  if (input.suspended) found.push("Completion is switched off for this window. Use the status bar item.");
  if (!input.inlineSuggestEnabled) {
    found.push(
      "editor.inlineSuggest.enabled is false. No extension can show ghost text while that is off, "
      + "whatever Dext does."
    );
  }
  if (input.report.invocations === 0) {
    found.push(
      "The editor has never called the provider, so nothing inside Dext has run and no setting here can be "
      + "the cause. Note that Tab does not ask for a completion: ghost text appears on its own while you "
      + "type, and Tab only accepts what is already showing. Type a few characters and run this again. If "
      + "the count stays at zero, another inline completion extension is winning the slot."
    );
  }
  if (input.probe && "error" in input.probe) {
    found.push(`The backend itself is failing: ${input.probe.error}`);
  }
  // The one case where the check above passes and typing still fails: the probe
  // is allowed at least ten seconds, so a tighter timeoutMs kills the real
  // request while the diagnosis looks healthy.
  if (/did not answer within/.test(input.report.outcome)) {
    found.push(
      `The request timed out at dext.completion.timeoutMs = ${input.settings.timeoutMs}ms. `
      + "The model is slower than that. Raise the setting, or lower maxTokens so there is less to generate."
    );
  } else if (input.report.outcome.startsWith("the request failed")) {
    found.push(`The last real request failed where the test did not: ${input.report.outcome}`);
  }
  if (
    input.probe && "completion" in input.probe && input.probe.completion.trim()
    && /nothing to insert|did not answer|request failed/.test(input.report.outcome)
  ) {
    found.push(
      "The same cursor answers when asked directly but not while typing, so the backend is fine and the "
      + "difference is timing: the probe allows at least 10000ms."
    );
  }
  if (input.probe && "completion" in input.probe && !input.probe.completion.trim()) {
    found.push("The backend answered with nothing to insert at this cursor. Try a position mid-function.");
  }
  if (!found.length) {
    found.push(
      "Everything Dext controls looks correct and the backend answers. If there is still no ghost text, "
      + "the editor is not rendering it: check for another inline completion provider."
    );
  }
  return found;
}

export interface CompletionDiagnoseOptions extends CompletionSetupOptions {
  report: () => CompletionDiagnostics;
  probe: (document: vscode.TextDocument, position: vscode.Position) => Promise<string>;
  scope: (field: keyof CompletionSettings) => string;
}

/** Turns "it does not work" into one named cause. Written to an output channel
 * rather than a notification, because the answer is worth copying. */
export async function diagnoseCompletion(
  options: CompletionDiagnoseOptions,
  channel: vscode.OutputChannel
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  let probe: { completion: string } | { error: string } | undefined;
  if (editor && options.settings().endpoint && options.settings().model) {
    try {
      probe = { completion: await options.probe(editor.document, editor.selection.active) };
    } catch (error) {
      probe = { error: error instanceof Error ? error.message : String(error) };
    }
  }
  const report = diagnosisReport({
    settings: options.settings(),
    hasKey: Boolean(await options.apiKey()),
    suspended: options.suspended(),
    inlineSuggestEnabled:
      vscode.workspace.getConfiguration("editor").get<boolean>("inlineSuggest.enabled", true) !== false,
    editor: editor
      ? {
        languageId: editor.document.languageId,
        scheme: editor.document.uri.scheme,
        path: vscode.workspace.asRelativePath(editor.document.uri, false)
      }
      : undefined,
    report: options.report(),
    probe,
    scope: options.scope
  });
  channel.clear();
  channel.appendLine(report);
  channel.show(true);
}

interface MenuItem extends vscode.QuickPickItem {
  run: () => Promise<void> | void;
}

/** What the status bar item opens. Everything reachable in one click, so the
 * key and the model it belongs to are never configured in separate places. */
export async function openCompletionMenu(options: CompletionSetupOptions): Promise<void> {
  const settings = options.settings();
  const configured = Boolean(settings.endpoint && settings.model);
  const hasKey = Boolean(await options.apiKey());
  const items: MenuItem[] = [
    {
      label: configured ? "$(gear) Configure completion model..." : "$(sparkle) Set up completion model...",
      description: summarize(settings),
      run: () => configureCompletionModel(options)
    }
  ];

  if (settings.enabled) {
    items.push({
      label: options.suspended() ? "$(check) Turn on for this window" : "$(circle-slash) Turn off for this window",
      description: "Leaves settings alone",
      run: () => options.toggle()
    });
  } else if (configured) {
    // Configured but switched off in settings, so the way back is a setting
    // rather than the per-window switch.
    items.push({
      label: "$(check) Enable inline completion",
      run: async () => {
        await options.writeSettings({ enabled: true });
        options.refresh();
      }
    });
  }

  if (configured) {
    items.push({
      label: "$(pulse) Test connection",
      description: "Sends one real request",
      run: () => testCompletionModel(options)
    });
  }

  items.push({
    label: "$(question) Why is there no suggestion?",
    description: "Reports which step is stopping it",
    run: async () => void await vscode.commands.executeCommand("dext.diagnoseCompletion")
  });

  if (requiresApiKey(settings.api)) {
    items.push({
      label: hasKey ? "$(key) Replace API key" : "$(key) Set API key",
      run: () => setCompletionApiKey(options)
    });
    if (hasKey) {
      items.push({
        label: "$(trash) Clear API key",
        run: async () => {
          await options.clearApiKey();
          options.refresh();
          await vscode.window.showInformationMessage("Cleared the Dext completion API key.");
        }
      });
    }
  }

  if (settings.enabled) {
    items.push({
      label: "$(close) Disable inline completion",
      description: "Hides this status item until it is set up again",
      run: async () => {
        await options.writeSettings({ enabled: false });
        options.refresh();
      }
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: TITLE,
    placeHolder: configured ? summarize(settings) : "Inline completion is not configured"
  });
  await picked?.run();
}

/** Kept as its own command so a key can be rotated without walking the wizard. */
export async function setCompletionApiKey(options: CompletionSetupOptions): Promise<void> {
  const key = await vscode.window.showInputBox({
    title: TITLE,
    prompt: "API key. It is kept in VS Code's encrypted secret storage, never in settings.",
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : "An API key cannot be empty.")
  });
  if (key === undefined) return;
  await options.setApiKey(key);
  options.refresh();
  await vscode.window.showInformationMessage("Stored the Dext completion API key.");
}

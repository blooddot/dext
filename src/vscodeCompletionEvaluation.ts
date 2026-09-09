import * as vscode from "vscode";
import { CompletionClient, requiresApiKey, type CompletionSettings } from "./core/completionProvider.js";
import { HttpCompletionBackend, type CompletionBackend } from "./core/completionBackend.js";
import { evaluationSampleCount, runCompletionEvaluation } from "./core/completionEvaluation.js";
import quality from "../test/fixtures/completionQuality.json";
import sequences from "../test/fixtures/completionAdaptation.json";
import type { CompletionQualityCase } from "./core/completionEvaluation.js";

export interface CompletionEvaluationHostOptions {
  settings: (uri?: vscode.Uri) => CompletionSettings;
  apiKey: () => Promise<string | undefined>;
  credentialStatus?: () => Promise<{ storageReadable: boolean; globalPresent: boolean; currentLegacyPresent: boolean; otherLegacyCount?: number }>;
  scope: (field: keyof CompletionSettings, uri?: vscode.Uri) => string;
  output: Pick<vscode.OutputChannel, "appendLine" | "show">;
  /** Injection for editor integration tests; never needed by the production command. */
  client?: () => CompletionClient;
}

/** Runs only on an explicit command. Never exports Profile credentials to a subprocess. */
export class DextCompletionEvaluation {
  private active: AbortController | undefined;
  constructor(private readonly options: CompletionEvaluationHostOptions) {}
  dispose(): void { this.active?.abort(); }
  async run(kind?: "quality" | "adaptation" | "performance") {
    if (this.active) { void vscode.window.showInformationMessage("A completion evaluation is already running."); return; }
    const controller = new AbortController(); this.active = controller;
    let owned: CompletionBackend | undefined;
    try {
      const uri = vscode.window.activeTextEditor?.document.uri;
      const settings = this.options.settings(uri);
      const choices = [
        { label: "Quality — 3 rounds", evaluationKind: "quality" as const, repeat: 3 },
        { label: "Adaptation — off / session / workspace", evaluationKind: "adaptation" as const, repeat: 3 },
        { label: "Latency — 100 samples", evaluationKind: "performance" as const, repeat: 100 }
      ];
      // Programmatic calls are explicit commands too. Validate before reading
      // credentials; no caller can override model, account or request budget.
      if (kind !== undefined && !choices.some((choice) => choice.evaluationKind === kind)) throw new Error("Unknown evaluation kind.");
      const selected = kind === undefined ? await vscode.window.showQuickPick(choices,
        { title: "Evaluate the current Profile's completion model", placeHolder: "Uses model requests; does not change your completion settings or project memory" })
        : choices.find((choice) => choice.evaluationKind === kind);
      if (!selected || controller.signal.aborted) return;
      // Explicit evaluation is allowed when automatic suggestions are disabled.
      // This copy is never written back to Profile settings.
      const run = { settings: { ...settings, enabled: true }, kind: selected.evaluationKind, repeat: selected.repeat, cases: quality as CompletionQualityCase[], sequences };
      const planned = evaluationSampleCount(run);
      let backend: CompletionBackend;
      let keyPresent = false;
      {
        if (!settings.endpoint || !settings.model) {
          void vscode.window.showErrorMessage("The active Profile and document have no effective HTTP endpoint/model. Open Dext completion diagnostics; no settings were changed."); return this.notStarted("missing_configuration", planned);
        }
        const key = await this.options.apiKey(); keyPresent = Boolean(key);
        if (requiresApiKey(settings.api) && !key) {
          const credentialStatus = await this.options.credentialStatus?.();
          if (credentialStatus) this.options.output.appendLine(JSON.stringify({ credentialStatus }));
          this.options.output.show(true);
          void vscode.window.showErrorMessage("The active Profile's completion credential is unavailable from VS Code SecretStorage. No alternate credential was used.");
          return { ...this.notStarted("missing_credential", planned), credentialStatus };
        }
        owned = backend = new HttpCompletionBackend(this.options.client?.() ?? new CompletionClient(), () => Promise.resolve(key));
      }
      if (controller.signal.aborted) return;
      const output = this.options.output;
      output.appendLine(JSON.stringify({ evaluation: selected.evaluationKind, backend: "http", model: settings.model,
        api: settings.api, automaticEnabled: settings.enabled, keyPresent, planned,
        settingSources: Object.fromEntries(["endpoint", "model", "api"].map((field) => [field, this.options.scope(field as keyof CompletionSettings, uri)])),
        context: "Bundled synthetic fixtures; source documents and account credentials are not exported." }));
      output.show(true);
      return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Dext completion evaluation", cancellable: true }, async (progress, token) => {
        const listener = token.onCancellationRequested(() => controller.abort());
        if (token.isCancellationRequested) controller.abort();
        let completed = 0;
        try {
          const report = await runCompletionEvaluation({ ...run, backend, signal: controller.signal,
            onRow: (row, total) => {
              completed++; progress.report({ increment: 100 / total, message: `${completed}/${total}` });
              // Model output is untrusted and may echo confidential provider text. Only bounded metrics are logged.
              const metrics = { id: row.id, category: row.category, outcome: row.outcome, score: row.score,
                elapsedMs: row.elapsedMs, inputChars: row.inputChars, round: row.round, mode: row.mode, sequence: row.sequence };
              output.appendLine(JSON.stringify(metrics));
            } });
          const summary = { planned: report.planned, attempted: report.attempted, stopReason: report.stopReason,
            summaries: report.summaries, limitation: report.limitation };
          output.appendLine(JSON.stringify(summary));
          return summary; // No credentials, prompts, model output or source code.
        } finally { listener.dispose(); }
      });
    } catch {
      // Errors from credential stores, gateways or RPCs can contain secrets.
      void vscode.window.showErrorMessage("Completion evaluation failed. Check the sanitized Dext Completion report; your configuration and login were preserved.");
      return this.notStarted("preparation_failed", 0);
    } finally { owned?.dispose(); if (this.active === controller) this.active = undefined; }
  }
  private notStarted(stopReason: string, planned: number) {
    const result = { planned, attempted: 0, stopReason, summaries: [], limitation: "No model generation started." };
    this.options.output.appendLine(JSON.stringify(result));
    return result;
  }
}

import * as vscode from "vscode";
import type { ImportVariantOptions } from "../domain/skillImportVariants.js";

function label(agent: string): string {
  return ({ shared: "Shared", codex: "Codex", claude: "Claude", opencode: "OpenCode", openclaw: "OpenClaw", copilot: "GitHub Copilot", cursor: "Cursor", gemini: "Gemini" } as Record<string, string>)[agent] ?? agent;
}

async function pick<T extends vscode.QuickPickItem>(items: T[], title: string, signal?: AbortSignal): Promise<T | undefined> {
  signal?.throwIfAborted();
  const cancellation = new vscode.CancellationTokenSource();
  const abort = (): void => cancellation.cancel();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const selected = await vscode.window.showQuickPick(items, { title, matchOnDetail: true, ignoreFocusOut: true }, cancellation.token);
    signal?.throwIfAborted();
    return selected;
  } finally {
    signal?.removeEventListener("abort", abort);
    cancellation.dispose();
  }
}

/** Source choices happen before drafting. Create remains the existing review
 * and save step; a picker never installs files or changes the active Agent. */
export function skillImportChoices(preferredAgent?: string, signal?: AbortSignal): ImportVariantOptions {
  return {
    ...(preferredAgent ? { preferredAgent } : {}),
    async chooseTarget(request) {
      const targets = [...request.targets].sort((a, b) => Number(b === request.recommended) - Number(a === request.recommended) || a.localeCompare(b));
      const selected = await pick(targets.map((agent) => ({
        label: label(agent), agent,
        ...(agent === request.recommended ? { description: "Recommended" } : {}),
        detail: request.sources.filter((source) => source.agent === agent || source.agent === "shared").map((source) => source.path || ".").slice(0, 5).join(", ")
      })), "Choose Skill import version — shared files fill gaps in the selected version", signal);
      return selected?.agent;
    },
    async chooseVariant(request) {
      const selected = await pick(request.sources.map((source) => ({
        label: source.path || ".", description: label(source.agent), path: source.path,
        detail: `Different ${request.kind} content for ${request.id}; import target: ${label(request.targetAgent)}`
      })), `Choose source for ${request.kind} '${request.id}'`, signal);
      return selected?.path;
    }
  };
}

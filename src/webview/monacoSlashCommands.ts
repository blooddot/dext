import { monaco } from "./monacoEnvironment.js";
import { DEXT_COMPOSER_SCHEME } from "./monacoTypescript.js";
import type { SkillCommandSummary } from "../features/workflow/contracts/skill.js";
import { commandsForSelection, isSlashCommandPrefix } from "../features/conversations/browser/skillSelection.js";

export interface SlashCommandContext {
  commands: readonly SkillCommandSummary[];
  selectedSkillIds: readonly string[];
}

/** Offers installed `/commands` in the plain-text chat composer. Only the first
 * token of the line is a command, and only commands whose skill is selected
 * appear. Code mode is TypeScript, so this provider never fires there. */
export function registerSlashCommandProvider(context: () => SlashCommandContext): monaco.IDisposable {
  return monaco.languages.registerCompletionItemProvider(
    { language: "plaintext", scheme: DEXT_COMPOSER_SCHEME },
    {
      triggerCharacters: ["/"],
      provideCompletionItems(model, position) {
        if (model.uri.scheme !== DEXT_COMPOSER_SCHEME) return { suggestions: [] };
        const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
        if (!isSlashCommandPrefix(before)) return { suggestions: [] };
        const state = context();
        const range = new monaco.Range(position.lineNumber, 1, position.lineNumber, position.column);
        return {
          suggestions: commandsForSelection(state.commands, state.selectedSkillIds).map((command, index) => ({
            label: `/${command.id}`,
            kind: monaco.languages.CompletionItemKind.Method,
            insertText: `/${command.id} `,
            filterText: `/${command.id}`,
            sortText: String(index).padStart(4, "0"),
            detail: command.title,
            documentation: [
              command.description,
              command.argumentHint ? `Arguments: ${command.argumentHint}` : "",
              command.packName ? `Pack: ${command.packName}` : ""
            ].filter(Boolean).join("\n\n"),
            range
          }))
        };
      }
    }
  );
}

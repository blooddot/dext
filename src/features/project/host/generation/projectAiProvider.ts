import type { WorkflowRuntime } from "../../../workflow/contracts/runtime.js";
import type { AgentStreamEvent } from "../../../../shared/contracts/types.js";
import type { AgentProfile, AgentSelection } from "../../../agents/contracts/agent.js";
import { outputLanguageInstruction, type ResolvedOutputLanguage } from "../../../agents/domain/outputLanguage.js";
import type { ProjectAiActivityEvent, ProjectAiProvider, ProjectAiRequest } from "./projectAiGeneration.js";
export interface ProjectAiDependencies {
  runtime: WorkflowRuntime;
  listProfiles(): readonly AgentProfile[];
  profiles(): readonly AgentProfile[];
  selection(): AgentSelection;
  /** The interaction language the conversation turns use; Project text follows it. */
  language?(): ResolvedOutputLanguage | undefined;
}
/**
 * Some Anthropic-compatible gateways reject a replayed assistant turn whose thinking text and
 * signature both came back empty: the API then answers 400 "the `content[].thinking` in the
 * thinking mode must be passed back". The block the API asks for was never produced, so no prompt
 * change can repair the history. A Project call is a stateless read-only ask, which makes one
 * retry without thinking both safe and sufficient: without thinking there is nothing to replay.
 */
const THINKING_REPLAY_FAILURE = /content\[\]\.thinking|thinking mode must be passed back/i;
export function isThinkingReplayFailure(error: unknown): boolean {
  return error instanceof Error && THINKING_REPLAY_FAILURE.test(error.message);
}
export function createProjectAiProvider(dependencies: ProjectAiDependencies): ProjectAiProvider { return new ProjectAiBridge(dependencies).projectAiProvider(); }
class ProjectAiBridge {
  constructor(private readonly dependencies: ProjectAiDependencies) { }


  /** Project-only model bridge. It uses the selected CLI in read-only Ask mode and never alters composer input. */
  projectAiProvider(): ProjectAiProvider {
    return {
      id: "selected-agent",
      generate: async (input, signal) => {
        // Project generation bypasses the conversation turn, so it applies the interaction
        // language itself; otherwise every drafted body follows the model's own choice.
        const instruction = outputLanguageInstruction(this.dependencies.language?.());
        const request: ProjectAiRequest = instruction
          ? { ...input, prompt: `${input.prompt}\n\n${instruction}\n- Write Project knowledge titles and bodies in that language too; keep code, file paths and identifiers unchanged.` }
          : input;
        const model = request.agent
          ? request.model ?? this.dependencies.listProfiles().find((profile) => profile.id === request.agent)?.defaults?.model
          : this.dependencies.selection().model;
        const structured = await this.generateProjectStructured(request, signal);
        if (structured !== undefined) return { text: structured, ...(model ? { model } : {}) };
        const ask = (reasoningEffort?: string) => this.dependencies.runtime.executeConversation("ask", request.prompt, {
          signal,
          ...(request.agent ? { agent: request.agent } : {}),
          ...(request.model ? { model: request.model } : {}),
          ...(reasoningEffort ?? request.reasoningEffort ? { reasoningEffort: (reasoningEffort ?? request.reasoningEffort) } : {}),
          ...(request.speed ? { speed: request.speed } : {}),
          ...(request.onEvent ? { onAgentEvent: this.projectAiEventSink(request.onEvent) } : {})
        });
        let response: Awaited<ReturnType<typeof ask>>;
        try {
          response = await ask();
        } catch (error) {
          // A cancellation is the caller's decision, and any other failure still belongs to the stage.
          if (signal.aborted || !isThinkingReplayFailure(error)) throw error;
          request.onEvent?.({
            id: "project-ai-thinking-fallback",
            phase: "status",
            title: "Thinking could not be replayed",
            text: `${error instanceof Error ? error.message : "The provider rejected the turn."} Dext retried this Project call without thinking.`,
            done: true
          });
          response = await ask("off");
        }
        const text = response.result.kind === "ask" ? response.result.text : JSON.stringify(response.result);
        return { text, ...(model ? { model } : {}) };
      }
    };
  }


  /** Public Project activity is the agent stream event minus the private phases. */
  private projectAiEventSink(onEvent: (event: ProjectAiActivityEvent) => void): (event: AgentStreamEvent) => void {
    return (event) => {
      if (event.phase !== "status" && event.phase !== "message" && event.phase !== "tool") return;
      onEvent({
        phase: event.phase, text: event.text,
        ...(event.id !== undefined ? { id: event.id } : {}),
        ...(event.title !== undefined ? { title: event.title } : {}),
        ...(event.replace !== undefined ? { replace: event.replace } : {}),
        ...(event.done !== undefined ? { done: event.done } : {}),
        ...(event.usage !== undefined ? { usage: event.usage } : {})
      });
    };
  }


  /**
   * Project generation on the provider's own structured-output channel, whenever
   * the selected CLI has one. Codex and Claude enforce the schema server-side,
   * so the answer cannot drift into prose, an envelope or a fenced block, and
   * the Project repair loop becomes a second line of defence rather than the
   * only one.
   *
   * Returns undefined to select the conversation transport instead. The Harness
   * has no schema field in ACP at all, and a CLI build that refuses the schema -
   * or simply fails to start - must not cost the user a Project initialization
   * when the previous path still works.
   */
  private async generateProjectStructured(request: ProjectAiRequest, signal: AbortSignal): Promise<string | undefined> {
    const profileId = request.agent ?? this.dependencies.selection().profileId;
    // The same profile set the runtime resolves against, so routing can never
    // disagree with the backend the conversation transport would pick.
    const profile = this.dependencies.profiles().find((item) => item.id === profileId);
    if (!profile || (profile.provider !== "codex" && profile.provider !== "claude")) return undefined;
    try {
      const response = await this.dependencies.runtime.executeStructuredJson(request.prompt, { ...request.responseSchema }, {
        signal,
        ...(request.agent ? { agent: request.agent } : {}),
        ...(request.model ? { model: request.model } : {}),
        ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
        ...(request.speed ? { speed: request.speed } : {}),
        ...(request.onEvent ? { onAgentEvent: this.projectAiEventSink(request.onEvent) } : {})
      });
      return response.text;
    } catch (error) {
      // A cancellation is the caller's decision, not a transport downgrade.
      if (signal.aborted) throw error;
      request.onEvent?.({
        id: "project-ai-structured-fallback",
        phase: "status",
        title: "Native output schema unavailable",
        text: `${profile.label} could not use its native output schema, so Dext retried through the conversation transport. ${error instanceof Error ? error.message : "Unknown provider error."}`,
        done: true
      });
      return undefined;
    }
  }
}

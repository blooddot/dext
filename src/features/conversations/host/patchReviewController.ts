import type { ApplyResult, InputExecutionResponse, PatchResult, RegisteredCallable } from "../../../core/types.js";
import type { DeterministicHandler } from "../../../core/runtime.js";
import type { ConversationWebviewResponse } from "../contracts/protocol.js";

/** An `agent(apply=False)` step proposes changes and writes nothing, so its
 * patch is the one Dext holds for review. A step that was allowed to write has
 * already landed and must not be offered again. */
function unappliedPatch(response: InputExecutionResponse): PatchResult | undefined {
  const changes: PatchResult["changes"] = [];
  let title = "Proposed changes";
  for (const execution of response.executions) {
    if (execution.result.kind !== "agent" || !execution.result.patch) continue;
    const applied = execution.invocation.arguments
      .some((argument) => argument.name === "apply" && argument.value !== false);
    if (applied) continue;
    title = execution.result.patch.title || title;
    changes.push(...execution.result.patch.changes.filter((change) => change.before !== change.after));
  }
  if (!changes.length) return undefined;
  return { kind: "patch", title, changes };
}

export interface PatchReviewControllerOptions {
  post: (message: ConversationWebviewResponse) => Promise<void>;
  /** The host's apply API. File writes stay with the original host capability. */
  applyMethod: () => RegisteredCallable;
  /** The host's apply capability. Injected so this module never imports VS Code. */
  applyPatch: DeterministicHandler;
}

/** Holds read-only Agent proposals until the reader accepts or rejects them.
 * Ownership is per turn, so two turns in one conversation cannot resolve each
 * other's files, and a resolved file disappears from the entry. */
export class PatchReviewController {
  private readonly pending = new Map<string, PatchResult>();

  constructor(private readonly options: PatchReviewControllerOptions) {}

  /** Registers a proposal when it still needs review. */
  hold(turnId: string, response: InputExecutionResponse): boolean {
    const reviewable = unappliedPatch(response);
    if (!reviewable) return false;
    this.pending.set(turnId, reviewable);
    return true;
  }

  drop(turnId: string): void {
    this.pending.delete(turnId);
  }

  has(turnId: string): boolean {
    return this.pending.has(turnId);
  }

  /** Accepting is what actually writes a read-only Agent turn to disk. Files are
   * resolved one entry at a time so accepting part of a proposal leaves the rest
   * pending instead of discarding it. */
  async resolve(sessionId: string, turnId: string, uris: readonly string[], accept: boolean): Promise<void> {
    const pending = this.pending.get(turnId);
    if (!pending) throw new Error("These changes are no longer available for review.");
    const targets = uris.length
      ? pending.changes.filter((change) => uris.includes(change.uri))
      : [...pending.changes];
    if (!targets.length) throw new Error("None of those files are part of this proposal.");
    const resolved = targets.map((change) => change.uri);
    const remaining = pending.changes.filter((change) => !resolved.includes(change.uri));
    if (!accept) {
      this.forgetResolvedChanges(turnId, pending, remaining);
      await this.options.post({
        type: "patchResolved",
        sessionId,
        turnId,
        uris: resolved,
        status: "rejected",
        message: `Discarded ${resolved.length} proposed change${resolved.length === 1 ? "" : "s"}.`
      });
      return;
    }
    const patch: PatchResult = { kind: "patch", title: pending.title, changes: targets };
    const result = await this.options.applyPatch({
      invocation: { kind: "invocation", method: "apply", arguments: [], source: "chat" },
      method: this.options.applyMethod(),
      arguments: { result: patch },
      context: [],
      metadata: {}
    }) as ApplyResult;
    // A conflict leaves the entry pending: the file moved on, and re-reviewing
    // it is the only honest next step.
    if (result.status === "applied" || result.status === "unchanged") {
      this.forgetResolvedChanges(turnId, pending, remaining);
    }
    await this.options.post({
      type: "patchResolved",
      sessionId,
      turnId,
      uris: resolved,
      status: result.status === "applied" || result.status === "unchanged" ? result.status : "conflict",
      message: result.summary
    });
  }

  private forgetResolvedChanges(turnId: string, pending: PatchResult, remaining: PatchResult["changes"]): void {
    if (remaining.length) this.pending.set(turnId, { ...pending, changes: remaining });
    else this.pending.delete(turnId);
  }
}

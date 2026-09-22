import type { DextResult, InvocationValue, RuntimeResponse, WorkflowStepResponse } from "./types.js";

type Value = InvocationValue | DextResult;
export type WorkflowFlow = boolean | { kind: "returned"; value: Value };

const CHANGED_SINCE_STOPPED = "The Code workflow or custom API changed since it stopped. Retry the turn to run the updated code.";

/** One execution tree, owned by one Code turn. Never shared between tabs.
 * Successful nodes restore their values without invoking their effects again.
 * Failed nodes retain their children so custom APIs can resume internally.
 *
 * Every node carries exactly one identity: the program it runs (a Code input, a
 * custom API or a local function) or the call whose response it caches. A call
 * node is not also the root of the program it calls: the response cache and the
 * program are separate nodes, so binding one identity can never be mistaken for
 * the other. Adding a binding site means adding a node, not a second slot. */
export class WorkflowCheckpoint {
  private readonly children = new Map<string, WorkflowCheckpoint>();
  private identity: string | undefined;
  cursor = 0;
  completed?: { environment: [string, Value][]; steps: WorkflowStepResponse[]; flow: WorkflowFlow };
  response?: RuntimeResponse;

  child(key: string): WorkflowCheckpoint {
    let child = this.children.get(key);
    if (!child) { child = new WorkflowCheckpoint(); this.children.set(key, child); }
    child.cursor = 0;
    return child;
  }

  /** Refuses a second, different identity. The same identity is the normal
   * resume path: replaying a checkpoint against the run it recorded must not
   * look like a change. */
  bind(identity: string): void {
    if (this.identity !== undefined && this.identity !== identity) throw new Error(CHANGED_SINCE_STOPPED);
    this.identity = identity;
  }
}

/**
 * The single source of truth for the parent/kernel conversation.
 *
 * The parent is the extension host (`src/runner/dextHost.ts`); the kernel is a
 * long-lived Node child (`src/runner/dextKernel.mjs`) that runs real TypeScript
 * with the same APIs a user's module imports from `dext`. Both sides are plain
 * JSON over the child's IPC channel, so the message shapes here are mirrored in
 * JavaScript by `dextKernel.mjs` / `dextRuntime.mjs` — change them together.
 *
 * Nothing in this file may import `vscode` or Node built-ins: the kernel side is
 * plain ESM and reads these shapes by convention.
 */

/** Protocol revision. Bump when a message shape changes incompatibly. */
export const DEXT_KERNEL_PROTOCOL = 1;

export type DextJson =
  | null
  | boolean
  | number
  | string
  | DextJson[]
  | { [key: string]: DextJson };

/** `stdout` / `stderr` written by user code. Not an API result: it carries no
 * invocation and no duration, so it cannot be mistaken for a Dext result kind. */
export interface DextStreamStep {
  channel: "stdout" | "stderr";
  text: string;
}

export type DextStepState = "success" | "failed" | "cancelled";

/**
 * One recorded step. `response` is a `RuntimeResponse` produced by the parent's
 * runtime; `stream` is process output; exactly one of the two is present.
 */
export interface DextWireStep {
  method: string;
  state: DextStepState;
  response?: unknown;
  stream?: DextStreamStep;
  error?: string;
  assignment?: string;
}

/** Kernel → parent. */
export type DextKernelMessage =
  | {
    type: "ready";
    /** Runtime facts documented in `docs/development.md`. */
    node: string;
    execPath: string;
    /** Whether the kernel can strip TypeScript natively. */
    nativeTypescript: boolean;
    protocol: number;
  }
  /** An API call that only the extension host can perform. */
  | { type: "request"; id: number; method: string; arguments: Record<string, DextJson> }
  /** A recorded step, sent as it happens so Output can follow along. */
  | { type: "step"; step: DextWireStep }
  | { type: "runDone"; id: number; ok: boolean; result?: DextJson; error?: string }
  /** The kernel is unusable (bad handshake, internal failure). */
  | { type: "fatal"; message: string };

/** Parent → kernel. */
export type DextHostMessage =
  | {
    type: "run";
    id: number;
    file: string;
    /** Calls from a previous attempt, in order. A call that still matches one of
     * these returns the recorded response instead of asking the parent again.
     * Arguments and responses are JSON by construction (see `dextSerialization.mjs`). */
    replay?: readonly { method: string; arguments: Record<string, unknown>; response: unknown }[];
    /** Directories `dext/api/<id>` resolves against, most specific first. The
     * workspace's own `.dext/api` is always first, so a configured directory can
     * never shadow a project API. */
    apiRoots?: readonly string[];
  }
  | { type: "response"; requestId: number; response?: unknown; error?: string }
  | { type: "shutdown" };

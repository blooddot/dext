/**
 * The `vscode` surface the plan writer touches, backed by the real filesystem so a
 * test can hand a saved `planPath` straight to Node's `fs` and prove it is readable.
 *
 * Kept free of Dext imports: a test registers it with `vi.mock("vscode", ...)`
 * through a dynamic import, and that factory must not pull in a module that itself
 * imports the module being mocked. The rest of the file is types only, which the
 * transform erases.
 */

import type * as vscode from "vscode";
import type { DextKernelHost } from "../src/runner/dextHost.js";
import type { DextStorage, StorageLocation } from "../src/platform/vscode/dextStorage.js";
import type {
  CodeRef,
  ExecutionMetadata,
  InputExecutionResponse,
  InvocationAst,
  RuntimeResponse
} from "../src/shared/contracts/types.js";

export interface PlanHostState {
  globalStorage: string;
  workspaceFolder: string | undefined;
  settings: Map<string, unknown>;
  /** Makes the next write fail, for the "no planPath when saving fails" case. */
  failWrite: boolean;
}

/**
 * The host members a plan test drives. `DextApplication`'s own fields and the two
 * plan helpers are private, and the stub is built from the prototype so the whole
 * extension is not constructed for a file write.
 */
export interface PlanHostStub {
  storage: DextStorage;
  workspaceUri: { fsPath: string } | undefined;
  workspaceTrusted: boolean;
  workspaceRoot: string;
  runtime: {
    execute: (invocation: InvocationAst, context: readonly CodeRef[], metadata: Readonly<ExecutionMetadata>) => Promise<RuntimeResponse>;
  };
  kernels: unknown[];
  reservedKernels: Set<unknown>;
  dispatchConcurrency: number;
  writePlanFile(
    input: string,
    document: string,
    location: StorageLocation,
    existingPath?: string,
    expectedFileHash?: string
  ): Promise<{ reference: string; filePath: string } | undefined>;
  savePlan(
    input: string,
    response: InputExecutionResponse["executions"][number],
    existingPath?: string,
    expectedFileHash?: string
  ): Promise<InputExecutionResponse["executions"][number]>;
  executeCodeCall(
    invocation: InvocationAst,
    metadata: Readonly<ExecutionMetadata>,
    context: readonly CodeRef[]
  ): Promise<RuntimeResponse>;
  planUri(reference: string): vscode.Uri | undefined;
  kernelHost(): DextKernelHost;
}

export const planHostState: PlanHostState = {
  globalStorage: "",
  workspaceFolder: undefined,
  settings: new Map<string, unknown>(),
  failWrite: false
};

export function resetPlanHostState(): void {
  planHostState.settings.clear();
  planHostState.failWrite = false;
}

export async function createVscodeMock(): Promise<Record<string, unknown>> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");

  class FileSystemError extends Error {
    static readonly FileNotFound = "FileNotFound";
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  }

  const uri = (fsPath: string): { fsPath: string; path: string; scheme: string; toString: () => string } => ({
    fsPath,
    path: fsPath,
    scheme: "file",
    toString: () => `file://${fsPath.replaceAll("\\", "/")}`
  });

  return {
    FileType: { File: 1, Directory: 2 },
    FileSystemError,
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    EventEmitter: class {
      event = () => ({ dispose() {} });
      fire() {}
      dispose() {}
    },
    Uri: {
      file: (fsPath: string) => uri(fsPath),
      joinPath: (base: { fsPath: string }, ...parts: string[]) => uri(path.join(base.fsPath, ...parts)),
      parse: (value: string) => uri(decodeURIComponent(new URL(value).pathname))
    },
    workspace: {
      get workspaceFolders() {
        return planHostState.workspaceFolder
          ? [{ uri: uri(planHostState.workspaceFolder), name: "ws", index: 0 }]
          : undefined;
      },
      isTrusted: true,
      getConfiguration: () => ({
        get: (key: string, fallback?: unknown) => planHostState.settings.has(`dext.${key}`)
          ? planHostState.settings.get(`dext.${key}`)
          : fallback,
        update: async () => undefined
      }),
      fs: {
        stat: async (target: { fsPath: string }) => {
          try { return await fs.stat(target.fsPath); }
          catch { throw new FileSystemError("FileNotFound"); }
        },
        readFile: async (target: { fsPath: string }) => new Uint8Array(await fs.readFile(target.fsPath)),
        writeFile: async (target: { fsPath: string }, bytes: Uint8Array) => {
          if (planHostState.failWrite) throw new Error("disk is read-only");
          await fs.writeFile(target.fsPath, bytes);
        },
        createDirectory: async (target: { fsPath: string }) => { await fs.mkdir(target.fsPath, { recursive: true }); },
        readDirectory: async (target: { fsPath: string }) => {
          const entries = await fs.readdir(target.fsPath, { withFileTypes: true });
          return entries.map((entry) => [entry.name, entry.isDirectory() ? 2 : 1]);
        }
      }
    },
    window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) },
    commands: { executeCommand: async () => undefined }
  };
}

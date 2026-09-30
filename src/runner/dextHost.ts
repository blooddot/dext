/**
 * The extension-host side of the kernel conversation.
 *
 * `DextKernelHost` owns the child process, the handshake, the dispatch queue and
 * crash recovery. It never runs user code itself: it turns every kernel
 * `request` into an ordinary `InvocationAst`, executes it through the injected
 * runtime (so contract validation, MCP, `ui.*` and the Agent CLIs are reused
 * unchanged) and answers with the resulting `RuntimeResponse`.
 *
 * The kernel is started with the Electron binary in VS Code's extension host, so
 * `ELECTRON_RUN_AS_NODE=1` is what makes `process.execPath` behave as Node.
 * `docs/development.md` records the measured runtime facts.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ExecutionCancelledError } from "../core/executionErrors.js";
import { dextWireStepSchema } from "../core/schemas.js";
import { toBoundaryJson } from "../core/resultSerialization.js";
import { DextResumeCache, type DextReplayEntry } from "./dextResumeCache.js";
import type {
  CodeRef,
  ExecutionMetadata,
  InputExecutionResponse,
  InvocationAst,
  InvocationValue,
  RuntimeResponse,
  WorkflowStepResponse
} from "../core/types.js";
import type { DextHostMessage, DextKernelMessage, DextWireStep } from "./dextProtocol.js";
import { DEXT_KERNEL_PROTOCOL } from "./dextProtocol.js";

/** How many kernel requests may be in flight at once. User code can call
 * `Promise.all`, so the limit belongs here rather than in the language. */
export const DEFAULT_DISPATCH_CONCURRENCY = 4;

/** How long the kernel may take to answer the handshake. */
const READY_TIMEOUT_MS = 20_000;

/** Run buffers kept in the runs directory. The kernel needs the file it is running
 * and nothing else: `Continue` replays recorded calls rather than re-reading it, so
 * an old buffer is only ever a curiosity. */
const RETAINED_RUN_BUFFERS = 20;

/** A run buffer's name as `[timestamp, sequence]`, for ordering by age. */
function runBufferAge(name: string): [number, number] {
  const match = /^run-(\d+)-(\d+)\.ts$/.exec(name);
  return match ? [Number(match[1]), Number(match[2])] : [0, 0];
}

/** Drop the oldest run buffers so the directory cannot grow without bound.
 * `current` is the file this run is about to import and is never deleted. */
async function pruneRunBuffers(directory: string, current: string): Promise<void> {
  try {
    const names = (await readdir(directory)).filter((name) => /^run-\d+-\d+\.ts$/.test(name) && name !== current);
    names.sort((left, right) => {
      const [leftTime, leftId] = runBufferAge(left);
      const [rightTime, rightId] = runBufferAge(right);
      return leftTime - rightTime || leftId - rightId;
    });
    // The current buffer is not in the list, so keeping `N` files means keeping
    // `N - 1` of these.
    for (const name of names.slice(0, Math.max(0, names.length - (RETAINED_RUN_BUFFERS - 1)))) {
      await rm(path.join(directory, name), { force: true });
    }
  } catch {
    // Housekeeping must never fail a run: a missing or unreadable directory is the
    // kernel's problem to report, not this helper's.
  }
}

export interface DextKernelReady {
  node: string;
  execPath: string;
  nativeTypescript: boolean;
  protocol: number;
}

export interface DextKernelRunMetadata {
  /** Carried into every API invocation the run makes. */
  execution?: Readonly<ExecutionMetadata>;
  signal?: AbortSignal;
  /** Calls recorded by an earlier attempt of the same file, in call order. A call
   * that still matches its entry returns the recorded response. */
  resume?: readonly DextReplayEntry[];
  /** Receives this attempt's call log, for a later resume. Called even when the
   * attempt fails or is cancelled. */
  onCallLog?: (entries: readonly DextReplayEntry[]) => void;
  /** Directories `dext/api/<id>` resolves against, most specific first. */
  apiRoots?: readonly string[];
  /** Resolved `@path` references, attached to every API call the run makes. */
  context?: readonly CodeRef[];
}

export interface DextKernelHostOptions {
  /** Workspace root: `dext/api/*` and `.dext/api/*` resolve below it. */
  workspaceRoot: string;
  /** Executes one API call in the extension host. `context` is the run's resolved
   * `@path` references, attached to every call the run makes. */
  execute: (
    invocation: InvocationAst,
    metadata: Readonly<ExecutionMetadata>,
    context: readonly CodeRef[]
  ) => Promise<RuntimeResponse>;
  /** Directory holding `dextKernel.mjs` and `dextLoader.mjs`. */
  runnerDirectory?: string;
  /** Node (or Electron-as-Node) executable. Defaults to the current process. */
  nodeExecPath?: string;
  /** In-flight limit for kernel requests. */
  maxConcurrency?: number;
  /** Where `runSource` writes the buffer it executes. The extension points this at
   * its own storage, so running Code leaves nothing in the repository; it defaults
   * to the workspace's `.dext/runs`. */
  runsDirectory?: string;
}

interface PendingRun {
  id: number;
  steps: WorkflowStepResponse[];
  resolve: (value: InputExecutionResponse) => void;
  reject: (error: Error) => void;
}

function defaultRunnerDirectory(): string {
  if (typeof __dirname === "string") return __dirname;
  throw new Error("DextKernelHost needs runnerDirectory when it is not loaded as a CommonJS bundle.");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toStep(wire: DextWireStep): WorkflowStepResponse {
  const parsed = dextWireStepSchema.parse(wire);
  const step: WorkflowStepResponse = { method: parsed.method, state: parsed.state };
  if (parsed.response !== undefined) step.response = parsed.response as RuntimeResponse;
  if (parsed.stream) step.stream = parsed.stream;
  if (parsed.notice) step.notice = parsed.notice;
  if (parsed.error) step.error = parsed.error;
  if (parsed.assignment) step.assignment = parsed.assignment;
  return step;
}

export class DextKernelHost {
  private readonly options: DextKernelHostOptions;
  private readonly runnerDirectory: string;
  private child: ChildProcess | undefined;
  private readyPromise: Promise<DextKernelReady> | undefined;
  private ready: DextKernelReady | undefined;
  private pending: PendingRun | undefined;
  private nextRunId = 1;
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private maxConcurrency: number;
  private disposed = false;
  /** Metadata applied to every API call the current run makes. */
  private currentMetadata: Readonly<ExecutionMetadata> = {};
  /** Call log of the run in flight, for a later resume. */
  private currentLog: DextResumeCache | undefined;
  /** `@path` references resolved for the run in flight. */
  private currentContext: readonly CodeRef[] = [];

  constructor(options: DextKernelHostOptions) {
    this.options = options;
    this.runnerDirectory = options.runnerDirectory ?? defaultRunnerDirectory();
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? DEFAULT_DISPATCH_CONCURRENCY);
  }

  /** The measured capabilities of the running kernel, once it has handshaken. */
  get capabilities(): DextKernelReady | undefined {
    return this.ready;
  }

  /** Whether a run is in flight — or the kernel is still starting one — so the
   * workspace root and run directory it was built with are still in use. */
  busy(): boolean {
    return this.pending !== undefined || (this.readyPromise !== undefined && this.ready === undefined);
  }

  setMaxConcurrency(value: number): void {
    this.maxConcurrency = Math.max(1, Math.floor(value));
    this.release();
  }

  /** Starts the kernel if needed and resolves when the child has handshaken. */
  async start(): Promise<DextKernelReady> {
    if (this.ready) return this.ready;
    this.readyPromise ??= this.spawnKernel();
    return this.readyPromise;
  }

  private spawnKernel(): Promise<DextKernelReady> {
    if (this.disposed) return Promise.reject(new Error("The Dext kernel host has been disposed."));
    const nodeExecPath = this.options.nodeExecPath ?? process.execPath;
    const loaderPath = path.join(this.runnerDirectory, "dextLoader.mjs");
    const kernelPath = path.join(this.runnerDirectory, "dextKernel.mjs");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DEXT_WORKSPACE_ROOT: this.options.workspaceRoot,
      DEXT_LOADER_AUTOREGISTER: "1"
    };
    // Inside VS Code the extension host runs on Electron, so the executable has
    // to be told to behave as Node before it can run the kernel.
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
    else delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(nodeExecPath, ["--import", pathToFileURL(loaderPath).href, kernelPath], {
      cwd: this.options.workspaceRoot,
      env,
      stdio: ["ignore", "pipe", "pipe", "ipc"]
    });
    this.child = child;
    return new Promise<DextKernelReady>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new Error(`The Dext kernel did not start within ${READY_TIMEOUT_MS} ms.`));
      }, READY_TIMEOUT_MS);
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          this.readyPromise = undefined;
          reject(error);
        } else {
          resolve(this.ready!);
        }
      };
      child.on("message", (message: unknown) => {
        const parsed = message as DextKernelMessage;
        if (!parsed || typeof parsed !== "object") return;
        if (parsed.type === "ready") {
          if (parsed.protocol !== DEXT_KERNEL_PROTOCOL) {
            finish(new Error(
              `The Dext kernel speaks protocol ${parsed.protocol}, but this extension needs ${DEXT_KERNEL_PROTOCOL}. Rebuild the extension.`
            ));
            return;
          }
          this.ready = {
            node: parsed.node,
            execPath: parsed.execPath,
            nativeTypescript: parsed.nativeTypescript,
            protocol: parsed.protocol
          };
          finish();
          return;
        }
        void this.onMessage(parsed);
      });
      child.on("error", (error) => {
        finish(new Error(`Cannot start the Dext kernel (${nodeExecPath}): ${error.message}`));
      });
      child.on("exit", (code, signal) => {
        // An older child may exit after its replacement was spawned (a cancel
        // kills and the next run restarts), so only the current child may clear
        // the host's state.
        if (this.child === child) this.handleExit(code, signal);
        finish(new Error(`The Dext kernel stopped before it was ready (code ${code ?? "null"}).`));
      });
    });
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.child = undefined;
    this.ready = undefined;
    this.readyPromise = undefined;
    const pending = this.pending;
    this.pending = undefined;
    // Requests already being dispatched finish in the host and drain the queue
    // through `release`; nothing has to be reset here.
    pending?.reject(new Error(`The Dext kernel stopped (code ${code ?? "null"}${signal ? `, signal ${signal}` : ""}).`));
  }

  private async onMessage(message: DextKernelMessage): Promise<void> {
    switch (message.type) {
      case "request":
        await this.onRequest(message.id, message.method, message.arguments);
        return;
      case "step":
        this.pending?.steps.push(toStep(message.step));
        return;
      case "runDone": {
        const pending = this.pending;
        this.pending = undefined;
        if (!pending || pending.id !== message.id) return;
        if (!message.ok) {
          pending.reject(new Error(message.error ?? "The Dext run failed."));
          return;
        }
        pending.resolve({
          kind: "workflow",
          executions: pending.steps.flatMap((step) => (step.response ? [step.response] : [])),
          steps: pending.steps
        });
        return;
      }
      case "fatal":
        this.child?.kill();
        return;
      default:
        return;
    }
  }

  private async onRequest(id: number, method: string, args: Record<string, unknown>): Promise<void> {
    const metadata = this.currentMetadata;
    let reply: DextHostMessage;
    try {
      const response = await this.dispatch(() =>
        this.options.execute(this.invocation(method, args), metadata, this.currentContext));
      // The kernel receives JSON, so a result that cannot cross that boundary is
      // refused here with a readable message instead of degrading silently.
      const boundaryResponse = toBoundaryJson(response, `The result of ${method}()`);
      this.currentLog?.record(method, args, boundaryResponse);
      reply = {
        type: "response",
        requestId: id,
        response: boundaryResponse
      };
    } catch (error) {
      reply = { type: "response", requestId: id, error: errorMessage(error) };
    }
    try {
      if (this.child?.connected) this.child.send(reply);
    } catch {
      // The kernel died while the call was in flight; the exit handler reports it.
    }
  }

  private invocation(method: string, args: Record<string, unknown>): InvocationAst {
    return {
      kind: "invocation",
      method,
      // Kernel arguments are JSON by construction (`dextSerialization.mjs`), which
      // is the same shape `InvocationValue` describes.
      arguments: Object.entries(args).map(([name, value]) => ({ name, value: value as InvocationValue })),
      source: "code"
    };
  }

  private async dispatch<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): void | Promise<void> {
    if (this.active < this.maxConcurrency) {
      this.active += 1;
      return;
    }
    // The admitted waiter takes the slot itself in `release`; incrementing here
    // would admit every waiter at once.
    return new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    while (this.active < this.maxConcurrency && this.waiting.length) {
      const admit = this.waiting.shift()!;
      this.active += 1;
      admit();
    }
  }

  /** Runs one TypeScript entry file and collects its steps. */
  async run(file: string, metadata: DextKernelRunMetadata = {}): Promise<InputExecutionResponse> {
    if (this.pending) throw new Error("A Dext run is already in progress.");
    const signal = metadata.signal;
    if (signal?.aborted) throw new ExecutionCancelledError();
    // Listening before the handshake means a cancel during startup is not lost:
    // `kill` stops the kernel and the aborted check below reports the run.
    const onAbort = (): void => {
      this.kill();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const log = new DextResumeCache(metadata.resume ?? []);
    const report = (): void => metadata.onCallLog?.(log.entries);
    try {
      try {
        await this.start();
      } catch (error) {
        // A cancel during the handshake kills the kernel, so report the cancel
        // rather than the death it caused.
        if (signal?.aborted) throw new ExecutionCancelledError();
        throw error;
      }
      if (signal?.aborted) throw new ExecutionCancelledError();
      const child = this.child;
      if (!child?.connected) throw new Error("The Dext kernel is not running.");
      const id = this.nextRunId++;
      this.currentMetadata = metadata.execution ?? {};
      this.currentLog = log;
      this.currentContext = metadata.context ?? [];
      const promise = new Promise<InputExecutionResponse>((resolve, reject) => {
        this.pending = { id, steps: [], resolve, reject };
      });
      try {
        const message: DextHostMessage = {
          type: "run",
          id,
          file,
          ...(log.replay.length ? { replay: log.replay } : {}),
          ...(metadata.apiRoots?.length ? { apiRoots: metadata.apiRoots } : {})
        };
        child.send(message);
      } catch (error) {
        this.pending = undefined;
        this.currentLog = undefined;
        throw error instanceof Error ? error : new Error(String(error));
      }
      try {
        return await promise;
      } finally {
        report();
      }
    } finally {
      this.currentMetadata = {};
      this.currentLog = undefined;
      this.currentContext = [];
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Writes a composer buffer to disk and runs it.
   *
   * The kernel imports the file, so it has to exist as a real path. It is not a
   * source of truth: Continue replays the recorded calls, so a finished run's buffer
   * is only a curiosity, and the directory is pruned to the newest few.
   */
  async runSource(source: string, metadata: DextKernelRunMetadata = {}): Promise<InputExecutionResponse> {
    const directory = this.options.runsDirectory ?? path.join(this.options.workspaceRoot, ".dext", "runs");
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, `run-${Date.now()}-${this.nextRunId}.ts`);
    await writeFile(file, source, "utf8");
    await pruneRunBuffers(directory, path.basename(file));
    return this.run(file, metadata);
  }

  /** Kills the kernel. The next run starts a fresh one. */
  kill(): void {
    const child = this.child;
    this.child = undefined;
    this.ready = undefined;
    this.readyPromise = undefined;
    child?.kill();
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(new ExecutionCancelledError());
  }

  dispose(): void {
    this.disposed = true;
    this.kill();
  }
}

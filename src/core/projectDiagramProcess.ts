import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiagramAdapterDocument, DiagramAdapterRenderOptions, DiagramAdapterArtifact } from "./projectDiagramAdapter.js";
import { validateProjectDiagram, type ProjectDiagram, type DiagramValidationReceipt, validationStatus } from "./projectDiagram.js";

/** Shell-free, bounded local execution. Child processes receive only adapter-owned input files. */
export function runDiagramProcess(command: string, args: readonly string[], cwd: string, signal?: AbortSignal, options: { tolerateFailure?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("Diagram operation cancelled.")); return; }
    const child = spawn(command, [...args], { cwd, shell: false, windowsHide: true, detached: process.platform !== "win32",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ARCHIFY_UPDATE_CHECK_DISABLED: "1" } });
    let stdout = ""; let stderr = ""; let failure: Error | undefined;
    const stop = (message: string) => {
      failure = new Error(message);
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { child.kill(); }
    };
    const cancel = () => stop("Diagram operation cancelled.");
    signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => stop("Diagram renderer exceeded 60 seconds."), 60_000);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); if (stdout.length > 8_000_000) stop("Diagram output exceeded limit."); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); if (stderr.length > 1_000_000) stop("Diagram diagnostics exceeded limit."); });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); };
    child.on("error", (error) => { cleanup(); reject(error); });
    child.on("close", (code) => { cleanup(); if (failure) reject(failure); else if (code !== 0 && !options.tolerateFailure) reject(new Error((stderr || stdout || "Diagram renderer failed.").slice(0, 6000))); else resolve(stdout || stderr); });
  });
}

export async function withDiagramFiles<T>(payload: unknown, run: (directory: string, input: string, output: string) => Promise<T>, extension: string): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "dext-diagram-"));
  try {
    const input = join(directory, "input.json"); const output = join(directory, "output." + extension);
    await writeFile(input, JSON.stringify(payload));
    return await run(directory, input, output);
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }); }
}

export const readDiagramOutput = (path: string): Promise<string> => readFile(path, "utf8");
export function assertDiagramDocument(document: DiagramAdapterDocument, id: string, version: string, options?: DiagramAdapterRenderOptions): void {
  if (options?.signal?.aborted) throw new Error("Diagram operation cancelled.");
  if (!document || document.adapterId !== id || document.adapterVersion !== version) throw new Error("Incompatible diagram adapter document.");
}
export function diagramReceipt(diagram: ProjectDiagram, id: string, version: string): DiagramValidationReceipt {
  const issues = validateProjectDiagram(diagram);
  return { adapterId: id, adapterVersion: version, status: validationStatus(issues), checkedAt: Date.now(), issues };
}
export function diagramArtifact(document: DiagramAdapterDocument, format: DiagramAdapterArtifact["format"], content: string): DiagramAdapterArtifact {
  const mimeType = format === "html" ? "text/html" : "image/svg+xml";
  return { adapterId: document.adapterId, adapterVersion: document.adapterVersion, diagramId: document.diagramId, format, mimeType, content };
}

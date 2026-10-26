import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import {
  projectModelCheckpointSchema,
  type ProjectInitializationCheckpointStore,
  type ProjectModelCheckpoint
} from "../generation/projectModelCheckpoint.js";

/** A checkpoint holds AI outlines and file paths, never source text; still bounded. */
const MAX_CHECKPOINT_BYTES = 8 * 1024 * 1024;

const RELATIVE_PATH = ".dext/project-initialization.checkpoint.json";

/** Durable stage checkpoint for a paused Project initialization. */
export function createProjectInitializationCheckpointStore(root: vscode.Uri): ProjectInitializationCheckpointStore {
  const target = vscode.Uri.joinPath(root, ...RELATIVE_PATH.split("/"));
  return {
    async read(): Promise<ProjectModelCheckpoint | undefined> {
      try {
        const bytes = await vscode.workspace.fs.readFile(target);
        if (bytes.byteLength > MAX_CHECKPOINT_BYTES) return undefined;
        const parsed = projectModelCheckpointSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
        return parsed.success ? parsed.data : undefined;
      } catch {
        // Missing, unreadable or corrupt checkpoints are simply not resumable.
        return undefined;
      }
    },
    async write(checkpoint: ProjectModelCheckpoint): Promise<void> {
      const serialized = JSON.stringify(checkpoint);
      if (Buffer.byteLength(serialized, "utf8") > MAX_CHECKPOINT_BYTES) throw new Error("Project checkpoint exceeds the size limit.");
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, ".dext"));
      const temporary = target.with({ path: `${target.path}.${randomUUID()}.tmp` });
      try {
        await vscode.workspace.fs.writeFile(temporary, new TextEncoder().encode(serialized));
        await vscode.workspace.fs.rename(temporary, target, { overwrite: true });
      } finally {
        // A failed rename may leave the temporary file behind; it is never read as a checkpoint.
        try { await vscode.workspace.fs.delete(temporary, { useTrash: false }); } catch { /* Already renamed away. */ }
      }
    },
    async clear(): Promise<void> {
      try { await vscode.workspace.fs.delete(target, { useTrash: false }); } catch { /* Already absent. */ }
    }
  };
}

export { RELATIVE_PATH as PROJECT_INITIALIZATION_CHECKPOINT_PATH };

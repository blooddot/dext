import * as vscode from "vscode";
import type { ProjectFileHost, ProjectDefinition, ProjectSaveResult } from "./projectStore.js";
import type { ProjectEditorDataSource } from "./projectEditorProvider.js";
import type { KnowledgeSuggestion } from "./core/projectKnowledgeReview.js";
import type { ProjectInitializationState } from "./projectService.js";
import type { ProjectPanelData } from "./webview/projectPanel.js";
import type { ArchitectureScanResult } from "./core/projectArchitecture.js";
import { runArchitectureScan } from "./core/projectArchitectureWorker.js";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

// VS Code glob patterns do not support nested brace alternatives.
export const PROJECT_SOURCE_GLOB = "**/*.{ts,tsx,cts,mts,js,jsx,cjs,mjs,py,rs}";
export const PROJECT_MANIFEST_GLOB = "**/{Cargo.toml,Cargo.lock}";
/**
 * Project architecture is about production modules by default. Tests and generated fixtures can
 * contain imports that make the graph noisy, so they are opt-in through a future scan profile.
 */
export const PROJECT_SCAN_EXCLUDE = "**/{node_modules,out,dist,build,.git,target,coverage,.vscode-test,.npm-cache,.tmp-tb,test,tests,__tests__,fixtures}/**";

export async function scanWorkspaceProject(root: vscode.Uri, config?: ProjectDefinition["scan"]): Promise<ArchitectureScanResult> {
  const limit = 2000;
  const roots = config?.roots?.length ? config.roots : ["."];
  const excluded = config?.includeTests
    ? PROJECT_SCAN_EXCLUDE.replace("test,tests,__tests__,fixtures/", "")
    : PROJECT_SCAN_EXCLUDE;
  const extra = config?.extraExcludes?.length ? `{${config.extraExcludes.join(",")}}` : "";
  const exclude = extra ? `${excluded},${extra}/**` : excluded;
  const groups = await Promise.all(roots.flatMap((scanRoot) => [PROJECT_SOURCE_GLOB, PROJECT_MANIFEST_GLOB].map((pattern) => {
    const prefix = scanRoot === "." ? "" : `${scanRoot.replace(/\/$/, "")}/`;
    return vscode.workspace.findFiles(new vscode.RelativePattern(root, `${prefix}${pattern}`), exclude, limit + 1);
  })));
  const found = groups.flat().sort((a, b) => a.path.localeCompare(b.path));
  const files: Array<{ path: string; content: string }> = [];
  const unsupported: ArchitectureScanResult["unsupported"] = [];
  for (const uri of found.slice(0, limit)) {
    const path = uri.path.slice(root.path.replace(/\/$/, "").length + 1);
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > 262144) {
        unsupported.push({ path, reason: "File size limit exceeded." });
        continue;
      }
      files.push({ path, content: textDecoder.decode(await vscode.workspace.fs.readFile(uri)) });
    } catch {
      unsupported.push({ path, reason: "File could not be read." });
    }
  }
  const result = runArchitectureScan(files, { maxFiles: limit, maxFileBytes: 262144 }).result;
  result.unsupported.push(...unsupported);
  if (found.length > limit) result.coverage = [...(result.coverage ?? []), "File limit exceeded: only the first 2000 files were scanned."];
  return result;
}

/** Implements {@link ProjectFileHost} over the VS Code file system rooted at the workspace folder. */
export class VscodeProjectFileHost implements ProjectFileHost {
  constructor(private readonly root: vscode.Uri) {}

  private uri(relativePath: string): vscode.Uri {
    return vscode.Uri.joinPath(this.root, ...relativePath.split("/").filter(Boolean));
  }

  async readFile(relativePath: string): Promise<string | undefined> {
    try {
      return textDecoder.decode(await vscode.workspace.fs.readFile(this.uri(relativePath)));
    } catch {
      // A missing or unreadable project file falls back to defaults upstream.
      return undefined;
    }
  }

  async writeFile(relativePath: string, content: string): Promise<void> {
    const segments = relativePath.split("/").filter(Boolean);
    if (segments.length > 1) {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.root, ...segments.slice(0, -1)));
    }
    await vscode.workspace.fs.writeFile(this.uri(relativePath), textEncoder.encode(content));
  }

  async deleteFile(relativePath: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(this.uri(relativePath));
    } catch {
      // Deleting an already-removed object is not an error.
    }
  }

  async listDirectory(relativeDir: string): Promise<string[]> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(this.uri(relativeDir));
      return entries.filter(([, type]) => type === vscode.FileType.File).map(([name]) => name);
    } catch {
      return [];
    }
  }
}

export interface ProjectPanelDataSourceOptions {
  store: {
    readObjects(): Promise<ProjectPanelData["objects"]>;
    readArchitecture(): Promise<{ decisions: Array<{ id: string; title: string; detail: string }> }>;
    readDefinition?(): Promise<ProjectDefinition>;
    writeDefinition?(next: ProjectDefinition, expectedVersion: number): Promise<ProjectSaveResult<ProjectDefinition>>;
  };
  scan(): Promise<ArchitectureScanResult>;
  name: string;
  root: string;
  languages?: () => Promise<readonly string[]>;
  drafts?: () => readonly KnowledgeSuggestion[];
  initialization?: () => ProjectInitializationState;
  status?: () => ProjectInitializationState["status"];
}

/**
 * Builds the Project tab data from long-term files and a bounded scan. Conversation runs, Hook
 * output, and single-run Review are never read or exposed here.
 */
export function createProjectPanelDataSource(options: ProjectPanelDataSourceOptions): ProjectEditorDataSource {
  const load = async (scanned?: ArchitectureScanResult): Promise<ProjectPanelData> => {
      const [objects, architecture, scan, definition] = await Promise.all([
        options.store.readObjects(),
        options.store.readArchitecture(),
        scanned ?? options.scan(),
        options.store.readDefinition?.()
      ]);
      const initialization = options.initialization?.() ?? { status: options.status?.() ?? (definition?.knowledge.initialized ? "completed" : "idle"), aiAvailable: false, drafts: 0, scannedFiles: 0 };
      return {
        overview: {
          name: options.name,
          root: options.root,
          languages: (await options.languages?.()) ?? [...new Set(scan.modules.map((module) => module.language))],
          objects: objects.length,
          accepted: objects.filter((object) => object.confirmation === "accepted").length,
          drafts: objects.filter((object) => object.confirmation === "draft").length,
          needsVerification: objects.filter((object) => object.validity !== "current").length,
          initialization: {
            status: initialization.status,
            aiAvailable: initialization.aiAvailable,
            scannedFiles: initialization.scannedFiles || scan.modules.length
          },
          scanRoots: definition?.scan.roots ?? []
        },
        objects,
        drafts: options.drafts?.() ?? [],
        architecture: {
          modules: scan.modules,
          relations: scan.relations,
          decisions: architecture.decisions,
          ...(scan.coverage?.length || scan.unsupported.length
            ? { coverage: [...(scan.coverage ?? []), ...scan.unsupported.map((entry) => `${entry.path}: ${entry.reason}`)] }
            : {})
        }
      };
    };
  return {
    load,
    ...(options.store.readDefinition && options.store.writeDefinition ? {
      initialize: async (): Promise<ProjectPanelData> => {
        const scan = await options.scan();
        const definition = await options.store.readDefinition!();
        if (!definition.knowledge.initialized) {
          const saved = await options.store.writeDefinition!({
            ...definition, knowledge: { ...definition.knowledge, enabled: true, initialized: true }
          }, definition.version);
          if (saved.status === "conflict") throw new Error("Project settings changed during initialization. Please retry.");
        }
        return load(scan);
      }
    } : {})
  };
}

import { describe, expect, it, vi } from "vitest";

/**
 * The workspace host is the only place that decides which files the model may read. The fixture
 * below is documentation-heavy on purpose: vendored renderer readmes plus a large docs tree used to
 * consume both the read window and the evidence budget, leaving the model with no source at all —
 * which is why a whole-project initialization could only describe one documented flow.
 */
const tree = {
  documents: [
    "README.md",
    "README.zh-CN.md",
    "package.json",
    ...Array.from({ length: 500 }, (_, index) => `docs/guide-${String(index).padStart(3, "0")}.md`),
    ...Array.from({ length: 200 }, (_, index) => `vendor/third-party/renderers/part-${String(index).padStart(3, "0")}/README.md`)
  ],
  sources: Array.from({ length: 400 }, (_, index) => `src/core/module-${String(index).padStart(3, "0")}.ts`)
};

const files = new Map<string, string>();
// Large enough that the file budget binds and the source reserve has to do real work.
for (const path of [...tree.documents, ...tree.sources]) files.set(path, `// ${path}\n${"export const value = 1;\n".repeat(60)}`);

const relative = (uri: { path: string }): string => uri.path.replace(/^\/C:\/ws\//, "");

vi.mock("vscode", () => {
  class RelativePattern { constructor(readonly base: unknown, readonly pattern: string) {} }
  return {
    RelativePattern,
    Uri: {
      file: (fsPath: string) => ({ scheme: "file", fsPath, path: fsPath.replace(/\\/g, "/") }),
      joinPath: (base: { fsPath?: string }, ...parts: string[]) => ({ scheme: "file", fsPath: [base.fsPath ?? "", ...parts].join("/"), path: [base.fsPath ?? "", ...parts].join("/") })
    },
    workspace: {
      fs: {
        stat: async (uri: { path: string }) => ({ size: (files.get(relative(uri)) ?? "").length }),
        readFile: async (uri: { path: string }) => new TextEncoder().encode(files.get(relative(uri)) ?? "")
      },
      findFiles: async (pattern: RelativePattern, _exclude: string, limit?: number) => {
        const glob = pattern.pattern;
        const matches = glob.includes("package.json")
          ? ["package.json"]
          : glob.includes("{README")
            ? tree.documents.filter((path) => /(?:^|\/)readme(?:\.[^/]*)?$/i.test(path))
            : glob.includes("{md")
              ? tree.documents.filter((path) => /\.(?:md|mdx|rst|txt)$/i.test(path))
              : tree.sources;
        return matches.slice(0, limit ?? matches.length).map((path) => ({ scheme: "file", fsPath: `C:/ws/${path}`, path: `/C:/ws/${path}` }));
      }
    }
  };
});

describe("project evidence selection", () => {
  it("keeps project source and the project README when documentation dominates", async () => {
    const { readWorkspaceEvidence } = await import("../src/vscodeProjectHost.js");
    const root = { scheme: "file", fsPath: "C:/ws", path: "/C:/ws" } as never;
    const packaged = await readWorkspaceEvidence(root, {}, {});

    const paths = packaged.files.map((file) => file.path);
    const kinds = packaged.files.map((file) => file.kind);
    // Both halves of the evidence survive: documentation for the intent, code for the diagrams.
    expect(kinds).toContain("readme");
    expect(kinds).toContain("manifest");
    expect(kinds).toContain("document");
    expect(kinds).toContain("source");
    expect(paths).toContain("README.md");
    expect(paths.some((path) => path.startsWith("src/"))).toBe(true);
    // Ownership: vendored documentation exists in the workspace but never crowds out project files.
    expect(paths.some((path) => path.startsWith("vendor/"))).toBe(false);
    // The read window was too small for everything, so the omission stays visible to the reader.
    expect(packaged.coverage.some((note) => note.includes("Documentation exceeds the limit"))).toBe(true);
    expect(packaged.omitted.files).toBeGreaterThan(0);
  }, 60_000);

  it("honours an explicit evidence scope instead of the built-in globs", async () => {
    const { readWorkspaceEvidence } = await import("../src/vscodeProjectHost.js");
    const root = { scheme: "file", fsPath: "C:/ws", path: "/C:/ws" } as never;
    const packaged = await readWorkspaceEvidence(root, {}, { include: ["src/**"] });
    expect(packaged.files.length).toBeGreaterThan(0);
    // A scope replaces the built-in README/documentation/manifest globs, so nothing outside it is read.
    expect(packaged.files.every((file) => file.path.startsWith("src/"))).toBe(true);
    expect(packaged.files.every((file) => file.kind === "source")).toBe(true);
  }, 60_000);

  it("drops a scope that could escape the workspace root", async () => {
    const { readWorkspaceEvidence } = await import("../src/vscodeProjectHost.js");
    const root = { scheme: "file", fsPath: "C:/ws", path: "/C:/ws" } as never;
    // Every entry is invalid, so the built-in globs stay in force rather than reading nothing.
    const packaged = await readWorkspaceEvidence(root, {}, { include: ["../outside/**", "C:/secret/**", "/etc/**"] });
    expect(packaged.files.some((file) => file.path === "README.md")).toBe(true);
  }, 60_000);
});

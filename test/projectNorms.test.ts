import { describe, expect, it } from "vitest";
import { projectModelSchema } from "../src/features/project/contracts/projectModel.js";
import { listProjectNorms, readProjectNorm, writeProjectNorm } from "../src/features/project/host/persistence/projectNorms.js";
import { ProjectStore, type ProjectFileHost } from "../src/features/project/host/persistence/projectStore.js";

const savedModel = () => projectModelSchema.parse({ schemaVersion: 1, revision: 0, updatedAt: 0, relations: [], nodes: [
  { id: "module:a", kind: "module", title: "Alpha", canonicalName: "Alpha", body: { kind: "inline", text: "## Responsibility\n\nOwns a." }, evidence: [{ path: "src/a.ts", contentHash: "hash" }] },
  { id: "doc", kind: "contract", title: "Document", canonicalName: "Document", body: { kind: "document", path: "docs/a.md", contentHash: "hash" } }
] });

function fixture() {
  const files = new Map<string, string>([[".dext/project/model.json", JSON.stringify(savedModel())]]);
  const host: ProjectFileHost = {
    readFile: async (path) => files.get(path),
    writeFile: async (path, text) => { files.set(path, text); },
    listDirectory: async (dir) => [...files.keys()].filter((path) => path.startsWith(`${dir}/`)).map((path) => path.slice(dir.length + 1))
  };
  return { files, store: new ProjectStore(host) };
}

const committed = (files: Map<string, string>) => JSON.parse(files.get(".dext/project/model.json")!) as ReturnType<typeof savedModel>;

describe("Project norms", () => {
  it("lists only inline bodies and reads one by id", async () => {
    const { store } = fixture();
    expect((await listProjectNorms(store)).map((norm) => norm.id)).toEqual(["module:a"]);
    expect(await readProjectNorm(store, "module:a")).toMatchObject({ title: "Alpha", text: "## Responsibility\n\nOwns a.", review: "draft", evidence: ["src/a.ts"] });
    // A document body is revised in its own file, never as a norm.
    await expect(readProjectNorm(store, "doc")).rejects.toThrow("inline");
  });

  it("treats an unchanged body as a confirmation and a changed body as needing verification", async () => {
    const { files, store } = fixture();
    await writeProjectNorm(store, "module:a", "## Responsibility\n\nOwns a.\n");
    expect(committed(files).revision).toBe(1);
    expect(committed(files).nodes[0]).toMatchObject({ id: "module:a", review: "accepted", freshness: "current" });
    await writeProjectNorm(store, "module:a", "## Responsibility\n\nOwns more.");
    expect(committed(files).revision).toBe(2);
    expect(committed(files).nodes[0]).toMatchObject({ review: "edited", freshness: "needs_verification", body: { kind: "inline", text: "## Responsibility\n\nOwns more." } });
  });

  it("refuses a missing node or a body it does not own", async () => {
    const { store } = fixture();
    await expect(writeProjectNorm(store, "missing", "text")).rejects.toThrow("missing");
    await expect(writeProjectNorm(store, "doc", "text")).rejects.toThrow("document");
  });
});

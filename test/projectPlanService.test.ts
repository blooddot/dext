import { describe, expect, it } from "vitest";
import { ProjectPlanService } from "../src/features/project/host/projectPlanService.js";
import { ProjectStore, projectContentHash, type ProjectFileHost } from "../src/features/project/host/persistence/projectStore.js";

function fixture() {
  const files = new Map<string, string>();
  const host: ProjectFileHost = {
    readFile: async path => files.get(path),
    writeFile: async (path, text) => { files.set(path, text); },
    listDirectory: async dir => [...files.keys()].filter(path => path.startsWith(dir + "/")).map(path => path.slice(dir.length + 1))
  };
  const store = new ProjectStore(host);
  const service = new ProjectPlanService(store, process.cwd());
  return { files, host, store, service, read: (input = "App") => service.readPlanContext({ input, workspaceKey: process.cwd() }) };
}
const path = ".dext/objects/app.json";
const object = { id: "app", canonicalName: "App", kind: "module", source: "user", confirmation: "accepted", description: "Public API", paths: ["src/app.ts"] };
const impact = { assessment: "none" as const, reason: "Existing contract preserved", refs: ["app"], coverage: "complete" as const };

describe("legacy Project Plan service", () => {
  it("does not mistake an initialized flag for a model or write during reading", async () => {
    const f = fixture();
    f.files.set(".dext/project.json", JSON.stringify({ schemaVersion: 1, knowledge: { initialized: true } }));
    expect((await f.read()).availability).toBe("absent");
    expect(f.files.size).toBe(1);
  });
  it("separates corruption and access errors from absence", async () => {
    const f = fixture();
    f.files.set(".dext/project-intent.json", "bad json");
    expect((await f.read()).availability).toBe("unavailable");
    f.files.clear();
    f.host.readFileStrict = async () => { throw new Error("Access denied"); };
    expect((await f.read()).diagnostics).toEqual(["Access denied"]);
  });
  it("never falls back when a native model exists", async () => {
    const f = fixture(); f.files.set(path, JSON.stringify(object)); f.files.set(".dext/project/model.json", "broken");
    expect((await f.read()).availability).toBe("unavailable");
  });
  it("binds real content and detects changes while ignoring checkbox progress", async () => {
    const f = fixture(); f.files.set(path, JSON.stringify(object));
    const context = f.service.bindPlan(await f.read(), ".dext/plans/a.plan.md", "1. [ ] Work", impact);
    expect(context.assessment).toBe("none");
    expect((await f.service.validatePlan(context, "1. [x] Work")).valid).toBe(true);    f.files.set(path, JSON.stringify({ ...object, description: "Changed public API" }));
    expect((await f.service.validatePlan(context, "1. [ ] Work")).valid).toBe(false);
  });
  it("checks applicability additions but ignores unrelated content edits", async () => {
    const f = fixture(); f.files.set(path, JSON.stringify(object));
    f.files.set(".dext/objects/other.json", JSON.stringify({ ...object, id: "other", canonicalName: "Other" }));
    const context = f.service.bindPlan(await f.read(), "a.plan.md", "Work", impact);
    f.files.set(".dext/objects/other.json", JSON.stringify({ ...object, id: "other", canonicalName: "Other", description: "unrelated" }));
    expect((await f.service.validatePlan(context, "Work")).valid).toBe(true);
    f.files.set(".dext/objects/new.json", JSON.stringify({ ...object, id: "new", canonicalName: "New" }));
    expect((await f.service.validatePlan(context, "Work")).valid).toBe(false);
  });
  it("loads the body of a directly related legacy norm without synthesizing a graph", async () => {
    const f = fixture(); f.files.set(path, JSON.stringify({ ...object, relatedIds: ["other"] }));
    f.files.set(".dext/objects/other.json", JSON.stringify({ ...object, id: "other", canonicalName: "Other", description: "Related invariant" }));
    expect((await f.read()).grounding).toContain("Related invariant");
    expect([...f.files.keys()]).toEqual([path, ".dext/objects/other.json"]);
  });
  it("does not approve absent matches, truncation, invalid references or foreign workspaces", async () => {
    const f = fixture(); f.files.set(path, JSON.stringify(object));
    expect(f.service.bindPlan(await f.read("unmatched"), "a", "Work", impact).assessment).toBe("unknown");
    expect(f.service.bindPlan(await f.read("#Missing[missing]"), "a", "Work", impact).assessment).toBe("unknown");
    f.files.set(path, JSON.stringify({ ...object, description: "x".repeat(30_000) }));
    const read = await f.read();
    expect(read.grounding.length).toBeLessThanOrEqual(24_000);
    expect(read.omitted).toEqual([path]);
    expect(f.service.bindPlan(read, "a", "Work", impact).assessment).toBe("unknown");
    // A 'none' claim needs complete grounding; a change is still an actionable statement.
    expect(f.service.bindPlan(read, "a", "1. [ ] Work norms: app", { ...impact, assessment: "change" }).assessment).toBe("change");
    expect((await f.service.readPlanContext({ input: "App", workspaceKey: process.cwd() + "/other" })).availability).toBe("unavailable");
  });
  it("indexes every norm and requires a task to name each changed norm", async () => {
    const f = fixture(); f.files.set(path, JSON.stringify(object));
    const read = await f.read();
    expect(read.grounding.split("\n")[0]).toBe("app\tmodule\tApp");
    const missing = f.service.bindPlan(read, "a", "1. [ ] Work", { ...impact, assessment: "change" });
    expect(missing.assessment).toBe("unknown");
    expect(missing.reason).toContain("app");
    expect(f.service.bindPlan(read, "a", "1. [ ] Work norms: app", { ...impact, assessment: "change" }).assessment).toBe("change");
  });
  it("checks dangling references and protects externally changed writes", async () => {
    const f = fixture(); const raw = JSON.stringify(object); f.files.set(path, raw);
    expect(await f.store.writeLegacyChecked(path, object, "wrong")).toBe("conflict");
    expect(f.files.get(path)).toBe(raw);
    expect(await f.store.writeLegacyChecked(path, object, projectContentHash(raw))).toBe("applied");
    f.files.set(path, JSON.stringify({ ...object, relatedIds: ["missing"] }));
    expect((await f.read()).availability).toBe("unavailable");
  });
});

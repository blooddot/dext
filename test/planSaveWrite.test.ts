import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("vscode", async () => (await import("./planHostMock.js")).createVscodeMock());

import { DextApplication } from "../src/app/application.js";
import { DEFAULT_PLAN_DIRECTORY, planFileName } from "../src/features/conversations/domain/planFile.js";
import { DextStorage } from "../src/platform/vscode/dextStorage.js";
import { planHostState as state, resetPlanHostState, type PlanHostStub } from "./planHostMock.js";

let globalRoot = "";
let workspaceRoot = "";
let name = "";

beforeEach(async () => {
  globalRoot = await mkdtemp(join(tmpdir(), "dext-plan-global-"));
  workspaceRoot = await mkdtemp(join(tmpdir(), "dext-plan-workspace-"));
  state.globalStorage = globalRoot;
  state.workspaceFolder = workspaceRoot;
  resetPlanHostState();
  // Plan names carry the save time, so a fixed clock keeps the assertions stable.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 7, 21, 9, 5, 3));
  name = planFileName(goal, new Date());
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(globalRoot, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
});

/** The writer is host-only, so a prototype instance with the fields it reads is
 * enough; constructing the whole extension would only add provider state. */
function application(): PlanHostStub {
  const app = Object.create(DextApplication.prototype) as unknown as PlanHostStub;
  app.storage = new DextStorage({ fsPath: state.globalStorage } as never);
  app.workspaceUri = state.workspaceFolder ? { fsPath: state.workspaceFolder } : undefined;
  app.workspaceTrusted = true;
  app.workspaceRoot = state.workspaceFolder ?? process.cwd();
  return app;
}

const goal = "Add a Redis cache";

describe("shared plan file writer", () => {
  it("resolves queued global and workspace Plans and checks the saved revision", async () => {
    const app = application();
    for (const location of ["global", "workspace"] as const) {
      const written = (await app.writePlanFile(goal, "# Plan", location))!;
      const hash = createHash("sha256").update(await readFile(written.filePath)).digest("hex");
      await expect(app.validateQueuedPlan(location === "global" ? written.filePath : written.reference, hash))
        .resolves.toBe(written.reference);
      await writeFile(written.filePath, "# Changed Plan\n");
      await expect(app.validateQueuedPlan(written.filePath, hash)).rejects.toThrow("saved Plan has changed");
    }
    const unrelated = join(globalRoot, "unrelated.plan.md");
    await writeFile(unrelated, "# Unrelated\n");
    await expect(app.validateQueuedPlan(unrelated, createHash("sha256").update("# Unrelated\n").digest("hex")))
      .rejects.toThrow("inside the current workspace or Dext Plan storage");
  });

  it("writes a global plan to Dext's storage and reports both reference and native path", async () => {
    state.settings.set("dext.storage.location", "global");
    const written = await application().writePlanFile(goal, "# Plan\n\nShip it.", "global");

    expect(written).toEqual({
      reference: `.dext-global/plans/${name}`,
      filePath: join(globalRoot, "plans", name)
    });
    expect(await readFile(written!.filePath, "utf8")).toBe("# Plan\n\nShip it.\n");
  });

  it("keeps the workspace plan path exactly as UI Plan has always saved it", async () => {
    state.settings.set("dext.storage.location", "workspace");
    const written = await application().writePlanFile(goal, "# Plan", "workspace");

    expect(written).toEqual({
      reference: `.dext/plans/${name}`,
      filePath: join(workspaceRoot, ".dext", "plans", name)
    });
    expect(written!.reference.startsWith(`${DEFAULT_PLAN_DIRECTORY}/`)).toBe(true);
  });

  it("follows a custom plan directory in the workspace location", async () => {
    state.settings.set("dext.planDirectory", "docs/plans");
    const written = await application().writePlanFile(goal, "# Plan", "workspace");

    expect(written!.reference).toBe(`docs/plans/${name}`);
    expect(written!.filePath).toBe(join(workspaceRoot, "docs", "plans", name));
  });

  it("lets the call's location override the setting without writing the other one", async () => {
    state.settings.set("dext.storage.location", "workspace");
    const global = await application().writePlanFile(goal, "# Plan", "global");
    expect(global!.filePath).toBe(join(globalRoot, "plans", name));
    expect(await readdir(join(workspaceRoot, ".dext", "plans")).catch(() => [])).toEqual([]);

    state.settings.set("dext.storage.location", "global");
    const workspace = await application().writePlanFile(goal, "# Plan", "workspace");
    expect(workspace!.reference).toBe(`.dext/plans/${name}`);
    expect(await readdir(join(globalRoot, "plans"))).toHaveLength(1);
  });

  it("numbers a plan that would reuse an existing name in the same second", async () => {
    const directory = join(globalRoot, "plans");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, name), "older\n", "utf8");

    const written = await application().writePlanFile(goal, "# Plan", "global");
    expect(written!.reference).toBe(`.dext-global/plans/${planFileName(goal, new Date(), 2)}`);
    expect(await readFile(join(directory, name), "utf8")).toBe("older\n");
  });

  it("writes a revision back to the same file and rejects an unexpected edit", async () => {
    const first = await application().writePlanFile(goal, "# Plan", "workspace");
    const target = first!.filePath;
    const hash = createHash("sha256").update(await readFile(target)).digest("hex");

    const revised = await application().writePlanFile(goal, "# Plan v2", "global", first!.reference, hash);
    expect(revised).toEqual({ reference: first!.reference, filePath: target });
    expect(await readFile(target, "utf8")).toBe("# Plan v2\n");

    await expect(application().writePlanFile(goal, "# Plan v3", "global", first!.reference, "stale"))
      .rejects.toThrow("Plan changed while generating its revision");
    expect(await readFile(target, "utf8")).toBe("# Plan v2\n");
  });

  it("writes nothing when the target location needs a trusted workspace", async () => {
    const app = application();
    app.workspaceTrusted = false;

    await expect(app.writePlanFile(goal, "# Plan", "workspace")).resolves.toBeUndefined();
    expect(await readdir(join(workspaceRoot, ".dext", "plans")).catch(() => [])).toEqual([]);

    app.workspaceUri = undefined;
    await expect(app.writePlanFile(goal, "# Plan", "workspace")).resolves.toBeUndefined();
  });
});

describe("UI Plan saving", () => {
  const text = "Here is the plan.\n<!-- dext-plan:start -->\n# Plan\n<!-- dext-plan:end -->";

  it("keeps the chat reply and the storage reference it has always returned", async () => {
    state.settings.set("dext.storage.location", "global");
    const saved = await application().savePlan(goal, {
      method: { id: "plan" },
      result: { kind: "plan", text }
    } as never);

    expect(saved.result).toMatchObject({ kind: "plan", text: "Here is the plan.", planPath: `.dext-global/plans/${name}` });
    expect(await readFile(join(globalRoot, "plans", name), "utf8")).toBe("# Plan\n");
  });

  it("returns an unsaved response unchanged in an untrusted workspace", async () => {
    state.settings.set("dext.storage.location", "workspace");
    const app = application();
    app.workspaceTrusted = false;
    const response = { method: { id: "plan" }, result: { kind: "plan", text } };

    await expect(app.savePlan(goal, response as never)).resolves.toBe(response);
    expect(await readdir(join(workspaceRoot, ".dext", "plans")).catch(() => [])).toEqual([]);
  });
});

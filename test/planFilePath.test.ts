import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("vscode", async () => (await import("./planHostMock.js")).createVscodeMock());

import { DextApplication } from "../src/app/application.js";
import { DextStorage } from "../src/platform/vscode/dextStorage.js";
import { planHostState as state, resetPlanHostState, type PlanHostStub } from "./planHostMock.js";

let globalRoot = "";
let workspaceRoot = "";

beforeEach(async () => {
  globalRoot = await mkdtemp(join(tmpdir(), "dext-plan-ref-global-"));
  workspaceRoot = await mkdtemp(join(tmpdir(), "dext-plan-ref-workspace-"));
  state.globalStorage = globalRoot;
  state.workspaceFolder = workspaceRoot;
  resetPlanHostState();
});

afterEach(async () => {
  await rm(globalRoot, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
});

function application(): PlanHostStub {
  const app = Object.create(DextApplication.prototype) as unknown as PlanHostStub;
  app.storage = new DextStorage({ fsPath: state.globalStorage } as never);
  app.workspaceUri = state.workspaceFolder ? { fsPath: state.workspaceFolder } : undefined;
  app.workspaceTrusted = true;
  return app;
}

describe("plan references across storage locations", () => {
  it("opens a global plan while plans are saved inside the workspace", () => {
    state.settings.set("dext.storage.location", "workspace");

    expect(application().planUri(".dext-global/plans/20260821-090503-cache.plan.md")).toMatchObject({
      fsPath: join(globalRoot, "plans", "20260821-090503-cache.plan.md")
    });
  });

  it("opens a workspace plan while plans are saved in global storage", () => {
    state.settings.set("dext.storage.location", "global");

    expect(application().planUri(".dext/plans/20260821-090503-cache.plan.md")).toMatchObject({
      fsPath: join(workspaceRoot, ".dext", "plans", "20260821-090503-cache.plan.md")
    });
  });

  it("opens a plan in a custom plan directory", () => {
    state.settings.set("dext.storage.location", "workspace");
    state.settings.set("dext.planDirectory", "docs/plans");

    expect(application().planUri("docs/plans/20260821-090503-cache.plan.md")).toMatchObject({
      fsPath: join(workspaceRoot, "docs", "plans", "20260821-090503-cache.plan.md")
    });
  });

  it("refuses a reference it does not own", () => {
    state.settings.set("dext.storage.location", "workspace");

    expect(application().planUri("notes/cache.md")).toMatchObject({
      fsPath: join(workspaceRoot, "notes", "cache.md")
    });
    expect(application().planUri("../outside/cache.plan.md")).toBeUndefined();
  });

  it("resolves nothing without a workspace", () => {
    state.workspaceFolder = undefined;
    const app = application();

    expect(app.planUri(".dext-global/plans/a.plan.md")).toMatchObject({
      fsPath: join(globalRoot, "plans", "a.plan.md")
    });
    expect(app.planUri(".dext/plans/a.plan.md")).toBeUndefined();
  });
});

describe("storage directories and references", () => {
  it("selects either location for one call without changing the setting", () => {
    state.settings.set("dext.storage.location", "workspace");
    const storage = new DextStorage({ fsPath: globalRoot } as never);

    expect(storage.reference("plans", "a.plan.md", "global")).toBe(".dext-global/plans/a.plan.md");
    expect(storage.reference("plans", "a.plan.md")).toBe(".dext/plans/a.plan.md");
    expect(storage.directory("plans", "global")).toMatchObject({ fsPath: join(globalRoot, "plans") });
    expect(storage.directory("plans", "workspace")).toMatchObject({ fsPath: join(workspaceRoot, ".dext", "plans") });
    expect(state.settings.get("dext.storage.location")).toBe("workspace");
  });

  it("rejects a reference whose name tries to leave the plan directory", () => {
    const storage = new DextStorage({ fsPath: globalRoot } as never);

    expect(() => storage.reference("plans", "../escape.plan.md", "global")).toThrow("path traversal");
    expect(storage.uriForReference("plans", ".dext-global/plans/../../escape.plan.md")).toBeUndefined();
  });
});

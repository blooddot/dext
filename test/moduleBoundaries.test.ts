import { describe, expect, it } from "vitest";
// The check is also a standalone Node CLI used before the build.
// @ts-expect-error Standalone build tooling has no emitted declaration.
import * as boundaryTools from "../scripts/checkModuleBoundaries.mjs";

const {
  checkBrowserMetafile,
  checkModuleBoundaries,
  checkRemovedModuleReferences,
  crossFeatureHostCouplings,
  declaredTypeEdges,
  migrationExceptions,
  removedModulePaths
} = boundaryTools as unknown as {
  checkBrowserMetafile(this: void, meta: unknown): string[];
  checkModuleBoundaries(this: void, sources: Record<string, string>): string[];
  checkRemovedModuleReferences(this: void, sources: Record<string, string>, removed?: readonly string[]): string[];
  crossFeatureHostCouplings: readonly { from: string; to: string }[];
  declaredTypeEdges: readonly { from: string; to: string }[];
  migrationExceptions: readonly unknown[];
  removedModulePaths: readonly string[];
};

const flags = (sources: Record<string, string>, text: string) => checkModuleBoundaries(sources).join("\n").includes(text);

describe("layer boundaries", () => {
  it("allows the six registered pure type edges and normal cross-feature contracts", () => {
    expect(checkModuleBoundaries({
      "src/features/resources/contracts/resourceDocuments.ts": 'import type { EditorTabState } from "../../../platform/editor-tabs/editorTabState.js";',
      "src/platform/editor-tabs/editorTabState.ts": "export interface EditorTabState { readonly page: string }",
      "src/features/a/domain/use.ts": 'import type { B } from "../../b/contracts/b.js";',
      "src/features/b/contracts/b.ts": "export interface B {}"
    })).toEqual([]);
    expect(declaredTypeEdges).toHaveLength(6);
  });

  it("rejects an unregistered pure type edge and any runtime host edge", () => {
    expect(flags({
      "src/features/a/contracts/x.ts": 'import type { Host } from "../host/run.js";',
      "src/features/a/host/run.ts": "export interface Host {}"
    }, "unregistered type edge")).toBe(true);
    expect(flags({
      "src/features/a/domain/x.ts": 'import { run } from "../host/run.js";',
      "src/features/a/host/run.ts": "export function run() {}"
    }, "runtime-depends")).toBe(true);
  });

  it("forbids contracts.ts, contracts/index.ts and new src root modules", () => {
    expect(flags({ "src/features/a/contracts.ts": "export {}" }, "never contracts.ts")).toBe(true);
    expect(flags({ "src/features/a/contracts/index.ts": "export {}" }, "not through an index barrel")).toBe(true);
    expect(flags({ "src/extra.ts": "export {}" }, "may only contain extension.ts")).toBe(true);
    expect(flags({ "src/core/types.ts": "export {}" }, "dissolved")).toBe(true);
  });

  it("keeps shared environment-free and inside its three subdirectories", () => {
    expect(flags({ "src/shared/lib/x.ts": 'import fs from "node:fs";' }, "shared depends on node:fs")).toBe(true);
    expect(flags({ "src/shared/x.ts": "export {}" }, "shared may only contain")).toBe(true);
    expect(flags({ "src/shared/lib/x.ts": 'import "../../features/a/contracts/a.js";' }, "shared depends on")).toBe(true);
  });

  it("keeps platform adapters from loading feature implementations", () => {
    expect(flags({
      "src/platform/vscode/x.ts": 'import { run } from "../../features/a/host/run.js";',
      "src/features/a/host/run.ts": "export function run() {}"
    }, "platform/vscode depends on feature implementation")).toBe(true);
    expect(flags({
      "src/platform/node/x.ts": 'import { run } from "../../features/a/host/run.js";',
      "src/features/a/host/run.ts": "export function run() {}"
    }, "platform/node depends on")).toBe(true);
    expect(checkModuleBoundaries({
      "src/platform/vscode/x.ts": 'import type { AgentProfile } from "../../features/agents/contracts/agent.js";',
      "src/features/agents/contracts/agent.ts": "export interface AgentProfile {}"
    })).toEqual([]);
  });

  it("keeps browser code away from hosts and hosts away from other browsers", () => {
    expect(flags({
      "src/features/a/browser/view.ts": 'import { run } from "../host/run.js";',
      "src/features/a/host/run.ts": "export function run() {}"
    }, "browser depends on host")).toBe(true);
    expect(flags({
      "src/features/a/host/run.ts": 'import "../../b/browser/view.js";',
      "src/features/b/browser/view.ts": "export {}"
    }, "host depends on feature browser")).toBe(true);
  });

  it("requires a registered cross-feature host coupling", () => {
    expect(flags({
      "src/features/a/host/run.ts": 'import "../../b/host/other.js";',
      "src/features/b/host/other.ts": "export {}"
    }, "unregistered cross-feature host coupling")).toBe(true);
    expect(checkModuleBoundaries({
      "src/features/workflow/host/runtime.ts": 'import { DefaultAgentRunner } from "../../agents/host/agentRouter.js";',
      "src/features/agents/host/agentRouter.ts": "export class DefaultAgentRunner {}"
    })).toEqual([]);
    expect(crossFeatureHostCouplings).toHaveLength(4);
  });

  it("keeps the webview and the runner out of host and feature code", () => {
    expect(flags({
      "src/webview/main.ts": 'import { run } from "../features/a/host/run.js";',
      "src/features/a/host/run.ts": "export function run() {}"
    }, "webview depends on")).toBe(true);
    expect(flags({
      "src/runner/host.ts": 'import { run } from "../features/a/domain/run.js";',
      "src/features/a/domain/run.ts": "export function run() {}"
    }, "runner depends on")).toBe(true);
    expect(flags({
      "src/webview/main.ts": 'import "../app/application.js";',
      "src/app/application.ts": "export {}"
    }, "webview depends on")).toBe(true);
  });

  it("rejects DOM globals in pure and host modules but not in browser modules", () => {
    expect(flags({ "src/features/a/presentation/view.ts": 'document.createElement("div");' }, "DOM global")).toBe(true);
    expect(flags({ "src/features/a/host/run.ts": 'window.setTimeout(() => {}, 0);' }, "DOM global")).toBe(true);
    expect(checkModuleBoundaries({ "src/features/a/browser/view.ts": 'document.createElement("div");' })).toEqual([]);
  });

  it("detects runtime cycles", () => {
    expect(flags({
      "src/features/a/domain/one.ts": 'import "./two.js";',
      "src/features/a/domain/two.ts": 'import "./one.js";'
    }, "Runtime cycle")).toBe(true);
  });

  it("checks the actual browser bundle metadata", () => {
    const errors = checkBrowserMetafile({
      inputs: {
        "src/features/a/host/run.ts": {},
        "src/app/application.ts": {},
        "src/platform/vscode/theme.ts": {},
        "src/platform/node/codeRef.ts": {},
        "src/runner/dextHost.ts": {}
      },
      outputs: { "dist/webview/main.js": { imports: [{ path: "node:fs" }] } }
    });
    expect(errors).toHaveLength(6);
  });

  it("has cleared the old migration exception table", () => {
    expect(migrationExceptions).toEqual([]);
  });
});

describe("removed migration paths", () => {
  it("records every moved root, webview and core entry without duplicates", () => {
    for (const entry of [
      "src/application.ts",
      "src/sidebarProvider.ts",
      "src/vscodeTerminalHost.ts",
      "src/webview/agentInputView.ts",
      "src/webview/markdownDiagrams.ts",
      "src/core/toml.ts",
      "src/core/agentRunner.ts",
      "src/features/agents/contracts.ts",
      "src/features/workspace/contracts.ts",
      "src/platform/duration.ts"
    ]) expect(removedModulePaths).toContain(entry);
    expect(new Set(removedModulePaths).size).toBe(removedModulePaths.length);
    expect(removedModulePaths.length).toBeGreaterThan(70);
  });
  it("rejects static, type-only, dynamic and extensionless references", () => {
    const removed = ["src/core/toml.ts"];
    expect(checkRemovedModuleReferences({ "src/a.ts": 'import { parseToml } from "./core/toml.js";' }, removed)).toHaveLength(1);
    expect(checkRemovedModuleReferences({ "src/a.ts": 'import type { T } from "../src/core/toml.ts";' }, removed)).toHaveLength(1);
    expect(checkRemovedModuleReferences({ "src/a.ts": 'await import("./core/toml.js");' }, removed)).toHaveLength(1);
    expect(checkRemovedModuleReferences({ "src/a.ts": 'const toml = require("./core/toml");' }, removed)).toHaveLength(1);
  });
  it("rejects mocks, restored files, inlined build strings and comments", () => {
    expect(checkRemovedModuleReferences({ "test/a.test.ts": 'vi.mock("../src/core/toml.js", () => ({}));' }, ["src/core/toml.ts"])).toHaveLength(1);
    expect(checkRemovedModuleReferences({ "src/core/toml.ts": "export {};" }, ["src/core/toml.ts"])).toHaveLength(1);
    expect(checkRemovedModuleReferences({ "scripts/check.mjs": 'const contents = \'export { parseToml } from "./src/core/toml.ts";\';' }, ["src/core/toml.ts"])).toHaveLength(1);
    expect(checkRemovedModuleReferences({ "src/features/a/host/run.ts": "// see src/core/agentRunner.ts" }, ["src/core/agentRunner.ts"])).toHaveLength(1);
  });
  it("keeps the new contract directories and unrelated public exports working", () => {
    expect(checkRemovedModuleReferences({
      "src/app/application.ts": 'import { AgentProfile } from "../features/agents/contracts/agent.js"; export { parseToml } from "../features/agents/host/toml.js";',
      "scripts/check.mjs": 'const contents = \'export { renderResourceList } from "./src/features/resources/presentation/resourceDocuments.ts";\';'
    })).toEqual([]);
  });
  it("is part of the boundary check", () => {
    expect(checkModuleBoundaries({ "src/a.ts": 'import { parseToml } from "./core/toml.js";' }).join("\n")).toContain("removed migration path");
  });
});

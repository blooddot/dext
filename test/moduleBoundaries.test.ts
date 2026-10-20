import { describe, expect, it } from "vitest";
// The check is also a standalone Node CLI used before the build.
// @ts-expect-error Standalone build tooling has no emitted declaration.
import * as boundaryTools from "../scripts/checkModuleBoundaries.mjs";

const { checkBrowserMetafile, checkModuleBoundaries } = boundaryTools as unknown as {
 checkBrowserMetafile(this: void, meta: unknown): string[];
 checkModuleBoundaries(this: void, sources: Record<string, string>, exceptions?: Array<{ from: string; to: string; reason: string; removeWhen: string }>): string[];
};
describe("feature boundaries", () => {
  it("allows type-only host references and explicit cross-feature contracts", () => {
    expect(checkModuleBoundaries({
      "src/features/a/browser/view.ts": 'import type { Host } from "../host/run.js"; import { value } from "../../b/contracts.js";',
      "src/features/a/host/run.ts": 'import fs from "node:fs";',
      "src/features/b/contracts.ts": "export const value = 1;"
    })).toEqual([]);
  });
  it("follows compatibility exports and indirect runtime dependencies", () => {
    const result = checkModuleBoundaries({
      "src/features/a/browser/view.ts": 'export { run } from "../../../compat.js";',
      "src/compat.ts": 'export { run } from "./features/a/host/run.js";',
      "src/features/a/host/run.ts": 'import fs from "node:fs";'
    });
    expect(result.join("\n")).toContain("host/run.ts");
    expect(result.join("\n")).toContain("node:fs");
  });
  it("rejects reverse composition, cycles, and DOM in pure modules", () => {
    const result = checkModuleBoundaries({
      "src/features/a/presentation/view.ts": 'document.createElement("div"); import "../host/run.js";',
      "src/features/a/host/run.ts": 'import "../../../app/setup.js"; import "../presentation/view.js";',
      "src/app/setup.ts": "export {};"
    });
    expect(result.join("\n")).toContain("DOM global");
    expect(result.join("\n")).toContain("Runtime cycle");
    expect(result.join("\n")).toContain("feature depends on application composition");
  });
  it("requires exact exceptions with a reason and removal condition", () => {
    const files = { "src/features/a/host/run.ts": 'import "../../../application.js";', "src/application.ts": "export {};" };
    expect(checkModuleBoundaries(files).length).toBeGreaterThan(0);
    expect(checkModuleBoundaries(files, [{ from: "src/features/a/host/run.ts", to: "src/application.ts", reason: "legacy caller", removeWhen: "caller migrated" }])).toEqual([]);
  });
  it("checks the actual browser bundle metadata", () => {
    expect(checkBrowserMetafile({ inputs: { "src/features/a/host/run.ts": {} }, outputs: { "dist/webview/main.js": { imports: [{ path: "node:fs" }] } } })).toHaveLength(2);
  });
});

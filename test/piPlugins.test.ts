import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { piPlugins } from "../src/features/agents/host/piPlugins.js";

describe("resolving installed Pi packages", () => {
  it("maps npm and local entries to directories and skips what this run cannot load", () => {
    const root = mkdtempSync(join(tmpdir(), "dext-pi-plugins-"));
    try {
      mkdirSync(join(root, "npm", "node_modules", "@scope", "pkg"), { recursive: true });
      mkdirSync(join(root, "local-plugin"), { recursive: true });
      const settings = JSON.stringify({ packages: ["npm:@scope/pkg", "./local-plugin", "git:github.com/x/y", "npm:missing", { source: "npm:@scope/pkg" }] });
      expect(piPlugins(settings, root)).toEqual([
        { id: "./local-plugin", label: "./local-plugin", path: join(root, "local-plugin") },
        { id: "npm:@scope/pkg", label: "@scope/pkg", path: join(root, "npm", "node_modules", "@scope", "pkg") }
      ]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("reads no packages from settings Pi cannot parse", () => {
    expect(piPlugins("{", "/nonexistent")).toEqual([]);
    expect(piPlugins("{}", "/nonexistent")).toEqual([]);
  });
});

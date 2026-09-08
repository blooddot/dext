import { describe, expect, it } from "vitest";
import { harnessPolicyPatch, harnessBinding, encodeHarnessSession, decodeHarnessSession } from "../src/core/deepseekHarnessPolicy.js";
describe("Harness policy", () => {
  it.each(["read-only", "workspace-write", "full-access"] as const)("pins all user preset choices to %s", (permission) => {
    const patch = JSON.parse(harnessPolicyPatch(permission, process.cwd())) as { id: string; config: { presets?: Record<string, { sandbox: string; approval: string }> } }[];
    const presets = Object.values(patch.find((item) => item.id === "permission")!.config.presets!);
    expect(presets).toHaveLength(3);
    expect(presets.every((item) => item.sandbox === (permission === "full-access" ? "danger-full-access" : permission))).toBe(true);
    if (permission !== "full-access") expect(presets.every((item) => item.approval === "never")).toBe(true);
  });
  it("binds sessions to permission and launch configuration", async () => {
    const first = await harnessBinding(process.cwd(), "read-only", "dsh", []);
    expect(await harnessBinding(process.cwd(), "workspace-write", "dsh", [])).not.toBe(first);
    expect(await harnessBinding(process.cwd(), "read-only", "other-dsh", [])).not.toBe(first);
    expect(decodeHarnessSession(encodeHarnessSession("native-id", first))).toEqual({ id: "native-id", binding: first });
    expect(() => decodeHarnessSession("native-id")).toThrow("Invalid");
  });
});

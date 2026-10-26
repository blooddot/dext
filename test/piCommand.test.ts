import { describe, expect, it } from "vitest";
import { checkPiVersion, piArguments, piCommand, piExtraArguments, piPermission, piTools } from "../src/features/agents/host/piCommand.js";

describe("associating an installed Pi command", () => {
  it("rejects an incompatible executable and respects an already cancelled connection check", async () => {
    await expect(checkPiVersion(process.execPath, process.cwd())).rejects.toThrow("could not start or report its version");
    const controller = new AbortController(); controller.abort(new Error("connection cancelled"));
    await expect(checkPiVersion(process.execPath, process.cwd(), controller.signal)).rejects.toThrow("connection cancelled");
  });
  it("accepts an existing explicit command without searching for Node or installing anything", () => {
    expect(piCommand({ provider: "pi", command: process.execPath })).toBe(process.execPath);
    expect(() => piCommand({ provider: "pi", command: "dext-definitely-missing-pi" })).toThrow("not found on PATH");
  });
  it("does not let extra arguments override managed capabilities", () => {
    expect(piExtraArguments(["--append-system-prompt", "extra instruction"])).toHaveLength(2);
    for (const args of [["--tools", "bash"], ["--extension", "evil.mjs"], ["--append-system-prompt"], ["--", "prompt"], ["--mode=print"]]) expect(() => piExtraArguments(args)).toThrow();
  });
  it("requires explicit full access for trusted writes and never upgrades a request", () => {
    expect(piPermission(false, "full-access", true)).toBe("read-only");
    expect(() => piPermission(true, "workspace-write", true)).toThrow("Explicitly select Full access");
    expect(() => piPermission(true, "full-access", false)).toThrow("trusted");
    expect(piPermission(true, "full-access", true)).toBe("full-access");
    expect(piTools("read-only", false)).not.toContain("bash");
    expect(piTools("full-access", true, "win32")).toContain("powershell");
  });
  it("keeps trusted text context but disables executable project resources", () => {
    const base = { extensionPath: "C:/extension path/pi.mjs", sessionDirectory: "C:/sessions", permission: "read-only" as const };
    const args = piArguments({ ...base, trusted: true });
    expect(args).toContain("--no-approve"); expect(args).toContain("--no-mcp");
    expect(args).not.toContain("--no-context-files");
    expect(piArguments({ ...base, trusted: false })).toContain("--no-context-files");
    const api = piArguments({ ...base, trusted: true, result: true });
    expect(api).toContain("--no-session"); expect(api).not.toContain("--session-dir");
  });
});

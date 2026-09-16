import { describe, expect, it } from "vitest";
import { parseToml, tomlString } from "../src/core/toml.js";

describe("TOML parsing", () => {
  it("reads nested tables the same way JSON.parse reads objects", () => {
    const parsed = parseToml(`
model = "gpt-5" # comment
[shell_environment_policy.set]
CODEX_CLI_PATH = 'C:\\tools\\codex.exe'
`);
    expect(tomlString(parsed, "model")).toBe("gpt-5");
    expect(tomlString(parsed, "shell_environment_policy", "set", "CODEX_CLI_PATH")).toBe("C:\\tools\\codex.exe");
  });

  it("treats invalid or empty input as absent", () => {
    expect(parseToml("")).toEqual({});
    expect(parseToml("model = [")).toBeUndefined();
    expect(tomlString({ CODEX_CLI_PATH: "" }, "CODEX_CLI_PATH")).toBeUndefined();
  });
});

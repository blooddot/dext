import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { harnessSpawnCommand } from "../src/core/harnessCommand.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Harness command resolution", () => {
  it("runs a desktop launcher with its own executable, flags and environment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dext-harness-launcher-"));
    directories.push(directory);
    const executable = join(directory, "DeepSeek Harness.exe");
    const script = join(directory, "app.asar", "cli.js");
    const wrapper = join(directory, "dsh.cmd");
    await writeFile(executable, "");
    await writeFile(wrapper, [
      "@echo off",
      "setlocal DisableDelayedExpansion",
      'set "ELECTRON_RUN_AS_NODE=1"',
      '"%~dp0DeepSeek Harness.exe" --expose-internals "%~dp0app.asar\\cli.js" %*',
      "exit /b %errorlevel%"
    ].join("\r\n"));

    const invocation = harnessSpawnCommand(wrapper, ["--profile", "acp"], { platform: "win32", env: {} });

    expect(invocation.command).toBe(executable);
    expect(invocation.args).toEqual(["--expose-internals", script, "--profile", "acp"]);
    expect(invocation.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
  });

  it("keeps running a node wrapper through node", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dext-harness-node-"));
    directories.push(directory);
    const entry = join(directory, "bin.js");
    const wrapper = join(directory, "dsh.cmd");
    await writeFile(entry, "");
    await writeFile(join(directory, "node.exe"), "");
    await writeFile(wrapper, [
      "@ECHO off",
      "SET dp0=%~dp0",
      '"%~dp0node.exe" "%~dp0bin.js" %*'
    ].join("\r\n"));

    const invocation = harnessSpawnCommand(wrapper, ["--version"], { platform: "win32", env: {} });

    expect(invocation.command).toBe(join(directory, "node.exe"));
    expect(invocation.args).toEqual([entry, "--version"]);
    expect(invocation.env).toBeUndefined();
  });
});

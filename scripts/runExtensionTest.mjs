import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const root = fileURLToPath(new URL("..", import.meta.url));
const configured = process.env.VSCODE_EXECUTABLE_PATH;
const defaultExecutable = process.platform === "win32"
  ? join(process.env.LOCALAPPDATA ?? "", "Programs", "Microsoft VS Code", "Code.exe")
  : process.platform === "darwin"
    ? "/Applications/Visual Studio Code.app/Contents/MacOS/Electron"
    : "/usr/bin/code";
const vscodeExecutablePath = configured || defaultExecutable;
const useDownloadedBuild = process.env.DEXT_TEST_DOWNLOAD === "1";

if (!useDownloadedBuild && !existsSync(vscodeExecutablePath)) {
  throw new Error("VS Code executable not found. Set VSCODE_EXECUTABLE_PATH to run the host test.");
}

const options = {
  extensionDevelopmentPath: root,
  extensionTestsPath: join(root, "dist", "extensionHostTest.js"),
  launchArgs: [root, "--disable-extensions", "--skip-welcome", "--skip-release-notes"]
};

await runTests(useDownloadedBuild ? { ...options, version: "stable" } : {
  ...options,
  vscodeExecutablePath
});

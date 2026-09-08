import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeepSeekHarnessTransport, harnessSpawnCommand } from "../src/core/deepseekHarnessTransport.js";
const connections: DeepSeekHarnessTransport[] = [];
const directories: string[] = [];
const client = { sessionUpdate: async () => {}, requestPermission: async () => ({ outcome: { outcome: "cancelled" as const } }) };
const fixture = resolve("test/fixtures/acpAgent.mjs");
function connection(args: string[] = []) {
  const result = new DeepSeekHarnessTransport(process.execPath, [fixture, ...args], process.cwd(), client);
  connections.push(result); return result;
}
afterEach(async () => {
  await Promise.all(connections.splice(0).map((item) => item.close()));
  await Promise.all(directories.splice(0).map((item) => rm(item, { recursive: true, force: true })));
});
describe("Harness ACP transport", { timeout: 15000 }, () => {
  it("handshakes despite stderr output and correlates concurrent requests", async () => {
    const transport = connection(); await transport.initialize();
    const responses = await Promise.all(Array.from({ length: 3 }, () => transport.wait(transport.connection.newSession({ cwd: process.cwd(), mcpServers: [] }))));
    expect(new Set(responses.map((item) => item.sessionId)).size).toBe(3);
    await transport.close(); expect(transport.alive).toBe(false);
  });
  it("terminates an owned process that ignores EOF", async () => {
    const transport = connection(["--hang-on-close"]); await transport.initialize();
    const started = Date.now();
    await transport.close();
    expect(transport.alive).toBe(false);
    expect(Date.now() - started).toBeLessThan(4500);
  });
  it("bounds a missing handshake", async () => {
    const transport = connection(["--no-handshake"]);
    await expect(transport.wait(transport.initialize(), 100)).rejects.toThrow(/timed out/);
  });
  it("fails on malformed protocol output", async () => {
    await expect(connection(["--malformed"]).initialize()).rejects.toThrow(/protocol|closed/);
  });
  it("reports an unavailable executable", async () => {
    let transport: DeepSeekHarnessTransport | undefined;
    await expect((async () => {
      transport = new DeepSeekHarnessTransport(join(tmpdir(), "dext-missing-command.exe"), [], process.cwd(), client);
      await transport.initialize();
    })()).rejects.toThrow(/found|ENOENT/);
    await transport?.close();
  });
  it("resolves an npm shim with spaces without using a shell", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dext shim ")); directories.push(directory);
    const entry = join(directory, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
    await mkdir(join(entry, ".."), { recursive: true }); await writeFile(entry, "");
    const shim = join(directory, "dsh.cmd");
    await writeFile(shim, '@ECHO off\n"%dp0%\\node.exe" "%dp0%\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*');
    const args = ["--patch", "C:/path with spaces/policy.json"];
    expect(harnessSpawnCommand(shim, args).args).toEqual([entry, ...args]);
  });
});

import { join, resolve } from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { checkPiVersion } from "../src/features/agents/host/piCommand.js";
import { afterEach, describe, expect, it } from "vitest";
import { PiRpcTransport } from "../src/features/agents/host/piRpcTransport.js";
const connections: PiRpcTransport[] = [];
function connection(...args: string[]): PiRpcTransport {
  const transport = new PiRpcTransport(process.execPath, [resolve("test/fixtures/piAgent.mjs"), ...args], process.cwd());
  connections.push(transport); return transport;
}
afterEach(async () => { await Promise.all(connections.splice(0).map((item) => item.close())); });
describe("Pi JSONL transport", () => {
  it.skipIf(process.platform !== "win32")("associates a batch path with spaces and forwards literal arguments", async () => {
    const root = await mkdtemp(join(tmpdir(), "dext pi launch "));
    try {
      const command = join(root, "pi local.cmd");
      await writeFile(command, `@echo off\r\n"${process.execPath}" "${resolve("test/fixtures/piAgent.mjs")}" %*\r\n`);
      await checkPiVersion(command, root);
      const log = join(root, "arguments.jsonl");
      const transport = new PiRpcTransport(command, ["--append-system-prompt", "literal with spaces & symbols"], root, { ...process.env, PI_FIXTURE_LOG: log });
      connections.push(transport);
      expect(await transport.request("echo", { value: "correct" })).toBe("correct");
      expect(JSON.parse((await readFile(log, "utf8")).split("\n")[0]!)).toMatchObject({ startup: ["--append-system-prompt", "literal with spaces & symbols"] });
      await transport.close();
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 50 }); }
  });
  it("writes large frames under pipe backpressure without losing concurrent requests", async () => {
    const transport = connection(), large = "中".repeat(100000);
    expect(await Promise.all([transport.request("echo", { value: large }), transport.request("echo", { value: "after" })])).toEqual([large, "after"]);
  });
  it("correlates responses that arrive out of order and drains stderr", async () => {
    const transport = connection("--flood-stderr");
    expect(await Promise.all([transport.request("echo", { value: "first", delay: 20 }), transport.request("echo", { value: "second" })])).toEqual(["first", "second"]);
  });
  it("handles fragmented UTF-8, CRLF and unicode separators", async () => {
    expect(await connection("--fragment").request("echo")).toBe("中文\u2028\u2029");
  });
  it("fails malformed protocol data and missing replies", async () => {
    await expect(connection("--malformed").request("echo")).rejects.toThrow("malformed");
    await expect(connection("--no-reply").request("echo", {}, 50)).rejects.toThrow("timed out");
  });
  it("aborts pending requests and terminates a process that ignores EOF", async () => {
    const transport = connection("--no-reply", "--hang-on-close"), controller = new AbortController();
    const waiting = transport.request("echo", {}, 30000, controller.signal); controller.abort(new Error("stopped"));
    await expect(waiting).rejects.toThrow("stopped");
    await transport.close(); expect(transport.alive).toBe(false);
  });
  it("reports missing executables without installing or repairing them", async () => {
    const transport = new PiRpcTransport("dext-missing-pi", [], process.cwd()); connections.push(transport);
    await expect(transport.request("get_state")).rejects.toThrow("Unable to launch");
  });
});

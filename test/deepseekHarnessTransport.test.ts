import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
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
/** The client capabilities the fixture echoed back from `initialize`. */
function advertised(transport: DeepSeekHarnessTransport): Record<string, unknown> {
  return (transport.capabilities?._meta ?? {}) as Record<string, unknown>;
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
  it("reports the cause and stderr behind a generic ACP internal error", async () => {
    const transport = connection(["--internal-error"]); await transport.initialize();
    const failure = transport.wait(transport.connection.newSession({ cwd: process.cwd(), mcpServers: [] }));
    await expect(failure).rejects.toThrow(/^DeepSeek Harness Internal error: Cannot read properties of undefined \(reading 'session'\)/);
    await expect(failure).rejects.toThrow(/Harness stderr:\nfixture diagnostic/);
    await expect(failure).rejects.toMatchObject({ cause: { message: "Internal error" } });
  });
  it("leaves an ACP error that already names its cause untouched", async () => {
    const transport = connection(); await transport.initialize();
    await expect(transport.wait(transport.connection.resumeSession({ sessionId: "missing", cwd: process.cwd(), mcpServers: [] })))
      .rejects.toThrow(/^not resumable$/);
  });
  it("reports an unavailable executable", async () => {
    let transport: DeepSeekHarnessTransport | undefined;
    await expect((async () => {
      transport = new DeepSeekHarnessTransport(join(tmpdir(), "dext-missing-command.exe"), [], process.cwd(), client);
      await transport.initialize();
    })()).rejects.toThrow(/found|ENOENT/);
    await transport?.close();
  });
  it("advertises elicitation only when Dext can render the card", async () => {
    const plain = connection(); await plain.initialize();
    expect(advertised(plain).clientCapabilities).toEqual({});
    const capable = new DeepSeekHarnessTransport(process.execPath, [fixture], process.cwd(), {
      ...client, createElicitation: async () => ({ action: "decline" as const })
    });
    connections.push(capable); await capable.initialize();
    expect(advertised(capable).clientCapabilities).toEqual({ elicitation: { form: {} } });
  });
  it("routes ACP elicitation and the private bridge to Dext's client surface", async () => {
    const elicitations: { mode: string; message: string }[] = [];
    const messages: string[] = [];
    const transport = new DeepSeekHarnessTransport(process.execPath, [fixture], process.cwd(), {
      sessionUpdate: (event) => {
        const update = event.update;
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") messages.push(update.content.text);
      },
      requestPermission: async () => ({ outcome: { outcome: "cancelled" as const } }),
      createElicitation: (params) => {
        elicitations.push({ mode: params.mode, message: params.message });
        return { action: "accept" as const, content: { scope: "user", notes: "typed" } };
      },
      harnessQuestion: async () => ({ status: "answered" as const, answer: { answers: [{ id: "q", selected: ["B"] }] } })
    });
    connections.push(transport);
    await transport.initialize();
    const session = await transport.wait(transport.connection.newSession({ cwd: process.cwd(), mcpServers: [] }));
    await transport.wait(transport.connection.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "elicitation" }] }));
    await transport.wait(transport.connection.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "bridge-question" }] }));
    expect(elicitations).toEqual([{ mode: "form", message: "Which scope?" }]);
    expect(messages).toEqual([
      "Inspecting", JSON.stringify({ action: "accept", content: { scope: "user", notes: "typed" } }),
      "Inspecting", JSON.stringify({ id: "fixture-question-1", status: "answered", answer: { answers: [{ id: "q", selected: ["B"] }] } })
    ]);
  });
  it.each([
    "%dp0%\\node_modules\\@deepseek-ai\\dsh\\custom dir\\entry.mjs",
    "%~dp0\\node_modules\\@deepseek-ai\\dsh\\custom dir\\entry.mjs",
    "%dp0%/node_modules/@deepseek-ai/dsh/custom dir/entry.mjs",
    "%dp0%\\node_modules/@deepseek-ai\\dsh/custom dir\\entry.mjs"
  ])("resolves an npm shim with spaces without using a shell: %s", async (shimEntry) => {
    const directory = await mkdtemp(join(tmpdir(), "dext shim ")); directories.push(directory);
    const entry = join(directory, "node_modules", "@deepseek-ai", "dsh", "custom dir", "entry.mjs");
    await mkdir(join(entry, ".."), { recursive: true }); await writeFile(entry, "");
    const shim = join(directory, "dsh.cmd");
    await writeFile(shim, `@ECHO off\n"%dp0%\\node.exe" "${shimEntry}" %*`);
    const args = ["--patch", "C:/path with spaces/policy.json"];
    expect(harnessSpawnCommand(shim, args, { platform: "win32", env: {} })).toEqual({ command: "node", args: [await realpath(entry), ...args] });
  });
});

import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
const sessions = new Map();
const send = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);
const options = (model = "model-a", effort = "high") => [
  { id: "model", name: "Model", type: "select", currentValue: model, options: [{ value: "model-a", name: "Model A" }, { value: "model-b", name: "Model B" }] },
  { id: "reasoning_effort", name: "Reasoning", type: "select", currentValue: effort, options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] }
];
const update = (sessionId, event) => send({ method: "session/update", params: { sessionId, update: event } });
const pending = new Map();
if (process.argv.includes("--malformed")) process.stdout.write("not json\n");
const lines = createInterface({ input: process.stdin });
lines.on("close", () => { if (process.argv.includes("--hang-on-close")) setInterval(() => {}, 1000); else process.exit(); });
lines.on("line", async (line) => {
  const message = JSON.parse(line), p = message.params ?? {};
  if (!message.method) { pending.get(message.id)?.(message.result); pending.delete(message.id); return; }
  const result = (value) => send({ id: message.id, result: value });
  switch (message.method) {
    case "initialize":
      if (process.argv.includes("--no-handshake")) return;
      process.stderr.write("fixture diagnostic\n");
      return result({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {}, list: {} } }, authMethods: [] });
    case "session/new": { const id = randomUUID(); sessions.set(id, options()); return result({ sessionId: id, configOptions: options() }); }
    case "session/resume":
      if (p.sessionId === "missing") return send({ id: message.id, error: { code: -32602, message: "not resumable" } });
      sessions.set(p.sessionId, options()); return result({ configOptions: options() });
    case "session/set_config_option": {
      const opts = sessions.get(p.sessionId); opts.find((item) => item.id === p.configId).currentValue = p.value;
      return result({ configOptions: opts });
    }
    case "session/close": if (process.argv.includes("--hang-on-close")) return; sessions.delete(p.sessionId); return result({});
    case "session/cancel": return;
    case "session/prompt": {
      const text = p.prompt.map((item) => item.text ?? "").join("");
      if (text === "crash") return process.exit(7);
      if (text === "hang") return;
      if (text === "slow") await new Promise((resolve) => setTimeout(resolve, 120));
      if (text === "todo") update(p.sessionId, { sessionUpdate: "plan", entries: [
        { content: "Inspect", status: "in_progress", priority: "high" },
        { content: "Verify", status: "pending", priority: "medium" }
      ] });
      update(p.sessionId, { sessionUpdate: "agent_message_chunk", messageId: "progress", content: { type: "text", text: "Inspecting" } });
      update(p.sessionId, { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Inspect workspace", kind: "read", status: "in_progress" });
      let answer = text;
      if (text === "permission") {
        const id = randomUUID();
        const response = new Promise((resolve) => pending.set(id, resolve));
        send({ id, method: "session/request_permission", params: { sessionId: p.sessionId, toolCall: { toolCallId: "tool-1" }, options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }
        ] } });
        answer = JSON.stringify(await response);
      }
      update(p.sessionId, { sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "done" } }] });
      if (text === "todo") update(p.sessionId, { sessionUpdate: "plan", entries: [
        { content: "Inspect", status: "completed", priority: "high" },
        { content: "Verify", status: "in_progress", priority: "medium" }
      ] });
      if (text.includes("Dext JSON payload:")) answer = text.includes("bad-json") ? "invalid" : JSON.stringify({ kind: "chat", text: "typed answer" });
      update(p.sessionId, { sessionUpdate: "agent_message_chunk", messageId: "final", content: { type: "text", text: answer } });
      return result({ stopReason: "end_turn" });
    }
    default: return send({ id: message.id, error: { code: -32601, message: "Unsupported method" } });
  }
});

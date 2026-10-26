import { connect } from "node:net";
import { StringDecoder } from "node:string_decoder";

/** This file is shipped with Dext and loaded explicitly into the user's existing Pi. */
export default async function dextPiExtension(pi) {
  const endpoint = process.env.DEXT_PI_BRIDGE, token = process.env.DEXT_PI_BRIDGE_TOKEN;
  if (!endpoint || !token) throw new Error("Dext Pi bridge is unavailable.");
  const socket = connect(endpoint), decoder = new StringDecoder("utf8"), pending = new Map();
  let sequence = 0, buffer = "", config, active = true;
  const send = (frame) => socket.write(`${JSON.stringify(frame)}\n`);
  let resolveConfig, rejectConfig;
  const configured = new Promise((resolve, reject) => { resolveConfig = resolve; rejectConfig = reject; });
  const initialization = setTimeout(() => { rejectConfig(new Error("Dext bridge initialization timed out.")); socket.destroy(); }, 30000);
  const fail = () => {
    clearTimeout(initialization); rejectConfig(new Error("Dext bridge disconnected."));
    for (const finish of pending.values()) finish({ status: "unavailable" }); pending.clear();
  };
  socket.on("error", fail); socket.on("close", fail);
  socket.on("connect", () => send({ token }));
  socket.on("data", (chunk) => {
    buffer += decoder.write(chunk);
    if (buffer.length > 1024 * 1024) { socket.destroy(); return; }
    const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
    for (const line of lines) {
      let frame;
      try { frame = JSON.parse(line); } catch { socket.destroy(); return; }
      if (frame.type === "config") { clearTimeout(initialization); resolveConfig(frame.config); }
      else if (frame.type === "clear") { active = false; pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "dext_submit_result")); }
      else if (frame.type === "begin") active = true;
      else if (pending.has(frame.id)) { const finish = pending.get(frame.id); pending.delete(frame.id); finish(frame); }
    }
  });
  config = await configured;
  const call = (kind, args, signal) => new Promise((resolve) => {
    if (!active || socket.destroyed || signal?.aborted) { resolve({ status: "unavailable" }); return; }
    const id = `pi-tool-${++sequence}`;
    const finish = (reply) => { signal?.removeEventListener("abort", abort); pending.delete(id); resolve(reply); };
    const abort = () => finish({ status: "cancelled" });
    pending.set(id, finish); signal?.addEventListener("abort", abort, { once: true }); send({ id, kind, ...args });
  });
  const result = (reply) => ({ content: [{ type: "text", text: JSON.stringify(reply) }], isError: ["unavailable", "rejected"].includes(reply.status) });
  const string = { type: "string" }, question = { type: "object", properties: {
    id: string, header: string, question: string, detail: string, isSecret: { type: "boolean" }, multiSelect: { type: "boolean" },
    options: { type: "array", items: { type: "object", properties: { label: string, description: string }, required: ["label"], additionalProperties: false } }
  }, required: ["id", "question"], additionalProperties: false };
  pi.registerTool({ name: "dext_request_user_input", label: "Ask the user", description: "Ask the user one or more questions. Supports choices, multiple selections and a custom answer. Wait for the actual response.",
    parameters: { type: "object", properties: { questions: { type: "array", items: question, minItems: 1, maxItems: 20 } }, required: ["questions"], additionalProperties: false },
    async execute(_id, args, signal) { return result(await call("question", { questions: args.questions }, signal)); } });
  pi.registerTool({ name: "dext_update_plan", label: "Update tasks", description: "Publish the complete current task list. When executing a Dext plan also report its stable task IDs with the instructed dext-todo protocol.",
    parameters: { type: "object", properties: { todos: { type: "array", items: { type: "object", properties: { id: string, text: string, status: { type: "string", enum: ["pending", "in_progress", "completed"] } }, required: ["id", "text", "status"], additionalProperties: false } } }, required: ["todos"], additionalProperties: false },
    async execute(_id, args, signal) { return result(await call("todo", { todos: args.todos }, signal)); } });
  if (config.resultSchema) pi.registerTool({ name: "dext_submit_result", label: "Submit result", description: "Submit the complete final result object matching this schema. Fix any validation diagnostics and submit again. Do not wrap or escape the object.",
    parameters: config.resultSchema, async execute(_id, args, signal) { return result(await call("submit_result", { args }, signal)); } });
  pi.on("tool_call", (event) => {
    if (config.permission !== "full-access" && !config.tools.includes(event.toolName)) return { block: true, reason: "This Dext turn is read-only; this tool is unavailable." };
    if (!active && event.toolName.startsWith("dext_")) return { block: true, reason: "The Dext turn has ended." };
    return undefined;
  });
  pi.on("session_shutdown", () => { active = false; socket.destroy(); });
  if (config.permission === "full-access") for (const server of config.mcpServers) pi.registerMcpServer(`dext_${token.slice(0, 8)}_${server.name}`, { command: server.command, args: server.args, env: server.env, exposure: "direct" });
  send({ type: "ready" });
}

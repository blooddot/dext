import { connect } from "node:net";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
const args = process.argv.slice(2), option = (key) => args[args.indexOf(key) + 1];
if (args.includes("--version")) { process.stdout.write("1.4.0\n"); process.exit(0); }
const models = [{ provider: "test", id: "flash", reasoning: true, contextWindow: 1000 }, { provider: "other", id: "plain", reasoning: false, contextWindow: 1000 }];
let model = models[0], thinkingLevel = "high", input = 0, output = 0, contextTokens = 0, retryTimer;
let sessionFile = args.includes("--no-session") ? undefined : args.includes("--session") ? option("--session") : args.includes("--session-dir") ? join(option("--session-dir"), `${randomUUID()}.jsonl`) : undefined;
if (args.includes("--session")) {
  try { const stored = JSON.parse(readFileSync(sessionFile, "utf8")); model = stored.model; thinkingLevel = stored.thinkingLevel; input = stored.input; output = stored.output; }
  catch { process.stderr.write("invalid fixture session\n"); process.exit(1); }
}
const persist = () => { if (sessionFile) { mkdirSync(dirname(sessionFile), { recursive: true }); writeFileSync(sessionFile, JSON.stringify({ model, thinkingLevel, input, output })); } };
const log = (value) => { if (process.env.PI_FIXTURE_LOG) appendFileSync(process.env.PI_FIXTURE_LOG, `${JSON.stringify(value)}\n`); };
log({ startup: args, pid: process.pid });
const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
let config, channel, pending = new Map(), toolSequence = 0;
if (process.env.DEXT_PI_BRIDGE && !args.includes("--no-bridge")) {
  channel = connect(process.env.DEXT_PI_BRIDGE); let buffer = "";
  channel.on("error", () => {});
  channel.on("connect", () => channel.write(`${JSON.stringify({ token: process.env.DEXT_PI_BRIDGE_TOKEN })}\n`));
  channel.on("data", (chunk) => {
    buffer += chunk.toString("utf8"); const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
    for (const line of lines) {
      const frame = JSON.parse(line);
      if (frame.type === "config") { config = frame.config; channel.write('{"type":"ready"}\n'); }
      else if (pending.has(frame.id)) { const finish = pending.get(frame.id); pending.delete(frame.id); finish(frame); }
    }
  });
}
const call = (kind, fields) => new Promise((resolve) => { const id = `fixture-${++toolSequence}`; pending.set(id, resolve); channel.write(`${JSON.stringify({ id, kind, ...fields })}\n`); });
const message = (text, failed = false) => {
  const value = { role: "assistant", content: [{ type: "text", text }], stopReason: failed ? "error" : "stop", ...(failed ? { errorMessage: "503 fixture" } : {}), usage: { input: 2, output: 3, totalTokens: 5 } };
  send({ type: "message_start", message: { role: "assistant", content: [] } });
  send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } });
  send({ type: "message_end", message: value }); input += 2; output += 3; contextTokens = input + output; persist();
  send({ type: "agent_end", messages: [value], willRetry: failed });
};
function example(schema, root = schema) {
  if (schema.$ref) return example(schema.$ref.split("/").slice(1).reduce((value, key) => value[key], root), root);
  if ("const" in schema) return schema.const;
  if (schema.enum) return schema.enum[0];
  if (schema.anyOf || schema.oneOf) return example((schema.anyOf || schema.oneOf)[0], root);
  if (schema.type === "object" || schema.properties) return Object.fromEntries((schema.required || []).map((key) => [key, example(schema.properties[key], root)]));
  if (schema.type === "array") return [];
  if (schema.type === "number" || schema.type === "integer") return 1;
  if (schema.type === "boolean") return true;
  return "fixture answer";
}
async function receive(request) {
  log({ command: request.type, ...(request.type === "prompt" ? { message: request.message, model, thinkingLevel } : {}) });
  const reply = (data) => send({ type: "response", command: request.type, id: request.id, success: true, data });
  if (request.type === "echo") {
    if (args.includes("--flood-stderr")) process.stderr.write("x".repeat(2 * 1024 * 1024));
    if (args.includes("--malformed")) { process.stdout.write("invalid\n"); return; }
    if (args.includes("--no-reply")) return;
    if (args.includes("--fragment")) {
      const bytes = Buffer.from(JSON.stringify({ type: "response", command: request.type, id: request.id, success: true, data: "中文\u2028\u2029" }) + "\r\n");
      for (const byte of bytes) process.stdout.write(Buffer.from([byte])); return;
    }
    setTimeout(() => reply(request.value), Number(request.delay ?? 0)); return;
  }
  if (request.type === "get_state") { if (args.includes("--no-handshake")) return; return reply({ model, thinkingLevel, sessionId: "fixture", sessionFile, isStreaming: false }); }
  if (request.type === "get_available_models") return reply({ models });
  if (request.type === "get_available_thinking_levels") return reply({ levels: model.reasoning ? ["off", "high"] : ["off"] });
  if (request.type === "set_model") {
    const selected = models.find((item) => item.provider === request.provider && item.id === request.modelId);
    if (!selected) return send({ type: "response", id: request.id, command: request.type, success: false, error: "Model not found" });
    if (selected !== model) thinkingLevel = selected.reasoning ? "high" : "off";
    model = selected; return reply(model);
  }
  if (request.type === "set_thinking_level") { thinkingLevel = request.level; return reply(); }
  if (request.type === "get_session_stats") return reply({ tokens: { input, output, cacheRead: 0, cacheWrite: 0, total: input + output }, contextUsage: { tokens: contextTokens, contextWindow: 1000 } });
  if (["clear_queue", "abort_retry", "abort"].includes(request.type)) { clearTimeout(retryTimer); reply({}); if (request.type === "abort") send({ type: "agent_settled", aborted: true }); return; }
  if (request.type === "prompt") {
    const text = request.message;
    if (text === "fixture:handled") return reply({ disposition: "handled" });
    if (text === "fixture:queued") return reply({ disposition: "queued" });
    reply({ disposition: "started" });
    if (text === "fixture:hang") return;
    if (text === "fixture:tool-hang") { send({ type: "tool_execution_start", toolCallId: "silent", toolName: "bash", args: {} }); return; }
    if (text === "fixture:retry" || text === "fixture:retry-fail") {
      message("retrying", true); send({ type: "auto_retry_start", attempt: 1, delayMs: 60 });
      retryTimer = setTimeout(() => {
        if (text.endsWith("-fail")) { send({ type: "auto_retry_end", success: false, finalError: "503 exhausted" }); send({ type: "agent_settled", aborted: false }); }
        else { send({ type: "auto_retry_end", success: true }); message("recovered"); send({ type: "agent_settled", aborted: false }); }
      }, 60); return;
    }
    if (text === "fixture:compact") { send({ type: "compaction_start", reason: "threshold" }); input += 4; output += 1; send({ type: "compaction_end", reason: "threshold", result: { summary: "short" }, aborted: false }); }
    if (text === "fixture:project-query") {
      message(JSON.stringify(await call("project_query", { query: { operation: "summary", limit: 2 } })));
    } else if (text === "fixture:todo") {
      message('<!-- dext-todo: {"updates":[{"id":"plan-1","status":"in_progress"}]} -->\nImplementing');
    } else if (text === "fixture:question") {
      const answer = await call("question", { questions: [{ id: "q", question: "Choose", options: [{ label: "A", description: "" }, { label: "B", description: "" }], multiSelect: true }] });
      message(JSON.stringify(answer));
    } else if (config?.resultSchema) {
      const rejected = await call("submit_result", { args: { unexpected: true } }); log({ rejected });
      const value = example(config.resultSchema); const accepted = await call("submit_result", { args: value }); log({ accepted }); message("prose after certified result");
    } else if (text.includes("PI_RESOURCE_SMOKE")) message(JSON.stringify({ name: "review", content: "# Review\nUse evidence." }));
    else if (text.includes("PI_IMPORT_SMOKE")) message(JSON.stringify({ packName: "review-pack", skillDirectories: ["skills/review"], excluded: [], confidence: "high", summary: "Review pack" }));
    else message(text === "fixture:compact" ? "compacted" : text);
    send({ type: "agent_settled", aborted: false }); return;
  }
  reply({});
}
let buffer = ""; const decoder = new StringDecoder("utf8");
process.stdin.on("data", (chunk) => { buffer += decoder.write(chunk); const lines = buffer.split("\n"); buffer = lines.pop() ?? ""; for (const line of lines) void receive(JSON.parse(line)); });
process.stdin.on("end", () => { clearTimeout(retryTimer); channel?.destroy(); if (args.includes("--hang-on-close")) setInterval(() => {}, 1000); });

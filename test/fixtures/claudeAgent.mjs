// A deterministic stand-in for `claude --input-format stream-json
// --permission-prompt-tool stdio`. It speaks the control protocol the real CLI
// speaks: tool decisions arrive as `control_request` frames and the host answers
// with `control_response` frames.
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

const sessionId = randomUUID();
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const pending = new Map();
const message = (role, content) => ({ type: role === "assistant" ? "assistant" : "user", session_id: sessionId, message: { role, content } });
const ask = (request) => {
  const id = randomUUID();
  const answer = new Promise((resolve) => pending.set(id, resolve));
  send({ type: "control_request", request_id: id, request });
  return answer;
};
const questions = [{ question: "Which one?", header: "Confirm", multiSelect: false, options: [
  { label: "A", description: "The first choice" }, { label: "B", description: "" }
] }];

const scenarios = {
  async question() {
    send(message("assistant", [{ type: "tool_use", id: "tool-1", name: "AskUserQuestion", input: { questions } }]));
    const answer = await ask({ subtype: "can_use_tool", tool_name: "AskUserQuestion", display_name: "AskUserQuestion",
      input: { questions }, tool_use_id: "tool-1", requires_user_interaction: true });
    return `answers=${JSON.stringify(answer.response?.updatedInput?.answers ?? null)}`;
  },
  async "question-multi"() {
    const multi = [
      { question: "Which targets?", header: "Targets", multiSelect: true, options: [{ label: "A", description: "" }, { label: "B", description: "" }] },
      { question: "Anything else?", header: "Notes", multiSelect: false, options: [] }
    ];
    send(message("assistant", [{ type: "tool_use", id: "tool-1", name: "AskUserQuestion", input: { questions: multi } }]));
    const answer = await ask({ subtype: "can_use_tool", tool_name: "AskUserQuestion", display_name: "AskUserQuestion",
      input: { questions: multi }, tool_use_id: "tool-1", requires_user_interaction: true });
    return `answers=${JSON.stringify(answer.response?.updatedInput?.answers ?? null)}`;
  },
  async permission() {
    send(message("assistant", [{ type: "tool_use", id: "tool-2", name: "Write", input: { file_path: "C:/ws/out.txt", content: "hi" } }]));
    const answer = await ask({ subtype: "can_use_tool", tool_name: "Write", display_name: "Write",
      input: { file_path: "C:/ws/out.txt", content: "hi" }, tool_use_id: "tool-2" });
    return `decision=${answer.response?.behavior ?? "none"}`;
  },
  async elicitation() {
    const schema = { type: "object", properties: {
      scope: { type: "string", title: "Scope", description: "Where", oneOf: [{ const: "user", title: "User" }, { const: "workspace", title: "Workspace" }] },
      notes: { type: "string", title: "Notes" }
    } };
    const answer = await ask({ subtype: "elicitation", mcp_server_name: "demo", message: "Pick", mode: "form", requested_schema: schema });
    return `elicitation=${JSON.stringify(answer.response)}`;
  },
  async cancelled() {
    const id = randomUUID();
    // The card is left open: the host is expected to close it when the CLI
    // withdraws the request, not to answer it afterwards.
    pending.set(id, () => {});
    send({ type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name: "AskUserQuestion",
      display_name: "AskUserQuestion", input: { questions }, tool_use_id: "tool-1", requires_user_interaction: true } });
    await new Promise((resolve) => setTimeout(resolve, 80));
    send({ type: "control_cancel_request", request_id: id });
    return "cancelled";
  },
  crash() { process.exit(7); },
  "error-result"() {
    send({ type: "result", subtype: "error", session_id: sessionId, is_error: true, result: "Claude Code hit its turn limit." });
    return undefined;
  },
  hang() { return new Promise(() => {}); },
  async plain() { return "plain answer"; }
};

const lines = createInterface({ input: process.stdin });
lines.on("close", () => process.exit());
lines.on("line", (line) => {
  let frame;
  try { frame = JSON.parse(line); } catch { return; }
  if (frame.type === "control_response") {
    const settle = pending.get(frame.response?.request_id);
    pending.delete(frame.response?.request_id);
    settle?.(frame.response?.subtype === "success" ? frame.response : { response: { behavior: "deny" } });
    return;
  }
  if (frame.type !== "user") return;
  const input = (frame.message?.content ?? []).map((block) => block.text ?? "").join("").trim();
  void (async () => {
    send({ type: "system", subtype: "init", session_id: sessionId, tools: ["AskUserQuestion", "Write"] });
    let answer;
    try { answer = await (scenarios[input] ?? scenarios.plain)(); }
    catch (error) { answer = `failed: ${String(error?.message ?? error)}`; }
    if (answer === undefined) return; // The scenario emitted its own terminal frame.
    send(message("assistant", [{ type: "text", text: answer }]));
    send({ type: "result", subtype: "success", session_id: sessionId, is_error: false, result: answer,
      usage: { input_tokens: 10, output_tokens: 5 } });
  })();
});

import { createInterface } from "node:readline";
const scenario = process.env.DEXT_QUESTION_TEST ?? "blocking";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const notify = (method, params) => send({ method, params: { threadId: "thread-1", turnId: "turn-1", ...params } });
const finish = (answer) => {
  notify("item/completed", { item: { type: "agentMessage", id: "final", text: `Received: ${answer}`, phase: "final_answer" } });
  notify("turn/completed", { turn: { id: "turn-1", status: "completed" } });
};
let config;
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params, result, error } = JSON.parse(line);
  if (id === "question-1" && !method) {
    if (error) process.exit(3);
    notify("serverRequest/resolved", { requestId: id });
    finish(result.answers.q1?.answers[0] ?? "skipped"); continue;
  }
  if (!method || id === undefined) continue;
  if (method === "initialize") send({ id, result: {} });
  else if (["thread/start", "thread/resume", "thread/fork"].includes(method)) {
    config = { method, ...params }; send({ id, result: { thread: { id: "thread-1" } } });
  } else if (method === "turn/start") {
    notify("turn/started", { turn: { id: "turn-1", status: "inProgress" } });
    send({ id, result: { turn: { id: "turn-1" } } });
    if (scenario === "config") { finish(JSON.stringify({ config, input: params.input })); continue; }
    if (scenario === "exit") { process.exit(2); }
    if (scenario === "async" || scenario === "expires" || scenario === "steer-fails") {
      notify("item/started", { item: { type: "agentMessage", id: "async-1", delivery: "async", text: "" } });
      notify("item/agentMessage/delta", { itemId: "async-1", delta: "Question in plain text" });
      const item = { type: "agentMessage", id: "async-1", delivery: "async", questions: [{ title: "Does it highlight?", options: ["Yes", "No"] }] };
      notify("item/completed", { item });
      notify("item/completed", { item }); // replay must not ask twice
      if (scenario === "expires") setTimeout(() => finish("expired"), 80);
    } else {
      send({ id: "question-1", method: "item/tool/requestUserInput", params: {
        threadId: "thread-1", turnId: "turn-1", itemId: "tool-1", isBlocking: true,
        questions: [{ id: "q1", header: "Highlight", question: "Does it highlight?", isSecret: scenario === "secret", isOther: true,
          options: [{ label: "Yes", description: "A border appears" }, { label: "No", description: "No change" }] }]
      } });
      if (scenario === "resolved") setTimeout(() => {
        notify("serverRequest/resolved", { requestId: "question-1" }); finish("resolved");
      }, 80);
    }
  } else if (method === "turn/steer") {
    if (params.expectedTurnId !== "turn-1") process.exit(4);
    if (scenario === "steer-fails") { send({ id, error: { message: "Turn no longer accepts answers" } }); continue; }
    send({ id, result: { turnId: "turn-1" } });
    setTimeout(() => finish(params.input[0].text), 20);
  } else if (method === "turn/interrupt") { send({ id, result: {} }); process.exit(0); }
  else send({ id, error: { message: "Unknown fixture request" } });
}

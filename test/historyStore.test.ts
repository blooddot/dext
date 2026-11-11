import { uiCallForm } from "../src/shared/contracts/uiForm.js";
import { describe, expect, it } from "vitest";
import { DextHistoryStore } from "../src/features/conversations/host/historyStore.js";
import { MemoryHistoryBackend } from "./historyBackend.js";

/** A store over the in-memory backend: the index plus one body per
 * conversation, exactly as the disk layer keeps them. */
function memoryStore(backend = new MemoryHistoryBackend(), limits?: () => { maxTurns: number; maxOutputLength: number }) {
  return new DextHistoryStore(backend, limits);
}

describe("DextHistoryStore", () => {
  it("restores the saved plan target, its status and its progress", async () => {
    const backend = new MemoryHistoryBackend(); const store = memoryStore(backend);
    await store.updatePlanProgress("s", "a.plan.md", []);
    await store.updatePlanContext("s", "a.plan.md", "active");
    const restored = (await memoryStore(backend).sessions())[0]!;
    expect(restored.activePlanPath).toBe("a.plan.md");
    expect(restored.planStatus).toBe("active");
    expect(restored.planProgress?.path).toBe("a.plan.md");
    await store.updatePlanContext("s", "b.plan.md", "active");
    expect((await store.sessions())[0]?.activePlanPath).toBe("b.plan.md");
  });
  it("persists a round checkpoint before a final turn exists, without losing native session bindings", async () => {
    const backend = new MemoryHistoryBackend(); const store = memoryStore(backend);
    const todos = [{ id: "plan-1", text: "Implement", status: "in_progress" as const }];
    await store.updatePlanProgress("plan", "plans/build.plan.md", todos);
    await store.setProviderSession("plan", "codex", "native-session");
    const restored = (await memoryStore(backend).sessions())[0]!;
    expect(restored.turns).toEqual([]);
    expect(restored.planProgress).toEqual({ path: "plans/build.plan.md", todos });
    expect(restored.providerSessions).toEqual({ codex: "native-session" });
    await store.addSuccess("build", [], { kind: "workflow", executions: [] }, "plan", "plan", "turn", {
      executePlan: true, planPath: "plans/build.plan.md", planOutcome: { status: "incomplete", reason: "No progress", rounds: 3 }
    });
    expect((await memoryStore(backend).sessions())[0]?.turns[0]?.planOutcome?.status).toBe("incomplete");
  });
  it("retains Plan execution identity after success, cancellation and reload without changing the input", async () => {
    const backend = new MemoryHistoryBackend();
    const store = memoryStore(backend);
    const context = { executePlan: true, planPath: "plans/build.plan.md" };
    await store.addSuccess("internal build prompt", [], { kind: "workflow", executions: [] }, "plan", "plan", "success", context);
    await store.addFailure("internal build prompt", [], new Error("Cancelled"), "plan", "plan", "cancelled", context);
    await store.addSuccess("Write a plan", [], { kind: "workflow", executions: [] }, "plan", "plan", "draft");
    const turns = (await memoryStore(backend).sessions())[0]!.turns;
    expect(turns.slice(0, 2)).toEqual([
      expect.objectContaining({ ...context, id: "success", input: "internal build prompt" }),
      expect.objectContaining({ ...context, id: "cancelled", input: "internal build prompt", error: "Cancelled" })
    ]);
    expect(turns[2]?.executePlan).toBeUndefined();
  });

  it("persists skills, command and resource source on success and failure", async () => {
    const backend = new MemoryHistoryBackend();
    const store = memoryStore(backend);
    const context = {
      skills: ["ponytail-review"],
      command: { id: "ponytail-review", skillId: "ponytail-review" },
      resourceSource: "import" as const
    };
    await store.addSuccess("/ponytail-review src/a.ts", [], { kind: "workflow", executions: [] }, "session", "agent", "success", context);
    await store.addFailure("/ponytail-review src/a.ts", [], new Error("failed"), "session", "agent", "failure", context);
    const turns = (await memoryStore(backend).sessions())[0]!.turns;
    expect(turns[0]).toMatchObject({ ...context, input: "/ponytail-review src/a.ts" });
    expect(turns[1]).toMatchObject({ ...context, input: "/ponytail-review src/a.ts", error: "failed" });
  });

  it("keeps CLI bindings after deleting the final Dext record and reloading", async () => {
    const backend = new MemoryHistoryBackend();
    const store = memoryStore(backend);
    await store.addSuccess("only turn", [], { kind: "workflow", executions: [] }, "session-1", "ask", "turn-1");
    await store.setProviderSession("session-1", "claude", "claude-thread");
    await store.setProviderSession("session-1", "deepseek-harness", "dsh-binding");
    expect(await store.removeTurn("session-1", "turn-1", { codex: "codex-thread" })).toBe(true);
    const restarted = memoryStore(backend);
    expect((await restarted.sessions())[0]).toMatchObject({
      id: "session-1", turns: [], providerSessions: { codex: "codex-thread", claude: "claude-thread", "deepseek-harness": "dsh-binding" }
    });
    await restarted.addSuccess("continue", [], { kind: "workflow", executions: [] }, "session-1");
    expect((await restarted.sessions())[0]?.providerSessions).toEqual({ codex: "codex-thread", claude: "claude-thread", "deepseek-harness": "dsh-binding" });
  });

  it("does not count retained empty CLI sessions as turns when enforcing history limits", async () => {
    const store = memoryStore(new MemoryHistoryBackend(), () => ({ maxTurns: 1, maxOutputLength: 1000 }));
    await store.addSuccess("only turn", [], { kind: "workflow", executions: [] }, "empty", "ask", "turn-1");
    await store.removeTurn("empty", "turn-1", { codex: "thread" });
    await store.addSuccess("first", [], { kind: "workflow", executions: [] }, "active");
    await store.addSuccess("second", [], { kind: "workflow", executions: [] }, "active");
    const sessions = await store.sessions();
    expect(sessions.flatMap((session) => session.turns.map((turn) => turn.input))).toEqual(["second"]);
    expect(sessions.find((session) => session.id === "empty")?.providerSessions).toEqual({ codex: "thread" });
  });

  it("keeps every turn when the limit is zero", async () => {
    const store = memoryStore();
    for (const input of ["first", "second", "third"]) {
      await store.addSuccess(input, [], { kind: "workflow", executions: [] }, "session-1");
    }
    await store.addSuccess("other", [], { kind: "workflow", executions: [] }, "session-2");
    const sessions = await store.sessions();
    expect(sessions.map((session) => session.turns.map((turn) => turn.input))).toEqual([["first", "second", "third"], ["other"]]);
    expect(store.summaries().map((summary) => summary.turnCount)).toEqual([3, 1]);
  });

  it("rewrites the index without touching a conversation body for metadata changes", async () => {
    const backend = new MemoryHistoryBackend();
    const store = memoryStore(backend);
    await store.addSuccess("first", [], { kind: "workflow", executions: [] }, "session-1");
    await store.addSuccess("second", [], { kind: "workflow", executions: [] }, "session-1");
    backend.written.length = 0;
    await store.setArchived("session-1", true);
    await store.updatePlanContext("session-1", "a.plan.md", "active");
    await store.setProviderSession("session-1", "codex", "thread");
    expect(backend.written).toEqual([]);
    expect((await store.sessions(true))[0]).toMatchObject({
      archivedAt: expect.any(Number), activePlanPath: "a.plan.md", providerSessions: { codex: "thread" }
    });
    expect((await store.sessions(true))[0]?.turns.map((turn) => turn.input)).toEqual(["first", "second"]);
  });

  it("persists a turn title independently of its input, sibling turns and parent conversation", async () => {
    const backend = new MemoryHistoryBackend();
    const store = memoryStore(backend);
    await store.addSuccess("original input", [], { kind: "workflow", executions: [] }, "session-1", "agent", "turn-1");
    await store.addFailure("second input", [], "failed", "session-1", "agent", "turn-2");
    const before = (await store.sessions())[0]!;
    expect(await store.renameTurn("session-1", "turn-1", "  New title  ")).toBe(true);
    const restored = (await memoryStore(backend).sessions())[0]!;
    expect(restored).toEqual({ ...before, turns: [{ ...before.turns[0]!, title: "New title" }, before.turns[1]!] });
    expect(await store.renameTurn("session-1", "turn-1", "   ")).toBe(true);
    expect((await store.sessions())[0]).toEqual(before);
    expect(await store.renameTurn("missing", "turn-1", "wrong")).toBe(false);
    expect(await store.renameTurn("session-1", "missing", "wrong")).toBe(false);
  });

  it("keeps turn names during concurrent writes and forks them independently", async () => {
    const store = memoryStore(new MemoryHistoryBackend({ delayed: true }));
    await store.addSuccess("first", [], { kind: "workflow", executions: [] }, "session-1", "ask", "turn-1");
    await Promise.all([
      store.renameTurn("session-1", "turn-1", "renamed"),
      store.addSuccess("second", [], { kind: "workflow", executions: [] }, "session-1")
    ]);
    const source = (await store.sessions())[0]!;
    expect(source.turns).toHaveLength(2);
    expect(source.turns[0]?.title).toBe("renamed");
    const forked = await store.fork(source.turns.slice(0, 1));
    expect(forked.turns[0]?.title).toBe("renamed");
    await store.renameTurn(forked.id, forked.turns[0]!.id, "fork title");
    expect((await store.sessions())[0]?.turns[0]?.title).toBe("renamed");
  });

  it("persists successful and failed execution records", async () => {
    const store = memoryStore();
    await store.addSuccess("ask(input=\"hello\")", [{ phase: "status", text: "started" }], {
      kind: "workflow",
      executions: []
    }, "session-1");
    await store.addFailure("terminal(command=\"git status\")", [], new Error("cancelled"), "session-1");
    const sessions = await store.sessions();
    expect(sessions).toHaveLength(1);
    const records = sessions[0]!.turns;
    expect(records.map((record) => record.input)).toEqual([
      'ask(input="hello")',
      'terminal(command="git status")'
    ]);
    expect(records[0]?.output).toContain("workflow");
    expect(records[0]?.response).toEqual({ kind: "workflow", executions: [] });
    expect(records[1]?.error).toBe("cancelled");
  });

  it("keeps the execution id when persisting a cancelled turn", async () => {
    const store = memoryStore();

    await store.addFailure("unfinished request", [], new Error("cancelled"), "session-1", "agent", "turn-running");

    expect((await store.sessions())[0]?.turns[0]?.id).toBe("turn-running");
    expect(await store.removeTurn("session-1", "turn-running")).toBe(true);
    expect(await store.sessions()).toEqual([]);
  });

  it("does not lose turns when separate conversations finish together", async () => {
    const store = memoryStore(new MemoryHistoryBackend({ delayed: true }));
    await Promise.all([
      store.addSuccess("first", [], { kind: "workflow", executions: [] }, "session-1"),
      store.addSuccess("second", [], { kind: "workflow", executions: [] }, "session-2")
    ]);

    expect((await store.sessions()).map((session) => [session.id, session.turns[0]?.input])).toEqual([
      ["session-1", "first"],
      ["session-2", "second"]
    ]);
  });

  it("honours the configured turn and output limits on every write", async () => {
    const limits = { maxTurns: 2, maxOutputLength: 12 };
    const store = memoryStore(new MemoryHistoryBackend(), () => limits);
    for (const input of ["first", "second", "third"]) {
      await store.addSuccess(input, [], { kind: "workflow", executions: [] }, "session-1");
    }
    // The oldest turn is what goes when the cap is reached.
    expect((await store.sessions())[0]?.turns.map((turn) => turn.input)).toEqual(["second", "third"]);

    await store.addSuccess("a".repeat(40), [{ phase: "status", text: "b".repeat(40) }], {
      kind: "workflow",
      executions: []
    }, "session-2");
    const turn = (await store.sessions()).at(-1)?.turns.at(-1);
    expect(turn?.input).toBe("a".repeat(12));
    expect(turn?.process[0]?.text).toBe(`${"b".repeat(6)}\n... output truncated ...\n${"b".repeat(6)}`);

    // Raising the limit takes effect on the next write, not the next window.
    limits.maxTurns = 10;
    limits.maxOutputLength = 100;
    await store.addSuccess("c".repeat(40), [], { kind: "workflow", executions: [] }, "session-2");
    expect((await store.sessions()).at(-1)?.turns.at(-1)?.input).toBe("c".repeat(40));
  });

  it("keeps both ends of oversized text and hands the whole value to the spill writer", async () => {
    const backend = new MemoryHistoryBackend();
    const store = memoryStore(backend, () => ({ maxTurns: 10, maxOutputLength: 12 }));
    const input = `begin${"-".repeat(28)}end`;
    const text = `head${"=".repeat(28)}tail`;
    await store.addSuccess(input, [{ phase: "status", text }], { kind: "workflow", executions: [] }, "session-1", "ask", "turn-1");
    const turn = (await store.sessions())[0]!.turns[0]!;
    // Input is re-sent by retry, so it is clipped without a marker.
    expect(turn.input.startsWith("begin")).toBe(true);
    expect(turn.input.endsWith("end")).toBe(true);
    expect(turn.input).not.toContain("truncated");
    expect(turn.process[0]?.text.startsWith("head")).toBe(true);
    expect(turn.process[0]?.text).toContain("\n... output truncated ...\n");
    expect(turn.process[0]?.text.endsWith("tail")).toBe(true);
    expect(backend.spilled[0]).toContain(input);
    expect(backend.spilled[0]).toContain(text);
    expect(turn.spillPath).toBe("/tmp/overflow.txt");
    expect(store.spillPath("session-1", "turn-1")).toBe("/tmp/overflow.txt");
    expect(store.spillPath("session-1", "missing")).toBeUndefined();
  });

  it("bounds a value that already carries the truncation marker like any other", async () => {
    const backend = new MemoryHistoryBackend();
    const store = memoryStore(backend, () => ({ maxTurns: 10, maxOutputLength: 12 }));
    // The event log bounds with the same limit, so a long line reaching the store
    // usually already bears the marker; that must not exempt it from the limit.
    const text = `head\n... output truncated ...\n${"middle".repeat(20)}tail`;
    await store.addSuccess("input", [{ phase: "status", text }], { kind: "workflow", executions: [] }, "session-1", "ask", "turn-2");
    const turn = (await store.sessions())[0]!.turns[0]!;
    expect(turn.process[0]?.text.length).toBeLessThan(text.length);
    expect(turn.process[0]?.text.startsWith("head\n.")).toBe(true);
    expect(turn.process[0]?.text).toContain("\n... output truncated ...\n");
    expect(turn.process[0]?.text.endsWith("tail")).toBe(true);
    expect(backend.spilled[0]).toContain(text);
    expect(turn.spillPath).toBe("/tmp/overflow.txt");
  });

  it("falls back to the built-in limits when a setting is nonsense", async () => {
    const store = memoryStore(new MemoryHistoryBackend(), () => ({ maxTurns: -1, maxOutputLength: -5 }));
    await store.addSuccess("kept", [], { kind: "workflow", executions: [] }, "session-1");
    expect((await store.sessions())[0]?.turns.map((turn) => turn.input)).toEqual(["kept"]);
  });

  it("forks selected turns into a conversation of their own", async () => {
    const store = memoryStore();
    await store.addSuccess("first", [], { kind: "workflow", executions: [] }, "session-1");
    await store.addSuccess("second", [], { kind: "workflow", executions: [] }, "session-1");
    const original = (await store.sessions())[0]!;

    await store.setProviderSession("session-1", "codex", "thread-1");
    const sourceWithProvider = (await store.sessions())[0]!;
    const forked = await store.fork(sourceWithProvider.turns.slice(0, 1), sourceWithProvider.providerSessions);

    expect(forked.turns.map((turn) => turn.input)).toEqual(["first"]);
    // A fork must not share turn identity with the conversation it came from.
    expect(forked.turns[0]?.id).not.toBe(original.turns[0]?.id);
    expect(forked.forkProviderSessions).toEqual({ codex: "thread-1" });
    const sessions = await store.sessions();
    expect(sessions.map((session) => session.id)).toEqual([original.id, forked.id]);
    expect(sessions[0]?.turns).toHaveLength(2);
  });

  it("removes a single conversation and keeps the rest", async () => {
    const store = memoryStore();
    await store.addSuccess("kept", [], { kind: "workflow", executions: [] }, "session-1");
    await store.addSuccess("dropped", [], { kind: "workflow", executions: [] }, "session-2");

    await store.remove("session-2");

    expect((await store.sessions()).map((session) => session.id)).toEqual(["session-1"]);
    expect(store.summaries().map((summary) => summary.id)).toEqual(["session-1"]);
  });

  it("removes one turn and drops an empty conversation", async () => {
    const store = memoryStore();
    await store.addSuccess("first", [], { kind: "workflow", executions: [] }, "session-1");
    await store.addSuccess("second", [], { kind: "workflow", executions: [] }, "session-1");
    const turns = (await store.sessions())[0]!.turns;

    expect(await store.removeTurn("session-1", turns[0]!.id)).toBe(true);
    expect((await store.sessions())[0]?.turns.map((turn) => turn.input)).toEqual(["second"]);
    expect(await store.removeTurn("session-1", turns[1]!.id)).toBe(true);
    expect(await store.sessions()).toEqual([]);
    expect(await store.removeTurn("session-1", "missing")).toBe(false);
  });

  it("migrates each legacy flat record into a one-turn conversation", async () => {
    const legacy = [{
      id: "old-1",
      createdAt: 100,
      input: 'ask(input="old")',
      process: [],
      output: '{"kind":"workflow","executions":[]}'
    }];
    const store = memoryStore(new MemoryHistoryBackend({ legacy }));

    expect(await store.sessions()).toEqual([expect.objectContaining({
      id: "legacy-old-1",
      turns: [expect.objectContaining({ id: "old-1", input: 'ask(input="old")' })]
    })]);
  });

  it("appends only to the conversation a turn belongs to", async () => {
    const backend = new MemoryHistoryBackend();
    const store = memoryStore(backend);
    await store.addSuccess("first", [], { kind: "workflow", executions: [] }, "session-1");
    await store.addSuccess("second", [], { kind: "workflow", executions: [] }, "session-2");
    backend.written.length = 0;
    await store.addSuccess("third", [], { kind: "workflow", executions: [] }, "session-1");
    expect(backend.written).toEqual(["session-1"]);
  });

  it("normalizes legacy inline reference storage before history presentation", async () => {
    const marker = "\uE000eyJraW5kIjoiZmlsZSIsInBheWxvYWQiOiJzcmMvYS50cyJ9\uE001";
    const stored = [{
      id: "old-ref",
      createdAt: 100,
      input: 'ask(input="Read ' + marker + '")',
      process: [],
      output: ""
    }];
    const store = memoryStore(new MemoryHistoryBackend({ legacy: stored }));

    expect((await store.sessions())[0]?.turns[0]?.input).toBe('ask(input="Read @src/a.ts")');
  });
});

it("preserves raw unknown history while bounding new interaction summaries and omitting secrets", async () => {
  const legacy = { id: "old", createdAt: 1, input: 'ui.choose(label="Old", options=["a"])', process: [], output: '{"kind":"ui","type":"choice","selected":["a"]}' };
  const backend = new MemoryHistoryBackend({ legacy: [legacy] });
  const store = memoryStore(backend, () => ({ maxTurns: 10, maxOutputLength: 500 }));
  expect((await store.sessions())[0]?.turns[0]).toEqual(legacy);
  const form = uiCallForm("input", { label: "Text" });
  await store.addSuccess("Input", [
    { phase: "input", text: "", uiInteraction: { sessionId: "s", turnId: "t", requestId: "r", status: "waiting", form } },
    { phase: "input", text: "", uiInteraction: { sessionId: "s", turnId: "t", requestId: "r", status: "submitted", form, answers: { answer: { type: "input", value: "x".repeat(2000) } } } },
    { phase: "input", text: "", userInput: { id: "native", blocking: true, status: "answered", questions: [{ id: "secret", question: "Secret", header: "", options: [], isSecret: true }], answers: { secret: { answers: ["private-value"] } } } }
  ], { kind: "workflow", executions: [] }, "new", "code", "new-turn");
  const sessions = await store.sessions();
  const record = sessions.find((session) => session.id === "new")!.turns[0]!;
  expect(record.process).toHaveLength(2);
  expect(record.process[0]?.text.length).toBeLessThan(550);
  expect(JSON.stringify(record)).not.toContain("private-value");
  expect(sessions[0]?.turns[0]).toEqual(legacy);
});

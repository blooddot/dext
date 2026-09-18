import { connect, type Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { HarnessBridge } from "../src/core/harnessBridge.js";
import type { HarnessQuestionOutcome } from "../src/core/harnessQuestions.js";

const question = { id: "q", question: "Which?" };

/** A peer that plays the Harness process: it authenticates and collects replies. */
function peer(bridge: HarnessBridge) {
  const socket: Socket = connect(bridge.endpoint);
  const replies: unknown[] = [];
  let buffer = "";
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) replies.push(JSON.parse(line));
  });
  const ready = new Promise<void>((resolve, reject) => { socket.once("connect", () => resolve()); socket.once("error", reject); });
  const write = (value: unknown): void => { socket.write(`${JSON.stringify(value)}\n`); };
  const settle = async (count: number): Promise<unknown[]> => {
    for (let attempt = 0; attempt < 100 && replies.length < count; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
    return replies;
  };
  return { socket, ready, write, settle };
}

describe("Harness private bridge", () => {
  it("answers each framed question and refuses the ones it cannot render", async () => {
    const seen: string[] = [];
    const bridge = new HarnessBridge(async (request): Promise<HarnessQuestionOutcome> => {
      seen.push(request.id);
      return { status: "answered", answer: { answers: request.questions.map((item) => ({ id: item.id, selected: ["A"] })) } };
    });
    const client = peer(bridge);
    try {
      await client.ready;
      client.write({ token: bridge.token });
      client.write("not json");
      // A frame Dext cannot render still has to be answered: the Harness
      // answerer waits on this socket, so silence parks the whole turn.
      client.write({ id: "bad", questions: [] });
      client.write({ id: "bad-options", questions: [{ id: "q", question: "Which?", options: [{}] }] });
      client.write({ id: "one", questions: [question] });
      client.write({ id: "two", questions: [question] });
      expect(await client.settle(4)).toEqual([
        { id: "bad", status: "unavailable" },
        { id: "bad-options", status: "unavailable" },
        { id: "one", status: "answered", answer: { answers: [{ id: "q", selected: ["A"] }] } },
        { id: "two", status: "answered", answer: { answers: [{ id: "q", selected: ["A"] }] } }
      ]);
      expect(seen).toEqual(["one", "two"]);
    } finally { client.socket.destroy(); bridge.dispose(); }
  });

  it("reports a refused or failed question instead of answering it", async () => {
    const bridge = new HarnessBridge(async (request) => {
      if (request.id === "boom") throw new Error("no card");
      return { status: "cancelled" };
    });
    const client = peer(bridge);
    try {
      await client.ready;
      client.write({ token: bridge.token });
      client.write({ id: "skip", questions: [question] });
      client.write({ id: "boom", questions: [question] });
      expect(await client.settle(2)).toEqual([
        { id: "skip", status: "cancelled" },
        { id: "boom", status: "unavailable" }
      ]);
    } finally { client.socket.destroy(); bridge.dispose(); }
  });

  it("ignores a peer that does not present the token", async () => {
    const answer = vi.fn(async (): Promise<HarnessQuestionOutcome> => ({ status: "cancelled" }));
    const bridge = new HarnessBridge(answer);
    const client = peer(bridge);
    try {
      await client.ready;
      client.write({ token: "wrong" });
      client.write({ id: "intruder", questions: [question] });
      expect(await client.settle(1)).toEqual([]);
      expect(answer).not.toHaveBeenCalled();
    } finally { client.socket.destroy(); bridge.dispose(); }
  });

  it("stops answering once disposed", async () => {
    const answer = vi.fn(async (): Promise<HarnessQuestionOutcome> => ({ status: "cancelled" }));
    const bridge = new HarnessBridge(answer);
    const client = peer(bridge);
    await client.ready;
    client.write({ token: bridge.token });
    bridge.dispose();
    client.write({ id: "late", questions: [question] });
    expect(await client.settle(1)).toEqual([]);
    expect(answer).not.toHaveBeenCalled();
    client.socket.destroy();
  });
});

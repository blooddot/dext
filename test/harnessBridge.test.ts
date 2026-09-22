import { connect, type Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { HarnessBridge } from "../src/core/harnessBridge.js";
import type { HarnessQuestionOutcome } from "../src/core/harnessQuestions.js";
import type { HarnessResultOutcome } from "../src/core/harnessResultTool.js";

const question = { id: "q", question: "Which?" };
const tool = { name: "dext_submit_result", description: "Submit the result.", parameters: { type: "object", properties: {} } };

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

/** Authenticate a peer, which the bridge only accepts as a frame of its own. */
async function authenticate(bridge: HarnessBridge, client: ReturnType<typeof peer>): Promise<void> {
  await client.ready;
  client.write({ token: bridge.token });
  client.write({ id: "probe", questions: [question] });
  await client.settle(1);
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

  it("validates the submissions the plugin forwards and answers each with its verdict", async () => {
    const seen: unknown[] = [];
    const bridge = new HarnessBridge(
      async (): Promise<HarnessQuestionOutcome> => ({ status: "cancelled" }),
      async (request): Promise<HarnessResultOutcome> => {
        seen.push(request.args);
        const args = request.args as { ok?: boolean };
        return args.ok === true ? { status: "accepted" } : { status: "rejected", diagnostics: "kind: Invalid input: expected \"ask\"" };
      }
    );
    const client = peer(bridge);
    try {
      await authenticate(bridge, client);
      // A submission is answered with the verdict, and a frame Dext cannot
      // validate is refused rather than accepted by silence.
      client.write({ id: "s1", kind: "submit", args: { nope: true } });
      client.write({ id: "s2", kind: "submit", args: { ok: true } });
      expect(await client.settle(3)).toEqual([
        { id: "probe", status: "cancelled" },
        { id: "s1", status: "rejected", diagnostics: "kind: Invalid input: expected \"ask\"" },
        { id: "s2", status: "accepted" }
      ]);
      expect(seen).toEqual([{ nope: true }, { ok: true }]);
    } finally { client.socket.destroy(); bridge.dispose(); }
  });

  it("refuses a submission whose validation threw instead of accepting it", async () => {
    const bridge = new HarnessBridge(
      async (): Promise<HarnessQuestionOutcome> => ({ status: "cancelled" }),
      async (): Promise<HarnessResultOutcome> => { throw new Error("no contract"); }
    );
    const client = peer(bridge);
    try {
      await authenticate(bridge, client);
      client.write({ id: "s", kind: "submit", args: {} });
      expect(await client.settle(2)).toEqual([{ id: "probe", status: "cancelled" }, { id: "s", status: "unavailable" }]);
    } finally { client.socket.destroy(); bridge.dispose(); }
  });

  it("publishes the turn's result tool and waits for the plugin to register it", async () => {
    const bridge = new HarnessBridge(async (): Promise<HarnessQuestionOutcome> => ({ status: "cancelled" }));
    const client = peer(bridge);
    try {
      await client.ready;
      // Nothing may be published before the plugin has authenticated.
      expect(await bridge.publishResultTool(tool)).toBe(false);
      await authenticate(bridge, client);
      const published = bridge.publishResultTool(tool);
      const publishedFrames = await client.settle(2) as [{ id: string }, { id: string; kind: string; tool: unknown }];
      const frame = publishedFrames[1];
      expect(frame).toEqual({ id: frame.id, kind: "tool", tool });
      client.write({ id: frame.id, status: "ready" });
      expect(await published).toBe(true);
      // Withdrawing publishes an explicit empty registration.
      const withdrawn = bridge.publishResultTool(undefined);
      const withdrawnFrames = await client.settle(3) as { id: string; tool?: unknown }[];
      const clear = withdrawnFrames[2]!;
      expect(clear.tool).toBeUndefined();
      client.write({ id: clear.id, status: "ready" });
      expect(await withdrawn).toBe(true);
    } finally { client.socket.destroy(); bridge.dispose(); }
  });

  it("keeps the prompt-carried fallback when the plugin does not register the tool", async () => {
    const bridge = new HarnessBridge(async (): Promise<HarnessQuestionOutcome> => ({ status: "cancelled" }));
    const client = peer(bridge);
    try {
      await authenticate(bridge, client);
      const published = bridge.publishResultTool(tool);
      const [, frame] = await client.settle(2) as [{ id: string }, { id: string }];
      // A preset may restrict the tool away: that is a refusal, not a failure.
      client.write({ id: frame.id, status: "unavailable" });
      expect(await published).toBe(false);
    } finally { client.socket.destroy(); bridge.dispose(); }
  });

  it("resolves a publication the plugin never answers", async () => {
    const bridge = new HarnessBridge(async (): Promise<HarnessQuestionOutcome> => ({ status: "cancelled" }));
    const client = peer(bridge);
    try {
      await authenticate(bridge, client);
      const controller = new AbortController();
      const published = bridge.publishResultTool(tool, controller.signal);
      controller.abort();
      expect(await published).toBe(false);
    } finally { client.socket.destroy(); bridge.dispose(); }
  });
});

import { describe, expect, it, vi } from "vitest";
import type { AxChatRequest } from "@ax-llm/ax";
import { CliAxAIService, renderChatPrompt, type CliAxTransport } from "../src/core/cliAxAIService.js";

const OUTPUT_FIELD = "structuredOutput";

function request(chatPrompt: AxChatRequest["chatPrompt"]): AxChatRequest {
  return { chatPrompt };
}

function service(transport: CliAxTransport, outputField = OUTPUT_FIELD): CliAxAIService {
  return new CliAxAIService({ id: "test", label: "Test CLI", outputField, transport });
}

function contentText(response: Awaited<ReturnType<CliAxAIService["chat"]>>): string {
  if (response instanceof ReadableStream) throw new Error("Unexpected stream.");
  return response.results[0]?.content ?? "";
}

function contentOf(response: Awaited<ReturnType<CliAxAIService["chat"]>>): unknown {
  return JSON.parse(contentText(response));
}

describe("renderChatPrompt", () => {
  it("labels roles and joins text content blocks", () => {
    const prompt = renderChatPrompt(request([
      { role: "system", content: "system rules" },
      { role: "user", content: "plain" },
      { role: "user", content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] },
      { role: "assistant", content: "previous" },
      { role: "function", result: "tool output", functionId: "f" }
    ]).chatPrompt);
    expect(prompt).toContain("System: system rules");
    expect(prompt).toContain("User: plain");
    expect(prompt).toContain("User: first\nsecond");
    expect(prompt).toContain("Assistant: previous");
    expect(prompt).toContain("Function: tool output");
  });
});

describe("CliAxAIService.chat", () => {
  it("wraps a bare result object in the output-field envelope", async () => {
    const transport = vi.fn(async () => ({ text: '{"kind":"agent","text":"done"}' }));
    const response = await service(transport).chat(request([{ role: "user", content: "go" }]));
    expect(contentOf(response)).toEqual({ [OUTPUT_FIELD]: { kind: "agent", text: "done" } });
  });

  it("passes an existing envelope through unchanged", async () => {
    const envelope = { [OUTPUT_FIELD]: { kind: "agent", text: "done" } };
    const response = await service(async () => ({ text: JSON.stringify(envelope) })).chat(request([{ role: "user", content: "go" }]));
    expect(contentOf(response)).toEqual(envelope);
  });

  it("extracts JSON from fenced blocks and surrounding narration", async () => {
    const raw = `Here is the result:\n\`\`\`json\n{"kind":"agent","text":"done"}\n\`\`\`\nDone.`;
    const response = await service(async () => ({ text: raw })).chat(request([{ role: "user", content: "go" }]));
    expect(contentOf(response)).toEqual({ [OUTPUT_FIELD]: { kind: "agent", text: "done" } });
  });

  it("falls back to the raw text when no JSON object is recoverable", async () => {
    const response = await service(async () => ({ text: "no json here" })).chat(request([{ role: "user", content: "go" }]));
    expect(contentText(response)).toBe("no json here");
  });

  it("ignores functions and responseFormat while rendering the prompt", async () => {
    let prompt = "";
    const transport: CliAxTransport = async (value) => { prompt = value; return { text: "{}" }; };
    await service(transport).chat({
      chatPrompt: [{ role: "user", content: "go" }],
      functions: [{ name: "doThing", description: "desc" }],
      functionCall: "required",
      responseFormat: { type: "json_object" }
    });
    expect(prompt).toContain("User: go");
    expect(prompt).not.toContain("doThing");
  });

  it("reports provider usage as AxModelUsage with the configured model", async () => {
    const response = await service(async () => ({
      text: JSON.stringify({ kind: "agent", text: "done" }),
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5, cachedInputTokens: 1 }
    })).chat(request([{ role: "user", content: "go" }]));
    if (response instanceof ReadableStream) throw new Error("Unexpected stream.");
    expect(response.modelUsage).toMatchObject({
      ai: "test",
      model: "unknown",
      tokens: { promptTokens: 2, completionTokens: 3, totalTokens: 5, cacheReadTokens: 1 }
    });
  });

  const signalError = (reason: unknown): Error => reason instanceof Error ? reason : new Error("aborted");

  it("rejects with the abort reason when the caller aborts", async () => {
    const transport: CliAxTransport = (_prompt, signal) => new Promise((_resolve, reject) => {
      if (signal?.aborted) reject(signalError(signal.reason));
      signal?.addEventListener("abort", () => reject(signalError(signal.reason)), { once: true });
    });
    const controller = new AbortController();
    const promise = service(transport).chat(request([{ role: "user", content: "go" }]), { abortSignal: controller.signal });
    controller.abort(new Error("caller stopped"));
    await expect(promise).rejects.toThrow("caller stopped");
  });

  it("honours a configured timeout by aborting the transport", async () => {
    const transport: CliAxTransport = (_prompt, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signalError(signal.reason)), { once: true });
    });
    const instance = service(transport);
    instance.setOptions({ timeout: 5 });
    await expect(instance.chat(request([{ role: "user", content: "go" }]))).rejects.toThrow(/timed out/);
  });

  it("declares CLI-compatible capabilities and records latency", async () => {
    const instance = service(async () => ({ text: "{}" }));
    const features = instance.getFeatures();
    expect(features).toMatchObject({ functions: false, streaming: false, structuredOutputs: true });
    expect(features.media.images.supported).toBe(false);
    const metrics = instance.getMetrics();
    expect(metrics.latency.chat.samples).toEqual([]);
    await instance.chat(request([{ role: "user", content: "go" }]));
    expect(instance.getMetrics().latency.chat.samples.length).toBe(1);
    expect(instance.getMetrics().errors.chat.total).toBe(1);
  });

  it("rejects unsupported modalities and returns empty options", async () => {
    const instance = service(async () => ({ text: "{}" }));
    await expect(instance.embed({ texts: ["x"] })).rejects.toThrow("embeddings");
    await expect(instance.transcribe({ audio: { data: "x" } })).rejects.toThrow("transcription");
    await expect(instance.speak({ text: "x" })).rejects.toThrow("speech");
    expect(instance.getOptions()).toEqual({});
    expect(instance.getModelList()).toBeUndefined();
    expect(instance.getEstimatedCost()).toBe(0);
  });
});

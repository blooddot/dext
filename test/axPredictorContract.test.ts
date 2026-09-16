import { describe, expect, it, vi } from "vitest";
import { AxGenerateError, ax, type AxAIServiceOptions, type AxChatRequest } from "@ax-llm/ax";
import { z } from "zod";
import { REPAIR_OUTPUT_FIELD, repairSignature } from "../src/core/axAdapter.js";
import { CliAxAIService, type CliAxTransport } from "../src/core/cliAxAIService.js";

const SCHEMA = z.object({ value: z.string() });

function envelope(value: unknown): string {
  return JSON.stringify({ [REPAIR_OUTPUT_FIELD]: value });
}

function service(transport: CliAxTransport): CliAxAIService {
  return new CliAxAIService({
    id: "contract",
    label: "Contract probe",
    outputField: REPAIR_OUTPUT_FIELD,
    transport
  });
}

function program() {
  const signature = repairSignature(SCHEMA);
  return ax(signature);
}

class ObservingService extends CliAxAIService {
  readonly requests: AxChatRequest[] = [];
  constructor(
    transport: CliAxTransport,
    private readonly structuredOutputs: boolean
  ) {
    super({ id: "observing", label: "Observing", outputField: REPAIR_OUTPUT_FIELD, transport });
  }

  override getFeatures() {
    return { ...super.getFeatures(), structuredOutputs: this.structuredOutputs };
  }

  override async chat(req: Readonly<AxChatRequest>, options?: Readonly<AxAIServiceOptions>) {
    this.requests.push(req);
    return super.chat(req, options);
  }
}

/** Bypasses CliAxAIService's envelope wrapper so the raw ax contract is
 * visible: ax itself accepts only the {[outputField]: value} envelope. */
class RawService extends CliAxAIService {
  constructor(
    private readonly content: string,
    private readonly structuredOutputs = true
  ) {
    super({ id: "raw", label: "Raw", outputField: REPAIR_OUTPUT_FIELD, transport: async () => ({ text: content }) });
  }

  override getFeatures() {
    return { ...super.getFeatures(), structuredOutputs: this.structuredOutputs };
  }

  override async chat(): Promise<{ results: { index: number; content: string }[] }> {
    return { results: [{ index: 0, content: this.content }] };
  }
}

const inputs = { agentOutput: "raw output", diagnostics: "value: invalid" };

describe("ax predictor contract (23.0.11)", () => {
  it("accepts only the output-field envelope", async () => {
    const good = service(async () => ({ text: envelope({ value: "ok" }) }));
    await expect(program().forward(good, inputs, { maxRetries: 0 })).resolves.toEqual({
      [REPAIR_OUTPUT_FIELD]: { value: "ok" }
    });

    // CliAxAIService wraps bare transport objects, so exercise the raw ax
    // service path to prove the envelope itself is mandatory.
    const bad = new RawService(JSON.stringify({ value: "ok" }));
    await expect(program().forward(bad, inputs, { maxRetries: 0 })).rejects.toThrow(/Structured Output/);
  });

  it("delivers addAssert fixing instructions in the retry prompt", async () => {
    const prompts: string[] = [];
    const transport: CliAxTransport = async (prompt) => {
      prompts.push(prompt);
      return {
        text: prompts.length === 1
          ? envelope({ value: "bad" })
          : envelope({ value: "good" })
      };
    };
    const instance = program();
    instance.addAssert((values) => {
      const result = (values as { [REPAIR_OUTPUT_FIELD]: { value: string } })[REPAIR_OUTPUT_FIELD];
      return result.value === "good" ? true : "Set value to good.";
    });
    await expect(instance.forward(service(transport), inputs, { maxRetries: 1 })).resolves.toEqual({
      [REPAIR_OUTPUT_FIELD]: { value: "good" }
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Set value to good.");
  });

  it("stops after one call when an assertion throws (zero retries)", async () => {
    const chat = vi.fn(async () => ({ text: envelope({ value: "bad" }) }));
    const instance = program();
    instance.addAssert((values) => {
      const result = (values as { [REPAIR_OUTPUT_FIELD]: { value: string } })[REPAIR_OUTPUT_FIELD];
      if (result.value !== "good") throw new Error("hard stop");
      return true;
    });
    await expect(instance.forward(service(chat), inputs, { maxRetries: 1 })).rejects.toBeInstanceOf(AxGenerateError);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("switches to the __finalResult fallback when structuredOutputs is false", async () => {
    const observing = new ObservingService(async () => ({ text: envelope({ value: "ok" }) }), false);
    await expect(program().forward(observing, inputs, { maxRetries: 0 })).resolves.toEqual({
      [REPAIR_OUTPUT_FIELD]: { value: "ok" }
    });
    // Measured behavior: ax requests a prompt-mode function call instead of a
    // native json_schema response. The envelope is still mandatory, and Dext's
    // service must declare `structuredOutputs: true` for the native path.
    expect(observing.requests[0]?.functions?.map((fn) => fn.name)).toContain("__finalResult");
    expect(observing.requests[0]?.responseFormat).toBeUndefined();
    const bare = new RawService(JSON.stringify({ value: "ok" }), false);
    await expect(program().forward(bare, inputs, { maxRetries: 0 })).rejects.toThrow(/Structured Output/);
  });

  it("spends at most 1 + maxRetries calls", async () => {
    const chat = vi.fn(async () => ({ text: "not json at all" }));
    await expect(program().forward(service(chat), inputs, { maxRetries: 1 })).rejects.toBeInstanceOf(AxGenerateError);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("keeps the repair output field constant aligned across adapter and service", () => {
    expect(REPAIR_OUTPUT_FIELD).toBe("structuredOutput");
    const signature = repairSignature(SCHEMA);
    expect(signature.getOutputFields().map((field) => field.name)).toEqual([REPAIR_OUTPUT_FIELD]);
  });
});

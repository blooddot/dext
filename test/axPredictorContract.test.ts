import { describe, expect, it, vi } from "vitest";
import { AxGenerateError, ax, type AxAIServiceOptions, type AxChatRequest } from "@ax-llm/ax";
import { REPAIR_OUTPUT_FIELD, repairSignature } from "../src/core/axAdapter.js";
import { CliAxAIService, type CliAxTransport } from "../src/core/cliAxAIService.js";

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
  return ax(repairSignature());
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
  it("hands the output envelope through, because the contract is no longer ax's field", async () => {
    const good = service(async () => ({ text: envelope({ value: "ok" }) }));
    await expect(program().forward(good, inputs, { maxRetries: 0 })).resolves.toEqual({
      [REPAIR_OUTPUT_FIELD]: { value: "ok" }
    });

    // The envelope itself is built by CliAxAIService from the first recovered object. ax does not
    // validate the value against a contract any more: that check lives in ResultRepair, which is
    // what lets a `list[str]` contract be repaired at all. A content object without the field is
    // therefore accepted here and rejected there.
    const bare = new RawService(JSON.stringify({ value: "ok" }));
    await expect(program().forward(bare, inputs, { maxRetries: 0 })).resolves.toEqual({});
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
    // native json_schema response, and Dext's service must declare
    // `structuredOutputs: true` for the native path.
    expect(observing.requests[0]?.functions?.map((fn) => fn.name)).toContain("__finalResult");
    expect(observing.requests[0]?.responseFormat).toBeUndefined();
  });

  it("spends at most 1 + maxRetries calls while the answer is never accepted", async () => {
    const chat = vi.fn(async () => ({ text: envelope({ value: "wrong" }) }));
    const instance = program();
    // ResultRepair answers an unusable value with the contract's diagnostics, which is the same
    // path a malformed answer takes now that ax no longer validates the field.
    instance.addAssert(() => "value: invalid");
    await expect(instance.forward(service(chat), inputs, { maxRetries: 1 })).rejects.toBeInstanceOf(AxGenerateError);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("hands the answer through untouched so a string-array contract can be repaired", async () => {
    // The field is opaque on purpose: a contract attached here makes ax JSON.parse the elements of
    // every string-array leaf (`list[str]`, `UiResult.selected`), which rejects an answer that
    // already satisfies the contract. ResultRepair validates with the contract instead.
    const text = JSON.stringify({ kind: "agent", text: "done", tags: ["Plain sentence.", "Second one."] });
    await expect(program().forward(service(async () => ({ text })), inputs, { maxRetries: 0 })).resolves.toEqual({
      [REPAIR_OUTPUT_FIELD]: { kind: "agent", text: "done", tags: ["Plain sentence.", "Second one."] }
    });
  });

  it("keeps the repair output field constant aligned across adapter and service", () => {
    expect(REPAIR_OUTPUT_FIELD).toBe("structuredOutput");
    const signature = repairSignature();
    expect(signature.getOutputFields().map((field) => field.name)).toEqual([REPAIR_OUTPUT_FIELD]);
  });
});

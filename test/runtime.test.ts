import { describe, expect, it } from "vitest";
import { AxAdapter } from "../src/core/axAdapter.js";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { compileChat } from "../src/core/chatCompiler.js";
import { ContextResolver, type ContextHost } from "../src/core/contextResolver.js";
import { parseInvocation } from "../src/core/dsl.js";
import { MethodRegistry } from "../src/core/registry.js";
import { DextRuntime } from "../src/core/runtime.js";
import type { CodeRef } from "../src/core/types.js";

const host: ContextHost = {
  selection: async () => ({ uri: "file:///x.ts", content: "const x = 1;", version: 1 }),
  activeFile: async () => ({ uri: "file:///x.ts", content: "const x = 1;", version: 1 }),
  file: async () => undefined,
  symbol: async () => undefined
};

function runtime(): DextRuntime {
  const registry = new MethodRegistry();
  registry.registerMany(BUILTIN_METHODS, "builtin");
  return new DextRuntime(registry, new ContextResolver(host));
}

describe("Dext runtime", () => {
  it("compiles chat into the same invocation pipeline", async () => {
    const response = await runtime().execute(compileChat("hello"));
    expect(response.invocation.source).toBe("chat");
    expect(response.result).toEqual({ kind: "text", text: "hello" });
  });

  it("resolves code references and produces structured review output", async () => {
    const response = await runtime().execute(
      parseInvocation('core.code.review(target: @selection, focus: "security")')
    );
    expect(response.result).toMatchObject({ kind: "review", findings: [{ severity: "info" }] });
  });

  it("builds Ax and JSON Schema contracts without a model", () => {
    const method = BUILTIN_METHODS[0];
    expect(method).toBeDefined();
    const contract = new AxAdapter().compile(method!);
    expect(contract.methodId).toBe("core.chat.respond");
    expect(contract.inputJsonSchema).toMatchObject({ type: "object" });
    expect(contract.signature.getInputFields()).toHaveLength(1);
  });

  it("rejects duplicate arguments at the runtime boundary", async () => {
    await expect(
      runtime().execute({
        kind: "invocation",
        method: "core.chat.respond",
        source: "chat",
        arguments: [
          { name: "message", value: "first" },
          { name: "message", value: "second" }
        ]
      })
    ).rejects.toThrow("provided more than once");
  });

  it("validates complete context reference shapes", () => {
    const method = BUILTIN_METHODS.find((candidate) => candidate.id === "core.code.review");
    expect(method).toBeDefined();
    const contract = new AxAdapter().compile(method!);
    expect(() =>
      contract.inputSchema.parse({ target: { kind: "file" }, focus: "correctness" })
    ).toThrow();
    expect(contract.inputJsonSchema).toMatchObject({
      type: "object",
      properties: {
        focus: { enum: ["correctness", "maintainability", "security"] }
      }
    });
  });

  it("merges supplemental attachment context once and does not leak it across executions", async () => {
    const registry = new MethodRegistry();
    registry.registerMany(BUILTIN_METHODS, "builtin");
    const inspecting = new DextRuntime(registry, new ContextResolver(host), undefined, {
      chatRespond: ({ context }) => ({
        kind: "text",
        text: context.map((reference) => reference.content).join(",")
      })
    });
    const attachment: CodeRef = {
      kind: "codeRef",
      uri: "file:///attachment.ts",
      documentVersion: 1,
      contentHash: "attachment-hash",
      content: "attached"
    };

    const withAttachment = await inspecting.execute(
      compileChat("ignored"),
      [attachment, attachment]
    );
    const withoutAttachment = await inspecting.execute(compileChat("ignored"));

    expect(withAttachment.result).toEqual({ kind: "text", text: "attached" });
    expect(withoutAttachment.result).toEqual({ kind: "text", text: "" });
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { DextLanguageService } from "../src/core/languageService.js";
import { MethodRegistry } from "../src/core/registry.js";

describe("DextLanguageService workflow features", () => {
  let service: DextLanguageService;
  beforeEach(() => {
    const registry = new MethodRegistry();
    registry.registerMany(BUILTIN_METHODS, "builtin");
    service = new DextLanguageService(registry);
  });

  it("completes APIs, keyword arguments, references, and result fields", () => {
    expect(service.documentCompletions("co").map((item) => item.label)).toEqual(["code"]);
    const codeNamespace = service.documentCompletions("code.");
    expect(codeNamespace.map((item) => item.label)).toEqual(["apply", "edit", "explain", "review"]);
    expect(codeNamespace.every((item) => item.replaceStart === 5 && item.replaceEnd === 5)).toBe(true);
    const codeFragment = service.documentCompletions("code.ex");
    expect(codeFragment.map((item) => item.label)).toEqual(["explain"]);
    expect(codeFragment[0]).toMatchObject({ replaceStart: 5, replaceEnd: 7 });
    expect(service.documentCompletions("code.review(ta").map((item) => item.label)).toEqual(["target"]);
    const references = service.documentCompletions("code.review(target=ref.");
    expect(references.map((item) => item.label)).toEqual(["selection", "active_file", "file", "symbol"]);
    expect(references.every((item) => item.replaceStart === 23 && item.replaceEnd === 23)).toBe(true);
    expect(service.documentCompletions("code.review(target=r").map((item) => item.label))
      .toEqual(["ref.selection", "ref.active_file", "ref.file", "ref.symbol"]);
    const source = 'analysis = chat(message="x")\nedit = code.edit(target=[ref.selection], instruction=analysis.';
    expect(service.documentCompletions(source).map((item) => item.label)).toEqual(["text"]);
    const status = 'review = code.review(target=ref.selection)\nif review.status == "';
    expect(service.documentCompletions(status).map((item) => item.label))
      .toEqual(["pass", "warning", "fail"]);
    const terminalFields = 'terminal_result = terminal.run(command="node --version")\nterminal_result.';
    expect(service.documentCompletions(terminalFields).map((item) => item.label))
      .toEqual(["status", "command", "cwd", "exit_code", "stdout", "stderr", "duration_ms"]);
    const terminalStatus = 'terminal_result = terminal.run(command="node --version")\nif terminal_result.status == "';
    expect(service.documentCompletions(terminalStatus).map((item) => item.label))
      .toEqual(["succeeded", "failed", "timed_out"]);
    const printed = 'printed = print(text="x")\nprinted.';
    expect(service.documentCompletions(printed).map((item) => item.label)).toEqual(["text", "label"]);
  });

  it("reports exact semantic ranges", () => {
    const source = 'code.review(instruction=2)';
    expect(service.documentDiagnostics(source)).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining("expects string"), from: source.indexOf("2"), to: source.indexOf("2") + 1 }),
      expect.objectContaining({ message: "Missing required argument 'target'." })
    ]));

    const misspelled = "code.review(targe=ref.selection)";
    expect(service.documentDiagnostics(misspelled)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: "Unknown argument 'targe' for 'code.review'.",
        from: misspelled.indexOf("targe"),
        to: misspelled.indexOf("targe") + "targe".length
      })
    ]));
  });

  it("provides API hover and signature help", () => {
    const source = "code.review(target=";
    expect(service.documentHover(source, 2)).toMatchObject({ label: expect.stringContaining("code.review") });
    expect(service.documentSignature(source)).toMatchObject({ activeParameter: 0, label: expect.stringContaining("target=") });
    expect(service.documentSignature("terminal.run(command=\"pwd\", cwd=")).toMatchObject({
      activeParameter: 1,
      label: expect.stringContaining("timeout_ms?=number")
    });
    expect(service.documentSignature("print(text=")).toMatchObject({
      activeParameter: 0,
      label: expect.stringContaining("label?=string")
    });
  });
});

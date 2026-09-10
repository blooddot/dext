import { describe, expect, it } from "vitest";
import { apiDefinitionTarget, apiFunctionDefinition, builtinApiDefinitionTarget, builtinTypeDefinitionTarget, builtinTypeReferenceTarget } from "../src/core/apiNavigation.js";

describe(".dx definition navigation", () => {
  it.each([
    ["from playground import verify", "verify()"],
    ["from playground import verify as check", "check()"],
    ["import playground.verify as check", "check()"],
    ["import playground.verify", "verify()"],
    ["import playground", "playground.verify()"],
    ["import playground as pg", "pg.verify()"]
  ])("resolves calls using %s", (header, call) => {
    const source = `${header}\n\ndef main() -> PrintResult:\n    return ${call}`;
    const cursor = source.lastIndexOf(call) + call.indexOf("(") - 2;
    const target = apiDefinitionTarget(source, cursor);
    expect(target).toMatchObject({ apiId: "playground.verify", name: "main" });
    expect(source.slice(target!.originFrom, target!.originTo)).toBe(call.slice(0, -2));
  });

  it.each(["verify", "check"])("resolves the import name %s", (name) => {
    const source = "from playground import verify as check";
    expect(apiDefinitionTarget(source, source.indexOf(name) + 1)).toMatchObject({ apiId: "playground.verify", name: "main" });
    expect(apiDefinitionTarget(source, source.indexOf("playground") + 1)).toBeUndefined();
  });

  it("resolves a forward helper declaration without requiring valid type annotations", () => {
    const source = 'def main() -> PrintResult:\n    return report()\n\ndef report():\n    return print(text="ok")';
    const reference = apiDefinitionTarget(source, source.indexOf("report()") + 1);
    expect(reference).toMatchObject({ name: "report" });
    expect(reference?.apiId).toBeUndefined();
    const definition = apiFunctionDefinition(source, "report")!;
    expect(source.slice(definition.nameFrom, definition.nameTo)).toBe("report");
    expect(definition.from).toBe(source.indexOf("def report"));
  });

  it("locates main after a helper and decorator, including CRLF offsets", () => {
    const source = 'def helper() -> PrintResult:\r\n    return print(text="ok")\r\n\r\n@api(agent="codex")\r\ndef main() -> PrintResult:\r\n    return helper()';
    const definition = apiFunctionDefinition(source, "main")!;
    expect(source.slice(definition.nameFrom, definition.nameTo)).toBe("main");
    expect(definition.from).toBe(source.indexOf("@api"));
  });

  it("ignores strings, comments, argument names, result fields and unimported calls", () => {
    const source = `from playground import verify
# verify()
text = "verify()"
verify = print(text="value")
print(verify="argument")
result.verify
other()
`;
    for (const text of ["# verify", '"verify', "verify =", 'verify="', "result.verify", "other()"]) {
      const start = source.indexOf(text);
      const offset = text.indexOf("verify");
      expect(apiDefinitionTarget(source, start + (offset < 0 ? 1 : offset + 1)), text).toBeUndefined();
    }
    const fakeImport = 'text = """\nfrom playground import verify\n"""\nverify()';
    expect(apiDefinitionTarget(fakeImport, fakeImport.lastIndexOf("verify") + 1)).toBeUndefined();
  });

  it("resolves built-in result types only in annotations", () => {
    const source = `# PrintResult
def main(context: PrintResult) -> AgentResult:
    return print(text="PrintResult")`;
    for (const name of ["PrintResult", "AgentResult"]) {
      const offset = source.indexOf(name, source.indexOf("def main")) + 2;
      expect(builtinTypeDefinitionTarget(source, offset)).toMatchObject({ name });
    }
    expect(builtinTypeDefinitionTarget(source, source.indexOf("PrintResult") + 2)).toBeUndefined();
    expect(builtinTypeDefinitionTarget(source, source.lastIndexOf("PrintResult") + 2)).toBeUndefined();
  });

  it("resolves namespaced structural types in annotations", () => {
    const source = "def main(fields: list[ui.Field]) -> UiFormResult:\n    ...";
    const offset = source.indexOf("ui.Field") + 4;
    expect(builtinTypeDefinitionTarget(source, offset)).toMatchObject({ name: "ui.Field" });
  });

  it("resolves nested type references in the generated type document", () => {
    const source = "interface AgentResult {\n  patch?: PatchResult\n}";
    expect(builtinTypeReferenceTarget(source, source.indexOf("PatchResult") + 2)).toMatchObject({ name: "PatchResult" });
  });

  it("resolves qualified types and nested type class declarations", () => {
    const qualified = "options: list[string | ui.Option]";
    expect(builtinTypeReferenceTarget(qualified, qualified.indexOf("Option") + 2)).toMatchObject({ name: "ui.Option" });
    const declaration = "# Type: ui.Field\nclass Field:\n    ...";
    expect(builtinTypeReferenceTarget(declaration, declaration.indexOf("Field:") + 2)).toMatchObject({ name: "ui.Field" });
  });

  it("resolves built-in APIs only at their call sites", () => {
    const source = `# node.url.parse(url="ignore")
parsed = node.url.parse(url=input)
label = "node.path.basename"`;
    const call = source.indexOf("node.url.parse", source.indexOf("parsed"));
    expect(builtinApiDefinitionTarget(source, call + 1)).toMatchObject({ id: "node" });
    expect(builtinApiDefinitionTarget(source, call + 6)).toMatchObject({ id: "node.url" });
    expect(builtinApiDefinitionTarget(source, call + 11)).toMatchObject({ id: "node.url.parse" });
    expect(builtinApiDefinitionTarget(source, source.indexOf("node.url.parse") + 6)).toBeUndefined();
    expect(builtinApiDefinitionTarget(source, source.lastIndexOf("node.path.basename") + 6)).toBeUndefined();
  });
});

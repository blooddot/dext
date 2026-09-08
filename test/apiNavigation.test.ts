import { describe, expect, it } from "vitest";
import { apiDefinitionTarget, apiFunctionDefinition } from "../src/core/apiNavigation.js";

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
});

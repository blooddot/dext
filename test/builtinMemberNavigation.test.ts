import { describe, expect, it } from "vitest";
import { builtinMemberDefinitionTarget } from "../src/core/builtinMemberNavigation.js";

const target = (source: string, field = "pathname") => builtinMemberDefinitionTarget(source, source.lastIndexOf(field) + 2);

describe("built-in result member navigation", () => {
  it("resolves the URL field inside another API's arguments", () => {
    const source = 'def main(input: str):\r\n    parsed_url = node.url.parse(url=input)\r\n    task_id = node.path.basename(path=parsed_url.pathname)';
    const result = target(source)!;
    expect(result).toMatchObject({ name: "NodeUrlParseResult", field: "pathname" });
    expect(source.slice(result.originFrom, result.originTo)).toBe("pathname");
  });

  it.each([
    'def main(parsed: NodeUrlParseResult):\n    return parsed.pathname',
    'parsed: NodeUrlParseResult = input\nparsed.pathname',
    'parsed = node.url.parse(url=input)\nalias = parsed\nalias.pathname',
    'node.url.parse(url=input).pathname'
  ])("resolves an annotated, aliased or immediate result: %s", (source) => {
    expect(target(source)).toMatchObject({ name: "NodeUrlParseResult", field: "pathname" });
  });

  it("supports other built-in results and nested named types", () => {
    expect(target('result = print(text="ok")\nresult.text', "text")).toMatchObject({ name: "PrintResult", field: "text" });
    expect(target('result = agent(input="edit")\nresult.patch.title', "title")).toMatchObject({ name: "PatchResult", field: "title" });
  });

  it.each([
    'parsed = node.url.parse(url=input)\n# parsed.pathname',
    'parsed = node.url.parse(url=input)\n"parsed.pathname"',
    'def first():\n    parsed = node.url.parse(url=input)\ndef second():\n    parsed.pathname',
    'parsed.pathname\nparsed = node.url.parse(url=input)',
    'parsed = node.url.parse(url=input)\nparsed = {}\nparsed.pathname',
    'parsed = node.url.parse(url=input)\ndef main(parsed):\n    parsed.pathname',
    'parsed = node.path.basename(path=input)\nparsed.pathname'
  ])("does not invent a field target for unrelated or unknown values: %s", (source) => {
    expect(target(source)).toBeUndefined();
  });
});

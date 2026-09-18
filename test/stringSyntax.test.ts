import { describe, expect, it } from "vitest";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { MethodRegistry } from "../src/core/registry.js";
import { compileWorkflow } from "../src/core/workflow.js";
import type { WorkflowExpression, WorkflowProgram } from "../src/core/types.js";

const registry = new MethodRegistry();
registry.registerMany(BUILTIN_METHODS, "builtin");

function compile(source: string) {
  return compileWorkflow(source, registry);
}

function messages(source: string): string {
  return compile(source).diagnostics.map((item) => item.message).join("\n");
}

function program(source: string): WorkflowProgram {
  const result = compile(source);
  if (!result.program) throw new Error(messages(source));
  return result.program;
}

/** The value `print(text=...)` receives, which shows how an expression compiled
 * and whether the compiler folded it to a constant. `setup` provides the
 * variables the expression reads. */
function value(source: string, setup = ""): WorkflowExpression {
  const prefix = setup ? `${setup}\n` : "";
  const last = program(`${prefix}print(text=${source})`).statements.at(-1);
  if (last?.kind !== "step") throw new Error(`Expected a step, got ${last?.kind ?? "nothing"}.`);
  const argument = last.call.arguments.find((item) => item.name === "text");
  if (!argument) throw new Error("print() lost its text argument.");
  return argument.value;
}

const ANSWER = 'answer = ask(input="x")';

describe("string concatenation", () => {
  it("folds literal concatenation at compile time", () => {
    expect(value('"fix: " + "done"')).toMatchObject({ kind: "literal", value: "fix: done" });
    expect(value('"a" "b" "c"')).toMatchObject({ kind: "literal", value: "abc" });
    expect(value('"a" * 3')).toMatchObject({ kind: "literal", value: "aaa" });
    expect(value('("a"\n  "b")')).toMatchObject({ kind: "literal", value: "ab" });
  });

  it("concatenates runtime values with a member expression", () => {
    const source = 'answer = ask(input="x")\ntext = "Review: " + answer.text';
    expect(compile(source).diagnostics).toEqual([]);
    expect(value('"Review: " + answer.text', ANSWER)).toMatchObject({
      kind: "binary",
      operator: "+",
      left: { kind: "literal", value: "Review: " },
      right: { kind: "member", property: "text" }
    });
  });

  it("accepts concatenation as an argument", () => {
    expect(compile('answer = ask(input="a")\nagent(input="Review " + answer.text)').diagnostics).toEqual([]);
  });

  it("rejects mixing a string with a number and suggests an f-string", () => {
    expect(messages('print(text="count: " + 1)')).toContain("Use an f-string");
    expect(messages('print(text="count: " + len("ab"))')).toContain("Use an f-string");
    expect(compile('print(text=f"count: {len(\'ab\')}")').diagnostics).toEqual([]);
  });

  it("supports numeric arithmetic", () => {
    expect(value("2 + 3 * 4")).toMatchObject({ kind: "literal", value: 14 });
    expect(value("2 ** 3")).toMatchObject({ kind: "literal", value: 8 });
    expect(value("7 // 2")).toMatchObject({ kind: "literal", value: 3 });
    expect(value("1_000 + 0x10")).toMatchObject({ kind: "literal", value: 1016 });
    expect(value("-1 + 2")).toMatchObject({ kind: "literal", value: 1 });
    expect(messages("print(text=1 / 0)")).toContain("division by zero");
    expect(messages('print(text="a" - "b")')).toContain("needs numbers");
  });

  it("reports a concatenation of two runtime strings as a step", () => {
    const source = 'first = ask(input="x")\nsecond = ask(input="y")\ntext = first.text + second.text';
    const last = program(source).statements.at(-1);
    expect(last).toMatchObject({ kind: "assign", assignment: "text", expression: { kind: "binary" } });
  });
});

describe("f-strings", () => {
  it("compiles a replacement and keeps its pieces", () => {
    const source = 'answer = ask(input="x")\npreview = f"Answer: {answer.text}!"';
    expect(compile(source).diagnostics).toEqual([]);
    expect(value('f"Answer: {answer.text}!"', ANSWER)).toMatchObject({
      kind: "format",
      parts: [
        { kind: "text", text: "Answer: " },
        { kind: "expression", expression: { kind: "member", property: "text" } },
        { kind: "text", text: "!" }
      ]
    });
  });

  it("folds an f-string whose fields are known", () => {
    expect(value('f"{1 + 2} items"')).toMatchObject({ kind: "literal", value: "3 items" });
    expect(value('f"{{literal}} {1.5:.1f}"')).toMatchObject({ kind: "literal", value: "{literal} 1.5" });
    expect(value('f"hi {\'dext\'.upper()}"')).toMatchObject({ kind: "literal", value: "hi DEXT" });
    expect(value('f"{1234:,}"')).toMatchObject({ kind: "literal", value: "1,234" });
    expect(value('f"{42:05d}"')).toMatchObject({ kind: "literal", value: "00042" });
    expect(value('f"{255:#x}"')).toMatchObject({ kind: "literal", value: "0xff" });
    expect(value('f"{0.256:.1%}"')).toMatchObject({ kind: "literal", value: "25.6%" });
    expect(value('f"{\'a\'!r}"')).toMatchObject({ kind: "literal", value: "'a'" });
    expect(value('f"{\'text\':>6}"')).toMatchObject({ kind: "literal", value: "  text" });
    expect(value('f"{\'abcdef\':.3}"')).toMatchObject({ kind: "literal", value: "abc" });
    expect(value('f"tab\\t{1}"')).toMatchObject({ kind: "literal", value: "tab\t1" });
    expect(value('rf"raw\\d{1}"')).toMatchObject({ kind: "literal", value: "raw\\d1" });
  });

  it("keeps conversions, specs, and self-documenting fields on runtime values", () => {
    const source = 'answer = ask(input="x")\nvalue = 3\n';
    expect(compile(`${source}text = f"{answer.text!r:>8}"`).diagnostics).toEqual([]);
    expect(value('f"{answer.text!r:>8}"', ANSWER)).toMatchObject({
      parts: [{ kind: "expression", conversion: "r", spec: ">8" }]
    });
    expect(value('f"{answer.text=}"', ANSWER)).toMatchObject({
      parts: [{ kind: "text", text: "answer.text=" }, { kind: "expression", conversion: "r" }]
    });
    expect(value('f"{answer.text=:>8}"', ANSWER)).toMatchObject({
      parts: [{ kind: "text", text: "answer.text=" }, { kind: "expression", spec: ">8" }]
    });
  });

  it("accepts nested and computed format specs", () => {
    const source = 'width = 6\nanswer = ask(input="x")\ntext = f"{answer.text:{width}}"';
    expect(compile(source).diagnostics).toEqual([]);
    expect(value('f"{answer.text:{width}}"', `${ANSWER}\nwidth = 6`)).toMatchObject({
      parts: [{ kind: "expression", specParts: [{ kind: "expression" }] }]
    });
  });

  it("reports a format spec that does not fit the value", () => {
    expect(messages('print(text=f"{1.5:d}")')).toContain("Unknown format code 'd'");
    expect(messages('print(text=f"{1:zz}")')).toContain("Unknown format code");
    expect(messages('print(text=f"{1!q}")')).toContain("Invalid Python syntax");
  });

  it("accepts an f-string in an API argument and a condition", () => {
    expect(compile('answer = ask(input="x")\nprint(text=f"{answer.text}")').diagnostics).toEqual([]);
    expect(compile('answer = ask(input="x")\nif f"{answer.text}" == "done":\n    print(text="ok")').diagnostics).toEqual([]);
  });

  it("treats an unknown variable in a field as an error", () => {
    expect(messages('print(text=f"{missing}")')).toContain("Unknown variable 'missing'");
  });

  it("still rejects bytes literals", () => {
    expect(messages('print(text=b"bytes")')).toContain("Bytes literals are not supported");
  });

  it("keeps legacy ref f-strings migrating to @ tokens", () => {
    expect(compile('ask(input=f"look at {ref.file(\'src/a.ts\')}")').diagnostics).toEqual([]);
    expect(messages('print(text=f"bad {ref.selection}")')).toContain("Unknown variable 'ref'");
  });
});

describe("string methods and helpers", () => {
  it("folds known string methods", () => {
    expect(value('"Hello World".lower()')).toMatchObject({ kind: "literal", value: "hello world" });
    expect(value('"a,b".split(",")')).toMatchObject({
      kind: "list",
      values: [{ kind: "literal", value: "a" }, { kind: "literal", value: "b" }]
    });
    expect(value('",".join(["a", "b"])')).toMatchObject({ kind: "literal", value: "a,b" });
    expect(value('"  pad  ".strip()')).toMatchObject({ kind: "literal", value: "pad" });
    expect(value('"abc".replace("a", "z")')).toMatchObject({ kind: "literal", value: "zbc" });
    expect(value('"a.txt".endswith(".txt")')).toMatchObject({ kind: "literal", value: true });
    expect(value('"a.txt".startswith(["a.", "b."])')).toMatchObject({ kind: "literal", value: true });
    expect(value('len("héllo")')).toMatchObject({ kind: "literal", value: 5 });
    expect(value('"{} and {}".format("a", "b")')).toMatchObject({ kind: "literal", value: "a and b" });
    expect(value('"%s: %d" % ["total", 3]')).toMatchObject({ kind: "literal", value: "total: 3" });
    expect(value('"%(name)s is %(state)s" % {"name": "build", "state": "ok"}')).toMatchObject({
      kind: "literal",
      value: "build is ok"
    });
    expect(value('"a\\nb".splitlines()')).toMatchObject({
      kind: "list",
      values: [{ kind: "literal", value: "a" }, { kind: "literal", value: "b" }]
    });
  });

  it("compiles a method on a runtime value", () => {
    const source = 'answer = ask(input="x")\nlines = answer.text.split("\\n")';
    expect(compile(source).diagnostics).toEqual([]);
    const last = program(source).statements.at(-1);
    expect(last).toMatchObject({ kind: "assign", assignment: "lines", expression: { kind: "method", method: "split" } });
    expect(value('answer.text.split("\\n")', ANSWER)).toMatchObject({
      kind: "method",
      method: "split",
      receiver: { kind: "member", property: "text" }
    });
  });

  it("slices and indexes strings and lists", () => {
    expect(value('"abcdef"[1:3]')).toMatchObject({ kind: "literal", value: "bc" });
    expect(value('"abcdef"[::-1]')).toMatchObject({ kind: "literal", value: "fedcba" });
    expect(value('"abcdef"[-1]')).toMatchObject({ kind: "literal", value: "f" });
    expect(value('"abcdef"[2:]')).toMatchObject({ kind: "literal", value: "cdef" });
    expect(value('["a", "b", "c"][1:]')).toMatchObject({
      kind: "list",
      values: [{ kind: "literal", value: "b" }, { kind: "literal", value: "c" }]
    });
    const source = 'answer = ask(input="x")\nfirst = answer.text[0:4]';
    expect(compile(source).diagnostics).toEqual([]);
    expect(value("answer.text[0:4]", ANSWER)).toMatchObject({ kind: "slice", object: { kind: "member", property: "text" } });
    expect(messages('print(text=len("abc")[0])')).toContain("Cannot index");
    expect(messages("print(text=(1 + 1)[0])")).toContain("Cannot index");
  });

  it("exposes pure helpers with their types", () => {
    expect(value("range(3)")).toMatchObject({
      kind: "list",
      values: [{ kind: "literal", value: 0 }, { kind: "literal", value: 1 }, { kind: "literal", value: 2 }]
    });
    expect(compile("for index in range(3):\n    print(text=index)").diagnostics).toEqual([]);
    expect(compile('names = sorted(["b", "a"])\nfor name in names:\n    ask(input=name)').diagnostics).toEqual([]);
    expect(value("str(12)")).toMatchObject({ kind: "literal", value: "12" });
    expect(value('int("41") + 1')).toMatchObject({ kind: "literal", value: 42 });
    expect(value('bool("")')).toMatchObject({ kind: "literal", value: false });
    expect(value("max([3, 1])")).toMatchObject({ kind: "literal", value: 3 });
    expect(value("sum([1, 2, 3])")).toMatchObject({ kind: "literal", value: 6 });
    expect(value('list("ab")')).toMatchObject({
      kind: "list",
      values: [{ kind: "literal", value: "a" }, { kind: "literal", value: "b" }]
    });
    expect(messages("print(text=range(200000))")).toContain("limited to");
  });

  it("checks helper arity and argument types", () => {
    expect(messages('print(text=len("a", "b"))')).toContain("len() takes 1 argument but 2 were given");
    expect(messages('print(text=",".join("abc"))')).toContain("expects a list but string was given");
    expect(messages('text = "a".upper(1)')).toContain("str.upper() takes 0 arguments but 1 were given");
    expect(messages('text = "a".nope()')).toContain("String has no method 'nope'");
    expect(messages('items = [1, 2]\ntext = items.join(",")')).toContain("separator.join(list)");
  });

  it("fans out over a pure expression instead of an API call", () => {
    const source = 'names = ["b", "a"]\nlabels = [name.upper() for name in sorted(names)]';
    expect(compile(source).diagnostics).toEqual([]);
    const last = program(source).statements.at(-1);
    expect(last).toMatchObject({
      kind: "assign",
      expression: { kind: "comprehension", body: { kind: "method", method: "upper" } }
    });
  });

  it("iterates the result of a string method", () => {
    expect(compile('answer = ask(input="x")\nfor line in answer.text.splitlines():\n    print(text=line)').diagnostics).toEqual([]);
    expect(messages('answer = ask(input="x")\nfor line in answer.text.upper():\n    print(text=line)')).toContain("for requires a list");
  });

  it("accepts keyword arguments where Python names them", () => {    expect(value('"a,b,c".split(sep=",", maxsplit=1)')).toMatchObject({
      kind: "list",
      values: [{ kind: "literal", value: "a" }, { kind: "literal", value: "b,c" }]
    });
    expect(value('sorted(["b", "a"], reverse=True)')).toMatchObject({
      kind: "list",
      values: [{ kind: "literal", value: "b" }, { kind: "literal", value: "a" }]
    });
    expect(messages('text = "a".split(maxsplit=1, sep=",")')).toContain("keeps the order you write");
  });
});

describe("comparisons and boolean conditions", () => {
  it("supports ordering, membership, and boolean operators", () => {
    expect(compile('answer = ask(input="x")\nif answer.text != "" and len(answer.text) > 3:\n    print(text="long")').diagnostics).toEqual([]);
    expect(compile('answer = ask(input="x")\nif "done" in answer.text or answer.text.startswith("ok"):\n    print(text="ok")').diagnostics).toEqual([]);
    expect(compile('answer = ask(input="x")\nif not answer.text.startswith("ok"):\n    print(text="retry")').diagnostics).toEqual([]);
    expect(compile('answer = ask(input="x")\nif bool(answer.text):\n    print(text="nonempty")').diagnostics).toEqual([]);
    expect(value('"b" > "a" and not False')).toMatchObject({ kind: "literal", value: true });
    expect(value('"ell" in "hello"')).toMatchObject({ kind: "literal", value: true });
    expect(value('"x" not in ["a", "b"]')).toMatchObject({ kind: "literal", value: true });
  });

  it("supports elif chains without dropping a branch", () => {
    const source = [
      'answer = ask(input="x")',
      'if answer.text == "a":',
      '    print(text="first")',
      'elif answer.text == "b":',
      '    print(text="second")',
      'else:',
      '    print(text="third")'
    ].join("\n");
    expect(compile(source).diagnostics).toEqual([]);
    const statement = program(source).statements.at(-1);
    expect(statement).toMatchObject({ kind: "if", condition: { kind: "comparison", operator: "==" } });
    const alternate = statement?.kind === "if" ? statement.alternate : [];
    expect(alternate[0]).toMatchObject({ kind: "if", condition: { kind: "comparison", operator: "==" } });
    const nested = alternate[0]?.kind === "if" ? alternate[0].alternate : [];
    expect(nested[0]).toMatchObject({ kind: "if", consequent: [{ kind: "step", call: { method: "print" } }] });
  });

  it("rejects conditions Dext cannot evaluate", () => {
    expect(messages('answer = ask(input="x")\nif answer.text:\n    print(text="x")')).toContain("must be boolean");
    expect(messages('answer = ask(input="x")\nif answer.text + 1:\n    print(text="x")')).toContain("Cannot add string and number");
    expect(messages('answer = ask(input="x")\nif answer.text < 1:\n    print(text="x")')).toContain("Cannot compare");
    expect(messages('answer = ask(input="x")\nif 1 < len(answer.text) < 3:\n    print(text="x")')).toContain("does not chain");
  });
});

describe("tuple literals", () => {
  it("compiles a tuple as a list, including the bare form", () => {
    expect(value("(1, 2)")).toMatchObject({
      kind: "list",
      values: [{ kind: "literal", value: 1 }, { kind: "literal", value: 2 }]
    });
    expect(value('("a", "b")')).toMatchObject({
      kind: "list",
      values: [{ kind: "literal", value: "a" }, { kind: "literal", value: "b" }]
    });
    expect(value("(1,)")).toMatchObject({ kind: "list", values: [{ kind: "literal", value: 1 }] });
    expect(value("()")).toMatchObject({ kind: "list", values: [] });
    expect(value("((1, 2), (3, 4))")).toMatchObject({ kind: "list", values: [{ kind: "list" }, { kind: "list" }] });
    expect(value("(1)")).toMatchObject({ kind: "literal", value: 1 });
    expect(value('("a")')).toMatchObject({ kind: "literal", value: "a" });
  });

  it("keeps the Python spellings working in arguments and expressions", () => {
    expect(compile('ask(input="x")\nprint(text=f"{len((1, 2))}")').diagnostics).toEqual([]);
    expect(value("len((1, 2))")).toMatchObject({ kind: "literal", value: 2 });
    expect(value('"a.txt".endswith((".md", ".txt"))')).toMatchObject({ kind: "literal", value: true });
    expect(value('"%s: %d" % ("total", 3)')).toMatchObject({ kind: "literal", value: "total: 3" });
    expect(value('"a" in ("a", "b")')).toMatchObject({ kind: "literal", value: true });
    expect(value('",".join(("a", "b"))')).toMatchObject({ kind: "literal", value: "a,b" });
    expect(compile('pairs = [(1, 2), (3, 4)]\nfor pair in pairs:\n    print(text=str(pair[0]))').diagnostics).toEqual([]);
    expect(messages('print(text=(x for x in [1]))')).toContain("Dext comprehensions use square brackets");
  });

  it("formats a list value by wrapping it in a tuple, as Python does", () => {
    expect(value('"%s" % (["a", "b"],)')).toMatchObject({ kind: "literal", value: "['a', 'b']" });
    expect(messages('print(text="%s" % ["a", "b"])')).toContain("not all arguments converted");
  });

  it("annotates a heterogeneous tuple as a list of unknown items", () => {
    const compiled = compile('pair = ("a", 1)\nagent(input=pair[0])');
    expect(compiled.diagnostics).toEqual([]);
    expect(compile('pair: list[str] = ("a", "b")').diagnostics).toEqual([]);
    // Mixed entries widen the item type to unknown, exactly like `["a", 1]`
    // does, so the annotation is what pins the type from there on.
    expect(compile('pair: list[str] = ("a", 1)').diagnostics).toEqual([]);
  });
});

describe("interaction with existing checks", () => {
  it("still rejects an unknown API inside an expression", () => {
    expect(messages('ask(input="Review " + ref.file("docs/a.md"))')).toContain("Unknown Dext API 'ref.file'");
  });

  it("keeps type declarations honest", () => {
    expect(compile('prompt: str = "a" + "b"').diagnostics).toEqual([]);
    expect(messages('prompt: int = "a" + "b"')).toContain("declared as number but assigned string");
  });

  it("reassigns a variable in ordinary sequential code", () => {
    expect(compile('text = "a"\ntext = "b"').diagnostics).toEqual([]);
    // A name written twice keeps a runtime slot, so later reads see the last
    // value instead of the constant that was folded first.
    expect(program('text = "a"\ntext = "b"\nprint(text=text)').statements.map((statement) => statement.kind))
      .toEqual(["assign", "assign", "step"]);
  });

  it("still rejects a reassignment that changes the type", () => {
    expect(messages('text = "a"\ntext = 1')).toContain("must keep type string");
    expect(messages('text = "a"\ntext = 1')).toContain("cannot be reassigned to number");
  });

  it("rejects the shapes that would otherwise drop a name or value", () => {
    // `a, b = value` and `a = b = 1` still have no meaning here: Dext binds one
    // name at a time, so the extra name has to be reported instead of discarded.
    expect(messages("a, b = 1")).toContain("unpacking");
    expect(messages("a, b = [1, 2]")).toContain("unpacking");
    expect(messages("a = b = 1")).toContain("chained assignment");
    expect(compile("pair = [1, 2]").diagnostics).toEqual([]);
  });

  it("explains why += is not available and what to write instead", () => {
    const message = messages('text = "a"\ntext += "b"');
    expect(message).toContain("does not support '+='");
    expect(message).toContain("total = total + item");
    expect(message).toContain("join");
  });

  it("validates UI form fields built from folded strings", () => {
    const source = 'fields = [{"id": "note" + "1", "type": "input", "label": "Note"}]\nui.form(title="Form", fields=fields)';
    expect(compile(source).diagnostics).toEqual([]);
    const invalid = 'fields = [{"id": "x", "type": "radio", "label": "X", "options": ["a"], "multiple": True}]\nui.form(title="Form", fields=fields)';
    expect(messages(invalid)).toContain("multiple");
  });
});

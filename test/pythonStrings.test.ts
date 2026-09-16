import { describe, expect, it } from "vitest";
import {
  formatPercent,
  formatTemplate,
  formatWithSpec,
  pythonArithmetic,
  pythonCompare,
  pythonIndex,
  pythonSlice,
  pythonText,
  pythonTruthy,
  pureFunction,
  stringMethod
} from "../src/core/pythonStrings.js";

describe("Python text and format specs", () => {
  it("renders values the way Python does", () => {
    expect(pythonText("a")).toBe("a");
    expect(pythonText(1.5)).toBe("1.5");
    expect(pythonText(2)).toBe("2");
    expect(pythonText(true)).toBe("True");
    expect(pythonText(["a", 1])).toBe("['a', 1]");
    expect(pythonText({ kind: "file", path: "src/a.ts" })).toBe("@src/a.ts");
  });

  it("applies the format mini-language", () => {
    expect(formatWithSpec(3.14159, ".2f")).toBe("3.14");
    expect(formatWithSpec(1234.5, ",.2f")).toBe("1,234.50");
    expect(formatWithSpec(1234, ",")).toBe("1,234");
    expect(formatWithSpec(1234, "_")).toBe("1_234");
    expect(formatWithSpec(42, "05d")).toBe("00042");
    expect(formatWithSpec(42, "+d")).toBe("+42");
    expect(formatWithSpec(-42, " d")).toBe("-42");
    expect(formatWithSpec(42, " d")).toBe(" 42");
    expect(formatWithSpec(255, "#x")).toBe("0xff");
    expect(formatWithSpec(255, "#X")).toBe("0XFF");
    expect(formatWithSpec(5, "b")).toBe("101");
    expect(formatWithSpec(65, "c")).toBe("A");
    expect(formatWithSpec(0.256, ".1%")).toBe("25.6%");
    expect(formatWithSpec(1234.5678, ".3e")).toBe("1.235e+03");
    expect(formatWithSpec(0.00001234, "g")).toBe("1.234e-05");
    expect(formatWithSpec(1.5, "g")).toBe("1.5");
    expect(formatWithSpec("text", ">6")).toBe("  text");
    expect(formatWithSpec("text", "<6")).toBe("text  ");
    expect(formatWithSpec("text", "^6")).toBe(" text ");
    expect(formatWithSpec("text", "*^7")).toBe("*text**");
    expect(formatWithSpec("abcdef", ".3")).toBe("abc");
    expect(formatWithSpec(7, ">5")).toBe("    7");
    expect(formatWithSpec(true, "d")).toBe("1");
    expect(pythonTruthy("")).toBe(false);
    expect(pythonTruthy("x")).toBe(true);
  });

  it("reports specs that do not fit the value", () => {
    expect(() => formatWithSpec("text", "d")).toThrow("Unknown format code 'd'");
    expect(() => formatWithSpec(1.5, "d")).toThrow("Unknown format code 'd'");
    expect(() => formatWithSpec("text", ".2f")).toThrow("Unknown format code 'f'");
    expect(() => formatWithSpec("text", "+")).toThrow("Sign not allowed");
    expect(() => formatWithSpec(1, "q")).toThrow("Unknown format code");
  });

  it("formats the legacy percent operator", () => {
    expect(formatPercent("%s=%d", ["a", 2])).toBe("a=2");
    expect(formatPercent("%05.1f%%", 2.5)).toBe("002.5%");
    expect(formatPercent("%(name)s ok", { name: "build" })).toBe("build ok");
    expect(() => formatPercent("%s %s", ["only"])).toThrow("not enough arguments");
    expect(() => formatPercent("%s", ["a", "b"])).toThrow("not all arguments converted");
  });

  it("formats .format templates", () => {
    expect(formatTemplate("{} and {} and {name}", ["a", "b"], { name: "c" })).toBe("a and b and c");
    expect(formatTemplate("{0} and {1} and {name}", ["a", "b"], { name: "c" })).toBe("a and b and c");
    expect(formatTemplate("{{literal}}", [])).toBe("{literal}");
    expect(formatTemplate("{0[name]}", [{ name: "a" }])).toBe("a");
    expect(formatTemplate("{0[1]}", [["a", "b"]])).toBe("b");
    expect(() => formatTemplate("{0.upper}", ["a"])).toThrow("has no attribute");
    expect(() => formatTemplate("{} and {0}", ["a"])).toThrow("cannot switch from automatic field numbering");
    expect(() => formatTemplate("{missing}", [])).toThrow("KeyError");
    expect(() => formatTemplate("single }", [])).toThrow("Single '}'");
  });
});

describe("Python string methods", () => {
  const calls = (receiver: string, method: string, ...args: unknown[]): unknown =>
    stringMethod(receiver, method, args);

  it("covers the common inspection and reshaping methods", () => {
    expect(calls("a b", "split")).toEqual(["a", "b"]);
    expect(calls("a,b", "split", ",", 1)).toEqual(["a", "b"]);
    expect(calls("a,b,c", "rsplit", ",", 1)).toEqual(["a,b", "c"]);
    expect(calls(" a ", "strip")).toBe("a");
    expect(calls("xxaxx", "strip", "x")).toBe("a");
    expect(calls("AbC", "swapcase")).toBe("aBc");
    expect(calls("hello world", "title")).toBe("Hello World");
    expect(calls("ab", "ljust", 4, ".")).toBe("ab..");
    expect(calls("-7", "zfill", 4)).toBe("-007");
    expect(calls("abc", "find", "c")).toBe(2);
    expect(calls("abc", "find", "z")).toBe(-1);
    expect(() => calls("abc", "index", "z")).toThrow("substring not found");
    expect(calls("abcabc", "count", "a")).toBe(2);
    expect(calls("a-b", "partition", "-")).toEqual(["a", "-", "b"]);
    expect(calls("a", "partition", "-")).toEqual(["a", "", ""]);
    expect(calls("prefix-x", "removeprefix", "prefix-")).toBe("x");
    expect(calls("x.txt", "removesuffix", ".txt")).toBe("x");
    expect(calls("a\nb\n", "splitlines")).toEqual(["a", "b"]);
    expect(calls("a\nb\n", "splitlines", true)).toEqual(["a\n", "b\n"]);
    expect(calls("a\tb", "expandtabs", 4)).toBe("a   b");
    expect(calls("abc", "isalpha")).toBe(true);
    expect(calls("ab1", "isalnum")).toBe(true);
    expect(calls("12", "isdigit")).toBe(true);
    expect(calls("Ab", "istitle")).toBe(true);
  });

  it("matches Python's split and replace corners", () => {
    expect(calls("  a  b  ", "split")).toEqual(["a", "b"]);
    expect(calls("a b c", "split", undefined, 1)).toEqual(["a", "b c"]);
    expect(calls("aaa", "replace", "a", "b", 2)).toBe("bba");
    expect(calls("ab", "replace", "", "-")).toBe("-a-b-");
    expect(() => calls("abc", "split", "")).toThrow("empty separator");
  });
});

describe("Python value helpers", () => {
  it("computes arithmetic including strings", () => {
    expect(pythonArithmetic("+", "a", "b")).toBe("ab");
    expect(pythonArithmetic("*", "ab", 2)).toBe("abab");
    expect(pythonArithmetic("*", 2, "ab")).toBe("abab");
    expect(pythonArithmetic("+", 2, 3)).toBe(5);
    expect(pythonArithmetic("//", -3, 2)).toBe(-2);
    expect(pythonArithmetic("%", -3, 2)).toBe(1);
    expect(pythonArithmetic("**", 2, 10)).toBe(1024);
    expect(() => pythonArithmetic("/", 1, 0)).toThrow("division by zero");
    expect(() => pythonArithmetic("+", "a", 1)).toThrow("Unsupported operand type");
  });

  it("compares and searches values", () => {
    expect(pythonCompare("==", ["a"], ["a"])).toBe(true);
    expect(pythonCompare("!=", 1, true)).toBe(true);
    expect(pythonCompare("<", "a", "b")).toBe(true);
    expect(pythonCompare("in", "b", "abc")).toBe(true);
    expect(pythonCompare("not in", "z", "abc")).toBe(true);
    expect(pythonCompare("in", "a", ["a", "b"])).toBe(true);
    expect(pythonCompare("in", "k", { k: 1 })).toBe(true);
    expect(() => pythonCompare("<", "a", 1)).toThrow("Cannot compare");
  });

  it("slices and indexes strings and lists", () => {
    expect(pythonSlice("abcdef", 1, 3, undefined)).toBe("bc");
    expect(pythonSlice("abcdef", undefined, undefined, -1)).toBe("fedcba");
    expect(pythonSlice("abcdef", -2, undefined, undefined)).toBe("ef");
    expect(pythonSlice(["a", "b", "c"], 1, undefined, undefined)).toEqual(["b", "c"]);
    expect(() => pythonSlice("abc", undefined, undefined, 0)).toThrow("slice step cannot be zero");
    expect(pythonIndex("abc", -1)).toBe("c");
    expect(pythonIndex(["a", "b"], 1)).toBe("b");
    expect(pythonIndex({ a: { b: 1 } }, "a")).toEqual({ b: 1 });
    expect(() => pythonIndex("abc", 5)).toThrow("string index out of range");
  });

  it("runs the pure helper functions", () => {
    expect(pureFunction("len", [[1, 2]])).toBe(2);
    expect(pureFunction("str", [1.5])).toBe("1.5");
    expect(pureFunction("int", ["0x1f", 16])).toBe(31);
    expect(pureFunction("int", [2.9])).toBe(2);
    expect(pureFunction("float", [" 1.5 "])).toBe(1.5);
    expect(pureFunction("bool", [[]])).toBe(false);
    expect(pureFunction("abs", [-2])).toBe(2);
    expect(pureFunction("round", [2.5])).toBe(2);
    expect(pureFunction("round", [3.5])).toBe(4);
    expect(pureFunction("round", [1.2345, 2])).toBe(1.23);
    expect(pureFunction("sum", [[1, 2]])).toBe(3);
    expect(pureFunction("sorted", [["b", "a"]])).toEqual(["a", "b"]);
    expect(pureFunction("sorted", [["a", "b"]], { reverse: true })).toEqual(["b", "a"]);
    expect(pureFunction("min", [3, 1])).toBe(1);
    expect(pureFunction("max", [[3, 1]])).toBe(3);
    expect(pureFunction("range", [3])).toEqual([0, 1, 2]);
    expect(pureFunction("range", [1, 4])).toEqual([1, 2, 3]);
    expect(pureFunction("range", [0, 6, 2])).toEqual([0, 2, 4]);
    expect(pureFunction("list", ["ab"])).toEqual(["a", "b"]);
    expect(pureFunction("reversed", [[1, 2]])).toEqual([2, 1]);
    expect(pureFunction("all", [[true, true]])).toBe(true);
    expect(pureFunction("any", [[false, true]])).toBe(true);
    expect(() => pureFunction("int", ["abc"])).toThrow("invalid literal");
    expect(() => pureFunction("len", [1])).toThrow("has no len()");
    expect(() => pureFunction("range", [0, 0, 0])).toThrow("must not be zero");
  });
});

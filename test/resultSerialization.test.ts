import { describe, expect, it } from "vitest";
import { toBoundaryJson } from "../src/core/resultSerialization.js";
import { dextWireStepSchema } from "../src/core/schemas.js";

describe("Dext boundary values", () => {
  it("passes JSON shapes through unchanged", () => {
    const value = { text: "x", count: 2, ok: true, none: null, items: ["a", { b: 1 }] };
    expect(toBoundaryJson(value)).toEqual(value);
  });

  it("turns a Date into an ISO string", () => {
    expect(toBoundaryJson({ at: new Date("2026-02-14T09:30:00.000Z") })).toEqual({ at: "2026-02-14T09:30:00.000Z" });
    expect(toBoundaryJson(new Date("2026-02-14T09:30:00.000Z"))).toBe("2026-02-14T09:30:00.000Z");
  });

  it("drops undefined object properties the way JSON does", () => {
    expect(toBoundaryJson({ a: 1, b: undefined })).toEqual({ a: 1 });
  });

  it("refuses values JSON cannot carry, naming the path", () => {
    expect(() => toBoundaryJson({ nested: { fn: () => 1 } }, "The run result"))
      .toThrow("The run result contains a function at nested.fn");
    expect(() => toBoundaryJson([Symbol("s")], "The run result"))
      .toThrow("The run result contains a symbol at [0]");
    expect(() => toBoundaryJson({ n: Number.NaN }, "The run result"))
      .toThrow("The run result contains NaN at n; use a finite number.");
    expect(() => toBoundaryJson({ n: Number.POSITIVE_INFINITY }, "The run result"))
      .toThrow("use a finite number");
    expect(() => toBoundaryJson(undefined, "The run result"))
      .toThrow("The run result is undefined at value; use null instead.");
    expect(() => toBoundaryJson({ big: 1n }, "The run result"))
      .toThrow("convert it with String() or Number()");
  });

  it("refuses containers that have no JSON form, with a replacement", () => {
    expect(() => toBoundaryJson({ map: new Map() }, "The arguments of ask()"))
      .toThrow("The arguments of ask() contains a Map at map; convert it to a plain object first.");
    expect(() => toBoundaryJson({ set: new Set([1]) }, "The arguments of ask()"))
      .toThrow("convert it to an array first");
    expect(() => toBoundaryJson({ buffer: Buffer.from("x") }, "The arguments of ask()"))
      .toThrow("convert it to a string or a number array");
    expect(() => toBoundaryJson({ view: new Uint8Array([1]) }, "The arguments of ask()"))
      .toThrow("convert it to a number array");
  });

  it("refuses a class instance but accepts one with toJSON", () => {
    class Custom { constructor(readonly name: string) {} }
    expect(() => toBoundaryJson(new Custom("x"), "The run result"))
      .toThrow("The run result contains a Custom at value; return a plain object, or add a toJSON() method.");
    class Convertible {
      constructor(readonly name: string) {}
      toJSON(): { name: string } { return { name: this.name }; }
    }
    expect(toBoundaryJson(new Convertible("x"))).toEqual({ name: "x" });
  });

  it("refuses circular references instead of recursing forever", () => {
    const value: Record<string, unknown> = { name: "root" };
    value.self = value;
    expect(() => toBoundaryJson(value, "The run result")).toThrow("circular reference at self");
    const list: unknown[] = [];
    list.push(list);
    expect(() => toBoundaryJson({ list }, "The run result")).toThrow("circular reference");
  });
});

describe("Dext wire steps", () => {
  it("accepts an API step, a stream step, a notice and a failure", () => {
    expect(dextWireStepSchema.safeParse({ method: "ask", state: "success", response: { kind: "ask" } }).success).toBe(true);
    expect(dextWireStepSchema.safeParse({ method: "stdout", state: "success", stream: { channel: "stdout", text: "x\n" } }).success).toBe(true);
    expect(dextWireStepSchema.safeParse({ method: "notice", state: "success", notice: { level: "warning", text: "ask() was not awaited." } }).success).toBe(true);
    expect(dextWireStepSchema.safeParse({ method: "ask", state: "failed", error: "nope" }).success).toBe(true);
  });

  it("refuses a step that is both an API result and process output", () => {
    const parsed = dextWireStepSchema.safeParse({
      method: "stdout",
      state: "success",
      response: { kind: "ask" },
      stream: { channel: "stdout", text: "x" }
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses a step that carries a notice beside a response or a stream", () => {
    expect(dextWireStepSchema.safeParse({
      method: "ask",
      state: "success",
      response: { kind: "ask" },
      notice: { level: "warning", text: "x" }
    }).success).toBe(false);
    expect(dextWireStepSchema.safeParse({
      method: "stderr",
      state: "success",
      stream: { channel: "stderr", text: "x" },
      notice: { level: "warning", text: "x" }
    }).success).toBe(false);
  });

  it("refuses a notice step named after something else, or one that claims to fail", () => {
    expect(dextWireStepSchema.safeParse({ method: "ask", state: "success", notice: { level: "warning", text: "x" } }).success).toBe(false);
    expect(dextWireStepSchema.safeParse({ method: "notice", state: "failed", notice: { level: "warning", text: "x" } }).success).toBe(false);
    expect(dextWireStepSchema.safeParse({ method: "notice", state: "success", notice: { level: "error", text: "x" } }).success).toBe(false);
  });

  it("refuses a stream step named after something other than its channel", () => {
    expect(dextWireStepSchema.safeParse({ method: "ask", state: "success", stream: { channel: "stdout", text: "x" } }).success).toBe(false);
    expect(dextWireStepSchema.safeParse({ method: "stderr", state: "failed", stream: { channel: "stderr", text: "x" } }).success).toBe(false);
  });

  it("refuses the removed skipped state and unknown fields", () => {
    expect(dextWireStepSchema.safeParse({ method: "ask", state: "skipped" }).success).toBe(false);
    expect(dextWireStepSchema.safeParse({ method: "ask", state: "success", branch: 1 }).success).toBe(false);
  });
});

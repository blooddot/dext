/** Python-compatible string and pure-value semantics for the Dext workflow
 * language.
 *
 * The compiler folds constant expressions with the same functions the runtime
 * uses, so a value folded at compile time can never disagree with the value a
 * run produces. Everything here is side-effect free: no I/O, no environment,
 * no randomness.
 */

export type FormatConversion = "s" | "r" | "a";

export type ArithmeticOperator = "+" | "-" | "*" | "/" | "//" | "%" | "**";

export type LogicalOperator = "and" | "or";

export type CompareOperator = "==" | "!=" | "<" | "<=" | ">" | ">=" | "in" | "not in";

/** The kind a pure helper produces, mirroring the compiler's ValueType kinds. */
export type PureKind = "string" | "number" | "boolean" | "list" | "unknown";

export interface PureReturn {
  kind: PureKind;
  item?: PureKind;
}

export interface PureSignature {
  /** Required argument count. */
  required: number;
  /** Highest accepted argument count; Infinity means variadic. */
  maximum: number;
  returns: PureReturn;
  /** Parameter names, so keyword arguments can be resolved to positions. */
  parameters?: readonly string[];
  /** Position of an argument that must be a list, when the helper needs one. */
  listArgument?: number;
  /** True when keyword arguments are meaningful (currently `str.format`). */
  keywords?: boolean;
}

const STRING_RETURN: PureReturn = { kind: "string" };
const NUMBER_RETURN: PureReturn = { kind: "number" };
const BOOLEAN_RETURN: PureReturn = { kind: "boolean" };
const UNKNOWN_RETURN: PureReturn = { kind: "unknown" };
const STRING_LIST: PureReturn = { kind: "list", item: "string" };
const NUMBER_LIST: PureReturn = { kind: "list", item: "number" };

/** String methods Dext evaluates itself. Kept next to their implementation so a
 * signature and its behavior cannot drift apart. */
export const STRING_METHODS: Readonly<Record<string, PureSignature>> = {
  capitalize: { required: 0, maximum: 0, returns: STRING_RETURN },
  casefold: { required: 0, maximum: 0, returns: STRING_RETURN },
  center: { required: 1, maximum: 2, returns: STRING_RETURN, parameters: ["width", "fillchar"] },
  count: { required: 1, maximum: 3, returns: NUMBER_RETURN, parameters: ["sub", "start", "end"] },
  endswith: { required: 1, maximum: 3, returns: BOOLEAN_RETURN, parameters: ["suffix", "start", "end"] },
  expandtabs: { required: 0, maximum: 1, returns: STRING_RETURN, parameters: ["tabsize"] },
  find: { required: 1, maximum: 3, returns: NUMBER_RETURN, parameters: ["sub", "start", "end"] },
  format: { required: 0, maximum: Infinity, returns: STRING_RETURN, keywords: true },
  index: { required: 1, maximum: 3, returns: NUMBER_RETURN, parameters: ["sub", "start", "end"] },
  isalnum: { required: 0, maximum: 0, returns: BOOLEAN_RETURN },
  isalpha: { required: 0, maximum: 0, returns: BOOLEAN_RETURN },
  isascii: { required: 0, maximum: 0, returns: BOOLEAN_RETURN },
  isdecimal: { required: 0, maximum: 0, returns: BOOLEAN_RETURN },
  isdigit: { required: 0, maximum: 0, returns: BOOLEAN_RETURN },
  isidentifier: { required: 0, maximum: 0, returns: BOOLEAN_RETURN },
  islower: { required: 0, maximum: 0, returns: BOOLEAN_RETURN },
  isnumeric: { required: 0, maximum: 0, returns: BOOLEAN_RETURN },
  isspace: { required: 0, maximum: 0, returns: BOOLEAN_RETURN },
  istitle: { required: 0, maximum: 0, returns: BOOLEAN_RETURN },
  isupper: { required: 0, maximum: 0, returns: BOOLEAN_RETURN },
  join: { required: 1, maximum: 1, returns: STRING_RETURN, parameters: ["iterable"], listArgument: 0 },
  ljust: { required: 1, maximum: 2, returns: STRING_RETURN, parameters: ["width", "fillchar"] },
  lower: { required: 0, maximum: 0, returns: STRING_RETURN },
  lstrip: { required: 0, maximum: 1, returns: STRING_RETURN, parameters: ["chars"] },
  partition: { required: 1, maximum: 1, returns: STRING_LIST, parameters: ["sep"] },
  removeprefix: { required: 1, maximum: 1, returns: STRING_RETURN, parameters: ["prefix"] },
  removesuffix: { required: 1, maximum: 1, returns: STRING_RETURN, parameters: ["suffix"] },
  replace: { required: 2, maximum: 3, returns: STRING_RETURN, parameters: ["old", "new", "count"] },
  rfind: { required: 1, maximum: 3, returns: NUMBER_RETURN, parameters: ["sub", "start", "end"] },
  rindex: { required: 1, maximum: 3, returns: NUMBER_RETURN, parameters: ["sub", "start", "end"] },
  rjust: { required: 1, maximum: 2, returns: STRING_RETURN, parameters: ["width", "fillchar"] },
  rpartition: { required: 1, maximum: 1, returns: STRING_LIST, parameters: ["sep"] },
  rsplit: { required: 0, maximum: 2, returns: STRING_LIST, parameters: ["sep", "maxsplit"] },
  rstrip: { required: 0, maximum: 1, returns: STRING_RETURN, parameters: ["chars"] },
  split: { required: 0, maximum: 2, returns: STRING_LIST, parameters: ["sep", "maxsplit"] },
  splitlines: { required: 0, maximum: 1, returns: STRING_LIST, parameters: ["keepends"] },
  startswith: { required: 1, maximum: 3, returns: BOOLEAN_RETURN, parameters: ["prefix", "start", "end"] },
  strip: { required: 0, maximum: 1, returns: STRING_RETURN, parameters: ["chars"] },
  swapcase: { required: 0, maximum: 0, returns: STRING_RETURN },
  title: { required: 0, maximum: 0, returns: STRING_RETURN },
  upper: { required: 0, maximum: 0, returns: STRING_RETURN },
  zfill: { required: 1, maximum: 1, returns: STRING_RETURN, parameters: ["width"] }
};

/** Pure helper functions callable from a workflow without an API round trip. */
export const PURE_FUNCTIONS: Readonly<Record<string, PureSignature>> = {
  abs: { required: 1, maximum: 1, returns: NUMBER_RETURN, parameters: ["x"] },
  all: { required: 1, maximum: 1, returns: BOOLEAN_RETURN, parameters: ["iterable"], listArgument: 0 },
  any: { required: 1, maximum: 1, returns: BOOLEAN_RETURN, parameters: ["iterable"], listArgument: 0 },
  bool: { required: 1, maximum: 1, returns: BOOLEAN_RETURN, parameters: ["x"] },
  float: { required: 1, maximum: 1, returns: NUMBER_RETURN, parameters: ["x"] },
  int: { required: 1, maximum: 2, returns: NUMBER_RETURN, parameters: ["x", "base"] },
  len: { required: 1, maximum: 1, returns: NUMBER_RETURN, parameters: ["x"] },
  list: { required: 0, maximum: 1, returns: { kind: "list", item: "unknown" }, parameters: ["iterable"] },
  max: { required: 1, maximum: Infinity, returns: UNKNOWN_RETURN, parameters: ["value"] },
  min: { required: 1, maximum: Infinity, returns: UNKNOWN_RETURN, parameters: ["value"] },
  range: { required: 1, maximum: 3, returns: NUMBER_LIST, parameters: ["start", "stop", "step"] },
  repr: { required: 1, maximum: 1, returns: STRING_RETURN, parameters: ["x"] },
  reversed: { required: 1, maximum: 1, returns: { kind: "list", item: "unknown" }, parameters: ["iterable"], listArgument: 0 },
  round: { required: 1, maximum: 2, returns: NUMBER_RETURN, parameters: ["number", "ndigits"] },
  sorted: { required: 1, maximum: 1, returns: { kind: "list", item: "unknown" }, parameters: ["iterable"], listArgument: 0, keywords: true },
  str: { required: 1, maximum: 1, returns: STRING_RETURN, parameters: ["x"] },
  sum: { required: 1, maximum: 2, returns: NUMBER_RETURN, parameters: ["iterable", "start"], listArgument: 0 }
};

/** Highest list `range` materializes, so a workflow cannot ask for an array that
 * does not fit in memory. */
export const MAX_RANGE_LENGTH = 100_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Renders a workspace reference the way the editor writes it, so a reference
 * interpolated into text stays usable by the prompt pipeline. */
function referenceText(value: Record<string, unknown>): string | undefined {
  const path = typeof value.path === "string" ? value.path.replace(/\/+$/, "") : undefined;
  if (value.kind === "file" && typeof value.path === "string") return `@${value.path}`;
  if ((value.kind === "dir" || value.kind === "dirRef") && path !== undefined) return `@${path}/`;
  if (value.kind === "selection") return "@selection";
  if (value.kind === "activeFile") return "@active_file";
  if (value.kind === "symbol" && typeof value.name === "string") return `@${value.name}`;
  if (value.kind === "codeRef" && typeof value.uri === "string") {
    const range = value.range as { start?: { line?: number } } | undefined;
    const line = range?.start?.line;
    return line === undefined ? `@${value.uri}` : `@${value.uri}#L${line + 1}`;
  }
  return undefined;
}

/** Python `str()`. */
export function pythonText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return pythonNumberText(value);
  if (typeof value === "boolean") return value ? "True" : "False";
  if (value === null || value === undefined) return "None";
  if (Array.isArray(value)) return `[${value.map((item) => pythonRepr(item)).join(", ")}]`;
  if (isObject(value)) {
    const reference = referenceText(value);
    if (reference !== undefined) return reference;
    return `{${Object.entries(value).map(([key, item]) => `${pythonRepr(key)}: ${pythonRepr(item)}`).join(", ")}}`;
  }
  return String(value as string | number | boolean);
}

export function pythonNumberText(value: number): string {
  if (!Number.isFinite(value)) {
    if (Number.isNaN(value)) return "nan";
    return value > 0 ? "inf" : "-inf";
  }
  return String(value);
}

/** Python `repr()`: the quote that needs no escaping is the one Python picks. */
export function pythonRepr(value: unknown): string {
  if (typeof value !== "string") return pythonText(value);
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t")
    .split(quote)
    .join(`\\${quote}`);
  return `${quote}${escaped}${quote}`;
}

/** Python `ascii()`. */
export function pythonAscii(value: unknown): string {
  return pythonRepr(value).replace(/[^\x20-\x7E]/g, (character) => {
    const code = character.codePointAt(0)!;
    if (code <= 0xff) return `\\x${code.toString(16).padStart(2, "0")}`;
    if (code <= 0xffff) return `\\u${code.toString(16).padStart(4, "0")}`;
    return `\\U${code.toString(16).padStart(8, "0")}`;
  });
}

function applyConversion(value: unknown, conversion: FormatConversion | undefined): unknown {
  if (conversion === "r") return pythonRepr(value);
  if (conversion === "a") return pythonAscii(value);
  if (conversion === "s") return pythonText(value);
  return value;
}

interface ParsedSpec {
  fill: string;
  align: "<" | ">" | "^" | "=";
  alignExplicit: boolean;
  sign: "+" | "-" | " ";
  alternate: boolean;
  width?: number;
  grouping?: "," | "_";
  precision?: number;
  type?: string;
}

const SPEC_TYPES = "bcdoxXneEfFgG%s";
const INTEGER_TYPES = "bcdoxXn";

function parseSpec(spec: string, subject: string): ParsedSpec {
  let rest = spec;
  let fill = " ";
  let align: ParsedSpec["align"] | undefined;
  if (rest.length >= 2 && "<>^=".includes(rest[1]!)) {
    fill = rest[0]!;
    align = rest[1] as ParsedSpec["align"];
    rest = rest.slice(2);
  } else if (rest.length >= 1 && "<>^=".includes(rest[0]!)) {
    align = rest[0] as ParsedSpec["align"];
    rest = rest.slice(1);
  }
  let sign: ParsedSpec["sign"] = "-";
  if (rest[0] === "+" || rest[0] === "-" || rest[0] === " ") {
    sign = rest[0];
    rest = rest.slice(1);
  }
  let alternate = false;
  if (rest[0] === "#") {
    alternate = true;
    rest = rest.slice(1);
  }
  if (rest[0] === "0") {
    if (!align) {
      align = "=";
      fill = "0";
    }
    rest = rest.slice(1);
  }
  let width: number | undefined;
  const widthMatch = /^\d+/.exec(rest);
  if (widthMatch) {
    width = Number(widthMatch[0]);
    rest = rest.slice(widthMatch[0].length);
  }
  let grouping: ParsedSpec["grouping"];
  if (rest[0] === "," || rest[0] === "_") {
    grouping = rest[0] as ParsedSpec["grouping"];
    rest = rest.slice(1);
  }
  let precision: number | undefined;
  const precisionMatch = /^\.(\d+)/.exec(rest);
  if (precisionMatch) {
    precision = Number(precisionMatch[1]!);
    rest = rest.slice(precisionMatch[0].length);
  } else if (rest.startsWith(".")) {
    throw new Error(`Format spec '${spec}' needs digits after '.'.`);
  }
  let type: string | undefined;
  if (rest.length === 1 && SPEC_TYPES.includes(rest)) {
    type = rest;
    rest = "";
  }
  if (rest.length) throw new Error(`Unknown format code '${rest}' in format spec '${spec}' for ${subject}.`);
  return {
    fill,
    align: align ?? ">",
    alignExplicit: align !== undefined,
    sign,
    alternate,
    ...(width === undefined ? {} : { width }),
    ...(grouping === undefined ? {} : { grouping }),
    ...(precision === undefined ? {} : { precision }),
    ...(type === undefined ? {} : { type })
  };
}

function groupDigits(value: string, separator: string): string {
  const negative = value.startsWith("-");
  const digits = negative ? value.slice(1) : value;
  const [integer, fraction] = digits.split(".");
  const grouped = integer!.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
  return `${negative ? "-" : ""}${grouped}${fraction === undefined ? "" : `.${fraction}`}`;
}

function pad(value: string, spec: ParsedSpec, numeric: boolean): string {
  const width = spec.width ?? 0;
  if (value.length >= width) return value;
  const align = spec.alignExplicit ? spec.align : numeric ? ">" : "<";
  const count = width - value.length;
  if (align === "<") return value + spec.fill.repeat(count);
  if (align === "^") {
    const left = Math.floor(count / 2);
    return spec.fill.repeat(left) + value + spec.fill.repeat(count - left);
  }
  if (align === "=" && numeric) {
    const match = /^([-+ ]?)([\s\S]*)$/.exec(value)!;
    return match[1]! + spec.fill.repeat(count) + match[2]!;
  }
  return spec.fill.repeat(count) + value;
}

function signPrefix(value: number, spec: ParsedSpec): string {
  if (value >= 0 && spec.sign !== "-") return spec.sign === " " ? " " : "+";
  return "";
}

function formatInteger(value: number, spec: ParsedSpec, radix: number, prefix: string, upper: boolean): string {
  if (!Number.isInteger(value)) throw new Error(`Unknown format code '${spec.type}' for object of type 'float'.`);
  if (spec.precision !== undefined) throw new Error(`Precision not allowed in integer format specifier.`);
  let digits = Math.abs(value).toString(radix);
  if (upper) digits = digits.toUpperCase();
  if (spec.grouping && radix === 10) digits = groupDigits(digits, spec.grouping);
  const number = `${value < 0 ? "-" : signPrefix(value, spec)}${spec.alternate ? prefix : ""}${digits}`;
  return pad(number, spec, true);
}

function formatFloat(value: number, spec: ParsedSpec): string {
  const type = spec.type;
  const magnitude = Math.abs(value);
  let text: string;
  if (type === "%") {
    text = `${(magnitude * 100).toFixed(spec.precision ?? 6)}%`;
  } else if (type === "e" || type === "E") {
    text = exponentialText(magnitude, spec.precision ?? 6);
    if (type === "E") text = text.toUpperCase();
  } else if (type === "f" || type === "F") {
    text = magnitude.toFixed(spec.precision ?? 6);
  } else if (type === "g" || type === "G") {
    text = generalText(magnitude, spec.precision ?? 6);
    if (type === "G") text = text.toUpperCase();
  } else if (type === "n") {
    text = generalText(magnitude, spec.precision ?? 6);
  } else {
    text = pythonNumberText(magnitude);
  }
  if (spec.grouping) text = groupDigits(text, spec.grouping);
  return pad(`${value < 0 ? "-" : signPrefix(value, spec)}${text}`, spec, true);
}

function exponentialText(value: number, precision: number): string {
  const [mantissa, exponent] = value.toExponential(precision).split("e");
  const sign = exponent!.startsWith("-") ? "-" : "+";
  return `${mantissa}e${sign}${exponent!.replace(/^[-+]/, "").padStart(2, "0")}`;
}

function generalText(value: number, precision: number): string {
  if (value === 0) return precision > 0 ? "0" : "0";
  const exponent = Math.floor(Math.log10(value));
  if (exponent < -4 || exponent >= precision) {
    const [mantissa, power] = value.toExponential(Math.max(0, precision - 1)).split("e");
    const trimmed = mantissa!.includes(".") ? mantissa!.replace(/\.?0+$/, "") : mantissa!;
    const sign = power!.startsWith("-") ? "-" : "+";
    return `${trimmed}e${sign}${power!.replace(/^[-+]/, "").padStart(2, "0")}`;
  }
  const decimals = Math.max(0, precision - exponent - 1);
  const fixed = value.toFixed(Math.min(decimals, 100));
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}

/** Applies a Python format spec (the text after `:` in an f-string). */
export function formatWithSpec(value: unknown, spec: string): string {
  if (!spec) return pythonText(value);
  if (typeof value === "boolean") {
    // Python formats bool as int whenever the spec is not empty.
    const booleanSpec = parseSpec(spec, "bool");
    if (booleanSpec.type !== undefined && booleanSpec.type !== "s" && !INTEGER_TYPES.includes(booleanSpec.type)) {
      throw new Error(`Unknown format code '${booleanSpec.type}' for object of type 'bool'.`);
    }
    return formatWithSpec(value ? 1 : 0, spec);
  }
  if (typeof value === "number") {
    const parsed = parseSpec(spec, "float");
    switch (parsed.type) {
      case "d": return formatInteger(value, parsed, 10, "", false);
      case "b": return formatInteger(value, parsed, 2, "0b", false);
      case "o": return formatInteger(value, parsed, 8, "0o", false);
      case "x": return formatInteger(value, parsed, 16, "0x", false);
      case "X": return formatInteger(value, parsed, 16, "0X", true);
      case "c": {
        if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) {
          throw new Error(`%c arg not in range(0x110000): ${pythonNumberText(value)}`);
        }
        return pad(String.fromCodePoint(value), parsed, false);
      }
      default: return formatFloat(value, parsed);
    }
  }
  const text = pythonText(value);
  const parsed = parseSpec(spec, typeof value === "string" ? "str" : "object");
  if (parsed.type !== undefined && parsed.type !== "s") {
    throw new Error(`Unknown format code '${parsed.type}' for object of type '${typeof value === "string" ? "str" : "object"}'.`);
  }
  if (parsed.sign !== "-") throw new Error("Sign not allowed in string format specifier");
  if (parsed.alternate) throw new Error("Alternate form (#) not allowed in string format specifier");
  const truncated = parsed.precision === undefined ? text : [...text].slice(0, parsed.precision).join("");
  return pad(truncated, parsed, false);
}

/** One resolved f-string replacement: value, `!conversion`, and `:spec`. */
export function formatReplacement(value: unknown, conversion: FormatConversion | undefined, spec: string): string {
  return formatWithSpec(applyConversion(value, conversion), spec);
}

/** Python truthiness, used by `bool()`, `and`, `or`, and `not`. */
export function pythonTruthy(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return value !== null && value !== undefined;
}

function requireNumber(value: unknown, operator: string): number {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value !== "number") throw new Error(`Unsupported operand type for ${operator}: '${typeof value}'.`);
  return value;
}

function requireString(value: unknown, operator: string): string {
  if (typeof value !== "string") throw new Error(`Unsupported operand type for ${operator}: '${typeof value}'.`);
  return value;
}

function repeat(value: string, count: number): string {
  if (!Number.isInteger(count)) throw new Error(`Cannot repeat a string ${pythonNumberText(count)} times.`);
  if (count <= 0) return "";
  if (value.length * count > 1_000_000) throw new Error("String repetition is limited to 1000000 characters.");
  return value.repeat(count);
}

/** Python arithmetic, including the string forms of `+`, `*`, and `%`. */
export function pythonArithmetic(operator: ArithmeticOperator, left: unknown, right: unknown): number | string {
  if (operator === "+") {
    if (typeof left === "string" && typeof right === "string") return left + right;
    return requireNumber(left, "+") + requireNumber(right, "+");
  }
  if (operator === "*") {
    if (typeof left === "string" && typeof right === "number") return repeat(left, Math.trunc(right));
    if (typeof right === "string" && typeof left === "number") return repeat(right, Math.trunc(left));
    return requireNumber(left, "*") * requireNumber(right, "*");
  }
  if (operator === "%" && typeof left === "string") return formatPercent(left, right);
  const a = requireNumber(left, operator);
  const b = requireNumber(right, operator);
  if (operator === "-") return a - b;
  if (operator === "/") {
    if (b === 0) throw new Error("division by zero");
    return a / b;
  }
  if (operator === "//") {
    if (b === 0) throw new Error("integer division or modulo by zero");
    return Math.floor(a / b);
  }
  if (operator === "%") {
    if (b === 0) throw new Error("integer division or modulo by zero");
    return ((a % b) + b) % b;
  }
  return a ** b;
}

function orderable(value: unknown): number | string {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "string") return value;
  throw new Error(`'${typeof value}' is not orderable.`);
}

function pythonEquals(left: unknown, right: unknown): boolean {
  if (typeof left === "boolean" || typeof right === "boolean") {
    return typeof left === "boolean" && typeof right === "boolean" ? left === right : false;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => pythonEquals(item, right[index]));
  }
  if (isObject(left) && isObject(right)) {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every((key) => key in right && pythonEquals(left[key], right[key]));
  }
  return left === right;
}

function containsValue(container: unknown, item: unknown): boolean {
  if (typeof container === "string") {
    if (typeof item !== "string") throw new Error("'in <string>' requires a string left operand.");
    return container.includes(item);
  }
  if (Array.isArray(container)) return container.some((value) => pythonEquals(value, item));
  if (isObject(container)) {
    if (typeof item !== "string") throw new Error("'in <dict>' requires a string left operand.");
    return item in container;
  }
  throw new Error(`Argument of type '${typeof container}' is not iterable.`);
}

/** Ordered comparison, `in`, and equality for the values Dext can compare. */
export function pythonCompare(operator: CompareOperator, left: unknown, right: unknown): boolean {
  if (operator === "in" || operator === "not in") {
    const contained = containsValue(right, left);
    return operator === "in" ? contained : !contained;
  }
  if (operator === "==" || operator === "!=") {
    const equal = pythonEquals(left, right);
    return operator === "==" ? equal : !equal;
  }
  const a = orderable(left);
  const b = orderable(right);
  if (typeof a !== typeof b) throw new Error(`Cannot compare '${typeof a}' with '${typeof b}'.`);
  if (operator === "<") return a < b;
  if (operator === "<=") return a <= b;
  if (operator === ">") return a > b;
  return a >= b;
}

function normalizeIndex(index: unknown, length: number, fallback: number, name: string): number {
  if (index === undefined || index === null) return fallback;
  const raw = Math.trunc(requireNumber(index, name));
  return raw < 0 ? raw + length : raw;
}

/** Python slicing for strings and lists, including negative indices and steps. */
export function pythonSlice(value: unknown, start: unknown, stop: unknown, step: unknown): unknown {
  const items: unknown[] = typeof value === "string" ? [...value] : Array.isArray(value) ? [...(value as unknown[])] : [];
  if (typeof value !== "string" && !Array.isArray(value)) throw new Error(`'${typeof value}' is not sliceable.`);
  const stride = step === undefined || step === null ? 1 : Math.trunc(requireNumber(step, "slice"));
  if (stride === 0) throw new Error("slice step cannot be zero");
  const length = items.length;
  const selected: unknown[] = [];
  if (stride > 0) {
    const from = Math.min(Math.max(normalizeIndex(start, length, 0, "slice"), 0), length);
    const to = Math.min(Math.max(normalizeIndex(stop, length, length, "slice"), 0), length);
    for (let index = from; index < to; index += stride) selected.push(items[index]);
  } else {
    const from = Math.min(Math.max(normalizeIndex(start, length, length - 1, "slice"), -1), length - 1);
    const to = Math.min(Math.max(normalizeIndex(stop, length, -1, "slice"), -1), length - 1);
    for (let index = from; index > to; index += stride) selected.push(items[index]);
  }
  return typeof value === "string" ? selected.join("") : selected;
}

/** Python indexing: negative offsets count from the end, and a dictionary is
 * read with its key. */
export function pythonIndex(value: unknown, index: unknown): unknown {
  if (isObject(value)) {
    const key = typeof index === "string" ? index : pythonNumberText(requireNumber(index, "index"));
    if (!(key in value)) throw new Error(`KeyError: ${pythonRepr(key)}`);
    return value[key];
  }
  const position = Math.trunc(requireNumber(index, "index"));
  if (typeof value === "string") {
    const items = [...value];
    const resolved = position < 0 ? position + items.length : position;
    if (resolved < 0 || resolved >= items.length) throw new Error("string index out of range");
    return items[resolved];
  }
  if (Array.isArray(value)) {
    const resolved = position < 0 ? position + value.length : position;
    if (resolved < 0 || resolved >= value.length) throw new Error("list index out of range");
    return value[resolved];
  }
  throw new Error(`'${typeof value}' is not subscriptable.`);
}

function sliceBounds(length: number, start: unknown, end: unknown): [number, number] {
  const from = normalizeIndex(start, length, 0, "start");
  const to = normalizeIndex(end, length, length, "end");
  return [Math.min(Math.max(from, 0), length), Math.min(Math.max(to, 0), length)];
}

function splitString(value: string, separator: unknown, maxsplit: unknown, fromRight: boolean): string[] {
  const limit = maxsplit === undefined || maxsplit === null ? -1 : Math.trunc(requireNumber(maxsplit, "maxsplit"));
  if (separator === undefined || separator === null) {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (limit < 0) return trimmed.split(/\s+/);
    const parts: string[] = [];
    let rest = trimmed;
    while (parts.length < limit) {
      const match = /\s+/.exec(rest);
      if (!match) break;
      parts.push(rest.slice(0, match.index));
      rest = rest.slice(match.index + match[0].length);
    }
    parts.push(rest);
    return parts;
  }
  const delimiter = requireString(separator, "split");
  if (delimiter === "") throw new Error("empty separator");
  if (limit < 0) return value.split(delimiter);
  if (!fromRight) {
    const parts = value.split(delimiter);
    return parts.length <= limit + 1 ? parts : [...parts.slice(0, limit), parts.slice(limit).join(delimiter)];
  }
  const parts: string[] = [];
  let rest = value;
  while (parts.length < limit) {
    const index = rest.lastIndexOf(delimiter);
    if (index < 0) break;
    parts.unshift(rest.slice(index + delimiter.length));
    rest = rest.slice(0, index);
  }
  parts.unshift(rest);
  return parts;
}

/** Implements a Python string method. Throws with the Python-style message so a
 * failing step explains itself in Dext Output. */
export function stringMethod(
  receiver: string,
  method: string,
  args: readonly unknown[],
  keywords: Readonly<Record<string, unknown>> = {}
): unknown {
  const at = (index: number): unknown => args[index];
  const text = (value: unknown, name: string): string => requireString(value, name);
  switch (method) {
    case "capitalize": return receiver.charAt(0).toUpperCase() + receiver.slice(1).toLowerCase();
    case "casefold": case "lower": return receiver.toLowerCase();
    case "upper": return receiver.toUpperCase();
    case "center": {
      const width = Math.trunc(requireNumber(at(0), "width"));
      const fill = at(1) === undefined ? " " : text(at(1), "fillchar");
      const length = [...receiver].length;
      if ([...fill].length !== 1) throw new Error("The fill character must be exactly one character long.");
      if (length >= width) return receiver;
      const total = width - length;
      const left = Math.floor(total / 2);
      return fill.repeat(left) + receiver + fill.repeat(total - left);
    }
    case "count": case "find": case "rfind": case "index": case "rindex": {
      const needle = text(at(0), "sub");
      const [from, to] = sliceBounds(receiver.length, at(1), at(2));
      const haystack = receiver.slice(from, to);
      if (method === "count") return needle === "" ? haystack.length + 1 : haystack.split(needle).length - 1;
      const index = method === "find" || method === "index" ? haystack.indexOf(needle) : haystack.lastIndexOf(needle);
      if (index < 0) {
        if (method === "index" || method === "rindex") throw new Error("substring not found");
        return -1;
      }
      return index + from;
    }
    case "endswith": case "startswith": {
      const [from, to] = sliceBounds(receiver.length, at(1), at(2));
      const segment = receiver.slice(from, to);
      const candidate = at(0);
      const candidates: string[] = Array.isArray(candidate)
        ? candidate.map((item) => text(item, "prefix"))
        : [text(candidate, "prefix")];
      return candidates.some((candidate) => method === "startswith" ? segment.startsWith(candidate) : segment.endsWith(candidate));
    }
    case "expandtabs": {
      const size = at(0) === undefined ? 8 : Math.trunc(requireNumber(at(0), "tabsize"));
      let column = 0;
      let result = "";
      for (const character of receiver) {
        if (character === "\t") {
          const spaces = size > 0 ? size - (column % size) : 0;
          result += " ".repeat(spaces);
          column += spaces;
        } else if (character === "\n" || character === "\r") {
          result += character;
          column = 0;
        } else {
          result += character;
          column += 1;
        }
      }
      return result;
    }
    case "format": return formatTemplate(receiver, args, keywords);
    case "isalnum": return /^[\p{L}\p{Nd}]+$/u.test(receiver);
    case "isalpha": return /^\p{L}+$/u.test(receiver);
    case "isascii": return [...receiver].every((character) => (character.codePointAt(0) ?? 0) < 128);
    case "isdecimal": case "isdigit": case "isnumeric": return /^\p{Nd}+$/u.test(receiver);
    case "isidentifier": return /^[A-Za-z_][A-Za-z0-9_]*$/.test(receiver);
    case "islower": return /[a-z]/.test(receiver) && receiver === receiver.toLowerCase();
    case "isspace": return receiver.length > 0 && /^\s+$/.test(receiver);
    case "istitle": {
      const words = receiver.split(/[^\p{L}\p{Nd}]+/u).filter(Boolean);
      return words.length > 0 && words.every((word) => word[0] === word[0]!.toUpperCase() && word.slice(1) === word.slice(1).toLowerCase());
    }
    case "isupper": return /[A-Z]/.test(receiver) && receiver === receiver.toUpperCase();
    case "join": {
      const items = at(0);
      if (!Array.isArray(items)) throw new Error(`Expected a list, got '${typeof items}'.`);
      return items.map((item) => text(item, "join")).join(receiver);
    }
    case "ljust": case "rjust": case "zfill": {
      const width = Math.trunc(requireNumber(at(0), "width"));
      const fill = method === "zfill" ? "0" : at(1) === undefined ? " " : text(at(1), "fillchar");
      const length = [...receiver].length;
      if ([...fill].length !== 1) throw new Error("The fill character must be exactly one character long.");
      if (length >= width) return receiver;
      const padding = fill.repeat(width - length);
      if (method === "ljust") return receiver + padding;
      if (method === "zfill") {
        const sign = /^[+-]/.test(receiver) ? receiver[0]! : "";
        return sign + padding + receiver.slice(sign.length);
      }
      return padding + receiver;
    }
    case "lstrip": case "rstrip": case "strip": {
      const characters = at(0) === undefined ? undefined : text(at(0), "chars");
      const predicate = (character: string): boolean => characters === undefined ? /\s/.test(character) : characters.includes(character);
      const items = [...receiver];
      let from = 0;
      let to = items.length;
      if (method !== "rstrip") while (from < to && predicate(items[from]!)) from += 1;
      if (method !== "lstrip") while (to > from && predicate(items[to - 1]!)) to -= 1;
      return items.slice(from, to).join("");
    }
    case "partition": case "rpartition": {
      const separator = text(at(0), "sep");
      if (separator === "") throw new Error("empty separator");
      const index = method === "partition" ? receiver.indexOf(separator) : receiver.lastIndexOf(separator);
      if (index < 0) return method === "partition" ? [receiver, "", ""] : ["", "", receiver];
      return [receiver.slice(0, index), separator, receiver.slice(index + separator.length)];
    }
    case "removeprefix": {
      const prefix = text(at(0), "prefix");
      return receiver.startsWith(prefix) ? receiver.slice(prefix.length) : receiver;
    }
    case "removesuffix": {
      const suffix = text(at(0), "suffix");
      return suffix !== "" && receiver.endsWith(suffix) ? receiver.slice(0, -suffix.length) : receiver;
    }
    case "replace": {
      const old = text(at(0), "old");
      const replacement = text(at(1), "new");
      const count = at(2) === undefined ? -1 : Math.trunc(requireNumber(at(2), "count"));
      if (old === "") return [...receiver].map((character) => replacement + character).join("") + replacement;
      if (count < 0) return receiver.split(old).join(replacement);
      let result = receiver;
      let remaining = count;
      let cursor = 0;
      while (remaining > 0) {
        const index = result.indexOf(old, cursor);
        if (index < 0) break;
        result = result.slice(0, index) + replacement + result.slice(index + old.length);
        cursor = index + replacement.length;
        remaining -= 1;
      }
      return result;
    }
    case "rsplit": return splitString(receiver, at(0), at(1), true);
    case "split": return splitString(receiver, at(0), at(1), false);
    case "splitlines": {
      if (!receiver) return [];
      const lines = receiver.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
      return at(0) === true ? lines : lines.map((line) => line.replace(/\r\n$|\r$|\n$/, ""));
    }
    case "swapcase": return [...receiver]
      .map((character) => character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase())
      .join("");
    case "title": return receiver.replace(/[\p{L}\p{Nd}]+/gu, (word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase());
    default: throw new Error(`String has no method '${method}'.`);
  }
}

/** The `.format()` mini-language: `{}`, `{0}`, `{name}`, attribute and index
 * access, `!conversion`, and `:spec`. */
export function formatTemplate(
  template: string,
  positional: readonly unknown[] = [],
  keywords: Readonly<Record<string, unknown>> = {}
): string {
  let result = "";
  let next = 0;
  const numbering = { automatic: false, manual: false };
  let index = 0;
  while (index < template.length) {
    const character = template[index]!;
    if (character === "{") {
      if (template[index + 1] === "{") {
        result += "{";
        index += 2;
        continue;
      }
      const end = findFieldEnd(template, index);
      result += renderField(template.slice(index + 1, end), positional, keywords, numbering, () => {
        const value = next;
        next += 1;
        return value;
      });
      index = end + 1;
      continue;
    }
    if (character === "}") {
      if (template[index + 1] === "}") {
        result += "}";
        index += 2;
        continue;
      }
      throw new Error("Single '}' encountered in format string.");
    }
    result += character;
    index += 1;
  }
  return result;
}

function findFieldEnd(template: string, start: number): number {
  let depth = 0;
  for (let index = start; index < template.length; index += 1) {
    const character = template[index]!;
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error("Unmatched '{' in format string.");
}

function renderField(
  field: string,
  positional: readonly unknown[],
  keywords: Readonly<Record<string, unknown>>,
  numbering: { automatic: boolean; manual: boolean },
  takeAuto: () => number
): string {
  const conversionIndex = field.indexOf("!");
  const specIndex = field.indexOf(":");
  const nameEnd = Math.min(...[conversionIndex, specIndex, field.length].filter((value) => value >= 0));
  const name = field.slice(0, nameEnd);
  const conversion = conversionIndex >= 0 && (specIndex < 0 || conversionIndex < specIndex)
    ? field.slice(conversionIndex + 1, specIndex >= 0 ? specIndex : undefined)
    : undefined;
  const spec = specIndex >= 0 ? field.slice(specIndex + 1) : "";
  if (conversion !== undefined && conversion !== "" && !"sra".includes(conversion)) {
    throw new Error(`Unknown conversion '!${conversion}'.`);
  }
  const [head, ...rest] = name.split(/(?=[.[])/);
  let value: unknown;
  if (head === "") {
    if (numbering.manual) throw new Error("cannot switch from manual field specification to automatic field numbering");
    numbering.automatic = true;
    value = positional[takeAuto()];
  } else {
    // Python only rejects mixing automatic numbering with numeric fields;
    // named fields may be combined with `{}`.
    if (/^\d+$/.test(head!)) {
      if (numbering.automatic) throw new Error("cannot switch from automatic field numbering to manual field specification");
      numbering.manual = true;
      value = positional[Number(head)];
    } else if (head !== undefined && head in keywords) value = keywords[head];
    else throw new Error(`KeyError: ${pythonRepr(head ?? "")}`);
  }
  for (const part of rest) {
    if (part.startsWith(".")) {
      const property = part.slice(1);
      if (!isObject(value)) throw new Error(`'${typeof value}' object has no attribute '${property}'`);
      if (!(property in value)) throw new Error(`AttributeError: ${pythonRepr(property)}`);
      value = value[property];
      continue;
    }
    const match = /^\[(.*)\]$/.exec(part);
    if (!match) throw new Error(`Invalid format field '${field}'.`);
    const key = match[1]!;
    value = pythonIndex(value, /^\d+$/.test(key) ? Number(key) : key.replace(/^['"]|['"]$/g, ""));
  }
  return formatReplacement(value, conversion as FormatConversion | undefined, spec);
}

/** The legacy `%` operator for strings. */
export function formatPercent(template: string, value: unknown): string {
  let result = "";
  let index = 0;
  let consumed = 0;
  const take = (): unknown => {
    if (Array.isArray(value)) {
      const items = value as unknown[];
      if (consumed >= items.length) throw new Error("not enough arguments for format string");
      const item = items[consumed];
      consumed += 1;
      return item;
    }
    if (consumed > 0) throw new Error("not enough arguments for format string");
    consumed += 1;
    return value;
  };
  while (index < template.length) {
    const character = template[index]!;
    if (character !== "%") {
      result += character;
      index += 1;
      continue;
    }
    if (template[index + 1] === "%") {
      result += "%";
      index += 2;
      continue;
    }
    index += 1;
    let key: string | undefined;
    if (template[index] === "(") {
      const close = template.indexOf(")", index);
      if (close < 0) throw new Error("incomplete format key");
      key = template.slice(index + 1, close);
      index = close + 1;
    }
    const flags = /^[-+ 0#]*/.exec(template.slice(index))![0];
    index += flags.length;
    const width = /^\d+/.exec(template.slice(index))?.[0] ?? "";
    index += width.length;
    const precision = /^\.\d+/.exec(template.slice(index))?.[0] ?? "";
    index += precision.length;
    const type = template[index];
    if (!type) throw new Error("incomplete format");
    index += 1;
    if (!"diouxXeEfFgGcrsa".includes(type)) throw new Error(`unsupported format character '${type}'`);
    let operand: unknown;
    if (key !== undefined) {
      if (!isObject(value)) throw new Error("format requires a mapping");
      if (!(key in value)) throw new Error(`KeyError: ${pythonRepr(key)}`);
      operand = value[key];
    } else {
      operand = take();
    }
    const alignment = flags.includes("-") ? "<" : "";
    const sign = flags.includes("+") ? "+" : flags.includes(" ") ? " " : "";
    const alternate = flags.includes("#") ? "#" : "";
    const zero = !alignment && flags.includes("0") ? "0" : "";
    if (type === "c" && typeof operand === "number") {
      result += formatWithSpec(String.fromCodePoint(Math.trunc(operand)), `${alignment}${zero}${width}s`);
      continue;
    }
    const converted = "sra".includes(type) ? applyConversion(operand, type as FormatConversion) : operand;
    const typeCode = type === "i" || type === "u" ? "d" : "sra".includes(type) ? "s" : type;
    result += formatWithSpec(converted, `${alignment}${sign}${alternate}${zero}${width}${precision}${typeCode}`);
  }
  if (Array.isArray(value) && consumed < value.length) throw new Error("not all arguments converted during string formatting");
  return result;
}

/** Python rounds halves to the nearest even digit, measured on the exact value of
 * the double: `round(2.675, 2)` is 2.67, not 2.68. */
export function pythonRound(value: number, digits: number): number {
  if (!Number.isFinite(value)) throw new Error(`cannot convert float ${pythonNumberText(value)} to integer`);
  if (digits < 0) {
    const factor = 10 ** -digits;
    const scaled = value / factor;
    const lower = Math.floor(scaled);
    const fraction = scaled - lower;
    const rounded = fraction > 0.5 ? lower + 1 : fraction < 0.5 ? lower : lower % 2 === 0 ? lower : lower + 1;
    return rounded * factor;
  }
  if (digits > 100) return value;
  if (exactHalf(value, digits)) {
    const scaled = Math.abs(value) * 10 ** digits;
    const lower = Math.round(scaled - 0.5);
    const even = lower % 2 === 0 ? lower : lower + 1;
    return (value < 0 ? -even : even) / 10 ** digits;
  }
  return Number(value.toFixed(digits));
}

/** True when `value` sits exactly halfway at the digit being rounded, which is
 * the only case where Python's round-half-even differs from a plain round. */
function exactHalf(value: number, digits: number): boolean {
  if (!Number.isFinite(value) || value === 0) return false;
  const buffer = new DataView(new ArrayBuffer(8));
  buffer.setFloat64(0, Math.abs(value));
  const bits = buffer.getBigUint64(0);
  const exponent = Number((bits >> 52n) & 0x7ffn);
  if (exponent === 0 || exponent === 0x7ff) return false;
  const mantissa = (bits & 0xfffffffffffffn) | 0x10000000000000n;
  // value = mantissa * 2^(exponent - 1075), so doubling it and shifting the
  // decimal point by `digits` turns the tie test into an integer parity test.
  const power = exponent - 1075 + 1 + digits;
  let scaled = mantissa * 5n ** BigInt(digits);
  if (power >= 0) scaled <<= BigInt(power);
  else {
    const divisor = 1n << BigInt(-power);
    if (scaled % divisor !== 0n) return false;
    scaled /= divisor;
  }
  return scaled % 2n === 1n;
}

function requireList(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} expects a list but '${typeof value}' was given.`);
  return value;
}

function extremum(args: readonly unknown[], name: "min" | "max"): unknown {
  const values: readonly unknown[] = args.length === 1 && Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
  if (!values.length) throw new Error(`${name}() arg is an empty sequence`);
  let best = values[0];
  for (const value of values.slice(1)) {
    const a = orderable(value);
    const b = orderable(best);
    if (typeof a !== typeof b) throw new Error("'<' not supported between instances of different types");
    if (name === "max" ? a > b : a < b) best = value;
  }
  return best;
}

/** `int()` with an optional base, matching Python's parsing rules closely. */
export function toInt(value: unknown, base?: unknown): number {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`cannot convert float ${pythonNumberText(value)} to integer`);
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const text = value.trim().replaceAll("_", "");
    const radix = base === undefined ? undefined : Math.trunc(requireNumber(base, "int()"));
    if (radix !== undefined && (radix < 2 || radix > 36)) throw new Error("int() base must be >= 2 and <= 36");
    const digits = text.replace(/^[+-]/, "").replace(/^0[xXoObB]/, "");
    const pattern = radix === undefined || radix === 10 ? /^\d+$/
      : radix === 16 ? /^[0-9a-fA-F]+$/
      : radix === 8 ? /^[0-7]+$/
      : radix === 2 ? /^[01]+$/
      : new RegExp(`^[0-9a-zA-Z]+$`);
    if (!text || !pattern.test(digits)) throw new Error(`invalid literal for int() with base ${radix ?? 10}: ${pythonRepr(value)}`);
    const parsed = radix === undefined ? Number(digits) : parseInt(digits, radix);
    if (!Number.isFinite(parsed)) throw new Error(`invalid literal for int(): ${pythonRepr(value)}`);
    return (text.startsWith("-") ? -1 : 1) * parsed;
  }
  throw new Error(`int() argument must be a string or a number, not '${typeof value}'`);
}

/** `float()`, including the infinity and NaN spellings Python accepts. */
export function toFloat(value: unknown): number {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const text = value.trim().replaceAll("_", "");
    if (/^[+-]?(inf|infinity)$/i.test(text)) return text.startsWith("-") ? -Infinity : Infinity;
    if (/^[+-]?nan$/i.test(text)) return NaN;
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) {
      throw new Error(`could not convert string to float: ${pythonRepr(value)}`);
    }
    return Number(text);
  }
  throw new Error(`float() argument must be a string or a number, not '${typeof value}'`);
}

/** Pure helper functions. `name` must exist in PURE_FUNCTIONS. */
export function pureFunction(
  name: string,
  args: readonly unknown[],
  keywords: Readonly<Record<string, unknown>> = {}
): unknown {
  switch (name) {
    case "abs": return Math.abs(requireNumber(args[0], "abs()"));
    case "all": return requireList(args[0], "all()").every(pythonTruthy);
    case "any": return requireList(args[0], "any()").some(pythonTruthy);
    case "bool": return pythonTruthy(args[0]);
    case "float": return toFloat(args[0]);
    case "int": return toInt(args[0], args[1]);
    case "len": {
      const value = args[0];
      if (typeof value === "string") return [...value].length;
      if (Array.isArray(value)) return value.length;
      if (isObject(value)) return Object.keys(value).length;
      throw new Error(`object of type '${typeof value}' has no len()`);
    }
    case "list": {
      const value = args[0];
      if (value === undefined) return [];
      if (typeof value === "string") return [...value];
      if (Array.isArray(value)) return [...(value as unknown[])];
      if (isObject(value)) return Object.keys(value);
      throw new Error(`'${typeof value}' object is not iterable`);
    }
    case "max": return extremum(args, "max");
    case "min": return extremum(args, "min");
    case "range": {
      const [first, second, third] = args.map((value) => Math.trunc(requireNumber(value, "range()")));
      const start = second === undefined ? 0 : first!;
      const stop = second === undefined ? first! : second;
      const stride = third === undefined ? 1 : third;
      if (stride === 0) throw new Error("range() arg 3 must not be zero");
      const length = Math.max(0, Math.ceil((stop - start) / stride));
      if (length > MAX_RANGE_LENGTH) throw new Error(`range() is limited to ${MAX_RANGE_LENGTH} values in Dext workflows.`);
      return Array.from({ length }, (_unused, index) => start + index * stride);
    }
    case "repr": return pythonRepr(args[0]);
    case "reversed": return [...requireList(args[0], "reversed()")].reverse();
    case "round": {
      const value = requireNumber(args[0], "round()");
      const digits = args[1] === undefined ? 0 : Math.trunc(requireNumber(args[1], "round()"));
      return pythonRound(value, digits);
    }
    case "sorted": {
      const list = requireList(args[0], "sorted()");
      const sorted = [...list].sort((left, right) => {
        const a = orderable(left);
        const b = orderable(right);
        if (typeof a !== typeof b) throw new Error("'<' not supported between instances of different types");
        return a < b ? -1 : a > b ? 1 : 0;
      });
      return keywords.reverse === true ? sorted.reverse() : sorted;
    }
    case "str": return pythonText(args[0]);
    case "sum": {
      const list = requireList(args[0], "sum()");
      const start = args[1] === undefined ? 0 : requireNumber(args[1], "sum()");
      return list.reduce<number>((total, item) => total + requireNumber(item, "sum()"), start);
    }
    default: throw new Error(`Unknown helper function '${name}'.`);
  }
}

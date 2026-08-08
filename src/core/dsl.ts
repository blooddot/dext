import type {
  ContextReference,
  InvocationArgument,
  InvocationAst,
  InvocationValue
} from "./types.js";

type TokenKind =
  | "identifier"
  | "string"
  | "number"
  | "at"
  | "dot"
  | "leftParen"
  | "rightParen"
  | "leftBracket"
  | "rightBracket"
  | "colon"
  | "comma"
  | "eof";

interface Token {
  kind: TokenKind;
  text: string;
  offset: number;
}

export class DslSyntaxError extends Error {
  constructor(
    message: string,
    readonly offset: number
  ) {
    super(message);
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let offset = 0;
  const punctuation: Record<string, TokenKind> = {
    "@": "at",
    ".": "dot",
    "(": "leftParen",
    ")": "rightParen",
    "[": "leftBracket",
    "]": "rightBracket",
    ":": "colon",
    ",": "comma"
  };

  while (offset < source.length) {
    const character = source[offset] ?? "";
    if (/\s/.test(character)) {
      offset += 1;
      continue;
    }
    const punctuator = punctuation[character];
    if (punctuator) {
      tokens.push({ kind: punctuator, text: character, offset });
      offset += 1;
      continue;
    }
    if (character === '"') {
      const start = offset;
      offset += 1;
      let value = "";
      while (offset < source.length && source[offset] !== '"') {
        if (source[offset] === "\\") {
          offset += 1;
          const escaped = source[offset];
          if (escaped === undefined) {
            throw new DslSyntaxError("Unterminated string literal.", start);
          }
          value += escaped === "n" ? "\n" : escaped;
          offset += 1;
        } else {
          value += source[offset];
          offset += 1;
        }
      }
      if (source[offset] !== '"') {
        throw new DslSyntaxError("Unterminated string literal.", start);
      }
      offset += 1;
      tokens.push({ kind: "string", text: value, offset: start });
      continue;
    }
    const rest = source.slice(offset);
    const number = /^-?(?:\d+\.?\d*|\.\d+)/.exec(rest)?.[0];
    if (number) {
      tokens.push({ kind: "number", text: number, offset });
      offset += number.length;
      continue;
    }
    const identifier = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest)?.[0];
    if (identifier) {
      tokens.push({ kind: "identifier", text: identifier, offset });
      offset += identifier.length;
      continue;
    }
    throw new DslSyntaxError(`Unexpected character '${character}'.`, offset);
  }
  tokens.push({ kind: "eof", text: "", offset: source.length });
  return tokens;
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  parse(): InvocationAst {
    const method = this.parseQualifiedName();
    this.consume("leftParen", "Expected '(' after method name.");
    const args: InvocationArgument[] = [];
    if (!this.match("rightParen")) {
      do {
        const name = this.consume("identifier", "Expected a named argument.").text;
        this.consume("colon", `Expected ':' after argument '${name}'.`);
        args.push({ name, value: this.parseValue() });
      } while (this.match("comma"));
      this.consume("rightParen", "Expected ')' after arguments.");
    }
    this.consume("eof", "Only one method invocation is allowed.");
    return { kind: "invocation", method, arguments: args, source: "code" };
  }

  private parseQualifiedName(): string {
    let value = this.consume("identifier", "Expected a method name.").text;
    while (this.match("dot")) {
      value += `.${this.consume("identifier", "Expected a name after '.'.").text}`;
    }
    return value;
  }

  private parseValue(): InvocationValue {
    const token = this.peek();
    if (token.kind === "string") {
      this.index += 1;
      return token.text;
    }
    if (token.kind === "number") {
      this.index += 1;
      return Number(token.text);
    }
    if (token.kind === "identifier" && ["true", "false"].includes(token.text)) {
      this.index += 1;
      return token.text === "true";
    }
    if (token.kind === "at") {
      return this.parseReference();
    }
    if (this.match("leftBracket")) {
      const values: InvocationValue[] = [];
      if (!this.match("rightBracket")) {
        do {
          values.push(this.parseValue());
        } while (this.match("comma"));
        this.consume("rightBracket", "Expected ']' after array values.");
      }
      return values;
    }
    throw new DslSyntaxError("Expected a string, number, boolean, array, or @reference.", token.offset);
  }

  private parseReference(): ContextReference {
    this.consume("at", "Expected '@'.");
    const name = this.consume("identifier", "Expected a reference name after '@'.");
    if (name.text === "selection" || name.text === "activeFile") {
      return { kind: name.text };
    }
    if (name.text !== "file" && name.text !== "symbol") {
      throw new DslSyntaxError(`Unknown context reference '@${name.text}'.`, name.offset);
    }
    this.consume("leftParen", `Expected '(' after '@${name.text}'.`);
    const value = this.consume("string", `Expected a string in '@${name.text}(...)'.`).text;
    this.consume("rightParen", `Expected ')' after '@${name.text}'.`);
    return name.text === "file" ? { kind: "file", path: value } : { kind: "symbol", name: value };
  }

  private peek(): Token {
    return this.tokens[this.index] ?? this.tokens[this.tokens.length - 1] ?? {
      kind: "eof",
      text: "",
      offset: 0
    };
  }

  private match(kind: TokenKind): boolean {
    if (this.peek().kind !== kind) {
      return false;
    }
    this.index += 1;
    return true;
  }

  private consume(kind: TokenKind, message: string): Token {
    const token = this.peek();
    if (token.kind !== kind) {
      throw new DslSyntaxError(message, token.offset);
    }
    this.index += 1;
    return token;
  }
}

export function parseInvocation(source: string): InvocationAst {
  return new Parser(tokenize(source)).parse();
}

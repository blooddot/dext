import { parser } from "@lezer/python";
import type { SyntaxNode } from "@lezer/common";
import { MethodRegistry } from "./registry.js";
import { compileWorkflow, fieldType, type WorkflowCompileOptions, type WorkflowValueType } from "./workflow.js";
import type { CallableDefinition, CustomApiPlan, FieldDefinition, MethodSource } from "./types.js";

export interface CustomApiFile {
  path: string;
  id: string;
  source: string;
  definition: CallableDefinition;
  imports: Map<string, string>;
  functionNode: SyntaxNode;
  functions: { definition: CallableDefinition; node: SyntaxNode }[];
  agent?: string;
  model?: string;
}

export interface CustomApiLoadResult {
  files: CustomApiFile[];
  plans: Map<string, CustomApiPlan>;
  methods: { definition: CallableDefinition; source: MethodSource }[];
  diagnostics: string[];
  blocked: boolean;
}

export type ReadConfigFile = (path: string) => Promise<string | undefined>;
export type ListConfigFiles = (root: string) => Promise<string[]>;

function children(node: SyntaxNode): SyntaxNode[] {
  const values: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) values.push(child);
  return values;
}

function text(source: string, node: SyntaxNode): string {
  return source.slice(node.from, node.to);
}

function firstNode(root: SyntaxNode, name: string): SyntaxNode | undefined {
  if (root.name === name) return root;
  for (const child of children(root)) {
    const found = firstNode(child, name);
    if (found) return found;
  }
  return undefined;
}

function collectTopLevel(root: SyntaxNode): SyntaxNode[] {
  return children(root).filter((node) => node.name !== "Comment");
}

function identifier(value: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value);
}

/** An API's name is its path below the directory it was found in, so the same
 * file laid out under `.dext/api` or under a configured directory gets the same
 * dotted id. */
export function apiIdFromPath(path: string, root?: string): string {
  const normalized = path.replace(/\\/g, "/");
  const marker = "/.dext/api/";
  const index = normalized.lastIndexOf(marker);
  const normalizedRoot = root?.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = index >= 0
    ? normalized.slice(index + marker.length)
    : normalizedRoot && normalized.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`)
      ? normalized.slice(normalizedRoot.length + 1)
      : normalized;
  const relative = base.replace(/\.dx$/i, "").replace(/^\/+/, "");
  return relative.split("/").filter(Boolean).join(".");
}

function parseType(value: string): { fieldType: FieldDefinition["type"]; multiple?: boolean; values?: string[]; resultType?: string } {
  const normalized = value.replace(/\s+/g, "");
  const union = normalized.split("|").map((item) => item.trim());
  if (union.length === 2 && union[0] === "Context" && /^list\[Context\]$/i.test(union[1]!)) {
    return { fieldType: "context", multiple: true };
  }
  if (normalized === "Context" || normalized === "context") return { fieldType: "context" };
  if (normalized === "Result" || normalized === "DextResult" || normalized === "result") return { fieldType: "result" };
  if (outputKind(normalized)) return { fieldType: "result", resultType: normalized };
  if (normalized === "str" || normalized === "string") return { fieldType: "string" };
  if (normalized === "int" || normalized === "float" || normalized === "number") return { fieldType: "number" };
  if (normalized === "bool" || normalized === "boolean") return { fieldType: "boolean" };
  if (normalized === "object" || /^dict\[str,(?:object|Any|unknown)\]$/i.test(normalized)) return { fieldType: "object" };
  const list = /^list\[(.+)\]$/i.exec(normalized);
  if (list) {
    const nested = parseType(list[1]!);
    return { ...nested, multiple: true };
  }
  const literal = /^Literal\[(.*)\]$/i.exec(value.replace(/\s+/g, ""));
  if (literal) {
    const values = [...literal[1]!.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]!);
    if (values.length) return { fieldType: "enum", values };
  }
  throw new Error(`Unsupported parameter type '${value}'.`);
}

function outputKind(value: string): CallableDefinition["output"]["kind"] | undefined {
  const name = value.replace(/\s+/g, "");
  if (name === "McpRawResult") return "mcpRaw";
  const match = /^(Chat|Agent|Explain|Edit|Review|Apply|Terminal|Print|Text|Code|Plan|Patch|Ui)Result$/.exec(name);
  return match?.[1]?.toLowerCase() as CallableDefinition["output"]["kind"] | undefined;
}

function typedDictResults(source: string): Map<string, CallableDefinition["output"]> {
  const results = new Map<string, CallableDefinition["output"]>();
  const classes = /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*TypedDict\s*\)\s*:\s*\r?\n((?:^[ \t]+[^\r\n]*(?:\r?\n|$))*)/gm;
  for (const match of source.matchAll(classes)) {
    const name = match[1]!;
    const fields: FieldDefinition[] = [];
    let kind: string | undefined;
    for (const line of match[2]!.split(/\r?\n/)) {
      const field = /^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$/.exec(line);
      if (!field) continue;
      const optional = /^NotRequired\[(.+)\]$/.exec(field[2]!.replace(/\s+/g, ""));
      const parsed = parseType(optional?.[1] ?? field[2]!);
      if (field[1] === "kind") {
        if (parsed.fieldType !== "enum" || parsed.values?.length !== 1) {
          throw new Error(`TypedDict '${name}' requires kind: Literal["..."] .`);
        }
        kind = parsed.values[0];
        continue;
      }
      fields.push({
        name: field[1]!,
        type: parsed.fieldType,
        ...(parsed.values ? { values: parsed.values } : {}),
        ...(parsed.multiple ? { multiple: true } : {}),
        required: !optional
      });
    }
    if (!kind) throw new Error(`TypedDict '${name}' requires kind: Literal["..."] .`);
    results.set(name, { kind, resultType: name, fields });
  }
  return results;
}

function functionSignature(
  source: string,
  node: SyntaxNode,
  typedResults: ReadonlyMap<string, CallableDefinition["output"]>
): { inputs: FieldDefinition[]; output: CallableDefinition["output"] } {
  const paramList = children(node).find((child) => child.name === "ParamList");
  const returnType = children(node).find((child) => child.name === "TypeDef" && text(source, child).startsWith("->"));
  if (!paramList || !returnType) throw new Error("Functions require parameter and return type annotations.");
  const inputs: FieldDefinition[] = [];
  const parts = children(paramList);
  for (let index = 0; index < parts.length; index += 1) {
    const nameNode = parts[index];
    if (nameNode?.name !== "VariableName") continue;
    if (inputs.some((field) => field.name === text(source, nameNode))) throw new Error(`Duplicate parameter '${text(source, nameNode)}'.`);
    const typeNode = parts[index + 1]?.name === "TypeDef" ? parts[index + 1] : undefined;
    if (!typeNode) throw new Error(`Parameter '${text(source, nameNode)}' requires a type annotation.`);
    const defaultNode = parts[index + 2]?.name === "AssignOp" ? parts[index + 3] : undefined;
    const parsed = parseType(text(source, typeNode).replace(/^:\s*/, ""));
    const field: FieldDefinition = {
      name: text(source, nameNode),
      type: parsed.fieldType,
      ...(parsed.resultType ? { resultType: parsed.resultType } : {}),
      ...(parsed.values ? { values: parsed.values } : {}),
      ...(parsed.multiple ? { multiple: true } : {}),
      required: !defaultNode,
      ...(defaultNode?.name === "String" ? { default: text(source, defaultNode).slice(1, -1) } : {}),
      ...(defaultNode?.name === "Number" ? { default: Number(text(source, defaultNode)) } : {}),
      ...(defaultNode?.name === "Boolean" ? { default: text(source, defaultNode) === "True" } : {}),
      ...(defaultNode?.name === "DictionaryExpression" && text(source, defaultNode).trim() === "{}" ? { default: {} } : {})
    };
    if (defaultNode && field.default === undefined) throw new Error(`Unsupported default for parameter '${field.name}'; use a string, number, boolean or empty dictionary literal.`);
    inputs.push(field);
  }
  const declared = text(source, returnType).replace(/^->\s*/, "").trim();
  const output = typedResults.get(declared) ?? ((): CallableDefinition["output"] | undefined => {
    const kind = outputKind(declared);
    return kind ? { kind } : undefined;
  })();
  if (!output) throw new Error(`Unsupported function return type '${declared}'; expected a Dext result type.`);
  return { inputs, output };
}

function parseImports(source: string, root: SyntaxNode): Map<string, string> {
  const imports = new Map<string, string>();
  for (const node of collectTopLevel(root)) {
    if (node.name !== "ImportStatement") continue;
    const raw = text(source, node);
    if (raw.startsWith("from ")) {
      const match = /^from\s+([A-Za-z_][A-Za-z0-9_.]*)\s+import\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?$/.exec(raw);
      if (match && match[1] !== "typing" && match[1] !== "typing_extensions") {
        imports.set(match[3] ?? match[2]!, `${match[1]}.${match[2]}`);
      }
    } else {
      const match = /^import\s+([A-Za-z_][A-Za-z0-9_.]*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?$/.exec(raw);
      if (match) imports.set(match[2] ?? match[1]!.split(".").at(-1)!, match[1]!);
    }
  }
  return imports;
}

function dedent(value: string): string {
  const lines = value.replace(/^\s*:\s*\r?\n/, "").split(/\r?\n/);
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  const indent = nonEmpty.length ? Math.min(...nonEmpty.map((line) => line.match(/^\s*/)?.[0].length ?? 0)) : 0;
  return lines.map((line) => line.slice(indent)).join("\n").trim();
}

function decoratorStringOption(options: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`).exec(options);
  return match?.[1];
}

/** Parse signatures separately so unsaved .dx documents can offer helper hints. */
export function functionDefinitions(source: string, tolerant = false): { definition: CallableDefinition; node: SyntaxNode }[] {
  const root = parser.parse(source).topNode;
  const results = typedDictResults(source);
  const functions: { definition: CallableDefinition; node: SyntaxNode }[] = [];
  for (const top of collectTopLevel(root)) {
    const node = top.name === "FunctionDefinition" ? top
      : top.name === "DecoratedStatement" ? children(top).find((child) => child.name === "FunctionDefinition") : undefined;
    if (!node) continue;
    try {
      if (children(node).some((child) => child.name === "async")) throw new Error("async functions are not supported in .dx files.");
      const name = children(node).find((child) => child.name === "VariableName");
      if (!name) throw new Error("Function name is missing.");
      const id = text(source, name);
      const signature = functionSignature(source, node, results);
      functions.push({ node, definition: {
        id, title: id, description: `Local Dext function ${id}.`, kind: "skill", version: "1.0.0",
        input: signature.inputs, output: signature.output, executor: { kind: "custom", apiId: id }
      } });
    } catch (error) {
      if (!tolerant) throw error;
    }
  }
  return functions;
}

function calledMethods(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return [
    ...(record.kind === "call" && typeof record.method === "string" ? [record.method] : []),
    ...Object.values(record).flatMap(calledMethods)
  ];
}

function checkCycles(graph: ReadonlyMap<string, readonly string[]>, label: string): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`${label} at '${id}'.`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of graph.get(id) ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of graph.keys()) visit(id);
}

function parseHeader(path: string, source: string, root?: string): CustomApiFile {
  const tree = parser.parse(source);
  const validateSyntax = (node: SyntaxNode): void => {
    if (node.type.isError) throw new Error(`Invalid .dx syntax near offset ${node.from}.`);
    for (const child of children(node)) validateSyntax(child);
  };
  validateSyntax(tree.topNode);
  const functions = functionDefinitions(source);
  const functionNode = functions.find((fn) => fn.definition.id === "main")?.node;
  if (!functionNode) throw new Error("A .dx API file must define main().");
  const names = new Set<string>();
  for (const fn of functions) {
    if (names.has(fn.definition.id)) throw new Error(`Duplicate function '${fn.definition.id}'.`);
    names.add(fn.definition.id);
  }
  const signature = functionSignature(source, functionNode, typedDictResults(source));
  const id = apiIdFromPath(path, root);
  if (!id || id.split(".").some((part) => !identifier(part))) throw new Error(`Invalid API path for '${path}'.`);
  const definition: CallableDefinition = {
    id,
    title: id,
    description: `Custom Dext API ${id}.`,
    kind: "skill",
    version: "1.0.0",
    input: signature.inputs,
    output: signature.output,
    executor: { kind: "custom", apiId: id }
  };
  const decorated = functionNode.parent?.name === "DecoratedStatement" ? firstNode(functionNode.parent, "Decorator") : undefined;
  const options = decorated ? text(source, decorated) : "";
  const agent = decoratorStringOption(options, "agent");
  const model = decoratorStringOption(options, "model");
  return {
    path,
    id,
    source,
    definition,
    imports: parseImports(source, tree.topNode),
    functionNode,
    functions: functions.filter((fn) => fn.definition.id !== "main"),
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {})
  };
}

function initialTypes(file: CustomApiFile): ReadonlyMap<string, WorkflowValueType> {
  const values = new Map<string, WorkflowValueType>();
  for (const field of file.definition.input) {
    values.set(field.name, fieldType(field));
  }
  return values;
}

export async function loadCustomApis(
  trusted: boolean,
  roots: readonly string[],
  listFiles: ListConfigFiles,
  readFile: ReadConfigFile,
  registry: MethodRegistry,
  source: MethodSource = "project"
): Promise<CustomApiLoadResult> {
  if (!trusted) return { files: [], plans: new Map(), methods: [], diagnostics: ["Custom .dext/api files are disabled in an untrusted workspace."], blocked: true };
  const diagnostics: string[] = [];
  const files: CustomApiFile[] = [];
  for (const root of roots) {
    let paths: string[] = [];
    try { paths = await listFiles(root); } catch (error) {
      diagnostics.push(`${root}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    for (const path of paths.filter((candidate) => candidate.toLowerCase().endsWith(".dx"))) {
      try {
        const content = await readFile(path);
        if (content === undefined) continue;
        files.push(parseHeader(path, content, root));
      } catch (error) {
        diagnostics.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const methods: CustomApiLoadResult["methods"] = [];
  const registeredIds = new Set<string>();
  for (const file of files) {
    if (registry.get(file.id)) {
      diagnostics.push(`${file.path}: API '${file.id}' is already defined.`);
      continue;
    }
    registry.register(file.definition, source);
    registeredIds.add(file.id);
    methods.push({ definition: file.definition, source });
  }
  const plans = new Map<string, CustomApiPlan>();
  const dependencyGraph = new Map<string, string[]>();
  for (const file of files) {
    if (!registeredIds.has(file.id)) continue;
    try {
      const scope = new MethodRegistry();
      for (const method of registry.list()) scope.register(method, method.source);
      const aliases = new Map<string, string>();
      for (const [alias, imported] of file.imports) {
        const isNamespace = registry.list().some((candidate) => candidate.id.startsWith(`${imported}.`));
        if (!registry.get(imported) && !isNamespace) throw new Error(`Imported API '${imported}' is not defined.`);
        aliases.set(alias, imported);
      }
      for (const fn of file.functions) {
        const name = fn.definition.id;
        if (scope.get(name) || aliases.has(name) || scope.list().some((method) => method.id.startsWith(`${name}.`))) {
          throw new Error(`Local function '${name}' conflicts with an API or import.`);
        }
        scope.register(fn.definition, source);
      }
      const localNames = new Set(file.functions.map((fn) => fn.definition.id));
      const localGraph = new Map<string, string[]>();
      const dependencies: string[] = [];
      const compileFunction = (definition: CallableDefinition, node: SyntaxNode): CustomApiPlan => {
        const name = definition.id === file.id ? "main" : definition.id;
        const body = children(node).find((child) => child.name === "Body");
        if (!body) throw new Error(`${name}() requires a function body.`);
        const bodySource = dedent(file.source.slice(body.from, body.to));
        const options: WorkflowCompileOptions = {
          allowReturn: true,
          allowNestedCalls: true,
          allowImports: true,
          aliases,
          initialVariables: initialTypes({ ...file, definition }),
          customApiIds: new Set(files.map((candidate) => candidate.id))
        };
        const compiled = compileWorkflow(bodySource, scope, options);
        const outputType = compiled.returnType;
        if (!compiled.program || !compiled.program.returnExpression || !outputType) {
          const details = compiled.diagnostics
            .filter((diagnostic) => diagnostic.severity === "error")
            .map((diagnostic) => diagnostic.message)
            .join(" ");
          throw new Error(`${name}() must return a Dext result.${details ? ` ${details}` : ""}`);
        }
        const expected = definition.output.kind;
        if (
          !definition.output.fields
          && (outputType.kind !== "result" || outputType.name.toLowerCase() !== `${expected}result`)
        ) {
          throw new Error(`${name}() must return ${expected} result.`);
        }
        if (compiled.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
          throw new Error(compiled.diagnostics.map((diagnostic) => diagnostic.message).join(" "));
        }
        const calls = calledMethods(compiled.program);
        localGraph.set(name, calls.filter((id) => localNames.has(id)));
        dependencies.push(...calls.filter((id) => !localNames.has(id) && registry.get(id)?.executor.kind === "custom"));
        return {
          id: definition.id,
          sourcePath: file.path,
          parameters: definition.input.map((field) => field.name),
          program: compiled.program,
          returnExpression: compiled.program.returnExpression,
          ...(file.agent ? { agent: file.agent } : {}),
          ...(file.model ? { model: file.model } : {})
        };
      };
      const plan = compileFunction(file.definition, file.functionNode);
      const functions = file.functions.map((fn) => ({ definition: fn.definition, program: compileFunction(fn.definition, fn.node).program }));
      checkCycles(localGraph, "Recursive local function call detected");
      dependencyGraph.set(file.id, dependencies);
      plans.set(file.id, { ...plan, ...(functions.length ? { functions } : {}) });
    } catch (error) {
      diagnostics.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try {
    checkCycles(dependencyGraph, "Circular custom API call detected");
  } catch (error) {
    diagnostics.push(error instanceof Error ? error.message : String(error));
    plans.clear();
  }
  return { files, plans, methods, diagnostics, blocked: false };
}

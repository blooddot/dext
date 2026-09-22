import { parser } from "@lezer/python";
import type { SyntaxNode } from "@lezer/common";
import { MethodRegistry } from "./registry.js";
import { compileWorkflow, fieldType, type WorkflowCompileOptions, type WorkflowValueType } from "./workflow.js";
import type { CallableDefinition, CustomApiPlan, FieldDefinition, MethodSource } from "./types.js";
import { ApiSourceError, apiBodySource, formatDiagnostic, type DextDiagnostic } from "./apiDiagnostic.js";

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
  diagnosticDetails: DextDiagnostic[];
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
  if (/^Ui(?:Select|Radio|Checkbox|Input|Confirm|Alert|Form)Result$/.test(name)) return "ui";
  const match = /^(Ask|Plan|Skill|Agent|Template|Apply|Terminal|Print|Patch|Ui)Result$/.exec(name);
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
    return kind ? { kind, ...(kind === "ui" && declared !== "UiResult" ? { resultType: declared } : {}) } : undefined;
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
      if (!tolerant) throw new ApiSourceError(error instanceof Error ? error.message : String(error), node.from, source.indexOf("\n", node.from) < 0 ? node.to : source.indexOf("\n", node.from));
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

/** Returns the ids on the first cycle found, or undefined when the graph is acyclic. */
function findCycle(graph: ReadonlyMap<string, readonly string[]>): string[] | undefined {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const search = (id: string): string[] | undefined => {
    if (visiting.has(id)) return [...stack.slice(stack.indexOf(id)), id];
    if (visited.has(id)) return undefined;
    visiting.add(id);
    stack.push(id);
    for (const dependency of graph.get(id) ?? []) {
      const cycle = search(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return undefined;
  };
  for (const id of graph.keys()) {
    const cycle = search(id);
    if (cycle) return cycle;
  }
  return undefined;
}

function checkCycles(graph: ReadonlyMap<string, readonly string[]>, label: string): void {
  const cycle = findCycle(graph);
  if (cycle) throw new Error(`${label} at '${cycle[0]}'.`);
}

function parseHeader(path: string, source: string, root?: string): CustomApiFile {
  const tree = parser.parse(source);
  const validateSyntax = (node: SyntaxNode): void => {
    if (node.type.isError) throw new ApiSourceError(`Invalid .dx syntax near offset ${node.from}.`, node.from, node.to, "dext/syntax");
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
  if (!trusted) return { files: [], plans: new Map(), methods: [], diagnostics: ["Custom .dext/api files are disabled in an untrusted workspace."], diagnosticDetails: [], blocked: true };
  const diagnostics: string[] = [];
  const diagnosticDetails: DextDiagnostic[] = [];
  // `diagnostics` stays the flat, human-readable view every consumer already
  // reads; `diagnosticDetails` is the same data with its file coordinates, so a
  // consumer that needs a squiggle never has to re-parse a message.
  const report = (path: string, error: unknown, file?: CustomApiFile, code = "dext/api", source = file?.source): void => {
    const message = error instanceof Error ? error.message : String(error);
    const diagnostic: DextDiagnostic = {
      path, ...(file ? { apiId: file.id } : {}), severity: "error", message,
      code: error instanceof ApiSourceError ? error.code : code,
      from: error instanceof ApiSourceError ? error.from : file?.functionNode.from ?? 0,
      to: error instanceof ApiSourceError ? error.to : (file?.functionNode.from ?? 0) + 1
    };
    diagnosticDetails.push(diagnostic);
    diagnostics.push(formatDiagnostic(diagnostic, source));
  };
  const files: CustomApiFile[] = [];
  const seenPaths = new Set<string>();
  for (const root of roots) {
    let paths: string[] = [];
    try { paths = await listFiles(root); } catch (error) {
      report(root, error, undefined, "dext/read");
      continue;
    }
    for (const path of paths.filter((candidate) => candidate.toLowerCase().endsWith(".dx"))) {
      if (seenPaths.has(path)) continue;
      seenPaths.add(path);
      let content: string | undefined;
      try {
        content = await readFile(path);
        if (content === undefined) continue;
        files.push(parseHeader(path, content, root));
      } catch (error) {
        // A signature error has no authored position, so the position comes
        // from the file text this read already produced.
        report(path, error, undefined, "dext/api", content);
      }
    }
  }
  const methods: CustomApiLoadResult["methods"] = [];
  const registeredFiles = new Set<CustomApiFile>();
  for (const file of files) {
    if (registry.get(file.id)) {
      report(file.path, `API '${file.id}' is already defined.`, file, "dext/duplicate-api");
      continue;
    }
    registry.register(file.definition, source);
    registeredFiles.add(file);
    methods.push({ definition: file.definition, source });
  }
  const plans = new Map<string, CustomApiPlan>();
  const dependencyGraph = new Map<string, string[]>();
  for (const file of files) {
    if (!registeredFiles.has(file)) continue;
    try {
      const scope = new MethodRegistry();
      for (const method of registry.list()) scope.register(method, method.source);
      const aliases = new Map<string, string>();
      for (const [alias, imported] of file.imports) {
        const isNamespace = registry.list().some((candidate) => candidate.id.startsWith(`${imported}.`));
        if (!registry.get(imported) && !isNamespace) {
          // `from common import ask` comes from an older example. Built-in APIs are
          // always in scope and never need an import, so point at the direct call.
          const builtin = imported.startsWith("common.") ? imported.slice("common.".length) : "";
          const hint = builtin && registry.get(builtin)?.source === "builtin" ? ` Built-in APIs are always in scope; call ${builtin}() directly.` : "";
          throw new Error(`Imported API '${imported}' is not defined.${hint}`);
        }
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
      const compileFunction = (definition: CallableDefinition, node: SyntaxNode): CustomApiPlan | undefined => {
        const name = definition.id === file.id ? "main" : definition.id;
        const body = children(node).find((child) => child.name === "Body");
        if (!body) throw new Error(`${name}() requires a function body.`);
        const bodySource = apiBodySource(file.source.slice(body.from, body.to), body.from);
        const options: WorkflowCompileOptions = {
          allowReturn: true,
          allowNestedCalls: true,
          allowImports: true,
          aliases,
          initialVariables: initialTypes({ ...file, definition }),
          customApiIds: new Set(files.map((candidate) => candidate.id))
        };
        const compiled = compileWorkflow(bodySource.source, scope, options);
        for (const diagnostic of compiled.diagnostics) {
          // The compiler only knows the function body it was handed, so the
          // enclosing function is named here: "which function in this file" is
          // the first thing a reader of the error needs.
          const message = diagnostic.message.includes(`${name}()`)
            ? diagnostic.message
            : `${name}(): ${diagnostic.message}`;
          const detail: DextDiagnostic = { ...diagnostic, message, code: diagnostic.code ?? "dext/compile", path: file.path, apiId: file.id, from: bodySource.offset(diagnostic.from), to: bodySource.offset(diagnostic.to) };
          diagnosticDetails.push(detail);
          diagnostics.push(formatDiagnostic(detail, file.source));
        }
        if (compiled.diagnostics.some((diagnostic) => diagnostic.severity === "error")) return undefined;
        const outputType = compiled.returnType;
        if (!compiled.program || !compiled.program.returnExpression || !outputType) {
          report(file.path, new ApiSourceError(`${name}() must return a Dext result.`, node.from, body.from, "dext/must-return"), file);
          return undefined;
        }
        const expected = definition.output.kind;
        if (definition.output.resultType && !definition.output.fields && (outputType.kind !== "result" || outputType.name !== definition.output.resultType)) {
          report(file.path, new ApiSourceError(`${name}() must return ${definition.output.resultType}.`, node.from, body.from, "dext/return-type"), file);
          return undefined;
        }
        if (
          !definition.output.fields
          // Result kinds are camelCase (`mcpRaw`) while result type names are
          // PascalCase (`McpRawResult`), so compare the two case-insensitively.
          && (outputType.kind !== "result" || (outputType.name.toLowerCase() !== `${expected}result`.toLowerCase() && !(expected === "ui" && /^Ui(?:Select|Radio|Checkbox|Input|Confirm|Alert|Form)Result$/.test(outputType.name))))
        ) {
          report(file.path, new ApiSourceError(`${name}() must return ${expected} result.`, node.from, body.from, "dext/return-type"), file);
          return undefined;
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
      const functions: NonNullable<CustomApiPlan["functions"]> = [];
      for (const fn of file.functions) {
        const compiled = compileFunction(fn.definition, fn.node);
        if (compiled) functions.push({ definition: fn.definition, program: compiled.program });
      }
      if (!plan || functions.length !== file.functions.length) continue;
      checkCycles(localGraph, "Recursive local function call detected");
      dependencyGraph.set(file.id, dependencies);
      plans.set(file.id, { ...plan, ...(functions.length ? { functions } : {}) });
    } catch (error) {
      report(file.path, error, file);
    }
  }
  // Report a dependency cycle only on the APIs it involves: blaming every loaded
  // API would put the same error on files that are perfectly fine.
  const cycle = findCycle(dependencyGraph);
  if (cycle) {
    const message = `Circular custom API call detected: ${cycle.join(" -> ")}.`;
    const members = new Set(cycle);
    for (const file of registeredFiles) if (members.has(file.id)) report(file.path, message, file, "dext/cycle");
    plans.clear();
  }
  return { files, plans, methods, diagnostics, diagnosticDetails, blocked: false };
}

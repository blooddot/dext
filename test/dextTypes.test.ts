import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { dextFiles, dextModuleDeclaration, dextSharedDeclaration, dextTsconfig, dextTypesDocument } from "../src/core/dextApiTypes.js";
import { parseMcpManifest } from "../src/core/mcpManifest.js";
import { methodResultType } from "../src/core/methodSignature.js";

/**
 * Decision (recorded for the kernel/editor contract): Dext keeps Node's native
 * **strip** semantics and does not switch to `--experimental-transform-types`.
 *
 * The kernel's loader calls `module.stripTypeScriptTypes(source, { mode: "strip" })`.
 * That is the same rule tsserver enforces for the workspace through
 * `erasableSyntaxOnly: true` in the generated `.dext/tsconfig.json`, so the
 * editor and the runtime agree on what a valid run file is. Constructs that
 * need emitted runtime code — `enum`, `namespace` with runtime members, and
 * parameter properties — are rejected with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`,
 * which `src/runner/dextLoader.mjs` passes to the caller unchanged.
 *
 * `--experimental-transform-types` (or `mode: "transform"`) would instead
 * rewrite those constructs into runtime helpers. Dext deliberately does not do
 * that: run files are plain TypeScript whose only output is what the kernel
 * records, and silently injecting helpers would make the run differ from what
 * the editor type-checked.
 */

const run = promisify(execFile);
const script = resolve("scripts", "generateDextTypes.mjs");
const tsc = resolve("node_modules", "typescript", "bin", "tsc");
const roots: string[] = [];

/** Type-checks a generated workspace project exactly as the editor's service does. */
async function typecheckWorkspace(root: string): Promise<void> {
  await run(process.execPath, [tsc, "-p", join(root, ".dext", "tsconfig.json"), "--noEmit"]);
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

async function tempWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dext-types-"));
  roots.push(root);
  return root;
}

interface ExecFailure {
  code?: number;
  stdout: string;
  stderr: string;
}

describe("generated Dext TypeScript surface", () => {
  it("declares every built-in API in the dext module", () => {
    const declaration = dextModuleDeclaration();
    expect(declaration).toContain('declare module "dext"');
    for (const method of BUILTIN_METHODS) {
      expect(declaration, `missing ${method.id}`).toContain(method.id);
      expect(declaration, `missing result type of ${method.id}`).toContain(`Promise<${methodResultType(method)}>`);
    }
    expect(declaration).toContain("export const ui:");
    expect(declaration).toContain("export const mcp:");
    expect(declaration).toContain("mcp.<server>.<tool>");
    expect(declaration).toContain("JSON-serializable");
  });

  it("never mentions PrintResult and only uses PatchResult for AgentResult.patch", () => {
    const declaration = dextModuleDeclaration();
    expect(declaration).not.toContain("PrintResult");
    expect([...declaration.matchAll(/PatchResult/g)]).toHaveLength(2);
    expect(declaration).toContain("export interface PatchResult {");
    expect(declaration).toContain("patch?: PatchResult;");
    expect(declaration).not.toContain("Promise<PatchResult>");
  });

  it("derives result shapes from the registry and the type catalog", () => {
    const types = dextTypesDocument();
    for (const name of ["AskResult", "TerminalResult", "AgentResult", "McpRawResult", "PatchChange", "PatchResult", "UiSelectResult", "UiFormResult"]) {
      expect(types, `missing ${name}`).toContain(`interface ${name}`);
    }
    expect(types).toContain("export interface AgentResult {");
    expect(types).toContain("export type DextResult = ");
  });

  it("writes api/dext.d.ts, tsconfig.json and the ESM marker", () => {
    const files = dextFiles();
    expect(files.map((file) => file.path)).toEqual(["api/dext.d.ts", "tsconfig.json", "package.json"]);
    expect(files[0]!.content).toBe(dextSharedDeclaration());
    expect(files[1]!.content).toBe(dextTsconfig());
    // Without `"type": "module"` tsserver would read runs/*.ts as CommonJS and
    // reject the top-level `await` the kernel supports.
    expect(JSON.parse(files[2]!.content)).toEqual({ type: "module" });
  });

  it("names a project's own MCP servers and their tools", () => {
    const manifest = parseMcpManifest(JSON.stringify({
      name: "docs",
      transport: "stdio",
      command: "my-docs-mcp",
      tools: [{
        name: "read",
        description: "Read a document",
        inputSchema: { type: "object", properties: { uri: { type: "string" }, limit: { type: "integer" } }, required: ["uri"] },
        outputSchema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] }
      }, {
        // No output schema: the runtime returns the raw envelope.
        name: "ping",
        description: "Check the server",
        inputSchema: { type: "object", properties: {} }
      }]
    }), "docs.jsonc");
    const declaration = dextModuleDeclaration(manifest.methods);
    expect(declaration).toContain("export interface DocsReadResult {");
    expect(declaration).toContain('kind: "mcp.docs.read";');
    expect(declaration).toContain("read(options?: Record<string, unknown>): Promise<DocsReadResult>;");
    expect(declaration).toContain("ping(options?: Record<string, unknown>): Promise<McpRawResult>;");
    // The argument contract the widened parameter cannot express rides the hover text.
    expect(declaration).toContain("Arguments: uri: string, limit?: number");
    // The floor keeps a globally configured server callable — walked segment by
    // segment, like the runtime proxy — so its result is the whole union, and the
    // named tools are added to it.
    expect(declaration).toContain("type McpTool = ((options?: Record<string, unknown>) => Promise<DextResult>) & { [segment: string]: McpTool };");
    expect(declaration).toContain("export const mcp: { [server: string]: McpTool } & {");
    expect(declaration).toMatch(/export type DextResult = [^;]*DocsReadResult[^;]*;/);
    // A server or tool name that is not an identifier is quoted, not dropped.
    const dashed = parseMcpManifest(JSON.stringify({
      name: "teambition-user",
      transport: "stdio",
      command: "tb",
      tools: [{ name: "list-tasks", inputSchema: { type: "object", properties: {} }, outputSchema: { type: "object", properties: { id: { type: "string" } } } }]
    }), "tb.jsonc");
    const dashedDeclaration = dextModuleDeclaration(dashed.methods);
    expect(dashedDeclaration).toContain('"teambition-user": {');
    expect(dashedDeclaration).toContain('"list-tasks"(options?: Record<string, unknown>): Promise<TeambitionUserListTasksResult>;');
  });

  it("types a tool whose name contains a dot under the spelling the runtime resolves", async () => {
    // The kernel resolves `mcp.<server>.<tool>` by joining the property names it was
    // reached through, so the declaration nests by the id's own segments: a tool named
    // `b.c` is called as `mcp.docs.b.c`, and a name that is not an identifier is quoted
    // and reached with brackets instead.
    const root = await tempWorkspace();
    const manifest = parseMcpManifest(JSON.stringify({
      name: "docs",
      transport: "stdio",
      command: "my-docs-mcp",
      tools: [{
        name: "b.c",
        description: "Nested name",
        inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "object", properties: { nested: { type: "string" } }, required: ["nested"] }
      }, {
        // Declared both as a tool and as a step toward `b.c`.
        name: "b",
        description: "Prefix tool",
        inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "object", properties: { prefix: { type: "string" } }, required: ["prefix"] }
      }]
    }), join(root, ".dext", "mcp", "docs.jsonc"));
    const declaration = dextModuleDeclaration(manifest.methods);
    expect(declaration).toContain("export interface DocsBCResult {");
    expect(declaration).toContain("export interface DocsBResult {");
    // The node is a member that is callable *and* has children; the consumer below is
    // what proves both live under `b`.
    expect(declaration).toMatch(/\n\s+b: \{/);
    expect(declaration).toContain("(options?: Record<string, unknown>): Promise<DocsBResult>;");
    expect(declaration).toContain("c(options?: Record<string, unknown>): Promise<DocsBCResult>;");

    const directory = join(root, ".dext");
    for (const file of dextFiles(manifest.methods)) {
      const target = join(directory, ...file.path.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content, "utf8");
    }
    const consumer = join(directory, "api", "consumer.ts");
    await writeFile(consumer, [
      'import { mcp } from "dext";',
      "",
      "const nested = await mcp.docs.b.c({});",
      "console.log(nested.nested);",
      "const prefix = await mcp.docs.b({});",
      "console.log(prefix.prefix);",
      ""
    ].join("\n"), "utf8");
    await expect(typecheckWorkspace(root)).resolves.toBeUndefined();
  }, 60_000);

  it("keeps two tools that render the same result name apart", () => {
    // The runtime names a tool's result from its server and tool, so `a-b` + `c` and
    // `a` + `b-c` both render `ABCResult`. One shared interface would describe the wrong
    // fields for one of them.
    const manifest = (server: string, tool: string, field: string): string => JSON.stringify({
      name: server,
      transport: "stdio",
      command: "fixture-mcp",
      tools: [{
        name: tool,
        inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "object", properties: { [field]: { type: "string" } }, required: [field] }
      }]
    });
    const first = parseMcpManifest(manifest("a-b", "c", "one"), "one.jsonc");
    const second = parseMcpManifest(manifest("a", "b-c", "two"), "two.jsonc");
    const declaration = dextModuleDeclaration([...first.methods, ...second.methods]);
    expect(declaration).toContain("export interface ABCResult {");
    expect(declaration).toContain("export interface ABCResultMcpABC {");
    expect(declaration).toContain("  one: string;");
    expect(declaration).toContain("  two: string;");
    // Each tool returns its own interface, not the first one's.
    expect(declaration).toMatch(/ c\(options\?: Record<string, unknown>\): Promise<ABCResult>;/);
    expect(declaration).toMatch(/ "b-c"\(options\?: Record<string, unknown>\): Promise<ABCResultMcpABC>;/);
    expect(declaration).toMatch(/export type DextResult = [^;]*ABCResultMcpABC[^;]*;/);
  });

  it("compiles a manifest whose names do not form an identifier", async () => {
    // `resultTypeName("1", "2")` is `12Result`, which is not a type name — emitting it
    // would break the committed declaration, so it is qualified.
    const root = await tempWorkspace();
    const manifest = parseMcpManifest(JSON.stringify({
      name: "1",
      transport: "stdio",
      command: "fixture-mcp",
      tools: [{
        name: "2",
        description: "Numbered tool",
        inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "object", properties: { pong: { type: "string" } }, required: ["pong"] }
      }]
    }), join(root, ".dext", "mcp", "digits.jsonc"));
    expect(dextModuleDeclaration(manifest.methods)).not.toMatch(/interface \d/);
    const directory = join(root, ".dext");
    for (const file of dextFiles(manifest.methods)) {
      const target = join(directory, ...file.path.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content, "utf8");
    }
    const consumer = join(directory, "api", "digits.ts");
    await writeFile(consumer, [
      'import { mcp } from "dext";',
      "",
      'const pong = await mcp["1"]["2"]({});',
      "console.log(pong.pong);",
      ""
    ].join("\n"), "utf8");
    await expect(typecheckWorkspace(root)).resolves.toBeUndefined();
  }, 60_000);

  it("declares a tool once when two directories declare it", () => {
    const manifest = parseMcpManifest(JSON.stringify({
      name: "docs",
      transport: "stdio",
      command: "my-docs-mcp",
      tools: [{
        name: "read",
        description: "Read a document",
        inputSchema: { type: "object", properties: { uri: { type: "string" } }, required: ["uri"] },
        outputSchema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] }
      }]
    }), "docs.jsonc");
    const declaration = dextModuleDeclaration([...manifest.methods, ...manifest.methods]);
    expect([...declaration.matchAll(/read\(options\?: Record<string, unknown>\)/g)]).toHaveLength(1);
    expect([...declaration.matchAll(/export interface DocsReadResult \{/g)]).toHaveLength(1);
  });

  it("leaves a workspace without manifests on the raw MCP proxy", () => {
    // The shape every project without MCP manifests has always seen: `structured`
    // stays reachable without narrowing.
    const declaration = dextModuleDeclaration();
    expect(declaration).toContain("export const mcp: { [server: string]: { [tool: string]: (options?: Record<string, unknown>) => Promise<McpRawResult> } };");
    expect(declaration).not.toContain("DextResult> };");
  });

  it("keeps exactly one declaration in the generated project", () => {
    const files = dextFiles();
    expect(files.map((file) => file.path)).toEqual(["api/dext.d.ts", "tsconfig.json", "package.json"]);
    expect(files[0]!.content).toBe(dextSharedDeclaration());
    expect(files[1]!.content).toBe(dextTsconfig());
    // Without `"type": "module"` tsserver would read runs/*.ts as CommonJS and
    // reject the top-level `await` the kernel supports.
    expect(JSON.parse(files[2]!.content)).toEqual({ type: "module" });
    const config = JSON.parse(files[1]!.content) as { compilerOptions: { paths: Record<string, string[]> } };
    // The mapping is relative, so the three files can be committed and shared.
    expect(config.compilerOptions.paths.dext).toEqual(["./api/dext.d.ts"]);
    expect(JSON.stringify(files)).not.toContain(":/");
  });

  it("sets erasableSyntaxOnly and nodenext in the generated tsconfig", () => {
    const config = JSON.parse(dextTsconfig()) as {
      compilerOptions: Record<string, unknown>;
      include: string[];
    };
    expect(config.compilerOptions.strict).toBe(true);
    expect(config.compilerOptions.erasableSyntaxOnly).toBe(true);
    expect(config.compilerOptions.module).toBe("nodenext");
    expect(config.compilerOptions.moduleResolution).toBe("nodenext");
    expect(config.compilerOptions.target).toBe("es2022");
    expect(config.compilerOptions.noEmit).toBe(true);
    expect(config.compilerOptions.allowImportingTsExtensions).toBe(true);
    expect(config.compilerOptions.types).toEqual([]);
    expect(config.compilerOptions.paths).toEqual({
      dext: ["./api/dext.d.ts"],
      "dext/api/*": ["./api/*.ts", "./api/*.mts", "./api/*/index.ts"]
    });
    // A run buffer lives in Dext's storage, so the project holds only its APIs.
    expect(config.include).toEqual(["api/**/*.ts"]);
  });

  it("passes --check when the on-disk .dext directory is up to date", { timeout: 60_000 }, async () => {
    const root = await tempWorkspace();
    await run(process.execPath, [script, "--workspace", root]);
    const result = await run(process.execPath, [script, "--workspace", root, "--check"]);
    expect(result.stdout).toContain("up to date");
  });

  it("compiles the skeleton we generate, and rejects a bare result annotation", async () => {
    // A result interface is exported by the `dext` module, not declared globally, so
    // `Promise<AskResult>` only compiles when the type is imported. The recorder and
    // the `.dx` codemod both emit that import; this proves it against a real tsc.
    const root = await tempWorkspace();
    await run(process.execPath, [script, "--workspace", root]);
    const api = join(root, ".dext", "api", "sample.ts");
    const body = [
      "export async function main(input: string): Promise<AskResult> {",
      "  return await ask({ input });",
      "}",
      ""
    ].join("\n");
    await writeFile(api, ['import { ask, type AskResult } from "dext";', "", body].join("\n"), "utf8");
    await expect(typecheckWorkspace(root)).resolves.toBeUndefined();

    await writeFile(api, ['import { ask } from "dext";', "", body].join("\n"), "utf8");
    const failure = await typecheckWorkspace(root).then(
      () => undefined,
      (error: unknown) => error as ExecFailure
    );
    expect(failure).toBeDefined();
    expect(`${failure!.stdout}${failure!.stderr}`).toContain("Cannot find name 'AskResult'");
  }, 60_000);

  it("resolves dext/api/<id> imports the way the kernel loader does", async () => {
    // `import { main } from "dext/api/team/analyze"` is the documented way to call
    // another API module, and the kernel loader resolves it from the file stem. The
    // project resolves modules like Node (`nodenext`), which never guesses a missing
    // extension, so the `paths` substitution itself has to name one: with `./api/*`
    // every such import was `Cannot find module`.
    const root = await tempWorkspace();
    await run(process.execPath, [script, "--workspace", root]);
    const directory = join(root, ".dext", "api", "team");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "analyze.ts"),
      ['import { ask, type AskResult } from "dext";', "", "export async function main(): Promise<AskResult> {", '  return await ask({ input: "explain" });', "}", ""].join("\n"),
      "utf8"
    );
    await writeFile(
      join(directory, "index.ts"),
      ['export async function main(): Promise<string> {', '  return "index";', "}", ""].join("\n"),
      "utf8"
    );
    await writeFile(
      join(root, ".dext", "api", "consumer.ts"),
      [
        'import { main as analyze } from "dext/api/team/analyze";',
        'import { main as fromIndex } from "dext/api/team";',
        "",
        "console.log(await analyze(), await fromIndex());",
        ""
      ].join("\n"),
      "utf8"
    );
    await expect(typecheckWorkspace(root)).resolves.toBeUndefined();
  }, 60_000);

  it("type-checks a project's MCP calls against its own manifest", async () => {
    // The declaration a project commits is generated from the project's manifests, so
    // `mcp.docs.read(...)` is typed even though the built-in registry knows nothing
    // about that server, and an unlisted server stays callable through the floor.
    const root = await tempWorkspace();
    const manifest = parseMcpManifest(JSON.stringify({
      name: "docs",
      transport: "stdio",
      command: "my-docs-mcp",
      tools: [{
        name: "read",
        description: "Read a document",
        inputSchema: { type: "object", properties: { uri: { type: "string" } }, required: ["uri"] },
        outputSchema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] }
      }]
    }), join(root, ".dext", "mcp", "docs.jsonc"));
    const directory = join(root, ".dext");
    for (const file of dextFiles(manifest.methods)) {
      const target = join(directory, ...file.path.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content, "utf8");
    }
    const consumer = join(directory, "api", "consumer.ts");
    const body = [
      'import { mcp } from "dext";',
      "",
      'const document = await mcp.docs.read({ uri: "README.md" });',
      "console.log(document.content);",
      "const raw = await mcp.personal.someTool({ anything: 1 });",
      'if (raw.kind === "mcpRaw") console.log(raw.structured);',
      ""
    ].join("\n");
    await writeFile(consumer, body, "utf8");
    await expect(typecheckWorkspace(root)).resolves.toBeUndefined();

    // The named tool returns the manifest's shape rather than `any`.
    await writeFile(consumer, `${body}console.log(document.missing);\n`, "utf8");
    const failure = await typecheckWorkspace(root).then(
      () => undefined,
      (error: unknown) => error as ExecFailure
    );
    expect(failure).toBeDefined();
    expect(`${failure!.stdout}${failure!.stderr}`).toContain("Property 'missing' does not exist");
  }, 60_000);

  it("accepts a checkout that handed the generated files back as CRLF", { timeout: 60_000 }, async () => {
    // `core.autocrlf` turns the committed LF into CRLF on checkout, which is not a
    // reason to call the project out of date — or to rewrite it on every reload.
    const root = await tempWorkspace();
    await run(process.execPath, [script, "--workspace", root]);
    for (const path of ["api/dext.d.ts", "tsconfig.json", "package.json"]) {
      const file = join(root, ".dext", path);
      await writeFile(file, (await readFile(file, "utf8")).replace(/\n/g, "\r\n"), "utf8");
    }
    const result = await run(process.execPath, [script, "--workspace", root, "--check"]);
    expect(result.stdout).toContain("up to date");
  });

  it("maps the API directories a project configures", async () => {
    // The kernel resolves `dext/api/<id>` against `.dext/api` plus the project's own
    // `apiDirs`, so the generated project has to map those too — relatively, because
    // the file is committed — and `--check` has to read the same settings.
    const root = await tempWorkspace();
    await mkdir(join(root, ".dext", "api"), { recursive: true });
    await writeFile(join(root, ".dext", "project.json"), `${JSON.stringify({
      version: 22,
      paths: { planDirectory: ".dext/plans", apiDirs: [".dext/api", "tools/api"], skillDirs: [], mcpDirs: [".dext/mcp"] }
    }, null, 2)}\n`, "utf8");
    await mkdir(join(root, "tools", "api"), { recursive: true });
    await writeFile(join(root, "tools", "api", "greet.ts"), [
      'import { ask, type AskResult } from "dext";',
      "",
      "export async function main(): Promise<AskResult> {",
      '  return await ask({ input: "hello" });',
      "}",
      ""
    ].join("\n"), "utf8");
    await writeFile(join(root, ".dext", "api", "consumer.ts"), [
      'import { main as greet } from "dext/api/greet";',
      "",
      "console.log((await greet()).text);",
      ""
    ].join("\n"), "utf8");
    await run(process.execPath, [script, "--workspace", root]);
    const config = JSON.parse(await readFile(join(root, ".dext", "tsconfig.json"), "utf8")) as {
      compilerOptions: { paths: Record<string, string[]> };
    };
    expect(config.compilerOptions.paths["dext/api/*"]).toContain("../tools/api/*.ts");
    await expect(typecheckWorkspace(root)).resolves.toBeUndefined();
    const result = await run(process.execPath, [script, "--workspace", root, "--check"]);
    expect(result.stdout).toContain("up to date");
  }, 60_000);

  it("skips an API directory a committed file cannot name", () => {
    // Absolute paths and anything climbing out of the workspace are machine-specific,
    // and `.dext` itself holds no APIs.
    const config = JSON.parse(dextTsconfig(undefined, [".dext/api", "C:/elsewhere/api", "../outside", ".dext", "./tools/api/"])) as {
      compilerOptions: { paths: Record<string, string[]> };
    };
    expect(config.compilerOptions.paths["dext/api/*"]).toEqual([
      "./api/*.ts", "./api/*.mts", "./api/*/index.ts",
      "../tools/api/*.ts", "../tools/api/*.mts", "../tools/api/*/index.ts"
    ]);
  });

  it("reads the MCP directories a project's settings add", async () => {
    // The extension searches `.dext/mcp` plus the project's own `mcpDirs`, and the
    // committed declaration has to be the same text it writes — so `--check` has to
    // read those settings too, or a project that moved its manifests fails its CI.
    const root = await tempWorkspace();
    await mkdir(join(root, ".dext"), { recursive: true });
    await writeFile(join(root, ".dext", "project.json"), `${JSON.stringify({
      version: 22,
      paths: { planDirectory: ".dext/plans", apiDirs: [".dext/api"], skillDirs: [".dext/skills"], mcpDirs: [".dext/mcp", "tools/mcp"] }
    }, null, 2)}\n`, "utf8");
    const tools = join(root, "tools", "mcp");
    await mkdir(tools, { recursive: true });
    await writeFile(join(tools, "extra.jsonc"), JSON.stringify({
      name: "extra",
      transport: "stdio",
      command: "extra-mcp",
      tools: [{
        name: "lookup",
        description: "Look something up",
        inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] }
      }]
    }), "utf8");
    await run(process.execPath, [script, "--workspace", root]);
    const declaration = await readFile(join(root, ".dext", "api", "dext.d.ts"), "utf8");
    expect(declaration).toContain("ExtraLookupResult");
    expect(declaration).toContain("lookup(options?: Record<string, unknown>): Promise<ExtraLookupResult>;");
    const result = await run(process.execPath, [script, "--workspace", root, "--check"]);
    expect(result.stdout).toContain("up to date");
  }, 60_000);

  it("reports a mismatch after a manual edit to a temp .dext directory", { timeout: 60_000 }, async () => {
    const root = await tempWorkspace();
    await run(process.execPath, [script, "--workspace", root]);
    const target = join(root, ".dext", "api", "dext.d.ts");
    await writeFile(target, `${await readFile(target, "utf8")}\n// tampered\n`, "utf8");
    const failure = await run(process.execPath, [script, "--workspace", root, "--check"]).then(
      () => undefined,
      (error: unknown) => error as ExecFailure
    );
    expect(failure).toBeDefined();
    expect(failure!.code).toBe(1);
    const output = `${failure!.stdout}${failure!.stderr}`;
    expect(output).toContain("out of date");
    expect(output).toContain("differs");
  });
});

describe("erasable syntax boundary", () => {
  it("rejects the enum fixture with the native code and a readable message", async () => {
    const source = await readFile(resolve("test", "fixtures", "languageEnum.ts"), "utf8");
    expect(source).toMatch(/\benum\b/);
    expect(source).toContain("DEFAULT_PHASE_LABEL");
    const failure = (() => {
      try {
        stripTypeScriptTypes(source, { mode: "strip" });
        return undefined;
      } catch (error: unknown) {
        return error as { code?: string; message: string };
      }
    })();
    expect(failure).toBeDefined();
    expect(failure!.code).toBe("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");
    expect(failure!.message).toMatch(/enum/i);
  });

  it("keeps the loader on native strip semantics and surfaces the error verbatim", async () => {
    const loader = await readFile(resolve("src", "runner", "dextLoader.mjs"), "utf8");
    expect(loader).toContain("stripTypeScriptTypes");
    expect(loader).toContain('mode: "strip"');
    // The native error code is copied and its message is interpolated unchanged,
    // so a user sees Node's ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX explanation.
    expect(loader).toContain("wrapped.code = code");
    expect(loader).toContain("${detail}");
    expect(loader).not.toContain("experimental-transform-types");
  });
});

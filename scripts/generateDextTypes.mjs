/**
 * Generates the Dext TypeScript declaration surface.
 *
 *   node scripts/generateDextTypes.mjs [--check]                  # dist/dext.d.ts — the copy the extension ships
 *   node scripts/generateDextTypes.mjs [--check] --workspace <dir> # <dir>/.dext/ — the project the workspace commits
 *
 * The declaration describes the built-in registry, which is why the shipped copy is
 * a build artifact `npm run check` verifies. A workspace's own `.dext/` project also
 * describes the MCP tools that project's manifests declare: the extension writes it
 * on every API reload, and this command does the same from the command line, so a
 * teammate or CI can regenerate and check it without VS Code.
 *
 * `--check` compares what is on disk with what would be generated and exits
 * non-zero with a readable diff summary when they differ.
 *
 * The generator has no build step of its own: it bundles the TypeScript source
 * with esbuild (a dev dependency, the same way `esbuild.mjs` does) and imports
 * the result from an in-memory `data:` URL, so plain Node can run it without a
 * `tsc` emit.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** The declaration the extension ships; `esbuild.mjs` writes it. */
export const SHIPPED_DECLARATION = path.join(root, "dist", "dext.d.ts");

function parseArguments(argv) {
  const options = { check: false, workspace: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") options.check = true;
    else if (argument === "--workspace") {
      const value = argv[++index];
      if (!value) throw new Error("--workspace needs a directory.");
      options.workspace = value;
    } else if (argument.startsWith("--workspace=")) {
      options.workspace = argument.slice("--workspace=".length);
    } else {
      throw new Error(`Unknown argument '${argument}'.`);
    }
  }
  return options;
}

/** Bundle the generator and import it without touching the disk. */
async function loadGenerator() {
  const result = await build({
    // Both modules, because a workspace's project describes the MCP tools its own
    // manifests declare as well as the built-in surface.
    stdin: {
      contents: [
        'export { dextFiles, dextSharedDeclaration, dextModuleDeclaration } from "./src/core/dextApiTypes.ts";',
        'export { parseMcpManifest } from "./src/core/mcpManifest.ts";'
      ].join("\n"),
      resolveDir: root,
      sourcefile: "generateDextTypes.entry.ts",
      loader: "ts"
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "node20",
    logLevel: "silent"
  });
  const output = result.outputFiles?.[0];
  if (!output) throw new Error("esbuild produced no output for the dext type generator.");
  const code = Buffer.from(output.text, "utf8").toString("base64");
  return import(`data:text/javascript;base64,${code}`);
}

/** The shipped declaration text. */
export async function buildDeclaration() {
  const generator = await loadGenerator();
  return generator.dextSharedDeclaration();
}

/**
 * A workspace's project settings, as `.dext/project.json` records them. The file is
 * committed, so the CLI can read the same paths the extension reads for that
 * workspace — which is what makes `--check` mean something for a project that keeps
 * its manifests or APIs somewhere other than the default.
 */
async function projectPaths(root) {
  try {
    const settings = JSON.parse(await readFile(path.join(root, ".dext", "project.json"), "utf8"));
    return settings?.paths ?? {};
  } catch {
    return {};
  }
}

/** The MCP directories a workspace's project settings add, on top of `.dext/mcp`. */
function projectMcpDirectories(root, paths) {
  const directories = [path.join(root, ".dext", "mcp")];
  const configured = paths?.mcpDirs;
  if (Array.isArray(configured)) {
    for (const entry of configured) {
      if (typeof entry === "string" && entry.trim()) directories.push(path.resolve(root, entry));
    }
  }
  return [...new Set(directories)];
}

/** The directories `dext/api/<id>` resolves against that belong to the project,
 * which is what its generated `paths` project can name relatively. */
function projectApiDirectories(paths) {
  const directories = [".dext/api"];
  const configured = paths?.apiDirs;
  if (Array.isArray(configured)) {
    for (const entry of configured) if (typeof entry === "string" && entry.trim()) directories.push(entry);
  }
  return [...new Set(directories.map((entry) => entry.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "")).filter(Boolean))];
}

/**
 * The MCP methods a workspace's own manifests declare, in a deterministic order.
 *
 * A manifest the extension would report as a diagnostic contributes nothing: the
 * generated project still describes the built-in surface, and the error belongs to
 * the manifest rather than to the types.
 */
async function projectMcpMethods(generator, workspace, paths) {
  const root = path.resolve(workspace);
  const methods = [];
  const seenServers = new Set();
  for (const directory of projectMcpDirectories(root, paths)) {
    let entries;
    try { entries = await readdir(directory); }
    catch { continue; }
    for (const name of entries.filter((entry) => entry.toLowerCase().endsWith(".jsonc")).sort()) {
      const file = path.join(directory, name);
      let manifest;
      try {
        manifest = generator.parseMcpManifest(await readFile(file, "utf8"), file);
      } catch {
        // Unreadable or malformed: skipped, exactly as an editor without the manifest.
        continue;
      }
      // The first manifest to declare a server name owns it, as in the extension: a
      // later file with the same name is not what the workspace runs.
      if (manifest.server) {
        if (seenServers.has(manifest.server.name)) continue;
        seenServers.add(manifest.server.name);
      }
      methods.push(...manifest.methods);
    }
  }
  return methods;
}

/** The project a workspace commits: the declaration, the `paths` project and the
 * ESM marker, with the MCP tools that workspace's manifests declare and the API
 * directories its settings add. */
export async function buildWorkspaceLayout(workspace) {
  const generator = await loadGenerator();
  const paths = await projectPaths(path.resolve(workspace));
  return generator.dextFiles(
    await projectMcpMethods(generator, workspace, paths),
    projectApiDirectories(paths)
  );
}

/** Whether `current` is the generated text, ignoring the line endings the checkout
 * gave it: the generated text is LF, and `core.autocrlf` is not something a
 * repository can rely on. */
function sameText(current, expected) {
  return current.replace(/\r\n/g, "\n") === expected;
}

/** A short, human-readable summary of how two texts differ. */
function diffSummary(expected, actual, label) {
  // Compare and report by line, so a CRLF checkout does not read as every line
  // having changed.
  const expectedLines = expected.split("\n");
  const actualLines = actual.replace(/\r\n/g, "\n").split("\n");
  const total = Math.max(expectedLines.length, actualLines.length);
  let first = -1;
  let differences = 0;
  for (let line = 0; line < total; line += 1) {
    if (expectedLines[line] !== actualLines[line]) {
      differences += 1;
      if (first < 0) first = line;
    }
  }
  const lines = [`${label} differs: ${differences} of ${total} line(s); first difference at line ${first + 1}.`];
  if (first >= 0) {
    lines.push(`  expected: ${expectedLines[first] ?? "<missing line>"}`);
    lines.push(`  actual:   ${actualLines[first] ?? "<missing line>"}`);
    return lines;
  }
  return [`${label} differs.`];
}

/** Writes the shipped declaration (used by `esbuild.mjs`). Pass `declaration` to
 * write text that was already generated, so a caller that has it does not bundle
 * the generator a second time. */
export async function writeShippedDeclaration(declaration) {
  const text = declaration ?? await buildDeclaration();
  await mkdir(path.dirname(SHIPPED_DECLARATION), { recursive: true });
  await writeFile(SHIPPED_DECLARATION, text, "utf8");
  return SHIPPED_DECLARATION;
}

async function runCli(argv) {
  const options = parseArguments(argv);
  if (!options.workspace) {
    // Bundled once, here: the workspace path below needs its own bundle (it also
    // parses manifests) and paying for both would double the cost of every run.
    const declaration = await buildDeclaration();
    if (options.check) {
      let existing;
      try {
        existing = await readFile(SHIPPED_DECLARATION, "utf8");
      } catch {
        console.error(`dist/dext.d.ts is missing. Run \`npm run build\`.`);
        process.exitCode = 1;
        return;
      }
      if (!sameText(existing, declaration)) {
        console.error("The shipped dext declaration is out of date. Run `npm run build`.");
        for (const line of diffSummary(declaration, existing, "dist/dext.d.ts")) console.error(`  ${line}`);
        process.exitCode = 1;
        return;
      }
      console.log("The shipped dext declaration is up to date.");
      return;
    }
    console.log(`wrote ${path.relative(process.cwd(), await writeShippedDeclaration(declaration))}`);
    return;
  }

  const files = await buildWorkspaceLayout(options.workspace);
  const directory = path.join(path.resolve(options.workspace), ".dext");
  if (options.check) {
    const problems = [];
    for (const file of files) {
      const target = path.join(directory, file.path);
      let existing;
      try {
        existing = await readFile(target, "utf8");
      } catch {
        problems.push(`${path.join(".dext", file.path)} is missing.`);
        continue;
      }
      if (!file.createOnly && !sameText(existing, file.content)) problems.push(...diffSummary(file.content, existing, path.join(".dext", file.path)));
    }
    if (problems.length) {
      console.error(`Dext types in ${directory} are out of date. Run \`npm run generate:dext-types --workspace ${options.workspace}\`.`);
      for (const problem of problems) console.error(`  ${problem}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Dext types are up to date in ${directory}.`);
    return;
  }
  for (const file of files) {
    const target = path.join(directory, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    try {
      await writeFile(target, file.content, { encoding: "utf8", flag: file.createOnly ? "wx" : "w" });
    } catch (error) {
      if (file.createOnly && error.code === "EEXIST") continue;
      throw error;
    }
    console.log(`wrote ${path.relative(process.cwd(), target)}`);
  }
}

// Importing this module (from `esbuild.mjs` or a test) must not run the CLI.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCli(process.argv.slice(2));
}

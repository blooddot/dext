import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const runtimeRoot = fileURLToPath(new URL("../vendor/project-diagrams/archify/", import.meta.url));
const manifestPath = resolve(runtimeRoot, "UPSTREAM.json");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function runtimeFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    assert.ok(!entry.isSymbolicLink(), `Unexpected upstream symlink: ${name}`);
    if (entry.isDirectory()) files.push(...await runtimeFiles(resolve(directory, entry.name), `${name}/`));
    else if (entry.isFile() && name !== "UPSTREAM.json") files.push(name);
  }
  return files.sort();
}

/** The manifest is Dext-owned; every other file must remain an upstream file. */
export async function checkArchifyUpstream({ source, archive, record = false } = {}) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (record) assert.ok(source && archive, "Recording requires --source and --archive.");
  if (archive) {
    assert.equal(sha256(await readFile(resolve(archive))), manifest.archiveSha256, "Archify archive SHA-256 differs from UPSTREAM.json.");
  }
  const files = await runtimeFiles(runtimeRoot);
  const digest = createHash("sha256");
  const mismatches = [];
  for (const name of files) {
    const bytes = await readFile(resolve(runtimeRoot, name));
    // Hash each path and file digest, so additions, removals and renames count too.
    digest.update(`${name}\0${sha256(bytes)}\n`);
    if (source) {
      try {
        assert.ok(bytes.equals(await readFile(resolve(source, name))));
      } catch { mismatches.push(name); }
    }
  }
  assert.equal(mismatches.length, 0, `Vendored files differ from the release (or are missing):\n${mismatches.join("\n")}`);
  const pkg = JSON.parse(await readFile(resolve(runtimeRoot, "package.json"), "utf8"));
  assert.equal(pkg.version, manifest.version, "Archify package and pinned version differ.");
  const runtimeSha256 = digest.digest("hex");
  if (record) {
    manifest.runtimeFileCount = files.length;
    manifest.runtimeSha256 = runtimeSha256;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  } else {
    assert.equal(files.length, manifest.runtimeFileCount, "Archify runtime file set changed; compare with the official release before recording a new digest.");
    assert.equal(runtimeSha256, manifest.runtimeSha256, "Archify runtime was modified; keep changes in the Dext adapter and resync upstream files.");
  }
  return { version: pkg.version, files: files.length, paths: files, runtimeSha256, comparedWithRelease: Boolean(source) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { values } = parseArgs({ options: { source: { type: "string" }, archive: { type: "string" }, record: { type: "boolean" } } });
  const result = await checkArchifyUpstream(values);
  console.log(`PASS: Archify ${result.version}, ${result.files} unchanged upstream files${result.comparedWithRelease ? ", verified against extracted release" : ""}.`);
}

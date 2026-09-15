import { describe, expect, it } from "vitest";
import {
  parseCargoManifest,
  readRustProjectMetadata,
  scanRust,
  scanRustProjectMetadata,
  stripRustNonCode
} from "../src/core/projectArchitectureRust.js";

describe("Rust architecture scan", () => {
  it("finds use paths and records macro coverage", () => {
    const result = scanRust([{ path: "src/a.rs", content: "use crate::b;\nmacro_rules! x { () => {} }" }, { path: "src/b.rs", content: "pub fn b() {}" }]);
    expect(result.relations[0]).toMatchObject({ from: "src/a", to: "src/b" });
    expect(result.unsupported[0]?.reason).toContain("macros");
  });

  it("never treats comments or strings as dependencies", () => {
    const content = [
      "// use crate::ghost;",
      "/* use crate::also_ghost;",
      "   still a comment */",
      'const TEXT: &str = "use crate::string_ghost;";',
      "use crate::real;"
    ].join("\n");
    const result = scanRust([{ path: "src/a.rs", content }, { path: "src/real.rs", content: "pub fn real() {}" }, { path: "src/ghost.rs", content: "" }]);
    expect(result.relations.map((relation) => relation.to)).toEqual(["src/real"]);
    expect(stripRustNonCode(content)).not.toContain("ghost");
  });

  it("resolves self, super, grouped and re-exported paths", () => {
    const files = [
      { path: "src/lib.rs", content: "pub use crate::app::run;\nmod app;" },
      { path: "src/app.rs", content: "mod inner;\nuse self::inner::helper;\nuse super::base::Thing;" },
      { path: "src/app/inner.rs", content: "pub fn helper() {}" },
      { path: "src/base.rs", content: "pub struct Thing;" }
    ];
    const result = scanRust(files);
    const relations = result.relations.map((relation) => `${relation.from}->${relation.to}`).sort();
    expect(relations).toContain("src/lib->src/app");
    expect(relations).toContain("src/app->src/app/inner");
    expect(relations).toContain("src/app->src/base");
  });

  it("reports conditional compilation and unresolved macro paths as uncertain", () => {
    const result = scanRust([{ path: "src/a.rs", content: '#[cfg(feature = "x")]\nuse crate::generated::thing;' }, { path: "src/b.rs", content: "" }]);
    expect(result.unsupported.some((item) => item.reason.includes("Conditional compilation"))).toBe(true);
    expect(result.unsupported.some((item) => item.reason.includes("macro expansion"))).toBe(true);
  });
});

describe("Cargo metadata", () => {
  const manifest = ['[package]', 'name = "fixture"', 'version = "0.2.0"', 'description = "A fixture crate"', '', '[dependencies]', 'serde = "1"', 'tokio = { version = "1" }', '', '[target.\'cfg(unix)\'.dependencies]', 'libc = "0.2"'].join("\n");

  it("reads description and dependencies from the manifest without running Cargo", () => {
    expect(parseCargoManifest(manifest)).toEqual({
      name: "fixture", version: "0.2.0", description: "A fixture crate", dependencies: ["serde", "tokio", "libc"]
    });
  });

  it("degrades to the manifest when cargo metadata is unavailable", async () => {
    const files = [{ path: "Cargo.toml", content: manifest }];
    expect(scanRustProjectMetadata(files)).toMatchObject({ available: true, coverage: [] });
    const metadata = await readRustProjectMetadata(files, { runCargoMetadata: async () => { throw new Error("cargo missing"); } });
    expect(metadata.packages[0]!.metadata.description).toBe("A fixture crate");
    expect(metadata.coverage[0]).toContain("cargo metadata was unavailable");
  });

  it("uses cargo metadata when it is available", async () => {
    const metadata = await readRustProjectMetadata([{ path: "Cargo.toml", content: manifest }], {
      runCargoMetadata: async () => ({ packages: [{ name: "fixture", description: "Resolved description", dependencies: [{ name: "resolved-dep" }] }] })
    });
    expect(metadata.packages[0]!.metadata.description).toBe("Resolved description");
    expect(metadata.packages[0]!.metadata.dependencies).toEqual(["resolved-dep"]);
  });

  it("resolves a local crate path instead of reporting it unresolved", () => {
    const files = [
      { path: "native/Cargo.toml", content: manifest },
      { path: "native/src/lib.rs", content: "pub fn run() {}" },
      { path: "native/src/tasks.rs", content: "use fixture::run;" }
    ];
    const withoutManifest = scanRust(files.filter((file) => !file.path.endsWith("Cargo.toml")));
    expect(withoutManifest.relations).toHaveLength(0);
    expect(withoutManifest.unsupported.some((item) => item.reason.includes("fixture/run"))).toBe(true);
    const withManifest = scanRust(files.filter((file) => !file.path.endsWith("Cargo.toml")), {
      crates: [{ name: "fixture", manifestPath: "native/Cargo.toml" }]
    });
    expect(withManifest.relations[0]).toMatchObject({ from: "native/src/tasks", to: "native/src/lib" });
  });
});

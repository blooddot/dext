import { describe, expect, it } from "vitest";
import { loadMethodConfigs } from "../src/core/configLoader.js";

const VALID_CONFIG = JSON.stringify({
  version: 1,
  methods: [
    {
      id: "project.demo.run",
      title: "Demo",
      description: "Demo method",
      kind: "command",
      version: "1.0.0",
      input: [],
      output: { kind: "text" },
      executor: { kind: "deterministic", handler: "echoText" }
    }
  ]
});

describe("method config loader", () => {
  it("does not read external configuration in untrusted workspaces", async () => {
    let reads = 0;
    const result = await loadMethodConfigs(
      false,
      [{ source: "project", path: ".dext/methods.json" }],
      async () => {
        reads += 1;
        return VALID_CONFIG;
      }
    );
    expect(reads).toBe(0);
    expect(result.blocked).toBe(true);
    expect(result.methods).toEqual([]);
  });

  it("parses trusted project configuration", async () => {
    const result = await loadMethodConfigs(
      true,
      [{ source: "project", path: ".dext/methods.json" }],
      async () => VALID_CONFIG
    );
    expect(result.methods[0]).toMatchObject({
      source: "project",
      definition: { id: "project.demo.run" }
    });
  });

  it("reports invalid JSON without throwing", async () => {
    const result = await loadMethodConfigs(
      true,
      [{ source: "global", path: "broken.json" }],
      async () => "{"
    );
    expect(result.methods).toEqual([]);
    expect(result.diagnostics[0]).toContain("broken.json");
  });

  it("rejects duplicate fields and unknown configuration keys", async () => {
    const invalid = JSON.stringify({
      version: 1,
      methods: [
        {
          id: "project.demo.run",
          title: "Demo",
          description: "Demo method",
          kind: "command",
          version: "1.0.0",
          input: [
            { name: "value", type: "string" },
            { name: "value", type: "string" }
          ],
          output: { kind: "text" },
          executor: { kind: "deterministic", handler: "echoText" },
          unexpected: true
        }
      ]
    });
    const result = await loadMethodConfigs(
      true,
      [{ source: "project", path: ".dext/methods.json" }],
      async () => invalid
    );
    expect(result.methods).toEqual([]);
    expect(result.diagnostics[0]).toContain("Unrecognized key");
  });
});

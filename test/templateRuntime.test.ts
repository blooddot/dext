import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { loadCustomApis } from "../src/core/customApi.js";
import { ContextResolver, type ContextHost } from "../src/core/contextResolver.js";
import { MethodRegistry } from "../src/core/registry.js";
import { DextRuntime } from "../src/core/runtime.js";
import { parseAgentResult } from "../src/core/resultBoundary.js";
import type { AgentResult, InvocationValue } from "../src/core/types.js";

const host: ContextHost = {
  selection: async () => ({ uri: "file:///x.ts", content: "const x = 1;", version: 1 }),
  activeFile: async () => ({ uri: "file:///x.ts", content: "const x = 1;", version: 1 }),
  file: async (path) => ({ uri: `file:///${path}`, content: "export const y = 2;", version: 1 }),
  symbol: async () => undefined,
  dir: async (path) => ({ kind: "dirRef", uri: `file:///${path}`, path })
};

const TEMPLATE = `---
dext-template:
  format: markdown
  number: 四位数字编号
  title: 简短标题
  status:
    type: enum
    values: [accepted, rejected]
  context: 背景
  positive:
    type: lines
    description: 正面后果
  sources:
    type: lines
    optional: true
---

# ADR-{{number}}: {{title}}

## 状态

{{status}}

## 背景

{{context}}

## 后果

### 正面

- {{positive}}

## 参考资料

- {{sources}}
`;

const JSON_TEMPLATE = `---
dext-template:
  format: json
  name: 包名，kebab-case
  version: 版本号
  keywords:
    type: lines
    separator: ",\\n"
    description: 关键词，每个写成带双引号的 JSON 字符串
---

{
  "name": "{{name}}",
  "version": "{{version}}",
  "keywords": [
    {{keywords}}
  ]
}
`;

function setup() {
  const registry = new MethodRegistry();
  registry.registerMany(BUILTIN_METHODS, "builtin");
  return new DextRuntime(registry, new ContextResolver(host));
}

function selectAgent(runtime: DextRuntime): void {
  runtime.setAgentProfiles([{ id: "codex", label: "Codex", provider: "codex", command: "codex", models: [] }]);
  runtime.setAgentSelection({ profileId: "codex" });
}

async function withTemplate(
  run: (root: string, runtime: DextRuntime) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "dext-template-"));
  try {
    await mkdir(join(root, "templates"), { recursive: true });
    await writeFile(join(root, "templates", "adr.md"), TEMPLATE, "utf8");
    await writeFile(join(root, "templates", "package.json.tpl"), JSON_TEMPLATE, "utf8");
    const runtime = setup();
    runtime.setWorkspaceRoot(root);
    runtime.setWorkspaceTrusted(true);
    selectAgent(runtime);
    await run(root, runtime);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function templateCall(arguments_: { name: string; value: InvocationValue }[]) {
  return { kind: "invocation" as const, method: "template", source: "code" as const, arguments: arguments_ };
}

const FIELD_VALUES = {
  kind: "template",
  number: "0081",
  title: "多轮搜索选择 Medoid",
  status: "accepted",
  context: "逐字段聚合会拼出从未共同出现过的参数。",
  positive: "保留参数联动关系\n不增加 trial 成本"
};

describe("template API", () => {
  it("renders the template from the model's field values and never from its prose", async () => {
    await withTemplate(async (_root, runtime) => {
      const seen: { outputSchema: unknown; allowWorkspaceWrite: boolean | undefined; includePatch: boolean | undefined }[] = [];
      runtime.setAgentRunner({
        run: async (request) => {
          seen.push({
            outputSchema: request.contract.outputJsonSchema,
            allowWorkspaceWrite: request.allowWorkspaceWrite,
            includePatch: request.includePatch
          });
          return FIELD_VALUES;
        }
      });

      const response = await runtime.execute(templateCall([
        { name: "input", value: "记录这次决策" },
        { name: "source", value: "templates/adr.md" }
      ]));

      expect(response.result).toEqual({
        kind: "template",
        text: [
          "# ADR-0081: 多轮搜索选择 Medoid",
          "",
          "## 状态",
          "",
          "accepted",
          "",
          "## 背景",
          "",
          "逐字段聚合会拼出从未共同出现过的参数。",
          "",
          "## 后果",
          "",
          "### 正面",
          "",
          "- 保留参数联动关系",
          "- 不增加 trial 成本",
          ""
        ].join("\n")
      });
      // Text only: the call never declares or returns a destination.
      expect(Object.keys(response.result as object)).toEqual(["kind", "text"]);
      // An empty optional field removed its section, heading included.
      expect((response.result as { text: string }).text).not.toContain("参考资料");
      // Read-only, and a template call never asks for a patch.
      expect(seen[0]).toMatchObject({ allowWorkspaceWrite: false, includePatch: false });
    });
  });

  it("sends the template's own fields to the provider as the structured-output schema", async () => {
    await withTemplate(async (_root, runtime) => {
      let schema: { properties: Record<string, unknown>; required: string[] } | undefined;
      runtime.setAgentRunner({
        run: async (request) => {
          schema = request.contract.outputJsonSchema as typeof schema;
          return FIELD_VALUES;
        }
      });

      await runtime.execute(templateCall([
        { name: "input", value: "记录这次决策" },
        { name: "source", value: "templates/adr.md" }
      ]));

      expect(Object.keys(schema!.properties)).toEqual(["kind", "number", "title", "status", "context", "positive", "sources"]);
      expect(schema!.properties["status"]).toMatchObject({ enum: ["accepted", "rejected"] });
      expect(schema!.required).toContain("positive");
      expect(schema!.required).not.toContain("sources");
    });
  });

  it("keeps Dext-owned preset values out of the model contract and out of the model's reach", async () => {
    await withTemplate(async (_root, runtime) => {
      let schema: { properties: Record<string, unknown> } | undefined;
      runtime.setAgentRunner({
        run: async (request) => {
          schema = request.contract.outputJsonSchema as typeof schema;
          return { ...FIELD_VALUES, number: "9999" };
        }
      });

      const response = await runtime.execute(templateCall([
        { name: "input", value: "记录这次决策" },
        { name: "source", value: "templates/adr.md" },
        { name: "values", value: { number: "0082", status: "rejected" } }
      ]));

      expect(Object.keys(schema!.properties)).not.toContain("number");
      expect(Object.keys(schema!.properties)).not.toContain("status");
      expect((response.result as { text: string }).text).toContain("# ADR-0082");
      expect((response.result as { text: string }).text).toContain("## 状态\n\nrejected");
    });
  });

  it("rejects a model answer that breaks the template contract", async () => {
    await withTemplate(async (_root, runtime) => {
      runtime.setAgentRunner({ run: async () => ({ ...FIELD_VALUES, status: "maybe" }) });
      await expect(runtime.execute(templateCall([
        { name: "input", value: "x" },
        { name: "source", value: "templates/adr.md" }
      ]))).rejects.toThrow(/status/);
    });
  });

  it("repairs an invalid answer against the template's field contract", async () => {
    await withTemplate(async (_root, runtime) => {
      runtime.setAgentRunner({ run: async () => ({ kind: "template", number: "0081" }) });
      let outputFieldSchema: unknown;
      runtime.setResultRepair({
        parse: parseAgentResult,
        repair: async (request) => {
          outputFieldSchema = request.contract?.outputSchema;
          return { result: FIELD_VALUES as unknown as AgentResult };
        }
      });

      const response = await runtime.execute(templateCall([
        { name: "input", value: "x" },
        { name: "source", value: "templates/adr.md" }
      ]));

      expect(outputFieldSchema).toBeDefined();
      expect((response.result as { text: string }).text).toContain("# ADR-0081: 多轮搜索选择 Medoid");
    });
  });

  it("requires a trusted workspace and a workspace template", async () => {
    await withTemplate(async (_root, runtime) => {
      runtime.setAgentRunner({ run: async () => FIELD_VALUES });
      runtime.setWorkspaceTrusted(false);
      await expect(runtime.execute(templateCall([
        { name: "input", value: "x" },
        { name: "source", value: "templates/adr.md" }
      ]))).rejects.toThrow(/trusted local workspace/);

      runtime.setWorkspaceTrusted(true);
      await expect(runtime.execute(templateCall([
        { name: "input", value: "x" },
        { name: "source", value: "../outside.md" }
      ]))).rejects.toThrow(/inside the workspace/);

      await expect(runtime.execute(templateCall([
        { name: "input", value: "x" },
        { name: "source", value: "templates/missing.md" }
      ]))).rejects.toThrow(/Unable to read the template/);

      await expect(runtime.execute(templateCall([
        { name: "input", value: "x" },
        { name: "source", value: "   " }
      ]))).rejects.toThrow(/template path/);
    });
  });

  it("fails without a configured Agent profile instead of rendering an empty result", async () => {
    await withTemplate(async (_root, runtime) => {
      runtime.setAgentProfiles([]);
      runtime.setAgentSelection({});
      await expect(runtime.execute(templateCall([
        { name: "input", value: "x" },
        { name: "source", value: "templates/adr.md" }
      ]))).rejects.toThrow(/configured Agent profile/);
    });
  });

  it("compiles a .dx API that returns TemplateResult and writes the rendered file itself", async () => {
    const registry = new MethodRegistry();
    registry.registerMany(BUILTIN_METHODS, "builtin");
    const source = `def main(input: str, module: str, source: str, number: str, slug: str) -> TemplateResult:
    created = template(
        input=input,
        source=source,
        values={"module": module, "number": number, "slug": slug},
        skills=["adr"],
    )
    node.fs.writeFile(path=f"docs/decisions/{number}-{slug}.md", content=created.text)
    return created
`;
    const loaded = await loadCustomApis(
      true,
      ["C:/workspace/.dext/api"],
      async () => ["C:/workspace/.dext/api/adr/create.dx"],
      async (path) => (path.endsWith("create.dx") ? source : undefined),
      registry
    );

    expect(loaded.diagnostics).toEqual([]);
    expect(registry.get("adr.create")?.output).toMatchObject({ kind: "template" });
  });
});

describe("template formats at runtime", () => {
  it("renders valid JSON, keeps the option out of the contract and states the format in the instruction", async () => {
    await withTemplate(async (_root, runtime) => {
      let instruction: string | undefined;
      let schema: { properties: Record<string, unknown> } | undefined;
      runtime.setAgentRunner({
        run: async (request) => {
          instruction = request.metadata?.instruction;
          schema = request.contract.outputJsonSchema as typeof schema;
          return { kind: "template", name: "pkg", version: "0.1.0", keywords: '"a"\n"b"' };
        }
      });

      const response = await runtime.execute(templateCall([
        { name: "input", value: "写一个 package.json" },
        { name: "source", value: "templates/package.json.tpl" }
      ]));

      expect(response.result).toMatchObject({ kind: "template" });
      expect(JSON.parse((response.result as { text: string }).text))
        .toEqual({ name: "pkg", version: "0.1.0", keywords: ["a", "b"] });
      // `format` is a template option, so it never becomes a model field.
      expect(Object.keys(schema!.properties)).toEqual(["kind", "name", "version", "keywords"]);
      // The format requirement reaches the model as its own instruction.
      expect(instruction).toContain("as JSON");
      expect(instruction).toContain("must parse as valid JSON");
    });
  });

  it("repairs an answer whose fields do not render to valid JSON", async () => {
    await withTemplate(async (_root, runtime) => {
      const attempts: string[] = [];
      runtime.setAgentRunner({
        run: async () => {
          attempts.push("run");
          return { kind: "template", name: 'a"b', version: "0.1.0", keywords: '"x"' };
        }
      });
      let diagnostics: string | undefined;
      runtime.setResultRepair({
        parse: parseAgentResult,
        repair: async (request) => {
          diagnostics = request.diagnostics;
          return { result: { kind: "template", name: "pkg", version: "0.1.0", keywords: '"x"' } as unknown as AgentResult };
        }
      });

      const response = await runtime.execute(templateCall([
        { name: "input", value: "写一个 package.json" },
        { name: "source", value: "templates/package.json.tpl" }
      ]));

      // One model turn, then one repair: the render failure is the diagnostic.
      expect(attempts).toHaveLength(1);
      expect(diagnostics).toContain("Rendered JSON is invalid");
      expect(JSON.parse((response.result as { text: string }).text)).toMatchObject({ name: "pkg" });
    });
  });
});

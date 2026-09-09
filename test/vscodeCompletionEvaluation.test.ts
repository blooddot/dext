import { beforeEach, describe, expect, it, vi } from "vitest";
import { CompletionClient, normalizeCompletionSettings } from "../src/core/completionProvider.js";
import { DextCompletionEvaluation } from "../src/vscodeCompletionEvaluation.js";
import quality from "./fixtures/completionQuality.json";

const ui = vi.hoisted(() => ({
  pick: "quality" as string | undefined,
  messages: [] as string[],
  uri: { scheme: "file", fsPath: "/workspace/target.ts" },
  cancelled: false
}));
vi.mock("vscode", () => ({
  ProgressLocation: { Notification: 15 },
  window: {
    activeTextEditor: { document: { get uri() { return ui.uri; } } },
    showQuickPick: async (items: { evaluationKind: string }[]) => items.find((item) => item.evaluationKind === ui.pick),
    showInformationMessage: async (text: string) => { ui.messages.push(text); },
    showErrorMessage: async (text: string) => { ui.messages.push(text); },
    withProgress: async (_options: unknown, run: (progress: unknown, token: unknown) => unknown) => run({ report: () => undefined },
      { isCancellationRequested: ui.cancelled, onCancellationRequested: () => ({ dispose: () => undefined }) })
  }
}));
function host() {
  const output: string[] = []; const headers: Headers[] = [];
  const settings = vi.fn(() => normalizeCompletionSettings({ enabled: false, endpoint: "https://fixture.invalid", model: "profile-model", api: "openai-chat" }));
  const apiKey = vi.fn(async () => "fixture-secret");
  const options = { settings, apiKey, scope: vi.fn(() => "folder"),
    output: { show: () => undefined, appendLine: (text: string) => output.push(text) },
    client: () => new CompletionClient(async (_url, init) => {
      headers.push(new Headers(init?.headers));
      return new Response(JSON.stringify({ choices: [{ message: { content: "fixture-secret" } }] }), { headers: { "content-type": "application/json" } });
    }) };
  return { instance: new DextCompletionEvaluation(options), options, output, headers };
}
describe("Profile completion evaluation command", () => {
  beforeEach(() => { ui.pick = "quality"; ui.cancelled = false; ui.messages.length = 0; });
  it("uses resource settings and SecretStorage in-process without enabling automatic completion or logging secrets", async () => {
    const test = host(); await test.instance.run();
    expect(test.options.settings).toHaveBeenCalledWith(ui.uri);
    expect(test.options.scope).toHaveBeenCalledWith("model", ui.uri);
    expect(test.options.apiKey).toHaveBeenCalledTimes(1);
    expect(test.headers).toHaveLength(quality.length * 3); expect(test.headers[0]?.get("authorization")).toBe("Bearer fixture-secret");
    expect(test.output.join("\n")).not.toContain("fixture-secret");
    expect(test.options.settings().enabled).toBe(false);
  });
  it("does not access secrets or generate when the picker is dismissed", async () => {
    ui.pick = undefined; const test = host(); await test.instance.run();
    expect(test.options.apiKey).not.toHaveBeenCalled(); expect(test.headers).toHaveLength(0);
  });
  it("never generates after cancellation and can run again", async () => {
    ui.cancelled = true; const test = host(); await test.instance.run(); expect(test.headers).toHaveLength(0);
    ui.cancelled = false; await test.instance.run(); expect(test.headers).toHaveLength(quality.length * 3);
  });
  it("sanitizes credential-store failures", async () => {
    const test = host(); test.options.apiKey.mockRejectedValue(new Error("fixture-secret")); await test.instance.run();
    expect(ui.messages.join("\n")).not.toContain("fixture-secret"); expect(test.headers).toHaveLength(0);
  });
  it("supports explicit bounded command invocation and returns only sanitized summaries", async () => {
    ui.pick = undefined;
    const test = host(); const result = await test.instance.run("performance");
    expect(result?.attempted).toBe(100);
    expect(result?.planned).toBe(100);
    expect(JSON.stringify(result)).not.toMatch(/fixture-secret|candidate|modelText|endpoint/);
    expect(test.headers).toHaveLength(100);
  });
  it("rejects invalid command arguments before accessing Profile credentials", async () => {
    const test = host(); await test.instance.run("unknown" as "quality");
    expect(test.options.apiKey).not.toHaveBeenCalled(); expect(test.headers).toHaveLength(0);
  });
  it("reports missing credentials as zero attempts instead of a passed model evaluation", async () => {
    const test = host(); test.options.apiKey.mockResolvedValue("");
    const result = await test.instance.run("quality");
    expect(result).toMatchObject({ stopReason: "missing_credential", attempted: 0, planned: quality.length * 3 });
    expect(test.headers).toHaveLength(0);
  });
});

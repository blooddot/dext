import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CliAgentRunner, resolveCliCommand, runClaudeConversation } from "../src/core/agentRunner.js";
import type { AgentConversationRequest } from "../src/core/agentRunner.js";
import type { AgentInputRequest, UiFormResult, ExecutionMetadata } from "../src/core/types.js";

// Opt-in native integration: it makes real model calls with the installed CLI's
// own login. Enable with DEXT_TEST_CLAUDE=claude (or an executable path).
describe.skipIf(!process.env.DEXT_TEST_CLAUDE)("Claude questions and permissions", { timeout: 180_000 }, () => {
  let directory: string;
  const command = process.env.DEXT_TEST_CLAUDE ?? "claude";
  beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), "dext-claude-integration-")); });
  afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

  it("answers AskUserQuestion from Dext's card", async () => {
    const asked: AgentInputRequest[] = [];
    const metadata: ExecutionMetadata = {
      agentSessionId: "integration",
      requestAgentInput: vi.fn(async (input: AgentInputRequest) => {
        asked.push(input);
        return Object.fromEntries(input.questions.map((question) => [question.id, { answers: [question.options.at(-1)?.label ?? "Beta"] }]));
      }),
      ui: { form: vi.fn(async (): Promise<UiFormResult> => ({ kind: "ui", type: "form", status: "submitted", answers: {} })) }
    };
    const request: AgentConversationRequest = {
      profile: { id: "claude", provider: "claude", label: "Claude", command, models: [] },
      mode: "agent", cwd: directory, allowWorkspaceWrite: true, permission: "workspace-write",
      input: "Use the AskUserQuestion tool to ask me whether to use Alpha or Beta, then report my choice in one short line.",
      metadata
    };
    const text = await new CliAgentRunner(180_000).runConversation(request);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.questions[0]?.options.map((option) => option.label)).toContain("Beta");
    expect(text.toLowerCase()).toContain("beta");
  });

  it("answers an ordinary tool permission from Dext's card", async () => {
    const resolved = resolveCliCommand(command, "claude");
    expect(resolved).toBeTruthy();
    const form = vi.fn(async (): Promise<UiFormResult> => ({ kind: "ui", type: "form", status: "submitted", answers: {} }));
    const request: AgentConversationRequest = {
      profile: { id: "claude", provider: "claude", label: "Claude", command, models: [] },
      mode: "agent", cwd: directory, allowWorkspaceWrite: true,
      input: "Create a file named approval.txt containing the word hi, using the Write tool.",
      metadata: { agentSessionId: "integration-write", ui: { form } }
    };
    // `default` is the mode that actually asks; Dext maps its own tiers onto plan,
    // acceptEdits and bypassPermissions, so the protocol is exercised directly.
    const text = await runClaudeConversation(request, {
      command: resolved!, args: ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
        "--permission-mode", "default", "--permission-prompt-tool", "stdio"],
      timeoutMs: 180_000, idleTimeoutMs: 120_000, onSession: () => {}
    });
    expect(form).toHaveBeenCalledOnce();
    expect(text.toLowerCase()).toContain("approval.txt");
    expect(await readFile(join(directory, "approval.txt"), "utf8")).toContain("hi");
  });

  it("resumes the provider session in a later turn", async () => {
    let session = "";
    const onAgentSessionId = vi.fn((_provider: string, id: string) => { session = id; });
    const base: AgentConversationRequest = {
      profile: { id: "claude", provider: "claude", label: "Claude", command, models: [] },
      mode: "plan", cwd: directory, allowWorkspaceWrite: false, input: "", metadata: {}
    };
    const runner = new CliAgentRunner(180_000);
    await runner.runConversation({ ...base, input: "Remember the single word: pineapple. Reply with just OK.",
      metadata: { agentSessionId: "resume", onAgentSessionId } });
    expect(session).toBeTruthy();
    const text = await runner.runConversation({ ...base,
      input: "What single word did I ask you to remember? Reply with just that word.",
      metadata: { agentSessionId: "resume", conversationProviderSessionId: session } });
    expect(text.toLowerCase()).toContain("pineapple");
  });
});

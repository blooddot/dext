import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DeepSeekHarnessRunner } from "../src/core/deepseekHarnessRunner.js";
import type { AgentInputRequest, AgentStreamEvent } from "../src/core/types.js";

const probe = resolve("test/fixtures/harnessQuestionAgentProbe.mjs");

// Opt-in native integration: no API key is required, because the probe asks as
// soon as the prompt reaches the agent's inbox and the model call that follows
// is the part that fails. It covers the half no unit test can: the Harness
// dispatches `user-questions/request` to the live calling agent's scope, so
// only the real installed Harness proves Dext's root listener still owns it.
describe.skipIf(!process.env.DEXT_TEST_DSH)("Harness question for a live calling agent", { timeout: 60_000 }, () => {
  let directory: string;
  const originalHome = process.env.DSH_HOME;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "dext-question-agent-"));
    process.env.DSH_HOME = directory;
  });
  afterAll(async () => {
    if (originalHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = originalHome;
    await rm(directory, { recursive: true, force: true });
  });

  it("answers an agent-scoped question from Dext's card", async () => {
    const output = join(directory, "probe.jsonl");
    const patch = join(directory, "probe-patch.json");
    await writeFile(patch, JSON.stringify([{ insert: [{ id: "dext-question-agent-probe", name: pathToFileURL(probe).href, config: { output } }] }]), "utf8");
    const events: AgentStreamEvent[] = [];
    const asked: AgentInputRequest[] = [];
    const runner = new DeepSeekHarnessRunner(30_000);
    try {
      await runner.runConversation({
        profile: { id: "deepseek-harness", provider: "deepseek-harness", label: "Harness", command: process.env.DEXT_TEST_DSH ?? "dsh", models: [] },
        cwd: process.cwd(),
        input: "hello",
        mode: "ask",
        allowWorkspaceWrite: false,
        agentPreset: "standard",
        // Extra arguments are restricted to `--patch <path>` pairs, which is
        // exactly the injection point this probe needs.
        cliArguments: ["--patch", patch],
        onEvent: (event) => events.push(event),
        metadata: {
          agentSessionId: "probe",
          requestAgentInput: async (input) => { asked.push(input); return { q: { answers: ["B"] } }; }
        }
        // The model call itself fails without a key; the question is asked first.
      }).catch(() => "(prompt failed as expected)");
      await new Promise((done) => setTimeout(done, 1500));
      expect(asked).toHaveLength(1);
      expect(asked[0]?.questions.map((question) => question.id)).toEqual(["q"]);
      expect(events.filter((event) => event.userInput).map((event) => event.userInput!.status)).toEqual(["waiting", "answered"]);
      const recorded = (await readFile(output, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { ok?: boolean; answer?: unknown; code?: string });
      expect(recorded.at(-1)).toEqual({ ok: true, answer: { answers: [{ id: "q", selected: ["B"] }] } });
    } finally {
      await runner.dispose();
    }
  });
});

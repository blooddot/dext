import { describe, expect, it } from "vitest";
import { cliCompletion } from "../src/core/cliCompletion.js";
import { CliAgentRunner, runProcess } from "../src/core/agentRunner.js";

describe("CLI protocol completion", () => {
  it("recognizes fragmented terminal events without requiring a final newline", () => {
    const detect = cliCompletion("codex");
    expect(detect('{"type":"turn.')).toBeUndefined();
    expect(detect('completed","usage":{"input_tokens":1}}')).toBe(0);
    expect(cliCompletion("codex")('{"type":"turn.failed","error":{"message":"failed"}}\n')).toBe(1);
    expect(cliCompletion("claude")('{"type":"result","is_error":false,"result":"done"}\n')).toBe(0);
    expect(cliCompletion("claude")('{"type":"result","subtype":"error_max_turns"}\n')).toBe(1);
  });

  it("does not confuse progress, tool completion, or completed Todos with a finished turn", () => {
    const detect = cliCompletion("codex");
    for (const item of [
      { type: "agent_message", text: "All done" },
      { type: "command_execution", status: "completed" },
      { type: "todo_list", items: [{ text: "Build", completed: true }] }
    ]) expect(detect(JSON.stringify({ type: "item.completed", item }) + "\n")).toBeUndefined();
    expect(detect('{"type":"error","message":"Retrying","will_retry":true}\n')).toBeUndefined();
  });

  it.each(["codex", "claude"] as const)("returns %s's result when the completed CLI never exits", async (provider) => {
    const terminal = provider === "codex" ? { type: "turn.completed" } : { type: "result", result: "Finished", is_error: false };
    const stdout = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Finished" } }) + "\n" + JSON.stringify(terminal);
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 2000);
    try {
      const result = await runProcess(process.execPath,
        ["-e", `process.stdout.write(${JSON.stringify(stdout)});setInterval(()=>{},1000);`], "", process.cwd(), controller.signal,
        undefined, undefined, { consume: cliCompletion(provider), graceMs: 25 });
      expect(result).toMatchObject({ code: 0, stdout });
      expect(controller.signal.aborted).toBe(false);
    } finally { clearTimeout(deadline); }
  });

  it("reports a terminal failure even if the failed CLI stays alive", async () => {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 2000);
    try {
      const result = await runProcess(process.execPath,
        ["-e", 'console.log(JSON.stringify({type:"turn.failed",error:{message:"Task failed"}}));setInterval(()=>{},1000);'],
        "", process.cwd(), controller.signal, undefined, undefined, { consume: cliCompletion("codex"), graceMs: 25 });
      expect(result.code).toBe(1);
    } finally { clearTimeout(deadline); }
  });

  it("keeps cancellation before completion distinct from successful shutdown", async () => {
    const controller = new AbortController();
    const pending = runProcess(process.execPath, ["-e", 'console.log("ready");setInterval(()=>{},1000);'],
      "", process.cwd(), controller.signal, () => controller.abort(), undefined,
      { consume: cliCompletion("codex"), graceMs: 25 });
    await expect(pending).rejects.toMatchObject({ name: "ExecutionCancelledError" });
  });

  it("does not change an already completed turn into cancellation during CLI cleanup", async () => {
    const controller = new AbortController();
    const result = await runProcess(process.execPath,
      ["-e", 'console.log(JSON.stringify({type:"turn.completed"}));setInterval(()=>{},1000);'],
      "", process.cwd(), controller.signal, () => setTimeout(() => controller.abort(), 10), undefined,
      { consume: cliCompletion("codex"), graceMs: 100 });
    expect(result.code).toBe(0);
  });

  it("lets normal CLI shutdown drain trailing output before returning", async () => {
    const result = await runProcess(process.execPath,
      ["-e", 'console.log(JSON.stringify({type:"turn.completed"}));setTimeout(()=>{process.stderr.write("cleanup finished");},10);'],
      "", process.cwd(), undefined, undefined, undefined, { consume: cliCompletion("codex"), graceMs: 1000 });
    expect(result).toMatchObject({ code: 0, stderr: "cleanup finished" });
  });

  it("releases inherited output pipes after completion without terminating a spawned service", async () => {
    let servicePid: number | undefined;
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 2000);
    try {
      const script = 'const {spawn}=require("node:child_process"); const service=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:["ignore",1,2],windowsHide:true,detached:true}); service.unref(); console.log(JSON.stringify({servicePid:service.pid})); console.log(JSON.stringify({type:"turn.completed"}));';
      const result = await runProcess(process.execPath, ["-e", script], "", process.cwd(), controller.signal,
        (chunk) => {
          const match = /"servicePid":(\d+)/.exec(chunk);
          if (match) servicePid = Number(match[1]);
        }, undefined, { consume: cliCompletion("codex"), graceMs: 50 });
      expect(result.code).toBe(0);
      expect(servicePid).toBeDefined();
      expect(() => process.kill(servicePid!, 0)).not.toThrow();
    } finally {
      clearTimeout(deadline);
      if (servicePid) { try { process.kill(servicePid); } catch { /* Already exited. */ } }
    }
  });

  it("finishes the conversation with its final answer despite a hanging Codex process", async () => {
    const runner = new CliAgentRunner(2000, async (_command, args, input, cwd, signal, onStdout, env, completion) => {
      if (args[0] === "login") return { stdout: "", stderr: "", code: 1 };
      expect(completion).toBeDefined();
      const output = [
        { type: "item.completed", item: { type: "agent_message", text: "Final answer" } }, { type: "turn.completed" }
      ].map((event) => JSON.stringify(event)).join("\n");
      return runProcess(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(output)});setInterval(()=>{},1000);`],
        input, cwd, signal, onStdout, env, { ...completion!, graceMs: 25 });
    });
    await expect(runner.runConversation({ profile: { id: "codex", provider: "codex", label: "Codex", command: process.execPath, models: [] },
      mode: "plan", cwd: process.cwd(), input: "Build", metadata: {}, allowWorkspaceWrite: true }))
      .resolves.toBe("Final answer");
  });
});

import { describe, expect, it } from "vitest";
import { buildProjectEvidencePackage } from "../src/core/projectAiGeneration.js";
import { ProjectInitializationService, type ProjectInitializationPhase } from "../src/projectService.js";

const evidence = () => buildProjectEvidencePackage({ projectName: "Example", files: [] });
const promptIntent = { schemaVersion: 1 as const, brief: { name: "Example", summary: "Summary", evidence: [{ path: "README.md", line: 1 }] }, updatedAt: 1 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

describe("Project initialization state machine", () => {
  it("starts uninitialized and never treats an old flag or diagrams alone as success", () => {
    const service = new ProjectInitializationService({
      prepareEvidence: async () => evidence(),
      generate: async () => ({}),
      persist: async () => undefined
    });
    expect(service.snapshot.status).toBe("uninitialized");
    service.hydrate({ hasIntent: false, diagramCount: 0, markedInitialized: true });
    expect(service.snapshot.status).toBe("uninitialized");
    service.hydrate({ hasIntent: false, diagramCount: 2, markedInitialized: true });
    expect(service.snapshot.status).toBe("uninitialized");
    expect(service.snapshot.diagramsGenerated).toBe(2);
    expect(service.snapshot.message).toContain("not initialized");
    service.hydrate({ hasIntent: true, diagramCount: 1 });
    expect(service.snapshot.status).toBe("completed");
    expect(service.snapshot.intentGenerated).toBe(true);
  });

  it("runs prepare → generate → persist and only completes after saving", async () => {
    const phases: ProjectInitializationPhase[] = [];
    let persisted = false;
    const service = new ProjectInitializationService({
      prepareEvidence: async (_signal, onProgress) => { onProgress({ phase: "preparing", completed: 1, total: 2, message: "reading" }); return evidence(); },
      generate: async () => ({ intent: promptIntent as never, diagrams: [] }),
      persist: async (_output, _signal, onProgress) => { onProgress({ phase: "saving", completed: 1, total: 1, message: "saved" }); persisted = true; }
    });
    service.subscribe((state) => { if (state.phase) phases.push(state.phase); });
    const state = await service.start().promise;
    expect(state.status).toBe("completed");
    expect(persisted).toBe(true);
    expect(state.intentGenerated).toBe(true);
    expect(phases).toContain("preparing");
    expect(phases).toContain("generating");
    expect(phases).toContain("saving");
    expect(state.message).toBe("saved");
  });

  it("fails with a clear reason when no AI provider is available and saves nothing", async () => {
    let persisted = false;
    const service = new ProjectInitializationService({
      prepareEvidence: async () => evidence(),
      generate: async () => { throw new Error("项目 AI 不可用：请先启用并选择一个可用的 AI CLI。"); },
      persist: async () => { persisted = true; }
    });
    const state = await service.start().promise;
    expect(state.status).toBe("failed");
    expect(state.error).toContain("AI 不可用");
    expect(persisted).toBe(false);
  });

  it("reports a failed partial save instead of success", async () => {
    const service = new ProjectInitializationService({
      prepareEvidence: async () => evidence(),
      generate: async () => ({ intent: promptIntent as never }),
      persist: async () => { throw new Error("写入第二个文件失败"); }
    });
    const state = await service.start().promise;
    expect(state.status).toBe("failed");
    expect(state.error).toContain("第二个文件");
  });

  it("cancels a running prepare and ignores its late completion", async () => {
    const pending = deferred<ReturnType<typeof evidence>>();
    const service = new ProjectInitializationService({
      prepareEvidence: () => pending.promise,
      generate: async () => ({}),
      persist: async () => undefined
    });
    const task = service.start();
    expect(service.snapshot.status).toBe("running");
    service.cancel();
    expect(service.snapshot.status).toBe("cancelled");
    pending.resolve(evidence());
    await task.promise;
    expect(service.snapshot.status).toBe("cancelled");
  });

  it("keeps the retry result when a stale earlier run finishes late", async () => {
    const first = deferred<ReturnType<typeof evidence>>();
    const second = deferred<ReturnType<typeof evidence>>();
    let calls = 0;
    const service = new ProjectInitializationService({
      prepareEvidence: () => (++calls === 1 ? first.promise : second.promise),
      generate: async () => ({ intent: promptIntent as never }),
      persist: async () => undefined
    });
    const firstTask = service.start();
    service.cancel();
    const secondTask = service.retry();
    second.resolve(evidence());
    const state = await secondTask.promise;
    expect(state.status).toBe("completed");
    first.resolve(evidence());
    await firstTask.promise;
    expect(service.snapshot.status).toBe("completed");
  });
});

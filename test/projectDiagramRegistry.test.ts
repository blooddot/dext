import { describe, expect, it } from "vitest";
import { ProjectDiagramAdapterRegistry } from "../src/core/projectDiagramRegistry.js";
import type { DiagramAdapterArtifact, DiagramAdapterCapability, DiagramAdapterDocument, DiagramAdapterRenderOptions, ProjectDiagramAdapter } from "../src/core/projectDiagramAdapter.js";
import type { ProjectDiagram, DiagramValidationReceipt } from "../src/core/projectDiagram.js";

const capability: DiagramAdapterCapability = { kind: "architecture", formats: ["html"], features: ["interactive", "deterministic", "validation"] };

class FakeAdapter implements ProjectDiagramAdapter {
  readonly id = "archify";
  readonly version = "2.17.0-dev.1";
  readonly capabilities = [capability] as const;
  behaviour: "succeed" | "fail-after-first" | "hang" = "succeed";
  renders = 0;
  disposed = false;
  /** Set to advertise an engine probe, like the Archify adapter does. */
  probe: (() => Promise<{ available: boolean; reason?: string }>) | undefined;

  supports(kind: ProjectDiagram["kind"]): boolean { return kind === "architecture"; }

  async transform(diagram: ProjectDiagram): Promise<DiagramAdapterDocument> {
    return { adapterId: this.id, adapterVersion: this.version, diagramId: diagram.id, kind: diagram.kind, payload: { diagram } };
  }

  private artifact(diagramId: string): DiagramAdapterArtifact {
    return { format: "html", mimeType: "text/html", content: `<html data-version="ready"></html>`, adapterId: this.id, adapterVersion: this.version, diagramId };
  }

  async preview(document: DiagramAdapterDocument): Promise<DiagramAdapterArtifact> { return this.artifact(document.diagramId); }

  render(document: DiagramAdapterDocument, options?: DiagramAdapterRenderOptions): Promise<DiagramAdapterArtifact> {
    this.renders += 1;
    if (this.behaviour === "hang") {
      if (options?.signal?.aborted) return Promise.reject(new Error("cancelled"));
      return new Promise((_, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
    }
    if (this.behaviour === "fail-after-first" && this.renders > 1) return Promise.reject(new Error("renderer exploded"));
    return Promise.resolve(this.artifact(document.diagramId));
  }

  async export(document: DiagramAdapterDocument, options?: DiagramAdapterRenderOptions): Promise<DiagramAdapterArtifact> { return this.render(document, options); }

  async validate(document: DiagramAdapterDocument): Promise<DiagramValidationReceipt> {
    return { adapterId: this.id, adapterVersion: this.version, status: "passed" as const, checkedAt: 1, issues: [], metadata: { nodeCount: String((document.payload as { diagram: ProjectDiagram }).diagram.nodes.length) } };
  }

  cancel(): void {}

  dispose(): void { this.disposed = true; }
}

const diagram = (version: number): ProjectDiagram => ({
  schemaVersion: 1, id: "demo", title: "Demo", kind: "architecture", version, updatedAt: version,
  nodes: [{ id: "a", label: "A", role: "system", semanticIds: [], evidence: [{ path: "src/a.ts", line: 1 }] }],
  relations: []
});

describe("Project diagram registry", () => {
  it("renders through the single registered engine and records the successful snapshot", async () => {
    const registry = new ProjectDiagramAdapterRegistry();
    registry.register(new FakeAdapter());
    const outcome = await registry.render(diagram(1));
    expect(outcome.status).toBe("rendered");
    expect(outcome.adapterId).toBe("archify");
    expect(outcome.artifact?.format).toBe("html");
    expect(outcome.usedLastGood).toBe(false);
    expect(outcome.displayedVersion).toBe(1);
    expect(registry.latest("demo")?.artifact.content).toContain("<html");
  });

  it("returns the same diagram's last good render with its real version when a newer render fails", async () => {
    const adapter = new FakeAdapter();
    const registry = new ProjectDiagramAdapterRegistry();
    registry.register(adapter);
    await registry.render(diagram(1));
    adapter.behaviour = "fail-after-first";
    const outcome = await registry.render(diagram(2));
    expect(outcome.status).toBe("failed");
    expect(outcome.usedLastGood).toBe(true);
    expect(outcome.displayedVersion).toBe(1);
    expect(outcome.artifact?.diagramId).toBe("demo");
    expect(outcome.error).toContain("exploded");
  });

  it("cancels an in-flight render and never promotes a late result", async () => {
    const adapter = new FakeAdapter();
    adapter.behaviour = "hang";
    const registry = new ProjectDiagramAdapterRegistry();
    registry.register(adapter);
    const pending = registry.render(diagram(1));
    registry.cancel("demo");
    const outcome = await pending;
    expect(outcome.status).toBe("cancelled");
    expect(registry.latest("demo")).toBeUndefined();
  });

  it("has no renderer preferences, recommendations or fallback surface", () => {
    const registry = new ProjectDiagramAdapterRegistry();
    expect("setPreference" in registry).toBe(false);
    expect("setDiagramPreference" in registry).toBe(false);
    expect("choices" in registry).toBe(false);
    expect("defaults" in registry).toBe(false);
    expect("exportPreferences" in registry).toBe(false);
  });

  it("rejects an artifact that does not match the requested diagram", async () => {
    class BadIdentityAdapter extends FakeAdapter {
      render(): Promise<DiagramAdapterArtifact> {
        return Promise.resolve({ format: "html", mimeType: "text/html", content: "<html/>", adapterId: this.id, adapterVersion: this.version, diagramId: "other" });
      }
    }
    const registry = new ProjectDiagramAdapterRegistry();
    registry.register(new BadIdentityAdapter());
    const outcome = await registry.render(diagram(1));
    expect(outcome.status).toBe("failed");
    expect(outcome.receipt.issues[0]?.code).toBe("invalid_artifact_identity");
  });

  it("disposes the engine exactly once", () => {
    const adapter = new FakeAdapter();
    const registry = new ProjectDiagramAdapterRegistry();
    registry.register(adapter);
    registry.dispose();
    expect(adapter.disposed).toBe(true);
    expect(registry.list()).toHaveLength(0);
  });

  it("reports the engine probe so a missing runtime is distinguishable from missing output", async () => {
    const registry = new ProjectDiagramAdapterRegistry();
    expect(await registry.engineInfo()).toMatchObject({ id: "archify", available: false });
    expect(registry.supports("architecture")).toBe(false);

    const adapter = new FakeAdapter();
    registry.register(adapter);
    expect(adapter.probe === undefined).toBe(true);
    // An adapter without a probe is assumed usable instead of being reported unavailable.
    expect(await registry.engineInfo()).toEqual({ id: "archify", version: "2.17.0-dev.1", available: true });
    expect(registry.supports("architecture")).toBe(true);
    expect(registry.supports("workflow")).toBe(false);

    adapter.probe = async () => ({ available: false, reason: "Archify runtime is unavailable." });
    expect(await registry.engineInfo()).toMatchObject({ available: false, reason: "Archify runtime is unavailable." });
  });

  it("persists last-good snapshots and restores them in a fresh registry", async () => {
    const saved: unknown[] = [];
    const persistence = { load: async () => saved.at(-1), save: async (state: unknown) => { saved.push(state); } };
    const first = new ProjectDiagramAdapterRegistry(persistence);
    first.register(new FakeAdapter());
    expect((await first.render(diagram(1))).status).toBe("rendered");
    // Saves are chained behind the render, so wait for the write the render triggered.
    await new Promise((done) => setTimeout(done, 0));
    expect(saved).toHaveLength(1);

    // A reload in the same workspace finds the snapshot without rendering again.
    const second = new ProjectDiagramAdapterRegistry(persistence);
    second.register(new FakeAdapter());
    await second.engineInfo();
    expect(second.latest("demo")?.diagram.version).toBe(1);
    expect(String(second.latest("demo")?.artifact.content)).toContain("<html");

    const adapter = new FakeAdapter();
    adapter.behaviour = "fail-after-first";
    adapter.renders = 1; // the next render is the failing one
    const failing = new ProjectDiagramAdapterRegistry(persistence);
    failing.register(adapter);
    // The renderer fails immediately, so only the restored snapshot can be shown.
    await failing.engineInfo();
    const outcome = await failing.render(diagram(2));
    expect(outcome.status).toBe("failed");
    expect(outcome.usedLastGood).toBe(true);
    expect(outcome.displayedVersion).toBe(1);
  });

  it("ignores a damaged history document instead of losing the live fallback", async () => {
    const registry = new ProjectDiagramAdapterRegistry({ load: async () => ({ schemaVersion: 99, entries: "nonsense" }), save: async () => undefined });
    registry.register(new FakeAdapter());
    await expect(registry.render(diagram(1))).resolves.toMatchObject({ status: "rendered" });
    expect(registry.latest("demo")?.diagram.version).toBe(1);
  });

  it("keeps the failed receipt and stops an in-flight render when the engine is unregistered", async () => {
    class FailingReceiptAdapter extends FakeAdapter {
      override async validate() {
        return { adapterId: this.id, adapterVersion: this.version, status: "failed" as const, checkedAt: 1, issues: [{ code: "schema/invalid", message: "Upstream rejected the diagram.", severity: "error" as const }] };
      }
    }
    const failing = new ProjectDiagramAdapterRegistry();
    failing.register(new FailingReceiptAdapter());
    const rejected = await failing.render(diagram(1));
    expect(rejected.status).toBe("failed");
    expect(rejected.receipt.status).toBe("failed");
    expect(rejected.error).toContain("Upstream rejected the diagram.");
    expect(failing.latest("demo")).toBeUndefined();

    const hanging = new FakeAdapter();
    hanging.behaviour = "hang";
    const registry = new ProjectDiagramAdapterRegistry();
    registry.register(hanging);
    const pending = registry.render(diagram(1));
    registry.unregister("archify");
    // Operation ids are diagram-scoped, so removing the adapter must cancel its work anyway.
    expect((await pending).status).toBe("cancelled");
    expect(hanging.disposed).toBe(true);
    expect(registry.list()).toHaveLength(0);
  });
});

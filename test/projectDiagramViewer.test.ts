import { describe, expect, it } from "vitest";
import {
  DiagramTaskRegistry,
  archifyViewerBridgeScript,
  isAllowedEvidencePath,
  isDiagramExportPayload,
  isTrustedHostMessage,
  isTrustedViewerMessage,
  isViewerCommand,
  resolveDiagramTarget
} from "../src/projectDiagramViewer.js";
import { projectDiagramScript } from "../src/webview/projectArchitectureView.js";
import type { ProjectDiagram } from "../src/core/projectDiagram.js";

const diagram = (id: string, version: number): ProjectDiagram => ({
  schemaVersion: 1, id, title: id, kind: "architecture", version, updatedAt: version,
  nodes: [{ id: "n", label: "N", role: "system", semanticIds: [], evidence: [] }], relations: []
});

describe("viewer message validation", () => {
  it("accepts only messages from the sandboxed frame with the matching session", () => {
    const frame = { name: "frame" };
    expect(isTrustedViewerMessage(frame, frame, { __dext: "s1", type: "dext-diagram-ready" }, "s1")).toBe(true);
    expect(isTrustedViewerMessage({ name: "other" }, frame, { __dext: "s1" }, "s1")).toBe(false);
    expect(isTrustedViewerMessage(frame, frame, { __dext: "wrong" }, "s1")).toBe(false);
    expect(isTrustedViewerMessage(frame, frame, null, "s1")).toBe(false);
  });

  it("treats VS Code host messages as trusted and never accepts bridge-shaped messages from outside the frame", () => {
    const frame = { name: "frame" };
    expect(isTrustedHostMessage(null, frame, { type: "projectDiagramRendered" })).toBe(true);
    expect(isTrustedHostMessage(frame, frame, { type: "dext-diagram-export" })).toBe(false);
    expect(isTrustedHostMessage(null, frame, { __dext: "s1", type: "dext-diagram-export" })).toBe(false);
    expect(isTrustedHostMessage(null, frame, "text")).toBe(false);
  });

  it("allows only the bounded viewer command set", () => {
    for (const command of ["map", "theme", "export-svg", "search", "zoom-in", "zoom-out", "reset"]) expect(isViewerCommand(command)).toBe(true);
    for (const command of ["eval", "reload", "", 1, null]) expect(isViewerCommand(command)).toBe(false);
  });

  it("resolves diagram actions by stable id and semantic version", () => {
    const diagrams = [diagram("view", 3), diagram("other", 1)];
    expect(resolveDiagramTarget(diagrams, "view", 3)).toMatchObject({ ok: true, diagram: { id: "view" } });
    expect(resolveDiagramTarget(diagrams, "view", 2)).toMatchObject({ ok: false });
    expect(resolveDiagramTarget(diagrams, "missing", 1)).toMatchObject({ ok: false });
    expect(resolveDiagramTarget(diagrams, "", 1)).toMatchObject({ ok: false });
  });

  it("requires standalone HTML and script-free SVG for the displayed version", () => {
    expect(isDiagramExportPayload("html", "<!DOCTYPE html><html><body>x</body></html>", 2, 2)).toBe(true);
    expect(isDiagramExportPayload("html", "<div>x</div>", 2, 2)).toBe(false);
    expect(isDiagramExportPayload("svg", "<svg><style/></svg>", 2, 2)).toBe(true);
    expect(isDiagramExportPayload("svg", "<svg><script>alert(1)</script></svg>", 2, 2)).toBe(false);
    expect(isDiagramExportPayload("svg", "<svg/>", 2, 3)).toBe(false);
    expect(isDiagramExportPayload("png", "bytes", 2, 2)).toBe(false);
  });

  it("rejects unsafe evidence paths before the host opens a file", () => {
    expect(isAllowedEvidencePath("src/app.ts")).toBe(true);
    expect(isAllowedEvidencePath("../outside.ts")).toBe(false);
    expect(isAllowedEvidencePath("/etc/passwd")).toBe(false);
    expect(isAllowedEvidencePath("C:/secret.txt")).toBe(false);
    expect(isAllowedEvidencePath(".env")).toBe(false);
    expect(isAllowedEvidencePath("node_modules/pkg/index.js")).toBe(false);
  });

  it("injects a self-contained bridge that cannot terminate the outer document", () => {
    const bridge = archifyViewerBridgeScript("session-1", "light");
    expect(bridge).toContain("session-1");
    expect(bridge).toContain("dext-diagram-command");
    expect(bridge).toContain("export-svg");
    expect(bridge).toContain("postMessage");
    expect(bridge).not.toContain("</script>");
  });

  it("ships the tested trust helpers in the parent bridge instead of a second copy", () => {
    // The bridge runs inside a template string, so a hand-written duplicate of these rules could
    // drift from what the unit tests above cover. It embeds the functions themselves.
    const script = projectDiagramScript();
    expect(script).toContain(isTrustedViewerMessage.toString());
    expect(script).toContain(isTrustedHostMessage.toString());
  });
});

describe("diagram task lifecycle", () => {
  it("cancels stale tasks for the same key and only completes the active one", () => {
    const tasks = new DiagramTaskRegistry();
    const first = tasks.begin("render:view");
    const second = tasks.begin("render:view");
    expect(first.aborted).toBe(true);
    expect(second.aborted).toBe(false);
    expect(tasks.finish("render:view", first)).toBe(false);
    expect(tasks.finish("render:view", second)).toBe(true);
    expect(tasks.activeKeys).toEqual([]);
  });

  it("cleans every listener and task when switching diagrams or closing the page", () => {
    const tasks = new DiagramTaskRegistry();
    const render = tasks.begin("render:view");
    const generate = tasks.begin("generate");
    tasks.cancelAll();
    expect(render.aborted).toBe(true);
    expect(generate.aborted).toBe(true);
    expect(tasks.activeKeys).toEqual([]);
  });
});

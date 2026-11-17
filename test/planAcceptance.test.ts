import { describe, expect, it } from "vitest";
import { planAcceptanceItems, planTodoItems } from "../src/features/conversations/domain/planTodoProgress.js";
import {
  identifyPlanAcceptance, mergePlanAcceptance, planAcceptanceId, planAcceptanceProgress, togglePlanAcceptance
} from "../src/features/conversations/domain/planAcceptance.js";

const plan = [
  "# Plan",
  "",
  "## Tasks",
  "",
  "1. [ ] Add the parser",
  "2. [ ] Add the panel group",
  "3. [ ] Run the checks",
  "",
  "## Verification",
  "",
  "| Check | Command | Expected |",
  "| --- | --- | --- |",
  "| Unit | `npm test` | Pass |",
  "",
  "## Acceptance",
  "",
  "- [ ] Open the sidebar and press Build: the acceptance group appears below the tasks",
  "- [ ] Click the first checkbox: the header count changes to 1/2",
  "",
  "## Risks",
  "",
  "- [ ] This checklist is a risk note, not acceptance"
].join("\n");

describe("plan acceptance", () => {
  it("parses acceptance apart from tasks, without plan IDs", () => {
    const tasks = planTodoItems(plan);
    const acceptance = planAcceptanceItems(plan);
    expect(tasks.map((item) => item.id)).toEqual(["plan-1", "plan-2", "plan-3"]);
    expect(tasks.map((item) => item.text)).toEqual(["Add the parser", "Add the panel group", "Run the checks"]);
    expect(acceptance.map((item) => item.text)).toEqual([
      "Open the sidebar and press Build: the acceptance group appears below the tasks",
      "Click the first checkbox: the header count changes to 1/2"
    ]);
    expect(acceptance.every((item) => !item.id.startsWith("plan-"))).toBe(true);
    expect(acceptance.every((item) => item.checked === false)).toBe(true);
  });

  it("keeps document order and the initial checked state", () => {
    const acceptance = planAcceptanceItems("## Acceptance\n\n- [ ] First\n- [x] Second\n1. [X] Third");
    expect(acceptance.map((item) => [item.text, item.checked])).toEqual([
      ["First", false], ["Second", true], ["Third", true]
    ]);
    expect(new Set(acceptance.map((item) => item.id)).size).toBe(3);
  });

  it("accepts the three checklist styles and Chinese headings", () => {
    for (const heading of ["## Acceptance", "## User acceptance", "## 验收", "## 用户验收"]) {
      const acceptance = planAcceptanceItems(`${heading}\n- [ ] Dash\n* [x] Star\n1. [ ] Numbered`);
      expect(acceptance.map((item) => item.text)).toEqual(["Dash", "Star", "Numbered"]);
      expect(acceptance[1]?.checked).toBe(true);
    }
  });

  it("skips fenced examples and the checklists of other sections", () => {
    const source = [
      "## Tasks",
      "- [ ] A task",
      "",
      "## Acceptance",
      "",
      "```md",
      "- [ ] Example inside a fence",
      "```",
      "",
      "### Steps",
      "",
      "- [ ] Real acceptance item",
      "",
      "## Verification",
      "- [ ] Not acceptance",
      "- [ ] Not acceptance either"
    ].join("\n");
    expect(planAcceptanceItems(source).map((item) => item.text)).toEqual(["Real acceptance item"]);
    expect(planTodoItems(source).map((item) => item.text)).toEqual(["A task"]);
    // A bare bullet or a task line without a checkbox is not an acceptance item.
    expect(planAcceptanceItems("## Acceptance\n- Plain bullet\n- [x] Kept")).toEqual([
      { id: planAcceptanceId("Kept"), text: "Kept", checked: true }
    ]);
    expect(planAcceptanceItems("## Goal\n- [ ] Nothing here")).toEqual([]);
  });

  it("gives identical wording separate IDs", () => {
    const acceptance = planAcceptanceItems("## Acceptance\n- [ ] Restart the extension\n- [ ] Restart the extension\n- [ ] Restart the extension");
    const ids = acceptance.map((item) => item.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids[1]).toBe(`${ids[0]}-2`);
    expect(ids[2]).toBe(`${ids[0]}-3`);
  });

  it("normalises wording for identity, and repeated text is numbered by order", () => {
    expect(planAcceptanceId("  Open   the Sidebar ")).toBe(planAcceptanceId("open the sidebar"));
    expect(identifyPlanAcceptance([{ text: "Same", checked: false }, { text: " same ", checked: true }]).map((item) => item.id))
      .toEqual([planAcceptanceId("Same"), `${planAcceptanceId("Same")}-2`]);
  });

  it("keeps checks across a reorder and an insertion, and resets a rewritten item", () => {
    const previous = planAcceptanceItems("## Acceptance\n- [x] A\n- [ ] B");
    const reordered = planAcceptanceItems("## Acceptance\n- [ ] C\n- [ ] B\n- [ ] A");
    expect(mergePlanAcceptance(reordered, previous).map((item) => [item.text, item.checked])).toEqual([
      ["C", false], ["B", false], ["A", true]
    ]);
    const rewritten = planAcceptanceItems("## Acceptance\n- [ ] A but different\n- [ ] B");
    expect(mergePlanAcceptance(rewritten, previous).map((item) => item.checked)).toEqual([false, false]);
  });

  it("toggles one item at a time", () => {
    const acceptance = planAcceptanceItems("## Acceptance\n- [ ] A\n- [ ] B");
    const once = togglePlanAcceptance(acceptance, acceptance[1]!.id, true);
    expect(once.map((item) => item.checked)).toEqual([false, true]);
    expect(togglePlanAcceptance(once, acceptance[1]!.id, false).map((item) => item.checked)).toEqual([false, false]);
    // The input list is never mutated, so a rejected request cannot leak state.
    expect(acceptance.map((item) => item.checked)).toEqual([false, false]);
    expect(togglePlanAcceptance(acceptance, "missing", true).map((item) => item.checked)).toEqual([false, false]);
  });

  it("counts the acceptance group on its own", () => {
    const acceptance = planAcceptanceItems("## Acceptance\n- [x] A\n- [ ] B\n- [ ] C");
    expect(planAcceptanceProgress(acceptance)).toEqual({ total: 3, checked: 1, complete: false, remaining: 2 });
    expect(planAcceptanceProgress(togglePlanAcceptance(togglePlanAcceptance(acceptance, acceptance[1]!.id, true), acceptance[2]!.id, true)))
      .toEqual({ total: 3, checked: 3, complete: true, remaining: 0 });
    expect(planAcceptanceProgress([])).toEqual({ total: 0, checked: 0, complete: false, remaining: 0 });
    expect(planTodoItems(plan)).toHaveLength(3);
  });
});

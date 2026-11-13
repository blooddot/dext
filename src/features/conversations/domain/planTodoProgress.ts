import type { AgentStreamEvent, AgentTodoItem } from "../../../shared/contracts/types.js";
import { agentTodoEvent } from "../../agents/domain/agentTodoTracking.js";

const MARKER = "<!-- dext-todo:";

/** Read the document's task section, excluding examples and other checklists.
 * Checked boxes are explicit document state; prose is never treated as progress.
 * A `###` phase heading is not a task: it labels the steps after it, which the
 * panel collapses into one row so a long plan still reads as phases. */
export function planTodoItems(document: string): AgentTodoItem[] {
  const items: AgentTodoItem[] = [];
  let sectionLevel = 0;
  let fence: string | undefined;
  let phase: string | undefined;
  for (const line of document.split(/\r?\n/)) {
    const delimiter = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (delimiter) {
      if (!fence) fence = delimiter;
      else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      if (sectionLevel && heading[1]!.length <= sectionLevel) break;
      if (/^(tasks|todo(?:s)?|任务(?:列表)?|待办(?:事项|列表)?)$/i.test(heading[2]!)) sectionLevel = heading[1]!.length;
      else if (sectionLevel) phase = heading[2]!;
      continue;
    }
    if (!sectionLevel) continue;
    const task = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(\S.*)$/.exec(line);
    if (!task) continue;
    items.push({ id: `plan-${items.length + 1}`, text: task[2]!, status: task[1]?.toLowerCase() === "x" ? "completed" : "pending",
      ...(phase === undefined ? {} : { group: phase }) });
  }
  return items;
}

export function planTodoInstruction(items: readonly AgentTodoItem[]): string {
  if (!items.length) return "Use your native plan or task-tracking tool, if available, to publish tasks and update their status as you work.";
  return [
    "Dext shows the task IDs below in its Todo panel and cannot observe your work any other way: only these comments move it.",
    "Report cadence: as soon as a task's verify step succeeds, emit that task's completed update in the same message as the narration for it, together with the task you start next. Never batch several finished tasks into one comment at the end, and report any status the panel still lacks before your final response.",
    'Use exactly this machine-readable comment, with the actual task IDs and statuses: <!-- dext-todo: {"updates":[{"id":"plan-1","status":"completed"},{"id":"plan-2","status":"in_progress"}]} -->',
    'If the dext_update_todos tool is available, call it with that same object ({"updates":[…]} plus optional "blocked" and "verification") instead of writing the comment.',
    "Allowed statuses: pending, in_progress, completed. You may update several IDs in one comment. Dext consumes these comments and displays the task list. Emit them even if a native plan/task tool is unavailable. Do not write progress into the plan file.",
    "When resuming, verify existing changes before reporting completion. Keep unfinished tasks unfinished if execution stops.",
    'Continue all actionable tasks. For an external blocker, add "blocked":[{"id":"plan-1","reason":"Specific external condition needed"}] to a dext-todo report; do not classify difficult or unfinished work as blocked. Other tasks must continue.',
    'When the host requests final verification, check the implementation and required checks before reporting "verification":"passed" in a dext-todo report. Reopen any tasks that are incomplete. Do not claim verification merely because all boxes are checked.',
    JSON.stringify(items.map(({ id, text, status }) => ({ id, text, status })))
  ].join("\n");
}

/** Hide only our explicit progress protocol, including a marker split across
 * stream chunks. Other prose, HTML comments, and tool output remain untouched. */
export function stripPlanTodoProgress(text: string, streaming = false): string {
  let clean = text.replace(/<!-- dext-todo:[\s\S]*?-->/g, "");
  const incomplete = clean.indexOf(MARKER);
  if (incomplete >= 0) clean = clean.slice(0, incomplete);
  if (streaming) {
    for (let length = Math.min(clean.length, MARKER.length - 1); length > 0; length--) {
      if (clean.endsWith(MARKER.slice(0, length))) return clean.slice(0, -length);
    }
  }
  return clean;
}

/** The raw tail that may still grow into a progress comment: an unterminated
 * marker, or the fragment of one at the very end. */
function pendingMarker(text: string): string {
  let consumed = 0;
  for (const match of text.matchAll(/<!-- dext-todo:[\s\S]*?-->/g)) consumed = match.index + match[0].length;
  const rest = text.slice(consumed);
  const open = rest.indexOf(MARKER);
  if (open >= 0) return rest.slice(open);
  for (let length = Math.min(rest.length, MARKER.length - 1); length > 0; length--) {
    if (rest.endsWith(MARKER.slice(0, length))) return rest.slice(-length);
  }
  return "";
}

/** Scoped to one execution. The document supplies the initial list; only
 * explicit, validated status reports can change it. */
export class PlanTodoProgress {
  private readonly messages = new Map<string, { visible: string; hold: string; processed: Set<string>; length: number }>();
  private readonly items: AgentTodoItem[];
  private readonly blocked = new Map<string, string>();
  private verifying = false;
  verified = false;

  constructor(items: readonly AgentTodoItem[]) { this.items = items.map((item) => ({ ...item })); }

  initial(): AgentStreamEvent { return agentTodoEvent(this.items); }
  snapshot(): AgentTodoItem[] { return this.items.map((item) => ({ ...item })); }
  blockers(): { id: string; reason: string }[] {
    return this.items.filter((item) => item.status !== "completed" && this.blocked.has(item.id))
      .map((item) => ({ id: item.id, reason: this.blocked.get(item.id)! }));
  }
  beginRound(verifying: boolean): void { this.messages.clear(); this.verifying = verifying; this.verified = false; }

  consume(event: AgentStreamEvent): AgentStreamEvent[] {
    // The plan's stable IDs drive this panel. A provider's native task list is
    // not ours to show: only plan execution owns the Todo panel.
    if (event.phase === "todo") return [];
    if (event.phase !== "message") return [event];
    const id = event.id ?? "plan-progress";
    const state = this.messages.get(id) ?? { visible: "", hold: "", processed: new Set<string>(), length: 0 };
    // Only the unstripped tail of the previous chunk is rescanned, so the cost per
    // chunk follows the chunk rather than the whole message.
    const base = event.replace ? { visible: "", hold: "", length: 0 } : state;
    const buffer = base.hold + event.text;
    const hold = event.done ? "" : pendingMarker(buffer);
    const fresh = buffer.slice(0, buffer.length - hold.length);
    let changed = false;
    for (const match of fresh.matchAll(/<!-- dext-todo:([\s\S]*?)-->/g)) {
      const key = `${base.length + match.index}:${match[1]}`;
      if (state.processed.has(key)) continue;
      state.processed.add(key);
      let parsed: unknown;
      try { parsed = JSON.parse(match[1]!); } catch { continue; }
      if (typeof parsed !== "object" || parsed === null) continue;
      if ("updates" in parsed && !Array.isArray(parsed.updates)) continue;
      const rawUpdates = "updates" in parsed ? parsed.updates as unknown[] : [];
      const updates: Array<{ item: AgentTodoItem; status: AgentTodoItem["status"] }> = [];
      for (const value of rawUpdates) {
        if (typeof value !== "object" || value === null || !("id" in value) || !("status" in value)) break;
        const item = this.items.find((candidate) => candidate.id === value.id);
        if (!item || !["pending", "in_progress", "completed"].includes(String(value.status))) break;
        updates.push({ item, status: value.status as AgentTodoItem["status"] });
      }
      if (updates.length !== rawUpdates.length) continue;
      if (this.verifying && "verification" in parsed && parsed.verification === "passed") this.verified = true;
      if ("blocked" in parsed && Array.isArray(parsed.blocked)) {
        for (const value of parsed.blocked as unknown[]) {
          if (!value || typeof value !== "object" || !("id" in value) || !("reason" in value)) continue;
          if (typeof value.id !== "string" || typeof value.reason !== "string" || !this.items.some((item) => item.id === value.id)) continue;
          if (value.reason.trim()) this.blocked.set(value.id, value.reason.trim().slice(0, 2000));
          else this.blocked.delete(value.id);
        }
      }
      for (const update of updates) {
        if (update.item.status !== update.status) changed = true;
        update.item.status = update.status;
        if (update.status === "completed") this.blocked.delete(update.item.id);
      }
    }
    const visible = base.visible + stripPlanTodoProgress(fresh);
    const output: AgentStreamEvent[] = changed ? [this.initial()] : [];
    if (visible !== state.visible) output.push({ ...event, id, text: visible, replace: true });
    this.messages.set(id, { visible, hold, processed: state.processed, length: base.length + fresh.length });
    return output;
  }
}

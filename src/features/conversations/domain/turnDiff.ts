import type { DextHistoryRecord } from "../contracts/history.js";
import type { DextResult } from "../../../shared/contracts/types.js";
import { readHistoryResponse } from "./historyResponse.js";
/** Written for a file the turn changed but never explained. */
export const NO_STATED_REASON = "no stated reason";

export interface TurnChange {
  path: string;
  /** The stored line that mentions the file, or NO_STATED_REASON. */
  reason: string;
}

/** A command line names the file but can be a whole script; keep its head only. */
const MAX_REASON_LENGTH = 140;

function resultText(result: DextResult): string {
  return "text" in result && typeof result.text === "string" ? result.text : "";
}

/** The text a turn already stored: its tool/command events and what the Agent
 * said. Status, todo and form frames carry no description of a file. */
function evidenceLines(record: DextHistoryRecord): string[] {
  const texts = [
    ...record.process.flatMap((event) =>
      event.phase === "status" || event.phase === "todo" || event.phase === "input" ? [] : [event.text]),
    ...(readHistoryResponse(record)?.executions ?? []).map((execution) => resultText(execution.result))
  ];
  return texts.flatMap((text) => text.split(/\r?\n/)).map((line) => line.trim()).filter(Boolean);
}

/** One entry per changed file: the first stored line that names it, whole path
 * first and bare file name second. Nothing is generated, so a file the turn
 * never mentioned says so instead of inheriting a neighbour's line. */
export function turnChanges(record: DextHistoryRecord): TurnChange[] {
  const paths = record.changedFiles ?? [];
  if (!paths.length) return [];
  const lines = evidenceLines(record);
  return paths.map((path) => {
    const name = path.split("/").pop() ?? path;
    // A name shorter than 5 characters matches too much prose to be evidence.
    const line = lines.find((text) => text.includes(path))
      ?? (name.length >= 5 ? lines.find((text) => text.includes(name)) : undefined);
    const reason = line ? (line.length <= MAX_REASON_LENGTH ? line : `${line.slice(0, MAX_REASON_LENGTH)}...`) : NO_STATED_REASON;
    return { path, reason };
  });
}

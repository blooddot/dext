import type { DextHistoryRecord } from "../contracts/history.js";
import type { DextResult } from "../../../shared/contracts/types.js";
import { readHistoryResponse } from "./historyResponse.js";
/** Written for a file the turn changed but never explained. */
export const NO_STATED_REASON = "no stated reason";

export interface TurnChange {
  path: string;
  /** What the turn said about the file, or NO_STATED_REASON. */
  reason: string;
}

/** A command line names the file but can be a whole script; keep its head only. */
const MAX_REASON_LENGTH = 140;
/** The Agent's own bullets under a file heading are prose meant to be read. */
const MAX_SECTION_LENGTH = 260;

const BULLET = /^[-*+•]\s+/;
/** A line that names files and nothing else: `**`a.ts`**`, or `## path`. */
const SECTION_HEAD = /^(?:\*\*.*\*\*|#{1,6}\s.*)$/;

function resultText(result: DextResult): string {
  return "text" in result && typeof result.text === "string" ? result.text : "";
}

/** The text a turn already stored. The Agent's own words come first: a tool
 * event can name the file while saying nothing about it. Status, todo and form
 * frames carry no description of a file. */
function evidenceLines(record: DextHistoryRecord): string[] {
  const texts = [
    ...(readHistoryResponse(record)?.executions ?? []).map((execution) => resultText(execution.result)),
    ...record.process.flatMap((event) =>
      event.phase === "status" || event.phase === "todo" || event.phase === "input" ? [] : [event.text])
  ];
  return texts.flatMap(textLines);
}

/** A fenced block is code or command output the turn quoted, not its account of
 * the change: `31: import …` names the file and explains nothing. */
function textLines(text: string): string[] {
  let fenced = false;
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s{0,3}(?:```|~~~)/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    const line = raw.trim();
    if (!fenced && line) lines.push(line);
  }
  return lines;
}

function names(line: string, path: string, name: string): boolean {
  return line.includes(path) || (name.length >= 5 && line.includes(name));
}

/** The Agent's usual per-file section — `**`a.ts`**` followed by its bullets — is
 * the description it wrote on purpose; everything else is a line that happens
 * to name the file. */
function sectionReason(lines: string[], path: string, name: string): string | undefined {
  const head = lines.findIndex((line) => SECTION_HEAD.test(line) && names(line, path, name));
  if (head < 0) return undefined;
  // Bullets are kept whole: half a sentence reads worse than one bullet less.
  let reason = "";
  for (let next = head + 1; next < lines.length && BULLET.test(lines[next] ?? ""); next += 1) {
    const bullet = describeLine((lines[next] ?? "").replace(BULLET, ""), path, name);
    const joined = reason ? `${reason} · ${bullet}` : bullet;
    if (joined.length > MAX_SECTION_LENGTH) return reason ? `${reason}...` : `${joined.slice(0, MAX_SECTION_LENGTH)}...`;
    reason = joined;
  }
  return reason || undefined;
}

function clip(reason: string, limit: number): string {
  return reason.length <= limit ? reason : `${reason.slice(0, limit)}...`;
}

/** The turn's own words about one file, with its markdown scaffolding removed:
 * a table row keeps its other cells (reason, then detail), a line that starts
 * with the path keeps the text after it, and prose naming the file mid-sentence
 * stays whole because the sentence is the description. */
function describeLine(line: string, path: string, name: string): string {
  const cells = line.startsWith("|") ? line.replace(/^\||\|$/g, "").split("|").map((cell) => cell.replace(/[`*]/g, "").trim()) : [];
  if (cells.length > 1) {
    const rest = cells.filter((cell) => cell && !cell.includes(path) && !cell.includes(name) && !/^:?-{2,}:?$/.test(cell));
    if (rest.length) return rest.join(" — ");
  }
  const plain = line.replace(/[`*]/g, "").replace(/^[\s>*+\-•]+/, "");
  for (const mention of [path, name]) {
    if (!plain.startsWith(mention)) continue;
    const rest = plain.slice(mention.length).replace(/^[:：—–\-\s]+/, "").trim();
    if (rest) return rest;
  }
  return line;
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
    const section = sectionReason(lines, path, name);
    if (section) return { path, reason: section };
    // A name shorter than 5 characters matches too much prose to be evidence.
    const line = lines.find((text) => text.includes(path))
      ?? (name.length >= 5 ? lines.find((text) => text.includes(name)) : undefined);
    if (!line) return { path, reason: NO_STATED_REASON };
    return { path, reason: clip(describeLine(line, path, name), MAX_REASON_LENGTH) };
  });
}

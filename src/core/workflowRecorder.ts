import type { DextResult, InputExecutionResponse } from "./types.js";

/** Just enough of a history turn to record it, so the recorder stays free of the
 * storage layer and can be exercised without a Memento. */
export interface RecordedTurn {
  input: string;
  mode?: "agent" | "ask" | "plan" | "code";
  response?: InputExecutionResponse;
  error?: string;
}

export interface RecordedWorkflow {
  /** Suggested file name below `.dext/api`, including the `.dx` extension. */
  fileName: string;
  /** The dotted API id the file will register as once it is saved. */
  apiId: string;
  source: string;
}

/** Turns shorter than this say nothing about what the workflow does, so they are
 * not considered as a title. */
const MIN_TITLE_LENGTH = 3;

const RESULT_TYPES: Record<string, string> = {
  chat: "ChatResult",
  agent: "AgentResult",
  terminal: "TerminalResult",
  apply: "ApplyResult",
  print: "PrintResult",
  text: "TextResult",
  code: "CodeResult",
  explain: "ExplainResult",
  edit: "EditResult",
  review: "ReviewResult",
  plan: "PlanResult",
  patch: "PatchResult"
};

/** The name is derived from the first turn so the generated file lands somewhere
 * recognizable, and is reduced to what a dotted API id allows. */
export function recordedApiName(turns: readonly RecordedTurn[]): string {
  const first = turns.find((turn) => turn.input.trim().length >= MIN_TITLE_LENGTH)?.input ?? "";
  const slug = first
    .toLowerCase()
    .replace(/@[^\s]+/g, " ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40)
    .replace(/_+$/, "");
  // An API id is a dotted identifier, so a leading digit or underscore has to go.
  return slug.replace(/^[0-9_]+/, "") || "recorded_workflow";
}

function quote(value: string): string {
  const escaped = value.replaceAll("\\", "\\\\");
  // A multi-line prompt keeps its shape in a triple-quoted string rather than
  // being flattened into one unreadable line.
  if (!value.includes("\n")) return `"${escaped.replaceAll('"', '\\"')}"`;
  return `"""\n${escaped.replaceAll('"""', '\\"\\"\\"')}\n"""`;
}

function lastResult(turn: RecordedTurn): DextResult | undefined {
  return turn.response?.executions.at(-1)?.result;
}

/** A confirmation the conversation actually went through becomes a gate in the
 * workflow, because the person replaying it deserves the same stopping point. */
function confirmations(turn: RecordedTurn): string[] {
  const messages: string[] = [];
  for (const execution of turn.response?.executions ?? []) {
    if (execution.method.id !== "ui.confirm") continue;
    const message = execution.invocation.arguments.find((argument) => argument.name === "message")?.value;
    messages.push(typeof message === "string" && message.trim() ? message.trim() : "Continue?");
  }
  return messages;
}

/** Strings that show up in more than one turn are the workflow's real inputs, so
 * they are lifted into `main()` parameters instead of being pasted twice. */
function sharedParameters(turns: readonly RecordedTurn[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const turn of turns) {
    const text = turn.input.trim();
    if (text.length < MIN_TITLE_LENGTH) continue;
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  const shared = new Map<string, string>();
  let index = 0;
  for (const [text, count] of counts) {
    if (count < 2) continue;
    index += 1;
    shared.set(text, index === 1 ? "prompt" : `prompt_${index}`);
  }
  return shared;
}

function methodFor(turn: RecordedTurn): string {
  if (turn.mode === "ask" || turn.mode === "plan") return turn.mode;
  return "agent";
}

/** Builds a `.dx` skeleton from a recorded conversation. The result is meant to
 * be edited, not run as-is: the point is skipping the blank file, so a turn that
 * cannot be expressed is left as a comment rather than dropped or guessed at. */
export function recordWorkflow(turns: readonly RecordedTurn[]): RecordedWorkflow {
  const usable = turns.filter((turn) => turn.input.trim() && !turn.error);
  if (!usable.length) {
    throw new Error("This conversation has no successful turn to record.");
  }
  const name = recordedApiName(usable);
  const shared = sharedParameters(usable);
  const parameters = [...new Set(shared.values())].map((parameter) => `${parameter}: str`);
  const lines: string[] = [];
  const body: string[] = [];
  let lastVariable = "";
  let returnType = "ChatResult";
  for (const [index, turn] of usable.entries()) {
    const text = turn.input.trim();
    for (const [order, message] of confirmations(turn).entries()) {
      // The gate is emitted as a plain step rather than an `if` around the rest
      // of the workflow: a skeleton that compiles is more useful than one that
      // guesses which steps the answer was meant to guard.
      const gate = `gate_${index + 1}_${order + 1}`;
      body.push(`${gate} = ui.confirm(message=${quote(message)})`);
      body.push(`# Gate the step below on ${gate}.confirmed once you decide what a No should skip.`);
    }
    if (turn.mode === "code") {
      // A Code-mode turn was already a workflow; re-wrapping it in an agent call
      // would change what it does, so its source is left for the author to paste.
      body.push(`# Code-mode turn ${index + 1} ran this workflow directly:`);
      for (const line of text.split("\n")) body.push(`# ${line}`);
      continue;
    }
    const variable = `step_${index + 1}`;
    const argument = shared.get(text) ?? quote(text);
    const method = methodFor(turn);
    body.push(`${variable} = ${method}(input=${argument}${method === "agent" ? ", apply=False" : ""})`);
    lastVariable = variable;
    const kind = lastResult(turn)?.kind;
    returnType = (kind && RESULT_TYPES[kind]) ?? (method === "agent" ? "AgentResult" : "ChatResult");
  }
  if (!lastVariable) {
    // Every turn was Code mode, so there is nothing to return but a note.
    body.push('return print(text="Fill in the steps above.")');
    returnType = "PrintResult";
  } else {
    body.push(`return ${lastVariable}`);
  }
  lines.push(`# Recorded from a Dext conversation on ${new Date().toISOString().slice(0, 10)}.`);
  lines.push("# Edit the steps below, then save to register this file as a reusable API.");
  lines.push(`def main(${parameters.join(", ")}) -> ${returnType}:`);
  for (const line of body) lines.push(`    ${line}`);
  return { fileName: `${name}.dx`, apiId: name, source: `${lines.join("\n")}\n` };
}

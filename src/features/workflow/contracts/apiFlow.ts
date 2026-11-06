/**
 * The function-level execution graph of an API module.
 *
 * This contract is deliberately renderer-independent: the analyser builds it
 * from source, the resource pages render it, and the creation rules read it.
 * Mermaid is only one possible presentation of the same graph.
 */

/** The built-in top-level APIs a wrapper function may label itself with. */
export const API_FLOW_TAGS = ["ask", "agent", "plan", "skill", "template", "terminal"] as const;

export type ApiFlowTag = (typeof API_FLOW_TAGS)[number];

export function isApiFlowTag(value: string): value is ApiFlowTag {
  return (API_FLOW_TAGS as readonly string[]).includes(value);
}

/** One direct call to a labelled built-in API, with the source line it appears on. */
export interface ApiFlowApiCall {
  tag: ApiFlowTag;
  /** 1-based line in the API module. */
  line: number;
  /** The identifier or member expression that was called. */
  callee: string;
}

/** One function node: a declaration, variable-bound function, or default export. */
export interface ApiFlowFunction {
  name: string;
  /** 1-based line of the implementation, or of the first signature for an overload. */
  line: number;
  /** An exported function is an entry point of the module. */
  exported: boolean;
  /** Direct calls to other functions in this same module, in source order. */
  calls: string[];
  /** Direct calls to the labelled built-in APIs, in source order. */
  apiCalls: ApiFlowApiCall[];
  /** Not reachable from any exported entry point. */
  unused: boolean;
}

export type ApiFlowIssueRule = "multiple-api-calls" | "api-wrapper-composes";

/** A creation-rule violation. Every issue currently blocks a new API's save. */
export interface ApiFlowIssue {
  rule: ApiFlowIssueRule;
  severity: "error";
  function: string;
  /** 1-based line of the function implementation. */
  line: number;
  message: string;
  suggestion: string;
}

export interface ApiFlowEdge {
  from: string;
  to: string;
  /** 1-based line of the first direct call. */
  line: number;
}

export type ApiFlowStepKind = "entry" | "step" | "decision" | "loop" | "end";

/** One statement of the entry function, or one control-flow point in it. */
export interface ApiFlowStep {
  /** Unique inside its entry flow; the entry node is 0. */
  id: number;
  kind: ApiFlowStepKind;
  /** `name L4` for a call, the condition for a decision or loop, the fixed end label. */
  label: string;
  /** Set when the step calls a labelled built-in API, directly or through a wrapper. */
  tag?: ApiFlowTag;
}

export interface ApiFlowStepEdge {
  from: number;
  to: number;
  /** The branch a decision edge takes. */
  label?: "yes" | "no";
}

/** The statement-level control flow of the module's entry function. */
export interface ApiFlowEntry {
  name: string;
  /** 1-based line of the entry implementation. */
  line: number;
  steps: ApiFlowStep[];
  edges: ApiFlowStepEdge[];
}

export interface ApiFlow {
  functions: ApiFlowFunction[];
  edges: ApiFlowEdge[];
  issues: ApiFlowIssue[];
  /** Absent when the entry function is missing, ambiguous or unparseable. */
  entry?: ApiFlowEntry;
}

export const EMPTY_API_FLOW: ApiFlow = { functions: [], edges: [], issues: [] };

/** A single reusable sentence for a violation, shared by the draft text and the save error. */
export function describeApiFlowIssue(issue: ApiFlowIssue): string {
  return `${issue.function} (line ${issue.line}): ${issue.message} ${issue.suggestion}`;
}

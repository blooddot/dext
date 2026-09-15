import { z } from "zod";
import type { ProjectObject } from "./projectKnowledge.js";
import type { RunIdentity } from "./turnReview.js";
import type { ProjectIntent } from "./projectIntent.js";
import { formatProjectReference, type ProjectReferenceCandidate } from "./projectReference.js";

/** Read-only picker data. Accepted items remain addressable when their evidence needs review. */
export function searchProjectReferences(options: {
  objects: readonly ProjectObject[];
  intent?: ProjectIntent | undefined;
  query: string;
  limit?: number;
}): ProjectReferenceCandidate[] {
  const candidates: ProjectReferenceCandidate[] = options.objects.filter((object) => object.confirmation === "accepted").map((object) => ({
    objectId: object.id, canonicalName: object.canonicalName, aliases: [...object.aliases], kind: object.kind,
    ...(object.displayName ? { displayName: object.displayName } : {}), token: formatProjectReference({ objectId: object.id, canonicalName: object.canonicalName })
  }));
  if (options.intent) {
    for (const [kind, items] of [["capability", options.intent.capabilities], ["context", options.intent.contexts], ["term", options.intent.terms]] as const) {
      for (const item of items) {
        if (item.review !== "accepted" && item.review !== "edited") continue;
        candidates.push({ objectId: item.id, canonicalName: item.canonicalName, kind,
          ...(item.displayName ? { displayName: item.displayName } : {}),
          aliases: "aliases" in item ? [...item.aliases] : [], token: formatProjectReference({ objectId: item.id, canonicalName: item.canonicalName }) });
      }
    }
  }
  const query = options.query.trim().toLocaleLowerCase();
  const matches = candidates.map((item) => ({ item, names: [item.canonicalName, item.displayName ?? "", ...item.aliases].map((name) => name.toLocaleLowerCase()) }))
    .filter(({ names }) => !query || names.some((name) => name.includes(query)))
    .sort((left, right) => Number(right.names.includes(query)) - Number(left.names.includes(query)) || left.item.canonicalName.localeCompare(right.item.canonicalName));
  // IDs are the identity shared by all Project views. Avoid duplicate completion entries.
  return [...new Map(matches.map(({ item }) => [item.objectId, item])).values()].slice(0, Math.max(0, Math.min(options.limit ?? 50, 200)));
}

export interface ProjectContextSnapshot {
  projectVersion: number;
  objectIds: string[];
  preset: ReviewPreset;
  text: string;
  createdAt: number;
}

export interface ProjectContextInput {
  input: string;
  objects: readonly ProjectObject[];
  relatedObjectIds?: readonly string[];
  maxCharacters?: number;
  projectVersion?: number;
  preset?: ReviewPreset;
}

export const reviewPresetSchema = z.enum(["engineering", "experience"]);
export type ReviewPreset = z.infer<typeof reviewPresetSchema>;

/** The two long-lived development presets, independent from Ask/Agent/Plan/Code modes. */
export interface ReviewPresetPresentation {
  id: ReviewPreset;
  title: string;
  summary: string;
  emphasis: "design" | "behavior";
  highlights: string[];
}

const PRESET_PRESENTATIONS: Record<ReviewPreset, ReviewPresetPresentation> = {
  engineering: {
    id: "engineering",
    title: "Engineering review",
    summary: "Highlights design, module boundaries, and the reasons behind the change.",
    emphasis: "design",
    highlights: ["Design decisions", "Module boundaries", "Code differences", "Dependency changes"]
  },
  experience: {
    id: "experience",
    title: "Experience acceptance",
    summary: "Highlights behavior and the manual scenarios a user still has to walk through.",
    emphasis: "behavior",
    highlights: ["Behavior change", "Manual scenarios", "User feedback", "Open acceptance items"]
  }
};

export function reviewPresetPresentation(preset: ReviewPreset): ReviewPresetPresentation {
  return PRESET_PRESENTATIONS[preset];
}

export interface ProjectPresetDefaults {
  preset: ReviewPreset;
}

export interface TurnPresetSelection {
  preset: ReviewPreset;
  origin: "project" | "override" | "builtin";
  /** Ask is always a read-only question; a preset never widens it. */
  readOnly: boolean;
  capturedAt: number;
}

export const BUILTIN_REVIEW_PRESET: ReviewPreset = "engineering";

/**
 * Freezes the effective preset at send time. A conversation-level override wins over the project
 * default, and Ask stays read-only no matter which preset is selected.
 */
export function resolveReviewPreset(options: {
  projectDefault?: ProjectPresetDefaults | undefined;
  override?: ReviewPreset | undefined;
  mode: "agent" | "plan" | "ask" | "code";
  now?: number;
}): TurnPresetSelection {
  const preset = options.override ?? options.projectDefault?.preset ?? BUILTIN_REVIEW_PRESET;
  const origin: TurnPresetSelection["origin"] = options.override
    ? "override"
    : options.projectDefault ? "project" : "builtin";
  return { preset, origin, readOnly: options.mode === "ask", capturedAt: options.now ?? Date.now() };
}

/** The preset frozen for one run, together with the run identity that owns it. */
export interface CapturedTurnPreset extends TurnPresetSelection {
  sessionId: string;
  turnId: string;
  runId: string;
  attempt: number;
  mode: "agent" | "plan" | "ask" | "code";
}

/**
 * Pins the effective preset to a run identity at send time. A retry gets a new run identity, so it
 * never silently reuses the previous attempt's preset or its read-only Ask scope.
 */
export function captureTurnPreset(identity: RunIdentity, selection: TurnPresetSelection, mode: CapturedTurnPreset["mode"]): CapturedTurnPreset {
  return {
    ...selection,
    sessionId: identity.sessionId,
    turnId: identity.turnId,
    runId: identity.runId,
    attempt: identity.attempt,
    mode
  };
}

export function presetForRun(captured: CapturedTurnPreset | undefined, identity: RunIdentity): TurnPresetSelection | undefined {
  if (!captured) return undefined;
  if (captured.sessionId !== identity.sessionId || captured.turnId !== identity.turnId || captured.runId !== identity.runId) return undefined;
  return {
    preset: captured.preset,
    origin: captured.origin,
    readOnly: captured.readOnly,
    capturedAt: captured.capturedAt
  };
}

function score(object: ProjectObject, input: string): number {
  const query = input.toLocaleLowerCase();
  return [object.canonicalName, object.displayName ?? "", ...object.aliases]
    .reduce((value, name) => value + (name && query.includes(name.toLocaleLowerCase()) ? 10 : 0), 0);
}

export function selectProjectObjects(options: ProjectContextInput): ProjectObject[] {
  const explicit = new Set(options.relatedObjectIds ?? []);
  return [...options.objects]
    .map((object) => ({ object, score: (explicit.has(object.id) ? 1000 : 0) + score(object, options.input) }))
    .filter((entry) => entry.score > 0 || explicit.has(entry.object.id))
    .sort((left, right) => right.score - left.score || left.object.canonicalName.localeCompare(right.object.canonicalName))
    .map((entry) => entry.object);
}

function boundedLines(blocks: string[], maxCharacters: number): string {
  const text = blocks.join("\n");
  return text.length > maxCharacters ? `${text.slice(0, Math.max(0, maxCharacters - 1))}…` : text;
}

/**
 * Builds a bounded knowledge snapshot. It works from whatever objects exist, so development from
 * Input never requires an initialized or confirmed Knowledge store.
 */
export function buildProjectContext(options: ProjectContextInput): ProjectContextSnapshot {
  const selected = selectProjectObjects(options);
  const lines = selected.flatMap((object) => [
    `Project object: ${object.canonicalName}${object.displayName ? ` (${object.displayName})` : ""}`,
    `Kind: ${object.kind}; confirmation: ${object.confirmation}; validity: ${object.validity}; source: ${object.source}; ownership: ${object.ownership}; confidence: ${object.confidence}`,
    `Description: ${object.description}`,
    ...(object.behavior.length ? [`Behavior:\n${object.behavior.map((item) => `- ${item}`).join("\n")}`] : []),
    ...(object.paths.length ? [`Implementation paths: ${object.paths.join(", ")}`] : [])
  ]);
  return {
    projectVersion: options.projectVersion ?? 0,
    objectIds: selected.map((object) => object.id),
    preset: options.preset ?? BUILTIN_REVIEW_PRESET,
    text: boundedLines(lines, options.maxCharacters ?? 24000),
    createdAt: Date.now()
  };
}

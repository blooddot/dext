import * as vscode from "vscode";

/**
 * Project knowledge sends bounded documentation, manifests and source excerpts to the selected AI
 * CLI. The budgets are settings rather than constants because the right size depends on the CLI's
 * context window and on how much of the repository the reader is willing to send.
 *
 * The defaults are calibrated against two real workspaces (a ~190-source-file TypeScript extension
 * and a ~480-module Python service with ~1M characters of documentation): 600,000 evidence
 * characters keep the prompt near 100k tokens, which fits a 200k-token CLI context while leaving
 * room for the response, and they still cover every README and manifest plus roughly forty source
 * excerpts per project.
 */
export const DEFAULT_PROJECT_EVIDENCE_CHARS = 600_000;
export const DEFAULT_PROJECT_EVIDENCE_FILES = 600;
export const DEFAULT_PROJECT_EVIDENCE_FILE_CHARS = 16_000;

/**
 * Depth presets are the interface: a reader chooses how much of the project the model may see.
 * `standard` keeps a prompt near 100k tokens, `deep` near 150k, and `whole` near 200k, which only
 * the largest-context CLIs can hold together with the schema and the response.
 */
export const PROJECT_EVIDENCE_DEPTHS = {
  standard: { chars: 600_000, files: 600, fileChars: 16_000 },
  deep: { chars: 900_000, files: 800, fileChars: 20_000 },
  whole: { chars: 1_200_000, files: 1_000, fileChars: 24_000 }
} as const;
export type ProjectEvidenceDepth = keyof typeof PROJECT_EVIDENCE_DEPTHS;
export const DEFAULT_PROJECT_EVIDENCE_DEPTH: ProjectEvidenceDepth = "standard";

/** Room for the instructions and the response schema on top of the evidence package. */
const PROMPT_OVERHEAD_CHARS = 160_000;
const DEFAULT_PROMPT_CHARS = 400_000;
const DEFAULT_OUTPUT_CHARS = 240_000;
const DEFAULT_OUTPUT_TOKENS = 32_000;

export interface ProjectEvidenceLimits {
  maxFiles: number;
  maxSourceFiles: number;
  maxFileChars: number;
  maxEvidenceChars: number;
  /** Empty keeps the built-in README/documentation/manifest/source globs. */
  include: string[];
  /** Active depth preset, recorded in the evidence summary so a run explains itself. */
  preset: string;
}

export interface ProjectAiLimits {
  maxInputChars: number;
  maxOutputChars: number;
  maxOutputTokens: number;
}

interface ConfigurationLike {
  get<T>(section: string, defaultValue: T): T;
  /** Present in VS Code; a test double may omit it and then every value counts as explicit. */
  inspect?<T>(section: string): { globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T } | undefined;
}

function bounded(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function evidenceDepth(configuration: ConfigurationLike): ProjectEvidenceDepth {
  const configured = configuration.get<string>("project.evidenceDepth", DEFAULT_PROJECT_EVIDENCE_DEPTH);
  return configured in PROJECT_EVIDENCE_DEPTHS ? configured as ProjectEvidenceDepth : DEFAULT_PROJECT_EVIDENCE_DEPTH;
}

/** An explicitly configured value overrides the preset; an untouched setting follows it. */
function configuredNumber(configuration: ConfigurationLike, section: string, fallback: number, minimum: number, maximum: number): number {
  const inspected = configuration.inspect?.<number>(section);
  const explicit = inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
  if (typeof explicit === "number") return bounded(explicit, fallback, minimum, maximum);
  if (inspected) return fallback;
  return bounded(configuration.get<number>(section, fallback), fallback, minimum, maximum);
}

export function projectEvidenceLimits(configuration: ConfigurationLike = vscode.workspace.getConfiguration("dext")): ProjectEvidenceLimits {
  const depth = evidenceDepth(configuration);
  const preset = PROJECT_EVIDENCE_DEPTHS[depth];
  const files = configuredNumber(configuration, "project.evidenceFiles", preset.files, 1, 1000);
  const configured = configuration.get<string[]>("project.evidenceInclude", []);
  return {
    maxFiles: files,
    maxSourceFiles: files,
    maxFileChars: configuredNumber(configuration, "project.evidenceFileChars", preset.fileChars, 512, 262_144),
    maxEvidenceChars: configuredNumber(configuration, "project.evidenceChars", preset.chars, 20_000, 1_200_000),
    // The workspace host validates each glob; malformed settings entries must not escape the root.
    include: (Array.isArray(configured) ? configured : [])
      .filter((pattern): pattern is string => typeof pattern === "string")
      .map((pattern) => pattern.trim())
      .filter((pattern) => pattern.length > 0)
      .slice(0, 20),
    preset: depth
  };
}

/** The prompt budget follows the evidence budget so raising one never strands the other. */
export function projectAiLimits(configuration: ConfigurationLike = vscode.workspace.getConfiguration("dext")): ProjectAiLimits {
  const evidenceChars = projectEvidenceLimits(configuration).maxEvidenceChars;
  return {
    maxInputChars: Math.max(DEFAULT_PROMPT_CHARS, evidenceChars + PROMPT_OVERHEAD_CHARS),
    maxOutputChars: DEFAULT_OUTPUT_CHARS,
    maxOutputTokens: DEFAULT_OUTPUT_TOKENS
  };
}

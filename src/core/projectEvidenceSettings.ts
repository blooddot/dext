import { z } from "zod";

export const PROJECT_EVIDENCE_DEPTHS = {
  standard: { chars: 600_000, files: 600, fileChars: 16_000 },
  deep: { chars: 900_000, files: 800, fileChars: 20_000 },
  whole: { chars: 1_200_000, files: 1_000, fileChars: 24_000 }
} as const;
export type ProjectEvidenceDepth = keyof typeof PROJECT_EVIDENCE_DEPTHS;

export const projectEvidenceSettingsSchema = z.object({
  depth: z.enum(["standard", "deep", "whole"]),
  files: z.number().int().min(1).max(1000).optional(),
  fileChars: z.number().int().min(512).max(262_144).optional(),
  chars: z.number().int().min(20_000).max(1_200_000).optional(),
  include: z.array(z.string().trim().min(1).max(512).refine((pattern) =>
    !/^[\\/]|^[A-Za-z]:|[\\\\:]/.test(pattern)
    && ![...pattern].some((character) => character.charCodeAt(0) < 32)
    && !pattern.split("/").some((part) => part === ".." || part === "." || !part),
  "Use workspace-relative globs without parent traversal.")).max(20)
}).strict();
export type ProjectEvidenceSettings = z.infer<typeof projectEvidenceSettingsSchema>;

export function resolveProjectEvidenceSettings(settings: ProjectEvidenceSettings) {
  const preset = PROJECT_EVIDENCE_DEPTHS[settings.depth];
  const files = settings.files ?? preset.files;
  return {
    maxFiles: files, maxSourceFiles: files,
    maxFileChars: settings.fileChars ?? preset.fileChars,
    maxEvidenceChars: settings.chars ?? preset.chars,
    include: [...settings.include], preset: settings.depth
  };
}

/** Match the prompt budget to the evidence snapshot used by this run. */
export function projectPromptLimits(evidenceChars: number) {
  return { maxInputChars: Math.max(400_000, evidenceChars + 160_000), maxOutputChars: 240_000, maxOutputTokens: 32_000 };
}

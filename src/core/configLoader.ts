import { methodsFileSchema } from "./schemas.js";
import type { CallableDefinition, MethodSource } from "./types.js";

export interface ConfigFileCandidate {
  source: Exclude<MethodSource, "builtin">;
  path: string;
}

export interface ConfigLoadResult {
  methods: { definition: CallableDefinition; source: ConfigFileCandidate["source"] }[];
  diagnostics: string[];
  blocked: boolean;
}

export type ReadConfigFile = (path: string) => Promise<string | undefined>;

export async function loadMethodConfigs(
  trusted: boolean,
  candidates: readonly ConfigFileCandidate[],
  readFile: ReadConfigFile
): Promise<ConfigLoadResult> {
  if (!trusted) {
    return {
      methods: [],
      diagnostics: ["External method configuration is disabled in an untrusted workspace."],
      blocked: true
    };
  }

  const methods: ConfigLoadResult["methods"] = [];
  const diagnostics: string[] = [];
  for (const candidate of candidates) {
    let content: string | undefined;
    try {
      content = await readFile(candidate.path);
    } catch (error) {
      diagnostics.push(`${candidate.path}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (content === undefined) {
      continue;
    }
    try {
      const data: unknown = JSON.parse(content);
      const parsed = methodsFileSchema.parse(data);
      for (const definition of parsed.methods) {
        methods.push({ definition: definition as CallableDefinition, source: candidate.source });
      }
    } catch (error) {
      diagnostics.push(`${candidate.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { methods, diagnostics, blocked: false };
}

import { skill, type SkillResult } from "dext";
import { displayResult, nextStep } from "./shared.ts";

/**
 * Read the specs and the code and answer a question. Writes nothing.
 * @param input The question to explore.
 */
export async function explore(input = ""): Promise<SkillResult> {
  return displayResult(await skill({ skill: "openspec-explore", input }), "OpenSpec 探索结论",
    nextStep("结论会改变对外行为时 `spec.propose(\"…\")` 开一个 change；只是读代码到这里就结束。"));
}

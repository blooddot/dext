import { describe, expect, it } from "vitest";
import { githubTreeUrl, looksLikeGithubUrl, parseGithubUrl } from "../src/features/resources/domain/skillSource.js";

function parsed(value: string) {
  const result = parseGithubUrl(value);
  if ("error" in result) throw new Error(result.error);
  return result.source;
}

function error(value: string): string {
  const result = parseGithubUrl(value);
  if (!("error" in result)) throw new Error("expected an error");
  return result.error;
}

describe("GitHub skill source URLs", () => {
  it("parses a repository root", () => {
    expect(parsed("https://github.com/DietrichGebert/ponytail")).toMatchObject({
      kind: "repo", owner: "DietrichGebert", repo: "ponytail", path: "", repositoryUrl: "https://github.com/DietrichGebert/ponytail"
    });
    expect(parsed("https://github.com/acme/skills.git").repo).toBe("skills");
  });

  it("parses tree, blob and raw links", () => {
    expect(parsed("https://github.com/acme/skills/tree/main/skills/review")).toMatchObject({
      kind: "tree", owner: "acme", repo: "skills", ref: "main", path: "skills/review"
    });
    expect(parsed("https://github.com/acme/skills/blob/main/skills/review/SKILL.md")).toMatchObject({
      kind: "blob", ref: "main", path: "skills/review", skillFile: "skills/review/SKILL.md"
    });
    expect(parsed("https://raw.githubusercontent.com/acme/skills/main/skills/review/SKILL.md")).toMatchObject({
      kind: "raw", ref: "main", path: "skills/review", skillFile: "skills/review/SKILL.md"
    });
    expect(parsed("https://www.github.com/acme/skills/tree/main/skills/review")).toMatchObject({
      kind: "tree", owner: "acme", repo: "skills", path: "skills/review"
    });
    expect(parsed("https://github.com/acme/skills/blob/main/SKILL.md")).toMatchObject({ path: "", skillFile: "SKILL.md" });
  });

  it("rejects credentials, ports, queries, fragments, encoded slashes and unsupported hosts", () => {
    expect(error("https://user:pass@github.com/acme/skills")).toContain("credentials");
    expect(error("https://github.com:443/acme/skills")).toContain("port");
    expect(error("https://github.com/acme/skills?tab=readme")).toContain("query");
    expect(error("https://github.com/acme/skills#readme")).toContain("fragment");
    expect(error("https://github.com/acme/skills/tree/main/skills%2Freview")).toContain("Encoded slashes");
    expect(error("https://gitlab.com/acme/skills")).toContain("Unsupported host");
    expect(error("http://github.com/acme/skills")).toContain("HTTPS");
    expect(error("https://gist.github.com/acme/1234")).toContain("Unsupported host");
    expect(error("ftp://github.com/acme/skills")).toContain("HTTPS");
  });

  it("rejects paths and blobs that cannot be a skill", () => {
    expect(error("https://github.com/acme/skills/tree/main/../secret")).toContain("path is invalid");
    expect(error("https://github.com/acme/skills/blob/main/skills/review/README.md")).toContain("Only a SKILL.md");
    expect(error("https://github.com/acme/skills/blob/main/commands/review.md")).toContain("command file");
    expect(error("https://raw.githubusercontent.com/acme/skills/main/commands/review.md")).toContain("raw SKILL.md");
    expect(error("https://github.com/acme/skills/tree")).toContain("missing its branch");
    expect(error("https://github.com/acme/skills/issues")).toContain("repository root");
  });

  it("builds candidate tree URLs for the ambiguity report", () => {
    const source = parsed("https://github.com/acme/skills/tree/main");
    expect(githubTreeUrl(source, "packages/a/skills")).toBe("https://github.com/acme/skills/tree/main/packages/a/skills");
  });

  it("recognizes a bare GitHub URL for the Describe warning", () => {
    expect(looksLikeGithubUrl("https://github.com/acme/skills")).toBe(true);
    expect(looksLikeGithubUrl(" https://raw.githubusercontent.com/acme/skills/main/SKILL.md ")).toBe(true);
    expect(looksLikeGithubUrl("please import https://github.com/acme/skills")).toBe(false);
    expect(looksLikeGithubUrl("acme/skills")).toBe(false);
  });
});

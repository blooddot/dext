import { afterEach, describe, expect, it, vi } from "vitest";
import * as archives from "../src/features/resources/host/githubArchive.js";
import { fetchGithubSkillSnapshot } from "../src/features/resources/host/githubSkillSnapshot.js";
import { importSkillPack } from "../src/features/resources/host/skillImporter.js";
import type { GithubSource } from "../src/features/resources/domain/skillSource.js";

const COMMIT = "a".repeat(40);
const TREE = "b".repeat(40);
const ROOT = "https://github.com/acme/skills";
const source: GithubSource = { kind: "repo", owner: "acme", repo: "skills", path: "", repositoryUrl: ROOT };
const skill = (name: string): string => `---\nname: ${name}\ndescription: Help with ${name}.\n---\n# ${name}\nRead the project.\n`;

interface Entry { path: string; type: string; mode: string; size?: number; sha?: string; }

function backend(contents: Record<string, string>, extra: Entry[] = [], truncated = false, releaseTag: string | null = "v1.2.3") {
  const tree: Entry[] = Object.entries(contents).map(([path, text]) => ({
    path, type: "blob", mode: "100644", size: new TextEncoder().encode(text).byteLength
  }));
  tree.push(...extra);
  const fetch = vi.fn(async (input: string) => {
    const url = String(input);
    if (url.endsWith("/releases/latest")) {
      return releaseTag
        ? Response.json({ tag_name: releaseTag, draft: false, prerelease: false })
        : new Response(null, { status: 404 });
    }
    if (url === "https://api.github.com/repos/acme/skills") return Response.json({ default_branch: "main" });
    if (url.includes("/commits/")) return Response.json({ sha: COMMIT, commit: { tree: { sha: TREE } } });
    if (url.includes(`/git/trees/${TREE}?recursive=1`)) return Response.json({ tree, truncated });
    const prefix = `https://raw.githubusercontent.com/acme/skills/${COMMIT}/`;
    if (url.startsWith(prefix)) {
      const path = decodeURIComponent(url.slice(prefix.length));
      if (contents[path] !== undefined) return new Response(contents[path]);
    }
    throw new Error(`Unexpected download: ${url}`);
  });
  return { fetch, tree };
}

afterEach(() => vi.restoreAllMocks());

describe("selective GitHub skill downloads", () => {
  it("downloads support for every imported Agent version without selecting a target", async () => {
    const { fetch, tree } = backend({
      "skills/review/SKILL.md": skill("review"),
      "skills/review/reference.md": "Shared support",
      ".codex/skills/review/SKILL.md": skill("review"),
      ".codex/skills/review/reference.md": "Codex support"
    });
    for (const entry of tree) entry.sha = entry.path.endsWith("SKILL.md") ? "1".repeat(40)
      : entry.path.startsWith(".codex") ? "2".repeat(40) : "3".repeat(40);
    const result = await importSkillPack(ROOT, { fetch: fetch as never });
    expect(result.manifest.skills.map((entry) => entry.agent).sort()).toEqual(["codex", "shared"]);
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith("/skills/review/reference.md") && !String(url).includes("/.codex/"))).toBe(true);
    expect(result.draft.files).toContainEqual({ path: "skills/review/reference.md", content: "Shared support" });
    expect(result.draft.files).toContainEqual({ path: "skill-packs/skills/variants/codex/skills/review/reference.md", content: "Codex support" });
  });

  it("imports the latest release tag instead of a development commit", async () => {
    const { fetch } = backend({ "skills/review/SKILL.md": skill("review") }, [], false, "v9.9.9");
    const result = await importSkillPack(ROOT, { fetch: fetch as never });
    expect(result.manifest.commit).toBe(COMMIT);
    expect(result.manifest.releaseTag).toBe("v9.9.9");
    expect(result.report).toContain("Release: v9.9.9");
    const urls = fetch.mock.calls.map(([url]) => String(url));
    expect(urls).toContain("https://api.github.com/repos/acme/skills/releases/latest");
    expect(urls.some((url) => url.includes("/commits/v9.9.9"))).toBe(true);
  });

  it("falls back to the default branch, with a note, when no release exists", async () => {
    const { fetch } = backend({ "skills/review/SKILL.md": skill("review") }, [], false, null);
    const result = await importSkillPack(ROOT, { fetch: fetch as never });
    expect(result.manifest.releaseTag).toBeUndefined();
    expect(result.manifest.notes).toContain("No published GitHub release was found; the default branch was imported.");
    const urls = fetch.mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => url.includes("/commits/main"))).toBe(true);
  });

  it("keeps an explicit tree ref instead of resolving a release", async () => {
    const { fetch } = backend({ "skills/review/SKILL.md": skill("review") }, [], false, "v9.9.9");
    const result = await importSkillPack(`${ROOT}/tree/next/skills/review`, { fetch: fetch as never });
    expect(result.manifest.releaseTag).toBeUndefined();
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith("/releases/latest"))).toBe(false);
  });

  it("selects before downloading support and ignores unrelated oversized assets", async () => {
    const { fetch } = backend({
      "packages/a/review/SKILL.md": skill("review"),
      "packages/a/review/reference.md": "Reference",
      "packages/b/deploy/SKILL.md": skill("deploy"),
      "LICENSE": "MIT",
      "commands/review.md": "---\nskill: review\ndescription: Review\n---\nReview $ARGUMENTS.\n"
    }, [
      { path: "assets/video.mp4", type: "blob", mode: "100644", size: 1024 ** 3 },
      { path: "packages/b/deploy/huge.txt", type: "blob", mode: "100644", size: 1024 ** 3 }
    ]);
    const result = await importSkillPack(ROOT, {
      fetch: fetch as never,
      analyzer: async (request) => {
        expect(request.candidates.find((candidate) => candidate.id === "review")?.fileCount).toBe(2);
        expect(fetch.mock.calls.some(([url]) => String(url).endsWith("reference.md"))).toBe(false);
        return { packName: "review", skillDirectories: ["packages/a/review"], excluded: [], confidence: "high", summary: "Review only" };
      }
    });
    expect(result.manifest.commit).toBe(COMMIT);
    expect(result.manifest.license).toBe("LICENSE");
    expect(result.manifest.commands[0]?.status).toBe("available");
    expect(result.draft.files).toContainEqual({ path: "skills/review/reference.md", content: "Reference" });
    const urls = fetch.mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => /huge\.txt|video\.mp4|codeload/.test(url))).toBe(false);
    expect(urls.filter((url) => url.includes("raw.githubusercontent.com")).every((url) => url.includes(COMMIT))).toBe(true);
  });

  it.each([
    "tree/main/skills/review",
    "blob/main/skills/review/SKILL.md",
    "raw"
  ])("keeps %s downloads inside its directory, plus the root license", async (suffix) => {
    const { fetch } = backend({
      "skills/review/SKILL.md": skill("review"),
      "skills/review/guide #1.md": "Guide",
      "skills/deploy/SKILL.md": skill("deploy"),
      "LICENSE": "MIT",
      "commands/deploy.md": "Deploy."
    });
    const url = suffix === "raw" ? "https://raw.githubusercontent.com/acme/skills/main/skills/review/SKILL.md" : `${ROOT}/${suffix}`;
    const result = await importSkillPack(url, { fetch: fetch as never });
    expect(result.manifest.skills.map((item) => item.id)).toEqual(["review"]);
    expect(result.draft.files).toContainEqual({ path: "skills/review/guide #1.md", content: "Guide" });
    expect(fetch.mock.calls.some(([input]) => String(input).includes("deploy"))).toBe(false);
    expect(result.manifest.license).toBe("LICENSE");
  });

  it("keeps nested skills as supporting files of a root skill", async () => {
    const { fetch } = backend({ "SKILL.md": skill("skills"), "references/inner/SKILL.md": skill("inner"), "references/guide.md": "Guide" });
    const result = await importSkillPack(ROOT, { fetch: fetch as never });
    expect(result.manifest.skills.map((item) => item.id)).toEqual(["skills"]);
    expect(result.draft.files).toContainEqual({ path: "skills/skills/references/guide.md", content: "Guide" });
  });

  it("ignores unrelated links but rejects a link selected as support", async () => {
    const { fetch } = backend({ "skills/review/SKILL.md": skill("review") }, [
      { path: "external", type: "commit", mode: "160000" },
      { path: "skills/review/link", type: "blob", mode: "120000", size: 20 }
    ]);
    await expect(importSkillPack(ROOT, { fetch: fetch as never })).rejects.toThrow("link or submodule");
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith("/link"))).toBe(false);
  });

  it.each(["../escape", "/absolute", "dir\\file", "a/./b"])("rejects unsafe index path %s", async (path) => {
    const { fetch } = backend({}, [{ path, type: "blob", mode: "100644", size: 1 }]);
    await expect(fetchGithubSkillSnapshot(source, { fetch: fetch as never })).rejects.toThrow("unsafe path");
  });

  it("rejects duplicate case-folded names", async () => {
    const { fetch } = backend({ "SKILL.md": "a", "skill.md": "b" });
    await expect(fetchGithubSkillSnapshot(source, { fetch: fetch as never })).rejects.toThrow("Duplicate GitHub entry");
  });

  it("preflights the selected byte and file budgets without downloading oversized support", async () => {
    const { fetch } = backend({ "SKILL.md": skill("skills") }, [
      { path: "big.txt", type: "blob", mode: "100644", size: 2048 }
    ]);
    await expect(importSkillPack(ROOT, { fetch: fetch as never, limits: { maxCompressedBytes: 1024 } })).rejects.toThrow("download limit");
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith("/big.txt"))).toBe(false);
    const snapshot = await fetchGithubSkillSnapshot(source, { fetch: fetch as never, limits: { maxFiles: 1 } });
    await expect(snapshot.loadFiles(["SKILL.md", "big.txt"])).rejects.toThrow("file limit");
  });

  it("detects raw content that does not match the pinned file size", async () => {
    const { fetch, tree } = backend({ "SKILL.md": "wrong size" });
    tree[0]!.size = 100;
    const snapshot = await fetchGithubSkillSnapshot(source, { fetch: fetch as never });
    await expect(snapshot.loadFiles(["SKILL.md"])).rejects.toThrow("unexpected size");
  });

  it.each(["truncated", "rate limited"])("falls back to the bounded archive when %s", async (reason) => {
    const archive = vi.spyOn(archives, "fetchGithubArchive").mockResolvedValue({
      source, ref: "HEAD", commit: COMMIT, files: new Map([["SKILL.md", new TextEncoder().encode(skill("skills"))]])
    });
    const normal = backend({}, [], true).fetch;
    const fetch = reason === "truncated" ? normal : vi.fn(async (input: string) =>
      String(input).endsWith("/releases/latest")
        ? Response.json({ tag_name: "v1.2.3" })
        : new Response(null, { status: 403 }));
    const result = await importSkillPack(ROOT, { fetch: fetch as never });
    expect(result.manifest.skills[0]?.id).toBe("skills");
    expect(archive).toHaveBeenCalledOnce();
    expect(archive.mock.calls[0]?.[0].ref).toBe(reason === "truncated" ? COMMIT : "v1.2.3");
  });

  it("does not hide an invalid repository behind an archive retry", async () => {
    const archive = vi.spyOn(archives, "fetchGithubArchive");
    const fetch = vi.fn(async () => new Response(null, { status: 404 }));
    await expect(fetchGithubSkillSnapshot(source, { fetch: fetch as never })).rejects.toThrow("GitHub returned 404");
    expect(archive).not.toHaveBeenCalled();
  });

  it("honors cancellation and timeouts during index lookup", async () => {
    const fetch = vi.fn((_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    await expect(fetchGithubSkillSnapshot(source, { fetch: fetch as never, limits: { timeoutMs: 5 } })).rejects.toThrow("within 5 ms");
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    await expect(fetchGithubSkillSnapshot(source, { fetch: fetch as never, signal: controller.signal })).rejects.toThrow("stopped");
    expect(fetch).toHaveBeenCalledOnce();
  });
});

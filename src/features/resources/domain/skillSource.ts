/** Public GitHub URL parsing for Skill Pack import. This module is pure: it
 * never fetches, and every returned path has already been checked. */

export type GithubSourceKind = "repo" | "tree" | "blob" | "raw";

export interface GithubSource {
  kind: GithubSourceKind;
  owner: string;
  repo: string;
  /** Directory inside the repository, without a leading slash. Empty for a
   * repository root or a root SKILL.md. */
  path: string;
  /** Branch, tag or commit from a tree/blob/raw URL. */
  ref?: string;
  /** For a blob/raw URL this is the SKILL.md path; it is not repeated in path. */
  skillFile?: string;
  /** The canonical repository URL, without credentials or tracking parts. */
  repositoryUrl: string;
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}$/;
const ALLOWED_HOSTS = new Set(["github.com", "raw.githubusercontent.com"]);

function safeSegment(value: string): boolean {
  return Boolean(value) && value !== "." && value !== ".." && !value.includes("\\")
    && !Array.from(value).some((character) => character.charCodeAt(0) < 32);
}

function splitPath(value: string): string[] | undefined {
  const segments = value.split("/").filter((segment) => segment !== "");
  return segments.every(safeSegment) ? segments : undefined;
}

function repositoryPath(segments: readonly string[]): string {
  return segments.join("/");
}

/** True for any GitHub web URL, including ones Import cannot handle. Describe
 * mode uses this to ask the user to switch modes instead of sending a URL to
 * the model as prose. */
export function looksLikeGithubUrl(value: string): boolean {
  return /^\s*https?:\/\/(?:www\.)?(?:github\.com|raw\.githubusercontent\.com)\/[^\s]+\s*$/i.test(value);
}

/** Parses a supported public GitHub URL. Unsupported shapes return a specific
 * error so the composer can explain the problem before any network call. */
export function parseGithubUrl(value: string): { source: GithubSource } | { error: string } {
  const input = value.trim();
  if (!input) return { error: "Paste a GitHub repository URL." };
  if (!/^https?:\/\//i.test(input)) return { error: "Only public GitHub HTTPS URLs are supported." };
  // The URL parser removes an explicit default port and normalizes `..`, so
  // both are rejected on the raw text first.
  if (/^https?:\/\/[^/?#]*:\d+/i.test(input)) return { error: "GitHub URLs with an explicit port are not supported." };
  const rawPath = input.replace(/^https?:\/\/[^/]+/i, "").split(/[?#]/)[0] ?? "";
  if (/(?:^|\/)\.\.?(?:\/|$)/.test(rawPath)) return { error: "The GitHub directory path is invalid." };
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { error: "The GitHub URL is invalid." };
  }
  if (url.protocol !== "https:") return { error: "Only public GitHub HTTPS URLs are supported." };
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (!ALLOWED_HOSTS.has(host)) return { error: `Unsupported host '${url.hostname}'. Paste a github.com or raw.githubusercontent.com URL.` };
  if (url.username || url.password) return { error: "GitHub URLs with credentials are not supported." };
  if (url.search) return { error: "GitHub URLs with a query string are not supported." };
  if (url.hash) return { error: "GitHub URLs with a fragment are not supported." };
  if (/%2f|%5c/i.test(url.pathname)) return { error: "Encoded slashes are not supported in GitHub URLs." };
  if (!url.pathname.startsWith("/")) return { error: "The GitHub URL has no repository path." };

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return { error: "Paste a link to a repository, directory, or SKILL.md file." };
  const owner = parts[0]!;
  const rawRepo = parts[1]!;
  const repo = rawRepo.replace(/\.git$/i, "");
  if (!OWNER.test(owner) || !REPO.test(repo)) return { error: "The GitHub owner or repository name is invalid." };
  const repositoryUrl = `https://github.com/${owner}/${repo}`;

  if (host === "raw.githubusercontent.com") {
    if (parts.length < 4) return { error: "A raw URL needs a branch and a SKILL.md path." };
    const ref = parts[2]!;
    const fileParts = parts.slice(3);
    const file = repositoryPath(fileParts);
    if (!/^SKILL\.md$/i.test(fileParts.at(-1) ?? "")) return { error: "Only a raw SKILL.md link can be imported." };
    return { source: { kind: "raw", owner, repo, path: fileParts.slice(0, -1).join("/"), ref, skillFile: file, repositoryUrl } };
  }

  const rest = parts.slice(2);
  if (!rest.length) return { source: { kind: "repo", owner, repo, path: "", repositoryUrl } };
  const action = rest[0];
  if (action !== "tree" && action !== "blob") {
    return { error: "Paste a repository root, a tree link, or a blob link to SKILL.md." };
  }
  if (rest.length < 2) return { error: `The ${action} URL is missing its branch.` };
  const ref = rest[1]!;
  if (!safeSegment(ref)) return { error: "The GitHub branch is invalid." };
  const restPath = rest.slice(2);
  if (action === "tree") {
    const segments = splitPath(restPath.join("/"));
    if (!segments) return { error: "The GitHub directory path is invalid." };
    return { source: { kind: "tree", owner, repo, path: segments.join("/"), ref, repositoryUrl } };
  }
  if (!restPath.length) return { error: "A blob URL must point to a SKILL.md file." };
  const segments = splitPath(restPath.join("/"));
  if (!segments) return { error: "The GitHub file path is invalid." };
  if (!/^SKILL\.md$/i.test(segments.at(-1) ?? "")) {
    return { error: "Only a SKILL.md file can be imported. A command file is not a skill." };
  }
  return {
    source: {
      kind: "blob", owner, repo, path: segments.slice(0, -1).join("/"), ref,
      skillFile: segments.join("/"), repositoryUrl
    }
  };
}

/** A tree URL for one candidate directory, used when an import cannot choose
 * between candidates. */
export function githubTreeUrl(source: GithubSource, path: string, ref = source.ref): string {
  const suffix = path ? `/${path}` : "";
  return `${source.repositoryUrl}/tree/${encodeURIComponent(ref ?? "HEAD")}${suffix}`;
}

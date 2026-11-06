import { renderMarkdownDiagrams, rerenderMarkdownDiagrams } from "../platform/browser/markdownDiagrams.js";

/**
 * Entry for host-rendered pages (History) that have no bundle of their own. Its
 * inline script calls this after inserting Markdown that may contain Mermaid
 * fences, so the shared lazy loader is used instead of a second copy. The
 * re-render entry recolours diagrams already on screen after an appearance
 * change.
 */
(globalThis as typeof globalThis & { dextRenderDiagrams?: typeof renderMarkdownDiagrams }).dextRenderDiagrams = renderMarkdownDiagrams;
(globalThis as typeof globalThis & { dextRerenderDiagrams?: typeof rerenderMarkdownDiagrams }).dextRerenderDiagrams = rerenderMarkdownDiagrams;

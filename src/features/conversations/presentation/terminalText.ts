/** One run of terminal text that shares a style. Host renders it as HTML,
 * Webview as DOM; the ANSI rules themselves live here once. */
export interface TerminalSegment {
  text: string;
  classes: string[];
  color?: string;
}

const ANSI_COLOR_CLASSES = [
  "ansi-black", "ansi-red", "ansi-green", "ansi-yellow",
  "ansi-blue", "ansi-magenta", "ansi-cyan", "ansi-white",
  "ansi-bright-black", "ansi-bright-red", "ansi-bright-green", "ansi-bright-yellow",
  "ansi-bright-blue", "ansi-bright-magenta", "ansi-bright-cyan", "ansi-bright-white"
];

const ANSI_COLORS = new Map<number, string>([
  [30, "ansi-black"], [31, "ansi-red"], [32, "ansi-green"], [33, "ansi-yellow"],
  [34, "ansi-blue"], [35, "ansi-magenta"], [36, "ansi-cyan"], [37, "ansi-white"],
  [90, "ansi-bright-black"], [91, "ansi-bright-red"], [92, "ansi-bright-green"], [93, "ansi-bright-yellow"],
  [94, "ansi-bright-blue"], [95, "ansi-bright-magenta"], [96, "ansi-bright-cyan"], [97, "ansi-bright-white"]
]);

const ANSI_PALETTE = [
  "#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
  "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff"
];

const ESCAPE = String.fromCharCode(27);
const BELL = String.fromCharCode(7);
const ANSI = new RegExp(
  `${ESCAPE}(?:\\[([0-9;]*)m|\\[[0-?]*[ -/]*[@-~]|\\][^${BELL}]*(?:${BELL}|${ESCAPE}\\\\))`,
  "g"
);

function ansi256Color(value: number): string {
  if (value < 16) return ANSI_PALETTE[value] ?? ANSI_PALETTE[7]!;
  if (value >= 232) {
    const gray = 8 + (value - 232) * 10;
    return `rgb(${gray}, ${gray}, ${gray})`;
  }
  const index = value - 16;
  const red = Math.floor(index / 36);
  const green = Math.floor((index % 36) / 6);
  const blue = index % 6;
  const channel = (component: number): number => component === 0 ? 0 : 55 + component * 40;
  return `rgb(${channel(red)}, ${channel(green)}, ${channel(blue)})`;
}

/** A number of CLIs (notably when launched through a JSON/non-TTY adapter)
 * deliberately omit ANSI SGR codes. Keep the output readable in that case by
 * highlighting the small, tool-agnostic vocabulary used by test runners and
 * shell prompts. This is only a fallback; real ANSI styling always wins. */
function plainTerminalClass(line: string): string | undefined {
  if (/^\s*(?:[>$]|PS [^>]*>)\s+/.test(line)) return "ansi-cyan";
  if (/\b(?:fail(?:ed|ure)?|errors?|fatal)\b|[✗×]/i.test(line)) return "ansi-red";
  if (/\b(?:pass(?:ed)?|success(?:ful)?|succeed(?:ed)?|ok)\b|✓/i.test(line)) return "ansi-green";
  if (/^\s*(?:RUN|Test Files|Tests|Snapshots|Start|Duration)\b/.test(line)) return "ansi-bright-blue";
  return undefined;
}

/** Progress tools redraw a line with a bare carriage return. Resolve that
 * redraw before the text reaches a <pre>, which cannot emulate a terminal
 * cursor. */
function normalizeTerminalText(content: string): string {
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("\r") + 1))
    .join("\n");
}

/** Split terminal output into styled runs. Background and reverse-video codes
 * are deliberately ignored to keep output readable. */
export function terminalSegments(source: string): TerminalSegment[] {
  const content = normalizeTerminalText(source);
  const segments: TerminalSegment[] = [];
  const append = (text: string, classes: ReadonlySet<string> | undefined, color: string | undefined): void => {
    if (!text) return;
    const list = classes ? [...classes] : [];
    segments.push(color === undefined ? { text, classes: list } : { text, classes: list, color });
  };

  if (!content.includes(ESCAPE)) {
    const lines = content.split("\n");
    lines.forEach((line, index) => {
      const className = plainTerminalClass(line);
      append(line, className ? new Set([className]) : undefined, undefined);
      if (index < lines.length - 1) append("\n", undefined, undefined);
    });
    return segments;
  }

  const active = new Set<string>();
  let foreground: string | undefined;
  let cursor = 0;
  for (const match of content.matchAll(ANSI)) {
    append(content.slice(cursor, match.index), active, foreground);
    const codes = match[1] === undefined ? [] : (match[1] ? match[1].split(";").map(Number) : [0]);
    for (let index = 0; index < codes.length; index += 1) {
      const code = codes[index] ?? 0;
      if (code === 0) {
        active.clear();
        foreground = undefined;
      } else if (code === 1) active.add("ansi-bold");
      else if (code === 2) active.add("ansi-dim");
      else if (code === 3) active.add("ansi-italic");
      else if (code === 4) active.add("ansi-underline");
      else if (code === 22) { active.delete("ansi-bold"); active.delete("ansi-dim"); }
      else if (code === 23) active.delete("ansi-italic");
      else if (code === 24) active.delete("ansi-underline");
      else if (code === 39) { for (const color of ANSI_COLOR_CLASSES) active.delete(color); foreground = undefined; }
      else {
        const color = ANSI_COLORS.get(code);
        if (color) {
          for (const existing of ANSI_COLOR_CLASSES) active.delete(existing);
          active.add(color);
          foreground = undefined;
        } else if ((code === 38 || code === 48) && codes[index + 1] === 5 && codes[index + 2] !== undefined) {
          if (code === 38) foreground = ansi256Color(codes[index + 2]!);
          index += 2;
        } else if ((code === 38 || code === 48) && codes[index + 1] === 2 && codes[index + 4] !== undefined) {
          if (code === 38) {
            const [red, green, blue] = codes.slice(index + 2, index + 5);
            foreground = `rgb(${red}, ${green}, ${blue})`;
          }
          index += 4;
        }
      }
    }
    cursor = match.index + match[0].length;
  }
  append(content.slice(cursor), active, foreground);
  return segments;
}

/** Detect only terminal protocol events. An assistant message or a completed
 * Todo list can still be followed by more work and must not end execution. */
export function cliCompletion(provider: "codex" | "claude"): (chunk: string) => number | undefined {
  let buffer = "";
  const terminal = (line: string): number | undefined => {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return undefined; }
    if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) return undefined;
    if (provider === "codex") {
      if (parsed.type === "turn.completed") return 0;
      if (parsed.type === "turn.failed") return 1;
    } else if (parsed.type === "result") {
      return ("is_error" in parsed && parsed.is_error === true)
        || ("subtype" in parsed && typeof parsed.subtype === "string" && parsed.subtype.startsWith("error")) ? 1 : 0;
    }
    return undefined;
  };
  return (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const code = terminal(line);
      if (code !== undefined) return code;
    }
    // Some shims flush the final JSON object without a trailing newline.
    return terminal(buffer);
  };
}

/** Turn language-service summaries into declarations understood by VS Code's Python grammar. */
export function pythonHoverCode(label: string): string {
  const shape = /^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*) \{ (.*) \}$/.exec(label);
  if (shape) {
    const fields = shape[2]!.split("; ").map((field) => {
      const match = /^([A-Za-z_]\w*)(\?)?: (.*)$/.exec(field);
      if (!match) return `    # ${field}`;
      const type = match[3]!
        .replace(/\bstring\b/g, "str")
        .replace(/\bboolean\b/g, "bool")
        .replace(/\bnumber\b/g, "float")
        .replace(/\b([A-Za-z_]\w*)\[\]/g, "list[$1]");
      return `    ${match[1]}: ${match[2] ? `${type} | None` : type}`;
    });
    return `class ${shape[1]}:\n${fields.join("\n")}`;
  }
  if (/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\(/.test(label)) return `def ${label}:\n    ...`;
  return label;
}

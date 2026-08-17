import type { SidebarState } from "../webviewProtocol.js";

type Method = SidebarState["methods"][number];

export interface MethodGroup {
  methods: Method[];
  children: Map<string, MethodGroup>;
}

/** The top-level builtin group is a display container, not a real namespace. */
export function isSyntheticBuiltinGroup(name: string, prefix: string, group: MethodGroup): boolean {
  return prefix === "" && name === "builtin" && group.methods.length > 0
    && group.methods.every((method) => method.source === "builtin" && !method.id.includes("."));
}

export function groupMethodsForDisplay(methods: Method[]): MethodGroup {
  const root: MethodGroup = { methods: [], children: new Map() };
  for (const method of methods) {
    // Public top-level built-ins are one capability set, while ui.* remains a namespace.
    if (method.source === "builtin" && !method.id.includes(".")) {
      let builtin = root.children.get("builtin");
      if (!builtin) {
        builtin = { methods: [], children: new Map() };
        root.children.set("builtin", builtin);
      }
      builtin.methods.push(method);
      continue;
    }
    const parts = method.id.split(".");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let child = node.children.get(part);
      if (!child) {
        child = { methods: [], children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    }
    node.methods.push(method);
  }
  return root;
}

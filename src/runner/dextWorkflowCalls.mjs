import { parse } from "acorn";
import { analyze } from "eslint-scope";

/** The `dext/api` import binding a member chain is read from. `api.fix()` reads a
 * namespace, `barrel.release.audit()` an exported object, and both are the same
 * call boundary: the callee is only known once the module has been imported. */
function importedRoot(node, references) {
  let current = node;
  while (current && current.type === "MemberExpression") current = current.object;
  return current && current.type === "Identifier" && references.has(current) ? current : undefined;
}

/** Track only calls to static dext/api imports. Keep the call expression intact
 * (including this, arguments, optional calls and concurrent evaluation). Scope
 * resolution is essential: a parameter named `fix` is not the import. */
export function trackWorkflowCalls(source, generation) {
  if (!source.includes("dext/api/")) return source;
  const tree = parse(source, { ecmaVersion: "latest", sourceType: "module", ranges: true });
  const scopes = analyze(tree, { ecmaVersion: 2024, sourceType: "module", optimistic: true, ignoreEval: true });
  const references = new Map();
  for (const scope of scopes.scopes) {
    for (const variable of scope.variables) {
      const definition = variable.defs[0];
      if (definition?.type !== "ImportBinding" || !definition.parent.source.value.startsWith("dext/api/")) continue;
      const namespace = definition.node.type === "ImportNamespaceSpecifier";
      for (const reference of variable.references) references.set(reference.identifier, namespace);
    }
  }
  let helper = "__dextTrackWorkflow";
  while (source.includes(helper)) helper += "_";
  const edits = [];
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "CallExpression") {
      const callee = node.callee;
      const direct = references.get(callee) === false;
      const member = callee.type === "MemberExpression" && importedRoot(callee.object, references) !== undefined;
      if (direct || member) {
        // Wrap the callee, not the call: `fn?.().x` must still short-circuit
        // through the entire chain when fn is absent. The receiver is an imported
        // binding or a member below one, so reading it again preserves `this`.
        const receiver = member ? `, ${source.slice(callee.object.start, callee.object.end)}` : "";
        edits.push({ at: callee.start, text: `${helper}(` });
        edits.push({ at: callee.end, text: `, ${generation}${receiver})` });
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  }
  visit(tree);
  if (!edits.length) return source;
  for (const edit of edits.sort((a, b) => b.at - a.at)) {
    source = source.slice(0, edit.at) + edit.text + source.slice(edit.at);
  }
  // Append the import so hashbangs/directives and original line numbers survive.
  // Resolve through `dext`, never a bundled copy of the runtime registry.
  return `${source}\nimport { workflowEntry as ${helper} } from "dext";\n`;
}

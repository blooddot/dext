import { parse } from "acorn";
import { analyze } from "eslint-scope";

/** Track only direct calls to static dext/api imports. Keep the call expression
 * intact (including this, arguments, optional calls and concurrent evaluation).
 * Scope resolution is essential: a parameter named `fix` is not the import. */
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
      const member = callee.type === "MemberExpression" && references.get(callee.object) === true;
      if (direct || member) {
        // Wrap the callee, not the call: `fn?.().x` must still short-circuit
        // through the entire chain when fn is absent. A namespace is a stable
        // imported binding, so passing it again preserves the original receiver.
        edits.push({ at: callee.start, text: `${helper}(` });
        edits.push({ at: callee.end, text: `, ${generation}${member ? `, ${callee.object.name}` : ""})` });
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

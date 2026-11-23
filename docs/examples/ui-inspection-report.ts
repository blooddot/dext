import { stat } from "node:fs/promises";
import { ui, type UiNode } from "dext";

export async function inspectConfig(path = "openspec/config.yaml") {
  const exists = await stat(path).then(
    (entry) => entry.isFile(),
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  );
  const nodes = [{
    type: "Stack", children: [
      { type: "Section", title: "摘要", children: [
        { type: "Inline", children: [
          { type: "Text", text: path },
          { type: "Badge", text: exists ? "通过" : "需修复", tone: exists ? "info" : "warning" }
        ] }
      ] },
      { type: "Section", title: "详情", children: exists
        ? [{ type: "Empty", text: "没有待修复的项目" }]
        : [{ type: "CodeBlock", code: `ENOENT: ${path}` }] },
      { type: "Section", title: "说明", children: [
        { type: "Markdown", source: "此项检查配置文件是否存在。" },
        { type: "Separator" },
        { type: "Alert", tone: "info", text: "确认后返回修复范围。" }
      ] }
    ]
  }] satisfies UiNode[];
  await ui.render({ nodes });
  if (exists) return;

  const reply = await ui.form({
    title: "确认修复计划",
    fields: [{ id: "scope", type: "select", label: "修复范围", options: ["配置文件", "配置目录"] }],
    actions: [{ id: "confirm", label: "确认" }],
    on_cancel: "return"
  });
  if (reply.status === "cancelled") {
    console.log(reply);
    return reply;
  }
  if (reply.action === "confirm") {
    const answer = reply.answers.scope;
    const scope = answer?.type === "select" ? answer.selected?.[0] : undefined;
    if (scope !== undefined) {
      const plan = { path, scope };
      console.log(plan);
      return plan;
    }
  }
}

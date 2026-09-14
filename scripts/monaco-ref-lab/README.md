# Monaco Input 验证样例

本页面使用正式的 `src/webview/codeEditor.ts`，不再维护第二套编辑器实现。Monaco 固定为 **0.56.0**。

## 启动与验证

在仓库根目录执行：

```powershell
npm ci
node scripts/monaco-ref-lab/serve.mjs
```

打开 <http://127.0.0.1:4318>。仅监听本机回环地址，只提供实验页面和生成资源；样例中的打开操作只记录目标，语言服务使用内置 API 测试注册表。

```powershell
node scripts/monaco-ref-lab/check.mjs
node scripts/checkCodeHintsUi.mjs
node scripts/checkMonacoInputUi.mjs
npm run check
npm run test:host
```

前三项启动临时 Edge/Chrome；可通过 `DEXT_BROWSER` 指定浏览器。任何必需检查失败都会返回非零退出码。报告和截图写入 `.tmp-tb/monaco-ref-lab/`；完整迁移检查日志位于 `.tmp-tb/monaco-migration/`。

## 方案与基线

原 Input 的布局、Code 入口、工具栏和尺寸控制保留。Code 的 Enter 换行、Ctrl/Cmd+Enter 执行；聊天模式保持配置的发送行为，补全列表优先接受 Enter。会话切换建立新的撤销边界，并使旧的异步响应失效。

最初的完整源码 model 加 CSS 隐藏方案存在以下可复现失败：Shift 选择与剪切会进入长路径内部，480/320 px 会拆分标签。即使补齐左右键和删除，这些失败仍存在，因此没有把该方案用于正式 Input。

正式实现使用显式映射：每个引用在 Monaco 编辑文档中占一个私用区字符，显示短标签；完整表达式保存在当前 model 生命周期内的字典中。Monaco 原生选区、删除、多光标和撤销重做操作这个单字符；恢复旧字符即可恢复对应的引用身份。

`DextCodeEditor.source`、语言请求、诊断范围、剪贴板和文件插入都通过映射转换，持久化仍使用可读的完整 `@路径`。草稿切换清空撤销与映射字典。不同目录中的同名文件使用不同映射。用户粘贴的私用区文字不会作为已有引用解码；超出引用字典容量的新引用保留完整文本，不丢失源码。

引用标签按可用宽度和字符显示宽度缩短，完整目标通过悬浮展示。标签旁按 Alt+Enter 打开引用，Backspace/Delete 删除，Ctrl/Cmd+Z 撤销。

## 自动覆盖

- 引用两侧移动、Shift 选择、双向鼠标拖选、删除、剪切及撤销重做。
- Unicode 路径、行范围、图片、同名文件和多个引用的源码映射。
- 原生多光标编辑、完整源码复制粘贴、结构化粘贴、原文粘贴和草稿隔离。
- 合成中文输入事件、各模式 Enter 行为和文件补全优先级。
- 原生参数提示触发、Esc 关闭、手动唤起、迟到响应取消和模式切换。
- F12、修饰键悬浮与点击、当前文档跳转及外部定义打开桥接。
- 四种主题、320/480/760 px、长中文标签、大字号、隐藏后恢复及销毁。
- 实际 VS Code Webview 的本地资源与 CSP、Worker 消息响应、引用撤销、虚拟内置定义打开。
- 单元测试、类型检查、lint、构建和 VSIX 资源清单。

## 限制与待人工验证

粘贴回归修复：VS Code Webview 使用 `document.execCommand('paste')` 转发粘贴，Monaco 默认的 EditContext 输入无法接收该命令。生产编辑器改用 Monaco 自带的 textarea 输入，宿主测试实际写入文本和 PNG 剪贴板，验证文字、图片事件、引用标签与撤销重做，并恢复测试前的剪贴板。浏览器检查另覆盖 Agent 输入的 Shift 文件拖放；`@scripts/` 等根目录引用依据结尾的 `/` 识别为目录，普通 `@mention` 仍保持文字。

2026-09-14 验证记录：三个浏览器检查脚本、`npm run check`（1052 项测试通过，7 项跳过）和 `npm run test:host` 均通过。实际 Webview 还验证了诊断波浪线使用的内嵌 SVG 与 CSP 兼容。已生成 `release/dext-monaco-0.1.2-20260914-1609.vsix`，并直接检查压缩包中的编辑器脚本、样式、Worker 和字体资源；该安装包尚未由用户安装验收。

- 物理 Windows 中文输入法的候选窗、选词与 Esc 取消仍待人工确认；CDP 合成事件不能替代这项检查。
- 原生查找针对普通编辑文本，不搜索标签内隐藏的完整路径。修改路径需要删除并重新插入引用。
- 短标签不是单独可聚焦的按钮；键盘打开通过 Alt+Enter，删除使用编辑器原生按键。屏幕阅读器体验仍需人工评估。
- 引用解析沿用 Dext 原有文字边界规则，本次未修改普通文字紧贴 `@` 时的语法。
- Monaco 提供编辑器控件与原生交互；Dext provider 适配层负责业务语言能力，并非直接装载 VS Code 的整套扩展。

import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { ui, type SkillResult } from "dext";
import {
  describeChange, displayResult, isExistingChangeName, matchesTarget, nextStep, openSpecJson, queryOpenSpecJson,
  resolvedScope, runWorkflowAgent, runWriting, specCall, statusCommand, unverifiedScope,
  type ResolvedScope, type SpecScope
} from "./shared.ts";

const skillId = "openspec-sync-specs";
const heading = "OpenSpec 规格同步";
const statusBatchSize = 4;
const truncatedStatus = "完整状态超过 terminal() 的输出上限。";

interface ChangeStatus {
  changeName: string;
  changeRoot: string;
  artifactPaths?: { specs?: { existingOutputPaths?: unknown } };
}

function readChangeStatus(value: unknown) {
  const status = value as ChangeStatus | null | undefined;
  if (!isExistingChangeName(status?.changeName) || typeof status.changeRoot !== "string" || !isAbsolute(status.changeRoot)) return undefined;
  const paths = status.artifactPaths?.specs?.existingOutputPaths ?? [];
  if (!Array.isArray(paths) || new Set(paths).size !== paths.length ||
      !paths.every((path): path is string => typeof path === "string" && isAbsolute(path))) return undefined;
  return { status, paths: [...paths].sort() };
}

function readStatusFailure(status: unknown): string | undefined {
  if (!Array.isArray(status) || !status.length ||
      !status.every((entry) => entry?.severity === "error" && typeof entry.message === "string" && entry.message.trim())) return undefined;
  return status.map((entry) => entry.message).join(" / ");
}

function readCliFailure(result: Awaited<ReturnType<typeof queryOpenSpecJson>>): string | undefined {
  return result && result !== "truncated" ? readStatusFailure(result.data.status) ?? (result.errorOutput || undefined) : undefined;
}

async function readListedStatus(name: string, scope: ResolvedScope) {
  const command = statusCommand(name);
  if (!command) return { failure: "变更名无法安全传给 CLI。" };
  const result = await queryOpenSpecJson(command, scope);
  if (result === "truncated") return { failure: truncatedStatus };
  const entry = result?.exitCode === 0 && result.root && result.cwd === scope.cwd &&
    (result.root.store_id ?? undefined) === scope.store ? readChangeStatus(result.data) : undefined;
  if (entry?.status.changeName === name) return { entry };
  return { failure: readCliFailure(result) ?? "未能核实变更状态。" };
}

async function resolveDeltaRoot(changeRoot: string): Promise<string | undefined> {
  try {
    const directory = await realpath(changeRoot);
    const deltaRoot = await realpath(join(directory, "specs"));
    const output = relative(directory, deltaRoot);
    if (!output || isAbsolute(output) || output === ".." || output.startsWith(`..${sep}`)) return undefined;
    return deltaRoot;
  } catch {
    return undefined;
  }
}

function mainSpecPath(deltaRoot: string, path: string, root: string): string | undefined {
  const output = relative(deltaRoot, path);
  if (isAbsolute(output) || output.startsWith(`..${sep}`) || !output.includes(sep) || basename(output) !== "spec.md") return undefined;
  return join(root, "openspec", "specs", output);
}

interface SpecFileSnapshot {
  version: { path: string; digest: string };
  content: string;
}

interface MissingMainSpec {
  version: { path: string; digest: null; parent: string; remaining: string };
  content: null;
}

interface SpecSnapshot {
  deltaPath: string;
  mainPath: string;
  delta: SpecFileSnapshot;
  main: SpecFileSnapshot | MissingMainSpec;
}

type SpecSnapshotFailure = Pick<SpecSnapshot, "deltaPath" | "mainPath"> & { failure: string };

async function readSpecFile(resolved: string): Promise<SpecFileSnapshot> {
  const bytes = await readFile(resolved);
  return {
    version: { path: resolved, digest: createHash("sha256").update(bytes).digest("hex") },
    content: bytes.toString("utf8")
  };
}

async function snapshotDelta(path: string): Promise<SpecFileSnapshot> {
  return readSpecFile(await realpath(path));
}

async function resolveSpecPath(path: string) {
  let ancestor = path;
  for (;;) {
    try {
      await lstat(ancestor);
      break;
    } catch (error) {
      const parent = dirname(ancestor);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  return { resolved: await realpath(ancestor), remaining: relative(ancestor, path) };
}

function isInside(root: string, path: string): boolean {
  const output = relative(root, path);
  return !!output && !isAbsolute(output) && output !== ".." && !output.startsWith(`..${sep}`);
}

async function resolveSpecRoot(path: string, projectRoot: string): Promise<string | undefined> {
  try {
    const { resolved, remaining } = await resolveSpecPath(path);
    const target = join(resolved, remaining);
    if (isInside(projectRoot, target) && (await stat(resolved)).isDirectory()) return target;
  } catch {
    return undefined;
  }
}

async function snapshotMain(path: string, specRoot: string): Promise<SpecFileSnapshot | MissingMainSpec> {
  const { resolved, remaining } = await resolveSpecPath(path);
  const target = join(resolved, remaining);
  if (!isInside(specRoot, target)) {
    throw new Error("主规格的实际路径超出所选规格根目录。");
  }
  if (!remaining) return readSpecFile(resolved);
  if (!(await stat(resolved)).isDirectory()) throw new Error("主规格的父路径不是目录。");
  return { version: { path: target, digest: null, parent: resolved, remaining }, content: null };
}

async function snapshotSpecFiles(targets: Iterable<readonly [string, string]>, specRoot: string): Promise<(SpecSnapshot | SpecSnapshotFailure)[]> {
  return Promise.all([...targets].map(async ([deltaPath, mainPath]) => {
    try {
      const [delta, main] = await Promise.all([snapshotDelta(deltaPath), snapshotMain(mainPath, specRoot)]);
      return { deltaPath, mainPath, delta, main };
    } catch (error) {
      return { deltaPath, mainPath, failure: error instanceof Error ? error.message : String(error) };
    }
  }));
}

function specVersions(snapshot: SpecSnapshot[]) {
  return snapshot.map(({ deltaPath, mainPath, delta, main }) => ({
    deltaPath, mainPath, delta: delta.version, main: main.version
  }));
}

async function matchesSpecVersions(expected: ReturnType<typeof specVersions>, specRoot: string): Promise<boolean> {
  const current = await snapshotSpecFiles(expected.map(({ deltaPath, mainPath }) => [deltaPath, mainPath] as const), specRoot);
  return current.every((entry): entry is SpecSnapshot => "delta" in entry) &&
    JSON.stringify(specVersions(current)) === JSON.stringify(expected);
}

async function matchesDeltaVersions(expected: SpecSnapshot[]): Promise<boolean> {
  const matches = await Promise.all(expected.map(async ({ deltaPath, delta }) => {
    try {
      const { version } = await snapshotDelta(deltaPath);
      return version.path === delta.version.path && version.digest === delta.version.digest;
    } catch {
      return false;
    }
  }));
  return matches.every(Boolean);
}

function readSyncPrompt(value: unknown, targetByDelta: ReadonlyMap<string, string>) {
  if (!value || typeof value !== "object") return undefined;
  const { summary, paths, alreadySyncedPaths = [] } = value as Record<string, unknown>;
  if (typeof summary !== "string" || !summary.trim() || !Array.isArray(paths) || !paths.length ||
      !Array.isArray(alreadySyncedPaths)) return undefined;
  const handled = new Set([...paths, ...alreadySyncedPaths]);
  if (handled.size !== paths.length + alreadySyncedPaths.length ||
      [...handled].some((path) => typeof path !== "string" || !targetByDelta.has(path))) return undefined;
  return {
    summary: summary.trim(), paths, handled, targets: paths.map((path) => targetByDelta.get(path)!)
  };
}

/**
 * Preview and confirm the merge of a change's delta into `openspec/specs`.
 * @param change The change whose delta to sync, or omit to select one with delta specs.
 * @param scope Optional store, working directory and expected OpenSpec root.
 */
export async function sync(change = "", scope: SpecScope = {}): Promise<SkillResult> {
  const retry = nextStep("核对变更与范围后重新运行原调用。");
  const specifyChange = (selected: SpecScope) => nextStep(`请指定变更 ID 后运行 ${specCall("sync", selected, "<change>")}。`);
  const command = change === "" ? "list --json" : statusCommand(change);
  if (!command) return displayResult(unverifiedScope(), heading, retry);
  const initial = await queryOpenSpecJson(command, scope);
  const failedList = change === "" && initial && initial !== "truncated" && initial.exitCode !== 0 ? initial : undefined;
  const listFailure = failedList ? readCliFailure(failedList) ?? `退出码 ${failedList.exitCode}。` : undefined;
  // A failed list can be caused by a hidden directory. Batch status skips those
  // directories and includes each readable change even when another change fails.
  const fallbackScope = failedList?.root ? resolvedScope({ cwd: failedList.cwd, root: failedList.root })
    : { ...scope, cwd: failedList?.cwd ?? scope.cwd };
  let checked = failedList ? await queryOpenSpecJson("status --all --json", fallbackScope) : initial;
  const enumerateChanges = !!failedList && checked === "truncated";
  if (enumerateChanges) checked = await queryOpenSpecJson("context --json", fallbackScope);
  const failures: string[] = [];
  const finish = (result: SkillResult, next: string) => displayResult({ ...result, text: [
    result.text,
    ...(listFailure ? [`### 变更列表读取失败\n\n${listFailure}`] : []),
    ...(enumerateChanges ? ["批量状态超过 terminal() 的输出上限，已改为尝试逐项读取。"] : []),
    ...(failures.length ? ["### 未能读取状态的变更", failures.join("\n")] : [])
  ].join("\n\n") }, heading, next);
  if (checked === "truncated") {
    const text = enumerateChanges ? "OpenSpec 范围信息超过 terminal() 的输出上限，无法完整读取。"
      : change === "" ? "变更列表超过 terminal() 的输出上限，无法完整读取。" : truncatedStatus;
    return finish({ kind: "skill", text }, change === "" ? specifyChange(scope) : retry);
  }
  if (!checked?.root || (failedList && checked.cwd !== failedList.cwd) ||
      ((!failedList || enumerateChanges) && checked.exitCode !== 0)) {
    const result = unverifiedScope();
    const diagnostic = listFailure ? readCliFailure(checked) : undefined;
    if (diagnostic) result.text += `\n\n${enumerateChanges ? "OpenSpec 范围读取失败。" : "批量状态读取失败。"}\n\n${diagnostic}`;
    return finish(result, retry);
  }
  const selected = resolvedScope({ cwd: checked.cwd, root: checked.root });
  const changes = [];
  if (failedList && !enumerateChanges) {
    const entries: unknown = checked.data.changes;
    if (!Array.isArray(entries) || (checked.exitCode !== 0 && !entries.length)) return finish(unverifiedScope(), retry);
    for (const value of entries) {
      const entry = readChangeStatus(value);
      if (entry) changes.push(entry);
      else {
        const name = typeof value?.changeName === "string" ? value.changeName : "未知变更";
        failures.push(`- ${name} · ${readStatusFailure(value?.status) ?? "未能核实变更状态。"}`);
      }
    }
  } else if (change === "") {
    let listed: unknown = checked.data.changes;
    if (enumerateChanges) {
      if (!isAbsolute(selected.root)) return finish(unverifiedScope(), retry);
      try {
        // Only read directory entries. Opening a child here would reintroduce the list failure.
        const entries = await readdir(join(selected.root, "openspec", "changes"), { withFileTypes: true });
        listed = entries.filter((entry) => entry.isDirectory() && entry.name !== "archive");
      } catch (error) {
        const diagnostic = error instanceof Error ? error.message : String(error);
        return finish({ kind: "skill", text: `无法枚举活跃变更。\n\n${diagnostic}` }, specifyChange(selected));
      }
    }
    if (!Array.isArray(listed) || listed.some((entry) => typeof entry?.name !== "string")) {
      return finish(unverifiedScope(), retry);
    }
    // `list` can include hidden directories, which `status` excludes.
    const names = [...new Set(listed.map(({ name }) => name).filter((name) => !name.startsWith(".")))].sort((a, b) => a.localeCompare(b));
    for (let offset = 0; offset < names.length; offset += statusBatchSize) {
      const batch = names.slice(offset, offset + statusBatchSize);
      const statuses = await Promise.all(batch.map((name) => readListedStatus(name, selected)));
      for (const [index, status] of statuses.entries()) {
        if (status.entry) changes.push(status.entry);
        else failures.push(`- ${batch[index]} · ${status.failure}`);
      }
    }
  } else {
    const entry = readChangeStatus(checked.data);
    if (entry?.status.changeName !== change) return displayResult(unverifiedScope(), heading, retry);
    changes.push(entry);
  }
  const cancelled = () => finish({ kind: "skill", text: "已取消规格同步。" }, nextStep("需要同步时可重新运行原调用。"));
  const candidates = changes.filter((entry) => entry.paths.length > 0);
  if (!candidates.length) {
    if (failures.length) return finish({ kind: "skill", text: "已读取的变更中没有可同步的增量规格。" }, specifyChange(selected));
    const text = change === "" ? "当前没有包含增量规格的活跃变更。" : `${change} 没有增量规格。`;
    return finish({ kind: "skill", text }, nextStep("目前无需同步。"));
  }

  const scopeText = `OpenSpec 根目录 \`${selected.root}\`\n\nStore ${selected.store ? `\`${selected.store}\`` : "当前项目"}`;
  let target = candidates[0]!;
  if (candidates.length > 1) {
    const options = candidates.map(({ status }) => status.changeName);
    if (options.length > 200) {
      return finish({ kind: "skill", text: "候选变更超出对话框的选项上限。" },
        specifyChange(selected));
    }
    const reply = await ui.select({ label: "选择要同步的变更", options, presentation: "dialog" });
    const chosen = candidates.find(({ status }) => status.changeName === reply.selected[0]);
    if (!chosen) return cancelled();
    target = chosen;
  }

  const { status, paths } = target;
  const name = status.changeName;
  const request = describeChange(name);
  const deltaRoot = await resolveDeltaRoot(status.changeRoot);
  const projectRoot = isAbsolute(selected.root) ? await realpath(selected.root).catch(() => undefined) : undefined;
  if (!projectRoot) return finish(unverifiedScope(), retry);
  const specRootPath = join(selected.root, "openspec", "specs");
  const readSpecRoot = () => resolveSpecRoot(specRootPath, projectRoot);
  const specRoot = await readSpecRoot();
  if (!specRoot) return finish(unverifiedScope(), retry);
  const targetByDelta = new Map<string, string>();
  if (deltaRoot) {
    for (const path of paths) {
      const main = mainSpecPath(deltaRoot, path, selected.root);
      if (main) targetByDelta.set(path, main);
    }
  }
  const snapshots = await snapshotSpecFiles(targetByDelta, specRoot);
  const verified = snapshots.filter((entry): entry is SpecSnapshot => "delta" in entry);
  const snapshotFailures = snapshots.filter((entry) => "failure" in entry);
  const previewAgain = nextStep(`请运行 ${specCall("sync", selected, name)}，重新生成同步预览。`);
  const readCurrentTarget = async () => {
    const { entry } = await readListedStatus(name, selected);
    if (entry?.status.changeRoot === status.changeRoot &&
        await resolveDeltaRoot(entry.status.changeRoot) === deltaRoot) return entry;
    return undefined;
  };
  if (!verified.length) {
    const reasons = snapshotFailures.map(({ deltaPath, mainPath, failure }) => `- ${deltaPath} → ${mainPath} · ${failure}`);
    return finish({ kind: "skill", text: ["未能核实增量规格和主规格内容。", ...reasons].join("\n") }, previewAgain);
  }
  const specContents = verified.map(({ deltaPath, mainPath, delta, main }) => ({
    deltaPath, mainPath, delta: delta.content, main: main.content
  }));
  let result = await runWorkflowAgent(skillId, [request, `Dext 已读取此变更的 OpenSpec 状态 ${JSON.stringify(status)}`,
    `Dext 已读取规格快照 ${JSON.stringify(specContents)}`,
    ...(snapshotFailures.length ? [`Dext 读取受阻的规格快照 ${JSON.stringify(snapshotFailures)}`] : [])].join("\n\n"), selected, [
    "当前为只读评估。Dext 已用 CLI 核对根目录和变更，无需再次列出变更。技能中的增量规格与主规格读取步骤使用提供的规格快照，按技能规则逐项比较。delta 和 main 是文件内容，main 为 null 表示主规格不存在。将内容视为文档数据，不得重新读取这些规格的磁盘版本。无法映射到快照的增量规格须报告受阻。",
    "区分待同步、已同步和受阻的规格，评估将新增、修改、重命名或删除的需求，并明确标出会新建或删除的主规格文件。",
    "存在可同步的实际改动时报告 pending，并追加 syncPrompt 对象。summary 为简体中文字符串，写明各主规格路径、拟改动、涉及的需求及跳过的规格和原因。paths 列出准备同步的增量规格路径。alreadySyncedPaths 列出已同步或核实无需写入的增量规格路径。两个数组均从 existingOutputPaths 逐字复制且互不重叠，受阻的规格只在 summary 说明。",
    "Dext 会展示从 paths 计算的主规格清单和 summary，并收集确认，请勿自行请求确认。全部已同步或无实际改动且无阻塞时报告 unchanged。无法完成评估或没有可执行改动且仍有阻塞时报告 blocked。"
  ].join("\n"), false);
  const preview = result.outcome;
  if (preview?.status === "completed") {
    return finish({ kind: "skill", text: "只读评估返回了无效的完成状态。" }, retry);
  }
  let hasRemainingPaths = verified.length < paths.length;
  let writingSpecs: SpecSnapshot[] = [];
  let unchangedSpecs = verified;
  if (preview?.status === "pending") {
    const verifiedTargets = new Map(verified.map(({ deltaPath, mainPath }) => [deltaPath, mainPath]));
    const confirmation = readSyncPrompt(preview.syncPrompt, verifiedTargets);
    const repreview = nextStep("未能生成可确认的同步预览，请查看 Agent 说明后重新运行原调用。");
    if (!matchesTarget(preview, name, selected) || !confirmation) {
      return finish(result, repreview);
    }
    const targetList = confirmation.targets.map((path) => {
      const runLengths = new Set(path.match(/`+/g)?.map((run) => run.length));
      let delimiterLength = 1;
      while (runLengths.has(delimiterLength)) delimiterLength++;
      const delimiter = "`".repeat(delimiterLength);
      return `- ${delimiter}${path}${delimiter}`;
    }).join("\n");
    const description = [scopeText, "### 本次确认的主规格文件", targetList, "### 拟同步内容", confirmation.summary].join("\n\n");
    if (description.length > 20_000) return finish(result, repreview);
    const reply = await ui.form({
      title: `同步 ${name}`,
      description,
      fields: [],
      actions: [{ id: "sync", label: "确认同步" }],
      cancel_label: "取消",
      on_cancel: "return",
      presentation: "dialog"
    });
    if (reply.status !== "submitted" || reply.action !== "sync") return cancelled();

    const currentTarget = await readCurrentTarget();
    if (!currentTarget || [...confirmation.handled].some((path) => !currentTarget.paths.includes(path))) {
      return finish(unverifiedScope(), previewAgain);
    }
    const confirmed = verified.filter(({ deltaPath }) => confirmation.handled.has(deltaPath));
    const versions = specVersions(confirmed);
    if (await readSpecRoot() !== specRoot || !await matchesSpecVersions(versions, specRoot)) {
      return finish({ kind: "skill", text: "增量规格或主规格的内容、存在状态或目标目录已有变化，或当前文件无法核实。此次确认已失效。" }, previewAgain);
    }
    const writingPaths = new Set(confirmation.paths);
    writingSpecs = confirmed.filter(({ deltaPath }) => writingPaths.has(deltaPath));
    unchangedSpecs = confirmed.filter(({ deltaPath }) => !writingPaths.has(deltaPath));
    hasRemainingPaths = paths.length > confirmation.handled.size || currentTarget.paths.length > confirmation.handled.size;
    result = await runWriting(skillId, request, selected, [
      `用户已通过 Dext 对话框确认以下同步内容 ${JSON.stringify(confirmation.summary)}`,
      `本次确认的增量规格路径子集 ${JSON.stringify(confirmation.paths)}`,
      `本次确认的主规格文件 ${JSON.stringify(confirmation.targets)}`,
      `本次确认的规格版本 ${JSON.stringify(specVersions(writingSpecs))}`,
      `本次确认的规格根目录 ${JSON.stringify(specRoot)}（所选项目中的路径 ${JSON.stringify(specRootPath)}）`,
      "Dext 已使用 CLI 状态核实根目录与变更，无需再次列出变更。写入前核对所选项目中的规格根目录仍指向上述确认的路径，再核对增量规格和主规格的解析路径、原始字节的 SHA-256 摘要以及存在状态。main.digest 为 null 时主规格应仍不存在，最近存在的父目录真实路径（main.parent）和剩余相对路径（main.remaining）也须相符。确认主规格目标仍在上述规格根目录内，再比较实际改动。确认仅覆盖上面列出的改动、增量路径和主规格文件，严格遵循技能的子集合并规则。版本或实际改动不符、无法核对时停止并报告 blocked。",
      "按技能要求同步并校验主规格。只有同步写入并通过主规格校验时才报告 completed。没有实际改动时报告 unchanged。"
    ].join("\n"), selected);
  }

  const outcome = result.outcome;
  let next = nextStep("同步结果尚未确认，请查看 Agent 说明。");
  if (matchesTarget(outcome, name, selected) && (outcome?.status === "completed" || outcome?.status === "unchanged")) {
    const validation = await openSpecJson("validate --specs --json", selected);
    const items = validation?.data.items as Array<{ valid?: boolean }> | undefined;
    if (validation && Array.isArray(items) && items.every((item) => typeof item?.valid === "boolean")) {
      if (validation.exitCode !== 0 || items.some((item) => !item.valid)) {
        next = nextStep("主规格校验未通过。先处理校验问题，再重新同步。");
      } else {
        if (await readSpecRoot() !== specRoot) {
          return finish({ kind: "skill", text: `${result.text}\n\n规格根目录已变化或无法核实。` }, previewAgain);
        }
        if (!hasRemainingPaths) {
          const currentTarget = await readCurrentTarget();
          const readOnly = preview?.status === "unchanged";
          const samePaths = currentTarget?.paths.length === paths.length && paths.every((path, index) => path === currentTarget.paths[index]);
          if (!samePaths || !await matchesDeltaVersions(writingSpecs) ||
              !await matchesSpecVersions(specVersions(unchangedSpecs), specRoot)) {
            const drift = "增量规格路径或规格版本已变化，或当前规格无法核实。";
            const text = readOnly ? `同步评估后，${drift}` : `${result.text}\n\n同步写入及校验后，${drift}`;
            return finish({ kind: "skill", text }, previewAgain);
          }
          if (await readSpecRoot() !== specRoot) {
            return finish({ kind: "skill", text: `${result.text}\n\n规格根目录已变化或无法核实。` }, previewAgain);
          }
        }
        next = hasRemainingPaths
          ? nextStep("已确认的同步范围通过校验。归档前请核对其余增量规格。")
          : nextStep(`${specCall("archive", selected, name)} —— 规格已同步且主规格校验通过，可以归档。`);
      }
    } else {
      next = nextStep("主规格校验结果未知，请在所选 OpenSpec 根目录核对。");
    }
  }
  return finish(result, next);
}

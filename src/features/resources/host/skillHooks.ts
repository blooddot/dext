/** Skill pack hooks: read the hook declarations a pack's native plugin manifest
 * points at, so the import can copy the files those hooks read and record what
 * the pack declares. Nothing here runs a hook, in import or in a turn. */

import type { SkillPackHookRecord } from "../domain/skillPack.js";
import type { SkillSourcePlugin } from "./skillVariants.js";

const HOOK_CONFIG_MAX_BYTES = 200_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Files the hooks need to run: the declared configuration files, everything
 * beside them under `hooks/`, the skill roots they read, and the manifest that
 * declared them. Mirroring these at their repository paths keeps `__dirname/..`
 * and the plugin root resolvable. A hook that reads anything else outside these
 * directories cannot be detected here; it fails in the backend, not in Dext. */
export function hookUpstreamPaths(
  plugins: readonly SkillSourcePlugin[],
  present: ReadonlySet<string>
): string[] {
  const paths = new Set<string>();
  for (const plugin of plugins) {
    paths.add(plugin.manifestPath);
    for (const file of plugin.hookFiles) paths.add(file);
    const prefix = plugin.pluginRoot ? `${plugin.pluginRoot}/` : "";
    for (const path of present) {
      if (path.startsWith(`${prefix}hooks/`)) paths.add(path);
      if (plugin.skillRoots.some((root) => path === root || path.startsWith(`${root}/`))) paths.add(path);
    }
  }
  return [...paths].filter((path) => present.has(path)).sort();
}

/** Reads every declared hook file and flattens it into records. Only command
 * handlers become records; a host module such as a UI panel is reported and
 * dropped, because Dext cannot run it anywhere. */
export function readSkillPackHooks(input: {
  plugins: readonly SkillSourcePlugin[];
  files: ReadonlyMap<string, Uint8Array>;
  present: ReadonlySet<string>;
}): { hooks: SkillPackHookRecord[]; notes: string[] } {
  const hooks: SkillPackHookRecord[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  for (const plugin of input.plugins) {
    for (const path of plugin.hookFiles) {
      const bytes = input.files.get(path);
      if (!bytes || !input.present.has(path)) {
        notes.push(`${path}: hook configuration was not available; its hooks were not recorded.`);
        continue;
      }
      if (bytes.byteLength > HOOK_CONFIG_MAX_BYTES) {
        notes.push(`${path}: hook configuration is too large to inspect.`);
        continue;
      }
      let data: Record<string, unknown>;
      try {
        const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
        const value = record(parsed)?.hooks;
        const events = record(value);
        if (!events) {
          notes.push(`${path}: hook configuration has no 'hooks' object; it was copied but not recorded.`);
          continue;
        }
        data = events;
      } catch {
        notes.push(`${path}: hook configuration is not valid JSON; its hooks were not recorded.`);
        continue;
      }
      for (const [event, groups] of Object.entries(data)) {
        if (!Array.isArray(groups)) continue;
        for (const group of groups) {
          const entry = record(group);
          const handlers = Array.isArray(entry?.hooks) ? entry.hooks : [];
          const matcher = typeof entry?.matcher === "string" && entry.matcher.trim() ? entry.matcher.trim() : undefined;
          for (const handler of handlers) {
            const command = record(handler);
            const text = typeof command?.command === "string" ? command.command.trim() : "";
            if (command?.type !== "command" || !text) {
              const type = command?.type;
              if (typeof type === "string" && type) notes.push(`${path}: ignored a ${event} hook of type '${type}'; only command hooks are recorded.`);
              continue;
            }
            const key = `${plugin.agent}\u0000${event}\u0000${matcher ?? ""}\u0000${text}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const timeout = typeof command.timeout === "number" && Number.isFinite(command.timeout) && command.timeout > 0
              ? command.timeout
              : undefined;
            hooks.push({
              agent: plugin.agent,
              event,
              ...(matcher ? { matcher } : {}),
              command: text,
              ...(timeout ? { timeout } : {}),
              source: path,
              root: plugin.pluginRoot
            });
          }
        }
      }
    }
  }
  return { hooks, notes };
}

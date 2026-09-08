// Runs in the selected dsh installation's Node process, never in the webview.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const name = 'dext-acp-presets';
export const inject = ['agents', 'agentPresets', 'llm', 'sessionPersistence', 'sessions', 'loader'];

/** Scope the factory adapter to ACP; child agents keep Harness's own factory. */
export async function apply(ctx, config) {
  const agents = ctx.agents;
  const presets = ctx.agentPresets;
  const preset = await presets.resolveMountable(config.preset);
  const setup = (original) => async (agentCtx) => {
    await presets.mount(agentCtx, preset.id);
    await original?.(agentCtx);
  };
  const factory = {
    get: (id) => agents.get(id),
    create: (options) => agents.create({
      ...options, meta: { ...options.meta, agentPreset: preset.id }, setup: setup(options.setup)
    }),
    resume: (options) => agents.resume({ ...options, setup: setup(options.setup) })
  };
  const acp = await import(pathToFileURL(config.acpModule).href);
  const original = [...ctx.loader.entries()].find((entry) => entry.options.id === 'acp');
  acp.apply(ctx.extend({ agents: factory }), { ...original?.options.config, ...config.acp });
}

async function main() {
  const [entry, action, sourceId, targetId] = process.argv.slice(2);
  const require = createRequire(entry);
  const modulePath = require.resolve('@deepseek-ai/dsh-agent-presets');
  const native = await import(pathToFileURL(modulePath).href);
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  const roots = [
    { path: native.SHIPPED_PRESET_ROOT, trust: 'system' },
    { path: join(dshHome, '.agent-presets'), trust: 'user' }
  ];
  const profileBase = join(dshHome, 'profiles', 'acp', 'cordis.yml');
  const presets = await native.discoverPresets(roots, pathToFileURL(existsSync(profileBase) ? profileBase : entry).href);
  if (action === 'list') {
    process.stdout.write(JSON.stringify(presets));
    return;
  }
  const source = presets.find((preset) => preset.id === sourceId);
  if (!source) throw new Error('The selected preset no longer exists. Refresh presets.');
  if (action === 'copy') {
    if (source.broken) throw new Error(source.broken);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(targetId ?? '')) throw new Error('Use lowercase letters, numbers and hyphens for the preset ID.');
    if (presets.some((preset) => preset.id === targetId)) throw new Error('A preset with that ID already exists.');
    const path = await native.copyComposition(roots, source, targetId);
    process.stdout.write(JSON.stringify({ path }));
    return;
  }
  throw new Error('Unknown preset action.');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => { process.stderr.write(String(error.message ?? error)); process.exitCode = 1; });
}

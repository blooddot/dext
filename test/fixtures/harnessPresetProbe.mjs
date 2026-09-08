import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const inject = ['agents', 'tools'];
export async function apply(ctx, config) {
  const { scopeOf } = await import(pathToFileURL(config.scopeModule).href);
  const tools = ctx.tools;
  ctx.on('agent/created', ({ agent }) => {
    const scope = scopeOf(agent.ctx);
    appendFileSync(config.output, JSON.stringify({
      preset: agent.session.header.agentPreset,
      tools: tools.schemas(scope).map((tool) => tool.name),
      mode: tools.modeFor(scope)
    }) + '\n');
  });
  ctx.provide('dextPresetProbeReady', {});
}

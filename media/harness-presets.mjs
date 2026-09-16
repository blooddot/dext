// Runs in the selected dsh installation's Node process, never in the webview.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const name = 'dext-acp-presets';
export const inject = ['agents', 'agentPresets', 'llm', 'sessionPersistence', 'sessions', 'loader'];

/** Endpoint and one-time token Dext's launcher publishes for its question socket. */
const BRIDGE_ENV = 'DEXT_HARNESS_BRIDGE';
const BRIDGE_TOKEN_ENV = 'DEXT_HARNESS_BRIDGE_TOKEN';

/** Scope the factory adapter to ACP; child agents keep Harness's own factory. */
export async function apply(ctx, config) {
  // Installed before the awaits below: the answerer must exist as soon as the
  // plugin is applied, not once preset resolution finishes.
  installQuestionBridge(ctx);
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

/**
 * Rebuild a harness rejection the user-questions service restores into its own
 * taxonomy, so `ask()` reports the same codes its other answerers do.
 */
function userQuestionError(message, code) {
  const error = new Error(message);
  error.name = 'UserQuestionError';
  error.code = code;
  return error;
}

/** Project one seam question onto the wire; every absent field stays absent. */
function wireQuestion(question) {
  return {
    id: question.id,
    question: question.question,
    ...(question.header === undefined ? {} : { header: question.header }),
    ...(question.detail === undefined ? {} : { detail: question.detail }),
    ...(question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect }),
    ...(question.options === undefined ? {} : {
      options: question.options.map((option) => ({
        label: option.label,
        ...(option.description === undefined ? {} : { description: option.description })
      }))
    })
  };
}

/**
 * Dext's private question channel, newline-delimited JSON over a loopback socket
 * Dext listens on.
 *
 * The published ACP bridge answers `approval/request` but registers no answerer
 * for `user-questions/request`, so `ask_user_question` fails closed under
 * `dsh --profile acp`. ACP elicitation is the standard replacement and Dext
 * already answers it, but the Harness does not emit it yet, so this channel
 * carries the gap. stdout stays exclusively JSON-RPC either way.
 */
function questionBridge() {
  const endpoint = process.env[BRIDGE_ENV];
  if (!endpoint) return undefined;
  let socket;
  try { socket = connect(endpoint); } catch { return undefined; }
  const pending = new Map();
  let buffer = '';
  let open = true;
  const settle = (id, reply) => {
    const finish = pending.get(id);
    if (finish === undefined) return;
    pending.delete(id);
    finish(reply);
  };
  const close = () => {
    open = false;
    for (const id of [...pending.keys()]) settle(id, undefined);
  };
  socket.on('connect', () => {
    socket.write(`${JSON.stringify({ token: process.env[BRIDGE_TOKEN_ENV] })}\n`);
  });
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    if (buffer.length > 1024 * 1024) { close(); return; }
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let reply;
      try { reply = JSON.parse(line); } catch { continue; }
      if (reply && typeof reply.id === 'string') settle(reply.id, reply);
    }
  });
  socket.on('error', close);
  socket.on('close', close);
  let sequence = 0;
  return {
    ask(items, signal) {
      if (!open) return Promise.resolve(undefined);
      const id = `dext-question-${++sequence}`;
      return new Promise((resolve) => {
        const abort = () => settle(id, undefined);
        pending.set(id, (reply) => {
          signal?.removeEventListener('abort', abort);
          resolve(reply);
        });
        if (signal?.aborted) { abort(); return; }
        signal?.addEventListener('abort', abort, { once: true });
        socket.write(`${JSON.stringify({ id, questions: items })}\n`);
      });
    }
  };
}

/**
 * Answer `ask_user_question` from Dext's own card. When no Dext surface owns the
 * request the listener delegates, which keeps the shipped fail-closed path.
 */
function installQuestionBridge(ctx) {
  const bridge = questionBridge();
  if (!bridge) return;
  // Owned by the root fiber: the waterfall is dispatched from the user-questions
  // service's context, and a listener owned by this plugin's own fiber sits on a
  // sibling branch that the dispatch never visits.
  ctx.root.on('user-questions/request', async (request, next) => {
    const questions = request.questions ?? [];
    if (!questions.length) return next();
    const reply = await bridge.ask(questions.map(wireQuestion), request.signal);
    if (request.signal?.aborted) throw userQuestionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED');
    if (reply?.status === 'unavailable' || reply === undefined) return next();
    if (reply.status === 'cancelled') throw userQuestionError('the user cancelled ask_user_question', 'ASK_CANCELLED');
    return { answers: reply.answer.answers };
  });
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

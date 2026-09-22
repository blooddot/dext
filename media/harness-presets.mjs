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
  // plugin is applied, not once preset resolution finishes. The result tool is
  // registered later, when Dext publishes a contract over the same channel.
  const channel = dextChannel();
  if (channel) {
    installQuestionBridge(ctx, channel);
    installResultTool(ctx, channel);
  }
  const agents = ctx.agents;
  const presets = ctx.agentPresets;
  const preset = await presets.resolveMountable(config.preset);
  const setup = (original) => async (...args) => {
    await presets.mount(args[0], preset.id);
    await original?.(...args);
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
 * Dext's private channel to the Harness process, newline-delimited JSON over a
 * loopback socket Dext listens on.
 *
 * The published ACP bridge answers `approval/request` but registers no answerer
 * for `user-questions/request`, so `ask_user_question` fails closed under
 * `dsh --profile acp`. ACP elicitation is the standard replacement and Dext
 * already answers it, but the Harness does not emit it yet, so this channel
 * carries the gap. It carries the result tool for the same reason: ACP's
 * `PromptRequest` has no output-schema field, so Dext publishes the turn's
 * contract here and the model submits through a real tool instead of writing
 * JSON into its final message.
 *
 * stdout stays exclusively JSON-RPC either way.
 */
function dextChannel() {
  const endpoint = process.env[BRIDGE_ENV];
  if (!endpoint) return undefined;
  let socket;
  try { socket = connect(endpoint); } catch { return undefined; }
  const awaiting = new Map();
  const handlers = new Map();
  let buffer = '';
  let open = true;
  const settle = (id, reply) => {
    const finish = awaiting.get(id);
    if (finish === undefined) return;
    awaiting.delete(id);
    finish(reply);
  };
  const close = () => {
    open = false;
    for (const id of [...awaiting.keys()]) settle(id, undefined);
  };
  const send = (frame) => { if (open) socket.write(`${JSON.stringify(frame)}\n`); };
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
      let frame;
      try { frame = JSON.parse(line); } catch { continue; }
      if (!frame || typeof frame.id !== 'string') continue;
      // A reply to a frame this plugin sent is settled here; Dext's own requests
      // carry a `kind` and are answered by their registered handler.
      if (awaiting.has(frame.id)) { settle(frame.id, frame); continue; }
      const handler = typeof frame.kind === 'string' ? handlers.get(frame.kind) : undefined;
      if (!handler) continue;
      Promise.resolve().then(() => handler(frame)).then(
        (status) => send({ id: frame.id, status }),
        () => send({ id: frame.id, status: 'unavailable' })
      );
    }
  });
  socket.on('error', close);
  socket.on('close', close);
  let sequence = 0;
  const request = (body, signal) => {
    if (!open) return Promise.resolve(undefined);
    const id = `dext-call-${++sequence}`;
    return new Promise((resolve) => {
      const abort = () => settle(id, undefined);
      awaiting.set(id, (reply) => {
        signal?.removeEventListener('abort', abort);
        resolve(reply);
      });
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
      send({ id, ...body });
    });
  };
  return {
    on(kind, handler) { handlers.set(kind, handler); },
    ask(items, signal) { return request({ questions: items }, signal); },
    submit(args, signal) { return request({ kind: 'submit', args }, signal); }
  };
}

/**
 * Answer `ask_user_question` from Dext's own card. When no Dext surface owns the
 * request the listener delegates, which keeps the shipped fail-closed path.
 */
function installQuestionBridge(ctx, bridge) {
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

/**
 * Dext's normalized-output channel.
 *
 * Dext publishes the current call's output contract before prompting, this
 * registers one first-class tool whose argument schema IS that contract, and
 * every call is forwarded to Dext for validation. Arguments arrive here as
 * losslessly materialized JSON — no fence, no envelope, no escaped string — and
 * a rejection throws, which the Harness turns into the model-visible
 * `Error: <diagnostics>` result, so the model repairs its own answer inside the
 * turn instead of the turn failing on prose.
 *
 * The tool is registered per turn and withdrawn with it, because the contract
 * changes from call to call. `ctx.get('tools')` is opportunistic on purpose: a
 * composition without the registry leaves the prompt-carried answer form intact
 * instead of failing the whole overlay, and a preset that restricts the tool
 * away leaves it intact too.
 */
function installResultTool(ctx, bridge) {
  let dispose;
  bridge.on('tool', (frame) => {
    if (dispose) { dispose(); dispose = undefined; }
    if (!frame.tool) return 'ready';
    const tools = ctx.get('tools');
    if (!tools) return 'unavailable';
    const { name, description, parameters } = frame.tool;
    dispose = tools.register({
      name,
      description,
      parameters,
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args, exec) {
        const verdict = await bridge.submit(args, exec.signal);
        if (verdict?.status === 'accepted') return 'accepted';
        if (verdict?.status === 'rejected') throw new Error(verdict.diagnostics || 'the result did not match the required schema');
        throw new Error('Dext is not waiting for a result for this call.');
      }
    });
    return 'ready';
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

// Runs in the installed Harness process. Asks through the same seam
// `ask_user_question` uses — including the live calling agent and the turn's
// own abort signal — as soon as a prompt enters the agent's inbox, which is
// when a real tool call would ask.
import { appendFileSync } from 'node:fs';

export const name = 'dext-question-agent-probe';
export const inject = ['userQuestions', 'agents', 'acpAppStartup'];

export function apply(ctx, config) {
  const log = (value) => appendFileSync(config.output, `${JSON.stringify(value)}\n`);
  let asked = false;
  ctx.root.on('agent/inbox/inserted', () => {
    if (asked) return;
    asked = true;
    void (async () => {
      const agent = ctx.agents.roots().at(-1);
      log({ probe: 'inbox-inserted', roots: ctx.agents.roots().length, agent: agent?.id ?? null });
      try {
        const answer = await ctx.userQuestions.ask({
          questions: [{ id: 'q', question: 'Which one?', header: 'Confirm', options: [{ label: 'A' }, { label: 'B', description: 'Second' }] }],
          ...(agent ? { agent } : {})
        });
        log({ ok: true, answer });
      } catch (error) {
        log({ ok: false, code: error?.code, message: String(error?.message ?? error) });
      }
    })();
  }, { global: true });
}

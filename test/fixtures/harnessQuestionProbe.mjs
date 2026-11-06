// Runs in the installed Harness process. It exercises the same `userQuestions`
// seam `ask_user_question` uses, without needing a model turn: it asks once the
// ACP session exists, which is when a real question could arrive.
import { appendFileSync } from 'node:fs';

export const name = 'dext-question-probe';
export const inject = ['userQuestions', 'acpAppStartup'];

export function apply(ctx, config) {
  const log = (value) => appendFileSync(config.output, `${JSON.stringify(value)}\n`);
  ctx.on('session/created', () => {
    log({ probe: 'session-created' });
    void (async () => {
      try {
        const answer = await ctx.userQuestions.ask({
          questions: [{ id: 'q', question: 'Which one?', header: 'Confirm', options: [{ label: 'A' }, { label: 'B', description: 'Second' }] }]
        });
        log({ ok: true, answer });
      } catch (error) {
        log({ ok: false, code: error?.code, message: String(error?.message ?? error) });
      }
    })();
  });
}

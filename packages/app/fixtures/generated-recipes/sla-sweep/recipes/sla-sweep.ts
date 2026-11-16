import { defineRecipe, schedule } from '@indx-workspace/app';

/** The agent the example step asks: set AW_SLA_SWEEP_AGENT_ID to its Agent Workspace id. */
export const AGENT = process.env['AW_SLA_SWEEP_AGENT_ID'] ?? 'sla-sweep-agent';

/**
 * Sla sweep: the app runs it on each slot of its schedule, in UTC.
 *
 * Each step runs once: its key is the idempotency key of the one Agent Workspace run it may
 * start, so after a restart the recipe resumes rather than repeats. Keep each step safe to run
 * again until it completes.
 */
export default defineRecipe({
  name: 'sla-sweep',
  on: schedule('*/5 * * * *', 'UTC'),
  async run({ aw, step }) {
    await step('first-step', async () => {
      const prompt = 'Do the first step of sla-sweep.';
      const { result } = await aw.runs.start(AGENT, { prompt });
      return (await result).text;
    });
  },
});

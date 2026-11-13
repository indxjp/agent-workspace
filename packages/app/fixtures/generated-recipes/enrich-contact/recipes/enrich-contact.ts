import { defineRecipe, resourceEvent } from '@indx-workspace/app';

/** The agent the example step asks: set AW_ENRICH_CONTACT_AGENT_ID to its Agent Workspace id. */
export const AGENT = process.env['AW_ENRICH_CONTACT_AGENT_ID'] ?? 'enrich-contact-agent';

/**
 * Enrich contact: the app runs it when a contact is created.
 *
 * Each step runs once: its key is the idempotency key of the one Agent Workspace run it may
 * start, so after a restart the recipe resumes rather than repeats. Keep each step safe to run
 * again until it completes.
 */
export default defineRecipe({
  name: 'enrich-contact',
  on: resourceEvent('contact', 'created'),
  async run({ aw, step }) {
    await step('first-step', async () => {
      const prompt = 'Do the first step of enrich-contact.';
      const { result } = await aw.runs.start(AGENT, { prompt });
      return (await result).text;
    });
  },
});

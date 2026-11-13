import { defineRecipe, resourceEvent } from '@indx-workspace/app';

/** The desk's triage agent, which a step of the recipe asks (the one the agent panel offers too). */
export const TRIAGE_AGENT = '11111111-1111-4111-8111-111111111111';

/**
 * The desk's example recipe (issue #1514): when a ticket is created, the triage agent looks at it
 * and asks for approval to assign it, then the recipe notes that it is done. The graph at
 * `/recipes/<id>` shows the waiting step and lets the person decide it.
 */
export default defineRecipe({
  name: 'triage-incident',
  on: resourceEvent('ticket', 'created'),
  async run({ aw, input, step }) {
    const { record } = input as { readonly record: { readonly id: string } };
    await step('triage', async () => {
      const prompt = `ticket ${record.id}: triage this incident`;
      const { result } = await aw.runs.start(TRIAGE_AGENT, { prompt });
      return (await result).text;
    });
    await step('notify', () => Promise.resolve(`triaged ${record.id}`));
  },
});

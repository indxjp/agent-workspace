import { defineRecipe, resourceEvent, type ResourceEventInput } from '@indx-workspace/app';
import { z } from '@indx-workspace/sdk/define';

import { agentIdOf } from '../lib/agent-ids.ts';
import ticketComment from '../resources/ticket_comment.ts';

/** What triage answers: whether a knowledge base article resolves the ticket, and which. */
export const TriageSchema = z.object({
  resolvable: z.boolean(),
  kbArticleId: z.string().nullable(),
  summary: z.string(),
});

/**
 * Triage incident: when a ticket is created, `triage` sets its assignee and status through
 * ticket_update and names the knowledge base article that answers it, which the recipe links in an
 * internal comment. When that article resolves it, `closer` proposes closing it: its ticket_update
 * waits for a person's approval (agents/closer.ts), so the recipe waits with it.
 */
export default defineRecipe({
  name: 'triage-incident',
  on: resourceEvent('ticket', 'created'),
  async run({ aw, input, step, store }) {
    const id = String((input as ResourceEventInput).record['id']);
    const triage = await step('classify', async () => {
      const prompt = `Triage ticket ${id}: assign it, set it in_progress and find its kb_article.`;
      const started = await aw.runs.start(await agentIdOf(aw, 'triage'), {
        prompt,
        outputSchema: TriageSchema,
      });
      const { output } = await started.result;
      if (output?.kbArticleId != null) {
        const text = `Knowledge base: /kb_articles/${output.kbArticleId} (${output.summary})`;
        await store(ticketComment).create({
          ticket: id,
          body: [{ type: 'paragraph', text }],
          internal: true,
        });
      }
      return output ?? null;
    });
    if (triage?.['resolvable'] !== true) return;
    await step('approve-closure', async () => {
      const prompt = `Ticket ${id} is resolved by its knowledge base article: close it.`;
      await aw.runs.start(await agentIdOf(aw, 'closer'), { prompt });
      return undefined;
    });
  },
});

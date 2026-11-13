import { defineRecipe, resourceEvent } from '@indx-workspace/app';
import { z } from '@indx-workspace/sdk/define';

import company from '../resources/company.ts';
import contact from '../resources/contact.ts';

/** The agent the classify step asks, by name; AW_ENRICH_CONTACT_AGENT_ID names its id instead. */
export const AGENT = 'sales-assistant';

/** Mailboxes anyone can open: their domain says nothing about the contact's company. */
export const FREE_MAIL = ['gmail.com', 'yahoo.co.jp', 'outlook.com', 'icloud.com', 'hotmail.com'];

export const EnrichSchema = z.object({ company: z.string().min(1), title: z.string().nullable() });

/**
 * Enrich contact: when a contact is created, the sales assistant names its company and title, and
 * the contact is linked to that company, found by its email domain or created.
 *
 * One step, because a recipe writes only in the step whose run it writes for (ADR-0164): the
 * write carries that run's id. A completed step is never run again, so a restart starts no
 * second run and links no second company.
 */
export default defineRecipe({
  name: 'enrich-contact',
  on: resourceEvent('contact', 'created'),
  input: z.object({ record: z.object({ id: z.uuid(), email: z.string() }) }),
  async run({ aw, input, step, store }) {
    const { id, email } = input.record;
    const domain = email.split('@')[1]?.trim().toLowerCase() ?? '';
    if (domain === '' || FREE_MAIL.includes(domain)) return;
    const agentId =
      process.env['AW_ENRICH_CONTACT_AGENT_ID'] ??
      (await aw.agents.list()).find((agent) => agent.name === AGENT)?.id;
    if (agentId === undefined) throw new Error(`no agent named ${AGENT} in this workspace`);
    await step('classify', async () => {
      const prompt = `Enrich a new CRM contact: which company and job title for ${email}?`;
      const { result } = await aw.runs.start(agentId, { prompt, outputSchema: EnrichSchema });
      const { output } = await result;
      if (output === null) return null;
      const known = await store(company).search(domain);
      const linked =
        known.items.find((row) => row.domain === domain) ??
        (await store(company).create({ name: output.company, domain }));
      await store(contact).update(id, { company: linked.id });
      return { company: linked.id, title: output.title };
    });
  },
});

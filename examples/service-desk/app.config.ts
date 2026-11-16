import { defineApp } from '@indx-workspace/app';
import ticket from './resources/ticket.ts';
import kb_article from './resources/kb_article.ts';
import ticket_comment from './resources/ticket_comment.ts';
import triageIncidentRecipe from './recipes/triage-incident.ts';
import slaSweepRecipe from './recipes/sla-sweep.ts';

export default defineApp({
  name: 'service-desk',
  resources: [
    ticket,
    kb_article,
    ticket_comment,
  ],
  recipes: [
    triageIncidentRecipe,
    slaSweepRecipe,
  ],
});

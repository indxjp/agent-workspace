import { defineApp } from '@indx-workspace/app';

import triageIncident from './recipes/triage-incident';
import message from './resources/message';
import page from './resources/page';
import room from './resources/room';
import ticket from './resources/ticket';

/**
 * The desk fixture's app: its tickets with a recipe on them, a team chat's rooms and messages, and
 * its knowledge base's pages.
 */
export default defineApp({
  name: 'desk',
  resources: [ticket, room, message, page],
  recipes: [triageIncident],
});

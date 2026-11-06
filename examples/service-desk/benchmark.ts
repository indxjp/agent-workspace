// The apps benchmark's declaration for examples/service-desk (tests/apps/benchmark.ts reads it). It
// imports nothing, so the app reaches nothing outside itself; tests/apps/registry.ts checks it.
export default {
  id: 'service-desk',
  order: 4,
  title: 'Service desk',
  reference: true,
  budget: 250,
  // The generated files this app edits on purpose; each counts in full as handwritten.
  takenOver: [
    'agents/closer.ts',
    'app/tickets/[id]/page.tsx',
    'recipes/sla-sweep.ts',
    'recipes/triage-incident.ts',
    'resources/ticket.ts',
    'resources/ticket_comment.ts',
    'tests/recipes/sla-sweep.test.ts',
    'tests/recipes/triage-incident.test.ts',
  ],
  cells: {
    journeys: {
      verdict: 'ok',
      evidence: 'lane',
      file: 'examples/service-desk/e2e/service-desk.e2e.mjs',
      ref: 'signature: a ticket is triaged, escalated by the SLA sweep and closed after approval',
      note: "in en and ja, signed in through the portal's /sign-in at aw dev's development issuer: J3's panel run lowers the ticket as the person; triage moves the new ticket to in_progress; the sla-sweep slot fired two hours past its last change escalates it with an internal comment; closer's ticket_update waits in awaiting_approval, the home Dashboard lists it (the run list read as the person, ADR-0161's #1530 amendment), it is approved in RecipeGraph and closes the ticket; and the history shows the triage, escalation and closure writes, in that order, each linked to its step's run",
    },
    agentOnData: {
      verdict: 'ok',
      evidence: 'contract',
      file: 'examples/service-desk/tests/agent-on-data.test.ts',
      ref: 'triage updates a ticket as the requester and is refused deleting it',
      note: 'triage writes a ticket’s status through the app connector as the requester, its audit row naming the run; a field outside agents.write and a delete are refused',
    },
    selfHost: {
      verdict: 'ok',
      evidence: 'lane',
      file: 'tests/apps/lane.mjs',
      ref: 'self-host',
      note: 'aw deploy renders the app into Compose and Helm with its image and app_service_desk, npm run image builds that image, and the platform boots it healthy on its own database role',
    },
  },
} as const;

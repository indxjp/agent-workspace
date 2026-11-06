// The apps benchmark's declaration for examples/crm (tests/apps/benchmark.ts reads it). It imports
// nothing, so the app reaches nothing outside itself; tests/apps/registry.ts checks it.
export default {
  id: 'crm',
  order: 3,
  title: 'CRM',
  reference: true,
  budget: 200,
  // The generated files this app made its own code; Handwritten counts each in full (a test not).
  takenOver: [
    'agent-workspace.yaml',
    'agents/sales-assistant.ts',
    'app/deals/[id]/page.tsx',
    'recipes/enrich-contact.ts',
    'resources/company.ts',
    'resources/contact.ts',
    'resources/deal.ts',
    'tests/recipes/enrich-contact.test.ts',
  ],
  cells: {
    journeys: {
      verdict: 'ok',
      evidence: 'lane',
      file: 'examples/crm/e2e/crm.e2e.mjs',
      ref: 'J3: a member opens a deal on the board and works with the agent',
      note: "in en and ja, signed in through the portal's /sign-in at aw dev's development issuer: a member opens a deal from its board column and the sales assistant's panel run reads the deals as them (J3); a new contact is enriched by the recipe with exactly one platform run, linked from the recipe run; a deal moves from qualified to proposal on the board",
    },
    agentOnData: {
      verdict: 'ok',
      evidence: 'contract',
      file: 'examples/crm/tests/agent-on-data.test.ts',
      ref: 'the sales assistant updates a contact as the person and is refused a field outside agents.write',
      note: 'the sales assistant links a contact to its company through the app connector as the person, audited with its run, and is refused deal.amount, which agents.write leaves out',
    },
    selfHost: {
      verdict: 'ok',
      evidence: 'lane',
      file: 'tests/apps/lane.mjs',
      ref: 'self-host',
      note: 'aw deploy renders the app into Compose and Helm with its image and app_crm, npm run image builds that image, and the platform boots it healthy on its own database role',
    },
  },
} as const;

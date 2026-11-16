// The apps benchmark's declaration for examples/minimal (tests/apps/benchmark.ts reads it). It
// imports nothing, so the app reaches nothing outside itself; tests/apps/registry.ts checks it.
export default {
  id: 'minimal',
  order: 0,
  title: 'Minimal fixture',
  reference: false,
  budget: 0,
  cells: {
    journeys: {
      verdict: 'ok',
      evidence: 'lane',
      file: 'examples/minimal/e2e/minimal.e2e.mjs',
      ref: 'J3: a member opens a note and edits it',
      note: "a member opens a note from the list, follows its Edit link to the generated edit page and saves a new title, in en and in ja (the app kit's parts speak app/theme.ts's language)",
    },
    agentOnData: {
      verdict: 'ok',
      evidence: 'contract',
      file: 'examples/minimal/tests/agent-on-data.test.ts',
      ref: 'the helper reads notes as the person and is refused an update outside agents.write',
      note: 'the helper reads a note through the app connector as the person, and has no update tool because the resource gives agents no field',
    },
    selfHost: {
      verdict: 'ok',
      evidence: 'lane',
      file: 'tests/apps/lane.mjs',
      ref: 'self-host',
      note: 'aw deploy renders the app into Compose and Helm with its image and app_minimal, npm run image builds that image, and the platform boots it healthy on its own database role',
    },
  },
} as const;

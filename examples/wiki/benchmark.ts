// The apps benchmark's declaration for examples/wiki (tests/apps/benchmark.ts reads it). It imports
// nothing, so the app reaches nothing outside itself; tests/apps/registry.ts checks it.
export default {
  id: 'wiki',
  order: 2,
  title: 'Wiki',
  reference: true,
  budget: 100,
  // The generated files this app made its own code; Handwritten counts each in full.
  takenOver: ['app/wiki/[id]/page.tsx'],
  cells: {
    journeys: {
      verdict: 'ok',
      evidence: 'lane',
      file: 'examples/wiki/e2e/wiki.e2e.mjs',
      ref: 'signature: an agent summarizes a page tree into a new page',
      note: "in en and ja, signed in through the portal's /sign-in at aw dev's development issuer: a member opens a page from the space's tree and edits it (J3), and from the handbook's agent panel the writer summarizes it and the two pages under it into a new page in the tree, whose body cites the three and whose first revision carries the panel's run and the person",
    },
    agentOnData: {
      verdict: 'ok',
      evidence: 'contract',
      file: 'examples/wiki/tests/agent-on-data.test.ts',
      ref: 'the writer reads pages as the person, creates one in its run, and is refused a delete (role:admin)',
      note: 'the writer reads a page and creates one through the app connector as a builder, the revision carrying its run and that person, and is refused the delete a builder may not make (spaces carry no access of their own)',
    },
    selfHost: {
      verdict: 'ok',
      evidence: 'lane',
      file: 'tests/apps/lane.mjs',
      ref: 'self-host',
      note: 'aw deploy renders the app into Compose and Helm with its image and app_wiki, npm run image builds that image, and the platform boots it healthy on its own database role',
    },
  },
} as const;
